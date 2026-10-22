import { type FieldRef, type FilterSpec, type Grain, GRAINS, IDENT, type InlineMeasure, type MeasureSpec, type ModelSpec, parseField, type QuerySpec, type ResultColumn, type RoleSpec, type Scalar, TIME_CALCS } from '../../packages/plugin-ui/src/bi.ts';
import { DataError, lit, qid, scalarLit } from './engine.ts';

// The semantic model compiled to SQL. Every number a visual shows is an aggregate DuckDB computed
// from this SQL: measures are SQL aggregates over model fields; dimensions group; filters apply
// where they reach through relationships (many -> one, and back where cross-filtering is both);
// measures of different fact tables are grouped separately and joined on the dimensions; time
// intelligence (YTD, previous period, same period last year) is computed exactly by re-aggregating
// the fact rows of the shifted window, never by adding up rounded numbers; row-level security
// filters tables (and, through relationships, the tables that point at them) before anything else.

export interface Columns { name: string; type: string }
export interface CompileContext {
  model: ModelSpec;
  /** Columns of a dataset (known after its first refresh), for checking fields. */
  columnsOf(dataset: string): Columns[] | undefined;
  /** Row-level security in force for this viewer (none: the owner sees everything). */
  roles?: RoleSpec[];
  user?: string;
  /** Today (YYYY-MM-DD) for relative date filters; default the server's date. */
  today?: string;
}
export interface Compiled { sql: string; columns: ResultColumn[]; datasets: Set<string>; warnings: string[] }

/** A model with no relationships or measures where every dataset is a table (dashboards without a model). */
export function implicitModel(datasets: string[]): ModelSpec {
  return { id: '', name: 'Datasets', tables: datasets.map((d) => ({ name: d, dataset: d })), relationships: [], measures: [], hierarchies: [], roles: [], formats: {} };
}

interface Edge { many: FieldRef; one: FieldRef; both: boolean; oneToOne: boolean }
interface Measure extends MeasureSpec { inline?: boolean }

const GRAIN_SQL = (g: Grain, x: string) => (g === 'hour' || g === 'minute' ? `date_trunc('${g}', ${x})` : `CAST(date_trunc('${g}', ${x}) AS DATE)`);
const INTERVAL = (g: Grain, n = 1) => `INTERVAL ${n} ${g === 'quarter' ? 'MONTH' : g.toUpperCase()}`.replace(/INTERVAL (\d+) MONTH$/, (_m, k) => `INTERVAL ${g === 'quarter' ? Number(k) * 3 : k} MONTH`);

/** Strings and quoted names masked, so scanning an expression never matches inside them. */
function mask(expr: string): string { return expr.replace(/'(?:[^']|'')*'/g, (m) => ' '.repeat(m.length)); }

export class SemanticCompiler {
  private m: ModelSpec;
  private tables = new Map<string, ModelSpec['tables'][number]>();
  private edges: Edge[] = [];
  private measures = new Map<string, Measure>();
  warnings: string[] = [];
  datasets = new Set<string>();

  private ctx: CompileContext;
  constructor(ctx: CompileContext) {
    this.ctx = ctx;
    this.m = ctx.model;
    for (const t of this.m.tables) this.tables.set(t.name, t);
    for (const r of this.m.relationships) {
      if (r.active === false) continue;
      let a = parseField(r.from); let b = parseField(r.to);
      if (!a || !b) throw new DataError(`relationship ${r.from} -> ${r.to}: fields are table.column`);
      if (r.cardinality === '1:n') [a, b] = [b, a];
      this.edges.push({ many: a, one: b, both: r.crossFilter === 'both', oneToOne: r.cardinality === '1:1' });
    }
    for (const x of this.m.measures) this.measures.set(x.name, x);
  }

  // ---------- fields ----------

