// Local stand-ins for the services the integrations plugin talks to. Each
// implements the documented endpoints the plugin uses and checks what the real
// service checks: the auth header in its documented form, the request shape
// (required fields, enums, limits), and idempotency keys. Anything wrong is
// answered the way the service answers it, and recorded in `problems` so a test
// can assert that nothing slipped through.

import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Rec { res?: any; status?: number; method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; raw: string; json?: any; form?: URLSearchParams }
type Reply = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export interface Mock { url: string; requests: Rec[]; problems: string[]; close(): Promise<void>; hits(path: string | RegExp, method?: string): Rec[] }

export async function serve(handler: (r: Rec, m: Mock) => Reply | Promise<Reply>): Promise<Mock> {
  const requests: Rec[] = [];
  const problems: string[] = [];
  const mock = {} as Mock;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url ?? '/', 'http://x');
    const rec: Rec = { method: req.method ?? 'GET', path: u.pathname, query: u.searchParams, headers: req.headers, raw };
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.includes('json') && raw) { try { rec.json = JSON.parse(raw); } catch { problems.push(`${rec.path}: body is not JSON`); } }
    if (ct.includes('x-www-form-urlencoded')) rec.form = new URLSearchParams(raw);
    requests.push(rec);
    let r: Reply;
    try { r = await handler(rec, mock); } catch (e) { problems.push(`${rec.path}: handler threw ${(e as Error).message}`); r = { status: 500, json: { error: 'mock error' } }; }
    rec.res = r.json;
    rec.status = r.status;
    res.writeHead(r.status, { 'content-type': r.json !== undefined ? 'application/json' : 'text/plain', ...(r.headers ?? {}) });
    res.end(r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? ''));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  Object.assign(mock, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests, problems,
    close: () => new Promise<void>((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
    hits: (p: string | RegExp, method?: string) => requests.filter((r) => (typeof p === 'string' ? r.path === p : p.test(r.path)) && (!method || r.method === method)),
  });
  return mock;
}

const bad = (m: Mock, what: string, reply: Reply): Reply => { m.problems.push(what); return reply; };

// ---------------- Slack Web API ----------------

