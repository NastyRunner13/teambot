// Team tools: talking to people and agents, showing your progress, and asking a human.
import { z } from 'zod';
import { PROGRESS_STATUSES, PROGRESS_TOOL, type ProgressStatus } from '@teambot/shared';
import { markMissingFiles } from '../shared-files.js';
import type { Actor } from '../workspace.js';
import { defineTool, type ToolContext, type ToolDef } from './types.js';

const actorOf = (ctx: ToolContext): Actor => ({ id: ctx.agent.id, depth: ctx.run.depth, initiator: ctx.run.initiator, runId: ctx.run.id });

const Attachments = z.array(z.string()).max(20).optional().describe('Files in /shared to attach, e.g. ["/shared/report.pdf"]');

export function workspaceTools(): ToolDef[] {
  return [
    defineTool({
      name: 'post_message',
      description:
        'Post a message in a channel such as "#general". Mention a teammate with @Name only when you need them to act — a mention wakes them up and hands them your message.',
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
        const channel = ws.resolveChannel(a.channel, ctx.agent.id);
        ws.postMessage({ channelId: channel.id, authorId: ctx.agent.id, text: a.text, attachments: a.attachments, actor: actorOf(ctx) });
        return `Posted in ${ws.channelLabel(channel, ctx.agent.id)}.`;
      },
    }),

    defineTool({
      name: 'send_dm',
      description: 'Send a direct message to one teammate (human or agent). The recipient is always notified.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        to: z.string().describe('Teammate name, e.g. "Writer" or the human\'s name'),
        text: z.string().min(1),
        attachments: Attachments,
      }),
      summarize: (a) => `DM ${a.to}`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const to = ws.findMember(a.to);
        if (!to) throw new Error(`No teammate named "${a.to}"`);
        if (to.id === ctx.agent.id) throw new Error('You cannot DM yourself');
        const channel = ws.getOrCreateDm(ctx.agent.id, to.id);
        ws.postMessage({ channelId: channel.id, authorId: ctx.agent.id, text: a.text, attachments: a.attachments, actor: actorOf(ctx) });
        return `Sent to ${to.name}.`;
      },
    }),

    defineTool({
      name: 'read_channel',
      description: 'Read the most recent messages in a channel or DM ("#name" or "@Name").',
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
