import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { HarnessEvent, PermissionMode } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { defineTool } from '../src/plugins/api.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { results, tempDir } from './helpers.ts';

// Background work: sub-agents, workflows and shells that run while the main agent
// goes on, and the task tools around them. The main agent and each sub-agent kind
// get their own script (requests are told apart by cache key), so they can run at once.

type Step = { text?: string; calls?: { name: string; input?: Record<string, unknown> }[]; wait?: Promise<unknown> };
type Script = (Step | ((req: ProviderRequest) => Step))[];

class Routed implements Provider {
  requests: Record<string, ProviderRequest[]> = {};
  /** Each request's messages as sent (the agent goes on appending to the same array). */
  sent: Record<string, string[]> = {};
  private scripts: Record<string, Script>;
  private n = 0;
  constructor(scripts: Record<string, Script>) { this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    // hw-<session> for the main agent, hw-<session>-<agent kind> for sub-agents.
    const route = req.cacheKey.split('-')[2] ?? 'main';
    (this.requests[route] ??= []).push(req);
    (this.sent[route] ??= []).push(JSON.stringify(req.messages));
    const next = this.scripts[route]?.shift() ?? { text: 'done' };
    const s = typeof next === 'function' ? next(req) : next;
    if (s.wait) {
      await Promise.race([s.wait, new Promise((r) => req.signal.addEventListener('abort', r, { once: true }))]);
      if (req.signal.aborted) throw new Error('aborted');
    }
    const content: ProviderResponse['message']['content'] = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    for (const c of s.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input ?? {} });
    return {
      message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: s.text ?? null } } },
      stop: s.calls?.length ? 'tool_use' : 'end',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 },
    };
  }
}

