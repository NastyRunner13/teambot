// Live view of an agent's computer (noVNC over the server's WebSocket bridge), with take-over controls
// and an expanded view that fills the window.
import RFB from '@novnc/novnc';
import { Hand, Maximize2, Minimize2, MonitorOff, Play, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Agent, ComputerStatus } from '@teambot/shared';
import { api, wsUrl } from '../api';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { RecordControl, useActiveRecording } from './RecordControl';

type Info = ComputerStatus & { vncPassword: string };

function VncCanvas({ agentId, password, viewOnly }: { agentId: string; password: string; viewOnly: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<'connecting' | 'connected' | 'lost'>('connecting');

  useEffect(() => {
    if (!ref.current) return;
    setState('connecting');
    const rfb = new RFB(ref.current, wsUrl(`/agents/${agentId}/vnc`), { credentials: { password }, wsProtocols: ['binary'] });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = 'transparent';
    rfb.qualityLevel = 7;
    rfb.viewOnly = viewOnly;
    rfbRef.current = rfb;
    let retry: ReturnType<typeof setTimeout> | undefined;
    rfb.addEventListener('connect', () => setState('connected'));
    rfb.addEventListener('disconnect', () => {
      setState('lost');
      retry = setTimeout(() => setAttempt((n) => n + 1), 2500);
    });
    rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password }));
    return () => {
      clearTimeout(retry);
      try {
        rfb.disconnect();
      } catch {
        /* already closed */
      }
      rfbRef.current = null;
    };
    // viewOnly is applied by the effect below without reconnecting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, password, attempt]);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
    if (!viewOnly) rfbRef.current?.focus();
  }, [viewOnly]);

  return (
    <>
      <div ref={ref} className="screen-canvas" />
      {state !== 'connected' && <div className="screen-overlay">{state === 'connecting' ? 'Connecting to the screen…' : 'Reconnecting…'}</div>}
    </>
  );
}

export function Screen({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const notify = useStore((s) => s.notify);
  const approvals = useStore((s) => s.approvals);
  const recording = useActiveRecording(agent.id);
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [control, setControl] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api.get<Info>(`/agents/${agent.id}/computer`));
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }, [agent.id, notify]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  // A pending handoff/takeover means the agent is already waiting for a human at the screen.
  const waitingForHuman = approvals.some((a) => a.agentId === agent.id && (a.kind === 'handoff' || a.kind === 'takeover'));
  const hasControl = control || !!agent.takeoverBy;

  async function act(path: string, label: string) {
    setBusy(true);
    try {
      await api.post(`/agents/${agent.id}/${path}`);
      await load();
    } catch (err) {
      notify(`${label} failed: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleControl() {
    if (hasControl) {
      setControl(false);
      if (agent.takeoverBy) await act('handback', 'Hand back');
      // Handing back ends a recording; its draft is written under Skills.
      if (recording) notify('Recording stopped. The draft skill is being written: find it under Skills.');
    } else {
      setControl(true);
      if (!waitingForHuman) await act('takeover', 'Take over');
    }
  }

  const running = info?.state === 'running';
  const hint = recording
    ? 'Recording what you do in the browser. Press Stop when the task is done.'
    : hasControl
      ? waitingForHuman
        ? 'You are driving. Finish the step, then answer the request.'
        : `You are driving; ${agent.name} is paused.`
      : 'Watching live (view only)';
  // One live connection at a time: while expanded, only the expanded view shows the screen.
  const live = running && info ? <VncCanvas agentId={agent.id} password={info.vncPassword} viewOnly={!hasControl} /> : null;
  const offline = (
    <div className="screen-overlay">
      <div className="col" style={{ alignItems: 'center' }}>
        <MonitorOff size={28} />
        <div>
          {!info
            ? 'Checking the computer…'
            : info.state === 'starting'
              ? 'Starting the computer…'
              : info.state === 'unavailable'
                ? `Docker is not reachable: ${info.detail ?? ''}`
                : info.state === 'missing'
                  ? `${agent.name}'s computer hasn't been created yet. It starts automatically when ${agent.name} needs it.`
                  : `${agent.name}'s computer is off.`}
        </div>
        {info && (info.state === 'missing' || info.state === 'stopped') && (
          <button className="btn primary" disabled={busy} onClick={() => act('computer/start', 'Start')}>
            <Play size={14} /> {busy ? 'Starting…' : 'Start computer'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div>
      <div className={`screen ${hasControl && running ? 'control' : ''}`}>
        {live ? !expanded && live : offline}
        {live && !expanded && !hasControl && (
          <button className="screen-open" onClick={() => setExpanded(true)} aria-label={`Expand ${agent.name}'s screen`}>
            <span>
              <Maximize2 size={14} /> Expand
            </span>
          </button>
        )}
      </div>
      {running && (
        <div className="screen-bar">
          <button className={`btn ${hasControl ? 'primary' : ''} sm`} onClick={toggleControl} disabled={busy}>
            <Hand size={13} /> {hasControl ? 'Hand back to agent' : 'Take control'}
          </button>
          <RecordControl agent={agent} onStarted={() => setControl(true)} />
          <span className="small muted grow">{hint}</span>
          <button className="btn sm icon" onClick={() => setExpanded(true)} aria-label="Expand the screen" title="Expand">
            <Maximize2 size={13} />
          </button>
          {!compact && (
            <>
              <button className="btn sm" disabled={busy} onClick={() => act('computer/stop', 'Stop')}>
                Stop
              </button>
              <button
                className="btn sm danger"
                disabled={busy}
                onClick={() => {
                  if (confirm(`Wipe ${agent.name}'s computer? Its files, browser logins and installed software are deleted.`)) void act('computer/reset', 'Reset');
                }}
              >
                <RotateCcw size={13} /> Reset
              </button>
            </>
          )}
        </div>
      )}
      {expanded && (
        <ExpandedScreen agent={agent} onClose={() => setExpanded(false)}>
          <div className="screen-full-bar">
            <span className="small muted ellipsis">{running && hint}</span>
            <span className="screen-full-name">
              <Avatar member={agent} size={26} status />
              <span className="ellipsis">{agent.name}</span>
            </span>
            <div className="screen-full-actions">
              {running && <RecordControl agent={agent} onStarted={() => setControl(true)} />}
              {running && (
                <button className={`btn sm pill ${hasControl ? 'primary' : ''}`} onClick={toggleControl} disabled={busy}>
                  <Hand size={13} /> {hasControl ? 'Hand back' : 'Take control'}
                </button>
              )}
              <button className="icon-btn" data-autofocus onClick={() => setExpanded(false)} aria-label="Collapse the screen" title="Collapse">
                <Minimize2 size={18} />
              </button>
            </div>
          </div>
          <div className="screen-stage">
            <div className={`screen ${hasControl && running ? 'control' : ''}`}>{live ?? offline}</div>
          </div>
        </ExpandedScreen>
      )}
    </div>
  );
}

/** The screen filling the window, in the top layer like the shared modal. Escape collapses it, unless
 * you have control and the screen has focus: then Escape goes to the computer. */
function ExpandedScreen({ agent, onClose, children }: { agent: Agent; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="screen-full"
      aria-label={`${agent.name}'s screen`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
