import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeEnv } from '../src/runtime/host.ts';

// Inside the desktop app the engine is an Electron utility process: process.execPath is the app. run_script,
// plugin review, MCP bundles and the egress proxy start scripts with it, so they must ask for Node mode.

const here = path.dirname(fileURLToPath(import.meta.url));

test('nodeEnv asks Electron for Node mode, and nothing of plain Node', () => {
  assert.deepEqual(nodeEnv(), {});
  const had = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: '39.0.0', configurable: true });
  try { assert.deepEqual(nodeEnv(), { ELECTRON_RUN_AS_NODE: '1' }); }
  finally { if (had) Object.defineProperty(process.versions, 'electron', had); else delete (process.versions as Record<string, string>).electron; }
});

test("run_script's runner runs under the Electron binary only with Node mode", { timeout: 60_000 }, (t) => {
  let electron: string;
  try { electron = createRequire(import.meta.url)('electron') as unknown as string; } catch { t.skip('electron is not installed'); return; }
  const runner = path.join(here, '..', 'src', 'tools', 'code-runner.mjs');
  const job = JSON.stringify({ code: 'console.log(6 * 7)', tools: [], timeoutMs: 5000 }) + '\n';
  const run = (env: Record<string, string>) => spawnSync(electron, ['--permission', `--allow-fs-read=${runner}`, '--disable-warning=ExperimentalWarning', runner], { input: job, env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000, encoding: 'utf8', windowsHide: true });
  const r = run({ ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"type":"done","ok":true,"output":"42"/);
});
