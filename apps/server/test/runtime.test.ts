import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@teambot/shared';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { Runtime } from '../src/runtime/runtime.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

function setup(opts?: { maxAgentDepth?: number }) {
  const t = testApp(opts);
  current = t.app;
  t.app.runtime.start();
  return t;
}

const lastToolResult = (app: App, runId: string) =>
  app.store
    .getTranscript<TranscriptMessage>(runId)
    .filter((m) => m.role === 'tool')
    .at(-1)?.content;

describe('agent runtime', () => {
  it('answers a DM with its final reply', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('Hi! I can help with that.')]);

    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Can you help me write a launch post?' });
    await app.runtime.idle();

    const msgs = messagesIn(app, dm.id);
    expect(msgs.map((m) => m.text)).toEqual(['Can you help me write a launch post?', 'Hi! I can help with that.']);
    const run = app.store.listRuns({ agentId: writer.id })[0];
    expect(run.status).toBe('completed');
    expect(run.initiator).toBe('human');
    // The model saw the system prompt, the request and the tools.
    const req = models.requests[0];
    expect(req.messages[0].content).toContain('You are Writer');
    expect(req.messages[1].content).toContain('Can you help me write a launch post?');
    expect(req.tools?.some((t) => t.function.name === 'browser_navigate')).toBe(true);
    expect(app.store.getAgent(writer.id)!.status).toBe('idle');
  });

  it('asks again when a model ends its turn without any text, so the answer still gets posted', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    // Some models end a turn with only reasoning: no text and no tool calls.
    models.script('test/writer', [{ role: 'assistant', content: null }, say('Here are the benchmarks.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'What are the benchmarks?' });
    await app.runtime.idle();

    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(['What are the benchmarks?', 'Here are the benchmarks.']);
    expect(models.requests[1].messages.at(-1)!.content).toContain('ended without any text');
    expect(app.store.listRuns({ agentId: writer.id })[0].status).toBe('completed');

    // Empty twice: the run ends with a note rather than in silence, and without asking a third time.
    models.script('test/writer', [{ role: 'assistant', content: null }, say('  ')]);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'And the prices?' });
    await app.runtime.idle();
    expect(messagesIn(app, dm.id).at(-1)!.text).toContain('I finished without writing a reply');
    expect(models.requests).toHaveLength(4);
  });

  it('tells agents to say where answers came from and to report only what their tools showed', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    addAgent(app, 'Analyst');
    models.script('test/lead', [callTool('ask_agent', { to: 'Analyst', task: 'Check the price', expected_result: 'The price and its source' }), say('Asked Analyst.')]);

    app.workspace.postMessage({ channelId: app.workspace.getOrCreateDm(owner.id, lead.id).id, authorId: owner.id, text: 'What does Acme cost?' });
    await app.runtime.idle();

    const promptOf = (model: string) => String(models.requests.find((r) => r.model === model)!.messages[0].content);
    const prompt = promptOf('test/lead');
    expect(prompt).toContain("When it rests on something you read with a tool (a page, a file, a message, a teammate's answer), name or link it.");
    expect(prompt).toContain('figures, prices, dates, deadlines, limits');
    expect(prompt).toContain("That is not a reason to go searching. If nothing you can reach covers the question, give your best answer and mark it unverified.");
    expect(prompt).toContain("it is probably newer than your training. Look up what was asked directly; don't spend steps first proving that it exists.");
    expect(prompt).toContain('Never say you sent, saved, created, changed, ran or checked something unless a tool result in this job shows it happened.');
    // Where the final reply goes reads cleanly, whether the run works for a person or for another agent.
    expect(prompt).toContain(`It is posted automatically to DM with ${owner.name}. If there is nothing useful to say`);
    expect(promptOf('test/analyst')).toContain('It is posted automatically to DM with Lead. You are working for Lead here, so that reply is your answer to them: make it complete. If there');
  });

  it('only wakes agents that are mentioned in a channel', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('On it.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'Morning all. @Writer draft the post please' });
    await app.runtime.idle();

    expect(app.store.listRuns({ agentId: writer.id })).toHaveLength(1);
    expect(app.store.listRuns({ agentId: lead.id })).toHaveLength(0);
  });

  it('lets agents hand work to each other with mentions, and stops ping-pong loops', async () => {
    const { app, models, owner } = setup({ maxAgentDepth: 3 });
    addAgent(app, 'Ping');
    addAgent(app, 'Pong');
    const ping = Array.from({ length: 5 }, () => say('@Pong your turn'));
    const pong = Array.from({ length: 5 }, () => say('@Ping your turn'));
    models.script('test/ping', ping).script('test/pong', pong);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ping start' });
    await app.runtime.idle();

    const texts = messagesIn(app, general(app).id).map((m) => m.text);
    // human(0) → Ping(1) → Pong(2) → Ping(3) → Pong(4): posted, but depth 4 > 3 so it wakes nobody.
    expect(texts).toEqual(['@Ping start', '@Pong your turn', '@Ping your turn', '@Pong your turn', '@Ping your turn']);
    expect(app.store.listEvents({ types: ['loop.guard'] })).toHaveLength(1);
  });

  it('pauses for approval on risky clicks, then runs the click once approved', async () => {
    const { app, models, owner, computers } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [callTool('browser_click', { ref: 3 }), say('Sent the email.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer send it' });
    await app.runtime.idle();

    const [approval] = app.store.listApprovals({ status: 'pending' });
    expect(approval.summary).toBe('Click "Send" on mail.example.com');
    expect(approval.reason).toBe('Confirm clicks that send, publish, pay or delete');
    expect(app.store.getRun(approval.runId)!.status).toBe('waiting_approval');
    expect(app.store.getAgent(writer.id)!.status).toBe('waiting');
    expect(computers.calls.some((c) => c.path === '/browser/click')).toBe(false);

    app.runtime.resolveApproval(approval.id, 'approve', null, owner.id);
    await app.runtime.idle();

    expect(computers.calls.filter((c) => c.path === '/browser/click')).toHaveLength(1);
    expect(app.store.getRun(approval.runId)!.status).toBe('completed');
    expect(messagesIn(app, general(app).id).at(-1)!.text).toBe('Sent the email.');
  });

  it('tells the agent when a human denies, without running the tool', async () => {
    const { app, models, owner, computers } = setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('browser_click', { ref: 3 }), say('Understood, not sending.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer send it' });
    await app.runtime.idle();
    const [approval] = app.store.listApprovals({ status: 'pending' });
    app.runtime.resolveApproval(approval.id, 'deny', 'Not yet, wait for legal', owner.id);
    await app.runtime.idle();

    expect(computers.calls.some((c) => c.path === '/browser/click')).toBe(false);
    expect(lastToolResult(app, approval.runId)).toContain('Not yet, wait for legal');
  });

  it('hands password fields to a human instead of typing them', async () => {
    const { app, models, owner, computers } = setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('browser_type', { ref: 2, text: 'hunter2' }), say('Logged in.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer log in' });
    await app.runtime.idle();
    const [handoff] = app.store.listApprovals({ status: 'pending' });
    expect(handoff.kind).toBe('handoff');
    app.runtime.resolveApproval(handoff.id, 'done', 'typed it', owner.id);
    await app.runtime.idle();

    expect(computers.calls.some((c) => c.path === '/browser/type')).toBe(false);
    expect(lastToolResult(app, handoff.runId)).toContain('did this step themselves');
  });

  it('fills in secrets only at execution time and scrubs them from output', async () => {
    const { app, models, owner, computers } = setup();
    app.vault.set('API_KEY', 'sk-live-1234567890');
    const ops = addAgent(app, 'Ops');
    models.script('test/ops', [callTool('shell', { command: 'curl -H "Authorization: {{secret:API_KEY}}" api' }), say('done')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops call the api' });
    await app.runtime.idle();

    const shell = computers.calls.find((c) => c.path === '/shell')!;
    expect(shell.body.command).toContain('sk-live-1234567890');
    const run = app.store.listRuns({ agentId: ops.id })[0];
    const transcript = JSON.stringify(app.store.getTranscript(run.id));
    expect(transcript).not.toContain('sk-live-1234567890');
    expect(lastToolResult(app, run.id)).toContain('{{secret:API_KEY}}');
    const events = JSON.stringify(app.store.listEvents({ limit: 500 }));
    expect(events).not.toContain('sk-live-1234567890');
  });

  it('keeps the plan an agent writes as its progress, without counting it as actions', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [
      callTool('update_progress', { steps: [{ text: 'Outline the post', status: 'in_progress' }, { text: 'Write the draft', status: 'pending' }] }),
      callTool('read_channel', { channel: '#general' }),
      callTool('update_progress', { steps: [{ text: 'Outline the post', status: 'done' }, { text: 'Write the draft', status: 'done' }] }),
      say('Draft is ready.'),
    ]);

    app.workspace.postMessage({ channelId: app.workspace.getOrCreateDm(owner.id, writer.id).id, authorId: owner.id, text: 'Write a post about our launch' });
    await app.runtime.idle();

    const [run] = app.store.listRuns({ agentId: writer.id });
    expect(run.progress).toEqual([
      { text: 'Outline the post', status: 'done' },
      { text: 'Write the draft', status: 'done' },
    ]);
    // People watching see each version as it changes.
    const updates = app.store
      .listEvents({ runId: run.id, types: ['run.progress'] })
      .reverse()
      .map((e) => (e.data.run as Run).progress.map((s) => s.status));
    expect(updates).toEqual([
      ['in_progress', 'pending'],
      ['done', 'done'],
    ]);
    // Keeping the checklist isn't an action; reading the channel is.
    expect(app.store.runSummaries([run.id])[0].toolCalls).toBe(1);
    expect(models.requests[0].messages[0].content).toContain('write your plan with update_progress');
  });

  it('pauses mid-tool and resumes with an honest "interrupted" result', async () => {
    const { app, models, owner, computers } = setup();
    const ops = addAgent(app, 'Ops');
    computers.hangShell = true;
    models.script('test/ops', [callTool('shell', { command: 'sleep 100' }), say('Resumed and finished.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops run the long job' });
    await new Promise((r) => setTimeout(r, 100));
    app.runtime.setAgentPaused(ops.id, true, owner.id);
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: ops.id })[0];
    expect(run.status).toBe('paused');
    expect(app.store.getAgent(ops.id)!.status).toBe('paused');
    expect(lastToolResult(app, run.id)).toContain('Interrupted');

    computers.hangShell = false;
    app.runtime.setAgentPaused(ops.id, false, owner.id);
    await app.runtime.idle();
    expect(app.store.getRun(run.id)!.status).toBe('completed');
    expect(messagesIn(app, general(app).id).at(-1)!.text).toBe('Resumed and finished.');
  });

  it('recovers runs after a crash without re-running a tool that had started', async () => {
    const { app, models, owner } = setup();
    const ops = addAgent(app, 'Ops');
    await app.runtime.stop();

    // Simulate a process that died while a shell command was executing.
    const run = app.store.createRun({ agentId: ops.id, channelId: general(app).id, initiator: 'human', depth: 0, title: 'job' });
    app.store.setTranscript(run.id, [
      { role: 'user', content: 'run the job' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{"command":"deploy"}' } }] },
    ]);
    app.store.updateRun(run.id, { status: 'running' });
    app.bus.emit('tool.started', { agentId: ops.id, runId: run.id }, { toolCallId: 'c1', tool: 'shell' });
    void owner;

    models.script('test/ops', [say('Checked: the deploy did go through.')]);
    const fresh = new Runtime(app);
    app.runtime = fresh;
    fresh.start();
    await fresh.idle();

    expect(lastToolResult(app, run.id)).toContain('Interrupted: TeamBot restarted');
    expect(app.store.getRun(run.id)!.status).toBe('completed');
  });

  it('cancels a waiting run and its approval', async () => {
    const { app, models, owner } = setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('ask_for_approval', { action: 'Email the customer list' })]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer email everyone' });
    await app.runtime.idle();

    const [approval] = app.store.listApprovals({ status: 'pending' });
    app.runtime.cancelRun(approval.runId, owner.id);
    expect(app.store.getRun(approval.runId)!.status).toBe('cancelled');
    expect(app.store.getApproval(approval.id)!.status).toBe('cancelled');
  });

  it('pause-all stops new work until resumed', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('Back to work.')]);
    app.runtime.setPausedAll(true, owner.id);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer hello?' });
    await app.runtime.idle();
    expect(app.store.listRuns({ agentId: writer.id })).toHaveLength(0);

    app.runtime.setPausedAll(false, owner.id);
    await app.runtime.idle();
    expect(app.store.listRuns({ agentId: writer.id })[0].status).toBe('completed');
  });
});
