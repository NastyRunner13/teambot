// Tools that act inside the agent's own computer: terminal, files and the (watchable) browser.
import { z } from 'zod';
import { defineTool, hostOf, type PolicyFacts, type ToolContext, type ToolDef } from './types.js';

interface Snapshot {
  url: string;
  title: string;
  snapshot: string;
}
interface PageShot {
  image: string;
  mime: string;
  url: string;
  title: string;
  width: number;
  height: number;
  scrollY: number;
  scrollHeight: number;
}
interface Described {
  url: string;
  element: { name: string; type: string; role: string } | null;
}

async function describe(ctx: ToolContext, ref?: number): Promise<PolicyFacts> {
  const c = await ctx.computer();
  const d = await c.call<Described>('/browser/describe', ref === undefined ? {} : { ref }, { timeoutMs: 15_000, signal: ctx.signal });
  return { url: d.url, domain: hostOf(d.url), target: d.element?.name ?? '', fieldType: d.element?.type || undefined };
}

async function browserCall(ctx: ToolContext, path: string, body: Record<string, unknown> = {}): Promise<string> {
  const c = await ctx.computer();
  const s = await c.call<Snapshot>(path, body, { timeoutMs: 90_000, signal: ctx.signal });
  return s.snapshot;
}

const at = (f: PolicyFacts) => (f.domain ? ` on ${f.domain}` : '');

