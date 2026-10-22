import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { HarnessClient, SseParser, apply, fromHistory, normaliseApprovals, readStream, sessionEvents, toApproval, toRows, type GlobalEvent } from '../packages/client/src/index.ts';

test('SSE parser: chunks split anywhere, CRLF, comments, multi-line data, ids', () => {
  const p = new SseParser();
  const all = [
    ...p.feed(': ping\n\nid: 7\ndata: {"a"'),
    ...p.feed(':1}\n\r'),
    ...p.feed('\ndata: line one\r\ndata: line two\r\n\r\nevent: x\ndata:no-space\n\n'),
    ...p.feed('data: partial'),
  ];
  assert.deepEqual(all, [{ data: '{"a":1}', id: '7' }, { data: 'line one\nline two', id: '7' }, { data: 'no-space', id: '7', event: 'x' }]);
  assert.deepEqual(p.feed('\n\n'), [{ data: 'partial', id: '7' }]);
});

/** A tiny server: session events with drops, a global stream (or none), sessions and approvals. */
function server(o: { global: boolean }) {
  let sessionHits = 0;
  const afters: string[] = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/sessions/aaaaaaaaaaaaaaaa/events') {
      afters.push(u.searchParams.get('after') ?? '');
      sessionHits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (sessionHits === 1) { res.write('id: 1\ndata: {"seq":1,"event":{"kind":"status","status":"running"}}\n\n'); res.write('id: 2\ndata: {"seq":2,"event":{"kind":"text_delta","text":"Hi"}}\n\n'); res.end(); return; }
      // After the drop: the server replays 2 (a duplicate) and sends 3.
      res.write('data: {"seq":2,"event":{"kind":"text_delta","text":"Hi"}}\n\n');
      res.write('data: {"seq":3,"event":{"kind":"turn_end","reason":"done"}}\n\n');
      return;
    }
    if (u.pathname === '/api/events') {
      if (!o.global) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('id: 1\ndata: {"seq":1,"topic":"approvals","payload":{"type":"added","sessionId":"aaaaaaaaaaaaaaaa","requestId":"r1","kind":"permission_request","title":"T","summary":"write a.txt","tool":"write","at":5}}\n\n');
      return;
    }
    if (u.pathname === '/api/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const list = [{ id: 'aaaaaaaaaaaaaaaa', title: 'Alpha', status: 'waiting', updatedAt: 2 }, { id: 'bbbbbbbbbbbbbbbb', title: 'Beta', status: 'idle', updatedAt: 1, archived: true }];
      // An older server: the plain array whatever the query.
      res.end(JSON.stringify(list));
      return;
    }
    if (u.pathname === '/api/approvals') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    if (u.pathname === '/api/sessions/aaaaaaaaaaaaaaaa') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ meta: { id: 'aaaaaaaaaaaaaaaa', title: 'Alpha' }, status: 'waiting', history: [], lastSeq: 3, pending: [{ kind: 'permission_request', requestId: 'r9', tool: 'bash', summary: 'ls', input: { command: 'ls' } }, { kind: 'text_delta', text: 'not pending' }] }));
      return;
    }
    if (u.pathname === '/api/health') { res.writeHead(404); res.end('{}'); return; }
    if (u.pathname === '/api/me') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"operator","role":"admin"}'); return; }
    if (u.pathname === '/api/plugins/x/enable' && req.method === 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hdr: req.headers['x-harness'], type: req.headers['content-type'] })); return; }
    res.writeHead(404); res.end('{}');
  });
  return new Promise<{ base: string; close: () => Promise<void>; afters: string[] }>((r) => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, afters, close: () => new Promise((c) => { srv.closeAllConnections(); srv.close(() => c()); }) })));
}

test('session events: resume after a drop from the last sequence, without duplicates', async () => {
  const s = await server({ global: true });
  const seen: string[] = [];
  const stop = await new Promise<() => void>((resolve) => {
    const st = sessionEvents({ fetch: fetch as never, base: s.base, id: 'aaaaaaaaaaaaaaaa', after: 0, onEvent: (e, seq) => { seen.push(`${seq}:${e.kind}`); if (e.kind === 'turn_end') resolve(st); } });
  });
  stop();
  assert.deepEqual(seen, ['1:status', '2:text_delta', '3:turn_end']);
  assert.deepEqual(s.afters, ['0', '2'], 'the reconnect asks from 2');
  await s.close();
});

test('readStream: a 404 stops at once (the endpoint does not exist)', async () => {
  const s = await server({ global: false });
  const states: string[] = [];
  await new Promise<void>((resolve) => { readStream({ fetch: fetch as never, url: () => `${s.base}/api/events`, onMessage: () => {}, onState: (st) => { states.push(st); if (st === 'missing') resolve(); } }); });
  assert.deepEqual(states, ['missing']);
  await s.close();
});

