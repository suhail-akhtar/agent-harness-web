import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type CatalogSpec, type DatasetSpec, type DocSpec, type FilterSpec, IDENT, type Lineage, type ModelSpec, parseField, type QueryResult, type QuerySpec, type ResultColumn, type RoleSpec, type Scalar, type SourceSpec } from '../../packages/plugin-ui/src/bi.ts';
import { nextCron } from '../core/scheduler.ts';
import type { EventHub } from '../kernel/events.ts';
import type { Leases } from '../util/lease.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import type { VaultStore } from '../vault/store.ts';
import { DataError, Engine, type EngineLimits, lit, pathLit, qid, rowsHash, type ViewDef } from './engine.ts';
import { CATALOG_ID, DataHome, type DatasetState, type HomeState } from './home.ts';
import { compileQuery, implicitModel, SemanticCompiler } from './semantic.ts';
import { readerFor, type SourceContext } from './sources.ts';
import { compileDataset } from './steps.ts';

// The data service: one per server. Queries (compiled from the model, run in a locked engine,
// cached by the hash of their inputs), refreshes (sources read again on their schedules, with
// history and failure alerts), alerts on measures, subscriptions, the published-pages registry
// and the live "refreshed" signal published pages and the app listen to.

export interface Viewer {
  /** The owner sees every row (no row-level security) unless viewing as a role. */
  owner: boolean;
  user?: string;
  roles?: RoleSpec[];
  /** Whether results may carry the SQL (the owner's own app: yes; published pages: only if the owner allowed it). */
  showSql: boolean;
}
export const OWNER: Viewer = { owner: true, showSql: true };

export interface DataDeps {
  dataDir: string;
  vault?: VaultStore;
  events?: EventHub;
  leases?: Leases;
  log?: (m: string) => void;
  /** Folders accounts may read file sources from (operator: the server's local roots). */
  rootsFor?: (owner: string | undefined) => string[];
  /** A plugin's contributed data source (its route, called in the server). */
  pluginData?: (plugin: string, kind: string, params: Record<string, unknown>) => Promise<unknown>;
  limits?: Partial<EngineLimits>;
  /** Dashboard templates plugins contribute (ui.contributes.dashboardTemplates). */
  pluginTemplates?: () => import('../../packages/plugin-ui/src/layout.ts').TemplateSpec[];
  /** Today for relative dates (tests). */
  today?: () => string;
}

export interface PublishedEntry { slug: string; owner?: string; doc: string; access: 'token' | 'signed-in'; tokenHash?: string; accounts?: string[]; role?: string; showSql?: boolean; at: number; by: string; /** Published on another harness server (pushed there; served there). */ remote?: { url: string; secret: string; id: string } }

type Listener = (e: { owner?: string; type: string; doc?: string; dataset?: string; [k: string]: unknown }) => void;

export class DataService {
  readonly engine: Engine;
  readonly root: string;
  private homes = new Map<string, DataHome>();
  private cache = new Map<string, QueryResult>();
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private refreshing = new Map<string, Promise<unknown>>();
  private offEvents?: () => void;

  readonly deps: DataDeps;
  constructor(deps: DataDeps) {
    this.deps = deps;
    this.engine = new Engine(deps.limits);
    this.root = path.join(deps.dataDir, 'data');
  }

  home(owner: string | undefined): DataHome {
    const k = owner ?? '';
    let h = this.homes.get(k);
    if (!h) { h = new DataHome(owner, this.root); this.homes.set(k, h); }
    return h;
  }

  // ---------- events ----------

