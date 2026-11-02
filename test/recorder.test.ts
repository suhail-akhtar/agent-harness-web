import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Bundle, Recorder, replay, verifyBundle } from '../src/core/recorder.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { CONTROL_PLANE_DENY } from '../src/agents/agents.ts';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// The run recorder and investigations as co-pilot work (docs/swarm/SWARM.md, phase 6): a hash-chained record that
// shows any change, a replay that runs nothing, a bundle that verifies on its own; leads kept with their evidence and
// decided only by the person; the checklist's coverage checked.

const here = path.dirname(fileURLToPath(import.meta.url));

test('the record: each line chained to the one before; a changed line, a changed content, a removed or reordered line is found', async () => {
  const r = new Recorder(await tempDir());
  const events: HarnessEvent[] = [
    { kind: 'user_message', text: 'Why did the export fail?' },
    { kind: 'tool_call', id: 't1', name: 'read', input: { path: 'logs/app.log' } },
    { kind: 'tool_result', id: 't1', name: 'read', content: '03:12 export failed: disk full', is_error: false, ms: 3 },
    { kind: 'text_delta', text: 'not recorded' },
    { kind: 'request_resolved', requestId: 'q1', decision: 'Confirmed' },
  ];
  for (const e of events) void r.record(e, 1_700_000_000_000);
  const b = await r.export('s1');
  assert.equal(b.lines.length, 4, 'deltas are not recorded');
  assert.deepEqual(verifyBundle(b), { ok: true, lines: 4, problems: [], head: b.lines[3]!.hash });
  assert.deepEqual(replay(b).map((s) => [s.who, s.what]), [['person', 'asked: Why did the export fail?'], ['main', 'called read {"path":"logs/app.log"}'], ['main', 'read returned: 03:12 export failed: disk full'], ['person', 'decided: Confirmed']]);
  const copy = (): Bundle => JSON.parse(JSON.stringify(b));
  // A result changed after the fact: its content no longer matches its hash.
  const c1 = copy(); c1.blobs[c1.lines[2]!.blob] = c1.blobs[c1.lines[2]!.blob]!.replace('disk full', 'all fine');
  assert.match(verifyBundle(c1).problems.join('\n'), /line 3: its content does not match its hash/);
  // A line removed: numbering and chain break from there.
  const c2 = copy(); c2.lines.splice(1, 1);
  assert.match(verifyBundle(c2).problems.join('\n'), /line 2: numbered 3[\s\S]*line 2: does not follow line 1/);
  // A line rewritten to point at other content, with its hash recomputed by hand: the next line no longer follows.
  const c3 = copy(); c3.lines[1]!.name = 'write';
  assert.match(verifyBundle(c3).problems.join('\n'), /line 2: its hash does not match its contents/);
  // After a restart, recording goes on in the same chain.
  const again = new Recorder((r as unknown as { dir: string }).dir);
  await again.record({ kind: 'user_message', text: 'And after?' });
  const b2 = await again.export('s1');
  assert.deepEqual([b2.lines.length, b2.lines[4]!.prev === b.lines[3]!.hash, verifyBundle(b2).ok], [5, true, true]);
});

test('in a conversation: recorded when the settings say so, exported, verified and replayed over the API (as shown: redacted)', async () => {
  const t = await setupServer();
  try {
    const dir = await tempDir('hw-rec-');
    await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
    await fs.writeFile(path.join(dir, '.harness', 'settings.json'), JSON.stringify({ record: true }));
    await fs.writeFile(path.join(dir, 'notes.md'), 'the export runs at 03:00\n');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: dir, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    let ends = 0;
    s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !('agent' in event && event.agent)) ends++; });
    t.ds.scripts.lead = [{ calls: [{ name: 'read', input: { path: 'notes.md' } }] }, { text: 'It runs at 03:00.' }];
    await s.send('[[lead]] When does the export run?');
    await waitFor(() => ends > 0, 'the turn');
    await (await s.record())!.flush();
    const bundle = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/record`)).body as Bundle;
    assert.equal(bundle.format, 'harness-record/1');
    assert.ok(bundle.lines.length >= 4);
    const v = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/record?view=verify`)).body;
    assert.deepEqual([v.ok, v.problems], [true, []]);
    const r = (await t.call(OPERATOR, 'GET', `/api/sessions/${s.meta.id}/record?view=replay`)).body as { steps: { what: string }[] };
    assert.ok(r.steps.some((x) => /^asked: \[\[lead\]\] When does the export run\?/.test(x.what)) && r.steps.some((x) => /^read returned: .*the export runs at 03:00/.test(x.what)), JSON.stringify(r.steps));
    // A session without the setting is not recorded.
    const plain = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: await tempDir(), mode: 'bypass' });
    assert.equal((await t.call(OPERATOR, 'GET', `/api/sessions/${plain.body.id}/record`)).status, 404);
  } finally { await t.close(); }
});

