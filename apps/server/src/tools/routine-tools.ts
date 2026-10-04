// Routines from inside the team: when a person asks for something "every hour" or "each morning", an agent sets up a
// routine for itself or a teammate, instead of looking for cron on its own computer. Only time-based routines: webhook,
// email, Slack and calendar routines need addresses and credentials that a person sets up in the routine editor.
import { Cron } from 'croner';
import { z } from 'zod';
import type { Agent, Channel, Run, Schedule } from '@teambot/shared';
import type { App } from '../app.js';
import { CronScheduler } from '../runtime/cron.js';
import { routineSecret } from '../runtime/triggers.js';
import { defineTool, type ToolContext, type ToolDef } from './types.js';

/** Agents may set up routines that run at most this often; a person can schedule tighter ones in the routine editor. */
export const MIN_ROUTINE_MINUTES = 15;
/** Routines one agent may have before agents stop adding more to it. */
export const MAX_ROUTINES_PER_AGENT = 10;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

const CreateRoutineArgs = z.object({
  agent: z.string().trim().min(1).optional().describe('Who runs it: a teammate agent, or yourself (the default)'),
  name: z.string().trim().min(1).max(80).describe('A short name people will see, e.g. "Hourly joke"'),
  cron: z
    .string()
    .trim()
    .min(1)
    .describe(
      "When it runs, as a 5-field cron expression in UTC: \"0 * * * *\" every hour, \"30 3 * * 1-5\" weekdays at 03:30 UTC. Convert the person's local time to UTC, and ask their time zone if you don't know it.",
    ),
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(5000)
    .describe('What the agent does each time, written to it, e.g. "Tell Owner a short joke you haven\'t told before." Its reply is posted where the routine reports.'),
});
type CreateRoutineArgs = z.infer<typeof CreateRoutineArgs>;

/** The shortest gap between the next runs, in minutes. */
function shortestGap(expr: string): number {
  const job = new Cron(expr, { paused: true });
  try {
    const runs = job.nextRuns(24);
    let gap = Infinity;
    for (let i = 1; i < runs.length; i++) gap = Math.min(gap, (runs[i].getTime() - runs[i - 1].getTime()) / 60_000);
    return gap;
  } finally {
    job.stop();
  }
}

/** Who runs a routine: the named teammate agent, or the agent asking. */
function runnerOf(ctx: ToolContext, name: string | undefined): Agent {
  if (!name) return ctx.agent;
  const member = ctx.app.workspace.findMember(name);
  if (!member) throw new Error(`No teammate named "${name}".`);
  if (member.kind !== 'agent') throw new Error(`${member.name} is a person; routines are run by agents.`);
  return member;
}

/** Where a routine set up from this run reports: this group chat, or the DM between the person here and its agent. */
function reportsTo(app: App, run: Run, runner: Agent): string | null {
  const here = run.channelId ? app.store.getChannel(run.channelId) : undefined;
  if (!here) return null;
  if (here.kind === 'channel') return here.id;
  const people = here.memberIds.filter((id) => app.workspace.isHuman(id));
  // A DM between agents (a teammate's request): the routine reports in its agent's chat with the owner.
  return people.length === 1 ? app.workspace.getOrCreateDm(people[0], runner.id).id : null;
}

/** The conversation a routine reports in: its channel, or its agent's chat with the owner. */
function reportChannel(app: App, s: Schedule): Channel | undefined {
  return s.channelId ? app.store.getChannel(s.channelId) : app.store.findDm(app.workspace.owner().id, s.agentId);
}

/** Why this routine can't be set up, checked before anyone is asked to approve it and again when it runs. */
function refusal(ctx: ToolContext, a: CreateRoutineArgs): string | null {
  const { app, run } = ctx;
  if (run.initiator === 'schedule' || run.initiator === 'event') return "A routine can't set up more routines. Say in your reply what you would schedule, and let a person decide.";
  let runner: Agent;
  try {
    runner = runnerOf(ctx, a.agent);
    CronScheduler.validate(a.cron);
  } catch (err) {
    return (err as Error).message;
  }
  if (a.cron.split(/\s+/).length !== 5) return 'Use a 5-field cron expression (minute hour day month weekday), in UTC.';
  if (shortestGap(a.cron) < MIN_ROUTINE_MINUTES) {
    return `Routines you set up can run at most every ${MIN_ROUTINE_MINUTES} minutes. For more often, ask a person to set it up in the routine editor.`;
  }
  const count = app.store.listSchedules().filter((s) => s.agentId === runner.id).length;
  if (count >= MAX_ROUTINES_PER_AGENT) return `${runner.name} already has ${count} routines, the most agents may add. Stop one first, or ask a person.`;
  return null;
}

