import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { Effort } from '../core/models.ts';
import type { Session, SessionMeta } from '../core/session.ts';
import type { PermissionMode } from '../core/types.ts';
import type { Harness } from '../kernel/harness.ts';
import { MemoryError, MemoryStore } from '../memory/store.ts';
import { dockerAvailable, dockerDefaults, imageExists } from '../runtime/docker.ts';
import { COMPANION_RESULT_LIMIT } from '../runtime/companion.ts';
import { resolveIn, walk } from '../tools/paths.ts';
import { RateLimiter, type Role, type SpendLedger, type UserStore } from './users.ts';

// The HTTP side: JSON API, an SSE stream per session, the built UI, and the
// companion endpoints. Provider keys stay in this process.
//
// Who is asking: the operator (HARNESS_TOKEN, or loopback with auth off) is an
// administrator who owns nothing in particular; an account (users.json) is an
// administrator or a member. Members see and change only what they own.

export interface AppOptions {
  harness: Harness;
  /** The operator's token. */
  token: string;
  /** No sign-in at all (loopback only). */
  authOff?: boolean;
  /** Secure cookies unless the server is on loopback. */
  loopback: boolean;
  localRoots: string[];
  uiDir: string;
  appRoot: string;
  users?: UserStore;
  spend?: SpendLedger;
  /** Requests per minute per signed-in principal (0 = no limit). */
  rateLimit?: number;
  /** Messages and workflow starts per minute per principal. */
  messageRateLimit?: number;
}

export interface Principal { id?: string; name: string; role: Role }

export class HttpError extends Error {
  status: number;
  headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) { super(message); this.status = status; this.headers = headers; }
}

export function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(data);
}

async function readJson(req: http.IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'expected application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid JSON'); }
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json' };
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