/** https://docs.slack.dev/reference/methods/chat.postMessage (and chat.update, chat.postEphemeral, users.info, users.lookupByEmail), plus response_url hooks. */
export function slackMock(o: { token: string; users?: Record<string, { email: string }>; rateLimitOnce?: boolean }) {
  let ts = 1_700_000_000;
  const messages = new Map<string, any>();
  let limited = !o.rateLimitOnce;
  return serve((r, m) => {
    if (r.path.startsWith('/hooks/')) {
      if (r.method !== 'POST' || !r.json?.text) return bad(m, 'response_url: needs POST with text', { status: 400, text: 'invalid_payload' });
      return { status: 200, text: 'ok' };
    }
    const method = r.path.replace(/^\/api\//, '');
    if (r.headers.authorization !== `Bearer ${o.token}`) return bad(m, `${method}: bad or missing bearer token`, { status: 200, json: { ok: false, error: r.headers.authorization ? 'invalid_auth' : 'not_authed' } });
    if (['chat.postMessage', 'chat.update', 'chat.postEphemeral'].includes(method)) {
      if (r.method !== 'POST' || !String(r.headers['content-type']).startsWith('application/json')) return bad(m, `${method}: write methods take a JSON body`, { status: 200, json: { ok: false, error: 'invalid_arguments' } });
      const b = r.json ?? {};
      if (!b.channel) return bad(m, `${method}: no channel`, { status: 200, json: { ok: false, error: 'channel_not_found' } });
      if (!b.text && !b.blocks) return bad(m, `${method}: no text or blocks`, { status: 200, json: { ok: false, error: 'no_text' } });
      if (b.blocks) {
        if (!Array.isArray(b.blocks) || b.blocks.length > 50) return bad(m, `${method}: blocks must be an array of up to 50`, { status: 200, json: { ok: false, error: 'invalid_blocks' } });
        for (const blk of b.blocks) {
          if (blk.type === 'section' && String(blk.text?.text ?? '').length > 3000) return bad(m, 'section text over 3000', { status: 200, json: { ok: false, error: 'invalid_blocks' } });
          if (blk.type === 'header' && (blk.text?.type !== 'plain_text' || String(blk.text.text).length > 150)) return bad(m, 'header must be plain_text up to 150', { status: 200, json: { ok: false, error: 'invalid_blocks' } });
          if (blk.type === 'actions') for (const el of blk.elements ?? []) if (String(el.value ?? '').length > 2000 || !el.action_id) return bad(m, 'button needs action_id and a value up to 2000', { status: 200, json: { ok: false, error: 'invalid_blocks' } });
        }
      }
      if (method === 'chat.postMessage') {
        if (!limited) { limited = true; return { status: 429, headers: { 'retry-after': '1' }, json: { ok: false, error: 'ratelimited' } }; }
        if (b.thread_ts && !messages.has(`${b.channel}:${b.thread_ts}`)) return bad(m, 'thread_ts of a message that does not exist', { status: 200, json: { ok: false, error: 'thread_not_found' } });
        const id = String(++ts) + '.000100';
        messages.set(`${b.channel}:${id}`, b);
        return { status: 200, json: { ok: true, channel: b.channel, ts: id, message: { text: b.text, ts: id } } };
      }
      if (method === 'chat.update') {
        if (!b.ts || !messages.has(`${b.channel}:${b.ts}`)) return bad(m, 'chat.update of an unknown message', { status: 200, json: { ok: false, error: 'message_not_found' } });
        messages.set(`${b.channel}:${b.ts}`, b);
        return { status: 200, json: { ok: true, channel: b.channel, ts: b.ts, text: b.text } };
      }
      if (!b.user) return bad(m, 'chat.postEphemeral needs user', { status: 200, json: { ok: false, error: 'user_not_in_channel' } });
      return { status: 200, json: { ok: true, message_ts: String(++ts) } };
    }
    if (method === 'users.info' || method === 'users.lookupByEmail') {
      if (r.method !== 'GET') return bad(m, `${method}: expected GET with query parameters`, { status: 200, json: { ok: false, error: 'invalid_arguments' } });
      if (method === 'users.info') {
        const u = o.users?.[r.query.get('user') ?? ''];
        return { status: 200, json: u ? { ok: true, user: { id: r.query.get('user'), profile: { email: u.email } } } : { ok: false, error: 'user_not_found' } };
      }
      const hit = Object.entries(o.users ?? {}).find(([, u]) => u.email === r.query.get('email'));
      return { status: 200, json: hit ? { ok: true, user: { id: hit[0] } } : { ok: false, error: 'users_not_found' } };
    }
    return bad(m, `unknown Slack method ${method}`, { status: 404, json: { ok: false, error: 'unknown_method' } });
  });
}

/** What Slack sends: the v0 signature over "v0:<ts>:<raw body>". */
export function slackSign(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${crypto.createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig, 'content-type': 'application/x-www-form-urlencoded' };
}

// ---------------- Bot Framework (Teams) ----------------

/** A signing key pair, served as the OpenID metadata's JWKS; and the Entra token endpoint and the Connector API. */
export async function botFrameworkMock(o: { appId: string; appPassword: string; tenant?: string; endorsements?: string[]; members?: Record<string, { email: string }> }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', endorsements: o.endorsements ?? ['msteams'] };
  let n = 0;
  const issued = 'bf-access-token-' + crypto.randomBytes(8).toString('hex');
  const activities = new Map<string, any>();
  const mock = await serve((r, m) => {
    if (r.path === '/v1/.well-known/openidconfiguration') return { status: 200, json: { issuer: 'https://api.botframework.com', authorization_endpoint: 'https://invalid.botframework.com', jwks_uri: `${mock.url}/v1/.well-known/keys`, id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['private_key_jwt'] } };
    if (r.path === '/v1/.well-known/keys') return { status: 200, json: { keys: [jwk] } };
    if (/^\/[^/]+\/oauth2\/v2\.0\/token$/.test(r.path)) {
      const f = r.form;
      if (r.method !== 'POST' || !f) return bad(m, 'token: expected a form POST', { status: 400, json: { error: 'invalid_request' } });
      const tenant = r.path.split('/')[1];
      if (tenant !== (o.tenant ?? 'botframework.com')) m.problems.push(`token: tenant ${tenant}`);
      if (f.get('grant_type') !== 'client_credentials' || f.get('scope') !== 'https://api.botframework.com/.default') return bad(m, 'token: grant_type/scope', { status: 400, json: { error: 'invalid_scope' } });
      if (f.get('client_id') !== o.appId || f.get('client_secret') !== o.appPassword) return bad(m, 'token: bad client credentials', { status: 401, json: { error: 'invalid_client' } });
      return { status: 200, json: { token_type: 'Bearer', expires_in: 3599, ext_expires_in: 3599, access_token: issued } };
    }
    if (r.path.startsWith('/v3/conversations/')) {
      if (r.headers.authorization !== `Bearer ${issued}`) return bad(m, 'connector: bad bearer token', { status: 401, json: { error: { code: 'Unauthorized' } } });
      const parts = r.path.split('/').map(decodeURIComponent); // ['', 'v3', 'conversations', conv, 'activities'|'members', id?]
      const conv = parts[3];
      if (parts[4] === 'members' && r.method === 'GET') {
        const u = o.members?.[parts[5] ?? ''];
        return u ? { status: 200, json: { id: parts[5], email: u.email, userPrincipalName: u.email } } : { status: 404, json: { error: { code: 'MemberNotFoundInConversation' } } };
      }
      if (parts[4] !== 'activities') return bad(m, `connector: unknown path ${r.path}`, { status: 404, json: {} });
      const a = r.json ?? {};
      if (a.type !== 'message') return bad(m, 'connector: activity type must be message', { status: 400, json: { error: { code: 'BadArgument' } } });
      for (const att of a.attachments ?? []) {
        if (att.contentType !== 'application/vnd.microsoft.card.adaptive' || att.content?.type !== 'AdaptiveCard' || !att.content?.version) return bad(m, 'connector: attachment must be an Adaptive Card', { status: 400, json: { error: { code: 'BadArgument' } } });
        for (const act of att.content.actions ?? []) if (act.type === 'Action.Execute' && !act.verb) return bad(m, 'Action.Execute needs a verb', { status: 400, json: {} });
      }
      if (!a.text && !(a.attachments ?? []).length) return bad(m, 'connector: empty activity', { status: 400, json: {} });
      if (r.method === 'POST' && parts.length === 5) { const id = `act-${++n}`; activities.set(`${conv}:${id}`, a); return { status: 201, json: { id } }; }
      if (r.method === 'POST' && parts.length === 6) {
        if (!activities.has(`${conv}:${parts[5]}`)) return bad(m, 'reply to an unknown activity', { status: 404, json: {} });
        const id = `act-${++n}`; activities.set(`${conv}:${id}`, a); return { status: 201, json: { id } };
      }
      if (r.method === 'PUT' && parts.length === 6) {
        if (!activities.has(`${conv}:${parts[5]}`)) return bad(m, 'update of an unknown activity', { status: 404, json: {} });
        activities.set(`${conv}:${parts[5]}`, a); return { status: 200, json: { id: parts[5] } };
      }
    }
    return bad(m, `unknown ${r.method} ${r.path}`, { status: 404, json: {} });
  });
  /** A Connector -> bot token as the Bot Framework signs it. */
  const sign = (claims: Record<string, unknown>, key = privateKey, k = kid) => {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: k, x5t: k })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: 'https://api.botframework.com', aud: o.appId, nbf: now - 10, exp: now + 3600, ...claims })).toString('base64url');
    const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
    return `Bearer ${h}.${p}.${s}`;
  };
  return Object.assign(mock, { sign, activities, issued });
}

