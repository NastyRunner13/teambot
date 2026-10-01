import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { testApp } from './helpers.js';

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
  return { app: t.app, server };
}

describe('HTTP API', () => {
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

  it('does not let an agent take a human name', async () => {
    const { server } = await setup();
    const created = (await server.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Writer' } })).json();
    const res = await server.inject({ method: 'PATCH', url: `/api/agents/${created.id}`, payload: { name: 'Owner' } });
    expect(res.statusCode).toBe(409);
  });
});
