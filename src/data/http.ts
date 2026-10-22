import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { type DocSpec, type FilterSpec, FILTER_OPS, type ModelSpec, parseField, type QueryResult, type Scalar } from '../../packages/plugin-ui/src/bi.ts';
import { publicSource } from './sources.ts';
import { reads, type ViewState, visualData } from './analytics.ts';
import { DataError } from './engine.ts';
import { exportDoc, toCsv, viewerDir, viewerHtml } from './export.ts';
import { applyOps, type Actor, type Op } from './ops.ts';
import type { DataService, PublishedEntry, Viewer } from './service.ts';

// HTTP: /api/data/* for the signed-in person (every change through POST /api/data/ops), and the
// published pages /p/<slug>: the viewer (the same renderers as the app), the document without its
// SQL or sources, each visual's numbers for the viewer's state (row-level security applied on the
// server), live refresh over server-sent events, and CSV of a visual. Unpublishing cuts them off at once.

export interface DataHttpContext {
  svc: DataService;
  appRoot: string;
  /** The signed-in principal of a request, if any (for "signed-in" published pages). */
  whoami(req: http.IncomingMessage): { id?: string; name: string; role: string } | undefined;
  /** Folders of the person's sessions (a file source may name a path there). */
  workspaceOf?(sessionId: string, owner: string | undefined): string | undefined;
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(data);
}
async function body(req: http.IncomingMessage, limit = 2_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > limit) throw new DataError('request body too large', 413); chunks.push(c as Buffer); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  try { const j = JSON.parse(text) as unknown; if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object'); return j as Record<string, unknown>; } catch { throw new DataError('the body must be a JSON object', 400); }
}
const fail = (res: http.ServerResponse, e: unknown) => { const status = e instanceof DataError ? e.status : 500; send(res, status >= 400 && status < 600 ? status : 400, { error: (e as Error).message }); };

