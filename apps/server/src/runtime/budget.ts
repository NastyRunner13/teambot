// Spending caps. Every model call (agent steps, compaction, reviews) records its cost in the event
// log, so spend is a sum over events; there is no separate counter to drift or reset.
import type { Agent, Spend, SpendReport } from '@teambot/shared';
import type { App } from '../app.js';

/** Events that carry `costUsd` / `inputTokens` / `outputTokens` for a model call. */
export const COST_EVENTS = ['llm.response', 'run.compacted', 'tool.reviewed'];

export const startOfDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
export const startOfMonth = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

const usd = (n: number) => `$${n.toFixed(2)}`;

export class BudgetExceeded extends Error {}

export class Budgets {
  constructor(private app: App) {}

  spend(since: string, agentId?: string | string[]): Spend {
    return this.app.store.spendSince(COST_EVENTS, since, agentId);
  }

  /** An agent and its helpers spend from the same budget: the parent's. Helpers that are gone still count. */
  private family(agent: Agent): { owner: Agent; ids: string[] } {
    const owner = (agent.parentId && this.app.store.getAgent(agent.parentId)) || agent;
    return { owner, ids: [owner.id, ...this.app.store.helperIdsEver(owner.id)] };
  }

  get workspaceDailyUsd(): number | null {
    const v = Number(this.app.store.getSetting('budget_daily_usd'));
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  setWorkspaceDailyUsd(value: number | null, actorId: string) {
    this.app.store.setSetting('budget_daily_usd', value && value > 0 ? String(value) : '');
    this.app.bus.emit('budget.updated', { actorId }, { workspaceDailyUsd: this.workspaceDailyUsd });
  }

  /** Why this agent may not call a model right now, or null when it may. */
  blocked(agent: Agent): string | null {
    const workspace = this.workspaceDailyUsd;
    if (workspace !== null) {
      const all = this.spend(startOfDay());
      if (all.usd >= workspace) return `the workspace's daily budget (${usd(all.usd)} of ${usd(workspace)} spent today)`;
    }
    // Helpers spend from their parent's budget, and a parent's spend includes its helpers'.
    const { owner, ids } = this.family(agent);
    const { dailyUsd, monthlyUsd, dailyTokens } = owner.budget;
    if (dailyUsd === null && monthlyUsd === null && dailyTokens === null) return null;
    const label = (kind: string) => (owner.id !== agent.id ? `${owner.name}'s ${kind}` : ids.length > 1 ? `the ${kind} I share with my helpers` : `my ${kind}`);
    const today = this.spend(startOfDay(), ids);
    if (dailyUsd !== null && today.usd >= dailyUsd) return `${label('daily budget')} (${usd(today.usd)} of ${usd(dailyUsd)} spent today)`;
    if (dailyTokens !== null && today.tokens >= dailyTokens) {
      return `${label('daily token budget')} (${today.tokens.toLocaleString('en-US')} of ${dailyTokens.toLocaleString('en-US')} tokens today)`;
    }
    if (monthlyUsd !== null) {
      const month = this.spend(startOfMonth(), ids);
      if (month.usd >= monthlyUsd) return `${label('monthly budget')} (${usd(month.usd)} of ${usd(monthlyUsd)} spent this month)`;
    }
    return null;
  }

  report(): SpendReport {
    const day = startOfDay();
    const month = startOfMonth();
    return {
      today: this.spend(day),
      month: this.spend(month),
      agents: Object.fromEntries(this.app.store.listAgents().map((a) => [a.id, { today: this.spend(day, a.id), month: this.spend(month, a.id) }])),
      workspaceDailyUsd: this.workspaceDailyUsd,
    };
  }
}
