import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { exportSession } from '../src/core/portable.ts';
import { decide, suggestRule } from '../src/core/permissions.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { run } from '../src/runtime/host.ts';
import { createApp } from '../src/server/app.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { bashTool } from '../src/tools/exec.ts';
import { AwsBackend, AzureBackend, HashiCorpBackend } from '../src/vault/backends.ts';
import { Redactor, secretForms } from '../src/vault/redact.ts';
import { signV4 } from '../src/vault/sigv4.ts';
import { KEEP_VERSIONS, VaultStore } from '../src/vault/store.ts';
import { vaultTool } from '../src/vault/tool.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { FakeProvider, makeAgent, results, tempDir } from './helpers.ts';

const KEY_A = { HARNESS_SECRET_KEY: 'a'.repeat(40) };
const KEY_B = { HARNESS_SECRET_KEY: 'b'.repeat(40) };

/** Every form a value must never appear in. */
const leaks = (text: string, value: string) => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url'), encodeURIComponent(value)].filter((f) => text.includes(f));

test('the redactor hides a value and its base64 (at any alignment), URL-encoded, JSON and PEM-line forms', () => {
  const r = new Redactor();
  const v = 'S3cr3t/Value+123&x';
  r.add('api-token', v);
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const out = r.redact([
    `plain ${v} end`,
    `b64 ${b64(v)}`,
    `basic ${b64(`user:${v}`)}`,
    `shifted ${b64(`ab${v}`)} ${b64(`a${v}`)}`,
    `url ${encodeURIComponent(v)}`,
    `json ${JSON.stringify({ t: v })}`,
  ].join('\n'));
  assert.deepEqual(leaks(out, v), [], out);
  // Inside a longer base64 text only the value's own groups are certain; at most a few characters are left beside the label.
  for (const pre of ['user:', 'ab', 'a']) assert.ok(!out.includes(b64(pre + v).slice(Math.ceil(pre.length / 3) * 4, -4)), `the value's part of base64(${pre}...) is gone`);
  assert.match(out, /\[vault:api-token\]/);
  assert.equal(r.redact('nothing secret here'), 'nothing secret here');

  // A PEM key printed one line at a time, or with other line endings.
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  r.add('deploy-key', pem);
  const body = pem.split('\n')[1]!;
  assert.ok(!r.redact(`line: ${body}`).includes(body));
  assert.ok(!r.redact(pem.replace(/\n/g, '\r\n')).includes(body));

  // Deep: objects and arrays are copied only where they change; signed provider blocks and images are left alone.
  const msg = { role: 'assistant', content: [{ type: 'text', text: `x ${v}` }, { type: 'thinking', thinking: v, signature: 'sig' }], raw: { payload: { content: v } } };
  const clean = r.redactDeep(msg);
  assert.equal(clean.content[1], msg.content[1], 'signed block untouched');
  assert.equal(JSON.stringify(clean.content[0]).includes(v), false);
  assert.equal(JSON.stringify(clean.raw).includes(v), false);
  const same = { a: 'ok' };
  assert.equal(r.redactDeep(same), same);
  // Bytes: a binary file keeps its other bytes.
  const bin = Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from(v), Buffer.from([0xfe])]);
  const red = r.redactBytes(bin);
  assert.ok(!red.includes(Buffer.from(v)));
  assert.deepEqual([...red.subarray(0, 3)], [0, 255, 1]);
  assert.equal(red.at(-1), 0xfe);
  // Too short to tell apart from ordinary text: not registered (the vault refuses such values).
  const r2 = new Redactor();
  r2.add('pin', '1234');
  assert.equal(r2.size, 0);
  assert.ok(secretForms(v).includes(encodeURIComponent(v)));
});

test('SigV4 matches AWS\'s published test vectors (get-vanilla, post-vanilla, IAM ListUsers)', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const date = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
  const sig = (method: string, url: string, service: string, headers: Record<string, string> = {}) => signV4({ method, url, headers, region: 'us-east-1', service, credentials, date }).authorization;
  assert.equal(sig('GET', 'https://example.amazonaws.com/', 'service'), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(sig('POST', 'https://example.amazonaws.com/', 'service'), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');
  assert.equal(sig('GET', 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', 'iam', { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('local storage: sealed at rest with a fresh IV each, versions kept for rollback, a wrong server key is a clear error', async () => {
  const dataDir = await tempDir();
  const v = await new VaultStore({ dataDir, env: KEY_A }).load();
  const me = { account: 'usr_a' };
  await v.put(me, { name: 'db', value: 'first-value-1', kind: 'password' });
  await v.put(me, { name: 'twin', value: 'first-value-1' });
  const raw = await fs.readFile(path.join(dataDir, 'vault', 'entries.json'), 'utf8');
  assert.ok(!raw.includes('first-value-1'), 'never in clear on disk');
  const handles = (JSON.parse(raw).entries as { current: { handle: string } }[]).map((e) => e.current.handle);
  assert.ok(handles.every((h) => h.startsWith('aes256gcm:v1:')));
  assert.notEqual(handles[0], handles[1], 'the same value seals differently (a random IV per value)');
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dataDir, 'vault', 'entries.json'))).mode & 0o777, 0o600);

  // Rotations: a new strong value each time, the earlier ones kept (at most KEEP_VERSIONS) and readable.
  for (let i = 0; i < KEEP_VERSIONS + 2; i++) await v.rotate(me, 'db');
  const h = v.history(me, 'db');
  assert.equal(h.length, KEEP_VERSIONS + 1);
  assert.equal(h[0]!.current, true);
  assert.equal(h[0]!.version, KEEP_VERSIONS + 3);
  const current = await v.reveal(me, 'db', 'test');
  const previous = await v.reveal(me, 'db', 'test', { version: h[1]!.version });
  assert.notEqual(current, previous);
  assert.ok(current.length >= 24);
  const back = await v.rollback(me, 'db', h[1]!.version);
  assert.equal(await v.reveal(me, 'db', 'test'), previous, 'rolled back');
  assert.equal(back.version, KEEP_VERSIONS + 4, 'a rollback is a new version: nothing is lost');
  await assert.rejects(v.reveal(me, 'db', 'test', { version: 1 }), /has no version 1/);

  // Another server key cannot read it, and says why.
  const other = await new VaultStore({ dataDir, env: KEY_B }).load();
  await assert.rejects(other.reveal(me, 'db', 'test'), /vault entry "db": cannot decrypt: the server key \(HARNESS_SECRET_KEY or secret.key\) is not the one it was sealed with/);
  await assert.rejects(v.put(me, { name: 'short', value: '12345' }), /at least 6 characters/);
  await assert.rejects(v.put(me, { name: '../x', value: 'long-enough' }), /a vault name/);
});

