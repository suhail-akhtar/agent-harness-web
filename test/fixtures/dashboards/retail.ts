// A retail fixture for drill and multi-source tests: 32 stores in a five-level geography
// (region > country > state > city > store) and two years of daily sales, generated
// deterministically, with the truth computed here in plain code (no engine).
import fs from 'node:fs/promises';
import path from 'node:path';

export const GEO_LEVELS = ['region', 'country', 'state', 'city', 'store'] as const;
export interface Sale { day: string; store: string; amount: number; qty: number }
export interface Store { store: string; city: string; state: string; country: string; region: string }

export function retail(): { sales: Sale[]; stores: Store[] } {
  const regions = { EMEA: ['France', 'Germany'], AMER: ['Canada', 'Brazil'] } as const;
  const stores: Store[] = [];
  let n = 0;
  for (const [region, countries] of Object.entries(regions)) for (const country of countries) for (const s of [1, 2]) for (const c of [1, 2]) for (const k of [1, 2]) {
    n++;
    stores.push({ store: `S${String(n).padStart(2, '0')}`, city: `${country.slice(0, 3)}-${s}-City${c}`, state: `${country.slice(0, 3)}-State${s}`, country, region });
  }
  // A small linear congruential generator: the same rows every time.
  let seed = 7;
  const rnd = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const sales: Sale[] = [];
  const start = Date.UTC(2023, 0, 1);
  for (let i = 0; i < 1500; i++) {
    const day = new Date(start + Math.floor(rnd() * 731) * 86_400_000).toISOString().slice(0, 10);
    sales.push({ day, store: stores[Math.floor(rnd() * stores.length)]!.store, amount: 10 + Math.floor(rnd() * 490), qty: 1 + Math.floor(rnd() * 9) });
  }
  return { sales, stores };
}

export async function writeRetail(dir: string): Promise<{ sales: Sale[]; stores: Store[] }> {
  const r = retail();
  await fs.writeFile(path.join(dir, 'retail_sales.csv'), `day,store,amount,qty\n${r.sales.map((s) => `${s.day},${s.store},${s.amount},${s.qty}`).join('\n')}\n`);
  await fs.writeFile(path.join(dir, 'retail_stores.csv'), `store,city,state,country,region\n${r.stores.map((s) => `${s.store},${s.city},${s.state},${s.country},${s.region}`).join('\n')}\n`);
  return r;
}

/** A date at a grain, as the engine returns it ("YYYY-MM-DD" of the period's first day; weeks start on Monday). */
export function grainOf(day: string, g: 'year' | 'quarter' | 'month' | 'week' | 'day'): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (g === 'year') return `${day.slice(0, 4)}-01-01`;
  if (g === 'quarter') return `${day.slice(0, 4)}-${String(Math.floor(d.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  if (g === 'month') return `${day.slice(0, 7)}-01`;
  if (g === 'week') { const w = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000); return w.toISOString().slice(0, 10); }
  return day;
}

/** Sums by a key over the rows that pass a filter, rounded to cents. */
export function sumBy<T>(rows: T[], key: (r: T) => string, val: (r: T) => number, keep: (r: T) => boolean = () => true): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (keep(r)) m.set(key(r), Math.round(((m.get(key(r)) ?? 0) + val(r)) * 100) / 100);
  return m;
}
