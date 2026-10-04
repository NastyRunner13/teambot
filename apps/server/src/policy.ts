// The action policy: every tool call is checked against these rules before it runs.
import { Environment } from '@marcbachmann/cel-js';
import YAML from 'yaml';
import { z } from 'zod';
import type { Initiator, PolicyAction, ToolRisk } from '@teambot/shared';
import { globToRegExp } from './util.js';
import type { Store } from './store.js';
import type { Bus } from './bus.js';

export const DEFAULT_POLICY_YAML = `# TeamBot action policy
# Every tool call an agent makes is checked against these rules before it runs.
#   allow   - run it
#   review  - an independent reviewer model looks at the request and the action, then allows it,
#             asks a human, or blocks it (if the reviewer fails, a human is asked)
#   ask     - pause the agent and ask a human in the Approvals inbox
#   handoff - don't run it; ask a human to do this step themselves
#   deny    - refuse; the agent is told it was blocked
# When several rules match, the strictest wins: deny > handoff > ask > review > allow.
# If no rule matches, the default for the tool's risk class applies.
#
# Rule fields (all optional except name, tools and action; every field given must match):
#   tools:       tool names, * wildcards allowed (e.g. browser_*, mcp__github__*)
#   agents:      agent names
#   initiator:   [human, agent, schedule, event] - who started the work (event = a webhook)
#   domains:     site the browser is on / navigating to (example.com also matches sub.example.com)
#   target:      regex on the label of the element being clicked or typed into
#   field_types: input types being typed into (password, email, ...)
#   args:        map of argument name -> regex on its value
#   when:        a CEL expression (https://cel.dev) that must be true. Variables: tool, risk, agent, initiator,
#                args (map), domain, url, target, field_type, hour and weekday (UTC; weekday 0 = Sunday),
#                spend_today (the agent's USD today), steps (model calls so far in this run), read_only.
#                If it fails at run time (e.g. a missing key), deny/handoff/ask/review rules match and allow rules don't.

defaults:
  internal: allow   # team tools: messages, progress
  read: allow       # looking at things: page snapshots, reading files, browsing
  write: allow      # changing things inside the agent's own computer
  external: ask     # tools that act outside the computer (MCP servers), add agents or set up routines

rules:
  - name: Confirm clicks that send, publish, pay or delete
    tools: [browser_click, browser_press, computer_click, computer_key]
    target: "\\\\b(send|submit|publish|post|tweet|pay|purchase|buy|order|place order|checkout|delete|remove|confirm|transfer|sign up|subscribe|invite)\\\\b"
    action: ask

  - name: Confirm keyboard shortcuts that send
    tools: [browser_press, computer_key]
    args:
      key: "(control|ctrl|meta|cmd|super|controlormeta)\\\\+(enter|return)"
    action: ask

  - name: Humans type passwords
    tools: [browser_type, computer_type]
    field_types: [password]
    action: handoff

  - name: Humans type payment and identity numbers
    tools: [browser_type, computer_type]
    target: "(card number|credit card|cvv|cvc|security code|iban|routing number|ssn|social security|passport)"
    action: handoff

  - name: Confirm new agents
    tools: [create_agent]
    action: ask

  - name: Review new routines
    tools: [create_routine]
    action: review

  - name: Review tasks handed to coding agents
    tools: [run_coding_agent]
    action: review

  - name: Review risky shell commands
    tools: [shell]
    args:
      command: "(\\\\brm\\\\s+-[a-z]*[rf]|\\\\bsudo\\\\b|\\\\b(curl|wget)\\\\b[^|]*\\\\|\\\\s*(sudo\\\\s+)?(ba|z)?sh\\\\b|\\\\bgit\\\\s+push\\\\b|\\\\b(ssh|scp|rsync)\\\\b|\\\\bmkfs|\\\\bdd\\\\s+if=|\\\\bchmod\\\\s+-R|\\\\bcrontab\\\\b)"
    action: review

  - name: Review changes to team memory
    tools: [remember, forget]
    args:
      scope: "^team$"
    action: review

  # Examples - uncomment to use:
  # - name: Outside working hours, ask before changing anything
  #   tools: ["*"]
  #   when: 'risk in ["write", "external"] && (hour < 8 || hour >= 20 || weekday == 0 || weekday == 6)'
  #   action: ask
  # - name: After $5 in a day, ask before more browsing or commands
  #   tools: [browser_*, shell]
  #   when: "spend_today > 5.0"
  #   action: ask
  # - name: Work started by a webhook gets a second look
  #   tools: [shell, browser_click, browser_type, write_file]
  #   initiator: [event]
  #   action: review
  # - name: Never touch banking sites
  #   tools: [browser_*]
  #   domains: [mybank.com]
  #   action: deny
  # - name: Ask before admin commands
  #   tools: [shell]
  #   args:
  #     command: "\\\\bsudo\\\\b"
  #   action: ask
`;

