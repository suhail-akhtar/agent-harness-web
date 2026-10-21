import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock, writeFileAtomic } from './shared-file.ts';

// Leases for servers that share one data folder: "this server drives session X",
// "this server runs the schedules". A lease is a small file in <data>/leases,
// created atomically (O_EXCL), naming its holder and the address others reach it
// at, with a heartbeat the holder rewrites every third of the lease time. A lease
// whose heartbeat is older than the lease time belongs to a server that crashed
// or lost the share, and another may take it over. Clocks are compared across
// servers: keep them in sync (NTP); the lease time (30 s) dwarfs normal drift.
//
// Every change of an existing lease file - a takeover, a heartbeat, a release - is
// made under one short lock (<lease>.lock, O_EXCL, see withFileLock) and only after
// checking the file's random token is still the one this server last wrote: a
// heartbeat can never overwrite a takeover that landed a moment earlier, nor bring
// back a lease just released.

export interface LeaseRecord {
  /** The holding server's id (HARNESS_NODE_ID). */
  owner: string;
  /** Where that server can be reached directly (HARNESS_NODE_URL), for forwarding. */
  url?: string;
  /** HMAC of owner and url under the cluster secret: the address was written by a server that knows it. */
  sig?: string;
  host: string;
  pid: number;
  /** When it was taken. */
  since: number;
  /** The last heartbeat (the holder's clock). */
  beat: number;
  /** Random, new with every write: whoever wrote it last. */
  token?: string;
}

export type Acquired = { ok: true; /** It was not already held by this server. */ fresh: boolean } | { ok: false; holder: LeaseRecord };

const safe = (name: string) => name.replace(/[^\w.-]/g, '_').slice(0, 120);
const newToken = () => crypto.randomBytes(12).toString('hex');

/** The signature a lease carries for its address (see LeaseRecord.sig). */
export function leaseUrlSig(secret: string, owner: string, url: string): string {
  return crypto.createHmac('sha256', secret).update(`harness-lease-url\n${owner}\n${url}`).digest('base64url');
}

export class Leases {
  readonly dir: string;
  readonly owner: string;
  readonly url?: string;
  readonly ttlMs: number;
  private held = new Map<string, { since: number; token: string; onLost?: () => void }>();
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;
  private secret?: string;

  constructor(dir: string, o: { owner: string; url?: string; ttlMs?: number; now?: () => number; log?: (m: string) => void; secret?: string }) {
    this.dir = dir;
    this.owner = o.owner;
    this.url = o.url;
    this.ttlMs = o.ttlMs ?? 30_000;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
    this.secret = o.secret;
  }

  private file(name: string): string { return path.join(this.dir, `${safe(name)}.lease`); }

