// SQLite persistence (node:sqlite, built into Node 22+). Every state change also lands in the
// append-only `events` table, which doubles as the audit log and the activity timeline.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import {
  NO_BUDGET,
  OPEN_NETWORK,
  type Agent,
  type Approval,
  type ApprovalStatus,
  type Channel,
  type EventRecord,
  type Human,
  type HumanRole,
  type Invite,
  type InboxItem,
  type Message,
  type Run,
  type RunStatus,
  type RunSummary,
  type Schedule,
  type Spend,
  type Task,
} from '@teambot/shared';
import { newId, now } from './util.js';

const LAST_TASK_NUMBER = 'last_task_number';

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE humans (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, instructions TEXT NOT NULL,
    model TEXT NOT NULL, avatar TEXT NOT NULL, color TEXT NOT NULL, status TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0,
    takeover_by TEXT, mcp_servers TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE UNIQUE INDEX channels_name ON channels(name COLLATE NOCASE) WHERE kind = 'channel';
  CREATE TABLE channel_members (channel_id TEXT NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (channel_id, member_id));
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
    run_id TEXT, depth INTEGER NOT NULL DEFAULT 0, mentions TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX messages_channel ON messages(channel_id, created_at);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, assignee_id TEXT, creator_id TEXT NOT NULL, channel_id TEXT, depends_on TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL, channel_id TEXT, initiator TEXT NOT NULL,
    depth INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX runs_agent ON runs(agent_id, created_at);
  CREATE TABLE run_transcripts (run_id TEXT PRIMARY KEY, transcript TEXT NOT NULL);
  CREATE TABLE inbox (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, channel_id TEXT,
    task_number INTEGER, depth INTEGER NOT NULL DEFAULT 0, initiator TEXT NOT NULL, created_at TEXT NOT NULL, run_id TEXT
  );
  CREATE INDEX inbox_pending ON inbox(agent_id, run_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, run_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, kind TEXT NOT NULL,
    tool TEXT NOT NULL, args TEXT NOT NULL, summary TEXT NOT NULL, reason TEXT NOT NULL, channel_id TEXT,
    status TEXT NOT NULL, note TEXT, resolved_by TEXT, created_at TEXT NOT NULL, resolved_at TEXT
  );
  CREATE INDEX approvals_run ON approvals(run_id, tool_call_id);
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, cron TEXT NOT NULL, prompt TEXT NOT NULL,
    channel_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE secrets (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, type TEXT NOT NULL, actor_id TEXT, agent_id TEXT,
    run_id TEXT, channel_id TEXT, data TEXT NOT NULL
  );
  CREATE INDEX events_agent ON events(agent_id, id);
  CREATE INDEX events_run ON events(run_id, id);
  `,
  // 2: threads and file attachments
  `
  ALTER TABLE messages ADD COLUMN thread_id TEXT;
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  CREATE INDEX messages_thread ON messages(thread_id, created_at);
  ALTER TABLE runs ADD COLUMN thread_id TEXT;
  ALTER TABLE inbox ADD COLUMN thread_id TEXT;
  `,
  // 3: spending budgets (spend is summed from cost events by time)
  `
  ALTER TABLE agents ADD COLUMN budget TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX events_type_ts ON events(type, ts);
  `,
  // 4: skills
  `
  ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '["*"]';
  ALTER TABLE schedules ADD COLUMN skill TEXT;
  `,
  // 5: webhook and read-only routines, stalled-task follow-ups, channel leads
  `
  ALTER TABLE schedules ADD COLUMN trigger TEXT NOT NULL DEFAULT 'schedule';
  ALTER TABLE schedules ADD COLUMN token TEXT;
  ALTER TABLE schedules ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE inbox ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN nudged_at TEXT;
  ALTER TABLE channels ADD COLUMN lead_agent_id TEXT;
  `,
  // 6: computer setup scripts and base images
  `
  ALTER TABLE agents ADD COLUMN setup_script TEXT NOT NULL DEFAULT '';
  ALTER TABLE agents ADD COLUMN computer_image TEXT;
  `,
  // 7: messaging bridges remember which outside message stands for which conversation or approval
  `
  CREATE TABLE bridge_links (
    platform TEXT NOT NULL, external_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, channel_id TEXT, thread_id TEXT, created_at TEXT NOT NULL,
    PRIMARY KEY (platform, external_id)
  );
  CREATE INDEX bridge_links_ref ON bridge_links(platform, kind, ref);
  `,
  // 8: full desktop control is opt-in per agent
  `
  ALTER TABLE agents ADD COLUMN desktop INTEGER NOT NULL DEFAULT 0;
  `,
  // 9: per-agent internet access (open, or an allowlist enforced by the egress proxy)
  `
  ALTER TABLE agents ADD COLUMN network TEXT NOT NULL DEFAULT '{"mode":"open","allow":[]}';
  `,
  // 10: settings for email, Slack and calendar routine triggers
  `
  ALTER TABLE schedules ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
  `,
  // 11: short-lived helper agents point at the agent that started them
  `
  ALTER TABLE agents ADD COLUMN parent_id TEXT;
  `,
  // 12: team mode: roles, passwords, sign-in sessions and invite links (tokens are stored hashed)
  `
  ALTER TABLE humans ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
  ALTER TABLE humans ADD COLUMN password_hash TEXT;
  ALTER TABLE humans ADD COLUMN removed_at TEXT;
  UPDATE humans SET role = 'owner' WHERE id = (SELECT id FROM humans ORDER BY created_at LIMIT 1);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, human_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE INDEX sessions_human ON sessions (human_id);
  CREATE TABLE invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_by TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_by TEXT, used_at TEXT);
  `,
  // 13: which agent each helper belonged to, kept after the helper is removed so its spend stays on the parent's budget
  `
  CREATE TABLE helper_lineage (agent_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);
  CREATE INDEX helper_lineage_parent ON helper_lineage (parent_id);
  INSERT OR IGNORE INTO helper_lineage (agent_id, parent_id) SELECT id, parent_id FROM agents WHERE parent_id IS NOT NULL;
  INSERT OR IGNORE INTO helper_lineage (agent_id, parent_id)
    SELECT json_extract(data, '$.agent.id'), json_extract(data, '$.parentId') FROM events
    WHERE type = 'agent.created' AND json_extract(data, '$.parentId') IS NOT NULL AND json_extract(data, '$.agent.id') IS NOT NULL;
  `,
  // 14: a DM stays between the two members it was opened with. Posting used to add whoever spoke in one (an agent
  // named there, a helper, a task's assignee), after which the pair got a new, empty DM. Give each DM back the members
  // its creation event lists, then fold every later DM of the same pair into the oldest one.
  // Plus: messages each run posted, and runs by conversation, for what agents sent elsewhere while working in one.
  `
  DELETE FROM channel_members
  WHERE channel_id IN (SELECT id FROM channels WHERE kind = 'dm')
    AND EXISTS (SELECT 1 FROM events e WHERE e.type = 'channel.created' AND e.channel_id = channel_members.channel_id)
    AND member_id NOT IN (
      SELECT j.value FROM events e, json_each(e.data, '$.channel.memberIds') j
      WHERE e.type = 'channel.created' AND e.channel_id = channel_members.channel_id
    );
  CREATE TEMP TABLE dm_merge AS
    WITH pair AS (
      SELECT c.id, c.created_at,
        (SELECT group_concat(member_id, ',' ORDER BY member_id) FROM channel_members m WHERE m.channel_id = c.id) AS members,
        (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) AS size
      FROM channels c WHERE c.kind = 'dm'
    )
    SELECT p.id AS dup, (SELECT k.id FROM pair k WHERE k.size = 2 AND k.members = p.members ORDER BY k.created_at, k.id LIMIT 1) AS keep
    FROM pair p WHERE p.size = 2;
  DELETE FROM dm_merge WHERE dup = keep;
  UPDATE messages SET channel_id = (SELECT keep FROM dm_merge WHERE dup = messages.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE tasks SET channel_id = (SELECT keep FROM dm_merge WHERE dup = tasks.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE runs SET channel_id = (SELECT keep FROM dm_merge WHERE dup = runs.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE inbox SET channel_id = (SELECT keep FROM dm_merge WHERE dup = inbox.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE approvals SET channel_id = (SELECT keep FROM dm_merge WHERE dup = approvals.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE schedules SET channel_id = (SELECT keep FROM dm_merge WHERE dup = schedules.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE bridge_links SET channel_id = (SELECT keep FROM dm_merge WHERE dup = bridge_links.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE events SET channel_id = (SELECT keep FROM dm_merge WHERE dup = events.channel_id) WHERE channel_id IN (SELECT dup FROM dm_merge);
  UPDATE settings SET value = (SELECT replace(settings.value, dup, keep) FROM dm_merge WHERE instr(settings.value, dup) > 0)
    WHERE key LIKE '%_last_target' AND EXISTS (SELECT 1 FROM dm_merge WHERE instr(settings.value, dup) > 0);
  DELETE FROM channel_members WHERE channel_id IN (SELECT dup FROM dm_merge);
  DELETE FROM channels WHERE id IN (SELECT dup FROM dm_merge);
  DROP TABLE dm_merge;
  CREATE INDEX messages_run ON messages(run_id);
  CREATE INDEX runs_channel ON runs(channel_id, created_at);
  `,
];

type Row = Record<string, SQLInputValue>;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const paramNames = new Map<string, Set<string>>();
function namesIn(sql: string): Set<string> {
  let names = paramNames.get(sql);
  if (!names) {
    names = new Set([...sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
    paramNames.set(sql, names);
  }
  return names;
}

/** node:sqlite rejects unknown names, undefined and booleans, so pass only what the statement uses, converted. */
function params(sql: string, obj: Record<string, unknown>): Row {
  const out: Row = {};
  const wanted = namesIn(sql);
  for (const [k, v] of Object.entries(obj)) {
    if (!wanted.has(k)) continue;
    if (v === undefined || v === null) out[k] = null;
    else if (typeof v === 'boolean') out[k] = v ? 1 : 0;
    else if (typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v as SQLInputValue;
  }
  return out;
}

const toHuman = (r: Row): Human => ({
  id: String(r.id),
  kind: 'human',
  name: String(r.name),
  role: r.role === 'owner' ? 'owner' : 'member',
  removed: !!r.removed_at,
  createdAt: String(r.created_at),
});
const toInvite = (r: Row): Invite => ({
  id: String(r.id),
  role: r.role === 'owner' ? 'owner' : 'member',
  createdBy: String(r.created_by),
  createdAt: String(r.created_at),
  expiresAt: String(r.expires_at),
});

const toAgent = (r: Row): Agent => ({
  id: String(r.id),
  kind: 'agent',
  name: String(r.name),
  role: String(r.role),
  instructions: String(r.instructions),
  model: String(r.model),
  avatar: String(r.avatar),
  color: String(r.color),
  status: r.status as Agent['status'],
  paused: Number(r.paused) === 1,
  takeoverBy: (r.takeover_by as string) ?? null,
  mcpServers: json<string[]>(r.mcp_servers, []),
  skills: json<string[]>(r.skills, ['*']),
  budget: { ...NO_BUDGET, ...json<Partial<Agent['budget']>>(r.budget, {}) },
  setupScript: String(r.setup_script ?? ''),
  computerImage: (r.computer_image as string) || null,
  desktop: Number(r.desktop) === 1,
  network: { ...OPEN_NETWORK, ...json<Partial<Agent['network']>>(r.network, {}) },
  parentId: (r.parent_id as string) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toMessage = (r: Row): Message => ({
  id: String(r.id),
  channelId: String(r.channel_id),
  authorId: String(r.author_id),
  text: String(r.text),
  createdAt: String(r.created_at),
  runId: (r.run_id as string) ?? null,
  depth: Number(r.depth),
  mentions: json<string[]>(r.mentions, []),
  attachments: json<Message['attachments']>(r.attachments, []),
  threadId: (r.thread_id as string) ?? null,
  ...(r.reply_count !== undefined && { replyCount: Number(r.reply_count), lastReplyAt: (r.last_reply_at as string) ?? null }),
});

const toTask = (r: Row): Task => ({
  id: String(r.id),
  number: Number(r.number),
  title: String(r.title),
  description: String(r.description),
  status: r.status as Task['status'],
  assigneeId: (r.assignee_id as string) ?? null,
  creatorId: String(r.creator_id),
  channelId: (r.channel_id as string) ?? null,
  dependsOn: json<number[]>(r.depends_on, []),
  notes: json<Task['notes']>(r.notes, []),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toRun = (r: Row): Run => ({
  id: String(r.id),
  agentId: String(r.agent_id),
  status: r.status as RunStatus,
  channelId: (r.channel_id as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
  initiator: r.initiator as Run['initiator'],
  readOnly: Number(r.read_only) === 1,
  depth: Number(r.depth),
  title: String(r.title),
  steps: Number(r.steps),
  tokensIn: Number(r.tokens_in),
  tokensOut: Number(r.tokens_out),
  costUsd: Number(r.cost_usd),
  error: (r.error as string) ?? null,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toInbox = (r: Row): InboxItem => ({
  id: String(r.id),
  agentId: String(r.agent_id),
  kind: r.kind as InboxItem['kind'],
  text: String(r.text),
  channelId: (r.channel_id as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
  taskNumber: r.task_number === null ? null : Number(r.task_number),
  depth: Number(r.depth),
  initiator: r.initiator as InboxItem['initiator'],
  readOnly: Number(r.read_only) === 1,
  createdAt: String(r.created_at),
  runId: (r.run_id as string) ?? null,
});

const toApproval = (r: Row): Approval => ({
  id: String(r.id),
  agentId: String(r.agent_id),
  runId: String(r.run_id),
  toolCallId: String(r.tool_call_id),
  kind: r.kind as Approval['kind'],
  tool: String(r.tool),
  args: json<Record<string, unknown>>(r.args, {}),
  summary: String(r.summary),
  reason: String(r.reason),
  channelId: (r.channel_id as string) ?? null,
  status: r.status as ApprovalStatus,
  note: (r.note as string) ?? null,
  resolvedBy: (r.resolved_by as string) ?? null,
  createdAt: String(r.created_at),
  resolvedAt: (r.resolved_at as string) ?? null,
});

const toSchedule = (r: Row): Schedule => ({
  id: String(r.id),
  agentId: String(r.agent_id),
  name: String(r.name),
  trigger: (r.trigger as Schedule['trigger']) ?? 'schedule',
  config: json<Schedule['config']>(r.config, {}),
  cron: String(r.cron),
  prompt: String(r.prompt),
  skill: (r.skill as string) ?? null,
  readOnly: Number(r.read_only) === 1,
  token: (r.token as string) ?? null,
  channelId: (r.channel_id as string) ?? null,
  enabled: Number(r.enabled) === 1,
  lastRunAt: (r.last_run_at as string) ?? null,
  nextRunAt: null,
  createdAt: String(r.created_at),
});

const toEvent = (r: Row): EventRecord => ({
  id: Number(r.id),
  ts: String(r.ts),
  type: String(r.type),
  actorId: (r.actor_id as string) ?? null,
  agentId: (r.agent_id as string) ?? null,
  runId: (r.run_id as string) ?? null,
  channelId: (r.channel_id as string) ?? null,
  data: json<Record<string, unknown>>(r.data, {}),
});

export interface BridgeLink {
  platform: string;
  externalId: string;
  kind: 'message' | 'approval';
  /** Approval id for approval links. */
  ref: string | null;
  channelId: string | null;
  threadId: string | null;
}

const toLink = (r: Row): BridgeLink => ({
  platform: String(r.platform),
  externalId: String(r.external_id),
  kind: r.kind as BridgeLink['kind'],
  ref: (r.ref as string) ?? null,
  channelId: (r.channel_id as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
});

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as Row | undefined;
    let version = row ? Number(row.value) : 0;
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        version += 1;
        this.db
          .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(String(version));
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private statements = new Map<string, StatementSync>();
  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }
  private all(sql: string, p: Record<string, unknown> = {}): Row[] {
    return this.stmt(sql).all(params(sql, p)) as Row[];
  }
  private get(sql: string, p: Record<string, unknown> = {}): Row | undefined {
    return this.stmt(sql).get(params(sql, p)) as Row | undefined;
  }
  private run(sql: string, p: Record<string, unknown> = {}) {
    return this.stmt(sql).run(params(sql, p));
  }

  close() {
    this.db.close();
  }

  // ── humans ────────────────────────────────────────────────────────────
  createHuman(name: string, role: HumanRole = 'member'): Human {
    const h: Human = { id: newId('hum'), kind: 'human', name, role, removed: false, createdAt: now() };
    this.run('INSERT INTO humans (id, name, role, created_at) VALUES (:id, :name, :role, :createdAt)', h as unknown as Record<string, unknown>);
    return h;
  }
  /** People in the workspace now. Removed teammates keep their row so old messages still show their name. */
  listHumans(): Human[] {
    return this.all('SELECT * FROM humans WHERE removed_at IS NULL ORDER BY created_at').map(toHuman);
  }
  getHuman(id: string): Human | undefined {
    const r = this.get('SELECT * FROM humans WHERE id = :id', { id });
    return r && toHuman(r);
  }
  renameHuman(id: string, name: string) {
    this.run('UPDATE humans SET name = :name WHERE id = :id', { id, name });
  }
  passwordHash(id: string): string | undefined {
    const r = this.get('SELECT password_hash FROM humans WHERE id = :id AND removed_at IS NULL', { id });
    return r?.password_hash ? String(r.password_hash) : undefined;
  }
  setPasswordHash(id: string, hash: string | null) {
    this.run('UPDATE humans SET password_hash = :hash WHERE id = :id', { id, hash });
  }
  removeHuman(id: string) {
    this.tx(() => {
      this.run('UPDATE humans SET removed_at = :at, password_hash = NULL WHERE id = :id', { id, at: now() });
      this.run('DELETE FROM sessions WHERE human_id = :id', { id });
    });
  }

  // ── sign-in sessions and invites (team mode) ──────────────────────────
  createSession(id: string, humanId: string, expiresAt: string) {
    this.run('INSERT INTO sessions (id, human_id, created_at, expires_at) VALUES (:id, :humanId, :at, :expiresAt)', { id, humanId, at: now(), expiresAt });
  }
  getSession(id: string): { humanId: string; createdAt: string; expiresAt: string } | undefined {
    const r = this.get('SELECT * FROM sessions WHERE id = :id', { id });
    return r && { humanId: String(r.human_id), createdAt: String(r.created_at), expiresAt: String(r.expires_at) };
  }
  extendSession(id: string, expiresAt: string) {
    this.run('UPDATE sessions SET expires_at = :expiresAt WHERE id = :id', { id, expiresAt });
  }
  deleteSession(id: string) {
    this.run('DELETE FROM sessions WHERE id = :id', { id });
  }
  /** Signs a person out everywhere (or everyone, without an id), optionally keeping one session. */
  deleteSessions(humanId?: string, except?: string) {
    this.run('DELETE FROM sessions WHERE (:humanId IS NULL OR human_id = :humanId) AND (:except IS NULL OR id != :except)', { humanId, except });
  }
  createInvite(tokenHash: string, role: HumanRole, createdBy: string, expiresAt: string): Invite {
    const id = newId('inv');
    this.run(
      'INSERT INTO invites (id, token_hash, role, created_by, created_at, expires_at) VALUES (:id, :tokenHash, :role, :createdBy, :at, :expiresAt)',
      { id, tokenHash, role, createdBy, at: now(), expiresAt },
    );
    return this.listInvites().find((i) => i.id === id)!;
  }
  /** Invites nobody has used yet (expired ones too, until they are revoked). */
  listInvites(): Invite[] {
    return this.all('SELECT * FROM invites WHERE used_at IS NULL ORDER BY created_at').map(toInvite);
  }
  getInviteByToken(tokenHash: string): Invite | undefined {
    const r = this.get('SELECT * FROM invites WHERE token_hash = :tokenHash AND used_at IS NULL', { tokenHash });
    return r && toInvite(r);
  }
  useInvite(id: string, humanId: string) {
    this.run('UPDATE invites SET used_by = :humanId, used_at = :at WHERE id = :id', { id, humanId, at: now() });
  }
  deleteInvite(id: string) {
    this.run('DELETE FROM invites WHERE id = :id AND used_at IS NULL', { id });
  }
  deleteUnusedInvites() {
    this.run('DELETE FROM invites WHERE used_at IS NULL', {});
  }

  // ── agents ────────────────────────────────────────────────────────────
  createAgent(
    input: Omit<Agent, 'id' | 'kind' | 'status' | 'paused' | 'takeoverBy' | 'createdAt' | 'updatedAt' | 'budget' | 'skills' | 'setupScript' | 'computerImage' | 'desktop' | 'network' | 'parentId'> &
      Partial<Pick<Agent, 'budget' | 'skills' | 'setupScript' | 'computerImage' | 'desktop' | 'network' | 'parentId'>>,
  ): Agent {
    const t = now();
    const agent: Agent = {
      ...input,
      skills: input.skills ?? ['*'],
      budget: input.budget ?? { ...NO_BUDGET },
      setupScript: input.setupScript ?? '',
      computerImage: input.computerImage ?? null,
      desktop: input.desktop ?? false,
      network: input.network ?? { ...OPEN_NETWORK },
      parentId: input.parentId ?? null,
      id: newId('agt'),
      kind: 'agent',
      status: 'idle',
      paused: false,
      takeoverBy: null,
      createdAt: t,
      updatedAt: t,
    };
    this.run(
      `INSERT INTO agents (id, name, role, instructions, model, avatar, color, status, paused, takeover_by, mcp_servers, skills, budget, setup_script, computer_image, desktop, network, parent_id, created_at, updated_at)
       VALUES (:id, :name, :role, :instructions, :model, :avatar, :color, :status, :paused, :takeoverBy, :mcpServers, :skills, :budget, :setupScript, :computerImage, :desktop, :network, :parentId, :createdAt, :updatedAt)`,
      agent as unknown as Record<string, unknown>,
    );
    if (agent.parentId) this.run('INSERT OR IGNORE INTO helper_lineage (agent_id, parent_id) VALUES (:id, :parentId)', { id: agent.id, parentId: agent.parentId });
    return agent;
  }
  updateAgent(id: string, patch: Partial<Omit<Agent, 'id' | 'kind' | 'createdAt'>>): Agent {
    const current = this.getAgent(id);
    if (!current) throw new Error(`agent ${id} not found`);
    const next: Agent = { ...current, ...patch, updatedAt: now() };
    this.run(
      `UPDATE agents SET name = :name, role = :role, instructions = :instructions, model = :model, avatar = :avatar, color = :color,
       status = :status, paused = :paused, takeover_by = :takeoverBy, mcp_servers = :mcpServers, skills = :skills, budget = :budget,
       setup_script = :setupScript, computer_image = :computerImage, desktop = :desktop, network = :network, updated_at = :updatedAt WHERE id = :id`,
      next as unknown as Record<string, unknown>,
    );
    return next;
  }
  getAgent(id: string): Agent | undefined {
    const r = this.get('SELECT * FROM agents WHERE id = :id', { id });
    return r && toAgent(r);
  }
  getAgentByName(name: string): Agent | undefined {
    const r = this.get('SELECT * FROM agents WHERE name = :name COLLATE NOCASE', { name });
    return r && toAgent(r);
  }
  listAgents(): Agent[] {
    return this.all('SELECT * FROM agents ORDER BY created_at').map(toAgent);
  }
  deleteAgent(id: string) {
    this.tx(() => {
      this.run('DELETE FROM agents WHERE id = :id', { id });
      this.run('DELETE FROM channel_members WHERE member_id = :id', { id });
      this.run('DELETE FROM inbox WHERE agent_id = :id', { id });
      this.run('DELETE FROM schedules WHERE agent_id = :id', { id });
      this.run(`UPDATE tasks SET assignee_id = NULL WHERE assignee_id = :id`, { id });
      this.run(`UPDATE channels SET lead_agent_id = NULL WHERE lead_agent_id = :id`, { id });
    });
  }

  // ── channels ──────────────────────────────────────────────────────────
  createChannel(input: { name: string; kind: Channel['kind']; topic?: string; memberIds: string[] }): Channel {
    const ch: Channel = { id: newId('chn'), name: input.name, kind: input.kind, topic: input.topic ?? '', memberIds: [], leadAgentId: null, createdAt: now() };
    this.tx(() => {
      this.run('INSERT INTO channels (id, name, kind, topic, created_at) VALUES (:id, :name, :kind, :topic, :createdAt)', ch as unknown as Record<string, unknown>);
      for (const m of input.memberIds) this.addMember(ch.id, m);
    });
    return { ...ch, memberIds: [...new Set(input.memberIds)] };
  }
  private membersOf(channelId: string): string[] {
    return this.all('SELECT member_id FROM channel_members WHERE channel_id = :channelId', { channelId }).map((r) => String(r.member_id));
  }
  getChannel(id: string): Channel | undefined {
    const r = this.get('SELECT * FROM channels WHERE id = :id', { id });
    if (!r) return undefined;
    return {
      id: String(r.id),
      name: String(r.name),
      kind: r.kind as Channel['kind'],
      topic: String(r.topic),
      memberIds: this.membersOf(String(r.id)),
      leadAgentId: (r.lead_agent_id as string) ?? null,
      createdAt: String(r.created_at),
    };
  }
  getChannelByName(name: string): Channel | undefined {
    const r = this.get(`SELECT id FROM channels WHERE kind = 'channel' AND name = :name COLLATE NOCASE`, { name });
    return r ? this.getChannel(String(r.id)) : undefined;
  }
  listChannels(): Channel[] {
    return this.all('SELECT id FROM channels ORDER BY created_at').map((r) => this.getChannel(String(r.id))!);
  }
  updateChannel(id: string, patch: { name?: string; topic?: string; leadAgentId?: string | null }) {
    const ch = this.getChannel(id);
    if (!ch) throw new Error('channel not found');
    this.run('UPDATE channels SET name = :name, topic = :topic, lead_agent_id = :lead WHERE id = :id', {
      id,
      name: patch.name ?? ch.name,
      topic: patch.topic ?? ch.topic,
      lead: patch.leadAgentId === undefined ? ch.leadAgentId : patch.leadAgentId,
    });
  }
  addMember(channelId: string, memberId: string) {
    this.run('INSERT OR IGNORE INTO channel_members (channel_id, member_id) VALUES (:channelId, :memberId)', { channelId, memberId });
  }
  removeMember(channelId: string, memberId: string) {
    this.run('DELETE FROM channel_members WHERE channel_id = :channelId AND member_id = :memberId', { channelId, memberId });
  }
  findDm(a: string, b: string): Channel | undefined {
    const r = this.get(
      `SELECT c.id FROM channels c
       WHERE c.kind = 'dm'
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.member_id = :a)
         AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.member_id = :b)
         AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = :n`,
      { a, b, n: a === b ? 1 : 2 },
    );
    return r ? this.getChannel(String(r.id)) : undefined;
  }

  // ── messages ──────────────────────────────────────────────────────────
  insertMessage(m: Omit<Message, 'id' | 'createdAt' | 'replyCount' | 'lastReplyAt'>): Message {
    const msg: Message = { ...m, id: newId('msg'), createdAt: now() };
    this.run(
      `INSERT INTO messages (id, channel_id, author_id, text, created_at, run_id, depth, mentions, attachments, thread_id)
       VALUES (:id, :channelId, :authorId, :text, :createdAt, :runId, :depth, :mentions, :attachments, :threadId)`,
      msg as unknown as Record<string, unknown>,
    );
    return msg;
  }
  getMessage(id: string): Message | undefined {
    const r = this.get('SELECT * FROM messages WHERE id = :id', { id });
    return r && toMessage(r);
  }
  /** Every message in a channel, threads included, newest last (what agents read). */
  listMessages(channelId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const rows = this.all(
      `SELECT * FROM messages WHERE channel_id = :channelId ${opts.before ? 'AND created_at < :before' : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT :limit`,
      { channelId, before: opts.before, limit: opts.limit ?? 50 },
    );
    return rows.map(toMessage).reverse();
  }
  /** Top-level messages with their thread reply counts (what the channel view shows). */
  listTopLevel(channelId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const rows = this.all(
      `SELECT m.*,
         (SELECT COUNT(*) FROM messages r WHERE r.thread_id = m.id) AS reply_count,
         (SELECT MAX(created_at) FROM messages r WHERE r.thread_id = m.id) AS last_reply_at
       FROM messages m WHERE m.channel_id = :channelId AND m.thread_id IS NULL ${opts.before ? 'AND m.created_at < :before' : ''}
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT :limit`,
      { channelId, before: opts.before, limit: opts.limit ?? 50 },
    );
    return rows.map(toMessage).reverse();
  }
  /** What agents posted in other conversations while working in this one (messaging a teammate), oldest first. */
  listSentElsewhere(channelId: string, opts: { limit?: number } = {}): Message[] {
    const rows = this.all(
      `SELECT m.* FROM runs r JOIN messages m ON m.run_id = r.id
       WHERE r.channel_id = :channelId AND m.channel_id != :channelId
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT :limit`,
      { channelId, limit: opts.limit ?? 60 },
    );
    return rows.map(toMessage).reverse();
  }
  /** Messages that carry files, newest first: everything one member shared, or everything shared in one channel. */
  listWithAttachments(opts: { authorId?: string; channelId?: string; limit?: number }): Message[] {
    const where = ["attachments != '[]'"];
    if (opts.authorId) where.push('author_id = :authorId');
    if (opts.channelId) where.push('channel_id = :channelId');
    return this.all(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT :limit`, {
      authorId: opts.authorId,
      channelId: opts.channelId,
      limit: opts.limit ?? 200,
    }).map(toMessage);
  }
  /** Messages containing every term (case-insensitive), newest first. */
  searchMessages(terms: string[], opts: { limit?: number; before?: string } = {}): Message[] {
    if (!terms.length) return [];
    const p: Record<string, unknown> = { limit: opts.limit ?? 30, before: opts.before };
    terms.forEach((t, i) => (p[`q${i}`] = `%${likeEscape(t)}%`));
    return this.all(
      `SELECT * FROM messages WHERE ${terms.map((_, i) => `text LIKE :q${i} ESCAPE '\\'`).join(' AND ')}
       ${opts.before ? 'AND created_at < :before' : ''} ORDER BY created_at DESC LIMIT :limit`,
      p,
    ).map(toMessage);
  }
  /** Tasks whose title, description or notes contain every term. */
  searchTasks(terms: string[], limit = 20): Task[] {
    if (!terms.length) return [];
    const p: Record<string, unknown> = { limit };
    terms.forEach((t, i) => (p[`q${i}`] = `%${likeEscape(t)}%`));
    return this.all(
      `SELECT * FROM tasks WHERE ${terms.map((_, i) => `(title || ' ' || description || ' ' || notes) LIKE :q${i} ESCAPE '\\'`).join(' AND ')}
       ORDER BY updated_at DESC LIMIT :limit`,
      p,
    ).map(toTask);
  }

  /** A thread's replies, oldest first (the root is not included). */
  listThread(rootId: string, opts: { before?: string; limit?: number } = {}): Message[] {
    const rows = this.all(
      `SELECT * FROM messages WHERE thread_id = :rootId ${opts.before ? 'AND created_at < :before' : ''}
       ORDER BY created_at DESC, rowid DESC LIMIT :limit`,
      { rootId, before: opts.before, limit: opts.limit ?? 200 },
    );
    return rows.map(toMessage).reverse();
  }

  // ── tasks ─────────────────────────────────────────────────────────────
  createTask(input: Omit<Task, 'id' | 'number' | 'notes' | 'createdAt' | 'updatedAt'>): Task {
    return this.tx(() => {
      const max = this.get('SELECT COALESCE(MAX(number), 0) AS n FROM tasks');
      // Numbers of deleted tasks are never handed out again: old messages and transcripts still say "#5".
      const last = Math.max(Number(max?.n ?? 0), Number(this.getSetting(LAST_TASK_NUMBER) ?? 0));
      const t = now();
      const task: Task = { ...input, id: newId('tsk'), number: last + 1, notes: [], createdAt: t, updatedAt: t };
      this.run(
        `INSERT INTO tasks (id, number, title, description, status, assignee_id, creator_id, channel_id, depends_on, notes, created_at, updated_at)
         VALUES (:id, :number, :title, :description, :status, :assigneeId, :creatorId, :channelId, :dependsOn, :notes, :createdAt, :updatedAt)`,
        task as unknown as Record<string, unknown>,
      );
      return task;
    });
  }
  getTask(id: string): Task | undefined {
    const r = this.get('SELECT * FROM tasks WHERE id = :id', { id });
    return r && toTask(r);
  }
  getTaskByNumber(number: number): Task | undefined {
    const r = this.get('SELECT * FROM tasks WHERE number = :number', { number });
    return r && toTask(r);
  }
  listTasks(): Task[] {
    return this.all('SELECT * FROM tasks ORDER BY number').map(toTask);
  }
  /** Open tasks untouched since `cutoff` that nobody has followed up on since their last update. */
  staleTasks(cutoff: string): Task[] {
    return this.all(
      `SELECT * FROM tasks WHERE status IN ('todo', 'in_progress', 'blocked') AND assignee_id IS NOT NULL
       AND updated_at < :cutoff AND (nudged_at IS NULL OR nudged_at < updated_at) ORDER BY number`,
      { cutoff },
    ).map(toTask);
  }
  markNudged(id: string) {
    this.run('UPDATE tasks SET nudged_at = :at WHERE id = :id', { id, at: now() });
  }

  saveTask(task: Task): Task {
    const next = { ...task, updatedAt: now() };
    this.run(
      `UPDATE tasks SET title = :title, description = :description, status = :status, assignee_id = :assigneeId, channel_id = :channelId,
       depends_on = :dependsOn, notes = :notes, updated_at = :updatedAt WHERE id = :id`,
      next as unknown as Record<string, unknown>,
    );
    return next;
  }

  /** Delete a task for good. Tasks that depended on it lose that dependency (returned, updated) and unread inbox items about it are dropped. */
  deleteTask(number: number): Task[] {
    return this.tx(() => {
      const last = Math.max(number, Number(this.getSetting(LAST_TASK_NUMBER) ?? 0));
      this.setSetting(LAST_TASK_NUMBER, String(last));
      this.run('DELETE FROM tasks WHERE number = :number', { number });
      this.run('DELETE FROM inbox WHERE task_number = :number AND run_id IS NULL', { number });
      return this.listTasks()
        .filter((t) => t.dependsOn.includes(number))
        .map((t) => this.saveTask({ ...t, dependsOn: t.dependsOn.filter((n) => n !== number) }));
    });
  }

  // ── runs ──────────────────────────────────────────────────────────────
  createRun(input: Pick<Run, 'agentId' | 'channelId' | 'initiator' | 'depth' | 'title'> & { threadId?: string | null; readOnly?: boolean }): Run {
    const t = now();
    const run: Run = {
      ...input,
      threadId: input.threadId ?? null,
      readOnly: input.readOnly ?? false,
      id: newId('run'),
      status: 'queued',
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      error: null,
      createdAt: t,
      updatedAt: t,
    };
    this.tx(() => {
      this.run(
        `INSERT INTO runs (id, agent_id, status, channel_id, thread_id, initiator, read_only, depth, title, steps, tokens_in, tokens_out, cost_usd, error, created_at, updated_at)
         VALUES (:id, :agentId, :status, :channelId, :threadId, :initiator, :readOnly, :depth, :title, :steps, :tokensIn, :tokensOut, :costUsd, :error, :createdAt, :updatedAt)`,
        run as unknown as Record<string, unknown>,
      );
      this.run('INSERT INTO run_transcripts (run_id, transcript) VALUES (:id, :t)', { id: run.id, t: '[]' });
    });
    return run;
  }
  getRun(id: string): Run | undefined {
    const r = this.get('SELECT * FROM runs WHERE id = :id', { id });
    return r && toRun(r);
  }
  updateRun(id: string, patch: Partial<Omit<Run, 'id' | 'agentId' | 'createdAt'>>): Run {
    const cur = this.getRun(id);
    if (!cur) throw new Error(`run ${id} not found`);
    const next: Run = { ...cur, ...patch, updatedAt: now() };
    this.run(
      `UPDATE runs SET status = :status, channel_id = :channelId, thread_id = :threadId, initiator = :initiator, read_only = :readOnly, depth = :depth, title = :title, steps = :steps,
       tokens_in = :tokensIn, tokens_out = :tokensOut, cost_usd = :costUsd, error = :error, updated_at = :updatedAt WHERE id = :id`,
      next as unknown as Record<string, unknown>,
    );
    return next;
  }
  listRuns(opts: { agentId?: string; statuses?: RunStatus[]; limit?: number } = {}): Run[] {
    const where: string[] = [];
    if (opts.agentId) where.push('agent_id = :agentId');
    if (opts.statuses?.length) where.push(`status IN (${opts.statuses.map((s) => `'${s}'`).join(',')})`);
    return this.all(`SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT :limit`, {
      agentId: opts.agentId,
      limit: opts.limit ?? 50,
    }).map(toRun);
  }
  /** These runs (unknown ids are skipped), each with how many tool calls it made. */
  runSummaries(ids: string[]): RunSummary[] {
    if (!ids.length) return [];
    const params: Record<string, string> = {};
    ids.forEach((id, i) => (params[`id${i}`] = id));
    return this.all(
      `SELECT r.*, (SELECT COUNT(*) FROM events e WHERE e.run_id = r.id AND e.type = 'tool.checked') AS tool_calls
       FROM runs r WHERE r.id IN (${ids.map((_, i) => `:id${i}`).join(',')})`,
      params,
    ).map((r) => ({ ...toRun(r), toolCalls: Number(r.tool_calls) }));
  }
  getTranscript<T>(runId: string): T[] {
    return json<T[]>(this.get('SELECT transcript FROM run_transcripts WHERE run_id = :runId', { runId })?.transcript, []);
  }
  setTranscript(runId: string, transcript: unknown[]) {
    this.run('UPDATE run_transcripts SET transcript = :t WHERE run_id = :runId', { runId, t: JSON.stringify(transcript) });
  }

  // ── inbox ─────────────────────────────────────────────────────────────
  addInbox(input: Omit<InboxItem, 'id' | 'createdAt' | 'runId' | 'threadId' | 'readOnly'> & { threadId?: string | null; readOnly?: boolean }): InboxItem {
    const item: InboxItem = { ...input, threadId: input.threadId ?? null, readOnly: input.readOnly ?? false, id: newId('inb'), createdAt: now(), runId: null };
    this.run(
      `INSERT INTO inbox (id, agent_id, kind, text, channel_id, thread_id, task_number, depth, initiator, read_only, created_at, run_id)
       VALUES (:id, :agentId, :kind, :text, :channelId, :threadId, :taskNumber, :depth, :initiator, :readOnly, :createdAt, :runId)`,
      item as unknown as Record<string, unknown>,
    );
    return item;
  }
  pendingInbox(agentId: string): InboxItem[] {
    return this.all('SELECT * FROM inbox WHERE agent_id = :agentId AND run_id IS NULL ORDER BY created_at, rowid', { agentId }).map(toInbox);
  }
  consumeInbox(ids: string[], runId: string) {
    for (const id of ids) this.run('UPDATE inbox SET run_id = :runId WHERE id = :id', { id, runId });
  }

  // ── approvals ─────────────────────────────────────────────────────────
  createApproval(input: Omit<Approval, 'id' | 'status' | 'note' | 'resolvedBy' | 'createdAt' | 'resolvedAt'>): Approval {
    const a: Approval = { ...input, id: newId('apr'), status: 'pending', note: null, resolvedBy: null, createdAt: now(), resolvedAt: null };
    this.run(
      `INSERT INTO approvals (id, agent_id, run_id, tool_call_id, kind, tool, args, summary, reason, channel_id, status, note, resolved_by, created_at, resolved_at)
       VALUES (:id, :agentId, :runId, :toolCallId, :kind, :tool, :args, :summary, :reason, :channelId, :status, :note, :resolvedBy, :createdAt, :resolvedAt)`,
      a as unknown as Record<string, unknown>,
    );
    return a;
  }
  getApproval(id: string): Approval | undefined {
    const r = this.get('SELECT * FROM approvals WHERE id = :id', { id });
    return r && toApproval(r);
  }
  findApproval(runId: string, toolCallId: string): Approval | undefined {
    const r = this.get('SELECT * FROM approvals WHERE run_id = :runId AND tool_call_id = :toolCallId ORDER BY created_at DESC LIMIT 1', { runId, toolCallId });
    return r && toApproval(r);
  }
  listApprovals(opts: { status?: ApprovalStatus; limit?: number } = {}): Approval[] {
    return this.all(`SELECT * FROM approvals ${opts.status ? 'WHERE status = :status' : ''} ORDER BY created_at DESC LIMIT :limit`, {
      status: opts.status,
      limit: opts.limit ?? 100,
    }).map(toApproval);
  }
  resolveApproval(id: string, status: ApprovalStatus, by: string | null, note: string | null): Approval {
    this.run('UPDATE approvals SET status = :status, resolved_by = :by, note = :note, resolved_at = :at WHERE id = :id', { id, status, by, note, at: now() });
    return this.getApproval(id)!;
  }
  cancelPendingApprovals(runId: string): Approval[] {
    const pending = this.all(`SELECT * FROM approvals WHERE run_id = :runId AND status = 'pending'`, { runId }).map(toApproval);
    for (const a of pending) this.resolveApproval(a.id, 'cancelled', null, null);
    return pending;
  }

  // ── schedules ─────────────────────────────────────────────────────────
  createSchedule(
    input: Omit<Schedule, 'id' | 'lastRunAt' | 'nextRunAt' | 'createdAt' | 'skill' | 'trigger' | 'readOnly' | 'token' | 'config' | 'hasSecret'> &
      Partial<Pick<Schedule, 'skill' | 'trigger' | 'readOnly' | 'token' | 'config'>>,
  ): Schedule {
    const s: Schedule = {
      ...input,
      trigger: input.trigger ?? 'schedule',
      config: input.config ?? {},
      skill: input.skill ?? null,
      readOnly: input.readOnly ?? false,
      token: input.token ?? null,
      id: newId('sch'),
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now(),
    };
    this.run(
      `INSERT INTO schedules (id, agent_id, name, trigger, config, cron, prompt, skill, read_only, token, channel_id, enabled, last_run_at, created_at)
       VALUES (:id, :agentId, :name, :trigger, :config, :cron, :prompt, :skill, :readOnly, :token, :channelId, :enabled, :lastRunAt, :createdAt)`,
      s as unknown as Record<string, unknown>,
    );
    return s;
  }
  listSchedules(): Schedule[] {
    return this.all('SELECT * FROM schedules ORDER BY created_at').map(toSchedule);
  }
  getSchedule(id: string): Schedule | undefined {
    const r = this.get('SELECT * FROM schedules WHERE id = :id', { id });
    return r && toSchedule(r);
  }
  saveSchedule(s: Schedule) {
    this.run(
      `UPDATE schedules SET name = :name, trigger = :trigger, config = :config, cron = :cron, prompt = :prompt, skill = :skill, read_only = :readOnly, token = :token,
       channel_id = :channelId, enabled = :enabled, last_run_at = :lastRunAt WHERE id = :id`,
      s as unknown as Record<string, unknown>,
    );
  }
  deleteSchedule(id: string) {
    this.run('DELETE FROM schedules WHERE id = :id', { id });
  }

  // ── secrets (values are encrypted by Vault before they get here) ─────
  putSecret(name: string, enc: { ciphertext: string; iv: string; tag: string }) {
    const t = now();
    this.run(
      `INSERT INTO secrets (name, ciphertext, iv, tag, created_at, updated_at) VALUES (:name, :ciphertext, :iv, :tag, :t, :t)
       ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
      { name, ...enc, t },
    );
  }
  getSecretRows(): { name: string; ciphertext: string; iv: string; tag: string }[] {
    return this.all('SELECT name, ciphertext, iv, tag FROM secrets ORDER BY name').map((r) => ({
      name: String(r.name),
      ciphertext: String(r.ciphertext),
      iv: String(r.iv),
      tag: String(r.tag),
    }));
  }
  deleteSecret(name: string) {
    this.run('DELETE FROM secrets WHERE name = :name', { name });
  }

  // ── bridge links (outside message ↔ conversation or approval) ─────────
  linkBridge(link: BridgeLink) {
    this.run(
      `INSERT INTO bridge_links (platform, external_id, kind, ref, channel_id, thread_id, created_at)
       VALUES (:platform, :externalId, :kind, :ref, :channelId, :threadId, :at)
       ON CONFLICT(platform, external_id) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, channel_id = excluded.channel_id, thread_id = excluded.thread_id`,
      { ...link, at: now() },
    );
  }
  getBridgeLink(platform: string, externalId: string): BridgeLink | undefined {
    const r = this.get('SELECT * FROM bridge_links WHERE platform = :platform AND external_id = :externalId', { platform, externalId });
    return r && toLink(r);
  }
  findBridgeLinks(platform: string, kind: string, ref: string): BridgeLink[] {
    return this.all('SELECT * FROM bridge_links WHERE platform = :platform AND kind = :kind AND ref = :ref', { platform, kind, ref }).map(toLink);
  }

  // ── settings ──────────────────────────────────────────────────────────
  getSetting(key: string): string | undefined {
    const r = this.get('SELECT value FROM settings WHERE key = :key', { key });
    return r ? String(r.value) : undefined;
  }
  setSetting(key: string, value: string) {
    this.run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
  }

  // ── events ────────────────────────────────────────────────────────────
  appendEvent(e: Omit<EventRecord, 'id' | 'ts'>): EventRecord {
    const ts = now();
    const res = this.run(
      'INSERT INTO events (ts, type, actor_id, agent_id, run_id, channel_id, data) VALUES (:ts, :type, :actorId, :agentId, :runId, :channelId, :data)',
      { ts, ...e },
    );
    return { ...e, id: Number(res.lastInsertRowid), ts };
  }
  /** Model spend recorded since a time, for one agent or the whole workspace. Every model call emits one of `types`. */
  /** Every helper an agent has ever had, including ones already removed. */
  helperIdsEver(parentId: string): string[] {
    return this.all('SELECT agent_id FROM helper_lineage WHERE parent_id = :parentId', { parentId }).map((r) => String(r.agent_id));
  }

  spendSince(types: string[], since: string, agentIds?: string | string[]): Spend {
    const ids = agentIds === undefined ? [] : Array.isArray(agentIds) ? agentIds : [agentIds];
    const p: Record<string, unknown> = { since };
    types.forEach((t, i) => (p[`t${i}`] = t));
    ids.forEach((id, i) => (p[`a${i}`] = id));
    const r = this.get(
      `SELECT COALESCE(SUM(json_extract(data, '$.costUsd')), 0) AS usd,
              COALESCE(SUM(COALESCE(json_extract(data, '$.inputTokens'), 0) + COALESCE(json_extract(data, '$.outputTokens'), 0)), 0) AS tokens
       FROM events WHERE type IN (${types.map((_, i) => `:t${i}`).join(', ')}) AND ts >= :since ${ids.length ? `AND agent_id IN (${ids.map((_, i) => `:a${i}`).join(', ')})` : ''}`,
      p,
    );
    return { usd: Number(r?.usd ?? 0), tokens: Number(r?.tokens ?? 0) };
  }

  listEvents(opts: { beforeId?: number; agentId?: string; runId?: string; types?: string[]; limit?: number } = {}): EventRecord[] {
    const where: string[] = [];
    if (opts.beforeId) where.push('id < :beforeId');
    if (opts.agentId) where.push('agent_id = :agentId');
    if (opts.runId) where.push('run_id = :runId');
    if (opts.types?.length) where.push(`(${opts.types.map((_, i) => `type LIKE :t${i}`).join(' OR ')})`);
    const p: Record<string, unknown> = { beforeId: opts.beforeId, agentId: opts.agentId, runId: opts.runId, limit: opts.limit ?? 100 };
    opts.types?.forEach((t, i) => (p[`t${i}`] = t.replace('*', '%')));
    return this.all(`SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT :limit`, p).map(toEvent);
  }
}
