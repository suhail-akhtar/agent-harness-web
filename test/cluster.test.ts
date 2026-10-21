import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { SessionElsewhereError } from '../src/core/session.ts';
import type { Message } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { clusterAuthHeader, createApp, verifyClusterAuth } from '../src/server/app.ts';
import { BrowserSessions } from '../src/server/oidc.ts';
import { SpendLedger, UserStore } from '../src/server/users.ts';
import { Leases, leaseUrlSig } from '../src/util/lease.ts';
import { withFileLock, writeFileAtomic } from '../src/util/shared-file.ts';
import { tempDir } from './helpers.ts';
import { freePort } from './real-services.ts';

// Several harness servers on one shared data folder (as behind a load balancer
// on NFS or a shared volume): two servers in this process, one temp folder.

process.env.HARNESS_SYNC_MS = '0';
const OPERATOR = 'operator-token-for-cluster-tests';
const TTL = 1500;
/** HARNESS_CLUSTER_SECRET: servers pass requests to each other only with it. */
const SECRET = 'cluster-secret-for-tests-0123456789abcdef';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider whose answers wait until the test lets them go, recording what it was sent. */
class GatedProvider implements Provider {
  requests: ProviderRequest[] = [];
  private gates: (() => void)[] = [];
  open = false;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    if (!this.open) {
      await new Promise<void>((resolve, reject) => {
        this.gates.push(resolve);
        req.signal.addEventListener('abort', () => reject(req.signal.reason ?? new Error('aborted')), { once: true });
      });
    }
    return {
      message: { role: 'assistant', content: [{ type: 'text', text: `answer ${this.requests.length}` }] },
      stop: 'end',
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 },
    };
  }
  release(): void { for (const g of this.gates.splice(0)) g(); }
}

async function node(data: string, id: string, opts: { url?: boolean; secret?: string | null; peers?: string[] } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const users = await new UserStore(data).load();
  const spend = await new SpendLedger(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', spend, cluster: { id, url: opts.url === false ? undefined : base, leaseTtlMs: TTL, ...(opts.secret === null ? {} : { secret: opts.secret ?? SECRET }), ...(opts.peers ? { peers: opts.peers } : {}) } });
  const provider = new GatedProvider();
  harness.registry.setProviderInstance('deepseek', provider);
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data, users, spend });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${OPERATOR}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}), ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers };
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await harness.close();
  };
  return { id, base, harness, provider, users, spend, call, close };
}

const textOf = (m: Message | undefined) => (m?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
// Generous: a loaded machine (the full suite on Windows) can be many times slower than a quiet one.
const waitFor = async (what: string, ok: () => boolean | Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await sleep(50); }
  assert.fail(`timed out waiting for ${what}`);
};

