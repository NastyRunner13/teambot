// A conversation: messages as chat bubbles, a note on what an agent did above each reply, what agents are doing
// right now, the approvals waiting for you here, and the composer.
import { Copy, MessageSquareReply } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Message, RunSummary } from '@teambot/shared';
import { api } from '../api';
import { ago, dayLabel, timeShort } from '../lib/format';
import { useMember, useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { Attachments } from './Attachments';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { LiveWork, WorkNote } from './WorkLog';

const EMPTY: Message[] = [];
const isSystem = (text: string) => text.startsWith('📋 ') || text.startsWith('⚠️ ');

export function MessageRow({
  m,
  mine,
  showAuthor,
  close,
  note,
  onReply,
}: {
  m: Message;
  mine: boolean;
  showAuthor: boolean;
  /** Follows a message by the same author: less space above. */
  close: boolean;
  note?: React.ReactNode;
  onReply?: () => void;
}) {
  const author = useMember(m.authorId);
  const notify = useStore((s) => s.notify);
  const replies = m.replyCount ?? 0;

  if (isSystem(m.text)) {
    return (
      <div className="msg system">
        <Markdown text={m.text} />
      </div>
    );
  }

  function copy() {
    navigator.clipboard.writeText(m.text).then(
      () => notify('Copied'),
      () => notify('Could not copy; select the text instead', 'error'),
    );
  }

  return (
    <div className={`msg ${mine ? 'mine' : 'theirs'} ${close ? 'close' : ''}`}>
      {showAuthor && (
        <div className="msg-author">
          <Avatar member={author} size={22} />
          <span>{author?.name ?? 'Unknown'}</span>
        </div>
      )}
      {note}
      <div className="msg-line">
        <div className="bubble">
          {m.text && <Markdown text={m.text} />}
          <Attachments items={m.attachments} />
        </div>
        <div className="msg-actions">
          <span className="msg-time" title={new Date(m.createdAt).toLocaleString()}>
            {timeShort(m.createdAt)}
          </span>
          {onReply && (
            <button className="icon-btn sm" onClick={onReply} title="Reply in thread" aria-label="Reply in thread">
              <MessageSquareReply size={15} />
            </button>
          )}
          {m.text && (
            <button className="icon-btn sm" onClick={copy} title="Copy text" aria-label="Copy text">
              <Copy size={14} />
            </button>
          )}
        </div>
      </div>
      {onReply && replies > 0 && (
        <button className="thread-summary" onClick={onReply}>
          <MessageSquareReply size={13} />
          <strong>
            {replies} {replies === 1 ? 'reply' : 'replies'}
          </strong>
          <span className="faint">· {ago(m.lastReplyAt)}</span>
        </button>
      )}
    </div>
  );
}

/** For the first message of each finished run that took actions: that run, for its work note. */
function useWorkNotes(messages: Message[]): Map<string, RunSummary> {
  const summaries = useStore((s) => s.runSummaries);
  const active = useStore((s) => s.runs);
  const loadRunSummaries = useStore((s) => s.loadRunSummaries);
  const runIds = useMemo(() => [...new Set(messages.map((m) => m.runId).filter((id): id is string => !!id))], [messages]);
  useEffect(() => loadRunSummaries(runIds), [runIds, loadRunSummaries]);
  return useMemo(() => {
    const seen = new Set<string>();
    const notes = new Map<string, RunSummary>();
    for (const m of messages) {
      if (!m.runId || seen.has(m.runId)) continue;
      seen.add(m.runId);
      const run = summaries[m.runId];
      if (run && !active[run.id] && run.toolCalls > 0) notes.set(m.id, run);
    }
    return notes;
  }, [messages, summaries, active]);
}

/** Messages with day dividers. `partnerId`: the other member of a DM, whose name needn't be repeated. */
export function MessageList({ messages, partnerId, onReply }: { messages: Message[]; partnerId?: string; onReply?: (m: Message) => void }) {
  const me = useStore((s) => s.me);
  const notes = useWorkNotes(messages);
  return (
    <>
      {messages.map((m, i) => {
        const prev = messages[i - 1];
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        const close =
          !newDay &&
          !!prev &&
          prev.authorId === m.authorId &&
          !prev.replyCount &&
          !isSystem(prev.text) &&
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
        const mine = m.authorId === me?.id;
        const note = notes.get(m.id);
        return (
          <Fragment key={m.id}>
            {newDay && <div className="day-divider">{dayLabel(m.createdAt)}</div>}
            <MessageRow
              m={m}
              mine={mine}
              close={close && !note}
              showAuthor={!mine && m.authorId !== partnerId && !(close && !note)}
              note={note && <WorkNote run={note} />}
              onReply={onReply && (() => onReply(m))}
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** Keeps a scroller pinned to the bottom while the reader is there, also when content grows (live work, images). */
export function useStickToBottom(key: string) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [key]);
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { scroller, content, onScroll, pin: () => (stick.current = true) };
}

export function Conversation({
  channelId,
  placeholder,
  empty,
  partnerId,
}: {
  channelId: string;
  placeholder: string;
  empty?: React.ReactNode;
  /** The agent or person this DM is with. */
  partnerId?: string;
}) {
  const messages = useStore((s) => s.messages[channelId] ?? EMPTY);
  const loaded = useStore((s) => channelId in s.messages);
  const loadMessages = useStore((s) => s.loadMessages);
  const approvals = useStore((s) => s.approvals);
  const runs = useStore((s) => s.runs);
  const openThread = useStore((s) => s.openThread);
  const notify = useStore((s) => s.notify);
  const { scroller, content, onScroll, pin } = useStickToBottom(channelId);

  useEffect(() => {
    void loadMessages(channelId);
  }, [channelId, loadMessages]);

  const here = approvals.filter((a) => a.channelId === channelId || (!!partnerId && !a.channelId && a.agentId === partnerId));
  const live = Object.values(runs).filter((r) => r.channelId === channelId);

  async function send(text: string, attachments: string[]) {
    pin();
    try {
      await api.post(`/channels/${channelId}/messages`, { text, attachments });
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  return (
    <>
      <div className="messages" ref={scroller} onScroll={onScroll}>
        <div className="messages-inner" ref={content}>
          {loaded && messages.length === 0 && !live.length && empty}
          <MessageList messages={messages} partnerId={partnerId} onReply={(m) => openThread(m.id)} />
          {live.map((r) => (
            <LiveWork key={r.id} run={r} showName={!partnerId} onOpenThread={r.threadId ? () => openThread(r.threadId!) : undefined} />
          ))}
          {here.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      </div>
      <Composer key={channelId} placeholder={placeholder} onSend={send} />
    </>
  );
}