  on(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(owner: string | undefined, payload: { type: string; [k: string]: unknown }): void {
    const e = { owner, ...payload };
    for (const f of this.listeners) { try { f(e); } catch { /* a listener's bug is its own */ } }
    try { this.deps.events?.publish('data' as never, payload, { owner }); } catch { /* no hub */ }
  }
  notice(owner: string | undefined, level: 'info' | 'warn' | 'error', text: string): void {
    try { this.deps.events?.publish('notices', { level, text }, { owner }); } catch { /* no hub */ }
  }

  // ---------- sources and plans ----------

  async roots(home: DataHome): Promise<string[]> {
    const granted = await readJson<string[]>(home.path('roots.json'), []);
    return [home.path('uploads'), ...granted, ...(this.deps.rootsFor?.(home.owner) ?? [])];
  }
  /** Lets file sources of this person read a folder (a session's workspace that added one). */
  async grantRoot(home: DataHome, dir: string): Promise<void> {
    await fs.mkdir(home.dir, { recursive: true });
    await withFileLock(home.path('roots.json'), async () => {
      const cur = await readJson<string[]>(home.path('roots.json'), []);
      if (!cur.includes(dir)) await writeFileAtomic(home.path('roots.json'), JSON.stringify([...cur, dir].slice(-200)));
    });
  }
  async sourceContext(home: DataHome): Promise<SourceContext> {
    return {
      home: home.dir,
      roots: await this.roots(home),
      secret: async (name, purpose) => {
        if (!this.deps.vault) throw new DataError('the key vault is off on this server: a source cannot use a secret', 503);
        return this.deps.vault.reveal({ account: home.owner, label: home.owner ? `account:${home.owner}` : 'operator', tool: 'data' }, name, purpose);
      },
      privateHosts: (process.env.HARNESS_DATA_PRIVATE_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      pluginData: this.deps.pluginData,
    };
  }

  /** Datasets a dataset reads (merge/append steps and names in its SQL), in the catalog. */
  depsOf(d: DatasetSpec, cat: CatalogSpec): string[] {
    const names = new Set(cat.datasets.map((x) => x.name));
    const out = new Set<string>();
    for (const s of d.steps ?? []) { if (s.op === 'merge') out.add(s.with); if (s.op === 'append') for (const w of s.with) out.add(w); }
    if (d.sql) for (const m of d.sql.replace(/'(?:[^']|'')*'/g, '').matchAll(/"?([A-Za-z_]\w*)"?/g)) if (names.has(m[1]!) && m[1] !== d.name) out.add(m[1]!);
    return [...out];
  }
  dataset(cat: CatalogSpec, ref: string): DatasetSpec {
    const d = cat.datasets.find((x) => x.id === ref || x.name === ref);
    if (!d) throw new DataError(`no dataset "${ref}" (datasets: ${cat.datasets.map((x) => x.name).join(', ') || 'none yet: define one'})`, 404);
    return d;
  }

  /**
   * The views and files a run needs for these datasets (and what they read), in order. A dataset
   * with a source and no extract yet is read now (its first refresh).
   */
  async plan(home: DataHome, cat: CatalogSpec, names: Iterable<string>, o: { params?: Record<string, Scalar>; upTo?: { dataset: string; step: number }; autoRefresh?: boolean } = {}): Promise<{ views: ViewDef[]; files: string[]; vars: Record<string, Scalar>; lineage: Lineage['datasets']; state: HomeState }> {
    const order: DatasetSpec[] = [];
    const visiting = new Set<string>();
    const visit = (n: string) => {
      const d = this.dataset(cat, n);
      if (order.includes(d)) return;
      if (visiting.has(d.name)) throw new DataError(`datasets read each other in a loop at ${d.name}`);
      visiting.add(d.name);
      for (const dep of this.depsOf(d, cat)) visit(dep);
      visiting.delete(d.name);
      order.push(d);
    };
    for (const n of names) visit(n);
    let state = await home.state();
    for (const d of order) {
      if (d.source && !state.datasets[d.id]?.file) {
        if (o.autoRefresh === false) throw new DataError(`dataset ${d.name} has not been read yet: refresh it`, 409);
        await this.refresh(home, d.id, 'first use', cat);
        state = await home.state();
      }
    }
    const views: ViewDef[] = []; const files: string[] = []; const vars: Record<string, Scalar> = {};
    const lineage: Lineage['datasets'] = [];
    for (const d of order) {
      const st = state.datasets[d.id];
      const src = d.source ? cat.sources.find((s) => s.id === d.source) : undefined;
      let base: string | undefined;
      if (d.source) {
        if (!src) throw new DataError(`dataset ${d.name}: its source ${d.source} was removed`);
        const file = path.resolve(home.dir, st!.file!);
        files.push(file);
        base = qid(`__x_${d.name}`);
        views.push({ name: `__x_${d.name}`, sql: `SELECT * FROM read_parquet(${pathLit(file)})` });
      }
      for (const p of d.params ?? []) {
        let v = (o.params?.[`${d.name}.${p.name}`] ?? o.params?.[p.name] ?? p.default ?? null) as Scalar;
        // A parameter is a value of its type, bound as a variable: never SQL.
        if (v !== null && p.type === 'number') { v = Number(v); if (!Number.isFinite(v)) throw new DataError(`parameter ${p.name} is a number`); }
        if (v !== null && p.type === 'boolean') v = v === true || v === 'true';
        if (v !== null && p.type === 'date' && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) throw new DataError(`parameter ${p.name} is a date (YYYY-MM-DD)`);
        vars[`${d.name}.${p.name}`] = v;
      }
      const upTo = o.upTo?.dataset === d.name || o.upTo?.dataset === d.id ? o.upTo.step : undefined;
      views.push({ name: d.name, sql: compileDataset(d, base, { upTo, columnsOf: (n) => state.datasets[cat.datasets.find((x) => x.name === n)?.id ?? '']?.columns?.map((c) => c.name) }), user: true });
      lineage.push({ name: d.name, ...(src ? { source: src.name, sourceType: src.type } : {}), ...(st?.at ? { refreshedAt: st.at, rows: st.rows, hash: st.hash } : {}), ...(src?.type === 'static' ? { static: true, origin: src.origin ?? 'person' } : {}), ...(d.certified ? { certified: true } : {}), ...(src?.provenance ? { provenance: src.provenance.sources } : {}) });
    }
    return { views, files, vars, lineage, state };
  }

  // ---------- refresh ----------

  /** Reads a dataset's source again into a new extract (one refresh of a dataset at a time). */
  async refresh(home: DataHome, ref: string, reason: string, catalog?: CatalogSpec): Promise<DatasetState> {
    const cat = catalog ?? (await home.catalog()).spec;
    const d = this.dataset(cat, ref);
    const key = `${home.dir}\0${d.id}`;
    const running = this.refreshing.get(key);
    if (running) return running as Promise<DatasetState>;
    const p = this.doRefresh(home, d, cat, reason).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, p);
    return p;
  }

  private async doRefresh(home: DataHome, d: DatasetSpec, cat: CatalogSpec, reason: string): Promise<DatasetState> {
    const t0 = Date.now();
    try {
      let extract: Partial<DatasetState> = {};
      if (d.source) {
        const src = cat.sources.find((s) => s.id === d.source);
        if (!src) throw new DataError(`its source ${d.source} was removed`);
        const prev = (await home.state()).datasets[d.id];
        const inc = d.incremental && prev?.file ? d.incremental : undefined;
        const cutoff = inc ? new Date(Date.now() - inc.window * (inc.unit === 'day' ? 86_400_000 : inc.unit === 'month' ? 30.44 * 86_400_000 : 365.25 * 86_400_000)).toISOString().slice(0, 19).replace('T', ' ') : undefined;
        const ctx = await this.sourceContext(home);
        const r = await readerFor(src, d.from, ctx, inc ? { column: inc.column, cutoff: cutoff! } : undefined);
        const rel = path.join('extracts', d.id, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.parquet`);
        try {
          const x = await this.engine.extract({ reader: r.reader, out: home.path(rel), ...(inc && prev?.file ? { incremental: { previous: path.resolve(home.dir, prev.file), column: inc.column, cutoff: cutoff! } } : {}) });
          const hash = crypto.createHash('sha256').update(await fs.readFile(home.path(rel))).digest('hex');
          extract = { file: rel, rows: x.rows, sourceColumns: x.columns, hash, ...(inc ? { incremental: { cutoff: cutoff!, replaced: x.rows } } : {}) };
        } finally { await r.cleanup().catch(() => {}); }
      }
      const st = await home.updateState((s) => { s.datasets[d.id] = { ...s.datasets[d.id], ...extract, at: Date.now(), ms: Date.now() - t0, error: undefined, errorAt: undefined }; });
      // The dataset's own columns after its steps and SQL.
      let columns: DatasetState['columns'];
      try {
        const plan = await this.plan(home, cat, [d.name], { autoRefresh: false });
        columns = await this.engine.describe({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(d.name)}` });
      } catch (e) {
        throw new DataError(`read, but the dataset's steps or SQL failed: ${(e as Error).message}`);
      }
      const done = (await home.updateState((s) => { s.datasets[d.id] = { ...s.datasets[d.id], columns }; if (!d.source) s.datasets[d.id]!.rows = undefined; })).datasets[d.id]!;
      await this.pruneExtracts(home, d.id, st.datasets[d.id]?.file);
      await home.recordRun({ kind: 'refresh', dataset: d.name, ok: true, rows: done.rows, ms: Date.now() - t0, reason });
      this.emit(home.owner, { type: 'dataset_refreshed', dataset: d.name, rows: done.rows ?? null, at: done.at });
      return done;
    } catch (e) {
      const msg = (e as Error).message;
      await home.updateState((s) => { s.datasets[d.id] = { ...s.datasets[d.id], error: msg, errorAt: Date.now() }; });
      await home.recordRun({ kind: 'refresh', dataset: d.name, ok: false, error: msg, ms: Date.now() - t0, reason });
      this.emit(home.owner, { type: 'refresh_failed', dataset: d.name, error: msg });
      this.notice(home.owner, 'warn', `Refreshing dataset ${d.name} failed: ${msg}`);
      throw e instanceof DataError ? e : new DataError(msg);
    }
  }

