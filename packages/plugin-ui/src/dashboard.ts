/**
 * The dashboard spec: KPI cards, charts and tables in a responsive grid, from one JSON object. Shared
 * so that a model (a ```dashboard block), a plugin (a dashboard view or home card) and the renderer
 * agree on one shape. Every panel holds the spec its own block would (chart = ECharts option,
 * viz = Vega-Lite, table = {columns, rows}, markdown = text, plot = function plot, map = GeoJSON).
 */

export const DASHBOARD_PANEL_KINDS = ['chart', 'viz', 'table', 'markdown', 'plot', 'map'] as const;
export type DashboardPanelKind = typeof DASHBOARD_PANEL_KINDS[number];

export interface DashboardKpi {
  label: string;
  value: string | number;
  unit?: string;
  /** Change against the previous period, already formatted ("+17.8%"). */
  delta?: string;
  direction?: 'up' | 'down' | 'flat';
  /** Which direction is good (colours follow it): up (default) or down. */
  good?: 'up' | 'down';
  /** History behind the number, drawn as a sparkline. */
  series?: number[];
}

export interface DashboardPanel { title?: string; kind: DashboardPanelKind; spec: unknown; span?: 1 | 2 | 3; note?: string }

export interface DashboardSpec { title?: string; subtitle?: string; columns?: 1 | 2 | 3; kpis?: DashboardKpi[]; panels: DashboardPanel[] }

/** Reads a dashboard and names the exact mistake when there is one (a model repairs from the message). */
export function validateDashboard(raw: unknown): { spec?: DashboardSpec; error?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'a dashboard spec must be a JSON object with "panels"' };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.panels) || !o.panels.length) return { error: 'no "panels" in the dashboard: there is nothing to lay out' };
  if (o.panels.length > 24) return { error: 'at most 24 panels' };
  const panels: DashboardPanel[] = [];
  for (let i = 0; i < o.panels.length; i++) {
    const p = o.panels[i] as Record<string, unknown> | null;
    const where = `panel ${i + 1}${p && typeof p.title === 'string' ? ` ("${p.title}")` : ''}`;
    if (!p || typeof p !== 'object') return { error: `${where} is not an object` };
    if (!(DASHBOARD_PANEL_KINDS as readonly string[]).includes(String(p.kind))) return { error: `${where} has kind "${String(p.kind)}": use one of ${DASHBOARD_PANEL_KINDS.join(', ')}` };
    if (p.spec === undefined || p.spec === null) return { error: `${where} has no "spec"` };
    panels.push({ kind: p.kind as DashboardPanelKind, spec: p.spec, ...(typeof p.title === 'string' ? { title: p.title.slice(0, 120) } : {}), ...(p.span === 2 || p.span === 3 ? { span: p.span } : {}), ...(typeof p.note === 'string' ? { note: p.note.slice(0, 300) } : {}) });
  }
  const kpis: DashboardKpi[] = [];
  if (o.kpis !== undefined) {
    if (!Array.isArray(o.kpis)) return { error: '"kpis" must be a list of {label, value}' };
    for (const [i, k] of (o.kpis as Array<Record<string, unknown>>).slice(0, 12).entries()) {
      if (!k || typeof k.label !== 'string' || (typeof k.value !== 'string' && typeof k.value !== 'number')) return { error: `KPI ${i + 1} needs "label" and "value"` };
      kpis.push({
        label: k.label.slice(0, 60), value: typeof k.value === 'string' ? k.value.slice(0, 40) : k.value,
        ...(typeof k.unit === 'string' ? { unit: k.unit.slice(0, 12) } : {}), ...(typeof k.delta === 'string' ? { delta: k.delta.slice(0, 20) } : {}),
        ...(k.direction === 'up' || k.direction === 'down' || k.direction === 'flat' ? { direction: k.direction } : {}),
        ...(k.good === 'down' ? { good: 'down' as const } : {}),
        ...(Array.isArray(k.series) ? { series: (k.series as unknown[]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(0, 200) } : {}),
      });
    }
  }
  return { spec: { ...(typeof o.title === 'string' ? { title: o.title.slice(0, 120) } : {}), ...(typeof o.subtitle === 'string' ? { subtitle: o.subtitle.slice(0, 200) } : {}), ...(o.columns === 1 || o.columns === 2 || o.columns === 3 ? { columns: o.columns } : {}), ...(kpis.length ? { kpis } : {}), panels } };
}
