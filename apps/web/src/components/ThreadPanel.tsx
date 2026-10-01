// Side panel: one thread, its replies and a composer. Shares the slot with the computer dock.
import { X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import type { Message } from '@teambot/shared';
import { api } from '../api';
import { channelTitle, useStore } from '../store';
import { Composer } from './Composer';
import { MessageRow } from './Conversation';

const EMPTY: Message[] = [];

export function ThreadPanel({ rootId }: { rootId: string }) {
  const replies = useStore((s) => s.threads[rootId] ?? EMPTY);
  const cached = useStore((s) => Object.values(s.messages).flat().find((m) => m.id === rootId));
  const me = useStore((s) => s.me);
  const loadThread = useStore((s) => s.loadThread);
  const openThread = useStore((s) => s.openThread);
  const notify = useStore((s) => s.notify);
  const [root, setRoot] = useState<Message | null>(cached ?? null);
  const channel = useStore((s) => s.channels.find((c) => c.id === (cached ?? root)?.channelId));
  const agentIds = useStore((s) => s.agents.map((a) => a.id).join(','));
  const [location] = useLocation();
  const scroller = useRef<HTMLDivElement>(null);

  // A thread belongs to its conversation: close it when you go somewhere else.
  useEffect(() => {
    if (!channel) return;
    const dmAgent = channel.kind === 'dm' ? channel.memberIds.find((id) => agentIds.split(',').includes(id)) : undefined;
    const here = location.startsWith(`/c/${channel.id}`) || (!!dmAgent && location.startsWith(`/agents/${dmAgent}`));
    if (!here) openThread(null);
  }, [location, channel, agentIds, openThread]);

  useEffect(() => {
    api
      .get<{ root: Message }>(`/messages/${rootId}/thread`)
      .then((t) => setRoot(t.root))
      .catch((err) => notify((err as Error).message, 'error'));
    void loadThread(rootId);
  }, [rootId, loadThread, notify]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('dialog[open]') && openThread(null);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [openThread]);

  const shown = cached ?? root;

  async function send(text: string, attachments: string[]) {
    if (!shown) return;
    try {
      await api.post(`/channels/${shown.channelId}/messages`, { text, attachments, threadId: rootId });
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  return (
    <aside className="dock thread-panel" aria-label="Thread">
      <div className="dock-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>Thread</strong>
          {channel && <div className="small muted ellipsis">{channelTitle(channel, me?.id)}</div>}
        </div>
        <button className="btn ghost icon" title="Close thread" aria-label="Close thread" onClick={() => openThread(null)}>
          <X size={16} />
        </button>
      </div>
      <div className="thread-messages" ref={scroller}>
        {shown ? <MessageRow m={{ ...shown, replyCount: 0 }} compact={false} /> : <div className="small muted" style={{ padding: 16 }}>Loading…</div>}
        <div className="thread-divider">
          {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
        </div>
        {replies.map((m, i) => {
          const prev = replies[i - 1];
          const compact = !!prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return <MessageRow key={m.id} m={m} compact={compact} />;
        })}
      </div>
      <Composer key={rootId} placeholder="Reply in thread — agents in this thread see it" onSend={send} autoFocus />
    </aside>
  );
}
