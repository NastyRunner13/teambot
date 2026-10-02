// A chat: with one agent (/agents/:id) or a group (/c/:id), with the details panel beside it.
import { ArrowLeftRight, ArrowUpRight, PanelRight } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { Link, Redirect, useLocation, useSearch } from 'wouter';
import type { Agent, Channel } from '@teambot/shared';
import { api } from '../api';
import { Avatar, Blob, GroupAvatar, shapeOf } from '../components/Avatar';
import { Conversation } from '../components/Conversation';
import { Panel } from '../components/panel/Panel';
import { STARTER_TEAM, TEMPLATES } from '../lib/templates';
import { channelTitle, dmWith, useStore, type PanelTab } from '../store';
import { NewAgentDialog } from './AgentForm';

/** The floating name pill at the top of a chat, and the panel toggle. */
function ChatTop({ children, label }: { children: React.ReactNode; label: string }) {
  const open = useStore((s) => s.panel.open);
  const togglePanel = useStore((s) => s.togglePanel);
  const showPanel = useStore((s) => s.showPanel);
  return (
    <div className="chat-top">
      <button className="chat-pill" onClick={() => showPanel({ agentId: null, view: null, tab: 'details' })} title={`About ${label}`}>
        {children}
      </button>
      <button className={`icon-btn chat-panel-toggle ${open ? 'active' : ''}`} onClick={togglePanel} aria-pressed={open} aria-label={open ? 'Hide details' : 'Show details'} title={open ? 'Hide details' : 'Show details'}>
        <PanelRight size={18} />
      </button>
    </div>
  );
}

const LEGACY_TABS: Record<string, PanelTab> = { computer: 'computer', work: 'computer', routines: 'details', memory: 'details', settings: 'details' };

export function AgentChat({ id }: { id: string }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  const me = useStore((s) => s.me);
  const dm = useStore((s) => dmWith(s.channels, s.me?.id, id));
  const notify = useStore((s) => s.notify);
  const showPanel = useStore((s) => s.showPanel);
  const search = useSearch();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!dm && me && agent) api.post<Channel>('/dms', { memberId: agent.id }).catch((err) => notify((err as Error).message, 'error'));
  }, [dm, me, agent, notify]);

  // Old links (?tab=computer, ?tab=memory…) open the matching part of the panel.
  useEffect(() => {
    const tab = new URLSearchParams(search).get('tab');
    if (!tab) return;
    navigate(`/agents/${id}`, { replace: true });
    if (tab === 'memory' || tab === 'settings') showPanel({ view: { kind: tab === 'memory' ? 'memory' : 'customize', agentId: id } });
    else if (LEGACY_TABS[tab]) showPanel({ tab: LEGACY_TABS[tab], view: null });
  }, [search, id, navigate, showPanel]);

  if (!agent) return <div className="center-fill muted">This agent doesn't exist.</div>;
  return (
    <div className="chat-layout">
      <section className="chat">
        <ChatTop label={agent.name}>
          <Avatar member={agent} size={22} status />
          <span className="ellipsis">{agent.name}</span>
        </ChatTop>
        {dm ? (
          <Conversation
            channelId={dm.id}
            partnerId={agent.id}
            placeholder={`Message ${agent.name}`}
            empty={
              <div className="hero">
                <Avatar member={agent} size={96} />
                <h1>{agent.name}</h1>
                <p>{agent.role || 'Your AI teammate'}</p>
                <p className="small faint">Share a task, ask a question, or talk through an idea. It starts working right away.</p>
              </div>
            }
          />
        ) : (
          <div className="center-fill muted">Opening the chat…</div>
        )}
      </section>
      <Panel agentId={agent.id} />
    </div>
  );
}

