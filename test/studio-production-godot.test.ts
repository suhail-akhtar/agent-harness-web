// engine-godot's driver for the AI player (plugins/engine-godot/driver.mjs) on a fake Godot
// process that speaks the step protocol (test/fixtures/fake-godot-step.mjs): key and action
// mapping, the state flattened, bots finishing the game, crashes and softlocks caught, the
// game_bot and game_playtest tools and the game-starts and no-softlock gates on a Godot project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-godot-step.mjs');
// @ts-expect-error plain JS module
const drv = await import('../plugins/engine-godot/driver.mjs');
// @ts-expect-error plain JS module
const { startSession } = await import('../plugins/games3d/player/driver.mjs');
// @ts-expect-error plain JS module
const { runBot } = await import('../plugins/games3d/player/bots.mjs');
// @ts-expect-error plain JS module
const { stopAllSteps } = await import('../plugins/engine-godot/lib/play.mjs');
// @ts-expect-error plain JS module
const { inputSection } = await import('../plugins/engine-godot/lib/templates.mjs');

/** A server folder whose Godot is the fake: every spawned "godot" runs the fake step process. */
class FakeGodotHost extends LocalHost {
  env: Record<string, string>;
  constructor(root: string, env: Record<string, string> = {}) { super(root); this.env = env; }
  override async spawnStream(_cmd: string, args: string[]) {
    return spawn(process.execPath, [FAKE, ...args], { cwd: this.root, env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  }
}

/** A workspace with a Godot project (its input map) in game/, already imported, and .studio/project.json. */
async function project() {
  const root = await tempDir('studio-godot-drv-');
  await fs.mkdir(path.join(root, 'game', '.godot', 'harness'), { recursive: true });
  await fs.writeFile(path.join(root, 'game', 'project.godot'), `config_version=5\n\n[application]\n\nconfig/name="Fake"\nrun/main_scene="res://scenes/main.tscn"\n\n${inputSection()}\n`);
  await fs.mkdir(path.join(root, '.studio'), { recursive: true });
  await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'Fake', engine: 'godot', dimension: '2d', engineProject: 'game/project.godot' }));
  // The driver imports only when files are newer than its last import.
  await new Promise((r) => setTimeout(r, 30));
  await fs.writeFile(path.join(root, 'game', '.godot', 'harness', 'imported'), '');
  return root;
}

test.after(async () => { await stopAllSteps(); });

test('godot driver: web key codes and actions become Godot keys and input-map actions; the state is flattened', () => {
  assert.equal(drv.godotKey('ArrowRight'), 'Right');
  assert.equal(drv.godotKey('KeyA'), 'A');
  assert.equal(drv.godotKey('Digit3'), '3');
  assert.equal(drv.godotKey('Enter'), 'Enter');
  const map = drv.inputMapOf(`config_version=5\n\n${inputSection()}\n\n[rendering]\n`);
  assert.deepEqual(map.move_left, ['ArrowLeft', 'KeyA'], 'arrows first');
  assert.deepEqual(map.jump, ['Space']);
  assert.deepEqual(map.action, ['Enter', 'KeyE']);
  const { timeline, spanFrames } = drv.toTimeline([{ key: 'ArrowRight', ms: 400 }, { key: 'Space' }, { action: 'jump', at: 100 }, { key: 'move_up', down: true }, { mouse: [10, 20], click: true }], { actions: map, scale: 2 });
  assert.deepEqual(timeline.find((e: { key?: string }) => e.key === 'Right'), { f: 0, key: 'Right', down: true, hold: 24 / 60 });
  assert.ok(timeline.some((e: { action?: string; f: number }) => e.action === 'jump' && e.f === 6));
  assert.ok(timeline.some((e: { action?: string; down?: boolean }) => e.action === 'move_up' && e.down), 'a key named like an action is that action');
  assert.ok(timeline.some((e: { button?: number; x?: number }) => e.button === 1 && e.x === 20), 'mouse in frame pixels, scaled to the window');
  assert.equal(spanFrames, 24);
  const s = drv.flattenState({ frame: 9, scene: 'res://scenes/main.tscn', game: { player: [3, 4], targets: [[1, 2, 3]], score: 2, won: false } });
  assert.deepEqual(s.player, { x: 3, y: 4 });
  assert.deepEqual(s.targets, [{ x: 1, y: 2, z: 3 }]);
  assert.equal(s.scenePath, 'res://scenes/main.tscn');
  assert.equal(s.scene, undefined, 'the scene path is not mistaken for the game\'s mode');
});

