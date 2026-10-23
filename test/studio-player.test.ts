// Studio player, without a browser: the GIF encoder (and its decoder), frames, the report format,
// stuck and softlock detection, the explorer and goal bots on a fake driver, verdicts, the
// playtest runner and the gates on reports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { tempDir, testPicture } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// @ts-expect-error plain JS module
const gif = await import('../plugins/games3d/player/gif.mjs');
// @ts-expect-error plain JS module
const frames = await import('../plugins/games3d/player/frames.mjs');
// @ts-expect-error plain JS module
const analysis = await import('../plugins/games3d/player/analysis.mjs');
// @ts-expect-error plain JS module
const bots = await import('../plugins/games3d/player/bots.mjs');
// @ts-expect-error plain JS module
const verdicts = await import('../plugins/games3d/player/verdicts.mjs');
// @ts-expect-error plain JS module
const report = await import('../plugins/games3d/player/report.mjs');
// @ts-expect-error plain JS module
const driver = await import('../plugins/games3d/player/driver.mjs');

type Img = { width: number; height: number; rgb: Uint8Array };
type Obs = { t: number; state?: Record<string, unknown>; events: unknown[]; errors: string[]; hash?: string; frame?: unknown; crashed?: boolean; loopStopped?: boolean };

/** A test picture: bands of colour and a gradient, different per frame. */
function picture(w: number, h: number, k: number): Img {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3;
    rgb[o] = (x * 255) / w; rgb[o + 1] = ((y + k * 7) % h) * 255 / h; rgb[o + 2] = (x + y) % 32 < 16 ? 200 : 30;
  }
  return { width: w, height: h, rgb };
}

test('GIF: encodes frames with one palette and LZW, and decodes back to nearly the same pixels', () => {
  const clip = [0, 1, 2, 3].map((k) => picture(97, 61, k));
  const data = gif.encodeGif(clip, { delays: [100, 200, 300, 400] });
  assert.equal(data.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(data[data.length - 1], 0x3b);
  const back = gif.decodeGif(data);
  assert.equal(back.width, 97);
  assert.equal(back.height, 61);
  assert.equal(back.loops, true);
  assert.equal(back.frames.length, 4);
  assert.deepEqual(back.frames.map((f: { delayMs: number }) => f.delayMs), [100, 200, 300, 400]);
  for (const [i, f] of back.frames.entries()) {
    let err = 0;
    for (let p = 0; p < f.rgb.length; p++) err += Math.abs(f.rgb[p] - clip[i]!.rgb[p]!);
    assert.ok(err / f.rgb.length < 12, `frame ${i}: mean error ${(err / f.rgb.length).toFixed(1)} per channel`);
  }
  // A long, busy frame fills the 4096-code table and clears it: still exact for its palette.
  const big = picture(400, 300, 5);
  const one = gif.decodeGif(gif.encodeGif([big]));
  const idx = gif.mapToPalette(big.rgb, gif.quantize(Array.from(big.rgb.filter((_, i) => i % 9 < 3)), 256));
  assert.equal(one.frames[0].rgb.length, big.rgb.length);
  assert.ok(idx.length === 400 * 300);
  // LZW round trip on its own, on random data (worst case) and a flat run (best case).
  for (const src of [Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7919) % 251), new Uint8Array(30_000)]) {
    assert.deepEqual(gif.lzwDecode(gif.lzwEncode(src, 8), 8, src.length), src);
  }
  // Median cut keeps distinct colours apart.
  const pal = gif.quantize([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 0], 4);
  assert.ok(pal.some((c: number[]) => c[0] === 255 && c[1] === 0) && pal.some((c: number[]) => c[2] === 255) && pal.some((c: number[]) => c[1] === 255));
});