test('access: operator scope is written by administrators only, an account never sees another\'s entries, session scope stays in its session; the audit has no values', async () => {
  const dataDir = await tempDir();
  const v = await new VaultStore({ dataDir, env: KEY_A }).load();
  const admin = { admin: true, label: 'operator' };
  const alice = { account: 'usr_alice' };
  const bob = { account: 'usr_bob' };
  await v.put(admin, { name: 'shared-ci', value: 'operator-value-1', scope: 'operator' });
  await assert.rejects(v.put(alice, { name: 'x', value: 'member-value-1', scope: 'operator' }), /only administrators/);
  await assert.rejects(v.put({ ...admin, session: 's1' }, { name: 'x', value: 'from-a-session', scope: 'operator' }), /only administrators/);
  await v.put(alice, { name: 'alice-token', value: 'alice-secret-1' });
  await v.put({ account: 'usr_alice', session: 'sess1' }, { name: 'temp', value: 'session-only-1', scope: 'session' });

  assert.deepEqual(v.list(bob).map((e) => e.name), ['shared-ci']);
  assert.deepEqual(v.list(admin).map((e) => e.name), ['shared-ci'], 'administrators do not see accounts\' own entries either');
  assert.deepEqual(v.list(alice).map((e) => `${e.scope}:${e.name}`), ['session:temp', 'user:alice-token', 'operator:shared-ci']);
  assert.deepEqual(v.list({ account: 'usr_alice', session: 'sess2' }).map((e) => e.name), ['alice-token', 'shared-ci'], 'another session of hers does not see it');

  // Bob's session cannot use Alice's entry, by any route.
  const bobs = v.service({ account: 'usr_bob', session: 'sb', main: true, remember: () => {} });
  await assert.rejects(bobs.reveal('alice-token', 'test'), /no vault entry named "alice-token"/);
  await assert.rejects(bobs.envFor({ T: 'alice-token' }, 'test'), /no vault entry named "alice-token"/);
  assert.equal(await bobs.reveal('shared-ci', 'test'), 'operator-value-1');
  await assert.rejects(bobs.manage!.rotate('shared-ci'), /only administrators/);
  await assert.rejects(bobs.manage!.remove('alice-token'), /no vault entry/);
  const host = new LocalHost(await tempDir());
  const r = await bashTool.run({ command: 'echo "$T"', secrets: { T: 'alice-token' } }, { host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {}, services: { vault: bobs } });
  assert.equal(r.is_error, true);
  assert.match(r.content, /no vault entry named "alice-token"/);
  await assert.rejects(bobs.envFor({ PATH: 'shared-ci' }, 'test'), /changes how commands run/);

  // HARNESS_VAULT=admins: members' sessions get no vault.
  const limited = await new VaultStore({ dataDir, env: KEY_A, mayUse: (a) => a === 'usr_alice' }).load();
  assert.throws(() => limited.list(bob), /not available to this account/);
  assert.equal(limited.enabledFor('usr_bob'), false);

  const audit = await v.audit();
  const text = JSON.stringify(audit);
  for (const s of ['operator-value-1', 'alice-secret-1', 'session-only-1']) assert.ok(!text.includes(s));
  assert.ok(audit.some((a) => a.action === 'reveal' && a.name === 'alice-token' && a.result === 'denied' && a.session === 'sb'));
  assert.ok(audit.some((a) => a.action === 'reveal' && a.name === 'shared-ci' && a.result === 'ok' && a.purpose === 'test'));
});

