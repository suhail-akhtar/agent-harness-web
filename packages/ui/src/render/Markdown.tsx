/**
 * The assistant's prose and everything a fenced block can become.
 *
 * GFM (tables with alignment, task lists, footnotes, strikethrough, autolinks), maths with KaTeX
 * ($..$ and $$..$$), headings with anchors, citations, images with a lightbox, and fenced blocks
 * dispatched by language (fences.ts): code, diagrams, charts, maths, tables, CSV/TSV, JSON, diffs,
 * and HTML/SVG/React artifacts. A host may replace any fence language (a plugin renderer).
 *
 * Untrusted by construction: no rehype-raw (HTML in the text is shown as text, never parsed into
 * the DOM), every URL goes through safe.ts, and markup only ever runs inside a sandboxed frame.
 *
 * Streaming: the text is split into top-level blocks (blocks.ts) and each is a memoised component
 * keyed by its position, so a delta re-parses only the last block and finished blocks never re-render
 * or jump. Footnotes and link references reach across blocks: each block gets the definitions it
 * uses, and the footnotes are one section after the last block, drawn once the reply is complete.
 */

import React, { useContext, useId, useMemo, useRef } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { KATEX_MACROS, KATEX_OPTIONS } from './katex-setup.ts';
import { protectCurrency } from './currency.ts';
import { planBlocks } from './blocks.ts';
import { extensionFor, fenceKind, FRAMED, type FenceKind } from './fences.ts';
import { safeHref, isExternal } from './safe.ts';
import { CodeBlock } from './CodeBlock.tsx';
import { Diagram } from './Diagram.tsx';
import { Chart, Viz } from './Charts.tsx';
import { DataTable, JsonView, MathBlock } from './Data.tsx';
import { Artifact } from './Artifact.tsx';
import { PatchView } from './DiffView.tsx';
import { Citation, ImageView, type Source } from './Media.tsx';
import { RenderBoundary, Widget } from './Widget.tsx';
import { bioBlock } from './biology/kinds.ts';

// The science and BI blocks load with their first use (Graphviz's wasm, smiles-drawer and the rest).
const Science = () => import('./science/Science.tsx');
const lazyBlock = <K extends 'FunctionPlot' | 'GraphvizView' | 'SmilesView' | 'Molecule3D' | 'GeoMap' | 'NotebookView' | 'Dashboard'>(k: K) =>
  React.lazy(() => Science().then((m) => ({ default: m[k] as unknown as React.ComponentType<Record<string, unknown>> })));
const LZ = {
  plot: lazyBlock('FunctionPlot'), graphviz: lazyBlock('GraphvizView'), smiles: lazyBlock('SmilesView'), molecule: lazyBlock('Molecule3D'),
  geojson: lazyBlock('GeoMap'), notebook: lazyBlock('NotebookView'), dashboard: lazyBlock('Dashboard'),
};
// The biology blocks (biology/kinds.ts) load with their first use too, as one chunk.
const bioLazy = new Map<string, React.ComponentType<Record<string, unknown>>>();
const bioComponent = (name: string) => bioLazy.get(name) ?? bioLazy.set(name, React.lazy(() => import('./biology/Biology.tsx').then((m) => ({ default: (m as unknown as Record<string, React.ComponentType<Record<string, unknown>>>)[name]! })))).get(name)!;
const loadingBlock = <p className="p-3 text-[12px] text-hx-muted">Loading…</p>;
const nestedMarkdown = (text: string) => <Markdown text={text} />;

/** Replaces the default for a fence language (a plugin renderer). Return undefined to keep the default. */
export type FenceRenderer = (lang: string, source: string, streaming: boolean) => React.ReactNode | undefined;

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  renderFence?: FenceRenderer;
  /** Sources the session cited, for citation hover cards. */
  sources?: Source[];
  onFix?: (r: { kind: string; source: string; error: string }) => void;
  className?: string;
}

const TITLES: Partial<Record<FenceKind, string>> = { chart: 'Chart', viz: 'Figure', mermaid: 'Diagram', math: 'Formula', table: 'Table', csv: 'CSV', tsv: 'TSV', json: 'JSON', plot: 'Plot', graphviz: 'Graph', smiles: 'Structure', molecule: '3D structure', geojson: 'Map', notebook: 'Notebook', dashboard: 'Dashboard' };

export function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'section';
}
function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (React.isValidElement(children)) return textOf((children.props as { children?: React.ReactNode }).children);
  return '';
}

