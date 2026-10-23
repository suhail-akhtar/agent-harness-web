// Switching a plugin off while the server runs, safely: an open conversation keeps its tool list (the
// cached prefix is unchanged) but the plugin's tools, agents, skills and hooks answer with why they do
// not run; a workflow waits at the step that needs it and carries on when it is back; its schedules are
// skipped with a note; its routes answer 503; its loops get no lease; uninstalling keeps its data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import type { Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import { FakeProvider, tempDir } from './helpers.ts';

const OPERATOR = 'operator-token-for-plugin-off';
const OFF = 'Widget Works is switched off on this server; switch it on to use';
const until = async (f: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await f())) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};
const g = globalThis as unknown as { __widgetRuns: number; __widgetHooks: number };

async function writePlugin(root: string, name: string, title: string, body: string, permissions: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'skills', 'widget-howto'), { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.mjs', skills: 'skills', permissions, ui: { apiVersion: 1, displayName: title } }));
  await fs.writeFile(path.join(dir, 'skills', 'widget-howto', 'SKILL.md'), '---\nname: widget-howto\ndescription: How widgets are made\n---\nMake widgets carefully.\n');
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: ${JSON.stringify(name)}, setup(api) { ${body} } };\n`);
  return dir;
}

const WIDGETS = `
  globalThis.__widgetRuns = 0; globalThis.__widgetHooks = 0;
  api.registerTool({ name: 'widget_count', description: 'Counts the widgets', kind: 'read', parameters: { type: 'object', properties: {} }, run: async () => { globalThis.__widgetRuns++; return 'there are 7 widgets'; } });
  api.registerAgent({ name: 'widget-maker', description: 'Makes widgets', prompt: 'You make widgets.' });
  api.on('PreToolUse', async () => { globalThis.__widgetHooks++; });
  api.registerWorkflow({ name: 'widget-flow', description: 'Makes a widget', start: 'make', nodes: { make: { type: 'agent', agent: 'widget-maker', prompt: 'make one' , next: 'done' }, done: { type: 'end' } } });
  api.registerRoute({ method: 'POST', path: 'hook', auth: 'none', handler: async () => ({ status: 200, body: { ok: true } }) });
`;

async function setup(steps: ConstructorParameters<typeof FakeProvider>[0] = []) {
  const data = await tempDir();
  const plugins = await tempDir();
  const work = await tempDir();
  await writePlugin(plugins, 'widgets', 'Widget Works', WIDGETS, { routes: true });
  // Two plugins installed from the catalogue (under <data>/plugins), each with data of its own.
  for (const n of ['gadgets', 'gizmos']) {
    await writePlugin(path.join(data, 'plugins'), n, n, '');
    await fs.mkdir(path.join(data, 'plugin-data', n), { recursive: true });
    await fs.writeFile(path.join(data, 'plugin-data', n, 'state.json'), '{"kept":true}');
  }
  const harness = await createHarness({ dataDir: data, search: null, plugins: [plugins], backgroundWork: true });
  const fake = new FakeProvider(steps);
  for (const id of harness.registry.providers.keys()) harness.registry.setProviderInstance(id, fake);
  const users = await new UserStore(data).load();
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${OPERATOR}`, 'content-type': 'application/json', 'x-harness': '1' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any };
  };
  const close = async () => { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); };
  const session = () => harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: work }, mode: 'bypass' });
  return { harness, fake, call, close, data, work, session };
}

const toolResults = (history: Message[]) => history.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')) as Array<{ content: string; is_error?: boolean }>;

