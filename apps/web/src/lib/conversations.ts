// Every conversation the sidebar lists, newest first: a chat with each agent, each group chat, and DMs between people.
import { useMemo } from 'react';
import type { Agent, Channel, Human, Message } from '@teambot/shared';
import { dmWith, useStore } from '../store';

export interface ConversationEntry {
  key: string;
  href: string;
  title: string;
  /** A chat with this agent. */
  agent?: Agent;
  /** A DM with this person (team mode). */
  human?: Human;
  /** The channel behind it; an agent's chat has none until the first visit. */
  channel?: Channel;
  /** Agents in a group chat, for its avatar. */
  members: Agent[];
  last?: Message;
  sortAt: string;
  /** An agent is working on something in this conversation right now. */
  working: boolean;
  /** An approval or a hand-off waits here. */
  waiting: boolean;
}

/** One line of a message, without Markdown punctuation. */
export function plainLine(text: string): string {
  const line = text
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[-*_]{3,}$/.test(l));
  return (line ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, '')
    .replace(/[*_`~]/g, '')
    .trim();
}

export function previewOf(entry: ConversationEntry, meId: string | undefined, nameOf: (id: string) => string): string {
  const m = entry.last;
  if (!m) return entry.agent ? entry.agent.role.split(':')[0] : entry.channel?.topic || '';
  const body = plainLine(m.text) || (m.attachments.length ? `📎 ${m.attachments.map((a) => a.name).join(', ')}` : '');
  if (m.authorId === meId) return `You: ${body}`;
  return entry.channel?.kind === 'channel' ? `${nameOf(m.authorId)}: ${body}` : body;
}

export function useConversations(): ConversationEntry[] {
  const me = useStore((s) => s.me);
  const agents = useStore((s) => s.agents);
  const humans = useStore((s) => s.humans);
  const channels = useStore((s) => s.channels);
  const lastMessages = useStore((s) => s.lastMessages);
  const runs = useStore((s) => s.runs);
  const approvals = useStore((s) => s.approvals);

  return useMemo(() => {
    const busy = new Set(Object.values(runs).map((r) => r.channelId));
    const waitingIn = (channel: Channel | undefined, agent?: Agent) =>
      approvals.some((a) => (channel && a.channelId === channel.id) || (agent && a.agentId === agent.id && !a.channelId));
    const entries: ConversationEntry[] = [];

    for (const agent of agents) {
      const channel = dmWith(channels, me?.id, agent.id);
      const last = channel ? lastMessages[channel.id] : undefined;
      entries.push({
        key: agent.id,
        href: `/agents/${agent.id}`,
        title: agent.name,
        agent,
        channel,
        members: [agent],
        last,
        // Opening a chat creates its DM; only messages count as activity.
        sortAt: last?.createdAt ?? agent.createdAt,
        working: !!channel && busy.has(channel.id),
        waiting: waitingIn(channel, agent),
      });
    }
    for (const channel of channels) {
      const agentMembers = agents.filter((a) => channel.memberIds.includes(a.id));
      if (channel.kind === 'dm' && agentMembers.length) continue; // an agent's chat, above
      const human = channel.kind === 'dm' ? humans.find((h) => h.id !== me?.id && channel.memberIds.includes(h.id)) : undefined;
      if (channel.kind === 'dm' && !human) continue;
      const last = lastMessages[channel.id];
      entries.push({
        key: channel.id,
        href: `/c/${channel.id}`,
        title: channel.kind === 'channel' ? channel.name : human!.name,
        human,
        channel,
        members: agentMembers,
        last,
        sortAt: last?.createdAt ?? channel.createdAt,
        working: busy.has(channel.id),
        waiting: waitingIn(channel),
      });
    }
    return entries.sort((a, b) => b.sortAt.localeCompare(a.sortAt));
  }, [me, agents, humans, channels, lastMessages, runs, approvals]);
}
