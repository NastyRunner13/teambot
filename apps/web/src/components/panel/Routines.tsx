// An agent's routines: work handed to it on a schedule or when something happens (webhook, email, Slack, calendar).
// The panel lists them; each opens to its instruction and schedule, and to an editor.
import { BookOpen, CalendarClock, CalendarDays, Copy, Eye, Mail, MessagesSquare, Play, Plus, RefreshCw, Trash2, Webhook, X } from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent, RoutineTrigger, Schedule } from '@teambot/shared';
import { api } from '../../api';
import { DAY_SHORT, describeCron, describeSchedule, fromCron, toCron, type Frequency, type SimpleSchedule } from '../../lib/cron';
import { ago, until } from '../../lib/format';
import { useStore } from '../../store';
import { PanelPage, Switch } from './PanelPage';

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
  { value: 'webhook', label: 'When a webhook is called' },
  { value: 'email', label: 'When an email arrives' },
  { value: 'slack', label: 'On a Slack message' },
  { value: 'calendar', label: 'Before a calendar event' },
];

const ICONS: Record<RoutineTrigger, typeof CalendarClock> = { schedule: CalendarClock, webhook: Webhook, email: Mail, slack: MessagesSquare, calendar: CalendarDays };

const PLACEHOLDERS: Record<RoutineTrigger, [string, string]> = {
  schedule: ['Morning news digest', 'Check Hacker News for posts about AI agents and post the top 5 with one-line summaries.'],
  webhook: ['Triage new alerts', 'A monitoring alert arrived. Check whether the service is really down and tell me what you find.'],
  email: ['File invoices', 'An invoice arrived. Save the PDF to /shared/finance, add a row to /shared/finance/invoices.csv, and tell me if anything is overdue.'],
  slack: ['Help desk', 'Someone asked a question in our help channel. Answer it from the docs in /shared/docs, or tell me if you can’t.'],
  calendar: ['Meeting prep', 'A meeting is about to start. Write a one-page brief on the attendees and the topic in /shared/briefs.'],
};

/** When the routine runs, in words. */
export function whenItRuns(s: Schedule): string {
  const c = s.config;
  switch (s.trigger) {
    case 'schedule':
      return describeCron(s.cron);
    case 'webhook':
      return 'Whenever its webhook is called';
    case 'email':
      return `When mail arrives for ${c.user}${c.from ? ` from ${c.from}` : ''}${c.subject ? ` about “${c.subject}”` : ''}`;
    case 'slack':
      return `On new messages in Slack ${c.channel}`;
    case 'calendar':
      return `${c.minutesBefore ?? 10} min before each calendar event`;
  }
}

const blankForm = () => ({
  name: '',
  trigger: 'schedule' as RoutineTrigger,
  schedule: fromCron('0 9 * * 1-5'),
  prompt: '',
  channelId: '',
  skill: '',
  readOnly: false,
  config: { host: '', port: 993, user: '', mailbox: 'INBOX', from: '', subject: '', channel: '', minutesBefore: 10 },
  secret: '',
});
type Form = ReturnType<typeof blankForm>;

const formFrom = (s: Schedule): Form => {
  const blank = blankForm();
  return {
    ...blank,
    name: s.name,
    trigger: s.trigger,
    schedule: s.trigger === 'schedule' ? fromCron(s.cron) : blank.schedule,
    prompt: s.prompt,
    channelId: s.channelId ?? '',
    skill: s.skill ?? '',
    readOnly: s.readOnly,
    config: { ...blank.config, ...Object.fromEntries(Object.entries(s.config).filter(([, v]) => v !== undefined)) },
  };
};

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'days', label: 'On certain days' },
  { value: 'hours', label: 'Every few hours' },
  { value: 'minutes', label: 'Every few minutes' },
  { value: 'custom', label: 'Custom (cron)' },
];

