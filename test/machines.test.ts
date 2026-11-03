import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { finalVerdict } from '../src/agents/acceptance.ts';
import { cleanPolicy, type CompanionJob, createCompanionHandler, DEFAULT_POLICY, type MachinePolicy, policyRefusal } from '../src/companion/handler.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { CompanionHub } from '../src/runtime/companion.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// A swarm across the person's computers (docs/swarm/SWARM.md, phase 7; research: docs/swarm/research/multi_machine.md):
// stop means stop on the machine too (a cancel kills the job's processes; a job the server no longer waits for is
// stopped; with no word from the server the companion stops everything itself), the machine's own policy decides what
// swarm agents may do there (the server cannot widen it), a delegation can be placed on a computer, and at stakes a
// machine's checks of its own work do not accept it. Asserted on the machine's processes and files, not on reports.

type Handler = ReturnType<typeof createCompanionHandler>;

/** A companion in this process that runs its jobs at once, side by side (as the real one does), reporting what runs. */
function companion(hub: CompanionHub, id: string, dir: string, o: { policy?: MachinePolicy; sandboxed?: boolean; info?: Record<string, unknown> } = {}) {
  const audit: { kind: string; what: string; swarm: boolean; outcome: string }[] = [];
  const handle: Handler = createCompanionHandler(dir, { allowHooks: true, policy: () => o.policy ?? DEFAULT_POLICY, audit: (e) => audit.push(e), ...(o.sandboxed ? { host: sandboxedLocal(dir) } : {}) });
  let on = true;
  (async () => {
    while (on) {
      const job = await hub.poll(id, { platform: process.platform, shell: 'bash', root: dir, ...o.info }, 100, handle.running());
      if (!job) continue;
      void handle(job as CompanionJob).then((r) => hub.complete(id, job.id, r.ok, r.value));
    }
  })();
  return { handle, audit, stop: () => { on = false; handle.stopAll('test over'); } };
}

