// The test suite on every OS: finds test/**/*.test.ts itself (a quoted glob in an
// npm script reaches cmd.exe with its quotes and matches nothing) and runs them.
//   node scripts/test.mjs [--test-name-pattern=...] [files...]
//
// The Electron end-to-end files (test/desktop-*e2e*.test.ts) run after the rest, one after
// another: never in parallel with each other or with the other tests (their timing checks need
// a quiet machine, and their windows are hidden: HARNESS_E2E_SHOW=1 shows them).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.test.ts') ? [path.join(d, e.name)] : []));
  files = walk(path.join(root, 'test')).map((f) => path.relative(root, f)).sort();
}
const isElectron = (f) => /(^|[\\/])desktop-[^\\/]*e2e[^\\/]*\.test\.ts$/.test(f);
const batches = [files.filter((f) => !isElectron(f)), ...files.filter(isElectron).map((f) => [f])].filter((b) => b.length);

// Plugins' background loops (the aiops watch loop) stay off in tests unless a test turns them on.
// The harness home is a temporary folder of the run's own (never the person's ~/.harness), removed after.
const home = process.env.HARNESS_HOME ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-home-'));
const env = { HARNESS_PLUGIN_LOOPS: 'off', ...(home ? { HARNESS_HOME: home } : {}), ...process.env };
const run = (batch) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--test', '--test-force-exit', '--disable-warning=ExperimentalWarning', ...flags, ...batch], { stdio: 'inherit', cwd: root, env });
  child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
let failed = 0;
for (const b of batches) {
  if (batches.length > 1 && isElectron(b[0])) console.log(`\n# ${b[0]} (Electron, on its own)`);
  if (await run(b)) failed++;
}
if (home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* a file still open */ } }
if (batches.length > 1) console.log(`\n# ${batches.length} batch(es), ${failed} failed`);
process.exit(failed ? 1 : 0);
