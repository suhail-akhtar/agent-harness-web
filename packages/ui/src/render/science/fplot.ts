/**
 * Function plots: ```plot / ```function-plot blocks like {"fn": "sin(x)/x", "domain": [-10, 10]}.
 *
 * The expression is parsed by a small grammar here, never evaluated as JavaScript: numbers, x, pi,
 * e, + - * / ^, parentheses and a fixed list of functions. Anything else is a parse error, so a spec
 * cannot reach code (no eval, no Function, no property access). Pure; tested.
 */

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'var' }
  | { t: 'neg'; a: Expr }
  | { t: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Expr; b: Expr }
  | { t: 'call'; f: string; args: Expr[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

export class PlotError extends Error {}

/** Parses an expression in x. Throws PlotError with where it went wrong. */
export function parseExpr(src: string): Expr {
  if (typeof src !== 'string' || !src.trim()) throw new PlotError('the function is empty');
  if (src.length > 500) throw new PlotError('the function is too long');
  const toks = src.match(/\d+\.?\d*(?:e[-+]?\d+)?|\.\d+|[a-zA-Z_][a-zA-Z0-9_]*|\*\*|[-+*/^(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (want?: string) => { const t = toks[i++]; if (want !== undefined && t !== want) throw new PlotError(`expected "${want}" ${t ? `but found "${t}"` : 'at the end'}`); return t; };
  const primary = (): Expr => {
    const t = take();
    if (t === undefined) throw new PlotError('the function ends too early');
    if (/^(\d|\.)/.test(t)) { const v = Number(t); if (!Number.isFinite(v)) throw new PlotError(`bad number "${t}"`); return { t: 'num', v }; }
    if (t === '(') { const e = expr(); take(')'); return e; }
    if (t === '-') return { t: 'neg', a: power() };
    if (t === '+') return power();
    if (/^[a-zA-Z_]/.test(t)) {
      const name = t.toLowerCase();
      if (name === 'x') return { t: 'var' };
      if (Object.hasOwn(CONSTS, name)) return { t: 'num', v: CONSTS[name]! };
      if (Object.hasOwn(FUNCS, name)) {
        take('(');
        const args: Expr[] = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { take(','); args.push(expr()); } }
        take(')');
        return { t: 'call', f: name, args };
      }
      throw new PlotError(`unknown name "${t}" (use x, pi, e and functions like sin, exp, sqrt)`);
    }
    throw new PlotError(`unexpected "${t}"`);
  };
  // Implicit multiplication: 2x, 2(x+1), (x+1)(x-1), 3sin(x).
  const implicit = () => { const t = peek(); return t !== undefined && (t === '(' || /^[a-zA-Z_]/.test(t) || /^(\d|\.)/.test(t)); };
  const power = (): Expr => { const b = primary(); if (peek() === '^' || peek() === '**') { take(); return { t: 'bin', op: '^', a: b, b: unary() }; } return b; };
  const unary = (): Expr => { if (peek() === '-') { take(); return { t: 'neg', a: unary() }; } if (peek() === '+') { take(); return unary(); } return power(); };
  const term = (): Expr => {
    let a = unary();
    for (;;) {
      if (peek() === '*' || peek() === '/') { const op = take() as '*' | '/'; a = { t: 'bin', op, a, b: unary() }; }
      else if (implicit()) a = { t: 'bin', op: '*', a, b: unary() };
      else return a;
    }
  };
  const expr = (): Expr => { let a = term(); while (peek() === '+' || peek() === '-') { const op = take() as '+' | '-'; a = { t: 'bin', op, a, b: term() }; } return a; };
  const e = expr();
  if (i < toks.length) throw new PlotError(`unexpected "${toks[i]}"`);
  return e;
}

export function evaluate(e: Expr, x: number): number {
  switch (e.t) {
    case 'num': return e.v;
    case 'var': return x;
    case 'neg': return -evaluate(e.a, x);
    case 'bin': { const a = evaluate(e.a, x); const b = evaluate(e.b, x); return e.op === '+' ? a + b : e.op === '-' ? a - b : e.op === '*' ? a * b : e.op === '/' ? a / b : a ** b; }
    case 'call': return FUNCS[e.f]!(...e.args.map((a) => evaluate(a, x)));
  }
}

export interface PlotSpec { title?: string; fns: Array<{ fn: string; label: string; color?: string }>; domain: [number, number]; yDomain?: [number, number]; points?: Array<[number, number]>; samples: number }

/** Reads a plot block: {fn} or {fns:[...]} or a bare expression line. */
export function parsePlotSpec(source: string): { spec?: PlotSpec; exprs?: Expr[]; error?: string } {
  const text = source.trim();
  let raw: Record<string, unknown>;
  if (!text.startsWith('{')) raw = { fn: text };
  else { try { raw = JSON.parse(text) as Record<string, unknown>; } catch (e) { return { error: `the plot spec is not valid JSON: ${(e as Error).message}` }; } }
  const list = Array.isArray(raw.fns) ? raw.fns : raw.fn !== undefined ? [raw.fn] : Array.isArray(raw.data) ? raw.data : [];
  const fns = list.map((f) => (typeof f === 'string' ? { fn: f } : f && typeof f === 'object' ? f as Record<string, unknown> : {})).filter((f) => typeof f.fn === 'string').slice(0, 8)
    .map((f) => ({ fn: String(f.fn), label: typeof f.label === 'string' ? f.label : String(f.fn), ...(typeof f.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(f.color) ? { color: f.color } : {}) }));
  if (!fns.length) return { error: 'no function to plot: give {"fn": "sin(x)"}' };
  const dom = Array.isArray(raw.domain) ? raw.domain : Array.isArray(raw.xDomain) ? raw.xDomain : [-10, 10];
  const domain = [Number(dom[0]), Number(dom[1])] as [number, number];
  if (!domain.every(Number.isFinite) || domain[0] >= domain[1]) return { error: '"domain" must be [low, high]' };
  const yd = Array.isArray(raw.yDomain) ? [Number(raw.yDomain[0]), Number(raw.yDomain[1])] as [number, number] : undefined;
  if (yd && (!yd.every(Number.isFinite) || yd[0] >= yd[1])) return { error: '"yDomain" must be [low, high]' };
  const points = Array.isArray(raw.points) ? (raw.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v))).slice(0, 2000) : undefined;
  try {
    const exprs = fns.map((f) => parseExpr(f.fn));
    return { spec: { ...(typeof raw.title === 'string' ? { title: raw.title } : {}), fns, domain, ...(yd ? { yDomain: yd } : {}), ...(points?.length ? { points } : {}), samples: Math.min(2000, Math.max(50, Number(raw.samples) || 600)) }, exprs };
  } catch (e) { return { error: `could not read the function: ${(e as Error).message}` }; }
}

/** Samples a function over [a, b]; breaks the line where it is undefined or jumps (asymptotes). */
export function sample(e: Expr, [a, b]: [number, number], n: number): Array<Array<[number, number]>> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k <= n; k++) { const x = a + ((b - a) * k) / n; pts.push([x, evaluate(e, x)]); }
  // A jump is a step far larger than the curve's typical step, across a change of sign (tan, 1/x).
  const steps = pts.slice(1).map(([, y], i) => Math.abs(y - pts[i]![1])).filter(Number.isFinite).sort((p, q) => p - q);
  const typical = steps.length ? steps[steps.length >> 1]! : 0;
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  let prev: number | undefined;
  for (const [x, y] of pts) {
    const jump = prev !== undefined && Math.abs(y - prev) > Math.max(1e-9, typical * 50) && Math.sign(y) !== Math.sign(prev);
    if (!Number.isFinite(y) || jump) { if (cur.length > 1) segs.push(cur); cur = Number.isFinite(y) ? [[x, y]] : []; prev = Number.isFinite(y) ? y : undefined; continue; }
    cur.push([x, y]);
    prev = y;
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

/** "Nice" tick values for an axis. */
export function ticks(lo: number, hi: number, count = 8): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** The y range to show: the samples' range, trimmed of extreme outliers (1st-99th percentile), padded. */
export function autoY(segs: Array<Array<[number, number]>>, points: Array<[number, number]> = []): [number, number] {
  const ys = [...segs.flat().map((p) => p[1]), ...points.map((p) => p[1])].sort((a, b) => a - b);
  if (!ys.length) return [-1, 1];
  const lo = ys[Math.floor(ys.length * 0.01)]!;
  const hi = ys[Math.ceil(ys.length * 0.99) - 1]!;
  const pad = (hi - lo) * 0.08 || 1;
  return [lo - pad, hi + pad];
}
