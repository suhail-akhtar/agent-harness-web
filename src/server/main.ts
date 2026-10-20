import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Effort } from '../core/models.ts';
import type { SessionMeta } from '../core/session.ts';
import type { PermissionMode } from '../core/types.ts';
import { createHarness, type Harness } from '../kernel/harness.ts';
import { dockerAvailable, dockerDefaults, imageExists } from '../runtime/docker.ts';
import { resolveIn, walk } from '../tools/paths.ts';

// A small HTTP server: JSON API, an SSE stream per session, the built UI, and
// the companion endpoints. Provider keys stay in this process.

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const UI_DIR = path.join(appRoot, 'ui', 'dist');
const DATA_DIR = path.resolve(process.env.HARNESS_DATA || path.join(appRoot, '.harness-data'));
const HOST = process.env.HARNESS_HOST || '127.0.0.1';
const PORT = Number(process.env.HARNESS_PORT || 4310);
const LOCAL_ROOTS = (process.env.HARNESS_LOCAL_ROOTS || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));

const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
const AUTH_OFF = process.env.HARNESS_AUTH === 'off' && loopback;
const TOKEN = process.env.HARNESS_TOKEN || crypto.randomBytes(18).toString('base64url');

// Bundled plugins (quality gates, SDLC) load unless HARNESS_BUNDLED_PLUGINS=off.
const PLUGIN_DIRS = [...(process.env.HARNESS_BUNDLED_PLUGINS === 'off' ? [] : [path.join(appRoot, 'plugins')]), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)];
let harness: Harness;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
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

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authed(req: http.IncomingMessage): boolean {
  if (AUTH_OFF) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const c = cookie(req, 'hw_token');
  return (!!bearer && safeEqual(bearer, TOKEN)) || (!!c && safeEqual(c, TOKEN));
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8', '.map': 'application/json' };

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep)) return false;
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

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

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
    const body = await readJson(req, 20_000_000);
    if (p === '/api/companion/poll') {
      const info = (body.info ?? {}) as { platform?: string; shell?: string; root?: string; version?: string };
      const job = await companions.poll(id, { platform: String(info.platform ?? 'unknown'), shell: String(info.shell ?? 'bash'), root: String(info.root ?? ''), version: info.version });
      return job ? send(res, 200, job) : send(res, 204, '');
    }
    const ok = companions.complete(id, String(body.jobId), body.ok === true, body.value);
    return send(res, ok ? 200 : 404, { ok });
  }
  if (p === '/companion.mjs') {
    try {
      const data = await fs.readFile(path.join(appRoot, 'dist', 'companion.mjs'));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': 'attachment; filename="harness-companion.mjs"' });
      return void res.end(data);
    } catch { throw new HttpError(404, 'companion not built; run npm run build'); }
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readJson(req);
    if (typeof body.token !== 'string' || !safeEqual(body.token, TOKEN)) throw new HttpError(401, 'wrong access token');
    return send(res, 200, { ok: true }, { 'set-cookie': `hw_token=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${loopback ? '' : '; Secure'}` });
  }

  if (!p.startsWith('/api/')) {
    if (method === 'GET' && (await serveStatic(res, p) || await serveStatic(res, '/'))) return;
    throw new HttpError(404, 'not found');
  }
  if (!authed(req)) throw new HttpError(401, 'sign in required');
  // Cookie-authenticated writes must come from our own page (JSON content type is enforced too).
  if (method !== 'GET' && req.headers['x-harness'] !== '1') throw new HttpError(403, 'missing x-harness header');

  const { sessions, companions, registry } = harness;
  if (p === '/api/config' && method === 'GET') {
    const docker = await dockerAvailable();
    const image = dockerDefaults().image;
    return send(res, 200, {
      models: registry.listModels().map((m) => ({ id: m.id, label: m.label, provider: m.provider, contextWindow: m.contextWindow, compactAt: m.compactAt, effort: m.effort, efforts: m.efforts, available: m.available, vision: m.vision, notes: m.notes })),
      runtimes: { docker, dockerImage: docker ? (await imageExists(image) ? image : null) : null, local: LOCAL_ROOTS.length > 0, localRoots: LOCAL_ROOTS },
      companions: companions.list(),
      plugins: registry.plugins.map((x) => ({ name: x.name, version: x.version, description: x.description, contributes: x.contributes, signature: x.signature })),
    });
  }
  if (p === '/api/plugins/catalogue' && method === 'GET') return send(res, 200, await harness.catalogue());
  if (p === '/api/plugins/install' && method === 'POST') {
    const b = await readJson(req);
    try {
      const pl = await harness.install(String(b.name ?? ''));
      return send(res, 201, { name: pl.name, version: pl.version, contributes: pl.contributes, signature: pl.signature, note: 'Loaded: new sessions can use it.' });
    } catch (e) { throw new HttpError(409, (e as Error).message); }
  }

  if (p === '/api/sessions' && method === 'GET') return send(res, 200, sessions.list().map((m) => ({ ...m, status: sessions.statusOf(m.id) })));
  if (p === '/api/sessions' && method === 'POST') {
    const b = await readJson(req);
    const model = String(b.model ?? registry.listModels().find((m) => m.available)?.id ?? '');
    const kind = b.runtime === 'local' || b.runtime === 'companion' ? b.runtime : 'docker';
    const runtime: SessionMeta['runtime'] = { kind, network: b.network === 'full' ? 'full' : 'none' };
    if (kind === 'docker') {
      if (!await dockerAvailable()) throw new HttpError(400, 'Docker is not available on the server. Choose a companion or local workspace.');
      if (!await imageExists(dockerDefaults().image)) throw new HttpError(400, `Sandbox image ${dockerDefaults().image} is missing. Build it with: npm run sandbox:image`);
    }
    if (kind === 'local') {
      if (!LOCAL_ROOTS.length) throw new HttpError(400, 'Local workspaces are disabled. Set HARNESS_LOCAL_ROOTS on the server.');
      if (typeof b.path === 'string' && b.path) {
        const real = path.resolve(b.path);
        if (!LOCAL_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))) throw new HttpError(400, 'That folder is not under HARNESS_LOCAL_ROOTS.');
        runtime.path = real;
      }
    }
    if (kind === 'companion') {
      const id = String(b.companionId ?? '');
      if (!companions.list().some((c) => c.id === id)) throw new HttpError(400, 'Unknown companion.');
      runtime.companionId = id;
    }
    const s = await sessions.create({
      title: typeof b.title === 'string' ? b.title : undefined,
      model,
      effort: EFFORTS.includes(b.effort as Effort) ? b.effort as Effort : undefined,
      mode: MODES.includes(b.mode as PermissionMode) ? b.mode as PermissionMode : undefined,
      runtime,
      gitUrl: typeof b.gitUrl === 'string' && b.gitUrl ? b.gitUrl : undefined,
    });
    return send(res, 201, s.meta);
  }

  const rm = /^\/api\/sessions\/([a-f0-9]{16})\/runs\/(run_[a-f0-9]+)(?:\/(resume))?$/.exec(p);
  if (rm) {
    const s = sessions.get(rm[1]!);
    if (!s) throw new HttpError(404, 'no such session');
    if (!rm[3] && method === 'GET') { try { return send(res, 200, await s.readRun(rm[2]!)); } catch { throw new HttpError(404, 'no such run'); } }
    if (rm[3] === 'resume' && method === 'POST') { try { return send(res, 202, await s.resumeRun(rm[2]!)); } catch (e) { throw new HttpError(409, (e as Error).message); } }
  }
  const m = /^\/api\/sessions\/([a-f0-9]{16})(?:\/(\w+))?$/.exec(p);
  if (m) {
    const s = sessions.get(m[1]!);
    if (!s) throw new HttpError(404, 'no such session');
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
      const b = await readJson(req);
      if (typeof b.text !== 'string' || !b.text.trim()) throw new HttpError(400, 'text is required');
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
    if (action === 'workflows' && method === 'GET') {
      const wfs = await s.workflows();
      return send(res, 200, {
        workflows: wfs.map((w) => ({ name: w.name, description: w.description, inputs: w.inputs ?? {}, source: w.source, nodes: Object.entries(w.nodes).map(([id, n]) => ({ id, type: n.type, title: n.title })) })),
        runs: await s.listRuns(),
      });
    }
    if (action === 'workflows' && method === 'POST') {
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

  if (p === '/api/companions' && method === 'GET') return send(res, 200, companions.list());
  if (p === '/api/companions' && method === 'POST') {
    const b = await readJson(req);
    const c = await companions.create(String(b.name ?? 'My computer'));
    return send(res, 201, c);
  }
  const cm = /^\/api\/companions\/(cmp_[a-f0-9]+)$/.exec(p);
  if (cm && method === 'DELETE') { await companions.remove(cm[1]!); return send(res, 200, { ok: true }); }

  throw new HttpError(404, 'not found');
}

async function main() {
  harness = await createHarness({
    dataDir: DATA_DIR,
    plugins: PLUGIN_DIRS,
    shippedPlugins: [path.join(appRoot, 'plugins')],
    mcp: process.env.HARNESS_MCP_CONFIG || undefined,
    log: (m) => console.log(m),
  });
  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
  server.requestTimeout = 0;
  server.listen(PORT, HOST, () => {
    console.log(`harness-web listening on http://${HOST}:${PORT}`);
    console.log(`data: ${DATA_DIR}`);
    if (AUTH_OFF) console.log('auth: off (loopback only)');
    else if (!process.env.HARNESS_TOKEN) console.log(`access token (set HARNESS_TOKEN to fix it): ${TOKEN}`);
    const models = harness.registry.listModels();
    console.log(`models: ${models.map((m) => `${m.id}${m.available ? '' : ' (no key)'}`).join(', ')}`);
    console.log(`plugins: ${harness.registry.plugins.map((x) => x.name).join(', ') || 'none'}`);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