/** Pick when a scheduled routine runs, in your own time zone. */
function ScheduleBuilder({ value, onChange, error }: { value: SimpleSchedule; onChange: (s: SimpleSchedule) => void; error: string | null }) {
  const set = (patch: Partial<SimpleSchedule>) => onChange({ ...value, ...patch });
  const f = value.frequency;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="field schedule-builder">
      <label htmlFor="routine-frequency">When to run</label>
      <select
        id="routine-frequency"
        className="select"
        value={f}
        onChange={(e) => {
          const frequency = e.target.value as Frequency;
          const now = toCron(value);
          set({ frequency, ...(frequency === 'custom' && 'cron' in now ? { cron: now.cron } : {}) });
        }}
      >
        {FREQUENCIES.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {f === 'days' && (
        <div className="day-picks" role="group" aria-label="Days">
          {DAY_SHORT.map((d, i) => (
            <button key={d} type="button" aria-pressed={value.days.includes(i)} onClick={() => set({ days: value.days.includes(i) ? value.days.filter((x) => x !== i) : [...value.days, i].sort() })}>
              {d}
            </button>
          ))}
        </div>
      )}
      {(f === 'daily' || f === 'weekdays' || f === 'weekends' || f === 'days') && (
        <div className="time-picks">
          {value.times.map((t, i) => (
            <span key={i} className="time-pick">
              <input
                type="time"
                className="input"
                aria-label={`Time ${i + 1}`}
                value={t}
                onChange={(e) => set({ times: value.times.map((x, j) => (j === i ? e.target.value : x)) })}
              />
              {value.times.length > 1 && (
                <button type="button" className="icon-btn sm" aria-label="Remove this time" title="Remove" onClick={() => set({ times: value.times.filter((_, j) => j !== i) })}>
                  <X size={14} />
                </button>
              )}
            </span>
          ))}
          <button type="button" className="btn sm ghost" onClick={() => set({ times: [...value.times, value.times.at(-1) ?? '09:00'] })}>
            <Plus size={13} /> Add a time
          </button>
        </div>
      )}
      {(f === 'hours' || f === 'minutes') && (
        <div className="row small">
          Every
          <input
            className="input"
            type="number"
            style={{ width: 80 }}
            min={1}
            max={f === 'hours' ? 23 : 59}
            aria-label={f === 'hours' ? 'Hours between runs' : 'Minutes between runs'}
            value={value.every}
            onChange={(e) => set({ every: Math.max(1, Number(e.target.value) || 1) })}
          />
          {f === 'hours' ? 'hours' : 'minutes'}
        </div>
      )}
      {f === 'custom' && <input className="input mono" aria-label="Cron expression" value={value.cron} onChange={(e) => set({ cron: e.target.value })} />}
      {error ? (
        <span className="error-text small">{error}</span>
      ) : (
        <span className="hint">
          {describeSchedule(value)}
          {f === 'custom' ? ' — e.g. 0 9 * * 1-5 is weekdays at 09:00 UTC' : f === 'hours' || f === 'minutes' ? '' : ` · your time (${zone})`}
        </span>
      )}
    </div>
  );
}

