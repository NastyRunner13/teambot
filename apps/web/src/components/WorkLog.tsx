// What an agent did for its reply, inside the conversation: one live line while it works, then a short note
// above the reply ("Worked for 2m 14s · 5 steps") that opens to its plan — the checklist it kept with
// update_progress — or, without one, to the actions that mattered. Every detail is one click away in the panel's
// full log.
import { Ban, Check, ChevronRight, CircleAlert, Hand, Loader2, Monitor, ShieldQuestion, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PROGRESS_TOOL, type EventRecord, type ProgressStep, type Run, type RunSummary } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { useRunEvents } from './RunTimeline';

type StepState = 'ok' | 'failed' | 'blocked' | 'asking' | 'running' | 'answered' | 'stopped';
interface Step {
  key: string;
  state: StepState;
  text: string;
}

/** The steps worth showing: actions and how they went, a human's answers, and why a run stopped. */
function stepsOf(events: EventRecord[]): Step[] {
  const steps: Step[] = [];
  const byCall = new Map<string, Step>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === 'tool.checked') {
      if (d.tool === PROGRESS_TOOL) continue; // the plan shows as the checklist, not as an action
      const state: StepState = d.action === 'deny' ? 'blocked' : d.action === 'ask' || d.action === 'handoff' ? 'asking' : 'running';
      const step: Step = { key: `t${e.id}`, state, text: d.summary };
      byCall.set(d.toolCallId, step);
      steps.push(step);
    } else if (e.type === 'tool.finished') {
      const step = byCall.get(d.toolCallId);
      if (step && step.state !== 'blocked') step.state = d.ok ? 'ok' : 'failed';
    } else if (e.type === 'approval.resolved') {
      const status = d.approval?.status as string | undefined;
      const said = status === 'approved' ? 'You approved it' : status === 'denied' ? 'You said no' : status === 'done' ? 'You did the step' : status === 'declined' ? 'You declined the step' : 'The request was withdrawn';
      steps.push({ key: `a${e.id}`, state: 'answered', text: d.approval?.note ? `${said}: “${d.approval.note}”` : said });
    } else if (e.type === 'run.failed') {
      steps.push({ key: `f${e.id}`, state: 'failed', text: d.error ? `Failed: ${d.error}` : 'Failed' });
    } else if (e.type === 'budget.exceeded') {
      steps.push({ key: `b${e.id}`, state: 'stopped', text: 'Stopped: its budget is used up' });
    } else if (e.type === 'run.cancelled') {
      steps.push({ key: `c${e.id}`, state: 'stopped', text: 'Stopped' });
    }
  }
  return steps;
}

/** What the agent is doing this moment, in a few words. */
function nowDoing(run: Run, steps: Step[]): string {
  switch (run.status) {
    case 'waiting_approval':
      return 'Waiting for your approval';
    case 'waiting_human':
      return 'Waiting for you to do a step';
    case 'paused':
      return 'Paused';
    case 'queued':
      return 'About to start';
  }
  const planned = run.progress.find((s) => s.status === 'in_progress');
  if (planned) return planned.text;
  const current = [...steps].reverse().find((s) => s.state === 'running');
  return current ? current.text : 'Thinking';
}

/** "2 of 5", for a plan in progress. */
function progressCount(steps: ProgressStep[]): string {
  return `${steps.filter((s) => s.status === 'done').length} of ${steps.length}`;
}

