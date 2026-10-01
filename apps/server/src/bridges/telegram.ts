// Telegram bridge: talk to your agents and answer approvals from your phone.
//   Out: approval requests (with buttons), agents' DMs to you, and messages that @mention you.
//   In:  reply to a forwarded message to continue that conversation (or thread); start with @Name to DM an agent;
//        anything else goes to the last conversation you used. Photos and files land in /shared/uploads/telegram.
// Only one chat is accepted: the one you pair with a short-lived code. The bot token is the reserved secret
// TEAMBOT_TELEGRAM_TOKEN, which agents can't see or use. Long polling, so no public URL is needed.
import type { Approval, EventRecord, Message, TelegramStatus } from '@teambot/shared';
import type { App } from '../app.js';
import { saveUpload } from '../shared-files.js';
import { errorMessage, sleep } from '../util.js';
import { HELP, Pairing, approvalChoices, approvalText, command, deliver, forwardable, outcomeText, resolveTarget } from './common.js';

export const TOKEN_SECRET = 'TEAMBOT_TELEGRAM_TOKEN';
const PLATFORM = 'telegram';
const MAX_TEXT = 4000;
const MAX_DOWNLOAD = 20 * 1024 * 1024;

/** One Telegram Bot API call. Swappable so tests don't need the network. */
export type TelegramApi = (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => Promise<any>;
export type TelegramDownload = (filePath: string) => Promise<Buffer>;

class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function httpApi(token: string): { api: TelegramApi; download: TelegramDownload } {
  const base = process.env.TELEGRAM_API_URL ?? 'https://api.telegram.org';
  return {
    async api(method, params = {}, signal) {
      const res = await fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string; error_code?: number };
      if (!data.ok) throw new TelegramError(data.description ?? `Telegram returned HTTP ${res.status}`, data.error_code ?? res.status);
      return data.result;
    },
    async download(filePath) {
      const res = await fetch(`${base}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`could not download the file (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class TelegramBridge {
  private api: TelegramApi | null = null;
  private download: TelegramDownload | null = null;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;
  private botUsername: string | null = null;
  private error: string | null = null;
  private pairing = new Pairing();

  constructor(
    private app: App,
    /** Tests pass a fake API; otherwise the stored token is used. */
    private override?: { api: TelegramApi; download?: TelegramDownload },
  ) {}

  private get chatId(): string | null {
    return this.app.store.getSetting('telegram_chat_id') || null;
  }

  status(): TelegramStatus {
    return {
      configured: !!this.override || !!this.app.vault.get(TOKEN_SECRET),
      running: !!this.loop,
      botUsername: this.botUsername,
      paired: !!this.chatId,
      pairing: this.pairing.current(),
      error: this.error,
    };
  }

  /** Start (or restart) with the stored token. Resolves once the token is checked. */
  async start(): Promise<TelegramStatus> {
    await this.stop();
    this.error = null;
    if (this.override) {
      this.api = this.override.api;
      this.download = this.override.download ?? null;
    } else {
      const token = this.app.vault.get(TOKEN_SECRET);
      if (!token) return this.status();
      ({ api: this.api, download: this.download } = httpApi(token));
    }
    try {
      const me = await this.api('getMe');
      this.botUsername = me?.username ?? null;
    } catch (err) {
      this.error = `Telegram rejected the bot token: ${errorMessage(err)}`;
      this.api = null;
      return this.status();
    }
    this.unsubscribe = this.app.bus.subscribe((e) => void this.onEvent(e).catch((err) => console.error('telegram notify failed', err)));
    if (!this.override) {
      this.controller = new AbortController();
      this.loop = this.poll(this.controller.signal).finally(() => (this.loop = null));
    }
    this.app.bus.emit('bridge.started', {}, { platform: PLATFORM, bot: this.botUsername });
    return this.status();
  }

  async stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.controller = null;
    this.loop = null;
  }

  /** A one-time code to send to the bot as "/start <code>". */
  startPairing(): TelegramStatus {
    this.pairing.start();
    return this.status();
  }

  unpair() {
    this.app.store.setSetting('telegram_chat_id', '');
    this.app.bus.emit('bridge.unpaired', {}, { platform: PLATFORM });
  }

  private async poll(signal: AbortSignal) {
    let offset = Number(this.app.store.getSetting('telegram_offset') ?? 0);
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = (await this.api!('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, signal)) as { update_id: number }[];
        for (const u of updates) {
          offset = u.update_id + 1;
          this.app.store.setSetting('telegram_offset', String(offset));
          await this.handleUpdate(u).catch((err) => console.error('telegram update failed', err));
        }
        this.error = null;
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) return;
        this.error = errorMessage(err);
        if (err instanceof TelegramError && err.code === 401) return; // the token was revoked
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  // ── out: TeamBot → Telegram ─────────────────────────────────────────────

  private async send(text: string, extra: Record<string, unknown> = {}): Promise<number | null> {
    const chatId = this.chatId;
    if (!this.api || !chatId) return null;
    const sent = await this.api('sendMessage', { chat_id: chatId, text: clip(text), link_preview_options: { is_disabled: true }, ...extra });
    return sent?.message_id ?? null;
  }

  private async onEvent(e: EventRecord) {
    if (!this.chatId) return;
    const d = e.data as Record<string, any>;
    if (e.type === 'approval.created') {
      const a = d.approval as Approval;
      const buttons = { inline_keyboard: [approvalChoices(a).map((c) => ({ text: c.label, callback_data: `apr:${a.id}:${c.decision}` }))] };
      const id = await this.send(approvalText(this.app, a), { reply_markup: buttons });
      if (id) this.app.store.linkBridge({ platform: PLATFORM, externalId: String(id), kind: 'approval', ref: a.id, channelId: a.channelId, threadId: null });
    } else if (e.type === 'approval.resolved') {
      const a = d.approval as Approval;
      for (const link of this.app.store.findBridgeLinks(PLATFORM, 'approval', a.id)) {
        await this.api!('editMessageText', { chat_id: this.chatId, message_id: Number(link.externalId), text: clip(`${approvalText(this.app, a)}\n\n${outcomeText(this.app, a)}`) }).catch(
          () => undefined,
        );
      }
    } else if (e.type === 'message.created') {
      const m = d.message as Message;
      const out = forwardable(this.app, m);
      if (!out) return;
      const id = await this.send(out.text);
      if (id) this.app.store.linkBridge({ platform: PLATFORM, externalId: String(id), kind: 'message', ref: m.id, channelId: m.channelId, threadId: m.threadId });
    }
  }

  // ── in: Telegram → TeamBot ──────────────────────────────────────────────

  async handleUpdate(u: any) {
    if (u.callback_query) return this.onButton(u.callback_query);
    const m = u.message;
    if (!m?.chat) return;
    const chatId = String(m.chat.id);
    const text: string = (m.text ?? m.caption ?? '').trim();

    if (/^\/start\b/.test(text)) {
      if (this.pairing.redeem(text.split(/\s+/)[1])) {
        this.app.store.setSetting('telegram_chat_id', chatId);
        this.app.bus.emit('bridge.paired', {}, { platform: PLATFORM });
        await this.reply(chatId, `Paired with TeamBot. ${HELP}`);
      } else if (chatId !== this.chatId) {
        await this.reply(chatId, 'To pair, open Settings → Telegram in TeamBot, click Pair, and send the code you get: /start 123456');
      } else {
        await this.reply(chatId, HELP);
      }
      return;
    }
    if (chatId !== this.chatId) return this.reply(chatId, 'This TeamBot is private. Pair this chat from Settings → Telegram in the app.');

    const answer = command(this.app, text);
    if (answer !== null) return this.reply(chatId, answer);

    const target = resolveTarget(this.app, PLATFORM, m.reply_to_message?.message_id ? String(m.reply_to_message.message_id) : undefined, text);
    if (!target) return this.reply(chatId, `Who is this for? ${HELP}`);
    try {
      const attachments = await this.saveFiles(m);
      if (!text && !attachments.length) return;
      deliver(this.app, PLATFORM, target, text, attachments);
      await this.api!('setMessageReaction', { chat_id: chatId, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => undefined);
    } catch (err) {
      await this.reply(chatId, `Couldn't deliver that: ${errorMessage(err)}`);
    }
  }

  private reply(chatId: string, text: string) {
    return this.api?.('sendMessage', { chat_id: chatId, text: clip(text) }).catch(() => undefined);
  }

  private async saveFiles(m: any): Promise<string[]> {
    const file = m.document ?? (Array.isArray(m.photo) ? m.photo.at(-1) : null);
    if (!file || !this.download) return [];
    if (file.file_size && file.file_size > MAX_DOWNLOAD) throw new Error('Telegram only lets bots download files up to 20 MB');
    const info = await this.api!('getFile', { file_id: file.file_id });
    const data = await this.download(info.file_path);
    const name = m.document?.file_name ?? `photo-${m.message_id}.jpg`;
    const saved = saveUpload(this.app.cfg.sharedDir, `uploads/telegram/${new Date().toISOString().slice(0, 10)}`, name, data);
    this.app.bus.emit('file.uploaded', { actorId: this.app.workspace.owner().id }, { file: saved, via: PLATFORM });
    return [saved.path];
  }

  private async onButton(q: any) {
    const chatId = String(q.message?.chat?.id ?? '');
    const answer = (text: string) => this.api!('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => undefined);
    if (chatId !== this.chatId) return answer('This chat is not paired.');
    const [kind, approvalId, decision] = String(q.data ?? '').split(':');
    if (kind !== 'apr' || !approvalId) return answer('Unknown button.');
    try {
      const a = this.app.runtime.resolveApproval(approvalId, decision as 'approve' | 'deny' | 'done' | 'decline', null, this.app.workspace.owner().id);
      await answer(a.status === 'approved' || a.status === 'done' ? 'Done ✅' : 'Noted');
    } catch (err) {
      await answer(errorMessage(err));
    }
  }
}
