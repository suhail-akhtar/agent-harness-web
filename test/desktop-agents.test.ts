import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { SYSTEM_PROMPT } from '../src/core/prompt.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, record, Scripted, setupServer, turnsEnded, waitFor } from './multi-helpers.ts';

// Agents that know and drive the desktop (docs/desktop/DESIGN.md section 11): the client
// declaration in the frozen system prompt, artifacts and the Library, desktop tools
// forwarded to an attached app, and ask_user with a form. Every model call is scripted.

const toolNames = (p: Scripted, i = 0) => p.requests[i]!.tools.map((t) => t.name);

test('client declaration: validated, rendered once into the system prompt (identical on every request); desktop tools only for a client that serves them', async () => {
  const t = await setupServer();
  try {
    const ws = await tempDir();
    const bad = async (client: unknown) => (await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'local', path: ws, model: 'deepseek-flash', client })).status;
    assert.equal(await bad({ kind: 'tv' }), 400);
    assert.equal(await bad({ kind: 'desktop', tools: ['rm_rf'] }), 400);
    assert.equal(await bad({ kind: 'desktop', renderers: Array.from({ length: 101 }, (_, i) => `r${i}`) }), 400);
    assert.equal(await bad({ kind: 'desktop', renderers: ['<script>'] }), 400);
    const r = await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'local', path: ws, model: 'deepseek-flash', mode: 'bypass', client: { kind: 'desktop', version: '1.2.0', renderers: ['mermaid', 'chart', 'mermaid'], tools: ['desktop_open', 'desktop_notify'] } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.client, { kind: 'desktop', version: '1.2.0', renderers: ['chart', 'mermaid'], tools: ['desktop_notify', 'desktop_open'] });
    const s = t.harness.sessions.get(r.body.id)!;
    const ev = record(s);
    t.ds.scripts['k1'] = [{ text: 'one' }, { text: 'two' }];
    await s.send('[[k1]] hi'); await waitFor(() => turnsEnded(ev) === 1, 'turn 1');
    await s.send('again'); await waitFor(() => turnsEnded(ev) === 2, 'turn 2');
    const [a, b] = t.ds.byKey['k1']!;
    assert.ok(a!.system.startsWith(SYSTEM_PROMPT));
    assert.match(a!.system, /# Client\nThe person uses the desktop app 1\.2\.0\.\nIt draws these Markdown code fences instead of showing their source: chart, mermaid\./);
    assert.match(a!.system, /Desktop tools \(desktop_notify, desktop_open\)/);
    assert.equal(b!.system, a!.system, 'the client block never changes within the session');
    assert.deepEqual(b!.tools, a!.tools);
    const names = a!.tools.map((x) => x.name);
    for (const n of ['artifact', 'mark_chapter', 'desktop_open', 'desktop_notify', 'start_session', 'list_sessions', 'hand_off', 'dismiss_proposal']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('desktop_command') && !names.includes('desktop_describe'), 'only the desktop tools it serves');
    // A session without a client: the shared prompt and tool list are untouched.
    const plain = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const pev = record(plain);
    t.ds.scripts['k2'] = [{ text: 'x' }];
    await plain.send('[[k2]] hi'); await waitFor(() => turnsEnded(pev) === 1, 'plain turn');
    assert.equal(t.ds.byKey['k2']![0]!.system, SYSTEM_PROMPT);
    const plainNames = t.ds.byKey['k2']![0]!.tools.map((x) => x.name);
    for (const n of ['artifact', 'mark_chapter', 'desktop_open', 'start_session', 'hand_off']) assert.ok(!plainNames.includes(n), n);
  } finally { await t.close(); }
});

