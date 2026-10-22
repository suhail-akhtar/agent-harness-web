/**
 * Where everything in a diagram goes: node boxes, group boxes around their members, orthogonal
 * edge routes and the label pill on each edge.
 *
 * Three ways to get there, one result (a Scene):
 *  - **ELK** (layered, orthogonal routing, groups as compound nodes): the normal case, run in a
 *    worker (elk.ts) so a 300-node diagram lays out without the window stalling.
 *  - **layered** (AICO's Sugiyama layout, layered.ts), group by group from the inside out: the
 *    fallback when ELK cannot run, and the synchronous path (tests, a first paint on the server).
 *  - **positions**: the boxes stay where they were (saved positions in the spec, or the previous
 *    version's layout) and only new nodes are placed, next to their neighbours, in free space. So a
 *    small change to a diagram never moves everything; edges whose ends did not move keep their routes.
 *
 * Pure apart from the ELK call: no DOM, no React.
 */

import { directionOf, NODE_CAPTIONS, type DiagramEdge, type DiagramGroup, type DiagramNode, type DiagramSpec } from '@harness/plugin-ui';
import { layered } from './layered.ts';

export type Dir = 'right' | 'down' | 'left' | 'up';
export interface Rect { x: number; y: number; w: number; h: number }

export interface SceneNode extends Rect {
  id: string;
  /** The group it sits in (a visible one). */
  parent?: string;
  node?: DiagramNode;
  /** A collapsed group drawn as one card. */
  collapsed?: DiagramGroup;
  /** Nodes folded into a collapsed group. */
  members?: number;
}
export interface SceneGroup extends Rect { id: string; group: DiagramGroup; depth: number }
export interface EdgeLabel extends Rect { text: string }
export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  /** The route: [x0, y0, x1, y1, ...] from the source's border to the target's. */
  points: number[];
  label?: EdgeLabel;
  edge: DiagramEdge;
  /** Edges bundled into this one (by a collapsed group). */
  count: number;
  /** The spec edges it stands for. */
  ids: string[];
}
export interface Scene {
  nodes: SceneNode[];
  groups: SceneGroup[];
  edges: SceneEdge[];
  bounds: Rect;
  dir: Dir;
  engine: 'elk' | 'layered' | 'positions';
}

/** The id of the card a collapsed group becomes (not a valid spec id, so it never clashes). */
export const collapsedId = (group: string) => `#g:${group}`;
export const isCollapsedId = (id: string) => id.startsWith('#g:');

// ---------------- sizes ----------------

export const GROUP_PAD = { top: 48, side: 18, bottom: 18 };
export const TABLE_ROWS = 8;
const ROW_H = 22;
const textW = (s: string | undefined, per: number) => (s ? s.length * per : 0);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The caption a node's card shows ("RELATIONAL DATABASE"). */
export function captionOf(n: DiagramNode): string {
  return NODE_CAPTIONS[n.kind] ?? 'Component';
}

/** Card lines below the title: technology, size, address. */
export function detailLines(n: DiagramNode): string[] {
  return [n.tech, n.size, n.address].filter((x): x is string => !!x);
}

/** The box a node needs. */
export function nodeSize(n: DiagramNode): { w: number; h: number } {
  if (n.kind === 'person') return { w: Math.round(clamp(74 + Math.max(textW(n.title, 7.6), textW(n.tech, 6.3)), 180, 300)), h: n.tech ? 60 : 50 };
  if (n.fields?.length || n.kind === 'table') {
    const fields = n.fields ?? [];
    const rows = Math.min(fields.length, TABLE_ROWS) + (fields.length > TABLE_ROWS ? 1 : 0);
    const widest = fields.slice(0, TABLE_ROWS).reduce((m, f) => Math.max(m, 58 + textW(f.name, 6.9) + textW(f.type, 6.2) + (f.pii ? 30 : 0)), 0);
    return { w: Math.round(clamp(Math.max(70 + textW(n.title, 7.8), widest), 230, 340)), h: 48 + rows * ROW_H + (rows ? 6 : 0) };
  }
  const lines = detailLines(n);
  // The icon square on the left; the status badge's corner on the right.
  const w = clamp(64 + Math.max(textW(n.title, 7.5), textW(captionOf(n), 6.4) + 8, ...lines.map((l) => textW(l, 6.4))) + 34, 220, 320);
  return { w: Math.round(w), h: Math.max(66, 46 + lines.length * 16 + 4) };
}

export const COLLAPSED_SIZE = { w: 240, h: 66 };

/** A group is at least as wide as its header ("DMZ ZONE  subnet dmz 10.42.10.0/24" and the collapse button). */
export function groupMinWidth(g: DiagramGroup): number {
  return Math.round(38 + g.label.length * 7.4 + (g.subtitle ? 12 + g.subtitle.length * 6.1 : 0) + 44);
}

/** The pill an edge label sits in. */
export function labelSize(text: string): { w: number; h: number } { return { w: Math.round(Math.min(260, text.length * 6.1 + 14)), h: 18 }; }

/** What an edge's pill says: its label, and how many when it bundles several. */
export function edgeText(e: DiagramEdge, count: number): string | undefined {
  const n = Math.max(count, e.count ?? 1);
  if (e.label && n > 1) return `${e.label} ×${n}`;
  if (e.label) return e.label;
  return n > 1 ? String(n) : undefined;
}

