// One agent asking another for something (ask_agent), and the answer finding its way back.
//
// The request is posted in the two agents' DM, where people can read it, and recorded as a handoff. The asked agent's
// next reply in that DM is its answer. Instead of waking the asker in the DM, where it would have no idea who wanted
// the work, the answer goes back to the conversation the asking run worked in, together with the answers to anything
// else that run asked, once none of them is still open. A request that ends without an answer (the run failed, was
// stopped or ended silently, or the agent left the team) is reported the same way, so work handed on is never just
// dropped.
import type { Agent, Channel, Handoff, Message, Run } from '@teambot/shared';
import type { App } from '../app.js';
import type { Actor } from '../workspace.js';

export interface HandoffRequest {
  task: string;
  context?: string;
  constraints?: string;
  expectedResult: string;
  attachments?: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Budget reasons are written for the agent itself ("my daily budget"); these are about a teammate. */
const theirs = (reason: string) => reason.replace(/^my /, 'its ');

export class Handoffs {
  constructor(private app: App) {}

  /** Teammates this run has handed work to: its ask_agent requests, plus agents it @mentioned in group chats. */
  used(run: Run): number {
    const { store } = this.app;
    return store.listHandoffs({ runId: run.id }).length + this.mentioned(run).size;
  }

  /** Agents this run woke by @mentioning them in a group chat. */
  mentioned(run: Run): Set<string> {
    const { store } = this.app;
    const ids = new Set<string>();
    for (const m of store.listMessagesByRun(run.id)) {
      if (store.getChannel(m.channelId)?.kind !== 'channel') continue;
      for (const id of m.mentions) if (id !== run.agentId && store.getAgent(id)) ids.add(id);
    }
    return ids;
  }

  /** Why this run can't hand `extra` more teammates work, if it can't. */
  overLimit(run: Run, extra = 1): string | null {
    const { cfg } = this.app;
    if (run.depth + 1 > cfg.maxAgentDepth) {
      return `This job has already been passed between agents ${run.depth} times, the most allowed without a person. Do the rest yourself, or ask a person.`;
    }
    const used = this.used(run);
    if (used + extra > cfg.maxHandoffsPerRun) {
      return `You have already handed work to ${used} teammate${used === 1 ? '' : 's'} in this job, and the limit is ${cfg.maxHandoffsPerRun}. Do the rest yourself, or wait for their answers.`;
    }
    return null;
  }

  /** Why `from` can't ask `to` for something from this run, if it can't. */
  refusal(run: Run, from: Agent, to: Agent): string | null {
    const { store, budgets } = this.app;
    if (to.id === from.id) return "You can't ask yourself.";
    const dm = store.findDm(from.id, to.id);
    if (dm && store.listHandoffs({ fromAgentId: to.id, toAgentId: from.id, channelId: dm.id, statuses: ['open'] }).length) {
      return `${to.name} is waiting for your answer. If you need something from them first, say so in your reply instead.`;
    }
    if (to.paused) return `${to.name} is paused by a person, so it can't take work right now. Do it yourself, or tell the person.`;
    const over = budgets.blocked(to);
    if (over) return `${to.name} has reached ${theirs(over)}, so it can't take work until that resets. Do it yourself, or tell the person.`;
    return this.overLimit(run);
  }

