/**
 * A surface you can zoom (buttons, Ctrl+wheel) and drag when zoomed. Plain wheel scrolls the page,
 * as everywhere else. (Adapted from AICO's shared/ui/ZoomPan.)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from '../components/primitives.tsx';
import { useWidgetExpanded } from './Widget.tsx';

const MIN = 0.4;
const MAX = 6;
const STEP = 1.25;

export function ZoomPan({ children, actions, className = '' }: { children: React.ReactNode; actions?: React.ReactNode; className?: string }): React.ReactElement {
  const expanded = useWidgetExpanded();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const zoomTo = useCallback((next: number) => { const c = Math.min(MAX, Math.max(MIN, next)); setScale(c); if (c === 1) setOffset({ x: 0, y: 0 }); }, []);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); setScale((s) => Math.min(MAX, Math.max(MIN, s * (e.deltaY < 0 ? STEP : 1 / STEP)))); };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div className={`relative ${expanded ? 'flex h-full min-h-0 flex-1 flex-col' : ''}`}>
      <div
        ref={viewport}
        onPointerDown={(e) => { if (scale === 1) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }; }}
        onPointerMove={(e) => { const d = drag.current; if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }); }}
        onPointerUp={(e) => { if (drag.current) e.currentTarget.releasePointerCapture(e.pointerId); drag.current = null; }}
        className={`flex items-center justify-center overflow-hidden ${scale !== 1 ? 'cursor-grab active:cursor-grabbing' : ''} ${expanded ? 'h-full min-h-0 flex-1' : className}`}
      >
        <div className="w-full" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center center', transition: drag.current ? 'none' : 'transform 120ms ease-out' }}>
          {children}
        </div>
      </div>
      <div className="absolute right-1 top-1 flex items-center gap-0.5 rounded-lg border border-hx-border-subtle bg-hx-bg/90 p-0.5 backdrop-blur">
        {actions}
        <IconButton size="xs" icon="zoom-out" label="Zoom out" onClick={() => zoomTo(scale / STEP)} />
        <span className="min-w-[2.4rem] text-center text-[10px] tabular-nums text-hx-muted">{Math.round(scale * 100)}%</span>
        <IconButton size="xs" icon="zoom-in" label="Zoom in" onClick={() => zoomTo(scale * STEP)} />
        <IconButton size="xs" icon="fit" label="Reset zoom" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} />
      </div>
    </div>
  );
}
