// npm run eval -- [--packs sdlc,documents] [--cases name,...] [--models a,b] [--repeat 2] [--concurrency 3] [--out dir]
//                  [--configs evals/ablations.json] [--config baseline --config 'nocode={"codeMode":false}']
// npm run eval -- --rejudge <out dir>   (run the checks again on finished runs; no model spend)
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getModel } from '../core/models.ts';
import { type HarnessConfig, loadCases, parseConfigs, parseInlineConfig, rejudge, runEvals } from './runner.ts';

const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const all = (n: string) => process.argv.flatMap((a, i) => (a === `--${n}` && i + 1 < process.argv.length ? [process.argv[i + 1]!] : []));
const list = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cases = await loadCases(path.join(appRoot, 'evals'), list(arg('packs')), list(arg('cases')));
const plugins = [path.join(appRoot, 'plugins'), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)];
const again = arg('rejudge');
if (again) {
  const runs = await rejudge(path.resolve(again), await loadCases(path.join(appRoot, 'evals')), { plugins, shipped: [path.join(appRoot, 'plugins')], log: (m) => console.log(m) });
  console.log(`
${runs.filter((r) => r.pass).length}/${runs.filter((r) => !r.unscored).length} passed${runs.some((r) => r.unscored) ? ` (${runs.filter((r) => r.unscored).length} not scored: provider errors)` : ''}. Report: ${path.join(path.resolve(again), 'report.md')}`);
  process.exit(0);
}
const models = list(arg('models')) ?? ['claude-haiku-5-5', 'deepseek-flash', 'gpt-6-luna'];
for (const m of models) getModel(m); // unknown ids fail before anything runs
const out = path.resolve(arg('out', path.join(os.tmpdir(), `harness-eval-${new Date().toISOString().replace(/[:.]/g, '-')}`))!);
await fs.mkdir(out, { recursive: true });
const repeats = Number(arg('repeat', '1'));
// Harness configurations (ablations): from a file, and/or one per --config; the first is the baseline.
const configsFile = arg('configs');
const configs: HarnessConfig[] = [
  ...(configsFile ? parseConfigs(JSON.parse(await fs.readFile(path.resolve(configsFile), 'utf8'))) : []),
  ...all('config').map(parseInlineConfig),
];
if (configs.length) parseConfigs(configs); // names unique across the file and the flags
console.log(`${cases.length} case(s) x ${models.length} model(s) x ${repeats}${configs.length ? ` x ${configs.length} config(s) (${configs.map((c) => c.name).join(', ')})` : ''} -> ${out}`);
const runs = await runEvals({
  cases, models, repeats, out, concurrency: Number(arg('concurrency', '3')),
  plugins, configs,
  shipped: [path.join(appRoot, 'plugins')],
  log: (s) => console.log(s),
});
console.log(`\n${runs.filter((r) => r.pass).length}/${runs.filter((r) => !r.unscored).length} passed${runs.some((r) => r.unscored) ? ` (${runs.filter((r) => r.unscored).length} not scored: provider errors)` : ''}. Report: ${path.join(out, 'report.md')}`);
