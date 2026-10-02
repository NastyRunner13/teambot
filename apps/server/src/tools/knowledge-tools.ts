// What the team knows: skills (written procedures), long-term memory, and search over past work.
import { z } from 'zod';
import { search } from '../search.js';
import { markMissingFiles } from '../shared-files.js';
import { parseSkill } from '../skills.js';
import { defineTool, type ToolDef } from './types.js';

const Scope = z.enum(['me', 'team']).default('me').describe('"me" (default): your own notes. "team": something every agent should know');

export function knowledgeTools(): ToolDef[] {
  return [
    defineTool({
      name: 'use_skill',
      description:
        'Load one of your team skills (a written procedure) by name and follow it. Returns its instructions; supporting files are copied to ~/skills/<name>/ on your computer.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({ name: z.string().min(1).describe('Skill name from the Skills list in your instructions') }),
      summarize: (a) => `Use skill ${a.name}`,
      async execute(a, ctx) {
        const allowed = ctx.app.skills.forAgent(ctx.agent);
        const summary = allowed.find((s) => s.name === a.name.trim().toLowerCase());
        if (!summary) throw new Error(`No skill named "${a.name}". Your skills: ${allowed.map((s) => s.name).join(', ') || 'none'}`);
        const skill = ctx.app.skills.get(summary.name)!;
        const { body } = parseSkill(skill.content);
        let files = '';
        if (skill.files.length) {
          const { files: copy, skipped } = ctx.app.skills.supportFiles(skill.name);
          const computer = await ctx.computer();
          const dir = `/home/agent/skills/${skill.name}`;
          for (const f of copy) await computer.call('/fs/write', { path: `${dir}/${f.path}`, content: f.content }, { signal: ctx.signal });
          files = `\n\n---\nSupporting files are in ${dir}/: ${copy.map((f) => f.path).join(', ') || 'none'}${skipped.length ? ` (not copied, too large or binary: ${skipped.join(', ')})` : ''}. Run scripts with their interpreter, e.g. bash ${dir}/script.sh.`;
        }
        ctx.app.bus.emit('skill.used', { agentId: ctx.agent.id, runId: ctx.run.id }, { name: skill.name });
        return `Skill "${skill.name}": ${skill.description}\n\n${body}${files}`;
      },
    }),

    defineTool({
      name: 'remember',
      description:
        'Save a lasting fact or preference to long-term memory, e.g. "The owner wants reports in British English" or "Staging is at staging.example.com". Not for task progress or secrets.',
      risk: 'internal',
      schema: z.object({ note: z.string().min(3).max(500), scope: Scope }),
      summarize: (a) => `Remember${a.scope === 'team' ? ' for the team' : ''}: ${a.note.length > 80 ? `${a.note.slice(0, 80)}…` : a.note}`,
      async execute(a, ctx) {
        const scope = a.scope === 'team' ? 'team' : 'agent';
        const line = ctx.app.memory.remember(scope, a.note, ctx.agent.name, ctx.agent);
        ctx.app.bus.emit('memory.updated', { actorId: ctx.agent.id, agentId: ctx.agent.id, runId: ctx.run.id }, { scope, agentId: scope === 'agent' ? ctx.agent.id : null, added: line });
        return `Saved to ${scope === 'team' ? 'team' : 'your'} memory: ${line}`;
      },
    }),

    defineTool({
      name: 'forget',
      description: 'Remove outdated notes from long-term memory: every line containing the given text is deleted.',
      risk: 'internal',
      schema: z.object({ text: z.string().min(3).describe('Text that appears in the lines to remove'), scope: Scope }),
      summarize: (a) => `Forget "${a.text}"${a.scope === 'team' ? ' from team memory' : ''}`,
      async execute(a, ctx) {
        const scope = a.scope === 'team' ? 'team' : 'agent';
        const removed = ctx.app.memory.forget(scope, a.text, ctx.agent);
        if (!removed.length) return `Nothing in ${scope === 'team' ? 'team' : 'your'} memory contains "${a.text}".`;
        ctx.app.bus.emit('memory.updated', { actorId: ctx.agent.id, agentId: ctx.agent.id, runId: ctx.run.id }, { scope, agentId: scope === 'agent' ? ctx.agent.id : null, removed });
        return `Removed ${removed.length} line${removed.length === 1 ? '' : 's'}:\n${removed.join('\n')}`;
      },
    }),

    defineTool({
      name: 'search_history',
      description: 'Search past messages in every channel and DM, and the task board. All words must match. Use it to find earlier decisions, links and results.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({
        query: z.string().min(2).describe('Words to find; put "exact phrases" in quotes'),
        limit: z.number().int().min(1).max(30).optional(),
      }),
      summarize: (a) => `Search history for "${a.query}"`,
      async execute(a, ctx) {
        const ws = ctx.app.workspace;
        const r = search(ctx.app, a.query, { limit: a.limit ?? 15, viewerId: ctx.agent.id, workingIn: ctx.run.channelId });
        if (!r.messages.length && !r.tasks.length) return `Nothing found for "${a.query}".`;
        const lines = [
          ...r.messages.map((h) => `[${h.message.createdAt.slice(0, 16).replace('T', ' ')}] ${h.where} — ${ws.memberName(h.message.authorId)}: ${h.snippet}`),
          ...r.tasks.map((h) => `Task ${ws.taskLine(h.task)}\n    ${h.snippet}`),
        ];
        return markMissingFiles(ctx.app.cfg.sharedDir, `Results for "${a.query}" (newest first):\n${lines.join('\n')}`);
      },
    }),
  ];
}
