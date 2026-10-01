import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Approval } from '@teambot/shared';
import { api } from '../api';
import { ApprovalCard } from '../components/ApprovalCard';
import { ago } from '../lib/format';
import { memberName, useStore } from '../store';

const STATUS_BADGE: Record<string, string> = { approved: 'ok', done: 'ok', denied: 'danger', declined: 'danger', cancelled: '' };

export function ApprovalsView() {
  const pending = useStore((s) => s.approvals);
  const [history, setHistory] = useState<Approval[]>([]);

  useEffect(() => {
    api.get<Approval[]>('/approvals').then((all) => setHistory(all.filter((a) => a.status !== 'pending')));
  }, [pending.length]);

  return (
    <>
      <div className="page-header">
        <h1 className="grow">Approvals</h1>
        <span className="small muted">Agents pause here before risky actions, and when they need you to do a step.</span>
      </div>
      <div className="page page-narrow">
        {pending.length === 0 ? (
          <div className="empty">
            <ShieldCheck size={22} />
            <div>Nothing is waiting for you.</div>
          </div>
        ) : (
          pending.map((a) => <ApprovalCard key={a.id} approval={a} />)
        )}
        <div className="section">
          <h2>History</h2>
          {history.length === 0 && <div className="small muted">No decisions yet.</div>}
          {history.length > 0 && (
            <div className="list">
              {history.map((a) => (
                <div key={a.id} className="list-row">
                  <span className={`badge ${STATUS_BADGE[a.status] ?? ''}`}>{a.status}</span>
                  <span className="grow ellipsis">
                    <strong>{memberName(a.agentId)}</strong>: {a.summary}
                    {a.note && <span className="muted"> — “{a.note}”</span>}
                  </span>
                  <span className="small faint">{ago(a.resolvedAt ?? a.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
