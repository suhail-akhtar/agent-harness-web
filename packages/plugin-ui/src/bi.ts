/**
 * Data, dashboards and reports: the shared spec (core.dashboards). One JSON shape for the server's
 * engine, the renderers, the desktop editor, published pages, plugins and models.
 *
 * - A **source** is where data comes from (a file, a database, an HTTP API, inline values, a plugin).
 * - A **dataset** is a named table: a source's table (or sheet, or native query) plus recorded
 *   query-editor steps and/or DuckDB SQL over it and over other datasets. The engine computes it.
 * - A **model** (semantic model) names tables (datasets), relationships, calculated columns,
 *   measures (with time intelligence), hierarchies, formats and row-level security roles.
 * - A **query** asks the model for dimensions and measures with filters; the server compiles it to SQL.
 * - A **document** is a dashboard (pages of visuals on a grid) or a report (a flowing, paginated
 *   document): every number in it comes from a query the engine ran, never from a model's text.
 *
 * Every change is an **op** (OPS below): the desktop and the agents' tools apply the same ops.
 */

// ---------------- names and fields ----------------

/** Dataset, table and model-object names: SQL identifiers. */
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const GRAINS = ['year', 'quarter', 'month', 'week', 'day', 'hour'] as const;
export type Grain = typeof GRAINS[number];

/** "table.column" or "table.column:grain" (a date truncated to that grain). */
export interface FieldRef { table: string; column: string; grain?: Grain }
export function parseField(ref: string): FieldRef | undefined {
  const dot = ref.indexOf('.');
  if (dot <= 0) return undefined;
  const table = ref.slice(0, dot);
  if (!IDENT.test(table)) return undefined;
  let column = ref.slice(dot + 1);
  let grain: Grain | undefined;
  const c = column.lastIndexOf(':');
  if (c > 0 && (GRAINS as readonly string[]).includes(column.slice(c + 1))) { grain = column.slice(c + 1) as Grain; column = column.slice(0, c); }
  column = column.replace(/^"(.*)"$/, '$1');
  if (!column || column.length > 120) return undefined;
  return { table, column, ...(grain ? { grain } : {}) };
}
export const fieldRef = (f: FieldRef) => `${f.table}.${f.column}${f.grain ? `:${f.grain}` : ''}`;

// ---------------- sources and datasets ----------------

export const SOURCE_TYPES = ['file', 'sqlite', 'postgres', 'mysql', 'http', 'static', 'plugin'] as const;
export type SourceType = typeof SOURCE_TYPES[number];
export const FILE_FORMATS = ['csv', 'tsv', 'json', 'parquet', 'xlsx', 'geojson'] as const;
export type FileFormat = typeof FILE_FORMATS[number];

export interface SourceSpec {
  id: string;
  name: string;
  type: SourceType;
  description?: string;
  /** file, sqlite: a path the server can read (inside the person's folders or uploads). */
  path?: string;
  format?: FileFormat;
  /** postgres, mysql. */
  host?: string; port?: number; database?: string; user?: string; ssl?: boolean;
  /** http: the URL (its host is the only one the source may reach), the array inside the JSON. */
  url?: string; rowsPath?: string; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>;
  /**
   * A key vault entry holding the secret (a database password, an API token). Only the name lives
   * here: the value is read on the server when the source is read, never shown or sent to a page.
   */
  secret?: string;
  /** http: how the secret is sent. */
  auth?: 'bearer' | 'basic' | 'header' | 'query';
  authName?: string;
  /** static: inline values. `origin: "model"` marks numbers a model typed (shown as such until a real source is bound). */
  columns?: string[]; rows?: unknown[][]; origin?: 'person' | 'model';
  /** plugin: a data source a plugin contributes (ui.contributes.dataSources) and its parameters. */
  plugin?: string; kind?: string; params?: Record<string, unknown>;
  /** Where the data came from (research: the pages it was taken from). */
  provenance?: { sources: string[]; note?: string };
}

export type StepSpec =
  | { op: 'filter'; where: string }
  | { op: 'keep'; columns: string[] }
  | { op: 'remove'; columns: string[] }
  | { op: 'rename'; columns: Record<string, string> }
  | { op: 'type'; column: string; to: ColumnType; format?: string }
  | { op: 'split'; column: string; by: string; into: string[] }
  | { op: 'filldown'; columns: string[] }
  | { op: 'replace'; column: string; find: string | number | null; with: string | number | null }
  | { op: 'group'; by: string[]; aggs: Array<{ column?: string; fn: AggFn; as: string }> }
  | { op: 'pivot'; on: string; values: string; fn?: AggFn; using?: string[] }
  | { op: 'unpivot'; columns: string[]; name: string; value: string }
  | { op: 'merge'; with: string; on: Array<[string, string]>; how?: 'left' | 'inner' | 'right' | 'full' | 'anti' | 'semi'; columns?: string[]; prefix?: string }
  | { op: 'append'; with: string[] }
  | { op: 'dedupe'; columns?: string[] }
  | { op: 'add'; name: string; expr: string }
  | { op: 'conditional'; name: string; cases: Array<{ when: string; then: string | number | null }>; else?: string | number | null }
  | { op: 'dateparts'; column: string; parts: Array<'year' | 'quarter' | 'month' | 'monthname' | 'week' | 'day' | 'weekday' | 'dayname'> }
  | { op: 'sort'; by: Array<{ column: string; desc?: boolean }> }
  | { op: 'limit'; n: number };
