/** Geometry of routes: rounded orthogonal paths, lengths, reversal, the point at a fraction. */

/** An SVG path through the points with the corners rounded (radius r, smaller on short segments). */
export function roundedPath(p: number[], r = 8): string {
  if (p.length < 4) return '';
  let d = `M${p[0]} ${p[1]}`;
  for (let i = 2; i + 2 < p.length; i += 2) {
    const x0 = p[i - 2]!; const y0 = p[i - 1]!; const x1 = p[i]!; const y1 = p[i + 1]!; const x2 = p[i + 2]!; const y2 = p[i + 3]!;
    const l1 = Math.hypot(x1 - x0, y1 - y0); const l2 = Math.hypot(x2 - x1, y2 - y1);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (k < 0.5) { d += ` L${x1} ${y1}`; continue; }
    const ax = x1 - ((x1 - x0) / l1) * k; const ay = y1 - ((y1 - y0) / l1) * k;
    const bx = x1 + ((x2 - x1) / l2) * k; const by = y1 + ((y2 - y1) / l2) * k;
    d += ` L${r2(ax)} ${r2(ay)} Q${x1} ${y1} ${r2(bx)} ${r2(by)}`;
  }
  return `${d} L${p[p.length - 2]} ${p[p.length - 1]}`;
}
const r2 = (v: number) => Math.round(v * 100) / 100;

export function reversePoints(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i]!, p[i + 1]!);
  return out;
}

export function polyLength(p: number[]): number {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i]! - p[i - 2]!, p[i + 1]! - p[i - 1]!);
  return l;
}

/** The point at fraction t (0..1) along the route, and the direction there. */
export function pointAt(p: number[], t: number): { x: number; y: number; dx: number; dy: number } {
  const total = polyLength(p);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 2; i < p.length; i += 2) {
    const x0 = p[i - 2]!; const y0 = p[i - 1]!; const x1 = p[i]!; const y1 = p[i + 1]!;
    const l = Math.hypot(x1 - x0, y1 - y0);
    if (left <= l || i + 2 >= p.length) { const f = l ? Math.min(1, left / l) : 0; return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, dx: l ? (x1 - x0) / l : 1, dy: l ? (y1 - y0) / l : 0 }; }
    left -= l;
  }
  return { x: p[0] ?? 0, y: p[1] ?? 0, dx: 1, dy: 0 };
}

/** The middle of the longest segment. */
export function midOfLongest(p: number[]): { x: number; y: number } {
  let best = -1; let x = p[0] ?? 0; let y = p[1] ?? 0;
  for (let i = 2; i < p.length; i += 2) {
    const l = Math.abs(p[i]! - p[i - 2]!) + Math.abs(p[i + 1]! - p[i - 1]!);
    if (l > best) { best = l; x = (p[i]! + p[i - 2]!) / 2; y = (p[i + 1]! + p[i - 1]!) / 2; }
  }
  return { x, y };
}
