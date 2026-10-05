// Page comments at the edges: validation, permissions, routing corner cases, read-only and step-limited runs,
// failures, approvals, recovery after a restart, team-mode privacy, and the HTTP error paths.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { locateAnchor, MAX_COMMENT_CHARS, MAX_COMMENT_QUOTE } from '@teambot/shared';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { CommentForbidden } from '../src/comments.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await current?.runtime.stop();
  current = null;
  server = null;
});

function setup(opts: Parameters<typeof testApp>[0] = {}, start = true) {
  const t = testApp(opts);
  current = t.app;
  if (start) t.app.runtime.start();
  return t;
}

const BRIEF = '# Launch\n\nWe launch in Q3 with three markets.\n\nBudget: $40k.';
const transcript = (app: App, runId: string) => app.store.getTranscript<TranscriptMessage>(runId);
const userInputs = (app: App, runId: string) =>
  transcript(app, runId)
    .filter((m) => m.role === 'user')
    .map((m) => String(m.content));
const toolResults = (app: App, runId: string) =>
  transcript(app, runId)
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content));
const replies = (app: App, threadId: string) => app.store.listCommentReplies(threadId).map((c) => c.body);

describe('locating a passage', () => {
  it('handles empty quotes, overlaps, ties and the end of the text', () => {
    expect(locateAnchor('anything', { quote: '', offset: 0 })).toBeNull();
    // Overlapping occurrences each count.
    expect(locateAnchor('aaaa', { quote: 'aa', offset: 1 })).toBe(1);
    expect(locateAnchor('aaaa', { quote: 'aa', offset: 2 })).toBe(2);
    // Equally near on both sides: the earlier one.
    expect(locateAnchor('ab ab ab', { quote: 'ab', offset: 4 })).toBe(3);
    expect(locateAnchor('xx end', { quote: 'end', offset: 0 })).toBe(3);
    expect(locateAnchor('same', { quote: 'same', offset: 999 })).toBe(0);
    expect(locateAnchor('', { quote: 'x', offset: 0 })).toBeNull();
  });
});

describe('page comments: validation and permissions', () => {
  it('refuses empty, oversized and misplaced comments, and strips null bytes', () => {
    const { app, owner } = setup();
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const other = app.pages.create({ title: 'Other', content: 'Other text' }, owner.id);
    const post = (input: Partial<Parameters<App['comments']['post']>[0]>) => () => app.comments.post({ pageId: page.id, authorId: owner.id, body: 'ok', ...input });

    expect(post({ body: '  \n ' })).toThrow(/needs some text/);
    expect(post({ body: '\u0000\u0000' })).toThrow(/needs some text/);
    expect(post({ body: 'x'.repeat(MAX_COMMENT_CHARS + 1) })).toThrow(/at most 10,000 characters/);
    expect(post({ anchor: { quote: '   ' } })).toThrow(/Select the passage/);
    expect(post({ anchor: { quote: 'x'.repeat(MAX_COMMENT_QUOTE + 1) } })).toThrow(/at most 1,000 characters/);
    expect(post({ pageId: undefined })).toThrow(/Say which page/);
    expect(post({ pageId: 'page_nope' })).toThrow(/page not found/);
    expect(post({ threadId: 'cmt_nope' })).toThrow(/comment not found/);
    const elsewhere = app.comments.post({ pageId: other.id, authorId: owner.id, body: 'On the other page' });
    expect(post({ threadId: elsewhere.id })).toThrow(/on another page/);

    const clean = app.comments.post({ pageId: page.id, authorId: owner.id, body: ' Fine\u0000 now ' });
    expect(clean.body).toBe('Fine now');
    expect(app.comments.post({ pageId: page.id, authorId: owner.id, body: 'x'.repeat(MAX_COMMENT_CHARS) }).body).toHaveLength(MAX_COMMENT_CHARS);
    // Nothing refused was saved.
    expect(app.comments.threads(page.id)).toHaveLength(2);
  });

  it('resolves a thread once (through any of its comments) and lets only authors or the owner delete', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const bob = app.store.createHuman('Bob');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const root = app.comments.post({ pageId: page.id, authorId: bob.id, body: 'Root by Bob' });
    const byWriter = app.comments.post({ threadId: root.id, authorId: writer.id, body: 'Reply by Writer', route: false });
    const byOwner = app.comments.post({ threadId: root.id, authorId: owner.id, body: 'Reply by owner' });

    expect(app.comments.resolve(byWriter.id, true, bob.id)).toMatchObject({ id: root.id, resolved: true, resolvedBy: bob.id });
    const before = app.store.listEvents({ types: ['page.comment.updated'] }).length;
    app.comments.resolve(root.id, true, owner.id); // already resolved: nothing changes, nothing is announced
    expect(app.store.listEvents({ types: ['page.comment.updated'] })).toHaveLength(before);
    expect(app.comments.get(root.id).resolvedBy).toBe(bob.id);

    expect(() => app.comments.remove(root.id, writer.id)).toThrow(CommentForbidden);
    expect(() => app.comments.remove(byOwner.id, bob.id)).toThrow(/Only the person who wrote a comment, or the workspace owner/);
    // An agent may delete what it wrote; deleting a reply leaves the thread.
    app.comments.remove(byWriter.id, writer.id);
    expect(app.comments.threads(page.id)).toMatchObject([{ id: root.id, replies: [{ id: byOwner.id }] }]);
    // The owner may delete anyone's, and a root takes its replies with it.
    app.comments.remove(root.id, owner.id);
    expect(app.store.getComment(byOwner.id)).toBeUndefined();
    expect(app.store.listEvents({ types: ['page.comment.deleted'] }).map((e) => e.data.id)).toEqual(expect.arrayContaining([byWriter.id, root.id]));
    expect(() => app.comments.remove(root.id, owner.id)).toThrow(/comment not found/);
  });
});