  /** Post the request in the two agents' DM and hand it to `to`, remembering where the answer goes. */
  request(run: Run, from: Agent, to: Agent, req: HandoffRequest): Handoff {
    const { store, workspace, bus } = this.app;
    const dm = workspace.getOrCreateDm(from.id, to.id);
    const text = [
      `**Task:** ${req.task}`,
      req.context && `**Context:** ${req.context}`,
      req.constraints && `**Constraints:** ${req.constraints}`,
      `**A good answer:** ${req.expectedResult}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const actor: Actor = { id: from.id, depth: run.depth, initiator: run.initiator, runId: run.id };
    // Delivered below, with a record of where the answer goes, rather than by ordinary routing.
    const message = workspace.postMessage({ channelId: dm.id, authorId: from.id, text, attachments: req.attachments, actor, route: false });
    const handoff = store.tx(() => {
      store.addInbox({
        agentId: to.id,
        kind: 'message',
        // The request comes last, as in any inbox message, so the run's recent-conversation context doesn't repeat it.
        text:
          `${workspace.channelLabel(dm, to.id)} — ${from.name} (agent) asked you for this. Your final reply is your answer and goes straight back to ${from.name}, so make it complete: ` +
          `the result, sources and file paths, and anything you couldn't do. Don't reply [silent]; if you need something from ${from.name} first, say so in your reply.\n${workspace.messageBody(message)}`,
        channelId: dm.id,
        depth: message.depth,
        initiator: run.initiator,
        readOnly: run.readOnly,
      });
      return store.createHandoff({
        runId: run.id,
        fromAgentId: from.id,
        toAgentId: to.id,
        channelId: dm.id,
        originChannelId: run.channelId,
        originThreadId: run.threadId,
        depth: message.depth,
        initiator: run.initiator,
        readOnly: run.readOnly,
        task: clip(req.task, 300),
      });
    });
    bus.emit('handoff.requested', { agentId: from.id, runId: run.id, channelId: run.channelId }, { handoff });
    this.app.runtime.poke();
    return handoff;
  }

  /**
   * An agent's reply in its DM with an agent that asked it something is the answer. Returns the askers it answered,
   * so routing doesn't also wake them in the DM.
   */
  answer(message: Message, channel: Channel): Set<string> {
    const { store, bus, workspace } = this.app;
    const askers = new Set<string>();
    if (channel.kind !== 'dm' || !store.getAgent(message.authorId)) return askers;
    const held = store.listHandoffs({ toAgentId: message.authorId, channelId: channel.id, statuses: ['open', 'cancelled'] });
    for (const h of held) {
      if (h.status === 'cancelled') {
        // The asking run was stopped, so nobody is waiting: the reply stays in the DM and wakes no one.
        if (h.delivered) continue;
        askers.add(h.fromAgentId);
        store.markHandoffsDelivered([h.id]);
        continue;
      }
      askers.add(h.fromAgentId);
      store.settleHandoff(h.id, 'answered', workspace.messageBody(message), message.depth);
      bus.emit('handoff.answered', { agentId: h.fromAgentId, runId: h.runId, channelId: h.originChannelId }, { handoff: store.getHandoff(h.id) });
      this.deliver(h.runId);
    }
    return askers;
  }

  /** A run ended (completed, failed or cancelled): requests it held without answering fail, and if it was stopped, so do its own. */
  settle(run: Run) {
    const { store, cfg, bus } = this.app;
    const open = run.channelId ? store.listHandoffs({ toAgentId: run.agentId, channelId: run.channelId, statuses: ['open'] }) : [];
    if (open.length) {
      let why: string | null = null;
      if (run.status === 'failed') why = `their run failed${run.error ? ` (${clip(run.error, 300)})` : ''}`;
      else if (run.status === 'cancelled') why = 'a person stopped their run';
      else {
        // Not finished with it yet: it asked a teammate for this conversation and answers once they reply, or more for
        // this conversation is already queued.
        const waiting = store.listHandoffs({ fromAgentId: run.agentId, statuses: ['open'] }).some((h) => h.originChannelId === run.channelId);
        const queued = store.pendingInbox(run.agentId).some((i) => i.channelId === run.channelId);
        if (!waiting && !queued) why = run.steps >= cfg.maxStepsPerRun ? 'they stopped at the step limit before answering' : 'they finished without replying';
      }
      if (why) for (const h of open) this.fail(h, why);
    }
    if (run.status === 'failed' || run.status === 'cancelled') {
      for (const h of store.listHandoffs({ runId: run.id, statuses: ['open'] })) {
        store.settleHandoff(h.id, 'cancelled', run.status === 'failed' ? 'the asking run failed' : 'the asking run was stopped');
        bus.emit('handoff.cancelled', { agentId: h.fromAgentId, runId: h.runId, channelId: h.originChannelId }, { handoff: store.getHandoff(h.id) });
      }
    }
  }

  /** The asked agent ran out of budget while working on a request: tell the asker once, and keep waiting for the answer. */
  delayed(run: Run, reason: string) {
    const { store, workspace } = this.app;
    if (!run.channelId) return;
    for (const h of store.listHandoffs({ toAgentId: run.agentId, channelId: run.channelId, statuses: ['open'] })) {
      if (h.delayNoted) continue;
      store.markHandoffDelayNoted(h.id);
      const origin = this.origin(h);
      store.addInbox({
        agentId: h.fromAgentId,
        kind: 'system',
        text: `${workspace.memberName(h.toAgentId)} has reached ${theirs(reason)} while working on what you asked ("${clip(h.task, 160)}"). Its answer will come once the budget resets or is raised. Tell the person if they are waiting on it.`,
        channelId: origin.channelId,
        threadId: origin.threadId,
        depth: h.depth,
        initiator: h.initiator,
        readOnly: h.readOnly,
      });
    }
    this.app.runtime.poke();
  }

  /** An agent is leaving the team: what it was asked fails, and what it asked has nobody left to use it. */
  removed(agent: Agent) {
    const { store } = this.app;
    for (const h of store.listHandoffs({ toAgentId: agent.id, statuses: ['open'] })) this.fail(h, 'they were removed from the team');
    for (const h of store.listHandoffs({ fromAgentId: agent.id, statuses: ['open'] })) store.settleHandoff(h.id, 'cancelled', 'the asking agent was removed');
  }

  private fail(h: Handoff, why: string) {
    const { store, bus } = this.app;
    store.settleHandoff(h.id, 'failed', why);
    bus.emit('handoff.failed', { agentId: h.fromAgentId, runId: h.runId, channelId: h.originChannelId }, { handoff: store.getHandoff(h.id) });
    this.deliver(h.runId);
  }

  /** Where the asker hears back: the conversation it asked from, or its chat with the owner if that is gone. */
  private origin(h: Handoff): { channelId: string | null; threadId: string | null } {
    const channel = h.originChannelId ? this.app.store.getChannel(h.originChannelId) : undefined;
    return channel ? { channelId: channel.id, threadId: h.originThreadId } : { channelId: null, threadId: null };
  }

  /** Once nothing a run asked is still open, its answers (and non-answers) go back where it asked, in one message. */
  private deliver(runId: string) {
    const { store, workspace } = this.app;
    const all = store.listHandoffs({ runId });
    if (all.some((h) => h.status === 'open')) return;
    const ready = all.filter((h) => !h.delivered && (h.status === 'answered' || h.status === 'failed'));
    if (!ready.length) return;
    const first = ready[0];
    if (!store.getAgent(first.fromAgentId)) {
      store.markHandoffsDelivered(ready.map((h) => h.id));
      return;
    }
    const parts = ready.map((h) => {
      const who = workspace.memberName(h.toAgentId);
      const asked = `what you asked ("${clip(h.task, 160)}")`;
      return h.status === 'answered'
        ? `${who} answered ${asked}:\n${h.outcome}`
        : `${who} didn't answer ${asked}: ${h.outcome}. Do that part yourself if you can, or say plainly that it didn't come back.`;
    });
    const origin = this.origin(first);
    store.tx(() => {
      store.addInbox({
        agentId: first.fromAgentId,
        kind: 'message',
        text: parts.join('\n\n'),
        channelId: origin.channelId,
        threadId: origin.threadId,
        depth: Math.max(...ready.map((h) => h.answerDepth ?? h.depth)),
        initiator: first.initiator,
        readOnly: first.readOnly,
      });
      store.markHandoffsDelivered(ready.map((h) => h.id));
    });
    this.app.runtime.poke();
  }
}
