import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { ChatRequest } from '../src/models/types.js';
import { addAgent as addTeammate, removeAgent } from '../src/runtime/helpers.js';
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

/** A helper's reply: finish whichever task is open in its instructions. */
const finishMyTask = (req: ChatRequest) => {
  const n = Number(String(req.messages[0].content).match(/^- #(\d+) \[todo\]/m)?.[1]);
  return n ? callTool('update_task', { task: n, status: 'done', note: `Result for #${n}` }) : say('[silent]');
};

describe('helpers', () => {
  it('run sub-tasks in parallel, report back through the task board, and leave when done', async () => {
    const { app, models, owner, computers } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, { network: { mode: 'allowlist', allow: ['example.com'] } });
    models.script('test/lead', [
      callTool('spawn_helpers', {
        model: 'test/helper',
        helpers: [
          { title: 'Research Acme', task: 'Find Acme pricing and write it to /shared/acme.md' },
          { title: 'Research Globex', task: 'Find Globex pricing and write it to /shared/globex.md' },
        ],
      }),
      say('Two helpers are on it.'),
    ]);
    models.script('test/helper', Array.from({ length: 6 }, () => finishMyTask));

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead compare Acme and Globex pricing' });
    await app.runtime.idle();
    await app.runtime.idle();

    // Both helpers were real agents with their own task, the parent's network rules, and the requested model.
    const created = app.store.listEvents({ types: ['agent.created'] }).reverse().map((e) => e.data.agent as { name: string; parentId: string; network: unknown; model: string });
    expect(created.map((a) => a.name)).toEqual(['Lead-h1', 'Lead-h2']);
    expect(created.every((a) => a.parentId === lead.id && a.model === 'test/helper')).toBe(true);
    expect(created[0].network).toEqual({ mode: 'allowlist', allow: ['example.com'] });

    // Their tasks are done with notes, the lead heard about each, and the helpers are gone (computers too).
    const tasks = app.store.listTasks();
    expect(tasks.map((t) => [t.title, t.status, t.creatorId, t.notes.at(-1)?.text])).toEqual([
      ['Research Acme', 'done', lead.id, 'Result for #1'],
      ['Research Globex', 'done', lead.id, 'Result for #2'],
    ]);
    const leadInputs = JSON.stringify(models.requests.filter((r) => r.model === 'test/lead').map((r) => r.messages));
    expect(leadInputs).toContain('Task #1 \\"Research Acme\\"');
    expect(leadInputs).toContain('is now done');
    expect(app.store.listAgents().map((a) => a.name)).toEqual(['Lead']);
    expect(computers.resets.sort()).toEqual(app.store.listEvents({ types: ['agent.deleted'] }).map((e) => e.agentId).sort());
    expect(app.store.listEvents({ types: ['agent.deleted'] }).every((e) => e.data.helper === true)).toBe(true);
  });

  it('share their parent’s budget, cannot start helpers themselves, and go when the parent goes', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    app.store.updateAgent(lead.id, { budget: { dailyUsd: 0.0001, monthlyUsd: null, dailyTokens: null } });
    const [{ helper }] = app.helpers.spawn(app.store.getAgent(lead.id)!, app.store.createRun({ agentId: lead.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'x' }), [{ title: 'Sub-task', task: 'Do the sub-task please' }]);
    app.runtime.setPausedAll(true, owner.id); // keep the helper from working in this test

    app.bus.emit('llm.response', { agentId: helper.id }, { costUsd: 0.0001, inputTokens: 10, outputTokens: 10 });
    expect(app.budgets.blocked(app.store.getAgent(lead.id)!)).toContain('the daily budget I share with my helpers');
    expect(app.budgets.blocked(app.store.getAgent(helper.id)!)).toContain("Lead's daily budget");

    expect(app.tools.forAgent(app.store.getAgent(helper.id)!).map((t) => t.name)).not.toContain('spawn_helpers');
    expect(() => app.helpers.spawn(app.store.getAgent(helper.id)!, app.store.listRuns({ agentId: lead.id })[0], [{ title: 'Nested', task: 'Nested task here' }])).toThrow(/cannot start helpers/);
    expect(() =>
      app.helpers.spawn(app.store.getAgent(lead.id)!, app.store.listRuns({ agentId: lead.id })[0], Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, task: 'Some task here' }))),
    ).toThrow(/At most 5 helpers/);

    const server = await buildServer(app);
    await server.inject({ method: 'DELETE', url: `/api/agents/${lead.id}` });
    expect(app.store.listAgents()).toHaveLength(0);
    await server.close();
    void models;
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
    const [{ helper }] = app.helpers.spawn(app.store.getAgent(lead.id)!, app.store.listRuns({ agentId: lead.id })[0], [{ title: 'Sub-task', task: 'Do the sub-task please' }]);
    expect(app.tools.forAgent(helper).map((t) => t.name)).not.toContain('create_agent');
  });
});