// ---------------- the visible graph (collapsed groups folded) ----------------

export interface VNode { id: string; w: number; h: number; parent?: string; node?: DiagramNode; collapsed?: DiagramGroup; members?: number }
export interface VEdge { id: string; from: string; to: string; edge: DiagramEdge; count: number; ids: string[]; text?: string }
export interface VisibleGraph { nodes: VNode[]; groups: DiagramGroup[]; edges: VEdge[]; dir: Dir; spacing: 'compact' | 'normal' | 'wide'; groupParent: Map<string, string | undefined> }

/** The graph as drawn: nodes inside a collapsed group folded into one card, their edges bundled. `collapsed` (when given) replaces the spec's own `collapsed` flags. */
export function visibleGraph(spec: DiagramSpec, collapsed?: ReadonlySet<string>): VisibleGraph {
  const groups = spec.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const isCollapsed = (id: string) => (collapsed ? collapsed.has(id) : byId.get(id)?.collapsed === true);
  /** The outermost collapsed group around (or at) a group. */
  const foldOf = (gid: string | undefined): string | undefined => {
    let out: string | undefined;
    for (let g = gid; g; g = byId.get(g)?.parent) if (isCollapsed(g)) out = g;
    return out;
  };
  const owner = new Map<string, string>();
  const nodes: VNode[] = [];
  const folded = new Map<string, number>();
  for (const n of spec.nodes) {
    const f = foldOf(n.group);
    if (f) { owner.set(n.id, collapsedId(f)); folded.set(f, (folded.get(f) ?? 0) + 1); continue; }
    nodes.push({ id: n.id, ...nodeSize(n), ...(n.group ? { parent: n.group } : {}), node: n });
  }
  const visibleGroups: DiagramGroup[] = [];
  for (const g of groups) {
    const f = foldOf(g.id);
    if (f === g.id) nodes.push({ id: collapsedId(g.id), ...COLLAPSED_SIZE, ...(g.parent ? { parent: g.parent } : {}), collapsed: g, members: folded.get(g.id) ?? 0 });
    else if (!f) visibleGroups.push(g);
  }
  // Groups with nothing visible inside are not drawn.
  const used = new Set<string>();
  for (const n of nodes) for (let g = n.parent; g && !used.has(g); g = byId.get(g)?.parent) used.add(g);
  const keptGroups = visibleGroups.filter((g) => used.has(g.id));
  const edges: VEdge[] = [];
  const bundles = new Map<string, VEdge>();
  for (const e of spec.edges ?? []) {
    const from = owner.get(e.from) ?? e.from;
    const to = owner.get(e.to) ?? e.to;
    if (from === to) continue;
    if (from === e.from && to === e.to) { edges.push({ id: e.id, from, to, edge: e, count: e.count ?? 1, ids: [e.id] }); continue; }
    const k = `${from}\u0000${to}`;
    const b = bundles.get(k);
    if (b) { b.count += e.count ?? 1; b.ids.push(e.id); if (b.edge.label !== e.label) b.edge = { ...b.edge, label: undefined }; if (!e.async) b.edge = { ...b.edge, async: false }; continue; }
    const v: VEdge = { id: `#b:${from}>${to}`, from, to, edge: { ...e, id: `#b:${from}>${to}`, from, to }, count: e.count ?? 1, ids: [e.id] };
    bundles.set(k, v);
    edges.push(v);
  }
  for (const e of edges) e.text = edgeText(e.edge, e.count);
  return { nodes, groups: keptGroups, edges, dir: directionOf(spec), spacing: spec.layout?.spacing ?? 'normal', groupParent: new Map(keptGroups.map((g) => [g.id, g.parent && used.has(g.parent) ? g.parent : undefined])) };
}

// ---------------- ELK ----------------

/** The JSON graph ELK lays out (groups as compound nodes; every coordinate comes back absolute). */
export interface ElkGraph { id: string; layoutOptions?: Record<string, string>; children?: ElkGraph[]; edges?: Array<{ id: string; sources: string[]; targets: string[]; labels?: Array<{ id: string; text: string; width: number; height: number }> }>; width?: number; height?: number }
export interface ElkResult { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkResult[]; edges?: Array<{ id: string; sections?: Array<{ startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }>; labels?: Array<{ x?: number; y?: number; width?: number; height?: number; text?: string }> }> }

const ELK_DIR: Record<Dir, string> = { right: 'RIGHT', down: 'DOWN', left: 'LEFT', up: 'UP' };
const SPACING = { compact: { node: 26, layer: 64 }, normal: { node: 40, layer: 96 }, wide: { node: 60, layer: 140 } };
const GROUP_PREFIX = '#grp:';

