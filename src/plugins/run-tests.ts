import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A plugin's test files: *.test.{ts,mjs,js} under it (not node_modules). */
export async function pluginTestFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.test\.(ts|mjs|js)$/.test(e.name)) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * Runs a plugin's tests with node --test, '@harness/plugin-sdk' importable from anywhere on the disk
 * (sdk-resolve.mjs). Its output goes to ours (or is captured); the exit code is node's.
 */
export async function runPluginTests(dir: string, extra: string[] = [], o: { capture?: boolean; timeoutMs?: number } = {}): Promise<number | { code: number; output: string }> {
  const files = await pluginTestFiles(dir);
  if (!files.length) {
    const msg = `No tests in ${dir} (files named *.test.ts, *.test.mjs or *.test.js). npm run plugin -- new <name> writes an example.`;
    if (o.capture) return { code: 1, output: msg };
    console.error(msg);
    return 1;
  }
  const hook = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdk-resolve.mjs')).href;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', hook, '--test', '--test-concurrency=1', ...extra, ...files], {
    cwd: dir, stdio: o.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env },
  });
  let output = '';
  child.stdout?.on('data', (c) => { output += c; });
  child.stderr?.on('data', (c) => { output += c; });
  const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : undefined;
  const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 1)));
  clearTimeout(timer);
  return o.capture ? { code, output } : code;
}
