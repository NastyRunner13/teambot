// Agents are little blob characters in their own color; people are their initials.
import { Hash } from 'lucide-react';
import type { Agent, Human } from '@teambot/shared';

/**
 * Agents keep an emoji (Telegram and Slack messages show it). In the app, that emoji picks the blob's shape:
 * the eight emoji the agent editor offers map to the eight shapes in order, any other emoji to one of them.
 */
export const SHAPE_EMOJI = ['🦉', '🦊', '🐙', '🐝', '🐼', '🐱', '🤖', '✨'];

export function shapeOf(avatar: string): number {
  const i = SHAPE_EMOJI.indexOf(avatar);
  if (i !== -1) return i;
  let h = 0;
  for (const ch of avatar) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % SHAPE_EMOJI.length;
}

interface Shape {
  body: React.ReactNode;
  /** Eye centers. */
  eyes: [number, number][];
  tilt: number;
}

// A 48 × 48 canvas. Bodies are drawn in currentColor so the agent's color fills them.
const SHAPES: Shape[] = [
  { body: <path d="M9 27C8 16 15 8 25 8c10 0 15 7 15 16 0 10-6 17-16 17C15 41 9.6 35 9 27z" />, eyes: [[23, 20], [31, 19]], tilt: 10 },
  { body: <path d="M7 24c0-8 6-13 13-12 4 .5 6 3 10 2 6-1 11 3 11 10 0 10-8 17-18 17S7 34 7 24z" />, eyes: [[24, 22], [32, 21]], tilt: 6 },
  { body: <path d="M13 40c-3-4-3-10-3-16 0-11 6-18 14-18s14 7 14 18c0 6 0 12-3 16-3 3-6 0-11 0s-8 3-11 0z" />, eyes: [[20, 19], [28, 19]], tilt: 0 },
  { body: <path d="M5 29c0-9 8-15 19-15s19 6 19 15c0 7-6 11-19 11S5 36 5 29z" />, eyes: [[22, 24], [30, 24]], tilt: -4 },
  {
    body: (
      <>
        <circle cx="16" cy="28" r="10" />
        <circle cx="30" cy="23" r="13" />
      </>
    ),
    eyes: [[28, 20], [35, 20]],
    tilt: 8,
  },
  { body: <path d="M24 5c6 7 16 13 16 23 0 8-7 14-16 14S8 36 8 28C8 18 18 12 24 5z" />, eyes: [[20, 27], [28, 27]], tilt: -6 },
  { body: <path d="M10 37c-4 0-6-3-6-7 0-4 3-6 6-6 0-8 6-13 14-13 6 0 10 3 12 8 5 0 9 4 9 9s-4 9-9 9H10z" />, eyes: [[22, 24], [30, 24]], tilt: 4 },
  { body: <rect x="8" y="8" width="32" height="32" rx="13" transform="rotate(-9 24 24)" />, eyes: [[21, 21], [29, 20]], tilt: -9 },
];

export function Blob({ color, shape, size }: { color: string; shape: number; size: number }) {
  const s = SHAPES[shape % SHAPES.length];
  return (
    <svg className="blob" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" style={{ color }}>
      <g fill="currentColor">{s.body}</g>
      {s.eyes.map(([x, y]) => (
        <ellipse key={x} cx={x} cy={y} rx="2.3" ry="3.5" fill="#0b0b0b" transform={`rotate(${s.tilt} ${x} ${y})`} />
      ))}
    </svg>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export function Avatar({ member, size = 28, status = false }: { member: Agent | Human | undefined; size?: number; status?: boolean }) {
  if (!member || member.kind === 'human') {
    return (
      <span className="avatar human" style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.36)) }} title={member?.name}>
        {member ? initials(member.name) : '?'}
      </span>
    );
  }
  return (
    <span className="avatar" style={{ width: size, height: size }} title={`${member.name} · ${STATUS_LABEL[member.status]}`}>
      <Blob color={member.color} shape={shapeOf(member.avatar)} size={size} />
      {status && <span className={`status-dot ${member.status}`} />}
    </span>
  );
}

/** A group conversation: two of its agents side by side, or a # when it has none. */
export function GroupAvatar({ agents, size = 40 }: { agents: Agent[]; size?: number }) {
  if (!agents.length) {
    return (
      <span className="avatar group-hash" style={{ width: size, height: size }}>
        <Hash size={Math.round(size * 0.45)} />
      </span>
    );
  }
  const small = Math.round(size * 0.68);
  return (
    <span className="avatar group-avatar" style={{ width: size, height: size }}>
      {agents.slice(0, 2).map((a, i) => (
        <span key={a.id} className={`group-member m${i}`} style={agents.length === 1 ? { inset: 0, margin: 'auto' } : undefined}>
          <Blob color={a.color} shape={shapeOf(a.avatar)} size={agents.length === 1 ? size : small} />
        </span>
      ))}
    </span>
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