export function toElk(vg: VisibleGraph): ElkGraph {
  const sp = SPACING[vg.spacing];
  const kids = new Map<string | undefined, ElkGraph[]>();
  const push = (parent: string | undefined, c: ElkGraph) => { (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(c); };
  for (const n of vg.nodes) push(n.parent, { id: n.id, width: n.w, height: n.h });
  const build = (gid: string | undefined): ElkGraph[] => {
    const out = [...(kids.get(gid) ?? [])];
    for (const g of vg.groups) {
      if (vg.groupParent.get(g.id) !== gid) continue;
      out.push({ id: GROUP_PREFIX + g.id, layoutOptions: { 'elk.padding': `[top=${GROUP_PAD.top},left=${GROUP_PAD.side},bottom=${GROUP_PAD.bottom},right=${GROUP_PAD.side}]`, 'elk.nodeSize.constraints': '[MINIMUM_SIZE]', 'elk.nodeSize.minimum': `(${groupMinWidth(g)}, 60)` }, children: build(g.id) });
    }
    return out;
  };
  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': ELK_DIR[vg.dir], 'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT', 'elk.json.shapeCoords': 'ROOT',
      'elk.spacing.nodeNode': String(sp.node), 'elk.layered.spacing.nodeNodeBetweenLayers': String(sp.layer),
      'elk.spacing.edgeNode': '22', 'elk.spacing.edgeEdge': '14', 'elk.layered.spacing.edgeNodeBetweenLayers': '22', 'elk.layered.spacing.edgeEdgeBetweenLayers': '12',
      'elk.spacing.edgeLabel': '3', 'elk.edgeLabels.inline': 'true',
      // The author's order steadies small diagrams; on large ones it costs seconds (ELK's hierarchical crossing minimisation), so it is left out there.
      'elk.layered.considerModelOrder.strategy': vg.nodes.length <= 80 && vg.edges.length <= 160 ? 'NODES_AND_EDGES' : 'NONE', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF', 'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.separateConnectedComponents': 'true', 'elk.spacing.componentComponent': '64', 'elk.padding': '[top=24,left=24,bottom=24,right=24]',
    },
    children: build(undefined),
    edges: vg.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to], ...(e.text ? { labels: [{ id: `${e.id}#l`, text: e.text, ...dims(labelSize(e.text)) }] } : {}) })),
  };
}
const dims = (s: { w: number; h: number }) => ({ width: s.w, height: s.h });

export function fromElk(r: ElkResult, vg: VisibleGraph): Scene {
  const rects = new Map<string, Rect>();
  const walk = (n: ElkResult) => { for (const c of n.children ?? []) { rects.set(c.id, { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 }); walk(c); } };
  walk(r);
  const nodes: SceneNode[] = vg.nodes.map((n) => ({ ...strip(n), ...(rects.get(n.id) ?? { x: 0, y: 0, w: n.w, h: n.h }) }));
  const depthOf = depthFn(vg);
  const groups: SceneGroup[] = vg.groups.flatMap((g) => { const b = rects.get(GROUP_PREFIX + g.id); return b ? [{ id: g.id, group: g, depth: depthOf(g.id), ...b }] : []; });
  const byEdge = new Map((r.edges ?? []).map((e) => [e.id, e]));
  const nodeRect = new Map(nodes.map((n) => [n.id, n as Rect]));
  const edges: SceneEdge[] = vg.edges.map((e) => {
    const out = byEdge.get(e.id);
    const s = out?.sections?.[0];
    const points = s ? [s.startPoint.x, s.startPoint.y, ...(s.bendPoints ?? []).flatMap((p) => [p.x, p.y]), s.endPoint.x, s.endPoint.y] : simpleRoute(nodeRect.get(e.from)!, nodeRect.get(e.to)!, vg.dir);
    const l = out?.labels?.[0];
    const label = e.text ? (l && l.x !== undefined ? { x: l.x, y: l.y ?? 0, w: l.width ?? labelSize(e.text).w, h: l.height ?? 18, text: e.text } : labelAt(points, e.text)) : undefined;
    return { id: e.id, from: e.from, to: e.to, points: points.map(round1), ...(label ? { label } : {}), edge: e.edge, count: e.count, ids: e.ids };
  });
  return finish({ nodes, groups, edges, dir: vg.dir, engine: 'elk' });
}

const round1 = (v: number) => Math.round(v * 10) / 10;
function strip(n: VNode): Omit<SceneNode, 'x' | 'y'> {
  return { id: n.id, w: n.w, h: n.h, ...(n.parent ? { parent: n.parent } : {}), ...(n.node ? { node: n.node } : {}), ...(n.collapsed ? { collapsed: n.collapsed, members: n.members } : {}) };
}
function depthFn(vg: VisibleGraph): (g: string) => number {
  return (g) => { let d = 0; for (let p = vg.groupParent.get(g); p; p = vg.groupParent.get(p)) d++; return d; };
}

