// Installs DuckDB's native binding for this platform when npm left it out. Some npm versions skip a
// package's platform-specific optional dependencies when the lockfile was written on another
// platform, which leaves @duckdb/node-bindings without its binary (the data engine then cannot
// start). Runs as part of the root postinstall; never fails the install.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bindings = path.join(root, 'node_modules', '@duckdb', 'node-bindings', 'package.json');
if (!fs.existsSync(bindings)) process.exit(0);
const { version } = JSON.parse(fs.readFileSync(bindings, 'utf8'));
const musl = process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime;
const name = `@duckdb/node-bindings-${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
if (fs.existsSync(path.join(root, 'node_modules', ...name.split('/'), 'duckdb.node'))) process.exit(0);
console.log(`Installing ${name}@${version} (npm skipped it)...`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['install', '--no-save', '--no-audit', '--no-fund', '--ignore-scripts', `${name}@${version}`], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) console.warn(`${name} could not be installed now; run \`npm install --no-save ${name}@${version}\` before using dashboards.`);
