// Slack bridge, in your DMs with a TeamBot Slack app: approvals with buttons, agents' DMs to you and messages
// that @mention you; reply in a message's thread to answer in that conversation, start with @Name to message
// an agent. Socket Mode over a WebSocket, so no public URL is needed. Only the Slack user who paired with a
// code is accepted. Tokens are reserved secrets agents can't see or use.
import type { Approval, EventRecord, Message, SlackStatus } from '@teambot/shared';
import type { App } from '../app.js';
import { saveUpload } from '../shared-files.js';
import { errorMessage, sleep } from '../util.js';
import { MAX_QUEUED_EVENTS } from '../runtime/cron.js';
import { HELP, Pairing, approvalChoices, approvalText, command, deliver, forwardable, outcomeText, resolveTarget } from './common.js';

export const BOT_TOKEN = 'TEAMBOT_SLACK_BOT_TOKEN';
export const APP_TOKEN = 'TEAMBOT_SLACK_APP_TOKEN';
const PLATFORM = 'slack';
const MAX_TEXT = 3500;
const MAX_DOWNLOAD = 25 * 1024 * 1024;

/** The Slack app to create, pasted into "Create an app → From a manifest". */
export const SLACK_MANIFEST = `display_information:
  name: TeamBot
  description: Talk to your TeamBot agents and answer their approvals
features:
  bot_user:
    display_name: TeamBot
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot: [chat:write, im:history, im:read, im:write, files:read, reactions:write, channels:history, groups:history, users:read]
settings:
  event_subscriptions:
    bot_events: [message.im, message.channels, message.groups]
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
`;

/** One Slack Web API call with the bot (default) or app-level token. Swappable for tests. */
export type SlackApi = (method: string, params?: Record<string, unknown>, token?: 'bot' | 'app') => Promise<any>;
export type SlackDownload = (url: string) => Promise<Buffer>;

