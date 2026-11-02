// The forecasting ledger's arithmetic (docs/swarm/SWARM.md, phase 5), in code so no model does it: the aggregate of
// several forecasters (a trimmed mean in log-odds, extremized, capped), Brier and log scores, a calibration table, and
// the extremizing factor refitted from resolved questions.

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (p, lo, hi) => Math.min(hi, Math.max(lo, p));

/**
 * The aggregate of forecasters' probabilities: each clamped to [0.01, 0.99], the top and bottom `trim` share dropped
 * (when at least 4 remain), the mean taken in log-odds, multiplied by `extremize` (sqrt(3) by default: independent
 * forecasters each hold part of the evidence, so their mean is too timid), and capped to [cap, 1 - cap].
 */
export function aggregate(ps, { trim = 0.2, extremize = Math.sqrt(3), cap = 0.02 } = {}) {
  const xs = ps.filter((p) => typeof p === 'number' && Number.isFinite(p)).map((p) => logit(clamp(p, 0.01, 0.99))).sort((a, b) => a - b);
  if (!xs.length) return undefined;
  const k = xs.length - 2 * Math.floor(xs.length * trim) >= 4 ? Math.floor(xs.length * trim) : 0;
  const kept = xs.slice(k, xs.length - k);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return clamp(sigmoid(mean * extremize), cap, 1 - cap);
}

/** Brier score of probability p for an outcome (1 or 0): 0 is perfect, 0.25 is a coin. */
export const brier = (p, outcome) => (p - outcome) ** 2;
/** Log score (natural log loss): lower is better; a coin scores 0.693. */
export const logLoss = (p, outcome) => -Math.log(clamp(outcome ? p : 1 - p, 1e-6, 1));

/** Scores over resolved questions: per forecaster (by model) and for the aggregate, with how many each had. */
export function scores(questions) {
  const resolved = questions.filter((q) => q.resolution === 0 || q.resolution === 1);
  const by = new Map();
  const add = (who, p, o) => { const s = by.get(who) ?? { n: 0, brier: 0, log: 0 }; s.n++; s.brier += brier(p, o); s.log += logLoss(p, o); by.set(who, s); };
  for (const q of resolved) {
    for (const f of q.forecasts ?? []) if (typeof f.p === 'number') add(f.model, f.p, q.resolution);
    if (typeof q.aggregate === 'number') add('aggregate', q.aggregate, q.resolution);
    if (typeof q.market === 'number') add('market', q.market, q.resolution);
  }
  return [...by.entries()].map(([who, s]) => ({ who, n: s.n, brier: +(s.brier / s.n).toFixed(4), log: +(s.log / s.n).toFixed(4) })).sort((a, b) => a.brier - b.brier);
}

/** Calibration: resolved forecasts in probability buckets, with how often the event happened in each. */
export function calibration(questions, buckets = 5) {
  const rows = Array.from({ length: buckets }, (_, i) => ({ from: i / buckets, to: (i + 1) / buckets, n: 0, happened: 0, meanP: 0 }));
  for (const q of questions) {
    if (!(q.resolution === 0 || q.resolution === 1) || typeof q.aggregate !== 'number') continue;
    const r = rows[Math.min(buckets - 1, Math.floor(q.aggregate * buckets))];
    r.n++; r.happened += q.resolution; r.meanP += q.aggregate;
  }
  return rows.map((r) => ({ ...r, meanP: r.n ? +(r.meanP / r.n).toFixed(3) : null, rate: r.n ? +(r.happened / r.n).toFixed(3) : null }));
}

/**
 * The extremizing factor that would have scored best (Brier) on the resolved questions, from 1 to 3 in steps of 0.05:
 * refitted only when at least `min` questions are resolved (fewer say nothing), else undefined.
 */
export function refitExtremize(questions, { min = 20, trim = 0.2, cap = 0.02 } = {}) {
  const resolved = questions.filter((q) => (q.resolution === 0 || q.resolution === 1) && (q.forecasts ?? []).some((f) => typeof f.p === 'number'));
  if (resolved.length < min) return undefined;
  let best = { a: Math.sqrt(3), brier: Infinity };
  for (let a = 1; a <= 3.0001; a += 0.05) {
    const b = resolved.reduce((s, q) => s + brier(aggregate(q.forecasts.map((f) => f.p), { trim, extremize: a, cap }), q.resolution), 0) / resolved.length;
    if (b < best.brier) best = { a: +a.toFixed(2), brier: +b.toFixed(4) };
  }
  return best;
}
