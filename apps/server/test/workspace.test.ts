import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

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

describe('deleting a group chat', () => {
  it('deletes its messages and stops the work there; runs, the audit log and routines stay', async () => {
    const { app, models, owner, computers } = setup();
    const ops = addAgent(app, 'Ops');
    const writer = addAgent(app, 'Writer');
    const room = app.workspace.createChannel({ name: 'launch', memberIds: [ops.id, writer.id] }, owner.id);
    const routine = app.store.createSchedule({ agentId: ops.id, name: 'Daily report', cron: '0 9 * * *', prompt: 'Report', channelId: room.id, enabled: true });
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'unrelated', route: false });
    computers.hangShell = true;
    models.script('test/ops', [callTool('shell', { command: 'sleep 100' })]);
    app.workspace.postMessage({ channelId: room.id, authorId: owner.id, text: '@Ops run the long job' });
    // A paused agent's message waits unread.
    app.runtime.setAgentPaused(writer.id, true, owner.id);
    app.workspace.postMessage({ channelId: room.id, authorId: owner.id, text: '@Writer draft the post' });
    await new Promise((r) => setTimeout(r, 100));
    const run = app.store.listRuns({ agentId: ops.id })[0];
    expect(run.status).toBe('running');

    app.workspace.deleteChannel(room.id, owner.id);
    await app.runtime.idle();

    expect(app.store.getChannel(room.id)).toBeUndefined();
    expect(messagesIn(app, room.id)).toEqual([]);
    expect(messagesIn(app, general(app).id).map((m) => m.text)).toEqual(['unrelated']);
    expect(app.store.getRun(run.id)!.status).toBe('cancelled');
    expect(computers.cancelled).toEqual([ops.id]);
    expect(app.store.pendingInbox(writer.id)).toEqual([]);
    expect(app.store.getSchedule(routine.id)!.channelId).toBeNull();
    expect(app.store.listEvents({ types: ['channel.deleted'] })[0]).toMatchObject({ actorId: owner.id, channelId: room.id });
  });

  it('works on #general too, never on a DM, and new agents then join no channel', async () => {
    const { app, owner } = setup();
    const server = await buildServer(app);
    const writer = addAgent(app, 'Writer');
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    const del = (id: string) => server.inject({ method: 'DELETE', url: `/api/channels/${id}` });

    expect((await del(dm.id)).statusCode).toBe(409);
    expect((await del(general(app).id)).statusCode).toBe(200);
    expect(app.store.getChannelByName('general')).toBeUndefined();
    expect((await del('chn_missing')).statusCode).toBe(404);

    expect((await server.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Scout' } })).statusCode).toBe(200);
    expect(app.store.listChannels().map((c) => c.kind)).toEqual(['dm']);
    await server.close();
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
    models.script('test/writer', [
      callTool('read_channel', { channel: '#general' }),
      callTool('search_history', { query: 'reports' }),
      say('[silent]'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer where are the reports?' });
    await app.runtime.idle();

    const results = models.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toContain('/shared/research/gone.md (not found — deleted or moved)');
      expect(result).not.toContain('kept.md (not found');
    }
    expect(results[0]).toContain('/shared/research/kept.md and');
  });
});
