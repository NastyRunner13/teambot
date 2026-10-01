// Agent computers over time:
//   - ready(): start the computer if needed, then run the agent's setup script once (and again when it changes)
//   - sleep: a computer nobody has used for a while is stopped. Its disk is kept, and it starts again on the next tool call.
// A computer never sleeps while its agent has unfinished work (a waiting approval may depend on an open page),
// while a human has control, or while someone is watching it live.
import crypto from 'node:crypto';
import { ACTIVE_RUN_STATUSES, type Agent, type SetupRun } from '@teambot/shared';
import type { App } from '../app.js';
import type { ComputerHandle, ComputerSpec } from '../computers/types.js';
import { errorMessage } from '../util.js';

const SWEEP_MS = 60_000;
const SETUP_TIMEOUT_SEC = 900;
const MARKER = '~/.teambot/setup.sha';

export const scriptHash = (script: string) => crypto.createHash('sha256').update(script.trim()).digest('hex').slice(0, 16);

export class ComputerLifecycle {
  private lastUsed = new Map<string, number>();
  private viewers = new Map<string, number>();
  /** Script hash already applied (or attempted) per agent in this process, so a failing script isn't retried on every call. */
  private applied = new Map<string, string>();
  private setups = new Map<string, Promise<void>>();
  private timer?: NodeJS.Timeout;
  private startedAt = Date.now();

  constructor(private app: App) {}

  start() {
    this.startedAt = Date.now();
    if (this.app.cfg.computerIdleMinutes <= 0) return;
    this.timer = setInterval(() => void this.sweep().catch((err) => console.error('computer sleep sweep failed', err)), SWEEP_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  touch(agentId: string) {
    this.lastUsed.set(agentId, Date.now());
  }

  viewerOpened(agentId: string) {
    this.viewers.set(agentId, (this.viewers.get(agentId) ?? 0) + 1);
    this.touch(agentId);
  }

  viewerClosed(agentId: string) {
    this.viewers.set(agentId, Math.max(0, (this.viewers.get(agentId) ?? 1) - 1));
    this.touch(agentId);
  }

  /** How the agent's computer should be built and connected. */
  async spec(agent: Agent): Promise<ComputerSpec> {
    const network = agent.network.mode === 'allowlist' ? { proxyHost: this.app.egress.host, proxyPort: await this.app.egress.portFor(agent) } : null;
    return { image: agent.computerImage, network };
  }

  /** The agent's computer, running, on the right network, and set up. */
  async ready(agent: Agent): Promise<ComputerHandle> {
    this.touch(agent.id);
    const handle = await this.app.computers.ensure(agent.id, await this.spec(agent));
    await this.setUp(agent, handle);
    this.touch(agent.id);
    return handle;
  }

  /** Run the setup script again on the next start, even if it already succeeded. */
  async rerunSetup(agent: Agent): Promise<SetupRun | null> {
    const handle = await this.app.computers.ensure(agent.id, await this.spec(agent));
    await handle.call('/shell', { command: `rm -f ${MARKER}`, timeoutSec: 15 });
    this.applied.delete(agent.id);
    await this.ready(agent);
    return this.lastSetup(agent.id);
  }

  lastSetup(agentId: string): SetupRun | null {
    const raw = this.app.store.getSetting(`setup:${agentId}`);
    return raw ? (JSON.parse(raw) as SetupRun) : null;
  }

  private setUp(agent: Agent, handle: ComputerHandle): Promise<void> {
    const hash = agent.setupScript.trim() ? scriptHash(agent.setupScript) : '';
    if (this.applied.get(agent.id) === hash) return Promise.resolve();
    const running = this.setups.get(agent.id);
    if (running) return running;
    const p = this.runSetup(agent, handle, hash).finally(() => this.setups.delete(agent.id));
    this.setups.set(agent.id, p);
    return p;
  }

  private async runSetup(agent: Agent, handle: ComputerHandle, hash: string) {
    const { bus, store, vault } = this.app;
    if (!hash) {
      this.applied.set(agent.id, '');
      return;
    }
    // The marker lives on the computer's own disk, so a rebuilt computer with a kept disk isn't set up twice.
    const marker = await handle.call<{ stdout: string }>('/shell', { command: `cat ${MARKER} 2>/dev/null || true`, timeoutSec: 15 }, { timeoutMs: 30_000 });
    if (marker.stdout.trim() === hash) {
      this.applied.set(agent.id, hash);
      return;
    }
    bus.emit('computer.setup_started', { agentId: agent.id }, {});
    let run: SetupRun;
    try {
      const r = await handle.call<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>(
        '/shell',
        // Reserved TEAMBOT_* secrets belong to TeamBot's own features, never to a computer.
        { command: `set -e\n${vault.resolve(agent.setupScript, { forAgent: true })}`, cwd: '/home/agent', timeoutSec: SETUP_TIMEOUT_SEC },
        { timeoutMs: (SETUP_TIMEOUT_SEC + 30) * 1000 },
      );
      const ok = r.exitCode === 0 && !r.timedOut;
      if (ok) await handle.call('/shell', { command: `mkdir -p ~/.teambot && echo ${hash} > ${MARKER}`, timeoutSec: 15 });
      const output = vault.redact(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`).trim();
      run = { ok, at: new Date().toISOString(), exitCode: r.exitCode, output: `${r.timedOut ? '(timed out)\n' : ''}${output.slice(-4000)}` };
    } catch (err) {
      run = { ok: false, at: new Date().toISOString(), exitCode: null, output: errorMessage(err) };
    }
    this.applied.set(agent.id, hash);
    store.setSetting(`setup:${agent.id}`, JSON.stringify(run));
    bus.emit(run.ok ? 'computer.setup_finished' : 'computer.setup_failed', { agentId: agent.id }, { setup: run });
  }

  /** Stop computers that have been idle for the configured minutes. Returns the agents whose computers were stopped. */
  async sweep(at = Date.now()): Promise<string[]> {
    const { store, computers, bus, cfg } = this.app;
    const minutes = cfg.computerIdleMinutes;
    if (minutes <= 0) return [];
    const slept: string[] = [];
    for (const agent of store.listAgents()) {
      if (agent.takeoverBy || (this.viewers.get(agent.id) ?? 0) > 0) continue;
      if (store.listRuns({ agentId: agent.id, statuses: ACTIVE_RUN_STATUSES, limit: 1 }).length) continue;
      if (at - (this.lastUsed.get(agent.id) ?? this.startedAt) < minutes * 60_000) continue;
      if ((await computers.status(agent.id)).state !== 'running') continue;
      await computers.stop(agent.id);
      this.lastUsed.set(agent.id, at);
      bus.emit('computer.slept', { agentId: agent.id }, { idleMinutes: minutes });
      slept.push(agent.id);
    }
    return slept;
  }
}