export const STEP_OPS = ['filter', 'keep', 'remove', 'rename', 'type', 'split', 'filldown', 'replace', 'group', 'pivot', 'unpivot', 'merge', 'append', 'dedupe', 'add', 'conditional', 'dateparts', 'sort', 'limit'] as const;
export const AGG_FNS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct', 'median', 'stddev', 'first', 'last'] as const;
export type AggFn = typeof AGG_FNS[number];
export const COLUMN_TYPES = ['integer', 'double', 'decimal', 'text', 'date', 'timestamp', 'boolean'] as const;
export type ColumnType = typeof COLUMN_TYPES[number];

export interface ParamSpec { name: string; type: 'text' | 'number' | 'date' | 'boolean'; default?: string | number | boolean | null; description?: string }

export interface RefreshPolicy {
  mode: 'manual' | 'interval' | 'cron' | 'event';
  /** interval: seconds (at least 10). */
  every?: number;
  /** cron: five fields. */
  cron?: string;
  /** event: a global event topic (or "<topic>:<type>"), e.g. "plugins" or "data:refreshed". */
  event?: string;
}

export interface DatasetSpec {
  id: string;
  /** The table name in SQL (and in the model). */
  name: string;
  description?: string;
  source?: string;
  /** The table, sheet, JSON path or native read-only query to read from the source. */
  from?: string;
  /** Query-editor steps applied to what the source gives, compiled to SQL. */
  steps?: StepSpec[];
  /** DuckDB SQL (one SELECT): `base` is the source (after the steps); other datasets by their names; parameters as $name. */
  sql?: string;
  params?: ParamSpec[];
  refresh?: RefreshPolicy;
  /** Incremental refresh: only rows whose `column` is within the last `window` units are read again. */
  incremental?: { column: string; window: number; unit: 'day' | 'month' | 'year' };
  certified?: boolean;
  /** Promoted: recommended to others (a weaker flag than certified). */
  promoted?: boolean;
}

// ---------------- the semantic model ----------------

export const TIME_CALCS = ['ytd', 'qtd', 'mtd', 'prev_period', 'prev_year', 'yoy', 'yoy_pct', 'running_total', 'pct_of_total', 'rank', 'moving_avg'] as const;
export type TimeCalc = typeof TIME_CALCS[number];

export interface MeasureSpec {
  name: string;
  /** SQL aggregate over model fields (sum(sales.amount)); other measures as [Name]. */
  expr?: string;
  /** A filter context for this measure only (SQL over model fields): FILTER (WHERE ...). */
  filter?: string;
  /** A calculation over another measure: time intelligence, running total, % of total, rank. */
  base?: string;
  calc?: TimeCalc;
  /** The date field for time calculations (default: the model's date field). */
  date?: string;
  /** moving_avg: periods. */
  periods?: number;
  format?: string;
  description?: string;
  table?: string;
}

export interface CalcColumnSpec { name: string; expr: string; format?: string }
export interface ModelTableSpec { name: string; dataset: string; columns?: CalcColumnSpec[]; hidden?: boolean; description?: string }
export interface RelationshipSpec {
  id?: string;
  /** The many side ("sales.region_id") and the one side ("regions.id") for n:1. */
  from: string;
  to: string;
  cardinality?: 'n:1' | '1:1' | '1:n';
  /** single: filters flow from the one side to the many side; both: also back. */
  crossFilter?: 'single' | 'both';
  active?: boolean;
}
export interface HierarchySpec { name: string; levels: string[] }
export interface RoleSpec {
  name: string;
  /** Harness account ids (usr_...), "*" for every signed-in account, or "token:<label>" for a publish link bound to this role. */
  members: string[];
  /** Per table, an SQL predicate over its fields; {user} is the viewer's account id (quoted). */
  filters: Record<string, string>;
}
export interface ModelSpec {
  id: string;
  name: string;
  description?: string;
  tables: ModelTableSpec[];
  relationships: RelationshipSpec[];
  measures: MeasureSpec[];
  hierarchies: HierarchySpec[];
  roles: RoleSpec[];
  /** Field or measure -> format. */
  formats: Record<string, string>;
  /** The default date field for time intelligence. */
  date?: string;
}

/** Everything a person keeps: sources, datasets and models (one versioned document). */
export interface CatalogSpec { sources: SourceSpec[]; datasets: DatasetSpec[]; models: ModelSpec[] }

// ---------------- queries ----------------

