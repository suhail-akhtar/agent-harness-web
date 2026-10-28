// Studio player on real web games (test/fixtures/games: a platformer, a maze, a Three.js collect
// game) in the offline headless browser: bots reach every goal, exact replays, broken builds
// (a crash after 5 s, a softlock after the third coin) caught with evidence, regressions, a full
// playtest with its GIF, the gates, and the AI-player loop driven by a scripted model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates, pluginDir as dirOf } from '@harness/plugin-sdk/testing';
import { createHarness } from '@harness/plugin-sdk/testing';
import type { Block, Message } from '@harness/plugin-sdk/testing';
import type { Provider, ProviderRequest, ProviderResponse } from '@harness/plugin-sdk/testing';
import { LocalHost } from '@harness/plugin-sdk/testing';
import type { ToolContext } from '@harness/plugin-sdk/testing';
import { tempDir } from '@harness/plugin-sdk/testing';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';

const here = path.join(HARNESS_ROOT, 'test');
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(dirOf('games3d'), 'test', 'fixtures', 'games');
const { chromiumPath, closeBrowser, runPage } = await import('@harness/plugins/visual/lib/browser.mjs');
const { addLibrary } = await import('@harness/plugins/visual/lib/libraries.mjs');
// @ts-expect-error plain JS module
const { startWebSession } = await import('../player/web-driver.mjs');
// @ts-expect-error plain JS module
const { runBot } = await import('../player/bots.mjs');
// @ts-expect-error plain JS module
const { decodeGif } = await import('../player/gif.mjs');
// @ts-expect-error plain JS module
const { validateReport } = await import('../player/report.mjs');
// @ts-expect-error plain JS module
const { closeAllPlay } = await import('../player/index.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();
const skip = hasChromium ? false : 'no Chromium for playwright-core here';
const LONG = { skip, timeout: 600_000 };

/** A workspace with a copy of a fixture game (and Three.js vendored for the 3D one). */
async function workspace(game: string, edit?: (html: string) => string) {
  const root = await tempDir('studio-play-');
  await fs.cp(path.join(FIX, game), root, { recursive: true });
  if (edit) await fs.writeFile(path.join(root, 'index.html'), edit(await fs.readFile(path.join(root, 'index.html'), 'utf8')));
  if (game === 'collect3d') await addLibrary(root, 'three');
  return root;
}

const harness = async () => createHarness({ dataDir: await tempDir(), plugins: [path.join(pluginDir)], search: null, memory: 'off' });
const ctxFor = (root: string, extra: Partial<ToolContext> = {}) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, beforeWrite: async () => {}, ...extra }) as unknown as ToolContext;
type Tools = { get(n: string): { run(i: Record<string, unknown>, c: ToolContext): Promise<{ content: string; is_error?: boolean; images?: unknown[] }> } | undefined };
const tool = (h: { registry: { tools: Tools } }, name: string) => h.registry.tools.get(name)!;

test.after(async () => { await closeAllPlay(); await closeBrowser(); });

test('platformer: the goal bot takes all five coins and leaves by the exit; the recording replays exactly', LONG, async () => {
  const h = await harness();
  try {
    const root = await workspace('platformer');
    const t0 = Date.now();
    const r = await tool(h, 'game_bot').run({ mode: 'goal', seconds: 120 }, ctxFor(root));
    assert.equal(r.is_error, false, r.content);
    assert.match(r.content, /Goal reached: yes\. Crashed: no\. Softlocks: 0/);
    assert.match(r.content, /pickup x5/);
    assert.match(r.content, /"coins":5/);
    const rec = /Recording: (\S+\.json)/.exec(r.content)![1]!;
    const saved = JSON.parse(await fs.readFile(path.join(root, rec), 'utf8'));
    assert.equal(saved.recording.clock, 'fixed');
    assert.ok(saved.recording.events.length > 10);
    console.log(`goal bot: ${saved.summary.durationS}s of game in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${saved.summary.steps} steps`);
    // The fixed clock and the seed make the replay exact: the same moment, the same place.
    const replay = await tool(h, 'game_bot').run({ mode: 'scripted', recording: rec, expect: [{ path: 'won', op: '==', value: true, when: 'end' }, { path: 'coins', op: '==', value: 5, when: 'end' }] }, ctxFor(root));
    assert.match(replay.content, /PASS won == true \(end\)/);
    assert.match(replay.content, /PASS coins == 5 \(end\)/);
    // The same final state to the last digit (player x, y, coins...), and the same pickups (seen
    // a little sooner: the replay looks every 150 ms, the bot after each of its moves).
    const finalOf = (s: string) => /Final state: (.*)/.exec(s)![1];
    assert.equal(finalOf(replay.content), finalOf(r.content));
    const a = saved.summary.events.filter((e: { type: string }) => e.type === 'pickup').map((e: { t: number }) => e.t);
    const b = JSON.parse(await fs.readFile(path.join(root, /Recording: (\S+\.json)/.exec(replay.content)![1]!), 'utf8')).summary.events.filter((e: { type: string }) => e.type === 'pickup').map((e: { t: number }) => e.t);
    assert.equal(b.length, 5);
    b.forEach((t: number, i: number) => assert.ok(t <= a[i] && a[i] - t <= 0.61, `coin ${i + 1}: ${t} vs ${a[i]}`));
    // The explorer, with no target to follow, still finds every coin and the way out.
    const ex = await tool(h, 'game_bot').run({ mode: 'explore', seconds: 180 }, ctxFor(root));
    assert.match(ex.content, /Goal reached: yes/, ex.content);
  } finally { await h.close(); }
});