// ---------------- PagerDuty ----------------

/** Events API v2 (/v2/enqueue) and REST API v2 (incidents, notes, oncalls). */
export function pagerDutyMock(o: { routingKeys: string[]; apiToken: string; from: string; oncall?: { id: string; name: string; email: string; level: number }[] }) {
  const incidents = new Map<string, { id: string; status: string }>();
  let n = 0;
  return serve((r, m) => {
    if (r.path === '/v2/enqueue') {
      const b = r.json ?? {};
      const fail = (why: string) => bad(m, `enqueue: ${why}`, { status: 400, json: { status: 'invalid event', message: 'Event object is invalid', errors: [why] } });
      if (!o.routingKeys.includes(b.routing_key)) return fail('unknown routing_key');
      if (!['trigger', 'acknowledge', 'resolve'].includes(b.event_action)) return fail('event_action');
      if (b.dedup_key !== undefined && (typeof b.dedup_key !== 'string' || b.dedup_key.length > 255)) return fail('dedup_key');
      if (b.event_action === 'trigger') {
        const p = b.payload ?? {};
        if (!p.summary || p.summary.length > 1024 || !p.source || !['critical', 'error', 'warning', 'info'].includes(p.severity)) return fail('payload summary/source/severity');
        for (const l of b.links ?? []) if (!l.href) return fail('link without href');
        const key = b.dedup_key ?? crypto.randomUUID();
        if (!incidents.has(key)) incidents.set(key, { id: `PINC${++n}`, status: 'triggered' });
        return { status: 202, json: { status: 'success', message: 'Event processed', dedup_key: key } };
      }
      if (!b.dedup_key) return fail('acknowledge/resolve need dedup_key');
      if (b.payload) m.problems.push('acknowledge/resolve carry no payload');
      const inc = incidents.get(b.dedup_key);
      if (inc) inc.status = b.event_action === 'acknowledge' ? 'acknowledged' : 'resolved';
      return { status: 202, json: { status: 'success', message: 'Event processed', dedup_key: b.dedup_key } };
    }
    if (r.headers.authorization !== `Token token=${o.apiToken}`) return bad(m, 'REST: bad Authorization (Token token=...)', { status: 401, json: { error: { message: 'Authentication failed', code: 2006 } } });
    if (!String(r.headers.accept).includes('application/vnd.pagerduty+json;version=2')) m.problems.push('REST: Accept header');
    if (r.path === '/incidents' && r.method === 'GET') {
      const k = r.query.get('incident_key');
      const inc = k ? incidents.get(k) : undefined;
      return { status: 200, json: { incidents: inc ? [{ id: inc.id, status: inc.status, incident_key: k }] : [], limit: 25, offset: 0, more: false } };
    }
    const note = /^\/incidents\/([^/]+)\/notes$/.exec(r.path);
    if (note && r.method === 'POST') {
      if (r.headers.from !== o.from) return bad(m, 'notes: From header must be a valid user email', { status: 400, json: { error: { message: 'Invalid Input Provided', errors: ['Requester User Not Found'] } } });
      if (!r.json?.note?.content) return bad(m, 'notes: note.content', { status: 400, json: {} });
      if (![...incidents.values()].some((i) => i.id === note[1])) return { status: 404, json: { error: { message: 'Not Found' } } };
      return { status: 201, json: { note: { id: 'PNOTE1', content: r.json.note.content } } };
    }
    if (r.path === '/oncalls' && r.method === 'GET') {
      if (!r.query.getAll('escalation_policy_ids[]').length) m.problems.push('oncalls without escalation_policy_ids[]');
      const withUsers = r.query.getAll('include[]').includes('users');
      return { status: 200, json: { oncalls: (o.oncall ?? []).map((u) => ({ escalation_level: u.level, user: withUsers ? { id: u.id, name: u.name, email: u.email, type: 'user' } : { id: u.id, summary: u.name, type: 'user_reference' } })) } };
    }
    return bad(m, `unknown ${r.method} ${r.path}`, { status: 404, json: {} });
  });
}

