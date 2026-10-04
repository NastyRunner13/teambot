// A thread in the right panel: the message it started from, its replies, what agents are doing in it, and a composer.
import { useEffect, useState } from 'react';
import type { Message } from '@teambot/shared';
import { api } from '../../api';
import { useStore } from '../../store';
import { ApprovalCard } from '../ApprovalCard';
import { Composer } from '../Composer';
import { MessageList, useStickToBottom } from '../Conversation';
import { LiveWork } from '../WorkLog';
import { PanelPage } from './PanelPage';

const EMPTY: Message[] = [];

export function ThreadView({ rootId }: { rootId: string }) {
  const replies = useStore((s) => s.threads[rootId] ?? EMPTY);
  const cached = useStore((s) => Object.values(s.messages).flat().find((m) => m.id === rootId));
  const loadThread = useStore((s) => s.loadThread);
  const notify = useStore((s) => s.notify);
  const runs = useStore((s) => s.runs);
  const approvals = useStore((s) => s.approvals);
  const [root, setRoot] = useState<Message | null>(cached ?? null);
  const { scroller, content, onScroll, pin } = useStickToBottom(rootId);

  useEffect(() => {
    api
      .get<{ root: Message }>(`/messages/${rootId}/thread`)
      .then((t) => setRoot(t.root))
      .catch((err) => notify((err as Error).message, 'error'));
    void loadThread(rootId);
  }, [rootId, loadThread, notify]);

  const shown = cached ?? root;
  const live = Object.values(runs).filter((r) => r.threadId === rootId);
  const waiting = approvals.filter((a) => live.some((r) => r.id === a.runId));

  async function send(text: string, attachments: string[]) {
    if (!shown) return;
    pin();
    try {
      await api.post(`/channels/${shown.channelId}/messages`, { text, attachments, threadId: rootId });
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  return (
    <PanelPage title="Thread" flush>
      <div className="thread-scroll" ref={scroller} onScroll={onScroll}>
        <div ref={content}>
          {shown ? <MessageList messages={[{ ...shown, replyCount: 0 }]} /> : <div className="small muted">Loading…</div>}
          <div className="thread-divider">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </div>
          <MessageList messages={replies} />
          {live.map((r) => (
            <LiveWork key={r.id} run={r} showName />
          ))}
          {waiting.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      </div>
      <Composer key={rootId} placeholder="Reply in thread — agents in this thread see it" onSend={send} autoFocus draftKey={rootId} />
    </PanelPage>
  );
}
