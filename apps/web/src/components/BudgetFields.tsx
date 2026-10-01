// Spending caps for one agent, with what it has spent so far. Empty means no cap.
import { useEffect, useId, useState } from 'react';
import type { AgentBudget, SpendReport } from '@teambot/shared';
import { api } from '../api';
import { money, tokens } from '../lib/format';

/** Number input that maps "" to null. */
function CapInput({ id, value, onChange, step, placeholder }: { id: string; value: number | null; onChange: (v: number | null) => void; step: string; placeholder: string }) {
  return (
    <input
      id={id}
      className="input"
      type="number"
      min="0"
      step={step}
      inputMode="decimal"
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(e.target.value === '' || !Number.isFinite(n) || n <= 0 ? null : n);
      }}
    />
  );
}

export function BudgetFields({ agentId, budget, set }: { agentId: string; budget: AgentBudget; set: (b: AgentBudget) => void }) {
  const id = useId();
  const [spend, setSpend] = useState<SpendReport | null>(null);
  useEffect(() => {
    api.get<SpendReport>('/spend').then(setSpend, () => setSpend(null));
  }, [agentId]);
  const mine = spend?.agents[agentId];

  return (
    <div className="section budget-fields">
      <h3 className="form-section-title">Budget</h3>
      <p className="muted small">
        When a cap is reached, the agent stops before its next model call and its work waits in the queue. Daily caps reset at midnight UTC. Leave a field empty for no cap.
      </p>
      <div className="budget-grid">
        <div className="field">
          <label htmlFor={`${id}-day`}>Per day (USD)</label>
          <CapInput id={`${id}-day`} step="0.5" placeholder="No cap" value={budget.dailyUsd} onChange={(dailyUsd) => set({ ...budget, dailyUsd })} />
          {mine && <span className="hint">Today: {money(mine.today.usd)}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-month`}>Per month (USD)</label>
          <CapInput id={`${id}-month`} step="1" placeholder="No cap" value={budget.monthlyUsd} onChange={(monthlyUsd) => set({ ...budget, monthlyUsd })} />
          {mine && <span className="hint">This month: {money(mine.month.usd)}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-tokens`}>Tokens per day</label>
          <CapInput id={`${id}-tokens`} step="10000" placeholder="No cap" value={budget.dailyTokens} onChange={(v) => set({ ...budget, dailyTokens: v === null ? null : Math.round(v) })} />
          {mine && <span className="hint">Today: {tokens(mine.today.tokens)}</span>}
        </div>
      </div>
    </div>
  );
}
