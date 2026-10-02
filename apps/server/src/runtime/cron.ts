// Routines: on a schedule (cron) or when something happens (webhook, email, Slack message, calendar event),
// a prompt is dropped into the agent's inbox. Event triggers other than webhooks live in runtime/triggers.ts.
import crypto from 'node:crypto';
import { Cron } from 'croner';
import type { Schedule } from '@teambot/shared';
import type { App } from '../app.js';
import { now, untrusted } from '../util.js';

/** Webhook calls waiting for the agent before more are turned away (stops a noisy sender from flooding it). */
export const MAX_QUEUED_EVENTS = 10;
const MAX_PAYLOAD_CHARS = 20_000;

export const newHookToken = () => crypto.randomBytes(24).toString('base64url');

/** Something from outside that starts a routine. */
export interface RoutineEvent {
  source: 'webhook' | 'email' | 'slack' | 'calendar';
  /** How the prompt describes it: "a webhook", "an email from …". */
  via: string;
  body: string;
}

export function tokenMatches(expected: string | null, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class CronScheduler {
  private jobs = new Map<string, Cron>();

  constructor(private app: App) {}

  static validate(expr: string) {
    try {
      new Cron(expr, { paused: true }).stop();
    } catch (err) {
      throw new Error(`Invalid cron expression "${expr}": ${(err as Error).message}`);
    }
  }

  start() {
    this.reload();
  }

  reload() {
    this.stop();
    for (const s of this.app.store.listSchedules()) {
      if (!s.enabled || s.trigger !== 'schedule') continue;
      try {
        this.jobs.set(s.id, new Cron(s.cron, { protect: true, catch: true }, () => this.fire(s.id)));
      } catch (err) {
        console.error(`schedule ${s.name} has an invalid cron expression`, err);
      }
    }
  }

  withNextRun(s: Schedule): Schedule {
    return { ...s, nextRunAt: this.jobs.get(s.id)?.nextRun()?.toISOString() ?? null };
  }

  /** Waiting event items (webhook calls, emails, …) for a routine, so a flood can be refused. */
  queuedEvents(s: Schedule): number {
    return this.app.store.pendingInbox(s.agentId).filter((i) => i.kind === 'schedule' && i.text.startsWith(`Routine "${s.name}" was triggered by`)).length;
  }

  /**
   * Hand the routine to its agent. `event` is what started it from outside (a webhook call, an email, a Slack
   * message, a calendar event); its body is outside content and is tagged as untrusted. `via` is a fixed phrase
   * that lands outside the tag, so it never carries outside text (a sender's name, an event title).
   */
  fire(scheduleId: string, event?: RoutineEvent) {
    const { store, bus, workspace, runtime } = this.app;
    const s = store.getSchedule(scheduleId);
    if (!s) return;
    const agent = store.getAgent(s.agentId);
    if (!agent) return;
    const channelId = s.channelId ?? workspace.getOrCreateDm(workspace.owner().id, agent.id).id;
    const body = event && event.body.length > MAX_PAYLOAD_CHARS ? `${event.body.slice(0, MAX_PAYLOAD_CHARS)}\n… (truncated)` : event?.body;
    const head = event ? `Routine "${s.name}" was triggered by ${event.via}: ${s.prompt}` : `Routine "${s.name}" (${s.cron}): ${s.prompt}`;
    const lines = [
      head,
      s.skill && `Follow the skill "${s.skill}": call use_skill with that name first.`,
      s.readOnly && 'This routine is read-only: look and report, but change nothing. If something needs doing, say so in your reply; if nothing needs attention, reply [silent].',
      event && (body ? `What arrived:\n${untrusted(event.source, body)}` : 'Nothing else came with it.'),
    ];
    store.addInbox({
      agentId: agent.id,
      kind: 'schedule',
      text: lines.filter(Boolean).join('\n'),
      channelId,
      depth: 0,
      initiator: event ? 'event' : 'schedule',
      readOnly: s.readOnly,
    });
    const next = { ...s, lastRunAt: now() };
    store.saveSchedule(next);
    bus.emit('schedule.fired', { agentId: agent.id, channelId }, { schedule: this.withNextRun(next), trigger: event?.source ?? 'schedule' });
    runtime.poke();
  }

  stop() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
