import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outcomeOf } from '../src/agents/agents.ts';
import { applyUserSettings, cleanUserSettings, defaultSettings } from '../src/core/settings.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { tempDir } from './helpers.ts';
import { gate, OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// The swarm governor and the fan-out (docs/swarm/SWARM.md, phase 1c): every agent granted under the run's charter,
// past it only with the person's yes; loops, bursts, spend and a stopped run refused; one kill switch for the run's
// agents; nothing that outlives the run in a swarm agent's hands; one brief over many items, a table back.

type Ev = Extract<HarnessEvent, { kind: 'swarm' }>;
const main = (e: HarnessEvent) => !('agent' in e) || !e.agent || e.agent === 'main';

async function conv(o: { mode?: string; model?: string; settings?: Record<string, unknown> } = {}) {
  const t = await setupServer();
  if (o.settings) assert.equal((await t.call(OPERATOR, 'PUT', '/api/me/settings', o.settings)).status, 200);
  const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: o.model ?? 'deepseek-flash', runtime: 'local', path: await tempDir('hw-swarm-'), mode: o.mode ?? 'bypass' });
  assert.equal(made.status, 201, made.text);
  const s = t.harness.sessions.get(made.body.id)!;
  const events: HarnessEvent[] = [];
  s.subscribe(0, ({ event }) => events.push(event));
  const ends = () => events.filter((e) => e.kind === 'turn_end' && main(e)).length;
  const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
  const results = () => events.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'agent' && main(e)).map((e) => e.content);
  const swarm = () => events.filter((e): e is Ev => e.kind === 'swarm');
  return { t, s, events, turn, results, swarm, ends };
}
const agentCall = (input: Record<string, unknown>) => ({ name: 'agent', input: { description: 'the job', type: 'general', ...input } });