test('maze and 3D: the goal bot finishes the maze and collects every gem; the explorer covers the maze', LONG, async () => {
  const maze = await workspace('maze');
  const s = await startWebSession({ root: maze });
  const run = await runBot(s, { mode: 'goal', seconds: 300 });
  await s.stop();
  assert.equal(run.goalReached, true, JSON.stringify(run.final));
  assert.equal(run.final.coins, 3);
  console.log(`maze goal: ${run.durationS}s, ${run.steps} steps, ${run.coverage.cells} places`);
  const s2 = await startWebSession({ root: maze });
  const ex = await runBot(s2, { mode: 'explore', seconds: 300 });
  await s2.stop();
  assert.equal(ex.final.coins, 3, `the explorer found ${ex.final.coins} coins in ${ex.durationS}s`);
  console.log(`maze explore: ${ex.durationS}s, all coins: ${ex.final.coins === 3}, out: ${ex.goalReached}`);

  const g3d = await workspace('collect3d');
  const s3 = await startWebSession({ root: g3d, viewport: { width: 640, height: 400 } });
  const first = await s3.observe();
  assert.equal(first.frame.stats.blank, false, 'WebGL draws');
  const r3 = await runBot(s3, { mode: 'goal', seconds: 120 });
  const fin = await s3.stop();
  assert.equal(r3.goalReached, true, JSON.stringify(r3.final));
  assert.equal(r3.final.gems, 4);
  assert.deepEqual(fin.errors, []);
  console.log(`3D goal: ${r3.durationS}s, ${r3.steps} steps`);
});