test('an open conversation: a switched-off plugin\'s tools stay listed but answer why; back on, they work again', async () => {
  const t = await setup([
    { calls: [{ name: 'widget_count' }] }, { text: 'seven' },
    // Off: its tool, its agent type and its skill answer with the reason; a built-in tool still runs (without its hook).
    { calls: [{ name: 'widget_count' }, { name: 'agent', input: { description: 'make one', prompt: 'make a widget', type: 'widget-maker' } }, { name: 'skill', input: { name: 'widget-howto' } }, { name: 'glob', input: { pattern: '*' } }] }, { text: 'it is off' },
    { calls: [{ name: 'widget_count' }] }, { text: 'seven again' },
  ]);
  try {
    const s = await t.session();
    const id = s.meta.id;
    const turn = async (text: string, n: number) => { await s.send(text); await until(() => t.harness.sessions.statusOf(id) === 'idle' && toolResults(s.history).length >= n); };
    await turn('count the widgets', 1);
    assert.equal(toolResults(s.history)[0]!.content, 'there are 7 widgets');
    assert.equal(g.__widgetRuns, 1);
    const hooksOn = g.__widgetHooks;
    assert.ok(hooksOn >= 1, 'its PreToolUse hook ran while it was on');
    const first = t.fake.requests[0]!;

    await t.harness.plugins.setEnabled('widgets', false);
    await turn('again', 5);
    const off = toolResults(s.history).slice(1, 5);
    assert.deepEqual([off[0]!.content, off[0]!.is_error], [`${OFF} widget_count.`, true]);
    assert.match(off[1]!.content, new RegExp(`${OFF} the widget-maker agent\\.`));
    assert.equal(off[1]!.is_error, true);
    assert.deepEqual([off[2]!.content, off[2]!.is_error], [`${OFF} the widget-howto skill.`, true]);
    assert.notEqual(off[3]!.is_error, true, 'a built-in tool still runs');
    assert.equal(g.__widgetRuns, 1, 'its code did not run');
    assert.equal(g.__widgetHooks, hooksOn, 'its hook did not run');
    // The cached prefix: the same system prompt and tool list, byte for byte.
    const during = t.fake.requests.at(-1)!;
    assert.equal(during.system, first.system);
    assert.equal(JSON.stringify(during.tools), JSON.stringify(first.tools));
    assert.ok(during.tools.some((x) => x.name === 'widget_count'));

    await t.harness.plugins.setEnabled('widgets', true);
    await turn('once more', 6);
    assert.deepEqual([toolResults(s.history)[5]!.content, toolResults(s.history)[5]!.is_error], ['there are 7 widgets', undefined]);
    assert.equal(g.__widgetRuns, 2, 'it runs again, no restart');
    assert.ok(g.__widgetHooks > hooksOn, 'its hook runs again');
    assert.equal(JSON.stringify(t.fake.requests.at(-1)!.tools), JSON.stringify(first.tools));
  } finally { await t.close(); }
});

