import crypto from 'node:crypto';

export const now = () => new Date().toISOString();

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} characters)`;
}

/** Glob with `*` wildcards, case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Agent and channel names: letters, numbers, dash, underscore. Lets `@Name` and `#name` parse unambiguously. */
export const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Mark text that came from outside the team (web pages, files, command output, other systems) so the
 * model treats it as data. Tag look-alikes inside the text are defused so it can't close the block early.
 */
export function untrusted(source: string, text: string): string {
  const safe = text.replace(/<(\/?)\s*untrusted_content/gi, '<$1untrusted-content');
  return `<untrusted_content source="${source.replace(/["<>\n]/g, ' ')}">\n${safe}\n</untrusted_content>`;
}

export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([A-Za-z][A-Za-z0-9_-]{0,31})/g)) out.add(m[2].toLowerCase());
  return [...out];
}
