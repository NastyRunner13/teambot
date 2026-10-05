// Skills: written procedures (SKILL.md) the team's agents load and follow.
import { BookOpen, Circle, FileClock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import type { Skill } from '@teambot/shared';
import { api } from '../api';
import { Markdown } from '../components/Markdown';
import { Modal } from '../components/Modal';
import { RecordingReview } from '../components/RecordingReview';
import { ago } from '../lib/format';
import { useStore } from '../store';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function template(name: string) {
  const title = name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return `---
name: ${name}
description: What this skill does and when to use it, in one or two sentences. Agents decide whether to load it from this line.
---

# ${title}

## When to use
Describe the situations where this procedure applies.

## Steps
1. First step.
2. Second step.

## Output
Where the result goes and what it looks like (for example a file in /shared, or a message in a channel).
`;
}

/** The body without front matter, for the preview. */
const bodyOf = (content: string) => content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

function NewSkillDialog({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const valid = NAME_RE.test(name);

  async function create() {
    try {
      await api.put(`/skills/${name}`, { content: template(name) });
      onClose();
      navigate(`/skills/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title="New skill"
      onClose={onClose}
      footer={
        <>
          {error && <span className="error-text grow">{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid} onClick={create}>
            Create skill
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="skill-name">Name</label>
        <input
          id="skill-name"
          className="input mono"
          data-autofocus
          placeholder="weekly-report"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          onKeyDown={(e) => e.key === 'Enter' && valid && void create()}
        />
        <span className="hint">Lowercase words joined by hyphens. You'll write the procedure next.</span>
      </div>
    </Modal>
  );
}

function Editor({ name }: { name: string }) {
  const notify = useStore((s) => s.notify);
  const agents = useStore((s) => s.agents);
  const [, navigate] = useLocation();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSkill(null);
    setError(null);
    api.get<Skill>(`/skills/${name}`).then(
      (s) => {
        setSkill(s);
        setText(s.content);
      },
      (err) => setError((err as Error).message),
    );
  }, [name]);

  if (!skill) return error ? <div className="error-text">{error}</div> : <div className="muted">Loading…</div>;
  const users = agents.filter((a) => a.skills.includes('*') || a.skills.includes(name));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<Skill>(`/skills/${name}`, { content: text });
      setSkill(saved);
      setText(saved.content);
      notify('Skill saved — agents use the new version from their next step');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete the skill "${name}" and its folder?`)) return;
    try {
      await api.del(`/skills/${name}`);
      navigate('/skills');
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div className="skill-editor">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 className="grow mono ellipsis" style={{ fontSize: 15 }}>
          {name}
        </h2>
        <div className="segmented" role="group" aria-label="Editor mode">
          <button aria-pressed={!preview} onClick={() => setPreview(false)}>
            Edit
          </button>
          <button aria-pressed={preview} onClick={() => setPreview(true)}>
            Preview
          </button>
        </div>
      </div>
      {preview ? (
        <div className="file-preview">
          <Markdown text={bodyOf(text)} />
        </div>
      ) : (
        <textarea className="textarea code skill-text" spellCheck={false} aria-label="SKILL.md" value={text} onChange={(e) => setText(e.target.value)} />
      )}
      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || text === skill.content} onClick={save}>
          {busy ? 'Saving…' : 'Save skill'}
        </button>
        <button className="btn" disabled={text === skill.content} onClick={() => setText(skill.content)}>
          Discard changes
        </button>
        <span className="spacer" />
        <button className="btn ghost danger" onClick={remove}>
          <Trash2 size={14} /> Delete
        </button>
      </div>
      <dl className="kv" style={{ marginTop: 20 }}>
        <dt>Used by</dt>
        <dd>{users.length ? users.map((a) => a.name).join(', ') : 'No agent has access (change it in an agent’s Customize page)'}</dd>
        <dt>Files</dt>
        <dd>
          {skill.files.length ? (
            <span className="mono small">{skill.files.join(', ')}</span>
          ) : (
            <span className="muted">Only SKILL.md. Put scripts or templates in the skill’s folder on the server and agents get a copy when they use it.</span>
          )}
        </dd>
        <dt>Updated</dt>
        <dd>{ago(skill.updatedAt)}</dd>
      </dl>
    </div>
  );
}

const DRAFT_STATUS = { recording: 'Recording…', drafting: 'Writing the draft…', ready: 'Ready to review', failed: 'Couldn’t draft' } as const;

/** `name` opens a skill, `draft` a skill drafted from a recording. */
export function SkillsView({ name, draft }: { name?: string; draft?: string }) {
  const skills = useStore((s) => s.skills);
  const drafts = useStore((s) => s.recordings);
  const agents = useStore((s) => s.agents);
  const [, navigate] = useLocation();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <header className="fill-head">
        <div className="grow">
          <h1>Skills</h1>
          <p>Written procedures your agents load and follow, in the open SKILL.md format. Write one, or show one: take control of an agent’s computer and press Record.</p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}>
          <Plus size={15} /> New skill
        </button>
      </header>
      <div className="split-view">
        <div className="split-list">
          {drafts.length > 0 && (
            <>
              <div className="split-list-label">Drafts from recordings</div>
              {drafts.map((r) => (
                <div key={r.id} className={`list-row clickable ${r.id === draft ? 'selected' : ''}`} onClick={() => navigate(`/skills/drafts/${r.id}`)}>
                  {r.status === 'recording' ? <Circle size={13} className="rec-icon" /> : <FileClock size={15} className="faint" />}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis mono small" style={{ fontWeight: 600 }}>
                      {r.name || 'Untitled recording'}
                    </div>
                    <div className={`small ${r.status === 'failed' ? 'error-text' : r.status === 'ready' ? 'warn-text' : 'muted'} skill-desc`}>
                      {DRAFT_STATUS[r.status]} · {agents.find((a) => a.id === r.agentId)?.name ?? 'removed agent'} · {r.actions} {r.actions === 1 ? 'action' : 'actions'}
                    </div>
                  </div>
                </div>
              ))}
              <div className="split-list-label">Skills</div>
            </>
          )}
          {skills.length === 0 && (
            <div className="empty" style={{ margin: 16 }}>
              No skills yet. Write down how your team does a recurring job once, and every agent can follow it.
            </div>
          )}
          {skills.map((s) => (
            <div key={s.name} className={`list-row clickable ${s.name === name ? 'selected' : ''}`} onClick={() => navigate(`/skills/${s.name}`)}>
              <BookOpen size={15} className="faint" />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis mono small" style={{ fontWeight: 600 }}>
                  {s.name}
                </div>
                <div className={`small ${s.error ? 'error-text' : 'muted'} skill-desc`}>{s.error ?? s.description}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="split-detail">
          {draft ? (
            <RecordingReview key={draft} id={draft} />
          ) : name ? (
            <Editor key={name} name={name} />
          ) : (
            <div className="muted">{skills.length || drafts.length ? 'Pick a skill to read or edit it.' : 'Create your first skill to get started.'}</div>
          )}
        </div>
      </div>
      {creating && <NewSkillDialog onClose={() => setCreating(false)} />}
    </>
  );
}
