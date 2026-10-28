// The games3d eval pack (evals/games3d): six cases that load, name real workflows and gates, and
// whose hidden checks judge workspaces by playing them: the softlocking fixture fails until it is
// fixed and a regression is filed, a template game passes the bots' check (and fails a wrong
// expectation), and a pack of five sprites passes the consistency check while a mismatched one fails.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadCases, runChecks, pluginDir as dirOf } from '@harness/plugin-sdk/testing';
import { createHarness } from '@harness/plugin-sdk/testing';
import { LocalHost } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The solution's eval packs (solutions/studio/evals).
const EVALS = path.join(dirOf('games3d'), '..', '..', 'evals');
const { chromiumPath, closeBrowser } = await import('@harness/plugins/visual/lib/browser.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();
const LONG = { skip: hasChromium ? false : 'no Chromium', timeout: 900_000 };
const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'visual', 'engine-godot', 'engine-unreal'].map((p) => dirOf(p)), search: null, memory: 'off' });
const ctxOf = (root: string) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, beforeWrite: async () => {} }) as unknown as ToolContext;
const tool = (root: string, name: string, input: Record<string, unknown>) => h.registry.tools.get(name)!.run(input, ctxOf(root)) as Promise<{ content: string; is_error?: boolean }>;
test.after(async () => { await closeBrowser(); await h.close(); });

const cases = await loadCases(EVALS, ['games3d']);
const byName = (n: string) => cases.find((c) => c.name === n)!;
/**
 * Runs a case's checks as an eval run does. A child node under node:test reports to this run
 * instead of printing (NODE_TEST_CONTEXT): the checks' processes do not get it, as in a real eval.
 */
async function checks(c: Parameters<typeof runChecks>[1], ws: string) {
  const ctx = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return await runChecks(h, c, ws, new AbortController().signal); } finally { if (ctx !== undefined) process.env.NODE_TEST_CONTEXT = ctx; }
}
const check = async (caseName: string, checkName: string, ws: string) => (await checks({ ...byName(caseName), checks: byName(caseName).checks.filter((c) => c.name === checkName) }, ws))[0]!;

test('the games3d pack: six cases, real workflows, registered gates, hidden checks that exist', async () => {
  assert.deepEqual(cases.map((c) => c.name).sort(), ['asset-pack-props', 'fix-softlock', 'godot-topdown', 'iso-adventure', 'platformer-coins', 'threejs-collect']);
  for (const c of cases) {
    assert.ok(h.registry.workflows.has(c.workflow!), `${c.name}: ${c.workflow}`);
    for (const ch of c.checks) {
      for (const g of ch.gates ?? []) assert.ok(h.registry.gates.has(g), `${c.name}: gate ${g}`);
      const script = /\{\{case\}\}\/(\S+\.mjs)/.exec(ch.run ?? '')?.[1];
      if (script) assert.ok(await fs.stat(path.join(c.dir, script)), `${c.name}: ${script}`);
    }
    for (const k of Object.keys(c.input ?? {})) assert.ok(Object.keys(h.registry.workflows.get(c.workflow!)!.inputs ?? {}).includes(k), `${c.name}: input ${k}`);
  }
});

test('fix-softlock\'s hidden checks: the fixture softlocks and has no regression; fixed and filed, both pass', LONG, async () => {
  const ws = await tempDir('studio-eval-softlock-');
  await fs.cp(path.join(byName('fix-softlock').dir, 'fixtures'), ws, { recursive: true });
  let r = await check('fix-softlock', 'no softlock and the goal reached', ws);
  assert.equal(r.pass, false, r.detail);
  assert.match(r.detail, /softlock|did not reach the goal/);
  r = await check('fix-softlock', 'a regression was filed', ws);
  assert.equal(r.pass, false);
  // QA files it (a recording that must never softlock), the engineer fixes it.
  const bot = await tool(ws, 'game_bot', { mode: 'explore', seconds: 30 });
  const rec = /Recording: (\S+\.json)/.exec(bot.content)![1]!;
  await tool(ws, 'game_bot', { mode: 'scripted', recording: rec, saveAs: 'third-coin-freeze', expect: [{ path: '$softlocks', op: '>', value: 0, when: 'never' }] });
  const html = await fs.readFile(path.join(ws, 'index.html'), 'utf8');
  await fs.writeFile(path.join(ws, 'index.html'), html.replace(/if \(g\.collected === 3\) \{ g\.frozen = true;[^\n]*/, ''));
  r = await check('fix-softlock', 'no softlock and the goal reached', ws);
  assert.equal(r.pass, true, r.detail);
  r = await check('fix-softlock', 'a regression was filed', ws);
  assert.equal(r.pass, true, r.detail);
});

test('check-game on a template game: the bots win it; a wrong expectation or dimension fails it', LONG, async () => {
  const ws = await tempDir('studio-eval-game-');
  await tool(ws, 'studio_template', { action: 'create', template: 'puzzle-2d' });
  const run = (args: string) => checks({ ...byName('platformer-coins'), checks: [{ name: 'x', run: `node {{case}}/../lib/check-game.mjs ${args}`, timeoutSec: 600 }] }, ws).then((x) => x[0]!);
  let r = await run('--seconds 120 --expect won:eq:true');
  assert.equal(r.pass, true, r.detail);
  assert.match(r.detail, /the game plays and can be won/);
  r = await run('--seconds 120 --dimension 3d --expect total:ge:50');
  assert.equal(r.pass, false);
  assert.match(r.detail, /dimension is 2d/);
  assert.match(r.detail, /expected total >= 50/);
});

test('check-pack: five sprites in one palette pass; a sprite in its own palette and size fails', async () => {
  const ws = await tempDir('studio-eval-pack-');
  const kinds = ['chest', 'key', 'potion', 'sword', 'shield'];
  const plan = { assets: kinds.map((k) => ({ id: `prop-${k}`, kind: 'sprite' })) };
  await fs.mkdir(path.join(ws, 'design'), { recursive: true });
  await fs.writeFile(path.join(ws, 'design', 'asset-plan.json'), JSON.stringify(plan));
  for (const k of kinds) await tool(ws, 'studio_sprite', { action: 'sprite', kind: k, size: 16, palette: 'db16', id: `prop-${k}` });
  let r = await check('asset-pack-props', 'one consistent pack', ws);
  assert.equal(r.pass, true, r.detail);
  await tool(ws, 'studio_sprite', { action: 'sprite', kind: 'shield', size: 32, palette: ['#ff00ff', '#00ffff', '#ffff00'], id: 'prop-shield' });
  r = await check('asset-pack-props', 'one consistent pack', ws);
  assert.equal(r.pass, false);
  assert.match(r.detail, /mixes frame sizes|own palette/);
});