describe('page comments: routing', () => {
  it('wakes every agent mentioned, ignores people and unknown names, and never wakes the author', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    const bob = app.store.createHuman('Bob');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    app.runtime.setPausedAll(true, owner.id);

    const c = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer and @editor, also @Bob and @Nobody: thoughts?' });
    expect(c.mentions.sort()).toEqual([writer.id, editor.id, bob.id].sort());
    for (const agent of [writer, editor]) expect(app.store.pendingInbox(agent.id)).toMatchObject([{ commentThreadId: c.id, channelId: null, threadId: null, depth: 0, initiator: 'human', readOnly: false }]);

    // An agent naming itself doesn't wake itself.
    app.comments.post({ threadId: c.id, authorId: writer.id, body: 'Noted, @Writer will look', actor: { id: writer.id, depth: 0, initiator: 'human' } });
    expect(app.store.pendingInbox(writer.id)).toHaveLength(1);
    // A comment that mentions nobody, outside any thread with agents, wakes nobody.
    app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Just a note' });
    expect(app.store.pendingInbox(writer.id)).toHaveLength(1);
    expect(app.store.pendingInbox(editor.id)).toHaveLength(1);
  });

  it('continues a thread with every agent in it when a person replies, but not when an agent does', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const editor = addAgent(app, 'Editor');
    const analyst = addAgent(app, 'Analyst');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    app.runtime.setPausedAll(true, owner.id);
    const root = app.comments.post({ pageId: page.id, authorId: writer.id, body: 'I wrote this part', route: false });
    app.comments.post({ threadId: root.id, authorId: editor.id, body: 'I edited it', route: false });

    // Another agent replying without a mention wakes nobody.
    app.comments.post({ threadId: root.id, authorId: analyst.id, body: 'Looks fine', actor: { id: analyst.id, depth: 0, initiator: 'human' } });
    expect(app.store.pendingInbox(writer.id)).toHaveLength(0);
    expect(app.store.pendingInbox(editor.id)).toHaveLength(0);

    app.comments.post({ threadId: root.id, authorId: owner.id, body: 'Can you both shorten it?' });
    for (const agent of [writer, editor, analyst]) expect(app.store.pendingInbox(agent.id)).toMatchObject([{ commentThreadId: root.id, text: expect.stringContaining('Can you both shorten it?') }]);
  });

  it('answers comments queued for a page that was deleted in the agent’s chat with the owner', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    app.runtime.setPausedAll(true, owner.id);
    app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer check this' });
    app.pages.remove(page.id, owner.id);
    models.script('test/writer', [say('Checked.')]);
    app.runtime.setPausedAll(false, owner.id);
    await app.runtime.idle();

    const [run] = app.store.listRuns({ agentId: writer.id });
    expect(run.status).toBe('completed');
    // Without its thread, the agent still gets the comment itself.
    expect(userInputs(app, run.id)[0]).toContain('@Writer check this');
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(["(The page comment thread I was answering is gone, so I'm replying here.)\n\nChecked."]);
  });
});

