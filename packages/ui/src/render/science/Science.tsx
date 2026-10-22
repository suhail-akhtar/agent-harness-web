/**
 * Science and BI blocks: function plots, Graphviz graphs, SMILES structures, 3D molecules, GeoJSON
 * maps, Jupyter notebooks and dashboards. The heavy libraries load on first use only (Graphviz's
 * wasm, smiles-drawer; 3Dmol runs inside a sandboxed frame). Every output that is markup is either
 * scrubbed (SVG) or framed without same-origin.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { validateDashboard, type DashboardKpi, type DashboardSpec } from '@harness/plugin-ui';
import { IconButton } from '../../components/primitives.tsx';
import { autoY, parsePlotSpec, sample, ticks } from './fplot.ts';
import { layoutMap, parseGeoJson } from './geo.ts';
import { parseNotebook, type NbOutput } from './notebook.ts';
import { checkDot, cleanGraphSvg } from './graphviz.ts';
import { ZoomPan } from '../ZoomPan.tsx';
import { CodeBlock } from '../CodeBlock.tsx';
import { moleculeDocument } from '../artifact-doc.ts';
import { SandboxFrame, artifactHost } from '../Artifact.tsx';
import { Chart, Viz } from '../Charts.tsx';
import { TableBody, JsonView } from '../Data.tsx';
import { parseTableSpec } from '../data.ts';
import { RenderBoundary } from '../Widget.tsx';

const dark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#c98500', '#d55181', '#4a3aa7', '#e34948', '#008300'];
const fmtTick = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(Math.round(v * 1000) / 1000));

/** ```plot / ```function-plot: zoom (buttons, Ctrl+wheel) and pan (drag), recomputed at every view. */
export function FunctionPlot({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo(() => parsePlotSpec(source), [source]);
  const [view, setView] = useState<{ x: [number, number]; y?: [number, number] } | null>(null);
  const drag = useRef<{ px: number; py: number; x: [number, number]; y: [number, number] } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  if (parsed.error) { if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Plot arriving…</p>; throw new Error(parsed.error); }
  const spec = parsed.spec!;
  const W = 640; const H = 340; const P = { l: 44, r: 12, t: spec.title ? 26 : 10, b: 26 };
  const xd = view?.x ?? spec.domain;
  const segs = parsed.exprs!.map((e) => sample(e, xd, spec.samples));
  const yd = view?.y ?? spec.yDomain ?? autoY(segs.flat(), spec.points);
  const sx = (x: number) => P.l + ((x - xd[0]) / (xd[1] - xd[0])) * (W - P.l - P.r);
  const sy = (y: number) => H - P.b - ((y - yd[0]) / (yd[1] - yd[0])) * (H - P.t - P.b);
  const zoom = (k: number) => {
    const cx = (xd[0] + xd[1]) / 2; const cy = (yd[0] + yd[1]) / 2;
    setView({ x: [cx - ((xd[1] - xd[0]) / 2) * k, cx + ((xd[1] - xd[0]) / 2) * k], y: [cy - ((yd[1] - yd[0]) / 2) * k, cy + ((yd[1] - yd[0]) / 2) * k] });
  };
  const clipY = (y: number) => Math.max(P.t - 50, Math.min(H - P.b + 50, sy(y)));
  return (
    <div className="relative" data-fplot>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full touch-none select-none" style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
        onWheel={(e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); zoom(e.deltaY < 0 ? 0.8 : 1.25); }}
        onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, x: xd, y: yd }; }}
        onPointerMove={(e) => {
          const d = drag.current; const el = svg.current; if (!d || !el) return;
          const r = el.getBoundingClientRect(); const kx = ((d.x[1] - d.x[0]) / (r.width * (W - P.l - P.r) / W)); const ky = ((d.y[1] - d.y[0]) / (r.height * (H - P.t - P.b) / H));
          const dx = (e.clientX - d.px) * kx; const dy = (e.clientY - d.py) * ky;
          setView({ x: [d.x[0] - dx, d.x[1] - dx], y: [d.y[0] + dy, d.y[1] + dy] });
        }}
        onPointerUp={() => { drag.current = null; }}>
        {spec.title && <text x={P.l} y={16} fontSize={13} fontWeight={600} fill="var(--hx-text-primary)">{spec.title}</text>}
        <rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} fill="none" stroke="var(--hx-border)" />
        {ticks(xd[0], xd[1]).map((t) => <g key={`x${t}`}><line x1={sx(t)} x2={sx(t)} y1={P.t} y2={H - P.b} stroke="var(--hx-border-subtle)" /><text x={sx(t)} y={H - P.b + 16} fontSize={10.5} textAnchor="middle" fill="var(--hx-text-muted)">{fmtTick(t)}</text></g>)}
        {ticks(yd[0], yd[1], 6).map((t) => <g key={`y${t}`}><line x1={P.l} x2={W - P.r} y1={sy(t)} y2={sy(t)} stroke="var(--hx-border-subtle)" /><text x={P.l - 6} y={sy(t) + 3.5} fontSize={10.5} textAnchor="end" fill="var(--hx-text-muted)">{fmtTick(t)}</text></g>)}
        {yd[0] < 0 && yd[1] > 0 && <line x1={P.l} x2={W - P.r} y1={sy(0)} y2={sy(0)} stroke="var(--hx-text-muted)" strokeWidth={0.8} />}
        {xd[0] < 0 && xd[1] > 0 && <line x1={sx(0)} x2={sx(0)} y1={P.t} y2={H - P.b} stroke="var(--hx-text-muted)" strokeWidth={0.8} />}
        <clipPath id="fplot-clip"><rect x={P.l} y={P.t} width={W - P.l - P.r} height={H - P.t - P.b} /></clipPath>
        <g clipPath="url(#fplot-clip)">
          {segs.map((list, i) => list.map((seg, j) => <polyline key={`${i}-${j}`} data-fn={i} fill="none" strokeWidth={2} stroke={spec.fns[i]!.color ?? SERIES[i % SERIES.length]} points={seg.map(([x, y]) => `${sx(x).toFixed(1)},${clipY(y).toFixed(1)}`).join(' ')} />))}
          {spec.points?.map(([x, y], i) => <circle key={i} cx={sx(x)} cy={sy(y)} r={3} fill="var(--hx-accent)" />)}
        </g>
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px] text-hx-secondary">
        {spec.fns.map((f, i) => <span key={i} className="inline-flex items-center gap-1"><span className="h-0.5 w-4" style={{ background: f.color ?? SERIES[i % SERIES.length] }} />{f.label}</span>)}
        <span className="flex-1" />
        <IconButton size="xs" icon="zoom-in" label="Zoom in" onClick={() => zoom(0.8)} />
        <IconButton size="xs" icon="zoom-out" label="Zoom out" onClick={() => zoom(1.25)} />
        <IconButton size="xs" icon="fit" label="Reset" onClick={() => setView(null)} />
      </div>
    </div>
  );
}

