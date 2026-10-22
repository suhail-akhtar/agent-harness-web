import path from 'node:path';
import {
  type AlertSpec, type BookmarkSpec, type CatalogSpec, COLUMN_TYPES, DATA_VISUALS, type DatasetSpec, type DocSpec, FILTER_OPS, type FilterSpec, ID, IDENT, type MeasureSpec,
  type ModelSpec, OPS, type PageSpec, parseField, type QuerySpec, type RefreshPolicy, type SourceSpec, SOURCE_TYPES, type StepSpec, type SubscriptionSpec, THEMES, TIME_CALCS,
  VISUAL_TYPES, type VisualSpec, visualSummary,
} from '../../packages/plugin-ui/src/bi.ts';
import { parseCron } from '../core/scheduler.ts';
import { DataError, qid } from './engine.ts';
import { CATALOG_ID, type DataHome, newId } from './home.ts';
import type { DataService } from './service.ts';
import { checkStep } from './steps.ts';
import { BUILTIN_TEMPLATES, fillTemplate, pack as packLayout, reflow, type TemplateSpec } from '../../packages/plugin-ui/src/layout.ts';
import { LAYOUT_TYPES, type LayoutSpec } from '../../packages/plugin-ui/src/bi.ts';
const LAYOUT_TYPES_SET = new Set<string>(LAYOUT_TYPES);
import { implicitModel, SemanticCompiler } from './semantic.ts';

// The op layer: every change to sources, datasets, models, dashboards and reports - from a person's
// click or an agent's tool call - is a typed op, checked against the catalog and the model (an
// unknown column or measure is refused with the valid choices), applied atomically per batch,
// written as a new artifact version, logged with who made it (and from which session), and undoable.

export interface Actor { kind: 'person' | 'agent'; account?: string; session?: string; label: string }
export type Op = { op: string } & Record<string, unknown>;
export interface OpOutcome { op: string; message: string; data?: unknown }
export interface ApplyResult { results: OpOutcome[]; changed: Array<{ target: string; version: number; title: string }>; diff: string[]; untrusted?: boolean }
export interface ApplyOptions { workspace?: string; /** Read-only ops only (a viewer, plan mode). */ readOnly?: boolean }

type Handler = (tx: Tx, a: Op) => Promise<string | OpOutcome | void> | string | OpOutcome | void;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const S = (a: Op, k: string, what = k): string => { const v = a[k]; if (typeof v !== 'string' || !v.trim()) throw new DataError(`${a.op} needs "${k}" (${what})`); return v.trim(); };
const O = <T>(a: Op, k: string): T => { const v = a[k]; if (!v || typeof v !== 'object' || Array.isArray(v)) throw new DataError(`${a.op} needs "${k}" as an object`); return v as T; };
const SECRET_KEYS = /^(password|passwd|pwd|token|apikey|api_key|secretvalue|accesskey|access_key|privatekey|private_key|connectionstring|connection_string|credentials?)$/i;

function checkPolicy(p: unknown): RefreshPolicy {
  if (!p || typeof p !== 'object') throw new DataError('refresh is {mode: manual|interval|cron|event, every?, cron?, event?}');
  const r = p as RefreshPolicy;
  if (!['manual', 'interval', 'cron', 'event'].includes(r.mode)) throw new DataError('refresh.mode is manual, interval, cron or event');
  if (r.mode === 'interval' && !(Number(r.every) >= 10)) throw new DataError('refresh.every is seconds, at least 10');
  if (r.mode === 'cron') { try { parseCron(String(r.cron)); } catch (e) { throw new DataError(`refresh.cron: ${(e as Error).message}`); } }
  if (r.mode === 'event' && !/^[a-z]+(:[a-z_]+)?$/.test(String(r.event))) throw new DataError('refresh.event is a global event topic, or topic:type (e.g. "data:dataset_refreshed")');
  return { mode: r.mode, ...(r.every ? { every: Math.floor(Number(r.every)) } : {}), ...(r.cron ? { cron: r.cron } : {}), ...(r.event ? { event: r.event } : {}) };
}
const FORMAT = /^(currency(:[A-Za-z]{3}(:\d)?)?|percent(:\d)?|number(:\d)?|integer|compact(:\d)?|date(:(year|quarter|month|week|day|hour))?|text)$/;
export function checkFormat(f: unknown): string { if (typeof f !== 'string' || !FORMAT.test(f)) throw new DataError(`format "${String(f)}": use currency:USD[:decimals], percent[:decimals], number[:decimals], integer, compact, date[:grain] or text`); return f; }

