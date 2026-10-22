/**
 * npm run desktop:dev: builds Harness Desktop for development, starts Electron, and keeps rebuilding.
 *   - the interface (renderer, packages/ui, packages/client): Vite in watch mode; the window reloads;
 *   - main and preload (electron/, shared/): esbuild in watch mode; Electron restarts;
 *   - the engine runs the harness server from source, so a server change needs an engine restart
 *     (Settings > Application > Restart engine) or an app restart.
 * Extra folders of plugins under development: HARNESS_DESKTOP_DEV_PLUGINS=dir1;dir2 (path delimiter).
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const dist = path.join(desktop, 'dist');
const electron = createRequire(import.meta.url)('electron');

const first = spawnSync(process.execPath, [path.join(here, 'build.mjs'), '--dev'], { stdio: 'inherit', cwd: repo });
if (first.status !== 0) process.exit(first.status ?? 1);

let child = null;
let restarting = false;
function start() {
  child = spawn(electron, [desktop], { stdio: 'inherit', env: { ...process.env, HARNESS_DESKTOP_DEV_RELOAD: '1' } });
  child.on('exit', (code) => { if (restarting) { restarting = false; start(); } else process.exit(code ?? 0); });
}
function restart() {
  if (!child) return start();
  restarting = true;
  child.kill();
}

// Main and preload: rebuild and restart Electron.
const alias = { '@harness/plugin-ui': path.join(repo, 'packages/plugin-ui/src/index.ts') };
let ready = false;
const restartOnEnd = { name: 'restart', setup(b) { b.onEnd((r) => { if (ready && !r.errors.length) { console.log('[dev] main rebuilt: restarting Electron'); restart(); } }); } };
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning', plugins: [restartOnEnd] };
const mainCtx = await context({ ...common, entryPoints: [path.join(desktop, 'electron/main.ts')], outfile: path.join(dist, 'main.cjs'), alias, sourcemap: 'linked' });
const preloadCtx = await context({ ...common, entryPoints: [path.join(desktop, 'electron/preload.ts')], outfile: path.join(dist, 'preload.cjs') });
await Promise.all([mainCtx.watch(), preloadCtx.watch()]);

// The interface: Vite watch (keeps the runtime files next to it: no emptying).
process.env.HARNESS_NO_MINIFY = '1';
const { build: viteBuild } = await import('vite');
await viteBuild({ configFile: path.join(desktop, 'renderer/vite.config.ts'), logLevel: 'warn', mode: 'development', build: { watch: {}, emptyOutDir: false } });

ready = true;
start();
const stop = () => { restarting = false; child?.kill(); void mainCtx.dispose(); void preloadCtx.dispose(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
