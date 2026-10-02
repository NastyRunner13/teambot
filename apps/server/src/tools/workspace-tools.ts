// Team tools: talking to people and agents, and working the task board.
import { z } from 'zod';
import { TASK_STATUSES, type TaskStatus } from '@teambot/shared';
import { markMissingFiles } from '../shared-files.js';
import type { Actor } from '../workspace.js';
import { defineTool, type ToolContext, type ToolDef } from './types.js';

const actorOf = (ctx: ToolContext): Actor => ({ id: ctx.agent.id, depth: ctx.run.depth, initiator: ctx.run.initiator, runId: ctx.run.id });

const Attachments = z.array(z.string()).max(20).optional().describe('Files in /shared to attach, e.g. ["/shared/report.pdf"]');

function resolveMemberId(ctx: ToolContext, name: string | undefined | null): string | null | undefined {
  if (name === undefined) return undefined;
  if (name === null || name === '' || name.toLowerCase() === 'nobody' || name.toLowerCase() === 'unassigned') return null;
  if (name.toLowerCase() === 'me') return ctx.agent.id;
  const m = ctx.app.workspace.findMember(name);
  if (!m) {
    const names = [...ctx.app.store.listAgents(), ...ctx.app.store.listHumans()].map((x) => x.name).join(', ');
    throw new Error(`No teammate named "${name}". Team: ${names}`);
  }
  return m.id;
}

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
      name: 'list_tasks',
      description: 'List tasks on the team task board.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        status: z
          .enum(['open', 'all', ...TASK_STATUSES] as [string, ...string[]])
          .optional()
          .describe('"open" (default) = not done or cancelled. Finished tasks are history: ask for them only when someone asks about past work.'),
        assignee: z.string().optional().describe('"me", a teammate name, or omit for everyone'),
      }),
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const status = a.status ?? 'open';
        const assigneeId = a.assignee ? resolveMemberId(ctx, a.assignee) : undefined;
        const tasks = ctx.app.store.listTasks().filter((t) => {
          if (status === 'open' && (t.status === 'done' || t.status === 'cancelled')) return false;
          if (status !== 'open' && status !== 'all' && t.status !== status) return false;
          if (assigneeId !== undefined && t.assigneeId !== assigneeId) return false;
          return true;
        });
        if (!tasks.length) return 'No matching tasks.';
        const list = tasks
          .map((t) => {
            const last = t.notes.at(-1);
            return ws.taskLine(t) + (t.description ? `\n    ${t.description.slice(0, 300)}` : '') + (last ? `\n    latest note (${ws.memberName(last.authorId)}): ${last.text.slice(0, 300)}` : '');
          })
          .join('\n');
        return markMissingFiles(ctx.app.cfg.sharedDir, list);
      },
    }),

    defineTool({
      name: 'create_task',
      description:
        'Create a task on the team board, optionally assigned to a teammate (who is notified) and depending on other tasks (the assignee is told when they are done).',
      risk: 'internal',
      schema: z.object({
        title: z.string().min(1),
        description: z.string().optional().describe('What done looks like, inputs, where to put the output'),
        assignee: z.string().optional().describe('Teammate name, or "me"'),
        depends_on: z.array(z.number().int()).optional().describe('Task numbers that must be done first'),
        channel: z.string().optional().describe('Channel the task belongs to, e.g. "#launch"'),
      }),
      summarize: (a) => `Create task "${a.title}"${a.assignee ? ` for ${a.assignee}` : ''}`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const channelId = a.channel ? ws.resolveChannel(a.channel, ctx.agent.id).id : null;
        const task = ws.createTask(
          {
            title: a.title,
            description: a.description,
            assigneeId: resolveMemberId(ctx, a.assignee) ?? null,
            dependsOn: a.depends_on,
            channelId,
          },
          actorOf(ctx),
        );
        return `Created task #${task.number}: ${ws.taskLine(task)}`;
      },
    }),

    defineTool({
      name: 'update_task',
      description:
        'Update a task: change its status, hand it to someone else (assignee), and/or add a note. Notes are how you report results and blockers.',
      risk: 'internal',
      schema: z.object({
        task: z.number().int().describe('Task number, e.g. 3 for #3'),
        status: z.enum(TASK_STATUSES as [TaskStatus, ...TaskStatus[]]).optional(),
        assignee: z.string().optional().describe('Hand the task to this teammate ("me" to take it)'),
        note: z.string().optional(),
      }),
      summarize: (a) => `Update task #${a.task}`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const task = ws.updateTask(a.task, { status: a.status, assigneeId: resolveMemberId(ctx, a.assignee), note: a.note }, actorOf(ctx));
        return `Updated: ${ws.taskLine(task)}`;
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
