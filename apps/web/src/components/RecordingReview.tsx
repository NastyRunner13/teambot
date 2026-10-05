// A skill drafted from a recording, for a person to review: the draft beside what they did (the actions and the
// stills). Nothing reaches an agent until it is saved as a skill; saving deletes the draft and its stills.
import { Lock, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { describeAction, recordingClock, type Recording, type RecordingFrame, type Skill } from '@teambot/shared';
import { ApiError, api } from '../api';
import { ago } from '../lib/format';
import { memberName, useStore } from '../store';
import { Markdown } from './Markdown';
import { Modal } from './Modal';
import { StopRecordingDialog } from './RecordControl';

/** The body without front matter, for the preview. */
const bodyOf = (content: string) => content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

/** A starting point for writing the skill by hand when no draft could be made. */
function handTemplate(rec: Recording): string {
  const name = rec.name || 'recorded-task';
  const steps = rec.log.map((a, i) => `${i + 1}. ${describeAction(a)}`).join('\n');
  return `---\nname: ${name}\ndescription: ${rec.description.replace(/\s+/g, ' ').trim() || 'What this skill does and when to use it.'}\n---\n\n## Steps\n${steps}\n`;
}

const STATUS: Record<Recording['status'], { label: string; tone: string }> = {
  recording: { label: 'Recording', tone: 'danger' },
  drafting: { label: 'Drafting…', tone: 'info' },
  ready: { label: 'Draft · not saved', tone: 'warn' },
  failed: { label: 'Couldn’t draft', tone: 'danger' },
};

export function RecordingReview({ id }: { id: string }) {
  const notify = useStore((s) => s.notify);
  const summary = useStore((s) => s.recordings.find((r) => r.id === id));
  const agentName = useStore((s) => s.agents.find((a) => a.id === summary?.agentId)?.name);
  const [, navigate] = useLocation();
  const [rec, setRec] = useState<Recording | null>(null);
  const [text, setText] = useState('');
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [still, setStill] = useState<RecordingFrame | null>(null);
  /** The draft the text was last loaded from: a new draft replaces the text only if it wasn't edited since. */
  const loaded = useRef<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<Recording>(`/recordings/${id}`);
    const before = loaded.current;
    loaded.current = r.draft;
    setRec(r);
    setText((t) => (before === null || t === before ? r.draft : t));
  }, [id]);

  // Again whenever the recording changes (new actions, the draft arriving); not once it is gone (saved or discarded).
  const exists = !!summary;
  useEffect(() => {
    if (exists) load().catch((err) => setError((err as Error).message));
  }, [load, exists, summary?.updatedAt, summary?.status, summary?.actions]);

  if (!summary) return <div className="muted">This draft is gone: it was saved as a skill or discarded.</div>;
  if (!rec) return error ? <div className="error-text">{error}</div> : <div className="muted">Loading…</div>;

  const status = STATUS[summary.status];
  const dirty = text !== rec.draft;
  const editable = summary.status === 'ready' || (summary.status === 'failed' && (!!rec.draft || writing));

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const saveSkill = (overwrite = false): Promise<void> =>
    run(async () => {
      try {
        const skill = await api.post<Skill>(`/recordings/${id}/save`, { content: text, overwrite });
        notify(`Saved the skill ${skill.name}. Agents with access use it from their next step.`);
        navigate(`/skills/${skill.name}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && !overwrite && /already a skill/.test(err.message)) {
          if (confirm(`${err.message}\n\nReplace that skill with this draft?`)) return saveSkill(true);
          return;
        }
        throw err;
      }
    });

  const saveDraft = () =>
    run(async () => {
      const saved = await api.put<Recording>(`/recordings/${id}/draft`, { content: text });
      loaded.current = saved.draft;
      setRec(saved);
      setText(saved.draft);
      notify('Draft kept. Agents still can’t use it until you save it as a skill.');
    });

  const draftAgain = () =>
    run(async () => {
      if (dirty && !confirm('Draft it again? Your edits to this draft are replaced.')) return;
      loaded.current = null;
      setWriting(false);
      await api.post(`/recordings/${id}/draft`);
    });

  const discard = () =>
    run(async () => {
      if (!confirm('Delete this draft, its recording and its stills?')) return;
      await api.del(`/recordings/${id}`);
      navigate('/skills');
    });

  return (
    <div className="draft-review">
      <div className="draft-cols">
        <div className="draft-main">
          <div className="row" style={{ marginBottom: 6 }}>
            <h2 className="grow mono ellipsis" style={{ fontSize: 15 }}>
              {rec.name || 'Untitled recording'}
            </h2>
            <span className={`badge ${status.tone}`}>{status.label}</span>
          </div>
          <p className="small muted" style={{ margin: '0 0 12px' }}>
            Recorded on {agentName ?? 'a removed agent'}’s computer by {memberName(rec.startedBy)} · {ago(rec.startedAt)}
            {rec.description && <> · “{rec.description}”</>}
          </p>

          {summary.status === 'recording' && (
            <div className="draft-note">
              <span className="rec-dot" aria-hidden />
              <span className="grow">Still recording. Do the task in {agentName ?? 'the agent'}’s browser (Computer tab), then stop.</span>
              <button className="btn sm" onClick={() => setStopping(true)}>
                Stop
              </button>
            </div>
          )}
          {summary.status === 'drafting' && <div className="draft-note shimmer">Writing a draft skill from what you did…</div>}
          {summary.status === 'failed' && (
            <div className="draft-note danger">
              <span className="grow">{rec.error ?? 'The draft could not be written.'}</span>
              {rec.log.length > 1 && (
                <button className="btn sm" disabled={busy} onClick={draftAgain}>
                  <RotateCcw size={13} /> Draft again
                </button>
              )}
              {!editable && rec.log.length > 1 && (
                <button
                  className="btn sm"
                  onClick={() => {
                    setWriting(true);
                    setText(handTemplate(rec));
                  }}
                >
                  Write it yourself
                </button>
              )}
            </div>
          )}

          {editable && (
            <>
              <div className="row" style={{ margin: '12px 0 8px' }}>
                <span className="small muted grow">Agents can’t use this draft until you save it as a skill.</span>
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
                <textarea className="textarea code skill-text" spellCheck={false} aria-label="Draft SKILL.md" value={text} onChange={(e) => setText(e.target.value)} />
              )}
            </>
          )}
          {error && (
            <div className="error-text" style={{ marginTop: 8 }}>
              {error}
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 12 }}>
            {editable && (
              <>
                <button className="btn primary" disabled={busy || !text.trim()} onClick={() => void saveSkill()}>
                  Save as skill
                </button>
                <button className="btn" disabled={busy || !dirty} onClick={saveDraft}>
                  Keep draft
                </button>
                <button className="btn" disabled={busy || !dirty} onClick={() => setText(rec.draft)}>
                  Undo edits
                </button>
              </>
            )}
            <span className="spacer" />
            <button className="btn ghost danger" disabled={busy} onClick={discard}>
              <Trash2 size={14} /> Discard
            </button>
          </div>
        </div>

        <aside className="draft-recording" aria-label="What you did">
          <h3>What you did</h3>
          {rec.dropped > 0 && <p className="small muted">{rec.dropped} actions are missing: too many happened at once.</p>}
          {rec.log.length ? (
            <ol className="rec-log">
              {rec.log.map((a) => (
                <li key={a.seq}>
                  <span className="rec-time">{recordingClock(a.t)}</span>
                  <span className="rec-what">{describeAction(a)}</span>
                  {(a.sensitive || a.secrets?.length) && (
                    <span title={a.secrets?.length ? `Stored secret: ${a.secrets.join(', ')}` : 'Not recorded'}>
                      <Lock size={12} className="faint" aria-label="secret" />
                    </span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="small muted">Nothing yet.</p>
          )}
          {rec.frameList.length > 0 && (
            <>
              <h3>Stills</h3>
              <div className="rec-stills">
                {rec.frameList.map((f) => (
                  <button key={f.file} className="rec-still" onClick={() => setStill(f)} title={`${recordingClock(f.t)} · ${f.title || f.url}`}>
                    <img src={`/api/recordings/${id}/frames/${f.file}`} alt={`The screen at ${recordingClock(f.t)}: ${f.title || f.url}`} loading="lazy" />
                  </button>
                ))}
              </div>
              <p className="small muted">Fields are covered over, and pages where you typed a password or a secret have no stills.</p>
            </>
          )}
        </aside>
      </div>

      {still && (
        <Modal title={`${recordingClock(still.t)} · ${still.title || 'Still'}`} onClose={() => setStill(null)} wide>
          <img className="rec-still-large" src={`/api/recordings/${id}/frames/${still.file}`} alt={`The screen at ${recordingClock(still.t)}`} />
          <p className="small muted mono ellipsis">{still.url}</p>
        </Modal>
      )}
      {stopping && <StopRecordingDialog recording={summary} onClose={() => setStopping(false)} />}
    </div>
  );
}