const Action = z.enum(['allow', 'review', 'ask', 'deny', 'handoff']);

const RuleSchema = z.object({
  name: z.string().min(1),
  tools: z.array(z.string().min(1)).min(1),
  agents: z.array(z.string()).optional(),
  initiator: z.array(z.enum(['human', 'agent', 'schedule', 'event'])).optional(),
  domains: z.array(z.string()).optional(),
  target: z.string().optional(),
  field_types: z.array(z.string()).optional(),
  args: z.record(z.string(), z.string()).optional(),
  when: z.string().min(1).optional(),
  action: Action,
});

/** The variables a rule's `when` expression can use. */
const cel = new Environment()
  .registerVariable('tool', 'string')
  .registerVariable('risk', 'string')
  .registerVariable('agent', 'string')
  .registerVariable('initiator', 'string')
  .registerVariable('args', 'map')
  .registerVariable('domain', 'string')
  .registerVariable('url', 'string')
  .registerVariable('target', 'string')
  .registerVariable('field_type', 'string')
  .registerVariable('hour', 'int')
  .registerVariable('weekday', 'int')
  .registerVariable('spend_today', 'double')
  .registerVariable('steps', 'int')
  .registerVariable('read_only', 'bool');

function compileWhen(source: string, rule: string): (vars: Record<string, unknown>) => unknown {
  let checked: { valid: boolean; type?: string; error?: Error };
  try {
    checked = cel.check(source);
  } catch (err) {
    throw new Error(`Invalid "when" in rule "${rule}": ${(err as Error).message.split('\n')[0]}`);
  }
  if (!checked.valid) throw new Error(`Invalid "when" in rule "${rule}": ${checked.error?.message.split('\n')[0]}`);
  if (checked.type !== 'bool') throw new Error(`The "when" in rule "${rule}" must be true or false, but it gives a ${checked.type}`);
  return cel.parse(source) as unknown as (vars: Record<string, unknown>) => unknown;
}

const PolicySchema = z.object({
  defaults: z.object({ internal: Action, read: Action, write: Action, external: Action }),
  rules: z.array(RuleSchema).nullish().transform((r) => r ?? []),
});

export interface PolicyContext {
  tool: string;
  risk: ToolRisk;
  agentName: string;
  initiator: Initiator;
  args: Record<string, unknown>;
  domain?: string;
  url?: string;
  target?: string;
  fieldType?: string;
  /** For `when` expressions. */
  spendToday?: number;
  steps?: number;
  readOnly?: boolean;
  now?: Date;
}

export interface Decision {
  action: PolicyAction;
  rule: string;
}

const STRICTNESS: Record<PolicyAction, number> = { allow: 0, review: 1, ask: 2, handoff: 3, deny: 4 };

interface CompiledRule {
  name: string;
  action: PolicyAction;
  tools: RegExp[];
  agents?: RegExp[];
  initiator?: Initiator[];
  domains?: string[];
  target?: RegExp;
  fieldTypes?: string[];
  args?: [string, RegExp][];
  when?: (vars: Record<string, unknown>) => unknown;
}

export function domainMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.includes('*')) return globToRegExp(p).test(h);
  return h === p || h.endsWith(`.${p}`);
}

function compileRegex(source: string, where: string): RegExp {
  try {
    return new RegExp(source, 'i');
  } catch (err) {
    throw new Error(`Invalid regex in ${where}: ${(err as Error).message}`);
  }
}

export class Policy {
  private constructor(
    readonly defaults: Record<ToolRisk, PolicyAction>,
    private rules: CompiledRule[],
  ) {}

