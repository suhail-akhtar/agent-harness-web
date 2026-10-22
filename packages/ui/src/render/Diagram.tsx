/**
 * Mermaid diagrams (flowchart, sequence, class, state, gantt, ER, pie, ...): loaded on first use,
 * rendered under Mermaid's strict security level and then scrubbed again (no scripts, no
 * foreignObject, no event handlers, no javascript: links), cached by source and theme so a
 * re-render never redraws, zoomable, with a view-source toggle. (Adapted from AICO's shared/ui/Diagram.)
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '../components/primitives.tsx';
import { ZoomPan } from './ZoomPan.tsx';
import { useWidgetExpanded } from './Widget.tsx';
import { diagramCss, diagramTheme } from './diagram-theme.ts';
import { scrubSvgDom } from './safe.ts';

type Mermaid = typeof import('mermaid').default;
let mermaidPromise: Promise<Mermaid> | null = null;
let initialisedFor: string | null = null;
function loadMermaid(dark: boolean): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise.then((mermaid) => {
    const mode = dark ? 'dark' : 'light';
    if (initialisedFor !== mode) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: diagramTheme(dark),
        themeCSS: diagramCss(dark),
        // SVG text labels, not HTML in a foreignObject (which the scrub removes).
        htmlLabels: false,
        flowchart: { curve: 'basis', htmlLabels: false, nodeSpacing: 44, rankSpacing: 54 },
        sequence: { actorMargin: 56, mirrorActors: false },
        gantt: { barHeight: 22, barGap: 6, topPadding: 46 },
      });
      initialisedFor = mode;
    }
    return mermaid;
  });
}

const svgCache = new Map<string, string>();
const sourceShown = new Set<string>();
let counter = 0;
let queue: Promise<unknown> = Promise.resolve();

const isDark = () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';

export const Diagram = React.memo(function Diagram({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const [dark, setDark] = useState(isDark);
  const cacheKey = `${dark ? 'd' : 'l'}:${source}`;
  const [svg, setSvg] = useState(() => svgCache.get(cacheKey) ?? '');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(() => sourceShown.has(source));
  const container = useRef<HTMLDivElement>(null);
  const expanded = useWidgetExpanded();

  useEffect(() => {
    const mo = new MutationObserver(() => setDark(isDark()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    if (streaming) return;
    const cached = svgCache.get(cacheKey);
    if (cached) { setSvg(cached); setError(''); return; }
    let cancelled = false;
    const id = `hx-diagram-${++counter}`;
    // One render at a time: mermaid keeps global state while it lays out.
    queue = queue.then(() => loadMermaid(dark).then((m) => m.render(id, source))).then(({ svg: out }) => {
      const clean = scrubSvgDom(out);
      svgCache.set(cacheKey, clean);
      if (!cancelled) { setSvg(clean); setError(''); }
    }).catch((err: unknown) => {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [cacheKey, source, streaming, dark]);

  useLayoutEffect(() => {
    const drawing = container.current?.querySelector(':scope > svg');
    if (!drawing) return;
    drawing.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    drawing.setAttribute('height', '100%');
    (drawing as SVGElement).style.maxWidth = 'none';
  }, [svg, expanded, showSource]);

  if (streaming) return <p className="p-2 text-[11.5px] text-hx-muted">Diagram arriving…</p>;
  if (error) throw new Error(error.split('\n')[0]);
  const toggle = () => setShowSource((c) => { const n = !c; if (n) sourceShown.add(source); else sourceShown.delete(source); return n; });
  return (
    <ZoomPan className="h-[24rem]" actions={<IconButton size="xs" icon="code" label={showSource ? 'Show the diagram' : 'View source'} onClick={toggle} active={showSource} />}>
      {showSource ? (
        <pre className="max-h-[24rem] overflow-auto p-2 font-mono text-[12.5px] leading-5 text-hx-primary" data-diagram-source><code>{source}</code></pre>
      ) : svg ? (
        // Mermaid's output under securityLevel strict, scrubbed again by scrubSvgDom.
        <div ref={container} data-diagram="svg" dangerouslySetInnerHTML={{ __html: svg }} className="h-full w-full p-2 [&>svg]:h-full [&>svg]:w-full [&>svg]:!max-w-none" />
      ) : (
        <div className="p-6 text-center text-[12.5px] text-hx-muted">Drawing…</div>
      )}
    </ZoomPan>
  );
});
