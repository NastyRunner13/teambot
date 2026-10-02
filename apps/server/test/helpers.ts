import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Agent, ComputerStatus, Run } from '@teambot/shared';
import { createApp, type App, type AppOverrides } from '../src/app.js';
import type { CallOptions, ComputerHandle, ComputerProvider, ComputerSpec } from '../src/computers/types.js';
import { loadConfig } from '../src/config.js';
import { ScriptedProvider } from '../src/models/scripted.js';

/** A pretend computer: a page with a few elements and a shell that echoes. Records every call. */
export class FakeComputers implements ComputerProvider {
  calls: { agentId: string; path: string; body: Record<string, unknown> }[] = [];
  elements: Record<number, { name: string; type: string }> = {
    1: { name: 'To', type: 'email' },
    2: { name: 'Password', type: 'password' },
    3: { name: 'Send', type: '' },
    4: { name: 'Next page', type: '' },
  };
  url = 'https://mail.example.com/compose';
  /** Element number that has keyboard focus, for desktop typing. */
  focused = 1;
  /** Set to make the next shell call hang until aborted. */
  hangShell = false;
  /** Agents whose computers were stopped. */
  stopped: string[] = [];
  /** The image each agent's computer was last started with. */
  images: Record<string, string | null | undefined> = {};
  /** The network each agent's computer was last given. */
  networks: Record<string, ComputerSpec['network']> = {};

  async available() {
    return true;
  }
  async imageReady() {
    return true;
  }
  async status(agentId: string): Promise<ComputerStatus> {
    return { agentId, state: 'running' };
  }
  async stop(agentId: string) {
    this.stopped.push(agentId);
  }
  /** Addresses that count as agent computers. */
  computerAddresses = new Set<string>();
  isComputerAddress(ip: string | undefined) {
    return !!ip && this.computerAddresses.has(ip);
  }
  /** Agents whose running commands were cancelled. */
  cancelled: string[] = [];
  async cancelWork(agentId: string) {
    this.cancelled.push(agentId);
  }
  /** Agents whose computers were deleted. */
  resets: string[] = [];
  async reset(agentId: string) {
    this.resets.push(agentId);
  }
  /** Each agent's home folder, as the fake tar bytes last written to it. */
  homes: Record<string, string> = {};
  async exportHome(agentId: string) {
    return Readable.from([Buffer.from(this.homes[agentId] ?? `home of ${agentId}`)]);
  }
  async importHome(agentId: string, tar: NodeJS.ReadableStream) {
    const chunks: Buffer[] = [];
    for await (const c of tar) chunks.push(Buffer.from(c as Buffer));
    this.homes[agentId] = Buffer.concat(chunks).toString();
  }
  async vnc() {
    return { host: '127.0.0.1', port: 5900, password: 'x' };
  }

  async ensure(agentId: string, spec: ComputerSpec = {}): Promise<ComputerHandle> {
    const self = this;
    this.images[agentId] = spec.image;
    if (spec.network !== undefined) this.networks[agentId] = spec.network;
    return {
      vnc: { host: '127.0.0.1', port: 5900, password: 'x' },
      async call<T>(p: string, body: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> {
        self.calls.push({ agentId, path: p, body });
        if (p === '/browser/describe') {
          const el = body.ref === undefined ? self.elements[1] : self.elements[Number(body.ref)];
          return { url: self.url, element: el ? { ...el, role: 'button' } : null } as T;
        }
        if (p.startsWith('/browser/')) return { url: self.url, title: 'Mail', snapshot: `snapshot after ${p}` } as T;
        if (p === '/desktop/describe') {
          // A point maps to the element numbered by its x coordinate (x=3 → "Send"); no point means the focused element.
          const el = body.x === undefined ? self.elements[self.focused] : self.elements[Number(body.x)];
          return { window: 'Mail - Chromium', url: self.url, element: el ? { ...el, role: 'button' } : null } as T;
        }
        if (p.startsWith('/desktop/')) return { image: Buffer.from(`screen after ${p}`).toString('base64'), mime: 'image/jpeg', width: 1280, height: 800 } as T;
        if (p === '/shell') {
          if (self.hangShell) {
            await new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
          }
          const failed = String(body.command).includes('exit 1');
          return { exitCode: failed ? 1 : 0, stdout: `ran: ${body.command}`, stderr: failed ? 'something broke' : '', timedOut: false, truncated: false } as T;
        }
        if (p === '/fs/write') return { path: body.path, bytes: String(body.content).length } as T;
        return {} as T;
      },
    };
  }
}

export function testApp(opts: { maxAgentDepth?: number; telegram?: AppOverrides['telegram']; slack?: AppOverrides['slack']; telemetry?: AppOverrides['telemetry']; triggers?: AppOverrides['triggers'] } = {}) {
  const models = new ScriptedProvider();
  const computers = new FakeComputers();
  const dataDir = path.join(os.tmpdir(), `teambot-test-${crypto.randomBytes(4).toString('hex')}`);
  const cfg = loadConfig({
    dbPath: ':memory:',
    dataDir,
    sharedDir: path.join(dataDir, 'shared'),
    mcpConfigPath: path.join(dataDir, 'no-mcp.json'),
    openrouterKey: 'test',
    defaultModel: 'test/model',
    utilityModel: 'test/utility',
    reviewerModel: 'test/reviewer',
    egressPorts: [19400, 19499],
    maxConcurrentRuns: 4,
    maxStepsPerRun: 20,
    maxAgentDepth: opts.maxAgentDepth ?? 6,
  });
  const app = createApp(cfg, { models, computers, masterKey: crypto.randomBytes(32), telegram: opts.telegram, slack: opts.slack, telemetry: opts.telemetry, triggers: opts.triggers });
  return { app, models, computers, owner: app.workspace.owner() };
}

export function addAgent(app: App, name: string, model = `test/${name.toLowerCase()}`) {
  const agent = app.store.createAgent({ name, role: `${name} role`, instructions: '', model, avatar: '🤖', color: '#000', mcpServers: [] });
  const general = app.store.getChannelByName('general')!;
  app.store.addMember(general.id, agent.id);
  return agent;
}

export const general = (app: App) => app.store.getChannelByName('general')!;

/** Seed persisted helpers from before spawning was removed, to test upgrade compatibility. */
export function legacyHelpers(app: App, parent: Agent, run: Run, jobs: { title: string; job: string }[], model = parent.model): Agent[] {
  return jobs.map((job, i) => {
    const helper = app.store.createAgent({
      name: `${parent.name}-h${i + 1}`, role: `Helper of ${parent.name}`, instructions: parent.instructions,
      model, avatar: parent.avatar, color: parent.color, mcpServers: parent.mcpServers, parentId: parent.id,
    });
    app.store.addInbox({
      agentId: helper.id, kind: 'helper', text: `Your job from ${parent.name}: ${job.title}\n${job.job}`,
      channelId: run.channelId, threadId: run.threadId, depth: run.depth + 1, initiator: run.initiator,
    });
    return helper;
  });
}

export const messagesIn = (app: App, channelId: string) => app.store.listMessages(channelId, { limit: 200 });
