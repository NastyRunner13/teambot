// An agent's page: chat with it, watch its computer, review its work, routines and settings.
import { Brain, CalendarClock, MessageSquare, Monitor, Pause, Play, Settings, Square, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import type { Agent, Channel, Run } from '@teambot/shared';
import { api } from '../api';
import { Avatar, StatusBadge } from '../components/Avatar';
import { BudgetFields } from '../components/BudgetFields';
import { ComputerFields } from '../components/ComputerFields';
import { BlockedSites } from '../components/BlockedSites';
import { SetupStatus } from '../components/SetupStatus';
import { SnapshotList } from '../components/SnapshotList';
import { MemoryEditor } from '../components/MemoryEditor';
import { Conversation } from '../components/Conversation';
import { RunTimeline } from '../components/RunTimeline';
import { Screen } from '../components/Screen';
import { ago, money, tokens } from '../lib/format';
import { activeRunFor, memberName, useStore } from '../store';
import { AgentFields, draftFrom } from './AgentForm';
import { RoutinesTab } from './RoutinesTab';

type Tab = 'chat' | 'computer' | 'work' | 'routines' | 'memory' | 'settings';

function MemoryTab({ agent }: { agent: Agent }) {
  return (
    <div className="page page-narrow">
      <MemoryEditor
        url={`/agents/${agent.id}/memory`}
        scope="agent"
        agentId={agent.id}
        title={`${agent.name}'s memory`}
        hint={
          <>
            Lasting notes {agent.name} keeps for itself and reads before every step. It adds to it with <span className="mono">remember</span>; you can change anything here. Stored
            as a plain file: <span className="mono">data/memory/agents/{agent.name}.md</span>
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
    </div>
  );
}

function ChatTab({ agent }: { agent: Agent }) {
  const me = useStore((s) => s.me);
  const dm = useStore((s) => s.channels.find((c) => c.kind === 'dm' && c.memberIds.length === 2 && c.memberIds.includes(agent.id) && c.memberIds.includes(me?.id ?? '')));
  const notify = useStore((s) => s.notify);

  useEffect(() => {
    if (!dm && me) api.post<Channel>('/dms', { memberId: agent.id }).catch((err) => notify((err as Error).message, 'error'));
  }, [dm, me, agent.id, notify]);

  if (!dm) return <div className="center-fill muted">Opening the conversation…</div>;
  return (
    <Conversation
      channelId={dm.id}
      placeholder={`Message ${agent.name} — it will start working right away`}
      empty={
        <div className="hero">
          <div className="agent-welcome-avatar"><Avatar member={agent} size={76} /></div>
          <h1>Meet {agent.name}.</h1>
          <p>{agent.role}</p><p className="small">Share a task, ask a question, or talk through an idea.</p>
        </div>
      }
    />
  );
}

function WorkTab({ agent }: { agent: Agent }) {
  const live = useStore((s) => activeRunFor(s.runs, agent.id));
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.get<Run[]>(`/agents/${agent.id}/runs?limit=40`).then(setRuns);
  }, [agent.id, live?.id, live?.status]);

  const runId = selected ?? live?.id ?? runs[0]?.id ?? null;
  const run = runs.find((r) => r.id === runId) ?? (live?.id === runId ? live : undefined);

  async function cancel(id: string) {
    await api.post(`/runs/${id}/cancel`);
  }

  return (
    <div className="split-view">
      <div className="split-list">
        {runs.length === 0 && <div className="empty" style={{ margin: 16 }}>No work yet.</div>}
        {runs.map((r) => (
          <div key={r.id} className="list-row clickable" style={{ background: r.id === runId ? 'var(--accent-weak)' : undefined }} onClick={() => setSelected(r.id)}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                {r.title}
              </div>
              <div className="small muted">
                {ago(r.createdAt)} · {r.steps} steps · {money(r.costUsd)}
              </div>
            </div>
            <span className={`badge ${r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'danger' : r.status.startsWith('waiting') ? 'warn' : 'accent'}`}>{r.status.replace('_', ' ')}</span>
          </div>
        ))}
      </div>
      <div className="grow" style={{ overflowY: 'auto', padding: '16px 20px' }}>
        {run ? (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 className="grow ellipsis">{run.title}</h2>
              {['queued', 'running', 'waiting_approval', 'waiting_human', 'paused'].includes(run.status) && (
                <button className="btn sm danger" onClick={() => cancel(run.id)}>
                  <Square size={12} /> Stop this run
                </button>
              )}
            </div>
            <div className="small muted" style={{ marginBottom: 14 }}>
              {run.steps} model calls · {tokens(run.tokensIn)} in / {tokens(run.tokensOut)} out · {money(run.costUsd)} · started by a {run.initiator}
              {run.error && <div className="error-text">{run.error}</div>}
            </div>
            <RunTimeline runId={run.id} />
          </>
        ) : (
          <div className="muted">Select a run to see every step.</div>
        )}
      </div>
    </div>
  );
}

