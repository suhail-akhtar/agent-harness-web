import fs from 'node:fs/promises';
import path from 'node:path';

// A verifier's measured record (docs/swarm/SWARM.md, phase 1b): how often it passed planted problems (false passes)
// and failed good work (false fails), with honest bounds. Zero misses in n trials only says the rate is below about
// 3/n; the harness orders verifiers by these bounds, not by reputation.

export interface Trial { model: string; planted: boolean; verdict: 'pass' | 'fail' | 'unknown' | 'error'; costUsd?: number; mutator?: string }

export interface Scorecard {
  model: string;
  /** Planted problems: how many, how many it passed (a miss), the 95% upper bound on its false-pass rate. */
  planted: number; falsePasses: number; falsePassUpper: number;
  /** Good changes: how many, how many it failed or could not tell, the 95% upper bound on that rate. */
  good: number; falseFails: number; falseFailUpper: number;
  /** Planted problems it answered "unknown" (not a miss, not a catch). */
  unknowns: number;
  costPerVerdict: number;
  /** False passes by kind of problem (what slips through). */
  missedBy: Record<string, number>;
  at: number;
}

/** The Wilson score interval for k successes in n trials (95%); with k = 0 the upper bound is close to 3/n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

export function scorecard(model: string, trials: Trial[], at = Date.now()): Scorecard {
  const mine = trials.filter((t) => t.model === model);
  const planted = mine.filter((t) => t.planted);
  const good = mine.filter((t) => !t.planted);
  const falsePasses = planted.filter((t) => t.verdict === 'pass');
  const falseFails = good.filter((t) => t.verdict !== 'pass');
  const missedBy: Record<string, number> = {};
  for (const t of falsePasses) missedBy[t.mutator ?? '?'] = (missedBy[t.mutator ?? '?'] ?? 0) + 1;
  const cost = mine.reduce((n, t) => n + (t.costUsd ?? 0), 0);
  return {
    model, planted: planted.length, falsePasses: falsePasses.length, falsePassUpper: wilson(falsePasses.length, planted.length)[1],
    good: good.length, falseFails: falseFails.length, falseFailUpper: wilson(falseFails.length, good.length)[1],
    unknowns: planted.filter((t) => t.verdict === 'unknown').length, costPerVerdict: mine.length ? cost / mine.length : 0, missedBy, at,
  };
}

/** Where the harness keeps verifier scorecards: one file in its data directory. */
export const scorecardFile = (dataDir: string) => path.join(dataDir, 'verifier-scorecards.json');

export async function readScorecards(dataDir: string): Promise<Scorecard[]> {
  try { const j = JSON.parse(await fs.readFile(scorecardFile(dataDir), 'utf8')) as unknown; return Array.isArray(j) ? j.filter((x): x is Scorecard => !!x && typeof x === 'object' && typeof (x as Scorecard).model === 'string') : []; } catch { return []; }
}

/** Keeps the newest scorecard per model. */
export async function writeScorecards(dataDir: string, cards: Scorecard[]): Promise<void> {
  const byModel = new Map((await readScorecards(dataDir)).map((c) => [c.model, c]));
  for (const c of cards) byModel.set(c.model, c);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(scorecardFile(dataDir), JSON.stringify([...byModel.values()], null, 1));
}

/**
 * Models in the order to try them as verifiers: those with a scorecard first, by their false-pass bound, then their
 * false-fail bound (enough trials make a bound tight); the rest after, in their given order.
 */
export function byRecord(models: string[], cards: Scorecard[]): string[] {
  const card = new Map(cards.map((c) => [c.model, c]));
  const scored = models.filter((m) => card.has(m)).sort((a, b) => card.get(a)!.falsePassUpper - card.get(b)!.falsePassUpper || card.get(a)!.falseFailUpper - card.get(b)!.falseFailUpper);
  return [...scored, ...models.filter((m) => !card.has(m))];
}