export function ChannelChat({ id }: { id: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === id));
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  if (!channel) return <div className="center-fill muted">This chat doesn't exist.</div>;
  const members = agents.filter((a) => channel.memberIds.includes(a.id));
  const mine = !!me && channel.memberIds.includes(me.id);
  // My chat with an agent lives on the agent's page.
  if (channel.kind === 'dm' && members.length && mine) return <Redirect to={`/agents/${members[0].id}`} replace />;
  // Agents messaging each other: you can follow along, and step in from your own chat with either.
  const between = channel.kind === 'dm' && !mine;
  const title = channelTitle(channel, me?.id);
  const partner = channel.kind === 'dm' && mine ? channel.memberIds.find((m) => m !== me?.id) : undefined;

  return (
    <div className="chat-layout">
      <section className="chat">
        <ChatTop label={title}>
          {between ? (
            members.map((a, i) => (
              <Fragment key={a.id}>
                {i > 0 && <ArrowLeftRight size={14} className="faint" aria-label="and" />}
                <Avatar member={a} size={22} status />
                <span className="ellipsis">{a.name}</span>
              </Fragment>
            ))
          ) : (
            <>
              {channel.kind === 'channel' ? <GroupAvatar agents={members} size={22} /> : null}
              <span className="ellipsis">{title}</span>
            </>
          )}
        </ChatTop>
        <Conversation
          channelId={channel.id}
          partnerId={partner}
          placeholder={channel.kind === 'channel' ? `Message ${title} — @mention an agent to put it to work` : `Message ${title}`}
          readOnly={
            between && members.length ? (
              <>
                {members
                  .filter((a) => a.paused)
                  .map((a) => (
                    <p key={a.id} className="read-only-paused">
                      <strong>{a.name}</strong> is paused: messages to it wait until you resume it.{' '}
                      <button type="button" className="link-btn" onClick={() => api.post(`/agents/${a.id}/resume`).catch((err) => notify((err as Error).message, 'error'))}>
                        Resume {a.name}
                      </button>
                    </p>
                  ))}
                Only {members.map((a) => a.name).join(' and ')} write here. To step in, message{' '}
                {members.map((a, i) => (
                  <Fragment key={a.id}>
                    {i > 0 && ' or '}
                    <Link href={`/agents/${a.id}`}>{a.name}</Link>
                  </Fragment>
                ))}
                .
              </>
            ) : undefined
          }
          empty={
            <div className="hero">
              <GroupAvatar agents={members} size={88} />
              <h1>{title}</h1>
              <p>{channel.topic || (channel.kind === 'channel' ? 'A group chat for your team and its agents.' : between ? 'Nothing sent here yet.' : 'Your direct messages.')}</p>
              {members[0] && !between && (
                <p className="small faint">
                  Mention <strong>@{members[0].name}</strong> to get things moving.
                </p>
              )}
            </div>
          }
        />
      </section>
      <Panel channelId={channel.id} />
    </div>
  );
}

/** A fresh workspace: make a starter team, or one agent of your own. */
export function Welcome() {
  const defaultModel = useStore((s) => s.health?.defaultModel ?? 'anthropic/claude-sonnet-5.5');
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(false);
  const starters = TEMPLATES.filter((t) => STARTER_TEAM.includes(t.key));

  async function create() {
    setBusy(true);
    try {
      let lead: Agent | null = null;
      for (const t of starters) {
        const agent = await api.post<Agent>('/agents', { name: t.name, avatar: t.avatar, color: t.color, role: t.role, instructions: t.instructions, model: defaultModel });
        lead ??= agent;
      }
      notify('Your starter team is here. Try: research our top 3 competitors and write a one-page summary');
      if (lead) navigate(`/agents/${lead.id}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-fill">
      <div className="hero">
        <div className="starter-roster">
          {starters.map((t) => (
            <div key={t.key} className="starter-member">
              <Blob color={t.color} shape={shapeOf(t.avatar)} size={64} />
              <strong>{t.name}</strong>
              <span>{t.key === 'lead' ? 'Makes the plan' : t.key === 'researcher' ? 'Finds the answers' : 'Finds the words'}</span>
            </div>
          ))}
        </div>
        <h1>Good work starts with a team.</h1>
        <p>Each agent has its own computer, a role and a model. Give them a goal and work together, right here.</p>
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          <button className="btn primary pill" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating your team…' : 'Create starter team'} <ArrowUpRight size={15} />
          </button>
          <button className="btn pill" onClick={() => setCustom(true)}>
            Create your own agent
          </button>
        </div>
      </div>
      {custom && <NewAgentDialog onClose={() => setCustom(false)} />}
    </div>
  );
}