/** One batch: the catalog and documents it touches, edited in memory, checked, then written together. */
export class Tx {
  catalog: CatalogSpec;
  readonly catalogBefore: CatalogSpec;
  docs = new Map<string, { spec: DocSpec; before?: DocSpec; deleted?: boolean; created?: boolean }>();
  checks: Array<() => Promise<void>> = [];
  after: Array<() => Promise<OpOutcome>> = [];
  roots: string[] = [];
  catalogTouched = false;
  lastCreated?: string;
  svc: DataService; home: DataHome; actor: Actor; o: ApplyOptions;
  constructor(svc: DataService, home: DataHome, catalog: CatalogSpec, actor: Actor, o: ApplyOptions) {
    this.svc = svc; this.home = home; this.actor = actor; this.o = o;
    this.catalog = clone(catalog); this.catalogBefore = clone(catalog);
  }
  async doc(ref: unknown): Promise<DocSpec> {
    let id = typeof ref === 'string' ? ref : '';
    if (id === '$new' && this.lastCreated) id = this.lastCreated;
    if (!id) throw new DataError('name the document: "doc" (an id from list_docs)');
    const have = this.docs.get(id);
    if (have) { if (have.deleted) throw new DataError(`document ${id} was deleted in this batch`); return have.spec; }
    const d = await this.home.doc(id);
    const spec = clone(d.spec);
    this.docs.set(id, { spec, before: clone(d.spec) });
    return spec;
  }
  docId(spec: DocSpec): string { for (const [k, v] of this.docs) if (v.spec === spec) return k; throw new Error('unknown doc'); }
  touch() { this.catalogTouched = true; }
  model(ref: unknown): ModelSpec {
    const id = typeof ref === 'string' ? ref : '';
    const m = this.catalog.models.find((x) => x.id === id || x.name === id);
    if (!m) throw new DataError(`no model "${id}" (models: ${this.catalog.models.map((x) => x.id).join(', ') || 'none: add_model first'})`);
    return m;
  }
  dataset(ref: unknown): DatasetSpec { return this.svc.dataset(this.catalog, String(ref ?? '')); }
  /** A compiler over the batch's catalog (fields and measures checked against known columns). */
  async compiler(modelId?: string): Promise<SemanticCompiler> {
    const state = await this.home.state();
    const model = modelId ? this.model(modelId) : implicitModel(this.catalog.datasets.map((d) => d.name));
    return new SemanticCompiler({ model, columnsOf: (ds) => state.datasets[this.catalog.datasets.find((d) => d.name === ds)?.id ?? '']?.columns });
  }
  /** Runs a query (zero rows) against the batch's catalog: SQL errors, unknown columns and bad expressions surface now. */
  async probe(q: QuerySpec, roles?: ModelSpec['roles']): Promise<void> {
    const c = await this.compiler(q.model);
    const compiled = roles ? new SemanticCompiler({ ...(c as unknown as { ctx: ConstructorParameters<typeof SemanticCompiler>[0] }).ctx, roles, user: 'probe' }).compile(q) : c.compile(q);
    const plan = await this.svc.plan(this.home, this.catalog, compiled.datasets);
    await this.svc.engine.describe({ files: plan.files, views: plan.views, vars: plan.vars, sql: compiled.sql });
  }
  /** Checks a dataset still computes (its steps and SQL over the batch's catalog) and remembers its columns. */
  async probeDataset(name: string): Promise<Array<{ name: string; type: string }>> {
    const plan = await this.svc.plan(this.home, this.catalog, [name]);
    const cols = await this.svc.engine.describe({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT * FROM ${qid(name)}` });
    const d = this.dataset(name);
    await this.home.updateState((s) => { (s.datasets[d.id] ??= {}).columns = cols; });
    return cols;
  }
}

// ---------------- checks shared by ops ----------------

function cleanSource(s: SourceSpec, workspace?: string): SourceSpec {
  if (!(SOURCE_TYPES as readonly string[]).includes(s.type)) throw new DataError(`source type is one of ${SOURCE_TYPES.join(', ')}`);
  if (!s.name?.trim()) throw new DataError('a source needs a name');
  for (const k of Object.keys(s)) if (SECRET_KEYS.test(k)) throw new DataError(`"${k}": credentials are never written into a source. Store the value in the key vault (Settings > Vault, or the vault tool) and name the entry in "secret"`);
  for (const [k, v] of Object.entries(s.headers ?? {})) if (/^authorization$/i.test(k) || /bearer\s|basic\s/i.test(String(v))) throw new DataError(`header ${k} looks like a credential: put it in the key vault and name it in "secret" with auth`);
  if (s.secret !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s.secret)) throw new DataError('secret is the name of a key vault entry');
  if (s.type === 'file' || s.type === 'sqlite') {
    if (!s.path) throw new DataError(`a ${s.type} source needs a path`);
    if (!path.isAbsolute(s.path)) { if (!workspace) throw new DataError('the path must be absolute here'); s.path = path.resolve(workspace, s.path); }
  }
  if ((s.type === 'postgres' || s.type === 'mysql') && (!s.host || !s.database)) throw new DataError(`a ${s.type} source needs host and database (and user; the password as a vault entry name in "secret")`);
  if (s.type === 'http') { let u: URL; try { u = new URL(String(s.url)); } catch { throw new DataError('an http source needs a url'); } if (!/^https?:$/.test(u.protocol)) throw new DataError('only http(s) URLs'); if (u.username || u.password) throw new DataError('no credentials in the URL: use "secret"'); }
  if (s.type === 'static') {
    if (!Array.isArray(s.columns) || !Array.isArray(s.rows)) throw new DataError('a static source needs columns and rows');
    if (s.rows.length > 10_000) throw new DataError('a static source holds at most 10,000 rows; use a file');
  }
  if (s.type === 'plugin' && (!s.plugin || !s.kind)) throw new DataError('a plugin source needs plugin and kind');
  return s;
}

function checkFilter(f: FilterSpec, c?: SemanticCompiler, measures: string[] = []): FilterSpec {
  if (!f || typeof f.field !== 'string') throw new DataError('a filter is {field, op, values|value}');
  if (!(FILTER_OPS as readonly string[]).includes(f.op)) throw new DataError(`filter op is one of ${FILTER_OPS.join(', ')}`);
  if (parseField(f.field)) { c?.field(f.field); }
  else if (!measures.includes(f.field) && c) { try { c.measure(f.field); } catch { throw new DataError(`filter field "${f.field}" is neither table.column nor a measure`); } }
  if ((f.op === 'top' || f.op === 'bottom') && c) { if (!f.by) throw new DataError(`${f.op} needs "by" (a measure)`); c.measure(f.by); }
  return f;
}

async function checkVisual(tx: Tx, doc: DocSpec, v: VisualSpec, page: PageSpec): Promise<void> {
  if (!(VISUAL_TYPES as readonly string[]).includes(v.type)) throw new DataError(`visual type "${v.type}" is not one of: ${VISUAL_TYPES.join(', ')}`);
  const o = v.options ?? {};
  if (v.type === 'slicer' && !o.slicer?.field) throw new DataError('a slicer needs options.slicer.field (table.column)');
  if (v.type === 'button' && !o.button?.label) throw new DataError('a button needs options.button {label, action}');
  if (v.type === 'image' && o.url && !/^(https:|data:image\/)/.test(o.url)) throw new DataError('an image url is https: or data:image/');
  if (v.type === 'fence' && !o.fence?.lang) throw new DataError('a fence visual needs options.fence.lang (smiles, pdb, plot, dot, mermaid, geojson, diagram or a plugin renderer)');
  const modelId = v.query?.model ?? doc.model;
  const needsQuery = DATA_VISUALS.has(v.type) && !['slicer', 'fence', 'narrative'].includes(v.type);
  if (needsQuery && !v.query) throw new DataError(`a ${v.type} needs a query {dims, measures} (or columns for a table)`);
  const c = await tx.compiler(modelId);
  if (v.query) {
    if (v.query.model && v.query.model !== doc.model) tx.model(v.query.model);
    const q = { ...v.query, model: modelId };
    for (const f of q.filters ?? []) checkFilter(f, c, (q.measures ?? []).map((m) => (typeof m === 'string' ? m : m.name)));
    c.compile(q);
    const ms = (q.measures ?? []).map((m) => (typeof m === 'string' ? m : m.name));
    if (['bar', 'column', 'line', 'area', 'combo', 'ribbon', 'pie', 'donut', 'treemap', 'funnel', 'waterfall', 'map'].includes(v.type) && !ms.length) throw new DataError(`a ${v.type} needs at least one measure`);
    if (['bar', 'column', 'line', 'area', 'combo', 'ribbon', 'pie', 'donut', 'treemap', 'funnel', 'waterfall'].includes(v.type) && !(q.dims ?? []).length) throw new DataError(`a ${v.type} needs a dimension (dims) to draw along`);
    if (v.type === 'scatter' && ms.length < 2) throw new DataError('a scatter needs two measures (x, y) and optionally a third (size)');
    for (const l of o.lines ?? []) if (!ms.includes(l)) throw new DataError(`options.lines: "${l}" is not a measure of this visual (${ms.join(', ')})`);
    if (typeof o.target === 'string' && !ms.includes(o.target)) c.measure(o.target);
    for (const k of ['trend', 'play'] as const) if (o[k]) c.field(o[k]!);
    if (o.forecast && !(Number(o.forecast.periods) > 0)) throw new DataError('options.forecast.periods > 0');
    if ((o.forecast || o.anomalies) && !(q.dims ?? []).some((d) => parseField(d)?.grain)) throw new DataError('forecast and anomaly marks need a date dimension with a grain (e.g. sales.day:month)');
    for (const f of o.detail ?? []) c.field(f);
    for (const cf of o.conditional ?? []) if (!['scale', 'bars', 'icons', 'rules'].includes(cf.kind)) throw new DataError('conditional kind is scale, bars, icons or rules');
    for (const [k, f] of Object.entries(o.formats ?? {})) { checkFormat(f); if (!ms.includes(k) && !(q.dims ?? []).includes(k) && !(q.columns ?? []).includes(k)) throw new DataError(`options.formats: "${k}" is not in the visual's query`); }
  }
  if (o.slicer) c.field(o.slicer.field);
  for (const d of o.dims ?? []) c.field(d);
  if (o.hierarchy) { const m = modelId ? tx.model(modelId) : undefined; if (!m?.hierarchies.some((h) => h.name === o.hierarchy)) throw new DataError(`no hierarchy "${o.hierarchy}" in the model (${m?.hierarchies.map((h) => h.name).join(', ') || 'none'})`); }
  if (o.geo?.source && !tx.catalog.sources.some((s) => s.id === o.geo!.source || s.name === o.geo!.source)) throw new DataError(`options.geo.source: no source ${o.geo.source}`);
  if (v.tooltip && !doc.pages.some((p) => p.id === v.tooltip && p.kind === 'tooltip')) throw new DataError(`tooltip: no tooltip page ${v.tooltip}`);
  for (const k of Object.keys(v.interactions ?? {})) if (!page.visuals.some((x) => x.id === k)) throw new DataError(`interactions: no visual ${k} on page ${page.name}`);
  const L = v.layout;
  const canvas = page.layout?.type === 'canvas';
  if (!L || ![L.x, L.y, L.w, L.h].every((n) => Number.isInteger(n) && n >= 0) || L.w < 1 || L.h < 1 || (!canvas && L.x + L.w > 12) || (canvas && (L.w > 8000 || L.h > 8000))) throw new DataError(canvas ? 'a canvas layout is {x, y, w, h, z} in whole pixels' : 'layout is {x, y, w, h}: whole numbers, 12 columns (x + w <= 12)');
  if (v.section && v.section !== 'sidebar' && page.layout?.type === 'sections' && !page.layout?.sections?.some((s) => s.id === v.section)) throw new DataError(`no section "${v.section}" on page ${page.name} (${page.layout?.sections?.map((s) => s.id).join(', ') || 'it has none'})`);
  if (o.button?.action === 'bookmark' && !doc.bookmarks?.some((b) => b.id === o.button!.target)) throw new DataError(`button: no bookmark ${o.button.target}`);
  if (o.button?.action === 'page' && !doc.pages.some((p) => p.id === o.button!.target)) throw new DataError(`button: no page ${o.button.target}`);
}

function findVisual(doc: DocSpec, id: unknown): { page: PageSpec; v: VisualSpec; i: number } {
  for (const page of doc.pages) { const i = page.visuals.findIndex((x) => x.id === id); if (i >= 0) return { page, v: page.visuals[i]!, i }; }
  const all = doc.pages.flatMap((p) => p.visuals.map((v) => `${v.id} (${visualSummary(v)})`));
  throw new DataError(`no visual "${String(id)}" (visuals: ${all.join('; ') || 'none'})`);
}
function findPage(doc: DocSpec, id: unknown): PageSpec {
  const p = doc.pages.find((x) => x.id === id || x.name === id);
  if (!p) throw new DataError(`no page "${String(id)}" (pages: ${doc.pages.map((x) => `${x.id} "${x.name}"`).join(', ')})`);
  return p;
}
const DEFAULT_SIZE: Partial<Record<VisualSpec['type'], [number, number]>> = { card: [3, 4], kpi: [3, 5], gauge: [4, 7], multicard: [6, 4], slicer: [3, 6], text: [12, 3], button: [2, 2], table: [12, 9], matrix: [12, 10], narrative: [6, 5] };
function place(page: PageSpec, v: Partial<VisualSpec>): VisualSpec['layout'] {
  const [w, h] = DEFAULT_SIZE[v.type as VisualSpec['type']] ?? [6, 8];
  if (page.layout?.type === 'canvas') {
    // Pixels: below everything, at the left, on top of the stack.
    const bottom = Math.max(0, ...page.visuals.map((x) => x.layout.y + x.layout.h + 8));
    return { x: 0, y: bottom, w: (v.layout?.w ?? w) * 100 - 8, h: (v.layout?.h ?? h) * 48 - 8, z: Math.max(0, ...page.visuals.map((x) => x.layout.z ?? 0)) + 1 };
  }
  if (v.section) page = { ...page, visuals: page.visuals.filter((x) => x.section === v.section) };
  const ww = Math.min(12, v.layout?.w ?? w);
  // The first gap on the lowest row with room, else a new row.
  const bottom = Math.max(0, ...page.visuals.map((x) => x.layout.y + x.layout.h));
  const row = page.visuals.filter((x) => x.layout.y + x.layout.h === bottom);
  const lastRowY = row.length ? Math.min(...row.map((x) => x.layout.y)) : bottom;
  const used = page.visuals.filter((x) => x.layout.y === lastRowY).reduce((m, x) => Math.max(m, x.layout.x + x.layout.w), 0);
  if (row.length && used + ww <= 12) return { x: used, y: lastRowY, w: ww, h: v.layout?.h ?? h };
  return { x: 0, y: bottom, w: ww, h: v.layout?.h ?? h };
}
function mergePatch<T>(cur: T, patch: Record<string, unknown>, deep: string[] = []): T {
  const out = { ...cur } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (deep.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) out[k] = mergePatch((out[k] ?? {}) as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out as T;
}
function docsUsing(tx: Tx, all: Map<string, DocSpec>, pred: (d: DocSpec) => boolean): string[] { return [...all].filter(([, d]) => pred(d)).map(([id, d]) => `${id} "${d.title}"`); }

// ---------------- handlers ----------------

const H: Record<string, Handler> = {
  // ----- sources -----
  add_source: (tx, a) => {
    const s = cleanSource({ ...O<SourceSpec>(a, 'source') }, tx.o.workspace);
    s.id = s.id && ID.test(s.id) ? s.id : newId('src');
    if (tx.catalog.sources.some((x) => x.id === s.id)) throw new DataError(`source ${s.id} exists`);
    if (s.origin === 'model' && tx.actor.kind === 'person') delete s.origin;
    if (tx.o.workspace && (s.type === 'file' || s.type === 'sqlite') && s.path!.startsWith(tx.o.workspace)) tx.roots.push(tx.o.workspace);
    tx.catalog.sources.push(s); tx.touch();
    return { op: a.op, message: `added source ${s.id} "${s.name}" (${s.type})`, data: { id: s.id } };
  },
  update_source: (tx, a) => {
    const i = tx.catalog.sources.findIndex((x) => x.id === a.id || x.name === a.id);
    if (i < 0) throw new DataError(`no source "${String(a.id)}"`);
    const patch = O<Record<string, unknown>>(a, 'patch');
    if (patch.type && patch.type !== tx.catalog.sources[i]!.type) throw new DataError('a source keeps its type: add a new source instead');
    tx.catalog.sources[i] = cleanSource(mergePatch(tx.catalog.sources[i]!, patch), tx.o.workspace); tx.touch();
    return `updated source ${tx.catalog.sources[i]!.id}`;
  },
  remove_source: (tx, a) => {
    const s = tx.catalog.sources.find((x) => x.id === a.id || x.name === a.id);
    if (!s) throw new DataError(`no source "${String(a.id)}"`);
    const users = tx.catalog.datasets.filter((d) => d.source === s.id);
    if (users.length) throw new DataError(`source ${s.id} is read by datasets ${users.map((d) => d.name).join(', ')}: remove those first`);
    tx.catalog.sources = tx.catalog.sources.filter((x) => x !== s); tx.touch();
    return `removed source ${s.id}`;
  },
  // ----- datasets -----
  define: (tx, a) => {
    const d = { ...O<DatasetSpec>(a, 'dataset') };
    if (!IDENT.test(d.name ?? '')) throw new DataError('a dataset name is an SQL identifier: letters, digits and _ (e.g. sales_2026)');
    if (tx.catalog.datasets.some((x) => x.name === d.name)) throw new DataError(`dataset ${d.name} exists (update_dataset changes it)`);
    if (['base', 'k', 'j', 'r', 's', 'g0', 'g1'].includes(d.name) || /^(s|g|t|tot)\d+$/.test(d.name)) throw new DataError(`"${d.name}" is a reserved name; pick another`);
    if (d.source && !tx.catalog.sources.some((s) => s.id === d.source)) {
      const byName = tx.catalog.sources.find((s) => s.name === d.source);
      if (!byName) throw new DataError(`no source "${d.source}" (sources: ${tx.catalog.sources.map((s) => `${s.id} "${s.name}"`).join(', ') || 'none'})`);
      d.source = byName.id;
    }
    if (!d.source && !d.sql) throw new DataError('a dataset needs a source or sql');
    for (const s of d.steps ?? []) checkStep(s);
    if (d.refresh) d.refresh = checkPolicy(d.refresh);
    d.id = newId('ds');
    tx.catalog.datasets.push(d); tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(d.name); });
    return { op: a.op, message: `defined dataset ${d.name}`, data: { id: d.id, name: d.name } };
  },
  update_dataset: (tx, a) => {
    const d = tx.dataset(a.dataset);
    const patch = O<Record<string, unknown>>(a, 'patch');
    for (const k of Object.keys(patch)) if (!['description', 'sql', 'from', 'params', 'source', 'steps'].includes(k)) throw new DataError(`update_dataset changes description, sql, from, params, source or steps (not ${k}); a new name means a new dataset`);
    Object.assign(d, mergePatch(d, patch));
    for (const s of d.steps ?? []) checkStep(s);
    tx.touch();
    const reread = 'from' in patch || 'source' in patch;
    tx.checks.push(async () => { if (reread && d.source) await tx.svc.refresh(tx.home, d.id, 'changed', tx.catalog); await tx.probeDataset(d.name); });
    return `updated dataset ${d.name}`;
  },
  remove_dataset: (tx, a) => {
    const d = tx.dataset(a.dataset);
    const tables = tx.catalog.models.flatMap((m) => m.tables.filter((t) => t.dataset === d.name).map((t) => `${m.id}.${t.name}`));
    const readers = tx.catalog.datasets.filter((x) => x !== d && tx.svc.depsOf(x, tx.catalog).includes(d.name)).map((x) => x.name);
    if (tables.length || readers.length) throw new DataError(`dataset ${d.name} is used by ${[...tables.map((t) => `model table ${t}`), ...readers.map((r) => `dataset ${r}`)].join(', ')}`);
    tx.catalog.datasets = tx.catalog.datasets.filter((x) => x !== d); tx.touch();
    return `removed dataset ${d.name}`;
  },
  add_step: async (tx, a) => {
    const d = tx.dataset(a.dataset);
    const step = O<StepSpec>(a, 'step');
    checkStep(step);
    if (step.op === 'pivot' && !(step as { columns?: unknown[] }).columns) {
      // The columns a pivot makes are fixed when the step is added (like a query editor), from the data now.
      const steps = d.steps ?? [];
      const plan = await tx.svc.plan(tx.home, tx.catalog, [d.name], { upTo: { dataset: d.name, step: steps.length } });
      const r = await tx.svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT DISTINCT ${qid(step.on)} AS v FROM ${qid(d.name)} WHERE ${qid(step.on)} IS NOT NULL ORDER BY 1`, limit: 200 });
      if (r.truncated) throw new DataError(`pivot on ${step.on}: more than 200 distinct values`);
      (step as { columns?: unknown[] }).columns = r.rows.map((x) => x[0]);
    }
    const steps = [...(d.steps ?? [])];
    const at = a.at === undefined ? steps.length : Math.max(0, Math.min(steps.length, Number(a.at)));
    steps.splice(at, 0, step);
    d.steps = steps; tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(d.name); });
    return { op: a.op, message: `added step ${at} (${step.op}) to ${d.name}`, data: { index: at } };
  },
  update_step: (tx, a) => {
    const d = tx.dataset(a.dataset);
    const i = Number(a.index);
    if (!d.steps?.[i]) throw new DataError(`${d.name} has no step ${i} (0-${(d.steps?.length ?? 1) - 1})`);
    const step = O<StepSpec>(a, 'step'); checkStep(step);
    d.steps[i] = step; tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(d.name); });
    return `replaced step ${i} of ${d.name}`;
  },
  remove_step: (tx, a) => {
    const d = tx.dataset(a.dataset);
    const i = Number(a.index);
    if (!d.steps?.[i]) throw new DataError(`${d.name} has no step ${i}`);
    d.steps.splice(i, 1); tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(d.name); });
    return `removed step ${i} of ${d.name}`;
  },
  move_step: (tx, a) => {
    const d = tx.dataset(a.dataset);
    const from = Number(a.from); const to = Number(a.to);
    if (!d.steps?.[from] || to < 0 || to >= d.steps.length) throw new DataError('move_step: from and to are step positions');
    const [s] = d.steps.splice(from, 1); d.steps.splice(to, 0, s!); tx.touch();
    tx.checks.push(async () => { await tx.probeDataset(d.name); });
    return `moved step ${from} to ${to} in ${d.name}`;
  },
  certify: (tx, a) => {
    const d = tx.dataset(a.dataset);
    if (a.certified !== undefined) d.certified = a.certified === true;
    if (a.promoted !== undefined) d.promoted = a.promoted === true;
    tx.touch();
    return `${d.name}: certified ${!!d.certified}, promoted ${!!d.promoted}`;
  },
  set_dataset_refresh: (tx, a) => { const d = tx.dataset(a.dataset); d.refresh = checkPolicy(a.refresh); tx.touch(); return `${d.name} refreshes ${d.refresh.mode}`; },
  set_incremental: (tx, a) => {
    const d = tx.dataset(a.dataset);
    if (a.incremental === null) { delete d.incremental; tx.touch(); return `${d.name}: full refresh`; }
    const inc = O<NonNullable<DatasetSpec['incremental']>>(a, 'incremental');
    if (!inc.column || !(inc.window > 0) || !['day', 'month', 'year'].includes(inc.unit)) throw new DataError('incremental is {column, window, unit: day|month|year}');
    d.incremental = { column: inc.column, window: Math.floor(inc.window), unit: inc.unit }; tx.touch();
    tx.checks.push(async () => { const st = (await tx.home.state()).datasets[d.id]; if (st?.sourceColumns && !st.sourceColumns.some((c) => c.name === inc.column)) throw new DataError(`incremental column ${inc.column} is not in the source (${st.sourceColumns.map((c) => c.name).join(', ')})`); });
    return `${d.name}: incremental on ${inc.column}, last ${inc.window} ${inc.unit}(s)`;
  },
  // ----- model -----
  add_model: (tx, a) => {
    const m = O<Partial<ModelSpec>>(a, 'model');
    const id = m.id && ID.test(m.id) ? m.id : newId('m');
    if (tx.catalog.models.some((x) => x.id === id)) throw new DataError(`model ${id} exists`);
    if (!m.name?.trim()) throw new DataError('a model needs a name');
    tx.catalog.models.push({ id, name: m.name.trim(), ...(m.description ? { description: m.description } : {}), tables: [], relationships: [], measures: [], hierarchies: [], roles: [], formats: {}, ...(m.date ? { date: m.date } : {}) });
    tx.touch();
    return { op: a.op, message: `added model ${id}`, data: { id } };
  },
  remove_model: async (tx, a) => {
    const m = tx.model(a.model);
    const all = await allDocs(tx);
    const users = docsUsing(tx, all, (d) => d.model === m.id || d.pages.some((p) => p.visuals.some((v) => v.query?.model === m.id)));
    if (users.length) throw new DataError(`model ${m.id} is used by ${users.join(', ')}`);
    tx.catalog.models = tx.catalog.models.filter((x) => x !== m); tx.touch();
    return `removed model ${m.id}`;
  },
  set_model: (tx, a) => {
    const m = tx.model(a.model);
    const p = O<Partial<ModelSpec>>(a, 'patch');
    if (p.name) m.name = String(p.name);
    if (p.description !== undefined) m.description = p.description;
    if (p.date !== undefined) { if (p.date && !parseField(p.date)) throw new DataError('date is a field: table.column'); m.date = p.date || undefined; }
    tx.touch();
    tx.checks.push(async () => { if (m.date) (await tx.compiler(m.id)).field(m.date); });
    return `updated model ${m.id}`;
  },
  set_table: (tx, a) => {
    const m = tx.model(a.model);
    const t = O<ModelSpec['tables'][number]>(a, 'table');
    if (!IDENT.test(t.name ?? '')) throw new DataError('a table name is an SQL identifier');
    tx.dataset(t.dataset ?? t.name);
    const cur = m.tables.find((x) => x.name === t.name);
    const next = { ...cur, ...t, dataset: t.dataset ?? t.name };
    m.tables = cur ? m.tables.map((x) => (x === cur ? next : x)) : [...m.tables, next];
    tx.touch();
    return `${cur ? 'updated' : 'added'} table ${t.name} (${next.dataset}) in ${m.id}`;
  },
  remove_table: (tx, a) => {
    const m = tx.model(a.model); const name = S(a, 'table');
    if (!m.tables.some((t) => t.name === name)) throw new DataError(`no table ${name} in ${m.id}`);
    const deps = [...m.relationships.filter((r) => [r.from, r.to].some((f) => parseField(f)?.table === name)).map((r) => `relationship ${r.from} -> ${r.to}`), ...m.measures.filter((x) => new RegExp(`\\b${name}\\.`).test(`${x.expr ?? ''} ${x.filter ?? ''}`)).map((x) => `measure ${x.name}`)];
    if (deps.length) throw new DataError(`table ${name} is used by ${deps.join(', ')}`);
    m.tables = m.tables.filter((t) => t.name !== name); tx.touch();
    return `removed table ${name}`;
  },
  set_column: (tx, a) => {
    const m = tx.model(a.model); const tn = S(a, 'table');
    const t = m.tables.find((x) => x.name === tn);
    if (!t) throw new DataError(`no table ${tn} in ${m.id}`);
    const c = O<{ name: string; expr: string; format?: string }>(a, 'column');
    if (!c.name?.trim() || !c.expr?.trim()) throw new DataError('a calculated column is {name, expr}');
    if (c.format) checkFormat(c.format);
    t.columns = [...(t.columns ?? []).filter((x) => x.name !== c.name), { name: c.name, expr: c.expr, ...(c.format ? { format: c.format } : {}) }];
    if (c.format) m.formats[`${tn}.${c.name}`] = c.format;
    tx.touch();
    tx.checks.push(() => tx.probe({ model: m.id, columns: [`${tn}.${c.name}`], limit: 1 }));
    return `calculated column ${tn}.${c.name}`;
  },
  remove_column: (tx, a) => {
    const m = tx.model(a.model); const tn = S(a, 'table'); const cn = S(a, 'column');
    const t = m.tables.find((x) => x.name === tn);
    if (!t?.columns?.some((c) => c.name === cn)) throw new DataError(`no calculated column ${tn}.${cn}`);
    t.columns = t.columns.filter((c) => c.name !== cn); tx.touch();
    return `removed ${tn}.${cn}`;
  },
  set_relationship: (tx, a) => {
    const m = tx.model(a.model);
    const r = { ...O<ModelSpec['relationships'][number]>(a, 'relationship') };
    const f = parseField(r.from ?? ''); const t = parseField(r.to ?? '');
    if (!f || !t) throw new DataError('a relationship is {from: "many.column", to: "one.column", cardinality?, crossFilter?}');
    for (const x of [f, t]) if (!m.tables.some((tb) => tb.name === x.table)) throw new DataError(`no table ${x.table} in ${m.id} (set_table first)`);
    if (r.cardinality && !['n:1', '1:1', '1:n'].includes(r.cardinality)) throw new DataError('cardinality is n:1, 1:1 or 1:n');
    if (r.crossFilter && !['single', 'both'].includes(r.crossFilter)) throw new DataError('crossFilter is single or both');
    r.id = `${r.from}->${r.to}`;
    m.relationships = [...m.relationships.filter((x) => (x.id ?? `${x.from}->${x.to}`) !== r.id), r]; tx.touch();
    // The one side must be unique, or every number through this relationship would be counted more than once.
    tx.checks.push(async () => {
      const c = await tx.compiler(m.id); c.field(r.from); c.field(r.to);
      const one = r.cardinality === '1:n' ? f : t;
      const ds = m.tables.find((x) => x.name === one.table)!.dataset;
      const plan = await tx.svc.plan(tx.home, tx.catalog, [ds]);
      const res = await tx.svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT count(${qid(one.column)}) - count(DISTINCT ${qid(one.column)}) AS dup FROM ${qid(ds)}` });
      const dup = Number(res.rows[0]?.[0] ?? 0);
      if (dup > 0 && r.cardinality !== '1:1') throw new DataError(`${one.table}.${one.column} has ${dup} repeated value(s): the "one" side of a relationship must be unique (each row there would be counted again for every repeat). Fix the data, or relate to a deduplicated dataset`);
    });
    return `relationship ${r.id}${r.crossFilter === 'both' ? ' (both directions)' : ''}`;
  },
  remove_relationship: (tx, a) => {
    const m = tx.model(a.model); const id = S(a, 'id');
    const n = m.relationships.length;
    m.relationships = m.relationships.filter((x) => (x.id ?? `${x.from}->${x.to}`) !== id);
    if (n === m.relationships.length) throw new DataError(`no relationship ${id} (${m.relationships.map((x) => x.id ?? `${x.from}->${x.to}`).join(', ') || 'none'})`);
    tx.touch(); return `removed relationship ${id}`;
  },
  set_measure: (tx, a) => {
    const m = tx.model(a.model);
    const x = { ...O<MeasureSpec>(a, 'measure') };
    if (!x.name?.trim() || x.name.length > 80 || /[[\]{}]/.test(x.name)) throw new DataError('a measure needs a name (no brackets or braces)');
    if (!x.expr && !(x.base && x.calc)) throw new DataError('a measure is {name, expr} (an aggregate: sum(sales.amount)) or {name, base, calc} (calc: ' + TIME_CALCS.join(', ') + ')');
    if (x.calc && !(TIME_CALCS as readonly string[]).includes(x.calc)) throw new DataError(`calc is one of ${TIME_CALCS.join(', ')}`);
    if (x.format) checkFormat(x.format);
    if (m.tables.some((t) => t.name === x.name)) throw new DataError(`"${x.name}" is a table name`);
    m.measures = [...m.measures.filter((y) => y.name !== x.name), x]; tx.touch();
    tx.checks.push(async () => {
      const date = x.date ?? m.date;
      const timeCalc = x.calc && !['pct_of_total', 'rank'].includes(x.calc);
      if (timeCalc && !date) throw new DataError(`"${x.name}" (${x.calc}) needs a date field: give "date" or set the model's date (set_model)`);
      await tx.probe({ model: m.id, measures: [x.name], ...(timeCalc ? { dims: [`${date!.replace(/:.*$/, '')}:${x.calc === 'mtd' ? 'day' : 'month'}`] } : {}) });
    });
    return `measure "${x.name}"${x.calc ? ` (${x.calc} of ${x.base})` : `: ${x.expr}`}`;
  },
  remove_measure: async (tx, a) => {
    const m = tx.model(a.model); const name = S(a, 'name');
    if (!m.measures.some((x) => x.name === name)) throw new DataError(`no measure ${name}`);
    const refs = m.measures.filter((x) => x.base === name || (x.expr ?? '').includes(`[${name}]`)).map((x) => `measure ${x.name}`);
    const all = await allDocs(tx);
    refs.push(...docsUsing(tx, all, (d) => (d.model === m.id || d.pages.some((p) => p.visuals.some((v) => v.query?.model === m.id))) && (d.pages.some((p) => p.visuals.some((v) => (v.query?.measures ?? []).includes(name) || v.options?.target === name)) || (d.alerts ?? []).some((al) => al.measure === name))));
    if (refs.length) throw new DataError(`measure ${name} is used by ${refs.join(', ')}`);
    m.measures = m.measures.filter((x) => x.name !== name); tx.touch();
    return `removed measure ${name}`;
  },
  set_hierarchy: (tx, a) => {
    const m = tx.model(a.model);
    const h = O<{ name: string; levels: string[] }>(a, 'hierarchy');
    if (!h.name || !Array.isArray(h.levels) || h.levels.length < 2) throw new DataError('a hierarchy is {name, levels: [two or more fields, top first]}');
    m.hierarchies = [...m.hierarchies.filter((x) => x.name !== h.name), { name: h.name, levels: h.levels }]; tx.touch();
    tx.checks.push(async () => { const c = await tx.compiler(m.id); for (const l of h.levels) c.field(l); });
    return `hierarchy ${h.name}: ${h.levels.join(' > ')}`;
  },
  remove_hierarchy: (tx, a) => { const m = tx.model(a.model); const name = S(a, 'name'); if (!m.hierarchies.some((h) => h.name === name)) throw new DataError(`no hierarchy ${name}`); m.hierarchies = m.hierarchies.filter((h) => h.name !== name); tx.touch(); return `removed hierarchy ${name}`; },
  set_format: (tx, a) => {
    const m = tx.model(a.model); const field = S(a, 'field');
    if (a.format === null) delete m.formats[field]; else m.formats[field] = checkFormat(a.format);
    const meas = m.measures.find((x) => x.name === field);
    if (meas) { if (a.format === null) delete meas.format; else meas.format = String(a.format); }
    tx.touch();
    tx.checks.push(async () => { if (!meas) (await tx.compiler(m.id)).field(field); });
    return `${field}: ${a.format ?? 'default format'}`;
  },
  set_role: (tx, a) => {
    const m = tx.model(a.model);
    const r = O<ModelSpec['roles'][number]>(a, 'role');
    if (!r.name || !Array.isArray(r.members) || !r.filters || typeof r.filters !== 'object') throw new DataError('a role is {name, members: [account ids, "*", or "token:<label>"], filters: {table: "SQL predicate"}}');
    for (const t of Object.keys(r.filters)) if (!m.tables.some((x) => x.name === t)) throw new DataError(`role ${r.name}: no table ${t}`);
    m.roles = [...m.roles.filter((x) => x.name !== r.name), r]; tx.touch();
    tx.checks.push(async () => { for (const t of Object.keys(r.filters)) await tx.probe({ model: m.id, columns: [`${t}.${(await tx.compiler(m.id)).columnsOf(t)?.[0] ?? 'id'}`], limit: 1 }, [r]); });
    return `role ${r.name}: ${Object.entries(r.filters).map(([t, p]) => `${t} where ${p}`).join('; ')}`;
  },
  remove_role: (tx, a) => { const m = tx.model(a.model); const name = S(a, 'name'); if (!m.roles.some((x) => x.name === name)) throw new DataError(`no role ${name}`); m.roles = m.roles.filter((x) => x.name !== name); tx.touch(); return `removed role ${name}`; },
  // ----- documents -----
  create: (tx, a) => {
    const d = O<Partial<DocSpec>>(a, 'doc');
    const type = d.type === 'report' ? 'report' : 'dashboard';
    if (!d.title?.trim()) throw new DataError('a document needs a title');
    if (d.model) tx.model(d.model);
    const id = newId(type === 'report' ? 'rep' : 'dash');
    const spec: DocSpec = { type, title: d.title.trim(), ...(d.description ? { description: d.description } : {}), ...(d.model ? { model: tx.model(d.model).id } : {}), ...(d.theme ? { theme: d.theme } : {}), pages: [{ id: 'p-1', name: type === 'report' ? 'Report' : 'Page 1', visuals: [] }], ...(type === 'report' ? { header: '{title}', footer: '{date} · page {page} of {pages}' } : {}) };
    tx.docs.set(id, { spec, created: true });
    tx.lastCreated = id;
    return { op: a.op, message: `created ${type} ${id} "${spec.title}"`, data: { id } };
  },
  delete: async (tx, a) => {
    const spec = await tx.doc(a.doc);
    const id = tx.docId(spec);
    tx.docs.get(id)!.deleted = true;
    tx.after.push(async () => { await tx.svc.unpublish(tx.home.owner, id); return { op: 'unpublish', message: 'unpublished' }; });
    return `deleted ${id}`;
  },
  set_doc: async (tx, a) => {
    const d = await tx.doc(a.doc);
    const p = O<Partial<DocSpec>>(a, 'patch');
    for (const k of Object.keys(p)) if (!['title', 'description', 'model', 'header', 'footer'].includes(k)) throw new DataError(`set_doc changes title, description, model, header, footer (use set_theme, set_refresh ... for ${k})`);
    if (p.model) p.model = tx.model(p.model).id;
    Object.assign(d, mergePatch(d, p as Record<string, unknown>));
    if (p.model !== undefined) tx.checks.push(async () => { for (const pg of d.pages) for (const v of pg.visuals) await checkVisual(tx, d, v, pg); });
    return `updated ${tx.docId(d)}`;
  },
  add_page: async (tx, a) => {
    const d = await tx.doc(a.doc);
    const p = O<Partial<PageSpec>>(a, 'page');
    if (!p.name?.trim()) throw new DataError('a page needs a name');
    const page: PageSpec = { id: newId('p'), name: p.name.trim(), ...(p.kind && p.kind !== 'page' ? { kind: p.kind } : {}), ...(p.drillFields ? { drillFields: p.drillFields } : {}), ...(p.filters ? { filters: p.filters } : {}), visuals: [] };
    if (page.kind && !['drillthrough', 'tooltip'].includes(page.kind)) throw new DataError('page kind is page, drillthrough or tooltip');
    if (page.kind === 'drillthrough' && !page.drillFields?.length) throw new DataError('a drill-through page names drillFields (the fields whose values it receives)');
    d.pages.push(page);
    tx.checks.push(async () => { const c = await tx.compiler(d.model); for (const f of page.drillFields ?? []) c.field(f); for (const f of page.filters ?? []) checkFilter(f, c); });
    for (const v of (p.visuals ?? []) as VisualSpec[]) await H.add_visual!(tx, { op: 'add_visual', doc: tx.docId(d), page: page.id, visual: v as unknown as Record<string, unknown> });
    return { op: a.op, message: `added page ${page.id} "${page.name}"`, data: { id: page.id } };
  },
  update_page: async (tx, a) => {
    const d = await tx.doc(a.doc); const p = findPage(d, a.page);
    const patch = O<Partial<PageSpec>>(a, 'patch');
    for (const k of Object.keys(patch)) if (!['name', 'kind', 'drillFields', 'filters'].includes(k)) throw new DataError(`update_page changes name, kind, drillFields, filters (not ${k})`);
    Object.assign(p, mergePatch(p, patch as Record<string, unknown>));
    tx.checks.push(async () => { const c = await tx.compiler(d.model); for (const f of p.drillFields ?? []) c.field(f); for (const f of p.filters ?? []) checkFilter(f, c); });
    return `updated page ${p.id}`;
  },
  remove_page: async (tx, a) => {
    const d = await tx.doc(a.doc); const p = findPage(d, a.page);
    if (d.pages.length === 1) throw new DataError('a document keeps at least one page');
    d.pages = d.pages.filter((x) => x !== p);
    for (const pg of d.pages) for (const v of pg.visuals) if (v.tooltip === p.id) delete v.tooltip;
    d.bookmarks = d.bookmarks?.filter((b) => b.page !== p.id);
    return `removed page ${p.id}`;
  },
  move_page: async (tx, a) => {
    const d = await tx.doc(a.doc); const p = findPage(d, a.page);
    const to = Math.max(0, Math.min(d.pages.length - 1, Number(a.to)));
    d.pages = d.pages.filter((x) => x !== p); d.pages.splice(to, 0, p);
    return `moved page ${p.id} to ${to}`;
  },
  add_visual: async (tx, a) => {
    const d = await tx.doc(a.doc);
    const page = a.page ? findPage(d, a.page) : d.pages.find((p) => !p.kind) ?? d.pages[0]!;
    const raw = { ...O<Partial<VisualSpec>>(a, 'visual') };
    if (!raw.section && (page.layout?.type === 'sections' || page.layout?.type === 'tabs') && page.layout.sections?.length) raw.section = page.layout.sections[0]!.id;
    if (!raw.section && page.layout?.type === 'sidebar' && raw.type === 'slicer') raw.section = 'sidebar';
    const v: VisualSpec = { ...(raw as VisualSpec), id: raw.id && /^v-[a-z0-9-]{1,40}$/.test(raw.id) && !page.visuals.some((x) => x.id === raw.id) ? raw.id : newId('v'), layout: raw.layout ?? place(page, raw) };
    await checkVisual(tx, d, v, page);
    page.visuals.push(v);
    return { op: a.op, message: `added ${v.id}: ${visualSummary(v)} on ${page.id}`, data: { id: v.id, page: page.id } };
  },
  update_visual: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v, i } = findVisual(d, a.visual);
    const patch = O<Record<string, unknown>>(a, 'patch');
    if ('id' in patch) throw new DataError('a visual keeps its id');
    const next = mergePatch(v, patch, ['options', 'query', 'interactions', 'mobile']);
    await checkVisual(tx, d, next, page);
    page.visuals[i] = next;
    return `updated ${v.id}: ${visualSummary(next)}`;
  },
  remove_visual: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v } = findVisual(d, a.visual);
    page.visuals = page.visuals.filter((x) => x !== v);
    for (const x of page.visuals) if (x.interactions?.[v.id]) delete x.interactions[v.id];
    for (const b of d.bookmarks ?? []) b.hidden = b.hidden?.filter((h) => h !== v.id);
    return `removed ${v.id}`;
  },
  move_visual: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v } = findVisual(d, a.visual);
    if (a.layout) v.layout = { ...v.layout, ...(a.layout as object) };
    if (a.mobile !== undefined) v.mobile = a.mobile === null ? undefined : { ...v.mobile, ...(a.mobile as object) };
    await checkVisual(tx, d, v, page);
    return `moved ${v.id} to x${v.layout.x} y${v.layout.y} ${v.layout.w}x${v.layout.h}`;
  },
  duplicate_visual: async (tx, a) => {
    const d = await tx.doc(a.doc); const { v } = findVisual(d, a.visual);
    const copy = clone(v); delete (copy as Partial<VisualSpec>).layout; copy.id = newId('v');
    return H.add_visual!(tx, { op: 'add_visual', doc: tx.docId(d), page: a.page ?? findVisual(d, a.visual).page.id, visual: copy as unknown as Record<string, unknown> });
  },
  set_interaction: async (tx, a) => {
    const d = await tx.doc(a.doc); const from = findVisual(d, a.from); const to = findVisual(d, a.to);
    if (from.page !== to.page) throw new DataError('interactions are between visuals of one page');
    if (!['filter', 'highlight', 'none'].includes(String(a.mode))) throw new DataError('mode is filter, highlight or none');
    from.v.interactions = { ...from.v.interactions, [to.v.id]: a.mode as 'filter' };
    return `${from.v.id} -> ${to.v.id}: ${String(a.mode)}`;
  },
  add_filter: async (tx, a) => {
    const d = await tx.doc(a.doc);
    const f = O<FilterSpec>(a, 'filter');
    const scope = String(a.scope ?? 'doc');
    const c = await tx.compiler(d.model);
    if (scope === 'doc') { checkFilter(f, c); d.filters = [...(d.filters ?? []).filter((x) => x.field !== f.field), f]; }
    else if (d.pages.some((p) => p.id === scope)) { const p = findPage(d, scope); checkFilter(f, c); p.filters = [...(p.filters ?? []).filter((x) => x.field !== f.field), f]; }
    else { const { v, page } = findVisual(d, scope); v.query = { ...(v.query ?? {}), filters: [...(v.query?.filters ?? []).filter((x) => x.field !== f.field), f] }; await checkVisual(tx, d, v, page); }
    return `filter ${f.field} ${f.op} on ${scope}`;
  },
  remove_filter: async (tx, a) => {
    const d = await tx.doc(a.doc); const field = S(a, 'field'); const scope = String(a.scope ?? 'doc');
    if (scope === 'doc') d.filters = (d.filters ?? []).filter((x) => x.field !== field);
    else if (d.pages.some((p) => p.id === scope)) { const p = findPage(d, scope); p.filters = (p.filters ?? []).filter((x) => x.field !== field); }
    else { const { v } = findVisual(d, scope); if (v.query) v.query.filters = (v.query.filters ?? []).filter((x) => x.field !== field); }
    return `removed filters on ${field} (${scope})`;
  },
  add_bookmark: async (tx, a) => {
    const d = await tx.doc(a.doc); const b = O<BookmarkSpec>(a, 'bookmark');
    if (!b.name) throw new DataError('a bookmark needs a name');
    const page = findPage(d, b.page ?? d.pages[0]!.id);
    const c = await tx.compiler(d.model);
    for (const f of b.filters ?? []) checkFilter(f, c);
    for (const h of b.hidden ?? []) findVisual(d, h);
    const bm: BookmarkSpec = { ...b, id: newId('b'), page: page.id };
    d.bookmarks = [...(d.bookmarks ?? []), bm];
    return { op: a.op, message: `bookmark ${bm.id} "${bm.name}"`, data: { id: bm.id } };
  },
  remove_bookmark: async (tx, a) => { const d = await tx.doc(a.doc); const n = d.bookmarks?.length ?? 0; d.bookmarks = d.bookmarks?.filter((b) => b.id !== a.bookmark && b.name !== a.bookmark); if (n === (d.bookmarks?.length ?? 0)) throw new DataError(`no bookmark ${String(a.bookmark)}`); return 'removed bookmark'; },
  set_theme: async (tx, a) => {
    const d = await tx.doc(a.doc); const t = a.theme;
    if (typeof t === 'string') { if (!THEMES.some((x) => x.name === t)) throw new DataError(`theme is one of ${THEMES.map((x) => x.name).join(', ')}, or {name, palette, background, foreground, accent}`); d.theme = t; }
    else { const o = O<{ name?: string; palette?: string[] }>(a, 'theme'); if (!Array.isArray(o.palette) || o.palette.length < 2 || !o.palette.every((c) => /^#[0-9a-f]{6}$/i.test(c))) throw new DataError('a theme palette is two or more #rrggbb colours'); d.theme = { name: o.name ?? 'custom', ...(o as object), palette: o.palette }; }
    return `theme ${typeof d.theme === 'string' ? d.theme : d.theme?.name}`;
  },
  set_refresh: async (tx, a) => { const d = await tx.doc(a.doc); d.refresh = checkPolicy(a.refresh); return `refresh ${d.refresh.mode}${d.refresh.every ? ` every ${d.refresh.every}s` : d.refresh.cron ? ` at ${d.refresh.cron}` : ''}`; },
  add_alert: async (tx, a) => {
    const d = await tx.doc(a.doc); const al = O<AlertSpec>(a, 'alert');
    if (!al.name || !al.measure || !['gt', 'ge', 'lt', 'le', 'eq', 'ne'].includes(al.op) || typeof al.value !== 'number') throw new DataError('an alert is {name, measure, op: gt|ge|lt|le|eq|ne, value (a number), notify?}');
    const c = await tx.compiler(al.model ?? d.model); c.measure(al.measure);
    for (const f of al.filters ?? []) checkFilter(f, c);
    const out = { ...al, id: newId('a') };
    d.alerts = [...(d.alerts ?? []), out];
    return { op: a.op, message: `alert ${out.id}: ${al.measure} ${al.op} ${al.value}`, data: { id: out.id } };
  },
  remove_alert: async (tx, a) => { const d = await tx.doc(a.doc); d.alerts = (d.alerts ?? []).filter((x) => x.id !== a.alert && x.name !== a.alert); return 'removed alert'; },
  add_subscription: async (tx, a) => {
    const d = await tx.doc(a.doc); const s = O<SubscriptionSpec>(a, 'subscription');
    try { parseCron(String(s.cron)); } catch (e) { throw new DataError(`subscription cron: ${(e as Error).message}`); }
    if (!['pdf', 'html', 'csv', 'xlsx', 'png'].includes(s.format)) throw new DataError('subscription format is pdf, html, csv, xlsx or png');
    if (!['save', 'notify'].includes(s.deliver)) throw new DataError('subscription deliver is save or notify');
    const out = { ...s, id: newId('s') };
    d.subscriptions = [...(d.subscriptions ?? []), out];
    return { op: a.op, message: `subscription ${out.id}: ${s.format} at ${s.cron}, ${s.deliver}`, data: { id: out.id } };
  },
  remove_subscription: async (tx, a) => { const d = await tx.doc(a.doc); d.subscriptions = (d.subscriptions ?? []).filter((x) => x.id !== a.subscription); return 'removed subscription'; },
  set_narrative: async (tx, a) => {
    const d = await tx.doc(a.doc); const { v, page } = findVisual(d, a.visual);
    if (v.type !== 'narrative') throw new DataError(`${v.id} is a ${v.type}, not a narrative`);
    const text = S(a, 'text');
    const { checkNarrative } = await import('./analytics.ts');
    tx.checks.push(async () => { await checkNarrative(tx.svc, tx.home, { ...v, query: { ...v.query, model: v.query?.model ?? d.model } }, text, tx.catalog); });
    v.options = { ...v.options, text };
    await checkVisual(tx, d, v, page);
    return `narrative of ${v.id} set (every number checked against computed measures)`;
  },
  pin: async (tx, a) => {
    const { pinBlock } = await import('./analytics.ts');
    return pinBlock(tx, a);
  },
  bind: async (tx, a) => {
    const d = await tx.doc(a.doc); const { v, page } = findVisual(d, a.visual);
    const q = O<QuerySpec>(a, 'query');
    v.query = q;
    await checkVisual(tx, d, v, page);
    return `bound ${v.id} to ${q.model ? `model ${q.model}` : 'datasets'}: ${visualSummary(v)}`;
  },
};

/** Runs one write op inside a batch (ops that make other ops: pin, duplicate). */
export async function applyHandler(tx: Tx, op: Op): Promise<OpOutcome> {
  const h = H[op.op];
  if (!h) throw new DataError(`${op.op} is not a write op`);
  const r = await h(tx, op);
  return typeof r === 'string' ? { op: op.op, message: r } : r ?? { op: op.op, message: 'done' };
}

// ---------------- layouts ----------------

const pageOf = async (tx: Tx, a: Op) => { const d = await tx.doc(a.doc); return { d, page: a.page ? findPage(d, a.page) : d.pages.find((p) => !p.kind) ?? d.pages[0]! }; };

/** Templates: the built-in ones and those plugins contribute (ui.contributes.dashboardTemplates). */
export function templates(tx: { svc: DataService }): TemplateSpec[] { return [...BUILTIN_TEMPLATES, ...(tx.svc.deps.pluginTemplates?.() ?? [])]; }

/** What fills a template's placeholders: the model's measures, date, fields with few and many values. */
async function templateFields(tx: Tx, modelId: string) {
  const m = tx.model(modelId);
  const state = await tx.home.state();
  const categories: Array<[string, number]> = []; const entities: Array<[string, number]> = []; const numbers: string[] = []; const columns: Array<{ table: string; name: string }> = [];
  for (const t of m.tables) {
    const cols = state.datasets[tx.catalog.datasets.find((d) => d.name === t.dataset)?.id ?? '']?.columns ?? [];
    const text = cols.filter((c) => c.type === 'VARCHAR' && !/(^id$|_id$|_code$|^code$|uuid|key$)/i.test(c.name));
    for (const c of cols) if (c.name !== '__rn') columns.push({ table: t.name, name: c.name });
    for (const c of cols) if (/INT|DOUBLE|DECIMAL|FLOAT/.test(c.type) && !/(^id$|_id$)/i.test(c.name)) numbers.push(`${t.name}.${c.name}`);
    if (!text.length) continue;
    const plan = await tx.svc.plan(tx.home, tx.catalog, [t.dataset]);
    const r = await tx.svc.engine.run({ files: plan.files, views: plan.views, vars: plan.vars, sql: `SELECT ${text.map((c) => `approx_count_distinct(${qid(c.name)})`).join(', ')} FROM ${qid(t.dataset)}` });
    text.forEach((c, i) => { const n = Number(r.rows[0]![i]); if (n >= 2 && n <= 12) categories.push([`${t.name}.${c.name}`, n]); else if (n > 12) entities.push([`${t.name}.${c.name}`, n]); });
  }
  const fact = m.tables.find((t) => m.relationships.some((r) => r.from.startsWith(`${t.name}.`)))?.name ?? m.tables[0]?.name;
  return {
    measures: [...m.measures.filter((x) => !x.calc && !/\[/.test(x.expr ?? '')), ...m.measures.filter((x) => !x.calc && /\[/.test(x.expr ?? ''))].map((x) => x.name),
    date: m.date, categories: categories.sort((a, b) => a[1] - b[1]).map((c) => c[0]), entities: entities.sort((a, b) => a[1] - b[1]).map((c) => c[0]), numbers,
    table: fact, columns: columns.filter((c) => c.table === fact),
  };
}

const LH: Record<string, Handler> = {
  set_layout: async (tx, a) => {
    const { d, page } = await pageOf(tx, a);
    const lay = O<LayoutSpec>(a, 'layout');
    const type = lay.type ?? page.layout?.type ?? 'grid';
    if (!LAYOUT_TYPES_SET.has(type)) throw new DataError(`layout type is one of ${[...LAYOUT_TYPES_SET].join(', ')}`);
    if (lay.aspect && !['16:9', '21:9'].includes(lay.aspect)) throw new DataError('aspect is 16:9 or 21:9');
    if (lay.paper && !['A4', 'Letter'].includes(lay.paper)) throw new DataError('paper is A4 or Letter');
    if (lay.orientation && !['portrait', 'landscape'].includes(lay.orientation)) throw new DataError('orientation is portrait or landscape');
    const same = type === (page.layout?.type ?? 'grid');
    const next = same ? { ...page, layout: { ...page.layout, ...lay, type } } : reflow(page, { ...lay, type });
    Object.assign(page, next);
    for (const v of page.visuals) await checkVisual(tx, d, v, page);
    return same ? `layout options of ${page.id}: ${JSON.stringify(lay)}` : `${page.id} is now a ${type} layout (${page.visuals.length} widgets re-flowed, none removed)`;
  },
  apply_template: async (tx, a) => {
    const t = templates(tx).find((x) => x.id === a.template);
    if (!t) throw new DataError(`no template "${String(a.template)}" (templates: ${templates(tx).map((x) => x.id).join(', ')})`);
    let doc: DocSpec;
    if (a.doc) doc = await tx.doc(a.doc);
    else {
      const r = await LH_create(tx, { op: 'create', doc: { type: t.pages[0]?.layout?.type === 'print' || t.pages[0]?.layout?.type === 'story' ? 'report' : 'dashboard', title: String(a.title ?? t.title), ...(a.model ? { model: a.model } : {}) } });
      doc = await tx.doc((r.data as { id: string }).id);
      doc.pages = [];
    }
    const modelId = String(a.model ?? doc.model ?? '');
    const hasTokens = JSON.stringify(t.pages).includes('$');
    if (hasTokens && !modelId) throw new DataError('a template fills its widgets from a model: give model (model {op:"suggest"} proposes one), or apply a blank-* template');
    if (modelId && !doc.model) doc.model = tx.model(modelId).id;
    const filled = hasTokens ? fillTemplate(t, await templateFields(tx, modelId)) : { pages: t.pages, skipped: [] as string[] };
    const notes = [...filled.skipped];
    const added: string[] = [];
    for (const p of filled.pages) {
      const page: PageSpec = { id: newId('p'), name: String(a.pageName ?? p.name), ...(p.layout ? { layout: JSON.parse(JSON.stringify(p.layout)) as LayoutSpec } : {}), visuals: [] };
      doc.pages.push(page);
      for (const raw of p.visuals) {
        const v = { ...raw, id: newId('v'), ...(raw.title ? { title: raw.title.replace(/[A-Za-z_]\w*\.([A-Za-z_][\w]*)/g, (_m, c: string) => c.replace(/_/g, ' ')) } : {}) } as VisualSpec;
        if (!v.layout) v.layout = place(page, v);
        else if (page.layout?.type === 'canvas') v.layout = { x: v.layout.x * 100, y: v.layout.y * 48, w: v.layout.w * 100 - 8, h: v.layout.h * 48 - 8 };
        try { await checkVisual(tx, doc, v, page); page.visuals.push(v); } catch (e) { notes.push(`${v.title ?? v.type}: ${(e as Error).message}`); }
      }
      added.push(`${page.id} "${page.name}" (${page.layout?.type ?? 'grid'}, ${page.visuals.length} widgets)`);
    }
    if (!doc.pages.length) throw new DataError('the template made no page');
    return { op: a.op, message: `applied template ${t.id} to ${tx.docId(doc)}: ${added.join('; ')}${notes.length ? `. Left out: ${notes.join('; ')}` : ''}`, data: { id: tx.docId(doc), pages: added, skipped: notes } };
  },
  move_widget: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v } = findVisual(d, a.visual);
    const at = a.breakpoint === 'medium' ? 'medium' : a.breakpoint === 'phone' ? 'phone' : 'wide';
    if (a.section !== undefined) { v.section = a.section === null ? undefined : String(a.section); }
    const move = (l: { x: number; y: number; w: number; h: number; z?: number }) => ({ ...l, ...(a.x !== undefined ? { x: Math.round(Number(a.x)) } : {}), ...(a.y !== undefined ? { y: Math.round(Number(a.y)) } : {}) });
    if (at === 'medium') v.layouts = { ...v.layouts, medium: move(v.layouts?.medium ?? v.layout) };
    else if (at === 'phone') v.mobile = { ...v.mobile, ...(a.order !== undefined ? { order: Number(a.order) } : {}), ...(a.hidden !== undefined ? { hidden: a.hidden === true } : {}) };
    else { if (v.locked) throw new DataError(`${v.id} is locked (arrange {lock:false} first)`); v.layout = move(v.layout); }
    // A group moves together on a canvas.
    if (at === 'wide' && v.group && page.layout?.type === 'canvas') { const dx = Number(a.dx ?? 0); const dy = Number(a.dy ?? 0); if (dx || dy) for (const o of page.visuals) if (o !== v && o.group === v.group && !o.locked) o.layout = { ...o.layout, x: Math.max(0, o.layout.x + dx), y: Math.max(0, o.layout.y + dy) }; }
    await checkVisual(tx, d, v, page);
    return `moved ${v.id}${v.section ? ` (section ${v.section})` : ''} to ${at === 'medium' ? JSON.stringify(v.layouts!.medium) : at === 'phone' ? JSON.stringify(v.mobile) : `${v.layout.x},${v.layout.y}`}`;
  },
  resize_widget: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v } = findVisual(d, a.visual);
    if (v.locked) throw new DataError(`${v.id} is locked`);
    const size = (l: { x: number; y: number; w: number; h: number }) => ({ ...l, ...(a.w !== undefined ? { w: Math.round(Number(a.w)) } : {}), ...(a.h !== undefined ? { h: Math.round(Number(a.h)) } : {}) });
    if (a.breakpoint === 'medium') v.layouts = { ...v.layouts, medium: size(v.layouts?.medium ?? v.layout) };
    else if (a.breakpoint === 'phone') v.mobile = { ...v.mobile, h: Math.round(Number(a.h ?? v.mobile?.h ?? v.layout.h)) };
    else v.layout = size(v.layout);
    await checkVisual(tx, d, v, page);
    return `resized ${v.id} to ${v.layout.w}x${v.layout.h}`;
  },
  arrange: async (tx, a) => {
    const d = await tx.doc(a.doc); const { page, v } = findVisual(d, a.visual);
    const zs = page.visuals.map((x) => x.layout.z ?? 0);
    if (a.z !== undefined) v.layout = { ...v.layout, z: a.z === 'front' ? Math.max(0, ...zs) + 1 : a.z === 'back' ? Math.min(0, ...zs) - 1 : Math.round(Number(a.z)) };
    if (a.lock !== undefined) v.locked = a.lock === true || undefined;
    if (a.group !== undefined) v.group = a.group ? String(a.group) : undefined;
    return `${v.id}: z ${v.layout.z ?? 0}${v.locked ? ', locked' : ''}${v.group ? `, group ${v.group}` : ''}`;
  },
  align: async (tx, a) => {
    const d = await tx.doc(a.doc);
    const vs = (Array.isArray(a.visuals) ? a.visuals : []).map((id) => findVisual(d, id).v);
    if (vs.length < 2) throw new DataError('align needs two or more visuals');
    const e = String(a.edge);
    const ref = vs[0]!.layout;
    for (const v of vs) {
      if (v.locked) continue;
      const l = v.layout;
      if (e === 'left') l.x = Math.min(...vs.map((x) => x.layout.x));
      else if (e === 'right') l.x = Math.max(...vs.map((x) => x.layout.x + x.layout.w)) - l.w;
      else if (e === 'top') l.y = Math.min(...vs.map((x) => x.layout.y));
      else if (e === 'bottom') l.y = Math.max(...vs.map((x) => x.layout.y + x.layout.h)) - l.h;
      else if (e === 'hcenter') l.x = Math.round(ref.x + ref.w / 2 - l.w / 2);
      else if (e === 'vcenter') l.y = Math.round(ref.y + ref.h / 2 - l.h / 2);
      else if (e === 'size') { l.w = ref.w; l.h = ref.h; }
      else if (e !== 'distribute') throw new DataError('edge is left, right, top, bottom, hcenter, vcenter, size or distribute');
      l.x = Math.max(0, l.x); l.y = Math.max(0, l.y);
    }
    if (e === 'distribute') {
      const sorted = [...vs].sort((x, y) => x.layout.x - y.layout.x);
      const start = sorted[0]!.layout.x; const end = Math.max(...sorted.map((x) => x.layout.x + x.layout.w));
      const gap = (end - start - sorted.reduce((s, x) => s + x.layout.w, 0)) / Math.max(1, sorted.length - 1);
      let x = start;
      for (const v of sorted) { v.layout.x = Math.round(x); x += v.layout.w + gap; }
    }
    for (const v of vs) await checkVisual(tx, d, v, findVisual(d, v.id).page);
    return `aligned ${vs.map((v) => v.id).join(', ')}: ${e}`;
  },
  pack: async (tx, a) => {
    const { d, page } = await pageOf(tx, a);
    if (page.layout?.type === 'canvas') throw new DataError('a canvas keeps its positions (set_layout to grid to pack)');
    const dir = a.direction === 'left' ? 'left' : 'up';
    const groups = new Map<string, VisualSpec[]>();
    for (const v of page.visuals) groups.set(v.section ?? '', [...(groups.get(v.section ?? '') ?? []), v]);
    const packed = [...groups.values()].flatMap((g) => packLayout(g, dir));
    page.visuals = page.visuals.map((v) => packed.find((p) => p.id === v.id)!);
    void d;
    return `packed ${page.id} ${dir}`;
  },
  add_section: async (tx, a) => {
    const { page } = await pageOf(tx, a);
    if (!['sections', 'tabs'].includes(page.layout?.type ?? '')) throw new DataError('sections are for a sections or tabs layout (set_layout first)');
    const s = O<{ title: string; collapsed?: boolean }>(a, 'section');
    if (!s.title?.trim()) throw new DataError('a section needs a title');
    const id = newId('s');
    page.layout = { ...page.layout!, sections: [...(page.layout!.sections ?? []), { id, title: s.title.trim(), ...(s.collapsed ? { collapsed: true } : {}) }] };
    return { op: a.op, message: `added ${page.layout.type === 'tabs' ? 'tab' : 'section'} ${id} "${s.title}"`, data: { id } };
  },
  update_section: async (tx, a) => {
    const { page } = await pageOf(tx, a);
    const list = page.layout?.sections ?? [];
    const i = list.findIndex((s) => s.id === a.section || s.title === a.section);
    if (i < 0) throw new DataError(`no section "${String(a.section)}" (${list.map((s) => s.id).join(', ') || 'none'})`);
    const p = O<{ title?: string; collapsed?: boolean; to?: number }>(a, 'patch');
    const s = { ...list[i]!, ...(p.title ? { title: p.title } : {}), ...(p.collapsed !== undefined ? { collapsed: p.collapsed === true } : {}) };
    const next = list.filter((_, j) => j !== i);
    next.splice(p.to !== undefined ? Math.max(0, Math.min(next.length, Number(p.to))) : i, 0, s);
    page.layout = { ...page.layout!, sections: next };
    return `updated section ${s.id}`;
  },
  remove_section: async (tx, a) => {
    const { page } = await pageOf(tx, a);
    const list = page.layout?.sections ?? [];
    const s = list.find((x) => x.id === a.section);
    if (!s) throw new DataError(`no section "${String(a.section)}"`);
    if (list.length === 1) throw new DataError('a sections layout keeps one section');
    const rest = list.filter((x) => x !== s);
    for (const v of page.visuals) if (v.section === s.id) v.section = rest[0]!.id;
    page.visuals = [...page.visuals.filter((v) => v.section !== rest[0]!.id), ...packLayout(page.visuals.filter((v) => v.section === rest[0]!.id))];
    page.layout = { ...page.layout!, sections: rest };
    return `removed section ${s.id}; its widgets moved to ${rest[0]!.id}`;
  },
};
const LH_create = async (tx: Tx, op: Op) => (await H.create!(tx, op)) as OpOutcome;
Object.assign(H, LH);