describe('page comments: agents at work', () => {
  it('describes outdated and whole-page threads to the agent', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const anchored = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Too vague', anchor: { quote: 'three markets' } });
    const whole = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Overall fine' });
    app.pages.update(page.id, { content: BRIEF.replace('three markets', 'two markets') }, 1, owner.id);
    models.script('test/writer', [
      callTool('list_page_comments', { page: page.id }),
      say('Noted.'),
      say('Fine.'),
    ]);

    app.comments.post({ threadId: anchored.id, authorId: owner.id, body: '@Writer still vague?' });
    await app.runtime.idle();
    const [run] = app.store.listRuns({ agentId: writer.id });
    const input = userInputs(app, run.id)[0];
    expect(input).toContain('(now at revision 2)');
    expect(input).toContain('quoted on revision 1; it has been edited away since, so the thread is outdated');
    expect(input).toContain(`- ${owner.name}: Too vague`);
    expect(toolResults(app, run.id)[0]).toContain(`Thread ${anchored.id} on "three markets" (outdated: that passage was edited away):`);
    expect(toolResults(app, run.id)[0]).toContain(`Thread ${whole.id} on the whole page:`);

    app.comments.post({ threadId: whole.id, authorId: owner.id, body: '@Writer anything to add?' });
    await app.runtime.idle();
    expect(userInputs(app, app.store.listRuns({ agentId: writer.id })[0].id)[0]).toContain('The thread is about the page as a whole.');
    expect(replies(app, whole.id)).toEqual(['@Writer anything to add?', 'Fine.']);
  });

  it('reports tool mistakes back to the agent without saving anything', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const other = app.pages.create({ title: 'Other', content: 'Other' }, owner.id);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'A thread' });
    models.script('test/writer', [
      callTool('comment_on_page', { text: 'Where does this go?' }),
      callTool('comment_on_page', { reply_to: thread.id, quote: 'Q3', text: 'x' }),
      callTool('comment_on_page', { page: page.id, quote: 'Q4', text: 'x' }),
      callTool('comment_on_page', { page: other.id, reply_to: thread.id, text: 'x' }),
      callTool('comment_on_page', { reply_to: 'cmt_missing', text: 'x' }),
      callTool('resolve_comment', { thread: 'cmt_missing' }),
      callTool('list_page_comments', { page: other.id }),
      callTool('resolve_comment', { thread: thread.id }),
      callTool('resolve_comment', { thread: thread.id, resolved: false }),
      callTool('list_page_comments', { page: 'No such page' }),
      say('Done.'),
    ]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer tidy the comments' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [noPlace, quoteOnReply, missingQuote, wrongPage, missingThread, resolveMissing, emptyList, resolved, reopened, noPage] = toolResults(app, run.id);
    expect(noPlace).toMatch(/invalid arguments for comment_on_page: [\s\S]*Give the page for a new thread, or reply_to/);
    expect(quoteOnReply).toMatch(/invalid arguments for comment_on_page: [\s\S]*leave quote out/);
    expect(missingQuote).toMatch(/Not commented: the quote isn't in \[Brief\]/);
    expect(wrongPage).toMatch(new RegExp(`Thread ${thread.id} is on \\[Brief\\]\\(/pages/${page.id}\\), not on ${other.id}`));
    expect(missingThread).toBe('Error: comment not found');
    expect(resolveMissing).toBe('Error: comment not found');
    expect(emptyList).toContain(`[Other](/pages/${other.id}) has no open comments.`);
    expect(resolved).toBe(`Resolved thread ${thread.id} on [Brief](/pages/${page.id}).`);
    expect(reopened).toBe(`Reopened thread ${thread.id} on [Brief](/pages/${page.id}).`);
    expect(noPage).toMatch(/There is no page "No such page"/);
    // Only the resolve and reopen changed anything.
    expect(app.comments.threads(page.id)).toMatchObject([{ id: thread.id, resolved: false, replies: [] }]);
    expect(app.comments.threads(other.id)).toEqual([]);
  });

  it('counts agents mentioned in comments toward the teammates one job may hand work to', async () => {
    const { app, models, owner } = setup();
    app.cfg.maxHandoffsPerRun = 1;
    const writer = addAgent(app, 'Writer');
    addAgent(app, 'Editor');
    addAgent(app, 'Analyst');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    app.runtime.setPausedAll(true, owner.id);
    models.script('test/writer', [
      callTool('comment_on_page', { page: page.id, text: '@Editor and @Analyst, please review' }),
      callTool('comment_on_page', { page: page.id, text: '@Editor please review' }),
      callTool('comment_on_page', { page: page.id, text: '@Analyst too' }),
      say('Asked Editor.'),
    ]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer get the brief reviewed' });
    app.runtime.setPausedAll(false, owner.id);
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id }).find((r) => r.channelId === general(app).id)!;
    const [two, one, third] = toolResults(app, run.id);
    expect(two).toMatch(/limit is 1/);
    expect(one).toMatch(/^Started thread cmt_/);
    expect(third).toMatch(/already handed work to 1 teammate/);
    expect(app.comments.threads(page.id).map((t) => t.body)).toEqual(['@Editor please review']);
  });

  it('lets a read-only run comment but not resolve threads or edit the page', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const watcher = addAgent(app, 'Watcher');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: 'Is the budget right?' });
    // A read-only routine run of Watcher's mentions Writer in a comment: Writer's run is read-only too.
    const watch = app.store.createRun({ agentId: watcher.id, channelId: null, initiator: 'schedule', depth: 0, title: 'watch', readOnly: true });
    app.store.updateRun(watch.id, { status: 'completed' });
    models.script('test/writer', [
      callTool('comment_on_page', { reply_to: thread.id, text: 'It looks right to me.' }),
      callTool('resolve_comment', { thread: thread.id }),
      callTool('edit_page', { page: page.id, expected_revision: 1, content: 'Overwritten' }),
      say('Reported.'),
    ]);
    app.comments.post({ threadId: thread.id, authorId: watcher.id, body: '@Writer please check the budget', actor: { id: watcher.id, depth: 0, initiator: 'schedule', runId: watch.id } });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    expect(run).toMatchObject({ readOnly: true, initiator: 'schedule', commentThreadId: thread.id });
    const [commented, resolve, edit] = toolResults(app, run.id);
    expect(commented).toBe(`Replied in thread ${thread.id} on [Brief](/pages/${page.id}).`);
    expect(resolve).toMatch(/^Blocked: this is a read-only routine, so resolve_comment is not available/);
    expect(edit).toMatch(/^Blocked: this is a read-only routine, so edit_page is not available/);
    expect(app.comments.get(thread.id).resolved).toBe(false);
    expect(app.pages.get(page.id).content).toBe(BRIEF);
    expect(replies(app, thread.id)).toEqual(['@Writer please check the budget', 'It looks right to me.', 'Reported.']);
  });

  it('posts the step-limit notice in the thread, and carries on from it when asked there', async () => {
    const { app, models, owner } = setup();
    app.cfg.maxStepsPerRun = 1;
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    models.script('test/writer', [callTool('read_page', { page: page.id })]);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer rework the budget section' });
    await app.runtime.idle();
    expect(replies(app, thread.id)).toEqual(["I stopped after 1 steps (the per-run limit). Tell me to continue and I'll pick up where I left off."]);
    // A comment elsewhere doesn't take over that transcript; one in the same thread does.
    const [first] = app.store.listRuns({ agentId: writer.id });
    const before = transcript(app, first.id);

    app.cfg.maxStepsPerRun = 20;
    models.script('test/writer', [say('Reworked it.')]);
    app.comments.post({ threadId: thread.id, authorId: owner.id, body: 'continue' });
    await app.runtime.idle();
    const second = app.store.listRuns({ agentId: writer.id })[0];
    expect(second.id).not.toBe(first.id);
    const after = transcript(app, second.id);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(String(after[before.length].content)).toMatch(/^\[system\] Your last job in this conversation stopped at the step limit/);
    expect(replies(app, thread.id).at(-1)).toBe('Reworked it.');
  });

  it('reports a failed run in the thread', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    models.script('test/writer', [
      () => {
        throw new Error('the model provider is down');
      },
    ]);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer help' });
    await app.runtime.idle();
    expect(app.store.listRuns({ agentId: writer.id })[0]).toMatchObject({ status: 'failed', error: 'the model provider is down' });
    expect(replies(app, thread.id)).toEqual(['⚠️ I stopped because of an error: the model provider is down']);
  });

  it('waits for a person’s approval from a thread, and answers there once approved; a cancelled run says nothing', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    models.script('test/writer', [callTool('propose_page', { title: 'Budget detail', content: '# Budget\n\n$40k' }), say('Saved the budget page for you.')]);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer draft a budget page' });
    await app.runtime.idle();

    const [approval] = app.store.listApprovals({ status: 'pending' });
    expect(approval).toMatchObject({ tool: 'propose_page', channelId: null, agentId: writer.id });
    expect(app.store.getRun(approval.runId)).toMatchObject({ status: 'waiting_approval', commentThreadId: thread.id });
    app.runtime.resolveApproval(approval.id, 'approve', null, owner.id);
    await app.runtime.idle();
    expect(app.pages.list().map((p) => p.title)).toContain('Budget detail');
    expect(replies(app, thread.id)).toEqual(['Saved the budget page for you.']);

    // Stopped while waiting: the request is cancelled and nothing is posted.
    models.script('test/writer', [callTool('propose_page', { title: 'Another', content: 'x' })]);
    app.comments.post({ threadId: thread.id, authorId: owner.id, body: 'And another page?' });
    await app.runtime.idle();
    const waiting = app.store.listRuns({ agentId: writer.id, statuses: ['waiting_approval'] })[0];
    app.runtime.cancelRun(waiting.id, owner.id);
    await app.runtime.idle();
    expect(app.store.getRun(waiting.id)!.status).toBe('cancelled');
    expect(app.store.listApprovals({ status: 'pending' })).toHaveLength(0);
    expect(replies(app, thread.id)).toEqual(['Saved the budget page for you.', 'And another page?']);
  });

  it('picks a comment run up again after a restart and still answers in its thread', async () => {
    const { app, models, owner } = setup({}, false);
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    // Held, so nothing picks the comment up before the "crash" below is staged.
    app.runtime.setPausedAll(true, owner.id);
    const thread = app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer summarize' });
    // As if the server died mid-run: the item was taken in and the run was left "running".
    const [item] = app.store.pendingInbox(writer.id);
    const run = app.store.createRun({ agentId: writer.id, channelId: null, commentThreadId: thread.id, initiator: 'human', depth: 0, title: 'summarize' });
    app.store.consumeInbox([item.id], run.id);
    app.store.setTranscript(run.id, [{ role: 'user', content: item.text }]);
    app.store.updateRun(run.id, { status: 'running' });
    models.script('test/writer', [say('Three markets, $40k.')]);

    app.runtime.start();
    app.runtime.setPausedAll(false, owner.id);
    await app.runtime.idle();
    expect(app.store.getRun(run.id)).toMatchObject({ status: 'completed', commentThreadId: thread.id, channelId: null });
    expect(app.store.listEvents({ runId: run.id, types: ['run.recovered'] })).toHaveLength(1);
    expect(replies(app, thread.id)).toEqual(['Three markets, $40k.']);
  });

  it('shows the agent its jobs in comment threads when it works elsewhere', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    models.script('test/writer', [say('Fixed the budget line.'), say('Yes, I fixed it.')]);
    app.comments.post({ pageId: page.id, authorId: owner.id, body: '@Writer fix the budget line' });
    await app.runtime.idle();
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer did you fix the budget?' });
    await app.runtime.idle();
    const prompt = String(models.requests.at(-1)!.messages[0].content);
    expect(prompt).toContain('## Your recent work');
    expect(prompt).toMatch(new RegExp(`a comment thread on the page \\[Brief\\]\\(/pages/${page.id}\\): ".*fix the budget line" → you replied "Fixed the budget line\\."`));
  });

  it('in team mode, keeps an agent asked in a comment out of people’s private chats', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const bob = app.store.createHuman('Bob');
    app.store.setSetting('team_mode', '1');
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'The secret plan is X', route: false });
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    models.script('test/writer', [callTool('read_channel', { channel: `DM with ${owner.name}` }), say('I can’t read that from here.')]);

    // Pages and comments are open to everyone, so the agent may read only what everyone can.
    app.comments.post({ pageId: page.id, authorId: bob.id, body: `@Writer what did ${owner.name} tell you in private?` });
    await app.runtime.idle();
    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [read] = toolResults(app, run.id);
    expect(read).toMatch(/private to people who aren't all in this conversation/);
    expect(read).not.toContain('secret plan');
  });
});