test('the base prefix (system prompt and tool definitions of a plain session) stays within its token budget', async () => {
  const t = await setupServer();
  try {
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev = record(s);
    await s.send('[[b]] hi'); await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const req = t.ds.byKey['b']![0]!;
    const tokens = Math.round((req.system.length + JSON.stringify(req.tools).length) / 4);
    // Measured 4,011 before the multi-agent work and 4,047 after (the form field of ask_user,
    // the tools each named agent has), ~4,100 at 0.2.5 and 4,112 with todo_write's activeForm (the
    // chat's live task line); the budget leaves a little room, not a lot.
    assert.ok(tokens <= 4150, `base prefix ~${tokens} tokens (budget 4150)`);
    // A desktop session's additions are bounded too.
    const d = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, client: { kind: 'desktop', version: '1', renderers: ['mermaid'], tools: ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] } });
    const dev = record(d);
    await d.send('[[d]] hi'); await waitFor(() => turnsEnded(dev) === 1, 'desktop turn');
    const dreq = t.ds.byKey['d']![0]!;
    const extra = Math.round((dreq.system.length + JSON.stringify(dreq.tools).length) / 4) - tokens;
    assert.ok(extra <= 1300, `a desktop session adds ~${extra} tokens (budget 1300)`);
  } finally { await t.close(); }
});

test('artifacts: versioned files with events, find/replace updates, the session API (raw is a sandboxed download) and the Library, per owner', async () => {
  const t = await setupServer({ env: { HARNESS_ARTIFACT_MAX_KB: '16' } });
  try {
    const a = await t.member('alice');
    const b = await t.member('bob');
    const ws = await tempDir();
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'acceptEdits', runtime: { kind: 'local', network: 'none', path: ws }, owner: a.id, client: { kind: 'web', version: '', renderers: [], tools: [] } });
    const ev = record(s);
    let id = '';
    t.ds.scripts['art'] = [
      { calls: [{ name: 'artifact', input: { action: 'create', title: 'Sales report', kind: 'markdown', content: '# Sales\nQ1: 10\n' } }] },
      (req) => { id = /Created artifact (\S+) v1/.exec(JSON.stringify(req.messages))![1]!; return { calls: [{ name: 'artifact', input: { action: 'update', id, old_string: 'Q1: 10', new_string: 'Q1: 12' } }] }; },
      () => ({ calls: [{ name: 'artifact', input: { action: 'update', id, old_string: 'not there', new_string: 'x' } }] }),
      () => ({ calls: [{ name: 'artifact', input: { action: 'rewrite', id, content: '# Sales\nQ1: 12\nQ2: 15\n' } }] }),
      () => ({ calls: [{ name: 'artifact', input: { action: 'get', id, version: 1 } }, { name: 'artifact', input: { action: 'list' } }] }),
      { calls: [{ name: 'artifact', input: { action: 'create', title: 'Big', kind: 'markdown', content: 'x'.repeat(20 * 1024) } }, { name: 'artifact', input: { action: 'create', title: 'Page', kind: 'html', content: '<script>alert(1)</script>' } }, { name: 'artifact', input: { action: 'create', title: 'Data', kind: 'json', content: '{bad' } }] },
      { text: 'done' },
    ];
    await s.send('[[art]] make a report');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const results = ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    assert.match(results[1]!.content, /Updated .* v2/);
    assert.ok(results[2]!.is_error && /old_string was not found/.test(results[2]!.content));
    assert.match(results[3]!.content, /Rewrote .* v3/);
    assert.match(results[4]!.content, /v1 markdown: Sales report\n# Sales\nQ1: 10/);
    assert.match(results[5]!.content, new RegExp(`${id} v3 markdown: Sales report`));
    assert.ok(results[6]!.is_error && /at most 16 KB/.test(results[6]!.content), 'size cap');
    assert.ok(results[8]!.is_error && /valid JSON/.test(results[8]!.content));
    const arts = ev.filter((e) => e.kind === 'artifact').map((e) => (e as Extract<HarnessEvent, { kind: 'artifact' }>).artifact);
    assert.deepEqual(arts.filter((x) => x.id === id).map((x) => [x.version, x.action]), [[1, 'create'], [2, 'update'], [3, 'rewrite']]);
    const dir = path.join(ws, '.harness', 'artifacts', id);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['meta.json', 'v1.md', 'v2.md', 'v3.md']);
    assert.equal(await fs.readFile(path.join(dir, 'v2.md'), 'utf8'), '# Sales\nQ1: 12\n');
    // The API, as its owner.
    const list = await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((x: { title: string }) => x.title).sort(), ['Page', 'Sales report']);
    const v1 = await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts/${id}?version=1`);
    assert.equal(v1.body.content, '# Sales\nQ1: 10\n');
    assert.equal(v1.body.version, 1);
    assert.match(v1.body.contentType, /text\/markdown/);
    assert.equal((await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts/${id}?version=9`)).status, 404);
    const page = list.body.find((x: { title: string }) => x.title === 'Page');
    const raw = await t.call(a.token, 'GET', `/api/sessions/${s.meta.id}/artifacts/${page.id}?raw=1`);
    assert.match(raw.headers.get('content-disposition') ?? '', /^attachment/);
    assert.match(raw.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
    // Someone else's session reads as missing.
    assert.equal((await t.call(b.token, 'GET', `/api/sessions/${s.meta.id}/artifacts`)).status, 404);
    // The Library: across the person's sessions, searchable.
    const other = await t.harness.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: b.id });
    await other.artifactStore().create({ title: 'Bob sales', kind: 'csv', content: 'a,b\n1,2\n' });
    const lib = await t.call(a.token, 'GET', '/api/artifacts?query=sales');
    assert.deepEqual(lib.body.map((x: { title: string; sessionId: string }) => [x.title, x.sessionId]), [['Sales report', s.meta.id]]);
    const libB = await t.call(b.token, 'GET', '/api/artifacts');
    assert.deepEqual(libB.body.map((x: { title: string }) => x.title), ['Bob sales']);
    assert.equal((await t.call(OPERATOR, 'GET', '/api/artifacts?limit=1')).body.length, 1, 'limit');
    // A link planted where artifacts live is refused, never followed.
    const ws2 = await tempDir();
    const outside = await tempDir();
    await fs.mkdir(path.join(ws2, '.harness'), { recursive: true });
    await fs.symlink(outside, path.join(ws2, '.harness', 'artifacts'), 'junction');
    const s2 = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws2 }, client: { kind: 'web', version: '', renderers: [], tools: [] } });
    const ev2 = record(s2);
    t.ds.scripts['link'] = [{ calls: [{ name: 'artifact', input: { action: 'create', title: 'x', kind: 'markdown', content: 'y' } }] }, { text: 'ok' }];
    await s2.send('[[link]] go');
    await waitFor(() => turnsEnded(ev2) === 1, 'turn');
    const r2 = ev2.find((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>;
    assert.ok(r2.is_error && /not a plain folder/.test(r2.content), r2.content);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await t.close(); }
});



