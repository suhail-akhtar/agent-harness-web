// Seeded randomness: every generator takes a seed and gives the same output for it.
// mulberry32 for the stream, a string hash for seeds given as text.

/** A 32-bit seed from a number or a string. */
export function seedOf(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed ?? 0);
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A random stream: next() in [0, 1), and helpers. */
export function rng(seed) {
  let a = seedOf(seed) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    /** A float in [a, b). */
    range: (lo, hi) => lo + (hi - lo) * next(),
    /** An integer in [lo, hi] (both included). */
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** A choice by weight: items [{ weight }] or a parallel weights array. */
    weighted(items, weights = items.map((x) => x.weight ?? 1)) {
      const total = weights.reduce((s, w) => s + w, 0);
      let v = next() * total;
      for (let i = 0; i < items.length; i++) { v -= weights[i]; if (v < 0) return items[i]; }
      return items[items.length - 1];
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      return arr;
    },
    gauss: (mean = 0, sd = 1) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
    /** A child stream: the same parent seed and label always give the same child. */
    fork: (label) => rng(seedOf(`${a}:${label}`)),
  };
  return r;
}

/** A stable 32-bit hash of integers (for lattice noise and per-cell randomness). */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export const hash01 = (x, y, seed = 0) => hash2(x, y, seed) / 4294967296;