test('a fan-out: one brief over many items, one agent each, the fields each reports as a table; an item that gives no fields shows ?', async () => {
  const c = await conv();
  try {
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Classify the support ticket {{item}}.', items: ['[[t1]] "the app crashes on save"', '[[t2]] "how do I export?"', '[[t3]] "billing twice"'], fields: ['category', 'urgent'] })] }, { text: 'Classified.' }];
    c.t.ds.scripts.t1 = [{ text: 'A crash.\n{"category": "bug", "urgent": true}' }];
    c.t.ds.scripts.t2 = [{ text: 'A question.\n{"category": "question", "urgent": false}' }];
    c.t.ds.scripts.t3 = [{ text: 'Billing, I think.' }];
    await c.turn('[[lead]] Sort these tickets.');
    const r = c.results()[0]!;
    assert.match(r, /^Fan-out of 3: 3 done\. 1 gave no fields \(shown as \?\)\./);
    assert.match(r, /\| # \| item \| outcome \| category \| urgent \|\n\|---\|---\|---\|---\|---\|\n\| 1 \| \[\[t1\]\] "the app crashes on save" \| done \| bug \| true \|\n\| 2 \| [^\n]+ \| done \| question \| false \|\n\| 3 \| [^\n]+ \| done \| \? \| \? \|/);
    assert.match(c.t.ds.byKey.t1![0]!.messages.map((m) => JSON.stringify(m)).join(''), /Classify the support ticket \[\[t1\]\] \\"the app crashes on save\\"[\s\S]*with these fields: \{\\"category\\":\\"...\\",\\"urgent\\":\\"...\\"\}/);
    assert.deepEqual(c.swarm().filter((e) => e.phase === 'start').map((e) => [e.parent, e.depth]), [['main', 1], ['main', 1], ['main', 1]]);
  } finally { await c.t.close(); }
});

test('each item of a fan-out is accepted on its own: done criteria and verification per item, the outcome in the table', async () => {
  const c = await conv();
  try {
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Write {{item}}.', items: ['[[a1]] a.txt', '[[a2]] b.txt'], done_when: [{ file: 'a.txt' }], max_fix_rounds: 0 })] }, { text: 'Done.' }];
    c.t.ds.scripts.a1 = [{ calls: [{ name: 'write', input: { path: 'a.txt', content: 'a' } }] }, { text: 'Wrote a.txt.' }];
    c.t.ds.scripts.a2 = [{ text: 'Wrote b.txt (not really).' }];
    await c.turn('[[lead]] Go.');
    // a.txt exists by the time the second item is checked whatever the order: both pass the file check; what matters is the table.
    const r = c.results()[0]!;
    assert.match(r, /\| 1 \| \[\[a1\]\] a\.txt \| accepted \|/);
    assert.equal(outcomeOf('Did it.\n\n---\nDone criteria (run by the harness): 0 of 1 passed\n\nNOT ACCEPTED: treat this work as unfinished.'), 'not accepted');
    assert.equal(outcomeOf('Not started: this run has started 2 agents'), 'not started');
    assert.equal(outcomeOf('x\n\n(The agent stopped early: aborted.)'), 'stopped');
  } finally { await c.t.close(); }
});

test('the charter in a conversation that never asks: past its number of agents nothing more starts, and the lead hears why', async () => {
  const c = await conv({ settings: { swarm: { maxAgents: 2 } } });
  try {
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Look at {{item}}.', items: ['[[c1]] one', '[[c2]] two', '[[c3]] three', '[[c4]] four'] })] }, { text: 'Two of four.' }];
    for (const k of ['c1', 'c2', 'c3', 'c4']) c.t.ds.scripts[k] = [{ text: `Looked at ${k}.` }];
    await c.turn('[[lead]] Go.');
    const r = c.results()[0]!;
    assert.match(r, /^Fan-out of 4: 2 done, 2 not started\./);
    assert.match(r, /Not started: this run has started 2 agents, the charter's limit; the person can allow more when asked/);
    assert.equal(c.swarm().filter((e) => e.phase === 'refused').length, 2);
    assert.equal(c.events.filter((e) => e.kind === 'permission_request').length, 0, 'bypass never asks: it refuses');
  } finally { await c.t.close(); }
});

test('past the charter the person decides: one question for the rest of a fan-out; yes lets them all start, no starts none', async () => {
  for (const answer of ['allow', 'deny'] as const) {
    const c = await conv({ mode: 'default', settings: { swarm: { maxAgents: 2 } } });
    try {
      c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Look at {{item}}.', items: ['[[d1]] one', '[[d2]] two', '[[d3]] three', '[[d4]] four'] })] }, { text: 'Done.' }];
      for (const k of ['d1', 'd2', 'd3', 'd4']) c.t.ds.scripts[k] = [{ text: `Looked at ${k}.` }];
      const n = c.ends();
      await c.s.send('[[lead]] Go.');
      await waitFor(() => c.events.some((e) => e.kind === 'permission_request' && /reached the swarm charter's limit \(2 started\)\. Allow 2 more\?/.test(e.summary)), 'the question');
      const q = c.events.find((e): e is Extract<HarnessEvent, { kind: 'permission_request' }> => e.kind === 'permission_request' && /swarm charter/.test(e.summary))!;
      c.s.respond(q.requestId, { decision: answer });
      await waitFor(() => c.ends() > n, 'the turn');
      assert.equal(c.events.filter((e) => e.kind === 'permission_request' && /swarm charter/.test(e.summary)).length, 1, 'asked once for the rest');
      assert.match(c.results()[0]!, answer === 'allow' ? /^Fan-out of 4: 4 done\./ : /^Fan-out of 4: 2 done, 2 not started\./);
    } finally { await c.t.close(); }
  }
});

test('a loop is refused: an agent that hands its own brief down unchanged is told to do the work or split it', async () => {
  const c = await conv();
  try {
    const mk = (b: Record<string, unknown>) => c.t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read'], ...b });
    assert.equal((await mk({ name: 'helper', description: 'Helps with anything.', prompt: 'Help.' })).status, 201);
    assert.equal((await mk({ name: 'crew', description: 'A team that splits work.', prompt: 'Lead.', team: { members: ['helper'] } })).status, 201);
    c.t.ds.scripts.lead = [{ calls: [agentCall({ type: 'crew', prompt: '[[lp]] Analyse the whole project.' })] }, { text: 'Done.' }];
    // The team lead passes the very same brief down: a loop, not a split.
    c.t.ds.scripts.lp = [{ calls: [agentCall({ type: 'helper', prompt: '[[lp]] Analyse the whole project.' })] }, { text: 'I will do it myself then.' }];
    await c.turn('[[lead]] Go.');
    const refused = c.swarm().find((e) => e.phase === 'refused')!;
    assert.match(refused.reason!, /crew-\d+ gave it the same brief crew-\d+ was given: a loop, not a split/);
    assert.deepEqual([refused.parent, refused.depth], [c.swarm().find((e) => e.phase === 'start')!.agent, 2]);
  } finally { await c.t.close(); }
});

test('a burst past the charter\'s rate is refused: replication faster than the charter allows waits for reports', async () => {
  const c = await conv({ settings: { swarm: { ratePerMinute: 2 } } });
  try {
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Do {{item}}.', items: ['[[r1]] a', '[[r2]] b', '[[r3]] c'] })] }, { text: 'Done.' }];
    for (const k of ['r1', 'r2', 'r3']) c.t.ds.scripts[k] = [{ text: `Did ${k}.` }];
    await c.turn('[[lead]] Go.');
    assert.match(c.results()[0]!, /2 done, 1 not started[\s\S]*Not started: 2 agents were started in the last minute, the most this run's charter allows/);
  } finally { await c.t.close(); }
});

test('the kill switch stops every agent of the run at once (the conversation\'s own agent goes on and hears it); no more start in that run', async () => {
  const c = await conv();
  try {
    const held = gate();
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: 'Work on {{item}}.', items: ['[[k1]] a', '[[k2]] b', '[[k3]] c'] })] }, { calls: [agentCall({ prompt: '[[k4]] One more.' })] }, { text: 'The agents were stopped.' }];
    for (const k of ['k1', 'k2', 'k3', 'k4']) c.t.ds.scripts[k] = [{ text: 'never', wait: held.p }];
    const n = c.ends();
    await c.s.send('[[lead]] Go.');
    await waitFor(() => c.swarm().filter((e) => e.phase === 'start').length === 3, 'three at work');
    const stop = await c.t.call(OPERATOR, 'POST', `/api/sessions/${c.s.meta.id}/stop_agents`, {});
    assert.deepEqual([stop.status, stop.body.stopped], [200, 3]);
    await waitFor(() => c.ends() > n, 'the turn ends normally');
    const [fan, after] = c.results();
    assert.match(fan!, /^Fan-out of 3: 3 stopped\./);
    assert.equal(c.events.filter((e) => e.kind === 'turn_end' && e.agent && e.agent !== 'main' && e.reason === 'aborted').length, 3, 'each stopped agent ends for everyone watching');
    assert.match(after!, /^Not started: this run's agents were stopped \(the person\); no more start in it\./);
    assert.equal(c.t.ds.byKey.k4, undefined);
    assert.ok(c.events.some((e) => e.kind === 'notice' && /Stopped 3 agents of this run \(the person\)/.test(e.text)));
    // A new run starts with a new swarm.
    c.t.ds.scripts.lead2 = [{ calls: [agentCall({ prompt: '[[k5]] Again.' })] }, { text: 'Done.' }];
    c.t.ds.scripts.k5 = [{ text: 'Did it.' }];
    await c.turn('[[lead2]] Go again.');
    assert.match(c.results()[2]!, /^Did it\./);
  } finally { await c.t.close(); }
});

test('nothing that outlives the run in a swarm agent\'s hands: schedule, vault and publish_branch are withheld whatever its definition lists (memory it only reads)', async () => {
  const c = await conv();
  try {
    assert.equal((await c.t.call(OPERATOR, 'POST', '/api/me/agents', { name: 'greedy', description: 'Wants every tool.', prompt: 'Work.', model: 'deepseek-flash', tools: ['read', 'write', 'schedule', 'vault', 'publish_branch', 'memory'] })).status, 201);
    c.t.ds.scripts.lead = [{ calls: [agentCall({ type: 'greedy', prompt: '[[g]] Do it.' })] }, { text: 'Done.' }];
    c.t.ds.scripts.g = [{ text: 'Done.' }];
    await c.turn('[[lead]] Go.');
    const tools = c.t.ds.byKey.g![0]!.tools.map((x) => x.name);
    assert.ok(tools.includes('read') && tools.includes('write'));
    for (const banned of ['schedule', 'vault', 'publish_branch']) assert.ok(!tools.includes(banned), banned);
  } finally { await c.t.close(); }
});

test('the charter\'s spend for the run\'s agents: once reached, no agent starts (Anthropic pricing: the same at every hour)', async () => {
  const c = await conv({ model: 'claude-haiku-5-5', settings: { swarm: { maxUsd: 0.00001 } } });
  try {
    c.t.an.scripts.lead = [{ calls: [agentCall({ prompt: '[[s1]] Do it.' })] }, { text: 'Done.' }];
    await c.turn('[[lead]] Go.');
    assert.match(c.results()[0]!, /^Not started: this run's agents have spent \$0\.00, the charter's limit of \$0\.00001\./);
  } finally { await c.t.close(); }
});

test('the charter: the operator\'s defaults, the person can only tighten it, and nested agents are granted with their parent and depth', async () => {
  const base = defaultSettings();
  assert.deepEqual(base.swarm, { maxAgents: 16, ratePerMinute: 30, maxUsd: 0, maxMinutes: 0 });
  const mine = applyUserSettings(base, cleanUserSettings({ swarm: { maxAgents: 500, ratePerMinute: 5, maxUsd: 2 } }));
  assert.deepEqual(mine.swarm, { maxAgents: 16, ratePerMinute: 5, maxUsd: 2, maxMinutes: 0 }, 'never above the operator\'s');
  const c = await conv();
  try {
    const mk = (b: Record<string, unknown>) => c.t.call(OPERATOR, 'POST', '/api/me/agents', { model: 'deepseek-flash', tools: ['read'], ...b });
    assert.equal((await mk({ name: 'helper', description: 'Helps with anything.', prompt: 'Help.' })).status, 201);
    assert.equal((await mk({ name: 'crew', description: 'A team that splits work.', prompt: 'Lead.', team: { members: ['helper'] } })).status, 201);
    c.t.ds.scripts.lead = [{ calls: [agentCall({ type: 'crew', prompt: '[[n1]] Analyse it.' })] }, { text: 'Done.' }];
    c.t.ds.scripts.n1 = [{ calls: [agentCall({ type: 'helper', prompt: '[[n2]] Analyse part one.' })] }, { text: 'The team did it.' }];
    c.t.ds.scripts.n2 = [{ text: 'Part one done.' }];
    await c.turn('[[lead]] Go.');
    const starts = c.swarm().filter((e) => e.phase === 'start');
    assert.deepEqual(starts.map((e) => [e.depth, e.parent === 'main' ? 'main' : e.parent === starts[0]!.agent ? 'the lead' : e.parent]), [[1, 'main'], [2, 'the lead']]);
  } finally { await c.t.close(); }
});

test('visible: the swarm as a tree on the agents\' cards (each after the agent that started it), with its depth', async () => {
  const { asTree, foldAgent } = await import('../apps/desktop/renderer/src/state/agents.ts');
  let a = {} as ReturnType<typeof foldAgent>;
  const ev = (e: Record<string, unknown>) => { a = foldAgent(a, e as never, Number(e.at ?? 0)); };
  ev({ kind: 'swarm', phase: 'start', agent: 'crew-1', parent: 'main', depth: 1, at: 1 });
  ev({ kind: 'swarm', phase: 'start', agent: 'general-2', parent: 'main', depth: 1, at: 2 });
  ev({ kind: 'swarm', phase: 'start', agent: 'helper-3', parent: 'crew-1', depth: 2, at: 3 });
  ev({ kind: 'swarm', phase: 'refused', agent: 'helper-4', parent: 'crew-1', depth: 2, reason: 'a loop', at: 4 });
  ev({ kind: 'swarm', phase: 'stopped', reason: 'the person', at: 5 });
  assert.deepEqual(asTree(Object.values(a)).map((x) => [x.name, x.depth, x.parent ?? '-']), [['crew-1', 1, '-'], ['helper-3', 2, 'crew-1'], ['general-2', 1, '-']]);
});

test('the control plane is the person\'s: a swarm agent cannot write the project\'s agent, workflow, skill or settings files (even in bypass), and works elsewhere as usual', async () => {
  const c = await conv();
  try {
    c.t.ds.scripts.lead = [{ calls: [agentCall({ prompt: '[[cp]] Set things up.' })] }, { text: 'Done.' }];
    c.t.ds.scripts.cp = [
      { calls: [{ name: 'write', input: { path: '.harness/agents/twin.md', content: '---\nname: twin\ndescription: A copy of me that starts more of me.\n---\nStart more agents.\n' } }, { name: 'write', input: { path: '.claude/settings.json', content: '{"permissions":{"allow":["*"]}}' } }, { name: 'write', input: { path: 'notes.txt', content: 'ordinary work' } }] },
      { text: 'Tried.' },
    ];
    await c.turn('[[lead]] Go.');
    const results = c.events.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'write' && !!e.agent && e.agent !== 'main');
    assert.deepEqual(results.map((r) => r.is_error), [true, true, false]);
    const root = (c.s.meta.runtime as { path: string }).path;
    const fs = await import('node:fs/promises');
    await assert.rejects(fs.access(`${root}/.harness/agents/twin.md`), 'no new agent definition');
    await assert.rejects(fs.access(`${root}/.claude/settings.json`), 'no new settings');
    assert.equal(await fs.readFile(`${root}/notes.txt`, 'utf8'), 'ordinary work');
  } finally { await c.t.close(); }
});