test('frames: PNG decode, resize, encode, stats (blank or not) and the change hash', () => {
  const png = testPicture(200, 100);
  const f = frames.prepareFrame(png, 64);
  assert.equal(f.width, 64);
  assert.equal(f.height, 32);
  assert.equal(f.sourceWidth, 200);
  const again = frames.decodePng(f.png);
  assert.equal(again.width, 64);
  assert.equal(f.stats.blank, false);
  const flat = frames.encodePng({ width: 50, height: 40, rgb: new Uint8Array(50 * 40 * 3).fill(30) });
  assert.equal(frames.prepareFrame(flat).stats.blank, true);
  assert.equal(frames.hashDistance(f.hash, frames.prepareFrame(png, 32).hash), 0, 'the same picture, any size');
  assert.ok(frames.hashDistance(f.hash, frames.prepareFrame(flat).hash) > 10);
});

test('state conventions: position, targets, won/lost, and the events a change of state means', () => {
  const s0 = { state: 'playing', player: { x: 1, y: 2 }, coins: 1, total: 5, score: 10, lives: 3, targets: [{ x: 9, y: 2 }, { x: 2, y: 2 }] };
  assert.deepEqual(analysis.positionOf(s0), { x: 1, y: 2, z: 0, dims: 2 });
  assert.deepEqual(analysis.targetOf(s0, analysis.positionOf(s0)), { x: 2, y: 2, z: 0, dims: 2 });
  assert.equal(analysis.isWon({ state: 'Won' }), true);
  assert.equal(analysis.isWon({ done: true }), true);
  assert.equal(analysis.isLost({ state: 'gameover' }), true);
  const ev = analysis.stateEvents(s0, { ...s0, coins: 2, score: 20, lives: 2, state: 'won' }, 4200);
  assert.deepEqual(ev.map((e: { type: string }) => e.type).sort(), ['death', 'goal', 'pickup', 'score', 'state']);
  assert.equal(ev.find((e: { type: string }) => e.type === 'pickup').detail, 'coins 2/5');
  assert.equal(analysis.getPath({ a: { b: [{ c: 3 }] } }, 'a.b[0].c'), 3);
  assert.equal(analysis.getPath({ list: [1, 2] }, 'list.length'), 2);
});

test('stuck and softlock: a still game is stuck after 3 s, a softlock once every input was tried for 8 s', () => {
  const d = new analysis.StuckDetector({ stuckS: 3, softlockS: 8, actionCount: 3 });
  const sig = (x: number) => ({ pos: { x, y: 0, z: 0, dims: 2 }, mode: 'playing', hash: null });
  const out: { t: number; type: string }[] = [];
  for (let t = 0; t <= 2000; t += 250) out.push(...d.update(t, sig(t / 100), 0));
  assert.equal(out.length, 0, 'moving: nothing');
  for (let t = 2250; t <= 12000; t += 250) out.push(...d.update(t, sig(20), (t / 250) % 2));
  assert.deepEqual(out.map((e) => e.type), ['stuck'], 'only two of three inputs tried: stuck, not a softlock');
  for (let t = 12250; t <= 13000; t += 250) out.push(...d.update(t, sig(20), 2));
  assert.deepEqual(out.map((e) => e.type), ['stuck', 'softlock']);
  out.push(...d.update(13250, sig(25), 0));
  assert.equal(out.at(-1)!.type, 'unstuck');
  // Without a position, the picture decides: two cells of the hash changing is a change.
  const h = new analysis.StuckDetector({ stuckS: 1 });
  h.update(0, { pos: null, mode: '', hash: 'aaaa' });
  assert.deepEqual(h.update(1500, { pos: null, mode: '', hash: 'aaab' }).map((e: { type: string }) => e.type), ['stuck'], 'one cell is noise');
  assert.deepEqual(h.update(1600, { pos: null, mode: '', hash: 'abbb' }).map((e: { type: string }) => e.type), ['unstuck']);
});

