import { ArrowUpRight, Bot, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { Agent } from '@teambot/shared';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { Conversation } from '../components/Conversation';
import { Modal } from '../components/Modal';
import { STARTER_TEAM, TEMPLATES } from '../lib/templates';
import { channelTitle, useStore } from '../store';
import { NewAgentDialog } from './AgentForm';

function StarterTeam() {
  const defaultModel = useStore((s) => s.health?.defaultModel ?? 'anthropic/claude-sonnet-5.5');
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);

  async function create() {
    setBusy(true);
    try {
      for (const key of STARTER_TEAM) {
        const t = TEMPLATES.find((x) => x.key === key)!;
        await api.post<Agent>('/agents', { name: t.name, avatar: t.avatar, color: t.color, role: t.role, instructions: t.instructions, model: defaultModel });
      }
      notify('Your starter team is here. Try: @Lead research our top 3 competitors and write a one-page summary');
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="hero">
      <div className="welcome-mark"><Bot size={30} strokeWidth={1.5} /></div>
      <h1>Good work starts with a team.</h1>
      <p>
        Give your agents a role. Bring them a goal.<br />Work together, right here.
      </p>
      <div className="starter-roster">
        {TEMPLATES.filter((t) => STARTER_TEAM.includes(t.key)).map((t) => <div key={t.key} className="starter-member"><span className="starter-avatar">{t.avatar}</span><strong>{t.name}</strong><span>{t.key === 'lead' ? 'Makes the plan' : t.key === 'researcher' ? 'Finds the answers' : 'Finds the words'}</span></div>)}
      </div>
      <div className="row wrap" style={{ justifyContent: 'center' }}>
        <button className="btn primary" disabled={busy} onClick={create}>
          {busy ? 'Creating your team…' : 'Create starter team'} <ArrowUpRight size={15} />
        </button>
        <button className="btn" onClick={() => setCustom(true)}>
          Create your own agent
        </button>
      </div>
      <p className="small faint" style={{ marginTop: 14 }}>
        Your team, your models. Customize each agent anytime.
      </p>
      {custom && <NewAgentDialog onClose={() => setCustom(false)} />}
    </div>
  );
}

function Members({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))!;
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const members = [...humans, ...agents].filter((m) => channel.memberIds.includes(m.id));
  const outside = agents.filter((a) => !channel.memberIds.includes(a.id));

  async function toggle(id: string, add: boolean) {
    try {
      if (add) await api.post(`/channels/${channel.id}/members`, { memberId: id });
      else await api.del(`/channels/${channel.id}/members/${id}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Members">
        <Users size={13} /> {members.length}
      </button>
      {open && (
        <Modal title={`Members of #${channel.name}`} onClose={() => setOpen(false)}>
          {agents.length > 0 && (
            <div className="field">
              <label htmlFor="channel-lead">Lead</label>
              <select
                id="channel-lead"
                className="select"
                value={channel.leadAgentId ?? ''}
                onChange={(e) => api.patch(`/channels/${channel.id}`, { leadAgentId: e.target.value || null }).catch((err) => notify((err as Error).message, 'error'))}
              >
                <option value="">Nobody — agents only answer when mentioned</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.avatar} {a.name} answers messages that mention nobody
                  </option>
                ))}
              </select>
              <span className="hint">The lead picks up questions asked to the whole channel and can hand them to the right teammate.</span>
            </div>
          )}
          <div className="list">
            {members.map((m) => (
              <div key={m.id} className="list-row">
                <Avatar member={m} size={26} status />
                <span className="grow">
                  <strong>{m.name}</strong> <span className="small muted">{m.kind === 'agent' ? m.role : 'human'}</span>
                  {m.id === channel.leadAgentId && <span className="badge" style={{ marginLeft: 6 }}>lead</span>}
                </span>
                {m.kind === 'agent' && (
                  <button className="btn sm" onClick={() => toggle(m.id, false)}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          {outside.length > 0 && (
            <div className="section">
              <h3 style={{ marginBottom: 8 }}>Add agents</h3>
              <div className="list">
                {outside.map((a) => (
                  <div key={a.id} className="list-row">
                    <Avatar member={a} size={26} />
                    <span className="grow">
                      <strong>{a.name}</strong> <span className="small muted">{a.role}</span>
                    </span>
                    <button className="btn sm" onClick={() => toggle(a.id, true)}>
                      <UserPlus size={13} /> Add
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 14 }}>
            Mentioning an agent with @Name in a channel also adds it automatically.
          </p>
        </Modal>
      )}
    </>
  );
}

export function ChannelView({ id }: { id: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === id));
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const openDock = useStore((s) => s.openDock);
  const [, navigate] = useLocation();
  const channelAgents = channel ? agents.filter((a) => channel.memberIds.includes(a.id)) : [];
  // A DM with an agent lives on the agent's page.
  const dmAgentId = channel?.kind === 'dm' ? channelAgents[0]?.id : undefined;
  useEffect(() => {
    if (dmAgentId) navigate(`/agents/${dmAgentId}`, { replace: true });
  }, [dmAgentId, navigate]);

  if (!channel) return <div className="center-fill muted">This channel doesn't exist.</div>;
  if (dmAgentId) return null;
  const title = channelTitle(channel, me?.id);

  return (
    <>
      <div className="page-header">
        <div className="grow" style={{ minWidth: 0 }}>
          <h1>{title}</h1>
          {channel.topic && <div className="sub">{channel.topic}</div>}
        </div>
        <div className="row">
          {channelAgents.slice(0, 8).map((a) => (
            <button className="avatar-button" key={a.id} onClick={() => openDock(a.id)} title={`${a.name}: watch live`} aria-label={`Watch ${a.name}'s computer`}>
              <Avatar member={a} size={26} status />
            </button>
          ))}
        </div>
        {channel.kind === 'channel' && <Members channelId={channel.id} />}
      </div>
      <Conversation
        channelId={channel.id}
        placeholder={`Message ${title} — @mention an agent to put it to work`}
        empty={
          agents.length === 0 ? (
            <StarterTeam />
          ) : (
            <div className="hero">
              <div className="welcome-mark"><Users size={28} strokeWidth={1.5} /></div>
              <h1>What are we working on?</h1>
              <p>This is {title}, your team's shared conversation.<br />Mention <strong>@{agents[0].name}</strong> to get things moving.</p>
              <div className="team-shortcuts">{agents.slice(0, 6).map((a) => <Link key={a.id} href={`/agents/${a.id}`}><Avatar member={a} size={36} status /><span><strong>{a.name}</strong><span>{a.role.split(':')[0] || 'Your teammate'}</span></span><ArrowUpRight size={15} /></Link>)}</div>
            </div>
          )
        }
      />
    </>
  );
}