test('two servers on one data folder: both list the same sessions; one drives a turn, the other forwards to it or refuses; then the other takes its turn with the history', async () => {
  const data = await tempDir();
  const a = await node(data, 'node-a');
  const b = await node(data, 'node-b');
  const ws = await tempDir();
  try {
    // A session made on A is listed (and readable) on B: B reads the folder, not only its memory.
    const s = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws }, title: 'shared work' });
    const listB = await b.call('GET', '/api/sessions');
    assert.deepEqual(listB.body.map((x: { id: string }) => x.id), [s.meta.id]);
    assert.equal((await b.call('GET', `/api/sessions/${s.meta.id}`)).body.meta.title, 'shared work');

    // A runs a turn (its provider holds the answer): A holds the session's lease.
    const turnEnd = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    assert.equal((await a.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'first task, on A' })).status, 202);
    await waitFor('A to call its model', () => a.provider.requests.length === 1);
    const lease = await a.harness.cluster!.leases.holder(`session-${s.meta.id}`);
    assert.equal(lease?.owner, 'node-a');
    assert.equal(lease?.url, a.base);

    // B lists it as running, and B's own copy refuses to start a turn of its own.
    assert.equal((await b.call('GET', '/api/sessions')).body[0].status, 'running');
    const sB = b.harness.sessions.get(s.meta.id)!;
    await assert.rejects(sB.send('a second driver'), (e: unknown) => e instanceof SessionElsewhereError && e.holder.owner === 'node-a');
    assert.equal(b.provider.requests.length, 0, 'B never called a model for it');

    // A message through B is passed on to A (it joins A's running turn as a queued message).
    const viaB = await b.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'more, sent to B' });
    assert.equal(viaB.status, 202, JSON.stringify(viaB.body));
    assert.equal(viaB.body.state, 'queued');
    assert.equal(viaB.headers.get('x-harness-served-by'), 'node-a');
    // The event stream through B is A's stream.
    const ac = new AbortController();
    const stream = await fetch(`${b.base}/api/sessions/${s.meta.id}/events`, { headers: { authorization: `Bearer ${OPERATOR}` }, signal: ac.signal });
    assert.equal(stream.headers.get('x-harness-served-by'), 'node-a');
    // A request already passed on once is not passed on again: B answers 409 and names A.
    const refused = await b.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'x' }, { 'x-harness-forwarded': 'elsewhere' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.server, 'node-a');
    assert.equal(refused.body.url, a.base);
    assert.equal(refused.headers.get('x-harness-session-server'), a.base);

    // A finishes (two turns: the first, then the queued message); the stream through B saw it.
    const reader = stream.body!.getReader();
    let seen = '';
    const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); } })().catch(() => {});
    a.provider.open = true;
    a.provider.release();
    await turnEnd;
    await waitFor('the queued message to run on A', () => a.provider.requests.length === 2 && s.status === 'idle');
    await waitFor('the stream through B to carry the turn end', () => seen.includes('"turn_end"'));
    ac.abort();
    await reading;
    await waitFor('A to release the lease', async () => !(await a.harness.cluster!.leases.holder(`session-${s.meta.id}`)));

    // Now B drives it: it takes the lease, reads the session again (A's turns are in the
    // history it sends its model), and runs the turn.
    b.provider.open = true;
    const bEnd = new Promise<void>((r) => sB.subscribe(sB.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    assert.equal((await b.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'third, on B' })).status, 202);
    await bEnd;
    const sent = JSON.stringify(b.provider.requests[0]!.messages);
    for (const t of ['first task, on A', 'answer 1', 'more, sent to B', 'answer 2', 'third, on B']) assert.ok(sent.includes(t), `B's model saw "${t}"`);
    assert.equal(textOf(sB.history.at(-1)), 'answer 1');
    // And A, reading it again, sees B's turn.
    assert.ok(await s.syncFromDisk());
    assert.equal(s.history.length, 6);
    assert.equal((await a.call('GET', `/api/sessions/${s.meta.id}`)).body.history.length, 6);

    // A session deleted on B is gone from A's list.
    assert.equal((await b.call('DELETE', `/api/sessions/${s.meta.id}`)).status, 200);
    assert.deepEqual((await a.call('GET', '/api/sessions')).body, []);
  } finally {
    await a.close();
    await b.close();
  }
});

