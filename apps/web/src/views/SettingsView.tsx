// Settings: your name, system health, the team, connectors, chat bridges, secrets and the action policy.
import { CheckCircle2, KeyRound, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SpendReport } from '@teambot/shared';
import { api } from '../api';
import { ConnectorSettings } from '../components/ConnectorSettings';
import { SlackSettings } from '../components/SlackSettings';
import { TeamSettings } from '../components/TeamSettings';
import { TelegramSettings } from '../components/TelegramSettings';
import { money } from '../lib/format';
import { useStore } from '../store';

function Check({ ok, label, fix }: { ok: boolean; label: string; fix?: React.ReactNode }) {
  return (
    <div className="list-row">
      {ok ? <CheckCircle2 size={16} color="var(--ok)" /> : <XCircle size={16} color="var(--danger)" />}
      <span className="grow">{label}</span>
      {!ok && fix && <span className="small muted">{fix}</span>}
    </div>
  );
}

function Secrets() {
  const secrets = useStore((s) => s.secrets);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');

  async function save() {
    try {
      await api.put(`/secrets/${encodeURIComponent(name)}`, { value });
      setName('');
      setValue('');
      notify(`Secret ${name} saved`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div className="section">
      <h2>Secrets</h2>
      <p className="muted small">
        Encrypted on this machine. Agents don't get the values in their prompts: they write <span className="mono">{'{{secret:NAME}}'}</span> in a tool argument and TeamBot fills it in when the
        tool runs, then scrubs it from the output. An agent that may use a secret in a command could still reveal it on purpose, so give each agent only what it needs.
      </p>
      {secrets.length > 0 && (
        <div className="list" style={{ marginBottom: 12 }}>
          {secrets.map((s) => (
            <div key={s} className="list-row">
              <KeyRound size={14} className="faint" />
              <span className="grow mono">{s}</span>
              <button
                className="btn sm ghost danger"
                onClick={() => confirm(`Delete ${s}?`) && api.del(`/secrets/${s}`).catch((err) => notify((err as Error).message, 'error'))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <input className="input mono" style={{ width: 220 }} placeholder="GITHUB_TOKEN" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))} />
        <input className="input grow" type="password" placeholder="value" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn primary" disabled={!name || !value} onClick={save}>
          Save secret
        </button>
      </div>
    </div>
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
    });
  }, []);

  async function save() {
    const n = Number(cap);
    try {
      const r = await api.put<SpendReport>('/budget', { workspaceDailyUsd: cap.trim() && n > 0 ? n : null });
      setReport(r);
      notify(r.workspaceDailyUsd ? `Workspace cap set to ${money(r.workspaceDailyUsd)} per day` : 'Workspace cap removed');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  if (!report) return null;
  const current = report.workspaceDailyUsd ? String(report.workspaceDailyUsd) : '';
  return (
    <div className="section">
      <h2>Spending</h2>
      <p className="muted small">
        Model costs as reported by OpenRouter, in UTC days and months. Set caps per agent in its Customize tab; the workspace cap stops every agent once the team's total for
        the day reaches it.
      </p>
      <div className="list" style={{ marginBottom: 12 }}>
        <div className="list-row small muted">
          <span className="grow">Agent</span>
          <span className="spend-col">Today</span>
          <span className="spend-col">This month</span>
        </div>
        {agents.map((a) => (
          <div key={a.id} className="list-row">
            <span className="grow ellipsis">
              {a.avatar} {a.name}
              {(a.budget.dailyUsd || a.budget.monthlyUsd || a.budget.dailyTokens) && <span className="small faint"> · capped</span>}
            </span>
            <span className="spend-col mono small">{money(report.agents[a.id]?.today.usd ?? 0)}</span>
            <span className="spend-col mono small">{money(report.agents[a.id]?.month.usd ?? 0)}</span>
          </div>
        ))}
        <div className="list-row">
          <strong className="grow">Everyone</strong>
          <strong className="spend-col mono small">{money(report.today.usd)}</strong>
          <strong className="spend-col mono small">{money(report.month.usd)}</strong>
        </div>
      </div>
      <div className="row">
        <label className="small" htmlFor="workspace-cap">
          Workspace cap per day (USD)
        </label>
        <input id="workspace-cap" className="input" style={{ width: 140 }} type="number" min="0" step="1" placeholder="No cap" value={cap} onChange={(e) => setCap(e.target.value)} />
        <button className="btn" disabled={cap === current} onClick={save}>
          Save cap
        </button>
      </div>
    </div>
  );
}

function PolicyEditor() {
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
    });
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

  return (
    <div className="section">
      <h2>Action policy</h2>
      <p className="muted small">
        Every tool call is checked against these rules before it runs: <strong>allow</strong>, <strong>review</strong> (a reviewer model decides, and asks you when unsure),{' '}
        <strong>ask</strong> (wait in Approvals), <strong>handoff</strong> (a human does the step) or <strong>deny</strong>. The strictest matching rule wins.
      </p>
      <textarea className="textarea code" spellCheck={false} value={yaml} onChange={(e) => setYaml(e.target.value)} />
      {error && <div className="error-text" style={{ marginTop: 6 }}>{error}</div>}
      <div className="row" style={{ marginTop: 10 }}>
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
    </div>
  );
}

export function SettingsView() {
  const me = useStore((s) => s.me);
  const health = useStore((s) => s.health);
  const refresh = useStore((s) => s.refresh);
  const notify = useStore((s) => s.notify);
  const [name, setName] = useState(me?.name ?? '');
  const teamMode = useStore((s) => s.teamMode);
  const canManage = !teamMode || me?.role === 'owner';

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      <div className="page-header">
        <h1 className="grow">Settings</h1>
      </div>
      <div className="page page-narrow">
        <h2>You</h2>
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input" style={{ width: 260 }} value={name} onChange={(e) => setName(e.target.value)} />
          <button
            className="btn"
            disabled={!name.trim() || name === me?.name}
            onClick={() =>
              api
                .patch('/me', { name })
                .then(() => notify('Name updated'))
                .catch((err) => notify((err as Error).message, 'error'))
            }
          >
            Rename
          </button>
        </div>

        <div className="section">
          <h2>System</h2>
          {health && (
            <div className="list">
              <Check ok={health.openrouterKey} label="OpenRouter API key" fix={<>add OPENROUTER_API_KEY to .env and restart</>} />
              <Check ok={health.docker} label="Docker is reachable (agent computers)" fix="start Docker Desktop" />
              <Check ok={health.computerImage} label="Agent computer image is built" fix={<span className="mono">pnpm computer:build</span>} />
              <div className="list-row">
                <span className="grow">Default model for new agents</span>
                <span className="mono small">{health.defaultModel}</span>
              </div>
              <div className="list-row">
                <span className="grow">
                  Reviewer model <span className="small muted">(policy rules with action: review)</span>
                </span>
                <span className="mono small">{health.reviewerModel}</span>
              </div>
              <div className="list-row">
                <span className="grow">
                  Utility model <span className="small muted">(summarizing long runs)</span>
                </span>
                <span className="mono small">{health.utilityModel}</span>
              </div>
              {health.telemetry.enabled ? (
                <Check ok={!health.telemetry.error} label={`OpenTelemetry export to ${health.telemetry.endpoint}`} fix={health.telemetry.error ?? undefined} />
              ) : (
                <div className="list-row">
                  <span className="grow">OpenTelemetry export</span>
                  <span className="small muted">
                    off — set <span className="mono">OTEL_EXPORTER_OTLP_ENDPOINT</span> to send logs and traces
                  </span>
                </div>
              )}
              {health.mcpServers
                .filter((s) => s.source === 'file')
                .map((s) => (
                  <Check key={s.name} ok={s.connected} label={`MCP server "${s.name}" from mcp.json (${s.tools} tools)`} fix={s.error} />
                ))}
            </div>
          )}
        </div>

        <TeamSettings />
        {/* Members can read these; only owners change them (the server enforces it too). */}
        <fieldset className="owner-only" disabled={!canManage}>
          {!canManage && <p className="small muted owner-note">Only the workspace owners can change the settings below.</p>}
          <ConnectorSettings />
          <Spending />
          <TelegramSettings />
          <SlackSettings />
          <Secrets />
          <PolicyEditor />
        </fieldset>
      </div>
    </>
  );
}
