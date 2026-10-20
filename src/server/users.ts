import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Accounts for a shared server. Without any accounts the server is
// single-user, as before: whoever holds HARNESS_TOKEN. With accounts, each
// person signs in with their own token; members see only their own sessions,
// companions and memory; administrators see everything and manage accounts.
// Tokens are shown once and stored only as hashes.

export type Role = 'admin' | 'member';
export interface User { id: string; name: string; role: Role; tokenHash: string; createdAt: number; disabled?: boolean }
export interface PublicUser { id: string; name: string; role: Role; createdAt: number; disabled?: boolean }

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class UserStore {
  private file: string;
  private users = new Map<string, User>();
  private byHash = new Map<string, string>();

  constructor(dataDir: string) { this.file = path.join(dataDir, 'users.json'); }

  async load(): Promise<this> {
    try {
      for (const u of JSON.parse(await fs.readFile(this.file, 'utf8')) as User[]) { this.users.set(u.id, u); this.byHash.set(u.tokenHash, u.id); }
    } catch { /* none yet */ }
    return this;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.users.values()], null, 1), { mode: 0o600 });
    await fs.rename(tmp, this.file);
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

  /** Creates an account; the token is returned once and never stored. */
  async add(name: string, role: Role = 'member'): Promise<{ user: PublicUser; token: string }> {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new Error('a name is required');
    if ([...this.users.values()].some((u) => u.name.toLowerCase() === clean.toLowerCase())) throw new Error(`an account named "${clean}" exists`);
    const id = `usr_${crypto.randomBytes(6).toString('hex')}`;
    const token = `hwu_${crypto.randomBytes(24).toString('base64url')}`;
    const u: User = { id, name: clean, role, tokenHash: hash(token), createdAt: Date.now() };
    this.users.set(id, u);
    this.byHash.set(u.tokenHash, id);
    await this.save();
    return { user: this.get(id)!, token };
  }

  /** A new token for an account (the old one stops working). */
  async rotate(id: string): Promise<string> {
    const u = this.users.get(id);
    if (!u) throw new Error('no such account');
    this.byHash.delete(u.tokenHash);
    const token = `hwu_${crypto.randomBytes(24).toString('base64url')}`;
    u.tokenHash = hash(token);
    this.byHash.set(u.tokenHash, id);
    await this.save();
    return token;
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    const u = this.users.get(id);
    if (!u) throw new Error('no such account');
    if (!disabled && u.disabled === undefined) return;
    if (disabled) u.disabled = true; else delete u.disabled;
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const u = this.users.get(id);
    if (!u) return false;
    this.users.delete(id);
    this.byHash.delete(u.tokenHash);
    await this.save();
    return true;
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

/** Spend per account per day (UTC), kept on disk; a daily cap stops new and running turns. */
export class SpendLedger {
  private file: string;
  private days: Record<string, Record<string, number>> = {};
  private timer?: NodeJS.Timeout;
  private dailyCapUsd?: number;
  constructor(dataDir: string, dailyCapUsd?: number) { this.file = path.join(dataDir, 'spend.json'); this.dailyCapUsd = dailyCapUsd; }
  async load(): Promise<this> {
    try { this.days = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { /* first run */ }
    return this;
  }
  private today(at = new Date()): string { return at.toISOString().slice(0, 10); }
  add(owner: string | undefined, usd: number): void {
    if (!owner || !(usd > 0)) return;
    const d = (this.days[owner] ??= {});
    const t = this.today();
    d[t] = (d[t] ?? 0) + usd;
    for (const k of Object.keys(d)) if (k < this.today(new Date(Date.now() - 31 * 86_400_000))) delete d[k];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { fs.writeFile(this.file, JSON.stringify(this.days)).catch(() => {}); }, 500);
    this.timer.unref?.();
  }
  spentToday(owner: string | undefined): number { return owner ? this.days[owner]?.[this.today()] ?? 0 : 0; }
  /** A message when the owner has reached today's cap, else undefined. */
  over(owner: string | undefined): string | undefined {
    if (!owner || !this.dailyCapUsd) return undefined;
    const spent = this.spentToday(owner);
    return spent >= this.dailyCapUsd ? `Stopped: this account reached its daily spend limit of $${this.dailyCapUsd.toFixed(2)} ($${spent.toFixed(2)} today). It resets at midnight UTC.` : undefined;
  }
}
