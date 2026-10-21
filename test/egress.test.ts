import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { DockerHost, dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain JS module
const { allowed, createEgressProxy } = await import('../src/runtime/egress-proxy.mjs');

const hasDocker = (await dockerAvailable()) && (await imageExists('harness-sandbox:latest'));

test('allowlist rules: names, wildcards, ports', () => {
  const hosts = ['registry.npmjs.org', '*.github.com', '10.1.2.3:8080'];
  assert.equal(allowed(hosts, 'registry.npmjs.org', 443), true);
  assert.equal(allowed(hosts, 'registry.npmjs.org', 22), false, 'a bare name allows 80 and 443 only');
  assert.equal(allowed(hosts, 'api.github.com', 443), true);
  assert.equal(allowed(hosts, 'github.com', 443), false, '*.github.com is subdomains only');
  assert.equal(allowed(hosts, 'evilgithub.com', 443), false);
  assert.equal(allowed(hosts, '10.1.2.3', 8080), true);
  assert.equal(allowed(hosts, '10.1.2.3', 80), false);
});

async function proxyFixture(hosts: string[]) {
  const dir = await tempDir();
  const file = path.join(dir, 'allow.json');
  await fs.writeFile(file, JSON.stringify({ hosts }));
  const log: { host: string; allowed: boolean; why?: string }[] = [];
  const target = http.createServer((req, res) => res.end(`hello ${req.url}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  const tport = (target.address() as { port: number }).port;
  const proxy = createEgressProxy({ allowFile: file, log: (e: { host: string; allowed: boolean; why?: string }) => log.push(e) });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const pport = (proxy.address() as { port: number }).port;
  const close = () => { target.close(); proxy.close(); };
  return { file, log, tport, pport, close };
}

/** A plain HTTP request through the proxy (absolute form). */
function viaProxy(pport: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pport, path: url, method: 'GET', headers: { host: new URL(url).host } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** CONNECT through the proxy; resolves with the proxy's status line. */
function connect(pport: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(pport, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]!); s.destroy(); });
    s.on('error', reject);
  });
}

test('the egress proxy lets through only allowed hosts, re-reads its policy, and refuses names that resolve inside', async () => {
  const f = await proxyFixture([]);
  try {
    const url = `http://127.0.0.1:${f.tport}/x`;
    const blocked = await viaProxy(f.pport, url);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body, /Blocked by the harness network policy: 127\.0\.0\.1 not in the allowlist/);
    assert.match(await connect(f.pport, `127.0.0.1:${f.tport}`), /403/);
    // Allowed live, without restarting anything (a new mtime).
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(f.file, JSON.stringify({ hosts: [`127.0.0.1:${f.tport}`] }));
    assert.deepEqual(await viaProxy(f.pport, url), { status: 200, body: 'hello /x' });
    assert.match(await connect(f.pport, `127.0.0.1:${f.tport}`), /200 Connection Established/);
    // A name allowed by wildcard that resolves to a private address is refused.
    await fs.writeFile(f.file, JSON.stringify({ hosts: ['*.localhost', 'localhost'] }));
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(f.file, JSON.stringify({ hosts: ['*.example.test', 'localhost:1'] }));
    const r = await connect(f.pport, 'localhost:1');
    assert.match(r, /403|502/);
    assert.ok(f.log.some((e) => !e.allowed && e.why === 'not in the allowlist'));
  } finally { f.close(); }
});

