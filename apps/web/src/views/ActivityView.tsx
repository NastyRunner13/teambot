// The audit log: every message, model call, tool call, policy decision and approval, newest first.
import { useEffect, useMemo, useState } from 'react';
import type { EventRecord } from '@teambot/shared';
import { api } from '../api';
import { money } from '../lib/format';
import { memberName, useStore } from '../store';

const GROUPS: Record<string, string[]> = {
  all: [],
  messages: ['message.*'],
  tools: ['tool.*'],
  model: ['llm.*'],
  approvals: ['approval.*'],
  runs: ['run.*'],
  tasks: ['task.*'],
  memory: ['memory.*', 'skill.*'],
  system: ['agent.*', 'computer.*', 'system.*', 'policy.*', 'secret.*', 'schedule.*', 'channel.*', 'loop.*', 'budget.*', 'file.*', 'bridge.*', 'egress.*', 'trigger.*', 'connector.*', 'team.*', 'human.*'],
};

function matches(e: EventRecord, group: string, agentId: string) {
  if (agentId && e.agentId !== agentId) return false;
  const patterns = GROUPS[group];
  return !patterns.length || patterns.some((p) => e.type.startsWith(p.replace('*', '')));
}

export function describe(e: EventRecord): string {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'message.created':
      return `${memberName(d.message?.authorId)}: ${String(d.message?.text ?? '').slice(0, 160)}`;
    case 'tool.checked':
      return `${d.summary} → ${d.action}${d.action === 'allow' ? '' : ` (${d.rule})`}`;
    case 'tool.started':
      return `${d.tool} started`;
    case 'tool.reviewed':
      return `Reviewer said ${d.verdict} to “${d.summary}”: ${d.reason} · ${money(Number(d.costUsd ?? 0))}`;
    case 'tool.finished':
      return `${d.tool} ${d.ok ? 'finished' : 'failed'} in ${(Number(d.ms) / 1000).toFixed(1)}s`;
    case 'llm.response':
      return `${d.model} · ${d.toolCalls?.length ? `calls ${d.toolCalls.join(', ')}` : 'replied'} · ${d.inputTokens}→${d.outputTokens} tokens · ${money(Number(d.costUsd))}`;
    case 'approval.created':
      return `Asked: ${d.approval?.summary}`;
    case 'approval.resolved':
      return `${d.approval?.status}: ${d.approval?.summary}${d.approval?.note ? ` — “${d.approval.note}”` : ''}`;
    case 'task.created':
      return `Created #${d.task?.number} ${d.task?.title} → ${memberName(d.task?.assigneeId)}`;
    case 'task.updated':
      return `#${d.task?.number} ${d.task?.title}: ${d.before?.status !== d.task?.status ? `${d.before?.status} → ${d.task?.status}` : 'updated'}`;
    case 'agent.created':
      return d.parentId
        ? `${memberName(d.parentId)} started the helper ${d.agent?.name}`
        : d.createdBy
          ? `${memberName(d.createdBy)} added ${d.agent?.name} to the team`
          : `${d.agent?.name} joined the team`;
    case 'agent.deleted':
      return d.helper ? 'A helper finished and left' : 'An agent was removed';
    case 'agent.status':
      return `${memberName(e.agentId)} is now ${d.status}`;
    case 'computer.starting':
      return 'Computer starting';
    case 'computer.started':
      return 'Computer is up';
    case 'computer.stopped':
      return 'Computer stopped';
    case 'computer.reset':
      return 'Computer wiped';
    case 'egress.blocked':
      return `Blocked a connection to ${d.host} (not on the allowlist)`;
    case 'computer.network':
      return d.mode === 'allowlist' ? `Internet limited to the allowlist (via ${d.proxy})` : 'Internet access opened';
    case 'computer.snapshot':
      return `Saved a snapshot: ${d.snapshot?.label}`;
    case 'computer.restored':
      return 'Restored a snapshot of the home folder';
    case 'computer.slept':
      return `Computer went to sleep after ${d.idleMinutes} idle minutes`;
    case 'computer.setup_started':
      return 'Setup script started';
    case 'computer.setup_finished':
      return 'Setup script finished';
    case 'computer.setup_failed':
      return `Setup script failed${d.setup?.exitCode != null ? ` (exit code ${d.setup.exitCode})` : ''}`;
    case 'channel.created':
      return d.channel?.kind === 'dm' ? 'Started a direct conversation' : `Created #${d.channel?.name}`;
    case 'channel.updated':
      return d.channel?.kind === 'dm' ? 'Updated a direct conversation' : `Updated #${d.channel?.name}`;
    case 'run.input':
      return `Picked up ${d.items} new item${d.items === 1 ? '' : 's'}`;
    case 'loop.guard':
      return 'Stopped an agent-to-agent loop (too many hops without a human)';
    case 'run.failed':
      return `Run failed: ${d.error}`;
    case 'computer.error':
      return `Computer error: ${d.error}`;
    case 'policy.updated':
      return 'Policy changed';
    case 'secret.saved':
      return `Secret ${d.name} saved`;
    case 'secret.deleted':
      return `Secret ${d.name} deleted`;
    case 'budget.exceeded':
      return `Stopped at ${d.reason}`;
    case 'budget.updated':
      return d.workspaceDailyUsd ? `Workspace cap set to ${money(Number(d.workspaceDailyUsd))} per day` : 'Workspace cap removed';
    case 'file.uploaded':
      return `Uploaded ${d.file?.path}`;
    case 'memory.updated': {
      const which = d.scope === 'team' ? 'team memory' : `${memberName(d.agentId)}'s memory`;
      if (d.added) return `Added to ${which}: ${String(d.added).replace(/^- /, '')}`;
      if (d.removed) return `Removed ${d.removed.length} line(s) from ${which}`;
      return `Edited ${which}`;
    }
    case 'task.nudged':
      return `Followed up on #${d.taskNumber} ${d.title} (${String(d.status).replace('_', ' ')}, quiet for ${d.quietHours}h)`;
    case 'schedule.fired': {
      const by: Record<string, string> = { webhook: ' by a webhook', email: ' by an email', slack: ' by a Slack message', calendar: ' by a calendar event' };
      return `Routine "${d.schedule?.name}" started${by[d.trigger] ?? ''}`;
    }
    case 'trigger.failed':
      return `Couldn't check "${d.name}" (${d.trigger}): ${d.error}`;
    case 'trigger.recovered':
      return `Checking "${d.name}" works again`;
    case 'team.enabled':
      return 'Turned on team sign-in';
    case 'team.disabled':
      return 'Turned off team sign-in';
    case 'team.invited':
      return `Created an invite link${d.role === 'owner' ? ' for a co-owner' : ''}`;
    case 'human.joined':
      return `${d.human?.name} joined the team`;
    case 'human.removed':
      return `Removed ${d.human?.name} from the team`;
    case 'human.signed_in':
      return 'Signed in';
    case 'human.password_changed':
      return 'Changed their password';
    case 'human.updated':
      return `Renamed themselves to ${d.human?.name}`;
    case 'connector.added':
      return `Added the ${d.name} connector (${d.url})`;
    case 'connector.updated':
      return d.change === 'signed_in'
        ? `Signed in to the ${d.name} connector`
        : d.change === 'signed_out'
          ? `The ${d.name} connector stopped accepting its sign-in; sign in again in Settings`
          : d.change === 'sign_in_started'
            ? `Started signing in to the ${d.name} connector`
            : `Reconnected the ${d.name} connector`;
    case 'connector.removed':
      return `Removed the ${d.name} connector`;
    case 'bridge.configured':
      return `Connected the ${d.platform} bot${d.bot ? ` @${d.bot}` : ''}`;
    case 'bridge.started':
      return `${d.platform} bridge is listening${d.bot ? ` as @${d.bot}` : ''}`;
    case 'bridge.paired':
      return `Paired a ${d.platform} chat`;
    case 'bridge.unpaired':
      return `Unpaired the ${d.platform} chat`;
    case 'bridge.removed':
      return `Disconnected the ${d.platform} bot`;
    case 'skill.used':
      return `Used the skill ${d.name}`;
    case 'skill.saved':
      return `Saved the skill ${d.skill?.name}`;
    case 'skill.deleted':
      return `Deleted the skill ${d.name}`;
    case 'run.compacted':
      return `Summarized ${d.dropped} older steps${d.costUsd ? ` · ${money(Number(d.costUsd))}` : ''}`;
    default:
      if (e.type.startsWith('run.') && d.run) return `${e.type.slice(4)}: ${d.run.title}`;
      if (e.type.startsWith('agent.') && d.agent) return `${d.agent.name} ${e.type.slice(6)}`;
      return e.type;
  }
}

