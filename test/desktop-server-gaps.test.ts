// Server pieces the desktop's second phase needed: a session sees workflows added after it
// started (without touching its cached prompt), workflow runs say each node's agent, model and
// next nodes (for the graph), and /api/models never answers an empty list while starting.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './helpers.ts';
import { OPERATOR, record, setupServer, turnsEnded, waitFor } from './multi-helpers.ts';

const wf = (name: string) => ({
  name, description: `The ${name} flow`, start: 'check',
  nodes: {
    plan: { type: 'agent', agent: 'general', model: 'claude-sonnet-5-5', prompt: 'Plan {{input.request}}', next: 'check' },
    check: { type: 'approval', title: 'OK?', message: 'Fine?', next: { on: { approve: 'done', reject: 'plan' } } },
    done: { type: 'end', status: 'success' },
  },
});

test('workflows: a file added to .harness/workflows after the session started is listed and starts; the prompt and tools stay as they were', async () => {
  const t = await setupServer();
  try {
    const ws = await tempDir();
    const r = await t.call(OPERATOR, 'POST', '/api/sessions', { runtime: 'local', path: ws, model: 'deepseek-flash', mode: 'bypass', client: { kind: 'desktop', version: '1', renderers: [], tools: [] } });
    assert.equal(r.status, 201);
    const id = r.body.id as string;
    const s = t.harness.sessions.get(id)!;
    const ev = record(s);
    t.ds.scripts['w1'] = [{ text: 'first' }];
    await s.send('[[w1]] hi'); await waitFor(() => turnsEnded(ev) === 1, 'turn 1');
    const before = await t.call(OPERATOR, 'GET', `/api/sessions/${id}/workflows`);
    assert.ok(!before.body.workflows.some((w: { name: string }) => w.name === 'late-flow'));
    // Added while the session lives.
    await fs.mkdir(path.join(ws, '.harness', 'workflows'), { recursive: true });
    await fs.writeFile(path.join(ws, '.harness', 'workflows', 'late-flow.json'), JSON.stringify(wf('late-flow')));
    const after = await t.call(OPERATOR, 'GET', `/api/sessions/${id}/workflows`);
    const late = after.body.workflows.find((w: { name: string }) => w.name === 'late-flow');
    assert.ok(late, 'the new workflow is listed');
    assert.equal(late.start, 'check');
    assert.deepEqual(late.nodes, [
      { id: 'plan', type: 'agent', agent: 'general', model: 'claude-sonnet-5-5', next: ['check'] },
      { id: 'check', type: 'approval', title: 'OK?', next: ['done', 'plan'] },
      { id: 'done', type: 'end' },
    ], 'each node with its agent, model and where it goes (for the graph)');
    // A changed file is read again (its listing changed).
    await fs.writeFile(path.join(ws, '.harness', 'workflows', 'late-flow.json'), JSON.stringify({ ...wf('late-flow'), description: 'Changed' }));
    assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${id}/workflows`)).body.workflows.find((w: { name: string }) => w.name === 'late-flow').description, 'Changed');
    // It starts (and its run says the same about its nodes).
    const started = await t.call(OPERATOR, 'POST', `/api/sessions/${id}/workflows`, { name: 'late-flow', input: { request: 'x' } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await waitFor(async () => (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/workflows`)).body.runs.some((x: { status: string }) => x.status === 'waiting'), 'the run to wait for its approval');
    const run = (await t.call(OPERATOR, 'GET', `/api/sessions/${id}/workflows`)).body.runs[0];
    assert.equal(run.start, 'check');
    assert.deepEqual(run.nodes.find((n: { id: string }) => n.id === 'check').next, ['done', 'plan']);
    // The catalogue is not in the prompt: the next request's system prompt and tools are the first's.
    const pend = s.pendingRequests()[0] as { requestId: string } | undefined;
    if (pend) s.respond(pend.requestId, { decision: 'approve' });
    t.ds.scripts['w2'] = [{ text: 'second' }];
    await waitFor(() => s.status === 'idle', 'the session to be idle');
    await s.send('[[w2]] again'); await waitFor(() => !!t.ds.byKey['w2']?.length, 'turn 2');
    const [a] = t.ds.byKey['w1']!; const [b] = t.ds.byKey['w2']!;
    assert.equal(b!.system, a!.system, 'the system prompt is the same');
    assert.deepEqual(b!.tools.map((x) => x.name), a!.tools.map((x) => x.name), 'the tools are the same');
    assert.doesNotMatch(a!.system + JSON.stringify(a!.tools), /late-flow/);
  } finally { await t.close(); }
});

test('/api/models: never an empty list while the engine is starting (503 with Retry-After)', async () => {
  const t = await setupServer();
  try {
    const ok = await t.call(OPERATOR, 'GET', '/api/models');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.length > 0);
    const saved = new Map(t.harness.registry.models);
    t.harness.registry.models.clear();
    try {
      const starting = await t.call(OPERATOR, 'GET', '/api/models');
      assert.equal(starting.status, 503);
      assert.equal(starting.headers.get('retry-after'), '1');
      assert.match(starting.body.error, /still starting/);
    } finally { for (const [k, v] of saved) t.harness.registry.models.set(k, v); }
  } finally { await t.close(); }
});
