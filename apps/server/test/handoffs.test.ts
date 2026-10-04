// ask_agent: a structured request in the two agents' DM, the answer brought back to the conversation that asked (all
// of one run's answers together), and a request that never gets one said out loud instead of dropped.
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { removeAgent } from '../src/runtime/agents.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

function setup(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  current = t.app;
  t.app.runtime.start();
  return t;
}

const ask = (to: string, task: string, extra: Record<string, unknown> = {}) => callTool('ask_agent', { to, task, expected_result: 'A short answer with sources', ...extra });

/** Everything an agent was told and everything its tools answered, across its runs. */
function transcriptOf(app: App, agentId: string) {
  return app.store.listRuns({ agentId }).flatMap((r) => app.store.getTranscript<{ role: string; content: string }>(r.id));
}
const userMessages = (app: App, agentId: string) => transcriptOf(app, agentId).filter((m) => m.role === 'user').map((m) => String(m.content));
/** Approve every pending request, one at a time, letting each agent carry on before the next. */
async function approveAll(app: App, humanId: string) {
  for (const a of app.store.listApprovals({ status: 'pending' })) {
    app.runtime.resolveApproval(a.id, 'approve', null, humanId);
    await app.runtime.idle();
  }
}
const toolResults = (app: App, agentId: string) => transcriptOf(app, agentId).filter((m) => m.role === 'tool').map((m) => String(m.content));

