// Hidden check for the games3d evals: plays the game in the workspace (the current folder) with
// the Studio player's bots - an explorer that must find no softlock or crash, and the goal bot,
// which must reach the game's goal - and checks the state the game reports at the end.
//   node check-game.mjs [--engine web|godot|unreal] [--game build/web/index.html] [--seconds 300]
//                       [--explore 20] [--expect path:op:value ...] (op: eq ne gt ge lt le, shell-safe) [--dimension 2d|2.5d|3d] [--three]
// Exit 0 when everything holds; the problems are printed otherwise.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// solutions/studio (Studio's plugins) and the harness's folder above it (the core's plugins: visual).
const studio = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const harness = path.resolve(studio, '..', '..');
const imp = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);
const { startSession } = await imp(studio, 'plugins/games3d/player/driver.mjs');
const { runBot } = await imp(studio, 'plugins/games3d/player/bots.mjs');
const { evaluateCheck } = await imp(studio, 'plugins/games3d/player/verdicts.mjs');
const { closeBrowser } = await imp(harness, 'plugins/visual/lib/browser.mjs');
const { LocalHost } = await imp(harness, 'src/runtime/host.ts');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const all = (k) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const root = process.cwd();
const problems = [];
const project = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8').catch(() => '{}'));
const engine = opt('engine', project.engine ?? 'web');
const game = opt('game');
if (opt('dimension') && project.dimension !== opt('dimension')) problems.push(`.studio/project.json dimension is ${project.dimension}, the brief asked for ${opt('dimension')}`);
if (args.includes('--three')) {
  const html = await fs.readFile(path.join(root, game ?? 'index.html'), 'utf8').catch(() => '');
  if (!/three/.test(html) || !(await fs.stat(path.join(root, path.dirname(game ?? 'index.html'), 'vendor', 'three')).catch(() => null))) problems.push('no vendored Three.js (vendor/three and an import map)');
}
const host = new LocalHost(root);
const play = async (mode, seconds, seed) => {
  const s = await startSession(host, { engine, game, root, seed, clock: 'fixed' });
  try { return await runBot(s, { mode, seconds, seed, stopOnGoal: mode !== 'explore', frameWidth: 256, maxFrames: 10, wallMs: 15 * 60_000 }); } finally { await s.stop(); }
};
try {
  const ex = await play('explore', Number(opt('explore', 20)), 2);
  if (ex.crashed) problems.push(`the explorer crashed the game: ${ex.events.find((e) => e.type === 'crash')?.detail}`);
  if (ex.softlocks.length) problems.push(`softlock: ${ex.softlocks[0].detail} at ${ex.softlocks[0].t}s`);
  if (ex.errors.length) problems.push(`uncaught errors: ${ex.errors[0].split('\n')[0]}`);
  const run = await play('goal', Number(opt('seconds', 300)), 1);
  if (!run.goalReached) problems.push(`the goal bot did not reach the goal in ${run.durationS}s (final state ${JSON.stringify(run.final).slice(0, 300)})`);
  if (run.crashed) problems.push('the goal bot crashed the game');
  for (const e of all('expect')) {
    const [p, word, raw] = e.split(':');
    const op = { eq: '==', ne: '!=', gt: '>', ge: '>=', lt: '<', le: '<=' }[word] ?? word;
    const value = raw === undefined ? undefined : raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
    const v = evaluateCheck({ path: p, op, value, when: 'ever' }, run.samples);
    if (!v.pass) problems.push(`expected ${v.claim}: ${v.detail}`);
  }
  process.stdout.write(`goal bot: ${run.goalReached ? 'reached the goal' : 'no goal'} in ${run.durationS}s, ${run.events.filter((x) => x.type === 'pickup').length} pickups; explorer: ${ex.coverage.cells} places, ${ex.softlocks.length} softlocks\n`);
} catch (e) { problems.push(`the game could not be played: ${e.message}`); }
await closeBrowser().catch(() => {});
// Exit once the output is written (a pipe on Windows is asynchronous).
const done = (text, code) => process.stdout.write(`${text}\n`, () => process.exit(code));
if (problems.length) done(problems.join('\n'), 1);
else done('the game plays and can be won', 0);
