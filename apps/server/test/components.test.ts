import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { forwardable } from '../src/bridges/common.js';
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

const PRICE_TABLE = {
  title: 'Price table',
  description: 'Compare plans side by side: name and monthly price for each.',
  html: '<table id="t"></table>',
  css: 'table { width: 100%; }',
  js: 'for (const p of teambot.args.plans) document.getElementById("t").insertRow().textContent = p.name;',
  argsSchema: {
    type: 'object',
    properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' } }, required: ['name', 'price'] } } },
    required: ['plans'],
  },
  sampleArgs: { plans: [{ name: 'Pro', price: 20 }] },
};

const toolNames = (app: App, agentId: string) => app.tools.forAgent(app.store.getAgent(agentId)!).map((t) => t.name);

describe('components (generative UI)', () => {
  it('reaches agents only once published, as a ui_<name> tool that checks its arguments', () => {
    const { app, owner } = setup();
    const writer = addAgent(app, 'Writer');

    const draft = app.components.saveDraft('price_table', PRICE_TABLE, owner.id);
    expect(draft).toMatchObject({ name: 'price_table', live: false, changed: true, published: null });
    expect(toolNames(app, writer.id)).not.toContain('ui_price_table');

    // Publishing needs a description, markup, and sample arguments that fit the schema.
    app.components.saveDraft('price_table', { ...PRICE_TABLE, sampleArgs: { plans: [{ name: 'Pro' }] } }, owner.id);
    expect(() => app.components.publish('price_table', owner.id)).toThrow(/sample arguments don't fit.*plans\.0\.price/);
    app.components.saveDraft('price_table', { ...PRICE_TABLE, description: '' }, owner.id);
    expect(() => app.components.publish('price_table', owner.id)).toThrow(/description/);
    app.components.saveDraft('price_table', PRICE_TABLE, owner.id);
    const published = app.components.publish('price_table', owner.id);
    expect(published).toMatchObject({ live: true, changed: false, published: { revision: 1, by: owner.id, description: PRICE_TABLE.description } });

    const tool = app.tools.find(writer, 'ui_price_table')!;
    expect(tool.description).toContain('Compare plans side by side');
    expect(app.tools.specs([tool])[0].function.parameters).toMatchObject({ type: 'object', required: ['plans'] });
    expect(tool.schema.safeParse({ plans: [{ name: 'Pro', price: 20 }] }).success).toBe(true);
    expect(tool.schema.safeParse({ plans: [{ name: 'Pro' }] }).success).toBe(false);
    // Drawing is reporting, so read-only runs may do it.
    expect(usableReadOnly(tool)).toBe(true);

    // A new draft leaves the published version alone until it is published too.
    app.components.saveDraft('price_table', { ...PRICE_TABLE, title: 'Plans' }, owner.id);
    expect(app.components.get('price_table')).toMatchObject({ live: true, changed: false, published: { revision: 1 } });
    app.components.saveDraft('price_table', { ...PRICE_TABLE, html: '<ul></ul>' }, owner.id);
    expect(app.components.get('price_table')).toMatchObject({ changed: true, published: { html: PRICE_TABLE.html } });
    expect(app.components.publish('price_table', owner.id).published).toMatchObject({ revision: 2, html: '<ul></ul>' });

    // Withdrawn, no agent is offered it; the published copy is kept for next time.
    app.components.unpublish('price_table', owner.id);
    expect(toolNames(app, writer.id)).not.toContain('ui_price_table');
    expect(app.components.get('price_table')).toMatchObject({ live: false, published: { revision: 2 } });
    expect(() => app.components.saveDraft('Bad Name', PRICE_TABLE, owner.id)).toThrow(/lowercase/);
    expect(() => app.components.saveDraft('weird', { ...PRICE_TABLE, argsSchema: { type: 'string' } }, owner.id)).toThrow(/describe an object|can't be read/);
  });

  it('draws a component in the conversation from a copy of its published source', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    app.components.saveDraft('price_table', PRICE_TABLE, owner.id);
    app.components.publish('price_table', owner.id);
    const plans = [{ name: 'Free', price: 0 }, { name: 'Pro', price: 20 }];
    models.script('test/writer', [callTool('ui_price_table', { plans: [{ name: 'Pro' }] }), callTool('ui_price_table', { plans }), say('Pro is the better deal.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer compare the plans' });
    await app.runtime.idle();

    const run = app.store.listRuns({ agentId: writer.id })[0];
    const [invalid, shown] = toolResults(app, run.id);
    expect(invalid).toMatch(/invalid arguments for ui_price_table/);
    expect(shown).toContain('Shown in #general: "Price table"');

    const [view, reply] = messagesIn(app, general(app).id).slice(-2);
    expect(view).toMatchObject({ authorId: writer.id, runId: run.id, text: '' });
    expect(view.widget).toEqual({ kind: 'component', title: 'Price table', component: 'price_table', revision: 1, html: PRICE_TABLE.html, css: PRICE_TABLE.css, js: PRICE_TABLE.js, args: { plans } });
    expect(reply.text).toBe('Pro is the better deal.');
    // A picture isn't a request: nobody was woken by it.
    expect(app.store.pendingInbox(writer.id)).toHaveLength(0);
    // Agents reading the conversation later see what was shown.
    expect(app.workspace.messageBody(app.store.getMessage(view.id)!)).toContain('[Showed an interactive view: "Price table" (ui_price_table) with {"plans"');
  });

  it('lets agents write a one-off interface with show_ui, unless it is turned off', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [callTool('show_ui', { title: 'Signups', html: '<svg></svg>', args: { week: [3, 5] }, caption: 'Signups this week' }), say('Up 60%.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'chart the signups' });
    await app.runtime.idle();

    const [view] = messagesIn(app, dm.id).filter((m) => m.widget);
    expect(view).toMatchObject({ text: 'Signups this week', widget: { kind: 'html', title: 'Signups', html: '<svg></svg>', css: '', js: '', args: { week: [3, 5] } } });
    // Chat apps can't draw it, so they are told there is something to see.
    expect(forwardable(app, view)!.text).toContain('Signups this week\n\n🖼 Signups (an interactive view: open TeamBot to see it)');

    app.cfg.generativeUi = false;
    expect(toolNames(app, writer.id)).not.toContain('show_ui');
    expect(toolNames(app, writer.id)).toContain('draft_component');
  });

  it('lets agents draft components for a person to publish, without overwriting a person’s draft', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    const args = { name: 'status_card', title: 'Status', description: 'Show a status', html: '<p></p>', args_schema: { type: 'object', properties: { state: { type: 'string' } } }, sample_args: { state: 'ok' } };
    app.components.saveDraft('price_table', PRICE_TABLE, owner.id);
    models.script('test/writer', [callTool('draft_component', args), callTool('draft_component', { ...args, name: 'price_table' }), say('Drafted.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer make a status card' });
    await app.runtime.idle();

    const [saved, refused] = toolResults(app, app.store.listRuns({ agentId: writer.id })[0].id);
    expect(saved).toContain('Saved a draft of the component "Status" (ui_status_card). Nobody can use it until a person publishes it.');
    expect(refused).toContain('Owner is working on the component "price_table"');
    expect(app.components.get('status_card')).toMatchObject({ live: false, createdBy: writer.id, draft: { sampleArgs: { state: 'ok' } } });
    expect(app.components.get('price_table').updatedBy).toBe(owner.id);
    expect(toolNames(app, writer.id)).not.toContain('ui_status_card');
  });

  it('keeps component changes to owners in team mode, and refuses changes from sandboxed frames', async () => {
    const { app } = setup();
    server = await buildServer(app);
    // Personal mode: the owner may save; a request from a sandboxed frame ("Origin: null") may change nothing.
    expect((await server.inject({ method: 'PUT', url: '/api/components/price_table', payload: PRICE_TABLE })).statusCode).toBe(200);
    const framed = await server.inject({ method: 'POST', url: `/api/channels/${general(app).id}/messages`, payload: { text: 'hi' }, headers: { origin: 'null' } });
    expect(framed.statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/api/components', headers: { origin: 'null' } })).statusCode).toBe(200);

    const publish = await server.inject({ method: 'POST', url: '/api/components/price_table/publish' });
    expect(publish.json()).toMatchObject({ live: true });
    expect((await server.inject({ method: 'POST', url: '/api/components/nope/publish' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'PUT', url: '/api/components/x', payload: { title: 'X', argsSchema: { type: 'array' } } })).statusCode).toBe(400);

    // Team mode: a member can look but not change.
    const owner = await server.inject({ method: 'POST', url: '/api/team/enable', payload: { password: 'owner password 1' } });
    const ownerCookie = { cookie: String(owner.headers['set-cookie']).split(';')[0] };
    const { token } = (await server.inject({ method: 'POST', url: '/api/team/invites', payload: {}, headers: ownerCookie })).json();
    const joined = await server.inject({ method: 'POST', url: '/api/auth/join', payload: { token, name: 'Bob', password: 'bob password 1' } });
    const bob = { cookie: String(joined.headers['set-cookie']).split(';')[0] };
    expect((await server.inject({ method: 'GET', url: '/api/components', headers: bob })).json()).toHaveLength(1);
    expect((await server.inject({ method: 'POST', url: '/api/components/price_table/unpublish', headers: bob })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/api/components/price_table/unpublish', headers: ownerCookie })).json()).toMatchObject({ live: false });
  });
});
