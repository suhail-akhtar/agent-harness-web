// Engineering (sdlc), as any server loads it: its agents, workflows and skills, and the delivery routes its
// pages read (the features in flight, one feature, a conversation's gates), signed in and not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = new URL('..', import.meta.url);

test('engineering: its agents, workflows and skills load', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.agents.sort(), ['analyst', 'architect', 'code-reviewer', 'engineer', 'initializer', 'planner', 'security-reviewer', 'tech-writer']);
    assert.deepEqual(kit.adds.workflows.sort(), ['build-feature', 'long-task']);
    for (const s of ['requirements-spec', 'test-driven-development', 'code-review-checklist']) assert.ok(kit.adds.skills.includes(s), s);
  } finally { await kit.close(); }
});

test('engineering: the delivery routes answer the signed-in, refuse others, and check what they are given', async () => {
  const kit = await loadPlugin(dir);
  try {
    const list = await kit.route('GET', 'deliveries');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.stages) && list.body.stages.length > 0);
    assert.deepEqual(list.body.deliveries, []);
    assert.ok(list.body.workflows.includes('build-feature'));
    assert.equal((await kit.route('GET', 'deliveries', { as: 'anonymous' })).status, 401);
    assert.equal((await kit.route('GET', 'delivery', { query: { id: 'nope' } })).status, 404);
    assert.equal((await kit.route('POST', 'delivery', { body: { id: 'nope' } })).status, 404);
    assert.equal((await kit.route('GET', 'gates', { query: { session: 'not-an-id' } })).status, 400);
    const unseen = await kit.route('GET', 'gates', { query: { session: '0123456789abcdef' } });
    assert.deepEqual([unseen.status, unseen.body.gates, unseen.body.running], [200, [], null]);
  } finally { await kit.close(); }
});
