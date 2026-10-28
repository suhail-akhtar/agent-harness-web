// The efficiency package: deferred plugin tool schemas, spilled tool output, batched masking,
// cache-miss attribution and the 1-hour prefix TTL on Anthropic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { attributeMiss, cacheShape, firstChange } from '../src/core/cache.ts';
import { getModel, costOf } from '../src/core/models.ts';
import { defaultEfficiency, defaultPromptCaching, operatorSettings } from '../src/core/settings.ts';
import type { Message, Usage } from '../src/core/types.ts';
import { addUsage } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { anthropicBody, fromAnthropic } from '../src/providers/anthropic.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { report, type EvalRun } from '../src/eval/runner.ts';
import { LOAD_TOOLS, groupSummary, loadedGroups, pluginGroups, sentSpecs, type ToolGroup } from '../src/tools/deferred.ts';
import { BUILTIN_TOOLS } from '../src/tools/index.ts';
import { readTool } from '../src/tools/files.ts';
import { bashTool } from '../src/tools/exec.ts';
import { excerpt, SpillStore, spillPathIn } from '../src/tools/spill.ts';
import type { Tool } from '../src/tools/types.ts';
import { clipOrSpill } from '../src/tools/types.ts';
import { Redactor } from '../src/vault/redact.ts';
import { FakeProvider, makeAgent, results, tempDir } from './helpers.ts';
import { shippedPluginDirs } from '../src/plugins/shipped.ts';

const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

