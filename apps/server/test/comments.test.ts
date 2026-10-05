// Comments on pages: threads anchored to a passage, @mentions that wake agents in the thread, and their replies there.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { locateAnchor } from '@teambot/shared';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { usableReadOnly } from '../src/tools/types.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await current?.runtime.stop();
  current = null;
  server = null;
});

function setup(opts: Parameters<typeof testApp>[0] = {}) {
  const t = testApp(opts);
  current = t.app;
  t.app.runtime.start();
  return t;
}

const BRIEF = '# Launch\n\nWe launch in Q3 with three markets.\n\nBudget: $40k.';

const transcript = (app: App, runId: string) => app.store.getTranscript<TranscriptMessage>(runId);
const firstInput = (app: App, runId: string) => String(transcript(app, runId).find((m) => m.role === 'user')?.content ?? '');
const toolResults = (app: App, runId: string) =>
  transcript(app, runId)
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content));

describe('page comments', () => {
  it('finds a passage again after edits, nearest where it was, and reports it outdated once it is edited away', () => {
    expect(locateAnchor('one two one two', { quote: 'two', offset: 9 })).toBe(12);
    expect(locateAnchor('one two one two', { quote: 'two', offset: 0 })).toBe(4);
    expect(locateAnchor('one two', { quote: 'three', offset: 0 })).toBeNull();

    const { app, owner } = setup();
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Which three?', anchor: { quote: 'three markets', offset: BRIEF.indexOf('three markets') } });
    expect(thread.anchor).toEqual({ quote: 'three markets', offset: BRIEF.indexOf('three markets'), revision: 1 });

    // Text added above moves the passage; it is found where it went.
    const moved = `Draft.\n\n${BRIEF}`;
    app.pages.update(page.id, { content: moved }, 1, owner.id);
    expect(locateAnchor(app.pages.get(page.id).content, thread.anchor!)).toBe(moved.indexOf('three markets'));

    // Edited away: the thread stays, with the words it quoted, and reads as outdated.
    app.pages.update(page.id, { content: moved.replace('three markets', 'two markets') }, 2, owner.id);
    expect(locateAnchor(app.pages.get(page.id).content, thread.anchor!)).toBeNull();
    expect(app.comments.threads(page.id)).toMatchObject([{ id: thread.id, anchor: { quote: 'three markets', revision: 1 }, replies: [] }]);

    // A passage that is no longer there can't be commented on; replies keep their thread's passage.
    expect(() => app.comments.post({ pageId: page.id, authorId: owner.id, body: 'x', anchor: { quote: 'three markets' } })).toThrow(/no longer in the page/);
    const reply = app.comments.post({ threadId: thread.id, authorId: owner.id, body: 'Still open', anchor: { quote: 'Budget' } });
    expect(reply).toMatchObject({ threadId: thread.id, pageId: page.id, anchor: null });
    // A reply's id stands for its thread.
    expect(app.comments.post({ threadId: reply.id, authorId: owner.id, body: 'And another' }).threadId).toBe(thread.id);
  });

  it('counts open threads per page and announces every change to everyone, outside any run or chat', () => {
    const { app, owner } = setup();
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    const a = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'First' });
    app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Second' });
    app.comments.post({ threadId: a.id, authorId: owner.id, body: 'A reply is not a thread' });
    expect(app.pages.list()[0].openComments).toBe(2);
    app.comments.resolve(a.id, true, owner.id);
    expect(app.pages.get(page.id).openComments).toBe(1);
    expect(app.comments.get(a.id)).toMatchObject({ resolved: true, resolvedBy: owner.id });
    app.comments.resolve(a.id, false, owner.id);
    expect(app.comments.get(a.id)).toMatchObject({ resolved: false, resolvedBy: null, resolvedAt: null });

    const events = app.store.listEvents({ types: ['page.comment.created', 'page.comment.updated'] }).sort((x, y) => x.id - y.id);
    expect(events.map((e) => e.type)).toEqual(['page.comment.created', 'page.comment.created', 'page.comment.created', 'page.comment.updated', 'page.comment.updated']);
    expect(events.every((e) => e.channelId === null && e.runId === null)).toBe(true);
    expect(events.at(-1)!.data).toMatchObject({ comment: { id: a.id, resolved: false }, openComments: 2 });

    // Deleting a page takes its comments with it.
    app.pages.remove(page.id, owner.id);
    expect(app.store.getComment(a.id)).toBeUndefined();
  });

  it('wakes an @mentioned agent with the page and passage, and posts its reply in the thread', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    models.script('test/writer', [
      callTool('read_page', { page: page.id }),
      callTool('edit_page', { page: page.id, expected_revision: 1, edits: [{ find: 'three markets', replace: 'three markets (US, UK, DE)' }] }),
      say('Named the three markets: US, UK and DE.'),
    ]);

    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer which markets? Name them here.', anchor: { quote: 'three markets', offset: 0 } });
    await app.runtime.idle();

    const [run] = app.store.listRuns({ agentId: writer.id });
    expect(run).toMatchObject({ status: 'completed', commentThreadId: thread.id, channelId: null, threadId: null, initiator: 'human', depth: 0 });
    const input = firstInput(app, run.id);
    expect(input).toContain(`You are answering in a comment thread on the page [Launch brief](/pages/${page.id})`);
    // The passage is page text, so it comes as outside content; the request itself is the person's.
    expect(input).toContain('<untrusted_content source="page">\nthree markets\n</untrusted_content>');
    expect(input).toContain(`A comment on the page [Launch brief](/pages/${page.id}) — ${owner.name} (human) wrote:\n@Writer which markets? Name them here.`);
    expect(input.split('which markets?')).toHaveLength(2); // the request appears once, not again as thread history
    // The system prompt tells the agent where its reply goes.
    expect(String(models.requests.at(-1)!.messages[0].content)).toContain(`It is posted automatically to the comment thread on the page [Launch brief](/pages/${page.id}) you were asked from.`);

    const [threadNow] = app.comments.threads(page.id);
    expect(threadNow.replies).toMatchObject([{ authorId: writer.id, body: 'Named the three markets: US, UK and DE.', runId: run.id, depth: 1 }]);
    expect(app.pages.get(page.id)).toMatchObject({ revision: 2, updatedBy: writer.id });
    // Nothing went to a chat.
    expect(messagesIn(app, general(app).id)).toHaveLength(0);
    expect(app.store.listMessagesByRun(run.id)).toHaveLength(0);

    // A person replying in the thread continues with the agent already in it, in the same thread, without a mention.
    models.script('test/writer', [say('Yes: DE goes first.')]);
    app.comments.post({ threadId: thread.id, authorId: owner.id, body: 'Does DE go first?' });
    await app.runtime.idle();
    const runs = app.store.listRuns({ agentId: writer.id });
    expect(runs).toHaveLength(2);
    expect(runs[0].commentThreadId).toBe(thread.id);
    const later = firstInput(app, runs[0].id);
    expect(later).toContain('The thread so far (oldest first):');
    expect(later).toContain('- Writer: Named the three markets');
    expect(app.comments.threads(page.id)[0].replies.map((c) => c.body)).toEqual(['Named the three markets: US, UK and DE.', 'Does DE go first?', 'Yes: DE goes first.']);
    // An agent's reply never wakes another agent in the thread by itself, and the agent never answers itself.
    expect(app.store.pendingInbox(writer.id)).toHaveLength(0);
  });

  it('keeps work for different threads, and for chats, in separate runs', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    app.runtime.setPausedAll(true, owner.id);
    const one = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer first' });
    app.comments.post({ threadId: one.id, authorId: owner.id, body: '@Writer and also' });
    const two = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer second' });
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer hello' });
    models.script('test/writer', [say('Reply one.'), say('Reply two.'), say('Hi.')]);
    app.runtime.setPausedAll(false, owner.id);
    await app.runtime.idle();

    const runs = app.store.listRuns({ agentId: writer.id }).reverse();
    expect(runs.map((r) => [r.commentThreadId, r.channelId])).toEqual([
      [one.id, null],
      [two.id, null],
      [null, general(app).id],
    ]);
    // Both comments in the first thread went to one run.
    expect(firstInput(app, runs[0].id)).toMatch(/1\. A comment[\s\S]*first[\s\S]*2\. A comment[\s\S]*and also/);
    const threads = app.comments.threads(page.id);
    expect(threads.map((t) => t.replies.at(-1)?.body)).toEqual(['Reply one.', 'Reply two.']);
    expect(messagesIn(app, general(app).id).map((m) => m.text)).toEqual(['@Writer hello', 'Hi.']);
  });

  it('routes agent mentions with the loop guard, and keeps work from read-only runs read-only', async () => {
    const { app, models, owner } = setup({ maxAgentDepth: 1 });
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    models.script('test/writer', [say('@Editor please check the numbers.')]);
    models.script('test/editor', [say('@Writer numbers look fine.')]);

    app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer review this' });
    await app.runtime.idle();
    // Writer (depth 1) woke Editor; Editor's reply (depth 2) is past the limit, so Writer isn't woken again.
    expect(app.store.listRuns({ agentId: editor.id })).toMatchObject([{ depth: 1, initiator: 'human' }]);
    expect(app.store.listRuns({ agentId: writer.id })).toHaveLength(1);
    expect(app.store.listEvents({ types: ['loop.guard'] })).toMatchObject([{ agentId: writer.id, data: { depth: 2, pageId: page.id } }]);
    expect(app.comments.threads(page.id)[0].replies.map((c) => [c.body, c.depth])).toEqual([
      ['@Editor please check the numbers.', 1],
      ['@Writer numbers look fine.', 2],
    ]);

    // A comment written by a read-only run hands on read-only work.
    const watch = app.store.createRun({ agentId: writer.id, channelId: null, initiator: 'schedule', depth: 0, title: 'watch', readOnly: true });
    app.runtime.setPausedAll(true, owner.id);
    app.comments.post({ pageId: page.id, authorId: writer.id, body: '@Editor have a look', actor: { id: writer.id, depth: 0, initiator: 'schedule', runId: watch.id } });
    expect(app.store.pendingInbox(editor.id)).toMatchObject([{ readOnly: true, initiator: 'schedule', depth: 1 }]);
  });

  it('gives agents tools to read, start, reply to and resolve threads, and keeps resolving out of read-only runs', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Launch brief', content: `${BRIEF}\n\nBudget: TBD.` }, owner.id);
    const asked = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Is Q3 still right?', anchor: { quote: 'Q3', offset: 0 } });
    const old = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Old question' });
    app.comments.resolve(old.id, true, owner.id);

    models.script('test/writer', [
      callTool('list_page_comments', { page: 'Launch brief' }),
      callTool('comment_on_page', { page: page.id, text: 'This budget line is duplicated.', quote: 'Budget' }),
      callTool('comment_on_page', { page: page.id, text: 'Which budget is right?', quote: 'Budget: TBD.' }),
      callTool('comment_on_page', { reply_to: asked.id, text: 'Yes, Q3 holds.' }),
      callTool('resolve_comment', { thread: asked.id }),
      callTool('list_page_comments', { page: page.id, include_resolved: true }),
      say('Went through the comments.'),
    ]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer go through the comments on the launch brief' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [listed, ambiguous, started, replied, resolved, all] = toolResults(app, run.id);
    // Comments are written by people and agents: they come back as outside content.
    expect(listed).toContain('<untrusted_content source="list_page_comments">');
    expect(listed).toContain(`Thread ${asked.id} on "Q3":`);
    expect(listed).toContain('Is Q3 still right?');
    expect(listed).toContain('1 resolved thread not shown');
    expect(listed).not.toContain('Old question');
    expect(ambiguous).toMatch(/appears 2 times/);
    expect(started).toMatch(/^Started thread cmt_[\w-]+ on \[Launch brief\]/);
    expect(replied).toBe(`Replied in thread ${asked.id} on [Launch brief](/pages/${page.id}).`);
    expect(resolved).toBe(`Resolved thread ${asked.id} on [Launch brief](/pages/${page.id}).`);
    expect(all).toContain(`resolved by Writer`);
    expect(all).toContain('Old question');

    const threads = app.comments.threads(page.id);
    expect(threads.find((t) => t.id === asked.id)).toMatchObject({ resolved: true, resolvedBy: writer.id, replies: [{ authorId: writer.id, body: 'Yes, Q3 holds.', runId: run.id }] });
    expect(threads.find((t) => t.body === 'Which budget is right?')?.anchor).toMatchObject({ quote: 'Budget: TBD.', revision: 1 });

    const readOnly = app.tools.forAgent(writer).filter(usableReadOnly).map((t) => t.name);
    expect(readOnly).toEqual(expect.arrayContaining(['list_page_comments', 'comment_on_page']));
    expect(readOnly).not.toContain('resolve_comment');
  });

  it('brings a teammate’s answer back to the thread that asked', async () => {
    const { app, models, owner } = setup();
    const lead = addAgent(app, 'Lead');
    addAgent(app, 'Analyst');
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    models.script('test/lead', [
      callTool('ask_agent', { to: 'Analyst', task: 'Check the $40k budget', expected_result: 'Yes or no, with the reason' }),
      say('I asked Analyst to check the budget.'),
      say('Analyst says $40k covers it.'),
    ]);
    models.script('test/analyst', [say('Yes: $40k covers three markets.')]);

    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Lead is the budget enough?' });
    await app.runtime.idle();

    expect(app.store.listHandoffs({ fromAgentId: lead.id })).toMatchObject([{ status: 'answered', delivered: true, originChannelId: null, originCommentThreadId: thread.id }]);
    expect(app.store.listRuns({ agentId: lead.id }).every((r) => r.commentThreadId === thread.id)).toBe(true);
    expect(app.comments.threads(page.id)[0].replies.map((c) => c.body)).toEqual(['I asked Analyst to check the budget.', 'Analyst says $40k covers it.']);
  });

  it('posts a reply whose thread was deleted in the agent’s chat with the owner instead', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    models.script('test/writer', [
      (req) => {
        // The page goes while the agent is thinking.
        app.pages.remove(page.id, owner.id);
        return say(`Done (${req.model}).`);
      },
    ]);
    app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer tidy this up' });
    await app.runtime.idle();
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(["(The page comment thread I was answering is gone, so I'm replying here.)\n\nDone (test/writer)."]);
  });
});