function finish(s: Omit<Scene, 'bounds'>): Scene {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  const take = (r: Rect) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
  s.nodes.forEach(take); s.groups.forEach(take);
  for (const e of s.edges) { for (let i = 0; i < e.points.length; i += 2) take({ x: e.points[i]!, y: e.points[i + 1]!, w: 0, h: 0 }); if (e.label) take(e.label); }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
  // Groups first (outermost first), so inner ones draw on top.
  s.groups.sort((a, b) => a.depth - b.depth);
  return { ...s, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

// ---------------- the layered fallback ----------------

/** Lays out each group's content with layered.ts from the inside out, then routes every edge. */
export function layeredScene(vg: VisibleGraph): Scene {
  const sp = SPACING[vg.spacing];
  const horizontal = vg.dir === 'right' || vg.dir === 'left';
  const size = new Map<string, { w: number; h: number }>();
  const rel = new Map<string, { x: number; y: number }>();
  const groupOf = new Map(vg.nodes.map((n) => [n.id, n.parent]));
  /** The item directly inside `container` that holds node `id` (itself, or a group around it). */
  const itemIn = (id: string, container: string | undefined): string | undefined => {
    let g = groupOf.get(id);
    if (g === container) return id;
    while (g !== undefined) {
      const p = vg.groupParent.get(g);
      if (p === container) return GROUP_PREFIX + g;
      g = p;
    }
    return undefined;
  };
  const lay = (container: string | undefined): { w: number; h: number } => {
    const items: string[] = [];
    for (const g of vg.groups) if (vg.groupParent.get(g.id) === container) { size.set(GROUP_PREFIX + g.id, lay(g.id)); items.push(GROUP_PREFIX + g.id); }
    for (const n of vg.nodes) if (n.parent === container) { size.set(n.id, { w: n.w, h: n.h }); items.push(n.id); }
    // Nodes first, in spec order, then groups: the reading order a model wrote them in.
    items.sort((a, b) => Number(a.startsWith(GROUP_PREFIX)) - Number(b.startsWith(GROUP_PREFIX)));
    const index = new Map(items.map((id, i) => [id, i]));
    const from: number[] = []; const to: number[] = []; const weight: number[] = [];
    for (const e of vg.edges) {
      const a = itemIn(e.from, container); const b = itemIn(e.to, container);
      if (a === undefined || b === undefined || a === b) continue;
      from.push(index.get(a)!); to.push(index.get(b)!); weight.push(e.count);
    }
    const breadth = items.map((id) => (horizontal ? size.get(id)!.h : size.get(id)!.w));
    const depth = items.map((id) => (horizontal ? size.get(id)!.w : size.get(id)!.h));
    const r = layered({ n: items.length, breadth, depth, from, to, weight, nodeGap: sp.node, layerGap: sp.layer });
    items.forEach((id, i) => {
      const s = size.get(id)!;
      const cx = horizontal ? r.d[i]! : r.b[i]!;
      const cy = horizontal ? r.b[i]! : r.d[i]!;
      rel.set(id, { x: cx - s.w / 2, y: cy - s.h / 2 });
    });
    const span = items.length ? { w: horizontal ? r.depthSpan : r.breadthSpan, h: horizontal ? r.breadthSpan : r.depthSpan } : { w: 120, h: 40 };
    // Normalise to the content's own top-left.
    let mx = Infinity; let my = Infinity; let Mx = -Infinity; let My = -Infinity;
    for (const id of items) { const p = rel.get(id)!; const s = size.get(id)!; mx = Math.min(mx, p.x); my = Math.min(my, p.y); Mx = Math.max(Mx, p.x + s.w); My = Math.max(My, p.y + s.h); }
    if (items.length) for (const id of items) { const p = rel.get(id)!; rel.set(id, { x: p.x - mx, y: p.y - my }); }
    const w = items.length ? Mx - mx : span.w; const h = items.length ? My - my : span.h;
    if (container === undefined) return { w, h };
    const g = vg.groups.find((x) => x.id === container)!;
    return { w: Math.max(w + GROUP_PAD.side * 2, groupMinWidth(g)), h: h + GROUP_PAD.top + GROUP_PAD.bottom };
  };
  lay(undefined);
  // Absolute positions, from the outside in; left/up mirror right/down.
  const abs = new Map<string, Rect>();
  const place = (container: string | undefined, ox: number, oy: number) => {
    for (const g of vg.groups) if (vg.groupParent.get(g.id) === container) {
      const p = rel.get(GROUP_PREFIX + g.id)!; const s = size.get(GROUP_PREFIX + g.id)!;
      abs.set(GROUP_PREFIX + g.id, { x: ox + p.x, y: oy + p.y, ...s });
      place(g.id, ox + p.x + GROUP_PAD.side, oy + p.y + GROUP_PAD.top);
    }
    for (const n of vg.nodes) if (n.parent === container) { const p = rel.get(n.id)!; abs.set(n.id, { x: ox + p.x, y: oy + p.y, w: n.w, h: n.h }); }
  };
  place(undefined, 24, 24);
  if (vg.dir === 'left' || vg.dir === 'up') {
    let max = 0;
    for (const r of abs.values()) max = Math.max(max, vg.dir === 'left' ? r.x + r.w : r.y + r.h);
    for (const [k, r] of abs) abs.set(k, vg.dir === 'left' ? { ...r, x: max + 24 - (r.x + r.w) } : { ...r, y: max + 24 - (r.y + r.h) });
  }
  const nodes: SceneNode[] = vg.nodes.map((n) => ({ ...strip(n), ...abs.get(n.id)! }));
  const depthOf = depthFn(vg);
  const groups: SceneGroup[] = vg.groups.map((g) => ({ id: g.id, group: g, depth: depthOf(g.id), ...abs.get(GROUP_PREFIX + g.id)! }));
  return finish({ nodes, groups, edges: routeAll(nodes, vg.edges, vg.dir), dir: vg.dir, engine: 'layered' });
}

// ---------------- orthogonal routes without ELK ----------------

type Side = 'left' | 'right' | 'top' | 'bottom';

function sidesFor(a: Rect, b: Rect, dir: Dir): [Side, Side] {
  const gx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const across = (dir === 'right' || dir === 'left') ? (gx > 12 || gy <= 12) : !(gy > 12 || gx <= 12);
  if (across) return b.x + b.w / 2 >= a.x + a.w / 2 ? ['right', 'left'] : ['left', 'right'];
  return b.y + b.h / 2 >= a.y + a.h / 2 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function port(r: Rect, side: Side, offset: number): [number, number] {
  switch (side) {
    case 'left': return [r.x, r.y + r.h / 2 + offset];
    case 'right': return [r.x + r.w, r.y + r.h / 2 + offset];
    case 'top': return [r.x + r.w / 2 + offset, r.y];
    case 'bottom': return [r.x + r.w / 2 + offset, r.y + r.h];
  }
}

/** A route between two boxes: out of one side, a bend in the channel between them, into the facing side. */
export function simpleRoute(a: Rect, b: Rect, dir: Dir, offA = 0, offB = 0, obstacles: Rect[] = [], sides?: [Side, Side]): number[] {
  const [sa, sb] = sides ?? sidesFor(a, b, dir);
  const [x0, y0] = port(a, sa, offA);
  const [x1, y1] = port(b, sb, offB);
  if (sa === 'right' || sa === 'left') {
    const out = sa === 'right' ? 1 : -1;
    if (Math.abs(y0 - y1) < 0.5 && (x1 - x0) * out > 0) return [x0, y0, x1, y1];
    const lo = Math.min(x0, x1) + 14; const hi = Math.max(x0, x1) - 14;
    if ((x1 - x0) * out > 28) {
      const mx = freeChannel((x0 + x1) / 2, lo, hi, Math.min(y0, y1), Math.max(y0, y1), obstacles, true);
      return [x0, y0, mx, y0, mx, y1, x1, y1];
    }
    // The target is behind: step out, go round between them, step in.
    const ex = x0 + out * 18; const ix = x1 - out * 18;
    const my = a.y + a.h < b.y ? (a.y + a.h + b.y) / 2 : b.y + b.h < a.y ? (b.y + b.h + a.y) / 2 : Math.max(a.y + a.h, b.y + b.h) + 24;
    return [x0, y0, ex, y0, ex, my, ix, my, ix, y1, x1, y1];
  }
  const out = sa === 'bottom' ? 1 : -1;
  if (Math.abs(x0 - x1) < 0.5 && (y1 - y0) * out > 0) return [x0, y0, x1, y1];
  const lo = Math.min(y0, y1) + 14; const hi = Math.max(y0, y1) - 14;
  if ((y1 - y0) * out > 28) {
    const my = freeChannel((y0 + y1) / 2, lo, hi, Math.min(x0, x1), Math.max(x0, x1), obstacles, false);
    return [x0, y0, x0, my, x1, my, x1, y1];
  }
  const ey = y0 + out * 18; const iy = y1 - out * 18;
  const mx = a.x + a.w < b.x ? (a.x + a.w + b.x) / 2 : b.x + b.w < a.x ? (b.x + b.w + a.x) / 2 : Math.max(a.x + a.w, b.x + b.w) + 24;
  return [x0, y0, x0, ey, mx, ey, mx, iy, x1, iy, x1, y1];
}

/** A coordinate near `want` in [lo, hi] where a segment across [s0, s1] meets no obstacle. */
function freeChannel(want: number, lo: number, hi: number, s0: number, s1: number, obstacles: Rect[], vertical: boolean): number {
  if (lo > hi) return want;
  const blocked = (c: number) => obstacles.some((o) => (vertical
    ? c > o.x - 6 && c < o.x + o.w + 6 && s1 > o.y && s0 < o.y + o.h
    : c > o.y - 6 && c < o.y + o.h + 6 && s1 > o.x && s0 < o.x + o.w));
  if (!blocked(want)) return want;
  for (let d = 12; d <= hi - lo + 12; d += 12) {
    if (want - d >= lo && !blocked(want - d)) return want - d;
    if (want + d <= hi && !blocked(want + d)) return want + d;
  }
  return want;
}

/** The middle of a route's longest segment: where its label pill goes. */
export function labelAt(points: number[], text: string): EdgeLabel {
  let best = 0; let bx = points[0] ?? 0; let by = points[1] ?? 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const len = Math.abs(points[i + 2]! - points[i]!) + Math.abs(points[i + 3]! - points[i + 1]!);
    if (len > best) { best = len; bx = (points[i]! + points[i + 2]!) / 2; by = (points[i + 1]! + points[i + 3]!) / 2; }
  }
  const s = labelSize(text);
  return { x: round1(bx - s.w / 2), y: round1(by - s.h / 2), ...s, text };
}

/** Routes for every edge, with ports spread along a side when several edges share it. */
export function routeAll(nodes: SceneNode[], edges: Array<Pick<VEdge, 'id' | 'from' | 'to' | 'edge' | 'count' | 'ids' | 'text'>>, dir: Dir, keep?: Map<string, SceneEdge>): SceneEdge[] {
  const rect = new Map(nodes.map((n) => [n.id, n as Rect]));
  const sides = new Map<string, [Side, Side]>();
  const slots = new Map<string, Array<{ edge: string; end: 0 | 1; along: number }>>();
  const todo = edges.filter((e) => !keep?.has(e.id) && rect.has(e.from) && rect.has(e.to));
  for (const e of todo) {
    const a = rect.get(e.from)!; const b = rect.get(e.to)!;
    const s = sidesFor(a, b, dir);
    sides.set(e.id, s);
    const alongOf = (r: Rect, side: Side) => (side === 'left' || side === 'right' ? r.y + r.h / 2 : r.x + r.w / 2);
    for (const [end, node, side, other] of [[0, e.from, s[0], b], [1, e.to, s[1], a]] as const) {
      const k = `${node}\u0000${side}`;
      (slots.get(k) ?? slots.set(k, []).get(k)!).push({ edge: e.id, end, along: alongOf(other, side) });
    }
  }
  const offset = new Map<string, number>();
  for (const [k, list] of slots) {
    const [node, side] = k.split('\u0000') as [string, Side];
    const r = rect.get(node)!;
    const extent = side === 'left' || side === 'right' ? r.h : r.w;
    list.sort((p, q) => p.along - q.along || p.edge.localeCompare(q.edge));
    const span = Math.min(extent * 0.6, (list.length - 1) * 14);
    list.forEach((s, i) => offset.set(`${s.edge}\u0000${s.end}`, list.length === 1 ? 0 : -span / 2 + (span * i) / (list.length - 1)));
  }
  return edges.flatMap((e) => {
    const kept = keep?.get(e.id);
    if (kept) return [{ ...kept, edge: e.edge, count: e.count, ids: e.ids, ...(e.text ? { label: kept.label && kept.label.text === e.text ? kept.label : labelAt(kept.points, e.text) } : { label: undefined }) }];
    const a = rect.get(e.from); const b = rect.get(e.to);
    if (!a || !b) return [];
    const obstacles = nodes.filter((n) => n.id !== e.from && n.id !== e.to);
    const points = simpleRoute(a, b, dir, offset.get(`${e.id}\u00000`) ?? 0, offset.get(`${e.id}\u00001`) ?? 0, obstacles, sides.get(e.id)).map(round1);
    return [{ id: e.id, from: e.from, to: e.to, points, ...(e.text ? { label: labelAt(points, e.text) } : {}), edge: e.edge, count: e.count, ids: e.ids }];
  });
}

// ---------------- positions: keep what was there, place what is new ----------------

/** Positions to keep: the spec's saved ones, else the previous layout's (by node id). */
export function pinnedPositions(spec: DiagramSpec, vg: VisibleGraph, previous?: Scene | null): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const saved = spec.layout?.positions ?? {};
  const prev = new Map((previous?.nodes ?? []).map((n) => [n.id, n]));
  const prevGroups = new Map((previous?.groups ?? []).map((g) => [g.id, g]));
  const byId = new Map((spec.groups ?? []).map((g) => [g.id, g]));
  for (const n of vg.nodes) {
    const s = Object.prototype.hasOwnProperty.call(saved, n.id) ? saved[n.id] : undefined;
    if (s) { out.set(n.id, s); continue; }
    const p = prev.get(n.id);
    if (p) { out.set(n.id, { x: p.x, y: p.y }); continue; }
    if (n.collapsed) {
      // A collapsed group's card sits where the group was (or where its members were saved).
      const g = prevGroups.get(n.collapsed.id);
      if (g) { out.set(n.id, { x: g.x, y: g.y }); continue; }
      const inside = (id: string | undefined): boolean => { for (let x = id; x; x = byId.get(x)?.parent) if (x === n.collapsed!.id) return true; return false; };
      const members = spec.nodes.filter((m) => inside(m.group) && Object.prototype.hasOwnProperty.call(saved, m.id)).map((m) => saved[m.id]!);
      if (members.length) out.set(n.id, { x: Math.min(...members.map((m) => m.x)), y: Math.min(...members.map((m) => m.y)) });
    }
  }
  return out;
}

const GAP = { along: 90, across: 36 };

/** Places the nodes that have no position next to the ones they connect to, in free space. */
export function placeNew(vg: VisibleGraph, pinned: Map<string, { x: number; y: number }>): Map<string, { x: number; y: number }> {
  const pos = new Map(pinned);
  const size = new Map(vg.nodes.map((n) => [n.id, n]));
  const missing = vg.nodes.filter((n) => !pos.has(n.id)).map((n) => n.id);
  if (!missing.length) return pos;
  const adj = new Map<string, Array<{ other: string; out: boolean }>>();
  for (const e of vg.edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push({ other: e.to, out: true });
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push({ other: e.from, out: false });
  }
  const groupChain = (g: string | undefined) => { const s = new Set<string>(); for (let x = g; x; x = vg.groupParent.get(x)) s.add(x); return s; };
  /** The box of a group's placed members (and of their own groups inside it). */
  const groupBox = (gid: string): Rect | undefined => {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const n of vg.nodes) {
      const p = pos.get(n.id);
      if (!p || !groupChain(n.parent).has(gid)) continue;
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + n.w); y1 = Math.max(y1, p.y + n.h);
    }
    return Number.isFinite(x0) ? { x: x0 - GROUP_PAD.side, y: y0 - GROUP_PAD.top, w: x1 - x0 + GROUP_PAD.side * 2, h: y1 - y0 + GROUP_PAD.top + GROUP_PAD.bottom } : undefined;
  };
  const horizontal = vg.dir === 'right' || vg.dir === 'left';
  const sign = vg.dir === 'left' || vg.dir === 'up' ? -1 : 1;
  const overlaps = (r: Rect, o: Rect, m: number) => r.x < o.x + o.w + m && o.x < r.x + r.w + m && r.y < o.y + o.h + m && o.y < r.y + r.h + m;
  // Most-connected first, so later ones have more neighbours to sit by.
  const order = [...missing];
  while (order.length) {
    order.sort((a, b) => (adj.get(b) ?? []).filter((x) => pos.has(x.other)).length - (adj.get(a) ?? []).filter((x) => pos.has(x.other)).length || missing.indexOf(a) - missing.indexOf(b));
    const id = order.shift()!;
    const me = size.get(id)!;
    const wants: Array<[number, number]> = [];
    for (const { other, out } of adj.get(id) ?? []) {
      const p = pos.get(other); const o = size.get(other);
      if (!p || !o) continue;
      // A node that uses `other` goes before it in the flow; one `other` uses goes after.
      const before = out ? -sign : sign;
      if (horizontal) wants.push([before < 0 ? p.x - me.w - GAP.along : p.x + o.w + GAP.along, p.y + (o.h - me.h) / 2]);
      else wants.push([p.x + (o.w - me.w) / 2, before < 0 ? p.y - me.h - GAP.along : p.y + o.h + GAP.along]);
    }
    let target: [number, number];
    if (wants.length) target = [wants.reduce((s, w) => s + w[0], 0) / wants.length, wants.reduce((s, w) => s + w[1], 0) / wants.length];
    else {
      const box = (me.parent ? groupBox(me.parent) : undefined) ?? boundsOf(vg, pos);
      target = box ? (horizontal ? [box.x + (me.parent ? GROUP_PAD.side : 0), box.y + box.h + GAP.across] : [box.x + box.w + GAP.across, box.y + (me.parent ? GROUP_PAD.top : 0)]) : [24, 24];
    }
    // Free space: no other box, and no group this node is not inside.
    const mine = groupChain(me.parent);
    const blockers: Rect[] = [];
    for (const n of vg.nodes) { const p = pos.get(n.id); if (p && n.id !== id) blockers.push({ x: p.x, y: p.y, w: n.w, h: n.h }); }
    const foreign = vg.groups.filter((g) => !mine.has(g.id)).map((g) => groupBox(g.id)).filter((b): b is Rect => !!b);
    const free = (x: number, y: number) => { const r = { x, y, w: me.w, h: me.h }; return !blockers.some((b) => overlaps(r, b, 22)) && !foreign.some((b) => overlaps(r, b, 10)); };
    let best: [number, number] = target;
    search: for (let ring = 0; ring <= 80; ring++) {
      const step = 24;
      const cands: Array<[number, number]> = [];
      if (ring === 0) cands.push(target);
      else for (let i = -ring; i <= ring; i++) {
        cands.push([target[0] + i * step, target[1] - ring * step], [target[0] + i * step, target[1] + ring * step]);
        if (Math.abs(i) !== ring) cands.push([target[0] - ring * step, target[1] + i * step], [target[0] + ring * step, target[1] + i * step]);
      }
      cands.sort((p, q) => Math.hypot(p[0] - target[0], p[1] - target[1]) - Math.hypot(q[0] - target[0], q[1] - target[1]));
      for (const c of cands) if (free(c[0], c[1])) { best = c; break search; }
    }
    pos.set(id, { x: Math.round(best[0]), y: Math.round(best[1]) });
  }
  return pos;
}

