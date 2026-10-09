// Settings: you and the appearance, the team, spending, secrets, the action policy and the server's health.
// Apps, skills and files are the "Connect apps" sections of the same frame (AppsView).
import { CheckCircle2, KeyRound, Monitor, Moon, Plus, Sun, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { SpendReport } from '@teambot/shared';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { Switch } from '../components/panel/PanelPage';
import { SettingGroup, SettingRow, SettingsHeader, SettingsPage, SettingsShell } from '../components/settings/SettingsShell';
import { TeamSettings } from '../components/TeamSettings';
import { money } from '../lib/format';
import { useTheme, type Theme } from '../lib/theme';
import { useStore } from '../store';

export type SettingsSection = 'general' | 'team' | 'spending' | 'secrets' | 'policy' | 'system';
export const SETTINGS_SECTIONS: SettingsSection[] = ['general', 'team', 'spending', 'secrets', 'policy', 'system'];

const fail = (err: unknown) => useStore.getState().notify((err as Error).message, 'error');

/** Members can read the workspace's settings; only owners change them (the server enforces it too). */
function useCanManage() {
  const teamMode = useStore((s) => s.teamMode);
  const role = useStore((s) => s.me?.role);
  return !teamMode || role === 'owner';
}

function OwnerOnly({ children }: { children: ReactNode }) {
  const canManage = useCanManage();
  return (
    <fieldset className="owner-only" disabled={!canManage}>
      {!canManage && <p className="small muted owner-note">Only the workspace owners can change these.</p>}
      {children}
    </fieldset>
  );
}

function General() {
  const me = useStore((s) => s.me);
  const pausedAll = useStore((s) => s.pausedAll);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState(me?.name ?? '');
  const [theme, setTheme] = useTheme();
  useEffect(() => setName(me?.name ?? ''), [me?.name]);

  async function rename() {
    try {
      await api.patch('/me', { name });
      notify('Name updated');
    } catch (err) {
      fail(err);
    }
  }

  async function pause(on: boolean) {
    try {
      await api.post(on ? '/system/pause' : '/system/resume');
      notify(on ? 'All agents paused' : 'All agents resumed');
    } catch (err) {
      fail(err);
    }
  }

  const themes: [Theme, string, typeof Moon][] = [
    ['system', 'Auto', Monitor],
    ['light', 'Light', Sun],
    ['dark', 'Dark', Moon],
  ];
  const changed = name.trim() && name !== me?.name;
  return (
    <SettingsPage>
      <SettingsHeader title="General" />
      <SettingGroup title="Profile">
        <SettingRow title="Your name" description="How agents and teammates address you.">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (changed) void rename();
            }}
          >
            <input className="input setting-input" aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={!changed}>
              Save
            </button>
          </form>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Appearance">
        <SettingRow title="Theme" description="Auto follows your system. Saved in this browser.">
          <div className="segmented icons" role="group" aria-label="Theme">
            {themes.map(([value, label, Icon]) => (
              <button key={value} type="button" aria-pressed={theme === value} aria-label={label} title={label} onClick={() => setTheme(value)}>
                <Icon size={15} />
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Agents">
        <SettingRow
          title="Pause all agents"
          description={pausedAll ? 'Paused. New work waits, and paused runs pick up where they stopped when you switch this off.' : 'Stops what every agent is doing and holds new work until you switch it back off.'}
        >
          <Switch checked={pausedAll} onChange={(on) => void pause(on)} label="Pause all agents" />
        </SettingRow>
      </SettingGroup>
    </SettingsPage>
  );
}

function Spending() {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const [report, setReport] = useState<SpendReport | null>(null);
  const [cap, setCap] = useState('');

  useEffect(() => {
    api.get<SpendReport>('/spend').then((r) => {
      setReport(r);
      setCap(r.workspaceDailyUsd ? String(r.workspaceDailyUsd) : '');
    }, fail);
  }, []);

  async function save() {
    const n = Number(cap);
    try {
      const r = await api.put<SpendReport>('/budget', { workspaceDailyUsd: cap.trim() && n > 0 ? n : null });
      setReport(r);
      notify(r.workspaceDailyUsd ? `Workspace cap set to ${money(r.workspaceDailyUsd)} per day` : 'Workspace cap removed');
    } catch (err) {
      fail(err);
    }
  }

  const current = report?.workspaceDailyUsd ? String(report.workspaceDailyUsd) : '';
  return (
    <SettingsPage>
      <SettingsHeader title="Spending" intro="Model costs as reported by OpenRouter, counted in UTC days and months." />
      <OwnerOnly>
        <SettingGroup title="Limit">
          <SettingRow title="Workspace cap per day" description="Every agent stops once the team's total for the day reaches it. Caps for one agent are on its Customize page.">
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (cap !== current) void save();
              }}
            >
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input className="input" type="number" min="0" step="1" placeholder="No cap" aria-label="Workspace cap per day in US dollars" value={cap} onChange={(e) => setCap(e.target.value)} />
              </span>
              <button className="btn" disabled={!report || cap === current}>
                Save
              </button>
            </form>
          </SettingRow>
        </SettingGroup>
      </OwnerOnly>
      <SettingGroup title="By agent">
        {!report ? (
          <div className="setting-row muted small">Loading…</div>
        ) : (
          <table className="spend-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Today</th>
                <th scope="col">This month</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <th scope="row">
                    <span className="row">
                      <Avatar member={a} size={22} />
                      <span className="ellipsis">{a.name}</span>
                      {(a.budget.dailyUsd || a.budget.monthlyUsd || a.budget.dailyTokens) && <span className="badge">capped</span>}
                    </span>
                  </th>
                  <td>{money(report.agents[a.id]?.today.usd ?? 0)}</td>
                  <td>{money(report.agents[a.id]?.month.usd ?? 0)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Everyone</th>
                <td>{money(report.today.usd)}</td>
                <td>{money(report.month.usd)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </SettingGroup>
    </SettingsPage>
  );
}

function Secrets() {
  const secrets = useStore((s) => s.secrets);
  const notify = useStore((s) => s.notify);
  const canManage = useCanManage();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  async function save() {
    try {
      await api.put(`/secrets/${encodeURIComponent(name)}`, { value });
      notify(`Secret ${name} saved`);
      setName('');
      setValue('');
      setAdding(false);
    } catch (err) {
      fail(err);
    }
  }

  async function remove(secret: string) {
    if (!confirm(`Delete ${secret}? Agents that use it will get an error until you add it again.`)) return;
    try {
      await api.del(`/secrets/${secret}`);
      notify(`${secret} deleted`);
    } catch (err) {
      fail(err);
    }
  }

  const form = (
    <form
      className="row wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (name && value) void save();
      }}
    >
      <input className="input mono" style={{ flex: '0 1 220px' }} placeholder="GITHUB_TOKEN" aria-label="Secret name" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} autoFocus />
      <input className="input" style={{ flex: '1 1 200px' }} type="password" placeholder="Value" aria-label="Secret value" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn primary" disabled={!name || !value}>
        Save secret
      </button>
      <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
        Cancel
      </button>
    </form>
  );

  return (
    <SettingsPage>
      <SettingsHeader
        title="Secrets"
        intro={
          <>
            Encrypted on this machine. Agents never get the values: they write <span className="mono">{'{{secret:NAME}}'}</span> in a tool argument, TeamBot fills it in when the tool runs and
            scrubs it from the output. An agent that may use a secret in a command could still reveal it on purpose, so give each one only what it needs.
          </>
        }
        actions={
          canManage &&
          !adding && (
            <button className="btn" onClick={() => setAdding(true)}>
              <Plus size={15} /> Add secret
            </button>
          )
        }
      />
      <OwnerOnly>
        <SettingGroup>
          {adding && <SettingRow title="New secret" description="Upper-case letters, digits and underscores." below={form} />}
          {secrets.map((s) => (
            <SettingRow key={s} lead={<KeyRound size={16} className="faint" />} title={<span className="mono">{s}</span>}>
              <button className="btn sm ghost danger" onClick={() => void remove(s)} aria-label={`Delete ${s}`}>
                <Trash2 size={14} /> Delete
              </button>
            </SettingRow>
          ))}
          {!secrets.length && !adding && <SettingRow title="No secrets yet" description="Add the API keys and tokens agents should use in commands, like GITHUB_TOKEN. App sign-ins are kept separately." />}
        </SettingGroup>
      </OwnerOnly>
    </SettingsPage>
  );
}

function Policy() {
  const notify = useStore((s) => s.notify);
  const [yaml, setYaml] = useState('');
  const [original, setOriginal] = useState('');
  const [defaults, setDefaults] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ yaml: string; defaultYaml: string; invalid: string | null }>('/policy').then((p) => {
      setYaml(p.yaml);
      setOriginal(p.yaml);
      setDefaults(p.defaultYaml);
      if (p.invalid) setError(`This saved policy can't be used (${p.invalid}), so every action except team tools waits for approval until you fix and save it.`);
    }, fail);
  }, []);

  async function save(text = yaml) {
    setError(null);
    try {
      const p = await api.put<{ yaml: string }>('/policy', { yaml: text });
      setYaml(p.yaml);
      setOriginal(p.yaml);
      notify('Policy saved — it applies to the next action every agent takes');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const actions: [string, string][] = [
    ['allow', 'runs'],
    ['review', 'a reviewer model decides, and asks you when unsure'],
    ['ask', 'waits for you in the chat'],
    ['handoff', 'a human does the step'],
    ['deny', 'never runs'],
  ];
  return (
    <SettingsPage wide>
      <SettingsHeader title="Action policy" intro="Every tool call is checked against these rules before it runs. The strictest matching rule wins; with no match, the tool's risk decides." />
      <ul className="policy-legend">
        {actions.map(([action, text]) => (
          <li key={action}>
            <span className="mono">{action}</span> {text}
          </li>
        ))}
      </ul>
      <OwnerOnly>
        <textarea className="textarea code" spellCheck={false} aria-label="Policy rules (YAML)" value={yaml} onChange={(e) => setYaml(e.target.value)} />
        {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
        <div className="row wrap" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={yaml === original} onClick={() => save()}>
            Save policy
          </button>
          <button className="btn" disabled={yaml === original} onClick={() => setYaml(original)}>
            Discard changes
          </button>
          <span className="spacer" />
          <button className="btn ghost" onClick={() => confirm('Replace your policy with the default?') && save(defaults)}>
            Reset to default
          </button>
        </div>
      </OwnerOnly>
    </SettingsPage>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`status-text ${ok ? 'ok' : 'bad'}`}>
      {ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />} {children}
    </span>
  );
}

function System() {
  const health = useStore((s) => s.health);
  if (!health) return null;
  const t = health.telemetry;
  return (
    <SettingsPage>
      <SettingsHeader title="System" intro={<>What this TeamBot server runs on. These come from <span className="mono">.env</span>; restart the server after changing it.</>} />
      <SettingGroup title="Health">
        <SettingRow
          title="OpenRouter API key"
          description={
            health.offlineModels ? (
              <>Agents use a canned echo. To use real models, set <span className="mono">OPENROUTER_API_KEY</span>, remove <span className="mono">TEAMBOT_OFFLINE_MODELS</span>, and restart the server.</>
            ) : health.openrouterKey ? (
              'Agents think through OpenRouter, with any model per agent.'
            ) : (
              <>Add <span className="mono">OPENROUTER_API_KEY</span> to <span className="mono">.env</span> and restart the server.</>
            )
          }
        >
          <Status ok={health.openrouterKey || health.offlineModels}>
            {health.offlineModels ? 'Offline (echo)' : health.openrouterKey ? 'Set' : 'Missing'}
          </Status>
        </SettingRow>
        <SettingRow title="Docker" description={health.docker ? "Each agent's computer is a Docker container." : "Agents can't use their computers. Start Docker Desktop."}>
          <Status ok={health.docker}>{health.docker ? 'Reachable' : 'Not reachable'}</Status>
        </SettingRow>
        <SettingRow
          title="Agent computer image"
          description={
            health.computerImage || health.computerImagePulling ? (
              <>
                The image agents' computers start from: <span className="mono">{health.computerImageName}</span>.
              </>
            ) : (
              <>
                Run <span className="mono">pnpm computer:build</span>, or <span className="mono">docker pull {health.computerImageName}</span>.
              </>
            )
          }
        >
          <Status ok={health.computerImage}>{health.computerImage ? 'Ready' : health.computerImagePulling ? 'Downloading…' : 'Missing'}</Status>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Models">
        <SettingRow title="New agents" description={<>The model an agent starts with (<span className="mono">TEAMBOT_DEFAULT_MODEL</span>). Change it per agent on its Customize page.</>}>
          <span className="mono small setting-value">{health.defaultModel}</span>
        </SettingRow>
        <SettingRow title="Reviewer" description={<>Decides policy rules with action <span className="mono">review</span> (<span className="mono">TEAMBOT_REVIEWER_MODEL</span>).</>}>
          <span className="mono small setting-value">{health.reviewerModel}</span>
        </SettingRow>
        <SettingRow title="Utility" description={<>Summarizes long runs (<span className="mono">TEAMBOT_UTILITY_MODEL</span>).</>}>
          <span className="mono small setting-value">{health.utilityModel}</span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Observability">
        <SettingRow
          title="OpenTelemetry export"
          description={
            t.enabled ? (
              t.error ?? <>Logs and traces go to <span className="mono">{t.endpoint}</span>.</>
            ) : (
              <>Set <span className="mono">OTEL_EXPORTER_OTLP_ENDPOINT</span> to send logs and traces.</>
            )
          }
        >
          {t.enabled ? <Status ok={!t.error}>{t.error ? 'Failing' : 'On'}</Status> : <span className="muted small">Off</span>}
        </SettingRow>
      </SettingGroup>
    </SettingsPage>
  );
}

export function SettingsView({ section }: { section: SettingsSection }) {
  const refresh = useStore((s) => s.refresh);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <SettingsShell active={section}>
      {section === 'general' && <General />}
      {section === 'team' && <TeamSettings />}
      {section === 'spending' && <Spending />}
      {section === 'secrets' && <Secrets />}
      {section === 'policy' && <Policy />}
      {section === 'system' && <System />}
    </SettingsShell>
  );
}
