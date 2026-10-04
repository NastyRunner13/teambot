// Files agents make reach people as attachments, and a model whose output breaks down can't post, write or run
// garbage: null bytes are refused, replies cut off at the output limit are explained, and a run stops when it repeats.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { AssistantMessage, TranscriptMessage } from '../src/models/types.js';
import { GARBLED_REPLY_NUDGE } from '../src/runtime/runtime.js';
import { addAgent, messagesIn, testApp } from './helpers.js';

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

const put = (app: App, name: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(app.cfg.sharedDir, name)), { recursive: true });
  fs.writeFileSync(path.join(app.cfg.sharedDir, name), content);
};

const toolResults = (app: App, runId: string) =>
  app.store
    .getTranscript<TranscriptMessage>(runId)
    .filter((m) => m.role === 'tool')
    .map((m) => m.content as string);

/** A tool call whose raw arguments are exactly `json`, as a model sent them. */
const rawCall = (name: string, json: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `raw_${name}_${json.length}`, type: 'function', function: { name, arguments: json } }],
  ...extra,
});

describe('files in messages', () => {
  it("attaches the /shared files an agent's reply names, once each and only if they exist", async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    put(app, 'fibonacci.py', 'def fib(n): ...');
    put(app, 'labs/rl-lab.html', '<!doctype html><title>Lab</title>');
    models.script('test/writer', [say('Done: `/shared/fibonacci.py` and **/shared/labs/rl-lab.html**. Also see /shared/fibonacci.py. (I removed /shared/old.md.)')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Make me a fibonacci function and a lab' });
    await app.runtime.idle();

    const reply = messagesIn(app, dm.id).at(-1)!;
    expect(reply.attachments.map((a) => a.path)).toEqual(['/shared/fibonacci.py', '/shared/labs/rl-lab.html']);
    expect(reply.attachments[0]).toMatchObject({ name: 'fibonacci.py', size: 15 });
    // The agent's library is built from those attachments.
    const s = await buildServer(app);
    server = s;
    const library = (await s.inject({ method: 'GET', url: `/api/agents/${writer.id}/library` })).json();
    expect(library.map((f: { path: string }) => f.path)).toEqual(['/shared/fibonacci.py', '/shared/labs/rl-lab.html']);
  });

  it("keeps files a person names as plain text, and puts a message's chosen attachments first", () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    put(app, 'a.md', 'a');
    put(app, 'b.md', 'b');
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    const mine = app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Look at /shared/a.md', route: false });
    expect(mine.attachments).toEqual([]);
    const theirs = app.workspace.postMessage({ channelId: dm.id, authorId: writer.id, text: 'Compare /shared/a.md with this', attachments: ['/shared/b.md', 'shared/a.md'], route: false });
    expect(theirs.attachments.map((a) => a.path)).toEqual(['/shared/b.md', '/shared/a.md']);
  });

  it('never stores a null byte, which would cut the saved message off', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: writer.id, text: '\u0000Hello\u0000 there', route: false });
    expect(messagesIn(app, dm.id).at(-1)!.text).toBe('Hello there');
  });

  it('serves a file with an etag, and answers 304 while it is unchanged', async () => {
    const { app } = setup();
    put(app, 'page.html', '<script>alert(1)</script>');
    server = await buildServer(app);
    const first = await server.inject({ method: 'GET', url: '/api/shared/file?path=/shared/page.html' });
    expect(first.statusCode).toBe(200);
    // Agent-written HTML is never served as a page on this origin.
    expect(first.headers['content-type']).toBe('text/plain; charset=utf-8');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    // Previews ask with HEAD first: the version and the size, without the body.
    const head = await server.inject({ method: 'HEAD', url: '/api/shared/file?path=/shared/page.html' });
    expect(head.statusCode).toBe(200);
    expect(head.headers.etag).toBe(etag);
    expect(Number(head.headers['content-length'])).toBe(25);
    expect(head.body).toBe('');
    const again = await server.inject({ method: 'GET', url: '/api/shared/file?path=/shared/page.html', headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    put(app, 'page.html', '<p>changed and longer</p>');
    const changed = await server.inject({ method: 'GET', url: '/api/shared/file?path=/shared/page.html', headers: { 'if-none-match': etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe('<p>changed and longer</p>');
  });
});

describe('a model whose output breaks down', () => {
  it('does not post a garbled reply, and asks for it again', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('\u0000]<]minimax[>[</invoke\u0000>'), say('Here is the summary.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Summarize it' });
    await app.runtime.idle();

    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(['Summarize it', 'Here is the summary.']);
    const run = app.store.listRuns({ agentId: writer.id })[0];
    expect(run.status).toBe('completed');
    expect(app.store.getTranscript<TranscriptMessage>(run.id).some((m) => m.role === 'user' && m.content === GARBLED_REPLY_NUDGE)).toBe(true);
  });

  it('refuses tool calls with null bytes in their arguments, so nothing garbled is written or run', async () => {
    const { app, models, computers, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [
      callTool('write_file', { path: '/shared/lab.html', content: '<p>\u0000\u0000</p>' }),
      callTool('write_file', { path: '/shared/lab.html', content: '<p>fine</p>' }),
      say('Saved /shared/lab.html.'),
    ]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Make the lab' });
    await app.runtime.idle();

    const writes = computers.calls.filter((c) => c.path === '/fs/write');
    expect(writes.map((c) => c.body.content)).toEqual(['<p>fine</p>']);
    const run = app.store.listRuns({ agentId: writer.id })[0];
    expect(toolResults(app, run.id)[0]).toContain('contain null bytes');
    expect(run.status).toBe('completed');
  });

  it('runs a call whose code merely spells out the \\u0000 escape', async () => {
    const { app, models, computers, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [callTool('shell', { command: 'printf "a\\u0000b" | wc -c' }), say('Done.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Count it' });
    await app.runtime.idle();
    expect(computers.calls.filter((c) => c.path === '/shell').map((c) => c.body.command)).toEqual(['printf "a\\u0000b" | wc -c']);
  });

  it('stops the run with a clear error when the output is garbled twice in a row', async () => {
    const { app, models, computers, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [
      rawCall('shell', JSON.stringify({ command: "python3 -c \"d\u0000'utf-8'\"" })),
      rawCall('shell', '{"command": "head -n 456 rl-lab.html\u0000'),
      say('never reached'),
    ]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Fix the file' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    expect(run.status).toBe('failed');
    expect(run.error).toContain('test/writer sent garbled output twice in a row');
    expect(computers.calls.filter((c) => c.path === '/shell')).toEqual([]);
    const last = messagesIn(app, dm.id).at(-1)!;
    expect(last.text).toContain('⚠️ I stopped because of an error');
    expect(last.text).toContain('Pick another model for Writer under Customize');
  });

  it('explains a tool call cut off at the output limit instead of calling it invalid JSON', async () => {
    const { app, models, computers, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [
      rawCall('write_file', '{"path": "/shared/lab.html", "content": "<!doctype html><html><head><style>body{', { cutOff: true }),
      rawCall('write_file', '{"path": "/shared/lab.html", "content": "<p>part 1</p>"}'),
      say('Saved /shared/lab.html.'),
    ]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Build the lab' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [first] = toolResults(app, run.id);
    expect(first).toContain("hit the model's output limit");
    expect(first).toContain('append: true');
    expect(computers.calls.filter((c) => c.path === '/fs/write')).toHaveLength(1);
    // The marker stays in the transcript, never in what the model is sent.
    const stored = app.store.getTranscript<TranscriptMessage>(run.id).find((m) => m.role === 'assistant' && m.cutOff);
    expect(stored).toBeTruthy();
    expect(models.requests.at(-1)!.messages.some((m) => 'cutOff' in m)).toBe(false);
  });
});