test('artifacts are edits: asked in default mode, refused in plan mode; get and list are reads', async () => {
  const t = await setupServer();
  try {
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'plan', runtime: { kind: 'local', network: 'none', path: await tempDir() }, client: { kind: 'web', version: '', renderers: [], tools: [] } });
    const ev = record(s);
    t.ds.scripts['p'] = [{ calls: [{ name: 'artifact', input: { action: 'create', title: 'x', kind: 'markdown', content: 'y' } }, { name: 'artifact', input: { action: 'list' } }] }, { text: 'ok' }];
    await s.send('[[p]] go');
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const rs = ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    assert.ok(rs[0]!.is_error && /plan mode/.test(rs[0]!.content));
    assert.match(rs[1]!.content, /No artifacts/);
    s.update({ mode: 'default' });
    t.ds.scripts['p'] = [{ calls: [{ name: 'artifact', input: { action: 'create', title: 'x', kind: 'markdown', content: 'y' } }] }, { text: 'ok' }];
    await s.send('again [[p]]');
    await waitFor(() => ev.some((e) => e.kind === 'permission_request' && e.tool === 'artifact'), 'the edit to be asked');
    const req = ev.find((e) => e.kind === 'permission_request') as Extract<HarnessEvent, { kind: 'permission_request' }>;
    s.respond(req.requestId, { decision: 'allow' });
    await waitFor(() => turnsEnded(ev) === 2, 'turn 2');
    assert.equal((await s.artifactStore().list()).length, 1);
  } finally { await t.close(); }
});

