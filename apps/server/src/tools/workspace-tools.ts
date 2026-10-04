// Team tools: talking to people and agents, showing your progress, and asking a human.
import { z } from 'zod';
import { PROGRESS_STATUSES, PROGRESS_TOOL, type ProgressStatus } from '@teambot/shared';
import { markMissingFiles } from '../shared-files.js';
import { parseMentions } from '../util.js';
import type { Actor } from '../workspace.js';
import { defineTool, type ToolContext, type ToolDef } from './types.js';

const actorOf = (ctx: ToolContext): Actor => ({ id: ctx.agent.id, depth: ctx.run.depth, initiator: ctx.run.initiator, runId: ctx.run.id });

const Attachments = z.array(z.string()).max(20).optional().describe('Files in /shared to attach, e.g. ["/shared/report.pdf"]');

export function workspaceTools(): ToolDef[] {
  return [
    defineTool({
      name: 'post_message',
      description:
        'Post a message in a channel such as "#general". Mention a teammate with @Name only when you need them to act — a mention wakes them up and hands them your message. Ask another agent to help only when its stated specialty fits the task; do routine work yourself.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        channel: z.string().describe('Channel name, e.g. "#launch"'),
        text: z.string().min(1).describe('The message (Markdown)'),
        attachments: Attachments,
      }),
      summarize: (a) => `Post in ${a.channel}`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const named = a.channel.trim().startsWith('@') ? ws.findMember(a.channel) : undefined;
        if (named?.kind === 'agent' && named.id !== ctx.agent.id) throw new Error(`To hand ${named.name} work, use ask_agent.`);
        const channel = ws.resolveChannel(a.channel, ctx.agent.id);
        if (channel.kind === 'dm' && channel.memberIds.some((id) => id !== ctx.agent.id && ctx.app.store.getAgent(id))) {
          throw new Error('That is a DM with another agent. To hand an agent work, use ask_agent.');
        }
        // Mentioning an agent in a group chat wakes it, so it counts toward the teammates this job may hand work to.
        if (channel.kind === 'channel') {
          const already = ctx.app.handoffs.mentioned(ctx.run);
          const agents = new Set(
            parseMentions(a.text)
              .map((n) => ws.findMember(n))
              .filter((m) => m?.kind === 'agent' && m.id !== ctx.agent.id && !already.has(m.id))
              .map((m) => m!.id),
          );
          const refusal = agents.size ? ctx.app.handoffs.overLimit(ctx.run, agents.size) : null;
          if (refusal) throw new Error(refusal);
        }
        ws.postMessage({ channelId: channel.id, authorId: ctx.agent.id, text: a.text, attachments: a.attachments, actor: actorOf(ctx) });
        return `Posted in ${ws.channelLabel(channel, ctx.agent.id)}.`;
      },
    }),

    defineTool({
      name: 'send_dm',
      description: 'Send a direct message to a person on the team. The recipient is always notified. To hand a teammate agent work, use ask_agent instead.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        to: z.string().describe("The person's name"),
        text: z.string().min(1),
        attachments: Attachments,
      }),
      summarize: (a) => `DM ${a.to}`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const to = ws.findMember(a.to);
        if (!to) throw new Error(`No teammate named "${a.to}"`);
        if (to.id === ctx.agent.id) throw new Error('You cannot DM yourself');
        if (to.kind === 'agent') throw new Error(`${to.name} is an agent. To hand it work, use ask_agent: it takes the task, the context, any constraints and what a good answer looks like, and brings the answer back here.`);
        const channel = ws.getOrCreateDm(ctx.agent.id, to.id);
        ws.postMessage({ channelId: channel.id, authorId: ctx.agent.id, text: a.text, attachments: a.attachments, actor: actorOf(ctx) });
        return `Sent to ${to.name}.`;
      },
    }),

    defineTool({
      name: 'ask_agent',
      description:
        "Hand a teammate agent a piece of work and get its answer back in this conversation. Use it only when the teammate's stated specialty fits; do routine research and execution yourself. They can't see your conversation, so give them everything they need.",
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        to: z.string().describe('The teammate agent\'s name, e.g. "Analyst"'),
        task: z.string().trim().min(1).max(4000).describe('What you need done, in a sentence or two'),
        context: z
          .string()
          .trim()
          .max(8000)
          .optional()
          .describe("What they need to know and can't see: what you have found so far, links, file paths, who it is for"),
        constraints: z.string().trim().max(2000).optional().describe('Limits to respect, e.g. sources to use or avoid, scope, length, a deadline'),
        expected_result: z.string().trim().min(1).max(2000).describe('What a good answer looks like: its form, how much detail, and what it must include'),
        attachments: Attachments,
      }),
      summarize: (a) => `Ask ${a.to}: ${a.task.length > 120 ? `${a.task.slice(0, 119)}…` : a.task}`,
      async execute(a, ctx) {
        const { workspace: ws, store, handoffs } = ctx.app;
        const to = ws.findMember(a.to);
        if (!to) throw new Error(`No teammate named "${a.to}"`);
        if (to.kind !== 'agent') throw new Error(`${to.name} is a person. To message them, use send_dm.`);
        const refusal = handoffs.refusal(ctx.run, ctx.agent, to);
        if (refusal) throw new Error(refusal);
        handoffs.request(ctx.run, ctx.agent, to, { task: a.task, context: a.context, constraints: a.constraints, expectedResult: a.expected_result, attachments: a.attachments });
        const where = ctx.run.channelId ? store.getChannel(ctx.run.channelId) : undefined;
        const forAgent = where?.kind === 'dm' && where.memberIds.some((id) => id !== ctx.agent.id && store.getAgent(id));
        return `Asked ${to.name}. Their answer comes back to you in this conversation, together with any other answers you are waiting for. Carry on with anything that doesn't depend on it; if nothing does, end your turn now ${forAgent ? 'with exactly [silent]: you answer once you have what you need.' : 'with a one-line note saying who you asked and what for.'}`;
      },
    }),

    defineTool({
      name: 'read_channel',
      description: 'Read the most recent messages in a channel or DM: "#name", "@Name" for your DM with someone, or a conversation as search results name it ("DM with Ann").',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        channel: z.string(),
        limit: z.number().int().min(1).max(100).optional().describe('How many messages (default 20)'),
      }),
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const channel = ws.resolveChannel(a.channel, ctx.agent.id);
        if (!ws.canSeeFrom(channel, ctx.agent.id, ctx.run.channelId)) {
          return `${ws.channelLabel(channel, ctx.agent.id)} is private to people who aren't all in this conversation, so you can't read it from here.`;
        }
        const messages = ctx.app.store.listMessages(channel.id, { limit: a.limit ?? 20 });
        if (!messages.length) return `${ws.channelLabel(channel, ctx.agent.id)} has no messages yet.`;
        const lines = [
          `Last ${messages.length} messages in ${ws.channelLabel(channel, ctx.agent.id)} (oldest first):`,
          ...messages.map((m) => `[${m.createdAt.slice(0, 16).replace('T', ' ')}] ${ws.memberName(m.authorId)}${m.threadId ? ' (thread reply)' : ''}: ${ws.messageBody(m)}`),
        ];
        return markMissingFiles(ctx.app.cfg.sharedDir, lines.join('\n'));
      },
    }),

    defineTool({
      name: PROGRESS_TOOL,
      description:
        'Lay out your plan for the job in front of you as a checklist, and keep it current as you work: send the whole list each time, with the step you are on in_progress and finished steps done. Add, drop or reword steps as you learn more. The person you work for follows your work through it. Skip it for quick answers.',
      risk: 'internal',
      readOnlyOk: true, // the checklist belongs to this run; it changes nothing else
      schema: z.object({
        steps: z
          .array(
            z.object({
              text: z.string().trim().min(1).max(200).describe('One step, e.g. "Compare the three pricing pages"'),
              status: z.enum(PROGRESS_STATUSES as [ProgressStatus, ...ProgressStatus[]]),
            }),
          )
          .min(1)
          .max(30),
      }),
      summarize: (a) => a.steps.find((s) => s.status === 'in_progress')?.text ?? 'Update progress',
      async execute(a, ctx) {
        const run = ctx.app.store.updateRun(ctx.run.id, { progress: a.steps });
        ctx.app.bus.emit('run.progress', { agentId: run.agentId, runId: run.id, channelId: run.channelId }, { run });
        return `Progress saved: ${a.steps.filter((s) => s.status === 'done').length} of ${a.steps.length} steps done.`;
      },
    }),

    defineTool({
      name: 'ask_for_approval',
      description:
        'Ask a human to approve something before you do it (e.g. sending an email to a customer, spending money, deleting data). You are paused until they answer; the result tells you whether it was approved.',
      risk: 'internal',
      schema: z.object({
        action: z.string().min(1).describe('Exactly what you want to do, in one sentence'),
        details: z.string().optional().describe('Anything the human needs to decide: recipients, amounts, the draft text, links'),
      }),
      summarize: (a) => a.action,
      async execute(a) {
        return `Approved: ${a.action}`;
      },
    }),

    defineTool({
      name: 'request_human_takeover',
      description:
        'Ask a human to take control of your computer, e.g. to sign in, enter a 2FA code or solve a CAPTCHA. You are paused until they hand it back.',
      risk: 'internal',
      schema: z.object({
        reason: z.string().min(1).describe('What you need the human to do, and on which site'),
      }),
      summarize: (a) => a.reason,
      async execute() {
        return 'The human handed the computer back.';
      },
    }),
  ];
}

/** Tools whose approval flow is decided by the tool itself, not the policy. */
export const FORCED_APPROVAL_TOOLS: Record<string, 'approval' | 'takeover'> = {
  ask_for_approval: 'approval',
  request_human_takeover: 'takeover',
};
