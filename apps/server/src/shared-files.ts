// The /shared folder as the server sees it: path checks, uploads and message attachments.
// Every agent computer mounts the same folder at /shared, so a path here is a path there.
// Agents can create links in /shared, so a path is checked where it really leads, not only by its name:
// otherwise a link to /data would let the server read or write its own files on an agent's behalf.
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, SharedFile } from '@teambot/shared';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const OUTSIDE = 'path is outside /shared';
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Absolute host path for "/shared/x", "shared/x" or "x". Throws if it escapes the folder by name. */
export function sharedPath(sharedDir: string, rel: string): string {
  const full = path.resolve(sharedDir, rel.replace(/^\/?shared\/?/, ''));
  if (!within(sharedDir, full)) throw new Error(OUTSIDE);
  return full;
}

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

function realRoot(sharedDir: string): string {
  try {
    return fs.realpathSync.native(sharedDir);
  } catch {
    return path.resolve(sharedDir);
  }
}

/** Where an existing path in /shared really is, following links; null if it doesn't exist. Throws if it leads outside. */
export function realSharedPath(sharedDir: string, rel: string): string | null {
  const full = sharedPath(sharedDir, rel);
  let real: string;
  try {
    real = fs.realpathSync.native(full);
  } catch {
    return null;
  }
  if (!within(realRoot(sharedDir), real)) throw new Error(OUTSIDE);
  return real;
}

/** After opening, check where the descriptor really points (Linux), so a folder swapped for a link mid-way is caught. */
function checkOpened(sharedDir: string, fd: number) {
  let actual: string;
  try {
    actual = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return; // no /proc (Windows, macOS): the realpath check before opening is what we have
  }
  if (!within(realRoot(sharedDir), actual)) {
    fs.closeSync(fd);
    throw new Error(OUTSIDE);
  }
}

/** Open a file in /shared for reading. Returns null if there is no such file. */
export function openSharedFile(sharedDir: string, rel: string): { fd: number; real: string; size: number } | null {
  const real = realSharedPath(sharedDir, rel);
  if (!real) return null;
  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  checkOpened(sharedDir, fd);
  const st = fs.fstatSync(fd);
  if (!st.isFile()) {
    fs.closeSync(fd);
    return null;
  }
  return { fd, real, size: st.size };
}

export const toSharedRef = (sharedDir: string, full: string) => '/shared/' + path.relative(sharedDir, full).split(path.sep).join('/');

/** Describe an existing file in /shared so a message can point at it. */
export function attachmentFor(sharedDir: string, ref: string): Attachment {
  const full = sharedPath(sharedDir, ref.trim());
  const real = realSharedPath(sharedDir, ref.trim());
  const st = real ? fs.statSync(real, { throwIfNoEntry: false }) : undefined;
  if (!st?.isFile()) throw new Error(`${ref} is not a file in /shared`);
  return { path: toSharedRef(sharedDir, full), name: path.basename(full), size: st.size };
}

const SHARED_REF = /\/shared\/[^\s`'"<>()[\]{}*,;|]+/g;

/**
 * Mark every /shared path in old text (messages, task notes) that no longer exists, so an agent reading
 * history doesn't send someone to a file that was deleted since.
 */
export function markMissingFiles(sharedDir: string, text: string): string {
  return text.replace(SHARED_REF, (match) => {
    const ref = match.replace(/[.:!?]+$/, ''); // sentence punctuation after the path
    let exists = false;
    try {
      exists = !!realSharedPath(sharedDir, ref);
    } catch {
      // It leads outside /shared: not a file anyone can use.
    }
    return exists ? match : `${ref} (not found — deleted or moved)${match.slice(ref.length)}`;
  });
}

/** Make a file name safe and readable: no folders, no control characters, nothing hidden. */
export function cleanFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return base.replace(/^\.+/, '').slice(0, 120) || 'file';
}

/** Create the folders of `folder` one by one inside /shared, refusing links and anything that isn't a folder. */
function ensureSharedDir(sharedDir: string, folder: string) {
  let cur = path.resolve(sharedDir);
  fs.mkdirSync(cur, { recursive: true, mode: 0o777 });
  for (const part of path.relative(cur, folder).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const st = fs.lstatSync(cur, { throwIfNoEntry: false });
    if (!st) {
      try {
        // Agents run as a different user than the server, so keep the shared folder writable for them.
        fs.mkdirSync(cur, { mode: 0o777 });
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
      }
      if (!fs.lstatSync(cur).isDirectory()) throw new Error(`${toSharedRef(sharedDir, cur)} is not a folder`);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`${toSharedRef(sharedDir, cur)} is not a folder`);
    }
  }
}

/** Store an upload under /shared/<dir>/, picking a free name ("report (2).pdf") instead of overwriting. */
export function saveUpload(sharedDir: string, dir: string, name: string, data: Buffer): SharedFile {
  const folder = sharedPath(sharedDir, dir);
  ensureSharedDir(sharedDir, folder);
  if (!within(realRoot(sharedDir), fs.realpathSync.native(folder))) throw new Error(OUTSIDE);
  const clean = cleanFileName(name);
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  for (let n = 1; ; n++) {
    const full = path.join(folder, n === 1 ? clean : `${stem} (${n})${ext}`);
    let fd: number;
    try {
      // "wx" never follows or replaces an existing entry, links included.
      fd = fs.openSync(full, 'wx', 0o666);
    } catch (err: any) {
      if (err?.code === 'EEXIST' && n < 10_000) continue;
      throw err;
    }
    try {
      checkOpened(sharedDir, fd);
    } catch (err) {
      fs.rmSync(full, { force: true });
      throw err;
    }
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return { path: toSharedRef(sharedDir, full), size: data.length, modifiedAt: new Date().toISOString() };
  }
}

/** Delete one file in /shared. Only regular files: a link is never followed, and folders stay. Returns false if there is no such file. */
export function deleteSharedFile(sharedDir: string, rel: string): boolean {
  const full = sharedPath(sharedDir, rel);
  if (full === path.resolve(sharedDir)) return false;
  // The folder is checked where it really leads; the name itself is looked at, not followed.
  const folder = realSharedPath(sharedDir, path.dirname(full));
  if (!folder) return false;
  const target = path.join(folder, path.basename(full));
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!st?.isFile()) return false;
  fs.unlinkSync(target);
  return true;
}

export function listShared(sharedDir: string, dir: string, limit = 1000): SharedFile[] {
  const root = realSharedPath(sharedDir, dir);
  if (!root || !fs.statSync(root).isDirectory()) return [];
  const base = realRoot(sharedDir);
  const out: SharedFile[] = [];
  // Dirents describe links as links, so the walk never follows one.
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        const st = fs.lstatSync(full);
        out.push({ path: toSharedRef(base, full), size: st.size, modifiedAt: st.mtime.toISOString() });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