/** ```dot / ```graphviz, laid out by Graphviz's wasm build (loaded on first use), scrubbed, zoomable. */
type Gv = { dot(src: string, format?: string): string };
let gvPromise: Promise<Gv> | null = null;
const loadGraphviz = () => (gvPromise ??= import('@hpcc-js/wasm-graphviz').then((m) => m.Graphviz.load() as Promise<Gv>));
export function GraphvizView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (streaming) return;
    let alive = true;
    const refused = checkDot(source);
    if (refused) { setError(refused); return; }
    void loadGraphviz().then((gv) => {
      const out = cleanGraphSvg(gv.dot(source, 'svg'));
      if (alive) { setSvg(out); setError(''); }
    }).catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Graph arriving…</p>;
  if (error) throw new Error(error.split('\n')[0]);
  if (!svg) return <p className="p-4 text-[12px] text-hx-muted">Laying out…</p>;
  return <ZoomPan className="h-[22rem]"><div data-graphviz="svg" className="h-full w-full [&>svg]:h-full [&>svg]:w-full [&>svg]:max-h-[21rem]" dangerouslySetInnerHTML={{ __html: svg }} /></ZoomPan>;
}

/** ```smiles: a 2D structure drawn by smiles-drawer (loaded on first use). One SMILES per line. */
type SmilesNS = { parse(s: string, ok: (tree: unknown) => void, fail: (e: unknown) => void): void; SvgDrawer: new (o: Record<string, unknown>) => { draw(tree: unknown, target: SVGSVGElement, theme: string): void } };
let smilesPromise: Promise<SmilesNS> | null = null;
const loadSmiles = () => (smilesPromise ??= import('smiles-drawer').then((m) => ((m as { default?: SmilesNS }).default ?? m) as SmilesNS));
export const SMILES = /^[A-Za-z0-9@+\-[\]()=#$%\\/.:*~]{1,400}$/;
export function SmilesView({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const lines = useMemo(() => source.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12), [source]);
  const bad = lines.find((l) => !SMILES.test(l.split(/\s+/)[0]!));
  if (bad && !streaming) throw new Error(`not a SMILES string: "${bad.slice(0, 60)}"`);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Structure arriving…</p>;
  return <div className="grid gap-2 sm:grid-cols-2" data-smiles>{lines.map((l, i) => <Molecule2D key={i} line={l} />)}</div>;
}
function Molecule2D({ line }: { line: string }) {
  const [smiles, ...name] = line.split(/\s+/);
  const ref = useRef<SVGSVGElement>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadSmiles().then((sd) => {
      sd.parse(smiles!, (tree) => {
        if (!alive || !ref.current) return;
        try { new sd.SvgDrawer({ width: 280, height: 200, bondThickness: 1.2, compactDrawing: false }).draw(tree, ref.current, dark() ? 'dark' : 'light'); setDone(true); }
        catch (e) { setError((e as Error).message); }
      }, (e) => { if (alive) setError(String((e as Error)?.message ?? e)); });
    });
    return () => { alive = false; };
  }, [smiles]);
  if (error) throw new Error(`the SMILES "${smiles}" did not parse: ${error}`);
  return (
    <figure className="rounded-lg border border-hx-border-subtle p-2" data-smiles-drawn={done ? '1' : '0'}>
      <svg ref={ref} width="100%" height="200" viewBox="0 0 280 200" role="img" aria-label={`Structure of ${name.join(' ') || smiles}`} />
      <figcaption className="truncate text-center font-mono text-[11px] text-hx-muted">{name.length ? `${name.join(' ')} · ` : ''}{smiles}</figcaption>
    </figure>
  );
}

