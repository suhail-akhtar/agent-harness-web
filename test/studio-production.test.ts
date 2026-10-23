// Studio's production layer without a browser or an engine: the workflows (make-game and the
// other production graphs) validate and name only registered gates and agents, the agents name
// real tools, FORMATS.md's examples parse, the production gates (studio-project, asset-plan,
// web-game) judge workspaces, and the zip writer and the template list hold together.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runGates } from '../src/gates/gates.ts';
import type { WorkflowDef } from '../src/graph/types.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const G3 = path.join(here, '..', 'plugins', 'games3d');
// @ts-expect-error plain JS module
const { listTemplates, assetRefs } = await import('../plugins/games3d/templates/index.mjs');
// @ts-expect-error plain JS module
const { headings, projectProblems, levelFinishable } = await import('../plugins/games3d/templates/gates.mjs');
// @ts-expect-error plain JS module
const { writeZip, zipNames } = await import('../plugins/games3d/templates/zip.mjs');

const PLUGINS = ['games3d', 'visual', 'engine-blender', 'engine-godot', 'engine-unreal'].map((p) => path.join(here, '..', 'plugins', p));
const harness = async () => createHarness({ dataDir: await tempDir(), plugins: PLUGINS, search: null, memory: 'off' });
const workflow = async (name: string) => JSON.parse(await fs.readFile(path.join(G3, 'workflows', `${name}.json`), 'utf8')) as WorkflowDef;
const NEW = ['make-game', 'asset-pack', 'level-blockout', 'render-shot', 'port-game', 'playtest-loop'];
const ctxOf = (root: string) => ({ host: new LocalHost(root), signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, beforeWrite: async () => {} }) as unknown as ToolContext;

test('production workflows: every graph validates, loads, and names only gates and agents that exist', async () => {
  const h = await harness();
  try {
    for (const name of [...NEW, 'build-game', 'model-3d']) {
      const w = await workflow(name);
      assert.deepEqual(validateWorkflow(w), [], name);
      assert.ok(h.registry.workflows.has(name), `${name} loads`);
      for (const [id, n] of Object.entries(w.nodes)) {
        if (n.type === 'gate' && Array.isArray(n.gates)) for (const g of n.gates) assert.ok(h.registry.gates.has(g), `${name}.${id}: gate ${g} is registered`);
        if (n.type === 'agent' && n.agent) assert.ok(h.registry.agents.has(n.agent), `${name}.${id}: agent ${n.agent} exists`);
      }
    }
  } finally { await h.close(); }
});

test('make-game: inputs, stages in order, a gate per engine at every engine stage, attempt limits, checkpoints, Unity not yet', async () => {
  const w = await workflow('make-game');
  assert.deepEqual(Object.keys(w.inputs!), ['brief', 'engine', 'dimension', 'genre', 'budget', 'sources', 'approval']);
  assert.equal(w.inputs!.brief!.required, true);
  assert.equal(w.inputs!.engine!.default, 'web');
  const n = w.nodes as Record<string, { type: string; gates?: string[]; next?: unknown; maxFailures?: number; agent?: string; branches?: string[] }>;
  // The happy path, stage by stage.
  const path_: string[] = [];
  let at = w.start;
  const pick = (id: string): string | undefined => {
    const x = n[id]!;
    const nx = x.next as string | { on: Record<string, string>; default?: string } | undefined;
    if (!nx) return undefined;
    if (typeof nx === 'string') return nx;
    return nx.on.pass ?? nx.on.approve ?? nx.on.auto ?? nx.on.web ?? nx.on.false ?? nx.default;
  };
  for (let i = 0; i < 60 && at; i++) { path_.push(at); at = pick(at)!; }
  const stages = path_.filter((id) => n[id]!.type === 'agent' || n[id]!.type === 'parallel');
  assert.deepEqual(stages, ['plan', 'concept', 'art', 'assets', 'prototype', 'playtest', 'slice', 'levels', 'ui', 'polish', 'build', 'final', 'report']);
  assert.equal(path_.at(-1), 'done');
  for (const stage of ['prototype', 'slice', 'ui', 'polish', 'build']) {
    for (const e of ['web', 'godot', 'unreal']) {
      const g = n[`${stage}-gates-${e}`]!;
      assert.equal(g.type, 'gate', `${stage} ${e}`);
      assert.ok(g.maxFailures! >= 1 && g.maxFailures! <= 3);
      assert.deepEqual(g.next, { on: { pass: pick(`${stage}-gates-${e}`), fail: `${stage}-fix`, exhausted: 'failed' } });
    }
  }
  assert.deepEqual(n['build-gates-web']!.gates, ['web-build']);
  assert.deepEqual(n['build-gates-godot']!.gates, ['godot-export']);
  assert.deepEqual(n['build-gates-unreal']!.gates, ['unreal-package']);
  assert.ok(n['prototype-gates-godot']!.gates!.includes('no-softlock'), 'the bots play Godot through its driver');
  assert.deepEqual(n['asset-gates']!.gates, ['asset-plan', 'asset-manifest', 'asset-budget', 'asset-2d', 'asset-3d', 'audio-valid', 'level-playable']);
  assert.deepEqual(n.assets!.branches, ['make-art', 'make-audio']);
  for (const c of ['approve-concept', 'approve-art', 'approve-slice', 'approve-ship']) assert.equal(n[c]!.type, 'approval', c);
  assert.equal((n['engine-supported']!.next as { on: Record<string, string> }).on.unity, 'not-yet');
  assert.equal(n['not-yet']!.type, 'end');
});

