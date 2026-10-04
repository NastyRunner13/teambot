// Components (after OpenBot's playground): interfaces agents draw in conversations. Write the HTML, CSS and script,
// describe the arguments as JSON Schema, and preview it live with sample arguments, in the same sandbox chats use.
// Saving keeps a draft that reaches nobody; publishing hands it to every agent as the tool ui_<name>. Agents can
// draft components too (draft_component); a person publishes them here.
import { LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { COMPONENT_NAME_RE, type UiComponent } from '@teambot/shared';
import { api } from '../api';
import { Modal } from '../components/Modal';
import { WidgetFrame } from '../components/WidgetFrame';
import { ago } from '../lib/format';
import { memberName, useStore } from '../store';

const STARTER: Omit<UiComponent['draft'], 'description'> = {
  html: `<div class="card">
  <h3 id="title"></h3>
  <p id="body" class="muted"></p>
</div>`,
  css: `.card { border: 1px solid var(--tb-border); border-radius: var(--tb-radius); padding: 14px 16px; }
h3 { margin: 0 0 4px; font-size: 15px; }
.muted { margin: 0; color: var(--tb-muted); }`,
  js: `// The arguments an agent passed are on teambot.args.
const { title = 'Untitled', body = '' } = teambot.args;
document.getElementById('title').textContent = title;
document.getElementById('body').textContent = body;`,
  argsSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'The heading' },
      body: { type: 'string', description: 'One or two sentences under it' },
    },
    required: ['title'],
  },
  sampleArgs: { title: 'A worked example', body: 'Edit the panels on the left and this redraws.' },
};

type Tab = 'html' | 'css' | 'js' | 'argsSchema' | 'sampleArgs';
const TABS: [Tab, string][] = [
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['js', 'Script'],
  ['argsSchema', 'Arguments'],
  ['sampleArgs', 'Sample'],
];

/** The editor's working copy: everything as text, so half-typed JSON can sit there. */
interface Working {
  title: string;
  description: string;
  html: string;
  css: string;
  js: string;
  argsSchema: string;
  sampleArgs: string;
}

const toWorking = (c: UiComponent): Working => ({
  title: c.title,
  description: c.draft.description,
  html: c.draft.html,
  css: c.draft.css,
  js: c.draft.js,
  argsSchema: JSON.stringify(c.draft.argsSchema, null, 2),
  sampleArgs: JSON.stringify(c.draft.sampleArgs, null, 2),
});

function parseObject(text: string, label: string): { value?: Record<string, unknown>; error?: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${label} must be a JSON object` };
    return { value: value as Record<string, unknown> };
  } catch (err) {
    return { error: `${label} isn't valid JSON: ${(err as Error).message}` };
  }
}

/** Members in team mode can look; publishing hands a component to every agent, so owners decide (the server checks too). */
function useCanManage() {
  const teamMode = useStore((s) => s.teamMode);
  const role = useStore((s) => s.me?.role);
  return !teamMode || role === 'owner';
}

function StatusBadge({ c }: { c: UiComponent }) {
  if (c.live && c.changed) return <span className="badge warn">Published · changes not published</span>;
  if (c.live) return <span className="badge ok">Published</span>;
  if (c.published) return <span className="badge">Withdrawn</span>;
  return <span className="badge">Draft</span>;
}

function NewComponentDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = COMPONENT_NAME_RE.test(name) && !!title.trim();

  async function create() {
    try {
      await api.put(`/components/${name}`, { title: title.trim(), description: '', ...STARTER });
      onClose();
      navigate(`/components/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title="New component"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void create()}>
            Create draft
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="component-title">Title</label>
        <input id="component-title" className="input" data-autofocus placeholder="Price table" value={title} onChange={(e) => {
          setTitle(e.target.value);
          if (!name || name === slug(title)) setName(slug(e.target.value));
        }} />
      </div>
      <div className="field">
        <label htmlFor="component-name">Name</label>
        <input
          id="component-name"
          className="input mono"
          placeholder="price_table"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
          onKeyDown={(e) => e.key === 'Enter' && valid && void create()}
        />
        <span className="hint">Agents call it as the tool ui_{name || 'name'}. Lowercase letters, numbers and underscores; it can't change later.</span>
      </div>
    </Modal>
  );
}

const slug = (title: string) => title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

function Playground({ component }: { component: UiComponent }) {
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const canManage = useCanManage();
  const [work, setWork] = useState<Working>(() => toWorking(component));
  const [saved, setSaved] = useState<Working>(() => toWorking(component));
  const [tab, setTab] = useState<Tab>('html');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(work);

  // A save or publish elsewhere (an agent's new draft, another owner) shows here unless you have unsaved edits.
  useEffect(() => {
    const next = toWorking(component);
    setSaved(next);
    setWork((w) => (JSON.stringify(w) === JSON.stringify(saved) ? next : w));
  }, [component]); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw the preview a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setPreview(work), 400);
    return () => clearTimeout(t);
  }, [work]);

  const schema = parseObject(work.argsSchema, 'Arguments');
  const sample = parseObject(work.sampleArgs, 'Sample arguments');
  const previewSample = useMemo(() => parseObject(preview.sampleArgs, 'Sample').value ?? {}, [preview.sampleArgs]);
  const jsonError = schema.error ?? sample.error;
  const dirty = JSON.stringify(work) !== JSON.stringify(saved);
  const set = (key: keyof Working) => (value: string) => {
    setError(null);
    setWork((w) => ({ ...w, [key]: value }));
  };

  async function save(): Promise<boolean> {
    if (jsonError) {
      setError(jsonError);
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      await api.put<UiComponent>(`/components/${component.name}`, {
        title: work.title,
        description: work.description,
        html: work.html,
        css: work.css,
        js: work.js,
        argsSchema: schema.value,
        sampleArgs: sample.value,
      });
      setSaved(work);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const c = await api.post<UiComponent>(`/components/${component.name}/publish`);
      notify(`Published: agents can use ui_${c.name} from their next step`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(path: 'unpublish' | 'delete') {
    if (path === 'delete' && !confirm(`Delete the component "${component.title}"? Conversations keep what was already drawn.`)) return;
    setBusy(true);
    try {
      if (path === 'delete') {
        await api.del(`/components/${component.name}`);
        navigate('/components');
      } else {
        await api.post(`/components/${component.name}/unpublish`);
        notify('Withdrawn: no agent can draw it now');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const published = component.published;
  return (
    <div className="playground">
      <div className="playground-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <input className="playground-title" aria-label="Title" value={work.title} disabled={!canManage} onChange={(e) => set('title')(e.target.value)} />
          <div className="row small" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span className="mono faint">ui_{component.name}</span>
            <StatusBadge c={component} />
            {dirty && <span className="faint">· unsaved edits</span>}
          </div>
        </div>
        {canManage && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn sm pill" disabled={busy || !dirty} onClick={() => void save().then((ok) => ok && notify('Draft saved'))}>
              Save draft
            </button>
            <button className="btn sm pill primary" disabled={busy || (component.live && !component.changed && !dirty)} onClick={() => void publish()}>
              {component.live ? 'Publish changes' : 'Publish'}
            </button>
          </div>
        )}
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <label htmlFor="component-description">What it is for</label>
        <textarea
          id="component-description"
          className="textarea"
          style={{ minHeight: 64 }}
          disabled={!canManage}
          placeholder="Agents read this to decide when to use it, e.g. “Compare plans side by side: name, monthly price and what each includes.”"
          value={work.description}
          onChange={(e) => set('description')(e.target.value)}
        />
      </div>
      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
      <div className="playground-split">
        <div className="playground-code">
          <div className="segmented playground-tabs" role="tablist" aria-label="Source">
            {TABS.map(([t, label]) => (
              <button key={t} role="tab" aria-pressed={tab === t} aria-selected={tab === t} onClick={() => setTab(t)}>
                {label}
              </button>
            ))}
          </div>
          <textarea
            className="textarea code playground-text"
            spellCheck={false}
            aria-label={TABS.find(([t]) => t === tab)![1]}
            disabled={!canManage}
            value={work[tab]}
            onChange={(e) => set(tab)(e.target.value)}
          />
          {(tab === 'argsSchema' || tab === 'sampleArgs') && (
            <p className="hint small muted">
              {tab === 'argsSchema'
                ? 'JSON Schema of an object. Agents see it as the tool’s parameters, and their arguments are checked against it.'
                : 'Arguments the preview draws with. Publishing checks that they fit the schema.'}
            </p>
          )}
        </div>
        <div className="playground-preview">
          <div className="panel-label">
            <span>Preview</span>
            <span className="faint small">sandboxed, as in a chat</span>
          </div>
          <div className="widget-card">
            <WidgetFrame widget={{ title: work.title, html: preview.html, css: preview.css, js: preview.js, args: previewSample }} onReply={(text) => notify(`It would put “${text}” in the message box`)} />
          </div>
          {jsonError && <p className="small error-text">{jsonError}</p>}
        </div>
      </div>
      <dl className="kv" style={{ marginTop: 20 }}>
        <dt>Published</dt>
        <dd>
          {published ? (
            <>
              Revision {published.revision} by {memberName(published.by)}, {ago(published.at)}
              {component.live ? '' : ' (withdrawn)'}
            </>
          ) : (
            'Not yet: nobody can use it until it is published'
          )}
        </dd>
        <dt>Draft</dt>
        <dd>
          Last saved by {memberName(component.updatedBy)}, {ago(component.updatedAt)}
        </dd>
      </dl>
      {canManage && (
        <div className="row" style={{ marginTop: 16 }}>
          {component.live && (
            <button className="btn" disabled={busy} onClick={() => void act('unpublish')}>
              Withdraw
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost danger" disabled={busy} onClick={() => void act('delete')}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function ComponentsView({ name }: { name?: string }) {
  const components = useStore((s) => s.components);
  const loadComponents = useStore((s) => s.loadComponents);
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);
  const canManage = useCanManage();

  useEffect(() => {
    loadComponents().catch((err) => notify((err as Error).message, 'error'));
  }, [loadComponents, notify]);

  const open = components?.find((c) => c.name === name);
  return (
    <>
      <header className="fill-head">
        <div className="grow">
          <h1>Components</h1>
          <p>Interfaces agents draw in conversations instead of answering only in text. Drafts reach nobody; publishing makes one a tool every agent can use.</p>
        </div>
        {canManage && (
          <button className="btn" onClick={() => setCreating(true)}>
            <Plus size={15} /> New component
          </button>
        )}
      </header>
      <div className="split-view">
        <div className="split-list">
          {components?.length === 0 && (
            <div className="empty" style={{ margin: 16 }}>
              No components yet. Make one here, or ask an agent to draft one (“make a reusable card for project status”), then publish it.
            </div>
          )}
          {components?.map((c) => (
            <div key={c.name} className={`list-row clickable ${c.name === name ? 'selected' : ''}`} onClick={() => navigate(`/components/${c.name}`)}>
              <LayoutTemplate size={15} className="faint" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 600 }}>
                  {c.title}
                </div>
                <div className="row small" style={{ gap: 6 }}>
                  <span className="mono faint ellipsis">ui_{c.name}</span>
                  <StatusBadge c={c} />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {open ? (
            <Playground key={open.name} component={open} />
          ) : (
            <div className="muted">{components === null ? 'Loading…' : name ? 'There is no component by that name.' : components.length ? 'Pick a component to preview or edit it.' : 'Create your first component to get started.'}</div>
          )}
        </div>
      </div>
      {creating && <NewComponentDialog onClose={() => setCreating(false)} />}
    </>
  );
}