async function setup(scripts: Record<string, Script>, opts: { env?: Record<string, string>; mode?: PermissionMode; prepare?: (h: Awaited<ReturnType<typeof createHarness>>) => void } = {}) {
  const env = opts.env ?? {};
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off' });
  const p = new Routed(scripts);
  h.registry.setProviderInstance('deepseek', p);
  opts.prepare?.(h);
  const ws = await tempDir();
  const s = await h.sessions.create({ model: 'deepseek-flash', mode: opts.mode ?? 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const events: HarnessEvent[] = [];
  s.subscribe(0, ({ event }) => events.push(event));
  const ends = () => events.filter((e) => e.kind === 'turn_end' && !e.agent).length;
  const waitFor = async (cond: () => boolean, what: string, ms = 20_000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const turn = async (text: string) => {
    const n = ends();
    await s.send(text);
    await waitFor(() => ends() > n, 'the turn to end');
  };
  const notices = () => events.filter((e) => e.kind === 'notice').map((e) => (e as { text: string }).text);
  const close = async () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await h.close();
  };
  return { h, s, p, ws, events, turn, waitFor, ends, notices, close };
}

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
const bgAgent = (prompt: string, type = 'general') => ({ name: 'agent', input: { description: 'dig', prompt, type, run_in_background: true } });
const json = (x: unknown) => JSON.stringify(x);

test('a background sub-agent returns at once; the main agent works on, and gets the report at its next step', async () => {
  const g = gate();
  const t = await setup({
    main: [
      { calls: [bgAgent('find the thing')] },
      // The main agent has the floor again while the sub-agent is still held at its first request.
      () => { g.open(); return { calls: [{ name: 'monitor', input: { task_id: 'general-1', timeout_ms: 20_000 } }] }; },
      { text: 'all done' },
    ],
    general: [{ wait: g.p, text: 'the thing is in src/x.ts' }],
  });
  try {
    await t.turn('go');
    assert.match(results(t.s.history[2])[0]!.content, /Started general-1 in the background/);
    assert.match(results(t.s.history[4])[0]!.content, /general-1 ended \(completed\)/, 'monitor waits for an agent task to end');
    assert.match(json(t.s.history[4]), /Background agent general-1 \(dig\) finished[\s\S]*the thing is in src\/x\.ts/, 'the report arrives as a reminder with the next tool results');
    const task = t.s.tasks.get('general-1')!;
    assert.equal(task.status, 'completed');
    assert.ok((task.cost ?? 0) > 0, 'its cost is counted');
    assert.ok(t.s.meta.cost >= (task.cost ?? 0));
    assert.deepEqual(t.events.filter((e) => e.kind === 'task').map((e) => (e as { phase: string }).phase), ['started', 'finished']);
  } finally { await t.close(); }
});

test('a result that arrives while the session is idle waits for the user (or, opted in, starts a turn)', async () => {
  for (const wake of [false, true]) {
    const g = gate();
    const t = await setup({
      main: [{ calls: [bgAgent('count')] }, { text: 'It is running.' }, { text: 'It found 42.' }],
      general: [{ wait: g.p, text: 'found: 42' }],
    }, { env: wake ? { HARNESS_BACKGROUND_WAKE: '1' } : {} });
    try {
      await t.turn('go');
      assert.equal(t.s.status, 'idle');
      g.open();
      if (!wake) {
        await t.waitFor(() => t.notices().some((n) => /general-1 \(dig\) finished.*sees the result with your next message/.test(n)), 'the notice');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(t.p.requests.main!.length, 2, 'nothing is spent without the user');
        await t.turn('what did it find?');
      } else {
        await t.waitFor(() => t.ends() === 2, 'the woken turn');
      }
      const last = json((JSON.parse(t.p.sent.main![2]!) as unknown[]).at(-1));
      assert.match(last, /found: 42/);
      if (!wake) assert.match(last, /what did it find\?/);
    } finally { await t.close(); }
  }
});

test('taint crosses into and out of background sub-agents', async () => {
  const service = (h: Awaited<ReturnType<typeof createHarness>>) => h.registry.addTool(defineTool({ name: 'service', description: 'a service', parameters: { type: 'object', properties: {} }, kind: 'read', untrusted: true, run: async () => 'weather: sunny' }));
  // A tainted main agent's brief may carry what it read: the sub-agent starts tainted.
  const a = await setup({ main: [{ calls: [{ name: 'service' }] }, { calls: [bgAgent('go on')] }, { text: 'ok' }], general: [{ text: 'fine' }] }, { prepare: service });
  try {
    await a.turn('go');
    await a.waitFor(() => a.s.tasks.get('general-1')?.status === 'completed', 'the agent');
    assert.equal(a.s.tasks.get('general-1')!.untrusted?.(), true);
  } finally { await a.close(); }
  // A background sub-agent that read outside content taints the main agent when its report arrives.
  // (held at a gate until the main turn is checked: on a fast machine it could finish first)
  const g = gate();
  const b = await setup({ main: [{ calls: [bgAgent('look it up')] }, { text: 'ok' }], general: [{ wait: g.p, calls: [{ name: 'service' }] }, { text: 'sunny' }] }, { prepare: service });
  try {
    await b.turn('go');
    assert.equal(b.s.meta.tainted ?? false, false);
    g.open();
    await b.waitFor(() => b.s.tasks.get('general-1')?.status === 'completed', 'the agent');
    assert.equal(b.s.meta.tainted, true);
  } finally { await b.close(); }
});

test('send_message continues a sub-agent with its context; finished ones are kept, the last 20', async () => {
  const t = await setup({
    main: [
      { calls: [{ name: 'agent', input: { description: 'first', prompt: 'part one', type: 'general' } }] },
      { calls: [{ name: 'send_message', input: { to: 'general-1', message: 'and part two?' } }] },
      { calls: [{ name: 'send_message', input: { to: 'general-1', message: 'part three, in the background', run_in_background: true } }] },
      { calls: [{ name: 'monitor', input: { task_id: 'general-1', timeout_ms: 20_000 } }] },
      { text: 'done' },
    ],
    general: [{ text: 'first report' }, { text: 'second report' }, { text: 'third report' }],
  });
  try {
    await t.turn('go');
    assert.match(results(t.s.history[2])[0]!.content, /first report[\s\S]*agent id: general-1/);
    assert.match(results(t.s.history[4])[0]!.content, /^second report/);
    assert.match(t.p.sent.general![1]!, /part one[\s\S]*first report[\s\S]*and part two\?/, 'its context is intact');
    assert.match(results(t.s.history[6])[0]!.content, /continues in the background/);
    // It reports later, as a reminder of its own (never inside the call's result), with whichever step comes next.
    assert.ok(t.s.history.slice(6).some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && /third report/.test(b.text))), 'a background continuation reports later');
    assert.doesNotMatch(results(t.s.history[6])[0]!.content, /third report/);
    const tools = t.p.requests.general![0]!.tools.map((x) => x.name);
    assert.ok(!tools.includes('send_message') && !tools.includes('agent'), 'sub-agents that may not nest cannot continue others');
    assert.ok(t.p.requests.main![0]!.tools.some((x) => x.name === 'task_list'));
  } finally { await t.close(); }

  const call = (n: number) => ({ name: 'agent', input: { description: `job ${n}`, prompt: `job ${n}`, type: 'general' } });
  const many = await setup({
    main: [
      { calls: Array.from({ length: 22 }, (_, i) => call(i + 1)) },
      { calls: Array.from({ length: 22 }, (_, i) => ({ name: 'send_message', input: { to: `general-${i + 1}`, message: 'again' } })) },
      { text: 'done' },
    ],
  });
  try {
    await many.turn('go');
    const replies = results(many.s.history[4]);
    assert.equal(replies.length, 22);
    assert.equal(replies.filter((r) => r.is_error && /No sub-agent general-\d+ of yours/.test(r.content)).length, 2, 'the two least recently used are gone');
  } finally { await many.close(); }
});

