import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubbedEnv } from '../runtime/host.ts';

/** A plugin's test files: *.test.{ts,mjs,js} under it (not node_modules). */
/** Integration tests (a real engine, a stack of services, a desktop app): by name, left out of quick runs (the review). */
const INTEGRATION = /(e2e|-stack|-real|-live)[^\\/]*\.test\.(ts|mjs|js)$/;

export async function pluginTestFiles(dir: string, o: { quick?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.test\.(ts|mjs|js)$/.test(e.name) && !(o.quick && INTEGRATION.test(e.name))) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Runs a plugin's tests with node --test, '@harness/plugin-sdk' importable from anywhere on the disk
 * (sdk-resolve.mjs). Its output goes to ours (or is captured); the exit code is node's.
 */
export async function runPluginTests(folder: string, extra: string[] = [], o: { capture?: boolean; timeoutMs?: number; /** Pass the environment's credentials (API keys) through: tests that call real models. Default: removed. */ keys?: boolean; /** Leave out integration tests (*e2e*, *-stack, *-real, *-live). */ quick?: boolean } = {}): Promise<number | { code: number; output: string; /** Stopped at timeoutMs. */ timedOut?: boolean }> {
  const dir = path.resolve(folder);
  const files = await pluginTestFiles(dir, { quick: o.quick });
  if (!files.length) {
    const msg = `No tests in ${dir} (files named *.test.ts, *.test.mjs or *.test.js). npm run plugin -- new <name> writes an example.`;
    if (o.capture) return { code: 1, output: msg };
    console.error(msg);
    return 1;
  }
  const hook = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk-resolve.mjs')).href;
  // Its own run, whatever runs it (a test runner's NODE_TEST_CONTEXT would make it report to that one instead).
  // The plugin's code runs here before anyone trusted it: the server's credentials are not passed unless asked.
  const env = o.keys ? { ...process.env } : scrubbedEnv();
  delete env.NODE_TEST_CONTEXT;
  // As in the harness's own suite: background loops off, evals unsandboxed, a throwaway harness home.
  const home = env.HARNESS_HOME ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), 'harness-plugin-test-home-'));
  Object.assign(env, { HARNESS_PLUGIN_LOOPS: env.HARNESS_PLUGIN_LOOPS ?? 'off', HARNESS_EVAL_SANDBOX: env.HARNESS_EVAL_SANDBOX ?? 'off', ...(home ? { HARNESS_HOME: home } : {}) });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', hook, '--test', '--test-concurrency=1', ...(o.capture ? ['--test-reporter=tap'] : []), ...extra, ...files], {
    cwd: dir, stdio: o.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env,
  });
  let output = '';
  child.stdout?.on('data', (c) => { output += c; });
  child.stderr?.on('data', (c) => { output += c; });
  let timedOut = false;
  const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs) : undefined;
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)));
  clearTimeout(timer);
  if (home) await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  return o.capture ? { code, output, ...(timedOut ? { timedOut } : {}) } : code;
}
