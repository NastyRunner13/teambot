// Step-by-step view of one run: the agent's thinking, every tool call with its policy decision and result.
import { Ban, Brain, CheckCircle2, CircleAlert, CirclePause, CirclePlay, Flag, Hand, Loader2, MessageSquareReply, ShieldQuestion, Wallet, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EventRecord, Run } from '@teambot/shared';
import { api } from '../api';
import { timeShort } from '../lib/format';
import { memberName, useStore } from '../store';

interface ToolStep {
  kind: 'tool';
  id: number;
  ts: string;
  callId: string;
  tool: string;
  summary: string;
  action: string;
  rule: string;
  reviewed?: { verdict: string; reason: string };
  finished?: { ok: boolean; ms: number; preview: string; images?: string[] };
}
type Item = ToolStep | { kind: 'event'; e: EventRecord };

export function useRunEvents(runId: string | null) {
  const live = useStore((s) => s.events);
  const [loaded, setLoaded] = useState<{ run: Run; events: EventRecord[] } | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!runId) return;
    let cancelled = false;
    api.get<{ run: Run; events: EventRecord[] }>(`/runs/${runId}`).then((r) => !cancelled && setLoaded(r));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return useMemo(() => {
    if (!runId) return [];
    const seen = new Set<number>();
    const all: EventRecord[] = [];
    for (const e of [...(loaded?.events ?? []), ...live.filter((x) => x.runId === runId)]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      all.push(e);
    }
    return all.sort((a, b) => a.id - b.id);
  }, [runId, loaded, live]);
}