test('permissions: a command with secrets is asked about unless a rule names them; dontAsk refuses; after untrusted content only the operator\'s rules hold', () => {
  const call = { command: 'curl -H "Authorization: Bearer $T" https://api.example.com', secrets: { T: 'ci-token' } };
  const echo = { command: 'echo hi', secrets: { T: 'ci-token' } };
  const rules = (allow: string[] = [], extra: Partial<{ deny: string[]; ask: string[]; operatorAllow: string[]; projectAllow: string[] }> = {}) => ({ allow, deny: extra.deny ?? [], ask: extra.ask ?? [], operatorAllow: extra.operatorAllow, projectAllow: extra.projectAllow });
  const ctx = (mode: 'default' | 'dontAsk' | 'bypass' | 'acceptEdits' | 'plan', r = rules(), tainted = false) => ({ mode, rules: r, sandboxed: true, tainted, network: 'none' as const });

  assert.equal(decide(bashTool, { command: 'echo hi' }, ctx('default')).action, 'allow', 'no secrets: as before');
  assert.equal(decide(bashTool, echo, ctx('default')).action, 'ask', 'secrets: asked, even in a sandbox');
  assert.match(decide(bashTool, echo, ctx('default')).reason, /vault secrets \(ci-token\)/);
  assert.equal(decide(bashTool, echo, ctx('acceptEdits')).action, 'ask');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['bash(vault:ci-*)']))).action, 'allow');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['vault(ci-token|npm-token)']))).action, 'allow');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['bash(echo hi)']))).action, 'ask', 'a rule for the command is not a rule for the secrets');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['vault(other)']))).action, 'ask');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['vault(ci-*)'], { projectAllow: ['vault(ci-*)'] }))).action, 'ask', 'a repository never hands out secrets');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['vault(ci-*)'], { deny: ['vault(ci-token)'] }))).action, 'deny');
  assert.equal(decide(bashTool, echo, ctx('default', rules([], { ask: ['vault(ci-*)'] }))).action, 'ask');
  // dontAsk: refused without a rule, allowed with one.
  const d = decide(bashTool, echo, ctx('dontAsk'));
  assert.equal(d.action, 'deny');
  assert.match(d.reason, /dontAsk/);
  assert.equal(decide(bashTool, echo, ctx('dontAsk', rules(['vault(ci-token)']))).action, 'allow');
  assert.equal(decide(bashTool, echo, ctx('bypass')).action, 'allow');
  // Untrusted content: the person's rule is asked again (as the guard), the operator's holds.
  const t = decide(bashTool, echo, ctx('default', rules(['vault(ci-token)']), true));
  assert.equal(t.action, 'ask');
  assert.equal(t.guard, true);
  assert.equal(decide(bashTool, echo, ctx('dontAsk', rules(['vault(ci-token)']), true)).action, 'deny');
  assert.equal(decide(bashTool, echo, ctx('default', rules(['vault(ci-token)'], { operatorAllow: ['vault(ci-token)'] }), true)).action, 'allow');
  // The command itself is still decided as a command (a real machine asks).
  assert.equal(decide(bashTool, call, { ...ctx('default', rules(['vault(ci-token)'])), sandboxed: false }).action, 'ask');
  assert.equal(bashTool.sendsOut instanceof Function && bashTool.sendsOut(echo), true, 'a command holding a secret is a way out');
  assert.equal(suggestRule(bashTool, { command: 'x', secrets: { A: 'a', B: 'b', C: 'a' } }), 'bash(vault:a|b)');

  // The vault tool: writes are edits that persist; delete asks even when edits are accepted; plan mode refuses.
  assert.equal(decide(vaultTool, { action: 'list' }, ctx('plan')).action, 'allow');
  assert.equal(decide(vaultTool, { action: 'generate', name: 'x' }, ctx('default')).action, 'ask');
  assert.equal(decide(vaultTool, { action: 'generate', name: 'x' }, ctx('acceptEdits')).action, 'allow');
  assert.equal(decide(vaultTool, { action: 'generate', name: 'x' }, ctx('plan')).action, 'deny');
  assert.equal(decide(vaultTool, { action: 'delete', name: 'x' }, ctx('acceptEdits')).action, 'ask');
  const g = decide(vaultTool, { action: 'set', name: 'x', value: 'abcdefgh' }, ctx('acceptEdits', rules(), true));
  assert.equal(g.action, 'ask');
  assert.equal(g.guard, true);
});

/** A session whose turn the FakeProvider scripts; resolves at the main turn's end. */
async function turn(s: { send(t: string): Promise<unknown>; subscribe(after: number, fn: (e: { event: HarnessEvent }) => void): () => void }, text: string) {
  const done = new Promise<void>((r) => { const off = s.subscribe(Number.MAX_SAFE_INTEGER, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) { off(); r(); } }); });
  await s.send(text);
  await done;
}