test('a crashed holder: its lease expires and another server takes the session over, closing the interrupted turn', async () => {
  const data = await tempDir();
  // No addresses (HARNESS_NODE_URL unset): requests for the other's sessions get a 409, not forwarded.
  const a = await node(data, 'node-a', { url: false });
  const b = await node(data, 'node-b', { url: false });
  try {
    const s = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    await s.send('a long job');
    await waitFor('A to call its model', () => a.provider.requests.length === 1);
    // A "crashes": it stops beating (and never answers); its lease and meta.running stay on disk.
    a.harness.cluster!.leases.halt();
    const sB = (await b.harness.sessions.sync(true), b.harness.sessions.get(s.meta.id)!);
    await assert.rejects(sB.send('too soon'), SessionElsewhereError);
    // B has no address of A's to pass requests to: a 409 that names A.
    const early = await b.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'x' });
    assert.equal(early.status, 409);
    assert.equal(early.body.server, 'node-a');
    assert.equal(early.body.url, undefined);

    await sleep(TTL + 200);
    b.provider.open = true;
    const end = new Promise<void>((r) => sB.subscribe(sB.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    assert.equal(await sB.send('carry on'), 'started');
    await end;
    await waitFor('B to release the lease after the turn', async () => !(await b.harness.cluster!.leases.read(`session-${s.meta.id}`)));
    const sent = JSON.stringify(b.provider.requests[0]!.messages);
    assert.ok(sent.includes('a long job') && sent.includes('carry on'));
    assert.equal(sB.meta.running, false);
    assert.ok(sB.history.some((m) => m.role === 'assistant'), 'B answered');
  } finally {
    a.harness.sessions.get([...a.harness.sessions.list()][0]?.id ?? '')?.abort();
    await a.close();
    await b.close();
  }
});

test('the scheduler fires on exactly one server, and another takes over when it stops', async () => {
  const data = await tempDir();
  const a = await node(data, 'node-a');
  const b = await node(data, 'node-b');
  try {
    a.provider.open = b.provider.open = true;
    const s = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const t0 = Date.now();
    const sch = await a.harness.scheduler!.create({ prompt: 'nightly check', inMinutes: 1, sessionId: s.meta.id }, t0);
    // Made on A, listed on B.
    assert.deepEqual((await b.call('GET', '/api/schedules')).body.map((x: { id: string }) => x.id), [sch.id]);
    // Both servers' timers come due at the same moment: one fires it.
    const due = sch.nextRun! + 1000;
    const [fa, fb] = await Promise.all([a.harness.scheduler!.tick(due), b.harness.scheduler!.tick(due)]);
    assert.equal(fa.length + fb.length, 1, `fired once (A ${fa.length}, B ${fb.length})`);
    await waitFor('the scheduled turn', () => a.provider.requests.length + b.provider.requests.length === 1);
    // Again, from either: nothing is due any more.
    assert.equal((await b.harness.scheduler!.tick(due + 5000)).length + (await a.harness.scheduler!.tick(due + 5000)).length, 0);
    await b.harness.scheduler!.sync(true);
    assert.equal(b.harness.scheduler!.get(sch.id)!.runs, 1);
    assert.equal(b.harness.scheduler!.get(sch.id)!.enabled, false, 'a one-time schedule ends after its run');

    // The leader stops; after the lease time the other one fires the next schedule.
    const leader = fa.length ? a : b;
    const other = leader === a ? b : a;
    await waitFor('the session to be idle', () => s.status === 'idle' && !s.meta.running);
    await sleep(200);
    leader.harness.cluster!.leases.halt();
    leader.harness.scheduler!.stop();
    const next = await other.harness.scheduler!.create({ prompt: 'second check', inMinutes: 1, sessionId: s.meta.id }, Date.now());
    const due2 = next.nextRun! + 1000;
    assert.equal((await other.harness.scheduler!.tick(due2)).length, 0, 'not while the old leader\'s lease is live');
    await sleep(TTL + 200);
    assert.equal((await other.harness.scheduler!.tick(due2)).length, 1, 'taken over');
  } finally {
    await a.close();
    await b.close();
  }
});