/** ```pdb / ```sdf / ```mol ...: a 3D viewer (3Dmol.js) in a sandboxed frame. */
export function Molecule3D({ source, format, streaming }: { source: string; format: string; streaming?: boolean }): React.ReactElement {
  const doc = useMemo(() => moleculeDocument(source, format, artifactHost().runtimeUrl), [source, format]);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Structure arriving…</p>;
  if (!/^\s*\S/.test(source) || source.length > 3_000_000) throw new Error('the structure is empty or too large');
  return <SandboxFrame doc={doc} scripted label="3D structure" marker="molecule" initialHeight={340} fixedHeight />;
}

/** ```geojson: an SVG map from the data alone (no tiles, no network). */
export function GeoMap({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const parsed = useMemo(() => parseGeoJson(source), [source]);
  if (parsed.error) { if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Map arriving…</p>; throw new Error(parsed.error); }
  const m = layoutMap(parsed.features!, 640, 380);
  return (
    <ZoomPan className="h-[24rem]">
      <svg viewBox={`0 0 ${m.width} ${m.height}`} className="h-[23rem] w-full" data-geomap={m.features}>
        <rect width={m.width} height={m.height} fill="var(--hx-code-bg)" />
        {m.shapes.map((s, i) => <path key={i} d={s.d} fill={s.kind === 'area' ? s.fill ?? 'var(--hx-accent-soft)' : 'none'} stroke={s.stroke ?? 'var(--hx-accent)'} strokeWidth={s.kind === 'line' ? 2 : 1} fillRule="evenodd"><title>{s.title || s.label}</title></path>)}
        {m.points.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r={4.5} fill={p.color ?? 'var(--hx-danger)'} stroke="#fff" strokeWidth={1.5}><title>{p.title || p.label}</title></circle>{p.label && <text x={p.x > m.width * 0.7 ? p.x - 7 : p.x + 7} y={p.y + 4} textAnchor={p.x > m.width * 0.7 ? "end" : "start"} fontSize={11} fill="var(--hx-text-primary)">{p.label}</text>}</g>)}
      </svg>
    </ZoomPan>
  );
}