/** The folder's host, said to be sandboxed (what a bubblewrap or Docker companion reports): for the policy's sandbox rule. */
function sandboxedLocal(dir: string) {
  const h = new LocalHost(dir);
  Object.defineProperty(h, 'sandboxed', { get: () => true });
  return h;
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

test('a stop reaches the machine: the cancelled command\'s processes are killed (its later write never happens), the job is gone from the machine', async () => {
  const hub = new CompanionHub(await tempDir());
  const { id } = await hub.create('laptop');
  const dir = await tempDir();
  const c = companion(hub, id, dir);
  try {
    await new Promise((r) => setTimeout(r, 150));
    const host = hub.host(id, 'sess');
    const ac = new AbortController();
    const t0 = Date.now();
    const run = host.exec('sleep 10; echo late > late.txt', { timeoutMs: 60_000, signal: ac.signal });
    await waitFor(() => c.handle.running().length === 1, 'the command runs on the machine');
    ac.abort();
    await assert.rejects(run, /aborted/);
    await waitFor(() => c.handle.running().length === 0, 'stopped on the machine', 10_000);
    assert.ok(Date.now() - t0 < 9000, 'stopped well before the command would have ended');
    await new Promise((r) => setTimeout(r, 11_000));
    assert.equal(await exists(path.join(dir, 'late.txt')), false, 'its processes were killed: the write after the sleep never happened');
    assert.ok(c.audit.some((e) => e.kind === 'cancel' && e.outcome === 'stopped'), 'the machine\'s own log has the stop');
    assert.ok(c.audit.some((e) => e.kind === 'exec' && /^stopped/.test(e.outcome)));
  } finally { c.stop(); }
});

test('a job the server no longer waits for (it restarted) is stopped at the next poll; two stops are one', async () => {
  const dir = await tempDir();
  const data = await tempDir();
  const hub = new CompanionHub(data);
  const { id } = await hub.create('laptop');
  const handle = createCompanionHandler(dir, { allowHooks: true });
  await hub.poll(id, { platform: process.platform, shell: 'bash', root: dir }, 0);
  const sent = hub.host(id, 's').exec('sleep 12; echo late > late.txt', { timeoutMs: 60_000 }).catch(() => undefined);
  const job = (await hub.poll(id, { platform: process.platform, shell: 'bash', root: dir }, 1000))!;
  const running = handle(job);
  await waitFor(() => handle.running().length === 1, 'running');
  // The server restarts: a new hub knows nothing of the job, and the machine says it is running it.
  const again = new CompanionHub(data);
  await again.load();
  const cancel = await again.poll(id, { platform: process.platform, shell: 'bash', root: dir }, 0, handle.running());
  assert.equal(cancel?.kind, 'cancel');
  assert.equal((cancel as Extract<CompanionJob, { kind: 'cancel' }>).target, job.id);
  assert.deepEqual((await handle(cancel!)).value, { stopped: true });
  assert.deepEqual((await handle(cancel!)).value, { stopped: false }, 'a second stop does nothing');
  assert.equal((await running).ok, false);
  assert.equal(handle.running().length, 0);
  void sent;
  await new Promise((r) => setTimeout(r, 13_000));
  assert.equal(await exists(path.join(dir, 'late.txt')), false);
});

test('fenced (no word from the server for the lease): what runs stops, nothing new starts until the server is heard again', async () => {
  const dir = await tempDir();
  const handle = createCompanionHandler(dir, { allowHooks: true });
  const job = (n: number, command: string): CompanionJob => ({ id: `j${n}`, kind: 'exec', sessionId: 's', command, timeoutMs: 30_000 });
  const long = handle(job(1, 'sleep 10; echo late > late.txt'));
  await waitFor(() => handle.running().length === 1, 'running');
  handle.stopAll('no word from the server for 120s', true);
  assert.equal((await long).ok, false);
  const refused = await handle(job(2, 'echo hi'));
  assert.deepEqual([refused.ok, /stopped taking work: no word from the server/.test(String((refused.value as { error: string }).error))], [false, true]);
  handle.unfence();
  assert.equal((await handle(job(3, 'echo hi'))).ok, true);
  await new Promise((r) => setTimeout(r, 11_000));
  assert.equal(await exists(path.join(dir, 'late.txt')), false);
});

test('the machine\'s policy decides what swarm agents do there, whatever the server says; the conversation\'s own agent is as before', () => {
  const tool = (name: string, input: Record<string, unknown> = {}, swarm = true): CompanionJob => ({ id: 'x', kind: 'tool', sessionId: 's', name, input, swarm });
  // No policy file: swarm agents may read, nothing more.
  assert.equal(policyRefusal(tool('read', { path: 'a' }), DEFAULT_POLICY, false), undefined);
  assert.match(policyRefusal(tool('write', { path: 'a', content: 'x' }), DEFAULT_POLICY, false)!, /policy: write needs edit, and swarm work here may only read/);
  assert.match(policyRefusal({ id: 'x', kind: 'exec', sessionId: 's', command: 'npm test', timeoutMs: 1, swarm: true }, DEFAULT_POLICY, true)!, /a command needs exec/);
  assert.equal(policyRefusal(tool('write', { path: 'a', content: 'x' }, false), DEFAULT_POLICY, false), undefined, 'not swarm work: the start flags decide, as before');
  // Swarm work off altogether.
  assert.match(policyRefusal(tool('read', { path: 'a' }), cleanPolicy({ swarm: false }), true)!, /does not take swarm work/);
  // Writing and commands allowed, but only in a sandbox.
  const p = cleanPolicy({ swarm: true, kinds: ['read', 'edit', 'exec'] });
  assert.match(policyRefusal(tool('bash', { command: 'make' }), p, false)!, /beyond reading runs only in a sandbox/);
  assert.equal(policyRefusal(tool('bash', { command: 'make' }), p, true), undefined);
  assert.match(policyRefusal(tool('bash', { command: 'serve', run_in_background: true }), p, true)!, /background commands outlive the job/);
  assert.match(policyRefusal(tool('web_fetch', { url: 'https://x.example' }), p, true)!, /needs network/);
  // A policy file with nonsense in it: the defaults, never more.
  assert.deepEqual(cleanPolicy({ swarm: 'yes', kinds: ['root', 'read'], maxJobs: 1e9, sandboxRequired: 0 }), { swarm: false, kinds: ['read'], maxJobs: DEFAULT_POLICY.maxJobs, sandboxRequired: true });
});

test('the machine\'s capacity holds: 6 swarm commands sent at once run at most 2 at a time', async () => {
  const dir = await tempDir();
  const policy = cleanPolicy({ swarm: true, kinds: ['read', 'exec'], maxJobs: 2, sandboxRequired: false });
  const handle = createCompanionHandler(dir, { allowHooks: true, policy: () => policy });
  const t0 = Date.now();
  const marks: number[] = [];
  await Promise.all(Array.from({ length: 6 }, (_, i) => handle({ id: `c${i}`, kind: 'exec', sessionId: 's', command: 'sleep 1', timeoutMs: 30_000, swarm: true }).then((r) => { assert.equal(r.ok, true); marks.push(Date.now() - t0); })));
  marks.sort((a, b) => a - b);
  // Two at a time: three waves of about a second each.
  assert.ok(marks[5]! >= 2800, `the last finished after three waves (${marks.join(', ')} ms)`);
  assert.ok(marks[1]! < 2500 && marks[2]! >= 1800, `two in the first wave, the third in the second (${marks.join(', ')} ms)`);
});

test('a delegation placed on the person\'s computer works in that computer\'s folder, under its policy; a stop of the swarm stops its command there', async () => {
  const t = await setupServer();
  const { id } = await t.harness.companions.create('laptop');
  const laptop = await tempDir('hw-laptop-');
  let policy: MachinePolicy = DEFAULT_POLICY;
  // The laptop's companion, said to be sandboxed; it reads its policy for each job (the test changes it as its owner would).
  const handler = createCompanionHandler(laptop, { allowHooks: true, host: sandboxedLocal(laptop), policy: () => policy });
  let on = true;
  void (async () => {
    while (on) {
      const job = await t.harness.companions.poll(id, { platform: process.platform, shell: 'bash', root: laptop, sandbox: 'bwrap', network: 'none' }, 100, handler.running());
      if (job) void handler(job as CompanionJob).then((r) => t.harness.companions.complete(id, job.id, r.ok, r.value));
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 200));
    const here = await tempDir('hw-here-');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: here, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
    const call = (input: Record<string, unknown>) => ({ name: 'agent', input: { description: 'on the laptop', type: 'general', machine: 'laptop', ...input } });

    // The default policy: the agent may read on the laptop, and its write is refused there (by the machine).
    t.ds.scripts.lead = [{ calls: [call({ prompt: '[[w1]] Write the notes.' })] }, { text: 'Tried.' }];
    t.ds.scripts.w1 = [{ calls: [{ name: 'write', input: { path: 'notes.md', content: 'from the swarm\n' } }] }, { text: 'Could not write.' }];
    await turn('[[lead]] Go.');
    const spec = t.ds.requests.find((r) => r.tools.some((x) => x.name === 'agent'))!.tools.find((x) => x.name === 'agent')!;
    assert.deepEqual((spec.input_schema as { properties: Record<string, { enum?: string[] }> }).properties.machine!.enum, ['laptop'], 'the tool names the person\'s computers');
    const w1 = ev.find((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'write' && !!e.agent && e.agent !== 'main')!;
    assert.match(w1.content, /refused by this machine's policy: write needs edit/);
    assert.equal(await exists(path.join(laptop, 'notes.md')), false);

    // The owner allows writing and commands (on the machine): the write lands on the laptop, not here.
    policy = cleanPolicy({ swarm: true, kinds: ['read', 'edit', 'exec'], maxJobs: 4 });
    t.ds.scripts.lead = [{ calls: [call({ prompt: '[[w2]] Write the notes.' })] }, { text: 'Done.' }];
    t.ds.scripts.w2 = [{ calls: [{ name: 'write', input: { path: 'notes.md', content: 'from the swarm\n' } }] }, { text: 'Wrote notes.md.' }];
    await turn('[[lead]] Go.');
    assert.equal(await fs.readFile(path.join(laptop, 'notes.md'), 'utf8'), 'from the swarm\n');
    assert.equal(await exists(path.join(here, 'notes.md')), false, 'nothing in the conversation\'s own folder');

    // A long command on the laptop, then Stop all: it stops there too (its later write never happens).
    t.ds.scripts.lead = [{ calls: [call({ prompt: '[[w3]] Build it.' })] }, { text: 'Stopped.' }];
    t.ds.scripts.w3 = [{ calls: [{ name: 'bash', input: { command: 'sleep 12; echo late > late.txt', timeout_ms: 60_000 } }] }, { text: 'Built.' }];
    const n = ends();
    await s.send('[[lead]] Go.');
    await waitFor(() => handler.running().length === 1, 'the command runs on the laptop', 20_000);
    assert.equal((await t.call(OPERATOR, 'POST', `/api/sessions/${s.meta.id}/stop_agents`, {})).status, 200);
    await waitFor(() => handler.running().length === 0, 'stopped on the laptop', 10_000);
    await waitFor(() => ends() > n, 'the turn', 60_000);
    await new Promise((r) => setTimeout(r, 13_000));
    assert.equal(await exists(path.join(laptop, 'late.txt')), false, 'the stop reached the laptop\'s processes');

    // A computer that is not one of the person's: refused before anything starts.
    t.ds.scripts.lead = [{ calls: [call({ prompt: 'x', machine: 'desktop' })] }, { text: 'No such computer.' }];
    await turn('[[lead]] Go.');
    const r = ev.filter((e): e is Extract<HarnessEvent, { kind: "tool_result" }> => e.kind === "tool_result" && e.name === "agent").at(-1)!;
    assert.match(r.content, /parameter "machine" must be one of "laptop"/);
  } finally { on = false; handler.stopAll('test over'); await t.close(); }
});

test('at stakes, checks that ran only on the computer that did the work do not accept it', () => {
  const pass = { verdict: 'pass' as const, issues: [] };
  const results = [{ label: 'run npm test', ok: true, detail: 'exit 0' }];
  assert.equal(finalVerdict(pass, results, { stakes: 'high', remote: true }).verdict, 'unknown');
  assert.match(finalVerdict(pass, results, { stakes: 'high', remote: true }).overruled!, /ran only on the computer that did the work are its own report/);
  assert.equal(finalVerdict(pass, results, { stakes: 'high' }).verdict, 'pass', 'on the server: as before');
  assert.equal(finalVerdict(pass, results, { remote: true }).verdict, 'pass', 'at normal stakes: as before');
});

test('Windows: a stopped command started through timeout, exec or a nested shell is killed with all it started (seen live: a build ran on after Stop all)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  for (const command of ['timeout 550 bash b.sh', 'timeout 550 bash b.sh > out.txt 2>&1', 'bash -c "exec bash b.sh"', 'bash b.sh']) {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'b.sh'), 'echo started > started.txt\nsleep 8\necho late > late.txt\n');
    const ac = new AbortController();
    const run = new LocalHost(dir).exec(command, { timeoutMs: 60_000, signal: ac.signal });
    // Stopped once it runs (as Stop all finds a build): a stop in the very first moment of a cold Git Bash start can
    // still lose a process caught mid-start (seen in a loaded test run); that case is not covered here.
    await waitFor(() => exists(path.join(dir, 'started.txt')), 'the command runs', 20_000);
    ac.abort();
    await run;
    await new Promise((r) => setTimeout(r, 9000));
    assert.equal(await exists(path.join(dir, 'late.txt')), false, `${command}: its processes were killed`);
  }
});

test('"these computers" with no items is the same brief on each of them (seen live: it ran once, in the conversation\'s own folder)', async () => {
  const { makeAgentTool, BUILTIN_AGENTS } = await import('../src/agents/agents.ts');
  const tool = makeAgentTool(BUILTIN_AGENTS, { machines: ['laptop', 'office'] });
  const seen: { machine?: string; prompt: string }[] = [];
  const r = await tool.run({ description: 'count', type: 'general', prompt: 'Count the TODO lines in todo.txt.', machines: ['laptop', 'office'] }, { runSubagent: async (a: { machine?: string; prompt: string }) => { seen.push(a); return `counted on ${a.machine}`; }, signal: new AbortController().signal, services: {} } as never);
  assert.deepEqual(seen.map((a) => a.machine), ['laptop', 'office']);
  assert.match(String(r.content), /\| 1 \| laptop \| on laptop \| done \|[\s\S]*\| 2 \| office \| on office \| done \|/);
});

test('each machine\'s own key: pinned on its first poll, another key refused; a result must be signed with it (an unsigned or forged one fails its job); its policy shown as signed', async () => {
  const { machineKey, policyPayload, resultPayload, sign } = await import('../src/companion/sign.ts');
  const t = await setupServer();
  try {
    const made = (await t.call(OPERATOR, 'POST', '/api/companions', { name: 'keyed' })).body as { id: string; token: string };
    const home = await tempDir();
    const fsSync = await import('node:fs');
    const k1 = machineKey(path.join(home, 'a.key'), fsSync, path);
    const k2 = machineKey(path.join(home, 'b.key'), fsSync, path);
    assert.deepEqual(machineKey(path.join(home, 'a.key'), fsSync, path), k1, 'the same key on the next start');
    const policy = { swarm: true, kinds: ['read'], maxJobs: 2, sandboxRequired: true };
    const poll = (key: { privateKey: string; publicKey: string } | undefined, wait = 0) => fetch(`${t.base}/api/companion/poll`, { method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ info: { platform: 'linux', shell: 'bash', root: '/home/u', policy }, ...(key ? { publicKey: key.publicKey, policySignature: sign(key.privateKey, policyPayload(policy)) } : {}), wait }) });
    // The first poll pins its key (and comes back at once, nothing to do).
    const first = poll(k1);
    await new Promise((r) => setTimeout(r, 300));
    const job = t.harness.companions.host(made.id, 's1').exec('echo hi', { timeoutMs: 30_000 }).then(() => undefined, (e: Error) => e);
    const got = await (await first).json() as { id: string };
    assert.equal(t.harness.companions.publicKeyOf(made.id)?.includes('BEGIN PUBLIC KEY'), true);
    const listed = (await t.call(OPERATOR, 'GET', '/api/companions')).body as { id: string; keyed: boolean; info: { policySigned?: boolean } }[];
    assert.deepEqual([listed.find((c) => c.id === made.id)!.keyed, listed.find((c) => c.id === made.id)!.info.policySigned], [true, true]);
    // Another key, or none: refused, whatever the token.
    assert.equal((await poll(k2)).status, 401);
    assert.equal((await poll(undefined)).status, 401);
    // An unsigned result is refused and fails its job; a forged one too.
    const result = (body: Record<string, unknown>) => fetch(`${t.base}/api/companion/result`, { method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = { stdout: 'hi\n', stderr: '', code: 0, timedOut: false };
    assert.equal((await result({ jobId: got.id, ok: true, value: { ...value, stdout: 'forged\n' }, signature: sign(k2.privateKey, resultPayload(got.id, true, value)) })).status, 403);
    assert.match(String((await job)?.message), /not signed with the key of this machine/);
    // A signed result is taken.
    const p2 = poll(k1);
    await new Promise((r) => setTimeout(r, 300));
    const job2 = t.harness.companions.host(made.id, 's1').exec('echo hi', { timeoutMs: 30_000 });
    const got2 = await (await p2).json() as { id: string };
    assert.equal((await result({ jobId: got2.id, ok: true, value, signature: sign(k1.privateKey, resultPayload(got2.id, true, value)) })).status, 200);
    assert.equal((await job2).stdout, 'hi\n');
  } finally { await t.close(); }
});

test('re-placed: an item whose computer is offline (or drops mid-way) goes to the next computer of the fan-out, once each, and says so', async () => {
  const { makeAgentTool, BUILTIN_AGENTS } = await import('../src/agents/agents.ts');
  const tool = makeAgentTool(BUILTIN_AGENTS, { machines: ['laptop', 'office', 'server'] });
  const seen: string[] = [];
  const run = async (a: { machine?: string; prompt: string }) => {
    seen.push(`${a.prompt.slice(-6)}@${a.machine}`);
    if (a.machine === 'laptop') throw new Error('The computer "laptop" is offline: its companion is not running. Work elsewhere, or ask the person to start it.');
    if (a.machine === 'office' && /item-2/.test(a.prompt)) return 'Could not finish: the companion did not answer in time';
    return `did ${a.prompt.slice(-6)} on ${a.machine}`;
  };
  const r = String((await tool.run({ description: 'jobs', type: 'general', prompt: 'Do {{item}}', items: ['item-1', 'item-2', 'item-3'], machines: ['laptop', 'office', 'server'] }, { runSubagent: run, signal: new AbortController().signal, services: {} } as never)).content);
  // item-1: laptop offline -> office. item-2: office drops -> server. item-3: server, as placed.
  assert.deepEqual(seen.sort(), ['item-1@laptop', 'item-1@office', 'item-2@office', 'item-2@server', 'item-3@server'].sort());
  assert.match(r, /\| 1 \| item-1 \| on office \| done \|[\s\S]*\| 2 \| item-2 \| on server \| done \|[\s\S]*\| 3 \| item-3 \| on server \| done \|/);
  assert.match(r, /Re-placed from laptop to office: it was offline or dropped/);
  assert.match(r, /Re-placed from office to server/);
});

test('files between computers: through the harness with their hash, into this folder or onto another computer; a swarm agent\'s copy held to the receiving computer\'s policy', async () => {
  const t = await setupServer();
  const laptopDir = await tempDir('hw-lap-'); const officeDir = await tempDir('hw-off-');
  await fs.writeFile(path.join(laptopDir, 'report.csv'), 'id,status\n1,OK\n2,FAILED\n');
  const lap = (await t.harness.companions.create('laptop')).id; const off = (await t.harness.companions.create('office')).id;
  const loops: (() => void)[] = [];
  for (const [id, dir, policy] of [[lap, laptopDir, cleanPolicy({ swarm: true, kinds: ['read', 'edit'], sandboxRequired: false })], [off, officeDir, DEFAULT_POLICY]] as const) {
    const handler = createCompanionHandler(dir, { policy: () => policy });
    let on = true;
    void (async () => { while (on) { const job = await t.harness.companions.poll(id, { platform: process.platform, shell: 'bash', root: dir }, 100, handler.running()); if (job) void handler(job as CompanionJob).then((r) => t.harness.companions.complete(id, job.id, r.ok, r.value)); } })();
    loops.push(() => { on = false; });
  }
  try {
    await new Promise((r) => setTimeout(r, 200));
    const here = await tempDir('hw-here-');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: here, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
    const results = () => ev.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'copy_file');
    t.ds.scripts.lead = [{ calls: [{ name: 'copy_file', input: { from: 'laptop', path: 'report.csv', to: 'here' } }, { name: 'copy_file', input: { from: 'laptop', path: 'report.csv', to: 'office', to_path: 'in/report.csv' } }] }, { text: 'Copied.' }];
    await turn('[[lead]] Bring the report over.');
    const sha = (await import('node:crypto')).createHash('sha256').update('id,status\n1,OK\n2,FAILED\n').digest('hex');
    assert.equal(results()[0]!.content, `Copied laptop:report.csv to here:report.csv (24 bytes, sha256 ${sha}). Its contents came from laptop: outside content.`);
    assert.equal(await fs.readFile(path.join(here, 'report.csv'), 'utf8'), 'id,status\n1,OK\n2,FAILED\n');
    assert.equal(await fs.readFile(path.join(officeDir, 'in', 'report.csv'), 'utf8'), 'id,status\n1,OK\n2,FAILED\n', 'the conversation\'s own agent: the office takes it (its start flags)');
    // A swarm agent's copy onto the office: its policy (read only) refuses the write.
    t.ds.scripts.lead = [{ calls: [{ name: 'agent', input: { description: 'copy', type: 'general', prompt: '[[cp]] Copy it.' } }] }, { text: 'Tried.' }];
    t.ds.scripts.cp = [{ calls: [{ name: 'copy_file', input: { from: 'laptop', path: 'report.csv', to: 'office', to_path: 'swarm/report.csv' } }] }, { text: 'Could not.' }];
    await turn('[[lead]] Go.');
    assert.match(results().at(-1)!.content, /^Not copied: refused by this machine's policy: a file sent here needs edit/);
    await assert.rejects(fs.access(path.join(officeDir, 'swarm', 'report.csv')));
    assert.ok(t.ds.requests.some((r) => r.tools.some((x) => x.name === 'copy_file')), 'offered when there are computers');
  } finally { for (const l of loops) l(); await t.close(); }
});

test('done once: a call that changes something, repeated while its result never reached the server, is not run again (its result is handed over); once delivered, it runs; a restart keeps the journal', async () => {
  const dir = await tempDir();
  const journal = path.join(await tempDir(), 'journal.json');
  const h1 = createCompanionHandler(dir, { allowHooks: true, journal });
  const exec = (id: string): CompanionJob => ({ id, kind: 'exec', sessionId: 's', command: 'echo deployed >> deploys.txt; echo ok', timeoutMs: 30_000, opKey: 'k-deploy' });
  const lines = async () => (await fs.readFile(path.join(dir, 'deploys.txt'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const first = await h1(exec('j1'));
  assert.equal(first.ok, true);
  // The machine dropped before the server heard: the agent asks again, the same call. It is not deployed twice.
  const again = await h1(exec('j2'));
  assert.equal(await lines(), 1, 'deployed once');
  assert.match(String((again.value as { stdout: string }).stdout), /^\[Done on this computer at .*, while the server could not hear it: not run again\. Its result:\]\nok/);
  // A restart of the companion keeps it.
  const h2 = createCompanionHandler(dir, { allowHooks: true, journal });
  await h2(exec('j3'));
  assert.equal(await lines(), 1, 'still once after a restart');
  // Delivered: the next identical call is a new deploy.
  h2.delivered('j3');
  await h2(exec('j4'));
  assert.equal(await lines(), 2, 'a delivered result is not replayed');
  // Reads are not journaled: each runs.
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
  const read = (id: string): CompanionJob => ({ id, kind: 'tool', sessionId: 's', name: 'read', input: { path: 'a.txt' }, opKey: 'k-read' });
  await h2(read('r1'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'two\n');
  assert.match(String(((await h2(read('r2'))).value as { content: string }).content), /two/);
});

test('at stakes, work on a person\'s computer is checked again on the server: a machine that lies about its checks is caught; honest work passes there and is accepted', { skip: !(await (async () => { try { const { execFileSync } = await import('node:child_process'); return /ok/.test(execFileSync('docker', ['image', 'inspect', 'harness-sandbox:latest', '--format', 'ok'], { encoding: 'utf8', stdio: 'pipe' })); } catch { return false; } })()) && 'no Docker on this server: the recheck needs a sandbox here' }, async () => {
  const t = await setupServer();
  const laptop = await tempDir('hw-lap-');
  await fs.writeFile(path.join(laptop, 'check.js'), "const fs = require('fs'); process.exit(fs.existsSync('out.txt') && fs.readFileSync('out.txt', 'utf8').trim() === 'done' ? 0 : 1);\n");
  const id = (await t.harness.companions.create('laptop')).id;
  let lie = true;
  const handler = createCompanionHandler(laptop, { allowHooks: true, policy: () => cleanPolicy({ swarm: true, kinds: ['read', 'edit', 'exec'], sandboxRequired: false }) });
  let on = true;
  void (async () => {
    while (on) {
      const job = await t.harness.companions.poll(id, { platform: process.platform, shell: 'bash', root: laptop }, 100, handler.running());
      if (!job) continue;
      // A doctored companion: it says every command passed.
      void handler(job as CompanionJob).then((r) => t.harness.companions.complete(id, job.id, r.ok, lie && job.kind === 'exec' ? { stdout: '', stderr: '', code: 0, timedOut: false } : r.value));
    }
  })();
  try {
    assert.equal((await t.call(OPERATOR, 'PUT', '/api/me/settings', { delegation: { allowedModels: ['claude-sonnet-5-5'] } })).status, 200);
    await new Promise((r) => setTimeout(r, 200));
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: await tempDir(), mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 120_000); };
    const lastAgent = () => ev.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === 'agent').at(-1)!.content;
    const call = { name: 'agent', input: { description: 'make it', type: 'general', machine: 'laptop', stakes: 'high', done_when: [{ run: 'node check.js' }], max_fix_rounds: 0 } };
    const pass = { text: 'Checked.\n{"verdict": "pass", "issues": [], "requirements": [{"requirement": "out.txt says done", "status": "met"}]}' };
    // The worker claims it, writes nothing; the machine says its check passed. On the server it does not.
    t.ds.scripts.lead = [{ calls: [{ ...call, input: { ...call.input, prompt: '[[w1]] Write done into out.txt.' } }] }, { text: 'Reported.' }];
    t.ds.scripts.w1 = [{ text: 'Done: out.txt says done.' }];
    t.an.scripts.w1 = [pass, pass];
    await turn('[[lead]] Go.');
    assert.match(lastAgent(), /checks that ran only on the computer that did the work are its own report/);
    const notices = ev.filter((e): e is Extract<HarnessEvent, { kind: 'notice' }> => e.kind === 'notice').map((e) => e.text);
    assert.ok(notices.some((x) => /checks on the server: run again here .*1 did not pass: run `node check\.js`/.test(x)), JSON.stringify(notices));
    // Honest work: written on the laptop, and its check passes again here.
    lie = false;
    t.ds.scripts.lead = [{ calls: [{ ...call, input: { ...call.input, prompt: '[[w2]] Write done into out.txt.' } }] }, { text: 'Reported.' }];
    t.ds.scripts.w2 = [{ calls: [{ name: 'write', input: { path: 'out.txt', content: 'done\n' } }] }, { text: 'Wrote out.txt.' }];
    t.an.scripts.w2 = [pass, pass];
    await turn('[[lead]] Go again.');
    const after = ev.filter((e): e is Extract<HarnessEvent, { kind: 'notice' }> => e.kind === 'notice').map((e) => e.text);
    assert.ok(after.some((x) => /checks on the server: all \d passed again here/.test(x)), `${JSON.stringify(after.slice(-3))}\n${lastAgent().slice(0, 900)}`);
    assert.doesNotMatch(lastAgent(), /its own report/);
    assert.match(lastAgent(), /Verification by .*: PASS/);
  } finally { on = false; handler.stopAll('test over'); await t.close(); }
});