function build(events: EventRecord[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolStep>();
  for (const e of events) {
    const d = e.data as Record<string, any>;
    if (e.type === 'tool.checked') {
      const step: ToolStep = { kind: 'tool', id: e.id, ts: e.ts, callId: d.toolCallId, tool: d.tool, summary: d.summary, action: d.action, rule: d.rule, reviewed: d.reviewed };
      tools.set(d.toolCallId, step);
      items.push(step);
    } else if (e.type === 'tool.finished') {
      const step = tools.get(d.toolCallId);
      if (step) step.finished = { ok: d.ok, ms: d.ms, preview: d.preview, images: d.images };
      else items.push({ kind: 'event', e });
    } else if (e.type === 'tool.started' || e.type === 'tool.reviewed' || e.type === 'run.input' || e.type === 'run.created' || e.type === 'handoff.requested' || e.type === 'message.created') {
      continue;
    } else if (e.type === 'llm.response' && !String(d.text ?? '').trim()) {
      continue;
    } else {
      items.push({ kind: 'event', e });
    }
  }
  return items;
}

const RUN_TEXT: Record<string, string> = {
  'run.started': 'Started working',
  'run.resumed': 'Resumed',
  'run.completed': 'Finished',
  'run.waiting': 'Waiting for a human',
  'run.paused': 'Paused',
  'run.cancelled': 'Cancelled',
  'run.recovered': 'Recovered after a restart',
};

function EventRow({ e }: { e: EventRecord }) {
  const d = e.data as Record<string, any>;
  let icon = <Flag size={13} />;
  let cls = '';
  let text: React.ReactNode = e.type;
  let preview: string | null = null;
  if (e.type === 'llm.response') {
    icon = <Brain size={13} />;
    cls = 'think';
    text = <span className="muted">{d.toolCalls?.length ? 'Thinking' : 'Replied'}</span>;
    preview = d.text;
  } else if (RUN_TEXT[e.type]) {
    icon = e.type === 'run.paused' ? <CirclePause size={13} /> : e.type === 'run.completed' ? <CheckCircle2 size={13} /> : <CirclePlay size={13} />;
    cls = e.type === 'run.completed' ? 'ok' : '';
    text = RUN_TEXT[e.type];
  } else if (e.type === 'run.failed') {
    icon = <CircleAlert size={13} />;
    cls = 'bad';
    text = 'Failed';
    preview = d.error;
  } else if (e.type === 'approval.created') {
    icon = <ShieldQuestion size={13} />;
    cls = 'warn';
    text = d.approval?.kind === 'approval' ? 'Asked for approval' : 'Asked a human to step in';
    preview = d.approval?.summary;
  } else if (e.type === 'approval.resolved') {
    icon = <Hand size={13} />;
    cls = d.approval?.status === 'approved' || d.approval?.status === 'done' ? 'ok' : 'bad';
    text = `Human answered: ${d.approval?.status}`;
    preview = d.approval?.note;
  } else if (e.type === 'handoff.answered') {
    icon = <MessageSquareReply size={13} />;
    cls = 'ok';
    text = `${memberName(d.handoff?.toAgentId)} answered`;
    preview = d.handoff?.task;
  } else if (e.type === 'handoff.failed') {
    icon = <CircleAlert size={13} />;
    cls = 'bad';
    text = `No answer from ${memberName(d.handoff?.toAgentId)}`;
    preview = d.handoff?.outcome;
  } else if (e.type === 'handoff.cancelled') {
    text = `Stopped waiting for ${memberName(d.handoff?.toAgentId)}`;
    preview = d.handoff?.task;
  } else if (e.type === 'run.compacted') {
    text = 'Summarized older steps to save context';
  } else if (e.type === 'budget.exceeded') {
    icon = <Wallet size={13} />;
    cls = 'warn';
    text = 'Stopped: budget reached';
    preview = d.reason;
  }
  return (
    <div className="tl-item">
      <div className={`tl-icon ${cls}`}>{icon}</div>
      <div className="tl-text">
        {text}
        <span className="tl-time">{timeShort(e.ts)}</span>
        {preview && <div className="tl-preview">{preview}</div>}
      </div>
    </div>
  );
}

function ToolRow({ s }: { s: ToolStep }) {
  const blocked = s.action === 'deny';
  const gated = s.action === 'ask' || s.action === 'handoff';
  const icon = blocked ? <Ban size={13} /> : !s.finished ? gated ? <ShieldQuestion size={13} /> : <Loader2 size={13} className="spin" /> : <Wrench size={13} />;
  const cls = blocked ? 'bad' : s.finished ? (s.finished.ok ? 'ok' : 'bad') : gated ? 'warn' : '';
  return (
    <div className="tl-item">
      <div className={`tl-icon ${cls}`}>{icon}</div>
      <div className="tl-text">
        <span>{s.summary}</span>
        {s.action !== 'allow' && <span className={`badge ${blocked ? 'danger' : 'warn'}`} style={{ marginLeft: 6 }} title={s.rule}>{s.action}</span>}
        {s.reviewed && s.action === 'allow' && <span className="badge ok" style={{ marginLeft: 6 }} title={`Reviewer: ${s.reviewed.reason}`}>reviewed</span>}
        {s.reviewed && <div className="tl-preview">Reviewer: {s.reviewed.reason}</div>}
        <span className="tl-time">
          {timeShort(s.ts)}
          {s.finished ? ` · ${(s.finished.ms / 1000).toFixed(1)}s` : ''}
        </span>
        {s.finished?.preview && <div className="tl-preview">{s.finished.preview}</div>}
        {s.finished?.images?.map((ref) => (
          <a key={ref} href={`/api/${ref}`} target="_blank" rel="noreferrer" className="tl-shot" title="Open the screenshot">
            <img src={`/api/${ref}`} alt="Screenshot the agent took" loading="lazy" />
          </a>
        ))}
      </div>
    </div>
  );
}

export function RunTimeline({ runId }: { runId: string }) {
  const events = useRunEvents(runId);
  const items = useMemo(() => build(events), [events]);
  if (!items.length) return <div className="small muted">No steps yet.</div>;
  return (
    <div className="timeline">
      {items.map((it) => (it.kind === 'tool' ? <ToolRow key={`t${it.id}`} s={it} /> : <EventRow key={it.e.id} e={it.e} />))}
    </div>
  );
}