test('the user\'s Stop stops background agents; a background agent\'s question outlives the turn', async () => {
  const held = gate();
  const t = await setup({ main: [{ calls: [bgAgent('wait forever')] }, { text: 'started' }], general: [{ wait: held.p, text: 'never' }] });
  try {
    await t.turn('go');
    t.s.abort();
    await t.waitFor(() => t.s.tasks.get('general-1')?.status === 'stopped', 'the stop');
  } finally { held.open(); await t.close(); }

  const q = await setup({
    main: [{ calls: [bgAgent('make the file')] }, { text: 'started it' }],
    general: [{ calls: [{ name: 'bash', input: { command: 'touch made.txt' } }] }, { text: 'made it' }],
  }, { mode: 'default' });
  try {
    await q.turn('go');
    await q.waitFor(() => q.s.pendingRequests().length === 1, 'the question');
    const ask = q.s.pendingRequests()[0] as { requestId: string; agent?: string };
    assert.equal(ask.agent, 'general-1');
    assert.equal(q.s.status, 'waiting', 'the turn ended without answering it');
    q.s.respond(ask.requestId, { decision: 'allow' });
    await q.waitFor(() => q.s.tasks.get('general-1')?.status === 'completed', 'the agent');
    await fs.access(path.join(q.ws, 'made.txt'));
    assert.equal(q.s.status, 'idle');
  } finally { await q.close(); }
});

test('the workflow tool runs a workflow in the background; it is recorded, and its outcome arrives later', async () => {
  let runId = '';
  const t = await setup({
    main: [
      { calls: [{ name: 'workflow', input: { action: 'run', name: 'mini', input: { topic: 'caching' }, run_in_background: true } }] },
      (req) => {
        runId = /as (run_[a-f0-9]+)/.exec(json(req.messages.at(-1)))?.[1] ?? '';
        return { calls: [{ name: 'monitor', input: { task_id: runId, timeout_ms: 20_000 } }] };
      },
      { text: 'done' },
    ],
    general: [{ text: 'Notes written about caching.' }],
  }, { prepare: (h) => h.registry.workflows.set('mini', { name: 'mini', description: 'write notes', inputs: { topic: { description: 'what about' } }, start: 'write', nodes: { write: { type: 'agent', agent: 'general', prompt: 'Write notes about {{input.topic}}.', next: 'done' }, done: { type: 'end' } } }) });
  try {
    await t.turn('go');
    assert.match(results(t.s.history[2])[0]!.content, /started in the background as run_/);
    assert.match(json(t.s.history[4]), /Background workflow mini \(run_[a-f0-9]+\) succeeded[\s\S]*Notes written about caching/);
    const runs = await t.s.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.id, runId);
    assert.equal(runs[0]!.status, 'succeeded');
    assert.equal(t.s.tasks.get(runId)?.status, 'completed');
  } finally { await t.close(); }
});

