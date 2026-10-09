// `pnpm computer:build`: build the agent computer image (computer/) under the name this version of the server uses
// by default (DEFAULT_COMPUTER_IMAGE in apps/server/src/config.ts), plus teambot/computer:latest for setups whose
// .env still names that. Extra arguments go to docker build, e.g. `pnpm computer:build --build-arg DOCUMENT_TOOLS=0`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const tags = [`ghcr.io/nastyrunner13/teambot-computer:${version}`, 'teambot/computer:latest'];

try {
  execFileSync('docker', ['build', ...tags.flatMap((t) => ['-t', t]), ...process.argv.slice(2), 'computer'], { cwd: root, stdio: 'inherit' });
} catch {
  process.exit(1);
}
console.log(`\nBuilt ${tags.join(' and ')}`);