/** The agent that set a routine up, if one did (a person's routines were made in the app). */
function setUpBy(app: App, id: string): string | null {
  const created = app.store.listEvents({ types: ['schedule.created'], limit: 10_000 }).find((e) => (e.data.schedule as Schedule | undefined)?.id === id);
  return created?.actorId && app.store.getAgent(created.actorId) ? created.actorId : null;
}

const TRIGGERS: Record<Exclude<Schedule['trigger'], 'schedule'>, string> = { webhook: 'webhook calls', email: 'new email', slack: 'Slack messages', calendar: 'calendar events' };

function describe(app: App, s: Schedule, forAgentId: string): string {
  const ws = app.workspace;
  const runner = app.store.getAgent(s.agentId);
  const next = s.trigger === 'schedule' && s.enabled ? app.cron.withNextRun(s).nextRunAt : null;
  const when =
    s.trigger === 'schedule'
      ? `on "${s.cron}" (UTC), ${s.enabled ? `next at ${next ? utc(next) : 'an unknown time'}` : 'paused'}`
      : `on ${TRIGGERS[s.trigger]}${s.enabled ? '' : ', paused'}`;
  const channel = reportChannel(app, s);
  const where = channel ? ws.channelLabel(channel, forAgentId) : `${runner?.name ?? 'its agent'}'s chat with ${ws.owner().name}`;
  return `- "${s.name}" [${s.id}]: ${runner?.id === forAgentId ? 'you run it' : `${runner?.name ?? 'a removed agent'} runs it`} ${when}; reports in ${where}. Does: ${clip(s.prompt.replace(/\s+/g, ' '), 200)}`;
}

