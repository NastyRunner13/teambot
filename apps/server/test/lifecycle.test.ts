import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
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

const shellCommands = (calls: { path: string; body: Record<string, unknown> }[]) => calls.filter((c) => c.path === '/shell').map((c) => String(c.body.command));

describe('setup scripts', () => {
  it('runs once before the first tool call, with secrets filled in and kept out of the log', async () => {
    const { app, models, owner, computers } = setup();
    app.vault.set('NPM_TOKEN', 'npm-secret-123');
    const ops = addAgent(app, 'Ops');
    app.store.updateAgent(ops.id, { setupScript: 'npm config set token {{secret:NPM_TOKEN}}\nsudo apt-get install -y jq', computerImage: 'teambot/computer-node:latest' });
    models.script('test/ops', [callTool('shell', { command: 'jq --version' }), callTool('shell', { command: 'ls' }), say('ok')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops check jq' });
    await app.runtime.idle();

    const commands = shellCommands(computers.calls);
    expect(commands.filter((c) => c.startsWith('set -e'))).toEqual(['set -e\nnpm config set token npm-secret-123\nsudo apt-get install -y jq']);
    expect(commands.indexOf('jq --version')).toBeGreaterThan(commands.findIndex((c) => c.startsWith('set -e')));
    expect(computers.images[ops.id]).toBe('teambot/computer-node:latest');
    const last = app.lifecycle.lastSetup(ops.id)!;
    expect(last.ok).toBe(true);
    expect(last.output).toContain('{{secret:NPM_TOKEN}}');
    expect(last.output).not.toContain('npm-secret-123');

    // A changed script runs again on the next tool call.
    app.store.updateAgent(ops.id, { setupScript: 'pip install requests' });
    models.script('test/ops', [callTool('shell', { command: 'python3 -V' }), say('ok')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops python?' });
    await app.runtime.idle();
    expect(shellCommands(computers.calls).filter((c) => c.startsWith('set -e'))).toHaveLength(2);
  });

  it('reports a failing script without blocking the agent', async () => {
    const { app, models, owner } = setup();
    const ops = addAgent(app, 'Ops');
    app.store.updateAgent(ops.id, { setupScript: 'exit 1' });
    models.script('test/ops', [callTool('shell', { command: 'ls' }), say('done')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops ls' });
    await app.runtime.idle();

    expect(app.lifecycle.lastSetup(ops.id)).toMatchObject({ ok: false, exitCode: 1 });
    expect(app.store.listEvents({ types: ['computer.setup_failed'] })).toHaveLength(1);
    expect(app.store.listRuns({ agentId: ops.id })[0].status).toBe('completed');
  });
});

describe('idle sleep', () => {
  it('stops idle computers, but not while work is open or someone is watching', async () => {
    const { app, models, owner, computers } = setup();
    const idle = addAgent(app, 'Idle');
    const busy = addAgent(app, 'Busy');
    const watched = addAgent(app, 'Watched');
    models.script('test/busy', [callTool('ask_for_approval', { action: 'Send the newsletter' })]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Busy send it' });
    await app.runtime.idle();
    app.lifecycle.viewerOpened(watched.id);

    const later = Date.now() + (app.cfg.computerIdleMinutes + 1) * 60_000;
    expect(await app.lifecycle.sweep(later)).toEqual([idle.id]);
    expect(computers.stopped).toEqual([idle.id]);
    expect(app.store.listEvents({ types: ['computer.slept'] })).toHaveLength(1);

    app.lifecycle.viewerClosed(watched.id);
    expect(await app.lifecycle.sweep(later + (app.cfg.computerIdleMinutes + 1) * 60_000)).toEqual([idle.id, watched.id]);
    void busy;
  });
});