  /** Keeps the current and the previous extract (a run may still read it); older ones go. */
  private async pruneExtracts(home: DataHome, id: string, current?: string): Promise<void> {
    const dir = home.path('extracts', id);
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.parquet')).sort();
    const keep = new Set([current ? path.basename(current) : '', ...files.slice(-2)]);
    for (const f of files) if (!keep.has(f)) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }

  /** The datasets a document's numbers come from (through its model, or the fields it names). */
  docDatasets(doc: DocSpec, cat: CatalogSpec): string[] {
    const models = new Set<string>();
    const fields = new Set<string>();
    const names = new Set(cat.datasets.map((d) => d.name));
    const scan = (q?: QuerySpec) => {
      if (!q) return;
      if (q.model) models.add(q.model);
      for (const f of [...(q.dims ?? []), ...(q.columns ?? []), ...(q.filters ?? []).map((x) => x.field)]) fields.add(f);
      // Inline measures name their tables in SQL (sum(sales.amount)).
      for (const m of q.measures ?? []) if (typeof m !== 'string') for (const x of `${m.expr ?? ''} ${m.filter ?? ''}`.replace(/'(?:[^']|'')*'/g, '').matchAll(/"?([A-Za-z_]\w*)"?\s*\./g)) if (names.has(x[1]!)) fields.add(`${x[1]}.x`);
    };
    if (doc.model) models.add(doc.model);
    for (const p of doc.pages) for (const v of p.visuals) {
      scan(v.query);
      for (const f of [v.options?.slicer?.field, v.options?.trend, v.options?.play, ...(v.options?.dims ?? []), ...(v.options?.detail ?? [])]) if (f) fields.add(f);
    }
    const out = new Set<string>();
    for (const m of models) { const mm = cat.models.find((x) => x.id === m); for (const t of mm?.tables ?? []) out.add(t.dataset); }
    for (const f of fields) { const p = parseField(f); if (p && cat.datasets.some((d) => d.name === p.table)) out.add(p.table); }
    // Datasets those read too.
    const all = new Set<string>();
    const add = (n: string) => { if (all.has(n)) return; const d = cat.datasets.find((x) => x.name === n); if (!d) return; all.add(n); for (const x of this.depsOf(d, cat)) add(x); };
    for (const n of out) add(n);
    return [...all];
  }

