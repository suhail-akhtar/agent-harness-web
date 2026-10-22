/**
 * A live preview of an HTML page, an SVG drawing or a React component the agent wrote, in a
 * sandboxed frame (opaque origin, no network), with Preview / Code tabs, open in the side panel,
 * copy and download.
 *
 * Where the host can serve the page from an isolated origin of its own (the desktop's
 * harness://preview), it does: a srcdoc frame inherits the app's CSP, which refuses inline script.
 * Elsewhere (tests, a browser), srcdoc is used.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons.tsx';
import { IconButton, Tabs } from '../components/primitives.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { artifactDocument, artifactSandbox, type ArtifactKind } from './artifact-doc.ts';
import { copyText, downloadText } from './download.ts';

export interface ArtifactHost {
  /** Registers a document; returns a URL on an isolated origin to frame with sandbox="allow-scripts". */
  register?(doc: string): Promise<string>;
  /** The React runtime script (React, ReactDOM and a JSX transform) on that origin. */
  runtimeUrl?: string;
  /** Opens an artifact in the side panel. */
  openPanel?(a: { title: string; kind: ArtifactKind; source: string; language: string }): void;
}
let host: ArtifactHost = {};
export function setArtifactHost(h: ArtifactHost): void { host = h; }
export function artifactHost(): ArtifactHost { return host; }

export interface ArtifactProps { kind: ArtifactKind; source: string; language?: string; title?: string; streaming?: boolean; /** Fill the container (the side panel) instead of the transcript's height. */ fill?: boolean; defaultTab?: 'preview' | 'code' }

const label: Record<ArtifactKind, string> = { html: 'HTML', svg: 'SVG', react: 'React component' };

export const Artifact = React.memo(function Artifact({ kind, source, language, title, streaming, fill, defaultTab }: ArtifactProps): React.ReactElement {
  const [tab, setTab] = useState<'preview' | 'code'>(defaultTab ?? (streaming ? 'code' : 'preview'));
  const [copied, setCopied] = useState(false);
  const name = title ?? guessTitle(kind, source);
  useEffect(() => { if (!streaming && !defaultTab) setTab('preview'); }, [streaming, defaultTab]);
  return (
    <figure data-block="artifact" data-artifact={kind} className={`my-3 flex flex-col overflow-hidden rounded-xl border border-hx-border bg-hx-bg ${fill ? 'h-full' : ''}`}>
      <figcaption className="flex items-center gap-2 border-b border-hx-border-subtle px-2.5 py-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name={kind === 'react' ? 'atom' : kind === 'svg' ? 'image' : 'code'} size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-hx-primary">{name}</span>
          <span className="block text-[11px] text-hx-muted">{label[kind]}{streaming ? ' · writing…' : ''}</span>
        </span>
        <Tabs size="sm" value={tab} onChange={(t) => setTab(t as 'preview' | 'code')} tabs={[{ id: 'preview', label: 'Preview' }, { id: 'code', label: 'Code' }]} />
        {host.openPanel && !fill && <IconButton size="xs" icon="panel-right" label="Open in the side panel" onClick={() => host.openPanel!({ title: name, kind, source, language: language ?? kind })} />}
        <IconButton size="xs" icon={copied ? 'check' : 'copy'} label="Copy the source" onClick={() => void copyText(source).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); } })} />
        <IconButton size="xs" icon="download" label="Download" onClick={() => downloadText(`${slug(name)}.${kind === 'react' ? (language === 'tsx' ? 'tsx' : 'jsx') : kind}`, source)} />
      </figcaption>
      <div className={fill ? 'min-h-0 flex-1' : ''}>
        {tab === 'code' || streaming
          ? <div className="max-h-[480px] overflow-auto [&_figure]:my-0 [&_figure]:rounded-none [&_figure]:border-0"><CodeBlock code={source} language={language ?? (kind === 'react' ? 'jsx' : kind === 'svg' ? 'xml' : 'html')} collapseAt={1e9} streaming={streaming} /></div>
          : <ArtifactFrame kind={kind} source={source} fill={fill} />}
      </div>
    </figure>
  );
});

export function ArtifactFrame({ kind, source, fill }: { kind: ArtifactKind; source: string; fill?: boolean }): React.ReactElement {
  const doc = useMemo(() => artifactDocument(kind, source, { runtimeUrl: host.runtimeUrl }), [kind, source]);
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(kind === 'svg' ? 320 : 360);
  const frame = useRef<HTMLIFrameElement>(null);
  const scripted = kind !== 'svg';
  useEffect(() => {
    setUrl(null);
    if (!scripted || !host.register) return;
    let alive = true;
    host.register(doc).then((u) => { if (alive) setUrl(u); }, () => {});
    return () => { alive = false; };
  }, [doc, scripted]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { harnessArtifact?: string; height?: number } | null;
      if (d && d.harnessArtifact === 'size' && typeof d.height === 'number') setHeight(Math.min(1200, Math.max(80, d.height + 4)));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);
  const waiting = scripted && !!host.register && !url;
  return (
    <div className={`relative bg-white ${fill ? 'h-full' : ''}`} style={fill ? undefined : { height, resize: 'vertical', overflow: 'hidden', minHeight: 80 }}>
      {waiting ? <div className="p-4 text-[12px] text-neutral-500">Preparing preview…</div> : (
        <iframe
          ref={frame}
          key={url ?? 'srcdoc'}
          title={`${label[kind]} preview`}
          // Never allow-same-origin: the frame gets an opaque origin, whatever it runs.
          sandbox={artifactSandbox(kind)}
          referrerPolicy="no-referrer"
          {...(url ? { src: url } : { srcDoc: doc })}
          className="h-full w-full border-0"
          data-artifact-frame={kind}
        />
      )}
    </div>
  );
}

function guessTitle(kind: ArtifactKind, source: string): string {
  const t = /<title>([^<]{1,80})<\/title>/i.exec(source)?.[1] ?? /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(source)?.[1] ?? /export\s+default\s+function\s+([A-Za-z0-9_]+)/.exec(source)?.[1];
  return t?.trim() || (kind === 'react' ? 'Component' : kind === 'svg' ? 'Drawing' : 'Page');
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
