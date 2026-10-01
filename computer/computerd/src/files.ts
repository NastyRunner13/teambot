import fs from 'node:fs/promises';
import path from 'node:path';

export const HOME = process.env.HOME ?? '/home/agent';
export const WORKSPACE = path.join(HOME, 'workspace');
const MAX_READ = 200_000;

/** Relative paths are resolved against the agent's workspace; absolute paths are allowed (it's the agent's own machine). */
export function resolvePath(p: string): string {
  if (!p) return WORKSPACE;
  if (p === '~' || p.startsWith('~/')) return path.join(HOME, p.slice(1));
  return path.isAbsolute(p) ? path.normalize(p) : path.join(WORKSPACE, p);
}

export async function readFile(body: Record<string, unknown>) {
  const file = resolvePath(String(body.path ?? ''));
  const maxBytes = Math.min(Number(body.maxBytes ?? MAX_READ), 2_000_000);
  const stat = await fs.stat(file);
  if (stat.isDirectory()) throw new Error(`${file} is a directory`);
  const handle = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
    await handle.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) {
      return { path: file, size: stat.size, binary: true, content: '', truncated: false };
    }
    return { path: file, size: stat.size, binary: false, content: buf.toString('utf8'), truncated: stat.size > maxBytes };
  } finally {
    await handle.close();
  }
}

export async function writeFile(body: Record<string, unknown>) {
  const file = resolvePath(String(body.path ?? ''));
  const content = String(body.content ?? '');
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (body.append) await fs.appendFile(file, content, 'utf8');
  else await fs.writeFile(file, content, 'utf8');
  return { path: file, bytes: Buffer.byteLength(content) };
}

interface Entry {
  path: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size?: number;
}

export async function listFiles(body: Record<string, unknown>) {
  const root = resolvePath(String(body.path ?? ''));
  const maxDepth = Math.min(Math.max(Number(body.depth ?? 1), 1), 4);
  const entries: Entry[] = [];
  const LIMIT = 500;

  async function walk(dir: string, depth: number) {
    if (entries.length >= LIMIT) return;
    const items = await fs.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      if (entries.length >= LIMIT) return;
      const full = path.join(dir, item.name);
      const rel = path.relative(root, full) || item.name;
      if (item.isDirectory()) {
        entries.push({ path: rel + '/', type: 'dir' });
        const skip = item.name === 'node_modules' || item.name === '.git' || item.name.startsWith('.cache');
        if (depth < maxDepth && !skip) await walk(full, depth + 1);
      } else if (item.isFile()) {
        const st = await fs.stat(full).catch(() => undefined);
        entries.push({ path: rel, type: 'file', size: st?.size });
      } else {
        entries.push({ path: rel, type: item.isSymbolicLink() ? 'link' : 'other' });
      }
    }
  }

  await walk(root, 1);
  return { root, entries, truncated: entries.length >= LIMIT };
}
