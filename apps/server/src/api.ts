// HTTP + WebSocket API for the web app. In a personal workspace every human action is the owner's; in team mode
// each request carries the signed-in person (see auth.ts) and owner-only settings are checked here.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACTIVE_RUN_STATUSES, MAX_COMMENT_CHARS, MAX_COMMENT_QUOTE, MAX_PAGE_CHARS, NO_BUDGET, OPEN_NETWORK, type Agent, type Bootstrap, type EventRecord, type Health, type Human, type LibraryItem, type Message, type Schedule, type WsFrame } from '@teambot/shared';
import type { App } from './app.js';
import { AuthError, SESSION_COOKIE, SESSION_MAX_AGE_S } from './auth.js';
import { ComponentError, DraftInput } from './components.js';
import { PageConflict, PageError } from './pages.js';
import { RecordingError } from './recordings.js';
import { DEFAULT_POLICY_YAML } from './policy.js';
import { CronScheduler, MAX_QUEUED_EVENTS, newHookToken, tokenMatches } from './runtime/cron.js';
import { addAgent, nameTaken, removeAgent } from './runtime/agents.js';
import { routineSecret } from './runtime/triggers.js';
import { MAX_UPLOAD_BYTES, deleteSharedFile, listShared, openSharedFile, realSharedPath, saveUpload, sharedPath as toSharedPath, toSharedRef } from './shared-files.js';
import { SKILL_NAME_RE } from './skills.js';
import { MAX_MEMORY_BYTES } from './memory.js';
import { TOKEN_SECRET as TELEGRAM_TOKEN } from './bridges/telegram.js';
import { APP_TOKEN as SLACK_APP_TOKEN, BOT_TOKEN as SLACK_BOT_TOKEN, SLACK_MANIFEST } from './bridges/slack.js';
import { RESERVED_PREFIX, isReserved } from './vault.js';
import { search } from './search.js';
import { NAME_RE, errorMessage } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    human?: Human;
    sessionToken?: string;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const agentFields = {
  name: z.string().trim().regex(NAME_RE, 'Names use letters, numbers, - and _ (max 32), starting with a letter'),
  role: z.string().trim().max(200),
  instructions: z.string().max(20_000),
  model: z.string().trim().min(1),
  avatar: z.string().trim().max(8),
  color: z.string().trim().max(20),
  mcpServers: z.array(z.string()),
  skills: z.array(z.string().trim().min(1)).max(200),
  setupScript: z.string().max(50_000),
  computerImage: z
    .string()
    .trim()
    .max(255)
    .refine((v) => v === '' || /^[a-z0-9][a-z0-9._/:@-]*$/i.test(v), 'not a valid Docker image name')
    .nullable()
    .transform((v) => v || null),
  desktop: z.boolean(),
  network: z.object({
    mode: z.enum(['open', 'allowlist']),
    allow: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .transform((d) => d.replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
          .refine((d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(d), 'domains look like example.com or *.example.com'),
      )
      .max(200),
  }),
  budget: z
    .object({
      dailyUsd: z.number().positive().nullable(),
      monthlyUsd: z.number().positive().nullable(),
      dailyTokens: z.number().int().positive().nullable(),
    })
    .partial(),
};
const AgentInput = z.object({
  ...agentFields,
  role: agentFields.role.default(''),
  instructions: agentFields.instructions.default(''),
  model: agentFields.model.optional(),
  avatar: agentFields.avatar.optional(),
  color: agentFields.color.optional(),
  mcpServers: agentFields.mcpServers.default([]),
  skills: agentFields.skills.default(['*']),
  setupScript: agentFields.setupScript.default(''),
  computerImage: agentFields.computerImage.optional(),
  desktop: agentFields.desktop.default(false),
  network: agentFields.network.optional(),
  budget: agentFields.budget.optional(),
});
// No defaults here: a field left out of a PATCH keeps its current value.
const AgentPatch = z.object(agentFields).partial();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(400, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return r.data;
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const { store, bus, workspace, runtime, computers, vault, cfg } = app;
  const server = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });
  await server.register(fastifyWebsocket, {
    options: { handleProtocols: (protocols: Set<string>) => (protocols.has('binary') ? 'binary' : false) },
  });

  server.setErrorHandler((err, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500 ? (err as { statusCode: number }).statusCode : 400;
    reply.status(status).send({ error: errorMessage(err) });
  });

  /** Who is acting: the signed-in person in team mode, the owner in a personal workspace. */
  const me = (req: FastifyRequest) => req.human ?? workspace.owner();
  const agentOr404 = (id: string) => {
    const a = store.getAgent(id);
    if (!a) throw new HttpError(404, 'agent not found');
    return a;
  };
  /** A channel the person may read: in team mode, other people's DMs look like they don't exist. */
  const channelFor = (req: FastifyRequest, id: string) => {
    const channel = store.getChannel(id);
    if (!channel || !workspace.canSee(channel, me(req).id)) throw new HttpError(404, 'channel not found');
    return channel;
  };
  /** A channel whose members someone may change: one they can see, and never a DM (its members are who it is between). */
  const editableChannel = (req: FastifyRequest, id: string) => {
    const channel = channelFor(req, id);
    if (channel.kind === 'dm') throw new HttpError(409, "A direct message's members can't be changed");
    return channel;
  };
  /** Runs, approvals and events belong to the conversation their run works in. */
  const channelVisible = (channelId: string | null | undefined, viewerId: string) => {
    const channel = channelId ? store.getChannel(channelId) : undefined;
    return !channel || workspace.canSee(channel, viewerId);
  };
  const runVisible = (runId: string | null | undefined, viewerId: string) => !runId || channelVisible(store.getRun(runId)?.channelId, viewerId);
  /** In a team, news of a recording (what someone said they were doing) is for the person who made it and owners. */
  const recordingNewsVisible = (e: EventRecord, viewerId: string) => {
    if (!e.type.startsWith('recording.') || !app.auth.teamMode) return true;
    const by = (e.data.recording as { startedBy?: string } | undefined)?.startedBy ?? (e.data.startedBy as string | undefined);
    return !by || by === viewerId || store.getHuman(viewerId)?.role === 'owner';
  };
  const visibleTo = (viewerId: string) => (e: EventRecord) =>
    channelVisible(e.channelId, viewerId) && (e.channelId ? true : runVisible(e.runId, viewerId)) && recordingNewsVisible(e, viewerId);

  // ── team sign-in ─────────────────────────────────────────────────────
  const cookie = (req: FastifyRequest, name: string) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const [key, ...value] = part.trim().split('=');
      if (key === name) return decodeURIComponent(value.join('='));
    }
    return undefined;
  };
  const setSession = (req: FastifyRequest, reply: FastifyReply, token: string | null) => {
    const secure = cfg.publicUrl.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
    reply.header('set-cookie', `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_MAX_AGE_S : 0}${secure ? '; Secure' : ''}`);
  };
  const authCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw err instanceof AuthError ? new HttpError(err.status, err.message) : err;
    }
  };
  /** Open without signing in: signing in, joining, and webhooks (which carry their own token). */
  const PUBLIC = [/^\/api\/auth(\/|\?|$)/, /^\/api\/hooks\//];
  /** Workspace settings only an owner may change. */
  const OWNER_ONLY = /^\/api\/(policy|secrets|connectors|bridges|budget|team|components)(\/|\?|$)/;
  const sameSite = (origin: string, host: string | undefined) => {
    try {
      return new URL(origin).host === host || new URL(origin).origin === cfg.publicUrl;
    } catch {
      return false;
    }
  };

  server.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // Agent computers share a Docker network with the server in the Compose setup. Their firewall keeps them off it;
    // this is the second lock: the API acts as the owner when sign-in is off, so it never answers a computer.
    if (computers.isComputerAddress(req.socket.remoteAddress)) return reply.code(403).send({ error: 'Agent computers cannot use the TeamBot API' });
    // Interfaces agents draw run in sandboxed frames, whose requests say "Origin: null". With sign-in off the API acts as
    // the owner, so nothing from such a frame may change anything (the frames also forbid network requests).
    if (req.headers.origin === 'null' && req.method !== 'GET' && req.method !== 'HEAD') return reply.code(403).send({ error: 'Requests from sandboxed frames are refused' });
    if (!app.auth.teamMode) return;
    const token = cookie(req, SESSION_COOKIE);
    const human = app.auth.session(token);
    if (human) {
      req.human = human;
      req.sessionToken = token;
    }
    if (PUBLIC.some((re) => re.test(req.url))) return;
    if (!human) return reply.code(401).send({ error: 'Sign in to continue' });
    if (req.method === 'GET' || req.method === 'HEAD') return;
    // The cookie is SameSite=Lax; also refuse changes that a browser says came from another site.
    if (req.headers.origin && !sameSite(req.headers.origin, req.headers.host)) return reply.code(403).send({ error: 'Request from another site refused' });
    if (human.role !== 'owner' && OWNER_ONLY.test(req.url)) return reply.code(403).send({ error: 'Only the workspace owner can change this' });
  });

  server.get('/api/auth', async (req) => ({ teamMode: app.auth.teamMode, me: app.auth.teamMode ? (req.human ?? null) : workspace.owner() }));
  server.post('/api/auth/sign-in', async (req, reply) => {
    const { name, password } = parse(z.object({ name: z.string().trim().min(1).max(40), password: z.string().min(1).max(200) }), req.body);
    if (!app.auth.teamMode) throw new HttpError(409, 'This workspace has no sign-in');
    const { session, human } = authCall(() => app.auth.signIn(name, password, req.ip));
    setSession(req, reply, session);
    bus.emit('human.signed_in', { actorId: human.id }, {});
    return { me: human };
  });
  server.post('/api/auth/sign-out', async (req, reply) => {
    app.auth.signOut(req.sessionToken);
    setSession(req, reply, null);
    return { ok: true };
  });
  server.get<{ Params: { token: string } }>('/api/auth/invites/:token', async (req) => {
    const invite = app.auth.teamMode ? app.auth.inviteFor(req.params.token) : undefined;
    if (!invite) throw new HttpError(404, 'This invite link has expired or was already used. Ask for a new one.');
    return { invitedBy: workspace.memberName(invite.createdBy), role: invite.role, expiresAt: invite.expiresAt };
  });
  server.post('/api/auth/join', async (req, reply) => {
    const input = parse(
      z.object({
        token: z.string().min(16).max(200),
        name: z.string().trim().regex(NAME_RE, 'Names use letters, numbers, - and _ (max 32), starting with a letter'),
        password: z.string().max(200),
      }),
      req.body,
    );
    const { session, human } = authCall(() => app.auth.join(input.token, input.name, input.password));
    setSession(req, reply, session);
    bus.emit('human.joined', { actorId: human.id }, { human });
    return { me: human };
  });
  server.post('/api/auth/password', async (req) => {
    if (!req.human) throw new HttpError(401, 'Sign in to continue');
    const { current, next } = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), req.body);
    authCall(() => app.auth.changePassword(req.human!, current, next, req.sessionToken));
    bus.emit('human.password_changed', { actorId: req.human.id }, {});
    return { ok: true };
  });

  server.get('/api/team', async () => ({ teamMode: app.auth.teamMode, members: store.listHumans(), invites: store.listInvites() }));
  server.post('/api/team/enable', async (req, reply) => {
    if (app.auth.teamMode) throw new HttpError(409, 'Team sign-in is already on');
    const { password } = parse(z.object({ password: z.string().max(200) }), req.body);
    const owner = me(req);
    setSession(req, reply, authCall(() => app.auth.enable(owner, password)));
    bus.emit('team.enabled', { actorId: owner.id }, {});
    return { teamMode: true, me: owner };
  });
  server.post('/api/team/disable', async (req, reply) => {
    const actor = me(req);
    app.auth.disable();
    setSession(req, reply, null);
    bus.emit('team.disabled', { actorId: actor.id }, {});
    return { teamMode: false };
  });
  server.post('/api/team/invites', async (req) => {
    if (!app.auth.teamMode) throw new HttpError(409, 'Turn on team sign-in first');
    const { role } = parse(z.object({ role: z.enum(['member', 'owner']).default('member') }), req.body ?? {});
    const { invite, token } = app.auth.createInvite(me(req), role);
    bus.emit('team.invited', { actorId: me(req).id }, { role });
    return { invite, token };
  });
  server.delete<{ Params: { id: string } }>('/api/team/invites/:id', async (req) => {
    store.deleteInvite(req.params.id);
    return store.listInvites();
  });
  server.delete<{ Params: { id: string } }>('/api/team/members/:id', async (req) => {
    const human = store.getHuman(req.params.id);
    if (!human || human.removed) throw new HttpError(404, 'member not found');
    if (human.id === me(req).id) throw new HttpError(400, "You can't remove yourself");
    store.removeHuman(human.id);
    for (const channel of store.listChannels().filter((c) => c.kind === 'channel' && c.memberIds.includes(human.id))) workspace.removeMember(channel.id, human.id, me(req).id);
    bus.emit('human.removed', { actorId: me(req).id }, { human: store.getHuman(human.id) });
    return store.listHumans();
  });

  async function health(): Promise<Health> {
    const [docker, image] = await Promise.all([computers.available(), computers.imageReady()]);
    return {
      ok: true,
      openrouterKey: !!cfg.openrouterKey,
      docker,
      computerImage: image,
      defaultModel: cfg.defaultModel,
      utilityModel: cfg.utilityModel,
      reviewerModel: cfg.reviewerModel,
      mcpServers: app.mcp.status(),
      telemetry: app.telemetry.status(),
    };
  }

  // ── bootstrap & health ───────────────────────────────────────────────
  server.get('/api/health', health);

  server.get('/api/bootstrap', async (req): Promise<Bootstrap> => {
    const channels = store.listChannels().filter((c) => workspace.canSee(c, me(req).id));
    return {
      me: me(req),
      teamMode: app.auth.teamMode,
      humans: store.listHumans(),
      agents: store.listAgents(),
      channels,
      lastMessages: channels.flatMap((c) => store.listTopLevel(c.id, { limit: 1 })),
      approvals: store.listApprovals({ status: 'pending' }).filter((a) => channelVisible(a.channelId, me(req).id) && runVisible(a.runId, me(req).id)),
      activeRuns: store.listRuns({ statuses: ACTIVE_RUN_STATUSES, limit: 200 }).filter((r) => channelVisible(r.channelId, me(req).id)),
      schedules: store.listSchedules().map(presentSchedule),
      skills: app.skills.list(),
      recordings: store.listRecordings().filter((r) => app.recordings.visibleTo(r, me(req))),
      secrets: vault.agentNames(),
      pausedAll: runtime.pausedAll,
      health: await health(),
    };
  });

  server.patch('/api/me', async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
    const taken = store.listHumans().some((h) => h.id !== me(req).id && h.name.toLowerCase() === name.toLowerCase()) || !!store.getAgentByName(name);
    if (taken) throw new HttpError(409, `The name ${name} is taken`);
    store.renameHuman(me(req).id, name);
    const human = store.getHuman(me(req).id)!;
    bus.emit('human.updated', { actorId: human.id }, { human });
    return human;
  });

  server.get('/api/models', async () => app.models.listModels());

  // ── agents ───────────────────────────────────────────────────────────
  /**
   * With sign-in on, what an agent's computer runs at setup, which image it runs, where it may connect and what it
   * may spend are governance, so only an owner changes them. Members can still edit everything else.
   */
  const OWNER_AGENT_FIELDS = ['setupScript', 'computerImage', 'network', 'budget'] as const;
  type OwnerAgentFields = Pick<Agent, (typeof OWNER_AGENT_FIELDS)[number]>;
  const checkOwnerAgentFields = (req: FastifyRequest, before: OwnerAgentFields, after: Partial<OwnerAgentFields>) => {
    if (me(req).role === 'owner') return;
    const changed = OWNER_AGENT_FIELDS.filter((k) => after[k] !== undefined && JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    if (changed.length) throw new HttpError(403, `Only the workspace owner can change an agent's ${changed.join(', ')}`);
  };

  server.post('/api/agents', async (req) => {
    const input = parse(AgentInput, req.body);
    checkOwnerAgentFields(
      req,
      { setupScript: '', computerImage: null, network: OPEN_NETWORK, budget: NO_BUDGET },
      { ...input, budget: input.budget && { ...NO_BUDGET, ...input.budget } },
    );
    if (nameTaken(app, input.name)) throw new HttpError(409, `The name ${input.name} is taken`);
    return addAgent(
      app,
      {
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        model: input.model || cfg.defaultModel,
        avatar: input.avatar,
        color: input.color,
        mcpServers: input.mcpServers,
        skills: input.skills,
        setupScript: input.setupScript,
        computerImage: input.computerImage ?? null,
        desktop: input.desktop,
        network: input.network ?? { ...OPEN_NETWORK },
        budget: { ...NO_BUDGET, ...input.budget },
      },
      me(req).id,
    );
  });

  server.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const current = agentOr404(req.params.id);
    const input = parse(AgentPatch, req.body);
    checkOwnerAgentFields(req, current, { ...input, budget: input.budget && { ...current.budget, ...input.budget } });
    const renamed = input.name && input.name.toLowerCase() !== current.name.toLowerCase();
    if (renamed && (store.getAgentByName(input.name!) || store.listHumans().some((h) => h.name.toLowerCase() === input.name!.toLowerCase()))) {
      throw new HttpError(409, `The name ${input.name} is taken`);
    }
    const { budget, ...fields } = input;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (renamed) app.memory.rename(current.name, input.name!);
    let agent = store.updateAgent(current.id, budget ? { ...patch, budget: { ...current.budget, ...budget } } : patch);
    bus.emit('agent.updated', { actorId: me(req).id, agentId: agent.id }, { agent });
    // A raised budget can release queued work.
    runtime.refreshAgentStatus(agent.id);
    runtime.poke();
    agent = store.getAgent(agent.id)!;
    if (input.network && JSON.stringify(input.network) !== JSON.stringify(current.network)) {
      if (agent.network.mode === 'allowlist') await app.egress.portFor(agent);
      else await app.egress.close(agent.id);
      // A running computer switches right away; a stopped one when it next starts.
      if ((await computers.status(agent.id)).state === 'running') void app.lifecycle.ready(agent).catch((err) => console.error(`network change for ${agent.name}: ${errorMessage(err)}`));
    }
    return agent;
  });

  server.delete<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    await removeAgent(app, agentOr404(req.params.id), me(req).id);
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>('/api/agents/:id/pause', async (req) => {
    runtime.setAgentPaused(agentOr404(req.params.id).id, true, me(req).id);
    return store.getAgent(req.params.id);
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/resume', async (req) => {
    runtime.setAgentPaused(agentOr404(req.params.id).id, false, me(req).id);
    return store.getAgent(req.params.id);
  });

  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/agents/:id/runs', async (req) =>
    store.listRuns({ agentId: agentOr404(req.params.id).id, limit: Number(req.query.limit ?? 30) }).filter((r) => channelVisible(r.channelId, me(req).id)),
  );

  /** Files attached to these messages that are still in /shared: newest first, each path once. */
  const libraryOf = (messages: Message[]): LibraryItem[] => {
    const seen = new Set<string>();
    const items: LibraryItem[] = [];
    for (const m of messages) {
      for (const a of m.attachments) {
        if (seen.has(a.path)) continue;
        seen.add(a.path);
        let exists = false;
        try {
          exists = !!realSharedPath(cfg.sharedDir, a.path);
        } catch {
          // It leads outside /shared now: leave it out.
        }
        if (exists) items.push({ ...a, messageId: m.id, channelId: m.channelId, authorId: m.authorId, createdAt: m.createdAt });
      }
    }
    return items;
  };
  server.get<{ Params: { id: string } }>('/api/agents/:id/library', async (req) =>
    libraryOf(store.listWithAttachments({ authorId: agentOr404(req.params.id).id }).filter((m) => channelVisible(m.channelId, me(req).id))),
  );
  server.get<{ Params: { id: string } }>('/api/channels/:id/library', async (req) => libraryOf(store.listWithAttachments({ channelId: channelFor(req, req.params.id).id })));

  // ── computers ────────────────────────────────────────────────────────
  server.get<{ Params: { id: string } }>('/api/agents/:id/computer', async (req) => {
    const agent = agentOr404(req.params.id);
    const status = await computers.status(agent.id);
    return { ...status, vncPassword: vault.derive(`vnc:${agent.id}`).slice(0, 8), setup: app.lifecycle.lastSetup(agent.id) };
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/computer/start', async (req) => {
    const agent = agentOr404(req.params.id);
    await app.lifecycle.ready(agent);
    return computers.status(agent.id);
  });
  server.get<{ Params: { id: string } }>('/api/agents/:id/snapshots', async (req) => app.snapshots.list(agentOr404(req.params.id).id));
  server.post<{ Params: { id: string } }>('/api/agents/:id/snapshots', async (req) => {
    const agent = agentOr404(req.params.id);
    const { label } = parse(z.object({ label: z.string().max(120).default('') }), req.body);
    return app.snapshots.take(agent, label);
  });
  server.post<{ Params: { id: string; snap: string } }>('/api/agents/:id/snapshots/:snap/restore', async (req) => {
    const agent = agentOr404(req.params.id);
    if (store.listRuns({ agentId: agent.id, statuses: ACTIVE_RUN_STATUSES, limit: 1 }).length) {
      throw new HttpError(409, `${agent.name} is in the middle of work. Stop or finish it first, then restore.`);
    }
    await app.snapshots.restore(agent, req.params.snap);
    return { ok: true };
  });
  server.delete<{ Params: { id: string; snap: string } }>('/api/agents/:id/snapshots/:snap', async (req) => {
    app.snapshots.remove(agentOr404(req.params.id).id, req.params.snap);
    return { ok: true };
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/computer/setup', async (req) => {
    const agent = agentOr404(req.params.id);
    if (!agent.setupScript.trim()) throw new HttpError(400, `${agent.name} has no setup script`);
    return { setup: await app.lifecycle.rerunSetup(agent) };
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/computer/stop', async (req) => {
    const agent = agentOr404(req.params.id);
    runtime.setAgentPaused(agent.id, true, me(req).id);
    await computers.stop(agent.id);
    return computers.status(agent.id);
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/computer/reset', async (req) => {
    const agent = agentOr404(req.params.id);
    await computers.reset(agent.id);
    return computers.status(agent.id);
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/takeover', async (req) => {
    const agent = agentOr404(req.params.id);
    runtime.takeover(agent.id, me(req).id);
    return store.getAgent(agent.id);
  });
  server.post<{ Params: { id: string } }>('/api/agents/:id/handback', async (req) => {
    const agent = agentOr404(req.params.id);
    const { note } = parse(z.object({ note: z.string().max(2000).optional() }), req.body);
    runtime.handBack(agent.id, me(req).id, note ?? null);
    return store.getAgent(agent.id);
  });

  // Live view: bridge the browser's WebSocket (noVNC) to the computer's VNC port.
  server.get<{ Params: { id: string } }>('/api/agents/:id/vnc', { websocket: true }, (socket, req) => {
    const queued: Buffer[] = [];
    let tcp: net.Socket | null = null;
    let watching: string | null = null;
    socket.on('message', (data: Buffer) => (tcp ? tcp.write(data) : queued.push(data)));
    socket.on('close', () => {
      tcp?.destroy();
      if (watching) app.lifecycle.viewerClosed(watching);
    });
    (async () => {
      const agent = store.getAgent(req.params.id);
      if (!agent) return socket.close(4004, 'agent not found');
      // Someone watching live keeps the computer awake.
      watching = agent.id;
      app.lifecycle.viewerOpened(agent.id);
      const vnc = await computers.vnc(agent.id);
      if (!vnc) return socket.close(4009, 'computer is not running');
      tcp = net.connect(vnc.port, vnc.host);
      tcp.on('data', (d) => socket.readyState === socket.OPEN && socket.send(d));
      tcp.on('close', () => socket.close());
      tcp.on('error', () => socket.close());
      for (const d of queued.splice(0)) tcp.write(d);
    })().catch(() => socket.close(1011, 'could not reach the computer'));
  });

  // ── channels & messages ──────────────────────────────────────────────
  server.post('/api/channels', async (req) => {
    const input = parse(z.object({ name: z.string(), topic: z.string().max(300).optional(), memberIds: z.array(z.string()).default([]) }), req.body);
    return workspace.createChannel(input, me(req).id);
  });
  server.patch<{ Params: { id: string } }>('/api/channels/:id', async (req) => {
    const input = parse(z.object({ topic: z.string().max(300).optional(), leadAgentId: z.string().nullable().optional() }), req.body);
    const current = channelFor(req, req.params.id);
    if (input.leadAgentId !== undefined && current.kind === 'dm') throw new HttpError(409, 'A direct message has no lead agent');
    if (input.leadAgentId) {
      agentOr404(input.leadAgentId);
      workspace.addMember(req.params.id, input.leadAgentId, me(req).id);
    }
    store.updateChannel(req.params.id, input);
    const channel = store.getChannel(req.params.id);
    bus.emit('channel.updated', { actorId: me(req).id, channelId: req.params.id }, { channel });
    return channel;
  });
  server.delete<{ Params: { id: string } }>('/api/channels/:id', async (req) => {
    const channel = channelFor(req, req.params.id);
    if (channel.kind === 'dm') throw new HttpError(409, "A direct message can't be deleted");
    workspace.deleteChannel(channel.id, me(req).id);
    return { ok: true };
  });
  server.post<{ Params: { id: string } }>('/api/channels/:id/members', async (req) => {
    const { memberId } = parse(z.object({ memberId: z.string() }), req.body);
    editableChannel(req, req.params.id);
    if (!workspace.member(memberId)) throw new HttpError(404, 'member not found');
    workspace.addMember(req.params.id, memberId, me(req).id);
    return store.getChannel(req.params.id);
  });
  server.delete<{ Params: { id: string; memberId: string } }>('/api/channels/:id/members/:memberId', async (req) => {
    editableChannel(req, req.params.id);
    workspace.removeMember(req.params.id, req.params.memberId, me(req).id);
    return store.getChannel(req.params.id);
  });
  server.post('/api/dms', async (req) => {
    const { memberId } = parse(z.object({ memberId: z.string() }), req.body);
    if (!workspace.member(memberId)) throw new HttpError(404, 'member not found');
    return workspace.getOrCreateDm(me(req).id, memberId);
  });
  server.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/channels/:id/messages', async (req) =>
    store.listTopLevel(channelFor(req, req.params.id).id, { before: req.query.before, limit: Math.min(Number(req.query.limit ?? 60), 200) }),
  );
  server.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/channels/:id/sent', async (req) =>
    store
      .listSentElsewhere(channelFor(req, req.params.id).id, { limit: Math.min(Number(req.query.limit ?? 60), 200) })
      .filter((m) => channelVisible(m.channelId, me(req).id)),
  );
  server.post<{ Params: { id: string } }>('/api/channels/:id/messages', async (req) => {
    const input = parse(
      z.object({ text: z.string().default(''), threadId: z.string().nullable().optional(), attachments: z.array(z.string()).max(20).optional() }),
      req.body,
    );
    channelFor(req, req.params.id);
    return workspace.postMessage({ channelId: req.params.id, authorId: me(req).id, ...input });
  });
  server.get<{ Params: { id: string } }>('/api/messages/:id/thread', async (req) => {
    const root = store.getMessage(req.params.id);
    if (!root) throw new HttpError(404, 'message not found');
    channelFor(req, root.channelId);
    const rootId = root.threadId ?? root.id;
    return { root: store.getMessage(rootId), replies: store.listThread(rootId) };
  });

  // ── runs ─────────────────────────────────────────────────────────────
  // Summaries for the work notes conversations show above an agent's reply: /api/runs?ids=a,b
  server.get<{ Querystring: { ids?: string } }>('/api/runs', async (req) => {
    const ids = [...new Set((req.query.ids ?? '').split(',').filter(Boolean))].slice(0, 200);
    return store.runSummaries(ids).filter((r) => channelVisible(r.channelId, me(req).id));
  });
  server.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run || !channelVisible(run.channelId, me(req).id)) throw new HttpError(404, 'run not found');
    return { run, transcript: store.getTranscript(run.id), events: store.listEvents({ runId: run.id, limit: 500 }).reverse() };
  });
  // Screenshots agents took during a run (desktop control).
  server.get<{ Params: { runId: string; file: string } }>('/api/screens/:runId/:file', async (req, reply) => {
    const { runId, file } = req.params;
    if (!/^run_[\w-]+$/.test(runId) || !/^[\w-]+\.(jpg|png|webp)$/.test(file)) throw new HttpError(400, 'bad screenshot path');
    if (!runVisible(runId, me(req).id)) throw new HttpError(404, 'screenshot not found');
    const full = path.join(cfg.dataDir, 'screens', runId, file);
    if (!fs.existsSync(full)) throw new HttpError(404, 'screenshot not found');
    reply.header('content-type', file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(full));
  });
  server.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) => {
    const run = store.getRun(req.params.id);
    if (!run || !channelVisible(run.channelId, me(req).id)) throw new HttpError(404, 'run not found');
    runtime.cancelRun(req.params.id, me(req).id);
    return store.getRun(req.params.id);
  });

  // ── approvals ────────────────────────────────────────────────────────
  server.get<{ Querystring: { status?: string } }>('/api/approvals', async (req) =>
    store.listApprovals({ status: req.query.status as never, limit: 200 }).filter((a) => channelVisible(a.channelId, me(req).id) && runVisible(a.runId, me(req).id)),
  );
  server.post<{ Params: { id: string } }>('/api/approvals/:id/resolve', async (req) => {
    const approval = store.getApproval(req.params.id);
    if (!approval || !channelVisible(approval.channelId, me(req).id) || !runVisible(approval.runId, me(req).id)) throw new HttpError(404, 'approval not found');
    const { decision, note } = parse(z.object({ decision: z.enum(['approve', 'deny', 'done', 'decline']), note: z.string().max(2000).optional() }), req.body);
    return runtime.resolveApproval(req.params.id, decision, note ?? null, me(req).id);
  });

  // ── activity / audit ─────────────────────────────────────────────────
  server.get<{ Querystring: { before?: string; agentId?: string; types?: string; limit?: string } }>('/api/events', async (req) =>
    store
      .listEvents({
        beforeId: req.query.before ? Number(req.query.before) : undefined,
        agentId: req.query.agentId || undefined,
        types: req.query.types ? req.query.types.split(',') : undefined,
        limit: Math.min(Number(req.query.limit ?? 100), 500),
      })
      .filter(visibleTo(me(req).id)),
  );

  // ── spend & budgets ──────────────────────────────────────────────────
  server.get('/api/spend', async () => app.budgets.report());
  server.put('/api/budget', async (req) => {
    const { workspaceDailyUsd } = parse(z.object({ workspaceDailyUsd: z.number().positive().nullable() }), req.body);
    app.budgets.setWorkspaceDailyUsd(workspaceDailyUsd, me(req).id);
    for (const a of store.listAgents()) runtime.refreshAgentStatus(a.id);
    runtime.poke();
    return app.budgets.report();
  });

  // ── system controls, policy, secrets, schedules ──────────────────────
  server.post('/api/system/pause', async (req) => {
    runtime.setPausedAll(true, me(req).id);
    return { pausedAll: true };
  });
  server.post('/api/system/resume', async (req) => {
    runtime.setPausedAll(false, me(req).id);
    return { pausedAll: false };
  });

  server.get('/api/policy', async () => ({ yaml: app.policy.text(), defaultYaml: DEFAULT_POLICY_YAML, invalid: app.policy.invalid }));
  server.put('/api/policy', async (req) => {
    const { yaml } = parse(z.object({ yaml: z.string().min(1) }), req.body);
    app.policy.update(yaml, me(req).id);
    return { yaml: app.policy.text() };
  });

  // Reserved TEAMBOT_* secrets belong to features (e.g. the Telegram bridge) and are managed there.
  const notReserved = (name: string) => {
    if (isReserved(name)) throw new HttpError(400, `Names starting with ${RESERVED_PREFIX} are reserved for TeamBot itself`);
  };
  server.get('/api/secrets', async () => vault.agentNames());
  server.put<{ Params: { name: string } }>('/api/secrets/:name', async (req) => {
    const { value } = parse(z.object({ value: z.string().min(1).max(20_000) }), req.body);
    notReserved(req.params.name);
    vault.set(req.params.name, value);
    bus.emit('secret.saved', { actorId: me(req).id }, { name: req.params.name });
    return vault.agentNames();
  });
  server.delete<{ Params: { name: string } }>('/api/secrets/:name', async (req) => {
    notReserved(req.params.name);
    vault.delete(req.params.name);
    bus.emit('secret.deleted', { actorId: me(req).id }, { name: req.params.name });
    return vault.agentNames();
  });

  // ── connectors (remote MCP servers with sign-in) ─────────────────────
  // The sign-in page sends the browser back to the callback on the origin the person is using TeamBot from.
  const signInOrigin = (origin?: string) => cfg.publicUrl || (origin && /^https?:$/.test(new URL(origin).protocol) ? new URL(origin).origin : undefined);
  const ConnectInput = z.object({ origin: z.string().url().optional() });

  server.get('/api/connectors', async () => app.mcp.status());
  // A connector that takes a pasted token (an API key or personal access token) instead of an OAuth sign-in.
  const TokenInput = z.object({ header: z.string().trim().min(1).max(64), prefix: z.string().max(32).default(''), value: z.string().min(1).max(4096) });
  server.post('/api/connectors', async (req) => {
    const input = parse(ConnectInput.extend({ name: z.string().trim().toLowerCase(), url: z.string().trim().min(1), token: TokenInput.optional() }), req.body);
    let connector;
    try {
      connector = app.mcp.addConnector(input.name, input.url, input.token && { header: input.token.header, prefix: input.token.prefix });
      if (input.token) app.mcp.setToken(connector.name, input.token.value);
    } catch (err) {
      if (connector) await app.mcp.removeConnector(connector.name);
      throw new HttpError(400, errorMessage(err));
    }
    const { authUrl } = await app.mcp.connect(connector.name, signInOrigin(input.origin));
    bus.emit('connector.added', { actorId: me(req).id }, { name: connector.name, url: connector.url, servers: app.mcp.status() });
    return { authUrl, servers: app.mcp.status() };
  });
  server.put<{ Params: { name: string } }>('/api/connectors/:name/token', async (req) => {
    const { value } = parse(z.object({ value: z.string().min(1).max(4096) }), req.body);
    if (!app.mcp.connectors().some((c) => c.name === req.params.name)) throw new HttpError(404, 'connector not found');
    try {
      app.mcp.setToken(req.params.name, value);
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
    await app.mcp.connect(req.params.name);
    bus.emit('connector.updated', { actorId: me(req).id }, { name: req.params.name, change: 'token_updated', servers: app.mcp.status() });
    return { servers: app.mcp.status() };
  });
  server.post<{ Params: { name: string } }>('/api/connectors/:name/connect', async (req) => {
    const { origin } = parse(ConnectInput, req.body ?? {});
    if (!app.mcp.connectors().some((c) => c.name === req.params.name)) throw new HttpError(404, 'connector not found');
    const { authUrl } = await app.mcp.connect(req.params.name, signInOrigin(origin));
    bus.emit('connector.updated', { actorId: me(req).id }, { name: req.params.name, change: authUrl ? 'sign_in_started' : 'reconnected', servers: app.mcp.status() });
    return { authUrl, servers: app.mcp.status() };
  });
  server.delete<{ Params: { name: string } }>('/api/connectors/:name', async (req) => {
    const { name } = req.params;
    if (!app.mcp.connectors().some((c) => c.name === name)) throw new HttpError(404, 'connector not found');
    await app.mcp.removeConnector(name);
    // A connector added later under the same name must not inherit this one's agents.
    for (const agent of store.listAgents().filter((a) => a.mcpServers.includes(name))) {
      const updated = store.updateAgent(agent.id, { mcpServers: agent.mcpServers.filter((s) => s !== name) });
      bus.emit('agent.updated', { actorId: me(req).id, agentId: agent.id }, { agent: updated });
    }
    bus.emit('connector.removed', { actorId: me(req).id }, { name, servers: app.mcp.status() });
    return app.mcp.status();
  });
  // What a connected server offers. Members may look (Connect apps is readable for everyone), so it isn't under /api/connectors.
  server.get<{ Params: { name: string } }>('/api/mcp-servers/:name/tools', async (req) => {
    const tools = app.mcp.tools(req.params.name);
    if (!tools) throw new HttpError(404, 'MCP server not found');
    return tools;
  });
  server.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/api/connectors/callback', async (req, reply) => {
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const page = (title: string, text: string, ok: boolean) =>
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title>` +
            `<body style="font:15px/1.5 system-ui,sans-serif;color-scheme:light dark;max-width:440px;margin:18vh auto;padding:0 16px;text-align:center">` +
            `<h2>${esc(title)}</h2><p>${esc(text)}</p>${ok ? '<script>setTimeout(() => window.close(), 1500)</script>' : ''}</body>`,
        );
    const { code, state, error, error_description } = req.query;
    if (error || !code || !state) return page('Sign-in was not completed', error_description || error || 'The sign-in page did not send a code back.', false);
    try {
      const name = await app.mcp.finishSignIn(state, code);
      bus.emit('connector.updated', { actorId: me(req).id }, { name, change: 'signed_in', servers: app.mcp.status() });
      return page(`${name} is connected`, 'You can close this tab and go back to TeamBot.', true);
    } catch (err) {
      return page('Sign-in failed', errorMessage(err), false);
    }
  });

  // ── Telegram bridge ──────────────────────────────────────────────────
  server.get('/api/bridges/telegram', async () => app.telegram.status());
  server.put('/api/bridges/telegram', async (req) => {
    const { token } = parse(z.object({ token: z.string().trim().regex(/^\d+:[\w-]{20,}$/, 'That does not look like a bot token from @BotFather') }), req.body);
    vault.set(TELEGRAM_TOKEN, token);
    const status = await app.telegram.start();
    if (status.error) {
      vault.delete(TELEGRAM_TOKEN);
      throw new HttpError(400, status.error);
    }
    bus.emit('bridge.configured', { actorId: me(req).id }, { platform: 'telegram', bot: status.botUsername });
    return status;
  });
  server.delete('/api/bridges/telegram', async (req) => {
    await app.telegram.stop();
    app.telegram.unpair();
    vault.delete(TELEGRAM_TOKEN);
    bus.emit('bridge.removed', { actorId: me(req).id }, { platform: 'telegram' });
    return app.telegram.status();
  });
  server.post('/api/bridges/telegram/pair', async () => {
    if (!app.telegram.status().running && !app.telegram.status().botUsername) throw new HttpError(409, 'Connect a bot token first');
    return app.telegram.startPairing();
  });
  server.delete('/api/bridges/telegram/pair', async () => {
    app.telegram.unpair();
    return app.telegram.status();
  });

  // ── Slack bridge ─────────────────────────────────────────────────────
  server.get('/api/bridges/slack', async () => ({ ...app.slack.status(), manifest: SLACK_MANIFEST }));
  server.put('/api/bridges/slack', async (req) => {
    const { botToken, appToken } = parse(
      z.object({
        botToken: z.string().trim().regex(/^xoxb-[\w-]+$/, 'The bot token starts with xoxb- (OAuth & Permissions → Bot User OAuth Token)'),
        appToken: z.string().trim().regex(/^xapp-[\w-]+$/, 'The app-level token starts with xapp- (Basic Information → App-Level Tokens, with connections:write)'),
      }),
      req.body,
    );
    vault.set(SLACK_BOT_TOKEN, botToken);
    vault.set(SLACK_APP_TOKEN, appToken);
    const status = await app.slack.start();
    if (status.error) {
      vault.delete(SLACK_BOT_TOKEN);
      vault.delete(SLACK_APP_TOKEN);
      throw new HttpError(400, status.error);
    }
    bus.emit('bridge.configured', { actorId: me(req).id }, { platform: 'slack', bot: status.botName });
    return status;
  });
  server.delete('/api/bridges/slack', async (req) => {
    await app.slack.stop();
    app.slack.unpair();
    vault.delete(SLACK_BOT_TOKEN);
    vault.delete(SLACK_APP_TOKEN);
    bus.emit('bridge.removed', { actorId: me(req).id }, { platform: 'slack' });
    return app.slack.status();
  });
  server.post('/api/bridges/slack/pair', async () => {
    if (!app.slack.status().botName) throw new HttpError(409, 'Connect the Slack app first');
    return app.slack.startPairing();
  });
  server.delete('/api/bridges/slack/pair', async () => {
    app.slack.unpair();
    return app.slack.status();
  });

  const scheduleFields = {
    agentId: z.string(),
    name: z.string().trim().min(1).max(80),
    trigger: z.enum(['schedule', 'webhook', 'email', 'slack', 'calendar']),
    cron: z.string().trim(),
    prompt: z.string().trim().min(1).max(5000),
    skill: z.string().nullable(),
    readOnly: z.boolean(),
    channelId: z.string().nullable(),
    enabled: z.boolean(),
    config: z
      .object({
        host: z.string().trim().max(255),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        user: z.string().trim().max(255),
        mailbox: z.string().trim().max(255),
        from: z.string().trim().max(255),
        subject: z.string().trim().max(255),
        channel: z.string().trim().max(40),
        minutesBefore: z.number().int().min(0).max(24 * 60),
      })
      .partial(),
    /** Write-only: the mail password (email) or private feed URL (calendar), kept as a reserved secret. */
    secret: z.string().max(4000),
  };
  const ScheduleInput = z.object({
    ...scheduleFields,
    trigger: scheduleFields.trigger.default('schedule'),
    cron: scheduleFields.cron.default(''),
    skill: scheduleFields.skill.optional(),
    readOnly: scheduleFields.readOnly.default(false),
    channelId: scheduleFields.channelId.optional(),
    enabled: scheduleFields.enabled.default(true),
    config: scheduleFields.config.default({}),
    secret: scheduleFields.secret.optional(),
  });
  const SchedulePatch = z.object(scheduleFields).partial();
  /** What each trigger needs: a cron expression, a webhook token, a mail server and password, a Slack channel, a feed URL. */
  const settleTrigger = <T extends Pick<Schedule, 'trigger' | 'cron' | 'token' | 'config'>>(s: T, secret: string | undefined, id?: string): T => {
    const hasSecret = !!secret || (!!id && !!vault.get(routineSecret(id)));
    switch (s.trigger) {
      case 'schedule':
        CronScheduler.validate(s.cron);
        return s;
      case 'webhook':
        return { ...s, cron: '', token: s.token ?? newHookToken() };
      case 'email':
        if (!s.config.host || !s.config.user) throw new HttpError(400, 'An email routine needs the IMAP server and the user name');
        if (!hasSecret) throw new HttpError(400, 'An email routine needs the mail password (an app password for Gmail or Outlook)');
        return { ...s, cron: '' };
      case 'slack':
        if (!/^[CG][A-Z0-9]{6,}$/.test(s.config.channel ?? '')) throw new HttpError(400, 'A Slack routine needs the channel ID, like C0123ABCD (channel details → About)');
        return { ...s, cron: '' };
      case 'calendar':
        if (!hasSecret) throw new HttpError(400, 'A calendar routine needs the calendar’s iCal address');
        if (secret && !/^(https?|webcal):\/\/\S+$/i.test(secret.trim())) throw new HttpError(400, 'The iCal address should start with https:// or webcal://');
        return { ...s, cron: '' };
    }
  };
  /** A routine as the app shows it: next run, whether its secret is stored, and how its last check went. */
  const presentSchedule = (s: Schedule): Schedule => ({
    ...app.cron.withNextRun(s),
    ...(s.trigger === 'email' || s.trigger === 'calendar' ? { hasSecret: !!vault.get(routineSecret(s.id)), triggerStatus: app.triggers.status(s.id) } : {}),
  });
  const saveSecret = (s: Schedule, secret: string | undefined) => {
    if (secret?.trim() && (s.trigger === 'email' || s.trigger === 'calendar')) vault.set(routineSecret(s.id), secret.trim());
  };
  /** Email and calendar routines are checked right away, so a wrong password shows up at once. */
  const checkSoon = (s: Schedule) => {
    if (s.enabled && (s.trigger === 'email' || s.trigger === 'calendar')) void app.triggers.check(s);
  };
  server.get('/api/schedules', async () => store.listSchedules().map(presentSchedule));
  server.post('/api/schedules', async (req) => {
    const { secret, ...input } = parse(ScheduleInput, req.body);
    agentOr404(input.agentId);
    const settled = settleTrigger({ ...input, token: null }, secret);
    const s = store.createSchedule({ ...settled, skill: input.skill || null, channelId: input.channelId ?? null });
    saveSecret(s, secret);
    app.cron.reload();
    bus.emit('schedule.created', { actorId: me(req).id, agentId: s.agentId }, { schedule: presentSchedule(s) });
    checkSoon(s);
    return presentSchedule(s);
  });
  server.patch<{ Params: { id: string } }>('/api/schedules/:id', async (req) => {
    const current = store.getSchedule(req.params.id);
    if (!current) throw new HttpError(404, 'schedule not found');
    const { secret, ...input } = parse(SchedulePatch, req.body);
    const merged = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Schedule;
    if (input.config) merged.config = { ...current.config, ...input.config };
    const next = settleTrigger(merged, secret, current.id);
    store.saveSchedule(next);
    saveSecret(next, secret);
    app.cron.reload();
    bus.emit('schedule.updated', { actorId: me(req).id, agentId: next.agentId }, { schedule: presentSchedule(next) });
    if (secret || input.config || input.enabled) checkSoon(next);
    return presentSchedule(next);
  });
  server.delete<{ Params: { id: string } }>('/api/schedules/:id', async (req) => {
    store.deleteSchedule(req.params.id);
    vault.delete(routineSecret(req.params.id));
    app.cron.reload();
    bus.emit('schedule.deleted', { actorId: me(req).id }, { id: req.params.id });
    return { ok: true };
  });
  server.post<{ Params: { id: string } }>('/api/schedules/:id/run', async (req) => {
    app.cron.fire(req.params.id);
    return { ok: true };
  });
  server.post<{ Params: { id: string } }>('/api/schedules/:id/check', async (req) => {
    const s = store.getSchedule(req.params.id);
    if (!s || (s.trigger !== 'email' && s.trigger !== 'calendar')) throw new HttpError(404, 'email or calendar routine not found');
    await app.triggers.check(s);
    return presentSchedule(store.getSchedule(s.id)!);
  });
  server.post<{ Params: { id: string } }>('/api/schedules/:id/token', async (req) => {
    const current = store.getSchedule(req.params.id);
    if (!current || current.trigger !== 'webhook') throw new HttpError(404, 'webhook routine not found');
    const next = { ...current, token: newHookToken() };
    store.saveSchedule(next);
    bus.emit('schedule.updated', { actorId: me(req).id, agentId: next.agentId }, { schedule: app.cron.withNextRun(next), tokenRotated: true });
    return next;
  });

  // Webhooks: anything that can POST can start a routine. The body is handed over as untrusted content.
  await server.register(async (hooks) => {
    hooks.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    hooks.post<{ Params: { id: string }; Querystring: { token?: string } }>('/api/hooks/:id', { bodyLimit: 256 * 1024 }, async (req, reply) => {
      const s = store.getSchedule(req.params.id);
      const given = (req.headers['x-teambot-token'] as string | undefined) ?? req.query.token;
      if (!s || s.trigger !== 'webhook' || !tokenMatches(s.token, given)) throw new HttpError(404, 'no webhook here (check the URL and token)');
      if (!s.enabled) throw new HttpError(409, 'this routine is turned off');
      if (!store.getAgent(s.agentId)) throw new HttpError(410, 'the agent for this routine was removed');
      if (app.cron.queuedEvents(s) >= MAX_QUEUED_EVENTS) throw new HttpError(429, 'the agent already has too many webhook calls waiting; try again later');
      const body = req.body;
      const payload = body === undefined || body === null ? '' : Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      app.cron.fire(s.id, { source: 'webhook', via: 'a webhook', body: payload });
      return reply.status(202).send({ ok: true });
    });
  });

  // ── pages (documents people and agents edit together) ────────────────
  // Pages belong to the whole workspace, like /shared. A save names the revision it started from; when the page has
  // moved on, the answer is 409 with the page as it is now, and the editor keeps its draft.
  const pageCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof PageError && !(err instanceof PageConflict)) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  server.get('/api/pages', async () => app.pages.list());
  server.post('/api/pages', async (req) => {
    const input = parse(z.object({ title: z.string(), content: z.string().max(MAX_PAGE_CHARS).default('') }), req.body);
    return pageCall(() => app.pages.create(input, me(req).id));
  });
  server.get<{ Params: { id: string } }>('/api/pages/:id', async (req) => pageCall(() => app.pages.get(req.params.id)));
  server.patch<{ Params: { id: string } }>('/api/pages/:id', async (req, reply) => {
    const { expectedRevision, ...patch } = parse(z.object({ title: z.string().optional(), content: z.string().optional(), expectedRevision: z.number().int().min(1) }), req.body);
    try {
      return pageCall(() => app.pages.update(req.params.id, patch, expectedRevision, me(req).id));
    } catch (err) {
      if (err instanceof PageConflict) return reply.code(409).send({ error: err.message, page: err.current });
      throw err;
    }
  });
  server.delete<{ Params: { id: string } }>('/api/pages/:id', async (req) => {
    pageCall(() => app.pages.remove(req.params.id, me(req).id));
    return { ok: true };
  });

  // Comment threads on a page, open to everyone like the page. Anyone can comment, reply, resolve and reopen; only a
  // comment's author or an owner deletes it. An @mentioned agent answers in the thread.
  const commentOn = (pageId: string, commentId: string) => {
    const comment = app.comments.get(commentId);
    if (comment.pageId !== pageId) throw new HttpError(404, 'comment not found');
    return comment;
  };
  server.get<{ Params: { id: string } }>('/api/pages/:id/comments', async (req) =>
    pageCall(() => {
      app.pages.get(req.params.id);
      return app.comments.threads(req.params.id);
    }),
  );
  server.post<{ Params: { id: string } }>('/api/pages/:id/comments', async (req) => {
    const input = parse(
      z.object({
        body: z.string().max(MAX_COMMENT_CHARS),
        threadId: z.string().optional(),
        anchor: z.object({ quote: z.string().min(1).max(MAX_COMMENT_QUOTE), offset: z.number().int().min(0) }).optional(),
      }),
      req.body,
    );
    return pageCall(() => app.comments.post({ pageId: req.params.id, authorId: me(req).id, body: input.body, threadId: input.threadId, anchor: input.anchor }));
  });
  server.patch<{ Params: { id: string; commentId: string } }>('/api/pages/:id/comments/:commentId', async (req) => {
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body);
    return pageCall(() => app.comments.resolve(commentOn(req.params.id, req.params.commentId).id, resolved, me(req).id));
  });
  server.delete<{ Params: { id: string; commentId: string } }>('/api/pages/:id/comments/:commentId', async (req) => {
    pageCall(() => app.comments.remove(commentOn(req.params.id, req.params.commentId).id, me(req).id));
    return { ok: true };
  });

  // ── components (generative UI) ───────────────────────────────────────
  // Anyone can look; only an owner saves, publishes, withdraws or deletes (OWNER_ONLY), since publishing hands a
  // component to every agent.
  const componentCall = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ComponentError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  server.get('/api/components', async () => app.components.list());
  server.put<{ Params: { name: string } }>('/api/components/:name', async (req) => {
    const input = parse(DraftInput, req.body);
    return componentCall(() => app.components.saveDraft(req.params.name, input, me(req).id));
  });
  server.post<{ Params: { name: string } }>('/api/components/:name/publish', async (req) => componentCall(() => app.components.publish(req.params.name, me(req).id)));
  server.post<{ Params: { name: string } }>('/api/components/:name/unpublish', async (req) => componentCall(() => app.components.unpublish(req.params.name, me(req).id)));
  server.delete<{ Params: { name: string } }>('/api/components/:name', async (req) => {
    componentCall(() => app.components.remove(req.params.name, me(req).id));
    return { ok: true };
  });

  // ── memory & search ──────────────────────────────────────────────────
  const MemoryInput = z.object({ content: z.string().max(MAX_MEMORY_BYTES) });
  server.get('/api/memory/team', async () => ({ content: app.memory.read('team') }));
  server.put('/api/memory/team', async (req) => {
    const { content } = parse(MemoryInput, req.body);
    app.memory.write('team', content);
    bus.emit('memory.updated', { actorId: me(req).id }, { scope: 'team', agentId: null, edited: true });
    return { content: app.memory.read('team') };
  });
  server.get<{ Params: { id: string } }>('/api/agents/:id/memory', async (req) => ({ content: app.memory.read('agent', agentOr404(req.params.id)) }));
  server.put<{ Params: { id: string } }>('/api/agents/:id/memory', async (req) => {
    const agent = agentOr404(req.params.id);
    const { content } = parse(MemoryInput, req.body);
    app.memory.write('agent', content, agent);
    bus.emit('memory.updated', { actorId: me(req).id, agentId: agent.id }, { scope: 'agent', agentId: agent.id, edited: true });
    return { content: app.memory.read('agent', agent) };
  });
  server.get<{ Querystring: { q?: string } }>('/api/search', async (req) => search(app, req.query.q ?? '', { limit: 50, viewerId: me(req).id }));

  // ── skills ───────────────────────────────────────────────────────────
  const skillOr404 = (name: string) => {
    if (!SKILL_NAME_RE.test(name)) throw new HttpError(400, 'Skill names use lowercase letters, numbers and hyphens');
    const skill = app.skills.get(name);
    if (!skill) throw new HttpError(404, 'skill not found');
    return skill;
  };
  server.get('/api/skills', async () => app.skills.list());
  server.get<{ Params: { name: string } }>('/api/skills/:name', async (req) => skillOr404(req.params.name));
  server.put<{ Params: { name: string } }>('/api/skills/:name', async (req) => {
    const { content } = parse(z.object({ content: z.string().min(1) }), req.body);
    if (!SKILL_NAME_RE.test(req.params.name)) throw new HttpError(400, 'Skill names use lowercase letters, numbers and hyphens (max 64)');
    const skill = app.skills.save(req.params.name, content);
    const { content: _body, ...summary } = skill;
    bus.emit('skill.saved', { actorId: me(req).id }, { skill: summary });
    return skill;
  });
  server.delete<{ Params: { name: string } }>('/api/skills/:name', async (req) => {
    skillOr404(req.params.name);
    app.skills.delete(req.params.name);
    bus.emit('skill.deleted', { actorId: me(req).id }, { name: req.params.name });
    return { ok: true };
  });

  // ── learning by demonstration ────────────────────────────────────────
  // A person records a task on an agent's computer; the draft skill it becomes reaches no agent until a person saves
  // it. In a team, a recording (what someone typed, their stills) is for the person who made it and owners only.
  const recordingCall = async <T>(fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RecordingError) throw new HttpError(err.status, err.message);
      throw err;
    }
  };
  const recordingFor = (req: FastifyRequest, id: string) => {
    const rec = store.getRecording(id);
    if (!rec || !app.recordings.visibleTo(rec, me(req))) throw new HttpError(404, 'recording not found');
    return rec;
  };
  server.post<{ Params: { id: string } }>('/api/agents/:id/recordings', async (req) => {
    const agent = agentOr404(req.params.id);
    return recordingCall(() => app.recordings.begin(agent, me(req)));
  });
  server.get('/api/recordings', async (req) => store.listRecordings().filter((r) => app.recordings.visibleTo(r, me(req))));
  server.get<{ Params: { id: string } }>('/api/recordings/:id', async (req) => recordingFor(req, req.params.id));
  server.post<{ Params: { id: string } }>('/api/recordings/:id/stop', async (req) => {
    const input = parse(
      z.object({
        name: z
          .string()
          .trim()
          .refine((v) => v === '' || SKILL_NAME_RE.test(v), 'Skill names use lowercase letters, numbers and hyphens (max 64)')
          .optional(),
        description: z.string().max(1000).optional(),
      }),
      req.body ?? {},
    );
    const rec = recordingFor(req, req.params.id);
    return recordingCall(() => app.recordings.end(rec.id, me(req).id, input));
  });
  server.post<{ Params: { id: string } }>('/api/recordings/:id/draft', async (req) => {
    const rec = recordingFor(req, req.params.id);
    if (rec.status === 'drafting') throw new HttpError(409, 'The draft is already being written');
    return recordingCall(() => {
      app.recordings.checkDraftable(rec.id);
      // Answer at once; the draft arrives as recording.updated.
      void app.recordings.draft(rec.id, me(req).id).catch((err) => console.error(`drafting ${rec.id}: ${errorMessage(err)}`));
      return store.getRecording(rec.id);
    });
  });
  server.put<{ Params: { id: string } }>('/api/recordings/:id/draft', async (req) => {
    const { content } = parse(z.object({ content: z.string().min(1).max(100_000) }), req.body);
    const rec = recordingFor(req, req.params.id);
    return recordingCall(() => app.recordings.editDraft(rec.id, content, me(req).id));
  });
  server.post<{ Params: { id: string } }>('/api/recordings/:id/save', async (req) => {
    const { content, overwrite } = parse(z.object({ content: z.string().min(1).max(100_000), overwrite: z.boolean().default(false) }), req.body);
    const rec = recordingFor(req, req.params.id);
    return recordingCall(() => app.recordings.save(rec.id, content, me(req).id, { overwrite }));
  });
  server.delete<{ Params: { id: string } }>('/api/recordings/:id', async (req) => {
    const rec = recordingFor(req, req.params.id);
    await recordingCall(() => app.recordings.discard(rec.id, me(req).id));
    return { ok: true };
  });
  server.get<{ Params: { id: string; file: string } }>('/api/recordings/:id/frames/:file', async (req, reply) => {
    if (!/^\d{1,3}\.jpg$/.test(req.params.file)) throw new HttpError(400, 'bad still name');
    const rec = recordingFor(req, req.params.id);
    const file = app.recordings.frameFile(rec.id, req.params.file);
    if (!file) throw new HttpError(404, 'still not found');
    reply.header('content-type', 'image/jpeg');
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(fs.createReadStream(file));
  });

  // ── shared folder ────────────────────────────────────────────────────
  /** Path errors (outside /shared, through a link) are the caller's mistake: 400. */
  const inShared = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      throw new HttpError(400, errorMessage(err));
    }
  };
  const sharedPath = (rel: string) => inShared(() => toSharedPath(cfg.sharedDir, rel));
  server.get<{ Querystring: { path?: string } }>('/api/shared', async (req) => {
    const dir = req.query.path ?? '';
    return inShared(() => listShared(cfg.sharedDir, dir));
  });

  // Uploads arrive as the raw file body; the name travels in the query string.
  server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  server.post<{ Querystring: { name?: string; dir?: string } }>('/api/shared/upload', { bodyLimit: MAX_UPLOAD_BYTES }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'send the file as application/octet-stream');
    const name = req.query.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    const dir = req.query.dir?.trim() || `uploads/${new Date().toISOString().slice(0, 10)}`;
    sharedPath(dir);
    const file = inShared(() => saveUpload(cfg.sharedDir, dir, name, req.body as Buffer));
    bus.emit('file.uploaded', { actorId: me(req).id }, { file });
    return file;
  });
  server.delete<{ Querystring: { path?: string } }>('/api/shared/file', async (req) => {
    const rel = req.query.path ?? '';
    if (!inShared(() => deleteSharedFile(cfg.sharedDir, rel))) throw new HttpError(404, 'file not found');
    bus.emit('file.deleted', { actorId: me(req).id }, { path: toSharedRef(cfg.sharedDir, sharedPath(rel)) });
    return { ok: true };
  });
  // Agents write these files, so nothing that could run as a page on this origin is served as one: HTML and SVG go out
  // as plain text, and the web app previews them in a sandboxed frame.
  const TYPES: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json', '.html': 'text/plain; charset=utf-8', '.htm': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
    '.svg': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  };
  server.get<{ Querystring: { path?: string; download?: string } }>('/api/shared/file', async (req, reply) => {
    const file = sharedPath(req.query.path ?? '');
    const opened = inShared(() => openSharedFile(cfg.sharedDir, req.query.path ?? ''));
    if (!opened) throw new HttpError(404, 'file not found');
    // Previews ask again whenever an agent may have changed the file; an unchanged one costs a 304.
    const st = fs.fstatSync(opened.fd);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    reply.header('etag', etag);
    reply.header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) {
      fs.closeSync(opened.fd);
      return reply.code(304).send();
    }
    reply.header('content-type', TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
    reply.header('content-length', st.size);
    reply.header('x-content-type-options', 'nosniff');
    if (req.query.download) reply.header('content-disposition', `attachment; filename="${path.basename(file).replace(/"/g, '')}"`);
    return reply.send(fs.createReadStream('', { fd: opened.fd }));
  });

  // ── realtime ─────────────────────────────────────────────────────────
  server.get('/api/ws', { websocket: true }, (socket, req) => {
    const visible = visibleTo(me(req).id);
    const unsubscribe = bus.subscribe((event) => {
      if (socket.readyState === socket.OPEN && visible(event)) socket.send(JSON.stringify({ type: 'event', event } satisfies WsFrame));
    });
    socket.on('close', unsubscribe);
  });

  // ── the web app (production build) ───────────────────────────────────
  if (fs.existsSync(path.join(cfg.webDist, 'index.html'))) {
    await server.register(fastifyStatic, { root: cfg.webDist });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.status(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return server;
}
