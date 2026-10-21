// npm run eval -- [--packs sdlc,documents] [--cases name,...] [--models a,b] [--repeat 2] [--concurrency 3] [--out dir]
// npm run eval -- --rejudge <out dir>   (run the checks again on finished runs; no model spend)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel } from '../core/models.ts';
import { loadCases, rejudge, runEvals } from './runner.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cases = await loadCases(path.join(appRoot, 'evals'), list(arg('packs')), list(arg('cases')));
const plugins = [path.join(appRoot, 'plugins'), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)];
const again = arg('rejudge');
if (again) {
  const runs = await rejudge(path.resolve(again), await loadCases(path.join(appRoot, 'evals')), { plugins, shipped: [path.join(appRoot, 'plugins')], log: (m) => console.log(m) });
  console.log(`
${runs.filter((r) => r.pass).length}/${runs.length} passed. Report: ${path.join(path.resolve(again), 'report.md')}`);
  process.exit(0);
}
const models = list(arg('models')) ?? ['claude-haiku-5-5', 'deepseek-flash', 'gpt-6-luna'];
for (const m of models) getModel(m); // unknown ids fail before anything runs
const out = path.resolve(arg('out', path.join(os.tmpdir(), `harness-eval-${new Date().toISOString().replace(/[:.]/g, '-')}`))!);
await fs.mkdir(out, { recursive: true });
const repeats = Number(arg('repeat', '1'));
console.log(`${cases.length} case(s) x ${models.length} model(s) x ${repeats} -> ${out}`);
const runs = await runEvals({
  cases, models, repeats, out, concurrency: Number(arg('concurrency', '3')),
  plugins,
  shipped: [path.join(appRoot, 'plugins')],
  log: (s) => console.log(s),
});
console.log(`\n${runs.filter((r) => r.pass).length}/${runs.length} passed. Report: ${path.join(out, 'report.md')}`);
