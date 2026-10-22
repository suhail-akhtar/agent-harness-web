/**
 * core.dashboards' one door to the server: every control applies an op from the catalogue
 * (UI_ACTIONS -> POST /api/data/ops), the same ops agents apply. A change comes back with its diff
 * and versions; the toast offers Undo. Plus the stores the pages read and the dashboard client.
 */

import { create } from 'zustand';
import { type CatalogSpec, type DatasetSpec, type DocSpec, type FilterSpec, type ModelSpec, type QueryResult, type SourceSpec, UI_ACTIONS, type ViewState, type VisualSpec } from '@harness/plugin-ui';
import { toast, type BiClient } from '@harness/ui';
import { client, globalBus } from '../../state/data';

export interface OpOutcome { op: string; message: string; data?: Record<string, unknown> & { id?: string } }
export interface ApplyResult { results: OpOutcome[]; changed: Array<{ target: string; version: number; title: string }>; diff: string[] }
export type DatasetRow = DatasetSpec & { state: { file?: string; at?: number; rows?: number; error?: string; columns?: Array<{ name: string; type: string }>; sourceColumns?: Array<{ name: string; type: string }>; incremental?: { cutoff: string; replaced: number } } };
export interface Catalog { version: number; sources: SourceSpec[]; datasets: DatasetRow[]; models: ModelSpec[]; runs: Array<Record<string, unknown>> }
export interface DocListItem { id: string; type: 'dashboard' | 'report'; title: string; version: number; updatedAt: number; pages: number; visuals: number; model?: string; views: number; published: boolean; refresh: string }
export interface DocDetail { id: string; version: number; versions: Array<{ n: number; at: number }>; doc: DocSpec; model?: ModelSpec; published: { slug: string; access: string; role?: string; at: number } | null }

/** Applies the op behind a control (atomic with the others in `more`); toasts the change with Undo. */
export async function act(action: keyof typeof UI_ACTIONS | string, args: Record<string, unknown> = {}, o: { quiet?: boolean; more?: Array<[string, Record<string, unknown>]> } = {}): Promise<ApplyResult> {
  const ops = [[action, args] as [string, Record<string, unknown>], ...(o.more ?? [])].map(([a, x]) => {
    const op = UI_ACTIONS[a];
    if (!op) throw new Error(`${a} is not an action of the app`);
    return { op, ...x };
  });
  try {
    const r = await client.post<ApplyResult>('/api/data/ops', { ops });
    if (!o.quiet && r.changed.length) {
      const targets = r.changed.filter((c) => c.version > 0).map((c) => c.target);
      toast(r.diff[0] ? `${r.diff[0].replace(/^[\w-]+: /, '')}${r.diff.length > 1 ? ` (+${r.diff.length - 1} more)` : ''}` : r.results[0]?.message ?? 'Done', {
        kind: 'success',
        ...(targets.length ? { action: { label: 'Undo', run: () => { for (const t of targets.reverse()) void act(t === 'catalog' ? 'doc.undo' : 'doc.undo', t === 'catalog' ? { target: 'catalog' } : { doc: t }, { quiet: true }).then(() => toast('Undone')); } } } : {}),
      });
    }
    void useDataStore.getState().refreshAfter(r);
    return r;
  } catch (e) {
    if (!o.quiet) toast((e as Error).message, { kind: 'error' });
    throw e;
  }
}

interface DataStore {
  catalog: Catalog | null;
  docs: DocListItem[] | null;
  docVersion: Record<string, number>;
  refreshCatalog(): Promise<void>;
  refreshDocs(): Promise<void>;
  refreshAfter(r: ApplyResult): Promise<void>;
}

export const useDataStore = create<DataStore>((set, get) => ({
  catalog: null, docs: null, docVersion: {},
  async refreshCatalog() { try { set({ catalog: await client.get<Catalog>('/api/data/catalog') }); } catch { /* engine down */ } },
  async refreshDocs() { try { set({ docs: await client.get<DocListItem[]>('/api/data/docs') }); } catch { /* engine down */ } },
  async refreshAfter(r) {
    if (r.changed.some((c) => c.target === 'catalog')) await get().refreshCatalog();
    const docs = r.changed.filter((c) => c.target !== 'catalog');
    if (docs.length) { set({ docVersion: { ...get().docVersion, ...Object.fromEntries(docs.map((d) => [d.target, d.version])) } }); await get().refreshDocs(); }
  },
}));