// ---------------- Opsgenie ----------------

/** Alert API v2: create, acknowledge, close, notes (identifierType=alias). */
export function opsgenieMock(o: { apiKey: string }) {
  const alerts = new Map<string, { status: string; acknowledged: boolean; notes: string[] }>();
  let n = 0;
  return serve((r, m) => {
    if (r.headers.authorization !== `GenieKey ${o.apiKey}`) return bad(m, 'bad Authorization (GenieKey ...)', { status: 401, json: { message: 'Could not authenticate', took: 0, requestId: 'x' } });
    const ok = () => ({ status: 202, json: { result: 'Request will be processed', took: 0.1, requestId: `req-${++n}` } });
    const b = r.json ?? {};
    if (r.path === '/v2/alerts' && r.method === 'POST') {
      if (!b.message || b.message.length > 130) return bad(m, 'create: message required, up to 130', { status: 422, json: { message: 'Request body is not processable' } });
      if (b.alias && b.alias.length > 512) return bad(m, 'alias over 512', { status: 422, json: {} });
      if (b.priority && !/^P[1-5]$/.test(b.priority)) return bad(m, 'priority', { status: 422, json: {} });
      if ((b.tags ?? []).length > 20) return bad(m, 'tags over 20', { status: 422, json: {} });
      for (const x of b.responders ?? []) if (!['team', 'user', 'escalation', 'schedule'].includes(x.type) || !(x.id || x.name || x.username)) return bad(m, 'responder', { status: 422, json: {} });
      if (!alerts.has(b.alias)) alerts.set(b.alias, { status: 'open', acknowledged: false, notes: [] }); // alias de-duplicates
      return ok();
    }
    const a = /^\/v2\/alerts\/([^/]+)\/(acknowledge|close|notes)$/.exec(r.path);
    if (a && r.method === 'POST') {
      if (r.query.get('identifierType') !== 'alias') m.problems.push('expected identifierType=alias');
      const alert = alerts.get(decodeURIComponent(a[1]!));
      if (!alert) return { status: 404, json: { message: 'Alert does not exist' } };
      if (a[2] === 'notes') { if (!b.note) return bad(m, 'notes: note required', { status: 422, json: {} }); alert.notes.push(b.note); }
      if (a[2] === 'acknowledge') alert.acknowledged = true;
      if (a[2] === 'close') alert.status = 'closed';
      return ok();
    }
    return bad(m, `unknown ${r.method} ${r.path}`, { status: 404, json: {} });
  }).then((mock) => Object.assign(mock, { alerts }));
}

