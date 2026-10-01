import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool } from '../src/models/scripted.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  current = null;
});

describe('computer snapshots', () => {
  it('saves the home folder compressed and puts it back on restore', async () => {
    const t = testApp();
    current = t.app;
    const { app, computers } = t;
    const ops = addAgent(app, 'Ops');
    computers.homes[ops.id] = 'tar with logins and tools';

    const snap = await app.snapshots.take(ops, 'Before the upgrade');
    expect(snap).toMatchObject({ agentId: ops.id, label: 'Before the upgrade', id: expect.stringMatching(/^\d{8}T\d{6}Z/) });
    expect(snap.size).toBeGreaterThan(0);
    const again = await app.snapshots.take(ops, '');
    expect(app.snapshots.list(ops.id).map((s) => s.id)).toEqual([again.id, snap.id].sort().reverse());

    computers.homes[ops.id] = 'something else';
    await app.snapshots.restore(ops, snap.id);
    expect(computers.homes[ops.id]).toBe('tar with logins and tools');

    app.snapshots.remove(ops.id, snap.id);
    expect(app.snapshots.list(ops.id).map((s) => s.id)).toEqual([again.id]);
    await expect(app.snapshots.restore(ops, '../../etc')).rejects.toThrow(/not a snapshot id/);
  });

  it('will not restore while the agent is working', async () => {
    const t = testApp();
    current = t.app;
    const { app, models, owner } = t;
    app.runtime.start();
    const server = await buildServer(app);
    const ops = addAgent(app, 'Ops');
    const snap = await app.snapshots.take(ops, 'x');
    models.script('test/ops', [callTool('ask_for_approval', { action: 'Deploy' })]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops deploy' });
    await app.runtime.idle();

    const res = await server.inject({ method: 'POST', url: `/api/agents/${ops.id}/snapshots/${snap.id}/restore` });
    expect(res.statusCode).toBe(409);
    await server.close();
  });
});
