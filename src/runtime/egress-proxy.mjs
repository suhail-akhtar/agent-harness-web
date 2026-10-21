// The sandbox's only way out when its network is an allowlist: an HTTP proxy
// (CONNECT for HTTPS, absolute-form requests for HTTP) that lets through only
// the hosts in a policy file. For a Docker sandbox it runs as a small container
// beside the sandbox, which sits on an internal network with no route anywhere
// else; for the OS sandboxes (bubblewrap, Seatbelt) it runs as a local process
// the sandboxed command can reach and nothing else. The policy file is re-read
// when it changes, so hosts can be allowed mid-session.
// Plain JavaScript with no dependencies: it runs in any image that has Node.
//
//   ALLOW_FILE=/policy/allow.json  {"hosts": ["registry.npmjs.org", "*.github.com", "10.0.0.5:8080", "example.com GET,HEAD"]}
//   PORT=3128 (0: any free port)  HOST=0.0.0.0  UPSTREAM_PROXY=http://proxy.corp:8080 (optional)
//   SOCKET=/run/x/proxy.sock (optional): also listen on this unix socket (bubblewrap bridges to it)
//   SELF=127.0.0.1:3128 (optional): more names the proxy itself answers to besides egress:<port>
//   CREDENTIALS_FILE=/secrets/credentials.json, or CREDENTIALS_STDIN=1 (the JSON on stdin, never on disk)
//     {"openai": {"upstream": "https://api.openai.com", "headers": {"authorization": "Bearer sk-..."},
//                 "allow": [{"methods": ["POST"], "paths": ["/v1/chat/completions"]}]}}
//   PARENT_WATCH=1: exit when stdin closes (a local proxy dies with the harness).
//
// A host entry may end with the methods it allows ("example.com GET,HEAD", or
// "example.com read-only"). That is enforced where the proxy sees the request:
// plain http:// and the credential gateway. An HTTPS tunnel (CONNECT) is opaque -
// the proxy does no TLS interception, so for HTTPS only host-level policy applies
// and a host limited to some methods is refused over CONNECT rather than opened.
//
// It is also the credential gateway. A request to http://egress:3128/__cred/<name>/<path>
// goes to that credential's upstream with its headers added here, outside the
// sandbox: commands use an API without the key ever entering the sandbox (they
// hold a placeholder). Whatever auth headers the sandbox sends are dropped. A
// credential's "allow" rules limit it to some methods and paths (read-only
// GitHub, a model API's inference endpoints).
//
// Every decision is one JSON line on stdout, which the harness reads.

import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';

let credCache = { mtimeMs: -1, creds: {} };
export function credentials(file) {
  if (!file) return {};
  if (typeof file === 'object') return file;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== credCache.mtimeMs) credCache = { mtimeMs: st.mtimeMs, creds: JSON.parse(fs.readFileSync(file, 'utf8')) ?? {} };
  } catch { credCache = { mtimeMs: -1, creds: {} }; }
  return credCache.creds;
}

/**
 * "/__cred/openai/v1/models?x=1" (or the same as an absolute URL to the proxy itself) -> { name, rest }.
 * `self`: the names the proxy answers to (default: egress on any port).
 */
