/**
 * A dashboard visual as an ECharts option, from the numbers the engine computed. Pure (no DOM), so
 * the desktop, published pages and tests build the same figure. Nothing here aggregates: values are
 * placed as they came; the only arithmetic is layout (stack offsets, the share a 100% stack draws,
 * a waterfall's running position), and tooltips always show the computed value.
 */

import { type FilterSpec, formatValue, type QueryResult, type ResultColumn, type Scalar, type ThemeSpec, type VisualSpec } from '@harness/plugin-ui';
import { DARK_SERIES, LIGHT_SERIES } from '../chart-theme.ts';

export interface Shaped {
  categories: Scalar[];
  /** One per series: name, the measure column it reads, values per category, and the highlighted part. */
  series: Array<{ name: string; measure: ResultColumn; values: Array<number | null>; highlight?: Array<number | null>; key?: Scalar }>;
  dim?: ResultColumn;
  seriesDim?: ResultColumn;
  /** An expanded drill: each category label's values per level, and the levels' fields. */
  paths?: Record<string, Scalar[]>;
  pathFields?: string[];
}

const num = (v: Scalar | undefined): number | null => (v === null || v === undefined || v === '' ? null : typeof v === 'number' ? v : Number.isFinite(Number(v)) ? Number(v) : null);

/** Rows to categories x series: a second dim becomes the series (one measure), else each measure is a series. */
export function shape(r: QueryResult): Shaped {
  // An expanded drill (several hierarchy levels at once): the levels make one axis ("2024 › Q1"),
  // and a click carries a value for each level.
  const k = typeof r.extra?.expand === 'number' ? r.extra.expand : 0;
  if (k >= 2) {
    const path = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim').slice(0, k);
    if (path.length === k) {
      const keep = r.columns.map((_, i) => i).filter((i) => !path.some(([, j]) => j === i));
      const paths: Record<string, Scalar[]> = {};
      const rows = r.rows.map((row) => { const l = path.map(([c, i]) => formatValue(row[i] ?? null, c.format, c.grain) || '(blank)').join(' › '); paths[l] = path.map(([, i]) => row[i] ?? null); return [l, ...keep.map((i) => row[i] ?? null)]; });
      const columns: ResultColumn[] = [{ name: '__path', label: path.map(([c]) => c.label).join(' › '), type: 'VARCHAR', role: 'dim' }, ...keep.map((i) => r.columns[i]!)];
      return { ...shape({ ...r, columns, rows, extra: { ...r.extra, expand: 0 } }), paths, pathFields: path.map(([c]) => c.field ?? c.name) };
    }
  }
  const dims = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
  const ms = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
  const level = r.columns.findIndex((c) => c.role === 'level');
  const rows = level >= 0 ? r.rows.filter((x) => x[level] === 0) : r.rows;
  const hl = r.highlight ? (level >= 0 ? r.highlight.filter((_, i) => r.rows[i]![level] === 0) : r.highlight) : undefined;
  const [d0, d1] = dims;
  const categories: Scalar[] = [];
  const ci = new Map<string, number>();
  const cat = (v: Scalar) => { const k = JSON.stringify(v); if (!ci.has(k)) { ci.set(k, categories.length); categories.push(v); } return ci.get(k)!; };
  if (d0 && d1 && ms.length) {
    const [m, mi] = ms[0]!;
    const sKeys: Scalar[] = []; const si = new Map<string, number>();
    for (const row of rows) { cat(row[d0[1]]!); const k = JSON.stringify(row[d1[1]]); if (!si.has(k)) { si.set(k, sKeys.length); sKeys.push(row[d1[1]]!); } }
    const series = sKeys.map((k) => ({ name: formatValue(k, d1[0].format, d1[0].grain) || '(blank)', key: k, measure: m, values: categories.map(() => null as number | null), ...(hl ? { highlight: categories.map(() => null as number | null) } : {}) }));
    rows.forEach((row, ri) => { const s = series[si.get(JSON.stringify(row[d1[1]]))!]!; const c = ci.get(JSON.stringify(row[d0[1]]))!; s.values[c] = num(row[mi]); if (s.highlight) s.highlight[c] = num(hl![ri]![0]); });
    return { categories, series, dim: d0[0], seriesDim: d1[0] };
  }
  for (const row of rows) cat(d0 ? row[d0[1]]! : '');
  return {
    categories, dim: d0?.[0],
    series: ms.map(([m, mi], k) => ({ name: m.label, measure: m, values: rows.map((row) => num(row[mi])), ...(hl ? { highlight: hl.map((h) => num(h[k])) } : {}) })),
  };
}