test('broken builds: a crash after 5 s and a softlock after the third coin are caught with evidence, replayed, and locked in as regressions', LONG, async () => {
  const h = await harness();
  try {
    // The crash: game_playtest says crash, with the error, the frame and the inputs that lead to it.
    const root = await workspace('platformer');
    await fs.mkdir(path.join(root, '.studio'));
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'Coin Hop', engine: 'web', dimension: '2d', playtests: [] }));
    const pt = await tool(h, 'game_playtest').run({ query: '?bug=crash', goal: 'collect five coins and reach the exit', bots: ['goal', 'explore'], seconds: 30, bootSeconds: 2 }, ctxFor(root));
    assert.match(pt.content, /Playtest pt-\d{8}-1: CRASH/, pt.content);
    assert.match(pt.content, /\[BLOCKER\] The game crashes at \d+(\.\d+)?s: the game loop stopped after an uncaught error: TypeError: Cannot read properties of null/);
    const dir = path.join(root, '.studio', 'playtests', /Playtest (pt-\d{8}-1)/.exec(pt.content)![1]!);
    const rep = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
    assert.deepEqual(validateReport(rep), []);
    assert.equal(rep.result, 'crash');
    const crash = rep.issues.find((i: { title: string }) => /crashes/.test(i.title));
    await fs.access(path.join(dir, crash.evidence));
    assert.ok((pt.images ?? []).length >= 1, 'the evidence frame is shown');
    assert.ok(rep.errors[0].includes('TypeError'));
    const project = JSON.parse(await fs.readFile(path.join(root, '.studio', 'project.json'), 'utf8'));
    assert.deepEqual(project.playtests, [rep.id]);
    let [g] = await runGates(h.registry, new LocalHost(root), ['playtest-pass'], new AbortController().signal);
    assert.equal(g!.pass, false);
    assert.match(g!.summary, /result crash; it crashed/);
    // The replay of the crashing bot crashes at the same moment; saved as a regression it fails until fixed.
    const replay = await tool(h, 'game_bot').run({ mode: 'scripted', recording: path.relative(root, path.join(dir, crash.replay)).replace(/\\/g, '/'), saveAs: 'crash-after-5s', expect: [{ path: '$crashed', op: 'truthy', when: 'never' }] }, ctxFor(root));
    assert.match(replay.content, /Crashed: YES/);
    assert.match(replay.content, /FAIL \$crashed truthy \(never\)/);
    [g] = await runGates(h.registry, new LocalHost(root), ['playtest-regressions'], new AbortController().signal);
    assert.equal(g!.pass, false);
    assert.match(g!.details!, /crash-after-5s\.json: crashed/);

    // The softlock: the no-softlock gate fails with an evidence frame and a replay; fixed, it passes.
    const soft = await workspace('platformer', (html) => html.replace("const bug = q.get('bug');", "const bug = 'softlock';"));
    await fs.mkdir(path.join(soft, '.studio'));
    await fs.writeFile(path.join(soft, '.studio', 'project.json'), JSON.stringify({ name: 'Coin Hop', engine: 'web', playtest: { softlockSeconds: 90 } }));
    [g] = await runGates(h.registry, new LocalHost(soft), ['no-softlock'], new AbortController().signal);
    assert.equal(g!.pass, false, g!.summary);
    assert.match(g!.summary, /softlock at \d+(\.\d+)?s: no input changed anything for \d+\.\ds/);
    const png = /Evidence frame: (\S+)/.exec(g!.details!)![1]!;
    await fs.access(path.join(soft, png));
    const softRec = /"recording":"([^"]+)"/.exec(g!.details!)![1]!;
    const lock = await tool(h, 'game_bot').run({ mode: 'scripted', recording: softRec, saveAs: 'third-coin-freeze', expect: [{ path: '$softlocks', op: '>', value: 0, when: 'never' }] }, ctxFor(soft));
    assert.match(lock.content, /Softlocks: 1/, lock.content);
    [g] = await runGates(h.registry, new LocalHost(soft), ['playtest-regressions'], new AbortController().signal);
    assert.equal(g!.pass, false);
    // The fix: the regression's inputs now play on past the third coin.
    await fs.writeFile(path.join(soft, 'index.html'), (await fs.readFile(path.join(soft, 'index.html'), 'utf8')).replace("const bug = 'softlock';", 'const bug = null;'));
    [g] = await runGates(h.registry, new LocalHost(soft), ['playtest-regressions'], new AbortController().signal);
    assert.equal(g!.pass, true, g!.details ?? "");
    [g] = await runGates(h.registry, new LocalHost(soft), ['no-softlock'], new AbortController().signal);
    assert.equal(g!.pass, true, g!.summary);
  } finally { await h.close(); }
});

