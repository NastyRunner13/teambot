// Domain types shared by server and web. Timestamps are ISO-8601 strings.

export type MemberKind = 'human' | 'agent';

export type HumanRole = 'owner' | 'member';

export interface Human {
  id: string;
  kind: 'human';
  name: string;
  /** The owner manages the workspace (policy, secrets, connectors, bridges, the team); members do everything else. */
  role: HumanRole;
  /** A teammate who was removed; kept so old messages still show their name. */
  removed: boolean;
  createdAt: string;
}

/** A link that lets one person join the workspace. The token itself is shown once, when it is created. */
export interface Invite {
  id: string;
  role: HumanRole;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'paused' | 'over_budget' | 'error';

/** Spending caps; null means no cap. Days and months are UTC. */
export interface AgentBudget {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  dailyTokens: number | null;
}

export const NO_BUDGET: AgentBudget = { dailyUsd: null, monthlyUsd: null, dailyTokens: null };

/** Internet access from an agent's computer. With an allowlist, everything else is blocked at the network level. */
export interface AgentNetwork {
  mode: 'open' | 'allowlist';
  /** Domains (example.com also covers sub.example.com; *.example.com style wildcards work). */
  allow: string[];
}

export const OPEN_NETWORK: AgentNetwork = { mode: 'open', allow: [] };

export interface Spend {
  usd: number;
  tokens: number;
}

export interface SpendReport {
  today: Spend;
  month: Spend;
  agents: Record<string, { today: Spend; month: Spend }>;
  workspaceDailyUsd: number | null;
}

export interface Agent {
  id: string;
  kind: 'agent';
  name: string;
  role: string;
  instructions: string;
  model: string;
  avatar: string;
  color: string;
  status: AgentStatus;
  paused: boolean;
  /** Human currently controlling this agent's computer, if any. */
  takeoverBy: string | null;
  mcpServers: string[];
  /** Skill names this agent may use; ["*"] means all of them. */
  skills: string[];
  budget: AgentBudget;
  /** Bash run on the agent's computer once, and again whenever it changes (installs, config). */
  setupScript: string;
  /** Docker image for this agent's computer; null uses the default image. */
  computerImage: string | null;
  /** Full desktop control (screenshots, mouse and keyboard). Needs a model that can see images. */
  desktop: boolean;
  network: AgentNetwork;
  createdAt: string;
  updatedAt: string;
}

export type Member = Human | Agent;

export type ChannelKind = 'channel' | 'dm';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  topic: string;
  memberIds: string[];
  /** Agent that answers human messages here when nobody is mentioned. */
  leadAgentId: string | null;
  createdAt: string;
}

/** A file in /shared that a message points at. */
export interface Attachment {
  path: string;
  name: string;
  size: number;
}

/** A file someone shared in a message: an agent's or a conversation's library. */
export interface LibraryItem extends Attachment {
  messageId: string;
  channelId: string;
  authorId: string;
  createdAt: string;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  text: string;
  createdAt: string;
  runId: string | null;
  /** How many agent hops away from a human message this is (loop guard). */
  depth: number;
  mentions: string[];
  attachments: Attachment[];
  /** Root message of the thread this is a reply in; null for top-level messages. */
  threadId: string | null;
  /** An interface the agent drew in the conversation (generative UI), shown in a sandboxed frame. */
  widget?: Widget | null;
  /** Top-level messages only, as returned by the channel listing. */
  replyCount?: number;
  lastReplyAt?: string | null;
}

/**
 * Generative UI: an interface an agent shows in a conversation. It is drawn in a sandboxed frame that has no access to
 * TeamBot (no session, no network), from a copy of the source taken when it was shown, so later edits to a component
 * don't change old messages.
 */
export interface Widget {
  /** `component`: a published component from the library; `html`: an interface the agent wrote itself. */
  kind: 'component' | 'html';
  title: string;
  /** The component's name and the published revision it was drawn from. */
  component?: string;
  revision?: number;
  html: string;
  css: string;
  js: string;
  /** What the agent passed in; the frame's script reads them as `teambot.args`. */
  args: Record<string, unknown>;
}

/** The source of a component: what it draws and the arguments it takes. */
export interface ComponentSource {
  /** What agents are told it is for. It becomes the description of its ui_<name> tool. */
  description: string;
  html: string;
  css: string;
  js: string;
  /** JSON Schema of an object: the arguments agents pass. */
  argsSchema: Record<string, unknown>;
}

/**
 * A reusable interface for agents, written in the components playground (or drafted by an agent) and usable only once
 * someone publishes it. A published component is offered to agents as the tool ui_<name>.
 */
