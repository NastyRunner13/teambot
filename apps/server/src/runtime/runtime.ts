// The agent runtime. Each agent works through one run at a time:
//   inbox → model → tool calls → (policy check → maybe wait for a human) → execute → audit → repeat
// The transcript is saved after every step, so runs survive restarts, pauses and approvals.
import { ACTIVE_RUN_STATUSES, type Agent, type AgentStatus, type ApprovalStatus, type InboxItem, type Run } from '@teambot/shared';
import type { App } from '../app.js';
import type { AssistantMessage, ToolCall, ToolMessage, TranscriptMessage } from '../models/types.js';
import type { Decision } from '../policy.js';
import { usableReadOnly, type PolicyFacts, type ToolContext } from '../tools/types.js';
import { FORCED_APPROVAL_TOOLS } from '../tools/workspace-tools.js';
import { errorMessage, truncate, untrusted } from '../util.js';
import { BudgetExceeded, startOfDay } from './budget.js';
import { maybeCompact } from './compaction.js';
import { buildSystemPrompt, formatInbox } from './prompt.js';
import { reviewAction } from './reviewer.js';
import { saveImages, toModelMessages } from './vision.js';

type StopReason = 'pause' | 'cancel' | 'shutdown';
type WaitStatus = 'waiting_approval' | 'waiting_human';
type CallOutcome = { kind: 'result'; content: string; images?: string[] } | { kind: 'wait'; status: WaitStatus };

interface ActiveRun {
  agentId: string;
  controller: AbortController;
  reason?: StopReason;
  done: Promise<void>;
}

const MAX_TOOL_OUTPUT = 16_000;

export function pendingToolCalls(t: TranscriptMessage[]): ToolCall[] {
  for (let i = t.length - 1; i >= 0; i--) {
    const m = t[i];
    if (m.role !== 'assistant') continue;
    if (!m.tool_calls?.length) return [];
    const done = new Set(t.slice(i + 1).filter((x): x is ToolMessage => x.role === 'tool').map((x) => x.tool_call_id));
    return m.tool_calls.filter((c) => !done.has(c.id));
  }
  return [];
}

/** Some providers reuse ids like "call_0" every turn; approvals are keyed by id, so make them unique per run. */
function uniquifyIds(t: TranscriptMessage[], msg: AssistantMessage) {
  if (!msg.tool_calls) return;
  const seen = new Set(t.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])));
  for (const c of msg.tool_calls) {
    let id = c.id.replace(/[^A-Za-z0-9_-]/g, '_') || 'call';
    let n = 1;
    while (seen.has(id)) id = `${c.id}_${++n}`;
    c.id = id;
    seen.add(id);
  }
}

const result = (content: string): CallOutcome => ({ kind: 'result', content });
const wait = (status: WaitStatus): CallOutcome => ({ kind: 'wait', status });
const noteSuffix = (note: string | null) => (note ? ` Their note: "${note}"` : '');

export class Runtime {
  private active = new Map<string, ActiveRun>();
  private timer?: NodeJS.Timeout;
  private dispatching = false;
  private again = false;
  private stopped = false;

  constructor(private app: App) {}

  get pausedAll(): boolean {
    return this.app.store.getSetting('paused_all') === '1';
  }

