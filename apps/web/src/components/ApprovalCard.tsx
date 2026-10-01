import { ChevronDown, ChevronRight, Monitor } from 'lucide-react';
import { useState } from 'react';
import type { Approval } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { useMember, useStore } from '../store';
import { Avatar } from './Avatar';

const TITLE: Record<Approval['kind'], string> = {
  approval: 'wants your approval',
  handoff: 'needs you to do this step',
  takeover: 'needs you at its computer',
};

export function ApprovalCard({ approval }: { approval: Approval }) {
  const agent = useMember(approval.agentId);
  const notify = useStore((s) => s.notify);
  const openDock = useStore((s) => s.openDock);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [showArgs, setShowArgs] = useState(false);

  async function resolve(decision: 'approve' | 'deny' | 'done' | 'decline') {
    setBusy(true);
    try {
      await api.post(`/approvals/${approval.id}/resolve`, { decision, note: note || undefined });
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  }

  const needsScreen = approval.kind === 'takeover' || approval.tool.startsWith('browser_');

  return (
    <div className={`approval ${approval.kind}`}>
      <div className="row small">
        <Avatar member={agent} size={20} />
        <strong>{agent?.name ?? 'Agent'}</strong>
        <span className="muted">{TITLE[approval.kind]}</span>
        <span className="spacer" />
        <span className="faint">{ago(approval.createdAt)}</span>
      </div>
      <div className="approval-summary">{approval.summary}</div>
      <div className="small muted">
        {approval.kind === 'takeover' || approval.tool === 'ask_for_approval' ? 'Requested by the agent' : `Rule: ${approval.reason}`}
        {' · '}
        <button className="btn ghost sm" style={{ padding: 0, height: 'auto' }} onClick={() => setShowArgs((v) => !v)}>
          {showArgs ? <ChevronDown size={12} /> : <ChevronRight size={12} />} details
        </button>
      </div>
      {showArgs && <pre className="json">{JSON.stringify({ tool: approval.tool, ...approval.args }, null, 2)}</pre>}
      <div className="approval-actions">
        <input className="input" style={{ flex: 1, minWidth: 180, height: 32 }} placeholder="Optional note to the agent" value={note} onChange={(e) => setNote(e.target.value)} />
        {needsScreen && (
          <button className="btn sm" onClick={() => openDock(approval.agentId)}>
            <Monitor size={13} /> Open computer
          </button>
        )}
        {approval.kind === 'approval' ? (
          <>
            <button className="btn danger" disabled={busy} onClick={() => resolve('deny')}>
              Deny
            </button>
            <button className="btn ok" disabled={busy} onClick={() => resolve('approve')}>
              Approve
            </button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => resolve('decline')}>
              Won't do it
            </button>
            <button className="btn primary" disabled={busy} onClick={() => resolve('done')}>
              {approval.kind === 'takeover' ? 'Done, hand back' : 'I did it'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
