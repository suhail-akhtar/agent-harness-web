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
import { artifactDocument, type ArtifactKind, type FramedArtifactKind } from './artifact-doc.ts';
import { JsonView } from './Data.tsx';
import { RenderBoundary } from './Widget.tsx';
import { copyText, downloadText } from './download.ts';

export interface ArtifactHost {
  /** Registers a document; returns a URL on an isolated origin to frame with sandbox="allow-scripts". */
  register?(doc: string): Promise<string>;
  /** The React runtime script (React, ReactDOM and a JSX transform) on that origin. */
  runtimeUrl?: string;
  /** Opens an artifact in the side panel. */
  openPanel?(a: { title: string; kind: ArtifactKind; source: string; language: string }): void;
  /**
   * A hook (called inside the Artifact component, so it can subscribe to the host's plugin registry)
   * returning the host's renderer for an artifact kind: a plugin's renderer replaces the default preview.
   */
  useRenderer?(): ArtifactRenderer;
}
/** Draws an artifact kind, or returns undefined to keep the default. */
export type ArtifactRenderer = (kind: ArtifactKind, source: string, o: { title: string; fill?: boolean }) => React.ReactNode | undefined;
const noRenderer: ArtifactRenderer = () => undefined;
const useNoRenderer = () => noRenderer;
let host: ArtifactHost = {};
export function setArtifactHost(h: ArtifactHost): void { host = h; }
export function artifactHost(): ArtifactHost { return host; }

export interface ArtifactProps { kind: ArtifactKind; source: string; language?: string; title?: string; streaming?: boolean; /** Fill the container (the side panel) instead of the transcript's height. */ fill?: boolean; defaultTab?: 'preview' | 'code' }

const label: Record<ArtifactKind, string> = { html: 'HTML', svg: 'SVG', react: 'React component', diagram: 'Diagram' };
const ICON = { react: 'atom', svg: 'image', html: 'code', diagram: 'layers' } as const;

export const Artifact = React.memo(function Artifact({ kind, source, language, title, streaming, fill, defaultTab }: ArtifactProps): React.ReactElement {
  const [tab, setTab] = useState<'preview' | 'code'>(defaultTab ?? (streaming ? 'code' : 'preview'));
  const [copied, setCopied] = useState(false);
  const name = title ?? guessTitle(kind, source);
  const custom = (host.useRenderer ?? useNoRenderer)();
  useEffect(() => { if (!streaming && !defaultTab) setTab('preview'); }, [streaming, defaultTab]);
  return (
    <figure data-block="artifact" data-artifact={kind} className={`my-3 flex flex-col overflow-hidden rounded-xl border border-hx-border bg-hx-bg ${fill ? 'h-full' : ''}`}>
      <figcaption className="flex items-center gap-2 border-b border-hx-border-subtle px-2.5 py-1.5">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name={ICON[kind]} size={14} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-hx-primary">{name}</span>
          <span className="block text-[11px] text-hx-muted">{label[kind]}{streaming ? ' · writing…' : ''}</span>
        </span>
        <Tabs size="sm" value={tab} onChange={(t) => setTab(t as 'preview' | 'code')} tabs={[{ id: 'preview', label: 'Preview' }, { id: 'code', label: 'Code' }]} />
        {host.openPanel && !fill && <IconButton size="xs" icon="panel-right" label="Open in the side panel" onClick={() => host.openPanel!({ title: name, kind, source, language: language ?? kind })} />}
        <IconButton size="xs" icon={copied ? 'check' : 'copy'} label="Copy the source" onClick={() => void copyText(source).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); } })} />
        <IconButton size="xs" icon="download" label="Download" onClick={() => downloadText(`${slug(name)}.${kind === 'react' ? (language === 'tsx' ? 'tsx' : 'jsx') : kind === 'diagram' ? 'diagram.json' : kind}`, source)} />
      </figcaption>
      <div className={fill ? 'min-h-0 flex-1' : ''}>
        {tab === 'code' || streaming
          ? <div className="max-h-[480px] overflow-auto [&_figure]:my-0 [&_figure]:rounded-none [&_figure]:border-0"><CodeBlock code={source} language={language ?? (kind === 'react' ? 'jsx' : kind === 'svg' ? 'xml' : kind === 'diagram' ? 'json' : 'html')} collapseAt={1e9} streaming={streaming} /></div>
          : <ArtifactPreview kind={kind} source={source} fill={fill} title={name} custom={custom} />}
      </div>
    </figure>
  );
});

