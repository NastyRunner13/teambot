// Pages (after OpenDots' Spaces): Markdown documents you and your agents write and edit together. The library lists
// them, newest change first; a page opens in an editor that saves as you type, over the revision you started from, and
// shows other people's and agents' saves as they happen. "Ask an agent" opens your chat with an agent beside the page,
// and what you send there carries a link to it.
import { ArrowLeft, Check, CircleAlert, FileText, LoaderCircle, MessageSquare, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { Channel, Page } from '@teambot/shared';
import { api } from '../api';
import { Avatar } from '../components/Avatar';
import { Conversation } from '../components/Conversation';
import { Markdown } from '../components/Markdown';
import { MenuButton, MenuItem, MenuSeparator } from '../components/Menu';
import { PageAutosave, type AutosaveState } from '../lib/autosave';
import { ago } from '../lib/format';
import { dmWith, memberName, useMember, useStore } from '../store';

const chars = (n: number) => (n < 1000 ? `${n} characters` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k characters`);

export function PagesView() {
  const pages = useStore((s) => s.pages);
  const loadPages = useStore((s) => s.loadPages);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadPages().catch((err) => notify((err as Error).message, 'error'));
  }, [loadPages, notify]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pages ?? []).filter((p) => !q || p.title.toLowerCase().includes(q));
  }, [pages, query]);

  async function create() {
    setBusy(true);
    try {
      const page = await api.post<Page>('/pages', { title: 'Untitled' });
      navigate(`/pages/${page.id}?new=1`);
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  }

  return (
    <div className="pages">
      <header className="pages-head">
        <div className="grow">
          <h1>Pages</h1>
          <p>Documents you and your agents write and edit together. Ask an agent for a brief or a plan, or start one here and ask it to help.</p>
        </div>
        <button className="btn primary pill" disabled={busy} onClick={() => void create()}>
          <Plus size={16} /> New page
        </button>
      </header>
      {(pages?.length ?? 0) > 0 && (
        <label className="pages-search">
          <Search size={16} />
          <input className="input" placeholder="Find a page by title" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a page by title" />
        </label>
      )}
      <div className="pages-list">
        {pages === null ? (
          <div className="muted small">Loading…</div>
        ) : pages.length === 0 ? (
          <div className="empty">
            No pages yet. Start one, or ask an agent: “write a one-page brief for the launch” — it can save it as a page, or show you the draft to approve first.
          </div>
        ) : shown.length === 0 ? (
          <div className="muted small">No page title has “{query}” in it.</div>
        ) : (
          shown.map((p) => (
            <Link key={p.id} href={`/pages/${p.id}`} className="page-row">
              <FileText size={18} className="faint" />
              <span className="page-row-text">
                <strong className="ellipsis">{p.title}</strong>
                <span className="ellipsis">
                  Edited by {memberName(p.updatedBy)} · {ago(p.updatedAt)}
                </span>
              </span>
              <span className="faint small">{chars(p.size)}</span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

export function PageView({ id }: { id: string }) {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPage(null);
    setError(null);
    api.get<Page>(`/pages/${id}`).then(setPage, (err) => setError((err as Error).message));
  }, [id]);
  if (error) {
    return (
      <div className="center-fill muted">
        <div>
          <p>{error === 'page not found' ? 'This page doesn’t exist, or it was deleted.' : error}</p>
          <Link href="/pages">All pages</Link>
        </div>
      </div>
    );
  }
  if (!page) return <div className="center-fill muted">Opening the page…</div>;
  return <PageEditor key={page.id} page={page} />;
}

const STATUS: Record<AutosaveState['status'], string> = {
  saved: 'All changes saved',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  conflict: 'Changed elsewhere',
  error: 'Couldn’t save',
};

function download(title: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'page'}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function PageEditor({ page }: { page: Page }) {
  const [, navigate] = useLocation();
  const fresh = new URLSearchParams(useSearch()).has('new');
  const notify = useStore((s) => s.notify);
  const loadPages = useStore((s) => s.loadPages);
  const pagesLoaded = useStore((s) => s.pages !== null);
  // The newest revision anyone has saved, announced live.
  const announced = useStore((s) => s.pages?.find((p) => p.id === page.id));
  const [controller] = useState(() => new PageAutosave(page, (id, patch) => api.patch<Page>(`/pages/${id}`, patch)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [mode, setMode] = useState<'write' | 'read'>(fresh || !page.content.trim() ? 'write' : 'read');
  const [asking, setAsking] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editedBy = useMember(state.base.updatedBy);

  useEffect(() => {
    if (!pagesLoaded) loadPages().catch(() => undefined);
  }, [pagesLoaded, loadPages]);

  // Someone else saved a newer revision: fetch it. With nothing unsaved here it simply appears; otherwise you choose.
  // While a save of ours is under way, its own announcement is no news: once it lands, anything newer still is.
  const fetching = useRef(0);
  const saving = state.status === 'saving';
  useEffect(() => {
    if (!announced || saving || announced.revision <= Math.max(state.base.revision, state.theirs?.revision ?? 0, fetching.current)) return;
    fetching.current = announced.revision;
    api.get<Page>(`/pages/${page.id}`).then(
      (p) => controller.receive(p),
      () => undefined,
    );
  }, [announced, saving, state.base.revision, state.theirs, page.id, controller]);

  useEffect(() => {
    if (fresh) title.current?.select();
  }, [fresh]);

  useEffect(() => {
    controller.start();
    const leave = (e: BeforeUnloadEvent) => {
      if (controller.pending) e.preventDefault();
    };
    const save = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.isComposing) {
        e.preventDefault();
        void controller.flush();
      }
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('keydown', save);
    return () => {
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('keydown', save);
      // Leaving the page within the app: save what is there.
      void controller.flush();
      controller.stop();
    };
  }, [controller]);

  // The editor grows with its text, so the page scrolls as one document.
  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [state.draft.content, mode]);

  async function remove() {
    if (!confirm(`Delete the page "${state.draft.title}"? People and agents lose it for good.`)) return;
    try {
      controller.close();
      await api.del(`/pages/${page.id}`);
      navigate('/pages');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  const theirsBy = state.theirs ? memberName(state.theirs.updatedBy) : '';

  return (
    <div className="doc-layout">
      <section className="doc">
        <div className="doc-bar">
          <Link href="/pages" className="back-link">
            <ArrowLeft size={16} /> All pages
          </Link>
          <span className={`doc-status ${state.status}`} role="status" aria-live="polite">
            {state.status === 'saved' ? <Check size={13} /> : state.status === 'saving' ? <LoaderCircle size={13} className="spin" /> : state.status === 'dirty' ? null : <CircleAlert size={13} />}
            {STATUS[state.status]}
          </span>
          <span className="spacer" />
          <div className="segmented" role="group" aria-label="Editor mode">
            <button aria-pressed={mode === 'write'} onClick={() => setMode('write')}>
              Write
            </button>
            <button aria-pressed={mode === 'read'} onClick={() => setMode('read')}>
              Preview
            </button>
          </div>
          <button className={`btn sm pill ${asking ? 'active' : ''}`} aria-pressed={asking} onClick={() => setAsking(!asking)}>
            <MessageSquare size={14} /> Ask an agent
          </button>
          <MenuButton label="More for this page">
            <MenuItem onSelect={() => void controller.flush()}>Save now · Ctrl+S</MenuItem>
            <MenuItem onSelect={() => download(state.draft.title, state.draft.content)}>Download Markdown</MenuItem>
            <MenuItem
              onSelect={() =>
                navigator.clipboard.writeText(state.draft.content).then(
                  () => notify('Copied the Markdown'),
                  () => notify('Could not copy', 'error'),
                )
              }
            >
              Copy Markdown
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => void remove()}>
              Delete page
            </MenuItem>
          </MenuButton>
        </div>
        <div className="doc-scroll">
          <article className="doc-column">
            {state.status === 'conflict' && (
              <div className="doc-notice conflict" role="alert">
                <p>
                  {state.theirs ? (
                    <>
                      <strong>{theirsBy}</strong> saved a newer version (revision {state.theirs.revision}) while you were editing. Your changes are still here, not saved.
                    </>
                  ) : (
                    <>Someone saved a newer version while you were editing. Your changes are still here, not saved.</>
                  )}
                </p>
                <div className="row wrap">
                  <button
                    className="btn sm pill"
                    disabled={!state.theirs}
                    onClick={() => confirm('Load their version? Your unsaved changes here will be lost (download them first to keep a copy).') && controller.takeTheirs()}
                  >
                    Load their version
                  </button>
                  <button className="btn sm pill" onClick={() => download(state.draft.title, state.draft.content)}>
                    Download my changes
                  </button>
                  <button
                    className="btn sm pill danger"
                    disabled={!state.theirs}
                    onClick={() => confirm(`Save your version over ${theirsBy}'s? Their changes will be replaced.`) && controller.keepMine()}
                  >
                    Keep mine
                  </button>
                </div>
              </div>
            )}
            {state.status === 'error' && (
              <div className="doc-notice error" role="alert">
                <p>{state.error}</p>
                <button className="btn sm pill" onClick={() => void controller.flush()}>
                  Try again
                </button>
              </div>
            )}
            <input
              ref={title}
              className="doc-title"
              aria-label="Page title"
              placeholder="Untitled"
              maxLength={160}
              value={state.draft.title}
              onChange={(e) => controller.edit({ title: e.target.value })}
            />
            <div className="doc-meta">
              <Avatar member={editedBy} size={16} />
              <span>
                Edited by {editedBy?.name ?? 'someone'} · {ago(state.base.updatedAt)} · revision {state.base.revision}
              </span>
            </div>
            {mode === 'write' ? (
              <textarea
                ref={editor}
                className="doc-editor"
                aria-label="Page text (Markdown)"
                placeholder="Write in Markdown: # headings, - lists, **bold**, [links](https://…)"
                spellCheck
                value={state.draft.content}
                autoFocus={!fresh}
                onChange={(e) => controller.edit({ content: e.target.value })}
              />
            ) : (
              <div className="doc-preview" onDoubleClick={() => setMode('write')} title="Double-click to edit">
                {state.draft.content.trim() ? <Markdown text={state.draft.content} /> : <p className="muted">This page is empty. Switch to Write to add to it.</p>}
              </div>
            )}
          </article>
        </div>
      </section>
      {asking && <PageAssistant page={{ id: page.id, title: state.draft.title }} beforeSend={() => controller.flush()} onClose={() => setAsking(false)} />}
    </div>
  );
}