export function routineTools(): ToolDef[] {
  return [
    defineTool({
      name: 'create_routine',
      description:
        'Set up recurring work: a routine runs you or a teammate agent on a schedule (every hour, each weekday morning…), even when nobody is around, and posts its reply in this group chat or, from a DM, in the person\'s chat with that agent. Use it whenever someone asks for something to happen regularly; nothing on your own computer can do this. A reviewer or a person may check it first. People see and edit routines under the agent\'s profile.',
      risk: 'external',
      schema: CreateRoutineArgs,
      // Not facts as such: a routine that would be refused is refused before anyone is asked to approve it.
      async facts(a, ctx) {
        const why = refusal(ctx, a);
        if (why) throw new Error(why);
        return {};
      },
      summarize: (a) => `Set up routine "${a.name}" for ${a.agent ?? 'itself'}, on "${a.cron}" (UTC): ${clip(a.prompt, 160)}`,
      async execute(a, ctx) {
        const { app, run, agent } = ctx;
        const why = refusal(ctx, a);
        if (why) return `Error: ${why}`;
        const runner = runnerOf(ctx, a.agent);
        const s = app.store.createSchedule({ agentId: runner.id, name: a.name, cron: a.cron, prompt: a.prompt, channelId: reportsTo(app, run, runner), enabled: true });
        app.cron.reload();
        const shown = app.cron.withNextRun(s);
        app.bus.emit('schedule.created', { actorId: agent.id, agentId: runner.id, runId: run.id }, { schedule: shown });
        return `Set up routine "${s.name}" [${s.id}]:\n${describe(app, shown, agent.id)}\nPeople can pause or edit it under ${runner.name}'s profile → Routines; pause or stop it with stop_routine.`;
      },
    }),

    defineTool({
      name: 'list_routines',
      description: 'List the routines (scheduled and triggered recurring work): who runs each, when, what it does and where it reports. Give an agent name to see only theirs.',
      risk: 'internal',
      readOnlyOk: true,
      schema: z.object({ agent: z.string().trim().min(1).optional().describe("Only this agent's routines") }),
      summarize: (a) => (a.agent ? `List ${a.agent}'s routines` : 'List routines'),
      async execute(a, ctx) {
        const { app, agent, run } = ctx;
        const only = a.agent ? runnerOf(ctx, a.agent) : undefined;
        const routines = app.store
          .listSchedules()
          .filter((s) => !only || s.agentId === only.id)
          // A routine reporting in a private chat stays out of what people elsewhere could read.
          .filter((s) => {
            const channel = reportChannel(app, s);
            return !channel || app.workspace.canSeeFrom(channel, agent.id, run.channelId);
          });
        if (!routines.length) return only ? `${only.id === agent.id ? 'You have' : `${only.name} has`} no routines.` : 'There are no routines yet.';
        return routines.map((s) => describe(app, s, agent.id)).join('\n');
      },
    }),

    defineTool({
      name: 'stop_routine',
      description:
        'Stop a routine, by its name or id (see list_routines). With pause: true it is only paused, to resume later with resume_routine: use that when someone wants a break. Otherwise one an agent set up is removed for good, and one a person set up is paused (people delete their own). You can stop routines you run or set up yourself.',
      risk: 'internal',
      schema: z.object({
        routine: z.string().trim().min(1).describe('Its name or id'),
        pause: z.boolean().optional().describe('Pause it instead of removing it'),
      }),
      summarize: (a) => `${a.pause ? 'Pause' : 'Stop'} routine "${a.routine}"`,
      async execute(a, ctx) {
        const { app, agent, run } = ctx;
        const s = ownRoutine(ctx, a.routine, 'stop');
        const runner = app.workspace.memberName(s.agentId);
        if (!a.pause && setUpBy(app, s.id)) {
          app.store.deleteSchedule(s.id);
          app.vault.delete(routineSecret(s.id));
          app.cron.reload();
          app.bus.emit('schedule.deleted', { actorId: agent.id, agentId: s.agentId, runId: run.id }, { id: s.id });
          return `Removed routine "${s.name}" (${runner}). It won't run again.`;
        }
        if (!s.enabled) return `"${s.name}" (${runner}) is already paused.`;
        setEnabled(ctx, s, false);
        return a.pause
          ? `Paused routine "${s.name}" (${runner}). It stays under ${runner}'s profile → Routines; resume it with resume_routine.`
          : `Paused routine "${s.name}" (${runner}). A person set it up, so it stays under ${runner}'s profile → Routines, where they can resume or delete it.`;
      },
    }),

    defineTool({
      name: 'resume_routine',
      description: 'Resume a paused routine, by its name or id (see list_routines). You can resume routines you run or set up yourself.',
      risk: 'internal',
      schema: z.object({ routine: z.string().trim().min(1).describe('Its name or id') }),
      summarize: (a) => `Resume routine "${a.routine}"`,
      async execute(a, ctx) {
        const { app, agent, run } = ctx;
        if (run.initiator === 'schedule' || run.initiator === 'event') throw new Error("A routine can't resume routines. Say in your reply what you would resume, and let a person decide.");
        const s = ownRoutine(ctx, a.routine, 'resume');
        const runner = app.workspace.memberName(s.agentId);
        if (s.enabled) return `"${s.name}" (${runner}) isn't paused.`;
        return `Resumed routine "${s.name}" (${runner}):\n${describe(app, setEnabled(ctx, s, true), agent.id)}`;
      },
    }),
  ];
}

/** The routine a name or id refers to, if this agent runs it or set it up. */
function ownRoutine(ctx: ToolContext, ref: string, verb: 'stop' | 'resume'): Schedule {
  const { app, agent } = ctx;
  const wanted = ref.replace(/^\[|\]$/g, '').toLowerCase();
  const named = app.store.listSchedules().filter((s) => s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted);
  if (!named.length) throw new Error(`No routine "${ref}". Use list_routines to see them.`);
  const allowed = named.filter((s) => s.agentId === agent.id || setUpBy(app, s.id) === agent.id);
  if (!allowed.length) throw new Error(`You can only ${verb} routines you run or set up yourself. Ask a person, or the agent that runs "${ref}".`);
  if (allowed.length > 1) throw new Error(`Several routines are called "${ref}": ${allowed.map((s) => s.id).join(', ')}. Give the id.`);
  return allowed[0];
}

/** Pause or resume a routine, as the routine card's switch does. */
function setEnabled(ctx: ToolContext, s: Schedule, enabled: boolean): Schedule {
  const { app, agent, run } = ctx;
  const next = { ...s, enabled };
  app.store.saveSchedule(next);
  app.cron.reload();
  const shown = app.cron.withNextRun(next);
  app.bus.emit('schedule.updated', { actorId: agent.id, agentId: s.agentId, runId: run.id }, { schedule: shown });
  return shown;
}
