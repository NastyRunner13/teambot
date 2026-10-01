import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { hostAllowed } from '../src/egress.js';
import { callTool, say } from '../src/models/scripted.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
let target: http.Server | null = null;
afterEach(async () => {
  await current?.egress.stop();
  await current?.runtime.stop();
  await new Promise((r) => (target ? target.close(r) : r(null)));
  current = null;
  target = null;
});

/** A site to reach through the proxy. */
async function site(): Promise<number> {
  target = http.createServer((req, res) => res.end(`hello from ${req.url}`));
  await new Promise<void>((r) => target!.listen(0, '127.0.0.1', () => r()));
  return (target!.address() as AddressInfo).port;
}

function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(proxyPort: number, hostPort: string): Promise<{ status: number; reply?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: hostPort });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({ status: res.statusCode ?? 0 });
      }
      socket.write(`GET /tunnelled HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
      let reply = '';
      socket.on('data', (c) => (reply += c));
      socket.on('end', () => resolve({ status: 200, reply }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('egress allowlists', () => {
  it('matches domains and their subdomains', () => {
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com.evil.io', ['github.com'])).toBe(false);
    expect(hostAllowed('notgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('docs.example.com', ['*.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['https://example.com/path'])).toBe(true);
  });

  it('lets allowed sites through (HTTP and CONNECT) and blocks the rest, with live edits', async () => {
    const t = testApp();
    current = t.app;
    const app = t.app;
    const port = await site();
    const agent = addAgent(app, 'Scout');
    app.store.updateAgent(agent.id, { network: { mode: 'allowlist', allow: ['127.0.0.1'] } });
    const proxyPort = await app.egress.portFor(app.store.getAgent(agent.id)!);
    expect(proxyPort).toBeGreaterThanOrEqual(19400);

    expect(await viaProxy(proxyPort, `http://127.0.0.1:${port}/page`)).toEqual({ status: 200, body: 'hello from /page' });
    expect((await connect(proxyPort, `127.0.0.1:${port}`)).reply).toContain('hello from /tunnelled');

    const denied = await viaProxy(proxyPort, 'http://example.com/');
    expect(denied.status).toBe(403);
    expect(denied.body).toContain("example.com is not on this agent's allowlist");
    expect((await connect(proxyPort, 'example.com:443')).status).toBe(403);
    expect(app.store.listEvents({ types: ['egress.blocked'] }).map((e) => e.data.host)).toEqual(['example.com']); // logged once a minute

    // Edits apply to the next connection.
    app.store.updateAgent(agent.id, { network: { mode: 'allowlist', allow: [] } });
    expect((await viaProxy(proxyPort, `http://127.0.0.1:${port}/again`)).status).toBe(403);
    // The port is remembered for next time.
    await app.egress.close(agent.id);
    expect(await app.egress.portFor(app.store.getAgent(agent.id)!)).toBe(proxyPort);
  });

  it("puts restricted agents' computers behind their proxy", async () => {
    const t = testApp();
    current = t.app;
    const { app, models, owner, computers } = t;
    app.runtime.start();
    const open = addAgent(app, 'Open');
    const closed = addAgent(app, 'Closed');
    app.store.updateAgent(closed.id, { network: { mode: 'allowlist', allow: ['github.com'] } });
    models.script('test/open', [callTool('shell', { command: 'ls' }), say('ok')]);
    models.script('test/closed', [callTool('shell', { command: 'ls' }), say('ok')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Open @Closed list files' });
    await app.runtime.idle();

    expect(computers.networks[open.id]).toBeNull();
    expect(computers.networks[closed.id]).toEqual({ proxyHost: 'host.docker.internal', proxyPort: expect.any(Number) });
  });

  it('validates allowlists in the API and starts the proxy when one is set', async () => {
    const t = testApp();
    current = t.app;
    const server = await buildServer(t.app);
    const a = (await server.inject({ method: 'POST', url: '/api/agents', payload: { name: 'Scout' } })).json();
    const bad = await server.inject({ method: 'PATCH', url: `/api/agents/${a.id}`, payload: { network: { mode: 'allowlist', allow: ['not a domain!'] } } });
    expect(bad.statusCode).toBe(400);
    const ok = await server.inject({ method: 'PATCH', url: `/api/agents/${a.id}`, payload: { network: { mode: 'allowlist', allow: ['https://GitHub.com/org', '*.npmjs.org'] } } });
    expect(ok.json().network).toEqual({ mode: 'allowlist', allow: ['github.com', '*.npmjs.org'] });
    expect(t.app.store.getSetting(`egress_port:${a.id}`)).toMatch(/^194\d\d$/);
    await server.close();
  });
});