describe('page comments over HTTP', () => {
  it('lets a person comment on a selection, reply, resolve and delete', async () => {
    const { app, owner } = setup();
    server = await buildServer(app);
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    const url = `/api/pages/${page.id}/comments`;

    const created = await server.inject({ method: 'POST', url, payload: { body: 'Which ones?', anchor: { quote: 'three markets', offset: 20 } } });
    expect(created.statusCode).toBe(200);
    const root = created.json();
    expect(root).toMatchObject({ authorId: owner.id, anchor: { quote: 'three markets', offset: BRIEF.indexOf('three markets'), revision: 1 }, resolved: false });
    const reply = (await server.inject({ method: 'POST', url, payload: { body: 'US, UK, DE', threadId: root.id } })).json();
    expect(reply).toMatchObject({ threadId: root.id });

    expect((await server.inject({ method: 'POST', url, payload: { body: 'x', anchor: { quote: 'not in the page', offset: 0 } } })).statusCode).toBe(409);
    expect((await server.inject({ method: 'POST', url, payload: { body: '   ' } })).json().error).toMatch(/needs some text/);
    expect((await server.inject({ method: 'GET', url: '/api/pages/page_missing/comments' })).statusCode).toBe(404);

    const listed = (await server.inject({ method: 'GET', url })).json();
    expect(listed).toMatchObject([{ id: root.id, replies: [{ id: reply.id, body: 'US, UK, DE' }] }]);
    expect((await server.inject({ method: 'GET', url: '/api/pages' })).json()[0].openComments).toBe(1);

    expect((await server.inject({ method: 'PATCH', url: `${url}/${reply.id}`, payload: { resolved: true } })).json()).toMatchObject({ id: root.id, resolved: true });
    expect((await server.inject({ method: 'GET', url: '/api/pages' })).json()[0].openComments).toBe(0);

    // A comment is addressed through its own page.
    const other = app.pages.create({ title: 'Other', content: '' }, owner.id);
    expect((await server.inject({ method: 'DELETE', url: `/api/pages/${other.id}/comments/${root.id}` })).statusCode).toBe(404);
    expect((await server.inject({ method: 'DELETE', url: `${url}/${root.id}` })).statusCode).toBe(200);
    expect(app.store.getComment(reply.id)).toBeUndefined();
    expect(app.store.listEvents({ types: ['page.comment.deleted'] })).toMatchObject([{ channelId: null, data: { id: root.id, pageId: page.id, threadId: null, openComments: 0 } }]);
  });

  it('attributes comments to whoever is signed in, and lets only the author or an owner delete one', async () => {
    const { app, owner } = setup();
    server = await buildServer(app);
    const srv = server;
    const person = () => {
      let session = '';
      return async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => {
        const res = await srv.inject({ method, url, payload, headers: session ? { cookie: `teambot_session=${session}` } : {} });
        const set = res.headers['set-cookie'];
        const value = String(Array.isArray(set) ? set[0] : (set ?? '')).match(/^teambot_session=([^;]*)/)?.[1];
        if (value !== undefined) session = value;
        return res;
      };
    };
    const alice = person();
    const bob = person();
    const carol = person();
    expect((await alice('POST', '/api/team/enable', { password: 'owner password 1' })).statusCode).toBe(200);
    for (const [who, name] of [
      [bob, 'Bob'],
      [carol, 'Carol'],
    ] as const) {
      const { token } = (await alice('POST', '/api/team/invites', {})).json();
      expect((await who('POST', '/api/auth/join', { token, name, password: `${name} password 1` })).statusCode).toBe(200);
    }
    const page = app.pages.create({ title: 'Launch brief', content: BRIEF }, owner.id);
    const url = `/api/pages/${page.id}/comments`;

    const bobs = (await bob('POST', url, { body: 'Bob here' })).json();
    const bobId = app.store.listHumans().find((h) => h.name === 'Bob')!.id;
    expect(bobs.authorId).toBe(bobId);
    const carols = (await carol('POST', url, { body: 'Carol replies', threadId: bobs.id })).json();

    // Anyone may resolve; only the author or an owner deletes.
    expect((await carol('PATCH', `${url}/${bobs.id}`, { resolved: true })).json()).toMatchObject({ resolved: true, resolvedBy: app.store.listHumans().find((h) => h.name === 'Carol')!.id });
    const refused = await carol('DELETE', `${url}/${bobs.id}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toMatch(/Only the person who wrote a comment, or the workspace owner/);
    expect((await bob('DELETE', `${url}/${carols.id}`)).statusCode).toBe(403);
    expect((await carol('DELETE', `${url}/${carols.id}`)).statusCode).toBe(200);
    expect((await alice('DELETE', `${url}/${bobs.id}`)).statusCode).toBe(200);
    expect(app.comments.threads(page.id)).toEqual([]);
    // Signed out, nothing.
    expect((await person()('GET', url)).statusCode).toBe(401);
  });
});