function TriggerFields({ form, set, keepSecret }: { form: Form; set: (f: Partial<Form>) => void; keepSecret: boolean }) {
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
          <div className="field" style={{ width: 90 }}>
            <label htmlFor="mail-port">Port</label>
            <input id="mail-port" className="input mono" type="number" value={c.port} onChange={(e) => config({ port: Number(e.target.value) || 993 })} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="mail-user">User</label>
          <input id="mail-user" className="input" autoComplete="off" placeholder="you@example.com" value={c.user} onChange={(e) => config({ user: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="mail-pass">Password</label>
          <input
            id="mail-pass"
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={keepSecret ? 'Leave empty to keep the saved one' : 'An app password'}
            value={form.secret}
            onChange={(e) => set({ secret: e.target.value })}
          />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label htmlFor="mail-from">Only mail from</label>
            <input id="mail-from" className="input" placeholder="client.com" value={c.from} onChange={(e) => config({ from: e.target.value })} />
          </div>
          <div className="field grow">
            <label htmlFor="mail-subject">Subject contains</label>
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
          Connect Slack in Connect apps first, then invite the TeamBot app to the channel (/invite @TeamBot). The ID is at the bottom of the channel's details in Slack.
        </span>
      </div>
    );
  }
  if (form.trigger === 'calendar') {
    return (
      <>
        <div className="field">
          <label htmlFor="cal-url">Calendar’s iCal address</label>
          <input
            id="cal-url"
            className="input mono"
            type="password"
            autoComplete="off"
            placeholder={keepSecret ? 'Leave empty to keep the saved one' : 'https://calendar.google.com/calendar/ical/…/basic.ics'}
            value={form.secret}
            onChange={(e) => set({ secret: e.target.value })}
          />
          <span className="hint">Google Calendar: Settings → your calendar → “Secret address in iCal format”. It is stored encrypted, and agents can't see it.</span>
        </div>
        <div className="field" style={{ width: 160 }}>
          <label htmlFor="cal-lead">Minutes before</label>
          <input id="cal-lead" className="input mono" type="number" min={0} value={c.minutesBefore} onChange={(e) => config({ minutesBefore: Math.max(0, Number(e.target.value) || 0) })} />
        </div>
      </>
    );
  }
  return null;
}

/** The routines section of an agent's details. */
export function RoutineList({ agent }: { agent: Agent }) {
  // useShallow: a freshly filtered array on every read would re-render forever.
  const schedules = useStore(useShallow((s) => s.schedules.filter((x) => x.agentId === agent.id)));
  const showPanel = useStore((s) => s.showPanel);
  const notify = useStore((s) => s.notify);
  const create = () => showPanel({ view: { kind: 'routine-edit', agentId: agent.id, id: null } });

  return (
    <section className="panel-section">
      <div className="panel-label">
        Routines
        <button className="icon-btn sm" onClick={create} aria-label="New routine" title="New routine">
          <Plus size={15} />
        </button>
      </div>
      {schedules.length === 0 && (
        <button className="panel-empty" onClick={create}>
          Give {agent.name} recurring work: on a schedule, or when a webhook, an email, a Slack message or a meeting comes in.
        </button>
      )}
      {schedules.map((s) => (
        <div
          key={s.id}
          className={`routine-card ${s.enabled ? '' : 'off'}`}
          role="button"
          tabIndex={0}
          onClick={() => showPanel({ view: { kind: 'routine', id: s.id } })}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), showPanel({ view: { kind: 'routine', id: s.id } }))}
        >
          <div className="grow" style={{ minWidth: 0 }}>
            <strong className="ellipsis">{s.name}</strong>
            <span className="ellipsis">{whenItRuns(s)}</span>
          </div>
          <Switch
            checked={s.enabled}
            label={s.enabled ? `Pause ${s.name}` : `Turn on ${s.name}`}
            onChange={(on) => void api.patch(`/schedules/${s.id}`, { enabled: on }).catch((err) => notify((err as Error).message, 'error'))}
          />
        </div>
      ))}
    </section>
  );
}