test('metrics: fps from frame intervals (worst one-second window) and frame cost on the fixed clock', () => {
  const m = analysis.frameMetrics({ intervals: [...Array(60).fill(16.7), ...Array(30).fill(33.3)], cpu: [1, 1, 2, 2, 3, 30] });
  assert.ok(m.fpsAvg > 40 && m.fpsAvg < 50, String(m.fpsAvg));
  assert.ok(m.fpsMin <= 31, String(m.fpsMin));
  assert.equal(m.frameMsP95, 33.3);
  assert.equal(m.cpuFrameMsP95, 30);
  assert.equal(m.fpsEstimate, 33.3);
});

/**
 * A fake driver: a top-down grid world (0..W x 0..H, 1 unit cells, walls) where arrow keys
 * move the player 6 units/s; coins at cells; won when all are taken. With `freezeAfter`, input
 * stops working after that many coins (a softlock).
 */
function fakeWorld({ walls = [] as [number, number][], coins = [[8, 1], [1, 8], [8, 8]] as [number, number][], W = 10, H = 10, freezeAfter = Infinity, crashAt = Infinity } = {}) {
  const wall = new Set(walls.map(([x, y]) => `${x},${y}`));
  const p = { x: 0.5, y: 0.5 };
  let t = 0;
  let got = 0;
  let crashed = false;
  const taken = new Set<string>();
  const timeline: unknown[] = [];
  const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H || wall.has(`${Math.floor(x)},${Math.floor(y)}`);
  const state = () => ({ state: got === coins.length ? 'won' : 'playing', player: { ...p }, coins: got, total: coins.length, won: got === coins.length, targets: coins.filter(([x, y]) => !taken.has(`${x},${y}`)).map(([x, y]) => ({ x: x + 0.5, y: y + 0.5 })), inputs: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] });
  let reported = false;
  const obs = (): Obs => {
    const errors = crashed && !reported ? ['Error: boom'] : [];
    if (crashed) reported = true;
    return { t, state: state(), events: [], errors, hash: `${Math.floor(p.x * 2)},${Math.floor(p.y * 2)}`, loopStopped: crashed };
  };
  return {
    engine: 'fake',
    get t() { return t; },
    get info() { return { engine: 'fake', inputs: state().inputs }; },
    async observe() { return obs(); },
    async step(inputs: { key: string; ms?: number }[], ms: number) {
      timeline.push({ t, inputs, ms });
      const n = Math.max(1, Math.round(ms / (1000 / 60)));
      for (let i = 0; i < n; i++) {
        t += 1000 / 60;
        if (t >= crashAt) crashed = true;
        if (crashed || got >= freezeAfter) continue;
        for (const inp of inputs) {
          if (i * (1000 / 60) >= (inp.ms ?? 50)) continue;
          const d = 6 / 60;
          const [dx, dy] = inp.key === 'ArrowLeft' ? [-d, 0] : inp.key === 'ArrowRight' ? [d, 0] : inp.key === 'ArrowUp' ? [0, -d] : inp.key === 'ArrowDown' ? [0, d] : [0, 0];
          if (!blocked(p.x + dx * 4, p.y + dy * 4)) { p.x += dx; p.y += dy; }
        }
        for (const [x, y] of coins) if (!taken.has(`${x},${y}`) && Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < 0.5) { taken.add(`${x},${y}`); got++; }
      }
      return obs();
    },
    async act() {},
    recording() { return { version: 1, engine: 'fake', steps: timeline.slice() }; },
    async stop() { return { metrics: {}, errors: crashed ? ['Error: boom'] : [], console: [], recording: this.recording() }; },
  };
}

// A wall with one gap: the goal bot has to go around.
const WALL = Array.from({ length: 9 }, (_, i) => [i, 5] as [number, number]);

