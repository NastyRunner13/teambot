import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { ChatMessage, TranscriptMessage } from '../src/models/types.js';
import { addAgent, general, testApp } from './helpers.js';

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

const images = (messages: ChatMessage[]) =>
  messages.flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url') : []));

describe('desktop control', () => {
  it('is only offered to agents that have it turned on', async () => {
    const { app, models, owner } = setup();
    const a = addAgent(app, 'Plain');
    const b = addAgent(app, 'Desk');
    app.store.updateAgent(b.id, { desktop: true });
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Plain @Desk hi' });
    await app.runtime.idle();
    const toolsOf = (model: string) => models.requests.find((r) => r.model === model)!.tools!.map((t) => t.function.name);
    expect(toolsOf('test/plain')).not.toContain('computer_screenshot');
    expect(toolsOf('test/desk')).toEqual(expect.arrayContaining(['computer_screenshot', 'computer_click', 'computer_type', 'computer_key']));
    expect(String(models.requests.find((r) => r.model === 'test/desk')!.messages[0].content)).toContain('You also have the whole desktop');
    void a;
  });

  it('shows the model the latest screenshots, stored as files rather than in the transcript', async () => {
    const { app, models, owner } = setup();
    const desk = addAgent(app, 'Desk');
    app.store.updateAgent(desk.id, { desktop: true });
    models.script('test/desk', [
      callTool('computer_screenshot', {}),
      callTool('computer_scroll', { x: 600, y: 400, direction: 'down' }),
      callTool('computer_screenshot', {}),
      say('Looked around.'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Desk look at the screen' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: desk.id })[0];
    const tools = app.store.getTranscript<TranscriptMessage>(run.id).filter((m) => m.role === 'tool');
    const ref = (tools[0] as { images?: string[] }).images![0];
    expect(ref).toMatch(/^screens\/run_[\w-]+\/call_\d+-0\.jpg$/);
    expect(fs.readFileSync(path.join(app.cfg.dataDir, ref), 'utf8')).toBe('screen after /desktop/screenshot');
    expect(JSON.stringify(app.store.getTranscript(run.id))).not.toContain('base64');

    const second = models.requests.filter((r) => r.model === 'test/desk')[1];
    expect(images(second.messages)).toHaveLength(1);
    expect((images(second.messages)[0] as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    // By the last call there are three screenshots; only the newest two are attached.
    const last = models.requests.filter((r) => r.model === 'test/desk').at(-1)!;
    expect(images(last.messages)).toHaveLength(2);
    expect(JSON.stringify(last.messages)).toContain('That screenshot is no longer shown');
  });

  it('keeps policy in force for coordinate clicks and typing', async () => {
    const { app, models, owner, computers } = setup();
    const desk = addAgent(app, 'Desk');
    app.store.updateAgent(desk.id, { desktop: true });
    models.script('test/desk', [callTool('computer_click', { x: 3, y: 500 }), say('clicked')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Desk send the email' });
    await app.runtime.idle();
    const [approval] = app.store.listApprovals({ status: 'pending' });
    expect(approval.summary).toBe('Click at (3, 500) on "Send" (mail.example.com)');
    expect(approval.reason).toBe('Confirm clicks that send, publish, pay or delete');
    expect(computers.calls.some((c) => c.path === '/desktop/click')).toBe(false);

    app.runtime.resolveApproval(approval.id, 'deny', null, owner.id);
    await app.runtime.idle();

    computers.focused = 2; // the password field
    models.script('test/desk', [callTool('computer_type', { text: 'hunter2' }), say('typed')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Desk log in' });
    await app.runtime.idle();
    const [handoff] = app.store.listApprovals({ status: 'pending' });
    expect(handoff.kind).toBe('handoff');
    expect(computers.calls.some((c) => c.path === '/desktop/type')).toBe(false);
  });
});

describe('coding agents', () => {
  it('is offered once a key is stored, runs the CLI with the key in its environment, and keeps the key out of the log', async () => {
    const { app, models, owner, computers } = setup();
    const dev = addAgent(app, 'Dev');
    models.script('test/dev', [say('hi')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Dev hello' });
    await app.runtime.idle();
    expect(models.requests[0].tools!.map((t) => t.function.name)).not.toContain('run_coding_agent');

    app.vault.set('ANTHROPIC_API_KEY', "sk-ant-it's-secret-9999");
    models.script('test/dev', [callTool('run_coding_agent', { agent: 'claude-code', task: 'Add a /health endpoint with a test', cwd: '/home/agent/workspace/api' }), say('Done.')]);
    models.script('test/reviewer', [say('{"verdict":"allow","reason":"The owner asked for this change"}')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Dev add a health endpoint to the api' });
    await app.runtime.idle();

    const req = models.requests.filter((r) => r.model === 'test/dev').at(-2)!;
    expect(req.tools!.map((t) => t.function.name)).toContain('run_coding_agent');
    expect(String(req.messages[0].content)).toContain('run_coding_agent (claude-code)');
    const task = computers.calls.find((c) => c.path === '/fs/write' && String(c.body.path).startsWith('/tmp/teambot-task-'))!;
    expect(task.body.content).toBe('Add a /health endpoint with a test');
    const shell = computers.calls.filter((c) => c.path === '/shell').at(-1)!;
    expect(shell.body.command).toContain(`claude -p "$(cat ${task.body.path})"`);
    expect(shell.body.command).not.toContain('sk-ant');
    expect(shell.body.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-it's-secret-9999" });
    expect(shell.body.cwd).toBe('/home/agent/workspace/api');
    const run = app.store.listRuns({ agentId: dev.id })[0];
    const transcript = JSON.stringify(app.store.getTranscript(run.id));
    expect(transcript).not.toContain('sk-ant-it');
    expect(transcript).toContain('untrusted_content source=\\"run_coding_agent\\"');
    expect(models.requests.some((r) => r.model === 'test/reviewer')).toBe(true);
  });
});
