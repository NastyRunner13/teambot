// Event triggers that TeamBot has to go and look for: new email (IMAP) and upcoming calendar events (an iCal
// feed). Each enabled routine with one of these triggers is checked on its own interval; what is found is handed
// to the routine's agent as untrusted content. Slack channel messages arrive through the Slack bridge instead.
// Passwords and private feed URLs are reserved secrets (agents can't see or use them), named by routineSecret().
import type { Schedule } from '@teambot/shared';
import type { App } from '../app.js';
import { formatBytes, saveUpload } from '../shared-files.js';
import { errorMessage } from '../util.js';
import { MAX_QUEUED_EVENTS } from './cron.js';

const TICK_MS = 30_000;
const EMAIL_EVERY_MS = 2 * 60_000;
const CALENDAR_EVERY_MS = 5 * 60_000;
const MAX_EMAILS_PER_CHECK = 5;
const MAX_FIRED_KEYS = 300;

/** The reserved secret holding a routine's password (email) or private feed URL (calendar). */
export const routineSecret = (scheduleId: string) => `TEAMBOT_ROUTINE_${Buffer.from(scheduleId).toString('hex').toUpperCase()}`;

export interface MailMessage {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  text: string;
  attachments: { filename: string; content: Buffer }[];
}

export interface Mailbox {
  /** Unread messages matching the filters, oldest first. */
  unseen(opts: { from?: string; subject?: string; since: Date; limit: number }): Promise<MailMessage[]>;
  markSeen(uids: number[]): Promise<void>;
  close(): Promise<void>;
}

export interface MailServer {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
}

export type OpenMailbox = (server: MailServer) => Promise<Mailbox>;
export type FetchText = (url: string) => Promise<string>;

/** IMAP through imapflow, messages parsed with mailparser. Both are loaded only when an email routine exists. */
const openImap: OpenMailbox = async (server) => {
  const [{ ImapFlow }, { simpleParser }] = await Promise.all([import('imapflow'), import('mailparser')]);
  const client = new ImapFlow({ host: server.host, port: server.port, secure: server.secure, auth: { user: server.user, pass: server.password }, logger: false });
  await client.connect();
  const lock = await client.getMailboxLock(server.mailbox || 'INBOX');
  return {
    async unseen({ from, subject, since, limit }) {
      const query: Record<string, unknown> = { seen: false, since };
      if (from) query.from = from;
      if (subject) query.subject = subject;
      const uids = ((await client.search(query, { uid: true })) || []).slice(0, limit);
      const out: MailMessage[] = [];
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const addr = (a: unknown) => (Array.isArray(a) ? a.map((x) => x.text).join(', ') : ((a as { text?: string } | undefined)?.text ?? ''));
        out.push({
          uid,
          from: addr(parsed.from),
          to: addr(parsed.to),
          subject: parsed.subject ?? '',
          date: (parsed.date ?? new Date()).toISOString(),
          text: parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : ''),
          attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? 'attachment', content: a.content })),
        });
      }
      return out;
    },
    async markSeen(uids) {
      if (uids.length) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
    },
    async close() {
      lock.release();
      await client.logout().catch(() => undefined);
    },
  };
};

const fetchFeed: FetchText = async (url) => {
  const res = await fetch(url.replace(/^webcal:/i, 'https:'), { signal: AbortSignal.timeout(30_000), headers: { accept: 'text/calendar, */*' } });
  if (!res.ok) throw new Error(`the calendar feed answered HTTP ${res.status}`);
  return res.text();
};

interface Occurrence {
  key: string;
  start: Date;
  end: Date | null;
  summary: string;
  location: string;
  description: string;
  organizer: string;
  attendees: string[];
}