export const FILTER_OPS = ['in', 'not_in', 'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'contains', 'starts', 'is_null', 'not_null', 'relative', 'top', 'bottom'] as const;
export type FilterOp = typeof FILTER_OPS[number];
export type Scalar = string | number | boolean | null;
export interface FilterSpec {
  /** A field (table.column[:grain]) or, for gt/lt/top/bottom, a measure name. */
  field: string;
  op: FilterOp;
  values?: Scalar[];
  value?: Scalar;
  to?: Scalar;
  /** relative date: the last `n` units (and the current one if `current`). */
  n?: number; unit?: 'day' | 'week' | 'month' | 'quarter' | 'year'; current?: boolean;
  /** top/bottom: by this measure. */
  by?: string;
}
export interface InlineMeasure { name: string; expr?: string; base?: string; calc?: TimeCalc; filter?: string; date?: string; periods?: number; format?: string }
export interface QuerySpec {
  /** A model id; without one, every dataset is a table of an implicit model with no relationships. */
  model?: string;
  dims?: string[];
  measures?: Array<string | InlineMeasure>;
  /** Detail rows (no aggregation): these fields. */
  columns?: string[];
  filters?: FilterSpec[];
  sort?: Array<{ by: string; desc?: boolean }>;
  limit?: number;
  /** Subtotals: GROUPING SETS by prefixes of the dims (rows) crossed with the column dims. */
  totals?: { rows: number; columns?: number } | boolean;
}

export interface ResultColumn { name: string; label: string; type: string; role: 'dim' | 'measure' | 'column' | 'level'; field?: string; grain?: Grain; format?: string }
export interface QueryResult {
  columns: ResultColumn[];
  rows: Scalar[][];
  rowCount: number;
  truncated?: boolean;
  /** Cross-highlight: the measure values under the selection, aligned with rows. */
  highlight?: Scalar[][];
  /** sha256 of the rows: two results with the same hash hold the same numbers. */
  hash: string;
  ms: number;
  at: number;
  /** Where every number came from: datasets with their sources and refresh times, the SQL (unless hidden), parameters. */
  lineage: Lineage;
  /** Analysis notes (forecast, anomalies, drivers): the method used. */
  method?: string;
  extra?: Record<string, unknown>;
}
export interface Lineage {
  datasets: Array<{ name: string; source?: string; sourceType?: SourceType; refreshedAt?: number; rows?: number; hash?: string; static?: boolean; certified?: boolean; origin?: 'person' | 'model'; provenance?: string[] }>;
  sql?: string;
  params?: Record<string, unknown>;
  role?: string;
}

// ---------------- visuals, pages, documents ----------------

export const VISUAL_TYPES = [
  'card', 'multicard', 'kpi', 'gauge',
  'bar', 'column', 'line', 'area', 'combo', 'ribbon', 'waterfall', 'funnel',
  'pie', 'donut', 'treemap', 'scatter',
  'table', 'matrix', 'map',
  'decomp', 'drivers', 'narrative',
  'slicer', 'text', 'image', 'button', 'fence',
] as const;
export type VisualType = typeof VISUAL_TYPES[number];
/** Visuals that draw data (and so need a query). */
export const DATA_VISUALS: ReadonlySet<VisualType> = new Set(VISUAL_TYPES.filter((t) => !['text', 'image', 'button'].includes(t)));

export interface CondFormat {
  /** The column (a measure name or a field) it colours. */
  field: string;
  kind: 'scale' | 'bars' | 'icons' | 'rules';
  /** scale: two or three colours (low, [mid], high). */
  colors?: string[];
  min?: number; max?: number;
  rules?: Array<{ op: 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'between'; value: number; to?: number; color?: string; icon?: 'up' | 'down' | 'flat' | 'ok' | 'warn' | 'bad' }>;
}

export interface VisualOptions {
  stack?: 'clustered' | 'stacked' | 'percent';
  horizontal?: boolean;
  smooth?: boolean;
  labels?: boolean;
  legend?: boolean;
  /** combo: measures drawn as lines on the right axis. */
  lines?: string[];
  /** kpi, gauge: the target (a measure name or a number); the trend field (a date dim) for the sparkline. */
  target?: string | number;
  trend?: string;
  min?: number; max?: number;
  /** scatter: x and y measures are the first two; size is the third; the play axis is a dim animated over. */
  size?: string;
  play?: string;
  /** line: a statistical forecast for `periods` more periods, and anomaly marks (z-score of the residual). */
  forecast?: { periods: number; method?: 'linear' | 'seasonal'; season?: number };
  anomalies?: boolean | { z?: number };
  /** map: a GeoJSON source and the property matching the first dim (filled), or lat/lon fields (points). */
  geo?: { source?: string; key?: string; lat?: string; lon?: string };
  /** matrix: how many of the dims are rows (the rest are columns); stepped layout; subtotals. */
  rows?: number; stepped?: boolean; subtotals?: boolean;
  /** decomp: the dimensions to split by; drivers: the factors. */
  dims?: string[];
  /** narrative: text with {{Measure}} or {{Measure[dim=value]}} placeholders filled from the query. */
  text?: string;
  /** text: markdown; image: an https or data: URL. */
  markdown?: string;
  url?: string; alt?: string;
  slicer?: { field: string; style?: 'list' | 'dropdown' | 'range' | 'relative' | 'buttons'; multi?: boolean };
  button?: { label: string; action: 'bookmark' | 'page' | 'back' | 'clear' | 'url'; target?: string };
  /** fence: a renderer of the existing stack (smiles, pdb, plot, dot, mermaid, geojson, diagram, a plugin's) with static source or the query's rows. */
  fence?: { lang: string; source?: string };
  /** The hierarchy drilled through (model hierarchy name). */
  hierarchy?: string;
  formats?: Record<string, string>;
  conditional?: CondFormat[];
  colors?: string[];
  /** Detail rows shown when a data point is drilled into ("see records"): these fields. */
  detail?: string[];
}

export interface VisualSpec {
  id: string;
  type: VisualType;
  title?: string;
  subtitle?: string;
  query?: QuerySpec;
  options?: VisualOptions;
  /** 12 columns; y and h in rows of 40 px. */
  layout: { x: number; y: number; w: number; h: number };
  /** Phone layout: order and height (rows), or hidden. */
  mobile?: { order?: number; h?: number; hidden?: boolean };
  /** How a selection in this visual changes the others: filter (default), highlight or none. Key: the other visual's id. */
  interactions?: Record<string, 'filter' | 'highlight' | 'none'>;
  /** A tooltip page shown on hover. */
  tooltip?: string;
  hidden?: boolean;
}

export interface PageSpec {
  id: string;
  name: string;
  kind?: 'page' | 'drillthrough' | 'tooltip';
  /** drillthrough: the fields whose values a drill-through carries into this page. */
  drillFields?: string[];
  filters?: FilterSpec[];
  visuals: VisualSpec[];
}

export interface BookmarkSpec { id: string; name: string; page: string; filters?: FilterSpec[]; hidden?: string[]; selection?: { visual: string; filters: FilterSpec[] } }
export interface AlertSpec { id: string; name: string; measure: string; model?: string; filters?: FilterSpec[]; op: 'gt' | 'ge' | 'lt' | 'le' | 'eq' | 'ne'; value: number; notify?: boolean; visual?: string }
export interface SubscriptionSpec { id: string; cron: string; format: 'pdf' | 'html' | 'csv' | 'xlsx' | 'png'; deliver: 'save' | 'notify'; channel?: string; title?: string }
export interface ThemeSpec { name: string; mode?: 'light' | 'dark'; palette: string[]; background?: string; foreground?: string; accent?: string; font?: string }

export interface DocSpec {
  type: 'dashboard' | 'report';
  title: string;
  description?: string;
  model?: string;
  theme?: string | ThemeSpec;
  pages: PageSpec[];
  filters?: FilterSpec[];
  bookmarks?: BookmarkSpec[];
  refresh?: RefreshPolicy;
  alerts?: AlertSpec[];
  subscriptions?: SubscriptionSpec[];
  /** report: page header and footer ({title}, {date}, {page}, {pages}). */
  header?: string; footer?: string;
  /** report: the numbers frozen by a "refresh and snapshot" run. */
  snapshot?: { at: number; results: Record<string, QueryResult> };
}

export const THEMES: ThemeSpec[] = [
  { name: 'default', palette: ['#4E79A7', '#F28E2B', '#59A14F', '#E15759', '#76B7B2', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'] },
  { name: 'ocean', palette: ['#0B6E99', '#14A3C7', '#4CC9E0', '#1D4E89', '#7FDBDA', '#00798C', '#30638E', '#A5D8DD'] },
  { name: 'sunset', palette: ['#D1495B', '#EDAE49', '#F3722C', '#90BE6D', '#577590', '#F9844A', '#43AA8B', '#277DA1'] },
  { name: 'mono', palette: ['#1F2937', '#4B5563', '#6B7280', '#9CA3AF', '#374151', '#D1D5DB'] },
  { name: 'contrast', mode: 'dark', palette: ['#FFD166', '#06D6A0', '#EF476F', '#118AB2', '#F78C6B', '#83D483'], background: '#0B0F17', foreground: '#F5F7FA', accent: '#FFD166' },
];
export function themeOf(t: DocSpec['theme']): ThemeSpec { return typeof t === 'object' && t ? { ...THEMES[0]!, ...t } : THEMES.find((x) => x.name === t) ?? THEMES[0]!; }

// ---------------- formatting ----------------

const GRAIN_FMT: Record<Grain, Intl.DateTimeFormatOptions> = {
  year: { year: 'numeric', timeZone: 'UTC' }, quarter: { year: 'numeric', timeZone: 'UTC' }, month: { year: 'numeric', month: 'short', timeZone: 'UTC' },
  week: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }, day: { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }, hour: { month: 'short', day: 'numeric', hour: '2-digit', timeZone: 'UTC' },
};
/**
 * Formats a value for display. Formats: "currency:USD[:decimals]", "percent[:decimals]" (0.12 ->
 * 12%), "number[:decimals]", "integer", "compact" (12.3K), "date[:grain]", "text". Numbers are
 * never rounded before they are shown, and the raw value is kept in the data.
 */
export function formatValue(v: Scalar | undefined, format?: string, grain?: Grain, locale = 'en-US'): string {
  if (v === null || v === undefined) return '';
  const [kind, a, b] = (format ?? '').split(':');
  if (typeof v === 'number' || (typeof v === 'string' && kind && /^(currency|percent|number|integer|compact)$/.test(kind) && v.trim() !== '' && Number.isFinite(Number(v)))) {
    const n = Number(v);
    switch (kind) {
      case 'currency': return new Intl.NumberFormat(locale, { style: 'currency', currency: (a || 'USD').toUpperCase(), maximumFractionDigits: b !== undefined ? Number(b) : 2, minimumFractionDigits: b !== undefined ? Number(b) : undefined }).format(n);
      case 'percent': return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: a !== undefined ? Number(a) : 1, minimumFractionDigits: a !== undefined ? Number(a) : undefined }).format(n);
      case 'integer': return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
      case 'compact': return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: a !== undefined ? Number(a) : 1 }).format(n);
      case 'number': return new Intl.NumberFormat(locale, { maximumFractionDigits: a !== undefined ? Number(a) : 2, minimumFractionDigits: a !== undefined ? Number(a) : undefined }).format(n);
      default: return Number.isInteger(n) ? new Intl.NumberFormat(locale).format(n) : new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(n) >= 100 ? 2 : 4 }).format(n);
    }
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const g = (kind === 'date' && (GRAINS as readonly string[]).includes(a ?? '') ? a as Grain : undefined) ?? grain;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && (g || kind === 'date')) {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? '' : 'Z'));
    if (!Number.isNaN(d.getTime())) {
      if (g === 'quarter') return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      if (g === 'week') return `Week of ${new Intl.DateTimeFormat(locale, GRAIN_FMT.week).format(d)}`;
      return new Intl.DateTimeFormat(locale, GRAIN_FMT[g ?? 'day']).format(d);
    }
  }
  return String(v);
}

