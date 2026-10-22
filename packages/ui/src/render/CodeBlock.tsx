/**
 * A fenced code block: highlighted (Prism grammars for the common languages), labelled, copyable,
 * with a line-wrap toggle; long blocks start collapsed with "Show all N lines". Token colours are
 * CSS variables, so a theme switch recolours code without re-rendering it.
 */

import React, { useMemo, useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { Icon } from '../icons.tsx';
import { GRAMMARS, grammarFor, languageLabel } from './languages.ts';
import { copyText } from './download.ts';

for (const [name, grammar] of Object.entries(GRAMMARS)) SyntaxHighlighter.registerLanguage(name, grammar);

const tok = (v: string): React.CSSProperties => ({ color: `var(--hx-tok-${v})` });
/** A Prism style whose colours are theme variables (defined in styles.css for light and dark). */
export const CODE_STYLE: Record<string, React.CSSProperties> = {
  'code[class*="language-"]': { color: 'var(--hx-text-primary)', fontFamily: 'var(--hx-font-mono)', background: 'none' },
  'pre[class*="language-"]': { color: 'var(--hx-text-primary)', fontFamily: 'var(--hx-font-mono)', background: 'none', margin: 0 },
  comment: { ...tok('comment'), fontStyle: 'italic' }, prolog: tok('comment'), doctype: tok('comment'), cdata: tok('comment'),
  punctuation: tok('punct'), operator: tok('punct'),
  property: tok('prop'), tag: tok('tag'), boolean: tok('const'), number: tok('const'), constant: tok('const'), symbol: tok('const'), deleted: tok('deleted'),
  selector: tok('string'), 'attr-name': tok('attr'), string: tok('string'), char: tok('string'), builtin: tok('builtin'), inserted: tok('inserted'),
  entity: tok('const'), url: tok('string'), atrule: tok('keyword'), 'attr-value': tok('string'), keyword: tok('keyword'), function: tok('fn'), 'class-name': tok('type'),
  regex: tok('regex'), important: { ...tok('keyword'), fontWeight: 600 }, variable: tok('var'), bold: { fontWeight: 600 }, italic: { fontStyle: 'italic' },
};

export interface CodeBlockProps { code: string; language?: string; filename?: string; /** Lines before it starts collapsed. */ collapseAt?: number; className?: string; streaming?: boolean }

export const CodeBlock = React.memo(function CodeBlock({ code, language = '', filename, collapseAt = 30, className, streaming }: CodeBlockProps): React.ReactElement {
  const body = code.replace(/\n$/, '');
  const lines = useMemo(() => body.split('\n').length, [body]);
  const [wrap, setWrap] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const grammar = grammarFor(language);
  const collapsed = !open && !streaming && lines > collapseAt;
  const shown = collapsed ? body.split('\n').slice(0, Math.max(12, collapseAt - 12)).join('\n') : body;
  return (
    <figure data-block="code" data-lang={language || 'text'} className={`group/code my-3 overflow-hidden rounded-xl border border-hx-border-subtle bg-hx-code ${className ?? ''}`}>
      <figcaption className="flex items-center gap-1 border-b border-hx-border-subtle px-3 py-1 text-[11.5px] text-hx-muted">
        <span className="font-medium">{filename ?? languageLabel(language)}</span>
        <span className="ml-1 opacity-70">{lines > 1 ? `${lines} lines` : ''}</span>
        <div className="flex-1" />
        <button type="button" onClick={() => setWrap((w) => !w)} aria-pressed={wrap} title={wrap ? 'Do not wrap lines' : 'Wrap long lines'} className={`inline-flex h-6 items-center gap-1 rounded px-1.5 hover:bg-hx-hover hover:text-hx-primary ${wrap ? 'text-hx-primary' : ''}`}>
          <Icon name="wrap" size={13} /><span className="sr-only">Wrap</span>
        </button>
        <button type="button" onClick={() => void copyText(body).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })} aria-label="Copy code" className="inline-flex h-6 items-center gap-1 rounded px-1.5 hover:bg-hx-hover hover:text-hx-primary">
          <Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <div className={`hx-code relative overflow-x-auto px-3.5 py-2.5 ${wrap ? 'wrap' : ''}`} data-wrap={wrap ? '1' : '0'}>
        {grammar && !streaming ? (
          <SyntaxHighlighter language={grammar} style={CODE_STYLE} customStyle={{ margin: 0, padding: 0, background: 'transparent', fontSize: '12.5px', lineHeight: '20px', whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-word' : undefined }} codeTagProps={{ style: { fontFamily: 'var(--hx-font-mono)', whiteSpace: wrap ? 'pre-wrap' : 'pre' } }} wrapLongLines={wrap}>
            {shown}
          </SyntaxHighlighter>
        ) : (
          <pre className="m-0"><code className="font-mono text-[12.5px] leading-5 text-hx-primary" style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>{shown}</code></pre>
        )}
        {collapsed && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-[var(--hx-code-bg)] to-transparent" />}
      </div>
      {lines > collapseAt && !streaming && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-center gap-1 border-t border-hx-border-subtle py-1 text-[11.5px] text-hx-muted hover:bg-hx-hover hover:text-hx-primary">
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />{open ? 'Show less' : `Show all ${lines} lines`}
        </button>
      )}
    </figure>
  );
});
