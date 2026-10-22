/**
 * Phylogenetic trees: ```newick / ```nwk (and ```phyloxml). Parsed without recursion (a deeply
 * nested string cannot overflow the stack), internal labels that are numbers read as support
 * values, then laid out as a rectangular or a circular tree with branch lengths (a cladogram when
 * the tree has none). Clades can be collapsed. Pure; tested.
 */

import { LIMITS, checkSize, num, text, tooLarge } from './common.ts';

export interface TreeNode { id: number; name: string; length?: number; support?: number; children: TreeNode[] }
export interface ParsedTree { root: TreeNode; leaves: number; hasLengths: boolean; hasSupport: boolean; notes: string[] }

export function parseTree(source: string, format: 'newick' | 'phyloxml' = 'newick'): ParsedTree {
  checkSize(source, 'tree');
  const src = source.trim();
  const root = format === 'phyloxml' || src.startsWith('<') ? parsePhyloXml(src) : parseNewick(src);
  return finish(root);
}

function finish(root: TreeNode): ParsedTree {
  const notes: string[] = [];
  let leaves = 0; let hasLengths = false; let hasSupport = false;
  const stack: Array<[TreeNode, number]> = [[root, 0]];
  while (stack.length) {
    const [n, d] = stack.pop()!;
    if (d > LIMITS.treeDepth) throw new Error(`the tree is nested too deeply (more than ${LIMITS.treeDepth} levels)`);
    if (n.length !== undefined && n !== root) hasLengths = true;
    if (n.support !== undefined) hasSupport = true;
    if (!n.children.length) leaves++;
    for (const c of n.children) stack.push([c, d + 1]);
  }
  if (leaves < 2) throw new Error('a tree needs at least two leaves, e.g. ((A:0.1,B:0.2):0.05,C:0.3);');
  if (leaves > LIMITS.treeLeaves) { notes.push(tooLarge(LIMITS.treeLeaves, leaves, 'leaves')); prune(root, LIMITS.treeLeaves); }
  return { root, leaves: Math.min(leaves, LIMITS.treeLeaves), hasLengths, hasSupport, notes };
}

/** Keeps the first `keep` leaves (in order) and drops clades left empty. */
function prune(root: TreeNode, keep: number): void {
  let seen = 0;
  const visit = (n: TreeNode): boolean => {
    if (!n.children.length) return seen++ < keep;
    n.children = n.children.filter(visit);
    return n.children.length > 0;
  };
  // Depth is bounded by finish() before this runs.
  visit(root);
}

const supportOf = (label: string): number | undefined => {
  const v = num(label);
  return v !== undefined && v >= 0 && v <= 100 ? v : undefined;
};

export function parseNewick(src: string): TreeNode {
  const s = src.replace(/\[[^\]]*\]/g, (m) => (/^\[\d+(\.\d+)?\]$/.test(m) ? m : '')); // comments out, [95]-style support kept
  let id = 0;
  const node = (): TreeNode => ({ id: id++, name: '', children: [] });
  const root = node();
  const stack: TreeNode[] = [];
  let cur = root;
  let i = 0;
  const readLabel = (): string => {
    if (s[i] === "'") {
      let out = ''; i++;
      while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; } else if (s[i] === "'") { i++; break; } else out += s[i++]; }
      return out;
    }
    const start = i;
    while (i < s.length && !'(),:;['.includes(s[i]!)) i++;
    return s.slice(start, i).trim().replace(/_/g, ' ');
  };
  const readTail = (n: TreeNode) => {
    const label = readLabel();
    if (label) { if (n.children.length && supportOf(label) !== undefined) n.support = supportOf(label); else n.name = text(label, 60); }
    if (s[i] === ':') {
      i++; const st = i;
      while (i < s.length && /[0-9eE.+-]/.test(s[i]!)) i++;
      const v = Number(s.slice(st, i));
      if (s.slice(st, i) && !Number.isFinite(v)) throw new Error(`a branch length is not a number near "${text(s.slice(st, st + 12), 12)}"`);
      if (s.slice(st, i)) n.length = Math.max(0, v);
    }
    const b = /^\[(\d+(?:\.\d+)?)\]/.exec(s.slice(i, i + 12));
    if (b) { n.support = supportOf(b[1]!); i += b[0].length; }
  };
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') {
      if (stack.length >= LIMITS.treeDepth) throw new Error(`the tree is nested too deeply (more than ${LIMITS.treeDepth} levels)`);
      const child = node(); cur.children.push(child); stack.push(cur); cur = child; i++;
      if (id > 200_000) throw new Error('the tree is too large to draw');
      continue;
    }
    if (c === ',') {
      if (!stack.length) throw new Error(`unexpected "," at position ${i + 1} (outside any parentheses)`);
      const parent = stack[stack.length - 1]!; const sib = node(); parent.children.push(sib); cur = sib; i++; continue;
    }
    if (c === ')') {
      if (!stack.length) throw new Error(`unbalanced ")" at position ${i + 1}`);
      cur = stack.pop()!; i++; readTail(cur); continue;
    }
    if (c === ';') { i++; break; }
    readTail(cur);
    if (i < s.length && !'(),;'.includes(s[i]!) && !/\s/.test(s[i]!)) throw new Error(`unexpected "${text(s[i], 4)}" at position ${i + 1}`);
  }
  if (stack.length) throw new Error(`unbalanced parentheses: ${stack.length} "(" not closed`);
  // A root with a single child (the outer parentheses) is that child.
  let r = root;
  while (r.children.length === 1 && !r.name) r = r.children[0]!;
  return r;
}

