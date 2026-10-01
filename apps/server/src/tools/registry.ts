import type { Agent } from '@teambot/shared';
import type { App } from '../app.js';
import type { ToolSpec } from '../models/types.js';
import { codingTools } from './coding-tools.js';
import { computerTools } from './computer-tools.js';
import { desktopTools } from './desktop-tools.js';
import { helperTools } from './helper-tools.js';
import { knowledgeTools } from './knowledge-tools.js';
import type { McpManager } from './mcp.js';
import { toParameters, type ToolDef } from './types.js';
import { workspaceTools } from './workspace-tools.js';

export class ToolRegistry {
  private builtins: ToolDef[];
  private specCache = new WeakMap<ToolDef, ToolSpec>();

  constructor(
    private mcp: McpManager,
    private app: () => App,
  ) {
    this.builtins = [...workspaceTools(), ...knowledgeTools(), ...helperTools(), ...computerTools(), ...desktopTools(), ...codingTools()];
  }

  forAgent(agent: Agent): ToolDef[] {
    const app = this.app();
    return [...this.builtins.filter((t) => !t.available || t.available(agent, app)), ...this.mcp.toolsFor(agent)];
  }

  find(agent: Agent, name: string): ToolDef | undefined {
    return this.forAgent(agent).find((t) => t.name === name);
  }

  specs(tools: ToolDef[]): ToolSpec[] {
    return tools.map((t) => {
      let spec = this.specCache.get(t);
      if (!spec) {
        spec = { type: 'function', function: { name: t.name, description: t.description, parameters: toParameters(t) } };
        this.specCache.set(t, spec);
      }
      return spec;
    });
  }
}
