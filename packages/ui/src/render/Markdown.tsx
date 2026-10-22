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
 * Streaming: the text is split into top-level blocks (blocks.ts) and each is a memoised component,
 * so a delta re-parses only the last block and finished blocks never re-render or jump.
 */

import React, { useCallback, useId, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { protectCurrency } from './currency.ts';
import { splitBlocks, isOpenBlock } from './blocks.ts';
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

const TITLES: Partial<Record<FenceKind, string>> = { chart: 'Chart', viz: 'Figure', diagram: 'Diagram', math: 'Formula', table: 'Table', csv: 'CSV', tsv: 'TSV', json: 'JSON' };

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
  let drawn: React.ReactElement;
  switch (kind) {
    case 'chart': drawn = <Chart source={source} streaming={streaming} />; break;
    case 'viz': drawn = <Viz source={source} streaming={streaming} />; break;
    case 'diagram': drawn = <Diagram source={source} streaming={streaming} />; break;
    case 'math': drawn = <MathBlock source={source} streaming={streaming} />; break;
    case 'table': drawn = <DataTable source={source} streaming={streaming} />; break;
    case 'csv': drawn = <DataTable source={source} format="csv" streaming={streaming} />; break;
    case 'tsv': drawn = <DataTable source={source} format="tsv" streaming={streaming} />; break;
    case 'json': drawn = <JsonView source={source} streaming={streaming} />; break;
    case 'html': return <Artifact kind="html" source={source} language={lang} streaming={streaming} />;
    case 'svg': return <Artifact kind="svg" source={source} language="xml" streaming={streaming} />;
    case 'react': return <Artifact kind="react" source={source} language={lang} streaming={streaming} />;
    case 'diff': return streaming ? <CodeBlock code={source} language="diff" streaming /> : <PatchView source={source} />;
    default: return <CodeBlock code={source} language={lang} streaming={streaming} />;
  }
  if (!FRAMED.has(kind)) return drawn;
  return <Widget kind={TITLES[kind] ?? kind} source={source} extension={extensionFor(kind, lang)} onFix={onFix}>{drawn}</Widget>;
}

const MdBlock = React.memo(function MdBlock({ text, streaming, renderFence, sources, onFix, prefix }: { text: string; streaming: boolean; renderFence?: FenceRenderer; sources?: Source[]; onFix?: MarkdownProps['onFix']; prefix: string }): React.ReactElement {
  const cite = useCallback((n: number, url?: string): Source | undefined => {
    const byUrl = url ? sources?.find((s) => s.url === url) : undefined;
    return byUrl ?? sources?.find((s) => s.n === n) ?? (url ? { n, url } : undefined);
  }, [sources]);
  const components = useMemo((): Components => {
    const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => function H({ children }: { children?: React.ReactNode }) {
      const id = `${prefix}${slugify(textOf(children))}`;
      return <Tag id={id}>{children}<a href={`#${id}`} aria-label="Link to this section" className="heading-anchor" onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>#</a></Tag>;
    };
    return {
      code({ className, children, node: _n, ...props }) {
        const lang = /language-([\w+#.-]+)/.exec(className ?? '')?.[1] ?? '';
        const text = String(children ?? '');
        if (!lang && !text.includes('\n')) return <code {...props}>{children}</code>;
        return <FencedBlock lang={lang} source={text.replace(/\n$/, '')} streaming={streaming} renderFence={renderFence} onFix={onFix} />;
      },
      pre({ children }) { return <>{children}</>; },
      a({ href, children, node: _n, ...rest }) {
        const safe = safeHref(href);
        const label = textOf(children).trim();
        const isFootnote = 'data-footnote-ref' in rest || 'data-footnote-backref' in rest;
        if (safe && isFootnote) return <a href={safe} {...rest} onClick={(e) => { e.preventDefault(); document.getElementById(decodeURIComponent(safe.slice(1)))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>{children}</a>;
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
  }, [streaming, renderFence, onFix, prefix, cite]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, trust: false, output: 'html' }]]}
      remarkRehypeOptions={{ clobberPrefix: prefix }}
      components={components}
    >
      {protectCurrency(text)}
    </ReactMarkdown>
  );
});

export const Markdown = React.memo(function Markdown({ text, streaming = false, renderFence, sources, onFix, className }: MarkdownProps): React.ReactElement {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const blocks = useMemo(() => splitBlocks(text), [text]);
  return (
    <div className={`markdown-body ${className ?? ''}`} data-markdown>
      {blocks.map((b, i) => (
        <MdBlock key={i} text={b} streaming={streaming && i === blocks.length - 1 && isOpenBlock(b)} renderFence={renderFence} sources={sources} onFix={onFix} prefix={`m${id}-`} />
      ))}
    </div>
  );
});
