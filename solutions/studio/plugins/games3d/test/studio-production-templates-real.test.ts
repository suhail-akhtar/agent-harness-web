// Every Studio web template, made with studio_template create (its assets built by the Studio
// builders), boots in the offline headless browser and the player's goal bot wins it through the
// web driver; game.json resolves (web-game); a recording replays exactly; a web build boots from
// its own folder (web-build) and zips.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates, pluginDir as dirOf } from '@harness/plugin-sdk/testing';
import { createHarness } from '@harness/plugin-sdk/testing';
import { LocalHost } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';

const here = path.join(HARNESS_ROOT, 'test');
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromiumPath, closeBrowser } = await import('@harness/plugins/visual/lib/browser.mjs');
// @ts-expect-error plain JS module
const { closeAllPlay } = await import('../player/index.mjs');
// @ts-expect-error plain JS module
const { zipNames } = await import('../templates/zip.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();
const LONG = { skip: hasChromium ? false : 'no Chromium for playwright-core here', timeout: 600_000 };

const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'visual'].map((p) => dirOf(p)), search: null, memory: 'off' });
const ctxOf = (root: string) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, beforeWrite: async () => {} }) as unknown as ToolContext;
type Out = { content: string; is_error?: boolean };
const run = (root: string, tool: string, input: Record<string, unknown>) => h.registry.tools.get(tool)!.run(input, ctxOf(root)) as Promise<Out>;
test.after(async () => { await closeAllPlay(); await closeBrowser(); await h.close(); });

const made = new Map<string, string>();
async function make(template: string) {
  const root = await tempDir(`studio-tpl-${template}-`);
  const r = await run(root, 'studio_template', { action: 'create', template });
  assert.equal(r.is_error, false, r.content);
  made.set(template, root);
  return { root, r };
}

for (const template of ['platformer-2d', 'topdown-2d', 'puzzle-2d', 'iso-2.5d', 'sidescroller-2.5d', 'thirdperson-3d', 'firstperson-3d']) {
  test(`template ${template}: created with its Studio assets, game.json resolves, and the goal bot wins it`, LONG, async () => {
    const t0 = Date.now();
    const { root, r } = await make(template);
    assert.match(r.content, /Assets built with the Studio builders: [\w-]+/);
    assert.doesNotMatch(r.content, /FAILED/);
    const project = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    assert.equal(project.engine, 'web');
    assert.equal(project.template, template);
    if (template.includes('3d') || template === 'sidescroller-2.5d') assert.ok(await fs.stat(path.join(root, 'vendor', 'three', 'build', 'three.module.js')), 'Three.js vendored');
    const [g] = await runGates(h.registry, new LocalHost(root), ['web-game'], new AbortController().signal);
    assert.equal(g!.pass, true, `${g!.summary}\n${g!.details ?? ''}`);
    const bot = await run(root, 'game_bot', { mode: 'goal', seconds: 180 });
    assert.match(bot.content, /Goal reached: yes\. Crashed: no\./, bot.content);
    assert.match(bot.content, /Errors: 0\./);
    assert.doesNotMatch(bot.content, /"missingAssets":[1-9]/, 'every asset loaded');
    console.log(`${template}: ${/Bot goal on web index.html: ([^,]+)/.exec(bot.content)?.[1]} of game, ${((Date.now() - t0) / 1000).toFixed(1)}s real`);
  });
}

test('a template\'s recording replays exactly (puzzle-2d), and the game starts on the real clock (game-starts)', LONG, async () => {
  const root = made.get('puzzle-2d') ?? (await make('puzzle-2d')).root;
  const bot = await run(root, 'game_bot', { mode: 'goal', seconds: 120 });
  const rec = /Recording: (\S+\.json)/.exec(bot.content)![1]!;
  const replay = await run(root, 'game_bot', { mode: 'scripted', recording: rec, expect: [{ path: 'won', op: '==', value: true, when: 'end' }] });
  assert.match(replay.content, /PASS won == true \(end\)/, replay.content);
  const finalOf = (s: string) => JSON.parse(/Final state: (.*)/.exec(s)![1]!) as { moves: number; score: number; level: number };
  const [a, b] = [finalOf(bot.content), finalOf(replay.content)];
  assert.deepEqual([b.moves, b.score, b.level], [a.moves, a.score, a.level], 'the same moves, score and level');
  const [g] = await runGates(h.registry, new LocalHost(root), ['game-starts'], new AbortController().signal);
  assert.equal(g!.pass, true, g!.details ?? g!.summary);
});

test('a web build: studio_template build copies the game and only the assets it names, zips it, records it, and boots offline (web-build)', LONG, async () => {
  const root = made.get('platformer-2d') ?? (await make('platformer-2d')).root;
  // An asset nobody names stays out of the build.
  await run(root, 'studio_sprite', { action: 'sprite', kind: 'gem', id: 'unused-gem' });
  const r = await run(root, 'studio_template', { action: 'build' });
  assert.equal(r.is_error, false, r.content);
  assert.match(r.content, /Web build b1 in build\/web\/: \d+ files/);
  const names = await zipNames(path.join(root, 'build', 'coin-hop-web.zip'));
  for (const f of ['index.html', 'game.json', 'src/main.js', 'src/engine/core.js', '.studio/assets/hero-sheet/sheet.png', '.studio/assets/level-1/level.json', 'build.json']) assert.ok(names.includes(f), f);
  assert.ok(!names.some((n: string) => n.includes('unused-gem')), 'only the assets game.json names');
  const project = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
  assert.equal(project.builds.at(-1).platform, 'web');
  assert.equal(project.builds.at(-1).path, 'build/web/index.html');
  let [g] = await runGates(h.registry, new LocalHost(root), ['web-build'], new AbortController().signal);
  assert.equal(g!.pass, true, g!.details ?? g!.summary);
  // A build missing an asset fails it, with the asset named.
  await fs.rm(path.join(root, 'build', 'web', '.studio', 'assets', 'coin-sheet'), { recursive: true });
  [g] = await runGates(h.registry, new LocalHost(root), ['web-build'], new AbortController().signal);
  assert.equal(g!.pass, false);
  assert.match(g!.details!, /asset:coin-sheet/);
});
