// Learning by demonstration: record what you do on an agent's computer, and TeamBot drafts a skill from it.
// The control sits in the Computer tab's screen bar; stopping asks for a name and what the task was, then opens the
// draft under Skills, where nothing reaches an agent until you save it.
import { Circle, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { recordingClock, type Agent, type Recording, type RecordingSummary } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modal';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The recording going on this agent's computer that you can see, if any. */
export const useActiveRecording = (agentId: string) => useStore((s) => s.recordings.find((r) => r.agentId === agentId && r.status === 'recording'));

/** m:ss since a recording started, ticking. */
function useElapsed(since: string | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? recordingClock(now - Date.parse(since)) : '0:00';
}

export function StopRecordingDialog({ recording, onClose }: { recording: RecordingSummary; onClose: () => void }) {
  const notify = useStore((s) => s.notify);
  const [, navigate] = useLocation();
  const [name, setName] = useState(recording.name);
  const [description, setDescription] = useState(recording.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validName = name === '' || NAME_RE.test(name);

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      await api.post<Recording>(`/recordings/${recording.id}/stop`, { name, description });
      onClose();
      navigate(`/skills/drafts/${recording.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirm('Throw this recording away? Nothing of it is kept.')) return;
    try {
      await api.del(`/recordings/${recording.id}`);
      notify('Recording discarded');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Modal
      title="Stop recording"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost danger" onClick={discard} disabled={busy}>
            Discard
          </button>
          <span className="spacer" />
          {error && <span className="error-text">{error}</span>}
          <button className="btn" onClick={onClose}>
            Keep recording
          </button>
          <button className="btn primary" disabled={busy || !validName} onClick={stop}>
            {busy ? 'Stopping…' : 'Stop and draft a skill'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="rec-description">What were you doing?</label>
        <textarea
          id="rec-description"
          className="textarea"
          data-autofocus
          rows={3}
          maxLength={1000}
          placeholder="Filing a taxi expense in the expenses app. The amount and date change every time."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <span className="hint">Optional, and it helps: say what the task is for and what would be different next time.</span>
      </div>
      <div className="field">
        <label htmlFor="rec-name">Skill name</label>
        <input
          id="rec-name"
          className="input mono"
          placeholder="file-expense"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
          onKeyDown={(e) => e.key === 'Enter' && validName && !busy && void stop()}
        />
        <span className="hint">Optional. Lowercase words joined by hyphens; left empty, the draft suggests one.</span>
      </div>
      <p className="small muted">
        A model writes a draft skill from what you did. It reaches no agent until you review it and save it under Skills.
      </p>
    </Modal>
  );
}

/** Record / Stop in the screen bar. `onStarted` runs once you have the computer (recording takes it from the agent). */
export function RecordControl({ agent, onStarted }: { agent: Agent; onStarted?: () => void }) {
  const notify = useStore((s) => s.notify);
  const recording = useActiveRecording(agent.id);
  const elapsed = useElapsed(recording?.startedAt);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);

  async function start() {
    setBusy(true);
    try {
      await api.post<Recording>(`/agents/${agent.id}/recordings`);
      onStarted?.();
      notify(`Recording. Do the task in ${agent.name}'s browser, then press Stop.`);
    } catch (err) {
      notify(`Couldn't start recording: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!recording) {
    return (
      <button className="btn sm" onClick={start} disabled={busy} title="Record what you do in the browser, and get a draft skill from it">
        <Circle size={11} className="rec-icon" /> {busy ? 'Starting…' : 'Record'}
      </button>
    );
  }
  return (
    <>
      <span className="rec-live" role="status">
        <span className="rec-dot" aria-hidden /> Recording {elapsed} · {recording.actions} {recording.actions === 1 ? 'action' : 'actions'}
      </span>
      <button className="btn sm" onClick={() => setStopping(true)}>
        <Square size={11} /> Stop recording
      </button>
      {stopping && <StopRecordingDialog recording={recording} onClose={() => setStopping(false)} />}
    </>
  );
}
