// Composition root: wires the services together. Tests build an App with fakes for models and computers.
import fs from 'node:fs';
import path from 'node:path';
import { SlackBridge, type SlackApi, type SlackDownload } from './bridges/slack.js';
import { TelegramBridge, type TelegramApi, type TelegramDownload } from './bridges/telegram.js';
import { Bus } from './bus.js';
import { EgressProxy } from './egress.js';
import type { Config } from './config.js';
import { DockerComputers } from './computers/docker.js';
import type { ComputerProvider } from './computers/types.js';
import { MemoryStore } from './memory.js';
import { OpenRouterProvider } from './models/openrouter.js';
import { EchoProvider } from './models/scripted.js';
import type { ModelProvider } from './models/types.js';
import { PolicyManager } from './policy.js';
import { Budgets } from './runtime/budget.js';
import { CronScheduler } from './runtime/cron.js';
import { Handoffs } from './runtime/handoffs.js';
import { ComputerLifecycle } from './runtime/lifecycle.js';
import { Triggers } from './runtime/triggers.js';
import { Runtime } from './runtime/runtime.js';
import { SkillStore } from './skills.js';
import { Snapshots } from './snapshots.js';
import { Store } from './store.js';
import { Telemetry } from './telemetry.js';
import { McpManager } from './tools/mcp.js';
import { Auth } from './auth.js';
import { ToolRegistry } from './tools/registry.js';
import { Vault } from './vault.js';
import { Workspace } from './workspace.js';

export interface App {
  cfg: Config;
  store: Store;
  bus: Bus;
  vault: Vault;
  policy: PolicyManager;
  models: ModelProvider;
  computers: ComputerProvider;
  mcp: McpManager;
  auth: Auth;
  tools: ToolRegistry;
  workspace: Workspace;
  runtime: Runtime;
  handoffs: Handoffs;
  cron: CronScheduler;
  budgets: Budgets;
  skills: SkillStore;
  memory: MemoryStore;
  lifecycle: ComputerLifecycle;
  telegram: TelegramBridge;
  slack: SlackBridge;
  telemetry: Telemetry;
  egress: EgressProxy;
  snapshots: Snapshots;
  triggers: Triggers;
}

export interface AppOverrides {
  models?: ModelProvider;
  computers?: ComputerProvider;
  masterKey?: Buffer;
  /** A fake Telegram Bot API for tests. */
  telegram?: { api: TelegramApi; download?: TelegramDownload };
  /** A fake Slack Web API for tests. */
  slack?: { api: SlackApi; download?: SlackDownload };
  telemetry?: ConstructorParameters<typeof Telemetry>[1];
  /** Fake mail and calendar sources for tests. */
  triggers?: ConstructorParameters<typeof Triggers>[1];
}

export function createApp(cfg: Config, overrides: AppOverrides = {}): App {
  if (cfg.dbPath !== ':memory:') fs.mkdirSync(cfg.sharedDir, { recursive: true });
  const store = new Store(cfg.dbPath);
  const bus = new Bus(store);
  const vault = new Vault(store, { dataDir: cfg.dataDir, masterKey: overrides.masterKey });
  const mcp = new McpManager(cfg.mcpConfigPath, vault, store, bus, cfg.publicUrl || `http://localhost:${cfg.port}`);

  const app = {
    cfg,
    store,
    bus,
    vault,
    mcp,
    policy: new PolicyManager(store, bus),
    models: overrides.models ?? (cfg.offlineModels ? new EchoProvider() : new OpenRouterProvider(() => cfg.openrouterKey)),
    computers: overrides.computers ?? new DockerComputers(cfg, vault, bus),
    tools: new ToolRegistry(mcp, () => app),
    skills: new SkillStore(path.join(cfg.dataDir, 'skills')),
    memory: new MemoryStore(path.join(cfg.dataDir, 'memory')),
  } as App;
  app.workspace = new Workspace(app);
  app.budgets = new Budgets(app);
  app.runtime = new Runtime(app);
  app.handoffs = new Handoffs(app);
  app.cron = new CronScheduler(app);
  app.lifecycle = new ComputerLifecycle(app);
  app.telegram = new TelegramBridge(app, overrides.telegram);
  app.slack = new SlackBridge(app, overrides.slack);
  app.telemetry = new Telemetry(app, overrides.telemetry);
  app.egress = new EgressProxy(app);
  app.snapshots = new Snapshots(app);
  app.triggers = new Triggers(app, overrides.triggers);
  app.auth = new Auth(app);

  seed(app);
  return app;
}

/** First boot: the owner and #general. */
function seed(app: App) {
  if (app.store.listHumans().length) return;
  const owner = app.store.createHuman(app.cfg.userName, 'owner');
  app.store.createChannel({ name: 'general', kind: 'channel', topic: 'Everyone, humans and agents', memberIds: [owner.id] });
}

export async function startApp(app: App) {
  app.telemetry.start();
  await app.mcp.start();
  app.runtime.start();
  app.cron.start();
  app.lifecycle.start();
  app.egress.start();
  app.triggers.start();
  // Not awaited: an unreachable Telegram must not hold up startup.
  void app.telegram.start().catch((err) => console.error('telegram bridge failed to start', err));
  void app.slack.start().catch((err) => console.error('slack bridge failed to start', err));
}

export async function stopApp(app: App) {
  await app.telegram.stop();
  await app.slack.stop();
  await app.egress.stop();
  app.triggers.stop();
  app.lifecycle.stop();
  app.cron.stop();
  await app.runtime.stop();
  await app.mcp.stop();
  await app.telemetry.stop();
  app.store.close();
}
