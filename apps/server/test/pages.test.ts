import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { PageConflict } from '../src/pages.js';
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

function setup() {
  const t = testApp();
  current = t.app;
  t.app.runtime.start();
  return t;
}

const toolResults = (app: App, runId: string) =>
  app.store
    .getTranscript<TranscriptMessage>(runId)
    .filter((m) => m.role === 'tool')
    .map((m) => String(m.content));

describe('pages', () => {
  it('saves over the revision an edit started from, and refuses an edit made over an older one', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: '  Launch   brief ', content: '# Launch' }, owner.id);
    expect(page).toMatchObject({ title: 'Launch brief', revision: 1, createdBy: owner.id, updatedBy: owner.id });

    const second = app.pages.update(page.id, { content: '# Launch\n\nGoals' }, 1, writer.id);
    expect(second).toMatchObject({ revision: 2, updatedBy: writer.id, createdBy: owner.id });

    // The owner still has revision 1 open: their save is refused, and nothing changes.
    let conflict: unknown;
    try {
      app.pages.update(page.id, { content: '# Launch (mine)' }, 1, owner.id);
    } catch (err) {
      conflict = err;
    }
    expect(conflict).toBeInstanceOf(PageConflict);
    expect((conflict as PageConflict).current).toMatchObject({ revision: 2, content: '# Launch\n\nGoals' });
    expect(app.store.getPage(page.id)!.revision).toBe(2);

    // A save that changes nothing isn't a conflict: the editor already has what is there.
    expect(app.pages.update(page.id, { content: '# Launch\n\nGoals' }, 1, owner.id).revision).toBe(2);
    expect(() => app.pages.create({ title: '   ' }, owner.id)).toThrow(/needs a title/);

    // Every change is announced to everyone (pages belong to the whole workspace), not tied to a conversation.
    const events = app.store.listEvents({ types: ['page.created', 'page.updated'] });
    expect(events.map((e) => e.type).sort()).toEqual(['page.created', 'page.updated']);
    expect(events.every((e) => e.channelId === null && e.runId === null)).toBe(true);
    expect(events.find((e) => e.type === 'page.updated')!.data.page).toMatchObject({ revision: 2, updatedBy: writer.id });
    expect(events[0].data.page).not.toHaveProperty('content');
  });

  it('lets agents find, read and edit pages, with edits that name the revision they read', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const page = app.pages.create({ title: 'Launch brief', content: '# Launch\n\nDate: TBD\nOwner: Ann' }, owner.id);
    models.script('test/writer', [
      callTool('list_pages', { query: 'launch' }),
      callTool('read_page', { page: 'Launch brief' }),
      callTool('edit_page', { page: `/pages/${page.id}`, expected_revision: 1, edits: [{ find: 'Date: TBD', replace: 'Date: 12 November' }] }),
      callTool('edit_page', { page: page.id, expected_revision: 1, content: 'Overwritten' }),
      callTool('edit_page', { page: page.id, expected_revision: 2, edits: [{ find: 'not there', replace: 'x' }] }),
      say('Updated the date.'),
    ]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer set the launch date' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [listed, read, edited, stale, missing] = toolResults(app, run.id);
    expect(listed).toContain(`[Launch brief](/pages/${page.id}) · revision 1`);
    // Pages are written by people and agents: their text comes back marked as outside content.
    expect(read).toContain('<untrusted_content source="read_page">');
    expect(read).toContain('revision 1');
    expect(read).toContain('Owner: Ann');
    expect(edited).toBe(`Saved [Launch brief](/pages/${page.id}): it is now revision 2.`);
    expect(stale).toMatch(/Not saved: "Launch brief" changed after revision 1\. It is now revision 2, last edited by Writer/);
    expect(missing).toMatch(/isn't in the page \(revision 2\)/);

    const saved = app.store.getPage(page.id)!;
    expect(saved).toMatchObject({ revision: 2, updatedBy: writer.id, content: '# Launch\n\nDate: 12 November\nOwner: Ann' });
  });

  it('keeps writing pages out of read-only runs, which can still read them', () => {
    const { app } = setup();
    const writer = addAgent(app, 'Writer');
    const readOnly = app.tools.forAgent(writer).filter(usableReadOnly).map((t) => t.name);
    expect(readOnly).toEqual(expect.arrayContaining(['list_pages', 'read_page']));
    expect(readOnly).not.toContain('create_page');
    expect(readOnly).not.toContain('edit_page');
    expect(readOnly).not.toContain('propose_page');
  });

  it('saves a proposed page only once a person approves the draft', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const draft = { title: 'Q4 plan', content: '# Q4\n\n- Ship pages' };
    models.script('test/writer', [callTool('propose_page', draft), say('Saved the plan.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer draft the Q4 plan for me to check' });
    await app.runtime.idle();

    // Always a person's call, whatever the policy says, and nothing is saved while they decide.
    const [approval] = app.store.listApprovals({ status: 'pending' });
    expect(approval).toMatchObject({ tool: 'propose_page', kind: 'approval', summary: 'Save the page "Q4 plan"', args: draft, channelId: general(app).id });
    expect(app.store.getRun(approval.runId)!.status).toBe('waiting_approval');
    expect(app.pages.list()).toHaveLength(0);

    app.runtime.resolveApproval(approval.id, 'approve', null, owner.id);
    await app.runtime.idle();

    const [page] = app.pages.list();
    expect(page).toMatchObject({ title: 'Q4 plan', revision: 1, createdBy: writer.id });
    expect(toolResults(app, approval.runId)[0]).toBe(`Approved and saved as [Q4 plan](/pages/${page.id}) (revision 1). Give the person that link.`);
    expect(app.store.getRun(approval.runId)!.status).toBe('completed');
    expect(messagesIn(app, general(app).id).at(-1)!.text).toBe('Saved the plan.');

    // Run again for the same tool call (a retry after a restart), it returns the page it saved instead of a second one.
    const again = app.pages.create(draft, writer.id, { runId: approval.runId, callId: approval.toolCallId });
    expect(again.id).toBe(page.id);
    expect(app.pages.list()).toHaveLength(1);
  });

  it('saves nothing when the person declines the draft, and tells the agent why', async () => {
    const { app, models, owner } = setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('propose_page', { title: 'Q4 plan', content: 'Draft' }), say('Understood.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer draft the Q4 plan' });
    await app.runtime.idle();

    const [approval] = app.store.listApprovals({ status: 'pending' });
    app.runtime.resolveApproval(approval.id, 'deny', 'Make it shorter', owner.id);
    await app.runtime.idle();

    expect(app.pages.list()).toHaveLength(0);
    expect(toolResults(app, approval.runId)[0]).toContain('A human denied this: Save the page "Q4 plan". Their note: "Make it shorter"');
  });

  it('serves pages over HTTP, answering a stale save with 409 and the page as it is now', async () => {
    const { app, owner } = setup();
    server = await buildServer(app);
    const created = (await server.inject({ method: 'POST', url: '/api/pages', payload: { title: 'Notes' } })).json();
    expect(created).toMatchObject({ title: 'Notes', content: '', revision: 1, createdBy: owner.id });

    const saved = await server.inject({ method: 'PATCH', url: `/api/pages/${created.id}`, payload: { content: 'First', expectedRevision: 1 } });
    expect(saved.json()).toMatchObject({ content: 'First', revision: 2 });

    const stale = await server.inject({ method: 'PATCH', url: `/api/pages/${created.id}`, payload: { content: 'Second', expectedRevision: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: expect.stringMatching(/revision 2/), page: { content: 'First', revision: 2 } });

    expect((await server.inject({ method: 'PATCH', url: `/api/pages/${created.id}`, payload: { content: 'x' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'GET', url: '/api/pages' })).json()).toEqual([expect.objectContaining({ id: created.id, size: 5 })]);
    expect((await server.inject({ method: 'DELETE', url: `/api/pages/${created.id}` })).json()).toEqual({ ok: true });
    expect((await server.inject({ method: 'GET', url: `/api/pages/${created.id}` })).statusCode).toBe(404);
  });
});
