// Solutions (Studio, Operations, Engineering, DevOps): shipped with the harness, loaded only once installed on
// a server that installs them one by one, in any mix; the core never needs them. A new data folder starts with
// the core only (or HARNESS_SOLUTIONS), one in use before keeps every solution (nothing changes); installing one
// installs what it requires; removing one keeps its data and is refused while another needs it; the choice is
// kept across restarts; a folder the operator names on its own always loads; the default mode loads them all.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness, type HarnessOptions } from '../src/kernel/harness.ts';
import { tempDir } from './helpers.ts';

async function shipped(): Promise<string> {
  const root = path.join(await tempDir(), 'plugins');
  const plugin = async (name: string, extra: Record<string, unknown>, tool: string) => {
    await fs.mkdir(path.join(root, name), { recursive: true });
    await fs.writeFile(path.join(root, name, 'harness-plugin.json'), JSON.stringify({ name, version: '1.0.0', description: `${name} plugin`, main: 'index.mjs', ...extra }));
    await fs.writeFile(path.join(root, name, 'index.mjs'), `export default { name: ${JSON.stringify(name)}, setup(api) { api.registerTool({ name: ${JSON.stringify(tool)}, description: 'x', kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => 'ok' }); } };\n`);
  };
  await plugin('core-gates', {}, 'gates_run');
  await plugin('ops', { solution: { title: 'Operations' } }, 'ops_check');
  await plugin('studio', { solution: { title: 'Studio' } }, 'studio_open');
  // Sorts before "studio": loaded after it all the same (it requires it).
  await plugin('engine-x', { solution: { title: 'Studio: X' }, requires: ['studio'] }, 'engine_x');
  return root;
}

const start = (root: string, dataDir: string, o: Partial<HarnessOptions> = {}) =>
  createHarness({ dataDir, plugins: [root], shippedPlugins: [root], solutions: 'installed', backgroundWork: false, scheduler: false, search: null, ...o });
const tools = (h: Awaited<ReturnType<typeof createHarness>>) => ['gates_run', 'ops_check', 'studio_open', 'engine_x'].filter((t) => h.registry.tools.has(t));

test('solutions: a new server has the core only; installing one installs what it requires; the choice is kept; removing keeps the data and waits for what needs it', async () => {
  const root = await shipped();
  const data = await tempDir();
  let h = await start(root, data);
  try {
    assert.deepEqual(tools(h), ['gates_run'], 'the core only');
    assert.deepEqual(h.plugins.solutions().map((x) => [x.name, x.title, x.installed]), [['ops', 'Operations', false], ['studio', 'Studio', false], ['engine-x', 'Studio: X', false]]);
    assert.equal(h.plugins.list().some((p) => p.name === 'ops'), false, 'not installed: not among the plugins');
    assert.equal(h.registry.offReason('ops', 'the ops_check tool'), 'Operations is not installed on this server; install it (Plugins > Catalogue) to use the ops_check tool.');
    const cat = await h.catalogue();
    assert.deepEqual(cat.map((c) => [c.name, c.installed, c.solution?.requires]), [['ops', false, []], ['studio', false, []], ['engine-x', false, ['studio']]]);

    await h.install('engine-x');
    assert.deepEqual(tools(h), ['gates_run', 'studio_open', 'engine_x'], 'Studio came with its engine');
    assert.deepEqual(h.plugins.solutions().filter((x) => x.installed).map((x) => x.name).sort(), ['engine-x', 'studio']);
    await assert.rejects(h.plugins.removeSolution('studio'), /Studio is needed by Studio: X: remove it first/);
    await fs.mkdir(path.join(data, 'plugin-data', 'engine-x'), { recursive: true });
    await fs.writeFile(path.join(data, 'plugin-data', 'engine-x', 'keep.json'), '{}');
    await h.plugins.uninstall('engine-x');
    assert.deepEqual(tools(h), ['gates_run', 'studio_open']);
    assert.ok(await fs.stat(path.join(data, 'plugin-data', 'engine-x', 'keep.json')), 'its data is kept');
    assert.ok(await fs.stat(path.join(root, 'engine-x', 'index.mjs')), 'its shipped folder is untouched');
    await h.plugins.installSolution('ops');
  } finally { await h.close(); }

  // Restarted: what was installed is installed again, nothing else.
  h = await start(root, data);
  try {
    assert.deepEqual(tools(h), ['gates_run', 'ops_check', 'studio_open']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'plugins-state.json'), 'utf8')).solutions, ['ops', 'studio']);
  } finally { await h.close(); }
});

test('solutions: a data folder in use before keeps every solution; HARNESS_SOLUTIONS sets a new one; a folder named on its own loads; the default mode loads them all', async () => {
  const root = await shipped();
  // In use before (it has conversations): nothing changes for it.
  const old = await tempDir();
  await fs.mkdir(path.join(old, 'sessions'), { recursive: true });
  let h = await start(root, old);
  try { assert.deepEqual(tools(h), ['gates_run', 'ops_check', 'studio_open', 'engine_x']); } finally { await h.close(); }

  // A new one set up for operations only.
  process.env.HARNESS_SOLUTIONS = 'ops';
  try {
    const logs: string[] = [];
    h = await start(root, await tempDir(), { log: (m) => logs.push(m) });
    try { assert.deepEqual(tools(h), ['gates_run', 'ops_check'], logs.join(' | ')); } finally { await h.close(); }
  } finally { delete process.env.HARNESS_SOLUTIONS; }

  // The operator names a solution on its own (HARNESS_PLUGINS=.../ops): it loads, once.
  h = await start(root, await tempDir(), { plugins: [root, path.join(root, 'ops')] });
  try {
    assert.deepEqual(tools(h), ['gates_run', 'ops_check']);
    assert.equal(h.plugins.list().filter((p) => p.name === 'ops').length, 1);
  } finally { await h.close(); }

  // The default mode (tests, evals, embedders): every shipped plugin, as before.
  h = await createHarness({ dataDir: await tempDir(), plugins: [root], shippedPlugins: [root], backgroundWork: false, scheduler: false, search: null });
  try {
    assert.deepEqual(tools(h), ['gates_run', 'ops_check', 'studio_open', 'engine_x']);
    assert.deepEqual(h.plugins.solutions().map((x) => x.installed), [true, true, true]);
  } finally { await h.close(); }
});

test('solutions: the real ones are marked, and an engine of Studio requires Studio', async () => {
  const dir = path.join(import.meta.dirname, '..', 'plugins');
  const m = async (n: string) => JSON.parse(await fs.readFile(path.join(dir, n, 'harness-plugin.json'), 'utf8')) as { solution?: { title: string }; requires?: string[] };
  for (const [n, title] of [['aiops', 'Operations'], ['devops', 'DevOps'], ['sdlc', 'Engineering'], ['games3d', 'Studio']] as const) assert.equal((await m(n)).solution?.title, title, n);
  for (const n of ['engine-blender', 'engine-godot', 'engine-unity', 'engine-unreal']) assert.deepEqual((await m(n)).requires, ['games3d'], n);
  for (const n of ['quality-gates', 'research', 'documents', 'integrations', 'visual', 'computer', 'plugin-dev']) assert.equal((await m(n)).solution, undefined, `${n} stays core`);
});
