// Agents joining and leaving the team, and short-lived helpers.
// A helper is an agent another agent starts for one task, so independent pieces of work run in parallel. It
// inherits its parent's model, skills, MCP servers, network allowlist and computer setup; it spends from its
// parent's budget; and it is removed (computer included) once its task is done or cancelled. Its messages,
// runs and audit trail stay.
import { ACTIVE_RUN_STATUSES, type Agent, type Run, type Task } from '@teambot/shared';
import type { App } from '../app.js';
import type { Store } from '../store.js';
import { errorMessage } from '../util.js';
import { routineSecret } from './triggers.js';

export const MAX_HELPERS = 5;
const OPEN_TASK = new Set(['todo', 'in_progress', 'blocked']);

const AVATARS = ['🦊', '🐙', '🦉', '🐝', '🦄', '🐬', '🦁', '🐢', '🦜', '🐼', '🐧', '🦋'];
const COLORS = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6'];

type NewAgent = Omit<Parameters<Store['createAgent']>[0], 'avatar' | 'color'> & { avatar?: string; color?: string };

/** Agents and humans share one namespace, since both are @mentioned by name. */
export function nameTaken(app: App, name: string): boolean {
  return !!app.store.getAgentByName(name) || app.store.listHumans().some((h) => h.name.toLowerCase() === name.toLowerCase());
}

/** Add a permanent agent to the team and to #general. `data` goes on the agent.created event. */
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

  private freeName(parent: Agent): string {
    const base = parent.name.slice(0, 26);
    for (let n = 1; ; n++) {
      const name = `${base}-h${n}`;
      if (!this.app.store.getAgentByName(name)) return name;
    }
  }

  /** Start one helper per task, each with its own task on the board (assigned to it, created by the parent). */
  spawn(parent: Agent, run: Run, specs: { title: string; task: string }[], model?: string): { helper: Agent; task: Task }[] {
    const { store, workspace, bus } = this.app;
    if (parent.parentId) throw new Error('Helpers cannot start helpers of their own.');
    const busy = this.of(parent.id).length;
    if (busy + specs.length > MAX_HELPERS) throw new Error(`At most ${MAX_HELPERS} helpers at once; ${busy} are still working.`);
    const started: { helper: Agent; task: Task }[] = [];
    for (const spec of specs) {
      const helper = store.createAgent({
        name: this.freeName(parent),
        role: `Helper of ${parent.name}`,
        instructions: parent.instructions,
        model: model?.trim() || parent.model,
        avatar: parent.avatar,
        color: parent.color,
        mcpServers: parent.mcpServers,
        skills: parent.skills,
        setupScript: parent.setupScript,
        computerImage: parent.computerImage,
        desktop: parent.desktop,
        network: parent.network,
        parentId: parent.id,
      });
      bus.emit('agent.created', { actorId: parent.id, agentId: helper.id }, { agent: helper, parentId: parent.id });
      if (run.channelId) workspace.addMember(run.channelId, helper.id, parent.id);
      const task = workspace.createTask(
        { title: spec.title, description: spec.task, assigneeId: helper.id, channelId: run.channelId },
        { id: parent.id, depth: run.depth, initiator: run.initiator, runId: run.id },
      );
      started.push({ helper, task });
    }
    return started;
  }

  /** A helper whose work is over (no open task, nothing running or waiting) is removed. */
  async retireIfDone(agentId: string): Promise<boolean> {
    const { store } = this.app;
    const helper = store.getAgent(agentId);
    if (!helper?.parentId) return false;
    if (store.listRuns({ agentId, statuses: ACTIVE_RUN_STATUSES, limit: 1 }).length) return false;
    if (store.pendingInbox(agentId).length) return false;
    if (store.listTasks().some((t) => t.assigneeId === agentId && OPEN_TASK.has(t.status))) return false;
    await removeAgent(this.app, helper, null);
    return true;
  }

  /** Fallback for helpers whose task was closed by someone else while they were idle. */
  async sweep() {
    for (const a of this.app.store.listAgents()) if (a.parentId) await this.retireIfDone(a.id);
  }
}
