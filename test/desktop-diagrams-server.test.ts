// The engine's side of core.diagrams: the `diagram` artifact kind (checked against the spec, so the
// model hears what to fix), a person's new version (PUT, refused when stale), the read-only import
// scan behind the code map, and the diagrams skill listed only for an app that draws diagrams.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { HarnessEvent } from '../src/core/types.ts';
import { importSpecifiers, scanImports } from '../src/server/code-imports.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, record, setupServer, turnsEnded, waitFor } from './multi-helpers.ts';
import { DIAGRAMS, HOSTILE, json } from './fixtures/desktop/diagrams.ts';

const DESKTOP = { kind: 'desktop', version: '1', renderers: ['diagram', 'mermaid'], tools: [] };

test('diagram artifacts: validated on create and on every edit (a readable error to fix); a person saves a new version, refused when stale', async () => {
  const t = await setupServer();
  try {
    const a = await t.member('alice');
    const b = await t.member('bob');
    const ws = await tempDir();
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'acceptEdits', runtime: { kind: 'local', network: 'none', path: ws }, owner: a.id, client: DESKTOP as never });
    const ev = record(s);
    let id = '';
    t.ds.scripts['dia'] = [
      { calls: [{ name: 'artifact', input: { action: 'create', title: 'Broken', kind: 'diagram', content: json(HOSTILE.unknownEdge) } }, { name: 'artifact', input: { action: 'create', title: 'Not JSON', kind: 'diagram', content: '{"view":' } }] },
      { calls: [{ name: 'artifact', input: { action: 'create', title: 'CRM deployment', kind: 'diagram', content: json(DIAGRAMS.deployment) } }] },
      (req) => { id = /Created artifact (\S+) v1 diagram/.exec(JSON.stringify(req.messages))![1]!; return { calls: [{ name: 'artifact', input: { action: 'update', id, old_string: '"id": "db"', new_string: '"id": "db2"' } }] }; },
      () => ({ calls: [{ name: 'artifact', input: { action: 'update', id, old_string: '"title": "Backup job"', new_string: '"title": "Nightly backup"' } }] }),
      { text: 'done' },
    ];
    await s.send('[[dia]] draw it');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const results = ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    assert.ok(results[0]!.is_error);
    assert.match(results[0]!.content, /not a valid diagram: edge 1 \("sql"\) goes to "dbx", which is not a node id/);
    assert.ok(results[1]!.is_error && /not a valid diagram: the diagram is not valid JSON/.test(results[1]!.content));
    assert.match(results[2]!.content, /^Created artifact \S+ v1 diagram: CRM deployment/);
    assert.ok(results[3]!.is_error && /not a valid diagram: .*"db"/.test(results[3]!.content), 'an edit that breaks the edges is refused');
    assert.match(results[4]!.content, /^Updated \S+ v2 diagram: CRM deployment/);
    const dir = path.join(ws, '.harness', 'artifacts', id);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['meta.json', 'v1.json', 'v2.json']);
    // A person's new version (the canvas saving positions), as its owner.
    const put = (who: string, body: unknown) => t.call(who, 'PUT', `/api/sessions/${s.meta.id}/artifacts/${id}`, body);
    const v2 = (await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts/${id}`)).body;
    assert.equal(v2.version, 2);
    const moved = JSON.parse(v2.content);
    moved.layout = { positions: { user: { x: 0, y: 0 }, proxy: { x: 320, y: 10 } } };
    const ok = await put(a.token, { content: JSON.stringify(moved), baseVersion: 2 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.version, 3);
    assert.equal(ok.body.meta.kind, 'diagram');
    const stale = await put(a.token, { content: JSON.stringify(moved), baseVersion: 2 });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /is at v3 now, not v2/);
    assert.equal((await put(a.token, { content: json(HOSTILE.groupCycle) })).status, 400, 'a person cannot save a broken diagram either');
    assert.equal((await put(a.token, { nope: 1 })).status, 400);
    assert.equal((await put(b.token, { content: JSON.stringify(moved) })).status, 404, 'someone else\'s session reads as missing');
    assert.equal((await t.call(a.token, 'PUT', `/api/sessions/${s.meta.id}/artifacts/no-such-thing`, { content: '{}' })).status, 404);
    await waitFor(() => ev.some((e) => e.kind === 'artifact' && (e as Extract<HarnessEvent, { kind: 'artifact' }>).artifact.version === 3), 'the artifact event for the person\'s version');
    const v3 = await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts/${id}`);
    assert.deepEqual(JSON.parse(v3.body.content).layout.positions.proxy, { x: 320, y: 10 });
  } finally { await t.close(); }
});