  table(name: string) {
    const t = this.tables.get(name);
    if (!t) throw new DataError(`no table "${name}" in the model (tables: ${[...this.tables.keys()].join(', ') || 'none'})`);
    return t;
  }
  /** Every column of a table: the dataset's and its calculated columns. */
  columnsOf(table: string): string[] | undefined {
    const t = this.table(table);
    const base = this.ctx.columnsOf(t.dataset);
    return base ? [...base.map((c) => c.name).filter((c) => c !== '__rn'), ...(t.columns ?? []).map((c) => c.name)] : undefined;
  }
  field(ref: string): FieldRef {
    const f = parseField(ref);
    if (!f) throw new DataError(`"${ref}" is not a field: write table.column (or table.column:${GRAINS.join('|')})`);
    const cols = this.columnsOf(f.table);
    if (cols && !cols.includes(f.column)) {
      const ci = cols.find((c) => c.toLowerCase() === f.column.toLowerCase());
      throw new DataError(`no column "${f.column}" in ${f.table}${ci ? ` (did you mean "${ci}"?)` : ''}; its columns: ${cols.join(', ')}`);
    }
    return f;
  }
  fieldSql(ref: string | FieldRef, withGrain = true): string {
    const f = typeof ref === 'string' ? this.field(ref) : ref;
    const x = `${qid(f.table)}.${qid(f.column)}`;
    return withGrain && f.grain ? GRAIN_SQL(f.grain, x) : x;
  }
  /** Model tables an SQL expression refers to (table.column). */
  tablesIn(expr: string): Set<string> {
    const out = new Set<string>();
    for (const m of mask(expr).matchAll(/(?<![\w."])("?)([A-Za-z_]\w*)\1\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_]\w*)/g)) if (this.tables.has(m[2]!)) out.add(m[2]!);
    return out;
  }
  /** Measures an expression refers to as [Name]. */
  refsIn(expr: string): string[] { return [...mask(expr).matchAll(/\[([^\]\n]{1,80})\]/g)].map((m) => m[1]!.trim()); }

  measure(x: string | InlineMeasure): Measure {
    if (typeof x !== 'string') {
      if (!x?.name) throw new DataError('an inline measure needs a name');
      if (!x.expr && !(x.base && x.calc)) throw new DataError(`measure "${x.name}" needs expr (an aggregate such as sum(sales.amount)) or base and calc`);
      return { ...x, inline: true };
    }
    const m = this.measures.get(x);
    if (!m) {
      const ci = [...this.measures.keys()].find((k) => k.toLowerCase() === x.toLowerCase());
      throw new DataError(`no measure "${x}"${ci ? ` (did you mean "${ci}"?)` : ''}; measures: ${[...this.measures.keys()].join(', ') || 'none (define one with set_measure, or give {name, expr})'}`);
    }
    return m;
  }
  /** derived: an expression over other measures ([A] / [B]), computed after grouping. */
  private isDerived(m: Measure): boolean { return !!m.expr && this.refsIn(m.expr).length > 0; }

  // ---------- tables, security, joins ----------

  private roleFilter(table: string): string | undefined {
    const preds = (this.ctx.roles ?? []).map((r) => r.filters[table]).filter((p): p is string => !!p && !!p.trim());
    if (!preds.length) return undefined;
    // Several roles: a row visible under any of them is visible (as in role-based BI security).
    return preds.map((p) => `(${p.replace(/\{user\}/g, lit(this.ctx.user ?? ''))})`).join(' OR ');
  }
  /** Security through relationships: a table that points at a filtered table sees only the rows that reach visible ones. */
  private securedPred(table: string, seen = new Set<string>()): string | undefined {
    if (!this.ctx.roles?.length || seen.has(table)) return undefined;
    seen.add(table);
    const parts: string[] = [];
    const own = this.roleFilter(table);
    if (own) parts.push(`(${own})`);
    for (const e of this.edges.filter((x) => x.many.table === table)) {
      const inner = this.securedPred(e.one.table, new Set(seen));
      if (inner) parts.push(`${qid(e.many.column)} IN (SELECT ${qid(e.one.column)} FROM ${this.tableSource(e.one.table, new Set(seen))} WHERE ${inner})`);
    }
    return parts.length ? parts.join(' AND ') : undefined;
  }
  /** A table as a relation: its dataset, calculated columns, and row-level security. */
  tableSource(name: string, seen = new Set<string>()): string {
    const t = this.table(name);
    this.datasets.add(t.dataset);
    let rel = `SELECT * FROM ${qid(t.dataset)} AS ${qid(name)}`;
    for (const c of t.columns ?? []) {
      if (!IDENT.test(c.name) && !c.name.trim()) throw new DataError(`calculated column of ${name} needs a name`);
      rel = `SELECT *, (${c.expr}) AS ${qid(c.name)} FROM (${rel}) AS ${qid(name)}`;
    }
    const sec = this.securedPred(name, seen);
    return sec ? `(SELECT * FROM (${rel}) AS ${qid(name)} WHERE ${sec})` : `(${rel})`;
  }
  /** Tables reachable from a fact table along many -> one (and 1:1) relationships, with the join path. */
  private reach(from: string): Map<string, { sql: string; parent?: string }> {
    const joins = new Map<string, { sql: string; parent?: string }>([[from, { sql: '' }]]);
    const queue = [from];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of this.edges) {
        const hops: Array<[FieldRef, FieldRef]> = [];
        if (e.many.table === cur) hops.push([e.many, e.one]);
        if (e.oneToOne && e.one.table === cur) hops.push([e.one, e.many]);
        for (const [a, b] of hops) {
          if (joins.has(b.table)) continue;
          joins.set(b.table, { parent: a.table, sql: `LEFT JOIN ${this.tableSource(b.table)} AS ${qid(b.table)} ON ${qid(a.table)}.${qid(a.column)} = ${qid(b.table)}.${qid(b.column)}` });
          queue.push(b.table);
        }
      }
    }
    return joins;
  }
  /** FROM ... JOIN ... for a fact table and the tables it needs; filters on unreachable tables become semi-joins where cross-filtering allows. */
  private fromClause(fact: string, need: Set<string>): { sql: string; reach: Map<string, { sql: string; parent?: string }> } {
    const r = this.reach(fact);
    const used = new Set<string>([fact]);
    // Include each needed table and the tables on its path (BFS order keeps joins valid).
    const order = [...r.keys()];
    const parentOf = (t: string): string | undefined => r.get(t)?.parent;
    for (const t of need) {
      if (!r.has(t)) continue;
      for (let cur: string | undefined = t; cur && !used.has(cur); cur = parentOf(cur)) used.add(cur);
    }
    const sql = `${this.tableSource(fact)} AS ${qid(fact)}${order.filter((t) => t !== fact && used.has(t)).map((t) => `\n  ${r.get(t)!.sql}`).join('')}`;
    return { sql, reach: r };
  }

  // ---------- filters ----------

  private today(): string { return this.ctx.today ?? new Date().toISOString().slice(0, 10); }
  /** A filter on a field as SQL (the field's grain applies). */
  fieldFilter(f: FilterSpec): string {
    const x = this.fieldSql(f.field);
    const sub = (f as FilterSpec & { __sub?: string }).__sub;
    if (sub) return `${x} IN (${sub})`;
    const vals = (f.values ?? (f.value !== undefined ? [f.value] : [])) as Scalar[];
    const one = () => { if (f.value === undefined && !vals.length) throw new DataError(`filter ${f.op} on ${f.field} needs a value`); return scalarLit((f.value ?? vals[0]) as Scalar); };
    switch (f.op) {
      case 'in': case 'not_in': {
        const nn = vals.filter((v) => v !== null);
        const hasNull = nn.length < vals.length;
        const inner = [nn.length ? `${x} IN (${nn.map(scalarLit).join(', ')})` : '', hasNull ? `${x} IS NULL` : ''].filter(Boolean).join(' OR ') || 'FALSE';
        return f.op === 'in' ? `(${inner})` : `NOT (${inner})`;
      }
      case 'eq': return f.value === null ? `${x} IS NULL` : `${x} = ${one()}`;
      case 'ne': return f.value === null ? `${x} IS NOT NULL` : `${x} IS DISTINCT FROM ${one()}`;
      case 'gt': return `${x} > ${one()}`;
      case 'ge': return `${x} >= ${one()}`;
      case 'lt': return `${x} < ${one()}`;
      case 'le': return `${x} <= ${one()}`;
      case 'between': return `${x} BETWEEN ${one()} AND ${scalarLit((f.to ?? vals[1]) as Scalar)}`;
      case 'contains': return `contains(lower(CAST(${x} AS VARCHAR)), lower(${lit(String(f.value ?? vals[0] ?? ''))}))`;
      case 'starts': return `starts_with(lower(CAST(${x} AS VARCHAR)), lower(${lit(String(f.value ?? vals[0] ?? ''))}))`;
      case 'is_null': return `${x} IS NULL`;
      case 'not_null': return `${x} IS NOT NULL`;
      case 'relative': {
        const unit = f.unit ?? 'day';
        if (!['day', 'week', 'month', 'quarter', 'year'].includes(unit)) throw new DataError('relative date unit is day, week, month, quarter or year');
        const n = Math.max(1, Math.floor(Number(f.n ?? 1)));
        const cur = `date_trunc('${unit}', DATE ${lit(this.today())})`;
        const start = `${cur} - ${INTERVAL(unit as Grain, f.current ? n - 1 : n)}`;
        const end = f.current ? `${cur} + ${INTERVAL(unit as Grain)}` : cur;
        const raw = this.fieldSql(f.field, false);
        return `(${raw} >= ${start} AND ${raw} < ${end})`;
      }
    }
    throw new DataError(`filter op ${f.op} does not apply to a field`);
  }

  // ---------- compile ----------

  compile(q: QuerySpec): Compiled {
    if (q.columns?.length) return this.detail(q);
    const dims = (q.dims ?? []).map((d) => ({ ref: d, f: this.field(d) }));
    const measures = (q.measures ?? []).map((x) => this.measure(x));
    if (!dims.length && !measures.length) throw new DataError('a query needs dims, measures or columns');
    const names = new Set<string>();
    for (const n of [...dims.map((d) => d.ref), ...measures.map((x) => x.name)]) { if (names.has(n)) throw new DataError(`"${n}" is in the query twice`); names.add(n); }

    // Every base measure the query needs (derived and time calcs pull theirs in), each with its fact table.
    const base = new Map<string, Measure>();
    const want = (m: Measure, path: string[] = []) => {
      if (path.includes(m.name)) throw new DataError(`measures refer to each other in a loop: ${[...path, m.name].join(' -> ')}`);
      if (m.calc) {
        if (!(TIME_CALCS as readonly string[]).includes(m.calc)) throw new DataError(`calc is one of ${TIME_CALCS.join(', ')}`);
        if (!m.base) throw new DataError(`measure "${m.name}" has calc ${m.calc} but no base measure`);
        const b = this.measure(m.base);
        if (this.isDerived(b) || b.calc) throw new DataError(`"${m.name}": ${m.calc} needs a base measure that is an aggregate (sum, count, avg ...), not "${b.name}"`);
        return want(b, [...path, m.name]);
      }
      if (!m.expr) throw new DataError(`measure "${m.name}" has no expr`);
      if (this.isDerived(m)) { for (const r of this.refsIn(m.expr)) want(this.measure(r), [...path, m.name]); return; }
      base.set(m.name, m);
    };
    for (const m of measures) want(m);

    const factOf = (m: Measure): string => {
      const ts = [...this.tablesIn(`${m.expr ?? ''} ${m.filter ?? ''}`)];
      if (m.table) return this.table(m.table).name;
      if (!ts.length) {
        // count(*) and other measures naming no table: the fact table of the query's other measures, else a fact table reaching the dims.
        for (const o of base.values()) { const ot = [...this.tablesIn(`${o.expr ?? ''} ${o.filter ?? ''}`)]; if (ot.length) return factOf(o); }
        const dimTables = dims.map((d) => d.f.table);
        const facts = [...this.tables.keys()].filter((t) => dimTables.every((o) => this.reach(t).has(o))).sort((a, b) => this.edges.filter((e) => e.many.table === b).length - this.edges.filter((e) => e.many.table === a).length);
        return facts[0] ?? dims[0]?.f.table ?? [...this.tables.keys()][0] ?? (() => { throw new DataError('the model has no tables'); })();
      }
      // The table on the many side (it reaches the others).
      return ts.find((t) => ts.every((o) => this.reach(t).has(o))) ?? ts[0]!;
    };
    const groups = new Map<string, Measure[]>();
    for (const m of base.values()) { const f = factOf(m); groups.set(f, [...(groups.get(f) ?? []), m]); }
    if (!groups.size) groups.set(this.dimFact(dims.map((d) => d.f.table)), []);

    const fieldFilters = (q.filters ?? []).filter((f) => !!parseField(f.field) && !['top', 'bottom'].includes(f.op));
    const measureFilters = (q.filters ?? []).filter((f) => !parseField(f.field) && !['top', 'bottom'].includes(f.op));
    const topFilters = (q.filters ?? []).filter((f) => ['top', 'bottom'].includes(f.op));
    const totals = q.totals === true ? { rows: dims.length } : q.totals || undefined;
    const timeMeasures = measures.filter((m) => m.calc && ['ytd', 'qtd', 'mtd', 'prev_period', 'prev_year', 'yoy', 'yoy_pct'].includes(m.calc));
    if (totals && measures.some((m) => m.calc)) throw new DataError('subtotals and time calculations cannot be in one query');

    const dimAlias = (i: number) => qid(`__d${i}`);
    const groupSets = totals ? this.groupingSets(dims.length, typeof totals === 'object' ? totals.rows : dims.length, typeof totals === 'object' ? totals.columns : undefined) : undefined;
    const ctes: string[] = [];
    // Per fact table: its measures grouped by the dims, under the filters that reach it.
    const gnames: string[] = [];
    let gi = 0;
    for (const [fact, ms] of groups) {
      const g = `g${gi++}`;
      gnames.push(g);
      const { from, where } = this.factRelation(fact, dims.map((d) => d.f), [...fieldFilters, ...this.topToFilters(topFilters, q)], ms);
      const sel = [...dims.map((d, i) => `${this.fieldSql(d.f)} AS ${dimAlias(i)}`), ...ms.map((m) => `${this.aggSql(m)} AS ${qid(m.name)}`), ...(groupSets ? [`GROUPING(${dims.map((d) => this.fieldSql(d.f)).join(', ')}) AS __grp`] : [])];
      const groupBy = groupSets ? ` GROUP BY GROUPING SETS (${groupSets.map((s) => `(${s.map((i) => this.fieldSql(dims[i]!.f)).join(', ')})`).join(', ')})` : dims.length ? ` GROUP BY ${dims.map((_, i) => i + 1).join(', ')}` : '';
      ctes.push(`${g} AS (SELECT ${sel.join(', ')}\n FROM ${from}${where.length ? `\n WHERE ${where.join('\n   AND ')}` : ''}${groupBy})`);
    }
    // Joined on the dims (null-safe) when several fact tables take part.
    const keyCols = [...dims.map((_, i) => dimAlias(i)), ...(groupSets ? ['__grp'] : [])];
    let joined: string;
    if (gnames.length === 1) joined = gnames[0]!;
    else {
      ctes.push(`k AS (${gnames.map((g) => `SELECT ${keyCols.join(', ') || '1 AS __one'} FROM ${g}`).join(' UNION ')})`);
      joined = `k${gnames.map((g) => ` LEFT JOIN ${g} ON ${keyCols.length ? keyCols.map((c) => `k.${c} IS NOT DISTINCT FROM ${g}.${c}`).join(' AND ') : 'TRUE'}`).join('')}`;
      ctes.push(`j AS (SELECT ${[...keyCols.map((c) => `k.${c}`), ...[...groups].flatMap(([, ms], i) => ms.map((m) => `${gnames[i]}.${qid(m.name)}`))].join(', ') || '1 AS __one'} FROM ${joined})`);
      joined = 'j';
    }
    // Time intelligence: the same base measure over a shifted or widened window of fact rows.
    const timeCols: string[] = [];
    const pre = new Map<string, string>();
    let tci = 0;
    for (const m of timeMeasures) {
      const b = this.measure(m.base!);
      const dateRef = m.date ?? this.m.date;
      const di = dims.findIndex((d) => d.f.grain && (!dateRef || (parseField(dateRef)?.table === d.f.table && parseField(dateRef)?.column === d.f.column)));
      if (di < 0) throw new DataError(`"${m.name}" (${m.calc}) needs a date dimension in the query, e.g. ${dateRef ? `${dateRef.replace(/:.*$/, '')}:month` : 'sales.day:month'}`);
      const d = dims[di]!.f;
      const g = d.grain!;
      const raw = this.fieldSql(d, false);
      const k = `${dimAlias(di)}`;
      const span = (calc: string): [string, string] => {
        switch (calc) {
          case 'ytd': case 'qtd': case 'mtd': {
            const unit = calc === 'ytd' ? 'year' : calc === 'qtd' ? 'quarter' : 'month';
            if (GRAINS.indexOf(g) < GRAINS.indexOf(unit as Grain) || g === unit) throw new DataError(`"${m.name}": ${calc} needs the date at a finer grain than ${unit} (got ${g})`);
            return [`date_trunc('${unit}', k.${k})`, `k.${k} + ${INTERVAL(g)}`];
          }
          case 'prev_period': return [`k.${k} - ${INTERVAL(g)}`, `k.${k}`];
          default: return [`k.${k} - INTERVAL 1 YEAR`, `k.${k} - INTERVAL 1 YEAR + ${INTERVAL(g)}`];
        }
      };
      const calc = m.calc === 'yoy' || m.calc === 'yoy_pct' ? 'prev_year' : m.calc!;
      const [lo, hi] = span(calc);
      const fact = factOf(b);
      // Date filters apply to the periods shown (the keys), not to the window's rows.
      const nonDate = fieldFilters.filter((f) => { const p = parseField(f.field)!; return !(p.table === d.table && p.column === d.column); });
      const { from, where } = this.factRelation(fact, dims.map((x) => x.f), nonDate, [b]);
      const t = `t${tci++}`;
      const on = [...dims.map((x, i) => (i === di ? '' : `${this.fieldSql(x.f)} IS NOT DISTINCT FROM k.${dimAlias(i)}`)).filter(Boolean), `${raw} >= ${lo}`, `${raw} < ${hi}`];
      ctes.push(`${t} AS (SELECT ${dims.map((_, i) => `k.${dimAlias(i)}`).join(', ')}, ${this.aggSql(b)} AS v\n FROM ${from}\n JOIN (SELECT DISTINCT ${dims.map((_, i) => dimAlias(i)).join(', ')} FROM ${joined}) AS k ON ${on.join(' AND ')}${where.length ? `\n WHERE ${where.join(' AND ')}` : ''}\n GROUP BY ${dims.map((_, i) => `k.${dimAlias(i)}`).join(', ')})`);
      const val = `${t}.v`;
      const cur = `${joined}.${qid(b.name)}`;
      const expr = m.calc === 'yoy' ? `(${cur} - ${val})` : m.calc === 'yoy_pct' ? `((${cur} - ${val}) / NULLIF(${val}, 0))` : val;
      timeCols.push(`LEFT JOIN ${t} ON ${dims.map((_, i) => `${t}.${dimAlias(i)} IS NOT DISTINCT FROM ${joined}.${dimAlias(i)}`).join(' AND ')}`);
      pre.set(m.name, expr);
    }
    // Totals for % of total: the base measure over every row under the filters.
    const totCols: string[] = [];
    for (const m of measures.filter((x) => x.calc === 'pct_of_total')) {
      const b = this.measure(m.base!);
      const { from, where } = this.factRelation(factOf(b), [], fieldFilters, [b]);
      const t = `tot${totCols.length}`;
      ctes.push(`${t} AS (SELECT ${this.aggSql(b)} AS v FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''})`);
      totCols.push(`CROSS JOIN ${t}`);
      pre.set(m.name, `(${joined}.${qid(b.name)} / NULLIF(${t}.v, 0))`);
    }

    // The outer select: dims, then each measure (derived ones from their parts, window calcs over the result).
    const dateDim = dims.findIndex((d) => !!d.f.grain);
    const others = (skip: number) => dims.map((_, i) => i).filter((i) => i !== skip).map((i) => `${joined}.${dimAlias(i)}`);
    const outerOf = (m: Measure): string => {
      const p = pre.get(m.name);
      if (p) return p;
      if (m.calc) {
        const b = `${joined}.${qid(m.base!)}`;
        if (m.calc === 'rank') return `RANK() OVER (${dims.length > 1 && dateDim >= 0 ? `PARTITION BY ${joined}.${dimAlias(dateDim)} ` : ''}ORDER BY ${b} DESC NULLS LAST)`;
        if (dateDim < 0) throw new DataError(`"${m.name}" (${m.calc}) needs a date dimension in the query`);
        const part = others(dateDim);
        const w = `${part.length ? `PARTITION BY ${part.join(', ')} ` : ''}ORDER BY ${joined}.${dimAlias(dateDim)}`;
        if (m.calc === 'running_total') return `SUM(${b}) OVER (${w} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
        if (m.calc === 'moving_avg') return `AVG(${b}) OVER (${w} ROWS BETWEEN ${Math.max(0, (m.periods ?? 3) - 1)} PRECEDING AND CURRENT ROW)`;
      }
      if (this.isDerived(m)) return `(${m.expr!.replace(/\[([^\]\n]{1,80})\]/g, (_x, n: string) => `(${outerOf(this.measure(n.trim()))})`)})`;
      return `${joined}.${qid(m.name)}`;
    };
    const outerSel = [...dims.map((d, i) => `${joined}.${dimAlias(i)} AS ${qid(d.ref)}`), ...measures.map((m) => `${outerOf(m)} AS ${qid(m.name)}`), ...(groupSets ? [`${joined}.__grp AS __level`] : [])];
    let sql = `WITH ${ctes.join(',\n')}\nSELECT ${outerSel.join(', ')}\nFROM ${joined}${timeCols.length ? `\n${timeCols.join('\n')}` : ''}${totCols.length ? `\n${totCols.join('\n')}` : ''}`;
    // Measure filters (value > x) after aggregation.
    if (measureFilters.length) {
      for (const f of measureFilters) if (!measures.some((m) => m.name === f.field)) throw new DataError(`filter on "${f.field}": it is neither a field (table.column) nor a measure of this query`);
      sql = `SELECT * FROM (${sql}) AS r WHERE ${measureFilters.map((f) => this.valueFilter(`r.${qid(f.field)}`, f)).join(' AND ')}`;
    }
    const order = this.orderBy(q, dims.map((d) => d.ref), measures.map((m) => m.name), !!groupSets);
    sql = `SELECT * FROM (${sql}) AS r${order ? ` ORDER BY ${order}` : ''}${q.limit ? ` LIMIT ${Math.max(1, Math.floor(q.limit))}` : ''}`;
    const columns: ResultColumn[] = [
      ...dims.map((d) => ({ name: d.ref, label: this.label(d.f), type: '', role: 'dim' as const, field: d.ref, ...(d.f.grain ? { grain: d.f.grain } : {}), ...(this.m.formats[d.ref] ? { format: this.m.formats[d.ref] } : {}) })),
      ...measures.map((m) => ({ name: m.name, label: m.name, type: '', role: 'measure' as const, ...(this.formatOf(m) ? { format: this.formatOf(m) } : {}) })),
      ...(groupSets ? [{ name: '__level', label: 'level', type: 'INTEGER', role: 'level' as const }] : []),
    ];
    return { sql, columns, datasets: this.datasets, warnings: this.warnings };
  }

  private formatOf(m: Measure): string | undefined {
    if (m.format) return m.format;
    if (this.m.formats[m.name]) return this.m.formats[m.name];
    if (m.calc === 'yoy_pct' || m.calc === 'pct_of_total') return 'percent:1';
    if (m.base && m.calc !== 'rank') return this.formatOf(this.measure(m.base));
    return undefined;
  }
  label(f: FieldRef): string { return `${f.column}${f.grain ? ` (${f.grain})` : ''}`; }

  private dimFact(tables: string[]): string {
    // Dims only: the table that reaches every other one.
    const ts = [...new Set(tables)];
    return ts.find((t) => ts.every((o) => this.reach(t).has(o))) ?? ts[0] ?? [...this.tables.keys()][0]!;
  }

  private aggSql(m: Measure): string {
    const e = m.expr!.trim();
    return m.filter ? this.withFilter(e, m.filter) : `(${e})`;
  }
  /** Adds FILTER (WHERE ...) to every aggregate call of an expression (a measure's own filter context). */
  private withFilter(expr: string, filter: string): string {
    const aggs = /\b(sum|avg|count|min|max|median|stddev|stddev_samp|stddev_pop|var_samp|var_pop|first|last|any_value|mode|quantile_cont|quantile_disc|approx_count_distinct|string_agg|list|arg_max|arg_min|bool_and|bool_or|product|sumkahan|fsum|kurtosis|skewness|entropy|corr|covar_pop|covar_samp|regr_slope)\s*\(/gi;
    let out = ''; let i = 0; let m: RegExpExecArray | null;
    const masked = mask(expr);
    while ((m = aggs.exec(masked))) {
      let depth = 0; let j = m.index + m[0].length - 1;
      for (; j < masked.length; j++) { if (masked[j] === '(') depth++; else if (masked[j] === ')') { depth--; if (depth === 0) break; } }
      out += `${expr.slice(i, j + 1)} FILTER (WHERE ${filter})`;
      i = j + 1;
      aggs.lastIndex = j + 1;
    }
    if (!out) throw new DataError(`measure filter needs an aggregate in the expression (${expr})`);
    return `(${out}${expr.slice(i)})`;
  }

  /** The relation of a fact table with what the query needs joined, and the filters that reach it. */
  private factRelation(fact: string, dims: FieldRef[], filters: FilterSpec[], ms: Measure[]): { from: string; where: string[] } {
    const need = new Set<string>([...dims.map((d) => d.table), ...filters.map((f) => parseField(f.field)!.table)]);
    for (const m of ms) for (const t of this.tablesIn(`${m.expr ?? ''} ${m.filter ?? ''}`)) need.add(t);
    const reach = this.reach(fact);
    for (const d of dims) if (!reach.has(d.table)) throw new DataError(`${fieldRefText(d)} cannot group ${ms.length ? `"${ms.map((m) => m.name).join('", "')}"` : fact}: no many-to-one relationship path from ${fact} to ${d.table} (add one with set_relationship)`);
    for (const m of ms) for (const t of this.tablesIn(`${m.expr ?? ''} ${m.filter ?? ''}`)) if (!reach.has(t)) throw new DataError(`measure "${m.name}" uses ${t}, which ${fact} does not reach through relationships`);
    const { sql } = this.fromClause(fact, need);
    const where: string[] = [];
    for (const f of filters) {
      const t = parseField(f.field)!.table;
      if (reach.has(t)) { where.push(this.fieldFilter(f)); continue; }
      // Cross-filtering both ways: a filter on a table on the many side of a reached table, or on a
      // table that many side reaches (products -> orders -> customers: the customers who bought tea).
      const e = this.edges.find((x) => x.many.table === t && x.both && reach.has(x.one.table))
        ?? this.edges.find((x) => x.both && reach.has(x.one.table) && x.many.table !== fact && this.reach(x.many.table).has(t));
      if (e) {
        const from = e.many.table === t ? `${this.tableSource(t)} AS ${qid(t)}` : this.fromClause(e.many.table, new Set([t])).sql;
        where.push(`${qid(e.one.table)}.${qid(e.one.column)} IN (SELECT ${qid(e.many.table)}.${qid(e.many.column)} FROM ${from} WHERE ${this.fieldFilter(f)})`);
        continue;
      }
      this.warnings.push(`the filter on ${f.field} does not reach ${fact} (no relationship; set cross-filtering to both or add a relationship): it was not applied to ${ms.map((m) => m.name).join(', ') || fact}`);
    }
    return { from: sql, where };
  }

  /** top/bottom N of a field by a measure, as an IN filter computed under the other filters. */
  private topToFilters(tops: FilterSpec[], q: QuerySpec): FilterSpec[] {
    return tops.map((t) => {
      if (!t.by) throw new DataError(`${t.op} on ${t.field} needs "by": the measure that ranks`);
      const others = (q.filters ?? []).filter((f) => f !== t && !['top', 'bottom'].includes(f.op) && !!parseField(f.field));
      const sub = new SemanticCompiler(this.ctx).compile({ dims: [t.field], measures: [t.by], filters: others, sort: [{ by: t.by, desc: t.op === 'top' }], limit: Math.max(1, Math.floor(Number(t.n ?? t.value ?? 10))) });
      for (const d of sub.datasets) this.datasets.add(d);
      return { field: t.field, op: 'in', __sub: `SELECT ${qid(t.field)} FROM (${sub.sql}) AS s` } as FilterSpec;
    });
  }

  private valueFilter(x: string, f: FilterSpec): string {
    const v = scalarLit((f.value ?? f.values?.[0] ?? null) as Scalar);
    switch (f.op) {
      case 'gt': return `${x} > ${v}`; case 'ge': return `${x} >= ${v}`; case 'lt': return `${x} < ${v}`; case 'le': return `${x} <= ${v}`;
      case 'eq': return `${x} = ${v}`; case 'ne': return `${x} IS DISTINCT FROM ${v}`;
      case 'between': return `${x} BETWEEN ${v} AND ${scalarLit((f.to ?? f.values?.[1] ?? null) as Scalar)}`;
      case 'is_null': return `${x} IS NULL`; case 'not_null': return `${x} IS NOT NULL`;
    }
    throw new DataError(`filter op ${f.op} does not apply to a measure`);
  }

  private orderBy(q: QuerySpec, dims: string[], ms: string[], totals: boolean): string {
    const known = new Set([...dims, ...ms]);
    if (q.sort?.length) {
      for (const s of q.sort) if (!known.has(s.by)) throw new DataError(`sort by "${s.by}": it is not in the query (${[...known].join(', ')})`);
      return q.sort.map((s) => `${qid(s.by)} ${s.desc ? 'DESC' : 'ASC'} NULLS LAST`).join(', ');
    }
    if (totals) return dims.map((d) => `${qid(d)} ASC NULLS LAST`).join(', ');
    const dated = dims.filter((d) => !!parseField(d)?.grain);
    if (dated.length || !ms.length) return dims.map((d) => `${qid(d)} ASC NULLS LAST`).join(', ');
    return `${qid(ms[0]!)} DESC NULLS LAST${dims.length ? `, ${dims.map((d) => `${qid(d)} ASC`).join(', ')}` : ''}`;
  }

  /** Grouping sets for subtotals: prefixes of the row dims, each with and without the column dims. */
  private groupingSets(n: number, rows: number, columns?: number): number[][] {
    const r = Math.min(n, Math.max(0, rows));
    const cols = Array.from({ length: n - r }, (_, i) => r + i);
    const sets: number[][] = [];
    for (let k = r; k >= 0; k--) {
      const pre = Array.from({ length: k }, (_, i) => i);
      sets.push([...pre, ...cols]);
      if (cols.length && columns !== 0) sets.push(pre);
    }
    return sets.filter((s, i) => sets.findIndex((x) => x.join() === s.join()) === i);
  }

  /** Detail rows: fields of a table and the tables it reaches, filtered. */
  private detail(q: QuerySpec): Compiled {
    const cols = q.columns!.map((c) => ({ ref: c, f: this.field(c) }));
    const fact = this.dimFact(cols.map((c) => c.f.table));
    const { from, where } = this.factRelation(fact, cols.map((c) => c.f), (q.filters ?? []).filter((f) => !!parseField(f.field)), []);
    const order = q.sort?.length ? q.sort.map((s) => { if (!q.columns!.includes(s.by)) throw new DataError(`sort by "${s.by}": not one of the columns`); return `${qid(s.by)} ${s.desc ? 'DESC' : 'ASC'} NULLS LAST`; }).join(', ') : '';
    const sql = `SELECT ${cols.map((c) => `${this.fieldSql(c.f)} AS ${qid(c.ref)}`).join(', ')}\nFROM ${from}${where.length ? `\nWHERE ${where.join(' AND ')}` : ''}${order ? `\nORDER BY ${order}` : ''}${q.limit ? `\nLIMIT ${Math.max(1, Math.floor(q.limit))}` : ''}`;
    return { sql, columns: cols.map((c) => ({ name: c.ref, label: this.label(c.f), type: '', role: 'column' as const, field: c.ref, ...(c.f.grain ? { grain: c.f.grain } : {}), ...(this.m.formats[c.ref] ? { format: this.m.formats[c.ref] } : {}) })), datasets: this.datasets, warnings: this.warnings };
  }
}

const fieldRefText = (f: FieldRef) => `${f.table}.${f.column}${f.grain ? `:${f.grain}` : ''}`;

/** Compiles a query against a model for a viewer. */
export function compileQuery(q: QuerySpec, ctx: CompileContext): Compiled {
  return new SemanticCompiler(ctx).compile(q);
}
