/**
 * Charts from fenced specs: ```chart (an ECharts option object, drawn as SVG) and ```vega-lite
 * (a Vega-Lite spec; the library computes bins, aggregates and regressions from raw rows). Both
 * libraries load on first use. Vega runs with its expression interpreter, so no eval is needed and
 * the app's CSP stays strict; data must be inline (parseVizSpec refuses URLs).
 * (Adapted from AICO's shared/ui/Chart and Viz.)
 */

import React, { useEffect, useRef, useState } from 'react';
import { parseChartSpec, parseVizSpec } from './data.ts';
import { chartDefaults, chartTheme } from './chart-theme.ts';
import { vegaTheme } from './vega-theme.ts';

let echartsPromise: Promise<typeof import('echarts')> | null = null;
const loadECharts = () => (echartsPromise ??= import('echarts'));

const dark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

export function Chart({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (streaming) return;
    const parsed = parseChartSpec(source);
    if (parsed.error) { setError(parsed.error); return; }
    setError(undefined);
    let disposed = false;
    let inst: import('echarts').ECharts | undefined;
    void loadECharts().then((echarts) => {
      if (disposed || !host.current) return;
      const name = dark() ? 'hx-dark' : 'hx-light';
      echarts.registerTheme(name, chartTheme(dark()));
      inst = echarts.init(host.current, name, { renderer: 'svg' });
      inst.setOption({ ...chartDefaults(parsed.option!), ...parsed.option });
    }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    const ro = new ResizeObserver(() => inst?.resize());
    if (host.current) ro.observe(host.current);
    return () => { disposed = true; ro.disconnect(); inst?.dispose(); };
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Chart arriving…</p>;
  if (error) throw new Error(error);
  return <div ref={host} data-chart="echarts" className="h-[320px] w-full" />;
}

let embedPromise: Promise<[typeof import('vega-embed'), typeof import('vega-interpreter')]> | null = null;
const loadVega = () => (embedPromise ??= Promise.all([import('vega-embed'), import('vega-interpreter')]));

export function Viz({ source, streaming }: { source: string; streaming?: boolean }): React.ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (streaming) return;
    const parsed = parseVizSpec(source);
    if (parsed.error) { setError(parsed.error); return; }
    setError(undefined);
    let disposed = false;
    let view: { finalize: () => void } | undefined;
    void loadVega().then(async ([{ default: embed }, { expressionInterpreter }]) => {
      if (disposed || !host.current) return;
      // A single (or layered) view fits the column, axes and titles included; a faceted or
      // concatenated figure keeps the sizes it asked for (fit does not apply to those) and scrolls.
      const spec = parsed.spec as Record<string, unknown> & { encoding?: Record<string, unknown> };
      const composite = ['facet', 'hconcat', 'vconcat', 'concat', 'repeat'].some((k) => k in spec) || ['row', 'column', 'facet'].some((k) => !!spec.encoding?.[k]);
      const result = await embed(host.current, (composite ? spec : { autosize: { type: 'fit-x', contains: 'padding' }, ...spec }) as never, {
        actions: false,
        ast: true,
        expr: expressionInterpreter,
        config: { ...vegaTheme(dark()), ...((parsed.spec!.config as object) ?? {}) },
        renderer: 'svg',
        ...(composite ? {} : { width: Math.max(200, host.current.clientWidth - 16) }),
        logLevel: 0,
        // No loading from anywhere: data is inline.
        loader: { load: () => Promise.reject(new Error('this figure may not load data from elsewhere')), sanitize: () => Promise.reject(new Error('no external data')), http: () => Promise.reject(new Error('no external data')), file: () => Promise.reject(new Error('no external data')) } as never,
      });
      if (disposed) { result.view.finalize(); return; }
      view = result.view;
    }).catch((e: unknown) => { if (!disposed) setError(e instanceof Error ? e.message : String(e)); });
    return () => { disposed = true; view?.finalize(); };
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Figure arriving…</p>;
  if (error) throw new Error(error);
  return <div ref={host} data-chart="vega" className="w-full overflow-x-auto" />;
}