export function createApp(o: AppOptions): { server: http.Server; handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> } {
  const { harness } = o;
  const limiter = new RateLimiter(o.rateLimit ?? 600);
  const messageLimiter = new RateLimiter(o.messageRateLimit ?? 30);

  async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(o.uiDir, rel);
    if (!file.startsWith(o.uiDir + path.sep)) return false;
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': rel === 'index.html' ? 'no-store' : 'public, max-age=300',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      });
      res.end(data);
      return true;
    } catch { return false; }
  }

  function principalFor(token: string | undefined): Principal | undefined {
    if (!token) return undefined;
    if (safeEqual(token, o.token)) return { name: 'operator', role: 'admin' };
    const u = o.users?.byToken(token);
    return u ? { id: u.id, name: u.name, role: u.role } : undefined;
  }

  function who(req: http.IncomingMessage): Principal | undefined {
    if (o.authOff) return { name: 'operator', role: 'admin' };
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    return principalFor(bearer) ?? principalFor(cookie(req, 'hw_token'));
  }

  /** Members own their sessions; administrators see all of them. */
  const mayUse = (p: Principal, owner: string | undefined) => p.role === 'admin' || (!!p.id && owner === p.id);

  function sessionFor(p: Principal, id: string): Session {
    const s = harness.sessions.get(id);
    // Someone else's session reads as missing: its existence is not their business.
    if (!s || !mayUse(p, s.meta.owner)) throw new HttpError(404, 'no such session');
    return s;
  }

  function limited(l: RateLimiter, p: Principal) {
    const r = l.take(p.id ?? 'operator');
    if (!r.ok) throw new HttpError(429, `Too many requests; try again in ${r.retryAfterSec}s.`, { 'retry-after': String(r.retryAfterSec) });
  }

  async function memoryOf(p: Principal, url: URL) {
    const sid = url.searchParams.get('session');
    if (!sid) throw new HttpError(400, 'session is required');
    const mem = await sessionFor(p, sid).memoryStore();
    if (!mem) throw new HttpError(404, 'memory is turned off on this server');
    return mem;
  }

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // ---- companion protocol (its own token) ----
    if (p === '/api/companion/poll' || p === '/api/companion/result') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const companions = harness.companions;
      const id = token ? companions.authenticate(token) : undefined;
      if (!id) throw new HttpError(401, 'unknown companion token');
      const body = await readJson(req, p === '/api/companion/result' ? COMPANION_RESULT_LIMIT : 1_000_000);
      if (p === '/api/companion/poll') {
        const info = (body.info ?? {}) as { platform?: string; shell?: string; root?: string; version?: string; sandbox?: string; network?: string };
        const sandbox = ['bwrap', 'seatbelt', 'docker'].includes(String(info.sandbox)) ? String(info.sandbox) : 'off';
        const job = await companions.poll(id, { platform: String(info.platform ?? 'unknown'), shell: String(info.shell ?? 'bash'), root: String(info.root ?? ''), version: info.version, sandbox, network: info.network === 'none' ? 'none' : 'full' });
        return job ? send(res, 200, job) : send(res, 204, '');
      }
      const ok = companions.complete(id, String(body.jobId), body.ok === true, body.value);
      return send(res, ok ? 200 : 404, { ok });
    }
    if (p === '/companion.mjs') {
      try {
        const data = await fs.readFile(path.join(o.appRoot, 'dist', 'companion.mjs'));
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="harness-companion.mjs"' });
        return void res.end(data);
      } catch { throw new HttpError(404, 'companion not built; run npm run build'); }
    }

    if (p === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      const token = typeof body.token === 'string' ? body.token : '';
      if (!principalFor(token)) throw new HttpError(401, 'wrong access token');
      return send(res, 200, { ok: true }, { 'set-cookie': `hw_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${o.loopback ? '' : '; Secure'}` });
    }
    if (p === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': 'hw_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });

    if (!p.startsWith('/api/')) {
      if (method === 'GET' && (await serveStatic(res, p) || await serveStatic(res, '/'))) return;
      throw new HttpError(404, 'not found');
    }
    const me = who(req);
    if (!me) throw new HttpError(401, 'sign in required');
    // Cookie-authenticated writes must come from our own page (JSON content type is enforced too).
    if (method !== 'GET' && req.headers['x-harness'] !== '1') throw new HttpError(403, 'missing x-harness header');
    limited(limiter, me);
    const admin = me.role === 'admin';
    const { sessions, companions, registry } = harness;

    if (p === '/api/me' && method === 'GET') return send(res, 200, { ...me, spentToday: o.spend?.spentToday(me.id) ?? 0, accounts: (o.users?.size ?? 0) > 0 });

    // ---- accounts (administrators) ----
    if (p.startsWith('/api/users')) {
      if (!admin) throw new HttpError(403, 'administrators only');
      if (!o.users) throw new HttpError(404, 'accounts are not enabled');
      if (p === '/api/users' && method === 'GET') return send(res, 200, o.users.list());
      if (p === '/api/users' && method === 'POST') {
        const b = await readJson(req);
        try {
          const r = await o.users.add(String(b.name ?? ''), b.role === 'admin' ? 'admin' : 'member');
          return send(res, 201, { ...r.user, token: r.token, note: 'Give this token to the person; it is not shown again.' });
        } catch (e) { throw new HttpError(409, (e as Error).message); }
      }
      const um = /^\/api\/users\/(usr_[a-f0-9]+)(?:\/(rotate|disable|enable))?$/.exec(p);
      if (um && method === 'DELETE' && !um[2]) return send(res, (await o.users.remove(um[1]!)) ? 200 : 404, { ok: true });
      if (um && method === 'POST' && um[2] === 'rotate') { try { return send(res, 200, { token: await o.users.rotate(um[1]!) }); } catch (e) { throw new HttpError(404, (e as Error).message); } }
      if (um && method === 'POST' && (um[2] === 'disable' || um[2] === 'enable')) { try { await o.users.setDisabled(um[1]!, um[2] === 'disable'); return send(res, 200, { ok: true }); } catch (e) { throw new HttpError(404, (e as Error).message); } }
      throw new HttpError(404, 'not found');
    }

    if (p === '/api/config' && method === 'GET') {
      const docker = await dockerAvailable();
      const image = dockerDefaults().image;
      return send(res, 200, {
        models: registry.listModels().map((m) => ({ id: m.id, label: m.label, provider: m.provider, contextWindow: m.contextWindow, compactAt: m.compactAt, effort: m.effort, efforts: m.efforts, available: m.available, vision: m.vision, notes: m.notes })),
        runtimes: { docker, dockerImage: docker ? (await imageExists(image) ? image : null) : null, local: admin && o.localRoots.length > 0, localRoots: admin ? o.localRoots : [] },
        companions: companions.list().filter((c) => mayUse(me, c.owner)),
        plugins: registry.plugins.map((x) => ({ name: x.name, version: x.version, description: x.description, contributes: x.contributes, signature: x.signature, permissions: x.permissions })),
        search: harness.search ?? null,
        me,
      });
    }
    if (p === '/api/plugins/catalogue' && method === 'GET') return send(res, 200, await harness.catalogue());
    if (p === '/api/plugins/install' && method === 'POST') {
      if (!admin) throw new HttpError(403, 'only administrators install plugins: their code runs in the server');
      const b = await readJson(req);
      try {
        const pl = await harness.install(String(b.name ?? ''));
        return send(res, 201, { name: pl.name, version: pl.version, contributes: pl.contributes, signature: pl.signature, note: 'Loaded: new sessions can use it.' });
      } catch (e) { throw new HttpError(409, (e as Error).message); }
    }

    if (p === '/api/sessions' && method === 'GET') return send(res, 200, sessions.list().filter((m) => mayUse(me, m.owner)).map((m) => ({ ...m, status: sessions.statusOf(m.id) })));
    if (p === '/api/sessions' && method === 'POST') {
      const b = await readJson(req);
      const model = String(b.model ?? registry.listModels().find((m) => m.available)?.id ?? '');
      const kind = b.runtime === 'local' || b.runtime === 'companion' ? b.runtime : 'docker';
      const runtime: SessionMeta['runtime'] = { kind, network: b.network === 'full' ? 'full' : b.network === 'allowlist' && kind === 'docker' ? 'allowlist' : 'none' };
      if (kind === 'docker') {
        if (!await dockerAvailable()) throw new HttpError(400, 'Docker is not available on the server. Choose a companion or local workspace.');
        if (!await imageExists(dockerDefaults().image)) throw new HttpError(400, `Sandbox image ${dockerDefaults().image} is missing. Build it with: npm run sandbox:image`);
      }
      if (kind === 'local') {
        // Commands in a server folder run on the server itself, unsandboxed.
        if (!admin) throw new HttpError(403, 'Server folders are for administrators: commands there run on the server itself. Use a sandbox or your own computer (companion).');
        if (!o.localRoots.length) throw new HttpError(400, 'Local workspaces are disabled. Set HARNESS_LOCAL_ROOTS on the server.');
        if (typeof b.path === 'string' && b.path) {
          const real = path.resolve(b.path);
          if (!o.localRoots.some((r) => real === r || real.startsWith(r + path.sep))) throw new HttpError(400, 'That folder is not under HARNESS_LOCAL_ROOTS.');
          runtime.path = real;
        }
      }
      if (kind === 'companion') {
        const id = String(b.companionId ?? '');
        if (!companions.list().some((c) => c.id === id && mayUse(me, c.owner))) throw new HttpError(400, 'Unknown companion.');
        runtime.companionId = id;
      }
      const s = await sessions.create({
        title: typeof b.title === 'string' ? b.title : undefined,
        model,
        effort: EFFORTS.includes(b.effort as Effort) ? b.effort as Effort : undefined,
        mode: MODES.includes(b.mode as PermissionMode) ? b.mode as PermissionMode : undefined,
        runtime,
        gitUrl: typeof b.gitUrl === 'string' && b.gitUrl ? b.gitUrl : undefined,
        owner: me.id,
        allowHosts: Array.isArray(b.allowHosts) ? b.allowHosts.map(String) : undefined,
      });
      return send(res, 201, s.meta);
    }

    // ---- memory: what the agent remembers, readable and editable by its owner ----
    if (p === '/api/memory' && method === 'GET') {
      const mem = await memoryOf(me, url);
      return send(res, 200, {
        scopes: mem.scopes().map((sc) => ({ scope: sc, label: sc === 'project' ? mem.dirs.projectLabel : undefined })),
        mode: mem.readOnly ? 'read' : 'on',
        files: await mem.list(),
        changes: [...await mem.changes('user', 20), ...(mem.dirs.project ? await mem.changes('project', 20) : [])].sort((a, b) => b.at - a.at).slice(0, 30),
      });
    }
    if (p === '/api/memory/file') {
      const mem = await memoryOf(me, url);
      // People edit memory through the same guarded store, logged as theirs (not a session's).
      const editor = new MemoryStore(mem.dirs, { session: `user:${me.name}` });
      const vpath = url.searchParams.get('path') ?? '';
      try {
        if (method === 'GET') return send(res, 200, { path: vpath, content: await mem.read(vpath) });
        if (method === 'PUT') {
          const b = await readJson(req);
          if (typeof b.content !== 'string') throw new HttpError(400, 'content is required');
          await editor.create(vpath, b.content);
          return send(res, 200, { ok: true });
        }
        if (method === 'DELETE') { await editor.delete(vpath); return send(res, 200, { ok: true }); }
      } catch (e) {
        if (e instanceof MemoryError) throw new HttpError(400, e.message);
        throw e;
      }
      throw new HttpError(405, 'method not allowed');
    }

    const rm = /^\/api\/sessions\/([a-f0-9]{16})\/runs\/(run_[a-f0-9]+)(?:\/(resume))?$/.exec(p);
    if (rm) {
      const s = sessionFor(me, rm[1]!);
      if (!rm[3] && method === 'GET') { try { return send(res, 200, await s.readRun(rm[2]!)); } catch { throw new HttpError(404, 'no such run'); } }
      if (rm[3] === 'resume' && method === 'POST') {
        limited(messageLimiter, me);
        try { return send(res, 202, await s.resumeRun(rm[2]!)); } catch (e) { throw new HttpError(409, (e as Error).message); }
      }
    }
    const m = /^\/api\/sessions\/([a-f0-9]{16})(?:\/(\w+))?$/.exec(p);
    if (m) {
      const s = sessionFor(me, m[1]!);
      const action = m[2];
      if (!action && method === 'GET') return send(res, 200, { meta: s.meta, status: s.status, history: s.history, pending: s.pendingRequests(), lastSeq: s.lastSeq });
      if (!action && method === 'DELETE') { await sessions.remove(s.meta.id); return send(res, 200, { ok: true }); }
      if (!action && method === 'PATCH') {
        const b = await readJson(req);
        s.update({
          title: typeof b.title === 'string' ? b.title : undefined,
          model: typeof b.model === 'string' ? b.model : undefined,
          effort: EFFORTS.includes(b.effort as Effort) ? b.effort as Effort : undefined,
          mode: MODES.includes(b.mode as PermissionMode) ? b.mode as PermissionMode : undefined,
        });
        return send(res, 200, s.meta);
      }
      if (action === 'messages' && method === 'POST') {
        limited(messageLimiter, me);
        const b = await readJson(req);
        if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
        const over = o.spend?.over(s.meta.owner);
        if (over) throw new HttpError(429, over);
        return send(res, 202, { state: await s.send(b.text.slice(0, 200_000)) });
      }
      if (action === 'abort' && method === 'POST') { s.abort(); return send(res, 200, { ok: true }); }
      if (action === 'capabilities' && method === 'GET') return send(res, 200, await s.capabilities());
      if (action === 'checkpoints' && method === 'GET') return send(res, 200, await s.listCheckpoints());
      if (action === 'rewind' && method === 'POST') {
        const b = await readJson(req);
        const turn = Number(b.turn);
        if (!Number.isInteger(turn) || turn < 1) throw new HttpError(400, 'turn must be a positive integer');
        try { return send(res, 200, { files: await s.rewind(turn) }); } catch (e) { throw new HttpError(409, (e as Error).message); }
      }
      if (action === 'trace' && method === 'GET') return send(res, 200, await s.readTrace());
      if (action === 'sources' && method === 'GET') return send(res, 200, await s.sources.list());
      if (action === 'network' && method === 'GET') return send(res, 200, { network: s.meta.runtime.network, hosts: await s.allowHosts() });
      if (action === 'network' && method === 'PUT') {
        const b = await readJson(req);
        if (!Array.isArray(b.hosts)) throw new HttpError(400, 'hosts must be a list');
        try { return send(res, 200, { hosts: await s.setAllowHosts(b.hosts.map(String)) }); } catch (e) { throw new HttpError(409, (e as Error).message); }
      }
      if (action === 'workflows' && method === 'GET') {
        const wfs = await s.workflows();
        return send(res, 200, {
          workflows: wfs.map((w) => ({ name: w.name, description: w.description, inputs: w.inputs ?? {}, source: w.source, nodes: Object.entries(w.nodes).map(([id, n]) => ({ id, type: n.type, title: n.title })) })),
          runs: await s.listRuns(),
        });
      }
      if (action === 'workflows' && method === 'POST') {
        limited(messageLimiter, me);
        const over = o.spend?.over(s.meta.owner);
        if (over) throw new HttpError(429, over);
        const b = await readJson(req);
        const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
        try {
          return send(res, 202, await s.startWorkflow(String(b.name ?? ''), Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)]))));
        } catch (e) { throw new HttpError(409, (e as Error).message); }
      }
      if (action === 'respond' && method === 'POST') {
        const b = await readJson(req);
        const ok = s.respond(String(b.requestId), { decision: String(b.decision ?? 'deny'), feedback: typeof b.feedback === 'string' ? b.feedback : undefined, answer: typeof b.answer === 'string' ? b.answer : undefined });
        return send(res, ok ? 200 : 404, { ok });
      }
      if (action === 'events' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0;
        const off = s.subscribe(after, (e) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
        req.on('close', () => { off(); clearInterval(ping); });
        return;
      }
      if (action === 'files' && method === 'GET') {
        if (s.meta.runtime.kind === 'companion') throw new HttpError(400, 'Files of a companion session live on that computer.');
        const host = { root: s.workspace, displayRoot: s.workspace };
        const rel = url.searchParams.get('path') || '.';
        const target = await resolveIn(host, rel);
        const st = await fs.stat(target).catch(() => null);
        if (!st) throw new HttpError(404, 'not found');
        if (st.isDirectory()) {
          const files = await walk(target, { limit: 3000 });
          return send(res, 200, { type: 'dir', files: files.map((f) => ({ path: f.rel, size: f.size, mtime: f.mtimeMs })) });
        }
        if (st.size > 2_000_000) return send(res, 200, { type: 'file', path: rel, size: st.size, content: null, note: 'file too large to preview' });
        const buf = await fs.readFile(target);
        const binary = buf.subarray(0, 8000).includes(0);
        return send(res, 200, { type: 'file', path: rel, size: st.size, content: binary ? null : buf.toString('utf8'), note: binary ? 'binary file' : undefined });
      }
    }

    if (p === '/api/companions' && method === 'GET') return send(res, 200, companions.list().filter((c) => mayUse(me, c.owner)));
    if (p === '/api/companions' && method === 'POST') {
      const b = await readJson(req);
      const c = await companions.create(String(b.name ?? 'My computer'), me.id);
      return send(res, 201, c);
    }
    const cm = /^\/api\/companions\/(cmp_[a-f0-9]+)$/.exec(p);
    if (cm && method === 'DELETE') {
      if (!companions.list().some((c) => c.id === cm[1] && mayUse(me, c.owner))) throw new HttpError(404, 'no such companion');
      await companions.remove(cm[1]!);
      return send(res, 200, { ok: true });
    }

    throw new HttpError(404, 'not found');
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) }, err instanceof HttpError ? err.headers : undefined);
      else res.end();
    }
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(() => {}); });
  server.requestTimeout = 0;
  return { server, handle };
}

