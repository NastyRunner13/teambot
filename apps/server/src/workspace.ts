// Channels, messages and tasks: the shared surface that humans and agents both work in.
// Posting here is also how work gets routed: @mentions and DMs land in an agent's inbox,
// task assignments and hand-offs notify the people involved.
import type { Agent, Channel, Human, Initiator, Member, Message, Task, TaskStatus } from '@teambot/shared';
import type { App } from './app.js';
import { attachmentFor, formatBytes } from './shared-files.js';
import { NAME_RE, parseMentions } from './util.js';

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
    // A helper works in its parent's conversations without joining them, so it sees what its parent sees.
    viewerId = this.store.getAgent(viewerId)?.parentId ?? viewerId;
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

  /** Accepts "#name", "name", "@Member" (a DM) or a channel id. Other people's private DMs don't resolve. */
  resolveChannel(ref: string, actorId: string): Channel {
    const r = ref.trim();
    const byId = this.store.getChannel(r);
    if (byId && this.canSee(byId, actorId)) return byId;
    if (r.startsWith('@')) {
      const m = this.findMember(r);
      if (!m) throw new Error(`No teammate named ${r}`);
      return this.getOrCreateDm(actorId, m.id);
    }
    const byName = this.store.getChannelByName(r.replace(/^#/, ''));
    if (byName) return byName;
    const names = this.store
      .listChannels()
      .filter((c) => c.kind === 'channel')
      .map((c) => `#${c.name}`);
    throw new Error(`No channel "${ref}". Channels: ${names.join(', ')}`);
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
  }): Message {
    const channel = this.store.getChannel(input.channelId);
    if (!channel) throw new Error('channel not found');
    const text = input.text.trim();
    const attachments = [...new Set(input.attachments ?? [])].map((p) => attachmentFor(this.app.cfg.sharedDir, p));
    if (!text && !attachments.length) throw new Error('message is empty');
    if (text.length > 20_000) throw new Error('message is too long (max 20,000 characters)');
    if (attachments.length > 20) throw new Error('attach at most 20 files to one message');

    let threadId: string | null = null;
    if (input.threadId) {
      const root = this.store.getMessage(input.threadId);
      if (!root || root.channelId !== channel.id) throw new Error('that thread is not in this conversation');
      threadId = root.threadId ?? root.id;
    }

    const fromHuman = this.isHuman(input.authorId);
    // Posting joins a group chat. A DM stays between its two members: an agent working there for them (a helper, a
    // task's assignee) speaks in it without joining, or the DM would stop being theirs.
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
    });
    this.app.bus.emit('message.created', { actorId: input.authorId, channelId: channel.id, runId: actor.runId }, { message });
    if (input.route !== false) this.route(message, this.store.getChannel(channel.id)!, fromHuman ? 'human' : actor.initiator, !fromHuman && this.fromReadOnlyRun(actor));
    return message;
  }

  /** How a message reads in an agent's inbox: text plus the attached file paths. */
  messageBody(message: Message): string {
    const files = message.attachments.map((a) => `- ${a.path} (${formatBytes(a.size)})`);
    return [message.text, files.length ? `Attached files (read them from your computer):\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
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
        taskNumber: null,
        depth: message.depth,
        initiator,
        readOnly,
      });
    }
    this.app.runtime.poke();
  }

  // ── tasks ─────────────────────────────────────────────────────────────

  taskLine(task: Task): string {
    const deps = task.dependsOn.length ? ` (depends on ${task.dependsOn.map((d) => `#${d}`).join(', ')})` : '';
    return `#${task.number} [${task.status}] ${task.title} — assigned to ${this.memberName(task.assigneeId)}, created by ${this.memberName(task.creatorId)}${deps}`;
  }

  private depsSummary(task: Task): { text: string; allDone: boolean } {
    if (!task.dependsOn.length) return { text: '', allDone: true };
    const deps = task.dependsOn.map((n) => this.store.getTaskByNumber(n));
    const allDone = deps.every((d) => !d || d.status === 'done');
    const text = `Depends on: ${deps.map((d, i) => (d ? `#${d.number} (${d.status})` : `#${task.dependsOn[i]} (missing)`)).join(', ')}.`;
    return { text, allDone };
  }

  private notifyAgent(agentId: string | null, actor: Actor, text: string, task: Task) {
    if (!agentId || agentId === actor.id) return;
    const agent: Agent | undefined = this.store.getAgent(agentId);
    if (!agent) return;
    const depth = this.isHuman(actor.id) ? 0 : actor.depth + 1;
    if (depth > this.app.cfg.maxAgentDepth) {
      this.app.bus.emit('loop.guard', { agentId }, { taskNumber: task.number, depth });
      return;
    }
    const readOnly = !this.isHuman(actor.id) && this.fromReadOnlyRun(actor);
    this.store.addInbox({ agentId, kind: 'task', text, channelId: task.channelId, taskNumber: task.number, depth, initiator: actor.initiator, readOnly });
    this.app.runtime.poke();
  }

  createTask(
    input: { title: string; description?: string; assigneeId?: string | null; dependsOn?: number[]; channelId?: string | null },
    actor: Actor,
  ): Task {
    const title = input.title.trim();
    if (!title) throw new Error('task title is required');
    for (const n of input.dependsOn ?? []) if (!this.store.getTaskByNumber(n)) throw new Error(`task #${n} does not exist`);
    if (input.assigneeId && !this.member(input.assigneeId)) throw new Error('assignee not found');

    const task = this.store.createTask({
      title,
      description: input.description?.trim() ?? '',
      status: 'todo',
      assigneeId: input.assigneeId ?? null,
      creatorId: actor.id,
      channelId: input.channelId ?? null,
      dependsOn: [...new Set(input.dependsOn ?? [])],
    });
    this.app.bus.emit('task.created', { actorId: actor.id, channelId: task.channelId, runId: actor.runId }, { task });

    if (task.channelId) {
      this.postMessage({
        channelId: task.channelId,
        authorId: actor.id,
        text: `📋 Created task #${task.number}: **${task.title}** → ${this.memberName(task.assigneeId)}`,
        actor,
        route: false,
      });
    }
    this.notifyAgent(task.assigneeId, actor, this.assignmentText(task, `was assigned to you by ${this.memberName(actor.id)}`), task);
    return task;
  }

  private assignmentText(task: Task, how: string): string {
    const deps = this.depsSummary(task);
    return [
      `Task #${task.number} "${task.title}" ${how}.`,
      task.description && `Description: ${task.description}`,
      deps.text,
      deps.allDone
        ? 'Mark it in_progress when you start and done (with a short note) when finished.'
        : 'Wait for its dependencies; you will be told when they are done.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Ask the agent a task is assigned to to work on it now, e.g. after it went quiet. */
  startTask(number: number, actor: Actor): Task {
    const task = this.store.getTaskByNumber(number);
    if (!task) throw new Error(`task #${number} does not exist`);
    if (!task.assigneeId || !this.store.getAgent(task.assigneeId)) throw new Error(`task #${number} is not assigned to an agent`);
    if (task.status === 'done' || task.status === 'cancelled') throw new Error(`task #${number} is ${task.status}`);
    this.notifyAgent(task.assigneeId, actor, this.assignmentText(task, `needs you now: ${this.memberName(actor.id)} asked you to work on it`), task);
    this.app.bus.emit('task.started', { actorId: actor.id, channelId: task.channelId, runId: actor.runId }, { taskNumber: task.number, agentId: task.assigneeId });
    return task;
  }

  updateTask(
    number: number,
    patch: { status?: TaskStatus; assigneeId?: string | null; note?: string; title?: string; description?: string },
    actor: Actor,
  ): Task {
    const before = this.store.getTaskByNumber(number);
    if (!before) throw new Error(`task #${number} does not exist`);
    if (patch.assigneeId && !this.member(patch.assigneeId)) throw new Error('assignee not found');

    const next: Task = { ...before };
    if (patch.title?.trim()) next.title = patch.title.trim();
    if (patch.description !== undefined) next.description = patch.description.trim();
    if (patch.status) next.status = patch.status;
    if (patch.assigneeId !== undefined) next.assigneeId = patch.assigneeId;
    const note = patch.note?.trim();
    if (note) next.notes = [...before.notes, { authorId: actor.id, text: note, at: new Date().toISOString() }];
    const task = this.store.saveTask(next);
    this.app.bus.emit('task.updated', { actorId: actor.id, channelId: task.channelId, runId: actor.runId }, { task, before });

    const actorName = this.memberName(actor.id);
    const noteText = note ? ` Note: ${note}` : '';

    if (patch.assigneeId !== undefined && patch.assigneeId !== before.assigneeId) {
      const deps = this.depsSummary(task);
      this.notifyAgent(
        task.assigneeId,
        actor,
        [`Task #${task.number} "${task.title}" was handed to you by ${actorName}.${noteText}`, task.description && `Description: ${task.description}`, deps.text]
          .filter(Boolean)
          .join('\n'),
        task,
      );
    }

    if (task.status !== before.status) {
      // Creators hear about outcomes (done / blocked / cancelled), not every status flip.
      if (task.status === 'done' || task.status === 'blocked' || task.status === 'cancelled') {
        this.notifyAgent(
          task.creatorId,
          actor,
          `Task #${task.number} "${task.title}" (assigned to ${this.memberName(task.assigneeId)}) is now ${task.status} — updated by ${actorName}.${noteText}`,
          task,
        );
      }
      if (task.status === 'done') this.notifyUnblocked(this.store.listTasks().filter((other) => other.dependsOn.includes(task.number)), actor);
    } else if (note) {
      const other = actor.id === task.assigneeId ? task.creatorId : task.assigneeId;
      this.notifyAgent(other, actor, `${actorName} added a note on task #${task.number} "${task.title}": ${note}`, task);
    }
    return task;
  }

  /** Delete a task for good. The audit log keeps its history; tasks waiting on it stop waiting. */
  deleteTask(number: number, actor: Actor): Task {
    const task = this.store.getTaskByNumber(number);
    if (!task) throw new Error(`task #${number} does not exist`);
    const dependents = this.store.deleteTask(number);
    this.app.bus.emit('task.deleted', { actorId: actor.id, channelId: task.channelId, runId: actor.runId }, { taskNumber: task.number, title: task.title });
    for (const other of dependents) this.app.bus.emit('task.updated', { actorId: actor.id, channelId: other.channelId, runId: actor.runId }, { task: other });
    // A dependency that was already done has unblocked them before.
    if (task.status !== 'done') this.notifyUnblocked(dependents, actor);
    return task;
  }

  private notifyUnblocked(candidates: Task[], actor: Actor) {
    for (const other of candidates) {
      if (other.status === 'done' || other.status === 'cancelled' || !this.depsSummary(other).allDone) continue;
      const deps = other.dependsOn.length ? `all of its dependencies are done (${other.dependsOn.map((d) => `#${d}`).join(', ')})` : 'it no longer waits on anything';
      this.notifyAgent(other.assigneeId, actor, `Task #${other.number} "${other.title}" is unblocked: ${deps}. You can start it now.`, other);
    }
  }
}
