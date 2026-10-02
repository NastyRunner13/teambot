import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { humanActor } from '../src/workspace.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

function setup() {
  const t = testApp();
  current = t.app;
  fs.mkdirSync(t.app.cfg.sharedDir, { recursive: true });
  t.app.runtime.start();
  return t;
}

describe('threads', () => {
  it('a human reply in an agent thread continues with that agent, which answers in the thread', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const lead = addAgent(app, 'Lead');
    models.script('test/writer', [say('First draft is ready.'), say('Shortened it.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer draft the launch post' });
    await app.runtime.idle();
    const draft = app.store.listTopLevel(general(app).id).at(-1)!;
    expect(draft.text).toBe('First draft is ready.');

    // No mention needed: replying in the thread of the agent's message wakes it, with the thread as context.
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'Make it shorter', threadId: draft.id });
    await app.runtime.idle();

    expect(app.store.listTopLevel(general(app).id).map((m) => [m.text, m.replyCount])).toEqual([
      ['@Writer draft the launch post', 0],
      ['First draft is ready.', 2],
    ]);
    expect(app.store.listThread(draft.id).map((m) => m.text)).toEqual(['Make it shorter', 'Shortened it.']);
    expect(app.store.listRuns({ agentId: writer.id })[0].threadId).toBe(draft.id);
    const lastPrompt = JSON.stringify(models.requests.filter((r) => r.model === 'test/writer').at(-1)!.messages);
    expect(lastPrompt).toContain('The thread so far');
    expect(lastPrompt).toContain('First draft is ready.');
    expect(app.store.listRuns({ agentId: lead.id })).toHaveLength(0);
  });

  it('a mention inside a thread gets its answer in that thread', async () => {
    const { app, models, owner } = setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [say('Two options: A or B.')]);

    const root = app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'Ideas for the tagline?' });
    const reply = app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer any thoughts?', threadId: root.id });
    await app.runtime.idle();

    expect(app.store.listTopLevel(general(app).id)).toHaveLength(1);
    expect(app.store.listThread(root.id).map((m) => m.text)).toEqual(['@Writer any thoughts?', 'Two options: A or B.']);
    // Replying to a reply lands in the same thread.
    const nested = app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'A', threadId: reply.id });
    expect(nested.threadId).toBe(root.id);
  });

  it('rejects a thread from another conversation', () => {
    const { app, owner } = setup();
    const other = app.workspace.createChannel({ name: 'other', memberIds: [] }, owner.id);
    const root = app.workspace.postMessage({ channelId: other.id, authorId: owner.id, text: 'hello' });
    expect(() => app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'hi', threadId: root.id })).toThrow(/not in this conversation/);
  });
});

describe('attachments', () => {
  it('hands attached files to the agent, and lets agents attach their deliverables', async () => {
    const { app, models, owner } = setup();
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'brief.md'), '# Brief');
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'post.md'), '# Post');
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('post_message', { channel: '#general', text: 'Here it is', attachments: ['/shared/post.md'] }), say('[silent]')]);

    const msg = app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer use this brief', attachments: ['/shared/brief.md'] });
    expect(msg.attachments).toEqual([{ path: '/shared/brief.md', name: 'brief.md', size: 7 }]);
    await app.runtime.idle();

    expect(JSON.stringify(models.requests[0].messages)).toContain('/shared/brief.md');
    const posted = app.store.listTopLevel(general(app).id).at(-1)!;
    expect(posted.attachments.map((a) => a.path)).toEqual(['/shared/post.md']);
  });

  it('refuses files that are missing or outside /shared', () => {
    const { app, owner } = setup();
    const post = (p: string) => app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'x', attachments: [p] });
    expect(() => post('/shared/nope.md')).toThrow(/not a file/);
    expect(() => post('/shared/../../etc/passwd')).toThrow(/outside \/shared/);
  });

  it('uploads into /shared without overwriting, and posts an attachment-only message', async () => {
    const { app } = setup();
    const server = await buildServer(app);
    const upload = (name: string, body: string) =>
      server.inject({ method: 'POST', url: `/api/shared/upload?name=${encodeURIComponent(name)}&dir=uploads/test`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from(body) });

    const first = (await upload('notes.txt', 'one')).json();
    const second = (await upload('notes.txt', 'two')).json();
    expect(first.path).toBe('/shared/uploads/test/notes.txt');
    expect(second.path).toBe('/shared/uploads/test/notes (2).txt');
    expect(fs.readFileSync(path.join(app.cfg.sharedDir, 'uploads/test/notes.txt'), 'utf8')).toBe('one');

    const sneaky = await upload('../../escape.txt', 'x');
    expect(sneaky.json().path).toBe('/shared/uploads/test/escape.txt');
    const outside = await server.inject({ method: 'POST', url: '/api/shared/upload?name=x.txt&dir=../..', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(outside.statusCode).toBe(400);

    const res = await server.inject({ method: 'POST', url: `/api/channels/${general(app).id}/messages`, payload: { attachments: [first.path] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().attachments[0].name).toBe('notes.txt');
    await server.close();
  });

  it('tells agents reading history which files mentioned there are gone', async () => {
    const { app, models, owner } = setup();
    fs.mkdirSync(path.join(app.cfg.sharedDir, 'research'), { recursive: true });
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'research/kept.md'), '# Kept');
    addAgent(app, 'Writer');
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'Reports: /shared/research/kept.md and /shared/research/gone.md.', route: false });
    app.workspace.createTask({ title: 'Old report', description: 'Saved at /shared/research/gone.md' }, humanActor(owner.id));
    models.script('test/writer', [
      callTool('read_channel', { channel: '#general' }),
      callTool('list_tasks', { status: 'all' }),
      callTool('search_history', { query: 'reports' }),
      say('[silent]'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer where are the reports?' });
    await app.runtime.idle();

    const results = models.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toContain('/shared/research/gone.md (not found — deleted or moved)');
      expect(result).not.toContain('kept.md (not found');
    }
    expect(results[0]).toContain('/shared/research/kept.md and');
  });
});

