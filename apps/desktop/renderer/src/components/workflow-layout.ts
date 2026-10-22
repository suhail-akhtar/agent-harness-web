/**
 * A simple layered layout for a workflow run's graph: layers by distance from the start node (top
 * to bottom), nodes in a layer side by side, edges that go back up (a fix loop) marked so they are
 * drawn around the side. Nodes the start never reaches go last. Pure; unit-tested.
 */

export interface GraphNode { id: string; type: string; title?: string; agent?: string; model?: string; next?: string[] }
export interface Placed { id: string; layer: number; index: number; x: number; y: number }
export interface Edge { from: string; to: string; back: boolean }
export interface Layout { layers: string[][]; nodes: Record<string, Placed>; edges: Edge[]; width: number; height: number }

export const NODE_W = 168;
export const NODE_H = 52;
const GAP_X = 28;
const GAP_Y = 40;
const PAD = 16;

export function layoutWorkflow(nodes: GraphNode[], start?: string): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const first = start && byId.has(start) ? start : nodes[0]?.id;
  const layer = new Map<string, number>();
  const order: string[] = [];
  if (first) {
    layer.set(first, 0);
    const queue = [first];
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const to of byId.get(id)?.next ?? []) {
        if (!byId.has(to) || layer.has(to)) continue;
        layer.set(to, layer.get(id)! + 1);
        queue.push(to);
      }
    }
  }
  // Unreached nodes (an old run of a changed workflow, a node only an outcome we do not know reaches): a last layer.
  const deepest = Math.max(-1, ...layer.values());
  for (const n of nodes) if (!layer.has(n.id)) { layer.set(n.id, deepest + 1); order.push(n.id); }
  const layers: string[][] = [];
  for (const id of order) (layers[layer.get(id)!] ??= []).push(id);
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];
  const widest = Math.max(1, ...layers.map((l) => l.length));
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * GAP_X;
  const placed: Record<string, Placed> = {};
  layers.forEach((ids, li) => {
    const row = ids.length * NODE_W + (ids.length - 1) * GAP_X;
    const x0 = (width - row) / 2;
    ids.forEach((id, i) => { placed[id] = { id, layer: li, index: i, x: x0 + i * (NODE_W + GAP_X), y: PAD + li * (NODE_H + GAP_Y) }; });
  });
  const edges: Edge[] = [];
  for (const n of nodes) for (const to of n.next ?? []) if (placed[to] && placed[n.id]) edges.push({ from: n.id, to, back: placed[to]!.layer <= placed[n.id]!.layer });
  return { layers, nodes: placed, edges, width, height: PAD * 2 + layers.length * NODE_H + Math.max(0, layers.length - 1) * GAP_Y };
}

/** The SVG path of an edge: straight down between layers, around the right side for one going back. */
export function edgePath(l: Layout, e: Edge): string {
  const a = l.nodes[e.from]!;
  const b = l.nodes[e.to]!;
  if (!e.back) {
    const x1 = a.x + NODE_W / 2; const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2; const y2 = b.y;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  const x1 = a.x + NODE_W; const y1 = a.y + NODE_H / 2;
  const x2 = b.x + NODE_W; const y2 = b.y + NODE_H / 2;
  const out = Math.max(x1, x2) + 26 + 8 * Math.abs(a.layer - b.layer);
  return `M${x1},${y1} C${out},${y1} ${out},${y2} ${x2},${y2}`;
}

/** A node's state in a run: the latest step of it in the history. */
export function nodeState(history: Array<{ node: string; status: string; outcome?: string }>, id: string, current?: string): { status: string; outcome?: string; runs: number } {
  const steps = history.filter((h) => h.node === id);
  const last = steps.at(-1);
  if (!last) return { status: current === id ? 'running' : 'pending', runs: 0 };
  return { status: last.status, ...(last.outcome ? { outcome: last.outcome } : {}), runs: steps.length };
}
