// Comments on a page, in a rail beside it: threads about a passage (or the whole page), replies, resolve and reopen.
// A thread whose passage was edited away says so and keeps the words it quoted. Writing @Name in a comment asks that
// agent: it answers in the thread, and while it works the thread says so (with any approval it is waiting for).
import { Check, LoaderCircle, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { locateAnchor, MAX_COMMENT_QUOTE, type CommentThread, type PageComment } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { useMember, useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { Avatar } from './Avatar';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import { MenuButton, MenuItem } from './Menu';

/** A passage someone selected to comment on: its text and where it starts in the page. */
export interface CommentDraft {
  quote: string;
  offset: number;
}

const EMPTY: CommentThread[] = [];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Open threads in reading order: about the whole page first, then by where their passage is, outdated ones last. */
function readingOrder(threads: CommentThread[], content: string) {
  const placed = threads.map((t) => ({ thread: t, at: t.anchor ? locateAnchor(content, t.anchor) : null }));
  const rank = (p: (typeof placed)[number]) => (!p.thread.anchor ? -1 : p.at === null ? Number.MAX_SAFE_INTEGER : p.at);
  return placed.sort((a, b) => rank(a) - rank(b));
}

export function PageComments({
  pageId,
  content,
  draft,
  activeId,
  beforeComment,
  onClearDraft,
  onShow,
  onClose,
}: {
  pageId: string;
  /** The page's text as it is in the editor now, to find each passage. */
  content: string;
  draft: CommentDraft | null;
  activeId: string | null;
  /** Save the page first, so the passage is in the saved text the comment is checked against. */
  beforeComment: () => Promise<unknown>;
  onClearDraft: () => void;
  onShow: (thread: CommentThread, at: number | null) => void;
  onClose: () => void;
}) {
  const threads = useStore((s) => s.comments[pageId] ?? EMPTY);
  const loaded = useStore((s) => pageId in s.comments);
  const addComment = useStore((s) => s.addComment);
  const notify = useStore((s) => s.notify);
  const [tab, setTab] = useState<'open' | 'resolved'>('open');

  const open = useMemo(() => readingOrder(threads.filter((t) => !t.resolved), content), [threads, content]);
  const resolved = useMemo(
    () =>
      threads
        .filter((t) => t.resolved)
        .sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''))
        .map((thread) => ({ thread, at: thread.anchor ? locateAnchor(content, thread.anchor) : null })),
    [threads, content],
  );
  const shown = tab === 'open' ? open : resolved;

  async function comment(text: string) {
    try {
      await beforeComment();
      const saved = await api.post<PageComment>(`/pages/${pageId}/comments`, { body: text, anchor: draft ?? undefined });
      addComment(saved);
      onClearDraft();
      setTab('open');
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  return (
    <aside className="panel doc-comments" aria-label="Comments on this page">
      <div className="panel-bar">
        <div className="segmented" role="group" aria-label="Which comments">
          <button aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
            Open{open.length ? ` · ${open.length}` : ''}
          </button>
          <button aria-pressed={tab === 'resolved'} onClick={() => setTab('resolved')}>
            Resolved{resolved.length ? ` · ${resolved.length}` : ''}
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close comments" title="Close">
          <X size={18} />
        </button>
      </div>
      <div className="panel-body comment-list">
        {!loaded ? (
          <p className="muted small">Loading comments…</p>
        ) : shown.length === 0 ? (
          <p className="comment-empty muted small">
            {tab === 'open'
              ? 'No open comments. Select text in the page and choose Comment, or comment on the whole page below. Write @Name in a comment to ask an agent: it answers in the thread.'
              : 'Resolved threads show up here.'}
          </p>
        ) : (
          shown.map(({ thread, at }) => <Thread key={thread.id} thread={thread} at={at} active={thread.id === activeId} onShow={() => onShow(thread, at)} />)
        )}
      </div>
      {tab === 'open' && (
        <div className="comment-new">
          {draft && (
            <div className="comment-draft-quote">
              <span className="ellipsis">“{clip(draft.quote, 140)}”</span>
              <button className="icon-btn sm" onClick={onClearDraft} aria-label="Comment on the whole page instead" title="Comment on the whole page instead">
                <X size={14} />
              </button>
            </div>
          )}
          {/* Keyed by the passage, so choosing Comment on a selection puts the cursor here. */}
          <Composer
            key={draft ? `${draft.offset}:${draft.quote.length}` : 'page'}
            attach={false}
            autoFocus={!!draft}
            placeholder={draft ? 'Comment on the selection' : 'Comment on the page'}
            onSend={(text) => comment(text)}
          />
        </div>
      )}
    </aside>
  );
}

function Thread({ thread, at, active, onShow }: { thread: CommentThread; at: number | null; active: boolean; onShow: () => void }) {
  const notify = useStore((s) => s.notify);
  const addComment = useStore((s) => s.addComment);
  const runs = useStore((s) => s.runs);
  const approvals = useStore((s) => s.approvals);
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  // Agents at work on this thread, and anything they are waiting for a person to decide.
  const working = useMemo(() => Object.values(runs).filter((r) => r.commentThreadId === thread.id), [runs, thread.id]);
  const waiting = useMemo(() => approvals.filter((a) => working.some((r) => r.id === a.runId)), [approvals, working]);
  const outdated = !!thread.anchor && at === null;

  async function reply(text: string) {
    try {
      const saved = await api.post<PageComment>(`/pages/${thread.pageId}/comments`, { body: text, threadId: thread.id });
      addComment(saved);
      setReplying(false);
    } catch (err) {
      notify((err as Error).message, 'error');
      throw err;
    }
  }

  async function resolve(resolved: boolean) {
    setBusy(true);
    try {
      await api.patch(`/pages/${thread.pageId}/comments/${thread.id}`, { resolved });
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`comment-thread ${active ? 'active' : ''} ${thread.resolved ? 'resolved' : ''}`} aria-label={thread.anchor ? `Comments on “${clip(thread.anchor.quote, 60)}”` : 'Comments on the page'}>
      {thread.anchor ? (
        <button className="comment-quote" onClick={onShow} title={outdated ? 'This passage was edited away' : 'Show this passage in the page'}>
          <span className="comment-quote-text">{clip(thread.anchor.quote, 280)}</span>
          {outdated && <span className="badge warn">Outdated</span>}
        </button>
      ) : (
        <div className="comment-scope faint small">On the whole page</div>
      )}
      {[thread, ...thread.replies].map((c) => (
        <Comment key={c.id} comment={c} root={c.id === thread.id} />
      ))}
      {working.map((r) => (
        <Working key={r.id} agentId={r.agentId} status={r.status} />
      ))}
      {waiting.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      {thread.resolved && (
        <p className="faint small comment-resolved-by">
          <Check size={12} /> Resolved {ago(thread.resolvedAt)}
        </p>
      )}
      {replying ? (
        <Composer attach={false} autoFocus placeholder="Reply" onSend={(text) => reply(text)} />
      ) : (
        <div className="comment-actions">
          <button className="btn sm ghost" onClick={() => setReplying(true)}>
            <MessageSquare size={13} /> Reply
          </button>
          {thread.resolved ? (
            <button className="btn sm ghost" disabled={busy} onClick={() => void resolve(false)}>
              <RotateCcw size={13} /> Reopen
            </button>
          ) : (
            <button className="btn sm ghost" disabled={busy} onClick={() => void resolve(true)}>
              <Check size={13} /> Resolve
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Comment({ comment, root }: { comment: PageComment; root: boolean }) {
  const author = useMember(comment.authorId);
  const me = useStore((s) => s.me);
  const notify = useStore((s) => s.notify);
  // The server decides; this only hides a choice it would refuse.
  const mayDelete = !!me && (me.id === comment.authorId || me.role === 'owner');

  async function remove() {
    if (!confirm(root ? 'Delete this thread and its replies?' : 'Delete this reply?')) return;
    try {
      await api.del(`/pages/${comment.pageId}/comments/${comment.id}`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div className="comment">
      <div className="comment-head">
        <Avatar member={author} size={20} />
        <strong className="ellipsis">{author?.name ?? 'Someone'}</strong>
        <span className="faint small" title={new Date(comment.createdAt).toLocaleString()}>
          {ago(comment.createdAt)}
        </span>
        <span className="spacer" />
        {mayDelete && (
          <MenuButton label="More for this comment">
            <MenuItem danger onSelect={() => void remove()}>
              {root ? 'Delete thread' : 'Delete reply'}
            </MenuItem>
          </MenuButton>
        )}
      </div>
      <div className="comment-body">
        <Markdown text={comment.body} />
      </div>
    </div>
  );
}

function Working({ agentId, status }: { agentId: string; status: string }) {
  const agent = useMember(agentId);
  const waiting = status === 'waiting_approval' || status === 'waiting_human';
  return (
    <div className="comment-working small" role="status">
      <Avatar member={agent} size={20} />
      {waiting ? (
        <span className="muted">{agent?.name ?? 'An agent'} is waiting for you</span>
      ) : (
        <>
          <span className="shimmer">{agent?.name ?? 'An agent'} is working on it…</span>
          <LoaderCircle size={13} className="spin faint" />
        </>
      )}
    </div>
  );
}

/** Whether a selection can be commented on, and why not. */
export function selectionProblem(quote: string): string | null {
  if (!quote.trim()) return 'Select some text in the page to comment on it.';
  if (quote.length > MAX_COMMENT_QUOTE) return `Select at most ${MAX_COMMENT_QUOTE.toLocaleString('en')} characters to comment on.`;
  return null;
}
