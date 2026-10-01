import fs from 'node:fs';
import path from 'node:path';

/** Walk up from cwd to the repo root (the folder with pnpm-workspace.yaml) so `.env` and `./data` resolve the same everywhere. */
function findRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export const ROOT = findRoot(process.cwd());

export function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  sharedDir: string;
  dbPath: string;
  userName: string;
  openrouterKey: string;
  defaultModel: string;
  utilityModel: string;
  /** Model that reviews actions sent to it by `review` policy rules. */
  reviewerModel: string;
  computerImage: string;
  sandboxRuntime: string;
  /** Set when the server itself runs in Docker: computers join this network and are reached by container name. */
  computerNetwork: string;
  /** Set when the server runs in Docker: /shared is this named volume instead of a host folder. */
  sharedVolume: string;
  computerMemoryMb: number;
  computerCpus: number;
  /** Stop a computer after this many idle minutes (0 keeps computers running). */
  computerIdleMinutes: number;
  /** Egress proxy for agents with an allowlist: the address it listens on, how computers reach it, and its port range. */
  egressBind: string;
  egressHost: string;
  egressPorts: [number, number];
  maxStepsPerRun: number;
  maxConcurrentRuns: number;
  compactAtTokens: number;
  maxAgentDepth: number;
  /** Nudge an agent about a task with no update for this many hours (0 turns follow-ups off). */
  staleTaskHours: number;
  mcpConfigPath: string;
  /** The address people open TeamBot at, when it isn't this machine (OAuth sign-ins return here). */
  publicUrl: string;
  webDist: string;
  /** Answer with a canned echo instead of calling OpenRouter (trying the app without a key or cost). */
  offlineModels: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const dataDir = path.resolve(ROOT, env.TEAMBOT_DATA_DIR ?? 'data');
  const inDocker = !!env.TEAMBOT_COMPUTER_NETWORK;
  const [portLo, portHi] = (env.TEAMBOT_EGRESS_PORTS ?? '18800-18999').split('-').map(Number);
  const cfg: Config = {
    port: num(env.PORT, 8787),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    sharedDir: path.join(dataDir, 'shared'),
    dbPath: path.join(dataDir, 'teambot.db'),
    userName: env.TEAMBOT_USER_NAME || 'Owner',
    openrouterKey: env.OPENROUTER_API_KEY ?? '',
    defaultModel: env.TEAMBOT_DEFAULT_MODEL || 'anthropic/claude-sonnet-5.5',
    utilityModel: env.TEAMBOT_UTILITY_MODEL || 'openai/gpt-6-luna',
    reviewerModel: env.TEAMBOT_REVIEWER_MODEL || env.TEAMBOT_UTILITY_MODEL || 'openai/gpt-6-luna',
    computerImage: env.TEAMBOT_COMPUTER_IMAGE || 'teambot/computer:latest',
    sandboxRuntime: env.TEAMBOT_SANDBOX_RUNTIME ?? '',
    computerNetwork: env.TEAMBOT_COMPUTER_NETWORK ?? '',
    sharedVolume: env.TEAMBOT_SHARED_VOLUME ?? '',
    computerMemoryMb: num(env.TEAMBOT_COMPUTER_MEMORY_MB, 2048),
    computerCpus: num(env.TEAMBOT_COMPUTER_CPUS, 2),
    computerIdleMinutes: num(env.TEAMBOT_COMPUTER_IDLE_MINUTES, 30),
    // On the host, Docker Desktop forwards host.docker.internal to 127.0.0.1, so the proxy stays off the LAN.
    // In Docker Compose, computers reach the server by its service name on the shared network.
    egressBind: env.TEAMBOT_EGRESS_BIND || (inDocker ? '0.0.0.0' : '127.0.0.1'),
    egressHost: env.TEAMBOT_EGRESS_HOST || (inDocker ? 'teambot' : 'host.docker.internal'),
    egressPorts: [Number.isFinite(portLo) ? portLo : 18800, Number.isFinite(portHi) ? portHi : 18999],
    maxStepsPerRun: num(env.TEAMBOT_MAX_STEPS_PER_RUN, 40),
    maxConcurrentRuns: num(env.TEAMBOT_MAX_CONCURRENT_RUNS, 4),
    compactAtTokens: num(env.TEAMBOT_COMPACT_AT_TOKENS, 60_000),
    maxAgentDepth: num(env.TEAMBOT_MAX_AGENT_DEPTH, 6),
    staleTaskHours: num(env.TEAMBOT_STALE_TASK_HOURS, 4),
    mcpConfigPath: path.resolve(ROOT, env.TEAMBOT_MCP_CONFIG ?? 'mcp.json'),
    publicUrl: (env.TEAMBOT_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    webDist: path.join(ROOT, 'apps', 'web', 'dist'),
    offlineModels: env.TEAMBOT_OFFLINE_MODELS === '1',
    ...overrides,
  };
  return cfg;
}
