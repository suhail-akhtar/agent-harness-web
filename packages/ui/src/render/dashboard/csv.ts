import type { QueryResult, Scalar } from '@harness/plugin-ui';

/** A result as CSV: the computed values as they are (no formatting), headed by the column labels. */
export function toCsvText(r: QueryResult): string {
  const cell = (v: Scalar) => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role !== 'level');
  return [cols.map(([c]) => cell(c.label || c.name)), ...r.rows.map((row) => cols.map(([, i]) => cell(row[i]!)))].map((l) => l.join(',')).join('\r\n') + '\r\n';
}
