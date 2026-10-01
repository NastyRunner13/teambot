// Side panel: watch an agent's computer and its current run from anywhere in the app.
import { ExternalLink, X } from 'lucide-react';
import { useLocation } from 'wouter';
import { activeRunFor, useStore } from '../store';
import { Avatar, StatusBadge } from './Avatar';
import { RunTimeline } from './RunTimeline';
import { Screen } from './Screen';

export function Dock({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const run = useStore((s) => activeRunFor(s.runs, agentId));
  const openDock = useStore((s) => s.openDock);
  const [, navigate] = useLocation();
  if (!agent) return null;

  return (
    <aside className="dock">
      <div className="dock-head">
        <Avatar member={agent} size={30} status />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row">
            <strong>{agent.name}</strong>
            <StatusBadge agent={agent} />
          </div>
          <div className="small muted ellipsis">{run ? run.title : agent.role}</div>
        </div>
        <button className="btn ghost icon" title="Open agent page" onClick={() => navigate(`/agents/${agent.id}?tab=computer`)}>
          <ExternalLink size={15} />
        </button>
        <button className="btn ghost icon" title="Close" onClick={() => openDock(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="dock-body">
        <Screen agent={agent} compact />
        <div className="section" style={{ marginTop: 18 }}>
          <h3 style={{ marginBottom: 6 }}>{run ? 'Current work' : 'No active work'}</h3>
          {run ? <RunTimeline runId={run.id} /> : <div className="small muted">When {agent.name} picks up work, each step shows up here live.</div>}
        </div>
      </div>
    </aside>
  );
}
