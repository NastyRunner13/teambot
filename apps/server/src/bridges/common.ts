// What every personal messaging bridge (Telegram, Slack) shares: what goes out to your phone, how a
// message coming back finds its conversation, and pairing with a short-lived code.
import crypto from 'node:crypto';
import type { Approval, Message } from '@teambot/shared';
import type { App } from '../app.js';

export const PAIRING_MS = 10 * 60_000;

export interface Target {
  channelId: string;
  threadId: string | null;
}

export class Pairing {
  private pending: { code: string; expiresAt: number } | null = null;

  start() {
    this.pending = { code: String(crypto.randomInt(100000, 1000000)), expiresAt: Date.now() + PAIRING_MS };
  }

  current(): { code: string; expiresAt: string } | null {
    return this.pending && this.pending.expiresAt > Date.now() ? { code: this.pending.code, expiresAt: new Date(this.pending.expiresAt).toISOString() } : null;
  }

  /** True once, for the right code before it expires. */
  redeem(code: string | undefined): boolean {
    if (!code || !this.pending || this.pending.expiresAt <= Date.now() || code !== this.pending.code) return false;
    this.pending = null;
    return true;
  }
}

export function approvalText(app: App, a: Approval): string {
  const agent = app.workspace.memberName(a.agentId);
  const head = a.kind === 'approval' ? `🛂 ${agent} asks for approval` : a.kind === 'takeover' ? `🖐 ${agent} needs you on its computer` : `🖐 ${agent} needs you to do a step`;
  const details = typeof a.args.details === 'string' ? `\n\n${a.args.details}` : '';
  const where = a.kind === 'approval' ? '' : '\n\nDo it from the TeamBot app (it may need the live computer view), then tap Done.';
  return `${head}:\n${a.summary}${details}\n\nWhy: ${a.reason}${where}`;
}

export function outcomeText(app: App, a: Approval): string {
  const by = a.resolvedBy ? app.workspace.memberName(a.resolvedBy) : 'TeamBot';
  const outcome = { approved: '✅ Approved', denied: '⛔ Denied', done: '✅ Done', declined: 'Declined', cancelled: 'Cancelled', pending: '' }[a.status];
  return `${outcome}${a.status === 'cancelled' ? '' : ` by ${by}`}${a.note ? `: “${a.note}”` : ''}`;
}

export const approvalChoices = (a: Approval): { label: string; decision: 'approve' | 'deny' | 'done' | 'decline' }[] =>
  a.kind === 'approval'
    ? [
        { label: '✅ Approve', decision: 'approve' },
        { label: '⛔ Deny', decision: 'deny' },
      ]
    : [
        { label: '✅ Done', decision: 'done' },
        { label: 'Decline', decision: 'decline' },
      ];

/** An agent's message worth sending to your phone: its DMs to you and messages that @mention you. Null otherwise. */
export function forwardable(app: App, m: Message): { text: string } | null {
  const author = app.store.getAgent(m.authorId);
  if (!author) return null;
  const owner = app.workspace.owner();
  const channel = app.store.getChannel(m.channelId);
  if (!channel) return null;
  const dmWithOwner = channel.kind === 'dm' && channel.memberIds.includes(owner.id);
  if (!dmWithOwner && !m.mentions.includes(owner.id)) return null;
  const where = dmWithOwner ? (m.threadId ? ' in a thread' : '') : ` in ${app.workspace.channelLabel(channel, owner.id)}${m.threadId ? ' (thread)' : ''}`;
  const files = m.attachments.length ? `\n\n📎 ${m.attachments.map((a) => a.path).join('\n📎 ')}` : '';
  return { text: `${author.avatar} ${author.name}${where}:\n${m.text}${files}` };
}

export const HELP =
  'Reply to one of my messages to answer in that conversation. Start with @Name to message an agent directly. "agents" lists your team; "pause" and "resume" stop or restart all agents.';

/** Where a message from your phone goes: the conversation it replies to, the agent it names, or the last one used. */
export function resolveTarget(app: App, platform: string, replyTo: string | undefined, text: string): Target | null {
  const ws = app.workspace;
  const linked = replyTo ? app.store.getBridgeLink(platform, replyTo) : undefined;
  if (linked?.channelId && app.store.getChannel(linked.channelId)) return { channelId: linked.channelId, threadId: linked.threadId };
  const named = text.match(/^@([A-Za-z][A-Za-z0-9_-]{0,31})\b/);
  if (named) {
    const agent = app.store.getAgentByName(named[1]);
    if (agent) return { channelId: ws.getOrCreateDm(ws.owner().id, agent.id).id, threadId: null };
  }
  const last = app.store.getSetting(`${platform}_last_target`);
  if (last) {
    const t = JSON.parse(last) as Target;
    if (app.store.getChannel(t.channelId)) return t;
  }
  return null;
}

export function deliver(app: App, platform: string, target: Target, text: string, attachments: string[]) {
  app.workspace.postMessage({ channelId: target.channelId, threadId: target.threadId, authorId: app.workspace.owner().id, text, attachments });
  app.store.setSetting(`${platform}_last_target`, JSON.stringify(target));
}

/** Plain-word commands every bridge understands. Returns the reply, or null when it isn't a command. */
export function command(app: App, text: string): string | null {
  const word = text.trim().toLowerCase().replace(/^\//, '');
  if (word === 'help') return HELP;
  if (word === 'agents') {
    const agents = app.store.listAgents();
    return agents.length ? agents.map((a) => `${a.avatar} ${a.name} — ${a.status.replace('_', ' ')}${a.role ? ` · ${a.role}` : ''}`).join('\n') : 'No agents yet.';
  }
  if (word === 'pause' || word === 'resume') {
    app.runtime.setPausedAll(word === 'pause', app.workspace.owner().id);
    return word === 'pause' ? '⏸ All agents paused.' : '▶️ All agents resumed.';
  }
  return null;
}
