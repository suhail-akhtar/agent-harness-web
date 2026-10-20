import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { COMPACT_PROMPT } from '../src/core/prompt.ts';
import { makeAgent, results } from './helpers.ts';

const ac = () => new AbortController().signal;

test('runs tools and loops until the model answers without a tool call', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'write', input: { path: 'a.txt', content: 'hello\n' } }] },
    { calls: [{ name: 'read', input: { path: 'a.txt' } }] },
    { text: 'All done.' },
  ]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const reason = await h.agent.run(ac());
  assert.equal(reason, 'done');
  assert.equal(await fs.readFile(path.join(h.root, 'a.txt'), 'utf8'), 'hello\n');
  assert.equal(h.provider.requests.length, 3);
  const readResult = results(h.agent.messages[4]);
  assert.match(readResult[0]!.content, /1\thello/);
});

test('the context sent to the provider is append-only: every request extends the previous one', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'write', input: { path: 'x.js', content: 'let a = 1;\n' } }] },
    { calls: [{ name: 'read', input: { path: 'x.js' } }, { name: 'glob', input: { pattern: '*.js' } }] },
    { calls: [{ name: 'edit', input: { path: 'x.js', old_string: 'a = 1', new_string: 'a = 2' } }] },
    { text: 'ok' },
  ]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  const reqs = h.provider.snapshots.map((s) => JSON.parse(s) as unknown[]);
  for (let i = 1; i < reqs.length; i++) {
    const prev = reqs[i - 1]!;
    assert.deepEqual(reqs[i]!.slice(0, prev.length), prev, `request ${i} rewrote earlier history`);
  }
  // System prompt and tool list never change mid-session.
  const sys = new Set(h.provider.requests.map((r) => r.system + JSON.stringify(r.tools)));
  assert.equal(sys.size, 1);
});

test('tool list is sorted by name (deterministic prefix)', async () => {
  const h = await makeAgent([{ text: 'hi' }]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  const names = h.provider.requests[0]!.tools.map((t) => t.name);
  assert.deepEqual(names, [...names].sort());
});

test('parallel results come back in one user message, in call order', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'glob', input: { pattern: '*' } }, { name: 'grep', input: { pattern: 'zzz' } }, { name: 'glob', input: { pattern: '*.md' } }] },
    { text: 'ok' },
  ]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  const msg = h.agent.messages[2]!;
  const ids = msg.content.filter((b) => b.type === 'tool_result').map((b) => (b as { tool_use_id: string }).tool_use_id);
  assert.deepEqual(ids, ['call_1', 'call_2', 'call_3']);
});

test('errors go back to the model in a form it can repair from', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'nope' }, { name: 'read', input: {} }, { name: 'bash', parseError: 'invalid JSON arguments' }, { name: 'edit', input: { path: 'missing.txt', old_string: 'a', new_string: 'b' } }] },
    { text: 'ok' },
  ]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  assert.equal(await h.agent.run(ac()), 'done');
  const r = results(h.agent.messages[2]);
  assert.ok(r.every((x) => x.is_error));
  assert.match(r[0]!.content, /no tool named "nope".*Available tools/);
  assert.match(r[1]!.content, /missing required parameter "path"/);
  assert.match(r[2]!.content, /not valid JSON/);
  assert.match(r[3]!.content, /does not exist/);
});

test('edit refuses a file that was not read, and one that changed since it was read', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'edit', input: { path: 'f.txt', old_string: 'one', new_string: 'two' } }] },
    { calls: [{ name: 'read', input: { path: 'f.txt' } }] },
    { calls: [{ name: 'edit', input: { path: 'f.txt', old_string: 'one', new_string: 'two' } }] },
    { text: 'ok' },
  ]);
  await fs.writeFile(path.join(h.root, 'f.txt'), 'one\n');
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  const run = h.agent.run(ac());
  // Change the file between the read and the second edit.
  const wait = setInterval(async () => {
    if (h.provider.requests.length === 3) { clearInterval(wait); }
  }, 1);
  await run;
  const first = results(h.agent.messages[2])[0]!;
  assert.match(first.content, /must read this file/);
  const third = results(h.agent.messages[6])[0]!;
  assert.ok(!third.is_error, third.content);
  assert.equal(await fs.readFile(path.join(h.root, 'f.txt'), 'utf8'), 'two\n');
});

