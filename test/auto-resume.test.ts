import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import type { WorkflowDef } from '../src/graph/types.ts';
import { FakeProvider, tempDir } from './helpers.ts';

// After a restart, HARNESS_AUTO_RESUME=1 carries on what was left open with nobody there. Each case leaves a
// session on disk as a killed server would, then opens the data folder again.

const MINI: WorkflowDef = {
  name: 'mini', description: 'two steps', start: 'one',
  nodes: {
    one: { type: 'agent', agent: 'general', prompt: 'first', next: 'two' },
    two: { type: 'agent', agent: 'general', prompt: 'second', next: 'end' },
    end: { type: 'end' },
  },
} as unknown as WorkflowDef;

async function killed(meta: Record<string, unknown>, history: unknown[]) {
  const data = await tempDir();
  const ws = await tempDir();
  const h = await createHarness({ dataDir: data, memory: 'off', search: null });
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const id = s.meta.id;
  await h.close();
  const dir = path.join(data, 'sessions', id);
  await fs.writeFile(path.join(dir, 'history.jsonl'), history.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const m = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...m, running: true, ...meta }));
  return { data, id, dir };
}

const CUT_OFF = [
  { role: 'user', content: [{ type: 'text', text: 'build it' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'sleep 100' } }] },
];

async function reopen(data: string, id: string, steps: ConstructorParameters<typeof FakeProvider>[0], prepare?: (h: Awaited<ReturnType<typeof createHarness>>) => void) {
  const h = await createHarness({ dataDir: data, memory: 'off', search: null });
  const fake = new FakeProvider(steps);
  h.registry.setProviderInstance('deepseek', fake);
  prepare?.(h);
  const s = h.sessions.get(id)!;
  const notices: string[] = [];
  s.subscribe(0, ({ event }) => { if (event.kind === 'notice') notices.push(event.text); });
  const ended = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await h.sessions.resumeInterrupted();
  return { h, s, fake, notices, ended };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('auto resume: a cut-off turn starts again by itself, as a wake and not as the person', async () => withEnv({ HARNESS_AUTO_RESUME: '1' }, async () => {
  const { data, id } = await killed({}, CUT_OFF);
  const { h, s, fake, ended } = await reopen(data, id, [{ text: 'picked up' }]);
  await ended;
  assert.equal(fake.requests.length, 1);
  assert.equal(s.meta.autoContinues, 1, 'it counts as a wake, so a crash loop meets the limit');
  const said = JSON.stringify(fake.requests[0]!.messages);
  assert.match(said, /Not run: the server restarted/);
  assert.match(said, /Continue the task from where you left off/);
  await h.close();
}));

test('auto resume: off by default, the session waits and says so', async () => withEnv({ HARNESS_AUTO_RESUME: undefined }, async () => {
  const { data, id } = await killed({}, CUT_OFF);
  const { h, s, fake } = await reopen(data, id, [{ text: 'should not run' }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.requests.length, 0);
  assert.equal(s.meta.running, false);
  await h.close();
}));

test('auto resume: a server in a crash loop stops at the wake limit and says why', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_BACKGROUND_MAX_WAKES: '3' }, async () => {
  const { data, id } = await killed({ autoContinues: 3 }, CUT_OFF);
  const { h, fake, notices } = await reopen(data, id, [{ text: 'should not run' }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.requests.length, 0);
  assert.ok(notices.some((n) => /Not carrying on after the restart \(it already continued 3 time/.test(n)), notices.join(' | '));
  await h.close();
}));

test('auto resume: waking off stops it too', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_BACKGROUND_WAKE: '0' }, async () => {
  const { data, id } = await killed({}, CUT_OFF);
  const { h, fake, notices } = await reopen(data, id, []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.requests.length, 0);
  assert.ok(notices.some((n) => /HARNESS_BACKGROUND_WAKE=0/.test(n)), notices.join(' | '));
  await h.close();
}));

test('auto resume: a session that was idle stays idle', async () => withEnv({ HARNESS_AUTO_RESUME: '1' }, async () => {
  const { data, id } = await killed({ running: false }, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }]);
  const { h, fake } = await reopen(data, id, []);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.requests.length, 0);
  await h.close();
}));

async function interruptedRun(data: string, dir: string, id: string, status: string) {
  await fs.mkdir(path.join(dir, 'runs'), { recursive: true });
  const run = { id: 'run_abc123', workflow: 'mini', sessionId: id, status, input: {}, state: { one: 'first done' }, feedback: '', current: 'two', counts: { one: 1 }, agentRuns: 1, history: [], createdAt: 1, updatedAt: 1, cost: 0 };
  await fs.writeFile(path.join(dir, 'runs', 'run_abc123.json'), JSON.stringify(run));
  return data;
}

test('auto resume: a workflow run picks up at its step, the steps before are not run again', async () => withEnv({ HARNESS_AUTO_RESUME: '1' }, async () => {
  const { data, id, dir } = await killed({}, [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }]);
  await interruptedRun(data, dir, id, 'running');
  const { h, s, fake, notices } = await reopen(data, id, [{ text: 'second step done' }, { text: 'noted' }], (x) => x.registry.workflows.set('mini', MINI));
  for (let i = 0; i < 200 && !notices.some((n) => /carried on after a restart/.test(n)); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(notices.some((n) => /Workflow mini \(run_abc123\) carried on after a restart and ended: succeeded/.test(n)), notices.join(' | '));
  const prompts = fake.requests.map((r) => JSON.stringify(r.messages));
  assert.ok(prompts.some((p) => /second/.test(p)), 'the step it was in ran');
  assert.ok(!prompts.some((p) => /"text":"first"/.test(p)), 'the step before did not');
  assert.equal(s.meta.autoContinues! >= 1, true);
  await h.close();
}));

test('auto resume: a run inside a cut-off tool call goes back to the agent, which is told of it', async () => withEnv({ HARNESS_AUTO_RESUME: '1' }, async () => {
  const { data, id, dir } = await killed({}, [{ role: 'user', content: [{ type: 'text', text: 'run it' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'workflow', input: { action: 'run', name: 'mini' } }] }]);
  await interruptedRun(data, dir, id, 'running');
  const { h, fake, ended } = await reopen(data, id, [{ text: 'starting it again' }], (x) => x.registry.workflows.set('mini', MINI));
  await ended;
  assert.equal(fake.requests.length, 1);
  assert.match(JSON.stringify(fake.requests[0]!.messages), /workflow runs were interrupted too: run_abc123/);
  await h.close();
}));
