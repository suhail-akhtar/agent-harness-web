/**
 * A diagram in the transcript: light on purpose (a static drawing, no handlers, laid out once in
 * the worker and cached), with "Open interactive" for the canvas. A spec that does not validate
 * shows the reason (a model repairs from it) and its JSON, never a half-drawn picture.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { summarizeDiagram, summaryLine, validateDiagram, type DiagramSpec } from '@harness/plugin-ui';
import { Icon } from '../../icons.tsx';
import { Button, cx } from '../../components/primitives.tsx';
import { CodeBlock } from '../CodeBlock.tsx';
import { DiagramCanvas, type DiagramCanvasProps } from './Canvas.tsx';
import { Drawing } from './Drawing.tsx';
import { useDiagramLayout } from './useLayout.ts';

const VIEW_NAME: Record<string, string> = { context: 'System context', container: 'Containers', component: 'Components', deployment: 'Deployment', data: 'Data model', code: 'Code dependencies', flow: 'Flow' };
export const viewName = (v: string) => VIEW_NAME[v] ?? 'Diagram';

/** Reads a spec once per source text. */
export function useDiagramSpec(source: string): ReturnType<typeof validateDiagram> {
  return useMemo(() => validateDiagram(source), [source]);
}

/** Why a diagram was not drawn, with its JSON. */
export function DiagramError({ error, source }: { error: string; source: string }): React.ReactElement {
  const [show, setShow] = useState(false);
  return (
    <div data-diagram-error="" className="m-2 rounded-lg border border-hx-danger/30 bg-hx-danger/8 p-3 text-[12.5px]">
      <div className="flex items-start gap-2 text-hx-danger"><Icon name="alert" size={15} className="mt-0.5 shrink-0" /><span><b className="font-semibold">This diagram could not be drawn.</b> <span data-diagram-error-text>{error}</span></span></div>
      <button type="button" onClick={() => setShow((v) => !v)} className="mt-2 text-[12px] text-hx-secondary underline">{show ? 'Hide' : 'Show'} the JSON</button>
      {show && <div className="mt-2 max-h-[320px] overflow-auto [&_figure]:my-0"><CodeBlock code={source} language="json" /></div>}
    </div>
  );
}

export interface DiagramBlockProps {
  source: string;
  title?: string;
  /** Opens the interactive canvas (the desktop: its full-page view). Without it, a full-window overlay. */
  onOpen?: () => void;
  /** Remembers the layout (an artifact's id), so the next version keeps its boxes in place. */
  stableKey?: string;
  changed?: { nodes: string[]; edges: string[]; note?: string } | null;
  /** Options for the overlay canvas. */
  canvas?: Partial<DiagramCanvasProps>;
  /** Without the frame's own header (inside an artifact card, which has one). */
  bare?: boolean;
  maxHeight?: number;
}

export function DiagramBlock({ source, title, onOpen, stableKey, changed, canvas, bare, maxHeight = 460 }: DiagramBlockProps): React.ReactElement {
  const { spec, error, warnings } = useDiagramSpec(source);
  if (!spec) return <DiagramError error={error ?? 'unknown problem'} source={source} />;
  return <DiagramStatic spec={spec} warnings={warnings} title={title ?? spec.title} onOpen={onOpen} stableKey={stableKey} changed={changed} canvas={canvas} bare={bare} maxHeight={maxHeight} />;
}