export function credentialRoute(reqUrl, self = ['egress']) {
  let p = reqUrl ?? '';
  if (!p.startsWith('/')) {
    try {
      const u = new URL(p);
      const names = self.map((s) => s.toLowerCase());
      if (!names.includes(u.hostname.toLowerCase()) && !names.includes(u.host.toLowerCase())) return undefined;
      p = u.pathname + u.search;
    } catch { return undefined; }
  }
  const m = /^\/__cred\/([A-Za-z0-9_-]{1,64})(\/[^#]*)?$/.exec(p);
  return m ? { name: m[1], rest: m[2] ?? '/' } : undefined;
}

/** "/repos/**" style patterns: "*" is one path segment's characters, "**" anything. */
function pathPattern(p) {
  const re = String(p).split(/(\*\*|\*)/).map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`^${re}$`);
}

/**
 * Whether a credential's rules let this request through. No rules: anything.
 * Each rule is { methods?: [...], paths?: [...] }; a request needs one rule that
 * matches both (an absent list matches all).
 */
export function credentialAllows(cred, method, relPath) {
  if (!Array.isArray(cred?.allow)) return true;
  const m = String(method).toUpperCase();
  return cred.allow.some((r) => (!Array.isArray(r.methods) || r.methods.map((x) => String(x).toUpperCase()).includes(m))
    && (!Array.isArray(r.paths) || r.paths.some((p) => pathPattern(p).test(relPath))));
}

function describeRules(cred) {
  return cred.allow.map((r) => `${(r.methods ?? ['any method']).join('/')} ${(r.paths ?? ['any path']).join(', ')}`).join('; ');
}

const DROP = new Set(['host', 'authorization', 'x-api-key', 'api-key', 'proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'cookie', 'transfer-encoding', 'te', 'upgrade']);

/** Behind a corporate proxy: a CONNECT tunnel through it, TLS to the upstream inside. */
function viaUpstream(up, target) {
  return (_opts, cb) => {
    const r = http.request({ host: up.hostname, port: Number(up.port || 80), method: 'CONNECT', path: `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}` });
    r.on('connect', (res2, s) => {
      if (res2.statusCode !== 200) return cb(new Error(`upstream proxy refused (${res2.statusCode})`));
      cb(null, target.protocol === 'https:' ? tls.connect({ socket: s, servername: target.hostname }) : s);
    });
    r.on('error', cb);
    r.end();
  };
}

function forwardCredential(file, route, req, res, log, up) {
  const cred = credentials(file)[route.name];
  if (!cred || typeof cred.upstream !== 'string') {
    log({ t: Date.now(), kind: 'credential', name: route.name, allowed: false, why: 'no such credential' });
    return void res.writeHead(404, { 'content-type': 'text/plain' }).end(`No credential named ${route.name} is configured for this sandbox.\n`);
  }
  let target;
  try { target = new URL(route.rest.replace(/^\/+/, ''), cred.upstream.replace(/\/*$/, '/')); } catch { return void res.writeHead(400).end('bad path'); }
  // The path stays under the upstream: no "//other.host" or ".." walking out of it.
  const upUrl = new URL(cred.upstream);
  if (target.origin !== upUrl.origin) return void res.writeHead(400).end('bad path');
  const upPath = upUrl.pathname.replace(/\/+$/, '');
  if (upPath && target.pathname !== upPath && !target.pathname.startsWith(`${upPath}/`)) return void res.writeHead(400).end('bad path');
  // The URL parser has resolved "..", "%2e%2e" and the like: the rules see the path the upstream will.
  const rel = target.pathname.slice(upPath.length) || '/';
  const method = (req.method ?? 'GET').toUpperCase();
  if (!credentialAllows(cred, method, rel)) {
    log({ t: Date.now(), kind: 'credential', name: route.name, allowed: false, why: `${method} ${rel} is not allowed` });
    return void res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by the harness: the ${route.name} credential does not allow ${method} ${rel}. It allows: ${describeRules(cred)}.${cred.hint ? ` ${cred.hint}` : ''}\n`);
  }
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k.toLowerCase())) headers[k] = v;
  Object.assign(headers, cred.headers ?? {}, { host: target.host });
  const lib = target.protocol === 'https:' ? https : http;
  const out = lib.request(target, { method: req.method, headers, ...(up ? { createConnection: viaUpstream(up, target), agent: false } : {}) }, (r) => {
    log({ t: Date.now(), kind: 'credential', name: route.name, allowed: true, status: r.statusCode });
    const h = { ...r.headers };
    delete h['set-cookie'];
    res.writeHead(r.statusCode ?? 502, h);
    r.pipe(res);
  });
  out.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(`upstream error: ${e.message}`); else res.end(); });
  req.pipe(out);
}

let cache = { mtimeMs: -1, hosts: [] };
export function policy(file) {
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, hosts: (JSON.parse(fs.readFileSync(file, 'utf8')).hosts ?? []).map((h) => String(h).trim()).filter(Boolean) };
  } catch { cache = { mtimeMs: -1, hosts: [] }; }
  return cache.hosts;
}

const READ_ONLY = ['GET', 'HEAD', 'OPTIONS'];

/** "example.com:8080 GET,HEAD" -> { name, port, methods }; methods undefined means any. */
export function parseEntry(entry) {
  const [hp = '', meth] = String(entry).trim().split(/\s+/, 2);
  const m = /^(.*?)(?::(\d+))?$/.exec(hp.toLowerCase());
  const methods = meth ? (/^read-?only$/i.test(meth) ? READ_ONLY : meth.toUpperCase().split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  return { name: m[1].replace(/^\[|\]$/g, ''), port: m[2] ? Number(m[2]) : undefined, methods };
}

function entryMatches(e, h, port) {
  if (e.port !== undefined ? e.port !== port : port !== 80 && port !== 443) return false;
  return e.name.startsWith('*.') ? h.endsWith(e.name.slice(1)) && h !== e.name.slice(2) : h === e.name;
}

/**
 * What the allowlist says about host:port: undefined (not allowed), null (any
 * method), or the methods allowed (every matching entry's, together).
 */
export function access(hosts, host, port) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  let hit = false; let any = false;
  const methods = new Set();
  for (const e of hosts.map(parseEntry)) {
    if (!entryMatches(e, h, port)) continue;
    hit = true;
    if (!e.methods) any = true; else for (const x of e.methods) methods.add(x);
  }
  return !hit ? undefined : any ? null : [...methods];
}

/** "host" allows ports 80 and 443; "host:port" that port only; "*.example.com" any subdomain. */
export function allowed(hosts, host, port) {
  return access(hosts, host, port) !== undefined;
}

/** True when a host is named exactly in the list (then a private address is the operator's intent). */
const named = (hosts, host) => hosts.some((e) => parseEntry(e).name === host.toLowerCase());

export function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

/**
 * Decides one destination; resolves it so an allowed name cannot point inside.
 * `method`: the request's (plain HTTP); undefined for a CONNECT tunnel, which
 * cannot be held to a method list.
 */
async function decide(file, host, port, method) {
  const hosts = policy(file);
  const a = access(hosts, host, port);
  if (a === undefined) return { ok: false, why: 'not in the allowlist' };
  if (a !== null) {
    if (method === undefined) return { ok: false, why: `is limited to ${a.join(', ')}, which an HTTPS tunnel cannot enforce (the proxy does no TLS interception); only plain http:// or a credential gateway route can reach it` };
    if (!a.includes(method.toUpperCase())) return { ok: false, why: `does not allow ${method.toUpperCase()} (only ${a.join(', ')})` };
  }
  if (named(hosts, host) && net.isIP(host)) return { ok: true, address: host };
  let address;
  try { address = net.isIP(host) ? host : (await dns.lookup(host)).address; } catch (e) { return { ok: false, why: `cannot resolve: ${e.code ?? e.message}` }; }
  if (isPrivate(address) && !named(hosts, host)) return { ok: false, why: `resolves to a private address (${address})` };
  return { ok: true, address };
}

export function createEgressProxy({ allowFile, credentialsFile, credentials: credObject, upstream, self = [], log = (e) => process.stdout.write(JSON.stringify(e) + '\n') }) {
  const up = upstream ? new URL(upstream) : undefined;
  const creds = credObject ?? credentialsFile;
  const selfNames = () => ['egress', `egress:${server.address()?.port ?? 3128}`, ...self];
  const isSelf = (host, port) => {
    const h = host.toLowerCase();
    return (h === 'egress' && port === (server.address()?.port ?? 3128)) || self.some((s) => s.toLowerCase() === `${h}:${port}`);
  };
  const deny = (sock, host, why) => {
    sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nBlocked by the harness network policy: ${host} ${why}. Ask the user to allow it.\n`);
  };
  const server = http.createServer(async (req, res) => {
    const route = credentialRoute(req.url, selfNames());
    if (route) return forwardCredential(creds, route, req, res, log, up);
    // Plain HTTP through the proxy: an absolute URL.
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end('absolute URL required'); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end('only http:// here; use CONNECT for https'); return; }
    const port = Number(u.port || 80);
    const d = await decide(allowFile, u.hostname, port, req.method ?? 'GET');
    log({ t: Date.now(), kind: 'http', host: u.hostname, port, method: req.method, allowed: d.ok, why: d.why });
    if (!d.ok) { res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by the harness network policy: ${u.hostname} ${d.why}. Ask the user to allow it.\n`); return; }
    const headers = { ...req.headers };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const target = up ? { host: up.hostname, port: Number(up.port || 80), path: u.href } : { host: d.address, port, path: u.pathname + u.search, servername: u.hostname };
    const out = http.request({ ...target, method: req.method, headers: { ...headers, host: u.host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    out.on('error', (e) => { if (!res.headersSent) res.writeHead(502).end(`upstream error: ${e.message}`); else res.end(); });
    req.pipe(out);
  });
  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    if (!m) return void sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    const [host, port] = [m[1], Number(m[2])];
    // A client that tunnels even plain http (Node's env proxy does) to the proxy itself,
    // for the credential gateway: speak HTTP to our own server over the tunnel.
    if (isSelf(host, port)) {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) sock.unshift(head);
      server.emit('connection', sock);
      return;
    }
    const d = await decide(allowFile, host, port);
    log({ t: Date.now(), kind: 'connect', host, port, allowed: d.ok, why: d.why });
    if (!d.ok) return deny(sock, host, d.why);
    const onUp = (s) => {
      s.on('error', () => sock.destroy());
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) s.write(head);
      s.pipe(sock); sock.pipe(s);
    };
    if (!up) {
      const s = net.connect(port, d.address, () => onUp(s));
      s.on('error', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      return;
    }
    // Chained through an upstream proxy (a corporate network).
    const r = http.request({ host: up.hostname, port: Number(up.port || 80), method: 'CONNECT', path: `${host}:${port}` });
    r.on('connect', (res2, s) => (res2.statusCode === 200 ? onUp(s) : sock.end(`HTTP/1.1 ${res2.statusCode} Upstream refused\r\n\r\n`)));
    r.on('error', () => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    r.end();
  });
  return server;
}

/** One line of JSON from stdin; the rest of stdin stays open (the parent watch). */
function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (c) => {
      buf += c;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(buf.slice(0, i));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', () => resolve(buf));
  });
}

// Run directly: the sidecar's (or the local proxy's) entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3128);
  const bind = process.env.HOST || '0.0.0.0';
  const credsIn = process.env.CREDENTIALS_STDIN === '1' ? JSON.parse((await readStdin()) || '{}') : undefined;
  const self = (process.env.SELF ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const server = createEgressProxy({
    allowFile: process.env.ALLOW_FILE || '/policy/allow.json', credentialsFile: process.env.CREDENTIALS_FILE || undefined, credentials: credsIn,
    upstream: process.env.UPSTREAM_PROXY || undefined, self,
  });
  if (process.env.PARENT_WATCH === '1') {
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('error', () => process.exit(0));
    process.stdin.resume();
  }
  await new Promise((r) => server.listen(port, bind, r));
  const actual = server.address().port;
  // On loopback the proxy also answers to its own address (the sandbox's gateway URL).
  if (bind === '127.0.0.1') self.push(`127.0.0.1:${actual}`, `localhost:${actual}`);
  // A unix socket too: connections on it are served by the same server.
  const sock = process.env.SOCKET;
  if (sock) {
    try { fs.rmSync(sock, { force: true }); } catch { /* none */ }
    await new Promise((r) => net.createServer((s) => server.emit('connection', s)).listen(sock, r));
  }
  process.stdout.write(JSON.stringify({ t: Date.now(), kind: 'ready', port: actual, ...(sock ? { socket: sock } : {}) }) + '\n');
}