/** Live: the server's data events (refreshes, changes made by agents) keep the pages current. */
export function listenData(): () => void {
  return globalBus.on((e) => {
    if (e.topic !== 'data') return;
    const p = (e.payload ?? {}) as { type?: string; doc?: string; version?: number };
    const s = useDataStore.getState();
    if (p.type === 'catalog_changed' || p.type === 'dataset_refreshed' || p.type === 'refresh_failed') void s.refreshCatalog();
    if (p.type === 'doc_changed' && p.doc) { useDataStore.setState({ docVersion: { ...s.docVersion, [p.doc]: p.version ?? Date.now() } }); void s.refreshDocs(); }
    if (p.type === 'published' || p.type === 'unpublished') void s.refreshDocs();
    for (const f of refreshListeners) f(p);
  });
}
const refreshListeners = new Set<(p: { type?: string; doc?: string }) => void>();

/** The dashboard's numbers through the server, as the owner (or "view as" a role). */
export function appClient(docId: string, viewAs?: string): BiClient {
  return {
    visual: (v: VisualSpec, state: ViewState, signal: AbortSignal) => client.request<QueryResult>('POST', `/api/data/docs/${docId}/visual`, { visual: v.id, spec: v, state, ...(viewAs ? { viewAs } : {}) }, { signal }),
    records: (v: VisualSpec, filters: FilterSpec[], state: ViewState) => {
      const fields = v.options?.detail?.length ? v.options.detail : [...(v.query?.dims ?? []).map((d) => d.replace(/:.*$/, '')), ...((v.query?.columns ?? []))];
      const spec: VisualSpec = { id: `${v.id}-records`, type: 'table', layout: v.layout, query: { model: v.query?.model, columns: [...new Set(fields)], filters: [...(v.query?.filters ?? []).filter((f) => f.op !== 'top' && f.op !== 'bottom'), ...filters], limit: 1000 } };
      return client.request<QueryResult>('POST', `/api/data/docs/${docId}/visual`, { visual: spec.id, spec, state: { ...state, selection: undefined } });
    },
    geo: (source: string) => client.get(`/api/data/geo/${encodeURIComponent(source)}`),
    subscribe: (on) => { const f = (p: { type?: string; doc?: string }) => { if ((p.type === 'refreshed' && p.doc === docId) || p.type === 'dataset_refreshed') on({ type: 'refreshed' }); }; refreshListeners.add(f); return () => { refreshListeners.delete(f); }; },
  };
}

/** Fields of a model (or of every dataset) for pickers: table.column with its type, date grains offered. */
export function modelFields(catalog: Catalog | null, model?: ModelSpec): Array<{ field: string; label: string; type: string; table: string }> {
  if (!catalog) return [];
  const colsOf = (ds: string) => catalog.datasets.find((d) => d.name === ds)?.state.columns ?? [];
  const tables = model ? model.tables : catalog.datasets.map((d) => ({ name: d.name, dataset: d.name, columns: [] as Array<{ name: string; expr: string }> }));
  const out: Array<{ field: string; label: string; type: string; table: string }> = [];
  for (const t of tables) {
    for (const c of [...colsOf(t.dataset), ...(t.columns ?? []).map((x) => ({ name: x.name, type: 'calculated' }))]) {
      if (c.name === '__rn') continue;
      out.push({ field: `${t.name}.${c.name}`, label: `${t.name}.${c.name}`, type: c.type, table: t.name });
      if (/DATE|TIMESTAMP/.test(c.type)) for (const g of ['year', 'quarter', 'month', 'week', 'day']) out.push({ field: `${t.name}.${c.name}:${g}`, label: `${t.name}.${c.name} by ${g}`, type: c.type, table: t.name });
    }
  }
  return out;
}

export type { CatalogSpec };