export function palette(theme: ThemeSpec, dark: boolean): string[] {
  if (theme.name === 'default' && !theme.background) return dark ? DARK_SERIES : LIGHT_SERIES;
  return theme.palette;
}

export interface OptionContext { theme: ThemeSpec; dark: boolean; selection?: FilterSpec[]; height?: number; static?: boolean }

const PIE_LIKE = new Set(['pie', 'donut', 'funnel', 'treemap']);

/** The ECharts option for a chart visual (bar, column, line, area, combo, ribbon, waterfall, funnel, pie, donut, treemap, scatter, gauge, map). */
export function visualOption(v: VisualSpec, r: QueryResult, ctx: OptionContext): Record<string, unknown> {
  const colors = v.options?.colors?.length ? v.options.colors : palette(ctx.theme, ctx.dark);
  const fm = (c: ResultColumn | undefined) => (x: Scalar) => formatValue(x, v.options?.formats?.[c?.name ?? ''] ?? c?.format, c?.grain);
  const s = shape(r);
  const catLabels = s.categories.map((c) => fm(s.dim)(c) || (s.dim ? '(blank)' : ''));
  const base = { color: colors, animationDuration: ctx.static ? 0 : 400, animation: !ctx.static, tooltip: { trigger: PIE_LIKE.has(v.type) || v.type === 'scatter' ? 'item' : 'axis', confine: true }, legend: { show: v.options?.legend !== false && (s.series.length > 1 || PIE_LIKE.has(v.type)), type: 'scroll', bottom: 0 }, grid: { left: 8, right: 16, top: 16, bottom: s.series.length > 1 ? 36 : 12, containLabel: true } };
  const valueFmt = (m: ResultColumn) => (x: number) => formatValue(x, v.options?.formats?.[m.name] ?? m.format);
  /** Axis ticks: short ($3M, 40%), the full value is in the tooltip. */
  const axisFmt = (m: ResultColumn) => (x: number) => compact(x, v.options?.formats?.[m.name] ?? m.format);
  const selected = (cat: Scalar) => ctx.selection?.some((f) => f.field === s.dim?.field && (f.value === cat || f.values?.includes(cat)));
  const anySel = !!ctx.selection?.length && ctx.selection.some((f) => f.field === s.dim?.field);

  switch (v.type) {
    case 'pie': case 'donut': case 'funnel': {
      const m = s.series[0]!;
      const data = s.categories.map((c, i) => ({ name: catLabels[i], value: m.values[i], raw: c, itemStyle: anySel && !selected(c) ? { opacity: 0.35 } : undefined }));
      return { ...base, tooltip: { trigger: 'item', confine: true, valueFormatter: valueFmt(m.measure) }, series: [v.type === 'funnel'
        ? { type: 'funnel', left: '8%', width: '84%', top: 8, bottom: 32, data, label: { show: true, position: 'inside' }, sort: 'descending' }
        : { type: 'pie', radius: v.type === 'donut' ? ['42%', '72%'] : [0, '72%'], center: ['50%', '46%'], data, label: { show: v.options?.labels !== false, position: 'inside', formatter: (q: { percent: number }) => (q.percent >= 4 ? `${Math.round(q.percent)}%` : ''), color: '#fff', fontWeight: 600 }, labelLine: { show: false }, itemStyle: { borderRadius: 4, borderColor: ctx.dark ? '#1d1c1a' : '#fff', borderWidth: 2 } }] };
    }
    case 'treemap': {
      const dims = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
      const mi = r.columns.findIndex((c) => c.role === 'measure');
      const m = r.columns[mi]!;
      let data: unknown[];
      if (dims.length >= 2) {
        const groups = new Map<string, { name: string; children: unknown[]; raw: Scalar }>();
        for (const row of r.rows) { const k = fm(dims[0]![0])(row[dims[0]![1]]!); const g = groups.get(k) ?? { name: k, children: [], raw: row[dims[0]![1]]! }; g.children.push({ name: fm(dims[1]![0])(row[dims[1]![1]]!), value: num(row[mi]) }); groups.set(k, g); }
        data = [...groups.values()];
      } else data = s.categories.map((c, i) => ({ name: catLabels[i], value: s.series[0]?.values[i], raw: c }));
      return { ...base, legend: { show: false }, tooltip: { trigger: 'item', valueFormatter: valueFmt(m) }, series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, data, top: 4, bottom: 4, left: 4, right: 4, label: { show: true }, upperLabel: { show: dims.length >= 2, height: 20 } }] };
    }
    case 'scatter': {
      const ms = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
      const dims = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'dim');
      const [x, y, size] = ms;
      if (!x || !y) return { ...base, title: { text: 'A scatter needs two measures', left: 'center', top: 'middle', textStyle: { fontSize: 12 } } };
      const play = v.options?.play ? dims.find(([c]) => c.field === v.options!.play) : undefined;
      const label = dims.find(([c]) => c !== play?.[0]);
      const sizes = size ? r.rows.map((row) => num(row[size[1]]) ?? 0) : [];
      const maxSize = Math.max(1, ...sizes.map(Math.abs));
      const point = (row: Scalar[]) => ({ value: [num(row[x[1]]), num(row[y[1]]), size ? num(row[size[1]]) : null], name: label ? fm(label[0])(row[label[1]]!) : '', raw: label ? row[label[1]] : null });
      const series = (rows: Scalar[][]) => [{ type: 'scatter', data: rows.map(point), symbolSize: size ? (val: number[]) => 8 + 36 * Math.sqrt(Math.abs(val[2] ?? 0) / maxSize) : 10, itemStyle: { opacity: 0.85 }, emphasis: { focus: 'self' } }];
      const axes = { xAxis: { type: 'value', name: x[0].label, nameLocation: 'middle', nameGap: 28, scale: true, axisLabel: { formatter: axisFmt(x[0]) } }, yAxis: { type: 'value', name: y[0].label, scale: true, axisLabel: { formatter: axisFmt(y[0]) } } };
      const tooltip = { trigger: 'item', confine: true, formatter: (p: { name: string; value: number[] }) => `${p.name}<br/>${x[0].label}: ${valueFmt(x[0])(p.value[0]!)}<br/>${y[0].label}: ${valueFmt(y[0])(p.value[1]!)}${size ? `<br/>${size[0].label}: ${valueFmt(size[0])(p.value[2]!)}` : ''}` };
      if (!play) return { ...base, ...axes, tooltip, legend: { show: false }, series: series(r.rows) };
      // The play axis: one frame per value, animated.
      const frames: Scalar[] = [];
      for (const row of r.rows) if (!frames.some((f) => f === row[play[1]])) frames.push(row[play[1]]!);
      frames.sort((a, b) => String(a).localeCompare(String(b)));
      return {
        baseOption: { ...base, ...axes, tooltip, legend: { show: false }, timeline: { axisType: 'category', autoPlay: false, playInterval: 1200, data: frames.map((f) => fm(play[0])(f)), bottom: 4, left: 24, right: 24 }, grid: { ...base.grid, bottom: 64 }, series: series([]) },
        options: frames.map((f) => ({ title: { text: fm(play[0])(f), right: 16, top: 4, textStyle: { fontSize: 18, opacity: 0.35 } }, series: series(r.rows.filter((row) => row[play[1]] === f)) })),
      };
    }
    case 'gauge': {
      const ms = r.columns.map((c, i) => [c, i] as const).filter(([c]) => c.role === 'measure');
      const val = num(r.rows[0]?.[ms[0]?.[1] ?? 0]);
      const targetCol = typeof v.options?.target === 'string' ? ms.find(([c]) => c.name === v.options!.target) : undefined;
      const target = targetCol ? num(r.rows[0]?.[targetCol[1]]) : typeof v.options?.target === 'number' ? v.options.target : null;
      const max = v.options?.max ?? niceMax(Math.max(val ?? 0, target ?? 0) * 1.2);
      const f = ms[0] ? valueFmt(ms[0][0]) : (x: number) => String(x);
      return { ...base, legend: { show: false }, series: [
        { type: 'gauge', min: v.options?.min ?? 0, max, progress: { show: true, width: 14, roundCap: true }, axisLine: { lineStyle: { width: 14 } }, pointer: { show: false }, splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, anchor: { show: false },
          detail: { valueAnimation: !ctx.static, formatter: (x: number) => f(x), fontSize: 28, fontWeight: 600, offsetCenter: [0, '8%'] }, title: { offsetCenter: [0, '42%'], fontSize: 12 }, data: [{ value: val, name: ms[0]?.[0].label ?? '' }] },
        ...(target !== null ? [{ type: 'gauge', min: v.options?.min ?? 0, max, pointer: { show: true, length: '18%', width: 4, offsetCenter: [0, '-72%'], itemStyle: { color: ctx.dark ? '#ecebe6' : '#1f1e1c' } }, axisLine: { show: false }, splitLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, detail: { show: false }, title: { show: false }, data: [{ value: target, name: 'Target' }] }] : []),
      ] };
    }
    case 'waterfall': {
      const level = r.columns.findIndex((c) => c.role === 'level');
      const mi = r.columns.findIndex((c) => c.role === 'measure');
      const m = r.columns[mi]!;
      const total = level >= 0 ? num(r.rows.find((x) => x[level] !== 0)?.[mi]) : null;
      const vals = s.series[0]?.values ?? [];
      // The running position of each step (layout only); the total bar is the engine's own total.
      const starts: number[] = []; let run = 0;
      for (const x of vals) { starts.push((x ?? 0) >= 0 ? run : run + (x ?? 0)); run += x ?? 0; }
      const cats = [...catLabels, ...(total !== null ? ['Total'] : [])];
      return { ...base, legend: { show: false }, xAxis: { type: 'category', data: cats }, yAxis: { type: 'value', axisLabel: { formatter: axisFmt(m) } },
        tooltip: { trigger: 'axis', confine: true, formatter: (ps: Array<{ seriesName: string; name: string; dataIndex: number }>) => { const i = ps[0]!.dataIndex; const x = i < vals.length ? vals[i] : total; return `${ps[0]!.name}: ${formatValue(x, m.format)}`; } },
        series: [
          { type: 'bar', stack: 'w', itemStyle: { color: 'transparent' }, emphasis: { disabled: true }, data: [...starts, ...(total !== null ? [0] : [])], silent: true },
          { type: 'bar', stack: 'w', name: m.label, data: [...vals.map((x, i) => ({ value: Math.abs(x ?? 0), raw: s.categories[i], itemStyle: { color: (x ?? 0) >= 0 ? colors[2] ?? '#1baf7a' : colors[7] ?? '#e34948' } })), ...(total !== null ? [{ value: total, itemStyle: { color: colors[0] } }] : [])], label: { show: v.options?.labels === true, position: 'top', formatter: (p: { dataIndex: number }) => formatValue(p.dataIndex < vals.length ? vals[p.dataIndex] : total, m.format) } },
        ] };
    }
    case 'map': return { ...base, legend: { show: false } };
  }

  // Category charts: bar, column, line, area, combo, ribbon.
  const horizontal = v.type === 'bar' || v.options?.horizontal === true;
  const stackMode = v.options?.stack ?? (v.type === 'ribbon' ? 'stacked' : undefined);
  const percent = stackMode === 'percent';
  const totals = percent ? s.categories.map((_, i) => s.series.reduce((a, x) => a + Math.abs(x.values[i] ?? 0), 0)) : [];
  const shown = (vals: Array<number | null>) => (percent ? vals.map((x, i) => (x === null ? null : totals[i] ? x / totals[i]! : 0)) : vals);
  const lines = new Set(v.options?.lines ?? []);
  const twoAxes = v.type === 'combo' && lines.size > 0 && s.series.some((x) => !lines.has(x.measure.name));
  const kind = (name: string) => (v.type === 'combo' ? (lines.has(name) ? 'line' : 'bar') : v.type === 'line' || v.type === 'area' || v.type === 'ribbon' ? 'line' : 'bar');
  const m0 = s.series[0]?.measure;
  const fmtAxis = percent ? (x: number) => formatValue(x, 'percent:0') : m0 ? axisFmt(m0) : (x: number) => String(x);
  const forecast = (r.extra?.forecast as Scalar[][] | undefined) ?? [];
  const anomalies = (r.extra?.anomalies as Scalar[][] | undefined) ?? [];
  const fcCats = forecast.filter((f) => f[0] === null || f[0] === forecast[0]?.[0]).map((f) => f[1]!);
  const allCats = [...catLabels, ...fcCats.map((c) => fm(s.dim)(c))];
  const series: Array<Record<string, unknown>> = [];
  s.series.forEach((x, k) => {
    const t = kind(x.measure.name);
    const isLine = t === 'line';
    const dim = x.highlight && !isLine;
    const data = shown(x.values).map((val, i) => ({ value: val, raw: s.categories[i], key: x.key, itemStyle: anySel && !selected(s.categories[i]!) ? { opacity: 0.35 } : undefined }));
    series.push({
      type: t, name: x.name, data, ...(stackMode && stackMode !== 'clustered' && (!twoAxes || !lines.has(x.measure.name)) ? { stack: 'total' } : {}),
      ...(isLine ? { smooth: v.options?.smooth ?? v.type === 'ribbon', symbol: s.categories.length > 40 ? 'none' : 'circle', symbolSize: 6, ...(v.type === 'area' || v.type === 'ribbon' ? { areaStyle: { opacity: v.type === 'ribbon' ? 0.55 : 0.12 } } : {}) } : { barMaxWidth: 28 }),
      ...(twoAxes && lines.has(x.measure.name) ? { yAxisIndex: 1 } : {}),
      ...(dim ? { itemStyle: { opacity: 0.3 } } : {}),
      ...(v.options?.labels ? { label: { show: true, position: isLine ? 'top' : horizontal ? 'right' : 'top', formatter: (p: { value: number }) => (percent ? formatValue(p.value, 'percent:0') : formatValue(p.value, v.options?.formats?.[x.measure.name] ?? x.measure.format)) } } : {}),
      ...(k === 0 && anomalies.length ? { markPoint: { symbol: 'circle', symbolSize: 14, itemStyle: { color: 'transparent', borderColor: '#e34948', borderWidth: 2 }, label: { show: false }, data: anomalies.filter((a) => a[0] === null || a[0] === x.key).map((a) => ({ coord: [fm(s.dim)(a[1]!), a[2]], name: `anomaly z=${Number(a[3]).toFixed(1)}` })) } } : {}),
    });
    // Cross-highlight: the selected part drawn solid over the faded whole.
    if (dim) series.push({ type: 'bar', name: `${x.name} (selected)`, data: shown(x.highlight!).map((val, i) => ({ value: val, raw: s.categories[i], key: x.key })), barMaxWidth: 28, barGap: '-100%', z: 3, ...(stackMode && stackMode !== 'clustered' ? { stack: 'highlight' } : {}), itemStyle: { color: colors[k % colors.length] }, tooltip: { show: true } });
  });
  if (forecast.length) {
    const pad = s.categories.map(() => null);
    const last = s.series[0]?.values.at(-1) ?? null;
    const f0 = forecast.filter((f) => f[0] === null || f[0] === forecast[0]?.[0]);
    series.push({ type: 'line', name: 'Forecast', data: [...pad.slice(0, -1), last, ...f0.map((f) => f[2])], lineStyle: { type: 'dashed' }, symbol: 'none', itemStyle: { color: colors[0] } });
    series.push({ type: 'line', name: 'Low', stack: 'band', data: [...pad, ...f0.map((f) => f[3])], lineStyle: { opacity: 0 }, symbol: 'none', tooltip: { show: false } });
    series.push({ type: 'line', name: '95% interval', stack: 'band', data: [...pad, ...f0.map((f) => (num(f[4]) ?? 0) - (num(f[3]) ?? 0))], lineStyle: { opacity: 0 }, areaStyle: { opacity: 0.15, color: colors[0] }, symbol: 'none', tooltip: { show: false } });
  }
  const catAxis = { type: 'category', data: allCats, axisLabel: { hideOverlap: true, ...(horizontal && allCats.length <= 30 ? { interval: 0 } : {}) }, axisTick: { alignWithLabel: true } };
  const valAxis = (f: (x: number) => string, i = 0) => ({ type: 'value', ...(percent ? { max: 1 } : {}), axisLabel: { formatter: f }, ...(i ? { splitLine: { show: false } } : {}) });
  const second = twoAxes ? s.series.find((x) => lines.has(x.measure.name))!.measure : undefined;
  return {
    ...base,
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: v.type === 'line' || v.type === 'area' ? 'line' : 'shadow' }, valueFormatter: (x: number) => (percent ? formatValue(x, 'percent:1') : m0 ? formatValue(x, m0.format) : String(x)) },
    xAxis: horizontal ? valAxis(fmtAxis) : catAxis,
    yAxis: horizontal ? { ...catAxis, inverse: true } : twoAxes ? [valAxis(fmtAxis), valAxis(axisFmt(second!), 1)] : valAxis(fmtAxis),
    ...(s.categories.length > 30 && !horizontal ? { dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: s.series.length > 1 ? 28 : 4 }], grid: { ...base.grid, bottom: (s.series.length > 1 ? 36 : 12) + 24 } } : {}),
    series,
  };
}

