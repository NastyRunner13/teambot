import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { callTool, say } from '../src/models/scripted.js';
import type { TranscriptMessage } from '../src/models/types.js';
import { addAgent, general, messagesIn, testApp } from './helpers.js';

let current: App | null = null;
afterEach(async () => {
  await current?.telegram.stop();
  await current?.runtime.stop();
  current = null;
});

/** Records Bot API calls and answers like Telegram would. */
class FakeTelegram {
  calls: { method: string; params: Record<string, any> }[] = [];
  private nextId = 100;
  api = async (method: string, params: Record<string, any> = {}) => {
    this.calls.push({ method, params });
    if (method === 'getMe') return { username: 'team_bot' };
    if (method === 'sendMessage') return { message_id: this.nextId++ };
    if (method === 'getFile') return { file_path: 'documents/file_1.pdf' };
    return true;
  };
  download = async () => Buffer.from('%PDF-1.4 fake');
  sent = (chatId = '42') => this.calls.filter((c) => c.method === 'sendMessage' && String(c.params.chat_id) === chatId);
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const ME = { id: 42, type: 'private' };

async function setup() {
  const tg = new FakeTelegram();
  const t = testApp({ telegram: { api: tg.api, download: tg.download } });
  current = t.app;
  fs.mkdirSync(t.app.cfg.sharedDir, { recursive: true });
  t.app.runtime.start();
  await t.app.telegram.start();
  // Pair chat 42.
  const { pairing } = t.app.telegram.startPairing();
  await t.app.telegram.handleUpdate({ update_id: 1, message: { message_id: 1, chat: ME, text: `/start ${pairing!.code}` } });
  return { ...t, tg };
}

describe('Telegram bridge', () => {
  it('pairs one chat with a one-time code and ignores everyone else', async () => {
    const { app, tg } = await setup();
    expect(app.telegram.status()).toMatchObject({ paired: true, botUsername: 'team_bot', pairing: null });
    expect(tg.sent().at(-1)!.params.text).toContain('Paired with TeamBot');

    addAgent(app, 'Writer');
    await app.telegram.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: 666 }, text: '@Writer delete everything' } });
    expect(tg.sent('666').at(-1)!.params.text).toContain('This TeamBot is private');
    expect(app.store.listRuns({})).toHaveLength(0);

    // A stale or wrong code doesn't pair another chat.
    await app.telegram.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: 777 }, text: '/start 000000' } });
    expect(app.store.getSetting('telegram_chat_id')).toBe('42');
  });

  it('sends approvals with buttons, and a tap answers them', async () => {
    const { app, models, owner, tg } = await setup();
    addAgent(app, 'Writer');
    models.script('test/writer', [callTool('ask_for_approval', { action: 'Email the newsletter to 2,000 subscribers', details: 'Subject: October update' }), say('Sent!')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Writer send the newsletter' });
    await app.runtime.idle();
    await flush();

    const request = tg.sent().at(-1)!;
    expect(request.params.text).toContain('Writer asks for approval:\nEmail the newsletter to 2,000 subscribers');
    expect(request.params.text).toContain('Subject: October update');
    const [approve] = request.params.reply_markup.inline_keyboard[0];
    expect(approve.text).toBe('✅ Approve');

    await app.telegram.handleUpdate({ update_id: 5, callback_query: { id: 'cb1', data: approve.callback_data, message: { message_id: 100, chat: ME } } });
    await app.runtime.idle();
    await flush();

    expect(app.store.listApprovals({ status: 'approved' })).toHaveLength(1);
    expect(messagesIn(app, general(app).id).at(-1)!.text).toBe('Sent!');
    const edit = tg.calls.find((c) => c.method === 'editMessageText')!;
    expect(edit.params.text).toContain('✅ Approved by Owner');
  });

  it('forwards agent DMs, and a reply continues the same conversation', async () => {
    const { app, models, owner, tg } = await setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('Draft is ready: /shared/post.md'), say('Shortened it.')]);
    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);

    app.workspace.postMessage({ channelId: dm.id, authorId: owner.id, text: 'Write the launch post' });
    await app.runtime.idle();
    await flush();
    const forwarded = tg.sent().at(-1)!;
    expect(forwarded.params.text).toBe('🤖 Writer:\nDraft is ready: /shared/post.md');

    await app.telegram.handleUpdate({ update_id: 6, message: { message_id: 7, chat: ME, text: 'Make it shorter', reply_to_message: { message_id: 101 } } });
    await app.runtime.idle();

    expect(messagesIn(app, dm.id).map((m) => m.text)).toEqual(['Write the launch post', 'Draft is ready: /shared/post.md', 'Make it shorter', 'Shortened it.']);
    expect(tg.calls.some((c) => c.method === 'setMessageReaction')).toBe(true);
    // Owner messages are not echoed back to Telegram.
    expect(tg.sent().filter((c) => c.params.text.includes('Make it shorter'))).toHaveLength(0);
  });

  it('routes @Name messages and saves files into /shared', async () => {
    const { app, models, owner, tg } = await setup();
    const writer = addAgent(app, 'Writer');
    models.script('test/writer', [say('Got the contract.')]);

    await app.telegram.handleUpdate({
      update_id: 8,
      message: { message_id: 9, chat: ME, caption: '@Writer summarize this', document: { file_id: 'f1', file_name: 'contract.pdf', file_size: 13 } },
    });
    await app.runtime.idle();

    const dm = app.workspace.getOrCreateDm(owner.id, writer.id);
    const [msg] = messagesIn(app, dm.id);
    expect(msg.attachments[0].path).toMatch(/^\/shared\/uploads\/telegram\/\d{4}-\d{2}-\d{2}\/contract\.pdf$/);
    expect(fs.readFileSync(path.join(app.cfg.sharedDir, msg.attachments[0].path.replace('/shared/', '')), 'utf8')).toBe('%PDF-1.4 fake');
    expect(JSON.stringify(models.requests[0].messages)).toContain('contract.pdf');

    // With no reply and no @Name, the last conversation is used.
    await app.telegram.handleUpdate({ update_id: 9, message: { message_id: 10, chat: ME, text: 'thanks' } });
    expect(messagesIn(app, dm.id).at(-1)!.text).toBe('thanks');
    void tg;
  });

  it("keeps the bot token away from agents", async () => {
    const { app, models, owner } = await setup();
    app.vault.set('TEAMBOT_TELEGRAM_TOKEN', '123456:abcdefghijklmnopqrstuvwxyz');
    app.vault.set('GITHUB_TOKEN', 'ghp_12345678');
    const ops = addAgent(app, 'Ops');
    models.script('test/ops', [callTool('shell', { command: 'curl -H "x: {{secret:TEAMBOT_TELEGRAM_TOKEN}}" x' }), say('ok')]);

    app.workspace.postMessage({ channelId: general(app).id, authorId: owner.id, text: '@Ops try it' });
    await app.runtime.idle();

    const prompt = String(models.requests[0].messages[0].content);
    expect(prompt).toContain('Available secrets: GITHUB_TOKEN.');
    expect(prompt).not.toContain('TEAMBOT_TELEGRAM_TOKEN');
    const result = app.store.getTranscript<TranscriptMessage>(app.store.listRuns({ agentId: ops.id })[0].id).find((m) => m.role === 'tool')!.content;
    expect(result).toContain('Unknown secret "TEAMBOT_TELEGRAM_TOKEN". Available: GITHUB_TOKEN');
  });
});