test('a workflow waits at the step that needs a switched-off plugin and carries on from it when it is back; starting its own workflow is refused', async () => {
  const t = await setup([{ text: 'first step done' }, { text: 'made a widget' }]);
  try {
    await fs.mkdir(path.join(t.work, '.harness', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(t.work, '.harness', 'workflows', 'two-steps.json'), JSON.stringify({
      name: 'two-steps', description: 'a plain step, then one by the widget-maker', start: 'plan',
      nodes: { plan: { type: 'agent', agent: 'general', prompt: 'plan it', next: 'make' }, make: { type: 'agent', agent: 'widget-maker', prompt: 'make it', next: 'done' }, done: { type: 'end' } },
    }));
    const s = await t.session();
    const id = s.meta.id;
    await t.harness.plugins.setEnabled('widgets', false);
    await assert.rejects(s.startWorkflow('widget-flow', {}), new RegExp(`${OFF} the widget-flow workflow\\.`));

    const started = await s.startWorkflow('two-steps', {});
    await until(async () => t.harness.sessions.statusOf(id) === 'idle' && (await s.readRun(started.id)).status === 'waiting');
    const waiting = await s.readRun(started.id);
    assert.equal(waiting.current, 'make');
    assert.deepEqual(waiting.paused, { node: 'make', plugin: 'widgets', reason: `${OFF} the widget-maker agent.` });
    assert.deepEqual(waiting.history.map((h) => [h.node, h.status]), [['plan', 'done'], ['make', 'waiting']]);
    assert.equal((await s.listRuns()).find((r) => r.id === started.id)!.error, waiting.paused!.reason, 'the runs list says why');
    assert.equal(t.fake.requests.length, 1, 'only the first step ran');
    // A restart keeps it waiting (not "interrupted").
    await s.recoverRuns();
    assert.equal((await s.readRun(started.id)).status, 'waiting');

    await t.harness.plugins.setEnabled('widgets', true);
    await until(async () => (await s.readRun(started.id)).status === 'succeeded');
    const done = await s.readRun(started.id);
    assert.equal(done.paused, undefined);
    assert.deepEqual(done.history.map((h) => [h.node, h.status]), [['plan', 'done'], ['make', 'interrupted'], ['make', 'done'], ['done', 'done']]);
    assert.equal(done.state.make, 'made a widget');
    assert.equal(t.fake.requests.length, 2, 'the first step was not run again');
  } finally { await t.close(); }
});

test('background work: its schedules are skipped with a note and kept, its routes answer 503, its loops get no lease', async () => {
  const t = await setup([{ text: 'scheduled run' }]);
  try {
    const s = await t.session();
    const sch = t.harness.scheduler!;
    const made = await sch.create({ prompt: 'check the widgets', cron: '* * * * *', sessionId: s.meta.id, plugin: 'widgets' });
    const once = await sch.create({ prompt: 'one widget report', inMinutes: 1, sessionId: s.meta.id, plugin: 'widgets' });
    const plain = await sch.create({ prompt: 'not the plugin\'s', inMinutes: 1, newSession: { model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: t.work } } });
    await sch.remove(plain.id);
    assert.equal((await t.call('POST', '/api/plugins/widgets/hook')).status, 200);
    assert.equal(await t.harness.bridge.lease('widgets', 'watch'), true);

    await t.harness.plugins.setEnabled('widgets', false);
    const r = await t.call('POST', '/api/plugins/widgets/hook');
    assert.equal(r.status, 503);
    assert.match(JSON.stringify(r.body), /Widget Works is switched off/);
    assert.equal((await t.call('POST', '/api/plugins/nobody/hook')).status, 404, 'an unknown plugin is still not found');
    assert.equal(await t.harness.bridge.lease('widgets', 'watch'), false, 'its loops stop');
    await sch.tick(Date.now() + 3 * 60_000);
    const skipped = sch.get(made.id)!;
    assert.match(skipped.lastResult!, /^skipped: Widget Works is switched off on this server; switch it on to use the schedule "check the widgets"\.$/);
    assert.equal(skipped.enabled, true, 'kept');
    assert.equal(skipped.runs, 0, 'not run');
    assert.ok(skipped.nextRun! > Date.now(), 'its next time moved on');
    assert.equal(sch.get(once.id)!.enabled, true, 'a one-time schedule stays due');
    assert.match(sch.get(once.id)!.lastResult!, /^skipped:/);
    assert.equal(t.fake.requests.length, 0);

    await t.harness.plugins.setEnabled('widgets', true);
    assert.equal((await t.call('POST', '/api/plugins/widgets/hook')).status, 200);
    assert.equal(await t.harness.bridge.lease('widgets', 'watch'), true);
    await sch.remove(made.id);
    await sch.tick(Date.now() + 3 * 60_000);
    assert.equal(sch.get(once.id)!.lastResult, 'started', 'back on: it runs');
    await until(() => t.harness.sessions.statusOf(s.meta.id) === 'idle' && t.fake.requests.length === 1);
  } finally { await t.close(); }
});

test('uninstall keeps the plugin\'s data folder unless asked to delete it', async () => {
  const t = await setup();
  try {
    const r = await t.call('DELETE', '/api/plugins/gadgets');
    assert.deepEqual([r.status, r.body], [200, { ok: true, dataKept: true }]);
    assert.equal(await fs.readFile(path.join(t.data, 'plugin-data', 'gadgets', 'state.json'), 'utf8'), '{"kept":true}', 'kept by default');
    await assert.rejects(fs.stat(path.join(t.data, 'plugins', 'gadgets')), 'its folder is gone');
    const d = await t.call('DELETE', '/api/plugins/gizmos', { deleteData: true });
    assert.deepEqual([d.status, d.body], [200, { ok: true, dataKept: false }]);
    await assert.rejects(fs.stat(path.join(t.data, 'plugin-data', 'gizmos')), 'deleted when asked');
    assert.equal(t.harness.registry.offReason('gadgets', 'x'), 'gadgets was uninstalled from this server; install it again to use x.');
  } finally { await t.close(); }
});
