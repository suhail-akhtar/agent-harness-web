import type { Reducer, RunRecord, StateField, StateType } from './types.ts';

// Typed workflow state. A workflow declares named fields, each with a type and a
// reducer that says how a write combines with what is there: `replace` (default),
// `append` (lists), `merge` (objects, shallow), `sum` (numbers). Reducers make
// writes from parallel branches and map items order-independent where it matters
// (a count, a list of findings), so concurrent steps never overwrite each other.
//
// Values live in the run record (`run.values`), so they are saved after every
// step and survive a resume. Templates read them as {{state.field}} (dotted paths
// reach inside: {{state.plan.title}}); branch conditions test them with a small
// expression language parsed here - no eval.

export const STATE_TYPES: readonly StateType[] = ['string', 'number', 'boolean', 'list', 'object'];
export const REDUCERS: readonly Reducer[] = ['replace', 'append', 'merge', 'sum'];
/** The one type each non-replace reducer works on. */
export const REDUCER_TYPE: Record<Exclude<Reducer, 'replace'>, StateType> = { append: 'list', merge: 'object', sum: 'number' };
export const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);
const show = (v: unknown) => { const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v) ?? String(v); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };

/** A string that looks like JSON ([...] or {...}) is parsed; anything else stays as it is. */
function parseLoose(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!/^[[{]/.test(t)) return v;
  try { return JSON.parse(t); } catch { return v; }
}

export function initialValue(f: StateField): unknown {
  if (f.initial !== undefined) return clone(f.initial);
  return ({ string: '', number: 0, boolean: false, list: [], object: {} } as Record<StateType, unknown>)[f.type];
}

/** A value as the field's type, or an error saying what was wrong. Strings from templates are converted. */
export function coerce(name: string, f: StateField, v: unknown): unknown {
  const bad = (want: string) => new Error(`state.${name}: expected ${want}, got ${show(v)}`);
  switch (f.type) {
    case 'string': return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v);
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;
      if (!Number.isFinite(n)) throw bad('a number');
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0', ''].includes(s) && typeof v === 'string') return false;
      throw bad('true or false');
    }
    case 'list': { const x = parseLoose(v); if (!Array.isArray(x)) throw bad('a list (a JSON array)'); return x; }
    case 'object': { const x = parseLoose(v); if (!isObject(x)) throw bad('an object (a JSON object)'); return x; }
  }
}

/** Writes one value into a field through its reducer. Throws (with the field named) on a type mismatch. */
export function applyWrite(run: RunRecord, fields: Record<string, StateField>, name: string, value: unknown): void {
  const f = fields[name];
  if (!f) throw new Error(`state.${name} is not declared`);
  const values = (run.values ??= {});
  const cur = name in values ? values[name] : initialValue(f);
  switch (f.reducer ?? 'replace') {
    case 'replace': values[name] = coerce(name, f, value); break;
    // append: a list adds its items; any other value is one item.
    case 'append': { const x = parseLoose(value); values[name] = [...(cur as unknown[]), ...(Array.isArray(x) ? x : [x])]; break; }
    case 'merge': values[name] = { ...(cur as Record<string, unknown>), ...(coerce(name, f, value) as Record<string, unknown>) }; break;
    case 'sum': values[name] = (cur as number) + (coerce(name, f, value) as number); break;
  }
}

/** Fills in fields the record does not have yet (a new run, or a run saved before a field was declared). */
export function initState(run: RunRecord, fields: Record<string, StateField> | undefined): void {
  if (!fields) return;
  const values = (run.values ??= {});
  for (const [k, f] of Object.entries(fields)) if (!(k in values)) values[k] = initialValue(f);
}

// ---- references and templates ----

/** What a template or condition can read besides the run: a map item, its index, a node's own output. */
export interface Scope { item?: unknown; index?: number; output?: unknown }

const ROOTS = new Set(['input', 'state', 'item', 'index', 'output', 'feedback']);
const REF = /\{\{\s*([a-zA-Z_][\w-]*(?:\.[\w-]+)*)\s*\}\}/g;

function dig(v: unknown, path: string[]): unknown {
  let x = v;
  for (const p of path) {
    if (Array.isArray(x) && /^\d+$/.test(p)) x = x[Number(p)];
    else if (isObject(x)) x = x[p];
    else return undefined;
  }
  return x;
}

/** The value a dotted reference names, e.g. state.plan.title, input.request, item.path, index. */
export function lookup(ref: string, run: RunRecord, scope: Scope = {}): unknown {
  const [root, ...rest] = ref.split('.');
  switch (root) {
    case 'input': return rest.length === 1 ? run.input[rest[0]!] : undefined;
    case 'state': {
      const [name, ...more] = rest;
      if (!name) return undefined;
      // Declared fields first; otherwise a node's output (a string).
      if (run.values && name in run.values) return dig(run.values[name], more);
      return more.length ? undefined : run.state[name];
    }
    case 'item': return dig(scope.item, rest);
    case 'index': return rest.length ? undefined : scope.index;
    case 'output': return dig(scope.output, rest);
    case 'feedback': return run.feedback || '(none)';
    default: return undefined;
  }
}

