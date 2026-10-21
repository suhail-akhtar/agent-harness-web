// The numbers behind summaries, forecasts and SLOs. Pure functions, tested on
// their own: a forecast that is wrong looks exactly as confident as one that is right.

/** min/max/avg/last/count of [t, v] points (NaN and infinities skipped). */
export function summarize(points) {
  const vs = points.map((p) => p[1]).filter((v) => Number.isFinite(v));
  if (!vs.length) return { count: 0, min: NaN, max: NaN, avg: NaN, last: NaN, first: NaN };
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of vs) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { count: vs.length, min, max, avg: sum / vs.length, last: vs[vs.length - 1], first: vs[0] };
}

/** Ordinary least squares v = a + b*t over [t, v] points: slope per unit of t, intercept, r². */
export function linearFit(points) {
  const ps = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const n = ps.length;
  if (n < 2) return { n, slope: NaN, intercept: NaN, r2: NaN };
  let st = 0, sv = 0;
  for (const [t, v] of ps) { st += t; sv += v; }
  const mt = st / n, mv = sv / n;
  let stt = 0, stv = 0, svv = 0;
  for (const [t, v] of ps) { stt += (t - mt) ** 2; stv += (t - mt) * (v - mv); svv += (v - mv) ** 2; }
  if (stt === 0) return { n, slope: NaN, intercept: NaN, r2: NaN };
  const slope = stv / stt;
  const intercept = mv - slope * mt;
  const r2 = svv === 0 ? 1 : (stv * stv) / (stt * svv);
  return { n, slope, intercept, r2 };
}

/**
 * Holt's linear trend (double exponential smoothing) over equally spaced
 * values: level and trend per step. alpha/beta are chosen by a grid search on
 * one-step-ahead squared error when not given. Returns the final level and
 * trend, the fitted parameters and the mean absolute one-step error.
 */
export function holt(values, opts = {}) {
  const vs = values.filter((v) => Number.isFinite(v));
  if (vs.length < 3) return { n: vs.length, level: NaN, trend: NaN, alpha: NaN, beta: NaN, mae: NaN };
  const run = (alpha, beta) => {
    let level = vs[0], trend = vs[1] - vs[0], sse = 0, sae = 0;
    for (let i = 1; i < vs.length; i++) {
      const forecast = level + trend;
      const err = vs[i] - forecast;
      sse += err * err; sae += Math.abs(err);
      const prev = level;
      level = alpha * vs[i] + (1 - alpha) * (level + trend);
      trend = beta * (level - prev) + (1 - beta) * trend;
    }
    return { level, trend, sse, mae: sae / (vs.length - 1) };
  };
  if (opts.alpha !== undefined && opts.beta !== undefined) {
    const r = run(opts.alpha, opts.beta);
    return { n: vs.length, level: r.level, trend: r.trend, alpha: opts.alpha, beta: opts.beta, mae: r.mae };
  }
  let best;
  for (let a = 0.05; a <= 0.951; a += 0.05) {
    for (let b = 0.05; b <= 0.951; b += 0.05) {
      const r = run(a, b);
      if (!best || r.sse < best.sse) best = { ...r, alpha: Number(a.toFixed(2)), beta: Number(b.toFixed(2)) };
    }
  }
  return { n: vs.length, level: best.level, trend: best.trend, alpha: best.alpha, beta: best.beta, mae: best.mae };
}

/**
 * Forecasts a series ([t seconds, v] points, roughly equally spaced) with both
 * methods and says when it crosses `threshold` (rising or falling toward it).
 * Times are in seconds like Prometheus. `horizon`: how far ahead to look (s).
 */
