import { AGG_FNS, type AggFn, COLUMN_TYPES, type DatasetSpec, IDENT, STEP_OPS, type StepSpec } from '../../packages/plugin-ui/src/bi.ts';
import { DataError, lit, qid, scalarLit } from './engine.ts';

// Query-editor steps compiled to SQL: one CTE per step over the one before, so the step list
// replays exactly, each step can be previewed (the chain cut after it), and the whole dataset is
// one SELECT. The source's row order (__rn, from the extract) is kept while steps keep rows
// (fill down and "first" need it) and dropped at the end.

const TYPE_SQL: Record<string, string> = { integer: 'BIGINT', double: 'DOUBLE', decimal: 'DECIMAL(38,10)', text: 'VARCHAR', date: 'DATE', timestamp: 'TIMESTAMP', boolean: 'BOOLEAN' };
const AGG_SQL = (fn: AggFn, col: string | undefined, ordered: boolean): string => {
  const c = col ? qid(col) : '*';
  switch (fn) {
    case 'count': return col ? `count(${c})` : 'count(*)';
    case 'count_distinct': return `count(DISTINCT ${c})`;
    case 'stddev': return `stddev_samp(${c})`;
    case 'first': return ordered ? `arg_min(${c}, __rn)` : `first(${c})`;
    case 'last': return ordered ? `arg_max(${c}, __rn)` : `last(${c})`;
    default: return `${fn}(${c})`;
  }
};

/** Checks a step's shape (names, ops) before it is compiled; the engine checks columns and expressions. */
export function checkStep(s: StepSpec): void {
  if (!s || typeof s !== 'object' || !(STEP_OPS as readonly string[]).includes((s as { op?: string }).op ?? '')) throw new DataError(`a step's op is one of ${STEP_OPS.join(', ')}`);
  const cols = (v: unknown, what: string) => { if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && x)) throw new DataError(`${s.op}: ${what} is a list of column names`); };
  switch (s.op) {
    case 'filter': if (!s.where?.trim()) throw new DataError('filter: where is an SQL condition, e.g. amount > 0'); break;
    case 'keep': case 'remove': cols(s.columns, 'columns'); break;
    case 'rename': if (!s.columns || typeof s.columns !== 'object' || !Object.keys(s.columns).length) throw new DataError('rename: columns is {"old": "new"}'); break;
    case 'type': if (!s.column || !(COLUMN_TYPES as readonly string[]).includes(s.to)) throw new DataError(`type: column and to (${COLUMN_TYPES.join(', ')})`); break;
    case 'split': if (!s.column || !s.by || !Array.isArray(s.into) || s.into.length < 2) throw new DataError('split: column, by (a separator) and into (two or more new names)'); break;
    case 'filldown': cols(s.columns, 'columns'); break;
    case 'replace': if (!s.column || s.find === undefined) throw new DataError('replace: column, find and with'); break;
    case 'group': cols(s.by, 'by'); if (!Array.isArray(s.aggs) || !s.aggs.length || !s.aggs.every((a) => (AGG_FNS as readonly string[]).includes(a.fn) && a.as)) throw new DataError(`group: aggs is a list of {column, fn (${AGG_FNS.join(', ')}), as}`); break;
    case 'pivot': if (!s.on || !s.values) throw new DataError('pivot: on (the column whose values become columns) and values'); break;
    case 'unpivot': cols(s.columns, 'columns'); if (!s.name || !s.value) throw new DataError('unpivot: name and value (the two new columns)'); break;
    case 'merge': if (!IDENT.test(s.with ?? '') || !Array.isArray(s.on) || !s.on.length) throw new DataError('merge: with (a dataset) and on ([["left column","right column"]])'); break;
    case 'append': if (!Array.isArray(s.with) || !s.with.length || !s.with.every((x) => IDENT.test(x))) throw new DataError('append: with is a list of datasets'); break;
    case 'dedupe': if (s.columns !== undefined) cols(s.columns, 'columns'); break;
    case 'add': if (!s.name || !s.expr?.trim()) throw new DataError('add: name and expr (SQL over the row)'); break;
    case 'conditional': if (!s.name || !Array.isArray(s.cases) || !s.cases.length) throw new DataError('conditional: name and cases [{when, then}]'); break;
    case 'dateparts': if (!s.column || !Array.isArray(s.parts) || !s.parts.length) throw new DataError('dateparts: column and parts'); break;
    case 'sort': if (!Array.isArray(s.by) || !s.by.length) throw new DataError('sort: by [{column, desc}]'); break;
    case 'limit': if (!(Number(s.n) > 0)) throw new DataError('limit: n > 0'); break;
  }
}