function boundsOf(vg: VisibleGraph, pos: Map<string, { x: number; y: number }>): Rect | undefined {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of vg.nodes) { const p = pos.get(n.id); if (!p) continue; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + n.w); y1 = Math.max(y1, p.y + n.h); }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}

/** Group boxes around their members, from the innermost out. */
export function groupBoxes(vg: VisibleGraph, nodes: SceneNode[]): SceneGroup[] {
  const depthOf = depthFn(vg);
  const order = [...vg.groups].sort((a, b) => depthOf(b.id) - depthOf(a.id));
  const boxes = new Map<string, Rect>();
  for (const g of order) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const take = (r: Rect) => { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); };
    for (const n of nodes) if (n.parent === g.id) take(n);
    for (const c of vg.groups) if (vg.groupParent.get(c.id) === g.id && boxes.has(c.id)) take(boxes.get(c.id)!);
    if (Number.isFinite(x0)) boxes.set(g.id, { x: x0 - GROUP_PAD.side, y: y0 - GROUP_PAD.top, w: Math.max(x1 - x0 + GROUP_PAD.side * 2, groupMinWidth(g)), h: y1 - y0 + GROUP_PAD.top + GROUP_PAD.bottom });
  }
  return vg.groups.flatMap((g) => (boxes.has(g.id) ? [{ id: g.id, group: g, depth: depthOf(g.id), ...boxes.get(g.id)! }] : []));
}