/** ```ipynb: a notebook's cells and outputs. Markdown and code render as usual; HTML outputs go into a script-less frame. */
export function NotebookView({ source, streaming, renderMarkdown }: { source: string; streaming?: boolean; renderMarkdown: (text: string) => React.ReactNode }): React.ReactElement {
  const parsed = useMemo(() => parseNotebook(source), [source]);
  if (parsed.error) { if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Notebook arriving…</p>; throw new Error(parsed.error); }
  const nb = parsed.nb!;
  const out = (o: NbOutput, k: number) => {
    switch (o.kind) {
      case 'text': return <pre key={k} className={`overflow-x-auto whitespace-pre-wrap px-3 py-1.5 font-mono text-[12px] ${o.stream === 'stderr' ? 'bg-hx-danger/8 text-hx-danger' : 'text-hx-primary'}`}>{o.text}</pre>;
      case 'image': return <img key={k} src={`data:${o.mime};base64,${o.data}`} alt="Cell output" className="my-1 max-w-full rounded" />;
      case 'html': return <SandboxFrame key={k} doc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font:13px system-ui;margin:6px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:3px 8px}</style>${o.html}`} scripted={false} label="Cell output" marker="notebook-html" initialHeight={150} />;
      case 'markdown': return <div key={k} className="px-3">{renderMarkdown(o.text)}</div>;
      case 'json': return <div key={k} className="px-2"><JsonView source={o.json} /></div>;
      case 'error': return <pre key={k} className="overflow-x-auto whitespace-pre-wrap bg-hx-danger/8 px-3 py-1.5 font-mono text-[12px] text-hx-danger">{o.name}: {o.value}{o.traceback ? `\n${o.traceback}` : ''}</pre>;
    }
  };
  return (
    <div data-notebook={nb.cells.length} className="space-y-2">
      {nb.cells.map((c, i) => (
        <div key={i} data-cell={c.kind} className="flex gap-2">
          <div className="w-10 shrink-0 pt-2 text-right font-mono text-[11px] text-hx-muted">{c.kind === 'code' ? `[${c.count ?? ' '}]` : ''}</div>
          <div className="min-w-0 flex-1">
            {c.kind === 'markdown' ? renderMarkdown(c.source) : c.kind === 'code' ? <div className="[&_figure]:my-0"><CodeBlock code={c.source} language={nb.language} collapseAt={40} /></div> : <pre className="font-mono text-[12px] text-hx-muted">{c.source}</pre>}
            {c.outputs.length > 0 && <div className="mt-1 rounded-lg border border-hx-border-subtle bg-hx-bg">{c.outputs.map(out)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const lo = Math.min(...values); const hi = Math.max(...values); const span = hi - lo || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`).join(' ');
  return <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-1 h-7 w-full"><polyline points={pts} fill="none" stroke="var(--hx-accent)" strokeWidth={1.8} vectorEffect="non-scaling-stroke" /></svg>;
}
function Kpi({ k }: { k: DashboardKpi }) {
  const good = k.direction === 'flat' || !k.direction ? undefined : (k.direction === (k.good ?? 'up'));
  return (
    <div data-kpi className="rounded-xl border border-hx-border-subtle bg-hx-bg p-3">
      <div className="truncate text-[11.5px] font-medium text-hx-muted">{k.label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5"><span className="text-[22px] font-semibold tabular-nums text-hx-primary">{typeof k.value === 'number' ? k.value.toLocaleString() : k.value}</span>{k.unit && <span className="text-[12px] text-hx-muted">{k.unit}</span>}</div>
      {k.delta && <div className={`text-[12px] font-medium ${good === undefined ? 'text-hx-muted' : good ? 'text-hx-success' : 'text-hx-danger'}`}>{k.direction === 'up' ? '▲' : k.direction === 'down' ? '▼' : '•'} {k.delta}</div>}
      {k.series && <Spark values={k.series} />}
    </div>
  );
}

/** ```dashboard: KPI cards, charts and tables in a responsive grid (the DashboardSpec of @harness/plugin-ui). */
export function Dashboard({ source, streaming, renderMarkdown }: { source: string; streaming?: boolean; renderMarkdown: (text: string) => React.ReactNode }): React.ReactElement {
  const parsed = useMemo((): { spec?: DashboardSpec; error?: string } => { try { return validateDashboard(JSON.parse(source)); } catch (e) { return { error: `not valid JSON: ${(e as Error).message}` }; } }, [source]);
  if (parsed.error) { if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Dashboard arriving…</p>; throw new Error(parsed.error); }
  const d = parsed.spec!;
  const cols = d.columns ?? 2;
  const span = (s?: number) => (s === 3 || (s === 2 && cols === 2) ? 'md:col-span-full' : s === 2 ? 'md:col-span-2' : '');
  return (
    <div data-dashboard={d.panels.length} className="space-y-3">
      {(d.title || d.subtitle) && <div>{d.title && <div className="text-[16px] font-semibold">{d.title}</div>}{d.subtitle && <div className="text-[12.5px] text-hx-muted">{d.subtitle}</div>}</div>}
      {d.kpis && <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">{d.kpis.map((k, i) => <Kpi key={i} k={k} />)}</div>}
      <div className={`grid gap-3 ${cols === 1 ? '' : cols === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
        {d.panels.map((p, i) => {
          const src = typeof p.spec === 'string' ? p.spec : JSON.stringify(p.spec);
          const body = p.kind === 'chart' ? <Chart source={src} /> : p.kind === 'viz' ? <Viz source={src} /> : p.kind === 'plot' ? <FunctionPlot source={src} /> : p.kind === 'map' ? <GeoMap source={src} />
            : p.kind === 'markdown' ? <>{renderMarkdown(String(p.spec))}</> : (() => { const t = parseTableSpec(src); if (t.error) throw new Error(t.error); return <TableBody spec={t.spec!} maxHeight={260} />; })();
          return (
            <section key={i} data-panel={p.kind} className={`min-w-0 rounded-xl border border-hx-border-subtle bg-hx-bg p-3 ${span(p.span)}`}>
              {p.title && <div className="mb-1 text-[12.5px] font-medium text-hx-secondary">{p.title}</div>}
              <RenderBoundary fallback={(e) => <p className="text-[12px] text-hx-danger" data-render-error>This panel did not render: {e}</p>}>{body}</RenderBoundary>
              {p.note && <div className="mt-1 text-[11.5px] text-hx-muted">{p.note}</div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
