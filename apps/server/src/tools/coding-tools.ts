// Coding-agent adapter: an agent hands a programming task to Claude Code, Codex or Gemini CLI, which runs
// headless on the agent's own computer (installed in the computer image) and works in the folder given.
// Each CLI uses its own API key from TeamBot secrets; the key goes to the process environment only.
import crypto from 'node:crypto';
import { z } from 'zod';
import type { App } from '../app.js';
import { defineTool, type ToolDef } from './types.js';

interface CodingAgent {
  label: string;
  /** Secrets passed through as environment variables when they exist. */
  env: string[];
  /** At least one of these must exist for the agent to be offered. */
  needs: string[];
  command: (taskFile: string) => string;
}

export const CODING_AGENTS: Record<string, CodingAgent> = {
  'claude-code': {
    label: 'Claude Code',
    env: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'],
    needs: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    command: (f) => `claude -p "$(cat ${f})" --output-format text --dangerously-skip-permissions`,
  },
  codex: {
    label: 'Codex',
    env: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
    needs: ['OPENAI_API_KEY'],
    command: (f) => `codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "$(cat ${f})"`,
  },
  gemini: {
    label: 'Gemini CLI',
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    needs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    command: (f) => `gemini --yolo -p "$(cat ${f})"`,
  },
};

/** The coding agents whose keys are stored, so they can actually run. */
export function availableCodingAgents(app: App): string[] {
  const names = new Set(app.vault.agentNames());
  return Object.entries(CODING_AGENTS)
    .filter(([, a]) => a.needs.some((n) => names.has(n)))
    .map(([id]) => id);
}


export function codingTools(): ToolDef[] {
  return [
    defineTool({
      name: 'run_coding_agent',
      description:
        'Hand a programming task to a coding agent (Claude Code, Codex or Gemini CLI) that runs on your computer, reads and edits the code in a folder, runs commands and tests, and reports back. Use it for real code changes: give a precise task with what done looks like. It can take many minutes.',
      risk: 'write',
      // Its report is written by another model that read files and ran commands.
      untrusted: true,
      available: (_agent, app) => availableCodingAgents(app).length > 0,
      schema: z.object({
        agent: z.enum(Object.keys(CODING_AGENTS) as [string, ...string[]]).describe('Which coding agent (only ones with an API key stored will work)'),
        task: z.string().min(10).describe('The task, with context and acceptance criteria'),
        cwd: z.string().optional().describe('Folder with the code (default: your workspace), e.g. /home/agent/workspace/my-app'),
        timeout_minutes: z.number().int().min(1).max(60).optional().describe('Default 20'),
      }),
      summarize: (a) => `${CODING_AGENTS[a.agent]?.label ?? a.agent} in ${a.cwd ?? 'the workspace'}: ${a.task.length > 80 ? `${a.task.slice(0, 80)}…` : a.task}`,
      async execute(a, ctx) {
        const spec = CODING_AGENTS[a.agent];
        const available = availableCodingAgents(ctx.app);
        if (!available.includes(a.agent)) {
          throw new Error(`${spec.label} needs the secret ${spec.needs.join(' or ')} (add it in Settings). Available: ${available.join(', ') || 'none'}`);
        }
        // Keys travel as environment variables of this one process, never in the command line.
        const env = Object.fromEntries(
          spec.env.map((name) => [name, ctx.app.vault.get(name)] as const).filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
        );
        const computer = await ctx.computer();
        const file = `/tmp/teambot-task-${crypto.randomBytes(6).toString('hex')}.md`;
        await computer.call('/fs/write', { path: file, content: a.task }, { signal: ctx.signal });
        const minutes = a.timeout_minutes ?? 20;
        const r = await computer.call<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>(
          '/shell',
          { command: `${spec.command(file)}; code=$?; rm -f ${file}; exit $code`, env, cwd: a.cwd, timeoutSec: minutes * 60 },
          { timeoutMs: (minutes * 60 + 30) * 1000, signal: ctx.signal },
        );
        const head = `${spec.label} ${r.timedOut ? `timed out after ${minutes} minutes` : `finished with exit code ${r.exitCode}`}.`;
        const out = r.stdout.trim();
        const err = r.stderr.trim();
        return [head, out && `--- its report ---\n${out.length > 12_000 ? `…${out.slice(-12_000)}` : out}`, err && r.exitCode !== 0 && `--- errors ---\n${err.slice(-3000)}`]
          .filter(Boolean)
          .join('\n');
      },
    }),
  ];
}
