// Growing the team from inside it.
// New agents: an agent proposes a permanent teammate. A human approves it by default (risk `external`), and the
// new agent can't get more than its creator has: the creator's network rules and budget caps, and only skills and
// MCP servers the creator can use. No desktop, setup script or custom image; a human can add those later.
import { z } from 'zod';
import type { Agent } from '@teambot/shared';
import type { App } from '../app.js';
import { addAgent, nameTaken } from '../runtime/agents.js';
import { NAME_RE } from '../util.js';
import { defineTool, type ToolDef } from './types.js';

/** Agents an agent may have added that are still on the team. */
export const MAX_CREATED_AGENTS = 5;

const CreateAgentArgs = z.object({
  name: z.string().trim().regex(NAME_RE, 'Names use letters, numbers, - and _ (max 32), starting with a letter').describe('How teammates @mention it, e.g. Researcher'),
  role: z.string().trim().min(3).max(200).describe('One line, e.g. "Market research on competitors"'),
  instructions: z.string().trim().min(20).max(20_000).describe('Its standing instructions: what it does, how, and what good work looks like'),
  reason: z.string().trim().min(10).max(500).describe('Why the team needs this agent; the human approving it reads this'),
  model: z.string().trim().min(1).optional().describe('OpenRouter model (default: the workspace default)'),
  skills: z.array(z.string().trim().min(1)).max(200).optional().describe('Skills it may use, from yours (default: the same as yours)'),
  mcp_servers: z.array(z.string().trim().min(1)).optional().describe('MCP servers it may use, from yours (default: none)'),
});
type CreateAgentArgs = z.infer<typeof CreateAgentArgs>;

/** Agents this agent added that are still on the team. */
function addedBy(app: App, agent: Agent): Agent[] {
  return app.store
    .listEvents({ types: ['agent.created'], limit: 10_000 })
    .filter((e) => e.actorId === agent.id && e.agentId)
    .map((e) => app.store.getAgent(e.agentId!))
    .filter((a): a is Agent => !!a);
}

/** Why this request can't go ahead, checked before a human is asked and again when it runs. */
function refusal(app: App, agent: Agent, a: CreateAgentArgs): string | null {
  if (nameTaken(app, a.name)) return `The name ${a.name} is taken; pick another.`;
  if (addedBy(app, agent).length >= MAX_CREATED_AGENTS) return `You have already added ${MAX_CREATED_AGENTS} agents who are still on the team; ask a human to add more.`;
  const mine = new Set(app.skills.forAgent(agent).map((s) => s.name));
  const skills = a.skills?.filter((s) => !mine.has(s)) ?? [];
  if (skills.length) return `You can only give skills you have yourself; not yours: ${skills.join(', ')}.`;
  const servers = a.mcp_servers?.filter((s) => !agent.mcpServers.includes(s)) ?? [];
  if (servers.length) return `You can only give MCP servers you have yourself; not yours: ${servers.join(', ')}.`;
  return null;
}

export function agentTools(): ToolDef[] {
  return [
    defineTool({
      name: 'create_agent',
      description: `Propose a new permanent teammate with its own role, instructions and computer, only for an ongoing specialty no existing teammate covers. Do one-off work yourself; do not create agents as temporary helpers or just to parallelize a task. A human usually approves it first. It gets your network rules and budget limits, and only skills and MCP servers you have. It joins #general (if the workspace still has one) and this channel; @mention it to give it work. You can have added at most ${MAX_CREATED_AGENTS} agents still on the team.`,
      risk: 'external',
      schema: CreateAgentArgs,
      // Not facts as such: a request that would fail is refused before a human is asked to approve it.
      async facts(a, ctx) {
        const why = refusal(ctx.app, ctx.agent, a);
        if (why) throw new Error(why);
        return {};
      },
      summarize: (a) => `Add ${a.name} to the team (${a.role}): ${a.reason}`,
      async execute(a, ctx) {
        const { app, agent: creator, run } = ctx;
        const why = refusal(app, creator, a);
        if (why) return `Error: ${why}`;
        const agent = addAgent(
          app,
          {
            name: a.name,
            role: a.role,
            instructions: a.instructions,
            model: a.model || app.cfg.defaultModel,
            mcpServers: a.mcp_servers ?? [],
            skills: a.skills ?? creator.skills,
            network: structuredClone(creator.network),
            budget: { ...creator.budget },
          },
          creator.id,
          { createdBy: creator.id },
        );
        const channel = run.channelId ? app.store.getChannel(run.channelId) : undefined;
        // Never into a DM: that would show a private conversation to a new member.
        if (channel?.kind === 'channel' && !channel.memberIds.includes(agent.id)) app.workspace.addMember(channel.id, agent.id, creator.id);
        return `${agent.name} joined the team (${agent.role}, model ${agent.model}). When a task matches its specialty, ask it with ask_agent.`;
      },
    }),
  ];
}
