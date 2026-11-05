// The production dependency closure of the harness: what the engine imports (dependencies, and the optional
// ones that are installed), as folders in the workspace's node_modules. Shared by the desktop's engine
// (apps/desktop/scripts/package.mjs) and the kit (scripts/pack-kit.mjs).
import fs from 'node:fs';
import path from 'node:path';

const pkgDir = (name, from) => {
  for (let d = from; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return path.dirname(p);
    if (path.dirname(d) === d) return null;
  }
};

/** The folder of every package the root's dependencies reach. */
export function prodClosure(repo, rootPkg) {
  const want = [...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.optionalDependencies ?? {})];
  const seen = new Set();
  const queue = want.map((n) => [n, repo]);
  while (queue.length) {
    const [name, from] = queue.shift();
    const dir = pkgDir(name, from);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {})]) queue.push([dep, dir]);
  }
  return seen;
}

/** What of a dependency ships: no tests, docs, examples, source maps or markdown. */
export const shipsFile = (dir, p) => !/[\\/](test|tests|docs|example|examples)[\\/]/.test(path.relative(dir, p)) && !p.endsWith('.map') && !p.endsWith('.md');

// A skill's own tests/ ship with it (check_skill runs them); other test folders do not.
export const shipsSource = (repo) => (p) => { const r = path.relative(repo, p); return !/[\\/](\.harness-data|test|__tests__)([\\/]|$)/.test(r) && (!/[\\/]tests([\\/]|$)/.test(r) || /[\\/](skills|builtin)[\\/][^\\/]+[\\/]tests([\\/]|$)/.test(r)) && !p.endsWith('.map'); };