test('explorer and goal bots on a fake driver: every coin found, the goal reached, coverage reported', async () => {
  const goal = await bots.runBot(fakeWorld({ walls: WALL }), { mode: 'goal', seconds: 120, seed: 3 });
  assert.equal(goal.goalReached, true, JSON.stringify(goal.final));
  assert.equal(goal.final.coins, 3);
  assert.ok(goal.durationS < 120);
  const ex = await bots.runBot(fakeWorld({ walls: WALL }), { mode: 'explore', seconds: 240, seed: 1 });
  assert.equal(ex.final.coins, 3, `explore found ${ex.final.coins} coins in ${ex.durationS}s`);
  assert.ok(ex.coverage.cells >= 15, `coverage ${ex.coverage.cells}`);
  assert.ok(ex.events.some((e: { type: string }) => e.type === 'pickup'));
  assert.equal(ex.softlocks.length, 0);
  const rnd = await bots.runBot(fakeWorld(), { mode: 'random', seconds: 10, seed: 2 });
  assert.ok(rnd.steps > 10 && rnd.durationS >= 10);
  // The same seed plays the same game.
  const again = await bots.runBot(fakeWorld({ walls: WALL }), { mode: 'goal', seconds: 120, seed: 3 });
  assert.equal(again.durationS, goal.durationS);
  assert.deepEqual(again.final.player, goal.final.player);
});

test('a frozen game is a softlock with an evidence frame time; a dead loop after an error is a crash', async () => {
  const frozen = await bots.runBot(fakeWorld({ freezeAfter: 1 }), { mode: 'goal', seconds: 120 });
  assert.equal(frozen.softlocks.length, 1);
  assert.match(frozen.softlocks[0].detail, /no input changed anything for \d+\.\ds \(\d+ different inputs tried\)/);
  assert.ok(frozen.events.some((e: { type: string }) => e.type === 'stuck'));
  assert.ok(frozen.durationS < 40, 'it stops at the softlock');
  const crash = await bots.runBot(fakeWorld({ crashAt: 5000 }), { mode: 'explore', seconds: 30 });
  assert.equal(crash.crashed, true);
  const ev = crash.events.find((e: { type: string }) => e.type === 'crash');
  assert.ok(ev.t >= 5 && ev.t < 6, String(ev.t));
  assert.match(ev.detail, /the game loop stopped after an uncaught error: Error: boom/);
});

test('verdicts: state checks over a run (ever, end, always, never, run-level paths) and judge answers', () => {
  const run = { errors: [] as string[], crashed: false, softlocks: [], stuck: [], goalReached: false };
  const samples = [0, 1, 2, 3, 4, 5].map((i) => verdicts.sample(i * 1000, { coins: i, lives: 3, player: { x: i * 10 } }, run));
  const v = (c: object) => verdicts.evaluateCheck(c, samples);
  assert.equal(v({ path: 'coins', op: '>=', value: 5 }).pass, true);
  assert.match(v({ path: 'coins', op: '>=', value: 5 }).detail, /first held at 5\.0s/);
  assert.equal(v({ path: 'coins', op: '>=', value: 6 }).pass, false);
  assert.equal(v({ path: 'player.x', op: '==', value: 50, when: 'end' }).pass, true);
  assert.equal(v({ path: 'lives', op: '==', value: 3, when: 'always' }).pass, true);
  assert.equal(v({ path: 'lives', op: '<', value: 0, when: 'never' }).pass, true);
  assert.equal(v({ path: '$errors', op: '>', value: 0, when: 'never' }).pass, true);
  assert.equal(v({ path: 'coins', op: 'bogus' }).pass, false);
  assert.match(verdicts.checkError({ path: 'x', when: 'sometimes' }), /unknown when/);
  assert.equal(verdicts.describeCheck({ path: 'won', op: '==', value: true, when: 'end' }), 'won == true (end)');
  const j = verdicts.parseJudgement('Here: [{"claim": "door open", "pass": true, "frame": "f/1.png", "why": "green"}, {"claim": "score 5", "pass": false}]', ['door open', 'score 5', 'missing']);
  assert.equal(j[0].pass, true);
  assert.equal(j[0].frame, 'f/1.png');
  assert.equal(j[1].pass, false);
  assert.equal(j[2], null);
});

