// make-game's Godot path with the real Godot (HARNESS_REAL_GODOT=1; HARNESS_ENGINES_DIR keeps the
// installed Godot between runs) and a scripted model: the 2D template made into the game with a
// hero sheet from studio_sprite, the Godot gates, the bots and the AI player playing it through
// engine-godot's driver (a window off the screen), a Windows export that builds and runs its
// self-test, and the playtest reports.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Block, Message } from '@harness/core/src/core/types.ts';
import { createHarness } from '@harness/core/src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '@harness/core/src/providers/types.ts';
import { LocalHost } from '@harness/core/src/runtime/host.ts';
import { tempDir } from '@harness/core/test/helpers.ts';
import { HARNESS_ROOT } from '@harness/plugin-sdk/runtime';

const here = path.join(HARNESS_ROOT, 'test');
const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.HARNESS_REAL_GODOT !== '1' ? 'set HARNESS_REAL_GODOT=1 (and HARNESS_ENGINES_DIR to an installed Godot) to run Godot for real' : false;

type Call = { name: string; input: Record<string, unknown> };
type Step = { text?: string; calls?: Call[] };
type Script = Array<Step | ((results: string[]) => Step)>;
const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');

class StageProvider implements Provider {
  n = 0;
  results = new Map<string, string[]>();
  private scripts: Record<string, Script>;
  constructor(scripts: Record<string, Script>) { this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const first = textOf(req.messages[0]?.content ?? []);
    const brief = /<brief>\n?([\s\S]*?)\n?<\/brief>/.exec(first)?.[1] ?? first;
    const stage = /Stage: ([a-z0-9-]+)\./.exec(brief)?.[1] ?? 'none';
    const step = req.messages.filter((m: Message) => m.role === 'assistant').length;
    const results = req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content)));
    this.results.set(stage, results);
    const s = this.scripts[stage]?.[step];
    const st: Step = !s ? { text: `Done (${stage}).` } : typeof s === 'function' ? s(results) : s;
    const content: Block[] = [];
    if (st.text) content.push({ type: 'text', text: st.text });
    for (const c of st.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input });
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: st.text ?? null } } } as never, stop: st.calls?.length ? 'tool_use' : 'end', usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 20, reasoning: 0 } };
  }
}

const write = (p: string, content: string): Call => ({ name: 'write', input: { path: p, content } });
const GDD = [
  '# Coin Garden', '## Pitch', 'A gardener walks a walled garden and picks up every golden coin hidden between the paths.',
  '## Core loop', 'Walk, find, collect: five coins on a tile level, then the garden is cleared.',
  '## Controls', 'Arrows or WASD move (the input map: move_left, move_right, move_up, move_down).',
  '## Mechanics', 'Top-down movement at 120 px/s, stone walls block, coins are taken on touch.',
  '## Rules (win and lose)', 'Win: every coin taken (StudioHook "won"). No way to lose.',
  '## Levels', 'One garden of 40 x 22 tiles.', '## Art direction', 'Pixel art: the hero from studio_sprite, 16-px tiles.',
  '## Audio', 'A pickup sound.', '## UI', 'A coin counter and "You win!".', '## Balancing', 'Speed 120 px/s; five coins.',
  '## Scope', 'One level now; more later.',
  '## Self-test', 'Hold move_right 30 ticks: the player moves and walks; hold move_left into the wall: it stops; touch a coin: the score is 1; then SELFTEST PASS.',
].join('\n\n');
const PLAN = JSON.stringify({ name: 'Coin Garden', engine: 'godot', dimension: '2d', genre: 'top-down collect', design: 'design/GDD.md', engineProject: 'game/project.godot', budgets: { fps: 30 }, playtest: { softlockSeconds: 15, bootSeconds: 4 }, stages: [{ id: 'plan', status: 'done' }], builds: [], playtests: [] }, null, 2);
const trail = (run: { history: { node: string; outcome?: string; status: string }[] }) => run.history.map((x) => `${x.node}:${x.outcome ?? x.status}`);