test('a secret used in a command that prints it never reaches the model, the events, the trace, hooks, the history or an export - nor does one the model stored itself', async () => {
  const dataDir = await tempDir();
  const token = 'S3cr3t/Value+123&x';
  const modelMade = 'model-made-Pa55word!';
  const print = `node -e "const t=process.env.TOKEN; console.log(t); console.log(Buffer.from(t).toString('base64')); console.log(Buffer.from('user:'+t).toString('base64')); console.log(encodeURIComponent(t)); require('fs').writeFileSync('leak.txt', 'token=' + t)"`;
  const h = await createHarness({ dataDir, search: null, memory: 'off', vault: { env: KEY_A } });
  const fake = new FakeProvider([
    { calls: [{ name: 'vault', input: { action: 'list' } }] },
    { calls: [{ name: 'bash', input: { command: print, secrets: { TOKEN: 'api-token' } } }] },
    { calls: [{ name: 'read', input: { path: 'leak.txt' } }] },
    { calls: [{ name: 'vault', input: { action: 'set', name: 'db-pass', value: modelMade, kind: 'password' } }] },
    { calls: [{ name: 'bash', input: { command: 'echo "pw=$PW"', secrets: { PW: 'db-pass' } } }] },
    { text: `All done.` },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  const hooked: string[] = [];
  h.registry.hooks.push({ event: 'PostToolUse', plugin: 'test', handler: (p) => { hooked.push(JSON.stringify(p)); } });
  try {
    await h.vault!.put({}, { name: 'api-token', value: token, kind: 'token', description: 'the API' });
    const s = await h.sessions.create({ title: 'secrets', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none' } });
    const events: string[] = [];
    s.subscribe(0, ({ event }) => events.push(JSON.stringify(event)));
    await turn(s, 'use the token');

    // Each request as it was sent (the snapshots: a request's message list grows afterwards).
    const bodies = fake.requests.map((r, i) => `${r.system}\n${fake.snapshots[i]}`);
    const last = (i: number) => JSON.stringify((JSON.parse(fake.snapshots[i]!) as unknown[]).at(-1));
    assert.equal(bodies.length, 6);
    for (const [i, b] of bodies.entries()) {
      assert.deepEqual(leaks(b, token), [], `request ${i} leaks the token`);
      assert.ok(!b.includes(Buffer.from(`user:${token}`).toString('base64').slice(8, -4)), `request ${i} leaks base64(user:token)`);
      if (i >= 4) assert.ok(!b.includes(modelMade), `request ${i} still carries the value the model stored`);
    }
    const shown = last(2);
    assert.match(shown, /\[vault:api-token\]/, 'the model sees where the value was');
    assert.match(last(3), /token=\[vault:api-token\]/, 'a file the command wrote is read back hidden');
    assert.match(last(5), /pw=\[vault:db-pass\]/);
    assert.match(last(1), /api-token \(token, user scope/, 'list shows names and metadata');

    const all = [events.join('\n'), hooked.join('\n'), await fs.readFile(path.join(dataDir, 'sessions', s.meta.id, 'trace.jsonl'), 'utf8'), await fs.readFile(path.join(dataDir, 'sessions', s.meta.id, 'history.jsonl'), 'utf8'), await fs.readFile(path.join(dataDir, 'sessions', s.meta.id, 'meta.json'), 'utf8')];
    for (const [i, text] of all.entries()) {
      assert.deepEqual(leaks(text, token), [], `place ${i} leaks the token`);
      assert.ok(!text.includes(modelMade), `place ${i} leaks the model's value`);
    }
    assert.ok(hooked.length >= 4, 'hooks ran');
    assert.ok(hooked.some((x) => x.includes('[vault:db-pass]')), 'a hook sees the call, with the value hidden');
    assert.equal(await h.vault!.reveal({}, 'db-pass', 'test'), modelMade, 'the vault holds what the model stored');
    assert.deepEqual(s.meta.vaultNames?.sort(), ['api-token', 'db-pass']);
    // The workspace file still holds the value (the command wrote it); the export does not.
    assert.match(await fs.readFile(path.join(s.workspace, 'leak.txt'), 'utf8'), /S3cr3t/);
    const bundle = JSON.stringify(await exportSession(s));
    assert.deepEqual(leaks(bundle, token), []);
    assert.ok(!bundle.includes(modelMade));
    const file = (JSON.parse(bundle).files as { path: string; data: string }[]).find((f) => f.path === 'leak.txt')!;
    assert.equal(Buffer.from(file.data, 'base64').toString(), 'token=[vault:api-token]');
    const audit = await h.vault!.audit();
    assert.ok(audit.some((a) => a.action === 'reveal' && a.name === 'api-token' && a.tool === 'bash' && a.session === s.meta.id && /^bash: node -e/.test(a.purpose ?? '')));
    assert.ok(!JSON.stringify(audit).includes(token) && !JSON.stringify(audit).includes(modelMade));
  } finally { await h.close(); }

  // After a restart the session hides them again (the names were kept; the values come back from the vault).
  const h2 = await createHarness({ dataDir, search: null, memory: 'off', vault: { env: KEY_A } });
  try {
    const s2 = h2.sessions.list()[0]!;
    const bundle = JSON.stringify(await exportSession(h2.sessions.get(s2.id)!));
    assert.deepEqual(leaks(bundle, token), [], 'hidden after a restart too');
  } finally { await h2.close(); }
});

test('a plugin reaches only the vault names its manifest declared; a value it returns is still hidden; its rotation handler rotates', async () => {
  const root = await tempDir();
  const dir = path.join(root, 'vaulty');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'vaulty', main: 'index.mjs', permissions: { vault: ['ci-*'] } }));
  await fs.writeFile(path.join(dir, 'index.mjs'), `export default { name: 'vaulty', setup(api) {
    api.registerTool({ name: 'peek', description: 'reads a vault entry', parameters: { type: 'object', properties: { name: { type: 'string' } } }, kind: 'read',
      run: async (input, ctx) => { const v = await ctx.services.vault.reveal(input.name, 'signing a request'); return 'got ' + v; } });
    api.registerVaultRotation({ prefix: 'ci-', rotate: async ({ current, generated }) => { globalThis.__rotatedFrom = await current(); return 'rotated-' + generated.slice(0, 10); } });
  } };`);
  const h = await createHarness({ dataDir: await tempDir(), plugins: [root], search: null, memory: 'off', vault: { env: KEY_A } });
  const fake = new FakeProvider([
    { calls: [{ name: 'peek', input: { name: 'prod-db' } }, { name: 'peek', input: { name: 'ci-token' } }] },
    { text: 'ok' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    assert.deepEqual(h.registry.plugins.find((p) => p.name === 'vaulty')!.permissions, { network: [], secrets: [], vault: ['ci-*'] });
    await h.vault!.put({}, { name: 'prod-db', value: 'prod-db-password' });
    await h.vault!.put({}, { name: 'ci-token', value: 'ci-token-value-9' });
    const s = await h.sessions.create({ title: 'p', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none' } });
    await turn(s, 'peek');
    const last = JSON.stringify((JSON.parse(fake.snapshots[1]!) as unknown[]).at(-1));
    assert.match(last, /vaulty may not use the vault entry \\"prod-db\\": it is not in its harness-plugin.json permissions.vault/);
    assert.match(last, /got \[vault:ci-token\]/, 'a plugin that returns a value still cannot show it');
    assert.ok(!fake.snapshots.join('').includes('ci-token-value-9'));
    const audit = await h.vault!.audit();
    assert.ok(audit.some((a) => a.plugin === 'vaulty' && a.name === 'prod-db' && a.result === 'denied'));
    assert.ok(audit.some((a) => a.plugin === 'vaulty' && a.name === 'ci-token' && a.result === 'ok' && a.purpose === 'signing a request'));

    const info = await h.vault!.rotate({}, 'ci-token', { grantsFor: (p) => h.registry.plugins.find((x) => x.name === p)?.permissions?.vault ?? [] });
    assert.equal(info.version, 2);
    assert.equal((globalThis as { __rotatedFrom?: string }).__rotatedFrom, 'ci-token-value-9', 'the handler read the value it declared');
    assert.match(await h.vault!.reveal({}, 'ci-token', 'test'), /^rotated-/);
    // prod-db is not the plugin's: a password rotates to a generated value with no handler involved.
    await h.vault!.rotate({}, 'prod-db');
    assert.notEqual(await h.vault!.reveal({}, 'prod-db', 'test'), 'prod-db-password');
  } finally { await h.close(); }
});

test('the vault tool: generate never shows the value, entries past rotation are flagged at session start and in list, writes need the main agent', async () => {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', vault: { env: KEY_A } });
  const fake = new FakeProvider([
    { calls: [{ name: 'vault', input: { action: 'generate', name: 'new-db', kind: 'password', description: 'for the app user' } }] },
    { calls: [{ name: 'vault', input: { action: 'generate', name: 'deploy', kind: 'ssh-key' } }] },
    { calls: [{ name: 'vault', input: { action: 'list' } }] },
    { calls: [{ name: 'vault', input: { action: 'history', name: 'new-db' } }] },
    { calls: [{ name: 'vault', input: { action: 'delete', name: 'new-db' } }] },
    { text: 'done' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    await h.vault!.put({}, { name: 'old-key', value: 'old-key-value-1', rotateBy: Date.now() - 86_400_000 });
    const s = await h.sessions.create({ title: 'v', model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none' } });
    const notices: string[] = [];
    s.subscribe(0, ({ event }) => { if (event.kind === 'notice') notices.push(event.text); });
    await turn(s, 'make a password');
    assert.ok(notices.some((n) => /Key vault: old-key \(user\) is past the rotation date/.test(n)), notices.join('\n'));
    const out = (i: number) => JSON.stringify((JSON.parse(fake.snapshots[i]!) as unknown[]).at(-1));
    assert.match(out(1), /Generated new-db \(password, user scope, version 1/);
    const generated = await h.vault!.reveal({}, 'deploy', 'test');
    assert.match(generated, /BEGIN PRIVATE KEY/);
    assert.match(out(2), /ssh-ed25519 AAAA/);
    assert.match(out(3), /old-key .*ROTATION OVERDUE/);
    assert.match(out(4), /version 1 \(current\)/);
    assert.match(out(5), /Deleted new-db/);
    assert.ok(!fake.snapshots.join('').includes(generated.split('\n')[1]!), 'the private key never reached the model');
    assert.deepEqual(h.vault!.list({}).map((e) => e.name).sort(), ['deploy', 'old-key']);
  } finally { await h.close(); }
});

test('the REST API: values go in and never come out; members are kept to their own; the audit is for administrators', async () => {
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', vault: { env: KEY_A } });
  const { server } = createApp({ harness, token: 'op-token', loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users, spend: await new SpendLedger(data).load() });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  try {
    const alice = (await users.add('Alice')).token;
    const bob = (await users.add('Bob')).token;
    const made = await call(alice, 'POST', '/api/vault/entries', { name: 'gh-token', value: 'ghp_alice_secret_1', kind: 'token', rotateEveryDays: 30 });
    assert.equal(made.status, 201, made.text);
    assert.ok(!made.text.includes('ghp_alice_secret_1'));
    assert.equal(made.body.version, 1);
    assert.ok(made.body.rotateBy > Date.now());
    assert.equal((await call(alice, 'POST', '/api/vault/entries', { name: 'gh-token', value: 'again-value' })).status, 409);
    assert.equal((await call(alice, 'PUT', '/api/vault/entries/gh-token', { value: 'ghp_alice_secret_2' })).body.version, 2);
    assert.equal((await call(alice, 'POST', '/api/vault/entries', { name: 'ops', value: 'operator-only', scope: 'operator' })).status, 403);
    assert.equal((await call('op-token', 'POST', '/api/vault/entries', { name: 'ops', value: 'operator-only', scope: 'operator' })).status, 201);
    const gen = await call(alice, 'POST', '/api/vault/entries', { name: 'pw', generate: true, kind: 'password' });
    assert.equal(gen.status, 201);
    assert.equal(gen.body.kind, 'password');

    const mine = await call(alice, 'GET', '/api/vault/entries');
    assert.deepEqual(mine.body.entries.map((e: { name: string }) => e.name).sort(), ['gh-token', 'ops', 'pw']);
    assert.ok(!mine.text.includes('ghp_alice') && !mine.text.includes('handle') && !mine.text.includes('aes256gcm'));
    const theirs = await call(bob, 'GET', '/api/vault/entries');
    assert.deepEqual(theirs.body.entries.map((e: { name: string }) => e.name), ['ops']);
    assert.equal((await call(bob, 'DELETE', '/api/vault/entries/gh-token')).status, 404);
    assert.equal((await call(bob, 'POST', '/api/vault/entries/gh-token/rotate')).status, 404);

    const hist = await call(alice, 'GET', '/api/vault/entries/gh-token/history');
    assert.deepEqual(hist.body.map((x: { version: number }) => x.version), [2, 1]);
    const rot = await call(alice, 'POST', '/api/vault/entries/gh-token/rotate', {});
    assert.equal(rot.body.version, 3);
    const rb = await call(alice, 'POST', '/api/vault/entries/gh-token/rollback', { version: 1 });
    assert.equal(rb.body.version, 4);
    assert.equal(await harness.vault!.reveal({ account: users.list().find((u) => u.name === 'Alice')!.id }, 'gh-token', 'test'), 'ghp_alice_secret_1');

    assert.equal((await call(alice, 'GET', '/api/vault/audit')).status, 403);
    const audit = await call('op-token', 'GET', '/api/vault/audit');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.length >= 6);
    assert.ok(!audit.text.includes('ghp_alice_secret') && !audit.text.includes('operator-only'));
    assert.equal((await call(alice, 'DELETE', '/api/vault/entries/gh-token')).status, 200);
    assert.equal((await call(alice, 'GET', '/api/vault/entries')).body.entries.length, 2);
  } finally { await new Promise<void>((r) => server.close(() => r())); await harness.close(); }
});

/** A local stand-in for Azure Key Vault and its token endpoint: checks the client-credentials grant, the bearer token and the API version. */
async function azureMock() {
  const secrets = new Map<string, { version: string; value: string }[]>();
  const seen: string[] = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url!, 'http://x');
    seen.push(`${req.method} ${u.pathname}`);
    const reply = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.pathname === '/tenant-1/oauth2/v2.0/token') {
      const f = new URLSearchParams(body);
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded' || f.get('grant_type') !== 'client_credentials' || f.get('client_id') !== 'app-1' || f.get('client_secret') !== 'app-secret' || f.get('scope') !== 'https://vault.azure.net/.default') return reply(401, { error: 'invalid_client' });
      return reply(200, { access_token: 'azure-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (req.headers.authorization !== 'Bearer azure-access-token') return reply(401, { error: { code: 'Unauthorized' } });
    if (u.searchParams.get('api-version') !== '7.4') return reply(400, { error: { code: 'BadParameter' } });
    const m = /^\/secrets\/([A-Za-z0-9-]+)(?:\/([a-f0-9]+))?$/.exec(u.pathname);
    if (!m) return reply(404, {});
    const list = secrets.get(m[1]!) ?? [];
    if (req.method === 'PUT') {
      const version = crypto.randomBytes(16).toString('hex');
      list.push({ version, value: JSON.parse(body).value });
      secrets.set(m[1]!, list);
      return reply(200, { id: `https://vault.example/secrets/${m[1]}/${version}` });
    }
    if (req.method === 'GET') {
      const hit = m[2] ? list.find((x) => x.version === m[2]) : list.at(-1);
      return hit ? reply(200, { value: hit.value, id: `x/${hit.version}` }) : reply(404, { error: { code: 'SecretNotFound' } });
    }
    if (req.method === 'DELETE') { secrets.delete(m[1]!); return reply(200, {}); }
    reply(405, {});
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, secrets, seen, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A local stand-in for AWS Secrets Manager that recomputes every request's SigV4 signature. */
async function awsMock(creds: { accessKeyId: string; secretAccessKey: string }) {
  const secrets = new Map<string, { id: string; value: string }[]>();
  const auth: string[] = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const reply = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/x-amz-json-1.1' }); res.end(JSON.stringify(j)); };
    const a = String(req.headers.authorization ?? '');
    auth.push(a);
    const when = String(req.headers['x-amz-date'] ?? '');
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([a-z0-9-]+)\/secretsmanager\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(a);
    if (!m || m[1] !== creds.accessKeyId || !/^\d{8}T\d{6}Z$/.test(when) || m[2] !== when.slice(0, 8)) return reply(403, { __type: 'IncompleteSignatureException' });
    const date = new Date(Date.UTC(+when.slice(0, 4), +when.slice(4, 6) - 1, +when.slice(6, 8), +when.slice(9, 11), +when.slice(11, 13), +when.slice(13, 15)));
    const expected = signV4({ method: 'POST', url: `http://${req.headers.host}/`, body, region: m[3]!, service: 'secretsmanager', credentials: creds, date, headers: { 'content-type': String(req.headers['content-type']), 'x-amz-target': String(req.headers['x-amz-target']) } }).authorization;
    if (expected !== a) return reply(403, { __type: 'SignatureDoesNotMatch' });
    const j = JSON.parse(body) as Record<string, string>;
    const target = String(req.headers['x-amz-target']);
    if (target === 'secretsmanager.PutSecretValue') {
      const list = secrets.get(j.SecretId!);
      if (!list) return reply(400, { __type: 'ResourceNotFoundException' });
      list.push({ id: j.ClientRequestToken!, value: j.SecretString! });
      return reply(200, { VersionId: j.ClientRequestToken });
    }
    if (target === 'secretsmanager.CreateSecret') { secrets.set(j.Name!, [{ id: j.ClientRequestToken!, value: j.SecretString! }]); return reply(200, { VersionId: j.ClientRequestToken }); }
    if (target === 'secretsmanager.GetSecretValue') {
      const list = secrets.get(j.SecretId!) ?? [];
      const hit = j.VersionId ? list.find((x) => x.id === j.VersionId) : list.at(-1);
      return hit ? reply(200, { SecretString: hit.value, VersionId: hit.id }) : reply(400, { __type: 'ResourceNotFoundException' });
    }
    if (target === 'secretsmanager.DeleteSecret') { secrets.delete(j.SecretId!); return reply(200, {}); }
    reply(400, { __type: 'UnknownOperationException' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, secrets, auth, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('Azure Key Vault (client credentials) and AWS Secrets Manager (SigV4) backends round-trip against local stand-ins', async () => {
  const az = await azureMock();
  const awsCreds = { accessKeyId: 'AKIDTEST', secretAccessKey: 'aws-test-secret-key' };
  const aws = await awsMock(awsCreds);
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1,localhost';
  try {
    const env = { ...KEY_A, AZ_SECRET: 'app-secret', AWS_ACCESS_KEY_ID: awsCreds.accessKeyId, AWS_SECRET_ACCESS_KEY: awsCreds.secretAccessKey };
    const v = await new VaultStore({ dataDir: await tempDir(), env, backends: {
      akv: { type: 'azure', vaultUrl: az.url, authorityHost: az.url, tenantId: 'tenant-1', clientId: 'app-1', clientSecret: '${AZ_SECRET}' },
      sm: { type: 'aws', region: 'eu-west-1', endpoint: aws.url },
    } }).load();
    for (const backend of ['akv', 'sm']) {
      const me = { account: 'usr_x' };
      const name = `app/${backend}-db`;
      await v.put(me, { name, value: `${backend}-first-value`, backend });
      await v.put(me, { name, value: `${backend}-second-value` });
      assert.equal(await v.reveal(me, name, 'test'), `${backend}-second-value`);
      assert.equal(await v.reveal(me, name, 'test', { version: 1 }), `${backend}-first-value`, 'an earlier version reads back from the backend');
      assert.equal(v.list(me).find((e) => e.name === name)!.backend, backend);
      await v.remove(me, name);
    }
    assert.equal(az.secrets.size, 0);
    assert.equal(aws.secrets.size, 0);
    assert.ok(az.seen.filter((x) => x.includes('/token')).length === 1, 'the Azure token is reused while it lasts');
    assert.ok(aws.auth.length >= 6 && aws.auth.every((a) => a.startsWith('AWS4-HMAC-SHA256 Credential=AKIDTEST/')));
    // Wrong credentials are refused by the services, and the error says which backend.
    const bad = new AwsBackend('sm', { type: 'aws', region: 'eu-west-1', endpoint: aws.url, accessKeyId: 'AKIDTEST', secretAccessKey: 'wrong' }, {});
    await assert.rejects(bad.write('x', 'value-123'), /vault backend sm: write failed \(HTTP 403 SignatureDoesNotMatch\)/);
    const badAz = new AzureBackend('akv', { type: 'azure', vaultUrl: az.url, authorityHost: az.url, tenantId: 'tenant-1', clientId: 'app-1', clientSecret: 'nope' }, {});
    await assert.rejects(badAz.write('x', 'value-123'), /sign-in failed \(HTTP 401: invalid_client\)/);
    // A member may not point an entry at an existing path in a backend (only administrators may).
    await assert.rejects(v.put({ account: 'usr_x' }, { name: 'steal', value: 'xxxxxxxx', backend: 'sm', ref: 'other-app/prod' }), /only administrators point an entry/);
  } finally {
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
    await az.close(); await aws.close();
  }
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

test('HashiCorp Vault (KV v2), for real in Docker: token and AppRole logins, versions, rollback, delete', async (t) => {
  const docker = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
  if (docker.code !== 0) return t.skip('Docker is not available');
  const image = await run('docker', ['image', 'inspect', 'hashicorp/vault'], { timeoutMs: 20_000 });
  if (image.code !== 0) {
    const pull = await run('docker', ['pull', 'hashicorp/vault'], { timeoutMs: 600_000 });
    if (pull.code !== 0) return t.skip('the hashicorp/vault image cannot be pulled');
  }
  const port = await freePort();
  const name = `hwtest-vault-${crypto.randomBytes(4).toString('hex')}`;
  const root = 'hwtest-root-token';
  const started = await run('docker', ['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:8200`, '-e', `VAULT_DEV_ROOT_TOKEN_ID=${root}`, '-e', 'VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200', 'hashicorp/vault'], { timeoutMs: 60_000 });
  assert.equal(started.code, 0, started.stderr);
  const address = `http://127.0.0.1:${port}`;
  const prev = process.env.NO_PROXY;
  process.env.NO_PROXY = '127.0.0.1,localhost';
  try {
    for (let i = 0; ; i++) {
      const ok = await fetch(`${address}/v1/sys/health`).then((r) => r.status === 200, () => false);
      if (ok) break;
      if (i > 60) throw new Error('vault did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
    // Token login.
    const hv = new HashiCorpBackend('hcv', { type: 'hashicorp', address, token: '${VAULT_TEST_TOKEN}' }, { VAULT_TEST_TOKEN: root });
    const v1 = await hv.write('harness/test/one', 'first-hcv-value');
    const v2 = await hv.write('harness/test/one', 'second-hcv-value');
    assert.deepEqual([v1, v2], ['1', '2']);
    assert.equal(await hv.read('harness/test/one', v1), 'first-hcv-value');
    assert.equal(await hv.read('harness/test/one', v2), 'second-hcv-value');

    // AppRole: set up with the root token as an operator would, then log in with role and secret ids only.
    const api = (method: string, p: string, body?: unknown) => fetch(`${address}/v1/${p}`, { method, headers: { 'x-vault-token': root, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.ok((await api('POST', 'sys/auth/approle', { type: 'approle' })).ok);
    assert.ok((await api('PUT', 'sys/policies/acl/harness', { policy: 'path "secret/data/harness/*" { capabilities = ["create","read","update"] }\npath "secret/metadata/harness/*" { capabilities = ["delete","read"] }' })).ok);
    assert.ok((await api('POST', 'auth/approle/role/harness', { token_policies: ['harness'], token_ttl: '10m' })).ok);
    const roleId = ((await (await api('GET', 'auth/approle/role/harness/role-id')).json()) as { data: { role_id: string } }).data.role_id;
    const secretId = ((await (await api('POST', 'auth/approle/role/harness/secret-id')).json()) as { data: { secret_id: string } }).data.secret_id;

    const store = await new VaultStore({ dataDir: await tempDir(), env: { ...KEY_A, VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId }, backends: { hcv: { type: 'hashicorp', address, prefix: 'harness' }, default: 'hcv' } }).load();
    const me = { account: 'usr_h' };
    await store.put(me, { name: 'db/password', value: 'approle-value-1', kind: 'password' });
    await store.rotate(me, 'db/password');
    const rotated = await store.reveal(me, 'db/password', 'test');
    assert.notEqual(rotated, 'approle-value-1');
    assert.equal(await store.reveal(me, 'db/password', 'test', { version: 1 }), 'approle-value-1', 'version 1 reads back from Vault');
    await store.rollback(me, 'db/password', 1);
    assert.equal(await store.reveal(me, 'db/password', 'test'), 'approle-value-1');
    // It really is in Vault, at the derived path, as KV v2 version 3.
    const direct = await (await api('GET', 'secret/data/harness/user/usr_h/db/password')).json() as { data: { data: { value: string }; metadata: { version: number } } };
    assert.equal(direct.data.data.value, 'approle-value-1');
    assert.equal(direct.data.metadata.version, 3);
    // Outside its policy the AppRole token is refused.
    const outside = new HashiCorpBackend('hcv', { type: 'hashicorp', address, prefix: 'elsewhere', roleId, secretId }, {});
    await assert.rejects(outside.write('elsewhere/x', 'value-xyz'), /write failed \(HTTP 403/);
    await store.remove(me, 'db/password');
    assert.equal((await api('GET', 'secret/data/harness/user/usr_h/db/password')).status, 404);
    assert.ok(!(await fs.readFile(path.join((store as unknown as { dir: string }).dir, 'entries.json'), 'utf8')).includes('approle-value-1'));
  } finally {
    if (prev === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = prev;
    await run('docker', ['rm', '-f', name], { timeoutMs: 60_000 });
  }
});

test('in the loop: a rule lets a command with secrets run; after untrusted content it is asked again; dontAsk refuses; in a Docker sandbox the value is the command\'s environment only', async () => {
  const v = await new VaultStore({ dataDir: await tempDir(), env: KEY_A }).load();
  await v.put({}, { name: 'ci-token', value: 'ci-secret-value-7' });
  const agentWith = async (steps: Parameters<typeof makeAgent>[0], mode: 'default' | 'dontAsk', host?: import('../src/runtime/host.ts').ToolHost) => {
    const h = await makeAgent(steps, { mode, tools: [bashTool], host, settings: { permissions: { allow: mode === 'default' ? ['vault(ci-token)'] : [], deny: [], ask: [] } } });
    const redactor = new Redactor();
    h.agent.cfg.redactor = redactor;
    h.agent.cfg.services = { vault: v.service({ session: 'loop', main: true, remember: (n, vals) => vals.forEach((x) => redactor.add(n, x)) }) };
    if (!host) (h.agent.cfg.host as { sandboxed: boolean }).sandboxed = true;
    return h;
  };
  const call = { name: 'bash', input: { command: 'echo "token: $T"', secrets: { T: 'ci-token' } } };
  const go = async (h: Awaited<ReturnType<typeof agentWith>>) => { h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] }); await h.agent.run(new AbortController().signal); return results(h.persisted[2])[0]!; };

  const allowed = await agentWith([{ calls: [call] }, { text: 'done' }], 'default');
  const r1 = await go(allowed);
  assert.equal(r1.is_error, undefined, r1.content);
  assert.match(r1.content, /token: \[vault:ci-token\]/);
  assert.ok(!allowed.provider.snapshots.join('').includes('ci-secret-value-7'));

  const tainted = await agentWith([{ calls: [call] }, { text: 'done' }], 'default');
  tainted.agent.markTainted();
  const r2 = await go(tainted);
  assert.match(r2.content, /The user denied this call/, 'asked (and refused here): the session rule does not hold after untrusted content');

  const unattended = await agentWith([{ calls: [call] }, { text: 'done' }], 'dontAsk');
  const r3 = await go(unattended);
  assert.match(r3.content, /Permission denied: this command gets vault secrets \(ci-token\), and this session never asks \(dontAsk mode\)/);

  const { dockerAvailable, imageExists, DockerHost } = await import('../src/runtime/docker.ts');
  if (!(await dockerAvailable()) || !(await imageExists('harness-sandbox:latest'))) return;
  const host = new DockerHost(`vault${Date.now().toString(16)}`, await tempDir(), { image: 'harness-sandbox:latest', network: 'none', memory: '512m', cpus: '1' });
  const container = `hwtest-vault-sbx-${crypto.randomBytes(3).toString('hex')}`;
  (host as unknown as { name: string }).name = container;
  try {
    const direct = await host.exec('printf %s "$T"', { timeoutMs: 120_000, secretEnv: { T: 'ci-secret-value-7' } });
    assert.equal(direct.stdout, 'ci-secret-value-7', direct.stderr);
    const inspect = await run('docker', ['inspect', '-f', '{{json .Config.Env}}', container], { timeoutMs: 20_000 });
    assert.ok(!inspect.stdout.includes('ci-secret-value-7'), 'not part of the container');
    const later = await host.exec('printf %s "${T:-unset}"', { timeoutMs: 60_000 });
    assert.equal(later.stdout, 'unset', 'only that command had it');
    const inDocker = await agentWith([{ calls: [call] }, { text: 'done' }], 'default', host);
    const r4 = await go(inDocker);
    assert.match(r4.content, /token: \[vault:ci-token\]/, r4.content);
  } finally { await host.close(); }
});