test('docker allowlist sandbox: only the proxy is reachable, and it admits only the allowed hosts', { skip: !hasDocker && 'no docker or sandbox image' }, async () => {
  // A service on the host, reached through the proxy container (on the default bridge).
  const svc = http.createServer((_q, res) => res.end('host service'));
  await new Promise<void>((r) => svc.listen(0, '0.0.0.0', r));
  const port = (svc.address() as { port: number }).port;
  const ws = await tempDir();
  const policy = path.join(await tempDir(), 'egress', 'allow.json');
  await fs.mkdir(path.dirname(policy), { recursive: true });
  await fs.writeFile(policy, JSON.stringify({ hosts: [] }));
  const events: { host: string; allowed: boolean }[] = [];
  const id = `t${Date.now().toString(16)}`;
  const host = new DockerHost(id, ws, { image: 'harness-sandbox:latest', network: 'allowlist', memory: '512m', cpus: '1', policyFile: policy, onEgress: (e) => events.push(e) });
  // The host as the proxy container sees it: the bridge gateway on Linux; Docker Desktop (Windows, macOS) names it.
  const gw = process.platform === 'linux' ? '172.17.0.1' : 'host.docker.internal';
  const fetchCmd = (url: string, extra = '') => `${extra} node -e "fetch('${url}').then(async r=>console.log('STATUS',r.status,await r.text())).catch(e=>console.log('ERR',e.cause?.code||e.cause?.message||e.message))"`;
  try {
    // What a client sees when it asks the proxy for a host that is not allowed (curl: "CONNECT tunnel failed, response 403").
    const probe = `node -e "const s=require('net').connect(3128,'egress',()=>s.write('CONNECT ${gw}:${port} HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n'));s.once('data',d=>{console.log('PROXY',d.toString().split('\\r\\n')[0]);s.destroy()})"`;
    let r = await host.exec(probe, { timeoutMs: 60_000 });
    assert.match(r.stdout, /PROXY HTTP\/1\.1 403 Forbidden/, r.stdout + r.stderr);
    await fs.writeFile(policy, JSON.stringify({ hosts: [`${gw}:${port}`] }));
    r = await host.exec(fetchCmd(`http://${gw}:${port}/`), { timeoutMs: 60_000 });
    assert.match(r.stdout, /STATUS 200 host service/, r.stdout + r.stderr);
    // Without the proxy there is no way out: not to the host, not to the internet.
    r = await host.exec(fetchCmd(`http://${gw}:${port}/`, 'NODE_USE_ENV_PROXY=0'), { timeoutMs: 60_000 });
    // (By name on Docker Desktop: the sandbox's network has no DNS for it either.)
    assert.match(r.stdout, /ERR (ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|EAI_AGAIN|ENOTFOUND)/, r.stdout + r.stderr);
    r = await host.exec(fetchCmd('https://example.com/', 'NODE_USE_ENV_PROXY=0'), { timeoutMs: 60_000 });
    assert.match(r.stdout, /ERR /, r.stdout);
    assert.ok(events.some((e) => !e.allowed) && events.some((e) => e.allowed), JSON.stringify(events));
    assert.deepEqual(await host.allowedHosts(), [`${gw}:${port}`]);
  } finally {
    await host.close();
    svc.close();
  }
});

test('sandbox credentials: presets and files, filled from the server environment; missing variables skip with a reason', async () => {
  const { sandboxCredentials, PLACEHOLDER } = await import('../src/runtime/credentials.ts');
  const dir = await tempDir();
  const file = path.join(dir, 'creds.json');
  await fs.writeFile(file, JSON.stringify([{ name: 'billing', upstream: 'https://api.billing.example/v2/', headers: { Authorization: 'Bearer ${BILLING_TOKEN}' }, env: { BILLING_URL: '{base}' } }, { name: 'bad name', upstream: 'https://x', headers: {}, env: {} }]));
  const r = sandboxCredentials({ HARNESS_SANDBOX_CREDENTIALS: `openai,anthropic,deepseek,${file}`, OPENAI_API_KEY: 'sk-test-1', GW_ANTHROPIC_API_KEY: 'ant-2', BILLING_TOKEN: 'b-3' });
  assert.deepEqual(r.credentials.map((c) => c.name), ['openai', 'anthropic', 'billing']);
  const [openai, anthropic, billing] = r.credentials;
  assert.deepEqual(openai!.headers, { authorization: 'Bearer sk-test-1' });
  assert.deepEqual(openai!.env, { OPENAI_BASE_URL: 'http://egress:3128/__cred/openai/v1', OPENAI_API_KEY: PLACEHOLDER });
  assert.deepEqual(anthropic!.headers, { 'x-api-key': 'ant-2' }, 'the second name is used when the first is not set');
  assert.equal(billing!.upstream, 'https://api.billing.example/v2');
  assert.equal(billing!.env.BILLING_URL, 'http://egress:3128/__cred/billing');
  assert.ok(r.problems.some((p) => /DEEPSEEK_API_KEY is not set/.test(p)), r.problems.join('\n'));
  assert.ok(r.problems.some((p) => /bad name/.test(p)));
  assert.ok(!JSON.stringify(r.credentials.map((c) => c.env)).includes('sk-test-1'), 'no key in what the sandbox gets');
});