test('investigations: a lead needs evidence and a mandate; only the person decides it (refused where nobody can be asked); the checklist\'s coverage', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'investigations')], search: null, memory: 'off' });
  try {
    const dir = await tempDir('hw-inv-');
    const host = new LocalHost(dir);
    const asked: string[] = [];
    const base = { host, signal: new AbortController().signal, services: {} } as unknown as ToolContext;
    const withPerson = { ...base, askUser: async (q: string) => { asked.push(q); return { answered: 'Confirmed', note: 'matches the change ticket' }; } } as unknown as ToolContext;
    const tool = (name: string, input: Record<string, unknown>, ctx = base) => h.registry.tools.get(name)!.run(input, ctx);
    const lead = { title: 'The 03:12 login from a new country preceded the export', evidence: [{ source: 'logs/auth.log:812', quote: '03:12:04 login user=svc-export from=NL' }], score: 0.8, why: 'the export ran 4 minutes later' };
    assert.match((await tool('add_lead', lead)).content, /^Not added: no mandate/);
    await fs.mkdir(path.join(dir, '.harness'), { recursive: true });
    await fs.writeFile(path.join(dir, '.harness', 'investigation-mandate.json'), JSON.stringify({ purpose: 'why the nightly export leaked', subjects: ['our own logs'], authorizedBy: 'Sam' }));
    assert.match((await tool('add_lead', { ...lead, evidence: [] })).content, /needs evidence/);
    assert.equal((await tool('add_lead', lead)).content, 'L1 added to the queue (score 0.80, 1 piece(s) of evidence). A person decides it.');
    await tool('add_lead', { ...lead, title: 'A cron change the day before', score: 0.4 });
    assert.match((await tool('leads', {})).content, /^- L1 \[open\] \(0\.80\)[\s\S]*- L2 \[open\] \(0\.40\)/);
    // Nobody to ask: nothing is decided.
    assert.match((await tool('decide_lead', { id: 'L1' })).content, /^Not decided: L1 waits for a person/);
    // The person decides; the decision is theirs, with their note.
    assert.equal((await tool('decide_lead', { id: 'L1', recommendation: 'confirm: the timing fits' }, withPerson)).content, 'L1 was put to the person (the question appeared to them with its evidence and your recommendation). They answered "Confirmed": confirmed, by the person. Their note: "matches the change ticket".');
    assert.match(asked[0]!, /^Decide lead L1: The 03:12 login[\s\S]*logs\/auth\.log:812[\s\S]*The agent recommends: confirm/);
    assert.match((await tool('leads', {})).content, /L1 \[confirmed by the person\][\s\S]*the person's note: matches the change ticket/);
    // Coverage: an item neither done nor N/A fails the gate.
    await fs.mkdir(path.join(dir, 'investigation'), { recursive: true });
    const gate = async (text: string) => { await fs.writeFile(path.join(dir, 'investigation', 'checklist.md'), text); return (await runGates(h.registry, host, ['coverage'], new AbortController().signal))[0]!; };
    assert.match((await gate('- [x] auth logs: L1\n- [ ] cron history\n- [ ] backups: N/A: none exist\n')).details!, /^- \[ \] cron history$/);
    assert.equal((await gate('- [x] auth logs: L1\n- [x] cron history: L2\n- [ ] backups: N/A: none exist\n')).pass, true);
    assert.deepEqual(validateWorkflow(h.registry.workflows.get('investigation')!), []);
    assert.ok(CONTROL_PLANE_DENY.includes('write(.harness/investigation-mandate.json)'));
  } finally { await h.close(); }
});
