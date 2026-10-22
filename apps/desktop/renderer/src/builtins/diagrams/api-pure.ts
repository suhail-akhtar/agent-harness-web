/** core.diagrams' pure helpers (no engine, no DOM): the ask message and the marks between two versions. */

import { describeDiff, diffDiagrams, validateDiagram } from '@harness/plugin-ui';

/** What the canvas's ask box sends: the request, the artifact to change, and how. */
export function askMessage(request: string, a: { id?: string; title?: string; version?: number }): string {
  if (a.id) {
    return `${request.trim()}\n\n(About the diagram artifact "${a.title ?? a.id}", id ${a.id}${a.version ? `, now v${a.version}` : ''}. Change it with the artifact tool: get it first, then update it with an exact find/replace or rewrite it. Keep the ids of the boxes that stay and leave layout.positions as they are; load the diagrams skill if you need the spec.)`;
  }
  return `${request.trim()}\n\n(About the diagram "${a.title ?? 'in your last answer'}" in a \`\`\`diagram block. Save the changed diagram as an artifact of kind "diagram" with the artifact tool, keeping the ids of the boxes that stay; load the diagrams skill if you need the spec.)`;
}

export interface Changed { nodes: string[]; edges: string[]; note: string }

/** The marks between two versions (positions do not count). */
export function changedBetween(prev: string, next: string, version: number): Changed | null {
  const a = validateDiagram(prev).spec; const b = validateDiagram(next).spec;
  if (!a || !b) return null;
  const d = diffDiagrams(a, b);
  if (!d.marked.length && !d.edgesAdded.length && !d.removed.length && !d.edgesRemoved) return null;
  return { nodes: d.marked, edges: d.edgesAdded, note: `v${version}: ${describeDiff(d, b)}` };
}