function SettingsTab({ agent }: { agent: Agent }) {
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState(() => draftFrom(agent, agent.model));
  const [budget, setBudget] = useState(agent.budget);
  const [computer, setComputer] = useState({ setupScript: agent.setupScript, computerImage: agent.computerImage ?? '', desktop: agent.desktop, network: agent.network });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(draftFrom(agent, agent.model));
    setBudget(agent.budget);
    setComputer({ setupScript: agent.setupScript, computerImage: agent.computerImage ?? '', desktop: agent.desktop, network: agent.network });
  }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setBusy(true);
    try {
      await api.patch(`/agents/${agent.id}`, { ...draft, budget, setupScript: computer.setupScript, computerImage: computer.computerImage || null, desktop: computer.desktop, network: computer.network });
      notify('Saved');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove ${agent.name}? Its computer and files are deleted. Messages and the audit log stay.`)) return;
    await api.del(`/agents/${agent.id}`);
    notify(`${agent.name} was removed`);
    navigate('/');
  }

  return (
    <div className="page page-narrow">
      <AgentFields draft={draft} set={(d) => setDraft((x) => ({ ...x, ...d }))} />
      <BudgetFields agentId={agent.id} budget={budget} set={setBudget} />
      <ComputerFields {...computer} set={(v) => setComputer((c) => ({ ...c, ...v }))} />
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <span className="spacer" />
        <button className="btn danger" onClick={remove}>
          Remove agent
        </button>
      </div>
    </div>
  );
}

export function AgentView({ id }: { id: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  const live = useStore((s) => activeRunFor(s.runs, id));
  const search = useSearch();
  const [, navigate] = useLocation();
  const tab = (new URLSearchParams(search).get('tab') as Tab) || 'chat';
  const notify = useStore((s) => s.notify);

  const tabs = useMemo(
    () =>
      [
        ['chat', 'Chat', MessageSquare],
        ['computer', 'Computer', Monitor],
        ['work', 'Work log', Workflow],
        ['routines', 'Routines', CalendarClock],
        ['memory', 'Memory', Brain],
        ['settings', 'Customize', Settings],
      ] as const,
    [],
  );

  if (!agent) return <div className="center-fill muted">This agent doesn't exist.</div>;

  async function togglePause() {
    try {
      await api.post(`/agents/${agent!.id}/${agent!.paused ? 'resume' : 'pause'}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <>
      <div className="page-header">
        <Avatar member={agent} size={38} status />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row">
            <h1>{agent.name}</h1>
            <StatusBadge agent={agent} />
            {agent.parentId && <span className="badge" title="A short-lived helper; it leaves when its task is done">helper of {memberName(agent.parentId)}</span>}
            <span className="badge mono agent-model" title="Model">
              {agent.model}
            </span>
          </div>
          <div className="sub">{live ? `Working on: ${live.title}` : agent.role}</div>
        </div>
        <button className="btn" onClick={togglePause}>
          {agent.paused ? <Play size={14} /> : <Pause size={14} />} {agent.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div className="tabs">
        {tabs.map(([key, label, Icon]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => navigate(`/agents/${agent.id}${key === 'chat' ? '' : `?tab=${key}`}`)}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'chat' && <ChatTab agent={agent} />}
        {tab === 'computer' && (
          <div className="page" style={{ maxWidth: 1200 }}>
            <Screen agent={agent} />
            <p className="small muted" style={{ marginTop: 12 }}>
              {agent.name}'s own Linux computer. Its browser, terminal and files live here; the <span className="mono">/shared</span> folder is shared with the team. Take control
              to sign in to sites for it — logins persist across sessions. When nobody uses it for a while it goes to sleep, and it wakes up on the next task.
            </p>
            <BlockedSites agent={agent} />
            <SetupStatus agent={agent} />
            <SnapshotList agent={agent} />
          </div>
        )}
        {tab === 'work' && <WorkTab agent={agent} />}
        {tab === 'routines' && <RoutinesTab agent={agent} />}
        {tab === 'memory' && <MemoryTab agent={agent} />}
        {tab === 'settings' && <SettingsTab agent={agent} />}
      </div>
    </>
  );
}