// ---------------- ops ----------------

/** Which tool (and Data/Dashboards page) an op belongs to, and whether it changes anything. */
export type OpFamily = 'datasource' | 'dataset' | 'model' | 'dashboard';
export interface OpInfo { family: OpFamily; write: boolean; summary: string; example: string }

/**
 * The op catalogue: every change a person makes in the app and every change an agent makes through
 * its tools is one of these (POST /api/data/ops; the tools datasource, dataset, model, dashboard).
 */
export const OPS: Record<string, OpInfo> = {
  // sources
  list_sources: { family: 'datasource', write: false, summary: 'sources (never a secret)', example: '{}' },
  add_source: { family: 'datasource', write: true, summary: 'add a source; secrets by vault entry name only', example: '{"source":{"name":"Sales file","type":"file","path":"data/sales.xlsx"}}' },
  update_source: { family: 'datasource', write: true, summary: 'change a source', example: '{"id":"src-1","patch":{"url":"https://..."}}' },
  remove_source: { family: 'datasource', write: true, summary: 'remove a source no dataset uses', example: '{"id":"src-1"}' },
  test_source: { family: 'datasource', write: false, summary: 'connect and list tables/sheets', example: '{"id":"src-1"}' },
  // datasets
  list_datasets: { family: 'dataset', write: false, summary: 'datasets with refresh state, rows, certified', example: '{}' },
  define: { family: 'dataset', write: true, summary: 'define a dataset', example: '{"dataset":{"name":"sales","source":"src-1","from":"Sheet1"}}' },
  update_dataset: { family: 'dataset', write: true, summary: 'change a dataset (sql, from, params, description)', example: '{"dataset":"sales","patch":{"sql":"SELECT * FROM base WHERE amount > 0"}}' },
  remove_dataset: { family: 'dataset', write: true, summary: 'remove a dataset nothing uses', example: '{"dataset":"sales"}' },
  add_step: { family: 'dataset', write: true, summary: 'add a query-editor step (at: position)', example: '{"dataset":"sales","step":{"op":"type","column":"amount","to":"double"}}' },
  update_step: { family: 'dataset', write: true, summary: 'replace step n (0-based)', example: '{"dataset":"sales","index":0,"step":{...}}' },
  remove_step: { family: 'dataset', write: true, summary: 'remove step n', example: '{"dataset":"sales","index":0}' },
  move_step: { family: 'dataset', write: true, summary: 'move a step', example: '{"dataset":"sales","from":2,"to":0}' },
  certify: { family: 'dataset', write: true, summary: 'mark certified or promoted', example: '{"dataset":"sales","certified":true}' },
  set_dataset_refresh: { family: 'dataset', write: true, summary: 'refresh schedule of a dataset', example: '{"dataset":"sales","refresh":{"mode":"interval","every":3600}}' },
  set_incremental: { family: 'dataset', write: true, summary: 'incremental refresh window (null: off)', example: '{"dataset":"orders","incremental":{"column":"day","window":30,"unit":"day"}}' },
  query: { family: 'dataset', write: false, summary: 'read-only SQL over datasets: a capped summary', example: '{"sql":"SELECT region, sum(amount) FROM sales GROUP BY 1"}' },
  preview: { family: 'dataset', write: false, summary: 'first rows of a dataset (or up to step n)', example: '{"dataset":"sales","step":2}' },
  profile: { family: 'dataset', write: false, summary: 'column quality and distribution', example: '{"dataset":"sales"}' },
  refresh: { family: 'dataset', write: false, summary: 'read the sources again (dataset, or every dataset of a dashboard)', example: '{"dataset":"sales"}' },
  // model
  describe_model: { family: 'model', write: false, summary: 'tables, fields, relationships, measures, hierarchies, roles', example: '{"model":"sales-model"}' },
  add_model: { family: 'model', write: true, summary: 'a new semantic model', example: '{"model":{"id":"sales-model","name":"Sales"}}' },
  remove_model: { family: 'model', write: true, summary: 'remove a model no dashboard uses', example: '{"model":"sales-model"}' },
  set_table: { family: 'model', write: true, summary: 'add or change a table (a dataset)', example: '{"model":"m","table":{"name":"sales","dataset":"sales"}}' },
  remove_table: { family: 'model', write: true, summary: 'remove a table', example: '{"model":"m","table":"sales"}' },
  set_column: { family: 'model', write: true, summary: 'calculated column (SQL over the row)', example: '{"model":"m","table":"sales","column":{"name":"margin","expr":"amount - cost"}}' },
  remove_column: { family: 'model', write: true, summary: 'remove a calculated column', example: '{"model":"m","table":"sales","column":"margin"}' },
  set_relationship: { family: 'model', write: true, summary: 'relationship many -> one', example: '{"model":"m","relationship":{"from":"sales.region_id","to":"regions.id","crossFilter":"single"}}' },
  remove_relationship: { family: 'model', write: true, summary: 'remove a relationship', example: '{"model":"m","id":"sales.region_id->regions.id"}' },
  set_measure: { family: 'model', write: true, summary: 'measure: expr (aggregate) or base+calc (time intelligence)', example: '{"model":"m","measure":{"name":"Revenue","expr":"sum(sales.amount)","format":"currency:USD"}}' },
  remove_measure: { family: 'model', write: true, summary: 'remove a measure', example: '{"model":"m","name":"Revenue"}' },
  set_hierarchy: { family: 'model', write: true, summary: 'drill levels', example: '{"model":"m","hierarchy":{"name":"Calendar","levels":["sales.day:year","sales.day:quarter","sales.day:month"]}}' },
  remove_hierarchy: { family: 'model', write: true, summary: 'remove a hierarchy', example: '{"model":"m","name":"Calendar"}' },
  set_format: { family: 'model', write: true, summary: 'format of a field or measure', example: '{"model":"m","field":"Revenue","format":"currency:EUR:0"}' },
  set_role: { family: 'model', write: true, summary: 'row-level security role', example: '{"model":"m","role":{"name":"EU","members":["usr_..."],"filters":{"regions":"region = \'EU\'"}}}' },
  remove_role: { family: 'model', write: true, summary: 'remove a role', example: '{"model":"m","name":"EU"}' },
  set_model: { family: 'model', write: true, summary: 'name, description, default date field', example: '{"model":"m","patch":{"date":"sales.day"}}' },
  model_query: { family: 'model', write: false, summary: 'dims and measures from the model: a capped summary and the SQL', example: '{"query":{"model":"m","dims":["regions.region"],"measures":["Revenue"]}}' },
  suggest: { family: 'model', write: false, summary: 'profile datasets and propose relationships and measures', example: '{"datasets":["sales","regions"]}' },
  // documents
  list_docs: { family: 'dashboard', write: false, summary: 'dashboards and reports', example: '{}' },
  describe: { family: 'dashboard', write: false, summary: 'a document compactly: pages, visuals (ids, types, fields), filters, model fields and measures', example: '{"doc":"d-1"}' },
  create: { family: 'dashboard', write: true, summary: 'a new dashboard or report', example: '{"doc":{"type":"dashboard","title":"Sales","model":"m"}}' },
  delete: { family: 'dashboard', write: true, summary: 'delete a document (unpublished first)', example: '{"doc":"d-1"}' },
  set_doc: { family: 'dashboard', write: true, summary: 'title, description, model, header, footer', example: '{"doc":"d-1","patch":{"title":"Sales 2026"}}' },
  add_page: { family: 'dashboard', write: true, summary: 'a page (kind: page, drillthrough with drillFields, tooltip)', example: '{"doc":"d-1","page":{"name":"Detail","kind":"drillthrough","drillFields":["regions.region"]}}' },
  update_page: { family: 'dashboard', write: true, summary: 'rename or change a page', example: '{"doc":"d-1","page":"p-2","patch":{"name":"Regions"}}' },
  remove_page: { family: 'dashboard', write: true, summary: 'remove a page', example: '{"doc":"d-1","page":"p-2"}' },
  move_page: { family: 'dashboard', write: true, summary: 'reorder pages', example: '{"doc":"d-1","page":"p-2","to":0}' },
  add_visual: { family: 'dashboard', write: true, summary: 'a visual on a page (layout optional: placed below)', example: '{"doc":"d-1","page":"p-1","visual":{"type":"column","title":"Revenue by region","query":{"dims":["regions.region"],"measures":["Revenue"]}}}' },
  update_visual: { family: 'dashboard', write: true, summary: 'merge a patch into a visual (query, options, title, type)', example: '{"doc":"d-1","visual":"v-3","patch":{"type":"bar","options":{"stack":"stacked"}}}' },
  remove_visual: { family: 'dashboard', write: true, summary: 'remove a visual', example: '{"doc":"d-1","visual":"v-3"}' },
  move_visual: { family: 'dashboard', write: true, summary: 'layout {x,y,w,h} (12 columns) and/or the phone layout', example: '{"doc":"d-1","visual":"v-3","layout":{"x":0,"y":0,"w":6,"h":8}}' },
  duplicate_visual: { family: 'dashboard', write: true, summary: 'copy a visual (to another page)', example: '{"doc":"d-1","visual":"v-3","page":"p-2"}' },
  set_interaction: { family: 'dashboard', write: true, summary: 'how a selection in one visual affects another', example: '{"doc":"d-1","from":"v-1","to":"v-2","mode":"highlight"}' },
  add_filter: { family: 'dashboard', write: true, summary: 'a filter on the document, a page or a visual (scope)', example: '{"doc":"d-1","scope":"p-1","filter":{"field":"sales.day","op":"relative","n":12,"unit":"month"}}' },
  remove_filter: { family: 'dashboard', write: true, summary: 'remove the filters on a field (scope)', example: '{"doc":"d-1","scope":"doc","field":"sales.day"}' },
  add_bookmark: { family: 'dashboard', write: true, summary: 'saved filters, hidden visuals and page', example: '{"doc":"d-1","bookmark":{"name":"EU view","page":"p-1","filters":[...]}}' },
  remove_bookmark: { family: 'dashboard', write: true, summary: 'remove a bookmark', example: '{"doc":"d-1","bookmark":"b-1"}' },
  set_theme: { family: 'dashboard', write: true, summary: 'a theme name or {palette, background, foreground, accent}', example: '{"doc":"d-1","theme":"ocean"}' },
  set_refresh: { family: 'dashboard', write: true, summary: 'refresh policy: manual, interval (seconds), cron, event', example: '{"doc":"d-1","refresh":{"mode":"cron","cron":"0 * * * *"}}' },
  add_alert: { family: 'dashboard', write: true, summary: 'threshold on a measure, checked after each refresh', example: '{"doc":"d-1","alert":{"name":"Low sales","measure":"Revenue","op":"lt","value":1000,"notify":true}}' },
  remove_alert: { family: 'dashboard', write: true, summary: 'remove an alert', example: '{"doc":"d-1","alert":"a-1"}' },
  add_subscription: { family: 'dashboard', write: true, summary: 'scheduled snapshot saved or sent', example: '{"doc":"d-1","subscription":{"cron":"0 8 * * 1","format":"pdf","deliver":"save"}}' },
  remove_subscription: { family: 'dashboard', write: true, summary: 'remove a subscription', example: '{"doc":"d-1","subscription":"s-1"}' },
  set_narrative: { family: 'dashboard', write: true, summary: 'narrative text: numbers only as {{Measure}} / {{Measure[dim=value]}} or equal to a computed result', example: '{"doc":"d-1","visual":"v-9","text":"{{Revenue}} in total; {{Revenue[regions.region=EU]}} from EU."}' },
  pin: { family: 'dashboard', write: true, summary: 'a chart/table from a conversation into a document (its typed data becomes a static dataset)', example: '{"doc":"d-1","block":{"lang":"chart","source":"{...}"}}' },
  bind: { family: 'dashboard', write: true, summary: 'point a visual (static data) at a real dataset or model fields', example: '{"doc":"d-1","visual":"v-2","query":{"model":"m","dims":["sales.region"],"measures":["Revenue"]}}' },
  snapshot: { family: 'dashboard', write: true, summary: 'report: refresh and freeze every number with a timestamp', example: '{"doc":"r-1"}' },
  publish: { family: 'dashboard', write: true, summary: 'serve read-only at /p/<slug> (access: token or signed-in; role for RLS)', example: '{"doc":"d-1","access":"token"}' },
  unpublish: { family: 'dashboard', write: true, summary: 'revoke a published page now', example: '{"doc":"d-1"}' },
  verify: { family: 'dashboard', write: false, summary: 'run every visual: rows, nulls, errors, totals reconcile', example: '{"doc":"d-1"}' },
  undo: { family: 'dashboard', write: true, summary: 'undo the last change of a document or the catalog', example: '{"doc":"d-1"}' },
  redo: { family: 'dashboard', write: true, summary: 'redo what undo took back', example: '{"doc":"d-1"}' },
  restore: { family: 'dashboard', write: true, summary: 'restore a version (as a new version)', example: '{"doc":"d-1","version":3}' },
  history: { family: 'dashboard', write: false, summary: 'versions with who changed what', example: '{"doc":"d-1"}' },
  export: { family: 'dashboard', write: false, summary: 'export pdf, html, csv, xlsx (saved in the data folder)', example: '{"doc":"d-1","format":"xlsx"}' },
};