export interface UiComponent {
  name: string;
  title: string;
  /** The working copy, with the arguments the preview draws it with. */
  draft: ComponentSource & { sampleArgs: Record<string, unknown> };
  /** The version agents use, kept when it is withdrawn so it can be published again. */
  published: (ComponentSource & { revision: number; at: string; by: string }) | null;
  /** Published and not withdrawn: agents can draw it. */
  live: boolean;
  /** The draft differs from the published version. */
  changed: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** Tools for components are named ui_<name>. */
export const COMPONENT_TOOL_PREFIX = 'ui_';
/** Lowercase letters, numbers and underscores, 2 to 40 characters. */
export const COMPONENT_NAME_RE = /^[a-z0-9][a-z0-9_]{0,38}[a-z0-9]$/;

/**
 * A document that people and agents edit together (Markdown). Every save raises `revision` by one; a save names the
 * revision it started from and is refused when the page has moved on since, so nobody overwrites an edit they never saw.
 */
export interface PageSummary {
  id: string;
  title: string;
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Length of the content in characters. */
  size: number;
}

export interface Page extends PageSummary {
  content: string;
}

export const MAX_PAGE_TITLE = 160;
export const MAX_PAGE_CHARS = 100_000;

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_human'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'running', 'waiting_approval', 'waiting_human', 'paused'];

/** `task` only on items from the old task board. */
export type InboxKind = 'message' | 'schedule' | 'system' | 'task';

export interface InboxItem {
  id: string;
  agentId: string;
  kind: InboxKind;
  /** Human-readable text that is handed to the agent as a user message. */
  text: string;
  channelId: string | null;
  /** Thread the item came from, so the agent answers in that thread. */
  threadId: string | null;
  depth: number;
  initiator: Initiator;
  /** From a read-only routine: the run may look but not change anything. */
  readOnly: boolean;
  createdAt: string;
  runId: string | null;
}

export type HandoffStatus = 'open' | 'answered' | 'failed' | 'cancelled';

/**
 * One agent asking another for something (ask_agent). The request sits in the two agents' DM; the answer goes back
 * to the conversation the asking run worked in.
 */
export interface Handoff {
  id: string;
  /** The run that asked. Its answers are delivered together once none is still open. */
  runId: string;
  fromAgentId: string;
  toAgentId: string;
  /** The two agents' DM, where the request and the answer are posted. */
  channelId: string;
  /** Where the answer goes: the asking run's conversation. */
  originChannelId: string | null;
  originThreadId: string | null;
  depth: number;
  initiator: Initiator;
  readOnly: boolean;
  task: string;
  status: HandoffStatus;
  /** The answer, or why there is none. */
  outcome: string | null;
  /** The asked agent's message that answered it, in `channelId`. */
  answerId: string | null;
  /** The answer's depth, so what the asker does next still counts the hops. */
  answerDepth: number | null;
  delivered: boolean;
  /** The asker was told once that the answer is held up (the asked agent ran out of budget). */
  delayNoted: boolean;
  createdAt: string;
  settledAt: string | null;
}

/** Who ultimately caused a run: a human, another agent, a schedule, or an outside event (webhook). Policies can match on it. */
export type Initiator = 'human' | 'agent' | 'schedule' | 'event';
export const INITIATORS: Initiator[] = ['human', 'agent', 'schedule', 'event'];

export interface Run {
  id: string;
  agentId: string;
  status: RunStatus;
  /** Conversation the run reports back to. */
  channelId: string | null;
  threadId: string | null;
  initiator: Initiator;
  /** Only tools that look (risk internal or read) may run. */
  readOnly: boolean;
  depth: number;
  title: string;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  error: string | null;
  /** The agent's plan for this run, kept current with update_progress (empty for quick replies). */
  progress: ProgressStep[];
  createdAt: string;
  updatedAt: string;
}

export type ProgressStatus = 'pending' | 'in_progress' | 'done';
export const PROGRESS_STATUSES: ProgressStatus[] = ['pending', 'in_progress', 'done'];

export interface ProgressStep {
  text: string;
  status: ProgressStatus;
}

/** The tool agents keep their checklist with. Its calls aren't counted or listed as actions. */
export const PROGRESS_TOOL = 'update_progress';

/** A run as a conversation shows it: the run plus how many actions (tool calls) it took. */
export interface RunSummary extends Run {
  toolCalls: number;
}

/** `review`: an independent reviewer model decides between allow, ask and deny. */
export type PolicyAction = 'allow' | 'review' | 'ask' | 'deny' | 'handoff';
export type ToolRisk = 'internal' | 'read' | 'write' | 'external';

export type ApprovalKind = 'approval' | 'handoff' | 'takeover';
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'done' | 'declined' | 'cancelled';

export interface Approval {
  id: string;
  agentId: string;
  runId: string;
  toolCallId: string;
  kind: ApprovalKind;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  reason: string;
  channelId: string | null;
  status: ApprovalStatus;
  note: string | null;
  resolvedBy: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface SearchResults {
  query: string;
  messages: { message: Message; where: string; snippet: string }[];
}

/** A reusable procedure in the SKILL.md format. */
export interface SkillSummary {
  name: string;
  description: string;
  /** Supporting files next to SKILL.md, relative to the skill folder. */
  files: string[];
  updatedAt: string;
  /** Set when SKILL.md can't be parsed; the skill is not offered to agents. */
  error?: string;
}

export interface Skill extends SkillSummary {
  /** The full SKILL.md, front matter included. */
  content: string;
}

export type RoutineTrigger = 'schedule' | 'webhook' | 'email' | 'slack' | 'calendar';
export const ROUTINE_TRIGGERS: RoutineTrigger[] = ['schedule', 'webhook', 'email', 'slack', 'calendar'];

/** Settings for event triggers. Passwords and private calendar URLs are stored as reserved secrets, not here. */
export interface RoutineConfig {
  /** email: IMAP server and what to watch for. */
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  mailbox?: string;
  from?: string;
  subject?: string;
  /** slack: the channel ID to watch (the bot must be in the channel). */
  channel?: string;
  /** calendar: how long before an event starts to hand it over. */
  minutesBefore?: number;
}

/** A routine: a prompt handed to an agent on a schedule or when something happens (webhook, email, Slack, calendar). */
export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  trigger: RoutineTrigger;
  config: RoutineConfig;
  /** The trigger's password or private URL is stored (email, calendar). */
  hasSecret?: boolean;
  /** Email and calendar routines: when TeamBot last looked, and what went wrong if it failed. */
  triggerStatus?: { checkedAt: string | null; error: string | null };
  /** Cron expression (schedule triggers; empty for webhooks). */
  cron: string;
  prompt: string;
  /** Skill the agent should load for this routine. */
  skill: string | null;
  /** Monitoring: the agent can look and report, but not change anything. */
  readOnly: boolean;
  /** Secret for webhook triggers (POST /api/hooks/<id> with header x-teambot-token). */
  token: string | null;
  channelId: string | null;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
}

export interface EventRecord {
  id: number;
  ts: string;
  type: string;
  actorId: string | null;
  agentId: string | null;
  runId: string | null;
  channelId: string | null;
  data: Record<string, unknown>;
}

export type ComputerState = 'missing' | 'stopped' | 'starting' | 'running' | 'error' | 'unavailable';

export interface ComputerStatus {
  agentId: string;
  state: ComputerState;
  detail?: string;
}

export interface TelegramStatus {
  /** A bot token is stored. */
  configured: boolean;
  /** Polling Telegram for messages. */
  running: boolean;
  botUsername: string | null;
  /** A chat is paired: messages from it act as you. */
  paired: boolean;
  pairing: { code: string; expiresAt: string } | null;
  error: string | null;
}

export interface SlackStatus {
  /** Both tokens are stored. */
  configured: boolean;
  /** Connected to Slack over Socket Mode. */
  running: boolean;
  botName: string | null;
  team: string | null;
  /** A Slack user is paired: their DMs to the bot act as you. */
  paired: boolean;
  pairing: { code: string; expiresAt: string } | null;
  error: string | null;
}

/** A saved copy of an agent's home folder. */
export interface Snapshot {
  id: string;
  agentId: string;
  label: string;
  /** Compressed size in bytes. */
  size: number;
  createdAt: string;
}

/** The last time an agent's setup script ran on its computer. */
export interface SetupRun {
  ok: boolean;
  at: string;
  exitCode: number | null;
  /** End of the script's output. */
  output: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextLength: number;
  promptPricePerM: number;
  completionPricePerM: number;
  inputModalities: string[];
}

export interface SharedFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface Bootstrap {
  me: Human;
  /** People sign in, and invite teammates (off for a personal workspace). */
  teamMode: boolean;
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  /** The newest top-level message of each channel above, for the conversation list. */
  lastMessages: Message[];
  approvals: Approval[];
  activeRuns: Run[];
  schedules: Schedule[];
  skills: SkillSummary[];
  secrets: string[];
  pausedAll: boolean;
  health: Health;
}

/** A remote MCP server added in Settings. Sign-in tokens live in the vault, never here. */
export interface Connector {
  name: string;
  url: string;
  createdAt: string;
  /**
   * Set when the server takes a token the person pastes (an API key or personal access token) instead of an OAuth
   * sign-in: it is sent as `header: prefix + token` on every request.
   */
  token?: { header: string; prefix: string };
}

/** An MCP server from mcp.json ("file") or a connector added in Settings. */
export interface McpServerStatus {
  name: string;
  source: 'file' | 'connector';
  url?: string;
  connected: boolean;
  tools: number;
  /** A connector waiting for a human to sign in (first time, or after its tokens stopped working), or for a new token. */
  needsSignIn: boolean;
  /** The connector signs in with a pasted token rather than OAuth. */
  usesToken?: boolean;
  error?: string;
}

/** One tool a connected MCP server offers. */
export interface McpToolSummary {
  name: string;
  description?: string;
}

export interface Health {
  ok: boolean;
  openrouterKey: boolean;
  docker: boolean;
  computerImage: boolean;
  defaultModel: string;
  utilityModel: string;
  reviewerModel: string;
  mcpServers: McpServerStatus[];
  telemetry: { enabled: boolean; endpoint: string | null; exported: number; error: string | null };
}

/** Server → browser realtime frame. */
export interface WsFrame {
  type: 'event';
  event: EventRecord;
}
