// Generative UI (after CopilotKit's OpenBot): interfaces agents draw in conversations instead of answering only in
// prose. Two kinds reach a chat as a message with a `widget`, drawn by the browser in a sandboxed frame:
// - components from the library: written as a draft (in the playground, or by an agent with draft_component),
//   previewed with sample arguments, and offered to agents as the tool ui_<name> only once a person publishes them;
// - one-off interfaces an agent writes itself with show_ui.
// Publishing is the gate: a draft reaches nobody, and withdrawing a component keeps its published copy so it can be
// published again. The tools still pass the policy like any other, so a rule can keep one away from an agent.
import { z } from 'zod';
import { COMPONENT_NAME_RE, COMPONENT_TOOL_PREFIX, type UiComponent, type Widget } from '@teambot/shared';
import type { App } from './app.js';
import { defineTool, type ToolContext, type ToolDef } from './tools/types.js';
import { now } from './util.js';

export class ComponentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export const SOURCE_LIMITS = { html: 60_000, css: 30_000, js: 60_000 };

/** A whole draft, as the playground saves it. */
export const DraftInput = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1000).default(''),
  html: z.string().max(SOURCE_LIMITS.html).default(''),
  css: z.string().max(SOURCE_LIMITS.css).default(''),
  js: z.string().max(SOURCE_LIMITS.js).default(''),
  argsSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
  sampleArgs: z.record(z.string(), z.unknown()).default({}),
});
export type DraftInput = z.input<typeof DraftInput>;

/** The validator for a component's arguments. Throws when the schema can't be read or doesn't describe an object. */
export function argsValidator(schema: Record<string, unknown>): z.ZodType<Record<string, unknown>> {
  let parsed: z.ZodType;
  try {
    parsed = z.fromJSONSchema({ type: 'object', ...schema } as never);
  } catch (err) {
    throw new ComponentError(`The arguments schema can't be read: ${(err as Error).message}`);
  }
  if (!(parsed instanceof z.ZodObject)) throw new ComponentError('The arguments schema must describe an object: {"type": "object", "properties": {…}}');
  return parsed as z.ZodType<Record<string, unknown>>;
}

const firstIssue = (err: z.ZodError) => {
  const issue = err.issues[0];
  return `${issue.path.join('.') || 'arguments'}: ${issue.message}`;
};

export const componentToolName = (name: string) => `${COMPONENT_TOOL_PREFIX}${name}`;

/**
 * Post an interface in the conversation the run works for, under the agent's name. It is not routed: a picture is not
 * a request, so it neither wakes anyone nor answers a teammate's ask_agent.
 */
export function showWidget(ctx: ToolContext, widget: Widget, caption = ''): string {
  const { workspace, store } = ctx.app;
  const channelId = ctx.run.channelId ?? workspace.getOrCreateDm(workspace.owner().id, ctx.agent.id).id;
  workspace.postMessage({
    channelId,
    threadId: ctx.run.channelId ? ctx.run.threadId : null,
    authorId: ctx.agent.id,
    text: caption,
    widget,
    actor: { id: ctx.agent.id, depth: ctx.run.depth, initiator: ctx.run.initiator, runId: ctx.run.id },
    route: false,
  });
  const channel = store.getChannel(channelId);
  return `Shown in ${channel ? workspace.channelLabel(channel, ctx.agent.id) : 'the conversation'}: "${widget.title}". People see it above your reply, so don't describe it again in full.`;
}

export class ComponentLibrary {
  /** One tool per published component, rebuilt only when it is published again. */
  private tools = new Map<string, { revision: number; tool: ToolDef }>();

  constructor(private app: App) {}

  list(): UiComponent[] {
    return this.app.store.listComponents();
  }

  get(name: string): UiComponent {
    const c = this.app.store.getComponent(name);
    if (!c) throw new ComponentError(`There is no component "${name}"`, 404);
    return c;
  }