/** A plugin whose UI half has one agent-callable command and one that is the person's only. */
async function uiPlugin(): Promise<string> {
  const dir = path.join(await tempDir(), 'acme-ui');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({
    name: 'acme-ui', version: '1.0.0', description: 'UI commands',
    ui: { contributes: { commands: [
      { id: 'plain', title: 'Plain', action: { type: 'open-view', view: 'x' } },
      { id: 'greet', title: 'Greet', action: { type: 'prompt', prompt: 'hi' }, agent: { description: 'Greets someone in the app', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] } } },
    ] } },
  }));
  return dir;
}

test('desktop tools: forwarded to the attached app and answered once; unattached, timed out, other people\'s answers refused; desktop_command only for agent-callable commands, asked in default mode, refused in plan mode', async () => {
  const t = await setupServer({ plugins: [await uiPlugin()], env: { HARNESS_CLIENT_CALL_MS: '2500' } });
  try {
    const a = await t.member('alice');
    const b = await t.member('bob');
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'default', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: a.id, client: { kind: 'desktop', version: '1', renderers: [], tools: ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] } });
    const ev = record(s);
    const results = () => ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    // Not attached: the tool is unavailable (and says so), nothing is sent.
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_notify', input: { title: 'hello' } }] }, { text: 'ok' }];
    await s.send('[[d]] one');
    await waitFor(() => turnsEnded(ev) === 1, 'turn 1');
    assert.match(results()[0]!.content, /No desktop app is attached to this session/);
    assert.ok(!ev.some((e) => e.kind === 'client_call'));
    // Attached: alice's app listens on the session's stream.
    const app = await t.stream(a.token, `/api/sessions/${s.meta.id}/events?client=desktop`);
    assert.ok(s.clientAttached());
    const bobView = await t.stream(OPERATOR, `/api/sessions/${s.meta.id}/events?client=desktop`);
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_open', input: { target: 'file', path: 'a.md' } }] }, { calls: [{ name: 'desktop_open', input: { target: 'url', url: 'javascript:alert(1)' } }] }, { text: 'ok' }];
    await s.send('[[d]] two');
    await waitFor(() => app.got.some((e) => e.event?.kind === 'client_call'), 'the call to reach the app');
    const callEv = app.got.find((e) => e.event?.kind === 'client_call').event;
    assert.equal(callEv.tool, 'desktop_open');
    assert.deepEqual(callEv.input, { target: 'file', path: 'a.md' });
    assert.ok(!bobView.got.some((e) => e.event?.kind === 'client_call'), 'an administrator watching does not get the owner\'s app calls');
    assert.equal((await t.call(b.token, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: callEv.callId, ok: true, result: 'x' })).status, 404, 'someone else\'s session reads as missing');
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: callEv.callId, ok: true, result: 'x' })).status, 403, 'only the owner answers');
    assert.equal((await t.call(a.token, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: callEv.callId, ok: true, result: { opened: 'a.md' } })).status, 200);
    assert.equal((await t.call(a.token, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: callEv.callId, ok: true, result: 'again' })).status, 404, 'a call is answered once');
    await waitFor(() => turnsEnded(ev) === 2, 'turn 2');
    assert.equal(results()[1]!.content, '{"opened":"a.md"}');
    assert.match(results()[2]!.content, /only http\(s\) URLs/);
    assert.ok(ev.some((e) => e.kind === 'client_call_end' && e.reason === 'answered'));
    // Not answered in time.
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_notify', input: { title: 'slow' } }] }, { text: 'ok' }];
    await s.send('[[d]] three');
    await waitFor(() => turnsEnded(ev) === 3, 'turn 3');
    assert.match(results()[3]!.content, /the desktop did not answer/);
    assert.ok(ev.some((e) => e.kind === 'client_call_end' && e.reason === 'timeout'));
    // desktop_command: unknown and unmarked commands, and bad args, are refused before anything reaches the app.
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_command', input: { command: 'acme-ui:plain' } }, { name: 'desktop_command', input: { command: 'acme-ui:nope' } }, { name: 'desktop_command', input: { command: 'acme-ui:greet', args: {} } }, { name: 'desktop_command', input: { command: 'acme-ui:greet', args: { name: 'Ann' } } }] }, { text: 'ok' }];
    await s.send('[[d]] four');
    // Every desktop_command call is asked in default mode (an action in the person's app); they run one after another.
    const asked = () => ev.filter((e) => e.kind === 'permission_request') as Extract<HarnessEvent, { kind: 'permission_request' }>[];
    for (let i = 1; i <= 4; i++) {
      await waitFor(() => asked().length >= i, `desktop_command ${i} to be asked`);
      s.respond(asked()[i - 1]!.requestId, { decision: 'allow' });
    }
    assert.equal(asked()[0]!.suggestion, 'desktop_command(acme-ui:plain)');
    await waitFor(() => app.got.some((e) => e.event?.kind === 'client_call' && e.event.tool === 'desktop_command'), 'the command to reach the app');
    const cmd = app.got.find((e) => e.event?.kind === 'client_call' && e.event.tool === 'desktop_command').event;
    assert.deepEqual(cmd.input, { command: 'acme-ui:greet', args: { name: 'Ann' } });
    await t.call(a.token, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: cmd.callId, ok: true, result: 'greeted' });
    await waitFor(() => turnsEnded(ev) === 4, 'turn 4');
    const r4 = results().slice(4);
    assert.match(r4[0]!.content, /not agent-callable/);
    assert.match(r4[1]!.content, /No command acme-ui:nope/);
    assert.match(r4[2]!.content, /Invalid args for acme-ui:greet: args\.name: is required/);
    // A plugin the server does not ship is outside content: fenced, and the session counts as having read it.
    assert.match(r4[3]!.content, /<outside_data source="the desktop app \(desktop_command\)">[\s\S]*greeted/);
    assert.ok(s.meta.tainted);
    // An allow rule lets a command through without asking; plan mode refuses it.
    s.update({ mode: 'plan' });
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_command', input: { command: 'acme-ui:greet', args: { name: 'Ann' } } }] }, { text: 'ok' }];
    await s.send('[[d]] five');
    await waitFor(() => turnsEnded(ev) === 5, 'turn 5');
    assert.match(results().at(-1)!.content, /Permission denied: plan mode/);
    app.close(); bobView.close();
    await waitFor(() => !s.clientAttached(), 'the app to detach');
    // Attached through the global stream instead: the call arrives on its client topic.
    s.update({ mode: 'bypass' });
    const global = await t.stream(a.token, '/api/events?client=desktop');
    assert.ok(s.clientAttached());
    t.ds.scripts['d'] = [{ calls: [{ name: 'desktop_describe' }] }, { text: 'ok' }];
    await s.send('[[d]] six');
    await waitFor(() => global.got.some((e) => e.topic === 'client' && e.payload.type === 'call' && e.payload.tool === 'desktop_describe'), 'the call on the global stream');
    const g = global.got.find((e) => e.topic === 'client' && e.payload.type === 'call' && e.payload.tool === 'desktop_describe').payload;
    assert.equal(g.sessionId, s.meta.id);
    await t.call(a.token, 'POST', `/api/sessions/${s.meta.id}/client-result`, { callId: g.callId, ok: true, result: { plugins: [{ name: 'core.chat' }], views: ['core.chat:home'] } });
    await waitFor(() => turnsEnded(ev) === 6, 'turn 6');
    assert.equal(results().at(-1)!.content, '{"plugins":[{"name":"core.chat"}],"views":["core.chat:home"]}', 'first-party plugins only: not fenced');
    global.close();
  } finally { await t.close(); }
});

