// Pages an agent's profile opens in the panel: its memory, everything about it you can change, and a run's full log.
import { Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { Run } from '@teambot/shared';
import { api } from '../../api';
import { money, tokens } from '../../lib/format';
import { useStore } from '../../store';
import { AgentFields, draftFrom } from '../../views/AgentForm';
import { BudgetFields } from '../BudgetFields';
import { ComputerFields } from '../ComputerFields';
import { MemoryEditor } from '../MemoryEditor';
import { RunTimeline } from '../RunTimeline';
import { duration, ProgressList } from '../WorkLog';
import { PanelPage } from './PanelPage';

export function MemoryPage({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  if (!agent) return null;
  return (
    <PanelPage title="Memory">
      <MemoryEditor
        url={`/agents/${agent.id}/memory`}
        scope="agent"
        agentId={agent.id}
        title={`${agent.name}'s memory`}
        hint={
          <>
            Lasting notes {agent.name} keeps for itself and reads before every step. It adds to it with <span className="mono">remember</span>; you can change anything here. Stored
            as <span className="mono">data/memory/agents/{agent.name}.md</span>
          </>
        }
      />
      <MemoryEditor
        url="/memory/team"
        scope="team"
        title="Team memory"
        hint={
          <>
            Shared by every agent: facts and preferences about you, the team and its work. Agents' changes here pass the reviewer first. Stored as{' '}
            <span className="mono">data/memory/team.md</span>
          </>
        }
      />
    </PanelPage>
  );
}

export function CustomizePage({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId))!;
  const notify = useStore((s) => s.notify);
  const closeView = useStore((s) => s.closeView);
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState(() => draftFrom(agent, agent.model));
  const [budget, setBudget] = useState(agent.budget);
  const [computer, setComputer] = useState({ setupScript: agent.setupScript, computerImage: agent.computerImage ?? '', desktop: agent.desktop, network: agent.network });
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/agents/${agent.id}`, { ...draft, budget, setupScript: computer.setupScript, computerImage: computer.computerImage || null, desktop: computer.desktop, network: computer.network });
      notify('Saved');
      closeView();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${agent.name}? Its computer and files are deleted. Messages and the audit log stay.`)) return;
    try {
      await api.del(`/agents/${agent.id}`);
      notify(`${agent.name} was removed`);
      navigate('/');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <PanelPage
      title={`Customize ${agent.name}`}
      footer={
        <>
          <button className="btn pill icon danger" title={`Remove ${agent.name}`} aria-label={`Remove ${agent.name}`} onClick={() => void remove()}>
            <Trash2 size={15} />
          </button>
          <button className="btn pill grow" onClick={closeView}>
            Cancel
          </button>
          <button className="btn pill primary grow" disabled={busy || !draft.name || !draft.model} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <AgentFields draft={draft} set={(d) => setDraft((x) => ({ ...x, ...d }))} />
      <BudgetFields agentId={agent.id} budget={budget} set={setBudget} />
      <ComputerFields {...computer} set={(v) => setComputer((c) => ({ ...c, ...v }))} />
    </PanelPage>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const live = useStore((s) => s.runs[runId]);
  const [loaded, setLoaded] = useState<Run | null>(null);
  const notify = useStore((s) => s.notify);

  useEffect(() => {
    api.get<{ run: Run }>(`/runs/${runId}`).then((r) => setLoaded(r.run), (err) => notify((err as Error).message, 'error'));
  }, [runId, live?.status, notify]);

  const run = live ?? loaded;
  const active = !!live;
  return (
    <PanelPage
      title={run?.title ?? 'Work log'}
      footer={
        active && (
          <button className="btn pill danger grow" onClick={() => api.post(`/runs/${runId}/cancel`).catch((err) => notify((err as Error).message, 'error'))}>
            <Square size={12} /> Stop this run
          </button>
        )
      }
    >
      {run && (
        <div className="small muted" style={{ marginBottom: 14 }}>
          {run.status.replace('_', ' ')} · {duration(new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime())} · {run.steps} model calls · {tokens(run.tokensIn)} in /{' '}
          {tokens(run.tokensOut)} out · {money(run.costUsd)} · started by a {run.initiator}
          {run.error && <div className="error-text">{run.error}</div>}
        </div>
      )}
      {run && run.progress.length > 0 && (
        <div className="work-steps run-progress">
          <ProgressList steps={run.progress} live={active} />
        </div>
      )}
      <RunTimeline runId={runId} />
    </PanelPage>
  );
}