test('global events: the server stream when it exists, else polling with the same topics', async () => {
  const withStream = await server({ global: true });
  const c1 = new HarnessClient({ base: withStream.base });
  const g1 = c1.globalEvents(50);
  const got1 = await new Promise<GlobalEvent>((resolve) => { g1.on(resolve); g1.start(); });
  assert.equal(g1.mode, 'stream');
  assert.equal(got1.topic, 'approvals');
  assert.deepEqual(toApproval(got1.payload), { sessionId: 'aaaaaaaaaaaaaaaa', requestId: 'r1', kind: 'permission_request', title: 'T', summary: 'write a.txt', tool: 'write', at: 5 });
  g1.stop();
  await withStream.close();

  const old = await server({ global: false });
  const c2 = new HarnessClient({ base: old.base });
  const g2 = c2.globalEvents(50);
  const topics: GlobalEvent[] = [];
  await new Promise<void>((resolve) => { g2.on((e) => { topics.push(e); if (topics.length === 2) resolve(); }); g2.start(); });
  assert.equal(g2.mode, 'polling');
  assert.equal(topics[0]!.topic, 'sessions');
  assert.equal(topics[1]!.topic, 'approvals');
  const approvals = (topics[1]!.payload as { approvals: Array<{ requestId: string; summary: string; request?: unknown }> }).approvals;
  assert.equal(approvals.length, 1, 'gathered from the waiting session, pending requests only');
  assert.equal(approvals[0]!.requestId, 'r9');
  assert.equal(approvals[0]!.summary, 'ls');
  assert.ok(approvals[0]!.request, 'the full request is kept when the client has it');
  g2.stop();

  // Older server: health falls back to /api/me; a query is applied on the client.
  assert.deepEqual(await c2.health(), { ok: true, legacy: true });
  assert.equal(c2.has('health'), false);
  assert.deepEqual((await c2.sessions.list({ query: 'alp' })).sessions.map((x) => x.title), ['Alpha']);
  assert.deepEqual((await c2.sessions.list({ archived: false })).sessions.map((x) => x.title), ['Alpha']);
  // Writes carry the header the server requires and JSON.
  assert.deepEqual(await c2.plugins.enable('x'), { hdr: '1', type: 'application/json' });
  await old.close();
});

test('approvals: server items, full events, and junk', () => {
  assert.deepEqual(normaliseApprovals([
    { sessionId: 's', requestId: 'a', kind: 'question', title: 'T', summary: 'Which?', at: 1 },
    { sessionId: 's', request: { kind: 'plan_proposed', requestId: 'b', plan: '1. do' } },
    { sessionId: 's', requestId: 'c', kind: 'text_delta' },
    'nonsense', null, { requestId: 'd', kind: 'question' },
  ]).map((a) => `${a.requestId}:${a.kind}:${a.summary}`), ['a:question:Which?', 'b:plan_proposed:1. do']);
  assert.deepEqual(normaliseApprovals({ approvals: [{ sessionId: 's', requestId: 'e', kind: 'approval_request', at: 2 }] }).map((a) => a.requestId), ['e']);
});

test('the agent platform: new events leave the timeline alone, streams say they are the desktop, client calls are answered', async () => {
  let live = { items: fromHistory([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'artifact_ref', id: 'x' } as never] }]), contextTokens: 0, contextWindow: 0 };
  const before = JSON.stringify(toRows(live.items, false));
  for (const e of [
    { kind: 'artifact', artifact: { id: 'a1', title: 'Plan', kind: 'markdown', version: 2, action: 'updated' } },
    { kind: 'session_proposal', id: 'p1', title: 'Split the work', brief: 'x' },
    { kind: 'proposal_resolved', id: 'p1', decision: 'dismissed' },
    { kind: 'side_session', phase: 'started', id: 's2', title: 'Tests' },
    { kind: 'chapter', index: 1, title: 'Exploration' },
    { kind: 'client_call', callId: 'c1', tool: 'desktop_describe', input: {} },
    { kind: 'client_call_end', callId: 'c1', ok: false, reason: 'not supported by this version' },
    { kind: 'something_newer_still', x: 1 },
  ]) live = apply(live as never, e as never);
  assert.equal(JSON.stringify(toRows(live.items, false)), before, 'nothing drawn, nothing broken');

  // ?client=desktop on both streams, and the client-result answer.
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const fake = (async (input: string, init?: { body?: string }) => {
    urls.push(String(input));
    if (init?.body) bodies.push(JSON.parse(init.body));
    const result = String(input).includes('client-result');
    return new Response(result ? '{"ok":true}' : '', { status: result ? 200 : 404, headers: { 'content-type': 'application/json' } });
  }) as never;
  const c = new HarnessClient({ base: 'http://x', fetch: fake, clientKind: 'desktop' });
  const stop = c.sessions.events('aaaaaaaaaaaaaaaa', 5, () => {});
  const g = c.globalEvents(60_000);
  g.start();
  await new Promise((r) => setTimeout(r, 50));
  stop(); g.stop();
  assert.ok(urls.includes('http://x/api/sessions/aaaaaaaaaaaaaaaa/events?after=5&client=desktop'), urls.join(' '));
  assert.ok(urls.includes('http://x/api/events?client=desktop'), urls.join(' '));
  await c.sessions.clientResult('aaaaaaaaaaaaaaaa', { callId: 'c1', ok: false, error: 'not supported by this version' });
  assert.deepEqual(bodies.at(-1), { callId: 'c1', ok: false, error: 'not supported by this version' });
});
