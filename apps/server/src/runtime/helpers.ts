// Agents joining and leaving the team, plus completion and cleanup of legacy helpers.
// New helpers cannot be spawned. Existing ones may finish and report to their parent after an upgrade;
// their runs, audit trail and shared budget accounting stay intact.
import { ACTIVE_RUN_STATUSES, type Agent, type Run } from '@teambot/shared';
import type { App } from '../app.js';
import type { Store } from '../store.js';
import { errorMessage } from '../util.js';
import { routineSecret } from './triggers.js';

const AVATARS = ['🦊', '🐙', '🦉', '🐝', '🦄', '🐬', '🦁', '🐢', '🦜', '🐼', '🐧', '🦋'];
const COLORS = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6'];

type NewAgent = Omit<Parameters<Store['createAgent']>[0], 'avatar' | 'color'> & { avatar?: string; color?: string };

/** Agents and humans share one namespace, since both are @mentioned by name. */
export function nameTaken(app: App, name: string): boolean {
  return !!app.store.getAgentByName(name) || app.store.listHumans().some((h) => h.name.toLowerCase() === name.toLowerCase());
}

/** Add a permanent agent to the team and to #general, if it hasn't been deleted. `data` goes on the agent.created event. */
export function addAgent(app: App, input: NewAgent, actorId: string, data: Record<string, unknown> = {}): Agent {
  const { store, bus, workspace } = app;
  const n = store.listAgents().length;
  const agent = store.createAgent({ ...input, avatar: input.avatar || AVATARS[n % AVATARS.length], color: input.color || COLORS[n % COLORS.length] });
  bus.emit('agent.created', { actorId, agentId: agent.id }, { agent, ...data });
  const general = store.getChannelByName('general');
  if (general) workspace.addMember(general.id, agent.id, actorId);
  return agent;
}

/** Remove an agent and everything that belongs only to it. Its helpers go too. */
export async function removeAgent(app: App, agent: Agent, actorId: string | null) {
  const { store, runtime, bus, vault } = app;
  for (const helper of store.listAgents().filter((a) => a.parentId === agent.id)) await removeAgent(app, helper, actorId);
  for (const run of store.listRuns({ agentId: agent.id, statuses: ACTIVE_RUN_STATUSES })) runtime.cancelRun(run.id, actorId ?? agent.id);
  for (const s of store.listSchedules()) if (s.agentId === agent.id) vault.delete(routineSecret(s.id));
  store.deleteAgent(agent.id);
  app.memory.remove(agent.name);
  app.snapshots.removeAll(agent.id);
  await app.egress.close(agent.id);
  bus.emit('agent.deleted', { actorId, agentId: agent.id }, { agentId: agent.id, helper: !!agent.parentId });
  app.cron.reload();
  app.computers.reset(agent.id).catch((err) => console.error(`could not remove computer for ${agent.name}: ${errorMessage(err)}`));
}

export class Helpers {
  constructor(private app: App) {}

  of(parentId: string): Agent[] {
    return this.app.store.listAgents().filter((a) => a.parentId === parentId);
  }

  /** A helper's reply is its result: it goes to the agent that started it, for the conversation it worked in. */
  report(helper: Agent, run: Run, text: string) {
    const { store, bus } = this.app;
    const parent = helper.parentId ? store.getAgent(helper.parentId) : undefined;
    if (!parent) return;
    store.addInbox({
      agentId: parent.id,
      kind: 'helper',
      text: `Your helper ${helper.name} reports:\n${text}`,
      channelId: run.channelId,
      threadId: run.threadId,
      depth: run.depth,
      initiator: run.initiator,
    });
    bus.emit('helper.reported', { agentId: helper.id, runId: run.id, channelId: run.channelId }, { parentId: parent.id, text: text.slice(0, 2000) });
  }

  /** Whether some of this agent's helpers are still at work; their results wait until all of them are done. */
  busy(parentId: string): boolean {
    return this.of(parentId).length > 0;
  }

  /** After a helper's run: once it has nothing left to do it is removed, telling its parent if it never reported. */
  async finish(agentId: string): Promise<boolean> {
    const { store } = this.app;
    const helper = store.getAgent(agentId);
    if (!helper?.parentId) return false;
    if (store.listRuns({ agentId, statuses: ACTIVE_RUN_STATUSES, limit: 1 }).length) return false;
    if (store.pendingInbox(agentId).length) return false;
    const last = store.listRuns({ agentId, limit: 1 })[0];
    if (last && !store.listEvents({ agentId, types: ['helper.reported'], limit: 1 }).length) {
      this.report(helper, last, last.status === 'cancelled' ? '(It was stopped before it finished.)' : '(It finished without a result.)');
    }
    await removeAgent(this.app, helper, null);
    return true;
  }

  /** The parent's work in a conversation was stopped: its helpers there go, and so do results nobody will read. */
  async dismiss(parentId: string, channelId: string | null, actorId: string | null) {
    const { store } = this.app;
    for (const helper of this.of(parentId)) {
      const where = store.pendingInbox(helper.id)[0]?.channelId ?? store.listRuns({ agentId: helper.id, limit: 1 })[0]?.channelId ?? null;
      if (where === channelId) await removeAgent(this.app, helper, actorId);
    }
    store.dropInbox(parentId, 'helper', channelId);
  }

  /** On start: helpers left with nothing to do (TeamBot stopped between their report and their removal). */
  async sweep() {
    for (const a of this.app.store.listAgents()) if (a.parentId) await this.finish(a.id);
  }
}