test('shared files: accounts, sign-ins, spend and companions changed on one server are seen on the other; concurrent changes are all kept', async () => {
  const data = await tempDir();
  const a = await node(data, 'node-a');
  const b = await node(data, 'node-b');
  try {
    // Accounts made on both at once: none lost; a token made on A works on B.
    const made = await Promise.all([
      ...['ann', 'abe', 'ada'].map((n) => a.users.add(n)),
      ...['bob', 'bea', 'bud'].map((n) => b.users.add(n)),
    ]);
    const onDisk = await new UserStore(data).load();
    assert.equal(onDisk.size, 6);
    const r = await fetch(`${b.base}/api/me`, { headers: { authorization: `Bearer ${made[0]!.token}` } });
    assert.equal(((await r.json()) as { name: string }).name, 'ann');
    // Disabled on B: refused on A at its next request.
    await b.users.setDisabled(made[0]!.user.id, true);
    assert.equal((await fetch(`${a.base}/api/me`, { headers: { authorization: `Bearer ${made[0]!.token}` } })).status, 401);

    // Spend from both servers adds up.
    a.spend.add('usr_x', 1.25);
    b.spend.add('usr_x', 2.5);
    await Promise.all([a.spend.flush(), b.spend.flush()]);
    await a.spend.refresh();
    assert.equal(a.spend.spentToday('usr_x'), 3.75);
    assert.equal((await new SpendLedger(data).load()).spentToday('usr_x'), 3.75);

    // A browser signed in on A is known on B; signing out on B ends it on A too.
    const bsA = await new BrowserSessions(data).load();
    const bsB = await new BrowserSessions(data).load();
    const [x, y] = await Promise.all([bsA.create('usr_1'), bsB.create('usr_2')]);
    await bsB.refresh();
    assert.equal(bsB.get(x), 'usr_1');
    await bsB.delete(x);
    await bsA.refresh();
    assert.equal(bsA.get(x), undefined);
    assert.equal(bsA.get(y), 'usr_2', 'B\'s own sign-in kept');

    // A companion added on A can connect to B; a token B renews is kept on disk for A.
    const c = await a.harness.companions.create('laptop');
    await b.harness.companions.refresh();
    assert.equal(b.harness.companions.authenticate(c.token), c.id);
  } finally {
    await a.close();
    await b.close();
  }
});

test('shared-file primitives: atomic writes never show part of a file; the lock serialises read-change-write; leases', async () => {
  const dir = await tempDir();
  const f = path.join(dir, 'x.json');
  // Many writers and a reader at once: every read is one whole version.
  const big = (n: number) => JSON.stringify({ n, pad: 'x'.repeat(50_000) });
  let stop = false;
  const reader = (async () => {
    let reads = 0;
    while (!stop) {
      const t = await fs.readFile(f, 'utf8').catch(() => null);
      if (t !== null) { assert.doesNotThrow(() => JSON.parse(t), 'a whole file'); reads++; }
      // (Windows cannot replace a file while it is open: a reader in a tight loop starves the writers.)
      await sleep(10);
    }
    return reads;
  })();
  // Three writers (as two servers and a CLI might), eight versions each, while the reader reads.
  await Promise.all([0, 1, 2].map(async (w) => { for (let i = 0; i < 8; i++) { await writeFileAtomic(f, big(w * 10 + i)); await sleep(10); } }));
  stop = true;
  assert.ok((await reader) > 0);
  assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), [], 'no temp files left');

  // Counter incremented by 40 concurrent read-change-writes: no update lost.
  const c = path.join(dir, 'counter.json');
  await writeFileAtomic(c, '0');
  await Promise.all(Array.from({ length: 40 }, () => withFileLock(c, async () => {
    const v = Number(await fs.readFile(c, 'utf8'));
    await sleep(1);
    await writeFileAtomic(c, String(v + 1));
  })));
  assert.equal(await fs.readFile(c, 'utf8'), '40');
  // A lock left by a crash is broken after it goes stale.
  await fs.writeFile(`${c}.lock`, 'crashed 1 0\n');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(`${c}.lock`, old, old);
  assert.equal(await withFileLock(c, async () => 'got it', { waitMs: 2000 }), 'got it');

  // Leases: one holder; another refused; released; stale taken over; the old holder learns it lost.
  let now = 1_000_000;
  const la = new Leases(path.join(dir, 'leases'), { owner: 'a', url: 'http://a', ttlMs: 1000, now: () => now });
  const lb = new Leases(path.join(dir, 'leases'), { owner: 'b', ttlMs: 1000, now: () => now });
  assert.deepEqual(await la.acquire('s1'), { ok: true, fresh: true });
  assert.deepEqual(await la.acquire('s1'), { ok: true, fresh: false });
  const no = await lb.acquire('s1');
  assert.equal(no.ok, false);
  assert.equal(!no.ok && no.holder.owner, 'a');
  assert.equal(!no.ok && no.holder.url, 'http://a');
  await la.release('s1');
  assert.equal((await lb.acquire('s1')).ok, true);
  await lb.release('s1');
  await la.acquire('s2');
  let lost = false;
  await la.acquire('s2', () => { lost = true; });
  now += 1500;
  assert.equal((await lb.acquire('s2')).ok, true, 'a stale lease is taken over');
  assert.equal(await la.renew('s2'), false);
  assert.equal(lost, true, 'the old holder is told');
  assert.equal((await lb.holder('s2'))?.owner, 'b');
});