  start() {
    this.recover();
    this.timer = setInterval(() => this.poke(), 3000);
    this.poke();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const a of this.active.values()) {
      a.reason = 'shutdown';
      a.controller.abort();
    }
    await Promise.race([Promise.allSettled([...this.active.values()].map((a) => a.done)), new Promise((r) => setTimeout(r, 5000))]);
  }

  /** Wait until no run is executing (used by tests and shutdown). */
  async idle(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.active.size) {
        this.poke();
        if (!this.active.size) return;
      }
      await Promise.race([...this.active.values()].map((a) => a.done).concat(new Promise((r) => setTimeout(r, 50)) as Promise<void>));
    }
    throw new Error('runtime did not become idle');
  }

  // ── crash recovery ────────────────────────────────────────────────────

  private recover() {
    const { store, bus } = this.app;
    for (const run of store.listRuns({ statuses: ['running'], limit: 1000 })) {
      this.interruptExecutingCalls(run.id, 'TeamBot restarted while this was running');
      store.updateRun(run.id, { status: 'queued' });
      bus.emit('run.recovered', { agentId: run.agentId, runId: run.id });
    }
    for (const agent of store.listAgents()) this.refreshAgentStatus(agent.id);
  }

  /**
   * A tool that had started when the process died gets an explicit result, never a silent re-run: "interrupted" if
   * it hadn't finished, or what the audit log kept of its output if it finished but its result wasn't saved.
   */
  private interruptExecutingCalls(runId: string, why: string) {
    const { store } = this.app;
    const transcript = store.getTranscript<TranscriptMessage>(runId);
    const pending = pendingToolCalls(transcript);
    if (!pending.length) return;
    const events = store.listEvents({ runId, types: ['tool.started', 'tool.finished'], limit: 500 });
    const started = new Set(events.filter((e) => e.type === 'tool.started').map((e) => String(e.data.toolCallId)));
    const finished = new Map(events.filter((e) => e.type === 'tool.finished').map((e) => [String(e.data.toolCallId), e.data]));
    for (const call of pending) {
      if (!started.has(call.id)) break;
      const done = finished.get(call.id);
      transcript.push({
        role: 'tool',
        tool_call_id: call.id,
        content: done
          ? `This finished (${done.ok ? 'it succeeded' : 'it failed'}), but its full result was lost (${why}). The start of its output:
${untrusted(String(done.tool ?? call.function.name), String(done.preview ?? ''))}
Don't run it again just to see the result; check the current state instead.`
          : `Interrupted: ${why}. It may or may not have taken effect — check the current state before retrying.`,
      });
    }
    store.setTranscript(runId, transcript);
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  poke() {
    if (this.stopped) return;
    if (this.dispatching) {
      this.again = true;
      return;
    }
    this.dispatching = true;
    try {
      do {
        this.again = false;
        this.dispatch();
      } while (this.again);
    } catch (err) {
      console.error('dispatch failed', err);
    } finally {
      this.dispatching = false;
    }
  }

  private runningFor(agentId: string) {
    for (const a of this.active.values()) if (a.agentId === agentId) return true;
    return false;
  }

  private dispatch() {
    if (this.pausedAll) return;
    const { store, bus } = this.app;
    for (const agent of store.listAgents()) {
      if (this.active.size >= this.app.cfg.maxConcurrentRuns) return;
      if (agent.paused || agent.takeoverBy || this.runningFor(agent.id)) continue;
      // Budgets reset with the clock, so an over-budget agent is re-checked on every tick.
      if (agent.status === 'over_budget') this.refreshAgentStatus(agent.id);

      const current = store.listRuns({ agentId: agent.id, statuses: ACTIVE_RUN_STATUSES, limit: 1 })[0];
      if (current) {
        if ((current.status === 'queued' || current.status === 'running') && !this.app.budgets.blocked(agent)) this.launch(current);
        continue; // waiting on a human, paused, or out of budget
      }
      const pending = store.pendingInbox(agent.id);
      if (!pending.length || this.app.budgets.blocked(agent)) continue;
      const first = pending[0];
      const run = store.createRun({
        agentId: agent.id,
        channelId: first.channelId ?? this.app.workspace.getOrCreateDm(this.app.workspace.owner().id, agent.id).id,
        threadId: first.channelId ? first.threadId : null,
        initiator: first.initiator,
        readOnly: first.readOnly,
        depth: first.depth,
        title: titleFor(first),
      });
      bus.emit('run.created', { agentId: agent.id, runId: run.id, channelId: run.channelId }, { run });
      this.launch(run);
    }
  }

  private launch(run: Run) {
    const entry: ActiveRun = { agentId: run.agentId, controller: new AbortController(), done: Promise.resolve() };
    this.active.set(run.id, entry);
    entry.done = this.execute(run.id, entry).finally(async () => {
      this.active.delete(run.id);
      this.refreshAgentStatus(run.agentId);
      // A helper that has finished its task leaves the team.
      await this.app.helpers.retireIfDone(run.agentId).catch((err) => console.error('could not retire helper', err));
      setImmediate(() => this.poke());
    });
  }

  private async execute(runId: string, entry: ActiveRun) {
    const { store, bus } = this.app;
    const fresh = store.getTranscript(runId).length === 0;
    let run = store.updateRun(runId, { status: 'running', error: null });
    const scope = { agentId: run.agentId, runId, channelId: run.channelId };
    this.refreshAgentStatus(run.agentId);
    bus.emit(fresh ? 'run.started' : 'run.resumed', scope, { run });

    try {
      const outcome = await this.loop(runId, entry.controller.signal);
      run = store.updateRun(runId, { status: outcome });
      bus.emit(outcome === 'completed' ? 'run.completed' : 'run.waiting', scope, { run });
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        // Back to the queue: dispatch launches it again once the budget allows.
        run = store.updateRun(runId, { status: 'queued', error: `Waiting for budget: ${err.message}` });
        bus.emit('budget.exceeded', scope, { run, reason: err.message });
        this.say(run, `⏸️ I've reached ${err.message}. I'll pick this up again when the budget resets (daily budgets reset at midnight UTC) or when it is raised.`, false);
        return;
      }
      if (entry.controller.signal.aborted) {
        const reason = entry.reason ?? 'pause';
        // Aborting only drops the server's side; commands on the computer are stopped and confirmed gone before the
        // run counts as paused or cancelled (a human taking over must not find a command still at work).
        if (reason !== 'shutdown') await this.stopComputerWork(run);
        if (reason === 'cancel') {
          run = store.updateRun(runId, { status: 'cancelled' });
          for (const a of store.cancelPendingApprovals(runId)) bus.emit('approval.resolved', scope, { approval: store.getApproval(a.id) });
          bus.emit('run.cancelled', scope, { run });
        } else if (reason === 'pause') {
          run = store.updateRun(runId, { status: 'paused' });
          bus.emit('run.paused', scope, { run });
        }
        // shutdown: left as "running"; recover() re-queues it on the next start.
        return;
      }
      const message = errorMessage(err);
      run = store.updateRun(runId, { status: 'failed', error: message });
      bus.emit('run.failed', scope, { run, error: message });
      this.say(run, `⚠️ I stopped because of an error: ${message}`, false);
    }
  }

  /**
   * Whether a run may take in an inbox item: the same channel and thread, and the same read-only state. Notes from
   * TeamBot itself about the agent's own computer (a hand-back) go to whichever run comes next.
   */
  private belongsTo(run: Run, item: InboxItem): boolean {
    if (item.readOnly !== run.readOnly) return false;
    if (item.kind === 'system' && !item.channelId) return true;
    const channelId = item.channelId ?? this.app.workspace.getOrCreateDm(this.app.workspace.owner().id, run.agentId).id;
    return channelId === run.channelId && (item.channelId ? item.threadId : null) === run.threadId;
  }

  private async stopComputerWork(run: Run) {
    try {
      await this.app.computers.cancelWork(run.agentId);
    } catch (err) {
      this.app.bus.emit('computer.cancel_failed', { agentId: run.agentId, runId: run.id, channelId: run.channelId }, { error: errorMessage(err) });
    }
  }

  private say(run: Run, text: string, route = true) {
    const channelId = run.channelId ?? this.app.workspace.getOrCreateDm(this.app.workspace.owner().id, run.agentId).id;
    try {
      this.app.workspace.postMessage({
        channelId,
        threadId: run.channelId ? run.threadId : null,
        authorId: run.agentId,
        text,
        actor: { id: run.agentId, depth: run.depth, initiator: run.initiator, runId: run.id },
        route,
      });
    } catch (err) {
      console.error('could not post agent message', err);
    }
  }

  // ── the agent loop ────────────────────────────────────────────────────

  private async loop(runId: string, signal: AbortSignal): Promise<'completed' | WaitStatus> {
    const { store, bus, cfg } = this.app;
    for (;;) {
      signal.throwIfAborted();
      let run = store.getRun(runId)!;
      const agent = store.getAgent(run.agentId);
      if (!agent) throw new Error('this agent was deleted');
      const scope = { agentId: agent.id, runId, channelId: run.channelId };
      let transcript = store.getTranscript<TranscriptMessage>(runId);

      // 1. Finish outstanding tool calls, one at a time.
      const pending = pendingToolCalls(transcript);
      if (pending.length) {
        const call = pending[0];
        const outcome = await this.handleCall(run, agent, call, signal, transcript);
        if (outcome.kind === 'wait') return outcome.status;
        transcript.push({ role: 'tool', tool_call_id: call.id, content: outcome.content, ...(outcome.images?.length ? { images: outcome.images } : {}) });
        store.setTranscript(runId, transcript);
        continue;
      }

      // 2. Take in anything new for this conversation: messages, task updates, routines. Work from other
      // conversations waits for its own run, so a DM is never answered in a channel and read-only stays read-only.
      const items = store.pendingInbox(agent.id).filter((i) => this.belongsTo(run, i));
      if (items.length) {
        const first = transcript.length === 0;
        transcript.push({ role: 'user', content: formatInbox(this.app, agent, items, first) });
        const latest = items[items.length - 1];
        // One transaction: input is never consumed without being in the transcript, or recorded twice.
        run = store.tx(() => {
          store.consumeInbox(
            items.map((i) => i.id),
            runId,
          );
          store.setTranscript(runId, transcript);
          return store.updateRun(runId, {
            depth: Math.max(first ? 0 : run.depth, ...items.map((i) => i.depth)),
            initiator: items.some((i) => i.initiator === 'human') ? 'human' : first ? latest.initiator : run.initiator,
          });
        });
        bus.emit('run.input', scope, { items: items.length });
      }

      // 3. Finished when the last word is the agent's, with no tool calls.
      const last = transcript.at(-1);
      if (!last || (last.role === 'assistant' && !last.tool_calls?.length)) return 'completed';

      // 4. Step budget.
      if (run.steps >= cfg.maxStepsPerRun) {
        this.say(run, `I stopped after ${run.steps} steps (the per-run limit). Tell me to continue if you want me to keep going.`, false);
        return 'completed';
      }

      // 5. Ask the model what to do next, if the budget allows.
      const over = this.app.budgets.blocked(agent);
      if (over) throw new BudgetExceeded(over);
      const compacted = await maybeCompact(this.app, scope, transcript, signal);
      if (compacted !== transcript) {
        transcript = compacted;
        store.setTranscript(runId, transcript);
      }
      const tools = this.app.tools.forAgent(agent).filter((t) => !run.readOnly || usableReadOnly(t));
      const res = await this.app.models.chat({
        model: agent.model,
        messages: [{ role: 'system', content: buildSystemPrompt(this.app, agent, run) }, ...toModelMessages(this.app, transcript)],
        tools: this.app.tools.specs(tools),
        signal,
      });
      const msg = res.message;
      uniquifyIds(transcript, msg);
      transcript.push(msg);
      store.setTranscript(runId, transcript);
      run = store.updateRun(runId, {
        steps: run.steps + 1,
        tokensIn: run.tokensIn + res.usage.inputTokens,
        tokensOut: run.tokensOut + res.usage.outputTokens,
        costUsd: run.costUsd + res.usage.costUsd,
      });
      bus.emit('llm.response', scope, {
        model: res.model,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUsd: res.usage.costUsd,
        toolCalls: msg.tool_calls?.map((c) => c.function.name) ?? [],
        text: (msg.content ?? '').slice(0, 2000),
        step: run.steps,
      });

      if (!msg.tool_calls?.length) {
        const text = (msg.content ?? '').trim();
        if (text && !/^\[silent\]$/i.test(text)) this.say(run, text);
      }
    }
  }

  private async handleCall(run: Run, agent: Agent, call: ToolCall, signal: AbortSignal, transcript: TranscriptMessage[]): Promise<CallOutcome> {
    const { store, bus, vault } = this.app;
    const scope = { agentId: agent.id, runId: run.id, channelId: run.channelId };
    const tool = this.app.tools.find(agent, call.function.name);
    if (!tool) return result(`Error: there is no tool named "${call.function.name}".`);
    if (run.readOnly && !usableReadOnly(tool)) {
      return result(`Blocked: this is a read-only routine, so ${tool.name} is not available. Report what you found instead.`);
    }

    let args: Record<string, unknown>;
    try {
      const raw = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
      args = tool.schema.parse(raw) as Record<string, unknown>;
    } catch (err) {
      const detail = err instanceof SyntaxError ? 'arguments are not valid JSON' : errorMessage(err);
      return result(`Error: invalid arguments for ${tool.name}: ${truncate(detail, 1000)}`);
    }

    const ctx: ToolContext = { app: this.app, agent, run, signal, computer: () => this.app.lifecycle.ready(agent) };
    const redactArgs = (a: Record<string, unknown>) => JSON.parse(vault.redact(JSON.stringify(a))) as Record<string, unknown>;
    const forced = FORCED_APPROVAL_TOOLS[tool.name];

    const prior = store.findApproval(run.id, call.id);
    if (prior) {
      const n = noteSuffix(prior.note);
      switch (prior.status) {
        case 'pending':
          return wait(prior.kind === 'approval' ? 'waiting_approval' : 'waiting_human');
        case 'approved':
          break; // run it below
        case 'denied':
          return result(`A human denied this: ${prior.summary}.${n} Don't retry it; change your plan or ask them what they want.`);
        case 'done':
          return result(
            prior.kind === 'takeover'
              ? `The human finished on your computer and handed it back.${n} Take a fresh browser_snapshot before continuing.`
              : `The human did this step themselves.${n}`,
          );
        case 'declined':
          return result(`The human declined to do this.${n}`);
        case 'cancelled':
          return result('This request was cancelled.');
      }
    } else {
      let facts: PolicyFacts = {};
      let decision: Decision;
      if (forced) {
        decision = { action: forced === 'takeover' ? 'handoff' : 'ask', rule: forced === 'takeover' ? 'agent asked for a takeover' : 'agent asked for approval' };
      } else {
        if (tool.facts) {
          try {
            facts = await tool.facts(args, ctx);
          } catch (err) {
            // Without facts the policy can't judge the action, and the action itself would fail anyway.
            return result(`Error: ${truncate(errorMessage(err), 2000)}`);
          }
        }
        const policy = this.app.policy.policy;
        decision = policy.evaluate({
          tool: tool.name,
          risk: tool.risk,
          agentName: agent.name,
          initiator: run.initiator,
          args,
          ...facts,
          steps: run.steps,
          readOnly: run.readOnly,
          spendToday: policy.usesWhen ? this.app.budgets.spend(startOfDay(), agent.id).usd : 0,
        });
      }
      const summary = tool.summarize?.(args as never, facts) ?? tool.name;
      let reviewed: { verdict: string; reason: string } | undefined;
      if (decision.action === 'review') {
        const review = await reviewAction(this.app, agent, run, transcript, { tool: tool.name, summary, args: redactArgs(args), facts, rule: decision.rule }, signal);
        bus.emit('tool.reviewed', scope, { toolCallId: call.id, tool: tool.name, summary, verdict: review.verdict, reason: review.reason, model: review.model, ...review.usage });
        reviewed = { verdict: review.verdict, reason: review.reason };
        decision = { action: review.verdict, rule: `${decision.rule} — reviewer: ${review.reason}` };
      }
      bus.emit('tool.checked', scope, { toolCallId: call.id, tool: tool.name, summary, action: decision.action, rule: decision.rule, reviewed });

      if (decision.action === 'deny') {
        return result(`Blocked by the policy rule "${decision.rule}". Don't try to work around it; tell a human if it stops your work.`);
      }
      if (decision.action === 'ask' || decision.action === 'handoff') {
        const approval = store.createApproval({
          agentId: agent.id,
          runId: run.id,
          toolCallId: call.id,
          kind: forced === 'takeover' ? 'takeover' : decision.action === 'ask' ? 'approval' : 'handoff',
          tool: tool.name,
          args: redactArgs(args),
          summary,
          reason: decision.rule,
          channelId: run.channelId,
        });
        bus.emit('approval.created', scope, { approval });
        return wait(approval.kind === 'approval' ? 'waiting_approval' : 'waiting_human');
      }
    }

    let resolved: Record<string, unknown>;
    try {
      resolved = vault.resolve(args, { forAgent: true });
    } catch (err) {
      return result(`Error: ${errorMessage(err)}`);
    }

    bus.emit('tool.started', scope, { toolCallId: call.id, tool: tool.name, args: redactArgs(args) });
    const started = Date.now();
    let content: string;
    let images: string[] | undefined;
    let ok = true;
    try {
      const output = await tool.execute(resolved, ctx);
      if (typeof output === 'string') content = output;
      else if (output.images?.length && JSON.stringify(resolved) !== JSON.stringify(args)) {
        // Text output is scrubbed of secrets, but pixels can't be: after an action that used a secret (typing it into
        // a field, say), the screen may show it, so that screenshot isn't kept or shown to the model.
        content = `${output.text}
(The screenshot is withheld because this action used a secret, which may be visible on the screen. Take a new one once the value is hidden.)`;
      } else {
        content = output.text;
        if (output.images?.length) images = saveImages(this.app, run.id, call.id, output.images);
      }
    } catch (err) {
      if (signal.aborted) {
        const interrupted = 'Interrupted before it finished (the run was paused or stopped). It may or may not have taken effect — check before retrying.';
        transcript.push({ role: 'tool', tool_call_id: call.id, content: interrupted });
        store.setTranscript(run.id, transcript);
        bus.emit('tool.finished', scope, { toolCallId: call.id, tool: tool.name, ok: false, ms: Date.now() - started, preview: interrupted });
        throw err;
      }
      ok = false;
      content = `Error: ${errorMessage(err)}`;
    }
    content = truncate(vault.redact(content), MAX_TOOL_OUTPUT);
    bus.emit('tool.finished', scope, { toolCallId: call.id, tool: tool.name, ok, ms: Date.now() - started, preview: content.slice(0, 800), ...(images ? { images } : {}) });
    return { kind: 'result', content: tool.untrusted ? untrusted(tool.name, content) : content, images };
  }

  // ── controls used by the API ──────────────────────────────────────────

  refreshAgentStatus(agentId: string) {
    const { store, bus } = this.app;
    const agent = store.getAgent(agentId);
    if (!agent) return;
    let status: AgentStatus;
    const run = store.listRuns({ agentId, statuses: ACTIVE_RUN_STATUSES, limit: 1 })[0];
    if (agent.paused || agent.takeoverBy || this.pausedAll || run?.status === 'paused') status = 'paused';
    else if (run && run.status !== 'running' && run.status !== 'queued') status = 'waiting';
    else if (this.app.budgets.blocked(agent)) status = 'over_budget';
    else if (!run) status = store.listRuns({ agentId, limit: 1 })[0]?.status === 'failed' ? 'error' : 'idle';
    else status = 'working';
    if (status !== agent.status) {
      store.updateAgent(agentId, { status });
      bus.emit('agent.status', { agentId }, { status });
    }
  }

  private abortAgent(agentId: string, reason: StopReason) {
    for (const a of this.active.values()) {
      if (a.agentId === agentId) {
        a.reason = reason;
        a.controller.abort();
      }
    }
  }

  /** Paused runs go back to the queue unless something still holds them. */
  private requeuePaused(agentId: string) {
    const agent = this.app.store.getAgent(agentId);
    if (!agent || agent.paused || agent.takeoverBy || this.pausedAll) return;
    for (const run of this.app.store.listRuns({ agentId, statuses: ['paused'], limit: 10 })) this.app.store.updateRun(run.id, { status: 'queued' });
  }

  setAgentPaused(agentId: string, paused: boolean, actorId: string) {
    const agent = this.app.store.updateAgent(agentId, { paused });
    this.app.bus.emit(paused ? 'agent.paused' : 'agent.resumed', { actorId, agentId }, { agent });
    if (paused) this.abortAgent(agentId, 'pause');
    else this.requeuePaused(agentId);
    this.refreshAgentStatus(agentId);
    this.poke();
  }

  setPausedAll(paused: boolean, actorId: string) {
    this.app.store.setSetting('paused_all', paused ? '1' : '0');
    this.app.bus.emit(paused ? 'system.paused' : 'system.resumed', { actorId }, {});
    for (const agent of this.app.store.listAgents()) {
      if (paused) this.abortAgent(agent.id, 'pause');
      else this.requeuePaused(agent.id);
      this.refreshAgentStatus(agent.id);
    }
    this.poke();
  }

  cancelRun(runId: string, actorId: string) {
    const { store, bus } = this.app;
    const run = store.getRun(runId);
    if (!run) throw new Error('run not found');
    const active = this.active.get(runId);
    if (active) {
      active.reason = 'cancel';
      active.controller.abort();
      return;
    }
    if (!ACTIVE_RUN_STATUSES.includes(run.status)) return;
    const next = store.updateRun(runId, { status: 'cancelled' });
    const scope = { actorId, agentId: run.agentId, runId };
    for (const a of store.cancelPendingApprovals(runId)) bus.emit('approval.resolved', scope, { approval: store.getApproval(a.id) });
    bus.emit('run.cancelled', scope, { run: next });
    this.refreshAgentStatus(run.agentId);
    this.poke();
  }

  takeover(agentId: string, humanId: string) {
    const agent = this.app.store.updateAgent(agentId, { takeoverBy: humanId });
    this.abortAgent(agentId, 'pause');
    this.app.bus.emit('agent.takeover', { actorId: humanId, agentId }, { agent });
    this.refreshAgentStatus(agentId);
  }

  handBack(agentId: string, humanId: string, note: string | null) {
    const { store, bus } = this.app;
    const agent = store.getAgent(agentId);
    if (!agent?.takeoverBy) return;
    store.updateAgent(agentId, { takeoverBy: null });
    bus.emit('agent.handback', { actorId: humanId, agentId }, { agent: store.getAgent(agentId), note });
    const hasWork = store.listRuns({ agentId, statuses: ACTIVE_RUN_STATUSES, limit: 1 }).length > 0;
    if (hasWork || note) {
      store.addInbox({
        agentId,
        kind: 'system',
        text: `${this.app.workspace.memberName(humanId)} used your computer and handed it back.${noteSuffix(note)} The browser may be on a different page now; take a snapshot before continuing.`,
        channelId: null,
        taskNumber: null,
        depth: 0,
        initiator: 'human',
      });
    }
    this.requeuePaused(agentId);
    this.refreshAgentStatus(agentId);
    this.poke();
  }

  resolveApproval(approvalId: string, decision: 'approve' | 'deny' | 'done' | 'decline', note: string | null, humanId: string) {
    const { store, bus } = this.app;
    const approval = store.getApproval(approvalId);
    if (!approval) throw new Error('approval not found');
    if (approval.status !== 'pending') throw new Error(`already ${approval.status}`);
    const allowed: Record<string, ApprovalStatus> =
      approval.kind === 'approval' ? { approve: 'approved', deny: 'denied' } : { done: 'done', decline: 'declined' };
    const status = allowed[decision];
    if (!status) throw new Error(`"${decision}" is not a valid answer for a ${approval.kind} request`);

    const resolved = store.resolveApproval(approvalId, status, humanId, note?.trim() || null);
    bus.emit('approval.resolved', { actorId: humanId, agentId: approval.agentId, runId: approval.runId }, { approval: resolved });

    const run = store.getRun(approval.runId);
    if (run && (run.status === 'waiting_approval' || run.status === 'waiting_human')) {
      store.updateRun(run.id, { status: 'queued' });
    }
    if (approval.kind === 'takeover' && store.getAgent(approval.agentId)?.takeoverBy) {
      store.updateAgent(approval.agentId, { takeoverBy: null });
      bus.emit('agent.handback', { actorId: humanId, agentId: approval.agentId }, { agent: store.getAgent(approval.agentId), note });
    }
    this.refreshAgentStatus(approval.agentId);
    this.poke();
    return resolved;
  }
}

function titleFor(item: InboxItem): string {
  const lines = item.text.split('\n');
  const line = item.kind === 'message' && lines.length > 1 ? lines.slice(1).join(' ') : lines[0];
  return line.trim().slice(0, 120) || 'Work';
}