test('the playtest runner on a fake driver: segments, a softlock issue with evidence and replay, the report format', async () => {
  const root = await tempDir();
  const files = new Map<string, Buffer>();
  const io = {
    write: async (rel: string, data: Buffer) => { files.set(rel, data); await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await fs.writeFile(path.join(root, rel), data); },
    read: async (rel: string) => files.get(rel) ?? null,
    list: async () => [],
  };
  const good = await report.runPlaytest({ start: async () => fakeWorld({ walls: WALL }), ...io }, { id: 'pt-20261023-1', engine: 'fake', boot: false, bots: ['goal', { mode: 'explore', seconds: 20 }], goal: 'collect three coins', checks: [{ path: 'coins', op: '>=', value: 3 }] });
  assert.deepEqual(report.validateReport(good.report), []);
  assert.equal(good.report.result, 'pass', good.text);
  assert.equal(good.report.goalReached, true);
  assert.equal(good.report.goalReachedBy, 'bot:goal');
  assert.equal(good.report.verdicts[0].pass, true);
  assert.ok(files.has('.studio/playtests/pt-20261023-1/report.json'));
  assert.ok(files.has('.studio/playtests/pt-20261023-1/inputs-1.json'));
  assert.match(good.text, /Playtest pt-20261023-1: PASS/);

  const bad = await report.runPlaytest({ start: async () => fakeWorld({ freezeAfter: 1 }), ...io }, { id: 'pt-20261023-2', engine: 'fake', boot: false, bots: ['goal'], goal: 'collect three coins' });
  assert.deepEqual(report.validateReport(bad.report), []);
  assert.equal(bad.report.result, 'fail');
  const issue = bad.report.issues.find((i: { title: string }) => /Softlock/.test(i.title));
  assert.equal(issue.severity, 'blocker');
  assert.equal(issue.replay, 'inputs-1.json');
  assert.equal(bad.report.stuck.some((s: { type: string }) => s.type === 'softlock'), true);
  assert.deepEqual(report.validateReport({ ...bad.report, result: 'maybe', issues: [{ severity: 'huge', title: 1 }] }).length, 2);
});

test('engines: detection by project files; Godot, Unreal and Unity answer unavailable until their plugin has a driver, then use it', async () => {
  const root = await tempDir();
  assert.equal(await driver.detectEngine(root), 'web');
  await fs.writeFile(path.join(root, 'project.godot'), 'config_version=5\n');
  assert.equal(await driver.detectEngine(root), 'godot');
  const g = await tempDir();
  await fs.writeFile(path.join(g, 'Coin.uproject'), '{}');
  assert.equal(await driver.detectEngine(g), 'unreal');
  await fs.mkdir(path.join(g, '.studio'));
  await fs.writeFile(path.join(g, '.studio', 'project.json'), JSON.stringify({ engine: 'unity' }));
  assert.equal(await driver.detectEngine(g), 'unity');
  const host = new LocalHost(root);
  // engine-godot, engine-unity and engine-unreal ship drivers; with no project, editor or build they say why they cannot start.
  for (const engine of [] as string[]) {
    await assert.rejects(driver.startSession(host, { engine }), (e: Error & { unavailable?: boolean }) => e.unavailable === true && new RegExp(`engine-${engine}`).test(e.message));
  }
  await assert.rejects(driver.startSession(new LocalHost(await tempDir()), { engine: 'godot' }), /no Godot project here/);
  await assert.rejects(driver.startSession(host, { engine: 'unity' }), /harness bridge|build/);
  await assert.rejects(driver.startSession(host, { engine: 'unreal' }), /no Unreal project|Unreal Engine is not installed/);
  // An engine plugin's driver module (HARNESS_<ENGINE>_DRIVER points at one for the test).
  const mod = path.join(await tempDir(), 'driver.mjs');
  await fs.writeFile(mod, `export function createDriver(host, opts) { return { async start(game) { let t = 0; return {
    info: { game, seed: 1 }, get t() { return t; },
    async observe() { return { t, state: { player: { x: t / 100, y: 0 } }, events: [] }; },
    async step(inputs, ms) { t += ms; return { t, state: { player: { x: t / 100, y: 0 }, won: t > 1000 }, events: [{ t: t / 1000, type: 'tick', detail: inputs.map((i) => i.key).join('+') }] }; },
    async stop() { return { metrics: { fpsAvg: 60 } }; } }; } }; }\n`);
  process.env.HARNESS_UNITY_DRIVER = mod;
  try {
    const s = await driver.startSession(host, { engine: 'unity', game: 'Main.unity' });
    assert.equal(s.info.engine, 'unity');
    assert.equal(s.info.game, 'Main.unity');
    const o = await s.step([{ key: 'ArrowRight', ms: 600 }], 600);
    assert.equal(o.state.player.x, 6);
    assert.equal(o.events[0].detail, 'ArrowRight');
    const run = await bots.runBot(await driver.startSession(host, { engine: 'unity' }), { mode: 'random', seconds: 3 });
    assert.equal(run.goalReached, true);
    assert.deepEqual((await s.stop()).metrics, { fpsAvg: 60 });
  } finally { delete process.env.HARNESS_UNITY_DRIVER; }
});

