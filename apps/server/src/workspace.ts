// Channels and messages: the shared surface that humans and agents both work in.
// Posting here is also how work gets routed: @mentions and DMs land in an agent's inbox.
import { ACTIVE_RUN_STATUSES, type Agent, type Channel, type Human, type Initiator, type Member, type Message, type Widget } from '@teambot/shared';
import type { App } from './app.js';
import { componentToolName } from './components.js';
import { attachmentFor, formatBytes, sharedFilesIn } from './shared-files.js';
import { NAME_RE, parseMentions, truncate } from './util.js';

/** Who is acting, and how far this action is from a human request (for the agent loop guard). */
export interface Actor {
  id: string;
  depth: number;
  initiator: Initiator;
  runId?: string | null;
}

export const humanActor = (id: string): Actor => ({ id, depth: 0, initiator: 'human' });

export class Workspace {
  constructor(private app: App) {}

  private get store() {
    return this.app.store;
  }

  /** The person who set the workspace up. In personal mode every human action is theirs. */
  owner(): Human {
    const humans = this.store.listHumans();
    return humans.find((h) => h.role === 'owner') ?? humans[0];
  }

  member(id: string): Member | undefined {
    return this.store.getAgent(id) ?? this.store.getHuman(id);
  }

  memberName(id: string | null | undefined): string {
    if (!id) return 'nobody';
    return this.member(id)?.name ?? 'unknown';
  }

  findMember(name: string): Member | undefined {
    const n = name.trim().replace(/^@/, '').toLowerCase();
    if (!n) return undefined;
    if (n === 'me' || n === 'owner') return this.owner();
    return this.store.getAgentByName(n) ?? this.store.listHumans().find((h) => h.name.toLowerCase() === n);
  }

  isHuman(id: string): boolean {
    return !!this.store.getHuman(id);
  }

  /** In team mode, direct messages that include a person are private to their members. Everything else is shared. */
  canSee(channel: Channel, viewerId: string): boolean {
    if (!this.app.auth.teamMode || channel.kind !== 'dm' || channel.memberIds.includes(viewerId)) return true;
    return !channel.memberIds.some((id) => this.isHuman(id));
  }

  /**
   * What an agent may read while working in a conversation: what it can see itself, limited (in team mode) to what
   * everyone it answers there can see too. An agent in Alice's DM may read it when Alice asks, not when Bob asks in
   * #general, which every person can read.
   */
  canSeeFrom(channel: Channel, agentId: string, workingIn: string | null): boolean {
    if (!this.canSee(channel, agentId)) return false;
    if (!this.app.auth.teamMode) return true;
    const where = workingIn ? this.store.getChannel(workingIn) : undefined;
    const audience = where?.kind === 'dm' ? where.memberIds.filter((id) => this.isHuman(id)) : this.store.listHumans().map((h) => h.id);
    return audience.every((id) => this.canSee(channel, id));
  }

  channelLabel(channel: Channel, forMemberId?: string): string {
    if (channel.kind === 'channel') return `#${channel.name}`;
    const others = channel.memberIds.filter((m) => m !== forMemberId).map((m) => this.memberName(m));
    return `DM with ${others.join(', ') || 'yourself'}`;
  }

