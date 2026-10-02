// Client state. Loaded once from /api/bootstrap, then kept live by the event stream.
import { create } from 'zustand';
import {
  ACTIVE_RUN_STATUSES,
  type Agent,
  type Approval,
  type Bootstrap,
  type Channel,
  type EventRecord,
  type Health,
  type Human,
  type McpServerStatus,
  type Message,
  type Run,
  type Schedule,
  type SkillSummary,
  type Task,
  type WsFrame,
} from '@teambot/shared';
import { api, whenSignedOut, wsUrl } from './api';

const MAX_EVENTS = 800;

interface State {
  ready: boolean;
  connected: boolean;
  error: string | null;
  me: Human | null;
  /** Team mode: people sign in. */
  teamMode: boolean;
  /** Team mode and no valid session: show the sign-in page. */
  signedOut: boolean;
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  tasks: Task[];
  approvals: Approval[];
  runs: Record<string, Run>;
  schedules: Schedule[];
  skills: SkillSummary[];
  secrets: string[];
  pausedAll: boolean;
  health: Health | null;
  /** Top-level messages per channel. */
  messages: Record<string, Message[]>;
  /** Thread replies per root message id. */
  threads: Record<string, Message[]>;
  events: EventRecord[];
  /** Agent whose computer is open in the side panel. */
  dockAgentId: string | null;
  /** Thread open in the side panel (it shares the slot with the computer dock). */
  threadRootId: string | null;
  toast: { text: string; kind: 'info' | 'error' } | null;