test('background shells are tasks: listed, read, watched for a line or their end, stopped', { skip: new LocalHost(process.cwd()).shell === 'powershell' && 'needs bash' }, async () => {
  const lastResults = (req: ProviderRequest) => json(req.messages.at(-1));
  let server = '';
  let job = '';
  const t = await setup({
    main: [
      { calls: [{ name: 'bash', input: { command: 'echo booting; sleep 4; echo READY on 8080; while true; do echo tick; sleep 0.3; done', run_in_background: true, description: 'dev server' } }] },
      (req) => {
        server = /task (shell-\w+)/.exec(lastResults(req))?.[1] ?? '';
        return { calls: [{ name: 'monitor', input: { task_id: server, pattern: 'READY on \\d+', timeout_ms: 20_000 } }] };
      },
      () => ({ calls: [{ name: 'task_list' }, { name: 'task_output', input: { task_id: server, tail: 2 } }] }),
      () => ({ calls: [{ name: 'task_stop', input: { task_id: server } }] }),
      { calls: [{ name: 'bash', input: { command: 'echo failing; sleep 3; exit 3', run_in_background: true } }] },
      (req) => {
        job = /task (shell-\w+)/.exec(lastResults(req))?.[1] ?? '';
        return { calls: [{ name: 'monitor', input: { task_id: job, timeout_ms: 20_000 } }] };
      },
      { text: 'done' },
    ],
  });
  try {
    await t.turn('go');
    assert.match(server, /^shell-/);
    assert.match(results(t.s.history[4])[0]!.content, /printed a line matching \/READY on \\d\+\/:\nREADY on 8080/, 'output from after the call is watched');
    const [list, out] = results(t.s.history[6]);
    assert.match(list!.content, new RegExp(`${server}  shell  running .*dev server`));
    assert.match(out!.content, /tick/);
    assert.ok(!/booting/.test(out!.content), 'tail keeps only the last lines');
    assert.match(results(t.s.history[8])[0]!.content, new RegExp(`Stopped ${server}`));
    assert.equal(t.s.tasks.get(server)!.status, 'stopped');
    const size = (await t.s.tasks.get(server)!.read()).size;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await t.s.tasks.get(server)!.read()).size, size, 'its processes are gone (the log stopped growing)');
    assert.match(results(t.s.history[12])[0]!.content, new RegExp(`${job} ended \\(failed\\)`));
    assert.match(json(t.s.history[12]), new RegExp(`Background shell ${job} .*exited with code 3`), 'its end is reported to the agent');
  } finally { await t.close(); }
});

test('a background program that buffers its output (Python) still shows its lines as it prints them, so monitor sees them', { skip: (new LocalHost(process.cwd()).shell === 'powershell' && 'needs bash') || false, timeout: 60_000 }, async () => {
  const { execFileSync } = await import('node:child_process');
  const py = ['python3', 'python'].find((p) => { try { execFileSync(p, ['-c', 'print(1)'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (!py) return;
  const lastResults = (req: ProviderRequest) => json(req.messages.at(-1));
  let server = '';
  const t = await setup({
    main: [
      // Prints its ready line once, without flushing, then keeps running: block-buffered, that line would stay unseen.
      { calls: [{ name: 'bash', input: { command: `${py} -c "import time; print('SERVING on 8000'); time.sleep(40)"`, run_in_background: true } }] },
      (req) => {
        server = /task (shell-\w+)/.exec(lastResults(req))?.[1] ?? '';
        return { calls: [{ name: 'monitor', input: { task_id: server, pattern: 'SERVING on [0-9]+$', include_existing: true, timeout_ms: 15_000 } }] };
      },
      () => ({ calls: [{ name: 'task_stop', input: { task_id: server } }] }),
      { text: 'done' },
    ],
  });
  try {
    await t.turn('go');
    assert.match(results(t.s.history[4])[0]!.content, /printed a line matching[\s\S]*SERVING on 8000/);
  } finally { await t.close(); }
});
