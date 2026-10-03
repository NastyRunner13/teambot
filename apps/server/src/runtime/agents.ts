// Agents joining and leaving the team, for the API and for create_agent alike.
import { ACTIVE_RUN_STATUSES, type Agent } from '@teambot/shared';
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

/** Remove an agent and everything that belongs only to it. */
export async function removeAgent(app: App, agent: Agent, actorId: string | null) {
  const { store, runtime, bus, vault } = app;
  app.handoffs.removed(agent);
  for (const run of store.listRuns({ agentId: agent.id, statuses: ACTIVE_RUN_STATUSES })) runtime.cancelRun(run.id, actorId ?? agent.id);
  for (const s of store.listSchedules()) if (s.agentId === agent.id) vault.delete(routineSecret(s.id));
  store.deleteAgent(agent.id);
  app.memory.remove(agent.name);
  app.snapshots.removeAll(agent.id);
  await app.egress.close(agent.id);
  bus.emit('agent.deleted', { actorId, agentId: agent.id }, { agentId: agent.id });
  app.cron.reload();
  app.computers.reset(agent.id).catch((err) => console.error(`could not remove computer for ${agent.name}: ${errorMessage(err)}`));
}
