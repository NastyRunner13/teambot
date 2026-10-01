import { buildServer } from './api.js';
import { createApp, startApp, stopApp } from './app.js';
import { loadConfig, loadEnvFile } from './config.js';

loadEnvFile();
const cfg = loadConfig();
const app = createApp(cfg);
const server = await buildServer(app);
await startApp(app);
await server.listen({ port: cfg.port, host: cfg.host });

const health = await app.computers.available();
console.log(`\n  TeamBot is running at http://${cfg.host}:${cfg.port}\n`);
if (!cfg.openrouterKey) console.warn('  ! OPENROUTER_API_KEY is not set — agents cannot think until you add it to .env');
if (!health) console.warn('  ! Docker is not reachable — agents cannot use their computers');
else if (!(await app.computers.imageReady())) console.warn('  ! The computer image is missing — run: pnpm computer:build');
if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host) && !app.auth.teamMode) {
  console.warn(`  ! Listening on ${cfg.host} without sign-in: anyone who can reach this port controls your agents. Turn on team sign-in in Settings → Team.`);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Shutting down…');
  await server.close();
  await stopApp(app);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
