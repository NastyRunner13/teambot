// The right panel beside a conversation: the agent's (or group's) profile with Details, Library and Computer,
// and the pages it opens — a routine, its editor, memory, customize, a thread or a run's full log.
import { Brain, ChevronLeft, ChevronRight, FileImage, FileText, Pause, PanelRightClose, Play, SlidersHorizontal, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useShallow } from 'zustand/react/shallow';
import type { Agent, Channel, LibraryItem, Run } from '@teambot/shared';
import { api } from '../../api';
import { ago } from '../../lib/format';
import { activeRunFor, channelTitle, useStore, type PanelTab, type PanelView } from '../../store';
import { Avatar, GroupAvatar, StatusBadge } from '../Avatar';
import { BlockedSites } from '../BlockedSites';
import { IMAGE } from '../FilePreview';
import { Screen } from '../Screen';
import { SetupStatus } from '../SetupStatus';
import { SnapshotList } from '../SnapshotList';
import { CustomizePage, MemoryPage, RunPage } from './AgentPages';
import { RoutineDetail, RoutineEditor, RoutineList } from './Routines';
import { ThreadView } from './ThreadView';

/** The panel for the conversation on screen: an agent's chat (`agentId`) or a channel (`channelId`). */
export function Panel({ agentId, channelId }: { agentId?: string; channelId?: string }) {
  const panel = useStore((s) => s.panel);
  const [path] = useLocation();
  if (!panel.open) return null;
  const here = panel.at === path;
  const view = here ? panel.view : null;
  const picked = here ? panel.agentId : null;
  return (
    <aside className="panel" aria-label="Details">
      {view ? (
        <PanelPageFor key={JSON.stringify(view)} view={view} />
      ) : picked || agentId ? (
        <AgentProfile key={picked ?? agentId} agentId={(picked ?? agentId)!} backTo={picked && channelId ? channelId : undefined} />
      ) : channelId ? (
        <ChannelProfile key={channelId} channelId={channelId} />
      ) : null}
    </aside>
  );
}

function PanelPageFor({ view }: { view: PanelView }) {
  switch (view.kind) {
    case 'thread':
      return <ThreadView rootId={view.rootId} />;
    case 'run':
      return <RunPage runId={view.runId} />;
    case 'routine':
      return <RoutineDetail id={view.id} />;
    case 'routine-edit':
      return <RoutineEditor agentId={view.agentId} id={view.id} />;
    case 'memory':
      return <MemoryPage agentId={view.agentId} />;
    case 'customize':
      return <CustomizePage agentId={view.agentId} />;
  }
}

/** A line of text you click to change: an agent's role, a channel's topic. */
function InlineEdit({ value, placeholder, onSave, label }: { value: string; placeholder: string; onSave: (v: string) => Promise<unknown>; label: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  async function commit() {
    setEditing(false);
    if (text.trim() === value.trim()) return;
    await onSave(text.trim()).catch(() => setText(value));
  }

  if (!editing) {
    return (
      <button className={`inline-edit ${value ? '' : 'empty'}`} onClick={() => setEditing(true)} title={`Change the ${label}`}>
        {value || placeholder}
      </button>
    );
  }
  return (
    <input
      ref={input}
      className="input inline-edit-input"
      aria-label={label}
      value={text}
      maxLength={300}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') {
          setText(value);
          setEditing(false);
        }
      }}
    />
  );
}

function ProfileTabs({ tabs }: { tabs: [PanelTab, string][] }) {
  const tab = useStore((s) => s.panel.tab);
  const showPanel = useStore((s) => s.showPanel);
  const current = tabs.some(([t]) => t === tab) ? tab : tabs[0][0];
  return (
    <div className="pill-tabs" role="tablist" aria-label="Sections">
      {tabs.map(([t, label]) => (
        <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'active' : ''} onClick={() => showPanel({ tab: t })}>
          {label}
        </button>
      ))}
    </div>
  );
}

function ProfileTop({ back, onBack }: { back?: string; onBack?: () => void }) {
  const togglePanel = useStore((s) => s.togglePanel);
  return (
    <div className="panel-bar plain">
      {back && onBack ? (
        <button className="back-link" onClick={onBack}>
          <ChevronLeft size={16} /> {back}
        </button>
      ) : (
        <span />
      )}
      <button className="icon-btn" onClick={togglePanel} aria-label="Close the panel" title="Close the panel">
        <PanelRightClose size={18} />
      </button>
    </div>
  );
}

