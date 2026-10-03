// Start a chat: pick an agent, a person or a group chat, or make a new agent or group.
import { Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import type { Channel } from '@teambot/shared';
import { api } from '../api';
import { Avatar, GroupAvatar } from '../components/Avatar';
import { Modal } from '../components/Modal';
import { dmWith, useStore } from '../store';
import { NewAgentDialog } from './AgentForm';

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
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
      title="New group chat"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="group-name">Name</label>
        <input id="group-name" className="input" data-autofocus placeholder="launch" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))} />
      </div>
      <div className="field">
        <label htmlFor="group-topic">Topic</label>
        <input id="group-topic" className="input" placeholder="What this chat is for" value={topic} onChange={(e) => setTopic(e.target.value)} />
      </div>
      {agents.length > 0 && (
        <div className="field">
          <span className="field-label">Agents</span>
          <div className="member-picks">
            {agents.map((a) => (
              <label key={a.id} className={`member-pick ${members.includes(a.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={members.includes(a.id)} onChange={(e) => setMembers(e.target.checked ? [...members, a.id] : members.filter((m) => m !== a.id))} />
                <Avatar member={a} size={24} /> {a.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

interface Option {
  key: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void;
}

export function NewChatView() {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const channels = useStore((s) => s.channels);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dialog, setDialog] = useState<'agent' | 'group' | null>(null);

  const options = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: string) => !q || s.toLowerCase().includes(q);
    const list: Option[] = [
      { key: 'new-agent', label: 'Create new agent', icon: <span className="option-icon"><Plus size={16} /></span>, run: () => setDialog('agent') },
      { key: 'new-group', label: 'Create group chat', icon: <span className="option-icon"><Users size={15} /></span>, run: () => setDialog('group') },
    ].filter((o) => !q || match(o.label));
    for (const a of agents.filter((x) => match(x.name))) {
      list.push({ key: a.id, label: a.name, icon: <Avatar member={a} size={26} />, hint: dmWith(channels, me?.id, a.id) ? 'Open chat' : 'New chat', run: () => navigate(`/agents/${a.id}`) });
    }
    for (const h of humans.filter((x) => x.id !== me?.id && !x.removed && match(x.name))) {
      list.push({
        key: h.id,
        label: h.name,
        icon: <Avatar member={h} size={26} />,
        hint: 'Message',
        run: () =>
          void api
            .post<Channel>('/dms', { memberId: h.id })
            .then((dm) => navigate(`/c/${dm.id}`))
            .catch((err) => notify((err as Error).message, 'error')),
      });
    }
    for (const c of channels.filter((x) => x.kind === 'channel' && match(x.name))) {
      list.push({
        key: c.id,
        label: `#${c.name}`,
        icon: <GroupAvatar agents={agents.filter((a) => c.memberIds.includes(a.id))} size={26} />,
        hint: 'Group chat',
        run: () => navigate(`/c/${c.id}`),
      });
    }
    return list;
  }, [query, agents, humans, channels, me, navigate, notify]);

  const pick = Math.min(active, options.length - 1);

  return (
    <div className="new-chat">
      <div className="to-bar">
        <span className="muted">To:</span>
        <input
          autoFocus
          aria-label="Start a chat with"
          placeholder="Start a chat with…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((pick + 1) % options.length));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((pick - 1 + options.length) % options.length));
            if (e.key === 'Enter' && options[pick]) options[pick].run();
          }}
        />
      </div>
      <div className="picker" role="listbox" aria-label="Chats">
        {options.map((o, i) => (
          <button key={o.key} role="option" aria-selected={i === pick} className={`picker-row ${i === pick ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={o.run}>
            {o.icon}
            <span className="grow ellipsis">{o.label}</span>
            {o.hint && <span className="picker-hint">{o.hint}</span>}
          </button>
        ))}
        {options.length === 0 && <div className="picker-empty muted">Nobody called “{query}”.</div>}
      </div>
      {dialog === 'agent' && <NewAgentDialog onClose={() => setDialog(null)} />}
      {dialog === 'group' && <NewGroupDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