// ---------------- Jira Cloud ----------------

function validAdf(d: any): boolean {
  const node = (x: any): boolean => x && typeof x.type === 'string' && (x.type !== 'text' || typeof x.text === 'string' && x.text.length > 0) && (!x.content || (Array.isArray(x.content) && x.content.every(node)));
  return d?.version === 1 && d?.type === 'doc' && Array.isArray(d.content) && d.content.every(node);
}

/** REST v3: issue create, search/jql by label, comment, transitions, remote links. Basic auth with email:API token. */
export function jiraMock(o: { email: string; token: string; project: string }) {
  const issues = new Map<string, { fields: any; status: string; comments: any[]; links: any[] }>();
  let n = 0;
  return serve((r, m) => {
    const expected = `Basic ${Buffer.from(`${o.email}:${o.token}`).toString('base64')}`;
    if (r.headers.authorization !== expected) return bad(m, 'bad basic auth (email:API token)', { status: 401, json: { errorMessages: ['Client must be authenticated to access this resource.'] } });
    if (r.path === '/rest/api/3/issue' && r.method === 'POST') {
      const f = r.json?.fields ?? {};
      const errors: Record<string, string> = {};
      if (f.project?.key !== o.project) errors.project = 'valid project is required';
      if (!f.issuetype?.name && !f.issuetype?.id) errors.issuetype = 'valid issue type is required';
      if (!f.summary || f.summary.length > 255 || /\n/.test(f.summary)) errors.summary = 'summary: one line, up to 255';
      if (f.description && !validAdf(f.description)) errors.description = 'Operation value must be an Atlassian Document';
      if ((f.labels ?? []).some((l: string) => /\s/.test(l))) errors.labels = 'labels cannot contain spaces';
      if (Object.keys(errors).length) return bad(m, `create: ${JSON.stringify(errors)}`, { status: 400, json: { errorMessages: [], errors } });
      const key = `${o.project}-${++n}`;
      issues.set(key, { fields: f, status: 'To Do', comments: [], links: [] });
      return { status: 201, json: { id: String(10000 + n), key, self: `${'http://jira'}/rest/api/3/issue/${10000 + n}` } };
    }
    if (r.path === '/rest/api/3/search/jql' && r.method === 'GET') {
      const label = /labels = "([^"]+)"/.exec(r.query.get('jql') ?? '')?.[1];
      const hit = [...issues.entries()].filter(([, i]) => (i.fields.labels ?? []).includes(label)).map(([key]) => ({ key }));
      return { status: 200, json: { issues: hit.slice(0, Number(r.query.get('maxResults') ?? 50)), isLast: true } };
    }
    const im = /^\/rest\/api\/3\/issue\/([^/]+)\/(comment|transitions|remotelink)$/.exec(r.path);
    if (im) {
      const issue = issues.get(im[1]!);
      if (!issue) return { status: 404, json: { errorMessages: ['Issue does not exist or you do not have permission to see it.'] } };
      if (im[2] === 'comment' && r.method === 'POST') {
        if (!validAdf(r.json?.body)) return bad(m, 'comment body must be ADF', { status: 400, json: { errorMessages: ['Comment body is not valid ADF'] } });
        issue.comments.push(r.json.body);
        return { status: 201, json: { id: String(issue.comments.length) } };
      }
      if (im[2] === 'transitions' && r.method === 'GET') return { status: 200, json: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }, { id: '31', name: 'Close issue', to: { name: 'Done', statusCategory: { key: 'done' } } }] } };
      if (im[2] === 'transitions' && r.method === 'POST') {
        if (!['11', '31'].includes(r.json?.transition?.id)) return bad(m, 'transition id', { status: 400, json: { errorMessages: ['Transition id is not valid'] } });
        for (const c of r.json?.update?.comment ?? []) { if (!validAdf(c.add?.body)) return bad(m, 'transition comment must be ADF', { status: 400, json: {} }); issue.comments.push(c.add.body); }
        issue.status = r.json.transition.id === '31' ? 'Done' : 'In Progress';
        return { status: 204 };
      }
      if (im[2] === 'remotelink' && r.method === 'POST') {
        if (!r.json?.object?.url || !r.json?.object?.title) return bad(m, 'remotelink needs object.url and object.title', { status: 400, json: {} });
        issue.links.push(r.json);
        return { status: 201, json: { id: 1, self: 'x' } };
      }
    }
    return bad(m, `unknown ${r.method} ${r.path}`, { status: 404, json: {} });
  }).then((mock) => Object.assign(mock, { issues }));
}

