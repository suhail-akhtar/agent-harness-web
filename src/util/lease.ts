import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './shared-file.ts';

// Leases for servers that share one data folder: "this server drives session X",
// "this server runs the schedules". A lease is a small file in <data>/leases,
// created atomically (O_EXCL), naming its holder and the address others reach it
// at, with a heartbeat the holder rewrites every third of the lease time. A lease
// whose heartbeat is older than the lease time belongs to a server that crashed
// or lost the share, and another may take it over. Clocks are compared across
// servers: keep them in sync (NTP); the lease time (30 s) dwarfs normal drift.

export interface LeaseRecord {
  /** The holding server's id (HARNESS_NODE_ID). */
  owner: string;
  /** Where that server can be reached directly (HARNESS_NODE_URL), for forwarding. */
  url?: string;
  host: string;
  pid: number;
  /** When it was taken. */
  since: number;
  /** The last heartbeat (the holder's clock). */
  beat: number;
}

export type Acquired = { ok: true; /** It was not already held by this server. */ fresh: boolean } | { ok: false; holder: LeaseRecord };

const safe = (name: string) => name.replace(/[^\w.-]/g, '_').slice(0, 120);

export class Leases {
  readonly dir: string;
  readonly owner: string;
  readonly url?: string;
  readonly ttlMs: number;
  private held = new Map<string, { since: number; onLost?: () => void }>();
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private log: (m: string) => void;

  constructor(dir: string, o: { owner: string; url?: string; ttlMs?: number; now?: () => number; log?: (m: string) => void }) {
    this.dir = dir;
    this.owner = o.owner;
    this.url = o.url;
    this.ttlMs = o.ttlMs ?? 30_000;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  private file(name: string): string { return path.join(this.dir, `${safe(name)}.lease`); }

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

  private record(since = this.now()): LeaseRecord {
    return { owner: this.owner, ...(this.url ? { url: this.url } : {}), host: os.hostname(), pid: process.pid, since, beat: this.now() };
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
      try {
        const h = await fs.open(f, 'wx');
        const since = this.now();
        try { await h.writeFile(JSON.stringify(this.record(since))); } finally { await h.close(); }
        this.held.set(name, { since, onLost });
        return { ok: true, fresh: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const r = await this.read(name);
      if (!r) continue; // released or half-written a moment ago
      if (this.live(r) && r.owner !== this.owner) return { ok: false, holder: r };
      // Stale, or left by an earlier run of this same server: break it. The rename makes
      // two breakers safe (one wins); a holder that beat in between keeps it.
      const gone = `${f}.${crypto.randomBytes(4).toString('hex')}.stale`;
      if (!(await fs.rename(f, gone).then(() => true, () => false))) continue;
      const took = await fs.readFile(gone, 'utf8').then((t) => JSON.parse(t) as LeaseRecord, () => undefined);
      if (took && took.beat !== r.beat && this.live(took) && took.owner !== this.owner) {
        // It came back to life between our read and the rename: give it back.
        await fs.rename(gone, f).catch(() => {});
        return { ok: false, holder: took };
      }
      await fs.rm(gone, { force: true }).catch(() => {});
      this.log(`lease ${name}: took over from ${r.owner} (last heartbeat ${Math.round((this.now() - r.beat) / 1000)}s ago)`);
    }
    const r = await this.read(name);
    return r ? { ok: false, holder: r } : { ok: false, holder: this.record() };
  }

  /** Rewrites the heartbeat; false (and the lease forgotten) when another server holds it now. */
  async renew(name: string): Promise<boolean> {
    const mine = this.held.get(name);
    if (!mine) return false;
    const r = await this.read(name);
    if (!r || r.owner !== this.owner || r.since !== mine.since) {
      this.held.delete(name);
      if (r) { this.log(`lease ${name}: lost to ${r.owner}`); mine.onLost?.(); }
      return false;
    }
    await writeFileAtomic(this.file(name), JSON.stringify({ ...r, beat: this.now() })).catch(() => {});
    return true;
  }

  async renewAll(): Promise<void> {
    for (const name of [...this.held.keys()]) await this.renew(name).catch(() => {});
  }

  /** Gives the lease up (only if this server still holds it). */
  async release(name: string): Promise<void> {
    const mine = this.held.get(name);
    if (!mine) return;
    this.held.delete(name);
    const r = await this.read(name);
    if (r && r.owner === this.owner && r.since === mine.since) {
      // Renamed away first, so a holder that took it over a moment ago is never removed.
      const gone = `${this.file(name)}.${crypto.randomBytes(4).toString('hex')}.released`;
      if (await fs.rename(this.file(name), gone).then(() => true, () => false)) {
        const t = await fs.readFile(gone, 'utf8').then((x) => JSON.parse(x) as LeaseRecord, () => undefined);
        if (t && (t.owner !== this.owner || t.since !== mine.since)) await fs.rename(gone, this.file(name)).catch(() => {});
        else await fs.rm(gone, { force: true }).catch(() => {});
      }
    }
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

/** The cluster settings: HARNESS_CLUSTER=1 turns them on. */
export interface ClusterConfig { id: string; url?: string; leaseTtlMs: number }

export function clusterFromEnv(env: NodeJS.ProcessEnv = process.env): ClusterConfig | undefined {
  if (env.HARNESS_CLUSTER !== '1') return undefined;
  const id = (env.HARNESS_NODE_ID?.trim() || `${os.hostname()}-${process.env.HARNESS_PORT ?? '4310'}`).replace(/[^\w.-]/g, '_').slice(0, 64);
  const url = (env.HARNESS_NODE_URL ?? '').trim().replace(/\/+$/, '') || undefined;
  if (url && !/^https?:\/\//.test(url)) throw new Error('HARNESS_NODE_URL must be an http(s) URL');
  const ttl = Number(env.HARNESS_LEASE_SECONDS ?? 30);
  if (!(ttl >= 3 && ttl <= 3600)) throw new Error('HARNESS_LEASE_SECONDS must be between 3 and 3600');
  return { id, url, leaseTtlMs: ttl * 1000 };
}
