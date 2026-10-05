// Comments on pages: threads anchored to a passage, where people and agents discuss a page without changing its text.
// A thread's root keeps the passage it is about (the quoted text, where it was and the revision it was made on); when
// the page changes, the passage is found again by its text, and a thread whose passage was edited away is shown as
// outdated with the words it quoted, never lost. @mentioning an agent hands it the thread the way a chat mention
// does: it wakes with the page, the passage and the thread, and its reply lands in the thread. A person replying in a
// thread an agent has written in continues with that agent, as in a chat thread.
import {
  MAX_COMMENT_CHARS,
  MAX_COMMENT_QUOTE,
  locateAnchor,
  type CommentThread,
  type Initiator,
  type InboxItem,
  type Page,
  type PageComment,
} from '@teambot/shared';
import type { App } from './app.js';
import { PageError } from './pages.js';
import { pageLink } from './tools/page-tools.js';
import { parseMentions, truncate, untrusted } from './util.js';
import { humanActor, type Actor } from './workspace.js';

/** Who may delete a comment: the person or agent who wrote it, and the workspace owner. */
export class CommentForbidden extends PageError {
  constructor(message: string) {
    super(message, 403);
  }
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export class PageComments {
  constructor(private app: App) {}

  get(id: string): PageComment {
    const comment = this.app.store.getComment(id);
    if (!comment) throw new PageError('comment not found', 404);
    return comment;
  }

  /** A comment's thread root: itself, or the root of the thread it replies in. */
  root(id: string): PageComment {
    const comment = this.get(id);
    return comment.threadId ? this.get(comment.threadId) : comment;
  }

  /** A page's threads, oldest first, each with its replies. */
  threads(pageId: string): CommentThread[] {
    const all = this.app.store.listComments(pageId);
    const threads = new Map<string, CommentThread>();
    for (const c of all) if (!c.threadId) threads.set(c.id, { ...c, replies: [] });
    for (const c of all) if (c.threadId) threads.get(c.threadId)?.replies.push(c);
    return [...threads.values()];
  }

  /**
   * Comment on a page: a new thread (about a passage, or the whole page) or, with `threadId`, a reply in one (a
   * reply's id stands for its thread). `anchor.offset` says which occurrence of the quote is meant; the nearest one
   * in the page as it is now is used, and a quote that is no longer there is refused.
   */
  post(input: {
    pageId?: string;
    authorId: string;
    body: string;
    threadId?: string | null;
    anchor?: { quote: string; offset?: number } | null;
    actor?: Actor;
    route?: boolean;
  }): PageComment {
    const { store, bus, workspace } = this.app;
    const body = input.body.replaceAll('\u0000', '').trim();
    if (!body) throw new PageError('A comment needs some text');
    if (body.length > MAX_COMMENT_CHARS) throw new PageError(`A comment is at most ${MAX_COMMENT_CHARS.toLocaleString('en')} characters`);

    const root = input.threadId ? this.root(input.threadId) : undefined;
    const pageId = root?.pageId ?? input.pageId;
    if (!pageId) throw new PageError('Say which page the comment is on');
    if (input.pageId && root && root.pageId !== input.pageId) throw new PageError('That thread is on another page');
    const page = this.app.pages.get(pageId);

    let anchor: PageComment['anchor'] = null;
    if (input.anchor && !root) {
      const quote = input.anchor.quote.replaceAll('\u0000', '');
      if (!quote.trim()) throw new PageError('Select the passage the comment is about');
      if (quote.length > MAX_COMMENT_QUOTE) throw new PageError(`Comment on at most ${MAX_COMMENT_QUOTE.toLocaleString('en')} characters of the page at a time`);
      const offset = locateAnchor(page.content, { quote, offset: input.anchor.offset ?? 0 });
      if (offset === null) throw new PageError('That passage is no longer in the page: it changed while you were commenting. Select it again.', 409);
      anchor = { quote, offset, revision: page.revision };
    }

    const fromHuman = workspace.isHuman(input.authorId);
    const actor = input.actor ?? humanActor(input.authorId);
    const mentions = [
      ...new Set(
        parseMentions(body)
          .map((n) => workspace.findMember(n)?.id)
          .filter((id): id is string => !!id),
      ),
    ];
    const comment = store.insertComment({
      pageId,
      threadId: root?.id ?? null,
      authorId: input.authorId,
      body,
      mentions,
      anchor,
      runId: actor.runId ?? null,
      depth: fromHuman ? 0 : actor.depth + 1,
    });
    // Pages belong to the whole workspace, so their comments are announced to everyone, not tied to a run or chat.
    bus.emit('page.comment.created', { actorId: input.authorId }, { comment, openComments: store.openCommentCount(pageId) });
    if (input.route !== false) this.route(comment, page, fromHuman ? 'human' : actor.initiator, !fromHuman && this.fromReadOnlyRun(actor));
    return comment;
  }

  /** Resolve or reopen a thread (a reply's id stands for its thread). Anyone can. */
  resolve(id: string, resolved: boolean, by: string): PageComment {
    const { store, bus } = this.app;
    const root = this.root(id);
    if (root.resolved === resolved) return root;
    store.setCommentResolved(root.id, resolved, by);
    const comment = this.get(root.id);
    bus.emit('page.comment.updated', { actorId: by }, { comment, openComments: store.openCommentCount(root.pageId) });
    return comment;
  }

  /** Delete a comment, and a thread's replies with its root. Only its author or the workspace owner may. */
  remove(id: string, by: string) {
    const { store, bus, workspace } = this.app;
    const comment = this.get(id);
    const owner = store.getHuman(by)?.role === 'owner';
    if (comment.authorId !== by && !owner) throw new CommentForbidden('Only the person who wrote a comment, or the workspace owner, can delete it');
    store.deleteComment(id);
    bus.emit(
      'page.comment.deleted',
      { actorId: by },
      { id, pageId: comment.pageId, threadId: comment.threadId, openComments: store.openCommentCount(comment.pageId), author: workspace.memberName(comment.authorId) },
    );
  }

  /** Work that a read-only run hands on stays read-only, as for messages. */
  private fromReadOnlyRun(actor: Actor): boolean {
    return !!actor.runId && !!this.app.store.getRun(actor.runId)?.readOnly;
  }

  /**
   * Agents @mentioned in a comment get it in their inbox, as do agents already in the thread when a person replies.
   * They answer in the thread: the inbox item and the run it starts carry the thread instead of a channel.
   */
  private route(comment: PageComment, page: Page, initiator: Initiator, readOnly: boolean) {
    const { store, workspace, bus, cfg } = this.app;
    const rootId = comment.threadId ?? comment.id;
    const targets = new Set(comment.mentions.filter((id) => store.getAgent(id)));
    if (comment.threadId && workspace.isHuman(comment.authorId)) {
      for (const c of [this.get(rootId), ...store.listCommentReplies(rootId)]) if (store.getAgent(c.authorId)) targets.add(c.authorId);
    }
    targets.delete(comment.authorId);
    if (!targets.size) return;
    const author = workspace.member(comment.authorId);
    for (const agentId of targets) {
      if (comment.depth > cfg.maxAgentDepth) {
        bus.emit('loop.guard', { agentId }, { commentId: comment.id, pageId: page.id, depth: comment.depth });
        continue;
      }
      store.addInbox({
        agentId,
        kind: 'message',
        text: `A comment on the page ${pageLink(page)}${comment.threadId ? ' (a reply in a thread)' : ''} — ${author?.name ?? 'unknown'} (${author?.kind ?? '?'}) wrote:\n${comment.body}`,
        channelId: null,
        commentThreadId: rootId,
        depth: comment.depth,
        initiator,
        readOnly,
      });
    }
    this.app.runtime.poke();
  }

  /**
   * What an agent woken in a thread is shown before the comments for it (the first time in a run): the page, the
   * passage the thread is about and the thread so far. Page text and other people's comments are outside content.
   */
  context(items: InboxItem[]): string | null {
    const { store, workspace } = this.app;
    const first = items.find((i) => i.commentThreadId);
    const root = first?.commentThreadId ? store.getComment(first.commentThreadId) : undefined;
    const page = root && store.getPage(root.pageId);
    if (!first || !root || !page) return null;
    const parts = [`You are answering in a comment thread on the page ${pageLink(page)} (now at revision ${page.revision}).`];
    if (root.anchor) {
      const now = locateAnchor(page.content, root.anchor);
      parts.push(
        `The thread is about this passage (quoted on revision ${root.anchor.revision}; ${now === null ? 'it has been edited away since, so the thread is outdated' : 'it is still in the page'}):\n` +
          untrusted('page', truncate(root.anchor.quote, 1500)),
      );
    } else parts.push('The thread is about the page as a whole.');
    const earlier = [root, ...store.listCommentReplies(root.id)].filter((c) => c.createdAt <= first.createdAt && !items.some((i) => i.text.endsWith(c.body)));
    if (earlier.length) {
      parts.push(`The thread so far (oldest first):\n${untrusted('page comments', earlier.map((c) => `- ${workspace.memberName(c.authorId)}: ${clip(c.body, 1500)}`).join('\n'))}`);
    }
    parts.push(
      'Your final reply is posted in this thread. Read the page with read_page before you change it; then change it with edit_page, or with propose_page when someone should approve it first.',
    );
    return parts.join('\n\n');
  }

  /** How a thread reads for agents (list_page_comments): who said what, the passage and whether it is still there. */
  describe(thread: CommentThread, page: Page): string {
    const { workspace } = this.app;
    const at = thread.anchor ? locateAnchor(page.content, thread.anchor) : null;
    const about = thread.anchor ? `on "${clip(thread.anchor.quote, 300)}"${at === null ? ' (outdated: that passage was edited away)' : ''}` : 'on the whole page';
    const lines = [`Thread ${thread.id} ${about}${thread.resolved ? `, resolved by ${workspace.memberName(thread.resolvedBy)}` : ''}:`];
    for (const c of [thread, ...thread.replies]) lines.push(`  - ${workspace.memberName(c.authorId)}, ${c.createdAt.slice(0, 16).replace('T', ' ')} UTC: ${clip(c.body, 1500)}`);
    return lines.join('\n');
  }
}