  init(): Promise<void>;
  refresh(): Promise<void>;
  loadMessages(channelId: string): Promise<void>;
  loadThread(rootId: string): Promise<void>;
  openDock(agentId: string | null): void;
  openThread(rootId: string | null): void;
  notify(text: string, kind?: 'info' | 'error'): void;
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

let socket: WebSocket | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useStore = create<State>((set, get) => ({
  ready: false,
  connected: false,
  error: null,
  me: null,
  teamMode: false,
  signedOut: false,
  humans: [],
  agents: [],
  channels: [],
  tasks: [],
  approvals: [],
  runs: {},
  schedules: [],
  skills: [],
  secrets: [],
  pausedAll: false,
  health: null,
  messages: {},
  threads: {},
  events: [],
  dockAgentId: null,
  threadRootId: null,
  toast: null,

  async init() {
    if (socket) return;
    connect();
    await get().refresh();
  },

  async refresh() {
    try {
      const b = await api.get<Bootstrap>('/bootstrap');
      set({
        ready: true,
        error: null,
        me: b.me,
        teamMode: b.teamMode,
        signedOut: false,
        humans: b.humans,
        agents: b.agents,
        channels: b.channels,
        tasks: b.tasks,
        approvals: b.approvals,
        runs: Object.fromEntries(b.activeRuns.map((r) => [r.id, r])),
        schedules: b.schedules,
        skills: b.skills,
        secrets: b.secrets,
        pausedAll: b.pausedAll,
        health: b.health,
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  async loadMessages(channelId) {
    const msgs = await api.get<Message[]>(`/channels/${channelId}/messages?limit=100`);
    set((s) => {
      const live = s.messages[channelId] ?? [];
      const seen = new Set(msgs.map((m) => m.id));
      return { messages: { ...s.messages, [channelId]: [...msgs, ...live.filter((m) => !seen.has(m.id))] } };
    });
  },

  async loadThread(rootId) {
    const { root, replies } = await api.get<{ root: Message; replies: Message[] }>(`/messages/${rootId}/thread`);
    set((s) => {
      const live = s.threads[root.id] ?? [];
      const seen = new Set(replies.map((m) => m.id));
      return { threads: { ...s.threads, [root.id]: [...replies, ...live.filter((m) => !seen.has(m.id))] } };
    });
  },

  openDock(agentId) {
    set(agentId ? { dockAgentId: agentId, threadRootId: null } : { dockAgentId: null });
  },

  openThread(rootId) {
    set(rootId ? { threadRootId: rootId, dockAgentId: null } : { threadRootId: null });
  },

  notify(text, kind = 'info') {
    clearTimeout(toastTimer);
    set({ toast: { text, kind } });
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'error' ? 6000 : 3500);
  },
}));

function connect() {
  socket = new WebSocket(wsUrl('/ws'));
  socket.onopen = () => {
    const wasConnected = useStore.getState().ready;
    useStore.setState({ connected: true });
    // After a reconnect, resync anything we missed.
    if (wasConnected) void useStore.getState().refresh();
  };
  socket.onmessage = (e) => {
    const frame = JSON.parse(e.data as string) as WsFrame;
    if (frame.type === 'event') apply(frame.event);
  };
  socket.onclose = () => {
    useStore.setState({ connected: false });
    // Signed out: the server refuses the socket until the person signs in (which reloads the page).
    if (!useStore.getState().signedOut) setTimeout(connect, 1500);
  };
}

whenSignedOut(() => useStore.setState({ signedOut: true }));

/** Fold one server event into local state. */
function apply(e: EventRecord) {
  const d = e.data as Record<string, any>;
  useStore.setState((s) => {
    const next: Partial<State> = { events: [...s.events.slice(-MAX_EVENTS + 1), e] };

    if (d.message && e.type === 'message.created') {
      const m = d.message as Message;
      const list = s.messages[m.channelId];
      if (m.threadId) {
        const replies = s.threads[m.threadId];
        if (replies && !replies.some((x) => x.id === m.id)) next.threads = { ...s.threads, [m.threadId]: [...replies, m] };
        // Keep the root's "N replies" summary current.
        if (list) {
          next.messages = {
            ...s.messages,
            [m.channelId]: list.map((x) => (x.id === m.threadId ? { ...x, replyCount: (x.replyCount ?? 0) + 1, lastReplyAt: m.createdAt } : x)),
          };
        }
      } else if (list && !list.some((x) => x.id === m.id)) {
        next.messages = { ...s.messages, [m.channelId]: [...list, { ...m, replyCount: 0, lastReplyAt: null }] };
      }
    }
    if (d.channel) next.channels = upsert(s.channels, d.channel as Channel);
    if (d.agent && e.type.startsWith('agent.')) next.agents = upsert(s.agents, d.agent as Agent);
    if (e.type === 'agent.status' && e.agentId) next.agents = s.agents.map((a) => (a.id === e.agentId ? { ...a, status: d.status } : a));
    if (e.type === 'agent.deleted') next.agents = s.agents.filter((a) => a.id !== d.agentId);
    if (d.task) next.tasks = upsert(s.tasks, d.task as Task).sort((a, b) => a.number - b.number);
    if (e.type === 'task.deleted') next.tasks = (next.tasks ?? s.tasks).filter((t) => t.number !== d.taskNumber);
    if (e.type === 'approval.created') next.approvals = upsert(s.approvals, d.approval as Approval);
    if (e.type === 'approval.resolved' && d.approval) next.approvals = s.approvals.filter((a) => a.id !== d.approval.id);
    if (d.run) {
      const r = d.run as Run;
      const runs = { ...s.runs };
      if (ACTIVE_RUN_STATUSES.includes(r.status)) runs[r.id] = r;
      else delete runs[r.id];
      next.runs = runs;
    }
    if (e.type === 'system.paused') next.pausedAll = true;
    if (e.type === 'system.resumed') next.pausedAll = false;
    if (d.schedule) next.schedules = upsert(s.schedules, d.schedule as Schedule);
    if (e.type === 'schedule.deleted') next.schedules = s.schedules.filter((x) => x.id !== d.id);
    if (e.type === 'skill.saved' && d.skill) {
      next.skills = [...s.skills.filter((x) => x.name !== d.skill.name), d.skill as SkillSummary].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (e.type === 'skill.deleted') next.skills = s.skills.filter((x) => x.name !== d.name);
    if (e.type === 'secret.saved' && !s.secrets.includes(d.name)) next.secrets = [...s.secrets, d.name].sort();
    if (e.type === 'secret.deleted') next.secrets = s.secrets.filter((n) => n !== d.name);
    if (e.type.startsWith('connector.') && d.servers && s.health) next.health = { ...s.health, mcpServers: d.servers as McpServerStatus[] };
    if (e.type === 'human.joined' && d.human) next.humans = upsert(s.humans, d.human as Human);
    if (e.type === 'human.removed' && d.human) next.humans = s.humans.filter((h) => h.id !== d.human.id);
    if (e.type === 'team.enabled') next.teamMode = true;
    if (e.type === 'team.disabled') next.teamMode = false;
    if (e.type === 'human.updated' && d.human) {
      next.humans = upsert(s.humans, d.human as Human);
      if (s.me?.id === d.human.id) next.me = d.human;
    }
    return next;
  });
}

// ── selectors & helpers ────────────────────────────────────────────────

export function useMember(id: string | null | undefined): Agent | Human | undefined {
  return useStore((s) => (id ? (s.agents.find((a) => a.id === id) ?? s.humans.find((h) => h.id === id)) : undefined));
}

export function memberName(id: string | null | undefined): string {
  if (!id) return 'nobody';
  const s = useStore.getState();
  return s.agents.find((a) => a.id === id)?.name ?? s.humans.find((h) => h.id === id)?.name ?? 'unknown';
}

export function channelTitle(channel: Channel, meId: string | undefined): string {
  if (channel.kind === 'channel') return `#${channel.name}`;
  const others = channel.memberIds.filter((m) => m !== meId);
  return others.map((m) => memberName(m)).join(', ') || 'Notes to self';
}

/** The active run for an agent, if any. */
export function activeRunFor(runs: Record<string, Run>, agentId: string): Run | undefined {
  return Object.values(runs).find((r) => r.agentId === agentId);
}
