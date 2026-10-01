import type { Agent, Human } from '@teambot/shared';

export function Avatar({ member, size = 28, status = false }: { member: Agent | Human | undefined; size?: number; status?: boolean }) {
  const style = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  if (!member) return <div className="avatar human" style={style}>?</div>;
  if (member.kind === 'human') {
    const initials = member.name
      .split(/\s+/)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
    return (
      <div className="avatar human" style={{ ...style, fontSize: Math.round(size * 0.4) }} title={member.name}>
        {initials}
      </div>
    );
  }
  return (
    <div className="avatar" style={{ ...style, background: `${member.color}2e`, fontSize: Math.round(size * 0.56) }} title={`${member.name} · ${member.status}`}>
      {member.avatar}
      {status && <span className={`status-dot ${member.status}`} />}
    </div>
  );
}

export const STATUS_LABEL: Record<Agent['status'], string> = {
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting for you',
  paused: 'Paused',
  over_budget: 'Over budget',
  error: 'Error',
};

export function StatusBadge({ agent }: { agent: Agent }) {
  const kind = { idle: '', working: 'ok', waiting: 'warn', paused: '', over_budget: 'warn', error: 'danger' }[agent.status];
  const label = agent.takeoverBy ? 'You have control' : STATUS_LABEL[agent.status];
  return <span className={`badge ${kind}`}>{label}</span>;
}