/** A small reader for the phyloXML elements a tree needs: clade, name, branch_length, confidence, scientific_name. */
export function parsePhyloXml(src: string): TreeNode {
  if (!/<phyloxml|<phylogeny|<clade/i.test(src)) throw new Error('not phyloXML (no <phylogeny> or <clade>)');
  let id = 0;
  const top: TreeNode = { id: id++, name: '', children: [] };
  const stack: TreeNode[] = [top];
  let field = '';
  const re = /<(\/?)([A-Za-z_:][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {
      const v = m[5].trim(); if (!v || !field) continue;
      const n = stack[stack.length - 1]!;
      const val = v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      if (field === 'name' || (field === 'scientific_name' && !n.name)) n.name = text(val, 60);
      else if (field === 'branch_length') n.length = Math.max(0, num(val) ?? 0);
      else if (field === 'confidence') n.support = supportOf(val);
      continue;
    }
    const [, close, tag, attrs, self] = m; const t = tag!.toLowerCase().replace(/^.*:/, '');
    if (t === 'clade' && !close) {
      if (stack.length > LIMITS.treeDepth) throw new Error(`the tree is nested too deeply (more than ${LIMITS.treeDepth} levels)`);
      const n: TreeNode = { id: id++, name: '', children: [] };
      const bl = /branch_length\s*=\s*"([^"]*)"/.exec(attrs ?? '');
      if (bl) n.length = Math.max(0, num(bl[1]) ?? 0);
      stack[stack.length - 1]!.children.push(n);
      if (!self) stack.push(n);
      if (id > 200_000) throw new Error('the tree is too large to draw');
    } else if (t === 'clade' && close) { if (stack.length > 1) stack.pop(); }
    else if (!close && !self) field = t;
    else if (close) field = '';
  }
  let r = top;
  while (r.children.length === 1 && !r.name) r = r.children[0]!;
  return r;
}

// ---------- layout ----------

export interface LaidNode { id: number; x: number; y: number; leaf: boolean; name: string; support?: number; collapsed?: number; angle?: number; tipX?: number; tipY?: number }
export interface TreeLayout { paths: string[]; nodes: LaidNode[]; width: number; height: number; scale?: { x: number; y: number; len: number; label: string } }

const leafCount = (n: TreeNode, collapsed: ReadonlySet<number>): number => (!n.children.length || collapsed.has(n.id) ? 1 : n.children.reduce((a, c) => a + leafCount(c, collapsed), 0));
const countLeaves = (n: TreeNode): number => (!n.children.length ? 1 : n.children.reduce((a, c) => a + countLeaves(c), 0));

/**
 * Positions for every visible node. `x` of a node is its distance from the root (branch lengths, or
 * depth when the tree has none, leaves then aligned); `y` its leaf slot.
 */
