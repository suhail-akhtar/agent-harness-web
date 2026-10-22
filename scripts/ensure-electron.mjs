// Fetches Electron's binary when npm left it out. Newer npm versions can skip dependencies' install
// scripts, which leaves node_modules/electron without dist/ (the desktop app then cannot start and its
// end-to-end test skips). Runs as the root package's postinstall; never fails the install.
// HARNESS_SKIP_ELECTRON=1 skips it (servers that never run the desktop app).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'node_modules', 'electron');
if (process.env.HARNESS_SKIP_ELECTRON === '1' || !fs.existsSync(path.join(dir, 'install.js'))) process.exit(0);
const pathTxt = path.join(dir, 'path.txt');
const have = fs.existsSync(pathTxt) && fs.existsSync(path.join(dir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim()));
if (have) process.exit(0);
console.log('Fetching the Electron binary for the desktop app (HARNESS_SKIP_ELECTRON=1 skips this)...');
const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { cwd: dir, stdio: 'inherit' });
if (r.status !== 0) console.warn('Electron could not be fetched now; run `node node_modules/electron/install.js` before `npm run desktop:dev`.');
