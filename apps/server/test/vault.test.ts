import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { Vault } from '../src/vault.js';

describe('vault', () => {
  const store = new Store(':memory:');
  const vault = new Vault(store, { masterKey: crypto.randomBytes(32) });
  vault.set('GITHUB_TOKEN', 'ghp_supersecretvalue');

  it('stores values encrypted', () => {
    const row = store.getSecretRows()[0];
    expect(row.name).toBe('GITHUB_TOKEN');
    expect(row.ciphertext).not.toContain('supersecret');
  });

  it('resolves placeholders deeply and rejects unknown ones', () => {
    expect(vault.resolve({ a: ['token={{secret:GITHUB_TOKEN}}'], b: 1 })).toEqual({ a: ['token=ghp_supersecretvalue'], b: 1 });
    expect(() => vault.resolve('{{secret:NOPE}}')).toThrow(/Unknown secret "NOPE"/);
  });

  it('redacts values from output', () => {
    expect(vault.redact('auth: ghp_supersecretvalue ok')).toBe('auth: {{secret:GITHUB_TOKEN}} ok');
  });

  it('validates names', () => {
    expect(() => vault.set('lower', 'x')).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('cannot decrypt with another key', () => {
    const other = new Vault(store, { masterKey: crypto.randomBytes(32) });
    expect(other.names()).toEqual([]);
  });
});
