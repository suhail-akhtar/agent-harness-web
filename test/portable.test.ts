import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { exportSession, importSession, validateBundle } from '../src/core/portable.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { createApp } from '../src/server/app.ts';
import { FakeProvider, tempDir } from './helpers.ts';

test('a session moves to another server: its conversation continues there, with its files, never its secrets', async () => {
  const a = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  a.registry.setProviderInstance('deepseek', new FakeProvider([
    { calls: [{ name: 'write', input: { path: 'src/app.js', content: 'console.log(1)\n' } }] },
    { text: 'Wrote src/app.js. The port is 4310.' },
  ]));
  const b = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const fakeB = new FakeProvider([{ text: 'Continuing from the earlier work.' }]);
  b.registry.setProviderInstance('deepseek', fakeB);
  try {
    const s = await a.sessions.create({ title: 'Port work', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none' } });
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('write the app');
    await done;
    await fs.writeFile(path.join(s.workspace, '.env'), 'OPENAI_API_KEY=sk-secret');
    await fs.mkdir(path.join(s.workspace, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(s.workspace, 'node_modules', 'x', 'big.js'), 'x');
    const bundle = JSON.parse(JSON.stringify(await exportSession(s)));
    assert.deepEqual(bundle.files.map((f: { path: string }) => f.path), ['src/app.js'], 'no .env, no node_modules');
    assert.ok(!JSON.stringify(bundle).includes('sk-secret'));
    // Links never carry a server file out: a folder link (a junction on Windows) or a file link.
    const outside = await tempDir();
    await fs.writeFile(path.join(outside, 'server-secret.txt'), 'SERVER-ONLY');
    await fs.symlink(outside, path.join(s.workspace, 'linked'), 'junction');
    await fs.symlink(path.join(outside, 'server-secret.txt'), path.join(s.workspace, 'leak.txt')).catch(() => {});
    const linked = JSON.stringify(await exportSession(s));
    assert.ok(!linked.includes(Buffer.from('SERVER-ONLY').toString('base64')), 'nothing from outside the workspace');
    assert.match(linked, /src\/app\.js/);

    const t = await importSession(b.sessions, bundle, { runtime: { kind: 'local', network: 'none' } });
    assert.equal(t.meta.mode, 'default', 'an import never brings bypass along');
    assert.equal(t.meta.title, 'Port work');
    assert.match(t.meta.importedFrom!, /Port work/);
    assert.equal(await fs.readFile(path.join(t.workspace, 'src', 'app.js'), 'utf8'), 'console.log(1)\n');
    const done2 = new Promise<void>((r) => t.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await t.send('what port?');
    await done2;
    assert.match(JSON.stringify(fakeB.requests[0]!.messages), /The port is 4310/, 'the model there sees the whole earlier conversation');
  } finally { await a.close(); await b.close(); }
});

test('importing: a tainted conversation stays tainted; bad bundles and paths that leave the folder are refused', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  try {
    const base = { format: 'harness-session', version: 1, exportedAt: 0, skipped: [], source: { id: 'x', title: 'T', model: 'deepseek-flash', effort: 'high', mode: 'bypass', tainted: false, todos: [], contextStart: 0, compactions: 0, lastPromptTokens: 0, cost: 0 } };
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'read the page' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'web_fetch', input: { url: 'https://x.example' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'page text' }] },
    ];
    const files = [{ path: '../escape.txt', data: Buffer.from('x').toString('base64') }, { path: 'ok.txt', data: Buffer.from('fine').toString('base64') }];
    const s = await importSession(h.sessions, { ...base, history, files }, { runtime: { kind: 'local', network: 'none' } });
    assert.equal(s.meta.tainted, true, 'it read a web page before: that still counts here');
    assert.equal(await fs.readFile(path.join(s.workspace, 'ok.txt'), 'utf8'), 'fine');
    await assert.rejects(fs.stat(path.join(path.dirname(s.workspace), 'escape.txt')));
    assert.throws(() => validateBundle({ format: 'other' }), /not a harness session bundle/);
    assert.throws(() => validateBundle({ ...base, history: [{ role: 'system', content: [] }], files: [] }), /not valid/);
    assert.throws(() => validateBundle({ ...base, history: [{ role: 'user', content: [{ type: 'script' }] }], files: [] }), /unknown block type/);
  } finally { await h.close(); }
});

test('export and import over the API: owners only; an import lands in a sandbox unless an administrator chose a folder', async () => {
  const data = await tempDir();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off' });
  const work = await tempDir();
  const { server } = createApp({ harness, token: 'op', loopback: true, localRoots: [work], uiDir: path.join(data, 'ui'), appRoot: data });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const s = await harness.sessions.create({ title: 'Mine', model: 'deepseek-flash', runtime: { kind: 'local', network: 'none' } });
    await fs.writeFile(path.join(s.workspace, 'notes.md'), 'hello');
    const res = await fetch(`${base}/api/sessions/${s.meta.id}/export`, { headers: { authorization: 'Bearer op' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition')!, /attachment; filename="session-/);
    const bundle = await res.json();
    const imp = await fetch(`${base}/api/sessions/import`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ bundle, runtime: 'local' }) });
    assert.equal(imp.status, 201, await imp.clone().text());
    const meta = await imp.json() as { id: string; title: string };
    assert.notEqual(meta.id, s.meta.id);
    assert.equal(meta.title, 'Mine');
    const bad = await fetch(`${base}/api/sessions/import`, { method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify({ bundle: { format: 'x' }, runtime: 'local' }) });
    assert.equal(bad.status, 400);
  } finally { await new Promise<void>((r) => (server as http.Server).close(() => r())); await harness.close(); }
});
