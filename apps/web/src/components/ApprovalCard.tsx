import { Check, ChevronDown, ChevronRight, FileText, Monitor } from 'lucide-react';
import { useState } from 'react';
import type { Approval } from '@teambot/shared';
import { api } from '../api';
import { ago } from '../lib/format';
import { useMember, useStore } from '../store';
import { Avatar } from './Avatar';
import { Markdown } from './Markdown';

const TITLE: Record<Approval['kind'], string> = {
  approval: 'wants your approval',
  handoff: 'needs you to do this step',
  takeover: 'needs you at its computer',
};

type Decision = 'approve' | 'deny' | 'done' | 'decline';

function useResolve(approval: Approval) {
  const notify = useStore((s) => s.notify);
  const [busy, setBusy] = useState(false);
  async function resolve(decision: Decision, note: string) {
    setBusy(true);
    try {
      await api.post(`/approvals/${approval.id}/resolve`, { decision, note: note || undefined });
    } catch (err) {
      notify((err as Error).message, 'error');
      setBusy(false);
    }
  }
  return { busy, resolve };
}

/**
 * Review before saving (after OpenDots): an agent's draft page, drawn as it will read, saved only if you approve.
 * Declining saves nothing and tells the agent, with your note.
 */
function PageReviewCard({ approval }: { approval: Approval }) {
  const agent = useMember(approval.agentId);
  const { busy, resolve } = useResolve(approval);
  const [note, setNote] = useState('');
  const title = String(approval.args.title ?? 'Untitled');
  const content = String(approval.args.content ?? '');
  return (
    <section className="approval page-review" aria-label={`Review the page ${title}`}>
      <div className="row small">
        <Avatar member={agent} size={20} />
        <strong>{agent?.name ?? 'Agent'}</strong>
        <span className="muted">wrote a page for you to review</span>
        <span className="spacer" />
        <span className="faint">{ago(approval.createdAt)}</span>
      </div>
      <div className="page-review-doc">
        <div className="page-review-title">
          <FileText size={15} className="faint" />
          <h3>{title}</h3>
        </div>
        {content.trim() ? <Markdown text={content} /> : <p className="muted small">The draft is empty.</p>}
      </div>
      <p className="small muted">Nothing is saved until you approve. Approved, it becomes a page everyone in the workspace can read and edit.</p>
      <div className="approval-actions">
        <input className="input" style={{ flex: 1, minWidth: 180, height: 32 }} placeholder="Optional note to the agent" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn" disabled={busy} onClick={() => resolve('deny', note)}>
          Decline
        </button>
        <button className="btn ok" disabled={busy} onClick={() => resolve('approve', note)}>
          <Check size={14} /> Approve &amp; save
        </button>
      </div>
    </section>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const agent = useMember(approval.agentId);
  const openDock = useStore((s) => s.openDock);
  const { busy, resolve } = useResolve(approval);
  const [note, setNote] = useState('');
  const [showArgs, setShowArgs] = useState(false);

  if (approval.tool === 'propose_page' && approval.kind === 'approval') return <PageReviewCard approval={approval} />;

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
            <button className="btn danger" disabled={busy} onClick={() => resolve('deny', note)}>
              Deny
            </button>
            <button className="btn ok" disabled={busy} onClick={() => resolve('approve', note)}>
              Approve
            </button>
          </>
        ) : (
          <>
            <button className="btn" disabled={busy} onClick={() => resolve('decline', note)}>
              Won't do it
            </button>
            <button className="btn primary" disabled={busy} onClick={() => resolve('done', note)}>
              {approval.kind === 'takeover' ? 'Done, hand back' : 'I did it'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