/** A plugin-like tool with a schema large enough to be worth deferring. */
const bigTool = (name: string, out = `${name} ran`): Tool => ({
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: { name, description: `${name}: ${'does a rare and specialised thing. '.repeat(60)}`, input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
  summarize: () => name,
  run: async () => ({ content: out }),
});

const names = (specs: { name: string }[]) => specs.map((s) => s.name);

// ---------- 1. Deferred plugin tool schemas ----------

test('deferral: one group per plugin, core tools inline, small groups inline, defer flags respected', () => {
  const core = BUILTIN_TOOLS.find((t) => t.spec.name === 'read')!;
  const a = bigTool('studio_one'); const b = bigTool('studio_two'); const tiny = { ...bigTool('cite'), spec: { name: 'cite', description: 'small', input_schema: { type: 'object' as const, properties: {} } } };
  const kept = { ...bigTool('ops_main'), defer: false };
  const rare = { ...bigTool('core_rare'), defer: true };
  const owner = new Map<Tool, string>([[a, 'games3d'], [b, 'games3d'], [tiny, 'research'], [kept, 'ops']]);
  const groups = pluginGroups([core, a, b, tiny, kept, rare], (t) => owner.get(t), (p) => (p === 'games3d' ? 'Browser games and 3D models: design, build, play-test. More text here.' : undefined));
  assert.deepEqual(groups.map((g) => [g.id, g.tools]), [['core', ['core_rare']], ['games3d', ['studio_one', 'studio_two']]]);
  assert.equal(groups.find((g) => g.id === 'games3d')!.summary, 'Browser games and 3D models: design, build, play-test.');
  assert.equal(groupSummary('Blender for Studio: the blender tool (bpy scripts headless; renders and checks; one more clause that makes this long enough to cut somewhere sensible).', 'x'), 'Blender for Studio: the blender tool.');
});

test('deferral: the tool list is byte-stable until a group loads, then stays loaded; load_tools lists what waits', () => {
  const specs = [...BUILTIN_TOOLS.map((t) => t.spec), bigTool('studio_one').spec, bigTool('ops_apply').spec].sort((x, y) => (x.name < y.name ? -1 : 1));
  const groups: ToolGroup[] = [{ id: 'games3d', summary: 'Games.', tools: ['studio_one'] }, { id: 'devops', summary: 'DevOps.', tools: ['ops_apply'] }];
  const none = sentSpecs(specs, groups, new Set());
  assert.equal(JSON.stringify(none), JSON.stringify(sentSpecs(specs, groups, new Set())), 'the same loaded set renders the same bytes');
  assert.ok(!names(none).includes('studio_one') && names(none).includes(LOAD_TOOLS));
  const lt = none.find((s) => s.name === LOAD_TOOLS)!;
  assert.match(lt.description, /- games3d: Games\. Tools: studio_one/);
  assert.match(lt.description, /- devops: DevOps\. Tools: ops_apply/);
  const one = sentSpecs(specs, groups, new Set(['games3d']));
  assert.ok(names(one).includes('studio_one') && !names(one).includes('ops_apply'));
  assert.doesNotMatch(one.find((s) => s.name === LOAD_TOOLS)!.description, /games3d/);
  const all = sentSpecs(specs, groups, new Set(['games3d', 'devops']));
  assert.ok(!names(all).includes(LOAD_TOOLS), 'nothing left to load: no load_tools');
  assert.deepEqual(names(all), names(specs));
});

test('deferral: loads are read from the history - load_tools, a call by name, a plugin guide or skill; a failed load loads nothing', () => {
  const groups: ToolGroup[] = [{ id: 'games3d', summary: 'g', tools: ['studio_one'] }, { id: 'devops', summary: 'd', tools: ['ops_apply'] }, { id: 'visual', summary: 'v', tools: ['render'] }, { id: 'x', summary: 'x', tools: ['x_tool'] }, { id: 'iac', summary: 'i', tools: ['iac'], skills: ['terraform-practices'] }, { id: 'y', summary: 'y', tools: ['y_tool'], skills: ['y-howto'] }];
  const msgs: Message[] = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: LOAD_TOOLS, input: { groups: ['games3d'] } }, { type: 'tool_use', id: 'b', name: 'ops_apply', input: {} }, { type: 'tool_use', id: 'c', name: 'skill', input: { name: 'visual-guide' } }, { type: 'tool_use', id: 'd', name: LOAD_TOOLS, input: { groups: ['x'] } }, { type: 'tool_use', id: 'e', name: 'skill', input: { name: 'terraform-practices' } }, { type: 'tool_use', id: 'f', name: 'skill', input: { name: 'y-howto' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Loaded' }, { type: 'tool_result', tool_use_id: 'b', content: 'ok' }, { type: 'tool_result', tool_use_id: 'c', content: 'guide' }, { type: 'tool_result', tool_use_id: 'd', content: 'x is switched off', is_error: true }, { type: 'tool_result', tool_use_id: 'e', content: 'practices' }, { type: 'tool_result', tool_use_id: 'f', content: 'off', is_error: true }] },
  ];
  assert.deepEqual([...loadedGroups(msgs, groups)].sort(), ['devops', 'games3d', 'iac', 'visual']);
});

test('deferral in the loop: load_tools adds the schemas from the next request on, every later request is the same, a compaction keeps them', async () => {
  const studio = bigTool('studio_one', 'made a level');
  const groups: ToolGroup[] = [{ id: 'games3d', summary: 'Games.', tools: ['studio_one'] }];
  const h = await makeAgent([
    { text: 'first' },
    { calls: [{ name: LOAD_TOOLS, input: { groups: ['games3d'] } }] },
    { calls: [{ name: 'studio_one', input: {} }] },
    { text: 'done' },
  ], { tools: [...BUILTIN_TOOLS, studio], config: { toolGroups: groups } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  await h.agent.run(new AbortController().signal);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'make a level' }] });
  await h.agent.run(new AbortController().signal);
  const r = h.provider.requests;
  assert.equal(JSON.stringify(r[0]!.tools), JSON.stringify(r[1]!.tools), 'byte-stable across turns before a load');
  assert.ok(!names(r[1]!.tools).includes('studio_one'));
  assert.ok(names(r[2]!.tools).includes('studio_one'), 'loaded from the next request');
  assert.equal(JSON.stringify(r[2]!.tools), JSON.stringify(r[3]!.tools), 'byte-stable after the load');
  assert.equal(results(h.agent.messages.at(-2))[0]!.content, 'made a level');
  // A compaction replaces the context; the load sticks.
  await h.agent.compact(new AbortController().signal);
  assert.ok(names(h.agent.toolSpecs()).includes('studio_one'));
  assert.deepEqual(h.agent.loadedToolGroups(), ['games3d']);
});

