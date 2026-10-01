import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.slack.stop();
  await current?.runtime.stop();
  current = null;
});

class FakeSlack {
  calls: { method: string; params: Record<string, any>; token?: string }[] = [];
  private ts = 1000;
  api = async (method: string, params: Record<string, any> = {}, token?: 'bot' | 'app') => {
    this.calls.push({ method, params, token });
    if (method === 'auth.test') return { ok: true, user: 'teambot', user_id: 'UBOT', team: 'Acme' };
    if (method === 'chat.postMessage') return { ok: true, ts: `${++this.ts}.0001`, channel: params.channel };
    return { ok: true };
  };
  download = async () => Buffer.from('a,b\n1,2\n');
  posted = () => this.calls.filter((c) => c.method === 'chat.postMessage');
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const dm = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'events_api', payload: { event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text, ts: `${Date.now()}.5`, ...extra } } });

async function setup() {
  const slack = new FakeSlack();
  const t = testApp({ slack: { api: slack.api, download: slack.download } });
  current = t.app;
  fs.mkdirSync(t.app.cfg.sharedDir, { recursive: true });
  t.app.runtime.start();
  await t.app.slack.start();
  const { pairing } = t.app.slack.startPairing();
  await t.app.slack.handleEnvelope(dm(`pair ${pairing!.code}`));
  return { ...t, slack };
}

describe('Slack bridge', () => {
  it('pairs one Slack user and turns everyone else away', async () => {
    const { app, slack } = await setup();
    expect(app.slack.status()).toMatchObject({ paired: true, botName: 'teambot', team: 'Acme' });
    expect(slack.posted().at(-1)!.params).toMatchObject({ channel: 'D1', text: expect.stringContaining('Paired with TeamBot') });

    addAgent(app, 'Writer');
    await app.slack.handleEnvelope({ type: 'events_api', payload: { event: { type: 'message', channel_type: 'im', channel: 'D9', user: 'U9', text: '@Writer go', ts: '1.1' } } });
    expect(slack.posted().at(-1)!.params.text).toContain('This TeamBot is private');
    expect(app.store.listRuns({})).toHaveLength(0);
    // Its own messages and edits are ignored.
    await app.slack.handleEnvelope(dm('@Writer go', { bot_id: 'B1' }));
    await app.slack.handleEnvelope(dm('@Writer go', { subtype: 'message_changed' }));
    expect(app.store.listRuns({})).toHaveLength(0);
  });

  it('sends approvals as buttons, and a button press answers them', async () => {
    const { app, models, owner, slack } = await setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('ask_for_approval', { action: 'Post the release notes to <the blog>' }), say('Posted.')]);
    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer publish' });
    await app.runtime.idle();
    await flush();

    const msg = slack.posted().at(-1)!;
    expect(msg.params.blocks[0].text.text).toContain('Post the release notes to &lt;the blog&gt;');
    const [approve] = msg.params.blocks[1].elements;
    expect(approve).toMatchObject({ action_id: 'apr_approve', style: 'primary' });

    await app.slack.handleEnvelope({ type: 'interactive', payload: { type: 'block_actions', user: { id: 'U1' }, actions: [approve], channel: { id: 'D1' }, message: { ts: '1001.0001' } } });
    await app.runtime.idle();
    await flush();
    expect(messagesIn(app, general(app).id).at(-1)!.text).toBe('Posted.');
    const update = slack.calls.find((c) => c.method === 'chat.update')!;
    expect(update.params.blocks).toHaveLength(1); // buttons removed
    expect(update.params.text).toContain('✅ Approved by Owner');
  });

  it('continues a conversation from a thread reply, and saves shared files', async () => {
    const { app, models, owner, slack } = await setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('Here is the outline.'), say('Using the numbers.')]);
    const conv = app.workspace.getOrCreateDm(owner.id, writer.id);
    app.workspace.postMessage({ channelId: conv.id, authorId: owner.id, text: 'Outline the report' });
    await app.runtime.idle();
    await flush();
    const forwarded = slack.posted().at(-1)!;
    expect(forwarded.params.text).toBe('🤖 Writer:\nHere is the outline.');

    await app.slack.handleEnvelope(
      dm('use these numbers &amp; keep it short', { thread_ts: '1002.0001', subtype: 'file_share', files: [{ name: 'numbers.csv', size: 8, url_private_download: 'https://files.slack.com/x' }] }),
    );
    await app.runtime.idle();
    const msgs = messagesIn(app, conv.id);
    expect(msgs.at(-2)!.text).toBe('use these numbers & keep it short');
    expect(msgs.at(-2)!.attachments[0].path).toMatch(/^\/shared\/uploads\/slack\/.+\/numbers\.csv$/);
    expect(msgs.at(-1)!.text).toBe('Using the numbers.');
    expect(slack.calls.some((c) => c.method === 'reactions.add')).toBe(true);
  });
});
