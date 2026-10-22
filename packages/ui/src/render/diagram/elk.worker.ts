/**
 * ELK (elkjs, pinned in packages/ui/package.json) off the window's thread: `{id, graph}` in,
 * `{id, result}` or `{id, error}` out. One worker serves every diagram on the page.
 */

import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

self.onmessage = (ev: MessageEvent<{ id: number; graph: unknown }>) => {
  const { id, graph } = ev.data;
  elk.layout(graph as Parameters<typeof elk.layout>[0]).then(
    (result) => (self as unknown as Worker).postMessage({ id, result }),
    (e: unknown) => (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) }),
  );
};
