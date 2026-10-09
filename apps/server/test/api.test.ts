import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { addAgent, general, testApp } from './helpers.js';

let app: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await app?.runtime.stop();
  app = server = null;
});

async function setup() {
  const t = testApp();
  app = t.app;
  server = await buildServer(t.app);
  return { app: t.app, server, models: t.models };
}

describe('HTTP API', () => {
  it('reports offline model mode in health when no OpenRouter key is configured', async () => {
    const { app, server } = await setup();
    app.cfg.offlineModels = true;
    app.cfg.openrouterKey = '';

    const response = await server.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ offlineModels: true, openrouterKey: false });
  });

  it('PATCH only changes the fields it is given', async () => {
    const { server } = await setup();
    const created = (
      await server.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Writer', role: 'Writes things', instructions: 'Be brief', mcpServers: ['github'] } })
    ).json();
    const patched = (await server.inject({ method: 'PATCH', url: `/api/agents/${created.id}`, payload: { avatar: '🦉' } })).json();
    expect(patched).toMatchObject({ avatar: '🦉', role: 'Writes things', instructions: 'Be brief', mcpServers: ['github'] });

    const s = (
      await server.inject({ method: 'POST', url: '/api/schedules', payload: { agentId: created.id, name: 'Daily', cron: '0 9 * * *', prompt: 'Summarize', enabled: false } })
    ).json();
    const renamed = (await server.inject({ method: 'PATCH', url: `/api/schedules/${s.id}`, payload: { name: 'Morning' } })).json();
    expect(renamed).toMatchObject({ name: 'Morning', enabled: false });
  });

  it('previews each conversation and lists the files an agent shared that still exist', async () => {
    const { app, server } = await setup();
    fs.mkdirSync(app.cfg.sharedDir, { recursive: true });
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'report.md'), '# Report');
    fs.writeFileSync(path.join(app.cfg.sharedDir, 'draft.md'), '# Draft');
    const writer = addAgent(app, 'Writer');
    const channel = general(app);
    app.workspace.postMessage({ channelId: channel.id, authorId: writer.id, text: 'Draft', attachments: ['/shared/draft.md', '/shared/report.md'] });
    app.workspace.postMessage({ channelId: channel.id, authorId: writer.id, text: 'Final', attachments: ['/shared/report.md'] });
    fs.unlinkSync(path.join(app.cfg.sharedDir, 'draft.md'));

    const boot = (await server.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    expect(boot.lastMessages).toEqual([expect.objectContaining({ channelId: channel.id, text: 'Final' })]);

    const library = (await server.inject({ method: 'GET', url: `/api/agents/${writer.id}/library` })).json();
    expect(library).toEqual([expect.objectContaining({ path: '/shared/report.md', name: 'report.md', authorId: writer.id, channelId: channel.id })]);
    const inChannel = (await server.inject({ method: 'GET', url: `/api/channels/${channel.id}/library` })).json();
    expect(inChannel.map((i: { path: string }) => i.path)).toEqual(['/shared/report.md']);
  });

  it('summarizes runs with how many actions each took', async () => {
    const { app, server, models } = await setup();
    const writer = addAgent(app, 'Writer');
    app.runtime.start();
    models.script('test/writer', [callTool('search_history', { query: 'launch' }), callTool('search_history', { query: 'pricing' }), say('Nothing earlier.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: app.workspace.owner().id, text: '@Writer did we discuss this?' });
    await app.runtime.idle();

    const reply = app.store.listTopLevel(general(app).id).at(-1)!;
    expect(reply).toMatchObject({ authorId: writer.id, text: 'Nothing earlier.' });
    const summaries = (await server.inject({ method: 'GET', url: `/api/runs?ids=${reply.runId},missing` })).json();
    expect(summaries).toEqual([expect.objectContaining({ id: reply.runId, agentId: writer.id, status: 'completed', toolCalls: 2 })]);
  });

  it('does not let an agent take a human name', async () => {
    const { server } = await setup();
    const created = (await server.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Writer' } })).json();
    const res = await server.inject({ method: 'PATCH', url: `/api/agents/${created.id}`, payload: { name: 'Owner' } });
    expect(res.statusCode).toBe(409);
  });
});