export const toText = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/** Fills {{input.x}}, {{state.x}}, {{feedback}}, and in a map item {{item}}, {{index}}; lists and objects as JSON. */
export function renderTemplate(template: string, run: RunRecord, scope: Scope = {}): string {
  return template.replace(REF, (m, ref: string) => (ROOTS.has(ref.split('.')[0]!) ? toText(lookup(ref, run, scope)) : m));
}

/**
 * A shell command from a template: every value put in is quoted as one argument for
 * the shell that runs it, so an input, an agent's output or a map item can never add
 * commands of its own ("x; curl ... | sh" stays one word).
 */
export function renderShell(template: string, run: RunRecord, scope: Scope = {}, shell = 'bash'): string {
  const quote = (v: string) => (shell === 'powershell' ? `'${v.replace(/'/g, "''")}'` : `'${v.replace(/'/g, `'\\''`)}'`);
  return template.replace(REF, (m, ref: string) => (ROOTS.has(ref.split('.')[0]!) ? quote(toText(lookup(ref, run, scope))) : m));
}

/** A template that is exactly one reference gives its value as it is (a list stays a list); otherwise the rendered text. */
export function resolveTemplate(template: string, run: RunRecord, scope: Scope = {}): unknown {
  const one = /^\s*\{\{\s*([a-zA-Z_][\w-]*(?:\.[\w-]+)*)\s*\}\}\s*$/.exec(template);
  if (one && ROOTS.has(one[1]!.split('.')[0]!)) return lookup(one[1]!, run, scope);
  return renderTemplate(template, run, scope);
}

/** The references a template makes (known roots only), for validation. */
export function templateRefs(template: string): string[] {
  return [...template.matchAll(REF)].map((m) => m[1]!).filter((r) => ROOTS.has(r.split('.')[0]!));
}

// ---- structured output from an agent ----

/** The instruction appended to an agent's brief when it reports state fields. */
export function outputInstruction(names: string[], fields: Record<string, StateField>): string {
  const list = names.map((n) => `"${n}" (${fields[n]?.type ?? 'string'}${fields[n]?.description ? `: ${fields[n]!.description}` : ''})`).join(', ');
  return `\n\nEnd your report with a fenced JSON block (\`\`\`json ... \`\`\`) holding one object with these fields: ${list}.`;
}

/** The last fenced block in a report that parses as a JSON object. */
export function lastJsonBlock(report: string): Record<string, unknown> | undefined {
  const blocks = [...report.matchAll(/```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]!);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try { const v = JSON.parse(blocks[i]!); if (isObject(v)) return v; } catch { /* not this one */ }
  }
  return undefined;
}

/** The declared fields from an agent's report: the object, or an error naming what is missing or wrong. */
export function parseOutputs(report: string, names: string[], fields: Record<string, StateField>): { values?: Record<string, unknown>; error?: string } {
  const obj = lastJsonBlock(report);
  if (!obj) return { error: `the report did not end with a JSON block holding ${names.join(', ')}` };
  const missing = names.filter((n) => !(n in obj));
  if (missing.length) return { error: `the report's JSON block is missing ${missing.join(', ')}` };
  const values: Record<string, unknown> = {};
  for (const n of names) {
    const f = fields[n]!;
    // An append field takes one item or a list of items; every other reducer takes the field's own type.
    try { values[n] = (f.reducer ?? 'replace') === 'append' ? obj[n] : coerce(n, f, obj[n]); } catch (e) { return { error: (e as Error).message }; }
  }
  return { values };
}

// ---- conditions ----
//
// expr    := or
// or      := and (("||" | "or") and)*
// and     := not (("&&" | "and") not)*
// not     := ("!" | "not") not | cmp
// cmp     := operand (("==" | "!=" | ">" | ">=" | "<" | "<=") operand)?
// operand := number | 'string' | "string" | true | false | null | ref | len(ref) | contains(operand, operand) | "(" expr ")"
// ref     := (state | input | item | index) ("." name)*

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'id'; v: string } | { t: 'op'; v: string };
export type Expr =
  | { k: 'lit'; v: unknown } | { k: 'ref'; v: string }
  | { k: 'call'; f: 'len' | 'contains'; args: Expr[] }
  | { k: 'not'; e: Expr } | { k: 'bin'; op: string; a: Expr; b: Expr };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('<>!(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    if (c === '"' || c === "'") {
      let s = '';
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) s += src[j] === '\\' && j + 1 < src.length ? src[++j] : src[j];
      if (j >= src.length) throw new Error(`unclosed string at ${i + 1}`);
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const id = /^[a-zA-Z_][\w-]*(\.[\w-]+)*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new Error(`unexpected "${c}" at ${i + 1}`);
  }
  return out;
}

/** Parses a condition; throws with the position of the problem. */
export function parseCondition(src: string): Expr {
  if (typeof src !== 'string' || !src.trim()) throw new Error('empty condition');
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = peek(); return (t?.t === 'op' && t.v === v) || (t?.t === 'id' && t.v === v && ['and', 'or', 'not'].includes(v)); };
  const expect = (v: string) => { if (!isOp(v)) throw new Error(`expected "${v}"${peek() ? ` before "${String(peek()!.v)}"` : ' at the end'}`); p++; };
  const or = (): Expr => { let a = and(); while (isOp('||') || isOp('or')) { p++; a = { k: 'bin', op: '||', a, b: and() }; } return a; };
  const and = (): Expr => { let a = not(); while (isOp('&&') || isOp('and')) { p++; a = { k: 'bin', op: '&&', a, b: not() }; } return a; };
  const not = (): Expr => { if (isOp('!') || isOp('not')) { p++; return { k: 'not', e: not() }; } return cmp(); };
  const cmp = (): Expr => {
    const a = operand();
    const t = peek();
    if (t?.t === 'op' && ['==', '!=', '>', '>=', '<', '<='].includes(t.v)) { p++; return { k: 'bin', op: t.v, a, b: operand() }; }
    return a;
  };
  const operand = (): Expr => {
    const t = toks[p++];
    if (!t) throw new Error('the condition ends too early');
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') { const e = or(); expect(')'); return e; }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (t.v === 'len' || t.v === 'contains') {
        expect('(');
        const args = [operand()];
        if (t.v === 'contains') { expect(','); args.push(operand()); }
        expect(')');
        return { k: 'call', f: t.v, args };
      }
      const root = t.v.split('.')[0]!;
      if (!['state', 'input', 'item', 'index'].includes(root)) throw new Error(`unknown name "${t.v}" (use state.x, input.x, item, index)`);
      return { k: 'ref', v: t.v };
    }
    throw new Error(`unexpected "${t.v}"`);
  };
  const e = or();
  if (p < toks.length) throw new Error(`unexpected "${String(toks[p]!.v)}"`);
  return e;
}