/** A short number for an axis tick, in the measure's own kind (currency, percent, plain). */
export function compact(x: number, format?: string): string {
  const [kind, a] = (format ?? '').split(':');
  if (kind === 'percent') return formatValue(x, 'percent:0');
  if (Math.abs(x) < 1000) return formatValue(x, format);
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, ...(kind === 'currency' ? { style: 'currency', currency: (a || 'USD').toUpperCase() } : {}) }).format(x);
}

function niceMax(x: number): number {
  if (!(x > 0)) return 100;
  const p = 10 ** Math.floor(Math.log10(x));
  return Math.ceil(x / p) * p;
}

/** The filters a click on a data point means: its category (and series), as the selection. */
export function clickFilters(r: QueryResult, p: { data?: { raw?: Scalar; key?: Scalar }; name?: string }): FilterSpec[] | undefined {
  const s = shape(r);
  const raw = p.data?.raw !== undefined ? p.data.raw : undefined;
  if (s.paths && raw !== undefined) {
    const vals = s.paths[String(raw)];
    if (!vals) return undefined;
    const out: FilterSpec[] = s.pathFields!.map((field, i) => (vals[i] === null ? { field, op: 'is_null' as const } : { field, op: 'eq' as const, value: vals[i] }));
    if (s.seriesDim?.field && p.data?.key !== undefined) out.push({ field: s.seriesDim.field, op: p.data.key === null ? 'is_null' : 'eq', ...(p.data.key === null ? {} : { value: p.data.key }) });
    return out;
  }
  if (!s.dim?.field) return undefined;
  if (raw === undefined) return undefined;
  const out: FilterSpec[] = [{ field: s.dim.field, op: raw === null ? 'is_null' : 'eq', ...(raw === null ? {} : { value: raw }) }];
  if (s.seriesDim?.field && p.data?.key !== undefined) out.push({ field: s.seriesDim.field, op: p.data.key === null ? 'is_null' : 'eq', ...(p.data.key === null ? {} : { value: p.data.key }) });
  return out;
}