test('godot driver on a fake Godot: a session steps with frames and state, the goal bot takes every coin, the recording replays', { timeout: 120_000 }, async () => {
  const root = await project();
  const host = new FakeGodotHost(root);
  const s = await startSession(host, { engine: 'godot', bin: 'godot', import: false, headless: false, seed: 3 });
  let rec: { engine: string; steps: unknown[]; durationMs: number };
  try {
    assert.equal(s.engine, 'godot');
    assert.deepEqual(s.info.inputs, ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'], 'one key per action of the input map');
    assert.equal(s.info.project, 'game');
    let o = await s.observe({ frame: true });
    assert.ok(o.frame?.png?.length > 100, 'a frame comes back');
    assert.ok(o.frame.width > 0);
    const x0 = o.state.player.x;
    o = await s.step([{ key: 'ArrowRight', ms: 200 }], 200, { frame: false });
    assert.ok(o.state.player.x >= x0 + 20, `${x0} -> ${o.state.player.x}`);
    assert.ok(Math.abs(o.t - (s.t)) < 1);
    const run = await runBot(s, { mode: 'goal', seconds: 30, seed: 1, frameWidth: 160, maxFrames: 10 });
    assert.equal(run.goalReached, true, JSON.stringify(run.events.slice(-5)));
    assert.equal(run.events.filter((e: { type: string }) => e.type === 'pickup').length, 3);
    assert.equal(run.crashed, false);
    assert.ok(run.frames.length >= 2);
  } finally { rec = (await s.stop()).recording; }
  // The steps replay: the same inputs from a fresh start end in the same place.
  assert.equal(rec.engine, 'godot');
  assert.ok(rec.steps.length > 5);
  const again = await startSession(host, { engine: 'godot', bin: 'godot', import: false, headless: true, seed: 3 });
  const replay = await runBot(again, { mode: 'scripted', recording: rec, seconds: rec.durationMs / 1000 + 1 });
  await again.stop();
  assert.equal(replay.final.score, 3);
  assert.equal(replay.final.won, true);
  // The frames folder is cleaned up.
  assert.deepEqual((await fs.readdir(path.join(root, '.harness', 'godot')).catch(() => [])), []);
});

test('godot driver on a fake Godot: a crash and a softlock are caught by the bots', { timeout: 120_000 }, async () => {
  const root = await project();
  let s = await startSession(new FakeGodotHost(root, { FAKE_GODOT_CRASH_AT: '90' }), { engine: 'godot', bin: 'godot', import: false, headless: true, bootMs: 0 });
  let run = await runBot(s, { mode: 'explore', seconds: 10, seed: 1 });
  await s.stop();
  assert.equal(run.crashed, true);
  assert.ok(run.errors.some((e: string) => /fake crash|exited/.test(e)), run.errors.join('\n'));
  s = await startSession(new FakeGodotHost(root, { FAKE_GODOT_FREEZE_AT: '60' }), { engine: 'godot', bin: 'godot', import: false, headless: true });
  run = await runBot(s, { mode: 'explore', seconds: 40, seed: 1, softlockS: 6 });
  await s.stop();
  assert.equal(run.goalReached, false);
  assert.equal(run.softlocks.length, 1, 'the frozen player is a softlock');
  assert.match(run.softlocks[0].detail, /no input changed anything/);
});

test('game_bot, game_playtest and the player gates play a Godot project through the driver', { timeout: 300_000 }, async () => {
  const root = await project();
  process.env.HARNESS_GODOT = FAKE;
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  try {
    const host = new FakeGodotHost(root);
    const ctx = { host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, beforeWrite: async () => {} } as unknown as ToolContext;
    const bot = await h.registry.tools.get('game_bot')!.run({ mode: 'goal', seconds: 30 }, ctx) as { content: string; is_error?: boolean };
    assert.equal(bot.is_error, false, bot.content);
    assert.match(bot.content, /Bot goal on godot/);
    assert.match(bot.content, /Goal reached: yes/);
    const pt = await h.registry.tools.get('game_playtest')!.run({ goal: 'take the three coins', bots: [{ mode: 'goal', seconds: 30 }, { mode: 'explore', seconds: 10 }], checks: [{ path: 'score', op: '==', value: 3, when: 'ever' }] }, ctx) as { content: string };
    assert.match(pt.content, /Playtest pt-\d+-1: PASS \(godot/, pt.content);
    const studio = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    assert.equal(studio.playtests.length, 1);
    const gates = await runGates(h.registry, host, ['game-starts', 'no-softlock', 'playtest-pass'], new AbortController().signal);
    for (const g of gates) assert.equal(g.pass, true, `${g.name}: ${g.summary}\n${g.details ?? ''}`);
  } finally {
    delete process.env.HARNESS_GODOT;
    await h.close();
  }
});
