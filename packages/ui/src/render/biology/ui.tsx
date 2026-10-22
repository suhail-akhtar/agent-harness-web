/**
 * Small pieces the biology views share: the theme as state (so drawings follow a theme switch),
 * the "too large" notice, a stat chip, toggle buttons, and a zoom/pan range for linear views
 * (buttons, Ctrl+wheel, drag).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '../../components/primitives.tsx';

const isDark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

/** The current theme, re-rendering when it changes. */
export function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** Parses once per source; a parse error is thrown while drawing (the block frame shows it) unless the block is still arriving. */
export function useParsed<T>(parse: () => T, deps: unknown[]): { value?: T; error?: string } {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => { try { return { value: parse() }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }, deps);
}

export function Arriving({ what }: { what: string }): React.ReactElement {
  return <p className="p-2 text-[11.5px] text-hx-muted">{what} arriving…</p>;
}

export function Notes({ notes }: { notes: string[] }): React.ReactElement | null {
  if (!notes.length) return null;
  return <div data-bio-truncated className="mb-1.5 rounded-md bg-hx-warning/10 px-2 py-1 text-[11.5px] text-hx-warning">{notes.join(' ')}</div>;
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return <span className="inline-flex items-baseline gap-1 rounded-md bg-hx-code px-1.5 py-0.5 text-[11.5px]"><span className="text-hx-muted">{label}</span><span className="font-medium tabular-nums text-hx-primary">{value}</span></span>;
}

export function Toggle({ on, onChange, children, label }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; label?: string }): React.ReactElement {
  return (
    <button type="button" aria-pressed={on} aria-label={label} onClick={() => onChange(!on)}
      className={`rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors ${on ? 'border-hx-accent bg-hx-accent-soft text-hx-accent-text' : 'border-hx-border text-hx-secondary hover:bg-hx-hover'}`}>
      {children}
    </button>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }): React.ReactElement {
  return (
    <span role="group" aria-label={label} className="inline-flex rounded-md bg-hx-pill p-0.5">
      {options.map(([v, l]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}
          className={`rounded px-1.5 py-0.5 text-[11.5px] ${v === value ? 'bg-hx-elevated font-medium text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary'}`}>{l}</button>
      ))}
    </span>
  );
}

/**
 * A visible range [start, end] over a full one, with zoom (about a centre) and pan, never leaving
 * the full range and never narrower than `minSpan`.
 */
export function useRange(full: [number, number], minSpan = 10) {
  const [view, setView] = useState<[number, number]>(full);
  useEffect(() => { setView(full); }, [full[0], full[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const clamp = useCallback((s: number, e: number): [number, number] => {
    const total = full[1] - full[0];
    const span = Math.max(Math.min(minSpan, total), Math.min(total, e - s));
    const start = Math.max(full[0], Math.min(full[1] - span, s));
    return [start, start + span];
  }, [full[0], full[1], minSpan]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoom = useCallback((k: number, centre?: number) => setView(([s, e]) => { const c = centre ?? (s + e) / 2; return clamp(c - (c - s) * k, c + (e - c) * k); }), [clamp]);
  const pan = useCallback((d: number) => setView(([s, e]) => clamp(s + d, e + d)), [clamp]);
  const set = useCallback((s: number, e: number) => setView(clamp(s, e)), [clamp]);
  return { view, zoom, pan, set, reset: () => setView(full), zoomed: view[0] !== full[0] || view[1] !== full[1] };
}

/** Drag to pan and Ctrl+wheel to zoom on an SVG drawn in viewBox units (`plotLeft`..`plotRight` map to the range). */
export function useRangeGestures(r: ReturnType<typeof useRange>, box: { width: number; plotLeft: number; plotRight: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; view: [number, number] } | null>(null);
  const toUnits = (clientDx: number) => { const el = ref.current; if (!el) return 0; const w = el.getBoundingClientRect().width || box.width; return (clientDx * box.width) / w; };
  const bpPerUnit = (v: [number, number]) => (v[1] - v[0]) / (box.plotRight - box.plotLeft);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect(); const ux = ((e.clientX - rect.left) * box.width) / (rect.width || box.width);
      const [s] = r.view; const centre = s + (ux - box.plotLeft) * bpPerUnit(r.view);
      r.zoom(e.deltaY < 0 ? 0.8 : 1.25, centre);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => { if (e.button !== 0) return; drag.current = { x: e.clientX, view: r.view }; },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current; if (!d) return;
      const dx = toUnits(e.clientX - d.x);
      if (Math.abs(dx) < 2) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      r.set(d.view[0] - dx * bpPerUnit(d.view), d.view[1] - dx * bpPerUnit(d.view));
    },
    onPointerUp: () => { drag.current = null; },
    onPointerLeave: () => { drag.current = null; },
  };
  return { ref, handlers };
}

export function ZoomButtons({ r, children }: { r: ReturnType<typeof useRange>; children?: React.ReactNode }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-0.5">
      {children}
      <IconButton size="xs" icon="zoom-out" label="Zoom out" onClick={() => r.zoom(1.5)} />
      <IconButton size="xs" icon="zoom-in" label="Zoom in" onClick={() => r.zoom(0.66)} />
      <IconButton size="xs" icon="fit" label="Show all" onClick={r.reset} />
    </span>
  );
}

/** Mixes two hex colours (t from 0 to 1). */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i]! - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('')}`;
}