  /** Parse and validate policy YAML. Throws an Error with a readable message. */
  static parse(text: string): Policy {
    let raw: unknown;
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new Error(`Policy is not valid YAML: ${(err as Error).message}`);
    }
    const parsed = PolicySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Policy is invalid at "${issue.path.join('.')}": ${issue.message}`);
    }
    const rules = parsed.data.rules.map((r): CompiledRule => ({
      name: r.name,
      action: r.action,
      tools: r.tools.map(globToRegExp),
      agents: r.agents?.map(globToRegExp),
      initiator: r.initiator,
      domains: r.domains,
      target: r.target ? compileRegex(r.target, `rule "${r.name}" target`) : undefined,
      fieldTypes: r.field_types?.map((f) => f.toLowerCase()),
      args: r.args ? Object.entries(r.args).map(([k, v]) => [k, compileRegex(v, `rule "${r.name}" args.${k}`)]) : undefined,
      when: r.when ? compileWhen(r.when, r.name) : undefined,
    }));
    return new Policy(parsed.data.defaults, rules);
  }

  /** Whether any rule has a `when` expression (the runtime only gathers spend for those). */
  get usesWhen(): boolean {
    return this.rules.some((r) => r.when);
  }

  private whenVars(ctx: PolicyContext): Record<string, unknown> {
    const now = ctx.now ?? new Date();
    return {
      tool: ctx.tool,
      risk: ctx.risk,
      agent: ctx.agentName,
      initiator: ctx.initiator,
      args: ctx.args,
      domain: ctx.domain ?? '',
      url: ctx.url ?? '',
      target: ctx.target ?? '',
      field_type: ctx.fieldType ?? '',
      hour: BigInt(now.getUTCHours()),
      weekday: BigInt(now.getUTCDay()),
      spend_today: ctx.spendToday ?? 0,
      steps: BigInt(ctx.steps ?? 0),
      read_only: ctx.readOnly ?? false,
    };
  }

  private matches(rule: CompiledRule, ctx: PolicyContext): boolean {
    if (!rule.tools.some((t) => t.test(ctx.tool))) return false;
    if (rule.agents && !rule.agents.some((a) => a.test(ctx.agentName))) return false;
    if (rule.initiator && !rule.initiator.includes(ctx.initiator)) return false;
    if (rule.domains && !(ctx.domain && rule.domains.some((d) => domainMatches(ctx.domain!, d)))) return false;
    if (rule.target && !(ctx.target !== undefined && rule.target.test(ctx.target))) return false;
    if (rule.fieldTypes && !(ctx.fieldType && rule.fieldTypes.includes(ctx.fieldType.toLowerCase()))) return false;
    if (rule.args) {
      for (const [name, re] of rule.args) {
        const v = ctx.args[name];
        if (v === undefined) return false;
        if (!re.test(typeof v === 'string' ? v : JSON.stringify(v))) return false;
      }
    }
    if (rule.when) {
      try {
        return rule.when(this.whenVars(ctx)) === true;
      } catch {
        return rule.action !== 'allow'; // fail closed
      }
    }
    return true;
  }

  evaluate(ctx: PolicyContext): Decision {
    let best: Decision | null = null;
    for (const rule of this.rules) {
      if (!this.matches(rule, ctx)) continue;
      if (!best || STRICTNESS[rule.action] > STRICTNESS[best.action]) best = { action: rule.action, rule: rule.name };
    }
    return best ?? { action: this.defaults[ctx.risk], rule: `default for ${ctx.risk} tools` };
  }
}

/**
 * What applies while the saved policy can't be read: a human approves everything except team tools. Falling back to
 * the default instead could quietly loosen a stricter policy someone saved.
 */
export const SAFE_MODE_POLICY_YAML = `defaults:
  internal: allow
  read: ask
  write: ask
  external: ask
rules: []
`;

/** Holds the active policy; the YAML text lives in settings so it can be edited from the UI. */
export class PolicyManager {
  private current: Policy;
  /** Why the saved policy couldn't be used (safe mode is on until it is saved again), or null. */
  invalid: string | null = null;

  constructor(
    private store: Store,
    private bus: Bus,
  ) {
    const text = this.text();
    try {
      this.current = Policy.parse(text);
    } catch (err) {
      this.invalid = (err as Error).message;
      console.error(`Stored policy is invalid; every action except team tools needs approval until it is fixed: ${this.invalid}`);
      this.current = Policy.parse(SAFE_MODE_POLICY_YAML);
    }
  }

  text(): string {
    return this.store.getSetting('policy_yaml') ?? DEFAULT_POLICY_YAML;
  }

  get policy(): Policy {
    return this.current;
  }

  update(text: string, actorId: string) {
    const next = Policy.parse(text);
    this.store.setSetting('policy_yaml', text);
    this.current = next;
    this.invalid = null;
    this.bus.emit('policy.updated', { actorId }, {});
  }
}
