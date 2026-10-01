// Secrets are encrypted at rest (AES-256-GCM) and never shown to models. Agents reference them as
// {{secret:NAME}} in tool arguments; the gateway substitutes real values right before execution and
// scrubs them back out of tool output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.js';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const PLACEHOLDER_RE = /\{\{\s*secret:([A-Za-z0-9_]+)\s*\}\}/g;
/** Secrets TeamBot itself uses (e.g. bridge tokens). Agents never see their names and can't use them. */
export const RESERVED_PREFIX = 'TEAMBOT_';
export const isReserved = (name: string) => name.startsWith(RESERVED_PREFIX);

export class UnknownSecretError extends Error {}

export class Vault {
  private key: Buffer;
  private cache: Map<string, string> | null = null;

  constructor(
    private store: Store,
    opts: { dataDir?: string; masterKey?: Buffer },
  ) {
    this.key = opts.masterKey ?? Vault.loadOrCreateKey(opts.dataDir!);
  }

  private static loadOrCreateKey(dataDir: string): Buffer {
    const fromEnv = process.env.TEAMBOT_MASTER_KEY;
    if (fromEnv) {
      const k = Buffer.from(fromEnv, 'base64');
      if (k.length !== 32) throw new Error('TEAMBOT_MASTER_KEY must be 32 bytes, base64-encoded');
      return k;
    }
    const file = path.join(dataDir, 'master.key');
    if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    fs.mkdirSync(dataDir, { recursive: true });
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
    return k;
  }

  names(): string[] {
    return [...this.values().keys()];
  }

  /** The secrets agents may use. */
  agentNames(): string[] {
    return this.names().filter((n) => !isReserved(n));
  }

  get(name: string): string | undefined {
    return this.values().get(name);
  }

  set(name: string, value: string) {
    if (!SECRET_NAME_RE.test(name)) throw new Error('Secret names use UPPER_SNAKE_CASE, e.g. GITHUB_TOKEN');
    if (!value) throw new Error('Secret value is empty');
    // Output is scrubbed only of values this long (shorter ones would mangle ordinary text), so an agent may not use a shorter one.
    if (!isReserved(name) && value.length < 4) throw new Error('Secret values must be at least 4 characters long');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    this.store.putSecret(name, {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    });
    this.cache = null;
  }

  delete(name: string) {
    this.store.deleteSecret(name);
    this.cache = null;
  }

  private values(): Map<string, string> {
    if (this.cache) return this.cache;
    const map = new Map<string, string>();
    for (const row of this.store.getSecretRows()) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
        map.set(row.name, Buffer.concat([decipher.update(Buffer.from(row.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
      } catch {
        console.error(`secret ${row.name} could not be decrypted (master key changed?)`);
      }
    }
    this.cache = map;
    return map;
  }

  /** Deep-replace {{secret:NAME}} placeholders. Throws if a referenced secret does not exist (or, for agents, is reserved). */
  resolve<T>(value: T, opts: { forAgent?: boolean } = {}): T {
    const values = this.values();
    const visible = opts.forAgent ? this.agentNames() : [...values.keys()];
    const visit = (v: unknown): unknown => {
      if (typeof v === 'string') {
        return v.replace(PLACEHOLDER_RE, (_, name: string) => {
          const secret = opts.forAgent && isReserved(name) ? undefined : values.get(name);
          if (secret === undefined) throw new UnknownSecretError(`Unknown secret "${name}". Available: ${visible.join(', ') || 'none'}`);
          return secret;
        });
      }
      if (Array.isArray(v)) return v.map(visit);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
      return v;
    };
    return visit(value) as T;
  }

  /** Replace any secret value that appears in text with its placeholder. */
  redact(text: string): string {
    let out = text;
    for (const [name, value] of this.values()) {
      if (value.length >= 4) out = out.split(value).join(`{{secret:${name}}}`);
    }
    return out;
  }

  /** Deterministic per-purpose credential derived from the master key (computer API tokens, VNC passwords). */
  derive(purpose: string): string {
    return crypto.createHmac('sha256', this.key).update(purpose).digest('hex');
  }
}