/** An agent's plan for a run: every step, the finished ones checked and, while it works, the current one spinning. */
export function ProgressList({ steps, live = false }: { steps: ProgressStep[]; live?: boolean }) {
  return (
    <ol className="progress-list" aria-label="Progress">
      {steps.map((s, i) => {
        const state = s.status === 'done' ? 'ok' : s.status === 'in_progress' && live ? 'running' : 'pending';
        return (
          <li key={i} className={`work-step ${state}`}>
            <span className="work-step-icon">{state === 'ok' ? <Check size={12} /> : state === 'running' ? <Loader2 size={12} className="spin" /> : null}</span>
            <span className="work-step-text">{s.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const ICON: Record<StepState, React.ReactNode> = {
  ok: <Check size={12} />,
  failed: <X size={12} />,
  blocked: <Ban size={12} />,
  asking: <ShieldQuestion size={12} />,
  running: <Loader2 size={12} className="spin" />,
  answered: <Hand size={12} />,
  stopped: <Square size={10} />,
};

function StepList({ steps, runId, progress, live, children }: { steps: Step[] | null; runId: string; progress: ProgressStep[]; live?: boolean; children?: React.ReactNode }) {
  const openRun = useStore((s) => s.openRun);
  return (
    <div className="work-steps">
      {progress.length ? (
        <ProgressList steps={progress} live={live} />
      ) : steps === null ? (
        <div className="work-step muted">Loading…</div>
      ) : steps.length === 0 ? (
        <div className="work-step muted">No actions yet.</div>
      ) : (
        steps.map((s) => (
          <div key={s.key} className={`work-step ${s.state}`}>
            <span className="work-step-icon">{ICON[s.state]}</span>
            <span className="work-step-text">{s.text}</span>
          </div>
        ))
      )}
      <div className="work-links">
        <button type="button" className="link-btn" onClick={() => openRun(runId)}>
          Full log <ChevronRight size={12} />
        </button>
        {children}
      </div>
    </div>
  );
}

/** Above an agent's reply: how long it worked, and its plan or (without one) its actions. Actions load when opened. */
export function WorkNote({ run }: { run: RunSummary }) {
  const [open, setOpen] = useState(false);
  const plan = run.progress;
  const events = useRunEvents(open && !plan.length ? run.id : null);
  const steps = useMemo(() => (open && events.length ? stepsOf(events) : null), [open, events]);
  const took = duration(new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime());
  const failed = run.status === 'failed' || run.status === 'cancelled';
  const done = plan.filter((s) => s.status === 'done').length;
  const count = plan.length ? (done < plan.length ? `${progressCount(plan)} steps done` : `${plan.length} ${plan.length === 1 ? 'step' : 'steps'}`) : `${run.toolCalls} ${run.toolCalls === 1 ? 'step' : 'steps'}`;
  return (
    <div className={`work-note ${open ? 'open' : ''}`}>
      <button type="button" className="work-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} className="chev" />
        {failed ? <CircleAlert size={13} className="bad" /> : null}
        <span>
          {failed ? 'Stopped after' : 'Worked for'} {took} · {count}
        </span>
      </button>
      {open && <StepList steps={steps} runId={run.id} progress={plan} />}
    </div>
  );
}

/** At the bottom of a conversation while an agent works on something for it. */
export function LiveWork({ run, showName, onOpenThread }: { run: Run; showName: boolean; onOpenThread?: () => void }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === run.agentId));
  const openDock = useStore((s) => s.openDock);
  const notify = useStore((s) => s.notify);
  // A plan stays in view while the agent works on it, unless you fold it away.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? run.progress.length > 0;
  const events = useRunEvents(run.id);
  const steps = useMemo(() => stepsOf(events), [events]);
  const doing = nowDoing(run, steps);
  const waiting = run.status === 'waiting_approval' || run.status === 'waiting_human';

  async function stop() {
    try {
      await api.post(`/runs/${run.id}/cancel`);
    } catch (err) {
      notify((err as Error).message, 'error');
    }
  }

  return (
    <div className={`live-work ${waiting ? 'waiting' : ''} ${open ? 'open' : ''}`}>
      <button type="button" className="work-toggle live" aria-expanded={open} onClick={() => setOpen(!open)}>
        {showName && agent ? <Avatar member={agent} size={18} /> : <span className={`live-orb ${waiting ? 'waiting' : ''}`} />}
        <span className="live-text">
          {showName && agent && <strong>{agent.name} </strong>}
          <span className={waiting ? '' : 'shimmer'}>
            {doing}
            {waiting ? '' : '…'}
          </span>
          {run.progress.length > 0 && <span className="faint"> · {progressCount(run.progress)}</span>}
          {run.threadId && onOpenThread && <span className="faint"> · in a thread</span>}
        </span>
        <ChevronRight size={14} className="chev" />
      </button>
      {open && (
        <StepList steps={steps} runId={run.id} progress={run.progress} live={run.status === 'running'}>
          {run.threadId && onOpenThread && (
            <button type="button" className="link-btn" onClick={onOpenThread}>
              Open thread
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => openDock(run.agentId)}>
            <Monitor size={12} /> Watch its computer
          </button>
          <button type="button" className="link-btn danger" onClick={() => void stop()}>
            <Square size={11} /> Stop
          </button>
        </StepList>
      )}
    </div>
  );
}