/**
 * The SQL of a dataset over its base relation (`from`): steps, then its own SQL. `upTo` cuts the
 * chain after that many steps (a preview of one step). Other datasets are referred to by name.
 */
export function compileDataset(d: DatasetSpec, from: string | undefined, o: { upTo?: number; columnsOf?: (dataset: string) => string[] | undefined } = {}): string {
  const steps = (d.steps ?? []).slice(0, o.upTo ?? d.steps?.length ?? 0);
  if (!from && !d.sql) throw new DataError(`dataset ${d.name} needs a source or SQL`);
  if (!from && steps.length) throw new DataError(`dataset ${d.name}: steps need a source to start from`);
  const ctes: string[] = [];
  let ordered = !!from;
  let prev = 's0';
  if (from) ctes.push(`s0 AS (SELECT * FROM ${from})`);
  const noRn = (rel: string) => (ordered ? `(SELECT * EXCLUDE (__rn) FROM ${rel})` : rel);
  steps.forEach((s, i) => {
    checkStep(s);
    const p = prev; const n = `s${i + 1}`;
    let sql: string;
    switch (s.op) {
      case 'filter': sql = `SELECT * FROM ${p} WHERE (${s.where})`; break;
      case 'keep': sql = `SELECT ${ordered ? '__rn, ' : ''}${s.columns.map(qid).join(', ')} FROM ${p}`; break;
      case 'remove': sql = `SELECT * EXCLUDE (${s.columns.map(qid).join(', ')}) FROM ${p}`; break;
      case 'rename': sql = `SELECT * RENAME (${Object.entries(s.columns).map(([a, b]) => `${qid(a)} AS ${qid(b)}`).join(', ')}) FROM ${p}`; break;
      case 'type': {
        const t = TYPE_SQL[s.to]!;
        const x = (s.to === 'date' || s.to === 'timestamp') && s.format ? `CAST(strptime(CAST(${qid(s.column)} AS VARCHAR), ${lit(s.format)}) AS ${t})` : `CAST(${qid(s.column)} AS ${t})`;
        sql = `SELECT * REPLACE (${x} AS ${qid(s.column)}) FROM ${p}`; break;
      }
      case 'split': sql = `SELECT * EXCLUDE (${qid(s.column)}), ${s.into.map((name, k) => `NULLIF(split_part(CAST(${qid(s.column)} AS VARCHAR), ${lit(s.by)}, ${k + 1}), '') AS ${qid(name)}`).join(', ')} FROM ${p}`; break;
      case 'filldown':
        if (!ordered) throw new DataError(`step ${i + 1} (fill down) needs the source's row order: put it before group, pivot, unpivot, append or dedupe`);
        sql = `SELECT * REPLACE (${s.columns.map((c) => `last_value(${qid(c)} IGNORE NULLS) OVER (ORDER BY __rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ${qid(c)}`).join(', ')}) FROM ${p}`; break;
      case 'replace': sql = `SELECT * REPLACE (CASE WHEN ${qid(s.column)} IS NOT DISTINCT FROM ${scalarLit(s.find)} THEN ${scalarLit(s.with)} ELSE ${qid(s.column)} END AS ${qid(s.column)}) FROM ${p}`; break;
      case 'group':
        sql = `SELECT ${[...s.by.map(qid), ...s.aggs.map((a) => `${AGG_SQL(a.fn, a.column, ordered)} AS ${qid(a.as)}`)].join(', ')} FROM ${p} GROUP BY ${s.by.map(qid).join(', ')}`;
        ordered = false; break;
      case 'pivot': {
        const vals = (s as { columns?: unknown[] }).columns;
        if (!Array.isArray(vals) || !vals.length) throw new DataError(`step ${i + 1} (pivot) has no values to make columns of (the op layer fills them when the step is added)`);
        sql = `SELECT * FROM ${noRn(p)} PIVOT (${AGG_SQL(s.fn ?? 'sum', s.values, false)} FOR ${qid(s.on)} IN (${vals.map((v) => scalarLit(v as string)).join(', ')})${s.using?.length ? ` GROUP BY ${s.using.map(qid).join(', ')}` : ''})`;
        ordered = false; break;
      }
      case 'unpivot': sql = `SELECT * FROM ${noRn(p)} UNPIVOT (${qid(s.value)} FOR ${qid(s.name)} IN (${s.columns.map(qid).join(', ')}))`; ordered = false; break;
      case 'merge': {
        const how = s.how ?? 'left';
        const on = s.on.map(([a, b]) => `l.${qid(a)} = r.${qid(b)}`).join(' AND ');
        if (how === 'anti' || how === 'semi') { sql = `SELECT l.* FROM ${p} AS l ${how.toUpperCase()} JOIN ${qid(s.with)} AS r ON ${on}`; break; }
        const right = s.columns ?? o.columnsOf?.(s.with)?.filter((c) => !s.on.some(([, b]) => b === c) && c !== '__rn');
        if (!right) throw new DataError(`step ${i + 1} (merge): refresh ${s.with} first, or name the columns to bring`);
        const prefix = s.prefix ?? `${s.with}.`;
        sql = `SELECT l.*, ${right.map((c) => `r.${qid(c)} AS ${qid(`${prefix}${c}`)}`).join(', ') || 'NULL AS __none'} FROM ${p} AS l ${how.toUpperCase()} JOIN ${qid(s.with)} AS r ON ${on}`; break;
      }
      case 'append': sql = `SELECT * FROM ${noRn(p)} ${s.with.map((w) => `UNION ALL BY NAME SELECT * FROM ${qid(w)}`).join(' ')}`; ordered = false; break;
      case 'dedupe':
        if (s.columns?.length) sql = ordered ? `SELECT * FROM ${p} QUALIFY row_number() OVER (PARTITION BY ${s.columns.map(qid).join(', ')} ORDER BY __rn) = 1` : `SELECT DISTINCT ON (${s.columns.map(qid).join(', ')}) * FROM ${p}`;
        else { sql = `SELECT DISTINCT * FROM ${noRn(p)}`; ordered = false; }
        break;
      case 'add': sql = `SELECT *, (${s.expr}) AS ${qid(s.name)} FROM ${p}`; break;
      case 'conditional': sql = `SELECT *, CASE ${s.cases.map((c) => `WHEN (${c.when}) THEN ${scalarLit(c.then)}`).join(' ')} ELSE ${scalarLit(s.else ?? null)} END AS ${qid(s.name)} FROM ${p}`; break;
      case 'dateparts': {
        const x = qid(s.column);
        const part: Record<string, string> = { year: `year(${x})`, quarter: `quarter(${x})`, month: `month(${x})`, monthname: `monthname(${x})`, week: `week(${x})`, day: `day(${x})`, weekday: `isodow(${x})`, dayname: `dayname(${x})` };
        sql = `SELECT *, ${s.parts.map((k) => { if (!part[k]) throw new DataError(`dateparts: ${k} is not a part`); return `${part[k]} AS ${qid(`${s.column} ${k}`)}`; }).join(', ')} FROM ${p}`; break;
      }
      case 'sort': {
        const by = s.by.map((b) => `${qid(b.column)} ${b.desc ? 'DESC' : 'ASC'} NULLS LAST`).join(', ');
        sql = ordered ? `SELECT * REPLACE (row_number() OVER (ORDER BY ${by}, __rn) AS __rn) FROM ${p}` : `SELECT * FROM ${p} ORDER BY ${by}`; break;
      }
      case 'limit': sql = `SELECT * FROM ${p}${ordered ? ' ORDER BY __rn' : ''} LIMIT ${Math.floor(Number(s.n))}`; break;
    }
    ctes.push(`${n} AS (${sql})`);
    prev = n;
  });
  const last = from ? `SELECT * ${ordered ? 'EXCLUDE (__rn) ' : ''}FROM ${prev}${ordered ? ' ORDER BY __rn' : ''}` : '';
  if (!d.sql || o.upTo !== undefined) return ctes.length ? `WITH ${ctes.join(',\n')}\n${last}` : last;
  // The dataset's own SQL sees the steps' result as `base`.
  const params = (d.params ?? []).map((x) => x.name);
  const user = d.sql.replace(/\$([A-Za-z_]\w*)/g, (m, name: string) => (params.includes(name) ? `getvariable(${lit(`${d.name}.${name}`)})` : m));
  return from ? `WITH ${ctes.join(',\n')},\nbase AS (${last})\nSELECT * FROM (\n${user}\n)` : user;
}