test('default mode asks before edits; a denial returns the user feedback', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
    { calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] },
    { text: 'ok' },
  ], { mode: 'default' });
  h.permissionAnswers.push(false, true);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  assert.match(results(h.agent.messages[2])[0]!.content, /denied.*no thanks/);
  assert.ok(!results(h.agent.messages[4])[0]!.is_error);
});

test('plan mode blocks edits without asking', async () => {
  const h = await makeAgent([{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }] }, { text: 'ok' }], { mode: 'plan' });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  assert.match(results(h.agent.messages[2])[0]!.content, /plan mode/);
  await assert.rejects(fs.stat(path.join(h.root, 'a.txt')));
});

test('a tool call cut off at the output limit is not executed', async () => {
  const h = await makeAgent([{ calls: [{ name: 'write', input: { path: 'big.txt', content: 'partial' } }], stop: 'max_tokens' }, { text: 'ok' }]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  assert.match(results(h.agent.messages[2])[0]!.content, /cut off/);
  await assert.rejects(fs.stat(path.join(h.root, 'big.txt')));
});

test('repeating an identical call three times triggers a reminder', async () => {
  const same = { name: 'glob', input: { pattern: '*.none' } };
  const h = await makeAgent([{ calls: [same] }, { calls: [same] }, { calls: [same] }, { text: 'ok' }]);
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  const texts = h.agent.messages[6]!.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  assert.match(texts, /identical arguments 3 times/);
});

test('compaction reuses the cached prefix and restarts from a single summary message', async () => {
  const h = await makeAgent([
    { calls: [{ name: 'glob', input: { pattern: '*' } }], usage: { input: 5000 } },
    { text: 'SUMMARY: did things' },
    { text: 'continued' },
  ], { settings: { compactAt: 1000 } });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  const compactReq = JSON.parse(h.provider.snapshots[1]!) as { content: { text: string }[] }[];
  const prev = JSON.parse(h.provider.snapshots[0]!) as unknown[];
  // The summary request = the previous context (plus the tool results) + one appended instruction.
  assert.deepEqual(compactReq.slice(0, prev.length), prev);
  assert.equal(compactReq[compactReq.length - 1]!.content[0]!.text, COMPACT_PROMPT);
  // Afterwards the context is one user message holding the summary and the task.
  const after = JSON.parse(h.provider.snapshots[2]!) as { content: { text: string }[] }[];
  assert.equal(after.length, 1);
  const text = after[0]!.content[0]!.text;
  assert.match(text, /SUMMARY: did things/);
  assert.match(text, /the task/);
  assert.ok(h.events.some((e) => e.kind === 'compaction'));
});

test('Stop hook can send the agent back to work', async () => {
  const h = await makeAgent([{ text: 'first done' }, { text: 'fixed' }], {
    settings: { hooks: { Stop: [{ command: 'test -f done.flag || { touch done.flag; echo "tests are failing" >&2; exit 2; }' }] } },
  });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  assert.equal(h.provider.requests.length, 2);
  const reminder = h.agent.messages[2]!.content.map((b) => (b as { text: string }).text).join('');
  assert.match(reminder, /tests are failing/);
});

test('PreToolUse hook exit 2 blocks the call', async () => {
  const h = await makeAgent([{ calls: [{ name: 'bash', input: { command: 'echo hi' } }] }, { text: 'ok' }], {
    settings: { hooks: { PreToolUse: [{ matcher: 'bash', command: 'echo "no shell today" >&2; exit 2' }] } },
  });
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'go' }] });
  await h.agent.run(ac());
  assert.match(results(h.agent.messages[2])[0]!.content, /blocked this call: no shell today/);
});

test('an image a tool returns travels on its tool result', async () => {
  const h = await makeAgent([{ calls: [{ name: 'read', input: { path: 'shot.png' } }] }, { text: 'red and blue' }]);
  await fs.writeFile(path.join(h.root, 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  h.agent.append({ role: 'user', content: [{ type: 'text', text: 'look' }] });
  await h.agent.run(ac());
  const msg = h.agent.messages[2]!;
  assert.deepEqual(msg.content.map((b) => b.type), ['tool_result']);
  assert.equal((msg.content[0] as { images?: unknown[] }).images?.length, 1);
});