/** Every control in the desktop that changes something, and the op it applies (tested: each is in OPS). */
export const UI_ACTIONS: Record<string, string> = {
  'data.add-source': 'add_source', 'data.edit-source': 'update_source', 'data.remove-source': 'remove_source', 'data.test-source': 'test_source',
  'data.new-dataset': 'define', 'data.edit-sql': 'update_dataset', 'data.remove-dataset': 'remove_dataset', 'data.add-step': 'add_step', 'data.edit-step': 'update_step',
  'data.remove-step': 'remove_step', 'data.move-step': 'move_step', 'data.certify': 'certify', 'data.schedule': 'set_dataset_refresh', 'data.incremental': 'set_incremental',
  'data.refresh': 'refresh', 'data.preview': 'preview', 'data.profile': 'profile', 'data.run-sql': 'query',
  'model.new': 'add_model', 'model.add-table': 'set_table', 'model.remove-table': 'remove_table', 'model.add-column': 'set_column', 'model.remove-column': 'remove_column',
  'model.relate': 'set_relationship', 'model.unrelate': 'remove_relationship', 'model.measure': 'set_measure', 'model.remove-measure': 'remove_measure',
  'model.hierarchy': 'set_hierarchy', 'model.remove-hierarchy': 'remove_hierarchy', 'model.format': 'set_format', 'model.role': 'set_role', 'model.remove-role': 'remove_role',
  'model.settings': 'set_model', 'model.suggest': 'suggest',
  'doc.new': 'create', 'doc.delete': 'delete', 'doc.rename': 'set_doc', 'doc.add-page': 'add_page', 'doc.rename-page': 'update_page', 'doc.remove-page': 'remove_page', 'doc.move-page': 'move_page',
  'doc.add-visual': 'add_visual', 'doc.edit-visual': 'update_visual', 'doc.remove-visual': 'remove_visual', 'doc.drag': 'move_visual', 'doc.resize': 'move_visual', 'doc.duplicate': 'duplicate_visual',
  'doc.interaction': 'set_interaction', 'doc.filter': 'add_filter', 'doc.clear-filter': 'remove_filter', 'doc.bookmark': 'add_bookmark', 'doc.remove-bookmark': 'remove_bookmark',
  'doc.theme': 'set_theme', 'doc.refresh-policy': 'set_refresh', 'doc.alert': 'add_alert', 'doc.remove-alert': 'remove_alert', 'doc.subscribe': 'add_subscription', 'doc.unsubscribe': 'remove_subscription',
  'doc.narrative': 'set_narrative', 'doc.pin': 'pin', 'doc.bind': 'bind', 'doc.snapshot': 'snapshot', 'doc.publish': 'publish', 'doc.unpublish': 'unpublish', 'doc.verify': 'verify',
  'doc.undo': 'undo', 'doc.redo': 'redo', 'doc.restore': 'restore', 'doc.export': 'export',
};

