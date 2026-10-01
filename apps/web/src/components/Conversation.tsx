// A channel or DM: messages, who is working on it right now, pending approvals, and the composer.
import { MessageSquareReply } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation } from 'wouter';
import type { Message } from '@teambot/shared';
import { api } from '../api';
import { ago, dayLabel, timeShort } from '../lib/format';
import { useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { Attachments } from './Attachments';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Markdown } from './Markdown';

const EMPTY: Message[] = [];

export function MessageRow({ m, compact, onReply }: { m: Message; compact: boolean; onReply?: () => void }) {
  const author = useStore((s) => s.agents.find((a) => a.id === m.authorId) ?? s.humans.find((h) => h.id === m.authorId));
  const [, navigate] = useLocation();
  const isAgent = author?.kind === 'agent';
  const system = m.text.startsWith('📋 ') || m.text.startsWith('⚠️ ');
  const replies = m.replyCount ?? 0;
  return (
    <div className={`msg ${compact ? 'compact' : ''}`}>
      <div className="msg-gutter">{!compact && <Avatar member={author} size={36} />}</div>
      <div className="msg-body">
        {!compact && (
          <div className="msg-head">
            <span className="msg-author" onClick={() => isAgent && navigate(`/agents/${author!.id}`)}>
              {author?.name ?? 'Unknown'}
            </span>
            {isAgent && <span className="msg-tag">agent</span>}
            <span className="msg-time">{timeShort(m.createdAt)}</span>
          </div>
        )}
        {m.text && (
          <div className={system ? 'msg-body system' : ''}>
            <Markdown text={m.text} />
          </div>
        )}
        <Attachments items={m.attachments} />
        {onReply && replies > 0 && (
          <button className="thread-summary" onClick={onReply}>
            <MessageSquareReply size={13} />
            <strong>
              {replies} {replies === 1 ? 'reply' : 'replies'}
            </strong>
            <span className="faint">Last reply {ago(m.lastReplyAt)}</span>
          </button>
        )}
      </div>
      {onReply && (
        <div className="msg-actions">
          <button className="btn ghost sm" onClick={onReply} title="Reply in thread" aria-label="Reply in thread">
            <MessageSquareReply size={14} /> Reply
          </button>
        </div>
      )}
    </div>
  );
}

export function Conversation({ channelId, placeholder, empty }: { channelId: string; placeholder: string; empty?: React.ReactNode }) {
  const messages = useStore((s) => s.messages[channelId] ?? EMPTY);
  const loaded = useStore((s) => channelId in s.messages);
  const loadMessages = useStore((s) => s.loadMessages);
  const approvals = useStore((s) => s.approvals);
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);
  const openDock = useStore((s) => s.openDock);
  const openThread = useStore((s) => s.openThread);
  const notify = useStore((s) => s.notify);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
    void loadMessages(channelId);
  }, [channelId, loadMessages]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, approvals.length, channelId]);

  const here = approvals.filter((a) => a.channelId === channelId);
  const working = useMemo(() => {
    const ids = new Set(Object.values(runs).filter((r) => r.channelId === channelId).map((r) => r.agentId));
    return agents.filter((a) => ids.has(a.id));
  }, [runs, agents, channelId]);

  async function send(text: string, attachments: string[]) {
    stick.current = true;
    try {
      await api.post(`/channels/${channelId}/messages`, { text, attachments });
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  return (
    <>
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {loaded && messages.length === 0 && empty}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
          const compact =
            !newDay && !!prev && prev.authorId === m.authorId && !prev.replyCount && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <Fragment key={m.id}>
              {newDay && <div className="day-divider">{dayLabel(m.createdAt)}</div>}
              <MessageRow m={m} compact={compact} onReply={() => openThread(m.id)} />
            </Fragment>
          );
        })}
        {here.length > 0 && (
          <div className="inline-approvals">
            {here.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
          </div>
        )}
      </div>
      <div className="working-bar">
        {working.map((a) => (
          <span key={a.id} className={`chip ${a.status === 'waiting' ? 'waiting' : ''}`} onClick={() => openDock(a.id)} title="Watch live">
            <Avatar member={a} size={20} />
            {a.name}{' '}
            {a.status === 'waiting' ? 'is waiting for you' : a.status === 'paused' ? 'is paused' : <span className="dots">is working</span>}
          </span>
        ))}
      </div>
      <Composer key={channelId} placeholder={placeholder} onSend={send} />
    </>
  );
}
