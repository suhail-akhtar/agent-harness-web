import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentDef } from '../plugins/api.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { AgentDefError, BUILTIN_AGENTS, checkAgentDef } from './agents.ts';

// A person's own agents: specialists they made in the app, by asking an agent, or by importing an agent file
// (Claude Code's, Copilot's, Cursor's). Each has a version that goes up with every change, and its earlier
// versions are kept, so a change can be undone; saving with the version it was read at refuses a change made
// meanwhile elsewhere (two windows, two servers). One file per person under <data>/agents/.

export interface AgentRecord extends AgentDef {
  owner?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Off: kept, but in no conversation. */
  enabled: boolean;
}

/** An earlier version, kept to look at or go back to. */
export interface AgentVersion { version: number; at: number; def: AgentDef }

interface OwnerFile { agents: Record<string, AgentRecord>; history: Record<string, AgentVersion[]> }

const KEEP_VERSIONS = 20;
const MAX_AGENTS = Number(process.env.HARNESS_MAX_AGENTS ?? 100);

export class AgentStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** What the definition is, without the store's own fields. */
export const defOf = (r: AgentRecord): AgentDef => {
  const { owner: _o, version: _v, createdAt: _c, updatedAt: _u, enabled: _e, ...def } = r;
  return def;
};

export class AgentStore {
  readonly dir: string;
  constructor(dataDir: string) { this.dir = path.join(dataDir, 'agents'); }

  private file(owner: string | undefined): string {
    // An owner id as a file name: kept readable, never a path.
    const id = (owner ?? '_local').replace(/[^\w.-]/g, '_').slice(0, 80) || '_local';
    return path.join(this.dir, `${id}.json`);
  }
  private async read(owner: string | undefined): Promise<OwnerFile> {
    const f = await readJson<OwnerFile>(this.file(owner), { agents: {}, history: {} });
    return { agents: f.agents ?? {}, history: f.history ?? {} };
  }
  private async change<T>(owner: string | undefined, fn: (f: OwnerFile) => T): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.file(owner);
    return withFileLock(file, async () => {
      const f = await this.read(owner);
      const r = fn(f);
      await writeFileAtomic(file, JSON.stringify(f, null, 1), { mode: 0o600 });
      return r;
    });
  }

  /** The owner's agents, by name. */
  async list(owner: string | undefined): Promise<AgentRecord[]> {
    return Object.values((await this.read(owner)).agents).sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(owner: string | undefined, name: string): Promise<AgentRecord | undefined> {
    return (await this.read(owner)).agents[name];
  }
  /** The enabled ones, as definitions for a conversation. */
  async active(owner: string | undefined): Promise<AgentDef[]> {
    return (await this.list(owner)).filter((r) => r.enabled).map((r) => ({ ...defOf(r), owner: r.owner, version: r.version, updatedAt: r.updatedAt, source: 'user' }));
  }

  private checked(x: unknown): AgentDef {
    try {
      const def = checkAgentDef(x);
      if (BUILTIN_AGENTS.some((b) => b.name === def.name)) throw new AgentStoreError(`"${def.name}" is a built-in agent: choose another name`);
      return def;
    } catch (e) { if (e instanceof AgentDefError) throw new AgentStoreError(e.message); throw e; }
  }

  async create(owner: string | undefined, x: unknown, now = Date.now()): Promise<AgentRecord> {
    const def = this.checked(x);
    const enabled = (x as { enabled?: unknown }).enabled !== false;
    return this.change(owner, (f) => {
      if (f.agents[def.name]) throw new AgentStoreError(`you already have an agent named "${def.name}"`, 409);
      if (Object.keys(f.agents).length >= MAX_AGENTS) throw new AgentStoreError(`at most ${MAX_AGENTS} agents (HARNESS_MAX_AGENTS)`, 409);
      const r: AgentRecord = { ...def, ...(owner ? { owner } : {}), version: 1, createdAt: now, updatedAt: now, enabled };
      f.agents[def.name] = r;
      return r;
    });
  }

  /**
   * A new version. With `expectVersion`, refused (409) when it changed since that version was read. The name
   * may change (a rename keeps its history). `enabled` alone switches it on or off without a new version.
   */
  async update(owner: string | undefined, name: string, x: unknown, o: { expectVersion?: number; now?: number } = {}): Promise<AgentRecord> {
    const now = o.now ?? Date.now();
    const patch = (x ?? {}) as Record<string, unknown>;
    const onlyEnabled = Object.keys(patch).length === 1 && typeof patch.enabled === 'boolean';
    const def = onlyEnabled ? undefined : this.checked(x);
    return this.change(owner, (f) => {
      const cur = f.agents[name];
      if (!cur) throw new AgentStoreError(`no agent named "${name}"`, 404);
      if (o.expectVersion !== undefined && o.expectVersion !== cur.version) throw new AgentStoreError(`"${name}" changed since you opened it (now version ${cur.version}, you had ${o.expectVersion}): open it again`, 409);
      if (onlyEnabled) { cur.enabled = patch.enabled as boolean; return cur; }
      if (def!.name !== name && f.agents[def!.name]) throw new AgentStoreError(`you already have an agent named "${def!.name}"`, 409);
      const hist = f.history[name] ?? [];
      hist.push({ version: cur.version, at: cur.updatedAt, def: defOf(cur) });
      const next: AgentRecord = { ...def!, ...(owner ? { owner } : {}), version: cur.version + 1, createdAt: cur.createdAt, updatedAt: now, enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled };
      delete f.agents[name];
      delete f.history[name];
      f.agents[next.name] = next;
      f.history[next.name] = hist.slice(-KEEP_VERSIONS);
      return next;
    });
  }

  async remove(owner: string | undefined, name: string): Promise<boolean> {
    return this.change(owner, (f) => {
      if (!f.agents[name]) return false;
      delete f.agents[name];
      delete f.history[name];
      return true;
    });
  }

  /** Its earlier versions, newest first. */
  async versions(owner: string | undefined, name: string): Promise<AgentVersion[]> {
    return [...((await this.read(owner)).history[name] ?? [])].reverse();
  }

  /** Makes an earlier version current again, as a new version (nothing is lost). */
  async restore(owner: string | undefined, name: string, version: number, now = Date.now()): Promise<AgentRecord> {
    const old = (await this.read(owner)).history[name]?.find((v) => v.version === version);
    if (!old) throw new AgentStoreError(`"${name}" has no version ${version}`, 404);
    return this.update(owner, name, { ...old.def, name }, { now });
  }
}