// ---------------- ServiceNow ----------------

/** Table API for incident: create, query by correlation_id, PATCH (work_notes; resolve needs close_code and close_notes). Basic auth or OAuth. */
export function serviceNowMock(o: { user: string; password: string; clientId?: string; clientSecret?: string }) {
  const records = new Map<string, any>();
  let n = 10000;
  const issued = 'snow-oauth-' + crypto.randomBytes(6).toString('hex');
  return serve((r, m) => {
    if (r.path === '/oauth_token.do') {
      const f = r.form;
      if (f?.get('grant_type') !== 'client_credentials' || f.get('client_id') !== o.clientId || f.get('client_secret') !== o.clientSecret) return bad(m, 'oauth: bad client credentials', { status: 401, json: { error: 'access_denied' } });
      return { status: 200, json: { access_token: issued, token_type: 'Bearer', expires_in: 1799 } };
    }
    const basic = `Basic ${Buffer.from(`${o.user}:${o.password}`).toString('base64')}`;
    if (r.headers.authorization !== basic && r.headers.authorization !== `Bearer ${issued}`) return bad(m, 'bad auth', { status: 401, json: { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' } });
    if (!String(r.headers.accept).includes('application/json')) m.problems.push('Accept should be application/json');
    if (r.path === '/api/now/table/incident' && r.method === 'POST') {
      const b = r.json ?? {};
      if (!b.short_description) return bad(m, 'create: short_description', { status: 400, json: { error: { message: 'Mandatory field missing' } } });
      for (const k of ['impact', 'urgency']) if (b[k] !== undefined && !['1', '2', '3'].includes(String(b[k]))) return bad(m, `${k} must be 1-3`, { status: 400, json: {} });
      const sys_id = crypto.randomBytes(16).toString('hex');
      const rec = { ...b, sys_id, number: `INC00${++n}`, state: '1', work_notes_list: [] as string[] };
      records.set(sys_id, rec);
      return { status: 201, json: { result: { sys_id, number: rec.number, state: rec.state } } };
    }
    if (r.path === '/api/now/table/incident' && r.method === 'GET') {
      const corr = /correlation_id=([^^]+)/.exec(r.query.get('sysparm_query') ?? '')?.[1];
      return { status: 200, json: { result: [...records.values()].filter((x) => x.correlation_id === corr).map((x) => ({ sys_id: x.sys_id, number: x.number, state: x.state })) } };
    }
    const pm = /^\/api\/now\/table\/incident\/([0-9a-f]{32})$/.exec(r.path);
    if (pm && r.method === 'PATCH') {
      const rec = records.get(pm[1]!);
      if (!rec) return { status: 404, json: { error: { message: 'No Record found' }, status: 'failure' } };
      const b = r.json ?? {};
      if (String(b.state) === '6' && (!b.close_code || !b.close_notes)) return bad(m, 'resolve without close_code/close_notes (data policy)', { status: 403, json: { error: { message: 'Operation Failed', detail: 'Data Policy Exception: Resolution code, Resolution notes are mandatory' } } });
      if (b.work_notes) rec.work_notes_list.push(b.work_notes);
      Object.assign(rec, { ...b, work_notes: undefined });
      return { status: 200, json: { result: { sys_id: rec.sys_id, number: rec.number, state: rec.state } } };
    }
    return bad(m, `unknown ${r.method} ${r.path}`, { status: 404, json: {} });
  }).then((mock) => Object.assign(mock, { records }));
}

/** Teams Workflows webhook: takes a message with an Adaptive Card attachment, answers 202. */
export function workflowWebhookMock() {
  return serve((r, m) => {
    const a = r.json?.attachments?.[0];
    if (r.json?.type !== 'message' || a?.contentType !== 'application/vnd.microsoft.card.adaptive' || a?.content?.type !== 'AdaptiveCard') return bad(m, 'webhook: expected a message with an Adaptive Card', { status: 400, json: {} });
    if (r.query.get('sig') !== 'secret-sig') return bad(m, 'webhook: bad sig', { status: 401, json: {} });
    return { status: 202, text: '' };
  });
}