function DiagramStatic({ spec, warnings, title, onOpen, stableKey, changed, canvas, bare, maxHeight }: { spec: DiagramSpec; warnings: string[]; title?: string; onOpen?: () => void; stableKey?: string; changed?: DiagramBlockProps['changed']; canvas?: Partial<DiagramCanvasProps>; bare?: boolean; maxHeight: number }) {
  const { scene } = useDiagramLayout(spec, { stableKey });
  const [overlay, setOverlay] = useState(false);
  const [notes, setNotes] = useState(false);
  const summary = summaryLine(summarizeDiagram(spec), spec.view);
  const changedSet = useMemo(() => new Set(changed?.nodes ?? []), [changed]);
  const changedEdges = useMemo(() => new Set(changed?.edges ?? []), [changed]);
  const open = () => (onOpen ? onOpen() : setOverlay(true));
  return (
    <div data-diagram-block={spec.view} data-diagram-nodes={spec.nodes.length} data-diagram-edges={spec.edges?.length ?? 0} className={cx('flex flex-col', !bare && 'my-3 overflow-hidden rounded-xl border border-hx-border bg-hx-bg')}>
      {!bare && (
        <div className="flex items-center gap-2 border-b border-hx-border-subtle px-2.5 py-1.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name="layers" size={14} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[12.5px] font-medium text-hx-primary">{title ?? viewName(spec.view)}</span><span className="block text-[11px] text-hx-muted">{viewName(spec.view)} diagram</span></span>
        </div>
      )}
      <button type="button" onClick={open} title="Open the interactive diagram" className="group relative block w-full cursor-zoom-in bg-hx-bg text-left" style={{ backgroundImage: 'radial-gradient(circle, var(--hx-border) 1px, transparent 1.2px)', backgroundSize: '18px 18px' }} data-diagram-static="">
        {scene ? (
          <Drawing scene={scene} view={spec.view} fitToBox title={title ?? spec.title} state={{ changed: changedSet, changedEdges }} style={{ maxHeight, display: 'block', pointerEvents: 'none' }} />
        ) : <div className="flex h-[220px] items-center justify-center text-[12px] text-hx-muted">Laying out…</div>}
      </button>
      <div className="flex flex-wrap items-center gap-2 border-t border-hx-border-subtle px-2.5 py-1.5 text-[11.5px] text-hx-muted">
        <span data-diagram-summary>{summary}</span>
        {changed && changed.nodes.length > 0 && <span className="rounded-full bg-amber-500/12 px-2 py-0.5 font-medium text-hx-warning" data-diagram-changed={changed.nodes.length}>{changed.note ?? `${changed.nodes.length} changed`}</span>}
        {warnings.length > 0 && <button type="button" className="underline decoration-dotted" onClick={() => setNotes((v) => !v)}>{warnings.length} note{warnings.length === 1 ? '' : 's'}</button>}
        <Button size="sm" variant="secondary" icon="expand" className="ml-auto" onClick={open} data-diagram-open="">Open interactive</Button>
      </div>
      {notes && <ul className="border-t border-hx-border-subtle px-3 py-1.5 text-[11.5px] text-hx-muted" data-diagram-warnings>{warnings.slice(0, 20).map((w, i) => <li key={i}>· {w}</li>)}</ul>}
      {overlay && <DiagramOverlay spec={spec} title={title} stableKey={stableKey} changed={changed} canvas={canvas} onClose={() => setOverlay(false)} />}
    </div>
  );
}

/** The canvas over the whole window (when the host has no page for it). */
export function DiagramOverlay({ spec, title, stableKey, changed, canvas, onClose }: { spec: DiagramSpec; title?: string; stableKey?: string; changed?: DiagramBlockProps['changed']; canvas?: Partial<DiagramCanvasProps>; onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { onClose(); } };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--hx-scrim)] p-4" role="dialog" aria-modal="true" aria-label={title ?? 'Diagram'} data-diagram-overlay="">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-hx-border bg-hx-bg shadow-2xl">
        <div className="flex items-center gap-2 border-b border-hx-border-subtle px-3 py-2">
          <Icon name="layers" size={15} className="text-hx-accent-text" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title ?? spec.title ?? viewName(spec.view)}</span>
          <Button size="sm" variant="ghost" icon="x" onClick={onClose}>Close</Button>
        </div>
        <div className="min-h-0 flex-1"><DiagramCanvas spec={spec} title={title} stableKey={stableKey} changed={changed} {...canvas} /></div>
      </div>
    </div>
  );
}
