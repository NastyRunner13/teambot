// An agent's routines: work handed to it on a schedule or when something happens (webhook, email, Slack, calendar).
import { BookOpen, CalendarClock, CalendarDays, Copy, Eye, Mail, MessagesSquare, RefreshCw, Webhook } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent, RoutineTrigger, Schedule } from '@teambot/shared';
import { api } from '../api';
import { ago, until } from '../lib/format';
import { useStore } from '../store';

function copy(text: string, notify: (t: string, k?: 'info' | 'error') => void) {
  navigator.clipboard.writeText(text).then(
    () => notify('Copied'),
    () => notify('Could not copy; select the text instead', 'error'),
  );
}

function WebhookDetails({ s }: { s: Schedule }) {
  const notify = useStore((st) => st.notify);
  const [shown, setShown] = useState(false);
  const url = `${location.origin}/api/hooks/${s.id}`;
  const token = s.token ?? '';
  const curl = `curl -X POST ${url} \\\n  -H "x-teambot-token: ${shown ? token : '<token>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"text": "something happened"}'`;
  return (
    <div className="webhook-details">
      <div className="row small">
        <span className="muted" style={{ width: 52 }}>URL</span>
        <code className="grow ellipsis">{url}</code>
        <button className="btn ghost sm icon" title="Copy URL" aria-label="Copy URL" onClick={() => copy(url, notify)}>
          <Copy size={13} />
        </button>
      </div>
      <div className="row small">
        <span className="muted" style={{ width: 52 }}>Token</span>
        <code className="grow ellipsis">{shown ? token : '•'.repeat(24)}</code>
        <button className="btn ghost sm icon" title={shown ? 'Hide token' : 'Show token'} aria-label={shown ? 'Hide token' : 'Show token'} onClick={() => setShown(!shown)}>
          <Eye size={13} />
        </button>
        <button className="btn ghost sm icon" title="Copy token" aria-label="Copy token" onClick={() => copy(token, notify)}>
          <Copy size={13} />
        </button>
        <button
          className="btn ghost sm icon"
          title="Make a new token (the old one stops working)"
          aria-label="Make a new token"
          onClick={() => confirm('Make a new token? Anything using the old one stops working.') && api.post(`/schedules/${s.id}/token`).catch((err) => notify((err as Error).message, 'error'))}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <pre className="json">{curl}</pre>
      <div className="small muted">
        Send the token in the <span className="mono">x-teambot-token</span> header (or <span className="mono">?token=</span>). The body is handed to the agent as untrusted content. TeamBot listens on{' '}
        {location.hostname}, so outside services need a tunnel or proxy to reach it.
      </div>
    </div>
  );
}

const TRIGGERS: { value: RoutineTrigger; label: string }[] = [
  { value: 'schedule', label: 'On a schedule' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'email', label: 'Email' },
  { value: 'slack', label: 'Slack message' },
  { value: 'calendar', label: 'Calendar event' },
];

const ICONS: Record<RoutineTrigger, typeof CalendarClock> = { schedule: CalendarClock, webhook: Webhook, email: Mail, slack: MessagesSquare, calendar: CalendarDays };

const PLACEHOLDERS: Record<RoutineTrigger, [string, string]> = {
  schedule: ['Morning news digest', 'Check Hacker News for posts about AI agents and post the top 5 with one-line summaries.'],
  webhook: ['Triage new alerts', 'A monitoring alert arrived. Check whether the service is really down and tell me what you find.'],
  email: ['File invoices', 'An invoice arrived. Save the PDF to /shared/finance, add a row to /shared/finance/invoices.csv, and tell me if anything is overdue.'],
  slack: ['Help desk', 'Someone asked a question in our help channel. Answer it from the docs in /shared/docs, or tell me if you can’t.'],
  calendar: ['Meeting prep', 'A meeting is about to start. Write a one-page brief on the attendees and the topic in /shared/briefs.'],
};

