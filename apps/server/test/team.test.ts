import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api.js';
import type { App } from '../src/app.js';
import { hashPassword, verifyPassword } from '../src/auth.js';
import { addAgent, general, testApp } from './helpers.js';

let current: App | null = null;
let server: FastifyInstance | null = null;
afterEach(async () => {
  await server?.close();
  await current?.runtime.stop();
  current = null;
  server = null;
});

async function setup() {
  const t = testApp();
  current = t.app;
  server = await buildServer(t.app);
  return { ...t, server };
}

/** A tiny cookie jar per person. */
function person(srv: FastifyInstance) {
  let session = '';
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => {
    const res = await srv.inject({ method, url, payload, headers: { ...(session ? { cookie: `teambot_session=${session}` } : {}), ...headers } });
    const set = res.headers['set-cookie'];
    const value = String(Array.isArray(set) ? set[0] : (set ?? '')).match(/^teambot_session=([^;]*)/)?.[1];
    if (value !== undefined) session = value;
    return res;
  };
  return { call, signedIn: () => !!session };
}

describe('team mode', () => {
  it('stores passwords as salted scrypt hashes', () => {
    const a = hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(hashPassword('correct horse battery'));
    expect(verifyPassword('correct horse battery', a)).toBe(true);
    expect(verifyPassword('wrong horse battery', a)).toBe(false);
    expect(verifyPassword('anything', undefined)).toBe(false);
  });

  it('is off by default: no sign-in, everything is the owner’s', async () => {
    const { server, owner } = await setup();
    const boot = await server.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(boot.statusCode).toBe(200);
    expect(boot.json()).toMatchObject({ teamMode: false, me: { id: owner.id, role: 'owner' } });
    expect((await server.inject({ method: 'GET', url: '/api/auth' })).json()).toMatchObject({ teamMode: false, me: { id: owner.id } });
  });

  it('lets the owner turn on sign-in, invite a teammate, and keeps each person’s actions and DMs their own', async () => {
    const { app, server, owner } = await setup();
    const writer = addAgent(app, 'Writer');
    const alice = person(server);

    // Turning it on needs a real password and signs the owner in.
    expect((await alice.call('POST', '/api/team/enable', { password: 'short' })).json().error).toMatch(/at least 10/);
    expect((await alice.call('POST', '/api/team/enable', { password: 'owner password 1' })).statusCode).toBe(200);
    expect(alice.signedIn()).toBe(true);
    expect(app.auth.teamMode).toBe(true);

    // From now on, nobody else gets in without signing in, including the live event stream.
    const stranger = person(server);
    expect((await stranger.call('GET', '/api/bootstrap')).statusCode).toBe(401);
    expect((await stranger.call('POST', '/api/team/enable', { password: 'take over please' })).statusCode).toBe(401);
    expect((await stranger.call('GET', '/api/auth')).json()).toEqual({ teamMode: true, me: null });
    expect((await stranger.call('POST', '/api/auth/sign-in', { name: owner.name, password: 'wrong password!' })).statusCode).toBe(401);

    // An invite link works once.
    const { token } = (await alice.call('POST', '/api/team/invites', {})).json();
    expect((await stranger.call('GET', `/api/auth/invites/${token}`)).json()).toMatchObject({ invitedBy: owner.name, role: 'member' });
    const bob = person(server);
    expect((await bob.call('POST', '/api/auth/join', { token, name: 'Writer', password: 'bob password 1' })).json().error).toMatch(/taken/);
    const joined = await bob.call('POST', '/api/auth/join', { token, name: 'Bob', password: 'bob password 1' });
    expect(joined.json().me).toMatchObject({ name: 'Bob', role: 'member' });
    expect((await stranger.call('POST', '/api/auth/join', { token, name: 'Eve', password: 'eve password 1' })).statusCode).toBe(404);
    const bobId = joined.json().me.id as string;
    expect(general(app).memberIds).toContain(bobId);

    // Each person's actions are attributed to them.
    const msg = (await bob.call('POST', `/api/channels/${general(app).id}/messages`, { text: 'hello team' })).json();
    expect(msg.authorId).toBe(bobId);
    expect((await bob.call('GET', '/api/bootstrap')).json().me.id).toBe(bobId);

    // A DM between Alice and an agent is private to Alice.
    const dm = (await alice.call('POST', '/api/dms', { memberId: writer.id })).json();
    await alice.call('POST', `/api/channels/${dm.id}/messages`, { text: 'secret plan for the launch' });
    expect((await bob.call('GET', '/api/bootstrap')).json().channels.map((c: { id: string }) => c.id)).not.toContain(dm.id);
    expect((await bob.call('GET', `/api/channels/${dm.id}/messages`)).statusCode).toBe(404);
    expect((await bob.call('POST', `/api/channels/${dm.id}/messages`, { text: 'let me in' })).statusCode).toBe(404);
    expect((await bob.call('GET', '/api/search?q=secret')).json().messages).toEqual([]);
    expect((await alice.call('GET', '/api/search?q=secret')).json().messages).toHaveLength(1);
    expect((await bob.call('GET', '/api/events?types=message.created')).json().map((e: { channelId: string }) => e.channelId)).not.toContain(dm.id);

    // Members can work but not change workspace settings.
    expect((await bob.call('PUT', '/api/secrets/GITHUB_TOKEN', { value: 'x' })).statusCode).toBe(403);
    expect((await bob.call('PUT', '/api/policy', { yaml: 'rules: []' })).statusCode).toBe(403);
    expect((await bob.call('POST', '/api/team/invites', {})).statusCode).toBe(403);
    expect((await bob.call('POST', '/api/system/pause')).statusCode).toBe(200);

    // Changes that a browser says came from another site are refused.
    expect((await alice.call('POST', '/api/system/resume', {}, { origin: 'https://evil.example', host: 'localhost:8787' })).statusCode).toBe(403);
    expect((await alice.call('POST', '/api/system/resume', {}, { origin: 'http://localhost:8787', host: 'localhost:8787' })).statusCode).toBe(200);

    // Changing a password signs other devices out; removing a member signs them out everywhere.
    const bobPhone = person(server);
    await bobPhone.call('POST', '/api/auth/sign-in', { name: 'bob', password: 'bob password 1' });
    expect((await bobPhone.call('GET', '/api/bootstrap')).statusCode).toBe(200);
    expect((await bob.call('POST', '/api/auth/password', { current: 'bob password 1', next: 'bob password 2' })).statusCode).toBe(200);
    expect((await bobPhone.call('GET', '/api/bootstrap')).statusCode).toBe(401);
    expect((await bob.call('GET', '/api/bootstrap')).statusCode).toBe(200);
    expect((await alice.call('DELETE', `/api/team/members/${owner.id}`)).statusCode).toBe(400);
    expect((await alice.call('DELETE', `/api/team/members/${bobId}`)).statusCode).toBe(200);
    expect((await bob.call('GET', '/api/bootstrap')).statusCode).toBe(401);
    expect((await bob.call('POST', '/api/auth/sign-in', { name: 'Bob', password: 'bob password 2' })).statusCode).toBe(401);
    expect(app.store.getHuman(bobId)).toMatchObject({ name: 'Bob', removed: true });
    expect(general(app).memberIds).not.toContain(bobId);

    // Turning it off goes back to a personal workspace.
    await alice.call('POST', '/api/team/disable');
    expect((await stranger.call('GET', '/api/bootstrap')).json()).toMatchObject({ teamMode: false, me: { id: owner.id } });
  });

  it('slows down password guessing', async () => {
    const { app, server, owner } = await setup();
    const alice = person(server);
    await alice.call('POST', '/api/team/enable', { password: 'owner password 1' });
    const guesser = person(server);
    const tries = [];
    for (let i = 0; i < 9; i++) tries.push((await guesser.call('POST', '/api/auth/sign-in', { name: owner.name, password: `guess number ${i}` })).statusCode);
    expect(tries).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 429]);
    // Even the right password waits out the pause.
    expect((await guesser.call('POST', '/api/auth/sign-in', { name: owner.name, password: 'owner password 1' })).statusCode).toBe(429);
    void app;
  });
});
