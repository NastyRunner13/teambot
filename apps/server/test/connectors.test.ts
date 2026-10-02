import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { DEFAULT_POLICY_YAML } from '../src/policy.js';
import { McpManager, connectorSecret, connectorTokenSecret } from '../src/tools/mcp.js';
import { addAgent, general, testApp } from './helpers.js';

async function serveNotes(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }
  const mcp = new McpServer({ name: 'notes', version: '1.0.0' });
  mcp.registerTool('add_note', { description: 'Add a note', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `Saved note: ${text}` }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcp.connect(transport);
  return transport.handleRequest(req, res, JSON.parse(raw));
}

/** A remote MCP server behind OAuth (discovery, dynamic client registration, PKCE, refresh), like Notion's or Linear's. */
async function fakeService() {
  const pat = { value: 'ghp_first-token-1234' };
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const stats = { registrations: 0, refreshes: 0 };
  const issue = () => {
    const tokens = { access_token: crypto.randomUUID(), refresh_token: crypto.randomUUID(), token_type: 'Bearer', expires_in: 3600 };
    access.add(tokens.access_token);
    refresh.add(tokens.refresh_token);
    return tokens;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp':
        return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
      case '/.well-known/oauth-authorization-server':
        return json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      case '/register':
        stats.registrations++;
        return json(201, { ...JSON.parse(raw), client_id: `client-${stats.registrations}` });
      case '/authorize': {
        // The person signs in and approves; the service sends the browser back with a code.
        const code = crypto.randomUUID();
        codes.set(code, { challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
        const back = new URL(url.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state')!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      case '/token': {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') === 'refresh_token') {
          if (!refresh.delete(form.get('refresh_token')!)) return json(400, { error: 'invalid_grant' });
          stats.refreshes++;
          return json(200, issue());
        }
        const grant = codes.get(form.get('code')!);
        codes.delete(form.get('code')!);
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!grant || grant.challenge !== challenge || grant.redirect !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
        return json(200, issue());
      }
      case '/pat': {
        // A server that takes a personal access token instead of OAuth, like GitHub's.
        if (req.headers.authorization !== `Bearer ${pat.value}`) {
          res.writeHead(401);
          return res.end();
        }
        return serveNotes(req, res, raw);
      }
      case '/mcp': {
        if (!access.has(req.headers.authorization?.replace(/^Bearer /, '') ?? '')) {
          res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
          return res.end();
        }
        return serveNotes(req, res, raw);
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    stats,
    pat,
    /** Access tokens expire; refresh tokens still work. */
    expireAccess: () => access.clear(),
    /** The person revoked TeamBot's access at the service. */
    revokeAll: () => (access.clear(), refresh.clear()),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

let current: App | null = null;
let service: Awaited<ReturnType<typeof fakeService>> | null = null;
afterEach(async () => {
  await current?.runtime.stop();
  await current?.mcp.stop();
  await service?.close();
  current = null;
  service = null;
});

describe('connectors', () => {
  it('sign in with OAuth, give agents the tools, refresh tokens, and ask for sign-in again when access is revoked', async () => {
    const t = testApp();
    current = t.app;
    const { app, models, owner } = t;
    app.runtime.start();
    service = await fakeService();
    const server = await buildServer(app);

    // Adding the connector starts a sign-in on the service, with the callback on the page's origin.
    const added = await server.inject({ method: 'POST', url: '/api/connectors', payload: { name: 'notes', url: `${service.base}/mcp`, origin: 'http://localhost:5173' } });
    expect(added.statusCode).toBe(200);
    const { authUrl, servers } = added.json();
    expect(authUrl.startsWith(`${service.base}/authorize?`)).toBe(true);
    expect(new URL(authUrl).searchParams.get('redirect_uri')).toBe('http://localhost:5173/api/connectors/callback');
    expect(servers).toEqual([expect.objectContaining({ name: 'notes', source: 'connector', connected: false, needsSignIn: true })]);

    // The browser signs in and comes back to the callback.
    const back = new URL((await fetch(authUrl, { redirect: 'manual' })).headers.get('location')!);
    const page = await server.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    expect(page.body).toContain('notes is connected');
    expect(app.mcp.status()).toEqual([expect.objectContaining({ name: 'notes', connected: true, tools: 1, needsSignIn: false })]);

    // Tokens are a reserved secret: stored encrypted, invisible to agents.
    expect(JSON.parse(app.vault.get(connectorSecret('notes'))!).tokens.access_token).toBeTruthy();
    expect(app.vault.agentNames()).toEqual([]);
    // A replayed callback does nothing.
    expect((await server.inject({ method: 'GET', url: `${back.pathname}${back.search}` })).body).toContain('expired');

    // After a restart the saved sign-in is used, with no new registration.
    const restarted = new McpManager('none.json', app.vault, app.store, app.bus, 'http://localhost:8787');
    await restarted.start();
    expect(restarted.status()).toEqual([expect.objectContaining({ name: 'notes', connected: true, tools: 1 })]);
    await restarted.stop();
    expect(service.stats.registrations).toBe(1);

    // An agent that has the connector uses its tools (allowed by policy here), and its output counts as outside content.
    const scribe = addAgent(app, 'Scribe');
    app.store.updateAgent(scribe.id, { mcpServers: ['notes'] });
    app.policy.update(DEFAULT_POLICY_YAML.replace('\nrules:\n', '\nrules:\n  - name: Notes are fine\n    tools: [mcp__notes__*]\n    action: allow\n\n'), owner.id);
    models.script('test/scribe', [callTool('mcp__notes__add_note', { text: 'ship it' }), say('Noted.'), callTool('mcp__notes__add_note', { text: 'again' }), say('Noted again.'), callTool('mcp__notes__add_note', { text: 'once more' }), say('Could not.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Scribe note "ship it"' });
    await app.runtime.idle();
    const results = () => app.store.listEvents({ types: ['tool.finished'] }).map((e) => String(e.data.preview));
    expect(results()[0]).toBe('Saved note: ship it');
    expect(JSON.stringify(models.requests.at(-1)!.messages)).toContain('<untrusted_content source=\\"mcp__notes__add_note\\">');

    // Access tokens expire: the SDK refreshes them and the call goes through.
    service.expireAccess();
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Scribe note "again"' });
    await app.runtime.idle();
    expect(results()[0]).toContain('Saved note: again');
    expect(service.stats.refreshes).toBe(1);

    // Access revoked at the service: the agent is told a human must sign in again, and Settings shows it.
    service.revokeAll();
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Scribe note "once more"' });
    await app.runtime.idle();
    expect(results()[0]).toContain('needs a human to sign in again');
    expect(app.mcp.status()).toEqual([expect.objectContaining({ name: 'notes', connected: false, needsSignIn: true })]);
    expect(app.store.listEvents({ types: ['connector.updated'] })[0].data.change).toBe('signed_out');

    // Signing in again from Settings reuses the registered client.
    const again = (await server.inject({ method: 'POST', url: '/api/connectors/notes/connect', payload: { origin: 'http://localhost:5173' } })).json();
    const back2 = new URL((await fetch(again.authUrl, { redirect: 'manual' })).headers.get('location')!);
    expect((await server.inject({ method: 'GET', url: `${back2.pathname}${back2.search}` })).body).toContain('notes is connected');
    expect(service.stats.registrations).toBe(1);

    // Removing it deletes the sign-in and takes it off agents.
    expect((await server.inject({ method: 'DELETE', url: '/api/connectors/notes' })).statusCode).toBe(200);
    expect(app.vault.get(connectorSecret('notes'))).toBeUndefined();
    expect(app.store.getAgent(scribe.id)!.mcpServers).toEqual([]);
    expect(app.mcp.status()).toEqual([]);
    await server.close();
  });

  it('connects with a pasted token, keeps it secret, and asks for a new one when it stops working', async () => {
    const t = testApp();
    current = t.app;
    const { app, models, owner } = t;
    app.runtime.start();
    service = await fakeService();
    const server = await buildServer(app);
    const add = (value: string) =>
      server.inject({ method: 'POST', url: '/api/connectors', payload: { name: 'hub', url: `${service!.base}/pat`, token: { header: 'Authorization', prefix: 'Bearer ', value } } });

    // A token that is too short is refused, and nothing is left behind.
    expect((await add('short')).json().error).toMatch(/whole token/);
    expect(app.mcp.connectors()).toEqual([]);

    const added = await add(service.pat.value);
    expect(added.json().authUrl).toBeUndefined();
    expect(added.json().servers).toEqual([expect.objectContaining({ name: 'hub', connected: true, tools: 1, usesToken: true, needsSignIn: false })]);
    expect((await server.inject({ method: 'GET', url: '/api/mcp-servers/hub/tools' })).json()).toEqual([{ name: 'add_note', description: 'Add a note' }]);
    // The token is a reserved secret of its own, so agents can't use it and tool output never shows it.
    expect(app.vault.get(connectorTokenSecret('hub'))).toBe(service.pat.value);
    expect(app.vault.agentNames()).toEqual([]);
    expect(app.vault.redact(`echo ${service.pat.value}`)).not.toContain(service.pat.value);

    // After a restart the saved token is used.
    const restarted = new McpManager('none.json', app.vault, app.store, app.bus, 'http://localhost:8787');
    await restarted.start();
    expect(restarted.status()).toEqual([expect.objectContaining({ name: 'hub', connected: true, usesToken: true })]);
    await restarted.stop();

    // The token is revoked at the service: the agent hears a human must step in, and the app asks for a new token.
    const scribe = addAgent(app, 'Scribe');
    app.store.updateAgent(scribe.id, { mcpServers: ['hub'] });
    app.policy.update(DEFAULT_POLICY_YAML.replace('\nrules:\n', '\nrules:\n  - name: Hub is fine\n    tools: [mcp__hub__*]\n    action: allow\n\n'), owner.id);
    service.pat.value = 'ghp_second-token-5678';
    models.script('test/scribe', [callTool('mcp__hub__add_note', { text: 'x' }), say('Could not.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Scribe note "x"' });
    await app.runtime.idle();
    expect(String(app.store.listEvents({ types: ['tool.finished'] })[0].data.preview)).toContain('needs a human to sign in again');
    expect(app.mcp.status()).toEqual([expect.objectContaining({ name: 'hub', connected: false, needsSignIn: true, error: expect.stringMatching(/new one/) })]);

    // A wrong token is reported as such; the right one reconnects.
    const put = (value: string) => server.inject({ method: 'PUT', url: '/api/connectors/hub/token', payload: { value } });
    expect((await put('ghp_wrong-token-0000')).json().servers).toEqual([expect.objectContaining({ connected: false, error: expect.stringMatching(/didn't accept the token/) })]);
    expect((await put(service.pat.value)).json().servers).toEqual([expect.objectContaining({ connected: true })]);

    // Removing it deletes the token too.
    await server.inject({ method: 'DELETE', url: '/api/connectors/hub' });
    expect(app.vault.get(connectorTokenSecret('hub'))).toBeUndefined();
    // OAuth connectors don't take tokens.
    await app.mcp.addConnector('notes', `${service.base}/mcp`);
    expect(() => app.mcp.setToken('notes', 'ghp_whatever-1234')).toThrow(/not with a token/);
    await server.close();
  });

  it('checks names and addresses, and explains failed sign-ins', async () => {
    const t = testApp();
    current = t.app;
    const server = await buildServer(t.app);
    const add = (payload: object) => server.inject({ method: 'POST', url: '/api/connectors', payload });

    expect((await add({ name: 'plain', url: 'http://example.com/mcp' })).json().error).toMatch(/https/);
    expect((await add({ name: 'Bad Name!', url: 'https://example.com/mcp' })).json().error).toMatch(/lower-case/);
    const unreachable = await add({ name: 'local', url: 'http://127.0.0.1:9/mcp' });
    expect(unreachable.json().servers).toEqual([expect.objectContaining({ name: 'local', connected: false, needsSignIn: false, error: expect.any(String) })]);
    expect((await add({ name: 'local', url: 'http://127.0.0.1:9/mcp' })).json().error).toMatch(/already/);

    const denied = await server.inject({ method: 'GET', url: '/api/connectors/callback?error=access_denied&error_description=%3Cb%3Enope%3C%2Fb%3E' });
    expect(denied.body).toContain('Sign-in was not completed');
    expect(denied.body).toContain('&#60;b&#62;nope');
    expect((await server.inject({ method: 'GET', url: '/api/connectors/callback?code=x&state=forged' })).body).toContain('Sign-in failed');
    await server.close();
  });
});