test('agents: the production team exists, and every tool an agent names is a real one', async () => {
  const h = await harness();
  try {
    const team = ['producer', 'game-designer', 'art-director', 'technical-artist', '3d-artist', 'animator', 'level-designer', 'game-engineer', 'audio-designer', 'ui-designer', 'build-engineer', 'playtester', 'ai-player', 'qa-lead', 'vision-judge'];
    const session = new Set(['skill', 'quality_gates', 'agent']);
    for (const name of team) {
      const a = h.registry.agents.get(name);
      assert.ok(a, name);
      assert.ok(a!.prompt.length > 400 || name === 'vision-judge', `${name} has a real prompt`);
      for (const t of a!.tools ?? []) assert.ok(h.registry.tools.has(t) || session.has(t), `${name}: tool ${t}`);
    }
    // They know their exact actions.
    assert.match(h.registry.agents.get('build-engineer')!.prompt, /studio_template \{"action": "build"\}[\s\S]*godot build[\s\S]*unreal package/);
    assert.match(h.registry.agents.get('technical-artist')!.prompt, /studio_sprite[\s\S]*studio_procgen[\s\S]*studio_model/);
    assert.match(h.registry.agents.get('level-designer')!.prompt, /solver/);
  } finally { await h.close(); }
});

test('FORMATS.md: every JSON example parses once its comments are taken out', async () => {
  const md = await fs.readFile(path.join(G3, 'sdk', 'FORMATS.md'), 'utf8');
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.ok(blocks.length >= 7, `${blocks.length} examples`);
  for (const b of blocks) {
    const text = b.split('\n').map((l) => l.replace(/\s+\/\/ .*$/, '')).filter((l) => !/^\s*\/\//.test(l)).join('\n');
    assert.doesNotThrow(() => JSON.parse(text), text.slice(0, 200));
  }
  // The fields the merged parts added are documented.
  for (const f of ['directionNames', 'cellMetres', 'elevation', 'columns', 'background', 'particles', 'icon', 'pack', 'regressions', '"steps"', '"expect"', 'game.json', 'asset-plan.json']) assert.ok(md.includes(f), f);
  const project = JSON.parse(blocks[0]!.split('\n').map((l) => l.replace(/\s+\/\/ .*$/, '')).join('\n'));
  assert.deepEqual(projectProblems(project), []);
});

test('the production gates: studio-project wants a sound project.json and a GDD with its sections; asset-plan wants every planned asset; web-game resolves game.json', async () => {
  const h = await harness();
  const root = await tempDir('studio-prod-gates-');
  const host = new LocalHost(root);
  const gate = async (name: string) => (await runGates(h.registry, host, [name], new AbortController().signal))[0]!;
  try {
    await fs.mkdir(path.join(root, '.studio'), { recursive: true });
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'X', engine: 'web', dimension: '4d' }));
    let g = await gate('studio-project');
    assert.equal(g.pass, false);
    assert.match(g.details!, /dimension: one of 2d, 2.5d, 3d/);
    assert.match(g.details!, /design\/GDD.md is missing/);
    await fs.writeFile(path.join(root, '.studio', 'project.json'), JSON.stringify({ name: 'X', engine: 'web', dimension: '2d', stages: [{ id: 'plan', status: 'done' }] }));
    await fs.mkdir(path.join(root, 'design'));
    await fs.writeFile(path.join(root, 'design', 'GDD.md'), '# X\n\n## Pitch\nA fox.\n\n## Controls\nArrows.\n');
    g = await gate('studio-project');
    assert.match(g.details!, /no "Core loop" section/);
    assert.match(g.details!, /no "Scope" section/);
    const gdd = ['# X', '## Pitch', 'A fox thief hops rooftops.', '## Core loop', 'Run, jump, grab coins; clear a level; three levels.', '## Controls', 'Arrows move, Space jumps.', '## Rules (win and lose)', 'Every coin then the exit wins; unlimited retries.', '## Levels', 'Three platformer levels.', '## Balancing', 'jumpHeight 3.2 tiles.', '## Scope', 'One level type now; bosses later.'].join('\n\n');
    await fs.writeFile(path.join(root, 'design', 'GDD.md'), `${gdd}\n${'Detail. '.repeat(30)}\n`);
    g = await gate('studio-project');
    assert.equal(g.pass, true, g.details ?? g.summary);
    assert.match(g.summary, /advised, missing: Mechanics, Art direction, Audio, UI/);
    assert.deepEqual(headings('# A\n## B ##\ntext\n### C'), ['A', 'B', 'C']);

    await fs.writeFile(path.join(root, 'design', 'asset-plan.json'), JSON.stringify({ assets: [{ id: 'coin', kind: 'spritesheet', tool: 'studio_sprite', input: { action: 'sheet', kind: 'coin' } }, { id: 'lvl', kind: 'level' }] }));
    g = await gate('asset-plan');
    assert.equal(g.pass, false);
    assert.match(g.details!, /coin: not made yet/);
    const sprite = h.registry.tools.get('studio_sprite')!;
    await sprite.run({ action: 'sheet', kind: 'coin', id: 'coin' }, ctxOf(root));
    await sprite.run({ action: 'sprite', kind: 'gem', id: 'lvl' }, ctxOf(root));
    g = await gate('asset-plan');
    assert.match(g.details!, /lvl: planned as level, made as sprite/);
    await h.registry.tools.get('studio_procgen')!.run({ action: 'maze', id: 'lvl', cols: 4, rows: 3 }, ctxOf(root));
    g = await gate('asset-plan');
    assert.equal(g.pass, true, g.details ?? g.summary);

    await fs.writeFile(path.join(root, 'index.html'), '<canvas id="game"></canvas><script type="module" src="src/main.js"></script>');
    await fs.writeFile(path.join(root, 'game.json'), JSON.stringify({ assets: { coin: 'asset:coin', hero: 'asset:nope' }, levels: ['asset:lvl'] }));
    g = await gate('web-game');
    assert.equal(g.pass, false);
    assert.match(g.details!, /asset:nope: no \.studio\/assets\/nope\/asset\.json/);
    assert.match(g.details!, /src\/main.js is missing/);
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'main.js'), '');
    await fs.writeFile(path.join(root, 'game.json'), JSON.stringify({ assets: { coin: 'asset:coin' }, levels: ['asset:lvl'] }));
    g = await gate('web-game');
    assert.equal(g.pass, true, g.details ?? g.summary);
    assert.match(g.summary, /asset:lvl: start to exit in \d+ steps/);
    // A level the solver cannot finish fails it.
    assert.equal(levelFinishable({ type: 'platformer', rows: ['......', 'S....E', '##..##'] }).ok, true);
    assert.equal(levelFinishable({ type: 'platformer', rows: ['...........', 'S.........E', '##.......##'] }).ok, false, 'a 7-tile gap is past the 4.8-tile jump');
    assert.deepEqual([...assetRefs({ a: 'asset:x', b: ['asset:y', { c: 'asset:x' }], d: 'path.png' })], ['x', 'y']);
  } finally { await h.close(); }
});

