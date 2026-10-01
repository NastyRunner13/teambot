// Sites an allowlisted agent tried to reach and was refused, with a one-click way to allow them.
import { ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Agent, EventRecord } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { useStore } from '../store';

export function BlockedSites({ agent }: { agent: Agent }) {
  const notify = useStore((s) => s.notify);
  const live = useStore((s) => s.events.filter((e) => e.type === 'egress.blocked' && e.agentId === agent.id).length);
  const [events, setEvents] = useState<EventRecord[]>([]);

  useEffect(() => {
    if (agent.network.mode !== 'allowlist') return;
    api.get<EventRecord[]>(`/events?agentId=${agent.id}&types=egress.blocked&limit=50`).then(setEvents, () => undefined);
  }, [agent.id, agent.network.mode, live]);

  if (agent.network.mode !== 'allowlist') return null;
  const latest = new Map<string, string>();
  for (const e of events) {
    const host = String(e.data.host);
    if (!latest.has(host) && !agent.network.allow.includes(host)) latest.set(host, e.ts);
  }

  async function allow(host: string) {
    try {
      await api.patch(`/agents/${agent.id}`, { network: { mode: 'allowlist', allow: [...agent.network.allow, host] } });
      notify(`${agent.name} can now reach ${host}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div className="section">
      <h3 style={{ marginBottom: 8 }}>Internet access: allowlist</h3>
      <p className="small muted" style={{ margin: '0 0 10px' }}>
        {agent.name} can only reach {agent.network.allow.length ? agent.network.allow.join(', ') : 'nothing'}. Change the list in Customize.
      </p>
      {latest.size > 0 ? (
        <div className="list">
          {[...latest].slice(0, 12).map(([host, ts]) => (
            <div key={host} className="list-row">
              <ShieldOff size={14} className="faint" />
              <span className="grow mono small">{host}</span>
              <span className="small faint">blocked {ago(ts)}</span>
              <button className="btn sm" onClick={() => allow(host)}>
                Allow
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="small muted">Nothing blocked recently.</div>
      )}
    </div>
  );
}
