// make-game end to end with a scripted model (nothing is spent): a web 2D platformer from a brief.
// Every agent node gets a script keyed by its stage; the tool calls are real (the Studio asset
// builders, studio_template, game_bot, game_playtest, game_play) and so are the gates (the
// production gates, the asset gates, the player's game-starts, no-softlock and playtest-pass in
// the headless browser, web-build). The prototype's first try names an asset that does not
// exist, so the web-game gate sends it back with the evidence once. The Unreal path runs on the
// same provider with the engine's gates (which need Unreal) replaced by recording fakes: the
// route, the briefs and the Blender assets are what it proves.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Block, Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(here, '..', 'plugins', 'games3d', 'templates', 'web', 'platformer-2d');
// @ts-expect-error plain JS module
const { chromiumPath, closeBrowser } = await import('../plugins/visual/lib/browser.mjs');
// @ts-expect-error plain JS module
const { closeAllPlay } = await import('../plugins/games3d/player/index.mjs');
const hasChromium = await import('playwright-core').then(() => true, () => false) && !!chromiumPath();

type Call = { name: string; input: Record<string, unknown> };
type Step = { text?: string; calls?: Call[] };
type Script = Array<Step | ((results: string[]) => Step)>;
const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');

/** A model that plays a script per workflow stage ("Stage: <id>." in the node's brief), one step per call. */
class StageProvider implements Provider {
  n = 0;
  seen: string[] = [];
  briefs = new Map<string, string[]>();
  results = new Map<string, string[]>();
  private scripts: Record<string, Script>;
  constructor(scripts: Record<string, Script>) { this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const first = textOf(req.messages[0]?.content ?? []);
    const brief = /<brief>\n?([\s\S]*?)\n?<\/brief>/.exec(first)?.[1] ?? first;
    const stage = /Stage: ([a-z0-9-]+)\./.exec(brief)?.[1] ?? 'none';
    const step = req.messages.filter((m: Message) => m.role === 'assistant').length;
    if (!step) { this.seen.push(stage); this.briefs.set(stage, [...(this.briefs.get(stage) ?? []), brief]); }
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
const GDD = (title: string, engine: string) => [
  `# ${title}`, '## Pitch', 'A fox thief hops between rooftops, grabbing every coin before slipping out through the exit flag.',
  '## Core loop', '- Seconds: run and jump over gaps and spikes.\n- Minutes: take every coin in a level, then reach the exit.\n- Session: two levels, the second with wider gaps.',
  '## Controls', '| Action | Keys |\n| Move | Arrows / WASD |\n| Jump | Space |\n| Pause | P |',
  '## Mechanics', 'Running at 6 tiles/s, a 3.2-tile jump, coyote time; walkers to stomp; spikes and pits send you back to the last checkpoint.',
  '## Rules (win and lose)', `Win: every coin and the exit in each level (the game reports won). Unlimited retries. Engine: ${engine}.`,
  '## Levels', 'Two studio_procgen platformer levels, proven finishable by the solver.',
  '## Art direction', '16-px pixel art, warm sunset palette, dark outlines.',
  '## Audio', 'Jump, coin, hit, win sounds; a chiptune loop at 132 bpm.',
  '## UI', 'Title with controls, HUD with coins and deaths, pause, win and game-over cards.',
  '## Balancing', '| jumpHeight | 3.2 tiles |\n| runSpeed | 6 tiles/s |',
  '## Scope', 'First version: two levels. Later: a boss, more enemies.',
  '## Proof', 'Goal: take every coin and reach the exit; check {"path": "won", "op": "==", "value": true, "when": "ever"}.',
].join('\n\n');

const PLAN = (engine: string, dimension: string) => JSON.stringify({ name: 'Rooftop Fox', engine, dimension, genre: 'platformer', design: 'design/GDD.md', budgets: { fps: 30, frameMs: 33 }, playtest: { softlockSeconds: 15, bootSeconds: 4 }, stages: ['plan', 'concept', 'art', 'assets', 'prototype', 'playtest', 'vertical-slice', 'content', 'polish', 'build', 'full-playtest', 'report'].map((id) => ({ id, title: id, status: id === 'plan' ? 'done' : 'pending' })), builds: [], playtests: [] }, null, 2);

const trail = (run: { history: { node: string; outcome?: string; status: string }[] }) => run.history.map((x) => `${x.node}:${x.outcome ?? x.status}`);

/** A one-quad .glb with normals and UVs (what asset-3d wants of a model), 1 m across. */
function quadGlb(): Buffer {
  const parts = [new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), new Uint16Array([0, 1, 2, 0, 2, 3])].map((a) => Buffer.from(a.buffer));
  let off = 0;
  const bufferViews = parts.map((p) => { const v = { buffer: 0, byteOffset: off, byteLength: p.length }; off += p.length; return v; });
  const accessors = [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' }];
  const bin = Buffer.concat(parts);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  let js = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3 }] }], accessors, bufferViews, buffers: [{ byteLength: bin.length }] }));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + js.length + b.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(b.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, c1, js, c2, b]);
}