/** Boxes where `pos` says, new ones placed, edges between boxes that did not move keep their previous routes. */
export function positionsScene(vg: VisibleGraph, pinned: Map<string, { x: number; y: number }>, previous?: Scene | null): Scene {
  const pos = placeNew(vg, pinned);
  const nodes: SceneNode[] = vg.nodes.map((n) => ({ ...strip(n), ...pos.get(n.id)!, w: n.w, h: n.h }));
  return withRoutes(vg, nodes, previous, 'positions');
}

function withRoutes(vg: VisibleGraph, nodes: SceneNode[], previous: Scene | null | undefined, engine: Scene['engine']): Scene {
  const keep = new Map<string, SceneEdge>();
  if (previous) {
    const was = new Map(previous.nodes.map((n) => [n.id, n]));
    const now = new Map(nodes.map((n) => [n.id, n]));
    const same = (id: string) => { const a = was.get(id); const b = now.get(id); return !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && a.w === b.w && a.h === b.h; };
    for (const e of previous.edges) if (same(e.from) && same(e.to) && vg.edges.some((v) => v.id === e.id && v.from === e.from && v.to === e.to)) keep.set(e.id, e);
  }
  return finish({ nodes, groups: groupBoxes(vg, nodes), edges: routeAll(nodes, vg.edges, vg.dir, keep), dir: vg.dir, engine });
}