/** A visual's id-free summary for lists: "column: Revenue by regions.region". */
export function visualSummary(v: VisualSpec): string {
  const q = v.query;
  const ms = (q?.measures ?? []).map((m) => (typeof m === 'string' ? m : m.name));
  return `${v.type}${v.title ? ` "${v.title}"` : ''}${ms.length ? `: ${ms.join(', ')}` : ''}${q?.dims?.length ? ` by ${q.dims.join(', ')}` : ''}${q?.columns?.length ? `: ${q.columns.join(', ')}` : ''}`;
}

/** Fields a document uses (for dependency checks). */
export function docFields(d: DocSpec): { measures: Set<string>; fields: Set<string> } {
  const measures = new Set<string>(); const fields = new Set<string>();
  const fl = (fs?: FilterSpec[]) => { for (const f of fs ?? []) { (parseField(f.field) ? fields : measures).add(f.field); if (f.by) measures.add(f.by); } };
  fl(d.filters);
  for (const p of d.pages) {
    fl(p.filters);
    for (const v of p.visuals) {
      for (const m of v.query?.measures ?? []) if (typeof m === 'string') measures.add(m);
      for (const x of [...(v.query?.dims ?? []), ...(v.query?.columns ?? [])]) fields.add(x);
      fl(v.query?.filters);
    }
  }
  for (const a of d.alerts ?? []) measures.add(a.measure);
  return { measures, fields };
}