test('a full playtest of a good build: pass, a valid report, frames, a GIF a browser can show, and the gates pass', LONG, async () => {
  const h = await harness();
  try {
    const root = await workspace('platformer');
    await fs.mkdir(path.join(root, '.studio'));
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'Coin Hop', engine: 'web', budgets: { fps: 30 }, playtests: [] }));
    const t0 = Date.now();
    const pt = await tool(h, 'game_playtest').run({ goal: 'collect five coins and reach the exit', checks: [{ path: 'coins', op: '>=', value: 5 }, { path: '$errors', op: '>', value: 0, when: 'never' }], seconds: 90 }, ctxFor(root));
    console.log(`playtest in ${((Date.now() - t0) / 1000).toFixed(1)}s:\n${pt.content.split('\n').slice(0, 12).join('\n')}`);
    assert.match(pt.content, /: PASS/, pt.content);
    const id = /Playtest (pt-\d{8}-\d+)/.exec(pt.content)![1]!;
    const dir = path.join(root, '.studio', 'playtests', id);
    const rep = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
    assert.deepEqual(validateReport(rep), []);
    assert.equal(rep.goalReached, true);
    assert.deepEqual(rep.players, ['bot:monkey', 'bot:goal', 'bot:explore']);
    assert.deepEqual(rep.segments.map((s: { mode: string }) => s.mode), ['boot', 'goal', 'explore', 'monkey']);
    assert.ok(rep.metrics.fpsAvg > 20, `real-clock fps ${rep.metrics.fpsAvg}`);
    assert.equal(rep.metrics.errors, 0);
    assert.ok(rep.verdicts.every((v: { pass: boolean }) => v.pass));
    assert.ok(rep.events.some((e: { type: string; frame?: string }) => e.type === 'goal' && e.frame));
    for (const f of rep.frames.slice(0, 3)) await fs.access(path.join(dir, f));
    for (const s of rep.segments.filter((x: { recording?: string }) => x.recording)) await fs.access(path.join(dir, s.recording));
    const gifBytes = await fs.readFile(path.join(dir, rep.recording));
    const g = decodeGif(gifBytes);
    assert.ok(g.frames.length >= 10, `${g.frames.length} GIF frames`);
    assert.equal(g.width, 320);
    // Chromium decodes it too.
    await fs.writeFile(path.join(dir, 'show.html'), `<img src="${rep.recording}">`);
    const shown = await runPage({ root: dir, file: 'show.html', actions: [], evaluate: 'document.querySelector("img").naturalWidth', screenshot: false, waitMs: 300 });
    assert.equal(shown.result, '320');
    for (const gate of ['playtest-pass', 'game-starts', 'no-softlock']) {
      const [r] = await runGates(h.registry, new LocalHost(root), [gate], new AbortController().signal);
      assert.equal(r!.pass, true, `${gate}: ${r!.summary}\n${r!.details ?? ''}`);
      console.log(`${gate}: ${r!.summary}`);
    }
  } finally { await h.close(); }
});

test('game-starts fails a page that never draws, with the error', LONG, async () => {
  const h = await harness();
  try {
    const root = await workspace('platformer', (html) => html.replace('requestAnimationFrame(frame);\n\nwindow', 'throw new Error("assets failed to load");\n\nwindow'));
    const [g] = await runGates(h.registry, new LocalHost(root), ['game-starts'], new AbortController().signal);
    assert.equal(g!.pass, false);
    assert.match(g!.details!, /blank/);
    assert.match(g!.details!, /assets failed to load/);
  } finally { await h.close(); }
});

/**
 * A scripted model that plays the 3D game with game_play: it reads the state in each tool result
 * and steers to the nearest gem (x first, then z), records a verdict, stops, then asks for a
 * playtest with its session and a model judge. Sub-agents (the judge) answer from the frames' paths.
 */