/** A scene with some boxes moved (a drag): their edges re-routed, the groups around them re-fitted. */
export function moveNodes(scene: Scene, vg: VisibleGraph, moved: ReadonlyMap<string, { x: number; y: number }>): Scene {
  if (!moved.size) return scene;
  const nodes = scene.nodes.map((n) => { const p = moved.get(n.id); return p ? { ...n, x: p.x, y: p.y } : n; });
  const touched = new Set<string>();
  for (const n of scene.nodes) if (moved.has(n.id)) for (let g = n.parent; g; g = vg.groupParent.get(g)) touched.add(g);
  const refit = groupBoxes(vg, nodes);
  const groups = scene.groups.map((g) => (touched.has(g.id) ? refit.find((r) => r.id === g.id) ?? g : g));
  const keep = new Map(scene.edges.filter((e) => !moved.has(e.from) && !moved.has(e.to)).map((e) => [e.id, e]));
  return finish({ nodes, groups, edges: routeAll(nodes, vg.edges, vg.dir, keep), dir: vg.dir, engine: scene.engine });
}

// ---------------- the entry points ----------------

export interface LayoutOptions {
  collapsed?: ReadonlySet<string>;
  /** The layout of the version before: kept for the nodes still there. */
  previous?: Scene | null;
  /** auto: ELK, falling back to layered; layered: never ELK. */
  engine?: 'auto' | 'layered';
  /** ELK, however it runs (the canvas passes the worker's). */
  elk?: (g: ElkGraph) => Promise<ElkResult>;
  /** A fresh layout: saved positions and the previous layout are ignored (Re-layout). */
  fresh?: boolean;
}

