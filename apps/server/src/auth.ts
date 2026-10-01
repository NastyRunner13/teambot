// Team sign-in. Off by default: a personal workspace on 127.0.0.1 has no logins and every human action is the owner's.
// The owner turns it on in Settings by setting a password; after that everyone signs in with name and password
// (sessions are HttpOnly cookies) and teammates join through one-time invite links. Tokens are stored hashed.
import crypto from 'node:crypto';
import type { Human, HumanRole, Invite } from '@teambot/shared';
import type { App } from './app.js';

export const SESSION_COOKIE = 'teambot_session';
export const MIN_PASSWORD = 10;
const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const DAY_MS = 86_400_000;
/** Failed sign-ins allowed per name and per address before a 15-minute pause. */
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const inDays = (days: number, from = Date.now()) => new Date(from + days * DAY_MS).toISOString();

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  const [scheme, n, r, p, salt, hash] = (stored ?? '').split('$');
  if (scheme !== 'scrypt' || !hash) {
    // Same work for unknown names, so response times don't reveal who has an account.
    crypto.scryptSync(password, 'no-such-user', SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Auth {
  private failures = new Map<string, { count: number; since: number }>();

  constructor(private app: App) {}

  get teamMode(): boolean {
    return this.app.store.getSetting('team_mode') === '1';
  }

  /** The owner sets their password and from then on everyone signs in. Returns a session for the owner. */
  enable(owner: Human, password: string): string {
    if (owner.role !== 'owner') throw new AuthError(403, 'Only the workspace owner can turn on team sign-in');
    this.checkPassword(password);
    this.app.store.setPasswordHash(owner.id, hashPassword(password));
    this.app.store.setSetting('team_mode', '1');
    return this.startSession(owner.id);
  }

  /** Back to a personal workspace: no sign-in, sessions and unused invites are dropped. Teammates stay in the roster. */
  disable() {
    this.app.store.setSetting('team_mode', '0');
    this.app.store.deleteSessions();
    this.app.store.deleteUnusedInvites();
  }

  signIn(name: string, password: string, address: string): { session: string; human: Human } {
    const keys = [`name:${name.trim().toLowerCase()}`, `addr:${address}`];
    if (keys.some((k) => this.locked(k))) throw new AuthError(429, 'Too many failed sign-ins. Try again in 15 minutes.');
    const human = this.app.store.listHumans().find((h) => h.name.toLowerCase() === name.trim().toLowerCase());
    if (!verifyPassword(password, human && this.app.store.passwordHash(human.id))) {
      for (const k of keys) this.fail(k);
      throw new AuthError(401, 'That name and password do not match');
    }
    for (const k of keys) this.failures.delete(k);
    return { session: this.startSession(human!.id), human: human! };
  }

  /** The signed-in person for a session cookie, if it is valid. Sessions slide: each day of use extends them. */
  session(sessionToken: string | undefined): Human | undefined {
    if (!sessionToken) return undefined;
    const id = sha256(sessionToken);
    const s = this.app.store.getSession(id);
    if (!s) return undefined;
    const expires = Date.parse(s.expiresAt);
    if (expires <= Date.now()) {
      this.app.store.deleteSession(id);
      return undefined;
    }
    const human = this.app.store.getHuman(s.humanId);
    if (!human || human.removed) return undefined;
    if (expires - Date.now() < (SESSION_DAYS - 1) * DAY_MS) this.app.store.extendSession(id, inDays(SESSION_DAYS));
    return human;
  }

  signOut(sessionToken: string | undefined) {
    if (sessionToken) this.app.store.deleteSession(sha256(sessionToken));
  }

  changePassword(human: Human, current: string, next: string, keepSession?: string) {
    if (!verifyPassword(current, this.app.store.passwordHash(human.id))) throw new AuthError(400, 'Your current password is not right');
    this.checkPassword(next);
    this.app.store.setPasswordHash(human.id, hashPassword(next));
    // Other devices have to sign in again.
    this.app.store.deleteSessions(human.id, keepSession ? sha256(keepSession) : undefined);
  }

  createInvite(by: Human, role: HumanRole = 'member'): { invite: Invite; token: string } {
    const t = token();
    return { invite: this.app.store.createInvite(sha256(t), role, by.id, inDays(INVITE_DAYS)), token: t };
  }

  /** What an invite link is for, without using it (for the join page). */
  inviteFor(inviteToken: string): Invite | undefined {
    const invite = this.app.store.getInviteByToken(sha256(inviteToken));
    return invite && Date.parse(invite.expiresAt) > Date.now() ? invite : undefined;
  }

  /** A new teammate picks a name and password; the invite is used up. */
  join(inviteToken: string, name: string, password: string): { session: string; human: Human } {
    if (!this.teamMode) throw new AuthError(409, 'This workspace is not accepting teammates right now');
    const invite = this.inviteFor(inviteToken);
    if (!invite) throw new AuthError(404, 'This invite link has expired or was already used. Ask for a new one.');
    const taken = this.app.store.listHumans().some((h) => h.name.toLowerCase() === name.toLowerCase()) || !!this.app.store.getAgentByName(name);
    if (taken) throw new AuthError(409, `The name ${name} is taken`);
    this.checkPassword(password);
    const human = this.app.store.tx(() => {
      const h = this.app.store.createHuman(name, invite.role);
      this.app.store.setPasswordHash(h.id, hashPassword(password));
      this.app.store.useInvite(invite.id, h.id);
      return h;
    });
    const general = this.app.store.getChannelByName('general');
    if (general) this.app.workspace.addMember(general.id, human.id, human.id);
    return { session: this.startSession(human.id), human };
  }

  private startSession(humanId: string): string {
    const t = token();
    this.app.store.createSession(sha256(t), humanId, inDays(SESSION_DAYS));
    return t;
  }

  private checkPassword(password: string) {
    if (password.length < MIN_PASSWORD) throw new AuthError(400, `Use at least ${MIN_PASSWORD} characters for the password`);
  }

  private locked(key: string): boolean {
    const f = this.failures.get(key);
    if (f && Date.now() - f.since > LOCK_MS) this.failures.delete(key);
    return (this.failures.get(key)?.count ?? 0) >= MAX_FAILURES;
  }

  private fail(key: string) {
    const f = this.failures.get(key);
    this.failures.set(key, f && Date.now() - f.since <= LOCK_MS ? { count: f.count + 1, since: f.since } : { count: 1, since: Date.now() });
  }
}

export const SESSION_MAX_AGE_S = SESSION_DAYS * 86_400;