function AgentProfile({ agentId, backTo }: { agentId: string; backTo?: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const tab = useStore((s) => s.panel.tab);
  const me = useStore((s) => s.me);
  const backChannel = useStore((s) => s.channels.find((c) => c.id === backTo));
  const showPanel = useStore((s) => s.showPanel);
  const notify = useStore((s) => s.notify);
  if (!agent) return <div className="panel-body muted">This agent is gone.</div>;
  const current = tab === 'library' || tab === 'computer' ? tab : 'details';

  return (
    <div className="panel-page">
      <ProfileTop back={backChannel ? channelTitle(backChannel, me?.id) : undefined} onBack={() => showPanel({ agentId: null })} />
      <div className="panel-body">
        <div className="profile-head">
          <Avatar member={agent} size={84} status />
          <h2>{agent.name}</h2>
          <InlineEdit
            value={agent.role}
            placeholder="Add a label"
            label="role"
            onSave={(role) => api.patch(`/agents/${agent.id}`, { role }).catch((err) => (notify((err as Error).message, 'error'), Promise.reject(err)))}
          />
          <ProfileTabs tabs={[['details', 'Details'], ['library', 'Library'], ['computer', 'Computer']]} />
        </div>
        {current === 'details' && <AgentDetails agent={agent} />}
        {current === 'library' && <Library url={`/agents/${agent.id}/library`} watch={agent.id} empty={`Files ${agent.name} shares in chats show up here.`} />}
        {current === 'computer' && <AgentComputer agent={agent} />}
      </div>
    </div>
  );
}

function AgentDetails({ agent }: { agent: Agent }) {
  const live = useStore((s) => activeRunFor(s.runs, agent.id));
  const showPanel = useStore((s) => s.showPanel);
  const openRun = useStore((s) => s.openRun);
  const notify = useStore((s) => s.notify);

  async function togglePause() {
    try {
      await api.post(`/agents/${agent.id}/${agent.paused ? 'resume' : 'pause'}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <>
      <div className="status-card">
        <StatusBadge agent={agent} />
        {live ? (
          <button className="link-btn grow ellipsis" onClick={() => openRun(live.id)} title="Open its work log">
            {live.title}
          </button>
        ) : (
          <span className="grow small muted">{agent.paused ? 'Paused — work waits until you resume' : 'Ready for work'}</span>
        )}
        <button className="btn sm pill" onClick={() => void togglePause()}>
          {agent.paused ? <Play size={12} /> : <Pause size={12} />} {agent.paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <RoutineList agent={agent} />
      <section className="panel-section">
        <div className="panel-label">Make it yours</div>
        <button className="panel-row" onClick={() => showPanel({ view: { kind: 'customize', agentId: agent.id } })}>
          <SlidersHorizontal size={16} />
          <span className="grow">
            Customize
            <small>Name, look, instructions, model, budget and computer</small>
          </span>
          <ChevronRight size={16} className="faint" />
        </button>
        <button className="panel-row" onClick={() => showPanel({ view: { kind: 'memory', agentId: agent.id } })}>
          <Brain size={16} />
          <span className="grow">
            Memory
            <small>What it remembers about you and the work</small>
          </span>
          <ChevronRight size={16} className="faint" />
        </button>
      </section>
      <div className="panel-meta mono" title="Model">
        {agent.model}
      </div>
    </>
  );
}

function AgentComputer({ agent }: { agent: Agent }) {
  const live = useStore((s) => activeRunFor(s.runs, agent.id));
  const openRun = useStore((s) => s.openRun);
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    api.get<Run[]>(`/agents/${agent.id}/runs?limit=12`).then(setRuns, () => undefined);
  }, [agent.id, live?.id, live?.status]);

  return (
    <>
      <Screen agent={agent} />
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        {agent.name}'s own Linux computer. Take control to sign in to sites for it; logins persist. It sleeps when unused and wakes when there is work.
      </p>
      <section className="panel-section">
        <div className="panel-label">Recent work</div>
        {runs.length === 0 && <div className="small muted">Nothing yet.</div>}
        {runs.map((r) => (
          <button key={r.id} className="panel-row" onClick={() => openRun(r.id)}>
            <span className={`run-dot ${r.status}`} />
            <span className="grow ellipsis">
              {r.title}
              <small>
                {ago(r.createdAt)} · {r.status.replace('_', ' ')}
              </small>
            </span>
            <ChevronRight size={16} className="faint" />
          </button>
        ))}
      </section>
      <BlockedSites agent={agent} />
      <SetupStatus agent={agent} />
      <SnapshotList agent={agent} />
    </>
  );
}

const BUCKETS: [string, number][] = [
  ['Today', 0],
  ['Yesterday', 1],
  ['This week', 7],
  ['This month', 31],
];

function bucketOf(iso: string): string {
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86_400_000);
  return BUCKETS.find(([, max]) => days <= max)?.[0] ?? 'Older';
}

/** Files shared in messages, newest first, grouped by when. `watch`: refresh when this member or channel shares a file. */
function Library({ url, watch, empty }: { url: string; watch: string; empty: string }) {
  const openFile = useStore((s) => s.openFile);
  const version = useStore((s) => s.events.filter((e) => e.type === 'file.deleted' || (e.type === 'message.created' && (e.agentId === watch || e.channelId === watch || e.actorId === watch))).length);
  const [items, setItems] = useState<LibraryItem[] | null>(null);

  useEffect(() => {
    api.get<LibraryItem[]>(url).then(setItems, () => setItems([]));
  }, [url, version]);

  if (!items) return <div className="small muted">Loading…</div>;
  if (!items.length) return <div className="panel-empty static">{empty}</div>;
  const groups = new Map<string, LibraryItem[]>();
  for (const item of items) {
    const key = bucketOf(item.createdAt);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return (
    <>
      {[...groups].map(([label, list]) => (
        <section key={label} className="panel-section">
          <div className="panel-label">{label}</div>
          <div className="library-list">
            {list.map((f) => (
              <button key={f.path} className="library-row" onClick={() => openFile(f.path)} title={f.path}>
                <span className="file-icon">{/\.md$/i.test(f.name) ? <span className="md-mark">M↓</span> : IMAGE.test(f.name) ? <FileImage size={16} /> : <FileText size={16} />}</span>
                <span className="grow ellipsis">{f.name}</span>
                <span className="small faint">{ago(f.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

function ChannelProfile({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId));
  const agents = useStore((s) => s.agents);
  const me = useStore((s) => s.me);
  const tab = useStore((s) => s.panel.tab);
  const notify = useStore((s) => s.notify);
  if (!channel) return null;
  const members = agents.filter((a) => channel.memberIds.includes(a.id));
  const group = channel.kind === 'channel';

  return (
    <div className="panel-page">
      <ProfileTop />
      <div className="panel-body">
        <div className="profile-head">
          <GroupAvatar agents={members} size={84} />
          <h2>{channelTitle(channel, me?.id)}</h2>
          {group && (
            <InlineEdit
              value={channel.topic}
              placeholder="Add a topic"
              label="topic"
              onSave={(topic) => api.patch(`/channels/${channel.id}`, { topic }).catch((err) => (notify((err as Error).message, 'error'), Promise.reject(err)))}
            />
          )}
          <ProfileTabs tabs={[['details', 'Details'], ['library', 'Library']]} />
        </div>
        {tab === 'library' ? <Library url={`/channels/${channel.id}/library`} watch={channel.id} empty="Files shared in this chat show up here." /> : <ChannelDetails channel={channel} />}
      </div>
    </div>
  );
}

function ChannelDetails({ channel }: { channel: Channel }) {
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const routines = useStore((s) => s.schedules);
  const showPanel = useStore((s) => s.showPanel);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const members = [...humans, ...agents].filter((m) => channel.memberIds.includes(m.id));
  const outside = agents.filter((a) => !channel.memberIds.includes(a.id));
  const group = channel.kind === 'channel';

  async function toggle(id: string, add: boolean) {
    try {
      if (add) await api.post(`/channels/${channel.id}/members`, { memberId: id });
      else await api.del(`/channels/${channel.id}/members/${id}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  async function remove() {
    const posting = routines.filter((r) => r.channelId === channel.id).length;
    const moved = posting ? ` ${posting === 1 ? 'A routine that posts' : `${posting} routines that post`} here will post in its agent's chat instead.` : '';
    if (!confirm(`Delete #${channel.name}? Its messages are deleted for everyone and any work under way here stops. Files in /shared stay.${moved}`)) return;
    try {
      await api.del(`/channels/${channel.id}`);
      notify(`#${channel.name} was deleted`);
      navigate('/');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <>
      {group && agents.length > 0 && (
        <section className="panel-section">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="channel-lead" className="panel-label" style={{ padding: 0 }}>
              Lead
            </label>
            <select
              id="channel-lead"
              className="select"
              value={channel.leadAgentId ?? ''}
              onChange={(e) => api.patch(`/channels/${channel.id}`, { leadAgentId: e.target.value || null }).catch((err) => notify((err as Error).message, 'error'))}
            >
              <option value="">Nobody — agents answer only when mentioned</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} answers messages that mention nobody
                </option>
              ))}
            </select>
            <span className="hint">The lead picks up questions asked to the whole chat and can hand them to the right teammate.</span>
          </div>
        </section>
      )}
      <section className="panel-section">
        <div className="panel-label">Members · {members.length}</div>
        {members.map((m) => (
          <div key={m.id} className="panel-row static">
            <Avatar member={m} size={30} status />
            {m.kind === 'agent' ? (
              <button className="member-link grow ellipsis" onClick={() => showPanel({ agentId: m.id, tab: 'details' })}>
                {m.name}
                {m.id === channel.leadAgentId && <span className="badge">lead</span>}
                <small>{m.role}</small>
              </button>
            ) : (
              <span className="grow ellipsis">
                {m.name}
                <small>person</small>
              </span>
            )}
            {group && m.kind === 'agent' && (
              <button className="btn sm ghost" onClick={() => void toggle(m.id, false)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </section>
      {group && outside.length > 0 && (
        <section className="panel-section">
          <div className="panel-label">Add agents</div>
          {outside.map((a) => (
            <div key={a.id} className="panel-row static">
              <Avatar member={a} size={30} />
              <span className="grow ellipsis">
                {a.name}
                <small>{a.role}</small>
              </span>
              <button className="btn sm ghost" onClick={() => void toggle(a.id, true)}>
                <UserPlus size={13} /> Add
              </button>
            </div>
          ))}
          <p className="small muted">Mentioning an agent with @Name here also adds it.</p>
        </section>
      )}
      {group && (
        <section className="panel-section">
          <button className="btn sm ghost danger" onClick={() => void remove()}>
            <Trash2 size={13} /> Delete this chat
          </button>
        </section>
      )}
    </>
  );
}