async function allDocs(tx: Tx): Promise<Map<string, DocSpec>> {
  const out = new Map<string, DocSpec>();
  for (const m of await tx.home.docs()) { const x = tx.docs.get(m.id); if (x?.deleted) continue; out.set(m.id, x?.spec ?? (await tx.home.doc(m.id)).spec); }
  for (const [id, x] of tx.docs) if (x.created && !x.deleted) out.set(id, x.spec);
  return out;
}

// ---------------- diff ----------------

function byKey<T>(xs: T[] | undefined, k: (x: T) => string): Map<string, T> { return new Map((xs ?? []).map((x) => [k(x), x])); }
function diffList<T>(label: string, a: T[] | undefined, b: T[] | undefined, key: (x: T) => string, show: (x: T) => string, out: string[]): void {
  const A = byKey(a, key); const B = byKey(b, key);
  for (const [k, x] of B) { const y = A.get(k); if (!y) out.push(`+ ${label} ${show(x)}`); else if (JSON.stringify(y) !== JSON.stringify(x)) out.push(`~ ${label} ${show(x)}`); }
  for (const [k, y] of A) if (!B.has(k)) out.push(`- ${label} ${show(y)}`);
}
export function diffCatalog(a: CatalogSpec, b: CatalogSpec): string[] {
  const out: string[] = [];
  diffList('source', a.sources, b.sources, (x) => x.id, (x) => `${x.id} "${x.name}"`, out);
  diffList('dataset', a.datasets, b.datasets, (x) => x.id, (x) => `${x.name}${x.steps?.length ? ` (${x.steps.length} steps)` : ''}`, out);
  diffList('model', a.models.map((m) => ({ id: m.id, name: m.name, date: m.date })), b.models.map((m) => ({ id: m.id, name: m.name, date: m.date })), (x) => x.id, (x) => x.id, out);
  for (const m of b.models) {
    const p = a.models.find((x) => x.id === m.id);
    diffList(`${m.id} table`, p?.tables, m.tables, (x) => x.name, (x) => x.name, out);
    diffList(`${m.id} relationship`, p?.relationships, m.relationships, (x) => x.id ?? `${x.from}->${x.to}`, (x) => `${x.from} -> ${x.to}`, out);
    diffList(`${m.id} measure`, p?.measures, m.measures, (x) => x.name, (x) => `"${x.name}"`, out);
    diffList(`${m.id} hierarchy`, p?.hierarchies, m.hierarchies, (x) => x.name, (x) => x.name, out);
    diffList(`${m.id} role`, p?.roles, m.roles, (x) => x.name, (x) => x.name, out);
    if (JSON.stringify(p?.formats ?? {}) !== JSON.stringify(m.formats)) out.push(`~ ${m.id} formats`);
  }
  return out;
}
export function diffDoc(a: DocSpec | undefined, b: DocSpec | undefined): string[] {
  if (!a && b) return [`+ ${b.type} "${b.title}"`];
  if (a && !b) return [`- ${a.type} "${a.title}"`];
  if (!a || !b) return [];
  const out: string[] = [];
  for (const k of ['title', 'description', 'model', 'theme', 'refresh', 'header', 'footer', 'filters', 'snapshot'] as const) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(`~ ${k}${k === 'snapshot' ? '' : `: ${JSON.stringify(b[k] ?? null).slice(0, 80)}`}`);
  const pg = (p: PageSpec) => ({ id: p.id, name: p.name, kind: p.kind, filters: p.filters, drillFields: p.drillFields, layout: p.layout });
  diffList('page', a.pages.map(pg), b.pages.map(pg), (x) => x.id, (x) => `${x.id} "${x.name}"${x.layout ? ` (${x.layout.type} layout)` : ''}`, out);
  diffList('visual', a.pages.flatMap((p) => p.visuals), b.pages.flatMap((p) => p.visuals), (x) => x.id, (x) => `${x.id} ${visualSummary(x)}`, out);
  diffList('bookmark', a.bookmarks, b.bookmarks, (x) => x.id, (x) => `"${x.name}"`, out);
  diffList('alert', a.alerts, b.alerts, (x) => x.id, (x) => `"${x.name}"`, out);
  diffList('subscription', a.subscriptions, b.subscriptions, (x) => x.id, (x) => `${x.format} ${x.cron}`, out);
  return out;
}

