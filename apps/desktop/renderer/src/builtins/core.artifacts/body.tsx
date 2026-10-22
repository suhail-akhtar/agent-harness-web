/**
 * An artifact's content drawn by its kind, with the renderers of @harness/ui (and a plugin's
 * renderer for the kind first): html, svg and react run in the sandboxed frame (opaque origin, no
 * network); Markdown, Mermaid, charts, CSV and JSON as in the transcript; code highlighted; images
 * shown; PDFs downloaded. Also what copy and download need.
 */

import React from 'react';
import { ArtifactFrame, CodeBlock, DiagramPlaceholder, EmptyState, FencedBlock, JsonView, Markdown, RenderBoundary, copyText, downloadText, toast } from '@harness/ui';
import type { ArtifactContent } from '@harness/client';
import { useArtifactRenderer, useFenceRenderer } from '../../registry/renderers';

/** The file extension of a kind (for downloads), as the server stores it. */
export function extensionOf(kind: string, language?: string, contentType?: string): string {
  switch (kind) {
    case 'markdown': return 'md';
    case 'html': return 'html';
    case 'svg': return 'svg';
    case 'react': return language === 'tsx' ? 'tsx' : 'jsx';
    case 'mermaid': return 'mmd';
    case 'csv': return 'csv';
    case 'json': case 'chart': case 'diagram': return 'json';
    case 'pdf': return 'pdf';
    case 'image': return /png/.test(contentType ?? '') ? 'png' : /jpe?g/.test(contentType ?? '') ? 'jpg' : /gif/.test(contentType ?? '') ? 'gif' : /webp/.test(contentType ?? '') ? 'webp' : 'png';
    default: return ({ javascript: 'js', typescript: 'ts', python: 'py', rust: 'rs', shell: 'sh', bash: 'sh', yaml: 'yaml', css: 'css', go: 'go', java: 'java', sql: 'sql' } as Record<string, string>)[(language ?? '').toLowerCase()] ?? 'txt';
  }
}

/** The language a kind's source is highlighted as. */
export function codeLanguage(kind: string, language?: string): string {
  return ({ markdown: 'markdown', html: 'html', svg: 'xml', react: language === 'tsx' ? 'tsx' : 'jsx', mermaid: 'mermaid', csv: 'csv', json: 'json', chart: 'json', diagram: 'json' } as Record<string, string>)[kind] ?? language ?? 'text';
}

/** Kinds that have a text source (everything but images and PDFs). */
export const isText = (kind: string) => kind !== 'image' && kind !== 'pdf';

export function saveArtifact(c: ArtifactContent, title: string): void {
  const name = `${title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || c.meta.id}-v${c.version}.${extensionOf(c.meta.kind, c.meta.language, c.contentType)}`;
  if (c.base64 !== undefined) {
    const bytes = Uint8Array.from(atob(c.base64), (ch) => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: c.contentType }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } else downloadText(name, c.content ?? '', c.contentType || 'text/plain;charset=utf-8');
  toast(`Saved ${name}`, { kind: 'success' });
}

export function copyArtifact(c: ArtifactContent): void {
  if (c.content === undefined) { toast('Only text artifacts can be copied; download this one.', { kind: 'info' }); return; }
  void copyText(c.content).then((ok) => toast(ok ? 'Copied' : 'Could not copy', { kind: ok ? 'success' : 'error' }));
}

/** The preview of one version. */
export function ArtifactBody({ c, title, fill }: { c: ArtifactContent; title: string; fill?: boolean }): React.ReactElement {
  const fence = useFenceRenderer();
  const custom = useArtifactRenderer();
  const kind = c.meta.kind;
  const source = c.content ?? '';
  const drawn = (() => {
    const plugin = isText(kind) ? custom(kind as never, source, { title, fill }) : undefined;
    if (plugin !== undefined && plugin !== null) return <div data-artifact-renderer className={fill ? 'h-full' : ''}>{plugin}</div>;
    switch (kind) {
      case 'html': case 'svg': case 'react': return <ArtifactFrame kind={kind} source={source} fill={fill} />;
      case 'diagram': return <DiagramPlaceholder source={source} />;
      case 'markdown': return <div className="px-1"><Markdown text={source} renderFence={fence} /></div>;
      case 'mermaid': return <FencedBlock lang="mermaid" source={source} renderFence={fence} />;
      case 'chart': return <FencedBlock lang="chart" source={source} renderFence={fence} />;
      case 'csv': return <FencedBlock lang="csv" source={source} renderFence={fence} />;
      case 'json': return <JsonView source={source} />;
      case 'code': return <CodeBlock code={source} language={c.meta.language ?? 'text'} collapseAt={1e9} />;
      case 'image': return c.base64 ? <img data-artifact-image src={`data:${c.contentType};base64,${c.base64}`} alt={title} className="mx-auto max-h-full max-w-full rounded-lg" /> : <EmptyState icon="image" title="No image data" />;
      case 'pdf': return <EmptyState icon="file" title="A PDF document" action={<span className="text-[12px] text-hx-muted">Download it to read it.</span>}>{`${Math.round((c.base64?.length ?? 0) * 0.75 / 1024)} KB`}</EmptyState>;
      default: return <CodeBlock code={source} language={codeLanguage(kind, c.meta.language)} collapseAt={1e9} />;
    }
  })();
  return (
    <RenderBoundary fallback={(e, retry) => <div className="p-3 text-[12.5px] text-hx-danger" data-render-error>This artifact could not be drawn: {e} <button type="button" className="underline" onClick={retry}>Try again</button></div>}>
      <div data-artifact-body={kind} className={fill ? 'h-full min-h-0' : ''}>{drawn}</div>
    </RenderBoundary>
  );
}