  /**
   * Accepts "#name", "name", "@Member" (a DM), a DM's label as tools print it ("DM with Ann", "DM with Bo, Ann") or a
   * channel id. Other people's private DMs don't resolve.
   */
  resolveChannel(ref: string, actorId: string): Channel {
    const r = ref.trim();
    const byId = this.store.getChannel(r);
    if (byId && this.canSee(byId, actorId)) return byId;
    if (r.startsWith('@')) {
      const m = this.findMember(r);
      if (!m) throw new Error(`No teammate named ${r}`);
      return this.getOrCreateDm(actorId, m.id);
    }
    const label = /^DM with (.+)$/i.exec(r);
    if (label) {
      const members = label[1].split(',').map((n) => this.findMember(n));
      const dm =
        members.length === 1 && members[0] ? this.getOrCreateDm(actorId, members[0].id) : members.length === 2 && members[0] && members[1] ? this.store.findDm(members[0].id, members[1].id) : undefined;
      if (dm && this.canSee(dm, actorId)) return dm;
      throw new Error(`No conversation "${ref}" that you can read. For your DM with someone, use "@Name".`);
    }
    const byName = this.store.getChannelByName(r.replace(/^#/, ''));
    if (byName) return byName;
    const names = this.store
      .listChannels()
      .filter((c) => c.kind === 'channel')
      .map((c) => `#${c.name}`);
    throw new Error(`No channel "${ref}". Group chats: ${names.join(', ') || 'none'}. For your DM with someone, use "@Name".`);
  }

  createChannel(input: { name: string; topic?: string; memberIds: string[] }, actorId: string): Channel {
    const name = input.name.trim().replace(/^#/, '').toLowerCase();
    if (!NAME_RE.test(name)) throw new Error('Channel names use letters, numbers, - and _ (max 32), starting with a letter');
    if (this.store.getChannelByName(name)) throw new Error(`#${name} already exists`);
    const channel = this.store.createChannel({ name, kind: 'channel', topic: input.topic, memberIds: [...new Set([actorId, ...input.memberIds])] });
    this.app.bus.emit('channel.created', { actorId, channelId: channel.id }, { channel });
    return channel;
  }

  addMember(channelId: string, memberId: string, actorId: string) {
    this.store.addMember(channelId, memberId);
    this.app.bus.emit('channel.updated', { actorId, channelId }, { channel: this.store.getChannel(channelId) });
  }

  removeMember(channelId: string, memberId: string, actorId: string) {
    this.store.removeMember(channelId, memberId);
    this.app.bus.emit('channel.updated', { actorId, channelId }, { channel: this.store.getChannel(channelId) });
  }

  /**
   * Delete a group chat and its messages. Work under way there is cancelled, and routines that posted there post in
   * their agent's chat with the owner instead. Runs and the audit log stay. A DM can't be deleted.
   */
  deleteChannel(channelId: string, actorId: string) {
    const channel = this.store.getChannel(channelId);
    if (!channel) throw new Error('channel not found');
    if (channel.kind === 'dm') throw new Error("A direct message can't be deleted");
    for (const run of this.store.listRuns({ channelId, statuses: ACTIVE_RUN_STATUSES, limit: 1000 })) this.app.runtime.cancelRun(run.id, actorId);
    this.store.deleteChannel(channelId);
    this.app.bus.emit('channel.deleted', { actorId, channelId }, { channelId, name: channel.name });
  }

  getOrCreateDm(a: string, b: string): Channel {
    const existing = this.store.findDm(a, b);
    if (existing) return existing;
    const channel = this.store.createChannel({ name: 'dm', kind: 'dm', memberIds: [a, b] });
    this.app.bus.emit('channel.created', { actorId: a, channelId: channel.id }, { channel });
    return channel;
  }

  // ── messages ──────────────────────────────────────────────────────────

  postMessage(input: {
    channelId: string;
    authorId: string;
    text: string;
    actor?: Actor;
    route?: boolean;
    /** Reply in this message's thread. A reply's id resolves to its thread's root. */
    threadId?: string | null;
    /** Files in /shared to attach, e.g. "/shared/report.pdf". */
    attachments?: string[];
    /** An interface to draw with the message (generative UI). */
    widget?: Widget;
  }): Message {
    const channel = this.store.getChannel(input.channelId);
    if (!channel) throw new Error('channel not found');
    // SQLite keeps text only up to its first null byte, so a message with one would be saved cut off, or empty.
    const text = input.text.replaceAll('\u0000', '').trim();
    const fromHuman = this.isHuman(input.authorId);
    const sharedDir = this.app.cfg.sharedDir;
    const chosen = [...new Set(input.attachments ?? [])].map((p) => attachmentFor(sharedDir, p));
    if (chosen.length > 20) throw new Error('attach at most 20 files to one message');
    // An agent's message carries the /shared files it names, so "Saved /shared/report.md" arrives as a file to open.
    const named = fromHuman ? [] : sharedFilesIn(sharedDir, text).map((p) => attachmentFor(sharedDir, p));
    const attachments = [...new Map([...chosen, ...named].map((a) => [a.path, a])).values()].slice(0, 20);
    if (!text && !attachments.length && !input.widget) throw new Error('message is empty');
    if (text.length > 20_000) throw new Error('message is too long (max 20,000 characters)');

    let threadId: string | null = null;
    if (input.threadId) {
      const root = this.store.getMessage(input.threadId);
      if (!root || root.channelId !== channel.id) throw new Error('that thread is not in this conversation');
      threadId = root.threadId ?? root.id;
    }

    // Posting joins a group chat. A DM stays between its two members: anyone else who speaks in it doesn't join, or
    // the DM would stop being theirs.
    if (channel.kind === 'channel' && !channel.memberIds.includes(input.authorId)) this.addMember(channel.id, input.authorId, input.authorId);
    const actor = input.actor ?? humanActor(input.authorId);
    const depth = fromHuman ? 0 : actor.depth + 1;
    const mentionIds = parseMentions(text)
      .map((n) => this.findMember(n)?.id)
      .filter((id): id is string => !!id);

    const message = this.store.insertMessage({
      channelId: channel.id,
      authorId: input.authorId,
      text,
      runId: actor.runId ?? null,
      depth,
      mentions: [...new Set(mentionIds)],
      attachments,
      threadId,
      widget: input.widget ?? null,
    });
    this.app.bus.emit('message.created', { actorId: input.authorId, channelId: channel.id, runId: actor.runId }, { message });
    if (input.route !== false) this.route(message, this.store.getChannel(channel.id)!, fromHuman ? 'human' : actor.initiator, !fromHuman && this.fromReadOnlyRun(actor));
    return message;
  }

  /** How a message reads in an agent's inbox: text, the interface it showed and the attached file paths. */
  messageBody(message: Message): string {
    const files = message.attachments.map((a) => `- ${a.path} (${formatBytes(a.size)})`);
    const w = message.widget;
    const view = w ? `[Showed an interactive view: "${w.title}"${w.component ? ` (${componentToolName(w.component)})` : ''}${Object.keys(w.args).length ? ` with ${truncate(JSON.stringify(w.args), 1500)}` : ''}]` : '';
    return [message.text, view, files.length ? `Attached files (read them from your computer):\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
  }

  /** Work that a read-only run hands on stays read-only, so a monitoring routine can't act through a teammate. */
  private fromReadOnlyRun(actor: Actor): boolean {
    return !!actor.runId && !!this.store.getRun(actor.runId)?.readOnly;
  }

  private route(message: Message, channel: Channel, initiator: Initiator, readOnly: boolean) {
    const targets = new Set(message.mentions.filter((id) => this.store.getAgent(id)));
    if (channel.kind === 'dm') {
      // A chat with an agent is that agent's to answer: naming a teammate there asks it to bring them in, it doesn't
      // wake them in someone else's DM. Only people talking to each other call an agent into their DM by name.
      const agents = channel.memberIds.filter((id) => this.store.getAgent(id));
      if (agents.length) targets.clear();
      for (const id of agents) targets.add(id);
    }
    // A human replying in a thread continues the conversation with the agents already in it.
    if (message.threadId && channel.kind === 'channel' && this.isHuman(message.authorId)) {
      const root = this.store.getMessage(message.threadId);
      for (const m of [...(root ? [root] : []), ...this.store.listThread(message.threadId)]) if (this.store.getAgent(m.authorId)) targets.add(m.authorId);
    }
    targets.delete(message.authorId);
    // An agent's reply to a teammate that asked it something (ask_agent) goes back to where that teammate asked.
    if (channel.kind === 'dm' && !this.isHuman(message.authorId)) for (const id of this.app.handoffs.answer(message, channel)) targets.delete(id);
    // Nobody addressed: the channel's lead picks up messages from humans.
    let viaLead = false;
    if (!targets.size && channel.kind === 'channel' && channel.leadAgentId && this.isHuman(message.authorId) && this.store.getAgent(channel.leadAgentId)) {
      targets.add(channel.leadAgentId);
      viaLead = true;
    }
    if (!targets.size) return;

    for (const agentId of targets) {
      if (message.depth > this.app.cfg.maxAgentDepth) {
        this.app.bus.emit('loop.guard', { agentId, channelId: channel.id }, { messageId: message.id, depth: message.depth });
        continue;
      }
      if (channel.kind === 'channel' && !channel.memberIds.includes(agentId)) this.addMember(channel.id, agentId, message.authorId);
      const author = this.member(message.authorId);
      const where = `${this.channelLabel(channel, agentId)}${message.threadId ? ' (in a thread)' : ''}`;
      const lead = viaLead ? ` (you lead ${this.channelLabel(channel)}, so you get messages that mention nobody: handle it, hand it to the right teammate, or reply [silent] if it needs nothing)` : '';
      this.store.addInbox({
        agentId,
        kind: 'message',
        text: `${where} — ${author?.name ?? 'unknown'} (${author?.kind ?? '?'}) wrote${lead}:\n${this.messageBody(message)}`,
        channelId: channel.id,
        threadId: message.threadId,
        depth: message.depth,
        initiator,
        readOnly,
      });
    }
    this.app.runtime.poke();
  }
}