// ---------------- apply ----------------

const ACTIONS = new Set(['refresh', 'publish', 'unpublish', 'export', 'test_source', 'undo', 'redo', 'restore', 'snapshot']);
export const READS = new Set(Object.entries(OPS).filter(([k, v]) => !v.write && !ACTIONS.has(k)).map(([k]) => k));
export const WRITES = new Set(Object.keys(H));

/** Applies a batch of ops for a person or an agent: checked, written together, logged, then actions and reads run in order. */
export async function applyOps(svc: DataService, home: DataHome, ops: Op[], actor: Actor, o: ApplyOptions = {}): Promise<ApplyResult> {
  if (!Array.isArray(ops) || !ops.length) throw new DataError('no ops: give op (one) or ops [{op, ...}]');
  if (ops.length > 100) throw new DataError('at most 100 ops in one batch');
  for (const [i, x] of ops.entries()) {
    if (!x || typeof x.op !== 'string' || !OPS[x.op]) throw new DataError(`op ${i + 1}: "${String(x?.op)}" is not an op. Ops: ${Object.keys(OPS).join(', ')}`);
    if (o.readOnly && (WRITES.has(x.op) || ACTIONS.has(x.op))) throw new DataError(`op ${i + 1} (${x.op}) changes something: not allowed here`);
  }
  return home.serial(async () => {
    const { reads } = await import('./analytics.ts');
    const cat = await home.catalog();
    const tx = new Tx(svc, home, cat.spec, actor, o);
    const results: OpOutcome[] = [];
    const later: Array<{ i: number; op: Op }> = [];
    for (const [i, op] of ops.entries()) {
      if (!WRITES.has(op.op)) { later.push({ i, op }); results.push({ op: op.op, message: '' }); continue; }
      try {
        const r = await H[op.op]!(tx, op);
        results.push(typeof r === 'string' ? { op: op.op, message: r } : r ?? { op: op.op, message: 'done' });
      } catch (e) { throw new DataError(`op ${i + 1} (${op.op}): ${(e as Error).message}`, (e as DataError).status ?? 400); }
    }
    for (const c of tx.checks) {
      try { await c(); } catch (e) { throw new DataError(`not applied: ${(e as Error).message}`, (e as DataError).status ?? 400); }
    }
    // Commit: the catalog and each document as a new version, and one log entry per target.
    const changed: ApplyResult['changed'] = [];
    const diff: string[] = [];
    const names = ops.filter((x) => WRITES.has(x.op)).map((x) => x.op);
    if (tx.catalogTouched && JSON.stringify(tx.catalog) !== JSON.stringify(tx.catalogBefore)) {
      const from = cat.version;
      const v = await home.write(CATALOG_ID, tx.catalog, 'Data catalog');
      await home.append({ target: CATALOG_ID, from, to: v, by: actor.label, ...(actor.session ? { session: actor.session } : {}), ops: names, kind: 'ops' });
      changed.push({ target: CATALOG_ID, version: v, title: 'Data catalog' });
      diff.push(...diffCatalog(tx.catalogBefore, tx.catalog));
    }
    for (const r of tx.roots) await svc.grantRoot(home, r);
    for (const [id, x] of tx.docs) {
      if (x.deleted) { if (!x.created) { await home.remove(id); diff.push(`- ${x.spec.type} ${id} "${x.spec.title}"`); changed.push({ target: id, version: 0, title: x.spec.title }); } continue; }
      if (!x.created && JSON.stringify(x.spec) === JSON.stringify(x.before)) continue;
      const from = x.created ? 0 : await home.versionOf(id);
      const v = await home.write(id, x.spec, x.spec.title, x.created ? 'create' : 'rewrite');
      await home.append({ target: id, from, to: v, by: actor.label, ...(actor.session ? { session: actor.session } : {}), ops: names, kind: 'ops' });
      changed.push({ target: id, version: v, title: x.spec.title });
      diff.push(...diffDoc(x.before, x.spec).map((l) => `${id}: ${l}`));
      svc.emit(home.owner, { type: 'doc_changed', doc: id, version: v, by: actor.label });
    }
    if (tx.catalogTouched) svc.emit(home.owner, { type: 'catalog_changed', by: actor.label });
    // Newly defined datasets with a source are read now, so the next step can use their columns.
    let untrusted = false;
    for (const { i, op } of later) {
      try {
        const r = await reads(svc, home, op, actor, tx);
        results[i] = r;
        if ((r as OpOutcome & { untrusted?: boolean }).untrusted) untrusted = true;
      } catch (e) { results[i] = { op: op.op, message: `error: ${(e as Error).message}`, data: { error: (e as Error).message } }; if (later.length === 1 && !changed.length) throw e; }
    }
    for (const f of tx.after) results.push(await f());
    return { results, changed, diff, ...(untrusted ? { untrusted } : {}) };
  });
}

export { COLUMN_TYPES };
