// What an agent did for its reply, inside the conversation: one live line while it works, with its latest action as a
// card, then a short note above the reply ("Worked for 2m 14s · 5 steps") that opens to its plan — the checklist it
// kept with update_progress — and its actions as inline tool cards. Every detail is one click away in the panel's
// full log.
import { ChevronRight, CircleAlert, Monitor, Square, X, Check, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { EventRecord, ProgressStep, Run, RunSummary } from '@teambot/shared';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar } from './Avatar';
import { useRunEvents } from './RunTimeline';
import { ToolCard, ToolCards, toolCalls, type ToolCall } from './ToolCard';

interface Outcome {
  key: string;
  text: string;
}

/** Why a run ended other than by finishing: it failed, ran out of budget, or was stopped. */
function outcomesOf(events: EventRecord[]): Outcome[] {
  const out: Outcome[] = [];
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === 'run.failed') out.push({ key: `f${e.id}`, text: d.error ? `Failed: ${d.error}` : 'Failed' });
    else if (e.type === 'budget.exceeded') out.push({ key: `b${e.id}`, text: 'Stopped: its budget is used up' });
    else if (e.type === 'run.cancelled') out.push({ key: `c${e.id}`, text: 'Stopped' });
  }
  return out;
}

/** What the agent is doing this moment, in a few words. */
function nowDoing(run: Run, calls: ToolCall[]): string {
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
  const current = [...calls].reverse().find((c) => c.state === 'running');
  return current ? current.summary : 'Thinking';
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

/** With a plan in view, the actions behind it fold into one line. */
function ActionsToggle({ calls, initiallyOpen }: { calls: ToolCall[]; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="actions-toggle">
      <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={open ? 'rot' : undefined} /> {calls.length} {calls.length === 1 ? 'action' : 'actions'}
      </button>
      {open && <ToolCards calls={calls} />}
    </div>
  );
}

/** The plan, the actions as tool cards, how it ended, and links. `calls` is null while the events load. */
function WorkDetails({ runId, progress, calls, outcomes, live, children }: { runId: string; progress: ProgressStep[]; calls: ToolCall[] | null; outcomes: Outcome[]; live?: boolean; children?: React.ReactNode }) {
  const openRun = useStore((s) => s.openRun);
  return (
    <div className="work-steps">
      {progress.length > 0 && <ProgressList steps={progress} live={live} />}
      {calls === null ? (
        <div className="work-step muted">Loading…</div>
      ) : calls.length ? (
        progress.length ? (
          <ActionsToggle calls={calls} initiallyOpen={!!live} />
        ) : (
          <ToolCards calls={calls} />
        )
      ) : (
        !progress.length && <div className="work-step muted">No actions yet.</div>
      )}
      {outcomes.map((o) => (
        <div key={o.key} className="work-step failed">
          <span className="work-step-icon">
            <X size={12} />
          </span>
          <span className="work-step-text">{o.text}</span>
        </div>
      ))}
      <div className="work-links">
        <button type="button" className="link-btn" onClick={() => openRun(runId)}>
          Full log <ChevronRight size={12} />
        </button>
        {children}
      </div>
    </div>
  );
}

/** Above an agent's reply: how long it worked, and its plan and actions. Actions load when opened. */
export function WorkNote({ run }: { run: RunSummary }) {
  const [open, setOpen] = useState(false);
  const plan = run.progress;
  const events = useRunEvents(open ? run.id : null);
  const calls = useMemo(() => (open && events.length ? toolCalls(events) : null), [open, events]);
  const outcomes = useMemo(() => (open ? outcomesOf(events) : []), [open, events]);
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
      {open && <WorkDetails runId={run.id} progress={plan} calls={calls} outcomes={outcomes} />}
    </div>
  );
}

/** At the bottom of a conversation while an agent works on something for it: what it is doing, and its latest action. */
export function LiveWork({ run, showName, onOpenThread }: { run: Run; showName: boolean; onOpenThread?: () => void }) {
  const agent = useStore((s) => s.agents.find((a) => a.id === run.agentId));
  const openDock = useStore((s) => s.openDock);
  const notify = useStore((s) => s.notify);
  // A plan stays in view while the agent works on it, unless you fold it away.
  const [toggled, setOpen] = useState<boolean | null>(null);
  const open = toggled ?? run.progress.length > 0;
  const events = useRunEvents(run.id);
  const calls = useMemo(() => toolCalls(events), [events]);
  const outcomes = useMemo(() => outcomesOf(events), [events]);
  const doing = nowDoing(run, calls);
  const waiting = run.status === 'waiting_approval' || run.status === 'waiting_human';
  const latest = calls.at(-1);

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
      {!open && latest && (
        <div className="live-latest">
          <ToolCard key={latest.id} call={latest} />
        </div>
      )}
      {open && (
        <WorkDetails runId={run.id} progress={run.progress} calls={calls} outcomes={outcomes} live={run.status === 'running'}>
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
        </WorkDetails>
      )}
    </div>
  );
}