/** What starts the routine, in a few words for its card. */
function triggerLine(s: Schedule): string {
  const c = s.config;
  switch (s.trigger) {
    case 'schedule':
      return s.cron;
    case 'webhook':
      return 'webhook';
    case 'email':
      return `mail to ${c.user}${c.from ? ` from ${c.from}` : ''}${c.subject ? ` about “${c.subject}”` : ''}`;
    case 'slack':
      return `Slack ${c.channel}`;
    case 'calendar':
      return `${c.minutesBefore ?? 10} min before each event`;
  }
}

const blankForm = () => ({
  name: '',
  trigger: 'schedule' as RoutineTrigger,
  cron: '0 9 * * 1-5',
  prompt: '',
  channelId: '',
  skill: '',
  readOnly: false,
  config: { host: '', port: 993, user: '', mailbox: 'INBOX', from: '', subject: '', channel: '', minutesBefore: 10 },
  secret: '',
});
type Form = ReturnType<typeof blankForm>;

function TriggerFields({ form, set }: { form: Form; set: (f: Partial<Form>) => void }) {
  const c = form.config;
  const config = (patch: Partial<Form['config']>) => set({ config: { ...c, ...patch } });
  if (form.trigger === 'email') {
    return (
      <>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="mail-host">IMAP server</label>
            <input id="mail-host" className="input mono" placeholder="imap.gmail.com" value={c.host} onChange={(e) => config({ host: e.target.value })} />
          </div>
          <div className="field" style={{ width: 100 }}>
            <label htmlFor="mail-port">Port</label>
            <input id="mail-port" className="input mono" type="number" value={c.port} onChange={(e) => config({ port: Number(e.target.value) || 993 })} />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="mail-user">User</label>
            <input id="mail-user" className="input" autoComplete="off" placeholder="you@example.com" value={c.user} onChange={(e) => config({ user: e.target.value })} />
          </div>
          <div className="field grow">
            <label htmlFor="mail-pass">Password</label>
            <input id="mail-pass" className="input" type="password" autoComplete="new-password" placeholder="An app password" value={form.secret} onChange={(e) => set({ secret: e.target.value })} />
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="mail-from">Only mail from (optional)</label>
            <input id="mail-from" className="input" placeholder="client.com" value={c.from} onChange={(e) => config({ from: e.target.value })} />
          </div>
          <div className="field grow">
            <label htmlFor="mail-subject">Subject contains (optional)</label>
            <input id="mail-subject" className="input" placeholder="invoice" value={c.subject} onChange={(e) => config({ subject: e.target.value })} />
          </div>
        </div>
        <p className="small muted" style={{ margin: '-8px 0 16px' }}>
          Unread matching mail is checked every 2 minutes, handed to the agent and marked read. Attachments are saved in /shared/uploads/email. For Gmail or Outlook, use an
          app password. The password is stored encrypted, and agents can't see it.
        </p>
      </>
    );
  }
  if (form.trigger === 'slack') {
    return (
      <div className="field">
        <label htmlFor="slack-channel">Slack channel ID</label>
        <input id="slack-channel" className="input mono" placeholder="C0123ABCD" value={c.channel} onChange={(e) => config({ channel: e.target.value.trim().toUpperCase() })} />
        <span className="hint">
          Connect Slack in Settings first, then invite the TeamBot app to the channel (/invite @TeamBot). The ID is at the bottom of the channel's details in Slack.
        </span>
      </div>
    );
  }
  if (form.trigger === 'calendar') {
    return (
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="field grow">
          <label htmlFor="cal-url">Calendar’s iCal address</label>
          <input id="cal-url" className="input mono" type="password" autoComplete="off" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" value={form.secret} onChange={(e) => set({ secret: e.target.value })} />
          <span className="hint">Google Calendar: Settings → your calendar → “Secret address in iCal format”. It is stored encrypted, and agents can't see it.</span>
        </div>
        <div className="field" style={{ width: 140 }}>
          <label htmlFor="cal-lead">Minutes before</label>
          <input id="cal-lead" className="input mono" type="number" min={0} value={c.minutesBefore} onChange={(e) => config({ minutesBefore: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
      </div>
    );
  }
  return null;
}

export function RoutinesTab({ agent }: { agent: Agent }) {
  // useShallow: a freshly filtered array on every read would re-render forever.
  const schedules = useStore(useShallow((s) => s.schedules.filter((x) => x.agentId === agent.id)));
  const channels = useStore(useShallow((s) => s.channels.filter((c) => c.kind === 'channel')));
  const allSkills = useStore((s) => s.skills);
  const skills = allSkills.filter((s) => !s.error && (agent.skills.includes('*') || agent.skills.includes(s.name)));
  const notify = useStore((s) => s.notify);
  const [form, setForm] = useState(blankForm);
  const [checking, setChecking] = useState<string | null>(null);
  const t = form.trigger;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  /** Only the settings this trigger uses go to the server. */
  function configFor() {
    const c = form.config;
    if (t === 'email') return { host: c.host.trim(), port: c.port, secure: c.port !== 143, user: c.user.trim(), mailbox: c.mailbox.trim() || 'INBOX', from: c.from.trim(), subject: c.subject.trim() };
    if (t === 'slack') return { channel: c.channel };
    if (t === 'calendar') return { minutesBefore: c.minutesBefore };
    return {};
  }

  async function create() {
    try {
      await api.post<Schedule>('/schedules', {
        name: form.name,
        trigger: t,
        prompt: form.prompt,
        readOnly: form.readOnly,
        cron: t === 'schedule' ? form.cron : '',
        config: configFor(),
        ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
        agentId: agent.id,
        channelId: form.channelId || null,
        skill: form.skill || null,
      });
      setForm(blankForm());
      notify(t === 'webhook' ? 'Routine saved — its webhook URL is below' : 'Routine saved');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }
  const call = (p: Promise<unknown>) => p.catch((err) => notify((err as Error).message, 'error'));

  async function checkNow(s: Schedule) {
    setChecking(s.id);
    try {
      const r = await api.post<Schedule>(`/schedules/${s.id}/check`);
      if (r.triggerStatus?.error) notify(r.triggerStatus.error, 'error');
      else notify(s.trigger === 'email' ? 'Mail checked' : 'Calendar checked');
      await useStore.getState().refresh();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setChecking(null);
    }
  }

  const ready =
    !!form.name.trim() &&
    !!form.prompt.trim() &&
    (t !== 'schedule' || !!form.cron.trim()) &&
    (t !== 'email' || (!!form.config.host.trim() && !!form.config.user.trim() && !!form.secret.trim())) &&
    (t !== 'slack' || !!form.config.channel) &&
    (t !== 'calendar' || !!form.secret.trim());

  return (
    <div className="page page-narrow">
      <h2>Routines</h2>
      <p className="muted">
        Recurring work: on a schedule, or when something happens (a webhook, an email, a Slack message, an upcoming meeting), {agent.name} gets the prompt and does the job,
        reporting in the chosen channel.
      </p>
      {schedules.length === 0 && <div className="empty">No routines yet.</div>}
      {schedules.map((s) => {
        const Icon = ICONS[s.trigger] ?? CalendarClock;
        const polled = s.trigger === 'email' || s.trigger === 'calendar';
        return (
          <div key={s.id} className="card">
            <div className="card-title">
              <Icon size={15} />
              <span className="grow">{s.name}</span>
              {s.readOnly && (
                <span className="badge info" title="Can look and report, but not change anything">
                  read-only
                </span>
              )}
              <span className="badge mono ellipsis" style={{ maxWidth: 320 }} title={triggerLine(s)}>
                {triggerLine(s)}
              </span>
              <label className="row small">
                <input type="checkbox" checked={s.enabled} onChange={(e) => call(api.patch(`/schedules/${s.id}`, { enabled: e.target.checked }))} /> on
              </label>
            </div>
            <div style={{ margin: '6px 0' }}>{s.prompt}</div>
            {s.skill && (
              <div className="small muted" style={{ marginBottom: 6 }}>
                <BookOpen size={12} style={{ verticalAlign: -1 }} /> Follows the skill <span className="mono">{s.skill}</span>
              </div>
            )}
            {s.trigger === 'webhook' && <WebhookDetails s={s} />}
            {s.triggerStatus?.error && <div className="error-text small" style={{ marginBottom: 6 }}>Last check failed: {s.triggerStatus.error}</div>}
            <div className="row small muted">
              <span className="grow">
                {s.trigger === 'schedule' && <>Next: {s.enabled && s.nextRunAt ? `in ${until(s.nextRunAt)}` : '—'} · </>}
                {polled && <>Checked: {ago(s.triggerStatus?.checkedAt)} · </>}
                last run: {ago(s.lastRunAt)}
              </span>
              {polled && (
                <button className="btn sm" disabled={checking === s.id} onClick={() => checkNow(s)}>
                  {checking === s.id ? 'Checking…' : 'Check now'}
                </button>
              )}
              <button className="btn sm" onClick={() => call(api.post(`/schedules/${s.id}/run`))}>
                Run now
              </button>
              <button className="btn sm danger" onClick={() => confirm('Delete this routine?') && call(api.del(`/schedules/${s.id}`))}>
                Delete
              </button>
            </div>
          </div>
        );
      })}
      <div className="section card">
        <h3 style={{ marginBottom: 10 }}>New routine</h3>
        <div className="field">
          <span className="field-label">Starts</span>
          <div className="segmented wrap" role="group" aria-label="What starts the routine" style={{ alignSelf: 'flex-start' }}>
            {TRIGGERS.map((o) => (
              <button key={o.value} aria-pressed={t === o.value} onClick={() => set({ trigger: o.value, secret: '' })}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="routine-name">Name</label>
            <input id="routine-name" className="input" value={form.name} placeholder={PLACEHOLDERS[t][0]} onChange={(e) => set({ name: e.target.value })} />
          </div>
          {t === 'schedule' && (
            <div className="field" style={{ width: 180 }}>
              <label htmlFor="routine-cron">Schedule (cron, UTC)</label>
              <input id="routine-cron" className="input mono" value={form.cron} onChange={(e) => set({ cron: e.target.value })} />
            </div>
          )}
        </div>
        <TriggerFields form={form} set={set} />
        <div className="field">
          <label htmlFor="routine-prompt">What to do</label>
          <textarea id="routine-prompt" className="textarea" value={form.prompt} placeholder={PLACEHOLDERS[t][1]} onChange={(e) => set({ prompt: e.target.value })} />
        </div>
        {skills.length > 0 && (
          <div className="field">
            <label htmlFor="routine-skill">Skill to follow (optional)</label>
            <select id="routine-skill" className="select" value={form.skill} onChange={(e) => set({ skill: e.target.value })}>
              <option value="">None</option>
              {skills.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <label className="row small" style={{ marginBottom: 16 }}>
          <input type="checkbox" checked={form.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
          <span>
            <strong>Read-only</strong> <span className="muted">— for monitoring: the agent can browse and read, but can't run commands, click, type or change files. It stays quiet unless something needs attention.</span>
          </span>
        </label>
        <div className="row">
          <select className="select" style={{ width: 240 }} value={form.channelId} aria-label="Where to report" onChange={(e) => set({ channelId: e.target.value })}>
            <option value="">Report in a DM with me</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                Report in #{c.name}
              </option>
            ))}
          </select>
          <span className="small muted grow">
            {t === 'schedule' ? (
              <>
                e.g. <span className="mono">0 9 * * 1-5</span> = weekdays 09:00 · <span className="mono">*/30 * * * *</span> = every 30 min
              </>
            ) : t === 'webhook' ? (
              'You get a URL and a secret token after saving.'
            ) : (
              'What arrives is handed over as outside content the agent won’t take orders from.'
            )}
          </span>
          <button className="btn primary" disabled={!ready} onClick={create}>
            Save routine
          </button>
        </div>
      </div>
    </div>
  );
}
