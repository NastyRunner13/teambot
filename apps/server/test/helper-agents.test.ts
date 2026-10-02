import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { ChatRequest } from '../src/models/types.js';
import { addAgent as addTeammate, removeAgent } from '../src/runtime/helpers.js';
import { addAgent, general, legacyHelpers, messagesIn, testApp } from './helpers.js';

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

/** A helper's reply: its result, naming the job it was given. */
const reportJob = (req: ChatRequest) => say(`Result for ${String(req.messages.at(-1)?.content).match(/Your job from Lead: (.+)/)?.[1]}`);

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
      callTool('send_dm', { to: 'Analyst', text: 'Compare Acme and Globex annual pricing; report the cheaper option and its source.' }),
      say('[silent]'),
      callTool('post_message', { channel: '#general', text: 'The pricing specialist found Acme cheaper.' }),
      say('[silent]'),
    ]);
    models.script('test/analyst', [say('Acme is cheaper annually; source: https://example.com/pricing')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead compare annual pricing' });
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

describe('legacy helpers', () => {
  it('finish persisted jobs, report back to their parent together, and leave', async () => {
    const { app, models, owner, computers } = setup();
    const lead = addAgent(app, 'Lead');
    models.script('test/lead', [say('Acme and Globex compared.')]);
    models.script('test/helper', [reportJob, reportJob]);

    const run = app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'Compare pricing' });
    app.store.updateRun(run.id, { status: 'completed' });
    legacyHelpers(app, lead, run, [
      { title: 'Research Acme', job: 'Find Acme pricing' },
      { title: 'Research Globex', job: 'Find Globex pricing' },
    ], 'test/helper');
    await app.runtime.idle();
    await app.runtime.idle();

    // The lead heard from both in one go, and only the lead spoke in the chat.
    const heard = models.requests.filter((r) => r.model === 'test/lead').map(lastUserMessage);
    expect(heard.some((m) => m.includes('Lead-h1 reports:\nResult for Research Acme') && m.includes('Lead-h2 reports:\nResult for Research Globex'))).toBe(true);
    const chat = messagesIn(app, general(app).id);
    expect(chat.filter((m) => m.authorId !== owner.id).every((m) => m.authorId === lead.id)).toBe(true);
    expect(chat.at(-1)).toMatchObject({ authorId: lead.id, text: 'Acme and Globex compared.' });

    // The helpers are gone, computers too.
    expect(app.store.listAgents().map((a) => a.name)).toEqual(['Lead']);
    expect(computers.resets.sort()).toEqual(app.store.listEvents({ types: ['agent.deleted'] }).map((e) => e.agentId).sort());
    expect(app.store.listEvents({ types: ['agent.deleted'] }).every((e) => e.data.helper === true)).toBe(true);
  });

  it('that are stopped tell their parent so and leave', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    models.script('test/lead', [say('Noted.')]);
    models.script('test/helper', [callTool('ask_for_approval', { action: 'Email the client' })]);
    const run = app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'x' });
    app.store.updateRun(run.id, { status: 'completed' });
    const [helper] = legacyHelpers(app, app.store.getAgent(lead.id)!, run, [{ title: 'Email', job: 'Email the client the quote' }], 'test/helper');
    await app.runtime.idle();
    const waiting = app.store.listRuns({ agentId: helper.id })[0];
    expect(waiting.status).toBe('waiting_approval');

    app.runtime.cancelRun(waiting.id, owner.id);
    await vi.waitFor(() => expect(app.store.getAgent(helper.id)).toBeUndefined());
    await app.runtime.idle();
    expect(models.requests.filter((r) => r.model === 'test/lead').map(lastUserMessage)).toEqual([expect.stringContaining('Lead-h1 reports:\n(It was stopped before it finished.)')]);
  });

  it("go when their parent's run is stopped, with any results nobody will read", async () => {
    const { app, owner } = setup();
    const lead = addAgent(app, 'Lead');
    app.runtime.setPausedAll(true, owner.id); // nobody works in this test
    const run = app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'x' });
    const [first] = legacyHelpers(app, app.store.getAgent(lead.id)!, run, [
      { title: 'One', job: 'The first part of it' },
      { title: 'Two', job: 'The second part of it' },
    ]);
    app.helpers.report(first, app.store.createRun({ agentId: first.id, channelId: general(app).id, initiator: 'human', depth: 1, title: 'One' }), 'Half done');

    app.runtime.cancelRun(run.id, owner.id);
    await vi.waitFor(() => expect(app.store.listAgents().map((a) => a.name)).toEqual(['Lead']));
    expect(app.store.pendingInbox(lead.id)).toEqual([]);
  });

  it('share their parent’s budget and go when the parent goes', async () => {
    const { app, owner } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, { budget: { dailyUsd: 0.0001, monthlyUsd: null, dailyTokens: null } });
    const [helper] = legacyHelpers(app, app.store.getAgent(lead.id)!, app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'x' }), [{ title: 'Sub-task', job: 'Do the sub-task please' }]);
    app.runtime.setPausedAll(true, owner.id); // keep the helper from working in this test

    app.bus.emit('llm.response', { agentId: helper.id }, { costUsd: 0.0001, inputTokens: 10, outputTokens: 10 });
    expect(app.budgets.blocked(app.store.getAgent(lead.id)!)).toContain('the daily budget I share with my helpers');
    expect(app.budgets.blocked(app.store.getAgent(helper.id)!)).toContain("Lead's daily budget");

    expect(app.tools.forAgent(app.store.getAgent(helper.id)!).map((t) => t.name)).not.toContain('spawn_helpers');

    const server = await buildServer(app);
    await server.inject({ method: 'DELETE', url: `/api/agents/${lead.id}` });
    expect(app.store.listAgents()).toHaveLength(0);
    await server.close();
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
      parentId: null,
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

  it('is capped per creator and not offered to helpers', async () => {
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

    app.runtime.setPausedAll(true, owner.id);
    const [helper] = legacyHelpers(app, app.store.getAgent(lead.id)!, app.store.listRuns({ agentId: lead.id })[0], [{ title: 'Sub-task', job: 'Do the sub-task please' }]);
    expect(app.tools.forAgent(helper).map((t) => t.name)).not.toContain('create_agent');
  });
});
