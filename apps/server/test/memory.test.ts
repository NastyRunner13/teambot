import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { searchTerms, snippet } from '../src/search.js';
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

const lastToolResult = (app: App, agentId: string) =>
  app.store
    .getTranscript<TranscriptMessage>(app.store.listRuns({ agentId })[0].id)
    .filter((m) => m.role === 'tool')
    .at(-1)!.content;

describe('memory', () => {
  it('keeps an agent’s notes in a plain file that every later prompt includes', async () => {
    const { app, models, owner } = setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [callTool('remember', { note: 'Owner prefers British spelling' }), say('Noted.'), say('Hi again.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer always use British spelling' });
    await app.runtime.idle();

    const file = app.memory.file('agent', writer);
    expect(fs.readFileSync(file, 'utf8')).toMatch(/^- Owner prefers British spelling \(\d{4}-\d{2}-\d{2}\)\n$/);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer hello' });
    await app.runtime.idle();
    const prompt = String(models.requests.at(-1)!.messages[0].content);
    expect(prompt).toContain('### Your memory\n- Owner prefers British spelling');

    app.memory.forget('agent', 'british', writer);
    expect(app.memory.read('agent', writer)).toBe('');
  });

  it('sends team memory changes to the reviewer, then shares them with every agent', async () => {
    const { app, models, owner } = setup();
    addAgent(app, 'Writer');
    const lead = addAgent(app, 'Lead');
    models.script('test/writer', [callTool('remember', { note: 'Launch date is 14 November', scope: 'team' }), say('Saved for everyone.')]);
    models.script('test/reviewer', [say('{"verdict":"allow","reason":"A fact the owner stated"}')]);
    models.script('test/lead', [say('ok')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer remember for the team: launch is 14 November' });
    await app.runtime.idle();
    expect(models.requests.some((r) => r.model === 'test/reviewer')).toBe(true);
    expect(app.memory.read('team')).toContain('- Launch date is 14 November (Writer,');

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Lead when do we launch?' });
    await app.runtime.idle();
    const leadPrompt = String(models.requests.filter((r) => r.model === 'test/lead').at(-1)!.messages[0].content);
    expect(leadPrompt).toContain('### Team memory\n- Launch date is 14 November');
    void lead;
  });

  it('is editable over the API and follows renames', async () => {
    const { app } = setup();
    const server = await buildServer(app);
    const writer = addAgent(app, 'Writer');
    await server.inject({ method: 'PUT', url: `/api/agents/${writer.id}/memory`, payload: { content: '- likes tables' } });
    await server.inject({ method: 'PATCH', url: `/api/agents/${writer.id}`, payload: { name: 'Scribe' } });
    expect((await server.inject({ method: 'GET', url: `/api/agents/${writer.id}/memory` })).json().content).toBe('- likes tables\n');
    const big = await server.inject({ method: 'PUT', url: '/api/memory/team', payload: { content: 'x'.repeat(40_000) } });
    expect(big.statusCode).toBe(400);
    await server.close();
  });
});

describe('history search', () => {
  it('finds past messages and tasks where every word matches', async () => {
    const { app, models, owner } = setup();
    const ops = addAgent(app, 'Ops');
    const launch = app.workspace.createChannel({ name: 'launch', memberIds: [] }, owner.id);
    app.workspace.postMessage({ channelId: launch.id, authorId: owner.id, text: 'The staging server is staging.example.com, use port 8443' });
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: 'Lunch is at noon' });
    app.workspace.createTask({ title: 'Fix the staging deploy', description: 'Deploys hang at 50% on staging' }, { id: owner.id, depth: 0, initiator: 'human' });
    models.script('test/ops', [callTool('search_history', { query: 'staging port' }), say('Found it.')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops what was the staging port?' });
    await app.runtime.idle();

    const result = lastToolResult(app, ops.id);
    expect(result).toContain('#launch — Owner: The staging server is staging.example.com, use port 8443');
    expect(result).not.toContain('Lunch');

    expect(app.store.searchTasks(searchTerms('"50%"')).map((t) => t.title)).toEqual(['Fix the staging deploy']);
    expect(app.store.searchTasks(searchTerms('5_%'))).toEqual([]);
    expect(snippet('a '.repeat(200) + 'needle here', ['needle'], 10)).toBe('…a a a a a needle her…');
  });
});
