// A conversation: messages as chat bubbles, a note on what an agent did above each reply, what agents are doing
// right now, the approvals waiting for you here, and the composer.
import { Copy, MessageSquareReply } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Link } from 'wouter';
import type { Message, RunSummary } from '@teambot/shared';
import { api } from '../api';
import { plainLine } from '../lib/conversations';
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
      // A message an agent sent elsewhere gets no note there: the work belongs to the conversation it was done for.
      if (run && run.channelId === m.channelId && !active[run.id] && (run.toolCalls > 0 || run.progress.length > 0)) notes.set(m.id, run);
    }
    return notes;
  }, [messages, summaries, active]);
}

/** "Messaged Job Scout": an agent at work here posted in another conversation. Opens that conversation. */
function SentNote({ m, partnerId }: { m: Message; partnerId?: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === m.channelId));
  const me = useStore((s) => s.me);
  const author = useMember(m.authorId);
  const to = useMember(channel?.kind === 'dm' ? channel.memberIds.find((id) => id !== m.authorId) : undefined);
  if (!channel || (channel.kind === 'dm' && !to)) return null;
  // In a chat with one agent it's that agent who did it; anywhere else, say who.
  const who = m.authorId === partnerId ? null : author;
  const verb = channel.kind === 'dm' ? 'messaged' : 'posted in';
  return (
    <Link href={`/c/${channel.id}`} className="sent-note" title={plainLine(m.text)}>
      {who && (
        <>
          <Avatar member={who} size={16} />
          <strong>{who.name}</strong>
        </>
      )}
      <span>{who ? verb : verb[0].toUpperCase() + verb.slice(1)}</span>
      {channel.kind === 'channel' ? (
        <strong>#{channel.name}</strong>
      ) : to!.id === me?.id ? (
        <strong>you</strong>
      ) : (
        <>
          <Avatar member={to} size={16} />
          <strong>{to!.name}</strong>
          {to!.kind === 'agent' && to!.paused && <span title="It answers once you resume it">· paused</span>}
        </>
      )}
    </Link>
  );
}

type Entry = { kind: 'message' | 'sent'; m: Message };

/** Messages with what was sent elsewhere in between, in time order: one note for several posts in a row to one place. */
function timeline(messages: Message[], sent: Message[]): Entry[] {
  // Older notes would pile up above the first loaded message.
  const since = messages[0]?.createdAt ?? '';
  const notes = sent.filter((m) => m.createdAt >= since && !isSystem(m.text));
  const out: Entry[] = [];
  const add = (m: Message) => {
    const prev = out.at(-1);
    if (prev?.kind !== 'sent' || prev.m.channelId !== m.channelId || prev.m.authorId !== m.authorId) out.push({ kind: 'sent', m });
  };
  let j = 0;
  for (const m of messages) {
    while (j < notes.length && notes[j].createdAt < m.createdAt) add(notes[j++]);
    out.push({ kind: 'message', m });
  }
  while (j < notes.length) add(notes[j++]);
  return out;
}

/**
 * Messages with day dividers. `partnerId`: the other member of a DM, whose name needn't be repeated. `sent`: what
 * agents at work here posted elsewhere, shown as notes between the messages.
 */
export function MessageList({ messages, sent = EMPTY, partnerId, onReply }: { messages: Message[]; sent?: Message[]; partnerId?: string; onReply?: (m: Message) => void }) {
  const me = useStore((s) => s.me);
  const notes = useWorkNotes(messages);
  const entries = useMemo(() => timeline(messages, sent), [messages, sent]);
  return (
    <>
      {entries.map((entry, i) => {
        const m = entry.m;
        const before = entries[i - 1];
        const newDay = !before || new Date(before.m.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        const divider = newDay && <div className="day-divider">{dayLabel(m.createdAt)}</div>;
        if (entry.kind === 'sent') {
          return (
            <Fragment key={`sent-${m.id}`}>
              {divider}
              <SentNote m={m} partnerId={partnerId} />
            </Fragment>
          );
        }
        const prev = before?.kind === 'message' ? before.m : undefined;
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
            {divider}
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
  readOnly,
}: {
  channelId: string;
  placeholder: string;
  empty?: React.ReactNode;
  /** The agent or person this DM is with. */
  partnerId?: string;
  /** Shown instead of the composer in a conversation you only watch. */
  readOnly?: React.ReactNode;
}) {
  const messages = useStore((s) => s.messages[channelId] ?? EMPTY);
  const sent = useStore((s) => s.sent[channelId] ?? EMPTY);
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
          <MessageList messages={messages} sent={sent} partnerId={partnerId} onReply={(m) => openThread(m.id)} />
          {live.map((r) => (
            <LiveWork key={r.id} run={r} showName={r.agentId !== partnerId} onOpenThread={r.threadId ? () => openThread(r.threadId!) : undefined} />
          ))}
          {here.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      </div>
      {readOnly ? <div className="composer read-only">{readOnly}</div> : <Composer key={channelId} placeholder={placeholder} onSend={send} />}
    </>
  );
}