export function layoutTree(t: ParsedTree, o: { mode: 'rectangular' | 'circular'; collapsed?: ReadonlySet<number>; width?: number; labelWidth?: number }): TreeLayout {
  const collapsed = o.collapsed ?? new Set<number>();
  const visibleLeaves = leafCount(t.root, collapsed);
  const dist = new Map<number, number>();
  let maxDist = 0;
  // Distances: branch lengths, or depth for a cladogram (leaves pushed to the deepest level after).
  const walk = (n: TreeNode, d: number) => {
    dist.set(n.id, d); maxDist = Math.max(maxDist, d);
    if (collapsed.has(n.id)) return;
    for (const c of n.children) walk(c, d + (t.hasLengths ? (c.length ?? 0) : 1));
  };
  walk(t.root, 0);
  if (maxDist <= 0) maxDist = 1;
  const slot = new Map<number, number>();
  let k = 0;
  const place = (n: TreeNode): number => {
    if (!n.children.length || collapsed.has(n.id)) { slot.set(n.id, k); return k++; }
    const ys = n.children.map(place);
    const y = (ys[0]! + ys[ys.length - 1]!) / 2; slot.set(n.id, y); return y;
  };
  place(t.root);
  const leafX = (n: TreeNode) => (t.hasLengths ? dist.get(n.id)! : maxDist);
  const nodes: LaidNode[] = []; const paths: string[] = [];
  const W = o.width ?? 720;
  if (o.mode === 'rectangular') {
    const labelW = o.labelWidth ?? 170; const rowH = 20; const top = 14;
    const H = top * 2 + Math.max(1, visibleLeaves - 1) * rowH;
    const sx = (d: number) => 16 + (d / maxDist) * (W - 16 - labelW);
    const sy = (s: number) => top + s * rowH;
    const draw = (n: TreeNode) => {
      const x = sx(dist.get(n.id)!); const y = sy(slot.get(n.id)!);
      const leaf = !n.children.length; const col = collapsed.has(n.id);
      nodes.push({ id: n.id, x, y, leaf: leaf || col, name: n.name, support: n.support, ...(col ? { collapsed: countLeaves(n) } : {}), ...(leaf && !t.hasLengths ? { tipX: sx(leafX(n)) } : {}) });
      if (leaf || col) return;
      const ys = n.children.map((c) => sy(slot.get(c.id)!));
      paths.push(`M${r1(x)},${r1(Math.min(...ys))}V${r1(Math.max(...ys))}`);
      for (const c of n.children) { const cx = sx(dist.get(c.id)!); const cy = sy(slot.get(c.id)!); paths.push(`M${r1(x)},${r1(cy)}H${r1(cx)}`); draw(c); }
    };
    draw(t.root);
    const out: TreeLayout = { paths, nodes, width: W, height: H + 30 };
    if (t.hasLengths) { const len = niceLen(maxDist / 5); out.scale = { x: sx(0), y: H + 14, len: (len / maxDist) * (W - 16 - labelW), label: String(len) }; }
    return out;
  }
  // Circular: angle by leaf slot (a small gap where the circle closes), radius by distance.
  const R = (W / 2) - (o.labelWidth ?? 130); const cx = W / 2; const cy = W / 2;
  const ang = (s: number) => -Math.PI / 2 + (s / Math.max(1, visibleLeaves)) * Math.PI * 2 * 0.97;
  const rad = (d: number) => 8 + (d / maxDist) * (R - 8);
  const pt = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  const draw = (n: TreeNode) => {
    const r = rad(dist.get(n.id)!); const a = ang(slot.get(n.id)!); const [x, y] = pt(r, a);
    const leaf = !n.children.length; const col = collapsed.has(n.id);
    const tip = leaf && !t.hasLengths ? pt(rad(leafX(n)), a) : undefined;
    nodes.push({ id: n.id, x, y, leaf: leaf || col, name: n.name, support: n.support, angle: a, ...(col ? { collapsed: countLeaves(n) } : {}), ...(tip ? { tipX: tip[0], tipY: tip[1] } : {}) });
    if (leaf || col) return;
    const as = n.children.map((c) => ang(slot.get(c.id)!));
    const a0 = Math.min(...as); const a1 = Math.max(...as);
    const [x0, y0] = pt(r, a0); const [x1, y1] = pt(r, a1);
    paths.push(`M${r1(x0)},${r1(y0)}A${r1(r)},${r1(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${r1(x1)},${r1(y1)}`);
    for (const c of n.children) {
      const ca = ang(slot.get(c.id)!); const [px, py] = pt(r, ca); const [qx, qy] = pt(rad(dist.get(c.id)!), ca);
      paths.push(`M${r1(px)},${r1(py)}L${r1(qx)},${r1(qy)}`); draw(c);
    }
  };
  draw(t.root);
  const out: TreeLayout = { paths, nodes, width: W, height: W };
  if (t.hasLengths) { const len = niceLen(maxDist / 5); out.scale = { x: 16, y: W - 14, len: (len / maxDist) * (R - 8), label: String(len) }; }
  return out;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
function niceLen(v: number): number { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= v) ?? v; }