describe('page comments over HTTP: errors', () => {
  it('answers bad requests with the right status and changes nothing', async () => {
    const { app, owner } = setup();
    server = await buildServer(app);
    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const other = app.pages.create({ title: 'Other', content: 'Other' }, owner.id);
    const url = `/api/pages/${page.id}/comments`;
    const thread = app.comments.post({ pageId: other.id, authorId: owner.id, body: 'On the other page' });
    const inject = (method: 'POST' | 'PATCH' | 'DELETE' | 'GET', path: string, payload?: object, headers: Record<string, string> = {}) =>
      server!.inject({ method, url: path, payload, headers });

    expect((await inject('POST', '/api/pages/page_nope/comments', { body: 'x' })).statusCode).toBe(404);
    expect((await inject('POST', url, { body: 'x', threadId: thread.id })).json().error).toMatch(/on another page/);
    expect((await inject('POST', url, { body: 'x', threadId: 'cmt_nope' })).statusCode).toBe(404);
    expect((await inject('POST', url, { body: 'x'.repeat(MAX_COMMENT_CHARS + 1) })).statusCode).toBe(400);
    expect((await inject('POST', url, { body: 'x', anchor: { quote: 'Q3', offset: -1 } })).statusCode).toBe(400);
    expect((await inject('POST', url, { body: 'x', anchor: { quote: '', offset: 0 } })).statusCode).toBe(400);
    expect((await inject('POST', url, {})).statusCode).toBe(400);
    expect((await inject('PATCH', `${url}/${thread.id}`, { resolved: true })).statusCode).toBe(404); // addressed through the wrong page
    expect((await inject('PATCH', `/api/pages/${other.id}/comments/${thread.id}`, { resolved: 'yes' })).statusCode).toBe(400);
    expect((await inject('DELETE', `${url}/cmt_nope`)).statusCode).toBe(404);
    // Sandboxed interfaces can't comment as the owner.
    expect((await inject('POST', url, { body: 'from a widget' }, { origin: 'null' })).statusCode).toBe(403);
    expect(app.comments.threads(page.id)).toEqual([]);
    expect(app.comments.get(thread.id).resolved).toBe(false);
  });

  it('lets every signed-in person see comment events, which belong to no chat', async () => {
    const { app, owner } = setup();
    server = await buildServer(app);
    const srv = server;
    let session = '';
    const call = async (method: 'GET' | 'POST', url: string, payload?: object, cookie = session) => {
      const res = await srv.inject({ method, url, payload, headers: cookie ? { cookie: `teambot_session=${cookie}` } : {} });
      const value = String([res.headers['set-cookie']].flat()[0] ?? '').match(/^teambot_session=([^;]*)/)?.[1];
      if (value !== undefined) session = value;
      return res;
    };
    await call('POST', '/api/team/enable', { password: 'owner password 1' });
    const ownerSession = session;
    const { token } = (await call('POST', '/api/team/invites', {})).json();
    session = '';
    await call('POST', '/api/auth/join', { token, name: 'Bob', password: 'bob password 1' });
    const bobSession = session;

    const page = app.pages.create({ title: 'Brief', content: BRIEF }, owner.id);
    const posted = (await call('POST', `/api/pages/${page.id}/comments`, { body: 'By the owner' }, ownerSession)).json();
    const events = (await call('GET', '/api/events?types=page.comment.created', undefined, bobSession)).json();
    expect(events.map((e: { data: { comment: { id: string } } }) => e.data.comment.id)).toContain(posted.id);
    expect((await call('GET', `/api/pages/${page.id}/comments`, undefined, bobSession)).json()).toMatchObject([{ id: posted.id, authorId: owner.id }]);
  });
});
