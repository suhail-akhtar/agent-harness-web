import fs from 'node:fs';
import path from 'node:path';

// Where a harness's own plugins are, in its checkout and in a packaged engine:
//   plugins/<name>                         the plugins that ship with the core (visual, documents, research, ...)
//   solutions/<solution>/plugins/<name>    a solution's plugins (Studio: games3d and its engines), each solution
//                                          with its own version, tests, evals and docs (solutions/<solution>/)
// A packaged engine holds the solutions its product ships (products/*.json "solutions"); the others are
// installed as bundles.

/** The solutions in this harness's folder (solutions/<name> with a plugins/ folder), by name. */
export function solutionDirs(appRoot: string): string[] {
  const root = path.join(appRoot, 'solutions');
  let names: string[];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; }
  return names.map((n) => path.join(root, n)).filter((d) => fs.existsSync(path.join(d, 'plugins')));
}

/** The folders of plugin folders shipped with this harness: plugins/, then each solution's plugins/. */
export function shippedPluginDirs(appRoot: string): string[] {
  return [path.join(appRoot, 'plugins'), ...solutionDirs(appRoot).map((d) => path.join(d, 'plugins'))];
}

/** A shipped plugin's folder by name (the core's plugins first), or undefined. */
export function shippedPluginDir(appRoot: string, name: string): string | undefined {
  return shippedPluginDirs(appRoot).map((r) => path.join(r, name)).find((d) => fs.existsSync(path.join(d, 'harness-plugin.json')));
}

/** The eval packs' folders: evals/, then each solution's evals/. */
export function evalDirs(appRoot: string): string[] {
  return [path.join(appRoot, 'evals'), ...solutionDirs(appRoot).map((d) => path.join(d, 'evals')).filter((d) => fs.existsSync(d))];
}
