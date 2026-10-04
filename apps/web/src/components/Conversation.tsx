// A conversation: messages as chat bubbles, a note on what an agent did above each reply, what agents are doing
// right now, the approvals waiting for you here, and the composer.
import { ChevronDown, Copy, MessageSquareReply } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { Agent, Channel, Human, Message, RunSummary } from '@teambot/shared';
import { api } from '../api';
import { plainLine } from '../lib/conversations';
import { ago, dayLabel, timeShort } from '../lib/format';
import { useMember, useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { Attachments } from './Attachments';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { WidgetCard } from './WidgetFrame';
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
        <div className={`bubble ${m.widget ? 'has-widget' : ''}`}>
          {m.text && <Markdown text={m.text} />}
          {m.widget && <WidgetCard widget={m.widget} draftKey={m.threadId ?? m.channelId} />}
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

/**
 * For the first message here of each run that worked in another conversation (a group chat, or a teammate's request
 * in a DM between agents): that conversation, for the line above it.
 */
function useOrigins(messages: Message[]): Map<string, Channel> {
  const summaries = useStore((s) => s.runSummaries);
  const active = useStore((s) => s.runs);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  return useMemo(() => {
    const isAgent = new Set(agents.map((a) => a.id));
    const seen = new Set<string>();
    const origins = new Map<string, Channel>();
    for (const m of messages) {
      if (!m.runId || seen.has(m.runId)) continue;
      seen.add(m.runId);
      const from = (active[m.runId] ?? summaries[m.runId])?.channelId;
      const channel = from && from !== m.channelId ? channels.find((c) => c.id === from) : undefined;
      if (channel && (channel.kind === 'channel' || channel.memberIds.every((id) => isAgent.has(id)))) origins.set(m.id, channel);
    }
    return origins;
  }, [messages, summaries, active, channels, agents]);
}

/** "Asked by Writer" or "From #launch": where the work behind the message below was done. Opens that conversation. */
function FromNote({ m, channel }: { m: Message; channel: Channel }) {
  const by = useMember(channel.kind === 'dm' ? channel.memberIds.find((id) => id !== m.authorId) : undefined);
  if (channel.kind === 'dm' && !by) return null;
  return (
    <Link href={`/c/${channel.id}`} className="sent-note">
      {channel.kind === 'channel' ? (
        <>
          <span>From</span>
          <strong>#{channel.name}</strong>
        </>
      ) : (
        <>
          <span>Asked by</span>
          <Avatar member={by} size={16} />
          <strong>{by!.name}</strong>
        </>
      )}
    </Link>
  );
}

/**
 * "Messaged Job Scout": an agent at work here posted in another conversation. "Message from Job Scout": a teammate
 * answered the agent you're chatting with. Opens that conversation. `sub`: one line of an opened SentGroup.
 */
function SentNote({ m, partnerId, sub }: { m: Message; partnerId?: string; sub?: boolean }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === m.channelId));
  const me = useStore((s) => s.me);
  const author = useMember(m.authorId);
  const to = useMember(channel?.kind === 'dm' ? channel.memberIds.find((id) => id !== m.authorId) : undefined);
  if (!channel || (channel.kind === 'dm' && !to)) return null;
  const className = `sent-note${sub ? ' sub' : ''}`;
  if (partnerId && to?.id === partnerId && author) {
    return (
      <Link href={`/c/${channel.id}`} className={className} title={plainLine(m.text)}>
        <span>Message from</span>
        <Avatar member={author} size={16} />
        <strong>{author.name}</strong>
      </Link>
    );
  }
  // In a chat with one agent it's that agent who did it; anywhere else, say who.
  const who = m.authorId === partnerId ? null : author;
  const verb = channel.kind === 'dm' ? 'messaged' : 'posted in';
  return (
    <Link href={`/c/${channel.id}`} className={className} title={plainLine(m.text)}>
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

/**
 * One agent messaging several teammates between two messages: one line, "Messaged [blobs] 3 agents", that opens to a
 * line for each. `notes`: one message per conversation.
 */
function SentGroup({ notes, partnerId }: { notes: Message[]; partnerId?: string }) {
  const [open, setOpen] = useState(false);
  const channels = useStore((s) => s.channels);
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const members = notes
    .map((m) => channels.find((c) => c.id === m.channelId)?.memberIds.find((id) => id !== m.authorId))
    .map((id) => agents.find((a) => a.id === id) ?? humans.find((h) => h.id === id))
    .filter((x): x is Agent | Human => !!x);
  // In a chat with one agent it's that agent who did it; anywhere else, say who.
  const who = notes[0].authorId === partnerId ? undefined : agents.find((a) => a.id === notes[0].authorId);
  return (
    <>
      <button type="button" className="sent-note" aria-expanded={open} onClick={() => setOpen(!open)} title={members.map((x) => x.name).join(', ')}>
        {who && (
          <>
            <Avatar member={who} size={16} />
            <strong>{who.name}</strong>
          </>
        )}
        <span>{who ? 'messaged' : 'Messaged'}</span>
        <span className="avatar-stack">
          {members.slice(0, 3).map((x) => (
            <Avatar key={x.id} member={x} size={16} />
          ))}
        </span>
        <strong>
          {members.length} {members.every((x) => x.kind === 'agent') ? 'agents' : 'teammates'}
        </strong>
        <ChevronDown size={14} className={open ? 'flip' : undefined} aria-hidden />
      </button>
      {open && notes.map((m) => <SentNote key={m.id} m={m} partnerId={partnerId} sub />)}
    </>
  );
}

type SentEntry = { kind: 'sent'; m: Message; group: string | null; notes: Message[] };
type Entry = { kind: 'message'; m: Message } | SentEntry;

/**
 * Which notes between two messages share one line: messages one author sent to several DMs (its author). Answers to the
 * agent you're chatting with come back one at a time, so each keeps its own "Message from" line, and posts in group
 * chats only share a line with more posts to the same place (null).
 */
function groupOf(m: Message, channels: Channel[], partnerId?: string): string | null {
  const channel = channels.find((c) => c.id === m.channelId);
  if (channel?.kind !== 'dm' || (partnerId && channel.memberIds.includes(partnerId) && m.authorId !== partnerId)) return null;
  return m.authorId;
}

/**
 * Messages with what was sent elsewhere in between, in time order. Between two messages, notes share a line where they
 * can, even when requests and answers crossed (a quick teammate answering before the last one was asked).
 */
function timeline(messages: Message[], sent: Message[], channels: Channel[], partnerId?: string): Entry[] {
  // Older notes would pile up above the first loaded message.
  const since = messages[0]?.createdAt ?? '';
  const notes = sent.filter((m) => m.createdAt >= since && !isSystem(m.text));
  const out: Entry[] = [];
  let between = 0; // where the notes since the last message start
  const add = (m: Message) => {
    const group = groupOf(m, channels, partnerId);
    const line = out
      .slice(between)
      .find((e): e is SentEntry => e.kind === 'sent' && (group ? e.group === group : !e.group && e.m.channelId === m.channelId && e.m.authorId === m.authorId));
    if (!line) out.push({ kind: 'sent', m, group, notes: [m] });
    // One line per conversation: several posts to the same place count once.
    else if (!line.notes.some((n) => n.channelId === m.channelId)) line.notes.push(m);
  };
  let j = 0;
  for (const m of messages) {
    while (j < notes.length && notes[j].createdAt < m.createdAt) add(notes[j++]);
    out.push({ kind: 'message', m });
    between = out.length;
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
  const channels = useStore((s) => s.channels);
  const notes = useWorkNotes(messages);
  const origins = useOrigins(messages);
  const entries = useMemo(() => timeline(messages, sent, channels, partnerId), [messages, sent, channels, partnerId]);
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
              {entry.notes.length > 1 ? <SentGroup notes={entry.notes} partnerId={partnerId} /> : <SentNote m={m} partnerId={partnerId} />}
            </Fragment>
          );
        }
        const prev = before?.kind === 'message' ? before.m : undefined;
        const origin = origins.get(m.id);
        const close =
          !newDay &&
          !origin &&
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
            {origin && <FromNote m={m} channel={origin} />}
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
  prefix,
  beforeSend,
}: {
  channelId: string;
  placeholder: string;
  empty?: React.ReactNode;
  /** The agent or person this DM is with. */
  partnerId?: string;
  /** Shown instead of the composer in a conversation you only watch. */
  readOnly?: React.ReactNode;
  /** Put before what you send, e.g. a link to the page you are asking about. */
  prefix?: string;
  /** Runs before a message is sent (e.g. saving the page it is about, so the agent reads the latest). */
  beforeSend?: () => Promise<unknown>;
}) {
  const messages = useStore((s) => s.messages[channelId] ?? EMPTY);
  // "Messaged …" notes are for people following their own chats, not for a DM between agents that you only watch.
  const watching = useStore((s) => {
    const channel = s.channels.find((c) => c.id === channelId);
    return channel?.kind === 'dm' && !!s.me && !channel.memberIds.includes(s.me.id);
  });
  const sent = useStore((s) => (watching ? EMPTY : (s.sent[channelId] ?? EMPTY)));
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
      await beforeSend?.();
      await api.post(`/channels/${channelId}/messages`, { text: prefix && text ? `${prefix}\n\n${text}` : text, attachments });
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
      {readOnly ? <div className="composer read-only">{readOnly}</div> : <Composer key={channelId} placeholder={placeholder} onSend={send} draftKey={channelId} />}
    </>
  );
}