test('ask_user with a form: the question carries the schema; answers are checked against it (400 with what is wrong); a form that could stall the server is refused', async () => {
  const t = await setupServer();
  try {
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev = record(s);
    const form = { type: 'object', properties: { n: { type: 'integer', minimum: 1 }, size: { type: 'string', enum: ['s', 'm'] } }, required: ['n'] };
    t.ds.scripts['f'] = [{ calls: [{ name: 'ask_user', input: { question: 'How many?', form: { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } } } }, { name: 'ask_user', input: { question: 'How many?', form } }] }, { text: 'ok' }];
    await s.send('[[f]] go');
    await waitFor(() => ev.some((e) => e.kind === 'question'), 'the question');
    const q = ev.find((e) => e.kind === 'question') as Extract<HarnessEvent, { kind: 'question' }>;
    assert.deepEqual(q.form, form);
    const id = s.meta.id;
    const bad1 = await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q.requestId, decision: 'answer', answer: { n: 0 } });
    assert.equal(bad1.status, 400);
    assert.match(bad1.body.error, /answer\.n: at least 1/);
    const bad2 = await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q.requestId, decision: 'answer', answer: { n: 2, size: 'xl', extra: 1 } });
    assert.match(bad2.body.error, /size: must be one of[\s\S]*extra: is not a field/);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q.requestId, decision: 'answer', answer: 'not json' })).status, 400);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q.requestId, decision: 'answer', answer: { n: 3, size: 'm' } })).status, 200);
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const rs = ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[];
    assert.match(rs[0]!.content, /form is not usable: pattern could take too long/);
    assert.equal(rs[1]!.content, 'The user answered: {"n":3,"size":"m"}');
  } finally { await t.close(); }
});

