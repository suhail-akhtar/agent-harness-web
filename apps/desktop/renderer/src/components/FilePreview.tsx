/** A file's content drawn by what it is: Markdown, a table, a JSON tree, a live artifact, or code. */

import React from 'react';
import { FencedBlock, Markdown } from '@harness/ui';

const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

export function FilePreview({ path, content, fill }: { path: string; content: string; fill?: boolean }): React.ReactElement {
  const ext = extOf(path);
  if (/^(png|jpe?g|gif|webp|bmp|ico)$/.test(ext)) return <p className="p-2 text-[12px] text-hx-muted">An image: open it from the workspace.</p>;
  if (ext === 'md' || ext === 'markdown') return <div className={fill ? 'p-3' : 'max-h-96 overflow-auto p-2'}><Markdown text={content} /></div>;
  // JSON, CSV/TSV, HTML, SVG, React components, diffs and code: the same renderers as a fenced block.
  return <FencedBlock lang={ext === 'htm' ? 'html' : ext} source={content} />;
}
