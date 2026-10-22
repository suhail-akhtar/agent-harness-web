/**
 * npm run desktop:test: the desktop end-to-end test (Electron, driven by playwright-core, against a
 * scripted engine: no paid calls). Builds the app first when its sources are newer than the build.
 * HARNESS_DESKTOP_SCREENSHOTS=1 also writes the screenshots in docs/screenshots/desktop/.
 * The same test runs inside `npm test`; it skips itself when Electron cannot start.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const child = spawn(process.execPath, ['--test', '--test-force-exit', '--disable-warning=ExperimentalWarning', ...process.argv.slice(2), 'test/desktop-e2e.test.ts'], { stdio: 'inherit', cwd: repo, env: { HARNESS_PLUGIN_LOOPS: 'off', ...process.env } });
child.on('exit', (code) => process.exit(code ?? 1));
