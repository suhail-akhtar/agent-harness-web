import crypto from 'node:crypto';
import path from 'node:path';
import { FileWatch, readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';

// Accounts for a shared server. Without any accounts the server is
// single-user, as before: whoever holds HARNESS_TOKEN. With accounts, each
// person signs in with their own token; members see only their own sessions,
// companions and memory; administrators see everything and manage accounts.
// Tokens are shown once and stored only as hashes. With single sign-on, an
// account is also made for each person the identity provider vouches for,
// keyed by issuer and subject (an e-mail address can be reassigned; those are not).

export type Role = 'admin' | 'member';
export interface SsoIdentity { iss: string; sub: string; email: string }
export interface User { id: string; name: string; role: Role; tokenHash: string; createdAt: number; disabled?: boolean; sso?: SsoIdentity }
export interface PublicUser { id: string; name: string; role: Role; createdAt: number; disabled?: boolean; sso?: SsoIdentity }

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class UserStore {
  private file: string;
  private users = new Map<string, User>();
  private byHash = new Map<string, string>();
  private watch: FileWatch;

  constructor(dataDir: string) { this.file = path.join(dataDir, 'users.json'); this.watch = new FileWatch(this.file); }

  async load(): Promise<this> {
    await this.reload();
    return this;
  }

  private async reload(): Promise<void> {
    const list = await readJson<User[]>(this.file, []);
    this.users = new Map();
    this.byHash = new Map();
    for (const u of Array.isArray(list) ? list : []) { this.users.set(u.id, u); this.byHash.set(u.tokenHash, u.id); }
    await this.watch.mark();
  }

  /**
   * Reads the accounts again when the file changed on disk: another server sharing the
   * data folder (or `npm run users`) added, disabled or removed one. At most once a second.
   */
  async refresh(): Promise<void> {
    if (await this.watch.changed()) await this.reload();
  }

  /**
   * A change made under the file's lock, to the accounts as they are on disk now, then
   * written atomically: changes from several servers never overwrite each other.
   */
  private async mutate<T>(fn: () => T): Promise<T> {
    return withFileLock(this.file, async () => {
      await this.reload();
      const r = fn();
      await writeFileAtomic(this.file, JSON.stringify([...this.users.values()], null, 1), { mode: 0o600 });
      await this.watch.mark();
      return r;
    });
  }

  get size(): number { return this.users.size; }

  list(): PublicUser[] {
    return [...this.users.values()].map(({ tokenHash: _h, ...u }) => u);
  }

  get(id: string): PublicUser | undefined {
    const u = this.users.get(id);
    if (!u) return undefined;
    const { tokenHash: _h, ...rest } = u;
    return rest;
  }

  private taken(name: string): boolean { return [...this.users.values()].some((u) => u.name.toLowerCase() === name.toLowerCase()); }

  /** The account of a single sign-on identity, disabled or not (so the caller can say why it is refused). */
  bySso(iss: string, sub: string): PublicUser | undefined {
    for (const u of this.users.values()) if (u.sso?.iss === iss && u.sso.sub === sub) return this.get(u.id);
    return undefined;
  }

  /** Finds or creates the account of a verified identity, keeping its e-mail address and role current. */
  async signInSso(id: SsoIdentity, role: Role): Promise<PublicUser> {
    const known = [...this.users.values()].find((u) => u.sso?.iss === id.iss && u.sso.sub === id.sub);
    if (known && known.role === role && known.sso!.email === id.email) return this.get(known.id)!;
    return this.mutate(() => {
      const found = [...this.users.values()].find((u) => u.sso?.iss === id.iss && u.sso.sub === id.sub);
      if (found) {
        found.role = role;
        found.sso = { ...id };
        return this.get(found.id)!;
      }
      let name = id.email.slice(0, 60);
      for (let n = 2; this.taken(name); n++) name = `${id.email.slice(0, 54)} (${n})`;
      // No personal token: the hash is of a random value nobody is given. An administrator can still rotate one.
      const u: User = { id: `usr_${crypto.randomBytes(6).toString('hex')}`, name, role, tokenHash: hash(`sso_${crypto.randomBytes(24).toString('base64url')}`), createdAt: Date.now(), sso: { ...id } };
      this.users.set(u.id, u);
      this.byHash.set(u.tokenHash, u.id);
      return this.get(u.id)!;
    });
  }

  /** Creates an account; the token is returned once and never stored. */
  async add(name: string, role: Role = 'member'): Promise<{ user: PublicUser; token: string }> {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('a name is required');
    return this.mutate(() => {
      if (this.taken(clean)) throw new Error(`an account named "${clean}" exists`);
      const id = `usr_${crypto.randomBytes(6).toString('hex')}`;
      const token = `hwu_${crypto.randomBytes(24).toString('base64url')}`;
      const u: User = { id, name: clean, role, tokenHash: hash(token), createdAt: Date.now() };
      this.users.set(id, u);
      this.byHash.set(u.tokenHash, id);
      return { user: this.get(id)!, token };
    });
  }

  /** A new token for an account (the old one stops working). */
  async rotate(id: string): Promise<string> {
    return this.mutate(() => {
      const u = this.users.get(id);
      if (!u) throw new Error('no such account');
      this.byHash.delete(u.tokenHash);
      const token = `hwu_${crypto.randomBytes(24).toString('base64url')}`;
      u.tokenHash = hash(token);
      this.byHash.set(u.tokenHash, id);
      return token;
    });
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    const u = this.users.get(id);
    if (u && !disabled && u.disabled === undefined) return;
    await this.mutate(() => {
      const v = this.users.get(id);
      if (!v) throw new Error('no such account');
      if (disabled) v.disabled = true; else delete v.disabled;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(() => {
      const u = this.users.get(id);
      if (!u) return false;
      this.users.delete(id);
      this.byHash.delete(u.tokenHash);
      return true;
    });
  }

  /** The account a token belongs to (disabled accounts are refused). */
  byToken(token: string): PublicUser | undefined {
    if (!token.startsWith('hwu_')) return undefined;
    const id = this.byHash.get(hash(token));
    const u = id ? this.get(id) : undefined;
    return u && !u.disabled ? u : undefined;
  }
}

/**
 * Requests per minute per key, as a token bucket: bursts up to the limit,
 * refilled evenly. Returns how long to wait when over.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private perMinute: number;
  constructor(perMinute: number) { this.perMinute = perMinute; }
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterSec: number } {
    if (!(this.perMinute > 0)) return { ok: true };
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return { ok: false, retryAfterSec: Math.ceil(((1 - b.tokens) / this.perMinute) * 60) };
    b.tokens -= 1;
    return { ok: true };
  }
}

/**
 * What one account may have going at once (0 = no limit): turns and workflow runs
 * running (HARNESS_USER_MAX_RUNNING, default 4) and sessions with a sandbox
 * container on this server (HARNESS_USER_MAX_SANDBOXES, default 8). So one person
 * cannot take every CPU, container or provider slot of a shared server. The
 * operator's own token (no account) is not limited.
 */
export interface ConcurrencyLimits { running: number; sandboxes: number }

export function concurrencyLimits(env: NodeJS.ProcessEnv = process.env): ConcurrencyLimits {
  const n = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : d);
  return { running: n(env.HARNESS_USER_MAX_RUNNING, 4), sandboxes: n(env.HARNESS_USER_MAX_SANDBOXES, 8) };
}

/** A session as the limits count it. */
export interface CountedSession { owner?: string; busy: boolean; sandbox: boolean }

/** Why the account cannot start one more (a running turn, or a sandbox session), or undefined when it can. */
export function concurrencyRefusal(what: 'running' | 'sandboxes', owner: string | undefined, sessions: CountedSession[], limits: ConcurrencyLimits = concurrencyLimits()): string | undefined {
  if (!owner) return undefined;
  const max = limits[what];
  if (!max) return undefined;
  const mine = sessions.filter((s) => s.owner === owner && (what === 'running' ? s.busy : s.sandbox)).length;
  if (mine < max) return undefined;
  return what === 'running'
    ? `This account already has ${mine} session${mine === 1 ? '' : 's'} working, the most it may run at once (${max}, HARNESS_USER_MAX_RUNNING). Wait for one to finish or stop one, then try again.`
    : `This account already has ${mine} sandbox session${mine === 1 ? '' : 's'}, the most it may keep (${max}, HARNESS_USER_MAX_SANDBOXES). Delete one it no longer needs, then try again.`;
}

/** Spend per account per day (UTC), kept on disk; a daily cap stops new and running turns. */
export class SpendLedger {
  private file: string;
  /** As last read from disk. */
  private days: Record<string, Record<string, number>> = {};
  /** Spent here and not written yet: added to what is on disk then (servers sharing the file each add theirs). */
  private pending: Record<string, Record<string, number>> = {};
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private dailyCapUsd?: number;
  private watch: FileWatch;
  constructor(dataDir: string, dailyCapUsd?: number) { this.file = path.join(dataDir, 'spend.json'); this.dailyCapUsd = dailyCapUsd; this.watch = new FileWatch(this.file); }
  async load(): Promise<this> {
    this.days = await readJson(this.file, {});
    await this.watch.mark();
    return this;
  }
  private today(at = new Date()): string { return at.toISOString().slice(0, 10); }
  add(owner: string | undefined, usd: number): void {
    if (!owner || !(usd > 0)) return;
    const d = (this.pending[owner] ??= {});
    const t = this.today();
    d[t] = (d[t] ?? 0) + usd;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 500);
    this.timer.unref?.();
  }
  /** Writes what was spent here: under the file's lock, added to what is on disk now. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.writing = this.writing.then(async () => {
      if (!Object.keys(this.pending).length) return;
      const add = this.pending;
      this.pending = {};
      try {
        await withFileLock(this.file, async () => {
          const disk = await readJson<Record<string, Record<string, number>>>(this.file, {});
          const cutoff = this.today(new Date(Date.now() - 31 * 86_400_000));
          for (const [owner, byDay] of Object.entries(add)) {
            const d = (disk[owner] ??= {});
            for (const [day, usd] of Object.entries(byDay)) d[day] = (d[day] ?? 0) + usd;
          }
          for (const d of Object.values(disk)) for (const k of Object.keys(d)) if (k < cutoff) delete d[k];
          await writeFileAtomic(this.file, JSON.stringify(disk));
          this.days = disk;
          await this.watch.mark();
        });
      } catch {
        // Not written: kept for the next try.
        for (const [owner, byDay] of Object.entries(add)) for (const [day, usd] of Object.entries(byDay)) { const d = (this.pending[owner] ??= {}); d[day] = (d[day] ?? 0) + usd; }
      }
    });
    return this.writing;
  }
  /** Reads the file again when another server sharing it wrote its spend (at most once a second). */
  async refresh(): Promise<void> {
    if (await this.watch.changed()) { this.days = await readJson(this.file, {}); await this.watch.mark(); }
  }
  spentToday(owner: string | undefined): number {
    if (!owner) return 0;
    const t = this.today();
    return (this.days[owner]?.[t] ?? 0) + (this.pending[owner]?.[t] ?? 0);
  }
  /** A message when the owner has reached today's cap, else undefined. */
  over(owner: string | undefined): string | undefined {
    if (!owner || !this.dailyCapUsd) return undefined;
    const spent = this.spentToday(owner);
    return spent >= this.dailyCapUsd ? `Stopped: this account reached its daily spend limit of $${this.dailyCapUsd.toFixed(2)} ($${spent.toFixed(2)} today). It resets at midnight UTC.` : undefined;
  }
}
