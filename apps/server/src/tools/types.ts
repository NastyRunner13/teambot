import { z } from 'zod';
import type { Agent, Run, ToolRisk } from '@teambot/shared';
import type { App } from '../app.js';
import type { ComputerHandle } from '../computers/types.js';

export interface ToolContext {
  app: App;
  agent: Agent;
  run: Run;
  /** The tool call being run (its id in the transcript). */
  callId: string;
  signal: AbortSignal;
  computer(): Promise<ComputerHandle>;
}

/** Facts gathered before the policy check, e.g. which button a click targets and on which site. */
export interface PolicyFacts {
  domain?: string;
  url?: string;
  target?: string;
  fieldType?: string;
}

/** A tool result with images (e.g. a screenshot) as well as text. */
export interface ToolOutput {
  text: string;
  images?: { mime: string; data: string }[];
}

export interface ToolDef<A = any> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  /** JSON Schema override (used by MCP tools, whose schemas arrive as JSON). */
  parameters?: Record<string, unknown>;
  risk: ToolRisk;
  /** Its output carries outside content (web pages, files, command output, other systems), so it is tagged as untrusted. */
  untrusted?: boolean;
  /**
   * Usable in a read-only run (a monitoring routine). Defaults to true for risk "read" and false otherwise, so a
   * team tool that changes something (memory, agents) must not set it. Messages are the intended exception:
   * a read-only run reports, and whatever it hands on to other agents stays read-only.
   */
  readOnlyOk?: boolean;
  /** Offered only to some agents (e.g. desktop control is opt-in, coding agents need an API key). */
  available?(agent: Agent, app: App): boolean;
  /** Its point is the image it returns, so it is not offered to models known to be text-only. */
  returnsImages?: boolean;
  facts?(args: A, ctx: ToolContext): Promise<PolicyFacts>;
  /** One line for approvals and the activity log. */
  summarize?(args: A, facts: PolicyFacts): string;
  execute(args: A, ctx: ToolContext): Promise<string | ToolOutput>;
}

export function defineTool<S extends z.ZodType>(def: Omit<ToolDef<z.infer<S>>, 'schema'> & { schema: S }): ToolDef<z.infer<S>> {
  return def as ToolDef<z.infer<S>>;
}

export const usableReadOnly = (tool: ToolDef) => tool.readOnlyOk ?? tool.risk === 'read';

export function toParameters(tool: ToolDef): Record<string, unknown> {
  if (tool.parameters) return tool.parameters;
  const schema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname || undefined;
  } catch {
    return undefined;
  }
}