  /** Refreshes every dataset of a document, then checks its alerts and tells viewers. */
  async refreshDoc(home: DataHome, docId: string, reason: string): Promise<{ datasets: Array<{ name: string; ok: boolean; rows?: number; error?: string }> }> {
    const cat = (await home.catalog()).spec;
    const doc = (await home.doc(docId)).spec;
    const out: Array<{ name: string; ok: boolean; rows?: number; error?: string }> = [];
    for (const n of this.docDatasets(doc, cat)) {
      const d = cat.datasets.find((x) => x.name === n)!;
      if (!d.source) continue;
      try { const st = await this.refresh(home, d.id, reason, cat); out.push({ name: n, ok: true, rows: st.rows }); } catch (e) { out.push({ name: n, ok: false, error: (e as Error).message }); }
    }
    await home.updateState((s) => { (s.docs[docId] ??= {}).lastRefresh = Date.now(); });
    await this.checkAlerts(home, docId).catch((e: Error) => this.deps.log?.(`alerts of ${docId}: ${e.message}`));
    this.emit(home.owner, { type: 'refreshed', doc: docId, at: Date.now(), failed: out.filter((x) => !x.ok).map((x) => x.name) });
    return { datasets: out };
  }

  // ---------- queries ----------

  model(cat: CatalogSpec, id?: string): ModelSpec {
    if (!id) return implicitModel(cat.datasets.map((d) => d.name).filter((n) => IDENT.test(n)));
    const m = cat.models.find((x) => x.id === id || x.name === id);
    if (!m) throw new DataError(`no model "${id}" (models: ${cat.models.map((x) => x.id).join(', ') || 'none'})`, 404);
    return m;
  }
  compiler(cat: CatalogSpec, state: HomeState, modelId: string | undefined, viewer: Viewer): SemanticCompiler {
    const model = this.model(cat, modelId);
    return new SemanticCompiler({ model, columnsOf: (ds) => state.datasets[cat.datasets.find((d) => d.name === ds)?.id ?? '']?.columns, roles: viewer.owner ? undefined : viewer.roles ?? [], user: viewer.user, today: this.deps.today?.() });
  }

