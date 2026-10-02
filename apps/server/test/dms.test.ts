// A DM stays between the two members it was opened with, whoever else speaks or is named in it, and the
// conversation an agent works in can show what it sent elsewhere ("Messaged Editor").
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { MIGRATIONS, Store } from '../src/store.js';
import { humanActor } from '../src/workspace.js';
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
  return t;
}

const runsOf = (app: App, agentId: string) => app.store.listRuns({ agentId });

describe('direct messages', () => {
  it('leaves a teammate named in a chat with an agent to that agent, and keeps the chat theirs', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    models.script('test/writer', [say('I will ask Editor.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Make a channel with you and @Editor' });
    await app.runtime.idle();

    expect(runsOf(app, writer.id)).toHaveLength(1);
    expect(runsOf(app, editor.id)).toHaveLength(0);
    expect(app.store.getChannel(dm.id)!.memberIds.sort()).toEqual([owner.id, writer.id].sort());
    expect(app.workspace.getOrCreateDm(owner.id, writer.id).id).toBe(dm.id);
  });

  it('lets people call an agent into their DM by name without adding it', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const bob = app.store.createHuman('Bob');
    models.script('test/writer', [say('Here is a summary.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, bob.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: '@Writer can you summarize this for us?' });
    await app.runtime.idle();

    expect(messagesIn(app, dm.id).map((m) => [m.authorId, m.text])).toEqual([
      [owner.id, '@Writer can you summarize this for us?'],
      [writer.id, 'Here is a summary.'],
    ]);
    expect(app.store.getChannel(dm.id)!.memberIds.sort()).toEqual([owner.id, bob.id].sort());
  });

  it("answers a task filed in someone else's DM there, without joining it", async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    models.script('test/editor', [say('Edited.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);

    app.workspace.createTask({ title: 'Edit the draft', assigneeId: editor.id, channelId: dm.id }, humanActor(owner.id));
    await app.runtime.idle();

    expect(messagesIn(app, dm.id).at(-1)).toMatchObject({ authorId: editor.id, text: 'Edited.' });
    expect(app.store.getChannel(dm.id)!.memberIds).not.toContain(editor.id);
    expect(app.workspace.getOrCreateDm(owner.id, writer.id).id).toBe(dm.id);
  });

  it("keeps helpers out of the parent's DM, while they still see what the parent sees", () => {
    const { app, owner } = setup();
    const lead = addAgent(app, 'Lead');
    const dm = app.workspace.getOrCreateDm(owner.id, lead.id);
    const run = app.store.createRun({ agentId: lead.id, channelId: dm.id, initiator: 'human', depth: 0, title: 'x' });
    app.auth.enable(owner, 'a long enough password');

    const [{ helper }] = app.helpers.spawn(app.store.getAgent(lead.id)!, run, [{ title: 'Sub-task', task: 'Do the sub-task' }]);

    expect(app.store.getChannel(dm.id)!.memberIds).not.toContain(helper.id);
    expect(app.workspace.canSee(app.store.getChannel(dm.id)!, helper.id)).toBe(true);
    expect(app.workspace.canSee(app.store.getChannel(dm.id)!, addAgent(app, 'Stranger').id)).toBe(false);
  });

  it('lists what agents sent elsewhere while working in a conversation', async () => {
    const t = setup();
    const { app, models, owner } = t;
    server = await buildServer(app);
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    models.script('test/writer', [callTool('send_dm', { to: 'Editor', text: 'Please own the shortlist.' }), say('Handed it to Editor.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Editor should do this' });
    await app.runtime.idle();

    const sent = (await server.inject({ method: 'GET', url: `/api/channels/${dm.id}/sent` })).json();
    const between = app.workspace.getOrCreateDm(writer.id, editor.id);
    expect(sent).toMatchObject([{ channelId: between.id, authorId: writer.id, text: 'Please own the shortlist.' }]);
    expect((await server.inject({ method: 'GET', url: `/api/channels/${between.id}/sent` })).json()).toEqual([]);
  });
});

describe('repairing DMs that gained members (migration 14)', () => {
  it('gives each DM back its two members and folds later copies into the oldest', () => {
    const file = path.join(os.tmpdir(), `teambot-dm-repair-${crypto.randomBytes(4).toString('hex')}.db`);
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    MIGRATIONS.slice(0, 13).forEach((sql) => db.exec(sql)); // through 13: the schema before the repair
    db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '13')`);

    const at = (n: number) => `2026-10-02T10:0${n}:00.000Z`;
    const channel = (id: string, members: string[], created: string) => {
      db.prepare(`INSERT INTO channels (id, name, kind, created_at) VALUES (?, 'dm', 'dm', ?)`).run(id, created);
      for (const m of members) db.prepare('INSERT INTO channel_members (channel_id, member_id) VALUES (?, ?)').run(id, m);
      db.prepare(`INSERT INTO events (ts, type, channel_id, data) VALUES (?, 'channel.created', ?, ?)`).run(created, id, JSON.stringify({ channel: { id, memberIds: members } }));
    };
    const message = (id: string, channelId: string, author: string, created: string) =>
      db.prepare('INSERT INTO messages (id, channel_id, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)').run(id, channelId, author, id, created);

    channel('chn_old', ['hum_owner', 'agt_bot'], at(1));
    message('msg_hi', 'chn_old', 'hum_owner', at(2));
    db.prepare(`INSERT INTO channel_members (channel_id, member_id) VALUES ('chn_old', 'agt_other')`).run(); // replied there, joined
    message('msg_other', 'chn_old', 'agt_other', at(3));
    channel('chn_new', ['hum_owner', 'agt_bot'], at(4)); // the empty DM the app opened next
    message('msg_later', 'chn_new', 'hum_owner', at(5));
    db.prepare(`INSERT INTO runs (id, agent_id, status, channel_id, initiator, depth, title, created_at, updated_at) VALUES ('run_1', 'agt_bot', 'done', 'chn_new', 'human', 0, 't', ?, ?)`).run(at(5), at(5));
    db.prepare(`INSERT INTO settings (key, value) VALUES ('telegram_last_target', ?)`).run(JSON.stringify({ channelId: 'chn_new', threadId: null }));
    channel('chn_agents', ['agt_bot', 'agt_other'], at(6)); // between two agents: untouched
    db.close();

    const store = new Store(file);
    try {
      expect(store.listChannels().map((c) => [c.id, c.memberIds.sort()])).toEqual([
        ['chn_old', ['agt_bot', 'hum_owner']],
        ['chn_agents', ['agt_bot', 'agt_other']],
      ]);
      expect(store.findDm('hum_owner', 'agt_bot')!.id).toBe('chn_old');
      expect(store.listMessages('chn_old').map((m) => m.id)).toEqual(['msg_hi', 'msg_other', 'msg_later']);
      expect(store.getRun('run_1')!.channelId).toBe('chn_old');
      expect(JSON.parse(store.getSetting('telegram_last_target')!)).toEqual({ channelId: 'chn_old', threadId: null });
    } finally {
      store.close();
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  });
});