  /** Runs `fn` holding the lease's lock (short: a read and a rename). */
  private locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.file(name), fn, { staleMs: Math.max(2000, this.ttlMs), waitMs: Math.max(5000, this.ttlMs * 2) });
  }

  /** Starts the heartbeat (every third of the lease time). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.renewAll(); }, Math.max(200, Math.floor(this.ttlMs / 3)));
    this.timer.unref();
  }

  async read(name: string): Promise<LeaseRecord | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as LeaseRecord; } catch { return undefined; }
  }

  live(r: LeaseRecord | undefined): r is LeaseRecord { return !!r && this.now() - r.beat < this.ttlMs; }

  /** The live holder of a lease, or undefined when nobody holds it (or the holder stopped beating). */
  async holder(name: string): Promise<LeaseRecord | undefined> {
    const r = await this.read(name);
    return this.live(r) ? r : undefined;
  }

  /** Another server's live hold on this lease, or undefined (free, stale, or ours). */
  async heldElsewhere(name: string): Promise<LeaseRecord | undefined> {
    const r = await this.holder(name);
    return r && r.owner !== this.owner ? r : undefined;
  }

  holds(name: string): boolean { return this.held.has(name); }

  private record(since: number, token: string): LeaseRecord {
    return {
      owner: this.owner, ...(this.url ? { url: this.url } : {}), ...(this.url && this.secret ? { sig: leaseUrlSig(this.secret, this.owner, this.url) } : {}),
      host: os.hostname(), pid: process.pid, since, beat: this.now(), token,
    };
  }

  /**
   * Takes the lease, or renews it when this server holds it. Fails with the holder
   * when another server holds it and is alive. `onLost` runs if the lease is later
   * found taken over (this server stopped beating long enough for another to take it).
   */
  async acquire(name: string, onLost?: () => void): Promise<Acquired> {
    const f = this.file(name);
    await fs.mkdir(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt++) {
      const mine = this.held.get(name);
      if (mine) {
        if (await this.renew(name)) { if (onLost) mine.onLost = onLost; return { ok: true, fresh: false }; }
        continue; // lost it: try to take it again
      }
      // Free: created atomically, so of two servers at once one gets it.
      try {
        const h = await fs.open(f, 'wx');
        const since = this.now();
        const token = newToken();
        try { await h.writeFile(JSON.stringify(this.record(since, token))); } finally { await h.close(); }
        this.held.set(name, { since, token, onLost });
        return { ok: true, fresh: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // Held: taken over (under the lock, on the file as it is now) when stale or left by
      // an earlier run of this same server; a holder that beat in the meantime keeps it.
      const r = await this.locked(name, async (): Promise<Acquired | undefined> => {
        const cur = await this.read(name);
        if (!cur) return undefined; // released or half-written a moment ago
        if (this.live(cur) && cur.owner !== this.owner) return { ok: false, holder: cur };
        const since = this.now();
        const token = newToken();
        await writeFileAtomic(f, JSON.stringify(this.record(since, token)));
        this.held.set(name, { since, token, onLost });
        if (cur.owner !== this.owner) this.log(`lease ${name}: took over from ${cur.owner} (last heartbeat ${Math.round((this.now() - cur.beat) / 1000)}s ago)`);
        return { ok: true, fresh: true };
      });
      if (r) return r;
    }
    const r = await this.read(name);
    return r ? { ok: false, holder: r } : { ok: false, holder: this.record(this.now(), '') };
  }

  /**
   * Rewrites the heartbeat - a new file with a fresh token, renamed over the lease -
   * only while the token on disk is still the one this server wrote, under the lease's
   * lock. False (and the lease forgotten) when another server holds it now.
   */
  async renew(name: string): Promise<boolean> {
    const mine = this.held.get(name);
    if (!mine) return false;
    return this.locked(name, async () => {
      // Released (or renewed into a new hold) while this waited for the lock.
      if (this.held.get(name) !== mine) return false;
      const r = await this.read(name);
      if (!r || r.owner !== this.owner || r.since !== mine.since || (r.token !== undefined && r.token !== mine.token)) {
        this.held.delete(name);
        if (r) { this.log(`lease ${name}: lost to ${r.owner}`); mine.onLost?.(); }
        return false;
      }
      const token = newToken();
      await writeFileAtomic(this.file(name), JSON.stringify(this.record(mine.since, token)));
      mine.token = token;
      return true;
    });
  }

  async renewAll(): Promise<void> {
    for (const name of [...this.held.keys()]) await this.renew(name).catch(() => {});
  }

  /** Gives the lease up (only if this server still holds it: the token on disk is ours). */
  async release(name: string): Promise<void> {
    const mine = this.held.get(name);
    if (!mine) return;
    this.held.delete(name);
    const drop = async () => {
      const r = await this.read(name);
      if (r && r.owner === this.owner && r.since === mine.since && (r.token === undefined || r.token === mine.token)) await fs.rm(this.file(name), { force: true });
    };
    // The lock could not be had (a very slow share): still give the lease up if the file is ours,
    // rather than leave it for others to wait out.
    await this.locked(name, drop).catch(() => drop());
  }

  /** Stops beating and gives up every lease (a clean shutdown). */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const name of [...this.held.keys()]) await this.release(name).catch(() => {});
  }

  /** Stops beating without releasing anything (a crash, for tests). */
  halt(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.held.clear();
  }
}

/**
 * The cluster settings: HARNESS_CLUSTER=1 turns them on. `secret` (HARNESS_CLUSTER_SECRET)
 * lets servers pass requests to each other (signed, see app.ts); `peers`
 * (HARNESS_CLUSTER_PEERS) lists the only addresses they are passed to.
 */
export interface ClusterConfig { id: string; url?: string; leaseTtlMs: number; secret?: string; peers?: string[] }

export function clusterFromEnv(env: NodeJS.ProcessEnv = process.env): ClusterConfig | undefined {
  if (env.HARNESS_CLUSTER !== '1') return undefined;
  const id = (env.HARNESS_NODE_ID?.trim() || `${os.hostname()}-${process.env.HARNESS_PORT ?? '4310'}`).replace(/[^\w.-]/g, '_').slice(0, 64);
  const url = (env.HARNESS_NODE_URL ?? '').trim().replace(/\/+$/, '') || undefined;
  if (url && !/^https?:\/\//.test(url)) throw new Error('HARNESS_NODE_URL must be an http(s) URL');
  const ttl = Number(env.HARNESS_LEASE_SECONDS ?? 30);
  if (!(ttl >= 3 && ttl <= 3600)) throw new Error('HARNESS_LEASE_SECONDS must be between 3 and 3600');
  const secret = env.HARNESS_CLUSTER_SECRET?.trim() || undefined;
  if (secret && secret.length < 32) throw new Error('HARNESS_CLUSTER_SECRET is too short: use at least 32 random characters (e.g. openssl rand -hex 32), the same on every server.');
  const peers = (env.HARNESS_CLUSTER_PEERS ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    try { return new URL(p).origin; } catch { throw new Error(`HARNESS_CLUSTER_PEERS: "${p}" is not a URL`); }
  });
  return { id, url, leaseTtlMs: ttl * 1000, ...(secret ? { secret } : {}), ...(peers.length ? { peers } : {}) };
}