test('deferral: a model that calls a deferred tool by its own name is served, and its group loads', async () => {
  const studio = bigTool('studio_one', 'made it');
  const h = await makeAgent([{ calls: [{ name: 'studio_one', input: { x: 'y' } }] }, { text: 'ok' }], { tools: [...BUILTIN_TOOLS, studio], config: { toolGroups: [{ id: 'games3d', summary: 'g', tools: ['studio_one'] }] } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  assert.equal(results(h.agent.messages[2])[0]!.content, 'made it');
  assert.ok(!names(h.provider.requests[0]!.tools).includes('studio_one'));
  assert.ok(names(h.provider.requests[1]!.tools).includes('studio_one'));
});

test('deferral in a session with bundled plugins: plugin tools wait behind load_tools, a load reaches the next request, the history keeps it after a restart', async () => {
  const data = await tempDir();
  const plugins = shippedPluginDirs(path.resolve('.'));
  const fake = new FakeProvider([{ calls: [{ name: LOAD_TOOLS, input: { groups: ['visual'] } }] }, { text: 'loaded' }]);
  const h = await createHarness({ dataDir: data, plugins, shippedPlugins: plugins, backgroundWork: false, scheduler: false, search: null });
  try {
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'claude-haiku-5-5', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const before = await s.sentToolSpecs();
    assert.ok(before.all.some((t) => t.name === 'render') && !before.sent.some((t) => t.name === 'render'));
    assert.ok(before.groups.some((g) => g.id === 'devops'), 'devops is a group');
    assert.ok(before.sent.length < before.all.length);
    await s.send('render my page');
    await until(() => h.sessions.statusOf(s.meta.id) === 'idle' && fake.requests.length >= 2);
    assert.ok(!names(fake.requests[0]!.tools).includes('render'));
    assert.ok(names(fake.requests[1]!.tools).includes('render'));
    // Derived from the stored history: the same answer after the session is read back.
    assert.ok((await s.sentToolSpecs()).sent.some((t) => t.name === 'render'));
  } finally { await h.close(); }
});

test('deferral and the plugin-off rule: a loaded group stays listed and answers why; loading a switched-off group is refused and loads nothing', async () => {
  const data = await tempDir();
  const root = await tempDir();
  const dir = path.join(root, 'widgets');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'widgets', version: '1.0.0', description: 'Widget Works: makes widgets.', main: 'index.mjs', ui: { apiVersion: 1, displayName: 'Widget Works' } }));
  const desc = JSON.stringify(`Counts the widgets. ${'Widgets are rare. '.repeat(120)}`);
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: 'widgets', setup(api) {
    api.registerTool({ name: 'widget_count', description: ${desc}, kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => 'there are 7 widgets' });
    api.registerTool({ name: 'widget_paint', description: ${desc}, kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => 'painted' });
  } };\n`);
  const fake = new FakeProvider([
    { calls: [{ name: LOAD_TOOLS, input: { groups: ['widgets'] } }] }, { calls: [{ name: 'widget_count' }] }, { text: 'seven' },
    { calls: [{ name: 'widget_count' }] }, { text: 'it is off' },
  ]);
  const h = await createHarness({ dataDir: data, plugins: [root], backgroundWork: false, scheduler: false, search: null });
  try {
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'claude-haiku-5-5', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    await s.send('count');
    await until(() => h.sessions.statusOf(s.meta.id) === 'idle' && fake.requests.length >= 3);
    const tr = s.history.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')) as { content: string; is_error?: boolean }[];
    assert.match(tr[0]!.content, /Loaded; callable from your next step:\nwidgets: widget_count, widget_paint/);
    assert.equal(tr[1]!.content, 'there are 7 widgets');
    const loadedList = JSON.stringify(fake.requests[2]!.tools);
    await h.plugins.setEnabled('widgets', false);
    await s.send('again');
    await until(() => h.sessions.statusOf(s.meta.id) === 'idle' && fake.requests.length >= 5);
    const off = s.history.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')).at(-1) as { content: string; is_error?: boolean };
    assert.match(off.content, /Widget Works is switched off on this server/);
    assert.equal(off.is_error, true);
    assert.equal(JSON.stringify(fake.requests.at(-1)!.tools), loadedList, 'the cached tool list is unchanged by switching off');

    // A second session, the plugin off from its start: the plugin's tools are not in it at all.
    const s2 = await h.sessions.create({ model: 'claude-haiku-5-5', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    assert.ok(!(await s2.sentToolSpecs()).all.some((t) => t.name === 'widget_count'));
  } finally { await h.close(); }

  // Loading a group whose plugin is off at the time: refused, nothing loads.
  const groups: ToolGroup[] = [{ id: 'widgets', summary: 'w', tools: ['widget_count'] }];
  const hb = await makeAgent([{ calls: [{ name: LOAD_TOOLS, input: { groups: ['widgets'] } }] }, { text: 'ok' }], { tools: [...BUILTIN_TOOLS, bigTool('widget_count')], config: { toolGroups: groups } });
  // The registry's off rule, simulated: a group whose tools answer "switched off".
  (hb.agent as unknown as { loadTool: Tool }).loadTool = (await import('../src/tools/deferred.ts')).makeLoadTools(() => groups, () => 'Widget Works is switched off on this server; switch it on to use the widgets tools.');
  hb.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await hb.agent.run(new AbortController().signal);
  assert.equal(results(hb.agent.messages[2])[0]!.is_error, true);
  assert.ok(!names(hb.provider.requests[1]!.tools).includes('widget_count'), 'a refused load loads nothing');
});

test('deferral: a plugin\'s workflow runs its agents with that plugin\'s tools from the start; other plugins\' still wait', async () => {
  const data = await tempDir();
  const root = await tempDir();
  const desc = (what: string) => JSON.stringify(`${what}. ${'Rarely needed detail. '.repeat(120)}`);
  for (const [name, tool] of [['widgets', 'widget_count'], ['gadgets', 'gadget_spin']] as const) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `${name}.`, main: 'index.mjs' }));
    const flow = name === 'widgets' ? `api.registerWorkflow({ name: 'widget-flow', description: 'Counts widgets', start: 'count', nodes: { count: { type: 'agent', prompt: 'count them', next: 'done' }, done: { type: 'end' } } });` : '';
    await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: '${name}', setup(api) { api.registerTool({ name: '${tool}', description: ${desc(tool)}, kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => 'ok' }); ${flow} } };\n`);
  }
  const fake = new FakeProvider([{ text: 'counted' }]);
  const h = await createHarness({ dataDir: data, plugins: [root], backgroundWork: false, scheduler: false, search: null });
  try {
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'claude-haiku-5-5', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.startWorkflow('widget-flow', {});
    await ended;
    const sent = names(fake.requests[0]!.tools);
    assert.ok(sent.includes('widget_count'), 'its own plugin\'s tool, without a load');
    assert.ok(!sent.includes('gadget_spin') && sent.includes(LOAD_TOOLS), 'another plugin\'s still waits');
  } finally { await h.close(); }
});