/** Positions to keep win when they cover at least half the boxes; otherwise a fresh layout, with the kept ones laid over it. */
function planFor(spec: DiagramSpec, o: LayoutOptions): { vg: VisibleGraph; pinned: Map<string, { x: number; y: number }>; usePinned: boolean } {
  const vg = visibleGraph(spec, o.collapsed);
  const pinned = o.fresh ? new Map<string, { x: number; y: number }>() : pinnedPositions(spec, vg, o.previous);
  return { vg, pinned, usePinned: pinned.size > 0 && pinned.size * 2 >= vg.nodes.length };
}

function overlay(scene: Scene, vg: VisibleGraph, pinned: Map<string, { x: number; y: number }>): Scene {
  if (!pinned.size) return scene;
  const moved = new Map<string, { x: number; y: number }>();
  for (const n of scene.nodes) { const p = pinned.get(n.id); if (p && (p.x !== n.x || p.y !== n.y)) moved.set(n.id, p); }
  return moveNodes(scene, vg, moved);
}

/** The layout, synchronously: positions or the layered fallback (no ELK). */
export function layoutDiagramSync(spec: DiagramSpec, o: LayoutOptions = {}): Scene {
  const { vg, pinned, usePinned } = planFor(spec, o);
  if (usePinned) return positionsScene(vg, pinned, o.previous);
  return overlay(layeredScene(vg), vg, pinned);
}

/** The layout: positions when there are enough to keep, else ELK (or layered when ELK fails). */
export async function layoutDiagram(spec: DiagramSpec, o: LayoutOptions = {}): Promise<Scene> {
  const { vg, pinned, usePinned } = planFor(spec, o);
  if (usePinned) return positionsScene(vg, pinned, o.previous);
  if (o.engine === 'layered' || !o.elk) return overlay(layeredScene(vg), vg, pinned);
  let scene: Scene;
  try { scene = fromElk(await o.elk(toElk(vg)), vg); } catch { scene = layeredScene(vg); }
  return overlay(scene, vg, pinned);
}

/** Every box's top-left, for saving (layout.positions). */
export function positionsOf(scene: Scene): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of scene.nodes) if (!isCollapsedId(n.id)) out[n.id] = { x: Math.round(n.x), y: Math.round(n.y) };
  return out;
}

/** A stable key for a layout's inputs (the cache of laid-out diagrams). */
export function layoutKey(spec: DiagramSpec, collapsed?: ReadonlySet<string>): string {
  const vg = visibleGraph(spec, collapsed);
  return JSON.stringify([vg.dir, vg.spacing, vg.nodes.map((n) => [n.id, n.w, n.h, n.parent ?? '']), vg.groups.map((g) => [g.id, vg.groupParent.get(g.id) ?? '']), vg.edges.map((e) => [e.id, e.from, e.to, e.text ?? '']), spec.layout?.positions ?? null]);
}
