import { spawn } from 'node:child_process';
import { resolvePath, WORKSPACE } from './files.js';

const MAX_OUTPUT = 100_000;

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** Process groups of commands still running, so the server can stop them when a run is paused or cancelled. */
const running = new Set<number>();

function killGroup(pid: number | undefined) {
  try {
    if (pid) process.kill(-pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Kill every running command (and everything it started). Returns how many there were. */
export function cancelAll(): number {
  const n = running.size;
  for (const pid of running) killGroup(pid);
  running.clear();
  return n;
}

/** Run a command; `signal` (the request going away) kills it like a timeout does. */
export function runShell(body: Record<string, unknown>, signal?: AbortSignal): Promise<ShellResult> {
  const command = String(body.command ?? '');
  if (!command.trim()) throw new Error('command is required');
  const cwd = body.cwd ? resolvePath(String(body.cwd)) : WORKSPACE;
  // Up to an hour: coding agents run long tasks through here.
  const timeoutSec = Math.min(Math.max(Number(body.timeoutSec ?? 120), 1), 3600);
  // Extra environment variables (e.g. API keys), so secrets never have to appear in the command line.
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries((body.env as Record<string, unknown> | undefined) ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') throw new Error(`invalid environment variable ${k}`);
    extra[k] = v;
  }

  return new Promise((resolve) => {
    // detached: the command gets its own process group so a timeout can kill everything it spawned.
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...extra }, detached: true });
    if (child.pid) running.add(child.pid);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let done = false;

    const append = (which: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        if (stdout.length < MAX_OUTPUT) stdout += text;
        else truncated = true;
      } else if (stderr.length < MAX_OUTPUT) stderr += text;
      else truncated = true;
    };
    child.stdout.on('data', (c: Buffer) => append('out', c));
    child.stderr.on('data', (c: Buffer) => append('err', c));

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeoutSec * 1000);
    const onAbort = () => killGroup(child.pid);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (child.pid) running.delete(child.pid);
      resolve({
        exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        timedOut,
        truncated,
      });
    };
    // Background jobs (`cmd &`) can hold the pipes open after bash exits, so don't wait for 'close' forever.
    child.on('exit', (code) => setTimeout(() => finish(code), 300));
    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      stderr += String(err);
      finish(null);
    });
  });
}
