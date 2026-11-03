import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { gate, OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// What the person types while the agent works waits for its next step; a step can be long (a fan-out, a provider
// that stalls). It is listed (steering events, the session's detail), can go now (the current step stops, then it
// is sent) or be taken back, and Stop no longer drops it unseen.

async function conv() {
  const t = await setupServer();
  const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: await tempDir('hw-steer-'), mode: 'bypass' });
  assert.equal(made.status, 201, made.text);
  const s = t.harness.sessions.get(made.body.id)!;
  const events: HarnessEvent[] = [];
  s.subscribe(0, ({ event }) => events.push(event));
  const ends = () => events.filter((e) => e.kind === 'turn_end' && !('agent' in e && e.agent && e.agent !== 'main'));
  const steering = () => events.filter((e): e is Extract<HarnessEvent, { kind: 'steering' }> => e.kind === 'steering').at(-1)?.texts;
  const post = (b: Record<string, unknown>) => t.call(OPERATOR, 'POST', `/api/sessions/${s.meta.id}/steering`, b);
  return { t, s, events, ends, steering, post };
}

test('a message typed while the agent works is listed; one can be taken back; "send now" stops the step and sends it', async () => {
  const c = await conv();
  try {
    const held = gate();
    c.t.ds.scripts.long = [{ text: 'never', wait: held.p }];
    c.t.ds.scripts.now = [{ text: 'Doing the new thing.' }];
    await c.s.send('[[long]] A long job.');
    await waitFor(() => c.s.status === 'running', 'at work');
    assert.equal(await c.s.send('[[now]] Do this instead.'), 'queued');
    assert.equal(await c.s.send('[[drop]] And this.'), 'queued');
    assert.deepEqual(c.steering(), ['[[now]] Do this instead.', '[[drop]] And this.']);
    const removed = await c.post({ action: 'remove', index: 1 });
    assert.deepEqual([removed.status, removed.body.steering], [200, ['[[now]] Do this instead.']]);
    assert.deepEqual((await c.t.call(OPERATOR, 'GET', `/api/sessions/${c.s.meta.id}`)).body.steering, ['[[now]] Do this instead.'], 'the detail lists it');
    const now = await c.post({ action: 'send_now' });
    assert.equal(now.body.result, 'interrupted');
    await waitFor(() => c.ends().length >= 2, 'the long step stopped and the new turn ended');
    assert.equal((c.ends()[0] as Extract<HarnessEvent, { kind: 'turn_end' }>).reason, 'aborted');
    assert.equal(c.t.ds.byKey.now?.length, 1, 'the message started the next turn');
    assert.equal(c.t.ds.byKey.drop, undefined, 'the one taken back never went');
    assert.deepEqual(c.steering(), []);
  } finally { await c.t.close(); }
});

test('Stop keeps what the person typed meanwhile (it was dropped unseen): listed, and "send now" starts it', async () => {
  const c = await conv();
  try {
    const held = gate();
    c.t.ds.scripts.long = [{ text: 'never', wait: held.p }];
    c.t.ds.scripts.later = [{ text: 'Got it.' }];
    await c.s.send('[[long]] A long job.');
    await waitFor(() => c.s.status === 'running', 'at work');
    await c.s.send('[[later]] Keep me.');
    c.s.abort();
    await waitFor(() => c.ends().length === 1 && c.s.status === 'idle', 'stopped');
    assert.deepEqual(c.s.steering(), ['[[later]] Keep me.']);
    assert.deepEqual(c.steering(), ['[[later]] Keep me.'], 'still listed after the stop');
    assert.equal(Object.hasOwn(c.t.ds.byKey, 'later'), false, 'not sent on its own after a stop');
    assert.equal((await c.post({ action: 'send_now' })).body.result, 'started');
    await waitFor(() => c.ends().length === 2, 'its turn');
    assert.equal(c.t.ds.byKey.later?.length, 1);
    assert.deepEqual(c.s.steering(), []);
  } finally { await c.t.close(); }
});