function ArtifactPreview({ kind, source, fill, title, custom }: { kind: ArtifactKind; source: string; fill?: boolean; title: string; custom: ArtifactRenderer }): React.ReactElement {
  const drawn = custom(kind, source, { title, fill });
  if (drawn !== undefined && drawn !== null) {
    return <RenderBoundary fallback={(e, retry) => <div className="p-3 text-[12px] text-hx-danger" data-render-error>The renderer for {label[kind]} failed: {e} <button type="button" className="underline" onClick={retry}>Try again</button></div>}><div data-artifact-renderer className={fill ? 'h-full' : ''}>{drawn}</div></RenderBoundary>;
  }
  return kind === 'diagram' ? <DiagramPlaceholder source={source} /> : <ArtifactFrame kind={kind} source={source} fill={fill} />;
}

/** The reserved `diagram` kind before its plugin is installed: the JSON, readable, with a note. */
export function DiagramPlaceholder({ source }: { source: string }): React.ReactElement {
  let json = true;
  try { JSON.parse(source); } catch { json = false; }
  return (
    <div data-diagram-placeholder className="p-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-hx-muted"><Icon name="info" size={12} />diagram (interactive view coming)</div>
      <div className="max-h-[420px] overflow-auto [&_figure]:my-0">{json ? <JsonView source={source} /> : <CodeBlock code={source} language="text" />}</div>
    </div>
  );
}

export function ArtifactFrame({ kind, source, fill }: { kind: FramedArtifactKind; source: string; fill?: boolean }): React.ReactElement {
  const doc = useMemo(() => artifactDocument(kind, source, { runtimeUrl: host.runtimeUrl }), [kind, source]);
  return <SandboxFrame doc={doc} scripted={kind !== 'svg'} label={`${label[kind]} preview`} marker={kind} fill={fill} initialHeight={kind === 'svg' ? 320 : 360} />;
}

/**
 * A document in a sandboxed frame: never allow-same-origin; with scripts only when `scripted`, then
 * served from the host's isolated preview origin when it has one.
 */
export function SandboxFrame({ doc, scripted, label: title, marker, fill, initialHeight = 360, fixedHeight }: { doc: string; scripted: boolean; label: string; marker: string; fill?: boolean; initialHeight?: number; fixedHeight?: boolean }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState(initialHeight);
  const frame = useRef<HTMLIFrameElement>(null);
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
      if (!fixedHeight && d && d.harnessArtifact === 'size' && typeof d.height === 'number') setHeight(Math.min(1200, Math.max(80, d.height + 4)));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [fixedHeight]);
  const waiting = scripted && !!host.register && !url;
  return (
    <div className={`relative bg-white ${fill ? 'h-full' : ''}`} style={fill ? undefined : { height, resize: 'vertical', overflow: 'hidden', minHeight: 80 }}>
      {waiting ? <div className="p-4 text-[12px] text-neutral-500">Preparing preview…</div> : (
        <iframe
          ref={frame}
          key={url ?? 'srcdoc'}
          title={title}
          // Never allow-same-origin: the frame gets an opaque origin, whatever it runs.
          sandbox={scripted ? 'allow-scripts' : ''}
          referrerPolicy="no-referrer"
          {...(url ? { src: url } : { srcDoc: doc })}
          className="h-full w-full border-0"
          data-artifact-frame={marker}
        />
      )}
    </div>
  );
}

function guessTitle(kind: ArtifactKind, source: string): string {
  const t = /<title>([^<]{1,80})<\/title>/i.exec(source)?.[1] ?? /<h1[^>]*>([^<]{1,80})<\/h1>/i.exec(source)?.[1] ?? /export\s+default\s+function\s+([A-Za-z0-9_]+)/.exec(source)?.[1];
  if (kind === 'diagram') { try { const d = JSON.parse(source) as { title?: unknown }; if (typeof d.title === 'string' && d.title.trim()) return d.title.trim().slice(0, 80); } catch { /* not JSON */ } return 'Diagram'; }
  return t?.trim() || (kind === 'react' ? 'Component' : kind === 'svg' ? 'Drawing' : 'Page');
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'artifact';
