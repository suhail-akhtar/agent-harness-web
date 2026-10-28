/**
 * npm run desktop:build: packages Harness Desktop with electron-builder.
 *
 *   node scripts/package.mjs [--dir-only]
 *
 * 1. Builds the app (scripts/build.mjs).
 * 2. Stages it in a temporary folder: the built dist/ and a minimal package.json (the app
 *    needs no node_modules of its own: main and preload are bundled, the interface is static).
 * 3. Stages the engine in apps/desktop/release/engine: the harness server's sources (src/, plugins/,
 *    package.json) and the production dependencies it imports, copied from the workspace's
 *    node_modules (no network). Electron runs it in a utility process from resources/engine.
 * 4. Runs electron-builder: an unpacked app (--dir); copies the engine's dependencies into its
 *    resources/engine (electron-builder leaves node_modules out of extra resources); then, unless
 *    --dir-only, the NSIS installer from that app (dmg on macOS, AppImage on Linux). Output in
 *    apps/desktop/release/.
 *
 * The product profile (products/harness.json, or HARNESS_PRODUCT=path) gives the name, the app id
 * and the icon; it is shipped as resources/product.json.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '..', '..');
const release = path.join(desktop, 'release');
// Outside the workspace: electron-builder would otherwise collect the workspace's node_modules into the app.
const stage = path.join(os.tmpdir(), 'harness-desktop-stage');
const engine = path.join(release, 'engine');
const dirOnly = process.argv.includes('--dir-only');

const productFile = path.resolve(process.env.HARNESS_PRODUCT ?? path.join(repo, 'products', 'harness.json'));
const product = JSON.parse(fs.readFileSync(productFile, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const iconSrc = product.brand?.icon ? path.resolve(path.dirname(productFile), product.brand.icon) : null;

const step = (m) => console.log(`\n[package] ${m}`);
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repo, shell: process.platform === 'win32' && !cmd.endsWith('.exe') && cmd !== process.execPath, ...opts }); if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args.join(' ')} failed (${r.status})`); };
const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, dereference: true, filter: filter ?? (() => true) });

step('building');
run(process.execPath, [path.join(here, 'build.mjs')]);

step('staging the app');
fs.rmSync(release, { recursive: true, force: true });
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
copy(path.join(desktop, 'dist'), path.join(stage, 'dist'), (p) => !p.endsWith('.map'));
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'harness-desktop', productName: product.name, version: pkg.version, description: product.description ?? pkg.description, author: pkg.author, main: 'dist/main.cjs' }, null, 2));

step('staging the engine');
const skip = (p) => !/[\\/](\.harness-data|test|tests|__tests__)([\\/]|$)/.test(path.relative(repo, p)) && !p.endsWith('.map');
copy(path.join(repo, 'src'), path.join(engine, 'src'), skip);
copy(path.join(repo, 'plugins'), path.join(engine, 'plugins'), skip);
// The server validates plugin UI manifests with the shared contract.
copy(path.join(repo, 'packages', 'plugin-ui', 'src'), path.join(engine, 'packages', 'plugin-ui', 'src'), skip);
// Plugin code imports the harness's abilities from @harness/plugin-sdk/runtime (resolved to these files: src/plugins/resolve.ts).
copy(path.join(repo, 'packages', 'plugin-sdk', 'src'), path.join(engine, 'packages', 'plugin-sdk', 'src'), skip);
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(engine, 'package.json'), JSON.stringify({ name: 'harness-engine', private: true, type: rootPkg.type ?? 'module', version: rootPkg.version }, null, 2));
// The production dependency closure (dependencies, and the optional ones that are installed).
const want = [...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.optionalDependencies ?? {})];
const seen = new Set();

const pkgDir = (name, from) => {
  for (let d = from; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return path.dirname(p);
    if (path.dirname(d) === d) return null;
  }
};
const queue = want.map((n) => [n, repo]);
while (queue.length) {
  const [name, from] = queue.shift();
  const dir = pkgDir(name, from);
  if (!dir || seen.has(dir)) continue;
  seen.add(dir);
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dep of [...Object.keys(p.dependencies ?? {}), ...Object.keys(p.optionalDependencies ?? {})]) queue.push([dep, dir]);
}

for (const dir of seen) copy(dir, path.join(engine, path.relative(repo, dir)), (p) => !/[\\/](test|tests|docs|example|examples)[\\/]/.test(path.relative(dir, p)) && !p.endsWith('.map') && !p.endsWith('.md'));
console.log(`  ${seen.size} packages`);

step('electron-builder');
const config = {
  appId: product.appId ?? 'dev.harness.desktop',
  productName: product.name,
  directories: { app: stage, output: release, buildResources: path.join(release, 'build') },
  files: ['dist/**', 'package.json', '!**/node_modules/**'],
  asar: true,
  extraResources: [
    // Without its node_modules: electron-builder leaves them out of extra resources whatever the filter
    // says; they are copied into the unpacked app below, before the installer is made from it.
    { from: engine, to: 'engine' },
    { from: productFile, to: 'product.json' },
    ...(iconSrc && fs.existsSync(iconSrc) ? [{ from: iconSrc, to: 'icon.png' }] : []),
  ],
  ...(iconSrc && fs.existsSync(iconSrc) ? { icon: iconSrc } : {}),
  electronVersion: JSON.parse(fs.readFileSync(path.join(path.dirname(createRequire(import.meta.url).resolve('electron/package.json')), 'package.json'), 'utf8')).version,
  npmRebuild: false,
  win: { target: ['dir'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false },
  mac: { target: ['dir'], category: 'public.app-category.developer-tools' },
  linux: { target: ['dir'], category: 'Development' },
  protocols: [{ name: product.name, schemes: ['harness'] }],
};
const configFile = path.join(release, 'electron-builder.json');
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
const builder = path.join(path.dirname(createRequire(import.meta.url).resolve('electron-builder/package.json')), 'cli.js');
const platform = process.platform === 'win32' ? '--win' : process.platform === 'darwin' ? '--mac' : '--linux';
// From the staging folder, so electron-builder sees no workspace (and adds no node_modules: the app needs none).
run(process.execPath, [builder, '--projectDir', stage, '--config', configFile, platform], { cwd: stage });

// The engine's production dependencies, into the unpacked app's resources/engine (the engine imports them).
const unpacked = fs.readdirSync(release).map((d) => path.join(release, d)).find((d) => /^(win|linux)(-[a-z0-9]+)?-unpacked$|^mac/.test(path.basename(d)) && fs.statSync(d).isDirectory());
if (!unpacked) throw new Error(`no unpacked app in ${release}`);
const resources = process.platform === 'darwin'
  ? path.join(unpacked, fs.readdirSync(unpacked).find((d) => d.endsWith('.app')) ?? '', 'Contents', 'Resources')
  : path.join(unpacked, 'resources');
step('the engine\'s dependencies');
fs.rmSync(path.join(resources, 'engine', 'node_modules'), { recursive: true, force: true });
copy(path.join(engine, 'node_modules'), path.join(resources, 'engine', 'node_modules'));
if (!fs.existsSync(path.join(resources, 'engine', 'node_modules', '@anthropic-ai', 'sdk', 'package.json'))) throw new Error('the engine\'s dependencies did not reach the app');

// The installer, from that unpacked app.
if (!dirOnly) {
  const installer = { ...config, win: { target: ['nsis'] }, mac: { ...config.mac, target: ['dmg'] }, linux: { ...config.linux, target: ['AppImage'] } };
  fs.writeFileSync(configFile, JSON.stringify(installer, null, 2));
  step('installer');
  run(process.execPath, [builder, '--projectDir', stage, '--config', configFile, platform, '--prepackaged', process.platform === 'darwin' ? path.dirname(resources).replace(/[\\/]Contents$/, '') : unpacked], { cwd: stage });
}
// Each shipped plugin as its own installable bundle beside the installer (release/plugins: <name>-<version>.tgz
// and index.json): import one on another computer, or serve the folder as a catalogue.
step('plugin bundles');
fs.rmSync(path.join(release, 'plugins'), { recursive: true, force: true });
run(process.execPath, [path.join(repo, 'scripts', 'run.mjs'), 'src/plugins/cli.ts', 'bundles', '--out', path.join(release, 'plugins')]);
console.log(`\n[package] done: ${path.relative(repo, release)}`);
