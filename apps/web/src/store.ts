// Client state. Loaded once from /api/bootstrap, then kept live by the event stream.
import { create } from 'zustand';
import {
  ACTIVE_RUN_STATUSES,
  PROGRESS_TOOL,
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
  type RunSummary,
  type Schedule,
  type SkillSummary,
  type WsFrame,
} from '@teambot/shared';
import { api, whenSignedOut, wsUrl } from './api';

const MAX_EVENTS = 800;

export type PanelTab = 'details' | 'library' | 'computer';

/** A page the right panel shows over the conversation's profile. */
export type PanelView =
  | { kind: 'thread'; rootId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'routine'; id: string }
  | { kind: 'routine-edit'; agentId: string; id: string | null }
  | { kind: 'memory'; agentId: string }
  | { kind: 'customize'; agentId: string };

export interface PanelState {
  open: boolean;
  tab: PanelTab;
  /** An agent shown instead of the conversation itself, e.g. one picked in a group chat. */
  agentId: string | null;
  view: PanelView | null;
  /** The page `agentId` and `view` were opened on. Anywhere else the panel shows that page's own profile. */
  at: string;
}

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
  /** Newest top-level message per channel, for the conversation list. */
  lastMessages: Record<string, Message>;
  approvals: Approval[];
  runs: Record<string, Run>;
  /** Runs conversations have shown work notes for, with their tool call counts. */
  runSummaries: Record<string, RunSummary>;
  schedules: Schedule[];
  skills: SkillSummary[];
  secrets: string[];
  pausedAll: boolean;
  health: Health | null;
  /** Top-level messages per channel. */
  messages: Record<string, Message[]>;
  /** Thread replies per root message id. */
  threads: Record<string, Message[]>;
  /** Per conversation: what agents posted elsewhere while working in it, such as a message to a teammate. */
  sent: Record<string, Message[]>;
  events: EventRecord[];
  panel: PanelState;
  sidebarCollapsed: boolean;
  /** A /shared file open in the preview dialog. */
  preview: string | null;
  toast: { text: string; kind: 'info' | 'error' } | null;

  init(): Promise<void>;
  refresh(): Promise<void>;
  loadMessages(channelId: string): Promise<void>;
  loadThread(rootId: string): Promise<void>;
  loadRunSummaries(ids: string[], force?: boolean): void;
  /** Open the right panel, changing what it shows. */
  showPanel(patch?: Partial<Pick<PanelState, 'tab' | 'agentId' | 'view'>>): void;
  togglePanel(): void;
  /** Close the page open in the panel, back to the profile. */
  closeView(): void;
  /** Watch an agent's computer in the panel. */
  openDock(agentId: string): void;
  openThread(rootId: string): void;
  openRun(runId: string): void;
  toggleSidebar(): void;
  openFile(path: string | null): void;
  notify(text: string, kind?: 'info' | 'error'): void;
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

// Layout choices are per browser; storage can be unavailable, and the app works without it.
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not remembered, still works */
  }
}

/** The panel covers the chat instead of sitting beside it (see the 1100px breakpoint in styles.css). */
export const overlayPanel = () => window.innerWidth <= 1100;

