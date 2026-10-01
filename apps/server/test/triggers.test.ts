import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import type { MailMessage, MailServer } from '../src/runtime/triggers.js';
import { occurrencesBetween, routineSecret } from '../src/runtime/triggers.js';
import { addAgent, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await current?.slack.stop();
  await current?.runtime.stop();
  current = server = null;
});

class FakeMail {
  opened: MailServer[] = [];
  seen: number[] = [];
  fail: string | null = null;
  messages: MailMessage[] = [
    { uid: 7, from: 'Ana <ana@client.com>', to: 'me@team.com', subject: 'Invoice 42', date: '2026-10-01T08:00:00.000Z', text: 'Please find the invoice attached.', attachments: [{ filename: 'invoice-42.pdf', content: Buffer.from('%PDF') }] },
    { uid: 8, from: 'Bo <bo@client.com>', to: 'me@team.com', subject: 'Re: Invoice 41', date: '2026-10-01T09:00:00.000Z', text: 'Paid, thanks!', attachments: [] },
  ];
  open = async (s: MailServer) => {
    if (this.fail) throw new Error(this.fail);
    this.opened.push(s);
    return {
      unseen: async ({ limit }: { limit: number }) => this.messages.filter((m) => !this.seen.includes(m.uid)).slice(0, limit),
      markSeen: async (uids: number[]) => void this.seen.push(...uids),
      close: async () => undefined,
    };
  };
}

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VEVENT
UID:standup@test
DTSTART:20261005T090000Z
DTEND:20261005T091500Z
RRULE:FREQ=DAILY
SUMMARY:Daily standup
END:VEVENT
BEGIN:VEVENT
UID:launch@test
DTSTART:20261007T140000Z
DTEND:20261007T150000Z
SUMMARY:Launch review
LOCATION:Room 4
DESCRIPTION:Bring the numbers
ORGANIZER:mailto:boss@example.com
ATTENDEE;CN=Ana:mailto:ana@example.com
END:VEVENT
END:VCALENDAR`;

async function setup(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  current = t.app;
  fs.mkdirSync(t.app.cfg.sharedDir, { recursive: true });
  server = await buildServer(t.app);
  // Keep what the triggers hand over in the inbox, where the tests can read it.
  t.app.runtime.setPausedAll(true, t.owner.id);
  return { ...t, server };
}

const inbox = (app: App, agentId: string) => app.store.pendingInbox(agentId).map((i) => i.text);

describe('email routines', () => {
  it('hands each new email to the agent, saves attachments, and marks the mail read', async () => {
    const mail = new FakeMail();
    const { app, server } = await setup({ triggers: { openMailbox: mail.open } });
    const ops = addAgent(app, 'Ops');

    const missing = await server.inject({ method: 'POST', url: '/api/schedules', payload: { agentId: ops.id, name: 'Invoices', trigger: 'email', prompt: 'File invoices.', config: { host: 'imap.team.com', user: 'me@team.com' } } });
    expect(missing.statusCode).toBe(400);

    const res = await server.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { agentId: ops.id, name: 'Invoices', trigger: 'email', prompt: 'File invoices in /shared/finance.', config: { host: 'imap.team.com', user: 'me@team.com', from: 'client.com' }, secret: 'app-password-1' },
    });
    const routine = res.json();
    expect(routine).toMatchObject({ trigger: 'email', hasSecret: true });
    expect(JSON.stringify(routine)).not.toContain('app-password-1');
    expect(app.vault.get(routineSecret(routine.id))).toBe('app-password-1');
    expect(app.vault.agentNames()).not.toContain(routineSecret(routine.id));

    await app.triggers.check(app.store.getSchedule(routine.id)!);
    expect(mail.opened[0]).toMatchObject({ host: 'imap.team.com', port: 993, secure: true, user: 'me@team.com', password: 'app-password-1', mailbox: 'INBOX' });
    const items = inbox(app, ops.id);
    expect(items).toHaveLength(2);
    // Who sent it is outside content too, so it stays inside the untrusted block, never in the heading.
    expect(items[0]).toContain('Routine "Invoices" was triggered by an email: File invoices in /shared/finance.');
    expect(items[0].split('<untrusted_content')[0]).not.toContain('Ana');
    expect(items[0]).toContain('<untrusted_content source="email">');
    expect(items[0]).toMatch(/Attachments: \/shared\/uploads\/email\/\d{4}-\d{2}-\d{2}\/invoice-42\.pdf/);
    expect(mail.seen).toEqual([7, 8]);
    const saved = items[0].match(/\/shared\/(uploads\/email\/\S+\.pdf)/)![1];
    expect(fs.readFileSync(path.join(app.cfg.sharedDir, saved), 'utf8')).toBe('%PDF');
    expect(app.store.pendingInbox(ops.id)[0].initiator).toBe('event');

    // A failing server shows up on the routine, logged once.
    mail.fail = 'Invalid credentials (Failure)';
    await app.triggers.check(app.store.getSchedule(routine.id)!);
    await app.triggers.check(app.store.getSchedule(routine.id)!);
    const listed = (await server.inject({ method: 'GET', url: '/api/schedules' })).json()[0];
    expect(listed.triggerStatus.error).toBe('Invalid credentials (Failure)');
    expect(app.store.listEvents({ types: ['trigger.failed'] })).toHaveLength(1);
  });
});

describe('calendar routines', () => {
  it('expands recurring events and hands each one over once, minutes before it starts', async () => {
    const occ = await occurrencesBetween(ICS, Date.parse('2026-10-06T00:00:00Z'), Date.parse('2026-10-08T00:00:00Z'));
    expect(occ.map((o) => [o.summary, o.start.toISOString()])).toEqual([
      ['Daily standup', '2026-10-06T09:00:00.000Z'],
      ['Daily standup', '2026-10-07T09:00:00.000Z'],
      ['Launch review', '2026-10-07T14:00:00.000Z'],
    ]);

    const { app, server } = await setup({ triggers: { fetchText: async (url) => (url === 'https://cal.example.com/private.ics' ? ICS : '') } });
    const lead = addAgent(app, 'Lead');
    const routine = (
      await server.inject({
        method: 'POST',
        url: '/api/schedules',
        payload: { agentId: lead.id, name: 'Meeting prep', trigger: 'calendar', prompt: 'Prepare a one-page brief.', config: { minutesBefore: 10 }, secret: 'webcal://cal.example.com/private.ics'.replace('webcal', 'https') },
      })
    ).json();
    const s = () => app.store.getSchedule(routine.id)!;

    await app.triggers.check(s(), Date.parse('2026-10-07T13:51:00Z'));
    let items = inbox(app, lead.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toContain('triggered by a calendar event: Prepare a one-page brief.');
    expect(items[0].split('<untrusted_content')[1]).toContain('Event: Launch review');
    expect(items[0]).toContain('Starts: 2026-10-07T14:00:00.000Z (in 9 minutes)');
    expect(items[0]).toContain('Attendees: Ana');

    await app.triggers.check(s(), Date.parse('2026-10-07T13:56:00Z')); // same event, not again
    await app.triggers.check(s(), Date.parse('2026-10-08T08:52:00Z')); // next morning's standup
    items = inbox(app, lead.id);
    expect(items).toHaveLength(2);
    expect(items[1]).toContain('Starts: 2026-10-08T09:00:00.000Z (in 8 minutes)');
  });

  it('hands over events with a lead shorter than the check interval, including zero, once', async () => {
    const { app, server } = await setup({ triggers: { fetchText: async () => ICS } });
    const lead = addAgent(app, 'Lead');
    const make = async (minutesBefore: number) =>
      (
        await server.inject({
          method: 'POST',
          url: '/api/schedules',
          payload: { agentId: lead.id, name: `At ${minutesBefore}`, trigger: 'calendar', prompt: 'Join.', config: { minutesBefore }, secret: 'https://cal.example.com/x.ics' },
        })
      ).json();
    const zero = await make(0);
    const two = await make(2);
    const check = async (id: string, at: string) => app.triggers.check(app.store.getSchedule(id)!, Date.parse(at));

    // Checks every five minutes; the launch review starts at 14:00.
    await check(zero.id, '2026-10-07T13:57:00Z');
    await check(zero.id, '2026-10-07T14:02:00Z');
    await check(zero.id, '2026-10-07T14:07:00Z');
    await check(two.id, '2026-10-07T13:57:00Z'); // its moment (13:58) is after this check…
    await check(two.id, '2026-10-07T14:02:00Z'); // …and was passed by this one: still handed over
    const items = inbox(app, lead.id).filter((t) => t.includes('Launch review'));
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Routine "At 0"');
    expect(items[0]).toContain('started 2 minutes ago');
    expect(items[1]).toContain('Routine "At 2"');
  });
});

describe('Slack channel routines', () => {
  it('starts the routine for messages in the watched channel only', async () => {
    const calls: string[] = [];
    const api = async (method: string, params: Record<string, any> = {}) => {
      calls.push(method);
      if (method === 'auth.test') return { ok: true, user: 'teambot', user_id: 'UBOT', team: 'Acme' };
      if (method === 'users.info') return { ok: true, user: { profile: { display_name: params.user === 'U5' ? 'dana' : 'x' } } };
      return { ok: true, ts: '1.1' };
    };
    const { app, server } = await setup({ slack: { api } });
    await app.slack.start();
    const support = addAgent(app, 'Support');
    expect((await server.inject({ method: 'POST', url: '/api/schedules', payload: { agentId: support.id, name: 'Help desk', trigger: 'slack', prompt: 'Answer it.', config: { channel: '#help' } } })).statusCode).toBe(400);
    await server.inject({ method: 'POST', url: '/api/schedules', payload: { agentId: support.id, name: 'Help desk', trigger: 'slack', prompt: 'Answer the question.', config: { channel: 'C0HELP123' } } });

    const msg = (channel: string, extra = {}) => ({ type: 'events_api', payload: { event: { type: 'message', channel_type: 'channel', channel, user: 'U5', text: 'How do I reset my password?', ts: '9.9', ...extra } } });
    await app.slack.handleEnvelope(msg('C0OTHER99'));
    await app.slack.handleEnvelope(msg('C0HELP123', { bot_id: 'B1' }));
    expect(inbox(app, support.id)).toHaveLength(0);
    await app.slack.handleEnvelope(msg('C0HELP123'));
    const [item] = inbox(app, support.id);
    expect(item).toContain('Routine "Help desk" was triggered by a Slack message: Answer the question.');
    expect(item.split('<untrusted_content')[0]).not.toContain('dana');
    expect(item).toContain('dana wrote in Slack channel C0HELP123:\nHow do I reset my password?');
  });
});
