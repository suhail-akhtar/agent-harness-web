// The sandbox's only way out when its network is an allowlist: an HTTP proxy
// (CONNECT for HTTPS, absolute-form requests for HTTP) that lets through only
// the hosts in a policy file. It runs as a small container beside the sandbox,
// which sits on an internal network with no route anywhere else. The policy
// file is re-read when it changes, so hosts can be allowed mid-session.
// Plain JavaScript with no dependencies: it runs in any image that has Node.
//
//   ALLOW_FILE=/policy/allow.json  {"hosts": ["registry.npmjs.org", "*.github.com", "10.0.0.5:8080"]}
//   PORT=3128   UPSTREAM_PROXY=http://proxy.corp:8080 (optional)
//   CREDENTIALS_FILE=/secrets/credentials.json (optional)
//     {"openai": {"upstream": "https://api.openai.com", "headers": {"authorization": "Bearer sk-..."}}}
//
// It is also the credential gateway. A request to http://egress:3128/__cred/<name>/<path>
// goes to that credential's upstream with its headers added here, outside the
// sandbox: commands use an API without the key ever entering the sandbox (they
// hold a placeholder). Whatever auth headers the sandbox sends are dropped.
//
// Every decision is one JSON line on stdout, which the harness reads.

import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

let credCache = { mtimeMs: -1, creds: {} };
export function credentials(file) {
  if (!file) return {};
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs !== credCache.mtimeMs) credCache = { mtimeMs: st.mtimeMs, creds: JSON.parse(fs.readFileSync(file, 'utf8')) ?? {} };
  } catch { credCache = { mtimeMs: -1, creds: {} }; }
  return credCache.creds;
}

/** "/__cred/openai/v1/models?x=1" (or the same as an absolute URL to the proxy itself) -> { name, rest }. */
export function credentialRoute(reqUrl) {
  let p = reqUrl ?? '';
  if (!p.startsWith('/')) {
    try { const u = new URL(p); if (u.hostname !== 'egress') return undefined; p = u.pathname + u.search; } catch { return undefined; }
  }
  const m = /^\/__cred\/([A-Za-z0-9_-]{1,64})(\/[^#]*)?$/.exec(p);
  return m ? { name: m[1], rest: m[2] ?? '/' } : undefined;
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
  if (target.origin !== new URL(cred.upstream).origin) return void res.writeHead(400).end('bad path');
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
    if (st.mtimeMs !== cache.mtimeMs) cache = { mtimeMs: st.mtimeMs, hosts: (JSON.parse(fs.readFileSync(file, 'utf8')).hosts ?? []).map((h) => String(h).toLowerCase().trim()).filter(Boolean) };
  } catch { cache = { mtimeMs: -1, hosts: [] }; }
  return cache.hosts;
}

/** "host" allows ports 80 and 443; "host:port" that port only; "*.example.com" any subdomain. */
export function allowed(hosts, host, port) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return hosts.some((entry) => {
    const m = /^(.*?)(?::(\d+))?$/.exec(entry);
    const name = m[1];
    const p = m[2] ? Number(m[2]) : undefined;
    if (p !== undefined ? p !== port : port !== 80 && port !== 443) return false;
    return name.startsWith('*.') ? h.endsWith(name.slice(1)) && h !== name.slice(2) : h === name;
  });
}

/** True when a host is named exactly in the list (then a private address is the operator's intent). */
const named = (hosts, host) => hosts.some((e) => e.replace(/:\d+$/, '') === host.toLowerCase());

export function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

/** Decides one destination; resolves it so an allowed name cannot point inside. */
async function decide(file, host, port) {
  const hosts = policy(file);
  if (!allowed(hosts, host, port)) return { ok: false, why: 'not in the allowlist' };
  if (named(hosts, host) && net.isIP(host)) return { ok: true, address: host };
  let address;
  try { address = net.isIP(host) ? host : (await dns.lookup(host)).address; } catch (e) { return { ok: false, why: `cannot resolve: ${e.code ?? e.message}` }; }
  if (isPrivate(address) && !named(hosts, host)) return { ok: false, why: `resolves to a private address (${address})` };
  return { ok: true, address };
}

export function createEgressProxy({ allowFile, credentialsFile, upstream, log = (e) => process.stdout.write(JSON.stringify(e) + '\n') }) {
  const up = upstream ? new URL(upstream) : undefined;
  const deny = (sock, host, why) => {
    sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nBlocked by the harness network policy: ${host} ${why}. Ask the user to allow it.\n`);
  };
  const server = http.createServer(async (req, res) => {
    const route = credentialRoute(req.url);
    if (route) return forwardCredential(credentialsFile, route, req, res, log, up);
    // Plain HTTP through the proxy: an absolute URL.
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end('absolute URL required'); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end('only http:// here; use CONNECT for https'); return; }
    const port = Number(u.port || 80);
    const d = await decide(allowFile, u.hostname, port);
    log({ t: Date.now(), kind: 'http', host: u.hostname, port, allowed: d.ok, why: d.why });
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
    if (host === 'egress' && port === (server.address()?.port ?? 3128)) {
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

// Run directly: the sidecar's entry point.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT || 3128);
  createEgressProxy({ allowFile: process.env.ALLOW_FILE || '/policy/allow.json', credentialsFile: process.env.CREDENTIALS_FILE || undefined, upstream: process.env.UPSTREAM_PROXY || undefined })
    .listen(port, '0.0.0.0', () => process.stdout.write(JSON.stringify({ t: Date.now(), kind: 'ready', port }) + '\n'));
}