  /**
   * Save the working copy. It never changes what agents draw: that is the published copy. An agent may not overwrite
   * a draft a person saved last, so a person's unpublished work isn't lost to an agent that picked the same name.
   */
  saveDraft(name: string, input: DraftInput, by: string): UiComponent {
    if (!COMPONENT_NAME_RE.test(name)) throw new ComponentError('Component names are 2–40 lowercase letters, numbers and underscores');
    const parsed = DraftInput.safeParse(input);
    if (!parsed.success) throw new ComponentError(firstIssue(parsed.error));
    const { title, sampleArgs, ...source } = parsed.data;
    argsValidator(source.argsSchema);
    const existing = this.app.store.getComponent(name);
    if (existing && this.app.store.getAgent(by) && this.app.store.getHuman(existing.updatedBy)) {
      throw new ComponentError(`${this.app.workspace.memberName(existing.updatedBy)} is working on the component "${name}". Pick another name, or ask them to change it.`, 409);
    }
    const t = now();
    const saved = this.app.store.putComponent({
      name,
      title,
      draft: { ...source, sampleArgs },
      published: existing?.published ?? null,
      live: existing?.live ?? false,
      createdBy: existing?.createdBy ?? by,
      updatedBy: by,
      createdAt: existing?.createdAt ?? t,
      updatedAt: t,
    });
    this.app.bus.emit('component.saved', { actorId: by }, { component: saved });
    return saved;
  }

  /**
   * Publish the draft: its source and description become what agents see and draw, together, in one step. Refused
   * until it has a description and markup, and while the sample arguments don't fit the schema (then neither would an
   * agent's).
   */
  publish(name: string, by: string): UiComponent {
    const c = this.get(name);
    const d = c.draft;
    if (!d.description.trim()) throw new ComponentError('Write a description first: it is how agents know what the component is for');
    if (!d.html.trim()) throw new ComponentError('The component has no HTML to draw');
    const sample = argsValidator(d.argsSchema).safeParse(d.sampleArgs);
    if (!sample.success) throw new ComponentError(`The sample arguments don't fit the arguments schema (${firstIssue(sample.error)}), so an agent's might not either`);
    if (c.live && !c.changed) return c;
    const saved = this.app.store.putComponent({
      ...c,
      published: { description: d.description, html: d.html, css: d.css, js: d.js, argsSchema: d.argsSchema, revision: (c.published?.revision ?? 0) + 1, at: now(), by },
      live: true,
      updatedBy: by,
      updatedAt: now(),
    });
    this.app.bus.emit('component.published', { actorId: by }, { component: saved });
    return saved;
  }

  /** Withdraw it from every agent. The published copy stays, so publishing again needs no rebuilding. */
  unpublish(name: string, by: string): UiComponent {
    const c = this.get(name);
    if (!c.live) return c;
    const saved = this.app.store.putComponent({ ...c, live: false, updatedBy: by, updatedAt: now() });
    this.app.bus.emit('component.unpublished', { actorId: by }, { component: saved });
    return saved;
  }

  remove(name: string, by: string) {
    this.get(name);
    this.app.store.deleteComponent(name);
    this.tools.delete(name);
    this.app.bus.emit('component.deleted', { actorId: by }, { name });
  }

  /** The ui_<name> tools: one for each published component that isn't withdrawn. */
  toolsForAgents(): ToolDef[] {
    const out: ToolDef[] = [];
    for (const c of this.list()) {
      if (!c.live || !c.published) continue;
      let entry = this.tools.get(c.name);
      if (entry?.revision !== c.published.revision) {
        entry = { revision: c.published.revision, tool: this.toolFor(c) };
        this.tools.set(c.name, entry);
      }
      out.push(entry.tool);
    }
    return out;
  }

  private toolFor(c: UiComponent): ToolDef {
    const published = c.published!;
    let schema: z.ZodType<Record<string, unknown>>;
    try {
      schema = argsValidator(published.argsSchema);
    } catch {
      schema = z.record(z.string(), z.unknown());
    }
    const { $schema: _ignored, ...parameters } = { type: 'object', ...published.argsSchema } as Record<string, unknown>;
    return defineTool({
      name: componentToolName(c.name),
      description: `${published.description}\n(Draws "${c.title}" in this conversation, for the people in it.)`,
      schema,
      parameters,
      risk: 'internal',
      // Showing something is reporting, which read-only runs do.
      readOnlyOk: true,
      summarize: () => `Show ${c.title}`,
      execute: async (args, ctx) => {
        // Withdrawn or republished since this run was offered the tool: draw what is published now, or nothing.
        const current = ctx.app.store.getComponent(c.name);
        if (!current?.live || !current.published) throw new Error(`${c.title} has been withdrawn, so it can't be shown. Answer in text instead.`);
        const p = current.published;
        return showWidget(ctx, { kind: 'component', title: current.title, component: c.name, revision: p.revision, html: p.html, css: p.css, js: p.js, args });
      },
    });
  }
}