/** What a fenced block draws as (exported for tests and for hosts that render a single block). */
export function FencedBlock({ lang, source, streaming = false, renderFence, onFix }: { lang: string; source: string; streaming?: boolean; renderFence?: FenceRenderer; onFix?: MarkdownProps['onFix'] }): React.ReactElement {
  const custom = renderFence?.(lang, source, streaming);
  if (custom !== undefined && custom !== null) {
    return <RenderBoundary fallback={(e, retry) => <div className="my-2 rounded-lg border border-hx-danger/40 p-2 text-[12px] text-hx-danger" data-render-error>A plugin renderer for {lang} failed: {e} <button type="button" className="underline" onClick={retry}>Try again</button><CodeBlock code={source} language={lang} /></div>}>{custom}</RenderBoundary>;
  }
  const kind = fenceKind(lang, source);
  const bio = bioBlock(kind, lang);
  if (bio) { const C = bioComponent(bio.component); return <Widget kind={bio.title} source={source} extension={bio.ext} onFix={onFix}><React.Suspense fallback={loadingBlock}><C source={source} streaming={streaming} format={lang.toLowerCase()} /></React.Suspense></Widget>; }
  let drawn: React.ReactElement;
  switch (kind) {
    case 'chart': drawn = <Chart source={source} streaming={streaming} />; break;
    case 'viz': drawn = <Viz source={source} streaming={streaming} />; break;
    case 'mermaid': drawn = <Diagram source={source} streaming={streaming} />; break;
    case 'diagram': return <Artifact kind="diagram" source={source} language="json" streaming={streaming} />;
    case 'math': drawn = <MathBlock source={source} streaming={streaming} />; break;
    case 'table': drawn = <DataTable source={source} streaming={streaming} />; break;
    case 'csv': drawn = <DataTable source={source} format="csv" streaming={streaming} />; break;
    case 'tsv': drawn = <DataTable source={source} format="tsv" streaming={streaming} />; break;
    case 'json': drawn = <JsonView source={source} streaming={streaming} />; break;
    case 'html': return <Artifact kind="html" source={source} language={lang} streaming={streaming} />;
    case 'svg': return <Artifact kind="svg" source={source} language="xml" streaming={streaming} />;
    case 'react': return <Artifact kind="react" source={source} language={lang} streaming={streaming} />;
    case 'diff': return streaming ? <CodeBlock code={source} language="diff" streaming /> : <PatchView source={source} />;
    case 'plot': case 'graphviz': case 'smiles': case 'molecule': case 'geojson': case 'notebook': case 'dashboard': {
      const C = LZ[kind];
      drawn = <React.Suspense fallback={loadingBlock}><C source={source} streaming={streaming} format={lang.toLowerCase()} renderMarkdown={nestedMarkdown} /></React.Suspense>;
      break;
    }
    default: return <CodeBlock code={source} language={lang} streaming={streaming} />;
  }
  if (!FRAMED.has(kind)) return drawn;
  return <Widget kind={TITLES[kind] ?? kind} source={source} extension={extensionFor(kind, lang)} onFix={onFix} block={streaming ? undefined : { kind, lang }}>{drawn}</Widget>;
}

// The footnotes block's document is the references (in order) and the definitions: only its section is kept.
type HastParent = { children: Array<{ type: string; tagName?: string }> };
const onlyFootnotes = () => (tree: HastParent) => { tree.children = tree.children.filter((n) => n.type === 'element' && n.tagName === 'section'); };

// What changes while a block lives is read through context and a ref, never by making the components
// again: a new component function is a new element type, and React would remount everything the block
// drew (a code block folding again under the reader, a chart, a frame). Whether the block is arriving:
const BlockStreaming = React.createContext(false);
// The reply's footnote numbers (label -> number): a block's own numbering would restart at 1.
const FootnoteNumbers = React.createContext<ReadonlyMap<string, number>>(new Map());

/**
 * One top-level block. A footnote reference shows its number in the whole reply, and the block's own
 * footnotes section is not drawn (the reply's is, once, at the end). `footnotesOnly` draws that section.
 */