test('a question answered from the app: suggested answers with their descriptions; a reply in words instead of the form, a skip with a note, an answer with a note', async () => {
  const t = await setupServer();
  try {
    const s = await t.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ev = record(s);
    const form = { type: 'object', properties: { entries: { type: 'array', items: { type: 'string', enum: ['ollama-tunnel', 'updater'] } } } };
    const options = [{ label: 'Disable all', description: 'Reversible', recommended: true }, { label: 'Keep all' }];
    t.ds.scripts['q'] = [{ calls: [{ name: 'ask_user', input: { question: 'What to disable?', options, form } }, { name: 'ask_user', input: { question: 'Uninstall the VPNs?', options: ['Yes', 'No'] } }, { name: 'ask_user', input: { question: 'Which?', form } }] }, { text: 'ok' }];
    await s.send('[[q]] go');
    const id = s.meta.id;
    const nth = async (n: number) => { await waitFor(() => ev.filter((e) => e.kind === 'question').length >= n, `question ${n}`); return ev.filter((e) => e.kind === 'question')[n - 1] as Extract<HarnessEvent, { kind: 'question' }>; };
    const q1 = await nth(1);
    assert.deepEqual(q1.choices, [{ label: 'Disable all', description: 'Reversible', recommended: true }, { label: 'Keep all' }]);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q1.requestId, decision: 'reply', feedback: 'Disable all' })).status, 200);
    const q2 = await nth(2);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q2.requestId, decision: 'deny', feedback: 'decide later' })).status, 200);
    const q3 = await nth(3);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${id}/respond`, { requestId: q3.requestId, decision: 'answer', answer: { entries: ['updater'] }, feedback: 'not the tunnel' })).status, 200);
    await waitFor(() => turnsEnded(ev) === 1, 'turn');
    const rs = (ev.filter((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>[]).map((r) => r.content);
    assert.match(rs[0]!, /did not pick a suggested answer or fill in the form; they wrote: Disable all/);
    assert.match(rs[1]!, /skipped this question and said: decide later/);
    assert.equal(rs[2], 'The user answered: {"entries":["updater"]}\nTheir note: not the tunnel');
  } finally { await t.close(); }
});