let socket: WebSocket | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const summariesLoading = new Set<string>();

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
  lastMessages: {},
  approvals: [],
  runs: {},
  runSummaries: {},
  schedules: [],
  skills: [],
  secrets: [],
  pausedAll: false,
  health: null,
  messages: {},
  threads: {},
  sent: {},
  events: [],
  // Where the panel covers the chat (narrow windows) it starts closed; on wide ones it stays as you left it.
  panel: { open: !overlayPanel() && (remembered('teambot-panel') ?? (window.innerWidth >= 1280 ? 'open' : 'closed')) === 'open', tab: 'details', agentId: null, view: null, at: '' },
  sidebarCollapsed: remembered('teambot-sidebar') === 'collapsed',
  preview: null,
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
        lastMessages: Object.fromEntries(b.lastMessages.map((m) => [m.channelId, m])),
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
    const [msgs, sent] = await Promise.all([
      api.get<Message[]>(`/channels/${channelId}/messages?limit=100`),
      api.get<Message[]>(`/channels/${channelId}/sent?limit=100`).catch(() => [] as Message[]),
    ]);
    // Keep what arrived live while these loaded.
    const merge = (loaded: Message[], live: Message[] = []) => {
      const seen = new Set(loaded.map((m) => m.id));
      return [...loaded, ...live.filter((m) => !seen.has(m.id))];
    };
    set((s) => ({
      messages: { ...s.messages, [channelId]: merge(msgs, s.messages[channelId]) },
      sent: { ...s.sent, [channelId]: merge(sent, s.sent[channelId]) },
    }));
  },

  async loadThread(rootId) {
    const { root, replies } = await api.get<{ root: Message; replies: Message[] }>(`/messages/${rootId}/thread`);
    set((s) => {
      const live = s.threads[root.id] ?? [];
      const seen = new Set(replies.map((m) => m.id));
      return { threads: { ...s.threads, [root.id]: [...replies, ...live.filter((m) => !seen.has(m.id))] } };
    });
  },

  loadRunSummaries(ids, force = false) {
    const have = get().runSummaries;
    const missing = [...new Set(ids)].filter((id) => (force || !have[id]) && !summariesLoading.has(id));
    if (!missing.length) return;
    missing.forEach((id) => summariesLoading.add(id));
    api
      .get<RunSummary[]>(`/runs?ids=${missing.join(',')}`)
      .then((list) => set((s) => ({ runSummaries: { ...s.runSummaries, ...Object.fromEntries(list.map((r) => [r.id, r])) } })))
      .catch(() => {})
      .finally(() => missing.forEach((id) => summariesLoading.delete(id)));
  },

  showPanel(patch = {}) {
    if (!overlayPanel()) remember('teambot-panel', 'open');
    const at = location.pathname;
    set((s) => {
      // What was open on another page doesn't carry over to this one.
      const base = s.panel.at === at ? s.panel : { ...s.panel, agentId: null, view: null, at };
      return { panel: { ...base, ...patch, open: true } };
    });
  },

  togglePanel() {
    const open = !get().panel.open;
    if (!overlayPanel()) remember('teambot-panel', open ? 'open' : 'closed');
    set((s) => ({ panel: { ...s.panel, open, view: open ? s.panel.view : null } }));
  },

  closeView() {
    set((s) => ({ panel: { ...s.panel, view: null } }));
  },

  openDock(agentId) {
    get().showPanel({ agentId, tab: 'computer', view: null });
  },

  openThread(rootId) {
    get().showPanel({ view: { kind: 'thread', rootId } });
  },

  openRun(runId) {
    get().showPanel({ view: { kind: 'run', runId } });
  },

  toggleSidebar() {
    const collapsed = !get().sidebarCollapsed;
    remember('teambot-sidebar', collapsed ? 'collapsed' : 'expanded');
    set({ sidebarCollapsed: collapsed });
  },

  openFile(path) {
    set({ preview: path });
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
  let finishedRun: string | null = null;
  useStore.setState((s) => {
    const next: Partial<State> = { events: [...s.events.slice(-MAX_EVENTS + 1), e] };

    if (d.message && e.type === 'message.created') {
      const m = d.message as Message;
      const list = s.messages[m.channelId];
      // An agent at work in one conversation posting in another: the one it works in notes it.
      const from = m.runId ? (s.runs[m.runId] ?? s.runSummaries[m.runId])?.channelId : null;
      const sent = from && from !== m.channelId ? s.sent[from] : undefined;
      if (from && sent && !sent.some((x) => x.id === m.id)) next.sent = { ...s.sent, [from]: [...sent, m] };
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
      } else {
        next.lastMessages = { ...s.lastMessages, [m.channelId]: m };
        if (list && !list.some((x) => x.id === m.id)) next.messages = { ...s.messages, [m.channelId]: [...list, { ...m, replyCount: 0, lastReplyAt: null }] };
      }
    }
    // A teammate's answer to a request made from a conversation: that conversation notes it ("Message from …").
    if (e.type === 'handoff.answered' && d.message && d.handoff?.originChannelId) {
      const m = d.message as Message;
      const origin = d.handoff.originChannelId as string;
      const all = next.sent ?? s.sent;
      if (all[origin] && !all[origin].some((x) => x.id === m.id)) next.sent = { ...all, [origin]: [...all[origin], m] };
    }
    if (d.channel) next.channels = upsert(s.channels, d.channel as Channel);
    if (e.type === 'channel.deleted') {
      const gone = d.channelId as string;
      const { [gone]: _messages, ...messages } = s.messages;
      const { [gone]: _last, ...lastMessages } = s.lastMessages;
      next.channels = s.channels.filter((c) => c.id !== gone);
      next.messages = messages;
      next.lastMessages = lastMessages;
      // Its routines now post in their agent's chat with the owner.
      next.schedules = s.schedules.map((x) => (x.channelId === gone ? { ...x, channelId: null } : x));
    }
    if (d.agent && e.type.startsWith('agent.')) next.agents = upsert(s.agents, d.agent as Agent);
    if (e.type === 'agent.status' && e.agentId) next.agents = s.agents.map((a) => (a.id === e.agentId ? { ...a, status: d.status } : a));
    if (e.type === 'agent.deleted') next.agents = s.agents.filter((a) => a.id !== d.agentId);
    if (e.type === 'approval.created') next.approvals = upsert(s.approvals, d.approval as Approval);
    if (e.type === 'approval.resolved' && d.approval) next.approvals = s.approvals.filter((a) => a.id !== d.approval.id);
    if (d.run) {
      const r = d.run as Run;
      const runs = { ...s.runs };
      if (ACTIVE_RUN_STATUSES.includes(r.status)) runs[r.id] = r;
      else {
        delete runs[r.id];
        finishedRun = r.id;
      }
      next.runs = runs;
      next.runSummaries = { ...s.runSummaries, [r.id]: { ...r, toolCalls: s.runSummaries[r.id]?.toolCalls ?? 0 } };
    }
    if (e.type === 'tool.checked' && e.runId && s.runSummaries[e.runId] && d.tool !== PROGRESS_TOOL) {
      const r = s.runSummaries[e.runId];
      next.runSummaries = { ...(next.runSummaries ?? s.runSummaries), [r.id]: { ...r, toolCalls: r.toolCalls + 1 } };
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
  // A finished run's exact count of actions comes from the server (events may have arrived before this page loaded).
  if (finishedRun) useStore.getState().loadRunSummaries([finishedRun], true);
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
  // A DM without me is between two others, e.g. agents working something out.
  return others.map((m) => memberName(m)).join(meId && channel.memberIds.includes(meId) ? ', ' : ' ⇄ ') || 'Notes to self';
}

/** The active run for an agent, if any. */
export function activeRunFor(runs: Record<string, Run>, agentId: string): Run | undefined {
  return Object.values(runs).find((r) => r.agentId === agentId);
}

/** The DM between me and an agent, once it exists. */
export function dmWith(channels: Channel[], meId: string | undefined, agentId: string): Channel | undefined {
  return channels.find((c) => c.kind === 'dm' && c.memberIds.length === 2 && c.memberIds.includes(agentId) && c.memberIds.includes(meId ?? ''));
}