/** Your chat with an agent, beside the page. Messages from here link the page, so the agent knows which one you mean. */
function PageAssistant({ page, beforeSend, onClose }: { page: { id: string; title: string }; beforeSend: () => Promise<unknown>; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);
  const [agentId, setAgentId] = useState(() => {
    try {
      const last = localStorage.getItem('teambot-page-agent');
      if (last && agents.some((a) => a.id === last)) return last;
    } catch {
      /* not remembered, still works */
    }
    return agents[0]?.id ?? '';
  });
  const agent = agents.find((a) => a.id === agentId);
  const dm = useStore((s) => (agentId ? dmWith(s.channels, s.me?.id, agentId) : undefined));

  useEffect(() => {
    if (!agentId) return;
    try {
      localStorage.setItem('teambot-page-agent', agentId);
    } catch {
      /* not remembered */
    }
    if (!dm) api.post<Channel>('/dms', { memberId: agentId }).catch((err) => notify((err as Error).message, 'error'));
  }, [agentId, dm, notify]);

  return (
    <aside className="panel doc-assistant" aria-label="Ask an agent about this page">
      <div className="panel-bar">
        <select className="select doc-agent-select" aria-label="Agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close">
          <X size={18} />
        </button>
      </div>
      {!agent ? (
        <div className="panel-empty static">Create an agent first, then ask it about your pages.</div>
      ) : dm ? (
        <div className="doc-assistant-chat">
          <Conversation
            channelId={dm.id}
            partnerId={agent.id}
            placeholder={`Ask ${agent.name} about this page`}
            prefix={`About the page [${page.title.replace(/[[\]]/g, '') || 'Untitled'}](/pages/${page.id}):`}
            beforeSend={beforeSend}
            empty={<p className="small muted doc-assistant-empty">Ask {agent.name} to read, improve or extend this page. It edits the page itself, and you see its changes here as it saves them.</p>}
          />
        </div>
      ) : (
        <div className="muted small" style={{ padding: 16 }}>
          Opening your chat with {agent.name}…
        </div>
      )}
    </aside>
  );
}
