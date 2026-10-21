import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '../src/kernel/harness.ts';
import { defineTool } from '../src/plugins/api.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';

async function run(env: Record<string, string>, steps: ConstructorParameters<typeof FakeProvider>[0], setup?: (h: Awaited<ReturnType<typeof createHarness>>) => void) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const fake = new FakeProvider(steps);
  h.registry.setProviderInstance('deepseek', fake);
  setup?.(h);
  try {
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const notices: string[] = [];
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => {
      if (event.kind === 'notice') notices.push(event.text);
      if (event.kind === 'turn_end') notices.push(`end ${event.agent ?? 'main'}`);
      if (event.kind === 'turn_end' && !event.agent) r();
    }));
    await s.send('go');
    await done;
    return { s, fake, notices };
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await h.close();
  }
}

test('sub-agents nest as deep as the operator allows, and no deeper', async () => {
  const delegate = (prompt: string) => ({ calls: [{ name: 'agent', input: { description: 'delegate', prompt, type: 'general' } }] });
  const { s, fake } = await run({ HARNESS_SUBAGENT_DEPTH: '2' }, [delegate('mid'), delegate('deep'), { text: 'deep report' }, { text: 'mid report built on: deep report' }, { text: 'done' }]);
  assert.match(results(s.history[2])[0]!.content, /mid report built on: deep report/);
  const tools = (i: number) => fake.requests[i]!.tools.map((t) => t.name);
  assert.ok(tools(1).includes('agent'), 'depth 1 may delegate');
  assert.ok(!tools(2).includes('agent'), 'depth 2 is the limit');
  const flat = await run({}, [delegate('mid'), { text: 'mid report' }, { text: 'done' }]);
  assert.ok(!flat.fake.requests[1]!.tools.some((t) => t.name === 'agent'), 'by default sub-agents do not start their own');
});

test('a nested sub-agent that read the web taints the agents above it', async () => {
  const delegate = (prompt: string) => ({ calls: [{ name: 'agent', input: { description: 'delegate', prompt, type: 'general' } }] });
  const { s } = await run({ HARNESS_SUBAGENT_DEPTH: '2' }, [delegate('mid'), delegate('deep'), { calls: [{ name: 'service', input: {} }] }, { text: 'deep' }, { text: 'mid' }, { text: 'done' }],
    // A service whose answer is outside content (as an MCP server's would be).
    (h) => h.registry.addTool(defineTool({ name: 'service', description: 'a service', parameters: { type: 'object', properties: {} }, kind: 'read', untrusted: true, run: async () => 'weather: sunny' })));
  assert.equal(s.meta.tainted, true, 'the main agent knows untrusted content is in its context, two levels down');
});

test('at most maxParallelSubagents run at once; the rest wait their turn', async () => {
  const call = (n: number) => ({ name: 'agent', input: { description: `job ${n}`, prompt: `job ${n}`, type: 'general' } });
  const { notices } = await run({ HARNESS_SUBAGENTS_PARALLEL: '1' }, [{ calls: [call(1), call(2), call(3)] }, { text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'done' }]);
  const order = notices.filter((n) => /^Started general|^end general/.test(n)).map((n) => n.replace(/^Started (general-\d+).*/, 'start $1').replace(/^end /, 'end '));
  assert.deepEqual(order, ['start general-1', 'end general-1', 'start general-2', 'end general-2', 'start general-3', 'end general-3']);
});
