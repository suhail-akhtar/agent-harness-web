// A realistic, deterministic sales fixture (orders over two years, three regions, nine countries,
// products in categories, channels, discounts) for the dashboards tests, the e2e and the live run.
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeXlsx } from '../../../src/data/xlsx.ts';

const GEO: Array<[string, string, string[]]> = [
  ['EMEA', 'United Kingdom', ['London', 'Manchester']], ['EMEA', 'Germany', ['Berlin', 'Munich']], ['EMEA', 'France', ['Paris', 'Lyon']],
  ['Americas', 'United States', ['New York', 'Chicago', 'Austin']], ['Americas', 'Canada', ['Toronto']], ['Americas', 'Brazil', ['Sao Paulo']],
  ['APAC', 'Japan', ['Tokyo', 'Osaka']], ['APAC', 'Australia', ['Sydney']], ['APAC', 'India', ['Bengaluru', 'Mumbai']],
];
const PRODUCTS: Array<[string, string, number, number]> = [
  ['P-100', 'Laptop Pro', 1450, 0.62], ['P-110', 'Laptop Air', 980, 0.66], ['P-200', 'Monitor 27', 320, 0.58], ['P-210', 'Monitor 32', 460, 0.6],
  ['P-300', 'Keyboard', 85, 0.45], ['P-310', 'Mouse', 45, 0.4], ['P-400', 'Headset', 140, 0.5], ['P-500', 'Dock', 210, 0.55],
];
const CATEGORY: Record<string, string> = { 'P-100': 'Computers', 'P-110': 'Computers', 'P-200': 'Displays', 'P-210': 'Displays', 'P-300': 'Accessories', 'P-310': 'Accessories', 'P-400': 'Accessories', 'P-500': 'Accessories' };

/** A small linear congruential generator: the same rows on every machine. */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

export interface SalesFixture { columns: string[]; rows: Array<Array<string | number>>; regions: Array<[string, string, string]>; products: Array<[string, string, string, number]> }

export function salesFixture(n = 2400, seed = 7): SalesFixture {
  const r = rng(seed);
  const rows: Array<Array<string | number>> = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const day = Math.floor(r() * 730);
    const d = new Date(start + day * 86_400_000);
    // Growth over time and a Q4 season.
    const season = [0.9, 0.85, 1, 0.95, 1, 1.05, 0.9, 0.95, 1.1, 1.15, 1.3, 1.45][d.getUTCMonth()]!;
    const [region, country, cities] = GEO[Math.floor(r() * GEO.length)]!;
    const city = cities[Math.floor(r() * cities.length)]!;
    const [code, , price, costShare] = PRODUCTS[Math.floor(r() * PRODUCTS.length)]!;
    const units = 1 + Math.floor(r() * 6 * season * (1 + day / 1460));
    const channel = r() < 0.55 ? 'Online' : r() < 0.7 ? 'Retail' : 'Partner';
    const discount = channel === 'Partner' ? 0.1 : r() < 0.15 ? 0.05 : 0;
    const revenue = Math.round(units * price * (1 - discount) * 100) / 100;
    const cost = Math.round(units * price * costShare * 100) / 100;
    rows.push([`SO-${String(10001 + i)}`, d.toISOString().slice(0, 10), region, country, city, code, channel, units, price, discount, revenue, cost]);
  }
  rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])) || String(a[0]).localeCompare(String(b[0])));
  return {
    columns: ['order_id', 'order_date', 'region', 'country', 'city', 'product_code', 'channel', 'units', 'unit_price', 'discount', 'revenue', 'cost'],
    rows,
    regions: GEO.map(([region, country]) => [country, region, region === 'EMEA' ? 'usr_emea' : region === 'Americas' ? 'usr_amer' : 'usr_apac']),
    products: PRODUCTS.map(([code, name, price]) => [code, name, CATEGORY[code]!, price]),
  };
}

/** Writes sales.xlsx (Orders and Products sheets) and countries.csv into a folder. */
export async function writeSalesFiles(dir: string, n?: number): Promise<{ xlsx: string; csv: string; fixture: SalesFixture }> {
  const f = salesFixture(n);
  await fs.mkdir(dir, { recursive: true });
  const xlsx = path.join(dir, 'sales.xlsx');
  await fs.writeFile(xlsx, writeXlsx([{ name: 'Orders', columns: f.columns, rows: f.rows }, { name: 'Products', columns: ['product_code', 'product', 'category', 'list_price'], rows: f.products }]));
  const csv = path.join(dir, 'countries.csv');
  await fs.writeFile(csv, `country,region,manager\n${f.regions.map((x) => x.join(',')).join('\n')}\n`);
  return { xlsx, csv, fixture: f };
}