describe('ask_agent', () => {
  it('posts a structured request and brings the answer back to the conversation that asked', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    models.script('test/lead', [
      ask('Analyst', 'Compare Acme and Globex annual pricing', { context: 'For the Q3 budget', constraints: "Use the vendors' own pricing pages", expected_result: 'The cheaper option, both prices and source links' }),
      say('I asked Analyst to compare the pricing.'),
      say('Acme is cheaper: $100 a year against $120.'),
    ]);
    // Analyst waits for a person first, so Lead has finished its turn by the time the answer comes.
    models.script('test/analyst', [
      callTool('ask_for_approval', { action: 'Open the vendor sites' }),
      say('Acme $100/yr, Globex $120/yr. Sources: https://acme.test/pricing, https://globex.test/pricing'),
      say('Lead asked me to compare Acme and Globex pricing. I sent back both prices with sources.'),
    ]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Which is cheaper, Acme or Globex?' });
    await app.runtime.idle();
    await approveAll(app, owner.id);

    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual([
      'Which is cheaper, Acme or Globex?',
      'I asked Analyst to compare the pricing.',
      'Acme is cheaper: $100 a year against $120.',
    ]);
    const between = app.workspace.getOrCreateDm(lead.id, analyst.id);
    const [request, answer] = messagesIn(app, between.id);
    expect(request.authorId).toBe(lead.id);
    expect(request.text).toBe(
      "**Task:** Compare Acme and Globex annual pricing\n\n**Context:** For the Q3 budget\n\n**Constraints:** Use the vendors' own pricing pages\n\n**A good answer:** The cheaper option, both prices and source links",
    );
    expect(answer.authorId).toBe(analyst.id);
    const told = userMessages(app, analyst.id)[0];
    expect(told).toContain('Lead (agent) asked you for this. Your final reply is your answer and goes straight back to Lead');
    expect(told.split('**Task:**')).toHaveLength(2); // the request appears once, not again as recent conversation
    // The answer reached Lead where the person asked; Lead never worked in the agents' DM.
    expect(app.store.listRuns({ agentId: lead.id }).every((r) => r.channelId === dm.id)).toBe(true);
    expect(userMessages(app, lead.id).some((m) => m.includes('Analyst answered what you asked ("Compare Acme and Globex annual pricing")') && m.includes('Acme $100/yr'))).toBe(true);
    expect(app.store.listHandoffs({ fromAgentId: lead.id })).toMatchObject([{ status: 'answered', delivered: true, originChannelId: dm.id, answerId: answer.id }]);
    // People see where the work went from the chat that asked, and where the answer came from.
    expect(app.store.listSentElsewhere(dm.id).map((m) => m.id)).toEqual([request.id, answer.id]);
    expect(app.store.listEvents({ types: ['handoff.answered'] })[0].data).toMatchObject({ message: { id: answer.id } });

    // Analyst also tells the person in its own chat with them, from the run that did the work.
    const told2 = userMessages(app, analyst.id).at(-1);
    expect(told2).toBe(
      `[system] Your answer went back to Lead. Now write a short note for ${owner.name}, the person it was for; it is posted in your chat with them. ` +
        "In one or two lines, say what Lead asked you and what you sent back, including anything you couldn't do. Don't repeat the whole answer, and don't use tools.",
    );
    const withAnalyst = app.store.findDm(owner.id, analyst.id)!;
    const [note] = messagesIn(app, withAnalyst.id);
    expect(note).toMatchObject({ authorId: analyst.id, text: 'Lead asked me to compare Acme and Globex pricing. I sent back both prices with sources.' });
    expect(app.store.getRun(note.runId!)?.channelId).toBe(between.id);
    expect(messagesIn(app, between.id)).toHaveLength(2); // the note isn't posted where the agents talk
    expect(app.store.listSentElsewhere(between.id).map((m) => m.id)).toEqual([note.id]);
  });

  it('has the person hear from every agent in a chain, and nobody in a group chat', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    const researcher = addAgent(app, 'Researcher');
    models.script('test/lead', [ask('Analyst', 'Size the market'), say('Asked Analyst.'), say('About $2B.'), ask('Analyst', 'Check the date'), say('[silent]'), say('It is Monday.')]);
    models.script('test/analyst', [
      ask('Researcher', 'Find market reports'),
      say('[silent]'),
      say('About $2B, from two reports.'),
      say('Lead asked me to size the market. I said about $2B.'),
      say('Monday.'),
    ]);
    models.script('test/researcher', [callTool('ask_for_approval', { action: 'Buy the market report' }), say('Two reports: $1.9B and $2.1B.'), say('Analyst asked me for market reports. I sent two.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'How big is the market?' });
    await app.runtime.idle();
    await approveAll(app, owner.id);

    // Researcher was asked by Analyst on Lead's behalf, for the owner.
    expect(messagesIn(app, app.store.findDm(owner.id, researcher.id)!.id).map((m) => m.text)).toEqual(['Analyst asked me for market reports. I sent two.']);
    expect(messagesIn(app, app.store.findDm(owner.id, analyst.id)!.id).map((m) => m.text)).toEqual(['Lead asked me to size the market. I said about $2B.']);
    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(['How big is the market?', 'Asked Analyst.', 'About $2B.']);

    // Asked from a group chat, where everyone sees the exchange: no note, and no extra turn.
    const before = models.requests.filter((r) => r.model === 'test/analyst').length;
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead what day is it?' });
    await app.runtime.idle();
    expect(models.requests.filter((r) => r.model === 'test/analyst').length).toBe(before + 1);
    expect(messagesIn(app, app.store.findDm(owner.id, analyst.id)!.id)).toHaveLength(1);
    expect(messagesIn(app, general(app).id).at(-1)?.text).toBe('It is Monday.');
  });

  it('waits for every teammate a run asked, then delivers their answers together', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    addAgent(app, 'Analyst');
    addAgent(app, 'Writer');
    models.script('test/lead', [ask('Analyst', 'Find the numbers'), ask('Writer', 'Draft the intro'), say('Asked Analyst and Writer.'), say('Here is the combined report.')]);
    // Both wait for a person, so neither answers before Lead has asked them both.
    models.script('test/analyst', [callTool('ask_for_approval', { action: 'Read the finance sheet' }), say('The numbers are 1, 2, 3.')]);
    models.script('test/writer', [callTool('ask_for_approval', { action: 'Read the style guide' }), say('Intro: once upon a time.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Put the report together' });
    await app.runtime.idle();
    await approveAll(app, owner.id);

    const deliveries = userMessages(app, lead.id).filter((m) => m.includes('answered what you asked'));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain('Analyst answered what you asked ("Find the numbers"):\nThe numbers are 1, 2, 3.');
    expect(deliveries[0]).toContain('Writer answered what you asked ("Draft the intro"):\nIntro: once upon a time.');
    expect(messagesIn(app, dm.id).at(-1)?.text).toBe('Here is the combined report.');
  });

  it('tells the asker when the teammate fails or finishes without replying', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    addAgent(app, 'Analyst');
    addAgent(app, 'Writer');
    models.script('test/lead', [ask('Analyst', 'Find the numbers'), ask('Writer', 'Draft the intro'), say('Asked both.'), say('Neither came back, so I did it myself.')]);
    models.script('test/analyst', [
      callTool('ask_for_approval', { action: 'Read the finance sheet' }),
      () => {
        throw new Error('model unavailable');
      },
    ]);
    models.script('test/writer', [callTool('ask_for_approval', { action: 'Read the style guide' }), say('[silent]')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Put the report together' });
    await app.runtime.idle();
    await approveAll(app, owner.id);

    const delivery = userMessages(app, lead.id).find((m) => m.includes("didn't answer"))!;
    expect(delivery).toContain('Analyst didn\'t answer what you asked ("Find the numbers"): their run failed (model unavailable).');
    expect(delivery).toContain('Writer didn\'t answer what you asked ("Draft the intro"): they finished without replying.');
    expect(delivery).toContain("Do that part yourself if you can, or say plainly that it didn't come back.");
    expect(app.store.listHandoffs({ fromAgentId: lead.id }).map((h) => h.status)).toEqual(['failed', 'failed']);
    expect(messagesIn(app, dm.id).at(-1)?.text).toBe('Neither came back, so I did it myself.');
    expect(app.store.listRuns({ agentId: lead.id }).every((r) => r.channelId === dm.id)).toBe(true);
  });

  it('keeps work for agents in ask_agent and work for people in send_dm', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    models.script('test/lead', [
      callTool('send_dm', { to: 'Analyst', text: 'Can you look into pricing?' }),
      callTool('post_message', { channel: '@Analyst', text: 'Can you look into pricing?' }),
      ask(owner.name, 'Look into pricing'),
      callTool('send_dm', { to: owner.name, text: 'Starting on it.' }),
      say('[silent]'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead look into pricing' });
    await app.runtime.idle();

    const [viaDm, viaPost, viaAsk, toPerson] = toolResults(app, lead.id);
    expect(viaDm).toContain('Analyst is an agent. To hand it work, use ask_agent');
    expect(viaPost).toContain('To hand Analyst work, use ask_agent');
    expect(viaAsk).toContain('is a person. To message them, use send_dm');
    expect(toPerson).toBe(`Sent to ${owner.name}.`);
    expect(app.store.findDm(lead.id, analyst.id)).toBeUndefined();
    expect(app.store.listRuns({ agentId: analyst.id })).toEqual([]);
  });

  it('limits how many teammates one run may hand work to, counting @mentions in group chats', async () => {
    const { app, models, owner } = setup();
    app.cfg.maxHandoffsPerRun = 2;
    const lead = addAgent(app, 'Lead');
    addAgent(app, 'One');
    addAgent(app, 'Two');
    const three = addAgent(app, 'Three');
    models.script('test/lead', [
      ask('One', 'Part one'),
      callTool('post_message', { channel: '#general', text: '@Two can you take part two?' }),
      ask('Three', 'Part three'),
      callTool('post_message', { channel: '#general', text: '@Three can you take part three?' }),
      callTool('post_message', { channel: '#general', text: '@Two thanks, and @Lead noted' }),
      say('[silent]'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead split this up' });
    await app.runtime.idle();

    const results = toolResults(app, lead.id).slice(0, 5);
    expect(results[0]).toContain('Asked One.');
    expect(results[1]).toBe('Posted in #general.');
    expect(results[2]).toContain('You have already handed work to 2 teammates in this job, and the limit is 2.');
    expect(results[3]).toContain('the limit is 2');
    expect(results[4]).toBe('Posted in #general.'); // Two was already counted, and naming yourself wakes nobody
    expect(app.store.listRuns({ agentId: three.id })).toEqual([]);
  });

  it('refuses to pass a job further once it has hopped between agents too often', async () => {
    const { app, models, owner } = setup({ maxAgentDepth: 1 });
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    const researcher = addAgent(app, 'Researcher');
    models.script('test/lead', [ask('Analyst', 'Research the market'), say('Asked Analyst.'), say('Done.')]);
    models.script('test/analyst', [ask('Researcher', 'Dig into the sources'), say('I looked into it myself: the market is growing.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'How is the market?' });
    await app.runtime.idle();

    expect(toolResults(app, analyst.id)[0]).toContain('This job has already been passed between agents 1 times, the most allowed without a person.');
    expect(app.store.listRuns({ agentId: researcher.id })).toEqual([]);
    expect(userMessages(app, lead.id).some((m) => m.includes('Analyst answered') && m.includes('the market is growing'))).toBe(true);
  });

  it('lets an agent that asks someone else answer its own asker once it hears back', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    addAgent(app, 'Researcher');
    models.script('test/lead', [ask('Analyst', 'Size the market'), say('Asked Analyst.'), say('The market is about $2B.')]);
    models.script('test/analyst', [ask('Researcher', 'Find market reports'), say('[silent]'), say('Market size: about $2B, from two reports.')]);
    // Researcher waits for a person, so Analyst ends its first turn still waiting on the answer.
    models.script('test/researcher', [callTool('ask_for_approval', { action: 'Buy the market report' }), say('Two reports: $1.9B and $2.1B.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'How big is the market?' });
    await app.runtime.idle();
    expect(app.store.listHandoffs({ fromAgentId: lead.id })).toMatchObject([{ status: 'open' }]); // not failed for ending silently
    await approveAll(app, owner.id);

    expect(toolResults(app, analyst.id)[0]).toContain('end your turn now with exactly [silent]');
    const between = app.workspace.getOrCreateDm(lead.id, analyst.id);
    expect(app.store.listRuns({ agentId: analyst.id }).every((r) => r.channelId === between.id)).toBe(true);
    expect(app.store.listHandoffs({ fromAgentId: analyst.id })).toMatchObject([{ status: 'answered', outcome: 'Two reports: $1.9B and $2.1B.' }]);
    expect(app.store.listHandoffs({ fromAgentId: lead.id })).toMatchObject([{ status: 'answered', outcome: 'Market size: about $2B, from two reports.' }]);
    expect(messagesIn(app, dm.id).at(-1)?.text).toBe('The market is about $2B.');
  });

  it('drops an answer that arrives after the asking run was stopped', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    models.script('test/lead', [ask('Analyst', 'Find the numbers'), callTool('ask_for_approval', { action: 'Publish the numbers' })]);
    models.script('test/analyst', [callTool('ask_for_approval', { action: 'Read the finance sheet' }), say('The numbers are 1, 2, 3.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Get the numbers and publish them' });
    await app.runtime.idle();
    const [leadRun] = app.store.listRuns({ agentId: lead.id });
    app.runtime.cancelRun(leadRun.id, owner.id);
    const pending = app.store.listApprovals({ status: 'pending' }).find((a) => a.agentId === analyst.id)!;
    app.runtime.resolveApproval(pending.id, 'approve', null, owner.id);
    await app.runtime.idle();

    const between = app.workspace.getOrCreateDm(lead.id, analyst.id);
    expect(messagesIn(app, between.id).at(-1)?.text).toBe('The numbers are 1, 2, 3.');
    expect(app.store.listRuns({ agentId: lead.id })).toHaveLength(1);
    expect(app.store.listHandoffs({ fromAgentId: lead.id })).toMatchObject([{ status: 'cancelled', delivered: true }]);
  });

  it('tells the asker when the teammate is removed from the team', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    models.script('test/lead', [ask('Analyst', 'Find the numbers'), say('Asked Analyst.'), say('Analyst left, so I will find them myself.')]);
    models.script('test/analyst', [callTool('ask_for_approval', { action: 'Read the finance sheet' })]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Get the numbers' });
    await app.runtime.idle();
    await removeAgent(app, analyst, owner.id);
    await app.runtime.idle();

    expect(userMessages(app, lead.id).some((m) => m.includes('Analyst didn\'t answer what you asked ("Find the numbers"): they were removed from the team.'))).toBe(true);
    expect(messagesIn(app, dm.id).at(-1)?.text).toBe('Analyst left, so I will find them myself.');
  });

  it('tells the asker once when the teammate runs out of budget, and turns away one that already has', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const analyst = addAgent(app, 'Analyst');
    const broke = addAgent(app, 'Broke');
    // Each scripted model call uses 120 tokens: Analyst can make two, Broke none.
    app.store.updateAgent(analyst.id, { budget: { dailyUsd: null, monthlyUsd: null, dailyTokens: 200 } });
    app.store.updateAgent(broke.id, { budget: { dailyUsd: null, monthlyUsd: null, dailyTokens: 0 } });
    models.script('test/lead', [ask('Broke', 'Anything'), ask('Analyst', 'Find the numbers'), say('Asked Analyst.'), say('Analyst is out of budget for today.')]);
    models.script('test/analyst', [callTool('read_channel', { channel: '#general' }), callTool('read_channel', { channel: '#general' }), say('The numbers are 1, 2, 3.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Get the numbers' });
    await app.runtime.idle();
    app.runtime.poke(); // dispatch checks the budget again on every tick
    await app.runtime.idle();

    expect(toolResults(app, lead.id)[0]).toContain("Broke has reached its daily token budget (0 of 0 tokens today), so it can't take work until that resets.");
    const notices = userMessages(app, lead.id).filter((m) => m.includes('Analyst has reached its daily token budget'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('Its answer will come once the budget resets or is raised.');
    expect(app.store.listHandoffs({ toAgentId: analyst.id })).toMatchObject([{ status: 'open', delayNoted: true }]);
    expect(messagesIn(app, dm.id).at(-1)?.text).toBe('Analyst is out of budget for today.');
  });
});
