// Generative UI tools: draw a one-off interface (show_ui), or draft a reusable component for a person to publish
// (draft_component). Published components are tools of their own, ui_<name> (see components.ts).
import { z } from 'zod';
import { COMPONENT_NAME_RE } from '@teambot/shared';
import { SOURCE_LIMITS, componentToolName, showWidget } from '../components.js';
import { defineTool, type ToolDef } from './types.js';

/**
 * What an agent is told about drawing an interface. The frame it renders in can't see TeamBot's stylesheet, so the
 * theme arrives as CSS variables the frame defines (light or dark, as the person has it); the rules that matter are
 * the sandbox's limits and honesty about data.
 */
export const DRAWING_GUIDE = `It renders in a sandboxed frame inside the chat, under your name and above your reply.
- The frame has no network and no access to TeamBot: fetch and XHR fail and outside images don't load. Put the data in the markup or in args, and draw charts with inline SVG or canvas. Scripts and styles from cdn.jsdelivr.net, cdnjs.cloudflare.com and unpkg.com do load, if a library is really needed.
- Style with the theme variables, which follow the person's light or dark theme: var(--tb-bg), --tb-surface, --tb-raised, --tb-text, --tb-muted, --tb-border, --tb-accent, --tb-ok, --tb-warn, --tb-bad, --tb-font, --tb-mono, --tb-radius. Use colour for meaning, not decoration.
- Design for a column 320–720px wide: no fixed widths; tables and charts scroll inside their own box. Use real buttons with visible focus.
- A button can put text in the person's message box with teambot.reply("…"); they still press send. Your script reads args as teambot.args.
- Never present invented numbers as real data: label examples as examples.`;

const Source = {
  html: z.string().min(1).max(SOURCE_LIMITS.html).describe('The markup for the body'),
  css: z.string().max(SOURCE_LIMITS.css).optional(),
  js: z.string().max(SOURCE_LIMITS.js).optional().describe('Runs after the markup'),
};

export function uiTools(): ToolDef[] {
  return [
    defineTool({
      name: 'show_ui',
      description: `Draw an interface in this conversation when it shows something better than text: a chart, a comparison, a timeline, a small calculator or form. If a ui_* component fits, use it instead. Keep plain answers in text.\n${DRAWING_GUIDE}`,
      risk: 'internal',
      // Showing something is reporting, which read-only runs do.
      readOnlyOk: true,
      available: (_agent, app) => app.cfg.generativeUi,
      schema: z.object({
        title: z.string().trim().min(1).max(120).describe('What it shows, e.g. "Plan comparison"'),
        ...Source,
        args: z.record(z.string(), z.unknown()).optional().describe('Data for the script, as teambot.args'),
        caption: z.string().trim().max(2000).optional().describe('A line of text to show with it'),
      }),
      summarize: (a) => `Show ${a.title}`,
      async execute(a, ctx) {
        return showWidget(ctx, { kind: 'html', title: a.title, html: a.html, css: a.css ?? '', js: a.js ?? '', args: a.args ?? {} }, a.caption);
      },
    }),

    defineTool({
      name: 'draft_component',
      description: `Save a reusable interface (a component) as a draft in the team's component library. After a person previews and publishes it, every agent can draw it with the tool ui_<name>, passing arguments that fit args_schema. Use it when someone wants a view the team will reuse (a status card, a comparison table); for a one-off, use show_ui. Saving never publishes: tell the person to review it under Connect apps → Components. Saving again with the same name replaces your draft.\n${DRAWING_GUIDE}`,
      risk: 'write',
      schema: z.object({
        name: z.string().regex(COMPONENT_NAME_RE, 'use 2–40 lowercase letters, numbers and underscores').describe('e.g. "price_table"; the tool becomes ui_<name>'),
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1).max(1000).describe('What agents should use it for and what it shows; it becomes the tool description'),
        ...Source,
        args_schema: z.record(z.string(), z.unknown()).describe('JSON Schema of the arguments object: {"type": "object", "properties": {…}, "required": […]}'),
        sample_args: z.record(z.string(), z.unknown()).describe('Example arguments the preview draws it with; they must fit args_schema'),
      }),
      summarize: (a) => `Draft the component ${a.name}`,
      async execute(a, ctx) {
        const saved = ctx.app.components.saveDraft(
          a.name,
          { title: a.title, description: a.description, html: a.html, css: a.css ?? '', js: a.js ?? '', argsSchema: a.args_schema, sampleArgs: a.sample_args },
          ctx.agent.id,
        );
        const where = saved.live ? `The published version is unchanged until a person publishes this draft.` : `Nobody can use it until a person publishes it.`;
        return `Saved a draft of the component "${saved.title}" (${componentToolName(saved.name)}). ${where} It is under Connect apps → Components, at /components/${saved.name}.`;
      },
    }),
  ];
}
