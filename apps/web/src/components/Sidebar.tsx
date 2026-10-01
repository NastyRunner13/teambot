import { Activity, BookOpen, Bot, FolderOpen, Hash, KanbanSquare, Monitor, Moon, Pause, Play, Plus, Search, Settings, ShieldAlert, Sun } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { api } from '../api';
import { useStore } from '../store';
import { NewAgentDialog } from '../views/AgentForm';
import { Avatar } from './Avatar';
import { Modal } from './Modal';

function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    try {
      const ch = await api.post<{ id: string }>('/channels', { name, topic, memberIds: members });
      onClose();
      navigate(`/c/${ch.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title="New channel" aria-label="New channel"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name} onClick={create}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" data-autofocus placeholder="launch" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} />
      </div>
      <div className="field">
        <label>Topic</label>
        <input className="input" placeholder="What this channel is for" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </div>
      {agents.length > 0 && (
        <div className="field">
          <label>Agents</label>
          <div className="row wrap">
            {agents.map((a) => (
              <label key={a.id} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={members.includes(a.id)} onChange={(e) => setMembers(e.target.checked ? [...members, a.id] : members.filter((m) => m !== a.id))} />
                {a.avatar} {a.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Sidebar() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('teambot-theme', theme); } catch { /* Theme still works when storage is disabled. */ }
  }, [theme]);
  const [location] = useLocation();
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const approvals = useStore((s) => s.approvals.length);
  const openTasks = useStore((s) => s.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress' || t.status === 'blocked').length);
  const pausedAll = useStore((s) => s.pausedAll);
  const connected = useStore((s) => s.connected);
  const notify = useStore((s) => s.notify);
  const teamMode = useStore((s) => s.teamMode);
  const [newAgent, setNewAgent] = useState(false);
  const [newChannel, setNewChannel] = useState(false);

  const is = (path: string) => location === path || location.startsWith(`${path}/`) || location.startsWith(`${path}?`);

  async function togglePauseAll() {
    try {
      await api.post(pausedAll ? '/system/resume' : '/system/pause');
      notify(pausedAll ? 'All agents resumed' : 'All agents paused');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <nav className="sidebar" id="workspace-navigation" aria-label="Workspace">
      <div className="brand">
        <div className="logo"><Bot size={21} strokeWidth={1.7} /></div>
        <div>TeamBot<div className="brand-caption">{teamMode ? 'Team workspace' : 'Personal workspace'}</div></div>
        <span className={`conn ${connected ? '' : 'off'}`} title={connected ? 'Live' : 'Reconnecting…'} />
      </div>
      <div className="sidebar-scroll">
        <button className="btn primary new-agent" onClick={() => setNewAgent(true)}><Plus size={16} /> New agent</button>
        <div className="side-group">
          <div className="side-label">
            Your agents <span className="roster-count">{agents.filter((a) => !a.parentId).length}</span>
            <button onClick={() => setNewAgent(true)} title="Add an agent" aria-label="Add an agent">
              <Plus size={14} />
            </button>
          </div>
          {agents
            .filter((a) => !a.parentId)
            .map((a) => (
              <Fragment key={a.id}>
                <Link href={`/agents/${a.id}`} className={`side-item ${is(`/agents/${a.id}`) ? 'active' : ''}`}>
                  <Avatar member={a} size={34} status /> <span className="agent-nav-copy"><strong className="ellipsis">{a.name}</strong><span className="ellipsis">{a.role.split(':')[0] || 'Custom agent'}</span></span>
                  {a.status === 'waiting' && <span className="count warn">!</span>}
                </Link>
                {agents
                  .filter((h) => h.parentId === a.id)
                  .map((h) => (
                    <Link key={h.id} href={`/agents/${h.id}`} className={`side-item helper-item ${is(`/agents/${h.id}`) ? 'active' : ''}`} title={`${h.name}: a short-lived helper of ${a.name}`}>
                      <Avatar member={h} size={22} status />
                      <span className="ellipsis">{h.name}</span>
                      <span className="sub">helper</span>
                    </Link>
                  ))}
              </Fragment>
            ))}
          {agents.length === 0 && (
            <button className="side-item" style={{ background: 'none', border: 0, width: '100%' }} onClick={() => setNewAgent(true)}>
              <Plus size={15} /> Add your first agent
            </button>
          )}
        </div>
        <div className="side-group">
          <div className="side-label">
            Channels
            <button onClick={() => setNewChannel(true)} title="New channel">
              <Plus size={14} />
            </button>
          </div>
          {channels
            .filter((c) => c.kind === 'channel')
            .map((c) => (
              <Link key={c.id} href={`/c/${c.id}`} className={`side-item ${is(`/c/${c.id}`) ? 'active' : ''}`}>
                <Hash size={15} className="hash" /> {c.name}
              </Link>
            ))}
        </div>

        <div className="side-group">
          <div className="side-label">Workspace</div>
          <Link href="/search" className={`side-item ${is('/search') ? 'active' : ''}`}>
            <Search size={16} /> Search
          </Link>
          <Link href="/approvals" className={`side-item ${is('/approvals') ? 'active' : ''}`}>
            <ShieldAlert size={16} /> Approvals {approvals > 0 && <span className="count warn">{approvals}</span>}
          </Link>
          <Link href="/tasks" className={`side-item ${is('/tasks') ? 'active' : ''}`}>
            <KanbanSquare size={16} /> Tasks {openTasks > 0 && <span className="sub">{openTasks} open</span>}
          </Link>
          <Link href="/files" className={`side-item ${is('/files') ? 'active' : ''}`}>
            <FolderOpen size={16} /> Shared files
          </Link>
          <Link href="/skills" className={`side-item ${is('/skills') ? 'active' : ''}`}>
            <BookOpen size={16} /> Skills
          </Link>
          <Link href="/activity" className={`side-item ${is('/activity') ? 'active' : ''}`}>
            <Activity size={16} /> Activity
          </Link>
        </div>
      </div>
      <div className="side-footer">
        <div className="theme-switch" role="group" aria-label="Appearance">
          {([['light', 'Light', Sun], ['dark', 'Dark', Moon], ['system', 'System', Monitor]] as const).map(([value, label, Icon]) => (
            <button key={value} title={`${label} theme`} aria-label={`${label} theme`} aria-pressed={theme === value} onClick={() => setTheme(value)}><Icon size={14} /><span>{label}</span></button>
          ))}
        </div>
        <Link href="/settings" className={`side-item ${is('/settings') ? 'active' : ''}`} style={{ marginBottom: 8 }}>
          <Settings size={16} /> Settings
        </Link>
        <button className={`pause-all ${pausedAll ? 'on' : ''}`} onClick={togglePauseAll}>
          {pausedAll ? <Play size={14} /> : <Pause size={14} />}
          {pausedAll ? 'Resume all agents' : 'Pause all agents'}
        </button>
      </div>
      {newAgent && <NewAgentDialog onClose={() => setNewAgent(false)} />}
      {newChannel && <NewChannelDialog onClose={() => setNewChannel(false)} />}
    </nav>
  );
}