export function forecast(points, { threshold, horizon = 30 * 86400 } = {}) {
  const ps = points.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).sort((a, b) => a[0] - b[0]);
  const out = { points: ps.length, span: ps.length ? ps[ps.length - 1][0] - ps[0][0] : 0, last: ps.length ? ps[ps.length - 1][1] : NaN, lastAt: ps.length ? ps[ps.length - 1][0] : NaN };
  if (ps.length < 3) return { ...out, error: `only ${ps.length} point(s): a forecast needs at least 3 (widen the range or lower the step)` };
  const step = out.span / (ps.length - 1);
  const lin = linearFit(ps);
  const h = holt(ps.map((p) => p[1]));
  const t0 = out.lastAt;
  const linAt = (t) => lin.intercept + lin.slope * t;
  const holtAt = (dt) => h.level + h.trend * (dt / step);
  const res = {
    ...out, step,
    linear: { slopePerHour: lin.slope * 3600, slopePerDay: lin.slope * 86400, r2: lin.r2, atHorizon: linAt(t0 + horizon) },
    holt: { trendPerHour: (h.trend / step) * 3600, trendPerDay: (h.trend / step) * 86400, alpha: h.alpha, beta: h.beta, mae: h.mae, atHorizon: holtAt(horizon) },
    horizon,
  };
  if (threshold !== undefined && Number.isFinite(threshold)) {
    const cross = (slopePerSec, from) => {
      if (!Number.isFinite(slopePerSec) || slopePerSec === 0) return undefined;
      const dt = (threshold - from) / slopePerSec;
      return dt >= 0 ? dt : undefined;
    };
    const already = out.last >= threshold;
    res.threshold = threshold;
    res.alreadyOver = already;
    res.linear.secondsToThreshold = already ? 0 : cross(lin.slope, linAt(t0));
    res.holt.secondsToThreshold = already ? 0 : cross(h.trend / step, h.level);
  }
  // How far to trust it: a fit over a short span says little about a long horizon.
  res.confidence = ps.length < 10 || out.span < horizon / 20 ? 'low' : lin.r2 > 0.8 ? 'high' : lin.r2 > 0.4 ? 'medium' : 'low';
  return res;
}

/** Burn rate: how fast the error budget is spent (1 = exactly the budget over the SLO window). */
export function burnRate(errorRatio, objectivePct) {
  const budget = 1 - objectivePct / 100;
  if (!(budget > 0)) return NaN;
  return errorRatio / budget;
}

/**
 * The multi-window, multi-burn-rate checks of the SRE workbook: a long window
 * proves it is sustained, a short one that it is still happening. `ratios`:
 * error ratio per window ({ '1h': 0.02, '5m': 0.03, ... }).
 */
export const BURN_WINDOWS = [
  { long: '1h', short: '5m', factor: 14.4, severity: 'critical', budget: '2% of a 30-day budget in 1 hour' },
  { long: '6h', short: '30m', factor: 6, severity: 'critical', budget: '5% of a 30-day budget in 6 hours' },
  { long: '1d', short: '2h', factor: 3, severity: 'warning', budget: '10% of a 30-day budget in 1 day' },
  { long: '3d', short: '6h', factor: 1, severity: 'warning', budget: '10% of a 30-day budget in 3 days' },
];

export function burnAlerts(ratios, objectivePct) {
  return BURN_WINDOWS.map((w) => {
    const long = burnRate(ratios[w.long], objectivePct);
    const short = burnRate(ratios[w.short], objectivePct);
    return { ...w, longBurn: long, shortBurn: short, firing: long > w.factor && short > w.factor };
  });
}

/** Error budget left over the SLO window, given its error ratio. */
export function budgetLeft(errorRatio, objectivePct) {
  const budget = 1 - objectivePct / 100;
  return budget > 0 ? 1 - errorRatio / budget : NaN;
}

/** Collapses repeated log lines (numbers, hex ids and timestamps ignored): [{ line, count, first, last }]. */
export function dedupeLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = l.replace(/^\S*\d{4}-\d\d-\d\dT[\d:.]+Z?\s*/, '').replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/gi, '#').replace(/\d+(\.\d+)?/g, 'N').trim();
    const e = map.get(key);
    if (e) { e.count++; e.last = l; } else map.set(key, { line: l, count: 1, last: l });
  }
  return [...map.values()];
}

export const fmt = (v, digits = 3) => {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return String(Number(v.toFixed(digits)));
};

/** Seconds as "3d 4h", "45m". */
export function humanSeconds(s) {
  if (!Number.isFinite(s)) return 'never (no trend toward it)';
  if (s <= 0) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}
