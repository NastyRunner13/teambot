// Autosave for a page you edit while agents (and other people) may edit it too (after OpenDots' page autosave).
// Your draft is saved a moment after you stop typing, always over the revision it started from. When someone else's
// save gets there first, nothing of yours is written or lost: the editor enters "conflict" with both versions in hand,
// and you choose to load theirs or keep yours. Changes others make while you have nothing unsaved just appear.
import type { Page } from '@teambot/shared';
import { ApiError } from '../api';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
export type Draft = Pick<Page, 'title' | 'content'>;

export interface AutosaveState {
  /** The saved version the draft is based on. */
  base: Page;
  draft: Draft;
  status: SaveStatus;
  /** A newer version than `base`, saved by someone else (set in a conflict). */
  theirs: Page | null;
  error: string | null;
}

/** Saves a page over the revision it names; rejects with ApiError 409 (and the current page in `body`) when it moved on. */
export type SavePage = (id: string, patch: Draft & { expectedRevision: number }) => Promise<Page>;

const DELAY_MS = 800;
const fields = (p: Page): Draft => ({ title: p.title, content: p.content });
const same = (a: Draft, b: Draft) => a.title === b.title && a.content === b.content;

export class PageAutosave {
  private state: AutosaveState;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private saving = false;
  /** Saving as you type: on while the editor is open (start/stop follow it, also through React's double mount). */
  private active = true;
  /** The page is gone (deleted here): nothing more is saved. */
  private closed = false;

  constructor(
    page: Page,
    private save: SavePage,
  ) {
    this.state = { base: page, draft: fields(page), status: 'saved', theirs: null, error: null };
  }

  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private set(patch: Partial<AutosaveState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** Unsaved work: a change not yet saved, a save under way, or a conflict or error waiting for you. */
  get pending(): boolean {
    return this.saving || this.state.status !== 'saved';
  }

  private get changed() {
    return !same(this.state.draft, fields(this.state.base));
  }

  /** A version from the server (a load, or another person's or agent's save announced live). */
  receive(page: Page) {
    const { base, theirs } = this.state;
    if (page.id !== base.id || page.revision <= Math.max(base.revision, theirs?.revision ?? 0)) return;
    // Our own save may be announced before its response arrives: the save settles it.
    if (this.saving) {
      this.set({ theirs: page });
      return;
    }
    if (this.changed || this.state.status === 'conflict') {
      clearTimeout(this.timer);
      this.set({ theirs: page, status: 'conflict', error: null });
    } else {
      this.set({ base: page, draft: fields(page), theirs: null, status: 'saved', error: null });
    }
  }

  edit(patch: Partial<Draft>) {
    const draft = { ...this.state.draft, ...patch };
    if (this.state.status === 'conflict') return this.set({ draft });
    this.set({ draft, status: this.saving ? 'saving' : same(draft, fields(this.state.base)) ? 'saved' : 'dirty', error: null });
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.active && !this.closed && this.changed && this.state.status !== 'conflict') this.timer = setTimeout(() => void this.flush(), DELAY_MS);
  }

  /** Save now (Ctrl+S, leaving the page). Resolves true when everything is saved. */
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.closed || this.saving || this.state.status === 'conflict') return false;
    if (!this.changed) {
      if (this.state.status !== 'saved') this.set({ status: 'saved', error: null });
      return true;
    }
    const { base, draft } = this.state;
    if (!draft.title.trim()) {
      this.set({ status: 'error', error: 'A page needs a title. Your text is still here.' });
      return false;
    }
    this.saving = true;
    this.set({ status: 'saving', error: null });
    try {
      const saved = await this.save(base.id, { ...draft, expectedRevision: base.revision });
      this.saving = false;
      const theirs = this.state.theirs && this.state.theirs.revision > saved.revision ? this.state.theirs : null;
      const typing = !same(this.state.draft, draft);
      this.set({ base: saved, theirs, status: theirs ? 'conflict' : typing ? 'dirty' : 'saved' });
      if (typing && !theirs) this.schedule();
      return !theirs && !typing;
    } catch (err) {
      this.saving = false;
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.body as { page?: Page } | null)?.page ?? null;
        this.set({ theirs: current, status: 'conflict', error: null });
      } else {
        this.set({ status: 'error', error: `${(err as Error).message}. Your text is still here; try again.` });
      }
      return false;
    }
  }

  /** Drop the draft and take the other version. */
  takeTheirs() {
    const { theirs } = this.state;
    if (!theirs) return;
    clearTimeout(this.timer);
    this.set({ base: theirs, draft: fields(theirs), theirs: null, status: 'saved', error: null });
  }

  /** Save the draft over the other version (on purpose: their changes are replaced). */
  keepMine() {
    const { theirs } = this.state;
    if (!theirs) return;
    this.set({ base: theirs, theirs: null, status: same(this.state.draft, fields(theirs)) ? 'saved' : 'dirty', error: null });
    void this.flush();
  }

  start() {
    this.active = true;
    this.schedule();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
  }

  /** The page was deleted: stop saving it. */
  close() {
    this.closed = true;
    this.stop();
  }
}
