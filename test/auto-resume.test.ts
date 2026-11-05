import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { ProviderError, type ProviderRequest, type ProviderResponse } from '../src/providers/types.ts';
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
  for (let i = 0; i < 200 && !notices.some((n) => /carried on after a stop/.test(n)); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(notices.some((n) => /Workflow mini \(run_abc123\) carried on after a stop and ended: succeeded/.test(n)), notices.join(' | '));
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

// An outage: the provider cannot be reached for some calls, then answers. retryAfterMs keeps the agent's own retries quick.
class Flaky extends FakeProvider {
  down: number;
  constructor(down: number, steps: ConstructorParameters<typeof FakeProvider>[0]) { super(steps); this.down = down; }
  calls = 0;
  override async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    if (this.down-- > 0) throw new ProviderError('network error: Connection error.', 0, true, 1);
    return super.send(req);
  }
}

async function live(down: number, steps: ConstructorParameters<typeof FakeProvider>[0], prepare?: (h: Awaited<ReturnType<typeof createHarness>>) => void) {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, memory: 'off', search: null });
  const fake = new Flaky(down, steps);
  h.registry.setProviderInstance('deepseek', fake);
  prepare?.(h);
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
  const notices: string[] = [];
  s.subscribe(0, ({ event }) => { if (event.kind === 'notice') notices.push(event.text); });
  const until = async (f: () => boolean) => { for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
  return { h, s, fake, notices, until, data };
}

test('an outage: the turn tries again by itself, later and later, and carries on once the model answers', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_OUTAGE_RETRY_MS: '5' }, async () => {
  // Seven calls to give up the first turn, seven more for the second try: two outages in a row.
  const { h, s, fake, notices, until } = await live(14, [{ text: 'back at it' }]);
  await s.send('do the work', { origin: 'person' });
  await until(() => fake.requests.length === 1 && s.status === 'idle');
  assert.equal(fake.requests.length, 1, notices.join(' | '));
  assert.ok(notices.some((n) => /Stopped by an outage\. Trying again in 1 minute \(try 1\)/.test(n)), notices.join(' | '));
  assert.ok(notices.some((n) => /Trying again in 2 minutes \(try 2\)/.test(n)), 'the wait grows');
  assert.match(JSON.stringify(fake.requests[0]!.messages), /The connection to the model dropped/);
  await until(() => !s.meta.outageRetries);
  assert.equal(s.meta.outageRetries, 0, 'a turn that works clears it');
  assert.equal(s.meta.autoContinues, 2, 'each try is a wake');
  await h.close();
}));

test('an outage: without HARNESS_AUTO_RESUME the turn ends, as before', async () => withEnv({ HARNESS_AUTO_RESUME: undefined, HARNESS_OUTAGE_RETRY_MS: '5' }, async () => {
  const { h, s, fake, notices, until } = await live(7, [{ text: 'should not run' }]);
  await s.send('do the work', { origin: 'person' });
  await until(() => s.status === 'idle' && fake.calls >= 7);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.requests.length, 0);
  assert.ok(!notices.some((n) => /Trying again/.test(n)));
  await h.close();
}));

test('an outage: the wake limit stops the tries, and says so', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_OUTAGE_RETRY_MS: '5', HARNESS_BACKGROUND_MAX_WAKES: '1' }, async () => {
  const { h, s, notices, until } = await live(100, []);
  await s.send('do the work', { origin: 'person' });
  await until(() => notices.some((n) => /Not trying again \(it already continued 1 time/.test(n)));
  assert.ok(notices.some((n) => /Not trying again \(it already continued 1 time/.test(n)), notices.join(' | '));
  await h.close();
}));

test('an outage: a person stopping the turn is not an outage, and a retry waiting is dropped', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_OUTAGE_RETRY_MS: '1000' }, async () => {
  const { h, s, fake, notices, until } = await live(7, [{ text: 'answered' }, { text: 'again' }]);
  await s.send('do the work', { origin: 'person' });
  await until(() => notices.some((n) => /Trying again/.test(n)));
  await s.send('never mind, say hi', { origin: 'person' });
  await until(() => fake.requests.length === 1 && s.status === 'idle');
  assert.equal(s.meta.outageRetries, 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fake.requests.length, 1, 'no second try after the person took over');
  await h.close();
}));

test('an outage: a server stopping during the wait carries on when it is back', async () => withEnv({ HARNESS_AUTO_RESUME: '1' }, async () => {
  const { data, id } = await killed({ running: false, outageRetries: 3 }, [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
  const { h, fake, ended } = await reopen(data, id, [{ text: 'picked up' }]);
  await ended;
  assert.equal(fake.requests.length, 1);
  await h.close();
}));

test('an outage: a workflow run failed by it goes on from its step', async () => withEnv({ HARNESS_AUTO_RESUME: '1', HARNESS_OUTAGE_RETRY_MS: '5' }, async () => {
  const { h, s, fake, notices, until } = await live(7, [{ text: 'first done' }, { text: 'second done' }, { text: 'noted' }], (x) => x.registry.workflows.set('mini', MINI));
  await s.startWorkflow('mini', {});
  await until(() => notices.some((n) => /carried on after a stop and ended: succeeded/.test(n)));
  assert.ok(notices.some((n) => /Trying again in 1 minute/.test(n)), notices.join(' | '));
  assert.ok(notices.some((n) => /carried on after a stop and ended: succeeded/.test(n)), notices.join(' | '));
  assert.ok(fake.requests.length >= 2);
  await h.close();
}));