test.after(async () => { await closeAllPlay(); await closeBrowser(); });

test('make-game, web 2D: brief to a packaged, playtested platformer with a scripted model; assets from the Studio builders, the template filled, every stage gated', { skip: hasChromium ? false : 'no Chromium', timeout: 1_800_000 }, async () => {
  const ws = await tempDir('studio-make-game-');
  const tplGame = JSON.parse(await fs.readFile(path.join(TPL, 'game.json'), 'utf8'));
  const game = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...tplGame, title: 'Rooftop Fox', ...extra }, null, 2);
  const goal = 'take every coin and reach the exit';
  const checks = [{ path: 'won', op: '==', value: true, when: 'ever' }];
  let session = '';
  const scripts: Record<string, Script> = {
    plan: [{ calls: [write('.studio/project.json', PLAN('web', '2d')), write('design/production-plan.md', '# Production plan\n\nScope: two levels of the platformer-2d template. Cut: bosses. Budget: procedural assets only.\n')] }, { text: 'Planned: platformer-2d, two levels.' }],
    concept: [{ calls: [write('design/GDD.md', GDD('Rooftop Fox', 'web'))] }, { text: 'The GDD is written.' }],
    art: [{
      calls: [write('design/style-guide.md', '# Style guide\n\nPalette: #1e1e2a #f2a040 #3d7fd0 #c84a3a #f6d23a #4f8a3a. 32-px characters, 16-px tiles at 2x, dark outlines.\n'), write('design/asset-plan.json', JSON.stringify({ style: 'warm pixel art', assets: [
        { id: 'hero-sheet', kind: 'spritesheet', tool: 'studio_sprite', input: { action: 'sheet', kind: 'character', view: 'side', seed: 7, colors: { shirt: '#f2a040' } }, purpose: 'the fox thief' },
        { id: 'coin-sheet', kind: 'spritesheet', tool: 'studio_sprite', input: { action: 'sheet', kind: 'coin', seed: 2 }, purpose: 'coins' },
        { id: 'level-1', kind: 'level', tool: 'studio_procgen', input: { action: 'platformer', seed: 3, length: 48, height: 14, difficulty: 0.15 }, purpose: 'level 1' },
        { id: 'sfx-jump', kind: 'audio', tool: 'studio_audio', input: { action: 'sfx', preset: 'jump', seed: 4 }, purpose: 'jump' },
        { id: 'sfx-coin', kind: 'audio', tool: 'studio_audio', input: { action: 'sfx', preset: 'pickup', seed: 4 }, purpose: 'coin' },
        { id: 'music-loop', kind: 'music', tool: 'studio_audio', input: { action: 'music', style: 'chiptune', seed: 4, bpm: 132, repeats: 1 }, purpose: 'music' },
      ] }, null, 2))],
    }, { text: 'Style guide and asset plan written.' }],
    assets: [{ calls: [
      { name: 'studio_sprite', input: { action: 'sheet', kind: 'character', view: 'side', seed: 7, colors: { shirt: '#f2a040' }, id: 'hero-sheet' } },
      { name: 'studio_sprite', input: { action: 'sheet', kind: 'coin', seed: 2, id: 'coin-sheet' } },
      { name: 'studio_procgen', input: { action: 'platformer', seed: 3, length: 48, height: 14, difficulty: 0.15, id: 'level-1' } },
    ] }, { text: 'Made hero-sheet, coin-sheet, level-1.' }],
    audio: [{ calls: [
      { name: 'studio_audio', input: { action: 'sfx', preset: 'jump', seed: 4, id: 'sfx-jump' } },
      { name: 'studio_audio', input: { action: 'sfx', preset: 'pickup', seed: 4, id: 'sfx-coin' } },
      { name: 'studio_audio', input: { action: 'music', style: 'chiptune', seed: 4, bpm: 132, repeats: 1, id: 'music-loop' } },
    ] }, { text: 'Made the sounds.' }],
    // The first try names a boss sprite nobody made: the web-game gate sends it back.
    prototype: [
      { calls: [{ name: 'studio_template', input: { action: 'create', template: 'platformer-2d', title: 'Rooftop Fox' } }] },
      { calls: [{ name: 'read', input: { path: 'game.json' } }] },
      { calls: [write('game.json', game({ assets: { ...tplGame.assets, boss: 'asset:boss-sheet' } }))] },
      { calls: [{ name: 'game_bot', input: { mode: 'goal', seconds: 150 } }] },
      { text: 'The prototype plays: the goal bot reached the exit.' },
    ],
    'prototype-fix': [{ calls: [{ name: 'read', input: { path: 'game.json' } }] }, { calls: [write('game.json', game())] }, { text: 'Removed the boss sprite reference.' }],
    playtest: [{ calls: [{ name: 'game_playtest', input: { goal, checks, bots: [{ mode: 'goal', seconds: 150 }, { mode: 'explore', seconds: 10 }] } }] }, (r) => ({ text: `${r.at(-1)?.split('\n')[0]}\nAPPROVE` })],
    'vertical-slice': [{ calls: [{ name: 'game_bot', input: { mode: 'goal', seconds: 150 } }] }, { text: 'The slice uses the made sprites, tiles and sounds.' }],
    content: [
      { calls: [{ name: 'studio_procgen', input: { action: 'platformer', seed: 5, length: 36, height: 14, difficulty: 0.1, id: 'level-2' } }] },
      { calls: [{ name: 'read', input: { path: 'game.json' } }] },
      { calls: [write('game.json', game({ levels: ['asset:level-1', 'asset:level-2'] }))] },
      { calls: [{ name: 'game_bot', input: { mode: 'goal', seconds: 300 } }] },
      { text: 'Two levels; the bot finishes both.' },
    ],
    ui: [{ calls: [{ name: 'read', input: { path: 'game.json' } }] }, { calls: [write('game.json', game({ levels: ['asset:level-1', 'asset:level-2'], help: 'Arrows move - Space jumps - take every coin, then the flag' }))] }, { text: 'Title help and HUD set.' }],
    polish: [{ calls: [{ name: 'game_playtest', input: { goal, checks, bots: [{ mode: 'goal', seconds: 300 }] } }] }, { text: 'Polished; the playtest passes.' }],
    build: [{ calls: [{ name: 'studio_template', input: { action: 'build' } }] }, (r) => ({ text: r.at(-1)!.split('\n')[0] })],
    'full-playtest': [
      { calls: [{ name: 'game_play', input: { action: 'start', game: 'build/web/index.html', query: '?autostart=1' } }] },
      (r) => { session = /Play session (\S+) started/.exec(r.at(-1) ?? '')?.[1] ?? ''; return { calls: [{ name: 'game_play', input: { action: 'step', session, inputs: [{ key: 'ArrowRight', ms: 400 }], ms: 400 } }] }; },
      () => ({ calls: [{ name: 'game_play', input: { action: 'verdict', session, claim: 'the HUD shows the coins and the fox is on screen', pass: true } }] }),
      () => ({ calls: [{ name: 'game_play', input: { action: 'stop', session, note: 'a newcomer starts moving at once' } }] }),
      () => ({ calls: [{ name: 'game_playtest', input: { game: 'build/web/index.html', goal, checks, bots: [{ mode: 'goal', seconds: 300 }], sessions: [session] } }] }),
      { calls: [write('docs/playtest-report.md', '# Playtest report\n\nThe build plays; bots and the AI player reached the goal. No findings.\n')] },
      { text: 'No blocking or major findings.\nAPPROVE' },
    ],
    report: [{ calls: [write('docs/studio-report.md', '# Rooftop Fox\n\nA two-level web platformer, built in build/web.\n')] }, { text: 'Rooftop Fox is a two-level web platformer; the build is build/web/index.html.' }],
  };
  const fake = new StageProvider(scripts);
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'visual', 'engine-godot', 'engine-blender'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', fake);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('make-game', { brief: 'A 2D platformer about a fox thief who takes every coin on the rooftops and escapes by the exit flag.', engine: 'web', dimension: '2d', genre: 'platformer', approval: 'auto' });
    await done;
    const [run] = await s.listRuns();
    const t = trail(run!);
    console.log(t.join(' '));
    assert.equal(run!.status, 'succeeded', `${run!.error ?? ''}\n${t.join('\n')}\n${run!.history.filter((x) => x.type === 'gate').map((x) => x.summary).join('\n')}`);
    // The parallel asset branches finish in either order.
    for (const x of ['make-art:done', 'make-audio:done', 'assets:all']) assert.ok(t.includes(x), x);
    assert.deepEqual(t.filter((x) => !/^(make-art|make-audio|assets):/.test(x)), [
      'plan:done', 'engine-supported:web', 'concept:done', 'concept-gates:pass', 'approve-concept-mode:auto', 'art:done', 'approve-art-mode:auto',
      'asset-gates:pass',
      'prototype:done', 'prototype-check:web', 'prototype-gates-web:fail', 'prototype-fix:done', 'prototype-check:web', 'prototype-gates-web:pass',
      'playtest:APPROVE', 'playtest-gates:pass',
      'slice:done', 'slice-check:web', 'slice-gates-web:pass', 'approve-slice-mode:auto',
      'levels:done', 'ui:done', 'ui-check:web', 'ui-gates-web:pass',
      'polish:done', 'polish-check:web', 'polish-gates-web:pass',
      'build:done', 'build-check:web', 'build-gates-web:pass',
      'final:APPROVE', 'final-gates:pass', 'approve-ship-mode:auto', 'report:done', 'done:done',
    ]);
    // The evidence went back to the fixer.
    const fixBrief = fake.briefs.get('prototype-fix')![0]!;
    assert.match(fixBrief, /asset:boss-sheet: no \.studio\/assets\/boss-sheet\/asset\.json/);
    // Each gate passed for the right reasons.
    const summary = (node: string) => run!.history.filter((x) => x.node === node).at(-1)!.summary!;
    assert.match(summary('asset-gates'), /PASS asset-plan: all 6 planned asset\(s\) made/);
    assert.match(summary('asset-gates'), /PASS level-playable/);
    assert.match(summary('prototype-gates-web'), /PASS game-starts[\s\S]*PASS no-softlock/);
    assert.match(summary('polish-gates-web'), /PASS playtest-pass: playtest pt-\d+-\d+ passes: goal reached by bot:goal/);
    assert.match(summary('build-gates-web'), /PASS web-build: build\/web boots offline/);
    assert.match(summary('final-gates'), /PASS playtest-pass[\s\S]*PASS playtest-regressions/);
    // The project: the made assets were kept by the template; the build and the playtests recorded.
    const project = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'project.json'), 'utf8'));
    assert.equal(project.template, 'platformer-2d');
    assert.equal(project.builds.length, 1);
    assert.ok(project.playtests.length >= 3, project.playtests.join(', '));
    const hero = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'assets', 'hero-sheet', 'asset.json'), 'utf8'));
    assert.equal(hero.source.seed, 7, 'the art plan\'s hero, not the template\'s');
    const last = JSON.parse(await fs.readFile(path.join(ws, '.studio', 'playtests', project.playtests.at(-1), 'report.json'), 'utf8'));
    assert.equal(last.result, 'pass');
    assert.ok(last.players.includes('ai') && last.players.includes('bot:goal'), last.players.join(', '));
    assert.ok(last.events.some((e: { type: string; detail: string }) => e.type === 'level' && /level 2 of 2/.test(e.detail)), 'the bots played both levels');
    // The engine went into every engine-specific brief.
    assert.match(fake.briefs.get('prototype')![0]!, /in web \(dimension 2d\)/);
  } finally { await h.close(); }
});

