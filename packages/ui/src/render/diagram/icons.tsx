/**
 * The glyph of each node kind (and of groups), on a 24-unit grid with a 1.75 stroke: drawn inside a
 * card's icon square with the kind's tone as currentColor. Plain SVG elements, so an exported drawing
 * carries them as they are.
 */

import React from 'react';
import type { GroupKind, NodeKind } from '@harness/plugin-ui';

const G: Record<string, React.ReactNode> = {
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  'web-app': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /><path d="M6.5 6.5h.01M9 6.5h.01" /></>,
  'mobile-app': <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  'desktop-app': <><rect x="2.5" y="4" width="19" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  api: <><path d="M8 7 3 12l5 5" /><path d="m16 7 5 5-5 5" /><path d="m13.5 5-3 14" /></>,
  service: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></>,
  function: <><path d="M10 20c2 0 2.5-2 3-6l1-6c.5-3 1.2-4 3-4" /><path d="M8 11h8" /></>,
  worker: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  'batch-job': <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2" /><path d="M9 2.5h6" /></>,
  'relational-db': <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  'document-db': <><path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5Z" /><path d="M14 2.5v5h5" /><path d="M9 12.5h6M9 16h6" /></>,
  'key-value': <><circle cx="8" cy="14" r="4" /><path d="m11 11 9-9M17 5l2 2M15 7l2 2" /></>,
  cache: <><path d="M13 2.5 4.5 13.5H12L11 21.5l8.5-11H12Z" /></>,
  queue: <><rect x="3" y="6" width="4.5" height="12" rx="1" /><rect x="9.75" y="6" width="4.5" height="12" rx="1" /><rect x="16.5" y="6" width="4.5" height="12" rx="1" /></>,
  stream: <><path d="M3 8c3-3 6 3 9 0s6 3 9 0" /><path d="M3 14c3-3 6 3 9 0s6 3 9 0" /><path d="M3 20c3-3 6 3 9 0s6 3 9 0" /></>,
  storage: <><path d="M4 7h16l-1.5 12.5a2 2 0 0 1-2 1.5h-9a2 2 0 0 1-2-1.5Z" /><ellipse cx="12" cy="7" rx="8" ry="3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m20 20-4.8-4.8" /></>,
  'reverse-proxy': <><path d="M3 8h13" /><path d="m13 5 3 3-3 3" /><path d="M21 16H8" /><path d="m11 13-3 3 3 3" /></>,
  'load-balancer': <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="12" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5v9M10.5 7 6 16.8M13.5 7l4.5 9.8" /></>,
  gateway: <><path d="M4 21V9l8-6 8 6v12" /><path d="M9 21v-7h6v7" /></>,
  cdn: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" /><circle cx="12" cy="12" r="2" /></>,
  dns: <><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></>,
  secrets: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.5" /></>,
  identity: <><path d="M12 2.5 4 6v6c0 5 3.5 8.2 8 9.5 4.5-1.3 8-4.5 8-9.5V6Z" /><circle cx="12" cy="10.5" r="2.5" /><path d="M8 17a4 4 0 0 1 8 0" /></>,
  monitoring: <><path d="M3 12h4l3-8 4 16 3-8h4" /></>,
  'external-system': <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M10 14 20 4" /><path d="M14 4h6v6" /></>,
  internet: <><path d="M17.5 19H8a6 6 0 1 1 5.6-8.2A4.5 4.5 0 1 1 17.5 19Z" /></>,
  browser: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5h8.5M9 13.8 4.8 6.4M15 13.8l-4.2 7.2" /></>,
  device: <><rect x="5" y="2.5" width="14" height="19" rx="2.5" /><circle cx="12" cy="17.5" r="1" /></>,
  folder: <path d="M20 19a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />,
  file: <><path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5Z" /><path d="M14 2.5v5h5" /></>,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9.5h18M3 15h18M9.5 9.5V20" /></>,
  container: <><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7Z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></>,
  custom: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  // Groups.
  host: <><rect x="3" y="3" width="18" height="7" rx="1.5" /><rect x="3" y="14" width="18" height="7" rx="1.5" /><path d="M7 6.5h.01M7 17.5h.01" /></>,
  network: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" /><path d="M12 7.5v5M12 12.5 5 16.5M12 12.5l7 4" /></>,
  zone: <><path d="M12 2.5 4 6v6c0 5 3.5 8.2 8 9.5 4.5-1.3 8-4.5 8-9.5V6Z" /></>,
  subnet: <><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="3 3" /><path d="M8 12h8" /></>,
  cluster: <><circle cx="12" cy="12" r="3" /><circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="18" r="2" /><path d="M7 7.3 9.6 10M17 7.3 14.4 10M7 16.7l2.6-2.7M17 16.7 14.4 14" /></>,
  region: <><circle cx="12" cy="12" r="9" /><path d="M3.5 9h17M3.5 15h17" /><path d="M12 3c-2.5 3-2.5 15 0 18M12 3c2.5 3 2.5 15 0 18" /></>,
  boundary: <><rect x="3" y="3" width="18" height="18" rx="3" strokeDasharray="4 3" /></>,
  // Interface.
  check: <path d="M20 6 9 17l-5-5" />,
};

export function glyphFor(kind: NodeKind | GroupKind | string): React.ReactNode { return G[kind] ?? G.custom; }

/** A glyph placed at (x, y), `size` units square, stroked with currentColor. */
export function Glyph({ kind, x, y, size = 20, color }: { kind: string; x: number; y: number; size?: number; color?: string }): React.ReactElement {
  const s = size / 24;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} fill="none" stroke={color ?? 'currentColor'} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {glyphFor(kind)}
    </g>
  );
}