test('the credential gateway adds the key outside the sandbox, drops what the sandbox sends, and stays on its upstream', async () => {
  // @ts-expect-error plain JS module
  const { credentialRoute } = await import('../src/runtime/egress-proxy.mjs');
  const seen: { url?: string; auth?: string; cookie?: string; host?: string }[] = [];
  const api = http.createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization, cookie: req.headers.cookie, host: req.headers.host }); res.setHeader('set-cookie', 'track=1'); res.end(JSON.stringify({ ok: true })); });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const aport = (api.address() as { port: number }).port;
  const dir = await tempDir();
  const allow = path.join(dir, 'allow.json');
  await fs.writeFile(allow, JSON.stringify({ hosts: [] }));
  const creds = path.join(dir, 'credentials.json');
  await fs.writeFile(creds, JSON.stringify({ svc: { upstream: `http://127.0.0.1:${aport}/api`, headers: { authorization: 'Bearer real-key' } } }));
  const log: { kind: string; name?: string; allowed?: boolean }[] = [];
  const proxy = createEgressProxy({ allowFile: allow, credentialsFile: creds, log: (e: { kind: string }) => log.push(e) });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const pport = (proxy.address() as { port: number }).port;
  const get = (p: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: pport, path: p, headers }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: b, headers: res.headers })); }).on('error', reject);
  });
  try {
    // Origin form (a client talking to egress directly) and absolute form (through HTTP_PROXY).
    let r = await get('/__cred/svc/v1/models?limit=2', { authorization: 'Bearer placeholder', cookie: 'a=b' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['set-cookie'], undefined, 'no cookies set on the sandbox');
    r = await get('http://egress:3128/__cred/svc/v1/x');
    assert.equal(r.status, 200);
    assert.deepEqual(seen.map((s) => [s.url, s.auth, s.cookie]), [['/api/v1/models?limit=2', 'Bearer real-key', undefined], ['/api/v1/x', 'Bearer real-key', undefined]]);
    assert.equal(seen[0]!.host, `127.0.0.1:${aport}`);
    // Unknown names, and paths that try to leave the upstream.
    assert.equal((await get('/__cred/nope/x')).status, 404);
    assert.equal(credentialRoute('/__cred/svc//evil.example/x')?.rest, '//evil.example/x');
    r = await get('/__cred/svc//evil.example/x');
    assert.equal(seen.at(-1)!.url, '/api/evil.example/x', 'a doubled slash stays a path on the upstream');
    assert.equal(credentialRoute('http://other.example/__cred/svc/x'), undefined, 'only the proxy\'s own name routes to credentials');
    assert.ok(log.some((e) => e.kind === 'credential' && e.name === 'svc' && e.allowed) && log.some((e) => e.kind === 'credential' && e.allowed === false));
    assert.ok(!JSON.stringify(log).includes('real-key'), 'the key is never logged');
  } finally { proxy.close(); api.close(); }
});

const openaiKey = process.env.OPENAI_API_KEY;
test('docker: a sandbox calls a real API through the gateway with only a placeholder key inside', { skip: (!hasDocker && 'no docker or sandbox image') || (!openaiKey && 'no OPENAI_API_KEY') }, async () => {
  const { sandboxCredentials } = await import('../src/runtime/credentials.ts');
  const { credentials } = sandboxCredentials({ HARNESS_SANDBOX_CREDENTIALS: 'openai', OPENAI_API_KEY: openaiKey });
  const ws = await tempDir();
  const policy = path.join(await tempDir(), 'egress', 'allow.json');
  await fs.mkdir(path.dirname(policy), { recursive: true });
  await fs.writeFile(policy, JSON.stringify({ hosts: [] }));
  const host = new DockerHost(`c${Date.now().toString(16)}`, ws, { image: 'harness-sandbox:latest', network: 'allowlist', memory: '512m', cpus: '1', policyFile: policy, credentials });
  try {
    // Listing models costs nothing; it proves the key was added on the way out.
    const r = await host.exec(`node -e "fetch(process.env.OPENAI_BASE_URL+'/models',{headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY}}).then(async r=>{const j=await r.json();console.log('STATUS',r.status,Array.isArray(j.data)?'models':JSON.stringify(j).slice(0,200))})"`, { timeoutMs: 90_000 });
    assert.match(r.stdout, /STATUS 200 models/, r.stdout + r.stderr);
    const env = await host.exec('env; cat /proc/1/environ 2>/dev/null | tr "\\000" "\\n"', { timeoutMs: 30_000 });
    assert.ok(!env.stdout.includes(openaiKey!), 'the key is nowhere in the sandbox environment');
    assert.match(env.stdout, /OPENAI_API_KEY=harness-placeholder/);
    assert.deepEqual(host.credentialEnv(), [{ name: 'openai', vars: ['OPENAI_BASE_URL', 'OPENAI_API_KEY'] }]);
  } finally { await host.close(); }
});
