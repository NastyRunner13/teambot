import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { ChatRequest } from '../src/models/types.js';
import { addAgent as addTeammate, removeAgent } from '../src/runtime/agents.js';
import { MIGRATIONS, Store } from '../src/store.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

function setup() {
  const t = testApp();
  current = t.app;
  t.app.runtime.start();
  return t;
}

const lastUserMessage = (req: ChatRequest) => String([...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '');

describe('independent work and existing specialists', () => {
  it('rejects obsolete helper calls and continues research on its own computer', async () => {
    const { app, models, owner, computers } = setup();
    const lead = addAgent(app, 'Lead');
    const writer = addAgent(app, 'Writer');
    models.script('test/lead', [
      callTool('spawn_helpers', { helpers: [{ title: 'Research', job: 'Research Acme pricing' }] }),
      callTool('browser_navigate', { url: 'https://example.com/pricing' }),
      say('I researched the pricing.'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead research Acme pricing' });
    await app.runtime.idle();

    const request = models.requests.find((r) => r.model === 'test/lead')!;
    const tools = request.tools!.map((t) => t.function.name);
    expect(tools).not.toContain('spawn_helpers');
    expect(tools).toEqual(expect.arrayContaining(['browser_navigate', 'shell', 'send_dm', 'create_agent']));
    expect(JSON.stringify(request.messages[0])).not.toContain('spawn_helpers');
    const run = app.store.listRuns({ agentId: lead.id })[0];
    expect(app.store.getTranscript<{ role: string; content: string }>(run.id).find((m) => m.role === 'tool')?.content)
      .toContain('there is no tool named "spawn_helpers"');
    expect(computers.calls).toContainEqual(expect.objectContaining({ agentId: lead.id, path: '/browser/navigate' }));
    expect(app.store.listAgents().map((a) => a.id).sort()).toEqual([lead.id, writer.id].sort());
    expect(app.store.listEvents({ types: ['agent.created'] })).toEqual([]);
    expect(app.store.listRuns({ agentId: writer.id })).toEqual([]);
    expect(messagesIn(app, general(app).id).at(-1)?.text).toBe('I researched the pricing.');
  });

  it('shows specialties and supports a focused request to an existing specialist', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    const writer = addAgent(app, 'Writer');
    app.store.updateAgent(analyst.id, { role: 'Competitor pricing analysis' });
    models.script('test/lead', [
      callTool('ask_agent', { to: 'Analyst', task: 'Compare Acme and Globex annual pricing', expected_result: 'The cheaper option and its source' }),
      say('I asked Analyst to compare the pricing.'),
      say('The pricing specialist found Acme cheaper.'),
    ]);
    // Analyst waits for a person first, so its answer comes after Lead's turn.
    models.script('test/analyst', [callTool('ask_for_approval', { action: 'Open the pricing pages' }), say('Acme is cheaper annually; source: https://example.com/pricing')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead compare annual pricing' });
    await app.runtime.idle();
    app.runtime.resolveApproval(app.store.listApprovals({ status: 'pending' })[0].id, 'approve', null, owner.id);
    await app.runtime.idle();

    const requests = models.requests.filter((r) => r.model === 'test/lead');
    const prompt = String(requests[0].messages[0].content);
    expect(prompt).toContain('Analyst — Competitor pricing analysis');
    expect(prompt).toContain('Work independently by default');
    expect(prompt).toContain('only when its stated role in the Team roster shows a specific specialty relevant to the task');
    expect(prompt).toContain('If no specialty fits, do the work yourself');
    expect(requests.some((r) => lastUserMessage(r).includes('Acme is cheaper annually'))).toBe(true);
    expect(app.store.listRuns({ agentId: analyst.id })).toHaveLength(1);
    expect(app.store.listRuns({ agentId: writer.id })).toEqual([]);
    expect(app.store.listAgents()).toHaveLength(3);
    expect(messagesIn(app, general(app).id).at(-1)?.text).toBe('The pricing specialist found Acme cheaper.');
    expect(app.store.listEvents({ types: ['agent.created'] })).toEqual([]);
    expect(app.store.getChannel(app.workspace.getOrCreateDm(lead.id, analyst.id).id)!.memberIds.sort()).toEqual([lead.id, analyst.id].sort());
  });
});

describe('create_agent', () => {
  const analyst = { name: 'Analyst', role: 'Pricing analysis', instructions: 'Track competitor pricing weekly and report changes.', reason: 'Pricing questions keep coming up' };
  const toolResults = (app: App, agentId: string) =>
    app.store.listRuns({ agentId }).flatMap((r) => app.store.getTranscript<{ role: string; content: string }>(r.id).filter((m) => m.role === 'tool').map((m) => m.content));

  it('adds a permanent teammate after a human approves, with no more than its creator has', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, {
      network: { mode: 'allowlist', allow: ['example.com'] },
      budget: { dailyUsd: 2, monthlyUsd: null, dailyTokens: null },
      mcpServers: ['github', 'linear'],
    });
    models.script('test/lead', [callTool('create_agent', { ...analyst, mcp_servers: ['github'] }), say('Analyst is on board.')]);

    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'We need someone on pricing' });
    await app.runtime.idle();

    const [approval] = app.store.listApprovals({ status: 'pending' });
    expect(approval.reason).toBe('Confirm new agents');
    expect(approval.summary).toBe('Add Analyst to the team (Pricing analysis): Pricing questions keep coming up');
    expect(app.store.getAgentByName('Analyst')).toBeUndefined();

    app.runtime.resolveApproval(approval.id, 'approve', null, owner.id);
    await app.runtime.idle();

    const created = app.store.getAgentByName('Analyst')!;
    expect(created).toMatchObject({
      role: 'Pricing analysis',
      model: 'test/model',
      mcpServers: ['github'],
      skills: ['*'],
      desktop: false,
      network: { mode: 'allowlist', allow: ['example.com'] },
      budget: { dailyUsd: 2, monthlyUsd: null, dailyTokens: null },
    });
    // In #general, but not added to the private DM it was asked from.
    expect(general(app).memberIds).toContain(created.id);
    expect(app.store.getChannel(dm.id)!.memberIds).not.toContain(created.id);
    const [event] = app.store.listEvents({ types: ['agent.created'] });
    expect([event.actorId, event.data.createdBy]).toEqual([lead.id, lead.id]);
    expect(messagesIn(app, dm.id).at(-1)!.text).toBe('Analyst is on board.');
  });

  it('refuses before asking anyone when the request gives more than the creator has, or the name is taken', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, { mcpServers: ['github'] });
    models.script('test/lead', [
      callTool('create_agent', { ...analyst, mcp_servers: ['github', 'gmail'] }),
      callTool('create_agent', { ...analyst, skills: ['weekly-report'] }),
      callTool('create_agent', { ...analyst, name: 'lead' }),
      say('[silent]'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead add a pricing analyst' });
    await app.runtime.idle();

    expect(app.store.listApprovals({ status: 'pending' })).toHaveLength(0);
    expect(toolResults(app, lead.id)).toEqual([
      expect.stringContaining('not yours: gmail'),
      expect.stringContaining('not yours: weekly-report'),
      expect.stringContaining('The name lead is taken'),
    ]);
    expect(app.store.listAgents().map((a) => a.name)).toEqual(['Lead']);
  });

  it('is capped per creator', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    for (let i = 1; i <= 5; i++) addTeammate(app, { name: `Made${i}`, role: '', instructions: '', model: 'test/model', mcpServers: [] }, lead.id, { createdBy: lead.id });
    models.script('test/lead', [callTool('create_agent', analyst), say('[silent]')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead add a pricing analyst' });
    await app.runtime.idle();
    expect(toolResults(app, lead.id)).toEqual([expect.stringContaining('already added 5 agents')]);

    // Removing one frees a slot.
    await removeAgent(app, app.store.getAgentByName('Made1')!, owner.id);
    models.script('test/lead', [callTool('create_agent', analyst), say('[silent]')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead try again' });
    await app.runtime.idle();
    expect(app.store.listApprovals({ status: 'pending' })).toHaveLength(1);
  });
});

describe('removing helpers left from before (migration 16)', () => {
  it('removes them as deleting an agent would, and keeps their history', () => {
    const file = path.join(os.tmpdir(), `teambot-helpers-${crypto.randomBytes(4).toString('hex')}.db`);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    MIGRATIONS.slice(0, 15).forEach((sql) => db.exec(sql)); // through 15: the schema with helpers
    db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '15')`);

    const at = '2026-10-02T10:00:00.000Z';
    const agent = (id: string, name: string, parentId: string | null) =>
      db.prepare(`INSERT INTO agents (id, name, role, instructions, model, avatar, color, status, created_at, updated_at, parent_id) VALUES (?, ?, '', '', 'm', 'a', 'c', 'idle', ?, ?, ?)`).run(id, name, at, at, parentId);
    const run = (id: string, agentId: string, status: string) =>
      db.prepare(`INSERT INTO runs (id, agent_id, status, channel_id, initiator, depth, title, created_at, updated_at) VALUES (?, ?, ?, 'chn_general', 'human', 0, 't', ?, ?)`).run(id, agentId, status, at, at);
    const inbox = (id: string, agentId: string, kind: string, runId: string | null) =>
      db.prepare(`INSERT INTO inbox (id, agent_id, kind, text, channel_id, initiator, created_at, run_id) VALUES (?, ?, ?, 'x', 'chn_general', 'agent', ?, ?)`).run(id, agentId, kind, at, runId);

    db.prepare(`INSERT INTO channels (id, name, kind, created_at) VALUES ('chn_general', 'general', 'channel', ?)`).run(at);
    agent('agt_lead', 'Lead', null);
    agent('agt_helper', 'Lead-h1', 'agt_lead');
    for (const id of ['agt_lead', 'agt_helper']) db.prepare(`INSERT INTO channel_members (channel_id, member_id) VALUES ('chn_general', ?)`).run(id);
    db.prepare(`INSERT INTO helper_lineage (agent_id, parent_id) VALUES ('agt_helper', 'agt_lead')`).run();
    run('run_done', 'agt_helper', 'completed');
    run('run_waiting', 'agt_helper', 'waiting_approval');
    db.prepare(`INSERT INTO approvals (id, agent_id, run_id, tool_call_id, kind, tool, args, summary, reason, status, created_at) VALUES ('apr_1', 'agt_helper', 'run_waiting', 'c1', 'approval', 'shell', '{}', 's', 'r', 'pending', ?)`).run(at);
    inbox('inb_job', 'agt_helper', 'helper', null); // its unread job
    inbox('inb_result', 'agt_lead', 'helper', null); // a result its parent never read
    inbox('inb_read', 'agt_lead', 'helper', 'run_old'); // one it did read: history
    inbox('inb_msg', 'agt_lead', 'message', null); // ordinary work: untouched
    db.close();

    const store = new Store(file);
    try {
      expect(store.listAgents().map((a) => a.id)).toEqual(['agt_lead']);
      expect(store.getChannel('chn_general')!.memberIds).toEqual(['agt_lead']);
      expect(store.pendingInbox('agt_lead').map((i) => i.id)).toEqual(['inb_msg']);
      expect(store.getRun('run_done')!.status).toBe('completed');
      expect(store.getRun('run_waiting')!.status).toBe('cancelled');
      expect(store.getApproval('apr_1')!.status).toBe('cancelled');
    } finally {
      store.close();
    }
    const after = new DatabaseSync(file);
    try {
      expect(after.prepare('PRAGMA table_info(agents)').all().map((c) => c.name)).not.toContain('parent_id');
      expect(after.prepare(`SELECT name FROM sqlite_master WHERE name = 'helper_lineage'`).all()).toEqual([]);
      expect(after.prepare(`SELECT id FROM inbox WHERE kind = 'helper'`).all().map((r) => r.id)).toEqual(['inb_read']);
    } finally {
      after.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  });
});