/** One routine: what it does, when, and where it reports. */
export function RoutineDetail({ id }: { id: string }) {
  const s = useStore((st) => st.schedules.find((x) => x.id === id));
  const channel = useStore((st) => st.channels.find((c) => c.id === s?.channelId));
  const showPanel = useStore((st) => st.showPanel);
  const closeView = useStore((st) => st.closeView);
  const notify = useStore((st) => st.notify);
  const [checking, setChecking] = useState(false);

  if (!s) {
    return (
      <PanelPage title="Routine">
        <p className="muted">This routine was deleted.</p>
      </PanelPage>
    );
  }
  const Icon = ICONS[s.trigger] ?? CalendarClock;
  const call = (p: Promise<unknown>, done?: string) => p.then(() => done && notify(done)).catch((err) => notify((err as Error).message, 'error'));
  const polled = s.trigger === 'email' || s.trigger === 'calendar';

  async function checkNow() {
    setChecking(true);
    try {
      const r = await api.post<Schedule>(`/schedules/${s!.id}/check`);
      if (r.triggerStatus?.error) notify(r.triggerStatus.error, 'error');
      else notify(s!.trigger === 'email' ? 'Mail checked' : 'Calendar checked');
      await useStore.getState().refresh();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  }

  return (
    <PanelPage
      title={s.name}
      footer={
        <>
          <button className="btn pill grow" onClick={() => call(api.patch(`/schedules/${s.id}`, { enabled: !s.enabled }), s.enabled ? 'Routine paused' : 'Routine is on')}>
            {s.enabled ? 'Pause' : 'Resume'}
          </button>
          <button className="btn pill grow" onClick={() => showPanel({ view: { kind: 'routine-edit', agentId: s.agentId, id: s.id } })}>
            Edit
          </button>
          <button className="btn pill icon" title="Run it now" aria-label="Run it now" onClick={() => call(api.post(`/schedules/${s.id}/run`), 'Started')}>
            <Play size={15} />
          </button>
          <button
            className="btn pill icon danger"
            title="Delete this routine"
            aria-label="Delete this routine"
            onClick={() => confirm(`Delete the routine “${s.name}”?`) && void call(api.del(`/schedules/${s.id}`).then(closeView), 'Routine deleted')}
          >
            <Trash2 size={15} />
          </button>
        </>
      }
    >
      <div className="detail-label">Instruction</div>
      <div className="detail-text">{s.prompt}</div>
      <div className="detail-label">When to run</div>
      <div className="detail-when">
        <Icon size={15} /> {whenItRuns(s)}
        {!s.enabled && <span className="badge">paused</span>}
      </div>
      {s.trigger === 'webhook' && <WebhookDetails s={s} />}
      {s.triggerStatus?.error && <div className="error-text small">Last check failed: {s.triggerStatus.error}</div>}
      <div className="detail-label">Reports to</div>
      <div className="detail-text">{channel ? `#${channel.name}` : 'Your chat with the agent'}</div>
      {s.skill && (
        <>
          <div className="detail-label">Follows the skill</div>
          <div className="detail-text">
            <BookOpen size={13} style={{ verticalAlign: -2 }} /> <span className="mono">{s.skill}</span>
          </div>
        </>
      )}
      {s.readOnly && (
        <p className="small muted">
          <span className="badge info">read-only</span> Can look and report, but can't run commands, click, type or change files.
        </p>
      )}
      <div className="detail-meta">
        {s.trigger === 'schedule' && <>Next run {s.enabled && s.nextRunAt ? `in ${until(s.nextRunAt)}` : '—'} · </>}
        {polled && <>Checked {ago(s.triggerStatus?.checkedAt)} · </>}
        Last run {ago(s.lastRunAt)}
        {polled && (
          <button className="link-btn" disabled={checking} onClick={() => void checkNow()}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
    </PanelPage>
  );
}

/** Make a routine, or change one. */
export function RoutineEditor({ agentId, id }: { agentId: string; id: string | null }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const existing = useStore((s) => (id ? s.schedules.find((x) => x.id === id) : undefined));
  const channels = useStore(useShallow((s) => s.channels.filter((c) => c.kind === 'channel')));
  const allSkills = useStore((s) => s.skills);
  const notify = useStore((s) => s.notify);
  const showPanel = useStore((s) => s.showPanel);
  const closeView = useStore((s) => s.closeView);
  const [form, setForm] = useState(() => (existing ? formFrom(existing) : blankForm()));
  const [busy, setBusy] = useState(false);
  const t = form.trigger;
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const skills = allSkills.filter((s) => !s.error && agent && (agent.skills.includes('*') || agent.skills.includes(s.name)));
  const cron = t === 'schedule' ? toCron(form.schedule) : { cron: '' };
  const back = () => (id ? showPanel({ view: { kind: 'routine', id } }) : closeView());

  /** Only the settings this trigger uses go to the server. */
  function configFor() {
    const c = form.config;
    if (t === 'email') return { host: c.host.trim(), port: c.port, secure: c.port !== 143, user: c.user.trim(), mailbox: c.mailbox.trim() || 'INBOX', from: c.from.trim(), subject: c.subject.trim() };
    if (t === 'slack') return { channel: c.channel };
    if (t === 'calendar') return { minutesBefore: c.minutesBefore };
    return {};
  }

  async function save() {
    if (!('cron' in cron)) return;
    setBusy(true);
    try {
      const body = {
        name: form.name,
        trigger: t,
        prompt: form.prompt,
        readOnly: form.readOnly,
        cron: cron.cron,
        config: configFor(),
        ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
        channelId: form.channelId || null,
        skill: form.skill || null,
      };
      const saved = id ? await api.patch<Schedule>(`/schedules/${id}`, body) : await api.post<Schedule>('/schedules', { ...body, agentId });
      notify(id ? 'Routine saved' : t === 'webhook' ? 'Routine saved — its webhook URL is on its page' : 'Routine saved');
      showPanel({ view: { kind: 'routine', id: saved.id } });
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const hasSecret = !!existing?.hasSecret && existing.trigger === t;
  const ready =
    !!form.name.trim() &&
    !!form.prompt.trim() &&
    'cron' in cron &&
    (t !== 'email' || (!!form.config.host.trim() && !!form.config.user.trim() && (!!form.secret.trim() || hasSecret))) &&
    (t !== 'slack' || !!form.config.channel) &&
    (t !== 'calendar' || !!form.secret.trim() || hasSecret);

  return (
    <PanelPage
      title={id ? 'Edit routine' : 'New routine'}
      onBack={back}
      footer={
        <>
          <button className="btn pill grow" onClick={back}>
            Cancel
          </button>
          <button className="btn pill primary grow" disabled={!ready || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="routine-name">Name</label>
        <input id="routine-name" className="input" data-autofocus value={form.name} placeholder={PLACEHOLDERS[t][0]} onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="routine-prompt">Instruction</label>
        <textarea id="routine-prompt" className="textarea" rows={7} value={form.prompt} placeholder={PLACEHOLDERS[t][1]} onChange={(e) => set({ prompt: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="routine-trigger">Starts</label>
        <select id="routine-trigger" className="select" value={t} onChange={(e) => set({ trigger: e.target.value as RoutineTrigger, secret: '' })}>
          {TRIGGERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {t === 'webhook' && <span className="hint">You get a URL and a secret token after saving.</span>}
        {(t === 'email' || t === 'slack' || t === 'calendar') && <span className="hint">What arrives is handed over as outside content the agent won’t take orders from.</span>}
      </div>
      {t === 'schedule' && <ScheduleBuilder value={form.schedule} onChange={(schedule) => set({ schedule })} error={'error' in cron ? cron.error : null} />}
      <TriggerFields form={form} set={set} keepSecret={hasSecret} />
      <div className="field">
        <label htmlFor="routine-channel">Report in</label>
        <select id="routine-channel" className="select" value={form.channelId} onChange={(e) => set({ channelId: e.target.value })}>
          <option value="">Your chat with {agent?.name ?? 'the agent'}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              #{c.name}
            </option>
          ))}
        </select>
      </div>
      {skills.length > 0 && (
        <div className="field">
          <label htmlFor="routine-skill">Skill to follow</label>
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
      <label className="check-row">
        <input type="checkbox" checked={form.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
        <span>
          <strong>Read-only</strong> <span className="muted">— for monitoring: the agent can browse and read, but can't run commands, click, type or change files. It stays quiet unless something needs attention.</span>
        </span>
      </label>
    </PanelPage>
  );
}