const MdBlock = React.memo(function MdBlock({ text, streaming, renderFence, sources, onFix, prefix, footnotesOnly = false }: { text: string; streaming: boolean; renderFence?: FenceRenderer; sources?: Source[]; onFix?: MarkdownProps['onFix']; prefix: string; footnotesOnly?: boolean }): React.ReactElement {
  // The sources arrive after a turn (a new array each time): read when drawn, so the components stay.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const components = useMemo((): Components => {
    const cite = (n: number, url?: string): Source | undefined => {
      const list = sourcesRef.current;
      const byUrl = url ? list?.find((s) => s.url === url) : undefined;
      return byUrl ?? list?.find((s) => s.n === n) ?? (url ? { n, url } : undefined);
    };
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => function H({ children }: { children?: React.ReactNode }) {
      const id = `${prefix}${slugify(textOf(children))}`;
      return <Tag id={id}>{children}<a href={`#${id}`} aria-label="Link to this section" className="heading-anchor" onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>#</a></Tag>;
    };
    return {
      code: function Code({ className, children, node: _n, ...props }) {
        const streaming = useContext(BlockStreaming);
        const lang = /language-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? '';
        const text = String(children ?? '');
        if (!lang && !text.includes('\n')) return <code {...props}>{children}</code>;
        // An open ```math or $$ at the tail (KaTeX is not run on it, it would draw each half-formula as an error).
        if (streaming && lang === 'math') return /\bmath-inline\b/.test(className ?? '') ? <code {...props}>{children}</code> : <MathBlock source="" streaming />;
        return <FencedBlock lang={lang} source={text.replace(/\n$/, '')} streaming={streaming} renderFence={renderFence} onFix={onFix} />;
      },
      pre({ children }) { return <>{children}</>; },
      // A block's own footnotes section is not drawn: the reply's is, once, after the last block (Markdown).
      section({ children, node: _n, ...rest }) {
        if ('data-footnotes' in rest && !footnotesOnly) return null;
        return <section {...rest}>{children}</section>;
      },
      a: function A({ href, children, node: _n, ...rest }) {
        const numbers = useContext(FootnoteNumbers);
        const safe = safeHref(href);
        const label = textOf(children).trim();
        const isFootnote = 'data-footnote-ref' in rest || 'data-footnote-backref' in rest;
        if (safe && isFootnote) {
          // Numbered within the whole reply, not within this block.
          const n = 'data-footnote-ref' in rest ? numbers.get(decodeURIComponent(safe.slice(safe.lastIndexOf('-fn-') + 4))) : undefined;
          return <a href={safe} {...rest} onClick={(e) => { e.preventDefault(); document.getElementById(decodeURIComponent(safe.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>{n ?? children}</a>;
        }
        const num = /^\[?(\d{1,3})\]?$/.exec(label);
        if (safe && num && isExternal(safe)) return <Citation n={Number(num[1])} source={cite(Number(num[1]), safe)} />;
        if (!safe) return <span className="text-hx-secondary" title="Link removed (not an http(s) address)">{children}</span>;
        if (safe.startsWith('#')) return <a href={safe} onClick={(e) => { e.preventDefault(); document.getElementById(`${prefix}${safe.slice(1)}`)?.scrollIntoView({ behavior: 'smooth' }); }}>{children}</a>;
        return <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
      },
      img({ src, alt }) { return <ImageView src={typeof src === 'string' ? src : ''} alt={alt} />; },
      table({ children }) { return <div className="my-3 overflow-x-auto" data-md-table><table>{children}</table></div>; },
      th({ children, style, node: n }) { const align = (n?.properties?.align as string | undefined) ?? (style as React.CSSProperties | undefined)?.textAlign; return <th style={{ textAlign: (align as React.CSSProperties['textAlign']) ?? 'left' }}>{children}</th>; },
      td({ children, style, node: n }) { const align = (n?.properties?.align as string | undefined) ?? (style as React.CSSProperties | undefined)?.textAlign; return <td style={align ? { textAlign: align as React.CSSProperties['textAlign'] } : undefined}>{children}</td>; },
      input({ checked, type }) { return type === 'checkbox' ? <input type="checkbox" checked={!!checked} readOnly disabled className="mr-1.5 translate-y-[1px] accent-[var(--hx-accent)]" /> : null; },
      h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6'),
    };
  }, [renderFence, onFix, prefix, footnotesOnly]);
  return (
    <BlockStreaming.Provider value={streaming}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={streaming ? [] : footnotesOnly ? [[rehypeKatex, { ...KATEX_OPTIONS, macros: { ...KATEX_MACROS } }], onlyFootnotes] : [[rehypeKatex, { ...KATEX_OPTIONS, macros: { ...KATEX_MACROS } }]]}
        remarkRehypeOptions={{ clobberPrefix: prefix }}
        // The default drops data: URLs; inline images are allowed (an <img> runs no script; safe.ts checks the type).
        urlTransform={(url, key) => (key === 'src' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i.test(url.trim()) ? url : defaultUrlTransform(url))}
        components={components}
      >
        {protectCurrency(text)}
      </ReactMarkdown>
    </BlockStreaming.Provider>
  );
});

export const Markdown = React.memo(function Markdown({ text, streaming = false, renderFence, sources, onFix, className }: MarkdownProps): React.ReactElement {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const plan = useMemo(() => planBlocks(text, { streaming }), [text, streaming]);
  const order = plan.footnotes.join(' '); // labels hold no spaces
  const numbers = useMemo(() => new Map(order ? order.split(' ').map((l, i) => [l, i + 1] as const) : []), [order]);
  const last = plan.blocks.length - 1;
  return (
    <div className={`markdown-body ${className ?? ''}`} data-markdown>
      <FootnoteNumbers.Provider value={numbers}>
        {plan.blocks.map((b, i) => (
          <MdBlock key={b.key} text={b.text} streaming={streaming && i === last && b.open} renderFence={renderFence} sources={sources} onFix={onFix} prefix={`m${id}-`} />
        ))}
        {/* The footnotes come and go while an answer streams (a reference before its definition): drawn once it is complete. */}
        {!streaming && plan.footnotesDoc && <MdBlock key="footnotes" text={plan.footnotesDoc} streaming={false} sources={sources} onFix={onFix} prefix={`m${id}-`} footnotesOnly />}
      </FootnoteNumbers.Provider>
    </div>
  );
});