  /** Runs a model query: compiled, planned, run (or served from the cache when nothing it reads changed). */
  async query(home: DataHome, q: QuerySpec, viewer: Viewer = OWNER, o: { signal?: AbortSignal; limit?: number; highlight?: FilterSpec[]; catalog?: CatalogSpec; params?: Record<string, Scalar> } = {}): Promise<QueryResult> {
    const cat = o.catalog ?? (await home.catalog()).spec;
    const model = this.model(cat, q.model);
    if (!viewer.owner && model.roles.length && !(viewer.roles ?? []).length) throw new DataError('no row-level security role of this model includes you, so it shows you no data', 403);
    const state = await home.state();
    const compiled = compileQuery(q, { model, columnsOf: (ds) => state.datasets[cat.datasets.find((d) => d.name === ds)?.id ?? '']?.columns, roles: viewer.owner ? undefined : viewer.roles ?? [], user: viewer.user, today: this.deps.today?.() });
    const plan = await this.plan(home, cat, compiled.datasets, { params: o.params });
    const key = crypto.createHash('sha256').update(JSON.stringify([compiled.sql, plan.vars, plan.lineage.map((l) => l.hash ?? l.refreshedAt), viewer.owner, viewer.user, (viewer.roles ?? []).map((r) => r.name), o.limit])).digest('hex');
    let r = this.cache.get(key);
    if (!r) {
      const raw = await this.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: compiled.sql, limit: o.limit, signal: o.signal });
      const cols: ResultColumn[] = compiled.columns.map((c) => ({ ...c, type: raw.columns.find((x) => x.name === c.name)?.type ?? '' }));
      r = { columns: cols, rows: raw.rows, rowCount: raw.rows.length, ...(raw.truncated ? { truncated: true } : {}), hash: rowsHash(raw.rows), ms: raw.ms, at: Date.now(), lineage: { datasets: plan.lineage, sql: compiled.sql, ...(Object.keys(plan.vars).length ? { params: plan.vars } : {}), ...(viewer.roles?.length && !viewer.owner ? { role: viewer.roles.map((x) => x.name).join(', ') } : {}) }, ...(compiled.warnings.length ? { extra: { warnings: compiled.warnings } } : {}) };
      this.cache.set(key, r);
      if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value!);
    }
    let out: QueryResult = { ...r };
    if (o.highlight?.length && q.dims?.length) {
      // Cross-highlight: the same measures under the selection, matched to the rows by their dims.
      const h = await this.query(home, { ...q, filters: [...(q.filters ?? []), ...o.highlight], limit: undefined }, viewer, { ...o, highlight: undefined, catalog: cat });
      const nd = q.dims.length;
      const idx = new Map(h.rows.map((row) => [JSON.stringify(row.slice(0, nd)), row]));
      out = { ...out, highlight: out.rows.map((row) => { const m = idx.get(JSON.stringify(row.slice(0, nd))); return row.slice(nd).map((_, i) => (m ? m[nd + i]! : null)); }) };
    }
    if (!viewer.showSql) out = { ...out, lineage: { ...out.lineage, sql: undefined, datasets: out.lineage.datasets.map(({ name, refreshedAt, rows, static: st, certified, origin }) => ({ name, refreshedAt, rows, ...(st ? { static: st, origin } : {}), ...(certified ? { certified } : {}) })) } };
    return out;
  }

  /** Read-only SQL over datasets (the owner's own): a capped result. */
  async sql(home: DataHome, sql: string, o: { limit?: number; signal?: AbortSignal; params?: Record<string, Scalar>; catalog?: CatalogSpec } = {}): Promise<QueryResult> {
    const cat = o.catalog ?? (await home.catalog()).spec;
    const masked = sql.replace(/'(?:[^']|'')*'/g, '');
    const used = cat.datasets.filter((d) => new RegExp(`(^|[^\\w"])"?${d.name}"?($|[^\\w])`).test(masked)).map((d) => d.name);
    const plan = await this.plan(home, cat, used, { params: o.params });
    const raw = await this.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql, limit: o.limit, signal: o.signal });
    return { columns: raw.columns.map((c) => ({ name: c.name, label: c.name, type: c.type, role: 'column' })), rows: raw.rows, rowCount: raw.rows.length, ...(raw.truncated ? { truncated: true } : {}), hash: rowsHash(raw.rows), ms: raw.ms, at: Date.now(), lineage: { datasets: plan.lineage, sql } };
  }

  /** First rows of a dataset (optionally only up to a step of its query-editor list). */
  async preview(home: DataHome, ref: string, o: { step?: number; limit?: number; catalog?: CatalogSpec } = {}): Promise<QueryResult> {
    const cat = o.catalog ?? (await home.catalog()).spec;
    const d = this.dataset(cat, ref);
    const plan = await this.plan(home, cat, [d.name], o.step !== undefined ? { upTo: { dataset: d.name, step: o.step } } : {});
    const raw = await this.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(d.name)}`, limit: o.limit ?? 200 });
    return { columns: raw.columns.map((c) => ({ name: c.name, label: c.name, type: c.type, role: 'column' })), rows: raw.rows, rowCount: raw.rows.length, ...(raw.truncated ? { truncated: true } : {}), hash: rowsHash(raw.rows), ms: raw.ms, at: Date.now(), lineage: { datasets: plan.lineage.filter((l) => l.name === d.name) } };
  }

  /** Column quality and distribution: count, nulls, distinct, min, max, mean, top values. */
  async profile(home: DataHome, ref: string, o: { step?: number; catalog?: CatalogSpec } = {}): Promise<{ rows: number; columns: Array<{ name: string; type: string; nulls: number; distinct: number; min: Scalar; max: Scalar; mean: number | null; top: Array<[Scalar, number]> }> }> {
    const cat = o.catalog ?? (await home.catalog()).spec;
    const d = this.dataset(cat, ref);
    const plan = await this.plan(home, cat, [d.name], o.step !== undefined ? { upTo: { dataset: d.name, step: o.step } } : {});
    const cols = (await this.engine.describe({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(d.name)}` })).slice(0, 60);
    if (!cols.length) return { rows: 0, columns: [] };
    const num = (t: string) => /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i.test(t);
    const parts = cols.flatMap((c, i) => [`count(${qid(c.name)}) AS c${i}`, `approx_count_distinct(${qid(c.name)}) AS d${i}`, `CAST(min(${qid(c.name)}) AS VARCHAR) AS lo${i}`, `CAST(max(${qid(c.name)}) AS VARCHAR) AS hi${i}`, num(c.type) ? `avg(${qid(c.name)}) AS m${i}` : `NULL AS m${i}`]);
    const r = await this.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT count(*) AS n, ${parts.join(', ')} FROM ${qid(d.name)}` });
    const row = r.rows[0]!;
    const n = Number(row[0]);
    const tops = await this.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: cols.map((c, i) => `(SELECT ${i} AS col, CAST(${qid(c.name)} AS VARCHAR) AS v, count(*) AS k FROM ${qid(d.name)} GROUP BY 2 ORDER BY 3 DESC, 2 LIMIT 5)`).join(' UNION ALL '), limit: cols.length * 5 });
    return {
      rows: n,
      columns: cols.map((c, i) => ({ name: c.name, type: c.type, nulls: n - Number(row[1 + i * 5]), distinct: Number(row[2 + i * 5]), min: row[3 + i * 5] ?? null, max: row[4 + i * 5] ?? null, mean: row[5 + i * 5] === null ? null : Number(row[5 + i * 5]), top: tops.rows.filter((t) => t[0] === i).map((t) => [t[1] ?? null, Number(t[2])] as [Scalar, number]) })),
    };
  }

  // ---------- alerts ----------

  async checkAlerts(home: DataHome, docId: string): Promise<void> {
    const doc = (await home.doc(docId)).spec;
    for (const a of doc.alerts ?? []) {
      let value: number | null = null;
      try {
        const r = await this.query(home, { model: a.model ?? doc.model, measures: [a.measure], filters: a.filters });
        const v = r.rows[0]?.[0];
        value = v === null || v === undefined ? null : Number(v);
      } catch (e) { this.deps.log?.(`alert ${a.name}: ${(e as Error).message}`); continue; }
      const firing = value !== null && ({ gt: value > a.value, ge: value >= a.value, lt: value < a.value, le: value <= a.value, eq: value === a.value, ne: value !== a.value } as Record<string, boolean>)[a.op]!;
      let was: 'ok' | 'firing' | undefined;
      await home.updateState((s) => { const d = (s.docs[docId] ??= {}); d.alerts ??= {}; was = d.alerts[a.id]?.state; d.alerts[a.id] = { state: firing ? 'firing' : 'ok', value, at: Date.now() }; });
      if ((was ?? 'ok') !== (firing ? 'firing' : 'ok')) {
        await home.recordRun({ kind: 'alert', doc: docId, alert: a.name, state: firing ? 'firing' : 'ok', value });
        this.emit(home.owner, { type: 'alert', doc: docId, alert: a.id, name: a.name, state: firing ? 'firing' : 'ok', value, threshold: a.value, op: a.op });
        if (firing && a.notify) this.notice(home.owner, 'warn', `Alert "${a.name}" on ${doc.title}: ${a.measure} is ${value} (${a.op} ${a.value})`);
      }
    }
  }

  // ---------- scheduling ----------

  /** Starts the refresh, alert and subscription schedule (every 15 s; with several servers, on the lease holder). */
  start(onSubscription?: (home: DataHome, doc: string, sub: NonNullable<DocSpec['subscriptions']>[number]) => Promise<void>): void {
    this.subscriptionRunner = onSubscription;
    this.timer = setInterval(() => { void this.tick().catch((e: Error) => this.deps.log?.(`data schedule: ${e.message}`)); }, 15_000);
    this.timer.unref?.();
    void import('./remote.ts').then((m) => { this.offRemotes = m.followRemotes(this); });
    // Event-driven refresh: a policy {mode: 'event', event: 'topic' | 'topic:type'}.
    this.offEvents = this.deps.events?.subscribe(Number.MAX_SAFE_INTEGER, (e) => { void this.onEvent(e.topic, (e.payload as { type?: string; doc?: string })?.type, (e.payload as { doc?: string })?.doc).catch(() => {}); });
  }
  private subscriptionRunner?: (home: DataHome, doc: string, sub: NonNullable<DocSpec['subscriptions']>[number]) => Promise<void>;
  private offRemotes?: () => void;
  /** Stops the scheduler and closes the export browser (if a PDF or PNG export started one). */
  stop(): Promise<void> { clearInterval(this.timer); this.offEvents?.(); this.offRemotes?.(); return import('./export.ts').then((m) => m.closeExportBrowser()).catch(() => {}); }

  private async owners(): Promise<Array<string | undefined>> {
    const names = await fs.readdir(this.root).catch(() => [] as string[]);
    const out: Array<string | undefined> = [];
    for (const n of names) if ((await fs.stat(path.join(this.root, n)).catch(() => null))?.isDirectory()) out.push(n === 'operator' ? undefined : n);
    return out;
  }
  private due(p: { mode: string; every?: number; cron?: string } | undefined, last: number | undefined, now: number): boolean {
    if (!p) return false;
    const since = last ?? 0;
    if (p.mode === 'interval' && p.every) return now - since >= Math.max(10, p.every) * 1000;
    if (p.mode === 'cron' && p.cron) { const n = nextCron(p.cron, since || now - 60_000); return n !== undefined && n <= now; }
    return false;
  }
  /** One pass of the schedule (tests call it with their own clock). */
  async tick(now = Date.now()): Promise<void> {
    if (this.deps.leases && !(await this.deps.leases.acquire('data-schedule')).ok) return;
    for (const owner of await this.owners()) {
      const home = this.home(owner);
      const cat = (await home.catalog()).spec;
      const state = await home.state();
      for (const d of cat.datasets) {
        if (!this.due(d.refresh, state.datasets[d.id]?.lastAuto ?? state.datasets[d.id]?.at, now)) continue;
        await home.updateState((s) => { (s.datasets[d.id] ??= {}).lastAuto = now; });
        await this.refresh(home, d.id, 'schedule', cat).catch(() => {});
      }
      for (const m of await home.docs()) {
        const doc = (await home.doc(m.id).catch(() => undefined))?.spec;
        if (!doc) continue;
        const ds = state.docs[m.id] ?? {};
        if (this.due(doc.refresh, ds.lastAuto ?? ds.lastRefresh ?? m.createdAt, now)) {
          await home.updateState((s) => { (s.docs[m.id] ??= {}).lastAuto = now; });
          await this.refreshDoc(home, m.id, 'schedule').catch(() => {});
        }
        for (const sub of doc.subscriptions ?? []) {
          const last = ds.subs?.[sub.id] ?? m.createdAt;
          const next = nextCron(sub.cron, last);
          if (next === undefined || next > now) continue;
          await home.updateState((s) => { const x = (s.docs[m.id] ??= {}); (x.subs ??= {})[sub.id] = now; });
          await this.subscriptionRunner?.(home, m.id, sub).catch((e: Error) => this.notice(home.owner, 'warn', `Subscription of ${doc.title} failed: ${e.message}`));
        }
      }
    }
  }
  private async onEvent(topic: string, type?: string, fromDoc?: string): Promise<void> {
    for (const owner of await this.owners()) {
      const home = this.home(owner);
      for (const m of await home.docs()) {
        const doc = (await home.doc(m.id).catch(() => undefined))?.spec;
        const ev = doc?.refresh?.mode === 'event' ? doc.refresh.event : undefined;
        if (!ev || m.id === fromDoc) continue;
        const [t, ty] = ev.split(':');
        if (t === topic && (!ty || ty === type)) await this.refreshDoc(home, m.id, `event ${ev}`).catch(() => {});
      }
    }
  }

  // ---------- published pages ----------

  private pubFile() { return path.join(this.root, 'published.json'); }
  async published(): Promise<PublishedEntry[]> { return readJson<PublishedEntry[]>(this.pubFile(), []); }
  async publish(owner: string | undefined, doc: string, o: { access?: 'token' | 'signed-in'; accounts?: string[]; role?: string; showSql?: boolean; by: string }): Promise<{ entry: PublishedEntry; token?: string }> {
    await fs.mkdir(this.root, { recursive: true });
    return withFileLock(this.pubFile(), async () => {
      const all = await this.published();
      const old = all.find((p) => p.owner === owner && p.doc === doc);
      const access = o.access ?? 'token';
      const token = access === 'token' ? `hwp_${crypto.randomBytes(24).toString('base64url')}` : undefined;
      const entry: PublishedEntry = { slug: old?.slug ?? crypto.randomBytes(12).toString('base64url'), owner, doc, access, ...(token ? { tokenHash: crypto.createHash('sha256').update(token).digest('hex') } : {}), ...(o.accounts?.length ? { accounts: o.accounts } : {}), ...(o.role ? { role: o.role } : {}), showSql: !!o.showSql, at: Date.now(), by: o.by };
      await writeFileAtomic(this.pubFile(), JSON.stringify([...all.filter((p) => p !== old), entry], null, 1));
      this.emit(owner, { type: 'published', doc, slug: entry.slug });
      return { entry, ...(token ? { token } : {}) };
    });
  }
  /** Records a copy published on another server (re-pushed after each refresh, unpublished there with this one). */
  async addRemote(owner: string | undefined, doc: string, r: { url: string; secret: string; id: string; slug: string; by: string }): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await withFileLock(this.pubFile(), async () => {
      const all = (await this.published()).filter((p) => !(p.owner === owner && p.doc === doc && p.remote?.url === r.url));
      await writeFileAtomic(this.pubFile(), JSON.stringify([...all, { slug: `remote-${r.slug}`, owner, doc, access: 'token', at: Date.now(), by: r.by, remote: { url: r.url, secret: r.secret, id: r.id } } satisfies PublishedEntry], null, 1));
    });
  }
  async unpublish(owner: string | undefined, doc: string): Promise<boolean> {
    // Copies on other servers are taken down there too (with the same token the push used).
    for (const p of (await this.published()).filter((x) => x.owner === owner && x.doc === doc && x.remote)) {
      try {
        const token = await (await this.sourceContext(this.home(owner))).secret(p.remote!.secret, `unpublish ${doc} on ${p.remote!.url}`);
        await fetch(new URL('/api/data/ops', p.remote!.url), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ op: 'unpublish', doc: p.remote!.id }), signal: AbortSignal.timeout(30_000) });
      } catch (e) { this.notice(owner, 'warn', `Unpublishing ${doc} on ${p.remote!.url} failed: ${(e as Error).message}`); }
    }
    await fs.mkdir(this.root, { recursive: true });
    const gone = await withFileLock(this.pubFile(), async () => {
      const all = await this.published();
      const keep = all.filter((p) => !(p.owner === owner && p.doc === doc));
      await writeFileAtomic(this.pubFile(), JSON.stringify(keep, null, 1));
      return all.length - keep.length;
    });
    if (gone) this.emit(owner, { type: 'unpublished', doc });
    return gone > 0;
  }

  /** A catalog version for a run (the catalog file, read once). */
  async catalogOf(home: DataHome): Promise<CatalogSpec> { return (await home.catalog()).spec; }
}

export { CATALOG_ID, DataError, lit, type SourceSpec };