// ---------- 2. Spilled tool output ----------

test('spill: the whole output goes to a session file (redacted, git-ignored), the agent gets head, tail, path and line count', async () => {
  const ws = await tempDir();
  const r = new Redactor();
  r.add('db-pass', 'hunter2-very-secret-value');
  const store = new SpillStore(ws, 'sess1', { redact: (s) => r.redact(s) });
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}${i === 1500 ? ' hunter2-very-secret-value' : ''}`).join('\n');
  const text = await store.excerpt('bash', lines, 2000);
  assert.ok(text.length <= 2000, `bounded (${text.length})`);
  assert.match(text, /^line 0\n/);
  assert.match(text, /line 2999$/);
  const rel = spillPathIn(text)!;
  assert.match(rel, /^\.harness\/spill\/sess1\/0001-bash\.txt$/);
  assert.match(text, /\(3000 lines\)/);
  const saved = await fs.readFile(path.join(ws, rel), 'utf8');
  assert.equal(saved.split('\n').length, 3000);
  assert.match(saved, /line 1500 \[vault:db-pass\]/);
  assert.doesNotMatch(saved, /hunter2/);
  assert.equal(await fs.readFile(path.join(ws, '.harness', 'spill', '.gitignore'), 'utf8'), '*\n');
  // The read tool reads the middle back.
  const read = await readTool.run({ path: rel, offset: 1500, limit: 2 }, { host: new LocalHost(ws), readFiles: new Map() } as never);
  assert.match(read.content, /line 1499\n.*line 1500 \[vault:db-pass\]/);
  // Short output is untouched.
  assert.equal(await store.excerpt('bash', 'short', 2000), 'short');
  await store.remove();
  await assert.rejects(fs.stat(store.dir));
});

test('spill: the disk cap drops the oldest files; one output over half the cap is clipped instead', async () => {
  const ws = await tempDir();
  const store = new SpillStore(ws, 's', { maxBytes: 10_000 });
  for (let i = 0; i < 5; i++) await store.excerpt('t', `${i}`.repeat(3000), 500);
  const files = (await fs.readdir(store.dir)).sort();
  assert.deepEqual(files, ['0003-t.txt', '0004-t.txt', '0005-t.txt']);
  assert.ok(store.bytes <= 10_000);
  const big = await store.excerpt('t', 'z'.repeat(6000), 500);
  assert.match(big, /characters omitted/);
  assert.equal(spillPathIn(big), undefined);
  assert.equal(excerpt('abc'.repeat(100), 1000), 'abc'.repeat(100));
  // Without a store (spill off, a companion): clip as before.
  assert.match(await clipOrSpill({}, 't', 'q'.repeat(5000), 1000, 'hint'), /characters omitted - hint/);
});

test('spill: never through a link in the workspace', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async () => {
  const ws = await tempDir();
  const elsewhere = await tempDir();
  await fs.symlink(elsewhere, path.join(ws, '.harness'));
  const store = new SpillStore(ws, 's');
  assert.equal(await store.save('t', 'x'.repeat(100)), undefined);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('spill in the loop: bash output past its limit is kept whole; the agent reads the middle; off, it is clipped', async () => {
  const cmd = 'for i in $(seq 1 6000); do echo "row $i"; done';
  const run = async (spill: boolean) => {
    const root = await tempDir();
    const h = await makeAgent([{ calls: [{ name: 'bash', input: { command: cmd } }] }, { text: 'ok' }], { root, tools: [bashTool, readTool], settings: { efficiency: { ...defaultEfficiency(), spill } }, config: { spill: new SpillStore(root, 'loop') } });
    h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    await h.agent.run(new AbortController().signal);
    return { root, out: results(h.agent.messages[2])[0]!.content };
  };
  const on = await run(true);
  const rel = spillPathIn(on.out);
  assert.ok(rel, on.out.slice(0, 300));
  assert.match(on.out, /row 1\n/);
  assert.match(on.out, /row 6000/);
  const whole = (await fs.readFile(path.join(on.root, rel!), 'utf8')).trim().split('\n');
  assert.equal(whole.length, 6000);
  const off = await run(false);
  assert.equal(spillPathIn(off.out), undefined);
  assert.match(off.out, /characters omitted - filter the output/);
});

test('spill: a session removes its spill files when it is deleted', async () => {
  const data = await tempDir();
  const ws = await tempDir();
  const h = await createHarness({ dataDir: data, backgroundWork: false, scheduler: false, search: null });
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const store = new SpillStore(ws, s.meta.id);
    await store.save('bash', 'kept');
    await h.sessions.remove(s.meta.id);
    await assert.rejects(fs.stat(store.dir));
    assert.ok((await fs.stat(ws)).isDirectory(), 'the server folder itself stays');
  } finally { await h.close(); }
});

// ---------- 3. Batched masking ----------

const dumpTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: { name: 'dump', description: 'dump', input_schema: { type: 'object', properties: { n: { type: 'number' }, fail: { type: 'boolean' } } } },
  summarize: () => 'dump',
  run: async (i) => (i.fail ? { content: `dump failed: ${'e'.repeat(9000)}`, is_error: true } : { content: `dump ${String(i.n)}\n${'d'.repeat(10_000)}` }),
};

test('batched masking: nothing below half the compaction point; then one batch of every old result, never the last 8 steps, errors or state', async () => {
  const steps = Array.from({ length: 16 }, (_, i) => ({ calls: [{ name: 'dump', input: i === 0 ? { fail: true } : { n: i } }], usage: { input: i < 13 ? 1000 : 25_000 } }));
  const h = await makeAgent([...steps, { text: 'ok' }], { tools: [dumpTool, ...BUILTIN_TOOLS], settings: { compactAt: 40_000 } });
  const spans: { type: string }[] = [];
  h.agent.hooks.onTrace = (s) => spans.push(s);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  const all = h.agent.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as { content: string; is_error?: boolean }[];
  const masked = all.filter((b) => b.content.startsWith('[Earlier '));
  // At step 14 the results of steps 1-5 are older than 8 steps (step 0's is an error): one batch of five.
  assert.equal(masked.length, 5, all.map((b) => b.content.slice(0, 20)).join(' | '));
  assert.match(masked[0]!.content, /^\[Earlier dump output \(10007 chars\) masked to keep the context lean\. It began: "dump 1"\. Run the call again if you need a detail you did not keep\.\]$/);
  assert.equal(all[0]!.is_error, true);
  assert.ok(!all[0]!.content.startsWith('[Earlier '), 'errors are never masked');
  assert.ok(all.slice(-8).every((b) => !b.content.startsWith('[Earlier ')), 'the last 8 steps stay whole');
  assert.equal(spans.filter((s) => s.type === 'clear').length, 1, 'one batch, not one per step');
  assert.equal(h.persisted.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.content.startsWith('[Earlier ')).length, 0, 'the stored history keeps the originals');
  assert.ok(h.events.some((e) => e.kind === 'notice' && /Masked 5 old tool results .* in one batch/.test(e.text)));
});

test('batched masking: a spilled result says where the whole output is; Claude keeps its server-side clearing', async () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ calls: [{ name: 'dump', input: { n: i } }], usage: { input: i < 10 ? 1000 : 25_000 } }));
  const spilled: Tool = { ...dumpTool, spec: { ...dumpTool.spec, name: 'spilled' }, run: async () => ({ content: `head\n\n[... 9000 characters not shown. The whole output (900 lines) is in .harness/spill/s/0001-bash.txt: read it with offset/limit or grep it for the part you need.]\n\n${'t'.repeat(12_000)}` }) };
  const h = await makeAgent([{ calls: [{ name: 'spilled' }], usage: { input: 1000 } }, ...steps, { text: 'ok' }], { tools: [spilled, dumpTool, ...BUILTIN_TOOLS], settings: { compactAt: 40_000 } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  const first = results(h.agent.messages[2])[0]!.content;
  assert.match(first, /^\[Earlier spilled output .* The whole output is in \.harness\/spill\/s\/0001-bash\.txt \(read or grep it\)\.\]$/);

  const c = await makeAgent([...steps, { text: 'ok' }], { tools: [dumpTool, ...BUILTIN_TOOLS], settings: { compactAt: 40_000 }, config: { model: getModel('claude-haiku-5-5') } });
  c.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await c.agent.run(new AbortController().signal);
  assert.equal(c.agent.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.content.startsWith('[Earlier ')).length, 0);
});

// ---------- 4. Cache-reset attribution ----------

const usage = (u: Partial<Usage>): Usage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, ...u });
const msg = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] });

test('attribution: the first changed section names the miss: tools, system, a message (masked, compacted), the TTL, or the provider', () => {
  const model = getModel('deepseek-flash');
  const tools = BUILTIN_TOOLS.map((t) => t.spec);
  const m1 = msg('one'); const m2 = msg('two');
  const before = { ...cacheShape({ model, tools, system: 'S', messages: [m1, m2] }, 1000), prompt: 50_000 };
  const hit = usage({ cacheRead: 49_000, input: 2000 });
  assert.equal(attributeMiss(before, cacheShape({ model, tools, system: 'S', messages: [m1, m2, msg('3')] }, 2000), hit), undefined, 'a hit is no miss');
  const miss = usage({ input: 52_000 });
  assert.equal(attributeMiss(before, cacheShape({ model, tools: tools.slice(1), system: 'S', messages: [m1, m2] }, 2000), miss)!.cause, 'tools');
  assert.equal(attributeMiss(before, cacheShape({ model, tools, system: 'S2', messages: [m1, m2] }, 2000), miss)!.cause, 'system');
  const edited = attributeMiss(before, cacheShape({ model, tools, system: 'S', messages: [m1, msg('two, masked')] }, 2000), miss, { hint: 'mask' })!;
  assert.deepEqual([edited.cause, edited.section, edited.index], ['mask', 'messages', 1]);
  assert.equal(attributeMiss(before, cacheShape({ model, tools, system: 'S', messages: [msg('summary')] }, 2000), usage({ input: 9000 }), { hint: 'compaction' })!.cause, 'compaction');
  assert.equal(attributeMiss(before, cacheShape({ model, tools, system: 'S', messages: [m1, m2, msg('3')] }, 1000 + 6 * 60_000), miss)!.cause, 'ttl');
  assert.equal(attributeMiss(before, cacheShape({ model, tools, system: 'S', messages: [m1, m2, msg('3')] }, 2000), miss)!.cause, 'provider');
  assert.equal(attributeMiss(before, cacheShape({ model: getModel('gpt-6-luna'), tools, system: 'S', messages: [m1, m2] }, 2000), miss)!.cause, 'model');
  assert.deepEqual(firstChange(before, cacheShape({ model, tools, system: 'S', messages: [m1] })), { section: 'messages', index: 1 });
  assert.equal(attributeMiss({ ...before, prompt: 500 }, before, miss), undefined, 'a prompt too small to cache expects nothing');
});

test('attribution in the loop: a group load is a tools miss, in the trace, as a debug event and in the count', async () => {
  const studio = bigTool('studio_one');
  const spans: { type: string; cause?: string }[] = [];
  const counted: string[] = [];
  const h = await makeAgent([
    { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: { input: 20_000 } },
    { calls: [{ name: LOAD_TOOLS, input: { groups: ['games3d'] } }], usage: { input: 1000, cacheRead: 19_500 } },
    { calls: [{ name: 'studio_one' }], usage: { input: 22_000 } },
    { text: 'ok', usage: { input: 500, cacheRead: 21_900 } },
  ], { tools: [...BUILTIN_TOOLS, studio], config: { toolGroups: [{ id: 'games3d', summary: 'g', tools: ['studio_one'] }] }, hooks: { onTrace: (s) => spans.push(s), onCacheMiss: (m) => counted.push(m.cause) } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(new AbortController().signal);
  assert.deepEqual(spans.filter((s) => s.type === 'cache').map((s) => s.cause), ['tools']);
  assert.deepEqual(counted, ['tools']);
  assert.ok(h.events.some((e) => e.kind === 'cache_miss' && e.cause === 'tools' && e.section === 'tools'));
  assert.ok(spans.filter((s) => s.type === 'model').every((s) => typeof (s as { tools?: number }).tools === 'number'), 'each model span carries its schema tokens');

  // Off: no attribution at all, and the requests are the same either way (it only observes).
  const sent: string[] = [];
  for (const cacheAttribution of [false, true]) {
    const quiet: { type: string }[] = [];
    const root = await tempDir();
    const q = await makeAgent([{ calls: [{ name: 'glob', input: { pattern: '*' } }], usage: { input: 20_000 } }, { text: 'ok', usage: { input: 21_000 } }], { root, settings: { efficiency: { ...defaultEfficiency(), cacheAttribution } }, hooks: { onTrace: (s) => quiet.push(s) } });
    q.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
    await q.agent.run(new AbortController().signal);
    if (!cacheAttribution) assert.equal(quiet.filter((s) => s.type === 'cache').length, 0);
    sent.push(JSON.stringify(q.provider.requests.map((r) => ({ system: r.system, tools: r.tools, messages: r.messages, ttl: r.prefixTtl }))).split(root).join('<ws>'));
  }
  assert.equal(sent[0], sent[1]);
});

// ---------- 5. The 1-hour prefix TTL on Anthropic ----------

test('TTL: 1h puts ttl on the system breakpoint only (the tail stays 5m, after it); the 1h writes are billed at 2x input', () => {
  const base = { model: getModel('claude-sonnet-5-5'), system: 'S', tools: [], messages: [msg('hi')], effort: 'medium' as const };
  const five = anthropicBody(base, false);
  assert.deepEqual((five.system as { cache_control: unknown }[])[0]!.cache_control, { type: 'ephemeral' });
  const hour = anthropicBody({ ...base, prefixTtl: '1h' }, false);
  assert.deepEqual((hour.system as { cache_control: unknown }[])[0]!.cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(hour.cache_control, { type: 'ephemeral' }, 'the automatic tail breakpoint keeps the default TTL');
  // The response's TTL breakdown is kept, and priced.
  const r = fromAnthropic('claude-sonnet-5-5', { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 30_000, cache_creation: { ephemeral_1h_input_tokens: 20_000, ephemeral_5m_input_tokens: 10_000 } } } as never);
  assert.equal(r.usage.cacheWrite1h, 20_000);
  const sonnet = getModel('claude-sonnet-5-5');
  // 10 input x $2, 10k 5m writes x $2.50, 20k 1h writes x $4.00, 5 output x $10 (per million).
  assert.equal(costOf(sonnet, r.usage).toFixed(6), ((10 * 2 + 10_000 * 2.5 + 20_000 * 4 + 5 * 10) / 1e6).toFixed(6));
  assert.equal(costOf(sonnet, { ...r.usage, cacheWrite1h: 0 }).toFixed(6), ((10 * 2 + 30_000 * 2.5 + 5 * 10) / 1e6).toFixed(6));
  assert.equal(addUsage(r.usage, r.usage).cacheWrite1h, 40_000);
  assert.equal(addUsage(usage({}), usage({})).cacheWrite1h, undefined, 'absent stays absent');
});

test('TTL auto: the prefix gets the 1-hour TTL once a tool call has run past 4 minutes; 5m never, 1h always', async () => {
  const realNow = Date.now;
  let offset = 0;
  const slow: Tool = { kind: 'read', parallelSafe: false, remoteable: false, spec: { name: 'unreal_package', description: 'packages', input_schema: { type: 'object', properties: {} } }, summarize: () => 'pkg', run: async () => { offset += 4.5 * 60_000; return { content: 'packaged' }; } };
  Date.now = () => realNow() + offset;
  try {
    const go = async (prefixTtl: '5m' | '1h' | 'auto') => {
      offset = 0;
      const h = await makeAgent([{ calls: [{ name: 'glob', input: { pattern: '*' } }] }, { calls: [{ name: 'unreal_package' }] }, { text: 'ok' }], { tools: [...BUILTIN_TOOLS, slow], settings: { promptCaching: { prefixTtl } }, config: { model: getModel('claude-sonnet-5-5') } });
      h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
      await h.agent.run(new AbortController().signal);
      return h.provider.requests.map((r) => r.prefixTtl ?? '5m');
    };
    assert.deepEqual(await go('auto'), ['5m', '5m', '1h']);
    assert.deepEqual(await go('5m'), ['5m', '5m', '5m']);
    assert.deepEqual(await go('1h'), ['1h', '1h', '1h']);
  } finally { Date.now = realNow; }
});

// ---------- Settings and the eval report ----------

test('settings: each efficiency switch from its HARNESS_* variable and the operator file', async () => {
  assert.deepEqual(defaultEfficiency({ HARNESS_DEFER_PLUGIN_TOOLS: 'off', HARNESS_SPILL: '0', HARNESS_MASK_BATCHED: 'on' }), { ...defaultEfficiency({}), deferPluginTools: false, spill: false, batchedMasking: true });
  assert.equal(defaultPromptCaching({ HARNESS_PREFIX_TTL: '1h' }).prefixTtl, '1h');
  assert.equal(defaultPromptCaching({ HARNESS_PREFIX_TTL: 'nonsense' }).prefixTtl, defaultPromptCaching({}).prefixTtl);
  const f = path.join(await tempDir(), 'op.json');
  await fs.writeFile(f, JSON.stringify({ efficiency: { spill: false, bogus: true }, promptCaching: { prefixTtl: '5m' } }));
  const s = await operatorSettings({ HARNESS_SETTINGS: f });
  assert.equal(s.efficiency.spill, false);
  assert.equal(s.promptCaching.prefixTtl, '5m');
  assert.ok(!('bogus' in s.efficiency));
});

test('the eval report lists tokens, cache hits, schema tokens per request and misses by cause', () => {
  const run = (config: string, extra: Partial<EvalRun>): EvalRun => ({ pack: 'p', case: 'c', model: 'deepseek-flash', repeat: 1, config, status: 'done', pass: true, checks: [], cost: 0.01, inputTokens: 100_000, cacheHit: 0.9, output: 10, modelCalls: 20, toolCalls: 19, seconds: 60, workspace: 'w', ...extra });
  const md = report([run('baseline', { schemaTokens: 25_600, cacheMisses: { provider: 1 } }), run('efficiency', { schemaTokens: 8_300, cacheMisses: { tools: 1 }, spills: 2, masked: 5 })], undefined, ['baseline', 'efficiency']);
  assert.match(md, /## Tokens and cache/);
  assert.match(md, /\| p\/c \| deepseek-flash \| baseline \| 100,000 \| 90% \| 25,600 \| 20 \| provider 1 \| 0 \| 0 \|/);
  assert.match(md, /\| p\/c \| deepseek-flash \| efficiency \| 100,000 \| 90% \| 8,300 \| 20 \| tools 1 \| 2 \| 5 \|/);
});