test('make-game, Godot 2D for real: a scripted model makes a Godot game whose bots finish it, plays it as the AI player, and exports it for Windows', { skip, timeout: 3_600_000 }, async () => {
  const ws = await tempDir('studio-make-game-godot-');
  const goal = 'take every coin';
  const checks = [{ path: 'won', op: '==', value: true, when: 'ever' }];
  let session = '';
  const scripts: Record<string, Script> = {
    plan: [{ calls: [write('.studio/project.json', PLAN), write('design/production-plan.md', '# Plan\n\nThe Godot 2D template, made into Coin Garden with a studio_sprite hero.\n')] }, { text: 'Planned.' }],
    concept: [{ calls: [write('design/GDD.md', GDD)] }, { text: 'GDD written.' }],
    art: [{ calls: [write('design/style-guide.md', '# Style\n\n32-px characters, 16-px tiles, warm greens.\n'), write('design/asset-plan.json', JSON.stringify({ assets: [{ id: 'hero-sheet', kind: 'spritesheet', tool: 'studio_sprite', input: { action: 'sheet', kind: 'character', view: 'front', seed: 9, anims: ['idle', 'walk'] }, purpose: 'the gardener' }, { id: 'sfx-coin', kind: 'audio', tool: 'studio_audio', input: { action: 'sfx', preset: 'pickup', seed: 9 }, purpose: 'pickup' }] }))] }, { text: 'Planned.' }],
    assets: [{ calls: [{ name: 'studio_sprite', input: { action: 'sheet', kind: 'character', view: 'front', seed: 9, anims: ['idle', 'walk'], id: 'hero-sheet' } }] }, { text: 'Made hero-sheet.' }],
    audio: [{ calls: [{ name: 'studio_audio', input: { action: 'sfx', preset: 'pickup', seed: 9, id: 'sfx-coin' } }] }, { text: 'Made sfx-coin.' }],
    prototype: [
      { calls: [{ name: 'godot', input: { action: 'project.create', template: '2d', project: 'game', name: 'Coin Garden' } }] },
      { calls: [{ name: 'godot', input: { action: 'asset.import', project: 'game', asset: 'hero-sheet' } }] },
      { calls: [{ name: 'read', input: { path: 'game/scripts/main.gd' } }] },
      { calls: [{ name: 'edit', input: { path: 'game/scripts/main.gd', old_string: 'SpriteSheet.load_frames("res://assets/hero")', new_string: 'SpriteSheet.load_frames("res://assets/hero-sheet")' } }] },
      { calls: [{ name: 'godot', input: { action: 'check', project: 'game' } }] },
      { calls: [{ name: 'game_bot', input: { mode: 'goal', seconds: 60 } }] },
      (r) => ({ text: r.at(-1)!.split('\n').slice(0, 2).join('\n') }),
    ],
    playtest: [{ calls: [{ name: 'game_playtest', input: { goal, checks, bots: [{ mode: 'goal', seconds: 60 }, { mode: 'explore', seconds: 10 }] } }] }, (r) => ({ text: `${r.at(-1)!.split('\n')[0]}\nAPPROVE` })],
    'vertical-slice': [{ calls: [{ name: 'game_bot', input: { mode: 'goal', seconds: 60 } }] }, { text: 'The hero sheet plays its walk.' }],
    polish: [{ calls: [{ name: 'game_playtest', input: { goal, checks, bots: [{ mode: 'goal', seconds: 60 }] } }] }, { text: 'Polished.' }],
    build: [{ calls: [{ name: 'godot', input: { action: 'build', project: 'game', platform: 'windows' } }] }, (r) => ({ text: r.at(-1)!.split('\n')[0] })],
    'full-playtest': [
      { calls: [{ name: 'game_play', input: { action: 'start' } }] },
      (r) => { session = /Play session (\S+) started/.exec(r.at(-1) ?? '')?.[1] ?? ''; return { calls: [{ name: 'game_play', input: { action: 'step', session, inputs: [{ key: 'ArrowRight', ms: 500 }], ms: 500 } }] }; },
      () => ({ calls: [{ name: 'game_play', input: { action: 'verdict', session, claim: 'the gardener walks right and the coin counter shows', pass: true } }] }),
      () => ({ calls: [{ name: 'game_play', input: { action: 'stop', session } }] }),
      () => ({ calls: [{ name: 'game_playtest', input: { goal, checks, bots: [{ mode: 'goal', seconds: 60 }], sessions: [session] } }] }),
      { text: 'No findings.\nAPPROVE' },
    ],
    report: [{ calls: [write('docs/studio-report.md', '# Coin Garden\n\nA Godot 2D game; build/windows/game.exe.\n')] }, { text: 'Done.' }],
  };
  const fake = new StageProvider(scripts);
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'visual', 'engine-godot'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', fake);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('make-game', { brief: 'A small top-down Godot game: walk a garden and take every coin.', engine: 'godot', dimension: '2d', approval: 'auto' });
    await done;
    const [run] = await s.listRuns();
    const t = trail(run!);
    console.log(t.join(' '));
    assert.equal(run!.status, 'succeeded', `${t.join(' ')}\n${JSON.stringify([...fake.results]).slice(0, 4000)}\n${run!.history.filter((x) => x.type === 'gate').map((x) => x.summary).join('\n')}`);
    for (const g of ['prototype-gates-godot:pass', 'playtest-gates:pass', 'polish-gates-godot:pass', 'build-gates-godot:pass', 'final-gates:pass']) assert.ok(t.includes(g), g);
    const summary = (node: string) => run!.history.filter((x) => x.node === node).at(-1)!.summary!;
    for (const g of [/PASS godot-project/, /PASS godot-selftest/, /PASS game-starts: the game draws/, /PASS no-softlock/]) assert.match(summary('prototype-gates-godot'), g);
    assert.match(summary('build-gates-godot'), /PASS godot-export/);
    // The bots and the AI player played the Godot game; the hero is the studio_sprite sheet.
    const project = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'project.json'), 'utf8'));
    const last = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'playtests', project.playtests.at(-1), 'report.json'), 'utf8'));
    assert.equal(last.engine, 'godot');
    assert.equal(last.result, 'pass');
    assert.ok(last.players.includes('ai') && last.players.includes('bot:goal'), last.players.join(', '));
    assert.ok(last.events.filter((e: { type: string }) => e.type === 'pickup').length >= 5);
    assert.match(await fs.readFile(path.join(ws, 'game', 'scripts', 'main.gd'), 'utf8'), /res:\/\/assets\/hero-sheet/);
    // The Windows export builds and the exported game passes its own self-test.
    const exe = path.join(ws, 'build', 'windows', 'game.exe');
    assert.ok((await fs.stat(exe)).size > 1e6);
    const r = await new LocalHost(ws).exec(`'./build/windows/game.exe' --headless --fixed-fps 60 --quit-after 600 -- --selftest`, { timeoutMs: 120_000 });
    assert.match(r.stdout + r.stderr, /SELFTEST PASS/);
  } finally { await h.close(); }
});
