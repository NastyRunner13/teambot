// Snapshots of an agent's home folder: take one before risky work, restore it if things go wrong.
import { Archive } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Agent, Snapshot } from '@teambot/shared';
import { api } from '../api';
import { ago, bytes } from '../lib/format';
import { useStore } from '../store';

export function SnapshotList({ agent }: { agent: Agent }) {
  const notify = useStore((s) => s.notify);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => api.get<Snapshot[]>(`/agents/${agent.id}/snapshots`).then(setSnapshots, () => setSnapshots([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    try {
      await fn();
      notify(done);
      await load();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="section">
      <h3 style={{ marginBottom: 6 }}>Snapshots</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        A copy of {agent.name}'s home folder: files, browser logins and anything it installed there. Restoring replaces the folder with the copy.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Label, e.g. Before the upgrade" aria-label="Snapshot label" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn" disabled={!!busy} onClick={() => run('take', () => api.post(`/agents/${agent.id}/snapshots`, { label }).then(() => setLabel('')), 'Snapshot saved')}>
          {busy === 'take' ? 'Saving…' : 'Take snapshot'}
        </button>
      </div>
      {snapshots && snapshots.length > 0 && (
        <div className="list">
          {snapshots.map((s) => (
            <div key={s.id} className="list-row">
              <Archive size={14} className="faint" />
              <span className="grow ellipsis">
                <strong>{s.label}</strong> <span className="small muted">· {ago(s.createdAt)} · {bytes(s.size)}</span>
              </span>
              <button
                className="btn sm"
                disabled={!!busy}
                onClick={() =>
                  confirm(`Restore "${s.label}"? ${agent.name}'s home folder is replaced with this copy.`) &&
                  run(s.id, () => api.post(`/agents/${agent.id}/snapshots/${s.id}/restore`), 'Snapshot restored')
                }
              >
                {busy === s.id ? 'Restoring…' : 'Restore'}
              </button>
              <button className="btn sm ghost danger" disabled={!!busy} onClick={() => confirm('Delete this snapshot?') && run(`del-${s.id}`, () => api.del(`/agents/${agent.id}/snapshots/${s.id}`), 'Snapshot deleted')}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
