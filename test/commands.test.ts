import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function session(steps: ConstructorParameters<typeof FakeProvider>[0], opts: Parameters<typeof createHarness>[0] extends infer O ? Partial<O> : never = {}, setup?: (h: Awaited<ReturnType<typeof createHarness>>, ws: string) => Promise<void> | void) {
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', ...opts });
  const fake = new FakeProvider(steps);
  h.registry.setProviderInstance('deepseek', fake);
  const ws = await tempDir();
  await setup?.(h, ws);
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const turn = async (text: string) => {
    // From the latest event: a replayed earlier turn_end must not end this wait.
    const done = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send(text);
    await done;
  };
  return { h, s, fake, ws, turn };
}

test('the workflow tool runs one of the session\'s workflows inside the turn and reports its outcome', async () => {
  const { h, s, turn } = await session([
    { calls: [{ name: 'workflow', input: { action: 'run', name: 'mini', input: { topic: 'caching' } } }] },
    { text: 'Notes written about caching.' },
    { text: 'The workflow is done.' },
  ], {}, (h) => {
    h.registry.workflows.set('mini', { name: 'mini', description: 'write notes', inputs: { topic: { description: 'what about' } }, start: 'write', nodes: { write: { type: 'agent', agent: 'general', prompt: 'Write notes about {{input.topic}}.', next: 'done' }, done: { type: 'end' } } });
  });
  try {
    await turn('use the mini workflow');
    const r = results(s.history[2])[0]!;
    assert.match(r.content, /^Workflow mini succeeded \(\$/);
    assert.match(r.content, /- write \(agent\): .*Notes written about caching/);
    assert.equal((await s.listRuns()).length, 1, 'recorded like any run');
  } finally { await h.close(); }
});

test('slash commands: /<skill> loads that skill into the message; /compact compacts now', async () => {
  const { h, s, fake, turn } = await session([{ text: 'Done the house way.' }, { text: 'summary of everything' }], {}, async (_h, ws) => {
    await fs.mkdir(path.join(ws, '.harness', 'skills', 'house-style'), { recursive: true });
    await fs.writeFile(path.join(ws, '.harness', 'skills', 'house-style', 'SKILL.md'), '---\nname: house-style\ndescription: How we write code here\n---\nUse tabs. Name files in kebab-case.\n');
  });
  try {
    await turn('/house-style tidy src/');
    const sent = JSON.stringify(fake.requests[0]!.messages);
    assert.match(sent, /<command-name>\/house-style<\/command-name>/);
    assert.match(sent, /Use tabs\. Name files in kebab-case\./);
    assert.match(sent, /tidy src\//);
    await turn('/compact');
    assert.equal(s.meta.compactions >= 0, true);
    assert.match(JSON.stringify(fake.requests[1]!.messages), /summar/i, 'a compaction request was made');
    // An unknown /word is just a message.
    assert.ok(!JSON.stringify(fake.requests[0]!.messages).includes('<command-name>/nope'));
  } finally { await h.close(); }
});

test('mcp_tool and agent hooks: a connected server\'s tool hears the event; a verifying agent can block a call', async () => {
  const fixture = path.join(here, 'fixtures', 'mcp-server.mjs');
  const settingsFile = path.join(await tempDir(), 'settings.json');
  await fs.writeFile(settingsFile, JSON.stringify({ hooks: {
    PostToolUse: [{ type: 'mcp_tool', matcher: 'write', server: 'audit', tool: 'echo', arguments: { text: 'audit noted the write' } }],
    PreToolUse: [{ type: 'agent', matcher: 'bash', prompt: 'Block commands that deploy.' }],
  } }));
  const saved = process.env.HARNESS_SETTINGS;
  process.env.HARNESS_SETTINGS = settingsFile;
  const { h, s, fake, turn } = await session([
    { calls: [{ name: 'write', input: { path: 'a.txt', content: 'x' } }, { name: 'bash', input: { command: 'npm run deploy' } }] },
    // The verifier (an explore agent) answers.
    { text: 'This deploys.\n{"ok": false, "reason": "deploying is not allowed here"}' },
    { text: 'ok' },
  ], { mcp: { audit: { command: process.execPath, args: [fixture] } } });
  try {
    await turn('write and deploy');
    const [w, b] = results(s.history[2]);
    assert.match(w!.content, /<hook_feedback>\necho: audit noted the write/);
    assert.match(b!.content, /A PreToolUse hook blocked this call: deploying is not allowed here/);
    const verifier = fake.requests.find((r) => JSON.stringify(r.messages).includes('Block commands that deploy'))!;
    assert.ok(verifier, 'the verifying agent saw the instruction');
    assert.ok(!verifier.tools.some((t) => t.name === 'bash' && false));
  } finally {
    if (saved === undefined) delete process.env.HARNESS_SETTINGS; else process.env.HARNESS_SETTINGS = saved;
    await h.close();
  }
});