/** A raw request (fetch would normalise a request line like `//host/path`). */
function rawRequest(base: string, method: string, requestPath: string, headers: Record<string, string>): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: requestPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('passing requests on: only to a verified peer, at its own origin (the request line cannot name another host), without the person\'s token or cookie; the peer maps the signed principal back', async () => {
  const data = await tempDir();
  // Any other host on the network: records whatever reaches it.
  const reached: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  const other = http.createServer((req, res) => { reached.push({ url: req.url!, headers: req.headers }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"other":true}'); });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const otherUrl = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
  const a = await node(data, 'node-a');
  const b = await node(data, 'node-b');
  const c = await node(data, 'node-c', { peers: [otherUrl] });
  const d = await node(data, 'node-d', { secret: null });
  try {
    const mia = await a.users.add('mia');
    const s = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: mia.user.id });
    const asMia = { authorization: `Bearer ${mia.token}`, cookie: `hw_token=${mia.token}` };
    assert.equal((await a.call('POST', `/api/sessions/${s.meta.id}/messages`, { text: 'work on A' }, { authorization: `Bearer ${mia.token}` })).status, 202);
    await waitFor('A to call its model', () => a.provider.requests.length === 1);
    const lease = await a.harness.cluster!.leases.holder(`session-${s.meta.id}`);
    assert.ok(lease?.sig, 'the lease\'s address is signed with the cluster secret');

    // The request line names another host: B still passes it to A's own origin, path and query only.
    const viaB = await rawRequest(b.base, 'GET', `//127.0.0.1:${new URL(otherUrl).port}/api/sessions/${s.meta.id}?x=1`, asMia);
    assert.equal(viaB.status, 200, viaB.body);
    assert.equal(viaB.headers['x-harness-served-by'], 'node-a', 'A answered, as the member (mapped back from the signed header)');
    assert.equal(reached.length, 0, 'nothing reached the host the request line named');

    // A lease file anyone with write access to the shared folder could edit: an address that is
    // not signed (or signed with another secret, or plain http off loopback) is not passed to.
    const idle = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() }, owner: mia.user.id });
    const forge = (url: string, sig?: string) => writeFileAtomic(path.join(data, 'leases', `session-${idle.meta.id}.lease`), JSON.stringify({ owner: 'node-x', url, ...(sig ? { sig } : {}), host: 'x', pid: 1, since: Date.now(), beat: Date.now() + 600_000, token: 't' }));
    const forged: [string, string | undefined][] = [[otherUrl, undefined], [otherUrl, leaseUrlSig('another-secret-0123456789abcdef0123', 'node-x', otherUrl)], ['http://10.255.255.1:9', leaseUrlSig(SECRET, 'node-x', 'http://10.255.255.1:9')]];
    for (const [url, sig] of forged) {
      await forge(url, sig);
      const r = await b.call('GET', `/api/sessions/${idle.meta.id}`, undefined, { authorization: `Bearer ${mia.token}` });
      assert.equal(r.status, 409, `${url} ${sig ? 'signed' : 'unsigned'}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.url, undefined, 'an unverified address is not even named');
    }
    assert.equal(reached.length, 0);
    // Without a cluster secret a server passes nothing on (A's own, signed, lease included).
    assert.equal((await d.call('GET', `/api/sessions/${s.meta.id}`, undefined, { authorization: `Bearer ${mia.token}` })).status, 409);

    // C lists the stand-in as a peer: the request goes there, without the person's token or cookie,
    // with a cluster header signed for exactly this method, path and query.
    await forge(otherUrl);
    const viaC = await rawRequest(c.base, 'GET', `/api/sessions/${idle.meta.id}/events?after=3`, asMia);
    assert.equal(viaC.status, 200, viaC.body);
    assert.equal(reached.length, 1);
    const got = reached[0]!;
    assert.equal(got.url, `/api/sessions/${idle.meta.id}/events?after=3`);
    assert.equal(got.headers.authorization, undefined);
    assert.equal(got.headers.cookie, undefined);
    assert.equal(got.headers['x-harness-forwarded'], 'node-c');
    const header = String(got.headers['x-harness-cluster-auth']);
    const p = `/api/sessions/${idle.meta.id}/events`;
    assert.equal(verifyClusterAuth(SECRET, header, 'GET', `${p}?after=3`)?.id, mia.user.id);
    assert.equal(verifyClusterAuth(SECRET, header, 'GET', p), undefined, 'bound to the query');
    assert.equal(verifyClusterAuth(SECRET, header, 'DELETE', `${p}?after=3`), undefined, 'bound to the method');
    assert.equal(verifyClusterAuth(SECRET, header, 'GET', `${p}?after=3`, Date.now() + 120_000), undefined, 'expires');

    // The receiving side: only a valid signature speaks for a person, and as the account is now.
    const me = '/api/me';
    const at = (h: string) => fetch(a.base + me, { headers: { 'x-harness-cluster-auth': h } });
    const mias = { id: mia.user.id, name: 'mia', role: 'member' as const };
    assert.equal((await at(clusterAuthHeader(SECRET, mias, 'GET', me, 'node-b'))).status, 200);
    assert.equal(((await (await at(clusterAuthHeader(SECRET, { ...mias, role: 'admin' }, 'GET', me, 'node-b'))).json()) as { role: string }).role, 'member', 'the role is the receiving server\'s, not a claim');
    assert.equal((await at(clusterAuthHeader('wrong-secret-0123456789abcdef0123456', mias, 'GET', me, 'node-b'))).status, 401);
    assert.equal((await at(clusterAuthHeader(SECRET, mias, 'GET', '/api/sessions', 'node-b'))).status, 401, 'signed for another path');
    assert.equal((await at('v1.1.e30.xxx')).status, 401);
    await a.users.setDisabled(mia.user.id, true);
    assert.equal((await at(clusterAuthHeader(SECRET, mias, 'GET', me, 'node-b'))).status, 401, 'a disabled account');
    await a.users.setDisabled(mia.user.id, false);
  } finally {
    a.provider.open = true;
    a.provider.release();
    for (const n of [a, b, c, d]) await n.close();
    other.close();
  }
});

test('lease races: a heartbeat never overwrites a takeover that lands between its read and its write, nor brings back a lease just released', async () => {
  const dir = path.join(await tempDir(), 'leases');
  const now = 1_000_000;
  const la = new Leases(dir, { owner: 'a', ttlMs: 1000, now: () => now });
  // B's clock is ahead: A's heartbeat looks stale to it, so B takes the lease over.
  const lb = new Leases(dir, { owner: 'b', ttlMs: 1000, now: () => now + 5000 });
  // Holds one read of a lease file (the heartbeat's) after it read the file and before it can
  // write, while something else happens.
  const realRead = fs.readFile;
  let hook: { file: string; run: () => Promise<void> } | undefined;
  (fs as { readFile: unknown }).readFile = async (...args: unknown[]) => {
    const got = await (realRead as (...a: unknown[]) => Promise<unknown>).apply(fs, args);
    const h = hook;
    if (h && String(args[0]).endsWith(h.file)) { hook = undefined; await h.run(); }
    return got;
  };
  try {
    assert.equal((await la.acquire('race-takeover')).ok, true);
    let takeover!: ReturnType<Leases['acquire']>;
    hook = { file: 'race-takeover.lease', run: async () => { takeover = lb.acquire('race-takeover'); await sleep(300); } };
    await la.renew('race-takeover');
    const tb = await takeover;
    assert.equal(tb.ok, true, 'B took over (A is stale on B\'s clock)');
    assert.equal((await la.read('race-takeover'))?.owner, 'b', 'B\'s takeover stands: A\'s heartbeat did not write over it');
    assert.equal(await la.renew('race-takeover'), false, 'A learns it lost');
    assert.equal(lb.holds('race-takeover'), true);

    assert.equal((await la.acquire('race-release')).ok, true);
    let releasing!: Promise<void>;
    hook = { file: 'race-release.lease', run: async () => { releasing = la.release('race-release'); await sleep(300); } };
    await la.renew('race-release');
    await releasing;
    assert.equal(await la.read('race-release'), undefined, 'released: the heartbeat in flight did not bring the file back');
    assert.equal(la.holds('race-release'), false);
    assert.equal((await lb.acquire('race-release')).ok, true, 'free for another server at once');
  } finally {
    (fs as { readFile: unknown }).readFile = realRead;
  }
});

test('vault names in cluster mode: values another server revealed are hidden here after a reload; a name added here is not lost to a reload or another server\'s save', async () => {
  const data = await tempDir();
  const a = await node(data, 'node-a');
  const b = await node(data, 'node-b');
  type Svc = { vaultService(main: boolean): import('../src/vault/store.ts').VaultService };
  const metaNames = async (id: string) => (JSON.parse(await fs.readFile(path.join(data, 'sessions', id, 'meta.json'), 'utf8')) as { vaultNames?: string[] }).vaultNames ?? [];
  try {
    await a.harness.vault!.put({}, { name: 'db-a', value: 'value-from-a-123' });
    await a.harness.vault!.put({}, { name: 'db-b', value: 'value-from-b-456' });
    const sA = await a.harness.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    await b.harness.sessions.sync(true);
    const sB = b.harness.sessions.get(sA.meta.id)!;
    await sB.loadSecrets(); // B has loaded the (empty) list once
    // A's session is given a value (a command with secrets), and saves.
    await (sA as unknown as Svc).vaultService(true).envFor({ X: 'db-a' }, 'test');
    await sA.saveMeta();
    assert.equal(await sB.syncFromDisk(), true);
    assert.equal((await sB.loadSecrets()).redact('x value-from-a-123'), 'x [vault:db-a]', 'B hides what A revealed');
    // B is given one too; before B saves, A writes the session again and B reads it: B keeps its name.
    await (sB as unknown as Svc).vaultService(true).envFor({ Y: 'db-b' }, 'test');
    sA.meta.title = 'changed on A';
    await sA.saveMeta();
    assert.equal(await sB.syncFromDisk(), true);
    assert.deepEqual([...sB.meta.vaultNames!].sort(), ['db-a', 'db-b']);
    await sB.saveMeta();
    assert.deepEqual((await metaNames(sA.meta.id)).sort(), ['db-a', 'db-b']);
    // A saves from its older copy (no db-b): the names on disk are kept (a union), and A hides db-b now.
    sA.meta.title = 'again on A';
    await sA.saveMeta();
    assert.deepEqual((await metaNames(sA.meta.id)).sort(), ['db-a', 'db-b']);
    assert.equal((await sA.loadSecrets()).redact('value-from-b-456'), '[vault:db-b]');
  } finally {
    await a.close();
    await b.close();
  }
});
