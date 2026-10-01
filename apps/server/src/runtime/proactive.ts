// Proactive follow-ups: tasks that have gone quiet get a nudge, once per period of silence.
//   - an agent's open task with no update → the agent is asked to continue it or update its status
//   - a task that stays blocked → its assignee raises it with whoever can unblock it
import type { Task } from '@teambot/shared';
import type { App } from '../app.js';

const SWEEP_MS = 5 * 60_000;

export class Proactive {
  private timer?: NodeJS.Timeout;

  constructor(private app: App) {}

  start() {
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        console.error('follow-up sweep failed', err);
      }
      // Helpers whose task someone else closed while they were idle.
      void this.app.helpers.sweep().catch((err) => console.error('helper sweep failed', err));
    }, SWEEP_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Nudge every task that has been quiet for longer than the configured hours. Returns the tasks nudged. */
  sweep(at = new Date()): Task[] {
    const { store, runtime, bus, cfg } = this.app;
    const hours = cfg.staleTaskHours;
    if (hours <= 0) return [];
    const cutoff = new Date(at.getTime() - hours * 3_600_000).toISOString();
    const nudged: Task[] = [];
    for (const task of store.staleTasks(cutoff)) {
      const agent = task.assigneeId ? store.getAgent(task.assigneeId) : undefined;
      if (!agent || agent.paused) continue; // humans' tasks and paused agents are left alone
      // Blocked on dependencies that aren't done is waiting, not stalling.
      if (task.status === 'todo' && task.dependsOn.some((n) => store.getTaskByNumber(n)?.status !== 'done')) continue;
      const quiet = Math.round((at.getTime() - new Date(task.updatedAt).getTime()) / 3_600_000);
      const last = task.notes.at(-1);
      const text =
        task.status === 'blocked'
          ? `Task #${task.number} "${task.title}" has been blocked for ${quiet}h${last ? ` (latest note: ${last.text})` : ''}. Raise it with whoever can unblock it (mention them, or ask a human), or update the task if it is no longer blocked.`
          : `Task #${task.number} "${task.title}" is ${task.status.replace('_', ' ')} with no update for ${quiet}h. Continue it now, or update it: blocked with the reason, or done with a short note of the result.`;
      store.addInbox({ agentId: agent.id, kind: 'task', text, channelId: task.channelId, taskNumber: task.number, depth: 0, initiator: 'schedule' });
      store.markNudged(task.id);
      bus.emit('task.nudged', { agentId: agent.id, channelId: task.channelId }, { taskNumber: task.number, title: task.title, status: task.status, quietHours: quiet });
      nudged.push(task);
    }
    if (nudged.length) runtime.poke();
    return nudged;
  }
}
