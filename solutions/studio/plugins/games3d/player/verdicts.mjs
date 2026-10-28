// Claims checked against evidence. State checks read the game's state over a run:
//   {path: 'coins', op: '>=', value: 5, when: 'ever'}     reached at some point (the default)
//   {path: 'won', op: '==', value: true, when: 'end'}     true when the run ended
//   {path: '$errors', op: '>', value: 0, when: 'never'}  no uncaught error, ever
// when: 'ever' (some sample satisfies it), 'end' (the last sample), 'always' (every sample),
// 'never' (no sample satisfies it). Paths are dotted into the state ("player.x", "targets.length");
// $errors, $crashed, $softlocks, $stuck, $goal and $t (seconds) are what the run itself saw.
// Vision claims are verdicts too: the agent judges frames itself and records them, or a model
// judge (a sub-agent reading a few sampled frames) does; both cite the frame they used.

import { getPath } from './analysis.mjs';

export const OPS = {
  '==': (a, b) => JSON.stringify(a) === JSON.stringify(b), '!=': (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  truthy: (a) => !!a, falsy: (a) => !a, exists: (a) => a !== undefined && a !== null,
  includes: (a, b) => (Array.isArray(a) || typeof a === 'string') && a.includes(b),
};
export const WHEN = ['ever', 'end', 'always', 'never'];

export function describeCheck(c) {
  const op = c.op ?? 'truthy';
  return `${c.path} ${op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ''} (${c.when ?? 'ever'})`;
}

/** A check's problem, or null when it is well formed. */
export function checkError(c) {
  if (!c || typeof c !== 'object' || typeof c.path !== 'string' || !c.path) return 'a check needs a path, e.g. {"path": "coins", "op": ">=", "value": 5}';
  if (!OPS[c.op ?? 'truthy']) return `unknown op "${c.op}" (${Object.keys(OPS).join(' ')})`;
  if (c.when && !WHEN.includes(c.when)) return `unknown when "${c.when}" (${WHEN.join(', ')})`;
  return null;
}

/** One sample of a run for checks: the state plus what the run saw so far. */
export function sample(t, state, run) {
  return { t, state, vars: { $errors: run.errors?.length ?? 0, $crashed: !!run.crashed, $softlocks: run.softlocks?.length ?? 0, $stuck: run.stuck?.length ?? 0, $goal: !!run.goalReached, $t: Math.round(t) / 1000 } };
}

const valueAt = (s, p) => (p.startsWith('$') ? s.vars?.[p] : getPath(s.state, p));

/** Evaluates a check over samples: a verdict {by: 'state', claim, pass, evidence, detail}. */
export function evaluateCheck(c, samples) {
  const claim = c.claim ?? describeCheck(c);
  const bad = checkError(c);
  if (bad) return { by: 'state', claim, pass: false, detail: bad };
  if (!samples.length) return { by: 'state', claim, pass: false, detail: 'no state was read in this run' };
  const op = OPS[c.op ?? 'truthy'];
  const when = c.when ?? 'ever';
  const holds = (s) => { const v = valueAt(s, c.path); return { ok: !!op(v, c.value), v }; };
  if (when === 'end') {
    const last = samples[samples.length - 1];
    const { ok, v } = holds(last);
    return { by: 'state', claim, pass: ok, at: last.t / 1000, detail: `at the end (${(last.t / 1000).toFixed(1)}s): ${JSON.stringify(v)}` };
  }
  if (when === 'ever') {
    for (const s of samples) { const { ok, v } = holds(s); if (ok) return { by: 'state', claim, pass: true, at: s.t / 1000, detail: `first held at ${(s.t / 1000).toFixed(1)}s: ${JSON.stringify(v)}` }; }
    const last = samples[samples.length - 1];
    return { by: 'state', claim, pass: false, detail: `never held in ${samples.length} samples; last value ${JSON.stringify(valueAt(last, c.path))}` };
  }
  for (const s of samples) {
    const { ok, v } = holds(s);
    if (when === 'always' && !ok) return { by: 'state', claim, pass: false, at: s.t / 1000, detail: `broke at ${(s.t / 1000).toFixed(1)}s: ${JSON.stringify(v)}` };
    if (when === 'never' && ok) return { by: 'state', claim, pass: false, at: s.t / 1000, detail: `held at ${(s.t / 1000).toFixed(1)}s: ${JSON.stringify(v)}` };
  }
  return { by: 'state', claim, pass: true, detail: `${when === 'always' ? 'held' : 'never held'} in all ${samples.length} samples` };
}

/** The frame nearest a time (seconds) among run frames ({t in ms}), its index. */
export function frameNear(frames, atS) {
  if (!frames.length || atS === undefined) return -1;
  let best = 0;
  frames.forEach((f, i) => { if (Math.abs(f.t / 1000 - atS) < Math.abs(frames[best].t / 1000 - atS)) best = i; });
  return best;
}

/** Reads a judge's answer: one JSON object per claim ({claim, pass, frame, why}), in a list or lines. */
export function parseJudgement(text, claims) {
  const found = [];
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const list = tryParse(/\[[\s\S]*\]/.exec(text)?.[0] ?? '') ?? [...text.matchAll(/\{[^{}]*\}/g)].map((m) => tryParse(m[0])).filter(Boolean);
  for (const x of Array.isArray(list) ? list : []) {
    if (!x || typeof x !== 'object' || typeof x.pass !== 'boolean') continue;
    const claim = typeof x.claim === 'string' ? x.claim : claims[found.length];
    found.push({ claim, pass: x.pass, frame: typeof x.frame === 'string' ? x.frame : undefined, why: typeof x.why === 'string' ? x.why.slice(0, 300) : undefined });
  }
  return claims.map((c) => found.find((f) => f.claim === c) ?? found[claims.indexOf(c)] ?? null);
}