/** Every reference a parsed condition makes. */
export function conditionRefs(e: Expr): string[] {
  switch (e.k) {
    case 'ref': return [e.v];
    case 'lit': return [];
    case 'not': return conditionRefs(e.e);
    case 'call': return e.args.flatMap(conditionRefs);
    case 'bin': return [...conditionRefs(e.a), ...conditionRefs(e.b)];
  }
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length));
const asNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

function compare(op: string, a: unknown, b: unknown): boolean {
  const x = asNumber(a);
  const y = asNumber(b);
  const numeric = x !== undefined && y !== undefined && (typeof a === 'number' || typeof b === 'number');
  if (op === '==' || op === '!=') {
    const eq = numeric ? x === y : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return op === '==' ? eq : !eq;
  }
  let c: number;
  if (x !== undefined && y !== undefined) c = x - y;
  else if (typeof a === 'string' && typeof b === 'string') c = a < b ? -1 : a > b ? 1 : 0;
  else return false;
  return op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : c <= 0;
}

function evalExpr(e: Expr, run: RunRecord, scope: Scope): unknown {
  switch (e.k) {
    case 'lit': return e.v;
    case 'ref': return lookup(e.v, run, scope);
    case 'not': return !truthy(evalExpr(e.e, run, scope));
    case 'call': {
      const v = evalExpr(e.args[0]!, run, scope);
      if (e.f === 'len') return Array.isArray(v) || typeof v === 'string' ? v.length : isObject(v) ? Object.keys(v).length : 0;
      const w = evalExpr(e.args[1]!, run, scope);
      if (Array.isArray(v)) return v.some((x) => JSON.stringify(x) === JSON.stringify(w));
      return typeof v === 'string' && v.includes(toText(w));
    }
    case 'bin':
      if (e.op === '&&') return truthy(evalExpr(e.a, run, scope)) && truthy(evalExpr(e.b, run, scope));
      if (e.op === '||') return truthy(evalExpr(e.a, run, scope)) || truthy(evalExpr(e.b, run, scope));
      return compare(e.op, evalExpr(e.a, run, scope), evalExpr(e.b, run, scope));
  }
}

/** Evaluates a condition to true or false. */
export function evaluateCondition(src: string, run: RunRecord, scope: Scope = {}): boolean {
  return truthy(evalExpr(parseCondition(src), run, scope));
}
