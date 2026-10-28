import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pack } from './archive.ts';
import { readManifest } from './loader.ts';
import { signPlugin } from './signing.ts';

// A solution as one file: <name>-<version>.tgz holding harness-solution.json and its plugins
// (plugins/<name>/, each signed on its own when a key is given), installed in one step into a harness that
// has the core: Plugins > Install from a file in the desktop app, POST /api/plugins/import on a server. The
// plugins go in in the order their "requires" needs (games3d before its engines), all or none.

export const SOLUTION_FILE = 'harness-solution.json';

export interface SolutionManifest {
  name: string;
  title: string;
  version: string;
  description?: string;
  publisher?: { name: string };
  license?: string;
  /** The core versions it runs on (npm-style range). */
  engines?: { harness?: string };
  /** Its plugins, by folder name under plugins/. */
  plugins: string[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** A solution folder's manifest, from its package.json (solutions/<name>/package.json: version, harness.title/core/plugins). */
export async function solutionFromPackage(dir: string): Promise<SolutionManifest> {
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: string; description?: string; license?: string; author?: string; harness?: { title?: string; core?: string; plugins?: string[] } };
  return checkSolution({
    name: path.basename(dir), title: pkg.harness?.title ?? path.basename(dir), version: pkg.version ?? '0.0.0',
    ...(pkg.description ? { description: pkg.description } : {}), ...(pkg.author ? { publisher: { name: pkg.author } } : {}), ...(pkg.license ? { license: pkg.license } : {}),
    ...(pkg.harness?.core ? { engines: { harness: pkg.harness.core } } : {}), plugins: pkg.harness?.plugins ?? [],
  }, `${dir}/package.json`);
}

/** The manifest at the top of an unpacked solution bundle, or undefined when it is not one. */
export async function readSolutionManifest(dir: string): Promise<SolutionManifest | undefined> {
  const raw = await fs.readFile(path.join(dir, SOLUTION_FILE), 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  let m: unknown;
  try { m = JSON.parse(raw); } catch (e) { throw new Error(`${SOLUTION_FILE}: ${(e as Error).message}`); }
  return checkSolution(m, SOLUTION_FILE);
}

function checkSolution(m: unknown, where: string): SolutionManifest {
  const s = m as Partial<SolutionManifest>;
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !NAME.test(s.name)) throw new Error(`${where}: no valid "name"`);
  if (typeof s.version !== 'string' || !s.version) throw new Error(`${where}: no "version"`);
  if (!Array.isArray(s.plugins) || !s.plugins.length || !s.plugins.every((p) => typeof p === 'string' && NAME.test(p))) throw new Error(`${where}: "plugins" must name its plugins`);
  if (new Set(s.plugins).size !== s.plugins.length) throw new Error(`${where}: a plugin is named twice`);
  return { ...s, title: typeof s.title === 'string' && s.title ? s.title : s.name } as SolutionManifest;
}

/** The plugins in an order that puts each one after what it requires inside the solution. */
export function installOrder(plugins: { name: string; requires?: string[] }[]): string[] {
  const by = new Map(plugins.map((p) => [p.name, p]));
  const out: string[] = [];
  const visiting = new Set<string>();
  const visit = (n: string) => {
    if (out.includes(n)) return;
    if (visiting.has(n)) throw new Error(`the plugins require each other in a circle (${[...visiting, n].join(' -> ')})`);
    visiting.add(n);
    for (const r of by.get(n)?.requires ?? []) if (by.has(r)) visit(r);
    visiting.delete(n);
    out.push(n);
  };
  for (const p of plugins) visit(p.name);
  return out;
}

export interface WrittenSolution { name: string; version: string; file: string; size: number; sha256: string; signed: boolean; plugins: string[] }

/** Writes a solution folder (solutions/<name>) as one bundle into `out`; each plugin signed when `key` is given. */
export async function writeSolutionBundle(dir: string, out: string, key?: string): Promise<WrittenSolution> {
  const s = await solutionFromPackage(dir);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-solution-'));
  try {
    const root = path.join(tmp, s.name);
    const found: { name: string; requires?: string[] }[] = [];
    for (const p of s.plugins) {
      const from = path.join(dir, 'plugins', p);
      const m = await readManifest(from).catch(() => undefined);
      if (!m) throw new Error(`${s.name}: plugins/${p} has no harness-plugin.json`);
      if (m.name !== p) throw new Error(`${s.name}: plugins/${p} is named "${m.name}"`);
      const to = path.join(root, 'plugins', p);
      await fs.cp(from, to, { recursive: true, filter: (f) => !/[\\/](node_modules|\.harness-data)([\\/]|$)/.test(path.relative(from, f)) });
      if (key) await signPlugin(to, key);
      found.push({ name: p, ...(m.requires ? { requires: m.requires } : {}) });
    }
    const manifest: SolutionManifest = { ...s, plugins: installOrder(found) };
    await fs.writeFile(path.join(root, SOLUTION_FILE), JSON.stringify(manifest, null, 2));
    for (const f of ['README.md', 'CHANGELOG.md']) await fs.copyFile(path.join(dir, f), path.join(root, f)).catch(() => {});
    const data = await pack(root);
    const file = `${s.name}-${s.version}.tgz`;
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(path.join(out, file), data);
    return { name: s.name, version: s.version, file, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), signed: !!key, plugins: manifest.plugins };
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