test('the diagrams skill is listed only for an app that draws diagrams; the base prompt is unchanged', async () => {
  const t = await setupServer();
  try {
    const desk = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, client: DESKTOP as never });
    const ev = record(desk);
    t.ds.scripts['sk'] = [{ calls: [{ name: 'skill', input: { name: 'diagrams' } }] }, { text: 'ok' }];
    await desk.send('[[sk]] draw');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const req = t.ds.byKey['sk']![0]!;
    assert.ok(req.tools.some((x) => x.name === 'skill'), 'the skill tool is there');
    assert.match(JSON.stringify(req.messages[0]), /- diagrams: Draw architecture, deployment/);
    const loaded = ev.find((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>;
    assert.match(loaded.content, /<skill name="diagrams">/);
    assert.match(loaded.content, /"view":"deployment"/);
    assert.ok(loaded.content.length < 14_000, `the skill stays compact (${loaded.content.length} chars)`);
    // A desktop session that does not draw diagrams, and a plain session: no such skill.
    for (const client of [{ kind: 'desktop', version: '1', renderers: ['mermaid'], tools: [] }, undefined]) {
      const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, ...(client ? { client: client as never } : {}) });
      const e2 = record(s);
      const key = `n${client ? 'd' : 'p'}`;
      t.ds.scripts[key] = [{ text: 'ok' }];
      await s.send(`[[${key}]] hi`);
      await waitFor(() => turnsEnded(e2) === 1, 'turn');
      assert.doesNotMatch(JSON.stringify(t.ds.byKey[key]![0]!.messages[0]), /diagrams:/);
    }
  } finally { await t.close(); }
});

test('import scan: TS/JS and Python imports resolved to workspace files (".js" names ".ts"), outside packages counted; read-only and bounded', async () => {
  const ws = await tempDir();
  const put = async (p: string, text: string) => { await fs.mkdir(path.dirname(path.join(ws, p)), { recursive: true }); await fs.writeFile(path.join(ws, p), text); };
  await put('src/core/a.ts', "import { b } from './b.js';\nimport type { T } from '../util/t';\nimport React from 'react';\nexport * from './c';\nconst x = require('../util/t');\n// import { nope } from './gone';\n");
  await put('src/core/b.ts', "export const b = 1; import('./c').then(() => {}); import fs from 'node:fs'; import path from 'path';\n");
  await put('src/core/c.tsx', "import { a } from '@scope/pkg/deep';\n");
  await put('src/util/t.ts', 'export type T = 1;\n');
  await put('src/util/index.ts', "export * from './t';\n");
  await put('app/main.py', 'from app.models import User\nfrom . import views\nimport os, requests\nfrom .services.mail import send\n');
  await put('app/__init__.py', '');
  await put('app/models.py', 'class User: pass\n');
  await put('app/views.py', 'from .models import User\n');
  await put('app/services/__init__.py', '');
  await put('app/services/mail.py', 'import smtplib\n');
  await put('node_modules/x/index.js', "import './y';\n");
  await put('dist/out.js', "import './z';\n");
  const r = await scanImports(ws);
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, f.imports]));
  assert.deepEqual(byPath['src/core/a.ts'], ['src/core/b.ts', 'src/core/c.tsx', 'src/util/t.ts']);
  assert.deepEqual(byPath['src/core/b.ts'], ['src/core/c.tsx']);
  assert.deepEqual(byPath['app/main.py'], ['app/models.py', 'app/services/mail.py', 'app/views.py']);
  assert.deepEqual(byPath['app/views.py'], ['app/models.py']);
  assert.ok(!r.files.some((f) => f.path.startsWith('node_modules') || f.path.startsWith('dist')), 'heavy folders are skipped');
  const ext = Object.fromEntries(r.external);
  assert.equal(ext.react, 1);
  assert.equal(ext['@scope/pkg'], 1);
  assert.equal(ext.fs, undefined, 'node built-ins are not packages');
  assert.equal(ext.requests, 1);
  assert.equal(r.truncated, false);
  assert.ok((await scanImports(ws, ws, { maxFiles: 2 })).truncated, 'bounded');
  assert.deepEqual(importSpecifiers("/* import x from 'a' */\nimport y from 'b';", 'ts').map((x) => x.spec), ['b']);
  // Over HTTP, for the session's owner: a sub-folder, and refusals.
  const t = await setupServer();
  try {
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: ws } });
    const all = await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/files/imports`);
    assert.equal(all.status, 200);
    assert.equal(all.body.files.length, r.files.length);
    const sub = await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/files/imports?path=src`);
    assert.equal(sub.body.root, 'src');
    assert.ok(sub.body.files.every((f: { path: string }) => f.path.startsWith('src/')));
    assert.deepEqual(sub.body.files.find((f: { path: string }) => f.path === 'src/core/a.ts').imports, ['src/core/b.ts', 'src/core/c.tsx', 'src/util/t.ts']);
    assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/files/imports?path=../..`)).status, 400);
    assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/files/imports?path=src/core/a.ts`)).status, 400, 'a folder only');
    const bob = await t.member('bob');
    assert.equal((await t.call(bob.token, 'GET', `/api/sessions/${s.meta.id}/files/imports`)).status, 404);
  } finally { await t.close(); }
});