describe('deleting tasks', () => {
  it('removes the task, frees tasks that waited on it and never reuses its number', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const actor = humanActor(owner.id);
    app.workspace.createTask({ title: 'Research' }, actor);
    app.workspace.createTask({ title: 'Write it up', assigneeId: writer.id, dependsOn: [1] }, actor);
    await app.runtime.idle();

    app.workspace.deleteTask(1, actor);
    await app.runtime.idle();

    expect(app.store.listTasks().map((t) => [t.number, t.dependsOn])).toEqual([[2, []]]);
    const writerInputs = models.requests.filter((r) => r.model === 'test/writer').map((r) => JSON.stringify(r.messages));
    expect(writerInputs.some((m) => m.includes('#2') && m.includes('is unblocked'))).toBe(true);
    expect(app.store.listEvents({ limit: 50 }).some((e) => e.type === 'task.deleted' && (e.data as { taskNumber: number }).taskNumber === 1)).toBe(true);

    app.workspace.deleteTask(2, actor);
    expect(app.workspace.createTask({ title: 'Next' }, actor).number).toBe(3);
  });

  it('drops unread inbox items about the task', () => {
    const { app, owner } = setup();
    app.runtime.setPausedAll(true, owner.id); // the assignment stays unread
    const writer = addAgent(app, 'Writer');
    app.workspace.createTask({ title: 'Draft', assigneeId: writer.id }, humanActor(owner.id));
    expect(app.store.pendingInbox(writer.id)).toHaveLength(1);
    app.workspace.deleteTask(1, humanActor(owner.id));
    expect(app.store.pendingInbox(writer.id)).toHaveLength(0);
  });

  it('asks the assigned agent to start again on request, but not for closed or unassigned tasks', async () => {
    const { app, owner } = setup();
    const server = await buildServer(app);
    app.runtime.setPausedAll(true, owner.id);
    const writer = addAgent(app, 'Writer');
    app.workspace.createTask({ title: 'Draft', assigneeId: writer.id }, humanActor(owner.id));
    app.workspace.createTask({ title: 'Nobody' }, humanActor(owner.id));

    expect((await server.inject({ method: 'POST', url: '/api/tasks/1/start' })).statusCode).toBe(200);
    expect(app.store.pendingInbox(writer.id).map((i) => [i.taskNumber, i.text.split('\n')[0]])).toEqual([
      [1, 'Task #1 "Draft" was assigned to you by Owner.'],
      [1, 'Task #1 "Draft" needs you now: Owner asked you to work on it.'],
    ]);
    expect((await server.inject({ method: 'POST', url: '/api/tasks/2/start' })).json().error).toMatch(/not assigned to an agent/);
    app.workspace.updateTask(1, { status: 'done' }, humanActor(owner.id));
    expect((await server.inject({ method: 'POST', url: '/api/tasks/1/start' })).statusCode).toBe(400);
    await server.close();
  });

  it('is available over the API', async () => {
    const { app, owner } = setup();
    const server = await buildServer(app);
    app.workspace.createTask({ title: 'Draft' }, humanActor(owner.id));
    expect((await server.inject({ method: 'DELETE', url: '/api/tasks/1' })).statusCode).toBe(200);
    expect(app.store.listTasks()).toEqual([]);
    expect((await server.inject({ method: 'DELETE', url: '/api/tasks/1' })).statusCode).toBe(404);
    await server.close();
  });
});