/** The signed-in person's data API. Returns false when the path is not one of these. */
export async function dataRoutes(ctx: DataHttpContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL, me: { id?: string; name: string; role: string }): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/data/') && p !== '/api/data') return false;
  const { svc } = ctx;
  const home = svc.home(me.id);
  const method = req.method ?? 'GET';
  const actor: Actor = { kind: 'person', account: me.id, label: me.id ? `person:${me.id}` : 'person:operator' };
  try {
    if (p === '/api/data/ops' && method === 'POST') {
      const b = await body(req);
      const ops = (Array.isArray(b.ops) ? b.ops : [b]) as Op[];
      { send(res, 200, await applyOps(svc, home, ops, actor, {})); return true; }
    }
    if (p === '/api/data/catalog' && method === 'GET') {
      const c = await home.catalog();
      const st = await home.state();
      { send(res, 200, { version: c.version, sources: c.spec.sources.map(publicSource), datasets: c.spec.datasets.map((d) => ({ ...d, state: st.datasets[d.id] ?? {} })), models: c.spec.models, runs: await home.runs(50) }); return true; }
    }
    if (p === '/api/data/docs' && method === 'GET') { send(res, 200, (await reads(svc, home, { op: 'list_docs' }, actor)).data); return true; }
    const dm = /^\/api\/data\/docs\/((?:dash|rep)-[a-z0-9]{6,12})(?:\/(visual|history|published|export))?$/.exec(p);
    if (dm) {
      const id = dm[1]!;
      if (!dm[2] && method === 'GET') {
        const v = url.searchParams.get('version');
        const d = await home.doc(id, v ? Number(v) : undefined);
        const pub = (await svc.published()).find((x) => x.owner === home.owner && x.doc === id);
        if (!v) void home.countView(id, 'app').catch(() => {});
        const cat = (await home.catalog()).spec;
        const model = d.spec.model ? cat.models.find((m) => m.id === d.spec.model) : undefined;
        { send(res, 200, { id, version: d.version, versions: d.meta.versions.map((x) => ({ n: x.n, at: x.at })), doc: d.spec, model, published: pub ? { slug: pub.slug, access: pub.access, role: pub.role, at: pub.at } : null }); return true; }
      }
      if (dm[2] === 'visual' && method === 'POST') {
        const b = await body(req);
        const { spec } = await home.doc(id);
        const v = spec.pages.flatMap((x) => x.visuals).find((x) => x.id === b.visual) ?? (b.spec as DocSpec['pages'][number]['visuals'][number] | undefined);
        if (!v) throw new DataError(`no visual ${String(b.visual)}`, 404);
        let viewer: Viewer = { owner: true, showSql: true };
        if (typeof b.viewAs === 'string' && b.viewAs) {
          // "View as role": the owner checks what a role's members see.
          const cat = (await home.catalog()).spec;
          const m = spec.model ? cat.models.find((x) => x.id === spec.model) : undefined;
          const role = m?.roles.find((r) => r.name === b.viewAs);
          if (!role) throw new DataError(`no role ${String(b.viewAs)}`);
          viewer = { owner: false, user: me.id, roles: [role], showSql: true };
        }
        const ctl = new AbortController(); req.on('close', () => { if (!res.writableEnded) ctl.abort(); });
        { send(res, 200, await visualData(svc, home, spec, v, (b.state ?? {}) as ViewState, viewer, { signal: ctl.signal })); return true; }
      }
      if (dm[2] === 'export' && method === 'GET') {
        const r = await exportDoc(svc, home, id, (url.searchParams.get('format') ?? 'xlsx') as 'xlsx', { visual: url.searchParams.get('visual') ?? undefined, appRoot: ctx.appRoot });
        if (r.contentType === 'inode/directory') { send(res, 200, { path: r.path }); return true; }
        res.writeHead(200, { 'content-type': r.contentType, 'content-disposition': `attachment; filename="${r.file}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
        { res.end(await fs.readFile(r.path)); return true; }
      }
    }
    if (p === '/api/data/query' && method === 'POST') {
      const b = await body(req);
      const r = b.sql ? await svc.sql(home, String(b.sql), { limit: Number(b.limit ?? 5000) }) : await svc.query(home, (b.query ?? {}) as never, undefined, { limit: Number(b.limit ?? 5000), highlight: b.highlight as FilterSpec[] | undefined });
      { send(res, 200, r); return true; }
    }
    if (p === '/api/data/uploads' && method === 'POST') {
      const b = await body(req, 60_000_000);
      const name = path.basename(String(b.name ?? '')).replace(/[^\w.\- ]+/g, '_');
      if (!name || !/\.(csv|tsv|json|ndjson|jsonl|parquet|xlsx|geojson|sqlite|db)$/i.test(name)) throw new DataError('upload a .csv, .tsv, .json, .parquet, .xlsx, .geojson or .sqlite file');
      const data = Buffer.from(String(b.base64 ?? ''), 'base64');
      if (!data.length) throw new DataError('the file is empty');
      const dir = home.path('uploads'); await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, name);
      await fs.writeFile(file, data);
      { send(res, 200, { path: file, bytes: data.length }); return true; }
    }
    if (p === '/api/data/runs' && method === 'GET') { send(res, 200, await home.runs(Number(url.searchParams.get('limit') ?? 200))); return true; }
    if (p === '/api/data/cancel' && method === 'POST') { const b = await body(req); { send(res, 200, { ok: svc.engine.cancel(String(b.id ?? '')) }); return true; } }
    const geo = /^\/api\/data\/geo\/([\w-]{3,64})$/.exec(p);
    if (geo && method === 'GET') { send(res, 200, await geoJson(svc, home, geo[1]!)); return true; }
    if (p === '/api/data/import' && method === 'POST') { send(res, 201, await importBundle(svc, home, await body(req, 50_000_000), actor)); return true; }
    throw new DataError('not found', 404);
  } catch (e) { fail(res, e); }
  return true;
}

async function geoJson(svc: DataService, home: import('./home.ts').DataHome, ref: string): Promise<unknown> {
  const cat = (await home.catalog()).spec;
  const s = cat.sources.find((x) => x.id === ref || x.name === ref);
  if (!s || s.type !== 'file' || !/\.geojson$|\.json$/i.test(s.path ?? '')) throw new DataError(`no GeoJSON source ${ref}`, 404);
  const { allowedFile } = await import('./sources.ts');
  return JSON.parse(await fs.readFile(await allowedFile(s.path!, await svc.roots(home)), 'utf8'));
}

/**
 * Another server's dashboard, pushed here to publish (no credentials travel: its datasets arrive
 * as data, become static datasets here, and are replaced on each push).
 */
async function importBundle(svc: DataService, home: import('./home.ts').DataHome, b: Record<string, unknown>, actor: Actor): Promise<unknown> {
  const doc = b.doc as DocSpec | undefined;
  const model = b.model as ModelSpec | undefined;
  const data = (b.datasets ?? []) as Array<{ name: string; columns: string[]; rows: Scalar[][] }>;
  const from = String(b.from ?? 'another server').slice(0, 100);
  if (!doc?.pages || !Array.isArray(data)) throw new DataError('an import is {doc, model?, datasets: [{name, columns, rows}], from}');
  const cat = (await home.catalog()).spec;
  const ops: Op[] = [];
  for (const d of data) {
    const existing = cat.datasets.find((x) => x.name === d.name);
    const source = { name: `${d.name} (from ${from})`, type: 'static', columns: d.columns, rows: d.rows, provenance: { sources: [from], note: 'pushed by its server' } };
    if (existing?.source) ops.push({ op: 'update_source', id: existing.source, patch: { columns: d.columns, rows: d.rows } });
    else { const id = `src-${crypto.randomBytes(4).toString('hex')}`; ops.push({ op: 'add_source', source: { ...source, id } }, { op: 'define', dataset: { name: d.name, source: id } }); }
  }
  if (model && !cat.models.some((m) => m.id === model.id)) {
    ops.push({ op: 'add_model', model: { id: model.id, name: model.name, date: model.date } });
    for (const t of model.tables) ops.push({ op: 'set_table', model: model.id, table: t });
    for (const r of model.relationships) ops.push({ op: 'set_relationship', model: model.id, relationship: r });
    for (const m of model.measures) ops.push({ op: 'set_measure', model: model.id, measure: m });
    for (const h of model.hierarchies) ops.push({ op: 'set_hierarchy', model: model.id, hierarchy: h });
    for (const r of model.roles) ops.push({ op: 'set_role', model: model.id, role: r });
  }
  const r = ops.length ? await applyOps(svc, home, ops, actor) : undefined;
  // The document itself, as it was there (kept under the same id when pushed again).
  const target = typeof b.id === 'string' && /^(dash|rep)-[a-z0-9]{6,12}$/.test(b.id) ? b.id : undefined;
  let id = target && (await home.store.meta(target)) ? target : undefined;
  if (id) await home.write(id, doc, doc.title); else { id = target ?? `${doc.type === 'report' ? 'rep' : 'dash'}-${crypto.randomBytes(4).toString('hex')}`; await home.write(id, doc, doc.title, 'create'); }
  for (const d of data) { const ds = (await home.catalog()).spec.datasets.find((x) => x.name === d.name); if (ds) await svc.refresh(home, ds.id, `pushed from ${from}`); }
  const pub = (await svc.published()).find((x) => x.owner === home.owner && x.doc === id);
  const out = pub && !b.republish ? { entry: pub } : await svc.publish(home.owner, id, { access: b.access === 'signed-in' ? 'signed-in' : 'token', by: actor.label });
  svc.emit(home.owner, { type: 'refreshed', doc: id, at: Date.now(), failed: [] });
  return { id, slug: out.entry.slug, ...('token' in out && out.token ? { token: out.token } : {}), changed: r?.changed ?? [] };
}

// ---------------- published pages ----------------

const ASSET_TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json' };
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'none'";

/** Fields a published page may filter on: those the document itself shows or slices by. */
function allowedFields(doc: DocSpec, model?: ModelSpec): Set<string> {
  const out = new Set<string>();
  const add = (f?: string) => { if (f && parseField(f)) out.add(f); };
  for (const f of doc.filters ?? []) add(f.field);
  for (const p of doc.pages) {
    for (const f of [...(p.filters ?? []), ...(p.drillFields ?? []).map((x) => ({ field: x }))]) add(f.field);
    for (const v of p.visuals) {
      for (const f of [...(v.query?.dims ?? []), ...(v.query?.columns ?? []), v.options?.slicer?.field, ...(v.options?.dims ?? []), ...(v.options?.detail ?? [])]) add(f);
      if (v.options?.hierarchy) for (const l of model?.hierarchies.find((h) => h.name === v.options!.hierarchy)?.levels ?? []) add(l);
    }
  }
  for (const b of doc.bookmarks ?? []) for (const f of b.filters ?? []) add(f.field);
  // Each field at every grain (a slicer on a date filters at another grain than a chart draws).
  for (const f of [...out]) { const x = parseField(f)!; out.add(`${x.table}.${x.column}`); for (const g of ['year', 'quarter', 'month', 'week', 'day']) out.add(`${x.table}.${x.column}:${g}`); }
  return out;
}
function cleanState(s: unknown, allowed: Set<string>): ViewState {
  const o = (s && typeof s === 'object' ? s : {}) as ViewState;
  const fl = (fs: unknown): FilterSpec[] => (Array.isArray(fs) ? fs : []).slice(0, 50).map((f: FilterSpec) => {
    if (!f || !allowed.has(String(f.field))) throw new DataError(`this page cannot filter on ${String(f?.field)}`, 403);
    if (!(FILTER_OPS as readonly string[]).includes(f.op) || f.op === 'top' || f.op === 'bottom') throw new DataError('filter op not allowed here', 403);
    const vals = (f.values ?? []).filter((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 500);
    const sc = (v: unknown) => (v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v as Scalar : undefined);
    return { field: f.field, op: f.op, ...(f.values ? { values: vals } : {}), ...(sc(f.value) !== undefined ? { value: sc(f.value) } : {}), ...(sc(f.to) !== undefined ? { to: sc(f.to) } : {}), ...(f.n ? { n: Number(f.n) } : {}), ...(f.unit ? { unit: f.unit } : {}), ...(f.current ? { current: true } : {}) };
  });
  return {
    ...(o.page ? { page: String(o.page) } : {}),
    filters: fl(o.filters),
    ...(o.selection ? { selection: { visual: String(o.selection.visual), filters: fl(o.selection.filters) } } : {}),
    ...(o.drill ? { drill: Object.fromEntries(Object.entries(o.drill).slice(0, 50).map(([k, v]) => [k, { level: Number(v?.level ?? 0), path: (Array.isArray(v?.path) ? v.path : []).slice(0, 6) as Scalar[] }])) } : {}),
    ...(o.drillthrough ? { drillthrough: fl(o.drillthrough) } : {}),
    ...(o.decomp ? { decomp: Object.fromEntries(Object.entries(o.decomp).slice(0, 20).map(([k, v]) => [k, (Array.isArray(v) ? v : []).slice(0, 8).map((x) => { if (!allowed.has(String(x?.dim))) throw new DataError('decomposition dims are the visual\'s own', 403); return { dim: String(x.dim), value: x.value as Scalar }; })])) } : {}),
  };
}
/** The document as a viewer may see it: no measure expressions, SQL, sources, alerts or subscriptions. */
function publicDoc(doc: DocSpec, showSql: boolean): DocSpec {
  const d = JSON.parse(JSON.stringify(doc)) as DocSpec;
  delete d.alerts; delete d.subscriptions;
  if (!showSql) for (const p of d.pages) for (const v of p.visuals) if (v.query?.measures) v.query.measures = v.query.measures.map((m) => (typeof m === 'string' ? m : { name: m.name, ...(m.format ? { format: m.format } : {}) }));
  if (d.snapshot && !showSql) for (const r of Object.values(d.snapshot.results)) stripResult(r, false);
  return d;
}
function stripResult(r: QueryResult, showSql: boolean): QueryResult {
  if (!showSql) r.lineage = { datasets: r.lineage.datasets.map(({ name, refreshedAt, rows, static: st, origin }) => ({ name, refreshedAt, rows, ...(st ? { static: st, origin } : {}) })) };
  return r;
}

/** Who may see a published page, and with which row-level security. */
async function access(ctx: DataHttpContext, req: http.IncomingMessage, slug: string): Promise<{ entry: PublishedEntry; viewer: Viewer; doc: DocSpec; model?: ModelSpec }> {
  const entry = (await ctx.svc.published()).find((x) => x.slug === slug);
  if (!entry) throw new DataError('this page is not published (or was unpublished)', 404);
  const home = ctx.svc.home(entry.owner);
  let user: string | undefined;
  if (entry.access === 'token') {
    const t = String(req.headers['x-harness-share'] ?? '');
    const h = crypto.createHash('sha256').update(t).digest('hex');
    if (!t || !entry.tokenHash || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(entry.tokenHash))) throw new DataError('this link needs its share token (the part after #t= in the address)', 401);
  } else {
    const who = ctx.whoami(req);
    if (!who) throw new DataError('sign in to see this page', 401);
    if (entry.accounts?.length && !entry.accounts.includes('*') && !(who.id && entry.accounts.includes(who.id)) && who.id !== entry.owner) throw new DataError('this page is not shared with you', 403);
    user = who.id;
  }
  const { spec } = await home.doc(entry.doc);
  const cat = (await home.catalog()).spec;
  const model = spec.model ? cat.models.find((m) => m.id === spec.model) : undefined;
  // A link (token) shows its role's rows, or, published without a role, what the owner published.
  // Signed-in viewers see the rows of the roles they are members of (none: no data, when the model has roles).
  const roles = model?.roles.filter((r) => (entry.access === 'token' ? r.name === entry.role : (entry.role ? r.name === entry.role : false) || r.members.includes('*') || (!!user && r.members.includes(user)))) ?? [];
  const all = (entry.access === 'token' && !entry.role) || (entry.access === 'signed-in' && user === entry.owner && !entry.role) || !model?.roles.length;
  return { entry, doc: spec, model, viewer: all ? { owner: true, showSql: !!entry.showSql } : { owner: false, user, roles, showSql: !!entry.showSql } };
}

const streams = new Map<string, Set<http.ServerResponse>>();

/** /p/... : published pages. Returns false for other paths. */
export async function publishedRoutes(ctx: DataHttpContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/p/')) return false;
  const method = req.method ?? 'GET';
  try {
    const asset = /^\/p\/_\/([\w.-]+)$/.exec(p);
    if (asset && method === 'GET') {
      const dir = viewerDir(ctx.appRoot);
      const f = dir ? path.join(dir, asset[1]!) : '';
      if (!dir || !ASSET_TYPES[path.extname(f)] || !(await fs.stat(f).catch(() => null))?.isFile()) throw new DataError(dir ? 'not found' : 'the dashboard viewer is not built on this server (node apps/desktop/scripts/build-viewer.mjs)', dir ? 404 : 503);
      res.writeHead(200, { 'content-type': ASSET_TYPES[path.extname(f)]!, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
      { res.end(await fs.readFile(f)); return true; }
    }
    const m = /^\/p\/([A-Za-z0-9_-]{16})(?:\/api\/(doc|visual|events|export|geo\/[\w-]+))?\/?$/.exec(p);
    if (!m) throw new DataError('not found', 404);
    const slug = m[1]!;
    if (!m[2]) {
      if (!(await ctx.svc.published()).some((x) => x.slug === slug)) throw new DataError('this page is not published (or was unpublished)', 404);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
      { res.end(viewerHtml('Dashboard', { base: '/p/_/' })); return true; }
    }
    const a = await access(ctx, req, slug);
    const home = ctx.svc.home(a.entry.owner);
    if (m[2] === 'doc' && method === 'GET') {
      void home.countView(a.entry.doc, 'published').catch(() => {});
      { send(res, 200, { doc: publicDoc(a.doc, !!a.entry.showSql), hierarchies: a.model?.hierarchies ?? [], formats: a.model?.formats ?? {}, role: a.viewer.roles?.map((r) => r.name) ?? [], published: { at: a.entry.at } }); return true; }
    }
    if (m[2] === 'visual' && method === 'POST') {
      const b = await body(req, 200_000);
      const v = a.doc.pages.flatMap((x) => x.visuals).find((x) => x.id === b.visual);
      if (!v) throw new DataError('no such visual', 404);
      const state = cleanState(b.state, allowedFields(a.doc, a.model));
      const r = await visualData(ctx.svc, home, a.doc, v, state, a.viewer);
      { send(res, 200, stripResult(JSON.parse(JSON.stringify(r)) as QueryResult, !!a.entry.showSql)); return true; }
    }
    if (m[2] === 'export' && method === 'GET') {
      const v = a.doc.pages.flatMap((x) => x.visuals).find((x) => x.id === url.searchParams.get('visual'));
      if (!v) throw new DataError('no such visual', 404);
      const r = await visualData(ctx.svc, home, a.doc, v, {}, a.viewer);
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${(v.title ?? v.id).replace(/[^\w -]+/g, '')}.csv"`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      { res.end(toCsv(r)); return true; }
    }
    if (m[2]?.startsWith('geo/') && method === 'GET') {
      const ref = m[2].slice(4);
      if (!a.doc.pages.some((pg) => pg.visuals.some((v) => v.options?.geo?.source === ref))) throw new DataError('not found', 404);
      { send(res, 200, await geoJson(ctx.svc, home, ref)); return true; }
    }
    if (m[2] === 'events' && method === 'GET') {
      // Live: a "refreshed" message whenever the server refreshes this document's data; "gone" when unpublished.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      const set = streams.get(slug) ?? new Set(); set.add(res); streams.set(slug, set);
      const datasets = new Set(ctx.svc.docDatasets(a.doc, (await home.catalog()).spec));
      const off = ctx.svc.on((e) => {
        if (e.owner !== a.entry.owner) return;
        if (e.type === 'unpublished' && e.doc === a.entry.doc) { res.write('data: {"type":"gone"}\n\n'); res.end(); return; }
        if ((e.type === 'refreshed' || e.type === 'doc_changed') && e.doc === a.entry.doc) res.write(`data: ${JSON.stringify({ type: e.type, at: Date.now() })}\n\n`);
        else if (e.type === 'dataset_refreshed' && datasets.has(String(e.dataset))) res.write(`data: ${JSON.stringify({ type: 'refreshed', at: Date.now() })}\n\n`);
      });
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => { off(); clearInterval(ping); set.delete(res); });
      return true;
    }
    throw new DataError('not found', 404);
  } catch (e) { fail(res, e); }
  return true;
}
