// The test suite on every OS: finds test/**/*.test.ts, each plugin's plugins/<name>/test/**/*.test.ts and each solution's
// solutions/<solution>/test/** and solutions/<solution>/plugins/<name>/test/** itself (a quoted glob in an npm script
// reaches cmd.exe with its quotes and matches nothing) and runs them.
//   node scripts/test.mjs [--test-name-pattern=...] [--core | --solution=<name>] [files...]
// --core: the core's tests and its plugins' only; --solution=studio: that solution's only.
//
// The end-to-end files (test/*e2e*.test.ts: Electron or a real browser) run after the rest, one
// after another: never in parallel with each other or with the other tests (their timing checks
// need a quiet machine; their windows are off-screen and unfocused: HARNESS_E2E_SHOW=1 shows them).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ours = (a) => a === '--core' || a.startsWith('--solution=');
const flags = process.argv.slice(2).filter((a) => a.startsWith('--') && !ours(a));
const only = process.argv.includes('--core') ? 'core' : process.argv.find((a) => a.startsWith('--solution='))?.slice('--solution='.length);
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.test.ts') ? [path.join(d, e.name)] : []));
  const subdirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name));
  const pluginTests = (dir) => subdirs(dir).flatMap((p) => walk(path.join(p, 'test')));
  const core = [...walk(path.join(root, 'test')), ...pluginTests(path.join(root, 'plugins'))];
  const solutions = subdirs(path.join(root, 'solutions')).filter((d) => !only || only === 'core' || path.basename(d) === only);
  if (only && only !== 'core' && !solutions.length) { console.error(`no solution "${only}" in solutions/`); process.exit(2); }
  const solutionTests = solutions.flatMap((d) => [...walk(path.join(d, 'test')), ...pluginTests(path.join(d, 'plugins'))]);
  files = [...(only && only !== 'core' ? [] : core), ...(only === 'core' ? [] : solutionTests)].map((f) => path.relative(root, f)).sort();
}
const isElectron = (f) => /(^|[\\/])[^\\/]*e2e[^\\/]*\.test\.ts$/.test(f);
const batches = [files.filter((f) => !isElectron(f)), ...files.filter(isElectron).map((f) => [f])].filter((b) => b.length);

// Plugins' background loops (the aiops watch loop) stay off in tests unless a test turns them on.
// Eval runs in tests run their commands unsandboxed (the default, auto, would pick a Docker sandbox
// wherever one exists) unless a test asks for one.
// The harness home is a temporary folder of the run's own (never the person's ~/.harness), removed after.
const home = process.env.HARNESS_HOME ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-home-'));
const env = { HARNESS_PLUGIN_LOOPS: 'off', HARNESS_EVAL_SANDBOX: 'off', ...(home ? { HARNESS_HOME: home } : {}), ...process.env };
// Plugins' tests import the harness by name (@harness/core/..., @harness/plugins/...), as they do wherever they are installed.
const resolveHook = pathToFileURL(path.join(root, 'src', 'plugins', 'sdk-resolve.mjs')).href;
const run = (batch) => new Promise((resolve) => {
  const child = spawn(process.execPath, ['--import', resolveHook, '--test', '--test-force-exit', '--disable-warning=ExperimentalWarning', ...flags, ...batch], { stdio: 'inherit', cwd: root, env });
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