function httpApi(bot: string, app: string): { api: SlackApi; download: SlackDownload } {
  const base = process.env.SLACK_API_URL ?? 'https://slack.com/api';
  return {
    async api(method, params = {}, token = 'bot') {
      const res = await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token === 'app' ? app : bot}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(30_000),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error ?? `HTTP ${res.status}`}`);
      return data;
    },
    async download(url) {
      const res = await fetch(url, { headers: { authorization: `Bearer ${bot}` }, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`could not download the file (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Slack escapes &, < and > in message text, and wraps links and mentions in <…>. */
const fromSlack = (s: string) =>
  s
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const toSlack = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class SlackBridge {
  private api: SlackApi | null = null;
  private download: SlackDownload | null = null;
  private socket: WebSocket | null = null;
  private stopped = true;
  private unsubscribe: (() => void) | null = null;
  private botName: string | null = null;
  private botUserId: string | null = null;
  private team: string | null = null;
  private error: string | null = null;
  private connected = false;
  private pairing = new Pairing();

  constructor(
    private app: App,
    /** Tests pass a fake API and drive envelopes by hand; otherwise the stored tokens are used. */
    private override?: { api: SlackApi; download?: SlackDownload },
  ) {}

  private get userId(): string | null {
    return this.app.store.getSetting('slack_user_id') || null;
  }
  private get dmChannel(): string | null {
    return this.app.store.getSetting('slack_dm_channel') || null;
  }

  status(): SlackStatus {
    return {
      configured: !!this.override || (!!this.app.vault.get(BOT_TOKEN) && !!this.app.vault.get(APP_TOKEN)),
      running: this.connected,
      botName: this.botName,
      team: this.team,
      paired: !!this.userId,
      pairing: this.pairing.current(),
      error: this.error,
    };
  }

  async start(): Promise<SlackStatus> {
    await this.stop();
    this.error = null;
    if (this.override) {
      this.api = this.override.api;
      this.download = this.override.download ?? null;
    } else {
      const bot = this.app.vault.get(BOT_TOKEN);
      const appToken = this.app.vault.get(APP_TOKEN);
      if (!bot || !appToken) return this.status();
      ({ api: this.api, download: this.download } = httpApi(bot, appToken));
    }
    try {
      const me = await this.api('auth.test');
      this.botName = me.user ?? null;
      this.botUserId = me.user_id ?? null;
      this.team = me.team ?? null;
    } catch (err) {
      this.error = `Slack rejected the bot token: ${errorMessage(err)}`;
      this.api = null;
      return this.status();
    }
    this.stopped = false;
    this.unsubscribe = this.app.bus.subscribe((e) => void this.onEvent(e).catch((err) => console.error('slack notify failed', err)));
    if (this.override) this.connected = true;
    else await this.connect();
    this.app.bus.emit('bridge.started', {}, { platform: PLATFORM, bot: this.botName });
    return this.status();
  }

  async stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.socket?.close();
    this.socket = null;
    this.connected = false;
  }

  startPairing(): SlackStatus {
    this.pairing.start();
    return this.status();
  }

  unpair() {
    this.app.store.setSetting('slack_user_id', '');
    this.app.store.setSetting('slack_dm_channel', '');
    this.app.bus.emit('bridge.unpaired', {}, { platform: PLATFORM });
  }

  /** Socket Mode: ask for a WebSocket URL with the app token, then keep the socket open, reconnecting with backoff. */
  private async connect(attempt = 0) {
    if (this.stopped || !this.api) return;
    try {
      const { url } = await this.api('apps.connections.open', {}, 'app');
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        this.connected = true;
        this.error = null;
      };
      socket.onmessage = (ev) => void this.onSocket(socket, String(ev.data)).catch((err) => console.error('slack event failed', err));
      socket.onclose = () => {
        this.connected = false;
        if (!this.stopped && this.socket === socket) void sleep(Math.min(1000 * 2 ** attempt, 60_000)).then(() => this.connect(attempt + 1));
      };
    } catch (err) {
      this.error = errorMessage(err);
      if (!this.stopped) void sleep(Math.min(1000 * 2 ** attempt, 60_000)).then(() => this.connect(attempt + 1));
    }
  }

  private async onSocket(socket: WebSocket, raw: string) {
    const envelope = JSON.parse(raw) as { type: string; envelope_id?: string; payload?: any };
    if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); // ack within 3 s
    if (envelope.type === 'disconnect') socket.close(); // Slack asks us to reconnect
    else await this.handleEnvelope(envelope);
  }

  // ── out: TeamBot → Slack ────────────────────────────────────────────────

  private async post(text: string, blocks?: unknown[]): Promise<string | null> {
    const channel = this.dmChannel;
    if (!this.api || !channel) return null;
    const res = await this.api('chat.postMessage', { channel, text: clip(text), ...(blocks ? { blocks } : {}), unfurl_links: false });
    return res?.ts ?? null;
  }

  private approvalBlocks(a: Approval, resolved?: string) {
    const section = { type: 'section', text: { type: 'mrkdwn', text: clip(toSlack(approvalText(this.app, a) + (resolved ? `\n\n${resolved}` : ''))) } };
    if (resolved) return [section];
    return [
      section,
      {
        type: 'actions',
        elements: approvalChoices(a).map((c) => ({
          type: 'button',
          text: { type: 'plain_text', text: c.label, emoji: true },
          action_id: `apr_${c.decision}`,
          value: a.id,
          ...(c.decision === 'approve' || c.decision === 'done' ? { style: 'primary' } : c.decision === 'deny' ? { style: 'danger' } : {}),
        })),
      },
    ];
  }

  private async onEvent(e: EventRecord) {
    if (!this.dmChannel) return;
    const d = e.data as Record<string, any>;
    if (e.type === 'approval.created') {
      const a = d.approval as Approval;
      const ts = await this.post(approvalText(this.app, a), this.approvalBlocks(a));
      if (ts) this.app.store.linkBridge({ platform: PLATFORM, externalId: ts, kind: 'approval', ref: a.id, channelId: a.channelId, threadId: null });
    } else if (e.type === 'approval.resolved') {
      const a = d.approval as Approval;
      for (const link of this.app.store.findBridgeLinks(PLATFORM, 'approval', a.id)) {
        const outcome = outcomeText(this.app, a);
        await this.api!('chat.update', { channel: this.dmChannel, ts: link.externalId, text: clip(`${approvalText(this.app, a)}\n\n${outcome}`), blocks: this.approvalBlocks(a, outcome) }).catch(
          () => undefined,
        );
      }
    } else if (e.type === 'message.created') {
      const m = d.message as Message;
      const out = forwardable(this.app, m);
      if (!out) return;
      const ts = await this.post(toSlack(out.text));
      if (ts) this.app.store.linkBridge({ platform: PLATFORM, externalId: ts, kind: 'message', ref: m.id, channelId: m.channelId, threadId: m.threadId });
    }
  }

  // ── in: Slack → TeamBot ─────────────────────────────────────────────────

  async handleEnvelope(envelope: { type: string; payload?: any }) {
    if (envelope.type === 'events_api') return this.onMessage(envelope.payload?.event);
    if (envelope.type === 'interactive' && envelope.payload?.type === 'block_actions') return this.onButton(envelope.payload);
  }

  private reply(channel: string, text: string, threadTs?: string) {
    return this.api?.('chat.postMessage', { channel, text: clip(toSlack(text)), ...(threadTs ? { thread_ts: threadTs } : {}) }).catch(() => undefined);
  }

  private names = new Map<string, string>();

  /** A Slack user's display name (users:read), cached; falls back to the ID. */
  private async userName(id: string): Promise<string> {
    if (!this.names.has(id)) {
      const res = await this.api?.('users.info', { user: id }).catch(() => null);
      this.names.set(id, res?.user?.profile?.display_name || res?.user?.real_name || res?.user?.name || id);
    }
    return this.names.get(id)!;
  }

  /** A message in a channel the bot is in: start the routines watching that channel. */
  private async onChannelMessage(event: any) {
    const routines = this.app.store.listSchedules().filter((s) => s.enabled && s.trigger === 'slack' && s.config.channel === event.channel);
    if (!routines.length) return;
    const who = event.user ? await this.userName(event.user) : 'someone';
    const text = fromSlack(String(event.text ?? '')).trim();
    for (const s of routines) {
      if (this.app.cron.queuedEvents(s) >= MAX_QUEUED_EVENTS) continue;
      this.app.cron.fire(s.id, { source: 'slack', via: 'a Slack message', body: `${who} wrote in Slack channel ${event.channel}${event.thread_ts ? ' (in a thread)' : ''}:\n${text}` });
    }
  }

  private async onMessage(event: any) {
    if (!event || event.type !== 'message') return;
    if (event.bot_id || event.user === this.botUserId || (event.subtype && event.subtype !== 'file_share')) return; // ours, or edits/joins
    if (event.channel_type === 'channel' || event.channel_type === 'group') return this.onChannelMessage(event);
    if (event.channel_type !== 'im') return;
    const text = fromSlack(String(event.text ?? '')).trim();
    const pair = text.match(/^pair\s+(\d{6})$/i);
    if (pair) {
      if (this.pairing.redeem(pair[1])) {
        this.app.store.setSetting('slack_user_id', event.user);
        this.app.store.setSetting('slack_dm_channel', event.channel);
        this.app.bus.emit('bridge.paired', {}, { platform: PLATFORM });
        return this.reply(event.channel, `Paired with TeamBot. ${HELP}`);
      }
      return this.reply(event.channel, 'That code is wrong or has expired. Get a new one from Settings → Slack in TeamBot.');
    }
    if (event.user !== this.userId) return this.reply(event.channel, 'This TeamBot is private. To pair, click Pair in Settings → Slack in the app and send me: pair 123456');

    const answer = command(this.app, text);
    if (answer !== null) return this.reply(event.channel, answer, event.thread_ts);

    const target = resolveTarget(this.app, PLATFORM, event.thread_ts, text);
    if (!target) return this.reply(event.channel, `Who is this for? ${HELP}`);
    try {
      const attachments = await this.saveFiles(event.files);
      if (!text && !attachments.length) return;
      deliver(this.app, PLATFORM, target, text, attachments);
      await this.api!('reactions.add', { channel: event.channel, timestamp: event.ts, name: 'thumbsup' }).catch(() => undefined);
    } catch (err) {
      await this.reply(event.channel, `Couldn't deliver that: ${errorMessage(err)}`, event.thread_ts);
    }
  }

  private async saveFiles(files: any[] | undefined): Promise<string[]> {
    if (!files?.length || !this.download) return [];
    const saved: string[] = [];
    for (const f of files.slice(0, 10)) {
      if (!f.url_private_download) continue;
      if (f.size > MAX_DOWNLOAD) throw new Error(`${f.name} is larger than 25 MB`);
      const data = await this.download(f.url_private_download);
      const file = saveUpload(this.app.cfg.sharedDir, `uploads/slack/${new Date().toISOString().slice(0, 10)}`, f.name ?? 'file', data);
      this.app.bus.emit('file.uploaded', { actorId: this.app.workspace.owner().id }, { file, via: PLATFORM });
      saved.push(file.path);
    }
    return saved;
  }

  private async onButton(payload: any) {
    if (payload.user?.id !== this.userId) return;
    const action = payload.actions?.[0];
    const decision = String(action?.action_id ?? '').replace(/^apr_/, '');
    try {
      this.app.runtime.resolveApproval(String(action?.value ?? ''), decision as 'approve' | 'deny' | 'done' | 'decline', null, this.app.workspace.owner().id);
    } catch (err) {
      await this.reply(payload.channel?.id ?? this.dmChannel, `Couldn't do that: ${errorMessage(err)}`, payload.message?.ts);
    }
  }
}
