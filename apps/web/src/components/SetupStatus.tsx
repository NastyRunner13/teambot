// The last run of an agent's setup script, with its output and a way to run it again.
import { CheckCircle2, LoaderCircle, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Agent, SetupRun } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { useStore } from '../store';

export function SetupStatus({ agent }: { agent: Agent }) {
  const notify = useStore((s) => s.notify);
  // Refresh when a setup starts or ends for this agent.
  const version = useStore((s) => s.events.filter((e) => e.agentId === agent.id && e.type.startsWith('computer.setup')).length);
  const running = useStore((s) => {
    const last = s.events.filter((e) => e.agentId === agent.id && e.type.startsWith('computer.setup')).at(-1);
    return last?.type === 'computer.setup_started';
  });
  const [setup, setSetup] = useState<SetupRun | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ setup: SetupRun | null }>(`/agents/${agent.id}/computer`).then((r) => setSetup(r.setup), () => undefined);
  }, [agent.id, version]);

  if (!agent.setupScript.trim()) return null;

  async function rerun() {
    setBusy(true);
    try {
      const r = await api.post<{ setup: SetupRun | null }>(`/agents/${agent.id}/computer/setup`);
      setSetup(r.setup);
      notify(r.setup?.ok ? 'Setup script finished' : 'Setup script failed — see its output', r.setup?.ok ? 'info' : 'error');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 className="grow">Setup script</h3>
        <button className="btn sm" disabled={busy || running} onClick={rerun}>
          {busy || running ? 'Running…' : 'Run it again'}
        </button>
      </div>
      {running ? (
        <div className="row small muted">
          <LoaderCircle size={14} className="spin" /> Running on {agent.name}'s computer…
        </div>
      ) : setup ? (
        <>
          <div className="row small">
            {setup.ok ? <CheckCircle2 size={14} color="var(--ok)" /> : <XCircle size={14} color="var(--danger)" />}
            <span>
              {setup.ok ? 'Finished' : `Failed${setup.exitCode !== null ? ` (exit code ${setup.exitCode})` : ''}`} {ago(setup.at)}
            </span>
          </div>
          {setup.output && <pre className="json">{setup.output}</pre>}
        </>
      ) : (
        <div className="small muted">Not run yet. It runs before {agent.name} next starts work, or now with “Run it again”.</div>
      )}
    </div>
  );
}