/** Event occurrences starting in (from, to], recurring events expanded. */
export async function occurrencesBetween(ics: string, from: number, to: number): Promise<Occurrence[]> {
  const ICAL = (await import('ical.js')).default;
  const root = new ICAL.Component(ICAL.parse(ics));
  for (const tz of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(tz);
  const events = root.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  // Changed single occurrences of a recurring event (RECURRENCE-ID) belong to their series.
  const masters = new Map(events.filter((e) => !e.isRecurrenceException()).map((e) => [e.uid, e]));
  for (const e of events) if (e.isRecurrenceException()) masters.get(e.uid)?.relateException(e);

  const clean = (v: unknown) => String(v ?? '').replace(/^mailto:/i, '');
  const out: Occurrence[] = [];
  const add = (e: InstanceType<typeof ICAL.Event>, start: Date, end: Date | null) =>
    out.push({
      key: `${e.uid}|${start.toISOString()}`,
      start,
      end,
      summary: e.summary ?? '(no title)',
      location: e.location ?? '',
      description: e.description ?? '',
      organizer: clean(e.organizer),
      attendees: e.attendees.map((a) => clean(a.getParameter('cn') ?? a.getFirstValue())),
    });
  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      const start = event.startDate.toJSDate();
      if (start.getTime() > from && start.getTime() <= to) add(event, start, event.endDate?.toJSDate() ?? null);
      continue;
    }
    const it = event.iterator();
    for (let next = it.next(), n = 0; next && n < 20_000; next = it.next(), n++) {
      const t = next.toJSDate().getTime();
      if (t > to) break;
      if (t <= from) continue;
      const details = event.getOccurrenceDetails(next);
      add(details.item, details.startDate.toJSDate(), details.endDate?.toJSDate() ?? null);
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

export class Triggers {
  private timer?: NodeJS.Timeout;
  private busy = new Set<string>();
  private checked = new Map<string, number>();
  private openMailbox: OpenMailbox;
  private fetchText: FetchText;

  constructor(
    private app: App,
    opts: { openMailbox?: OpenMailbox; fetchText?: FetchText } = {},
  ) {
    this.openMailbox = opts.openMailbox ?? openImap;
    this.fetchText = opts.fetchText ?? fetchFeed;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Check every routine that is due. Returns when they are all done (tests await it). */
  async tick(at = Date.now()) {
    const due = this.app.store.listSchedules().filter((s) => {
      if (!s.enabled || (s.trigger !== 'email' && s.trigger !== 'calendar') || this.busy.has(s.id)) return false;
      return at - (this.checked.get(s.id) ?? 0) >= (s.trigger === 'email' ? EMAIL_EVERY_MS : CALENDAR_EVERY_MS);
    });
    await Promise.all(due.map((s) => this.check(s, at)));
  }

  /** Check one routine now. Checks of the same routine run one after another, so they never overwrite each other. */
  check(s: Schedule, at = Date.now()): Promise<void> {
    const before = this.inflight.get(s.id) ?? Promise.resolve();
    const run = before.then(() => this.run(s.id, at));
    this.inflight.set(s.id, run);
    void run.finally(() => this.inflight.get(s.id) === run && this.inflight.delete(s.id));
    return run;
  }

  private inflight = new Map<string, Promise<void>>();

  private async run(id: string, at: number) {
    const s = this.app.store.getSchedule(id);
    if (!s) return;
    this.busy.add(s.id);
    this.checked.set(s.id, at);
    try {
      if (s.trigger === 'email') await this.checkEmail(s);
      else if (s.trigger === 'calendar') await this.checkCalendar(s, at);
      this.setStatus(s, null);
    } catch (err) {
      this.setStatus(s, errorMessage(err));
    } finally {
      this.busy.delete(s.id);
    }
  }

  status(scheduleId: string): { checkedAt: string | null; error: string | null } {
    const raw = this.app.store.getSetting(`trigger_status:${scheduleId}`);
    return raw ? JSON.parse(raw) : { checkedAt: null, error: null };
  }

  private setStatus(s: Schedule, error: string | null) {
    const before = this.status(s.id).error;
    this.app.store.setSetting(`trigger_status:${s.id}`, JSON.stringify({ checkedAt: new Date().toISOString(), error }));
    // Only changes go to the audit log, not every successful check.
    if (error && error !== before) this.app.bus.emit('trigger.failed', { agentId: s.agentId }, { scheduleId: s.id, name: s.name, trigger: s.trigger, error });
    if (!error && before) this.app.bus.emit('trigger.recovered', { agentId: s.agentId }, { scheduleId: s.id, name: s.name, trigger: s.trigger });
  }

  private secret(s: Schedule, what: string): string {
    const value = this.app.vault.get(routineSecret(s.id));
    if (!value) throw new Error(`the ${what} for this routine is not set`);
    return value;
  }

  private async checkEmail(s: Schedule) {
    const c = s.config;
    if (!c.host || !c.user) throw new Error('the mail server and user are not set');
    const box = await this.openMailbox({
      host: c.host,
      port: c.port ?? 993,
      secure: c.secure ?? true,
      user: c.user,
      password: this.secret(s, 'mail password'),
      mailbox: c.mailbox || 'INBOX',
    });
    try {
      const room = Math.max(0, Math.min(MAX_EMAILS_PER_CHECK, MAX_QUEUED_EVENTS - this.app.cron.queuedEvents(s)));
      if (!room) return; // the agent is behind; the mail stays unread until it catches up
      // Only mail from the day the routine was made onwards (IMAP's SINCE is by date).
      const messages = await box.unseen({ from: c.from || undefined, subject: c.subject || undefined, since: new Date(s.createdAt.slice(0, 10)), limit: room });
      const handed: number[] = [];
      for (const m of messages) {
        const files = m.attachments.slice(0, 10).map((a) => saveUpload(this.app.cfg.sharedDir, `uploads/email/${new Date().toISOString().slice(0, 10)}`, a.filename, a.content));
        for (const file of files) this.app.bus.emit('file.uploaded', { agentId: s.agentId }, { file, via: 'email' });
        const head = [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, `Date: ${m.date}`];
        if (files.length) head.push(`Attachments: ${files.map((f) => `${f.path} (${formatBytes(f.size)})`).join(', ')}`);
        const body = `${head.join('\n')}\n\n${m.text.trim()}`;
        this.app.cron.fire(s.id, { source: 'email', via: 'an email', body });
        handed.push(m.uid);
      }
      await box.markSeen(handed);
    } finally {
      await box.close();
    }
  }

  private async checkCalendar(s: Schedule, at: number) {
    const ics = await this.fetchText(this.secret(s, 'calendar address'));
    const lead = (s.config.minutesBefore ?? 10) * 60_000;
    // Events whose moment to hand over ("lead" before the start) came since the last check (or, the first time, one
    // interval back), so a short lead between two checks isn't skipped and nothing is handed over twice. After
    // downtime, only moments from the last two intervals still count, not a backlog of meetings long over.
    const lastKey = `calendar_checked:${s.id}`;
    const since = Math.max(Number(this.app.store.getSetting(lastKey)) || at - CALENDAR_EVERY_MS, at - 2 * CALENDAR_EVERY_MS);
    const firedKey = `calendar_fired:${s.id}`;
    const fired: string[] = JSON.parse(this.app.store.getSetting(firedKey) ?? '[]');
    for (const o of await occurrencesBetween(ics, since + lead, at + lead)) {
      if (fired.includes(o.key)) continue;
      const minutes = Math.round((o.start.getTime() - at) / 60_000);
      const body = [
        `Event: ${o.summary}`,
        `Starts: ${o.start.toISOString()} (${minutes > 0 ? `in ${minutes} minutes` : minutes === 0 ? 'now' : `started ${-minutes} minutes ago`})`,
        o.end ? `Ends: ${o.end.toISOString()}` : '',
        o.location ? `Location: ${o.location}` : '',
        o.organizer ? `Organizer: ${o.organizer}` : '',
        o.attendees.length ? `Attendees: ${o.attendees.join(', ')}` : '',
        o.description ? `\n${o.description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      this.app.cron.fire(s.id, { source: 'calendar', via: 'a calendar event', body });
      fired.push(o.key);
    }
    this.app.store.setSetting(firedKey, JSON.stringify(fired.slice(-MAX_FIRED_KEYS)));
    this.app.store.setSetting(lastKey, String(at));
  }
}