class PlayerModel implements Provider {
  requests: ProviderRequest[] = [];
  imagesSeen = 0;
  private n = 0;
  private session = '';
  private steps = 0;
  private phase: 'play' | 'stopped' | 'playtest' | 'done' = 'play';
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    const msgs = req.messages as Message[];
    const first = msgs[0]!.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    const last = msgs.at(-1)!;
    const results = last.content.filter((b) => b.type === 'tool_result') as { content: string; images?: unknown[] }[];
    for (const r of results) this.imagesSeen += r.images?.length ?? 0;
    const text = results.map((r) => r.content).join('\n');
    if (first.includes('Frames of a game')) {
      const paths = [...first.matchAll(/^- (\S+\.png)$/gm)].map((m) => m[1]);
      if (!results.length) return this.reply([], undefined, paths.slice(0, 2).map((p) => ({ name: 'read', input: { path: p } })));
      return this.reply([], `[{"claim": "the cube is on a green field", "pass": true, "frame": "${paths[0]}", "why": "a blue cube on green ground"}]`);
    }
    if (!this.session) {
      if (!text) return this.reply([], 'I will play the game.', [{ name: 'game_play', input: { action: 'start', frameWidth: 320, width: 640, height: 400 } }]);
      this.session = /Play session (\S+) started/.exec(text)?.[1] ?? '';
    }
    if (this.phase === 'play') {
      const st = /state: (\{.*\})/.exec(text)?.[1];
      const state = st ? JSON.parse(st) : null;
      if (!state) return this.reply([], 'No state to read.');
      if (state.won || this.steps > 80) {
        this.phase = 'stopped';
        return this.reply([], 'All gems collected.', [{ name: 'game_play', input: { action: 'verdict', session: this.session, claim: 'all four gems are gone from the field', pass: !!state.won, goal: true } }]);
      }
      const p = state.player, t = [...state.targets].sort((a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      const dx = t.x - p.x, dz = t.z - p.z;
      const key = Math.abs(dx) > 0.3 ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft') : dz > 0 ? 'ArrowDown' : 'ArrowUp';
      const ms = Math.min(600, Math.max(50, Math.round((Math.abs(Math.abs(dx) > 0.3 ? dx : dz) / 6) * 1000)));
      this.steps++;
      return this.reply([], undefined, [{ name: 'game_play', input: { action: 'step', session: this.session, inputs: [{ key, ms }], ms } }]);
    }
    if (this.phase === 'stopped' && /Recorded: PASS/.test(text)) return this.reply([], undefined, [{ name: 'game_play', input: { action: 'stop', session: this.session, note: 'played by the scripted model' } }]);
    if (this.phase === 'stopped') { this.phase = 'playtest'; return this.reply([], undefined, [{ name: 'game_playtest', input: { sessions: [this.session], bots: [], boot: false, goal: 'collect all four gems' } }]); }
    if (this.phase === 'playtest') { this.phase = 'done'; return this.reply([], undefined, [{ name: 'game_playtest', input: { action: 'judge', claims: ['the cube is on a green field'] } }]); }
    return this.reply([], `Done: ${text.split('\n')[0]}`);
  }
  private reply(_: unknown[], text?: string, calls: { name: string; input: Record<string, unknown> }[] = []): ProviderResponse {
    const content: Block[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input });
    return { message: { role: 'assistant', content }, stop: calls.length ? 'tool_use' : 'end', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 } } as ProviderResponse;
  }
}

test('the AI player: a scripted model plays the 3D game through game_play from frames and state, its run replays, joins a playtest and a model judge', LONG, async () => {
  const ws = await workspace('collect3d');
  await fs.mkdir(path.join(ws, '.studio'));
  await fs.writeFile(path.join(ws, '.studio', 'project.json'), JSON.stringify({ name: 'Gem Field', engine: 'web', dimension: '3d', playtests: [] }));
  const h = await harness();
  const model = new PlayerModel();
  h.registry.setProviderInstance('deepseek', model);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('Play the game in this folder and collect every gem.');
    await done;
    assert.ok(model.imagesSeen >= 10, `the model saw ${model.imagesSeen} frames`);
    const recs = (await fs.readdir(path.join(ws, '.studio', 'recordings'))).filter((f) => f.startsWith('play-') && f.endsWith('.json'));
    assert.equal(recs.length, 1);
    const saved = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'recordings', recs[0]!), 'utf8'));
    assert.equal(saved.summary.goalReached, true);
    assert.equal(saved.summary.verdicts[0].by, 'vision');
    await fs.access(path.join(ws, '.studio', 'recordings', saved.summary.verdicts[0].evidence.replace('../../recordings/', '')));
    console.log(`AI player (scripted): ${saved.summary.steps} steps, ${saved.summary.durationS}s of game, ${model.imagesSeen} frames seen, ${model.requests.length} model calls`);
    // Its inputs replay exactly with a bot.
    const replay = await tool(h, 'game_bot').run({ mode: 'scripted', recording: `.studio/recordings/${recs[0]}`, expect: [{ path: 'won', op: '==', value: true, when: 'end' }] }, ctxFor(ws));
    assert.match(replay.content, /PASS won == true \(end\)/, replay.content);
    // The playtest has the AI player's segment, and the judge's verdict.
    const project = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'project.json'), 'utf8'));
    const rep = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'playtests', project.playtests[0], 'report.json'), 'utf8'));
    assert.deepEqual(validateReport(rep), []);
    assert.equal(rep.player, 'ai');
    assert.equal(rep.goalReachedBy, 'ai');
    assert.ok(rep.verdicts.some((v: { by: string; pass: boolean }) => v.by === 'model' && v.pass), JSON.stringify(rep.verdicts));
    assert.equal(rep.result, 'pass', JSON.stringify(rep.issues));
  } finally { await h.close(); }
});
