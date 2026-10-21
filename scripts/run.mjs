// Runs a TypeScript entry point the same way on Linux, macOS and Windows:
// npm scripts cannot set environment variables inline on Windows (cmd/PowerShell),
// so this sets them and starts Node with the right flags.
//   node scripts/run.mjs src/server/main.ts [args...]
import { spawn } from 'node:child_process';

const [entry, ...args] = process.argv.slice(2);
if (!entry) { console.error('usage: node scripts/run.mjs <entry.ts> [args...]'); process.exit(2); }
// A .env file in the folder it runs from supplies keys (variables already set win).
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--disable-warning=UNDICI-EHPA', '--env-file-if-exists=.env', entry, ...args], {
  stdio: 'inherit',
  // Node's fetch uses HTTP(S)_PROXY only with this set; harmless without a proxy.
  env: { ...process.env, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY ?? '1' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