/** A playtest report for the gates, with overrides. */
const reportOf = (o: Record<string, unknown> = {}) => ({
  id: 'pt-20261023-1', engine: 'web', player: 'bot:goal', goal: 'escape', goalReached: true, goalReachedBy: 'bot:goal', result: 'pass', durationS: 10, steps: 50,
  events: [], metrics: { fpsAvg: 58, fpsMin: 50, frameMsP95: 18, errors: 0, consoleErrors: 0, fpsBudget: 30 }, frames: [], recording: null, issues: [], verdicts: [], segments: [], crashes: [], ...o,
});

test('playtest-pass gate: the latest report decides; errors, a crash, no goal, low fps or a failed verdict fail it', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'games3d')], search: null, memory: 'off' });
  try {
    const root = await tempDir();
    const host = new LocalHost(root);
    const gate = () => runGates(h.registry, host, ['playtest-pass'], new AbortController().signal).then((r) => r[0]!);
    assert.ok(h.registry.gates.has('playtest-pass') && h.registry.gates.has('game-starts') && h.registry.gates.has('no-softlock') && h.registry.gates.has('playtest-regressions'));
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'T', engine: 'web', playtests: [] }));
    let g = await gate();
    assert.equal(g.pass, false);
    assert.match(g.summary, /no playtest yet/);
    const put = async (id: string, r: object) => {
      await fs.mkdir(path.join(root, '.studio', 'playtests', id), { recursive: true });
      await fs.writeFile(path.join(root, '.studio', 'playtests', id, 'report.json'), JSON.stringify(r));
      const p = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
      p.playtests.push(id);
      await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify(p));
    };
    await put('pt-20261023-1', reportOf());
    g = await gate();
    assert.equal(g.pass, true, g.details ?? "");
    assert.match(g.summary, /goal reached by bot:goal/);
    const cases: [string, object, RegExp][] = [
      ['pt-20261023-2', { metrics: { ...reportOf().metrics, errors: 2 }, result: 'fail' }, /2 uncaught error/],
      ['pt-20261023-3', { result: 'crash', crashes: [{ t: 5, detail: 'boom' }] }, /it crashed/],
      ['pt-20261023-4', { goalReached: false, result: 'fail' }, /nobody reached the goal/],
      ['pt-20261023-5', { metrics: { ...reportOf().metrics, fpsAvg: 12 } }, /12 fps \(budget 30\)/],
      ['pt-20261023-6', { verdicts: [{ by: 'vision', claim: 'the door opens', pass: false }] }, /verdict failed: the door opens/],
    ];
    for (const [id, o, why] of cases) {
      await new Promise((r) => setTimeout(r, 20));
      await put(id, reportOf({ id, ...o }));
      g = await gate();
      assert.equal(g.pass, false, id);
      assert.match(g.summary, why, id);
    }
  } finally { await h.close(); }
});