export function ActivityView() {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.events);
  const [group, setGroup] = useState('all');
  const [agentId, setAgentId] = useState('');
  const [older, setOlder] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const query = (before?: number) =>
    `/events?limit=150${before ? `&before=${before}` : ''}${agentId ? `&agentId=${agentId}` : ''}${GROUPS[group].length ? `&types=${GROUPS[group].join(',')}` : ''}`;

  useEffect(() => {
    setLoading(true);
    api.get<EventRecord[]>(query()).then((r) => {
      setOlder(r);
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, agentId]);

  const rows = useMemo(() => {
    const seen = new Set(older.map((e) => e.id));
    const fresh = live.filter((e) => !seen.has(e.id) && matches(e, group, agentId) && e.id > (older[0]?.id ?? 0)).reverse();
    return [...fresh, ...older];
  }, [live, older, group, agentId]);

  async function loadMore() {
    const last = older[older.length - 1];
    if (!last) return;
    const r = await api.get<EventRecord[]>(query(last.id));
    setOlder((x) => [...x, ...r]);
  }

  return (
    <>
      <div className="page-header">
        <h1 className="grow">Activity</h1>
        <select className="select" style={{ width: 160 }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.avatar} {a.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 150 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          {Object.keys(GROUPS).map((g) => (
            <option key={g} value={g}>
              {g === 'all' ? 'Everything' : g[0].toUpperCase() + g.slice(1)}
            </option>
          ))}
        </select>
      </div>
      <div className="page" style={{ padding: 0 }}>
        <table className="events">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Time</th>
              <th style={{ width: 120 }}>Agent</th>
              <th style={{ width: 150 }}>Event</th>
              <th>What happened</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="small muted">{new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</td>
                <td className="small">{e.agentId ? memberName(e.agentId) : e.actorId ? memberName(e.actorId) : '—'}</td>
                <td>
                  <span className="badge mono">{e.type}</span>
                </td>
                <td style={{ wordBreak: 'break-word' }}>{describe(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty" style={{ margin: 20 }}>No activity yet.</div>}
        {older.length >= 150 && (
          <div style={{ padding: 16, textAlign: 'center' }}>
            <button className="btn" onClick={loadMore}>
              Load older
            </button>
          </div>
        )}
      </div>
    </>
  );
}