test('tool inputs with union types (Studio\'s seed: number or string, license: string or object) pass the input check', async () => {
  const { validateInput } = await import('../src/tools/index.ts');
  const spec = { name: 't', description: '', input_schema: { type: 'object' as const, properties: { seed: { type: ['number', 'string'] }, license: { type: ['string', 'object'] }, n: { type: 'number' } }, required: [] } };
  assert.equal(validateInput(spec as never, { seed: 7, license: { id: 'CC0-1.0' } }), undefined);
  assert.equal(validateInput(spec as never, { seed: 'abc', license: 'CC0-1.0' }), undefined);
  assert.equal(validateInput(spec as never, { license: true }), 'parameter "license" must be a string or object');
  assert.equal(validateInput(spec as never, { n: 'x' }), 'parameter "n" must be a number');
});

test('the template list and the zip writer', async () => {
  const list = await listTemplates();
  assert.deepEqual(list.map((t: { id: string }) => t.id), ['platformer-2d', 'topdown-2d', 'puzzle-2d', 'iso-2.5d', 'sidescroller-2.5d', 'thirdperson-3d', 'firstperson-3d']);
  for (const t of list) {
    assert.ok(['2d', '2.5d', '3d'].includes(t.dimension), t.id);
    assert.equal(t.three, t.id.includes('3d') || t.id === 'sidescroller-2.5d', t.id);
    const cfg = JSON.parse(await fs.readFile(path.join(G3, 'templates', 'web', t.id, 'game.json'), 'utf8'));
    // Every asset game.json names is one the template builds.
    for (const id of assetRefs(cfg)) assert.ok(t.assets.some((a: { id: string }) => a.id === id), `${t.id}: ${id} is built by the template`);
  }
  const dir = await tempDir();
  const z = await writeZip(path.join(dir, 'a.zip'), [{ name: 'index.html', data: Buffer.from('<p>hi</p>'.repeat(50)) }, { name: 'src/main.js', data: Buffer.from('x') }]);
  assert.ok(z.bytes > 100);
  assert.deepEqual(await zipNames(path.join(dir, 'a.zip')), ['index.html', 'src/main.js']);
});
