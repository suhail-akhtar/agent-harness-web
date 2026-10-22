// The test suite on every OS: finds test/**/*.test.ts itself (a quoted glob in an
// npm script reaches cmd.exe with its quotes and matches nothing) and runs them.
//   node scripts/test.mjs [--test-name-pattern=...] [files...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'fixtures' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.test.ts') ? [path.join(d, e.name)] : []));
  files = walk(path.join(root, 'test')).map((f) => path.relative(root, f)).sort();
}
// Plugins' background loops (the aiops watch loop) stay off in tests unless a test turns them on.
const child = spawn(process.execPath, ['--test', '--test-force-exit', '--disable-warning=ExperimentalWarning', ...flags, ...files], { stdio: 'inherit', cwd: root, env: { HARNESS_PLUGIN_LOOPS: 'off', ...process.env } });
child.on('exit', (code) => process.exit(code ?? 1));
