import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CatalogSpec, DocSpec, QueryResult } from '../../packages/plugin-ui/src/bi.ts';
import { ArtifactError, type ArtifactMeta, ArtifactStore } from '../core/artifacts.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { DataError } from './engine.ts';

// A person's data folder (<data>/data/<account>/): the catalog (sources, datasets, models) and every
// dashboard and report are versioned artifacts here (the artifact store, so versions, history and
// restore come with them); extracts, refresh state, the op log and exports sit beside them.

export const CATALOG_ID = 'catalog';
export const DOC_ID = /^(dash|rep)-[a-z0-9]{6,12}$/;
const KEEP_VERSIONS = 300;

export interface DatasetState {
  file?: string; at?: number; rows?: number; hash?: string; ms?: number; error?: string; errorAt?: number;
  /** The dataset's own columns (after its steps and SQL), for checking fields. */
  columns?: Array<{ name: string; type: string }>;
  /** The extract's columns (before steps). */
  sourceColumns?: Array<{ name: string; type: string }>;
  lastAuto?: number;
  incremental?: { cutoff: string; replaced: number };
}
export interface HomeState {
  datasets: Record<string, DatasetState>;
  docs: Record<string, { lastRefresh?: number; lastAuto?: number; alerts?: Record<string, { state: 'ok' | 'firing'; value: number | null; at: number }>; subs?: Record<string, number> }>;
}
export interface OpLogEntry { seq: number; at: number; target: string; from: number; to: number; by: string; session?: string; ops: string[]; kind: 'ops' | 'undo' | 'redo' | 'restore'; of?: number }

export class DataHome {
  readonly dir: string;
  readonly store: ArtifactStore;
  private lock = Promise.resolve();
  readonly owner: string | undefined;
  constructor(owner: string | undefined, root: string) {
    this.owner = owner;
    this.dir = path.join(root, owner ? owner.replace(/[^A-Za-z0-9_-]/g, '_') : 'operator');
    this.store = new ArtifactStore(this.dir, { keep: KEEP_VERSIONS });
  }
  /** One change at a time per person (op batches, refresh state). */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
  path(...p: string[]) { return path.join(this.dir, ...p); }

  async catalog(): Promise<{ spec: CatalogSpec; version: number }> {
    const m = await this.store.meta(CATALOG_ID);
    if (!m) return { spec: { sources: [], datasets: [], models: [] }, version: 0 };
    const r = await this.store.get(CATALOG_ID);
    return { spec: JSON.parse(r.data.toString('utf8')) as CatalogSpec, version: m.version };
  }
  async doc(id: string, version?: number): Promise<{ spec: DocSpec; version: number; meta: ArtifactMeta }> {
    if (!DOC_ID.test(id)) throw new DataError(`no document "${id}" (ids look like dash-xxxxxx or rep-xxxxxx)`, 404);
    try {
      const r = await this.store.get(id, version);
      return { spec: JSON.parse(r.data.toString('utf8')) as DocSpec, version: r.v.n, meta: r.meta };
    } catch (e) { if (e instanceof ArtifactError) throw new DataError(e.message.replace('artifact', 'document'), e.status); throw e; }
  }
  async docs(): Promise<ArtifactMeta[]> { return (await this.store.list()).filter((m) => DOC_ID.test(m.id)); }
  async versionOf(target: string): Promise<number> { return (await this.store.meta(target))?.version ?? 0; }
  async content(target: string, version: number): Promise<string> { return (await this.store.get(target, version)).data.toString('utf8'); }

  /** Writes a new version of a target (the catalog or a document). */
  async write(target: string, spec: unknown, title: string, action: 'create' | 'rewrite' = 'rewrite'): Promise<number> {
    const content = JSON.stringify(spec, null, 1);
    await fs.mkdir(this.dir, { recursive: true });
    if (action === 'create' || !(await this.store.meta(target))) return (await this.store.create({ id: target, title, kind: 'json', content })).version;
    return (await this.store.rewrite(target, content, title)).version;
  }
  async remove(target: string): Promise<void> {
    const d = path.join(this.store.root, target);
    if (!DOC_ID.test(target)) throw new DataError('only documents are deleted');
    await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  async state(): Promise<HomeState> {
    const s = await readJson<HomeState>(this.path('state.json'), { datasets: {}, docs: {} });
    return { datasets: s.datasets ?? {}, docs: s.docs ?? {} };
  }
  async updateState(fn: (s: HomeState) => void): Promise<HomeState> {
    await fs.mkdir(this.dir, { recursive: true });
    return withFileLock(this.path('state.json'), async () => {
      const s = await this.state();
      fn(s);
      await writeFileAtomic(this.path('state.json'), JSON.stringify(s, null, 1));
      return s;
    });
  }

  async log(): Promise<OpLogEntry[]> {
    const text = await fs.readFile(this.path('oplog.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as OpLogEntry; } catch { return undefined; } }).filter((x): x is OpLogEntry => !!x);
  }
  async append(e: Omit<OpLogEntry, 'seq' | 'at'>): Promise<OpLogEntry> {
    await fs.mkdir(this.dir, { recursive: true });
    const all = await this.log();
    const entry: OpLogEntry = { ...e, seq: (all.at(-1)?.seq ?? 0) + 1, at: Date.now() };
    await fs.appendFile(this.path('oplog.jsonl'), `${JSON.stringify(entry)}\n`);
    return entry;
  }
  async runs(limit = 200): Promise<Array<Record<string, unknown>>> {
    const text = await fs.readFile(this.path('runs.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l) as Record<string, unknown>).reverse();
  }
  async recordRun(r: Record<string, unknown>): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.path('runs.jsonl'), `${JSON.stringify({ at: Date.now(), ...r })}\n`);
  }
  async usage(): Promise<Record<string, { views: number; last: number; days: Record<string, number> }>> { return readJson(this.path('usage.json'), {}); }
  async countView(doc: string, via: 'app' | 'published'): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await withFileLock(this.path('usage.json'), async () => {
      const u = await this.usage();
      const day = new Date().toISOString().slice(0, 10);
      const e = (u[doc] ??= { views: 0, last: 0, days: {} });
      e.views++; e.last = Date.now(); e.days[day] = (e.days[day] ?? 0) + 1;
      (e as Record<string, unknown>)[via] = (((e as Record<string, unknown>)[via] as number) ?? 0) + 1;
      for (const k of Object.keys(e.days).sort().slice(0, -90)) delete e.days[k];
      await writeFileAtomic(this.path('usage.json'), JSON.stringify(u));
    });
  }
}

export const newId = (prefix: string) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
export type { QueryResult };