export function computerTools(): ToolDef[] {
  return [
    defineTool({
      name: 'shell',
      description:
        'Run a bash command on your computer (Debian Linux, you are user "agent" with passwordless sudo). Working directory defaults to /home/agent/workspace. Python 3, Node 22, git, curl and jq are installed. For long-running servers, run them in the background and redirect output to a file.',
      risk: 'write',
      untrusted: true,
      schema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeout_seconds: z.number().int().min(1).max(900).optional().describe('Default 120'),
      }),
      summarize: (a) => `Run \`${a.command.length > 120 ? a.command.slice(0, 120) + '…' : a.command}\``,
      async execute(a, ctx) {
        const c = await ctx.computer();
        const r = await c.call<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean }>(
          '/shell',
          { command: a.command, cwd: a.cwd, timeoutSec: a.timeout_seconds ?? 120 },
          { timeoutMs: ((a.timeout_seconds ?? 120) + 15) * 1000, signal: ctx.signal },
        );
        return [
          `exit code: ${r.exitCode ?? 'none'}${r.timedOut ? ' (timed out and was killed)' : ''}${r.truncated ? ' (output truncated)' : ''}`,
          r.stdout && `--- stdout ---\n${r.stdout}`,
          r.stderr && `--- stderr ---\n${r.stderr}`,
        ]
          .filter(Boolean)
          .join('\n');
      },
    }),

    defineTool({
      name: 'read_file',
      description: 'Read a text file from your computer. Relative paths are inside /home/agent/workspace; /shared is the team folder.',
      risk: 'read',
      untrusted: true,
      schema: z.object({ path: z.string().min(1) }),
      async execute(a, ctx) {
        const c = await ctx.computer();
        const r = await c.call<{ path: string; size: number; binary: boolean; content: string; truncated: boolean }>('/fs/read', { path: a.path }, { signal: ctx.signal });
        if (r.binary) return `${r.path} is a binary file (${r.size} bytes).`;
        return `${r.path} (${r.size} bytes)${r.truncated ? ' — showing the beginning' : ''}:\n${r.content}`;
      },
    }),

    defineTool({
      name: 'write_file',
      description: 'Create or overwrite a text file (parent folders are created). Put deliverables for the team in /shared.',
      risk: 'write',
      schema: z.object({
        path: z.string().min(1),
        content: z.string(),
        append: z.boolean().optional(),
      }),
      summarize: (a) => `${a.append ? 'Append to' : 'Write'} ${a.path}`,
      async execute(a, ctx) {
        const c = await ctx.computer();
        const r = await c.call<{ path: string; bytes: number }>('/fs/write', { path: a.path, content: a.content, append: a.append }, { signal: ctx.signal });
        return `Wrote ${r.bytes} bytes to ${r.path}.`;
      },
    }),

    defineTool({
      name: 'list_files',
      description: 'List files in a folder on your computer.',
      risk: 'read',
      schema: z.object({
        path: z.string().optional().describe('Default: your workspace'),
        depth: z.number().int().min(1).max(4).optional(),
      }),
      async execute(a, ctx) {
        const c = await ctx.computer();
        const r = await c.call<{ root: string; entries: { path: string; type: string; size?: number }[]; truncated: boolean }>(
          '/fs/list',
          { path: a.path ?? '', depth: a.depth ?? 1 },
          { signal: ctx.signal },
        );
        if (!r.entries.length) return `${r.root} is empty.`;
        return `${r.root}:\n${r.entries.map((e) => `${e.path}${e.size !== undefined ? `  (${e.size} bytes)` : ''}`).join('\n')}${r.truncated ? '\n… (truncated)' : ''}`;
      },
    }),

    defineTool({
      name: 'browser_navigate',
      description:
        'Open a URL in your browser (humans can watch it live). Returns a snapshot: page text plus numbered interactive elements you can click or type into.',
      risk: 'read',
      untrusted: true,
      schema: z.object({ url: z.string().min(1) }),
      facts: async (a) => ({ url: a.url, domain: hostOf(a.url) }),
      summarize: (a) => `Open ${a.url}`,
      execute: (a, ctx) => browserCall(ctx, '/browser/navigate', { url: a.url }),
    }),

    defineTool({
      name: 'browser_snapshot',
      description: 'Get a fresh snapshot of the current page (text + numbered interactive elements). Element numbers change after every snapshot.',
      risk: 'read',
      untrusted: true,
      schema: z.object({}),
      execute: (_a, ctx) => browserCall(ctx, '/browser/snapshot'),
    }),

    defineTool({
      name: 'browser_screenshot',
      description:
        'See the visible part of the current page as an image. Use it when what you need is drawn rather than written: a chart, a table or text inside an image, a diagram, a layout. Scroll it into view first. To look at an image link or an image file up close, open it with browser_navigate (file:///path for files on your computer) and take a screenshot. Prefer this to installing OCR tools. PDFs open in the browser\'s viewer, where scrolling does not work: to see page N whole, open the PDF\'s URL with #page=N&view=Fit at the end and take a screenshot (if it is already open, open about:blank first, since changing only the # does not move the viewer).',
      risk: 'read',
      untrusted: true,
      returnsImages: true,
      schema: z.object({}),
      facts: async (_a, ctx) => {
        const f = await describe(ctx);
        return { url: f.url, domain: f.domain };
      },
      summarize: (_a, f) => `Take a screenshot of the page${at(f)}`,
      async execute(_a, ctx) {
        const c = await ctx.computer();
        const s = await c.call<PageShot>('/browser/screenshot', {}, { timeoutMs: 60_000, signal: ctx.signal });
        return {
          text: `Screenshot of ${s.title || '(untitled)'} (${s.url}), ${s.width}x${s.height}, scrolled to ${s.scrollY}px of ${s.scrollHeight}px. The image is attached.`,
          images: [{ mime: s.mime, data: s.image }],
        };
      },
    }),

    defineTool({
      name: 'browser_click',
      description: 'Click an element by its number from the latest snapshot.',
      risk: 'write',
      untrusted: true,
      schema: z.object({ ref: z.number().int().min(1) }),
      facts: (a, ctx) => describe(ctx, a.ref),
      summarize: (a, f) => `Click ${f.target ? `"${f.target}"` : `element [${a.ref}]`}${at(f)}`,
      execute: (a, ctx) => browserCall(ctx, '/browser/click', { ref: a.ref }),
    }),

    defineTool({
      name: 'browser_type',
      description:
        'Type into a field by its number from the latest snapshot (replaces existing text unless clear=false). Set submit=true to press Enter afterwards. Use {{secret:NAME}} for stored secrets.',
      risk: 'write',
      untrusted: true,
      schema: z.object({
        ref: z.number().int().min(1),
        text: z.string(),
        submit: z.boolean().optional(),
        clear: z.boolean().optional(),
      }),
      facts: (a, ctx) => describe(ctx, a.ref),
      summarize: (a, f) => `Type "${a.text.length > 60 ? a.text.slice(0, 60) + '…' : a.text}" into ${f.target ? `"${f.target}"` : `element [${a.ref}]`}${at(f)}${a.submit ? ' and press Enter' : ''}`,
      execute: (a, ctx) => browserCall(ctx, '/browser/type', { ref: a.ref, text: a.text, submit: a.submit, clear: a.clear }),
    }),

    defineTool({
      name: 'browser_press',
      description: 'Press a key or shortcut on the focused element, e.g. "Enter", "Escape", "Tab", "ArrowDown", "ControlOrMeta+A".',
      risk: 'write',
      untrusted: true,
      schema: z.object({ key: z.string().min(1) }),
      facts: (_a, ctx) => describe(ctx),
      summarize: (a, f) => `Press ${a.key}${f.target ? ` on "${f.target}"` : ''}${at(f)}`,
      execute: (a, ctx) => browserCall(ctx, '/browser/press', { key: a.key }),
    }),

    defineTool({
      name: 'browser_scroll',
      description: 'Scroll the page up or down by a number of screens (default 1).',
      risk: 'read',
      untrusted: true,
      schema: z.object({
        direction: z.enum(['up', 'down']),
        amount: z.number().min(0.25).max(10).optional(),
      }),
      execute: (a, ctx) => browserCall(ctx, '/browser/scroll', { direction: a.direction, amount: a.amount ?? 1 }),
    }),

    defineTool({
      name: 'browser_back',
      description: 'Go back to the previous page.',
      risk: 'read',
      untrusted: true,
      schema: z.object({}),
      execute: (_a, ctx) => browserCall(ctx, '/browser/back'),
    }),

    defineTool({
      name: 'browser_tabs',
      description: 'List open browser tabs, or switch to one by index.',
      risk: 'read',
      untrusted: true,
      schema: z.object({ switch_to: z.number().int().min(0).optional() }),
      async execute(a, ctx) {
        if (a.switch_to !== undefined) return browserCall(ctx, '/browser/switch_tab', { index: a.switch_to });
        const c = await ctx.computer();
        const tabs = await c.call<{ index: number; url: string; title: string; active: boolean }[]>('/browser/tabs', {}, { signal: ctx.signal });
        return tabs.map((t) => `${t.active ? '*' : ' '} [${t.index}] ${t.title || '(untitled)'} — ${t.url}`).join('\n');
      },
    }),
  ];
}
