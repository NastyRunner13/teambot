// Pages: Markdown documents that people and agents edit together (after OpenDots' Spaces). Every save raises the
// revision by one, and a save names the revision it started from: if someone saved in between, nothing is written and
// the editor gets the current version instead (409 for people, an error the agent can act on for agents). Nobody
// overwrites an edit they never saw, and the refused draft stays with whoever wrote it.
import { MAX_PAGE_CHARS, MAX_PAGE_TITLE, type Page, type PageSummary } from '@teambot/shared';
import type { App } from './app.js';

export class PageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** The page moved on since the revision a save started from. `current` is the page as it is now. */
export class PageConflict extends PageError {
  constructor(readonly current: Page) {
    super(`This page changed while you were editing: it is now revision ${current.revision}.`, 409);
  }
}

export const pageSummary = ({ content: _content, ...summary }: Page): PageSummary => summary;

/** Page ids as they appear on their own or in a link (/pages/page_…). */
const PAGE_ID = /(?:^|\/pages\/)(page_[\w-]+)/;

function cleanTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t) throw new PageError('A page needs a title');
  if (t.length > MAX_PAGE_TITLE) throw new PageError(`Titles are at most ${MAX_PAGE_TITLE} characters`);
  return t;
}

function checkContent(content: string): string {
  if (content.length > MAX_PAGE_CHARS) throw new PageError(`A page holds at most ${MAX_PAGE_CHARS.toLocaleString('en')} characters`);
  return content;
}

export class Pages {
  constructor(private app: App) {}

  list(): PageSummary[] {
    return this.app.store.listPages();
  }

  get(id: string): Page {
    const page = this.app.store.getPage(id);
    if (!page) throw new PageError('page not found', 404);
    return page;
  }

  /** A page by id, link or exact title: agents name pages the way people do. */
  find(ref: string): Page {
    const r = ref.trim();
    const id = PAGE_ID.exec(r)?.[1];
    const byId = id ? this.app.store.getPage(id) : undefined;
    if (byId) return byId;
    const byTitle = this.app.store.findPagesByTitle(r.replace(/^["“]|["”]$/g, ''));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) throw new PageError(`Several pages are called "${r}": ${byTitle.map((p) => p.id).join(', ')}. Name it by id.`);
    throw new PageError(`There is no page "${r}". list_pages shows the pages there are.`, 404);
  }

  /**
   * A new page at revision 1. `source` is the tool call that saved an approved draft: saving it again (a retry after a
   * restart) returns the page it already made.
   */
  create(input: { title: string; content?: string }, by: string, source?: { runId: string; callId: string }): Page {
    const { store, bus } = this.app;
    const earlier = source && store.pageFromSource(source.runId, source.callId);
    if (earlier) return earlier;
    const page = store.insertPage({ title: cleanTitle(input.title), content: checkContent(input.content ?? ''), by, source });
    bus.emit('page.created', { actorId: by }, { page: pageSummary(page) });
    return page;
  }

  /**
   * Save over `expectedRevision`. Throws PageConflict when the page has moved on, unless the save would change nothing
   * (the editor already has what is there).
   */
  update(id: string, patch: { title?: string; content?: string }, expectedRevision: number, by: string): Page {
    const { store, bus } = this.app;
    const current = this.get(id);
    const title = patch.title === undefined ? current.title : cleanTitle(patch.title);
    const content = patch.content === undefined ? current.content : checkContent(patch.content);
    if (title === current.title && content === current.content) return current;
    if (current.revision !== expectedRevision) throw new PageConflict(current);
    const saved = store.updatePage(id, { title, content }, expectedRevision, by);
    // Someone else saved between the read above and this write.
    if (!saved) throw new PageConflict(this.get(id));
    bus.emit('page.updated', { actorId: by }, { page: pageSummary(saved) });
    return saved;
  }

  remove(id: string, by: string) {
    const page = this.get(id);
    this.app.store.deletePage(id);
    this.app.bus.emit('page.deleted', { actorId: by }, { id, title: page.title });
  }
}