test('make-game, Unreal 3D: the route through the Unreal gates, Blender assets in the plan, and the Unreal briefs (the engine\'s gates faked)', { timeout: 300_000 }, async () => {
  const ws = await tempDir('studio-make-game-ue-');
  const ran: string[] = [];
  const scripts: Record<string, Script> = {
    plan: [{ calls: [write('.studio/project.json', PLAN('unreal', '3d')), write('design/production-plan.md', '# Plan\n\nUnreal third-person collect-and-escape; Blender props.\n')] }, { text: 'Planned.' }],
    concept: [{ calls: [write('design/GDD.md', GDD('Coin Escape', 'unreal'))] }, { text: 'GDD written.' }],
    art: [{ calls: [write('design/style-guide.md', '# Style\n\nStylized low-poly, metres, 5k triangles per prop.\n'), write('design/asset-plan.json', JSON.stringify({ assets: [{ id: 'coin-model', kind: 'model', tool: 'studio_model', input: { action: 'build', generator: 'coin', fbx: true }, purpose: 'collectible' }, { id: 'sfx-coin', kind: 'audio', tool: 'studio_audio', input: { action: 'sfx', preset: 'pickup' }, purpose: 'coin' }] }))] }, { text: 'Planned the Blender coin.' }],
    // Blender is not needed here: the model asset is written as the builder would, from a tiny glTF.
    assets: [{ calls: [{ name: 'studio_library', input: { action: 'import', files: ['models/coin.glb'], kind: 'model', id: 'coin-model', license: { id: 'CC0-1.0', author: 'test' } } }] }, { text: 'Made coin-model.' }],
    audio: [{ calls: [{ name: 'studio_audio', input: { action: 'sfx', preset: 'pickup', id: 'sfx-coin' } }] }, { text: 'Made sfx-coin.' }],
    playtest: [{ text: 'APPROVE' }],
    'full-playtest': [{ text: 'APPROVE' }],
  };
  const fake = new StageProvider(scripts);
  await fs.mkdir(path.join(ws, 'models'), { recursive: true });
  await fs.writeFile(path.join(ws, 'models', 'coin.glb'), quadGlb());
  const h = await createHarness({ dataDir: await tempDir(), plugins: ['games3d', 'visual', 'engine-unreal', 'engine-blender'].map((p) => path.join(here, '..', 'plugins', p)), search: null, memory: 'off' });
  h.registry.setProviderInstance('deepseek', fake);
  // The Unreal gates and the player's gates need Unreal and a packaged game: recording fakes here.
  for (const name of ['unreal-project', 'unreal-automation', 'unreal-package', 'playtest-pass', 'playtest-regressions']) {
    h.registry.gates.set(name, { name, plugin: 'test', description: 'fake', async run() { ran.push(name); return { pass: true, summary: `${name} (fake) passes` }; } });
  }
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('make-game', { brief: 'A third-person collect-and-escape game in Unreal: ten coins, then the exit door.', engine: 'unreal', dimension: '3d', approval: 'auto' });
    await done;
    const [run] = await s.listRuns();
    const t = trail(run!);
    assert.equal(run!.status, 'succeeded', `${t.join(' ')}\n${JSON.stringify([...fake.results]).slice(0, 3000)}\n${run!.history.filter((x) => x.type === 'gate').map((x) => x.summary).join('\n')}`);
    for (const g of ['prototype-gates-unreal:pass', 'slice-gates-unreal:pass', 'ui-gates-unreal:pass', 'polish-gates-unreal:pass', 'build-gates-unreal:pass']) assert.ok(t.includes(g), g);
    assert.ok(!t.some((x) => /gates-(web|godot)/.test(x)), 'only the Unreal checks');
    assert.ok(ran.includes('unreal-package') && ran.includes('unreal-automation'));
    // The real asset gates judged the Blender model and the sound.
    assert.match(run!.history.find((x) => x.node === 'asset-gates')!.summary!, /PASS asset-3d: 1 model asset\(s\) pass/);
    // The engineers were briefed for Unreal, with Blender models through asset.import.
    assert.match(fake.briefs.get('prototype')![0]!, /in unreal \(dimension 3d\)[\s\S]*unreal project\.create/);
    assert.match(fake.briefs.get('vertical-slice')![0]!, /unreal asset\.import/);
    assert.match(fake.briefs.get('build')![0]!, /unreal package for Win64/);
    // Unity is not covered yet.
    const s2 = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const done2 = new Promise<void>((r) => s2.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s2.startWorkflow('make-game', { brief: 'A Unity game', engine: 'unity', approval: 'auto' });
    await done2;
    const [r2] = await s2.listRuns();
    assert.deepEqual(trail(r2!), ['plan:done', 'engine-supported:unity', 'not-yet:done']);
  } finally { await h.close(); }
});
