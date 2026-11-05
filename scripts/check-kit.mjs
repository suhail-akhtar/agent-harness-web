// Checks a built kit the way someone with only the archive would meet it. Nothing here imports from the repository.
//   node --env-file=.env scripts/check-kit.mjs <harness-kit-x.y.z.tgz> [--live claude-haiku-5-5]
// Unpacks it into an empty folder, tampers with it in each way, makes an app and a plugin, starts the server.
// --live also asks a real model through the new app (spends money; keys come from the environment, never printed).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const archive = path.resolve(process.argv[2] ?? '');
const liveModel = process.argv.includes('--live') ? process.argv[process.argv.indexOf('--live') + 1] : undefined;
if (!fs.existsSync(archive)) { console.error('usage: check-kit.mjs <harness-kit-x.y.z.tgz> [--live model]'); process.exit(2); }

const results = [];
const check = (ok, what, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `\n      ${String(detail).slice(0, 600)}` : ''}`); };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-check-')));
// A stranger's environment: no key, no harness settings, no home from this machine.
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^HARNESS_|^GW_/.test(k)));
const env = { ...clean, HARNESS_HOME: path.join(root, 'home') };
const sh = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', env, shell: process.platform === 'win32' && cmd === 'npm', maxBuffer: 64 << 20, ...o }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };

const name = path.basename(archive).replace(/\.tgz$/, '');
const copyTo = path.join(root, path.basename(archive));
fs.copyFileSync(archive, copyTo);
if (fs.existsSync(`${archive}.sig.json`)) fs.copyFileSync(`${archive}.sig.json`, `${copyTo}.sig.json`);
const x = sh('tar', ['-xzf', path.basename(copyTo)], { cwd: root });
check(x.code === 0, 'the archive unpacks', x.out);
const kit = path.join(root, name);
const harness = (args, o) => sh(process.execPath, [path.join(kit, 'bin', 'harness.mjs'), ...args], o);

// The archive's own signature.
let r = harness(['verify', '--archive', copyTo]);
check(r.code === 0 && /verified/.test(r.out), 'the archive verifies against its signature', r.out);
const bad = path.join(root, 'bad.tgz');
const bytes = fs.readFileSync(copyTo);
bytes[bytes.length >> 1] ^= 1;
fs.writeFileSync(bad, bytes);
fs.copyFileSync(`${copyTo}.sig.json`, `${bad}.sig.json`);
r = harness(['verify', '--archive', bad]);
check(r.code !== 0 && /NOT VERIFIED/.test(r.out), 'one flipped bit in the archive is refused', r.out);
fs.rmSync(`${bad}.sig.json`);
r = harness(['verify', '--archive', bad]);
check(r.code !== 0, 'an archive with no signature is refused', r.out);

// The unpacked kit.
r = harness(['verify']);
check(r.code === 0, 'the unpacked kit verifies', r.out);
const v = harness(['version']);
check(v.code === 0 && /harness \d/.test(v.out), `version: ${v.out.trim()}`, v.out);

const target = path.join(kit, 'src', 'core', 'permissions.ts');
const original = fs.readFileSync(target);
const refused = (what) => {
  const a = harness(['verify']);
  const b = harness(['start'], { timeout: 60000 });
  check(a.code !== 0 && /NOT VERIFIED/.test(a.out), `${what}: verify refuses`, a.out);
  check(b.code !== 0 && /NOT VERIFIED/.test(b.out) && !/listening/.test(b.out), `${what}: the server refuses to start`, b.out);
};
fs.writeFileSync(target, Buffer.concat([original, Buffer.from('\n// one more line\n')]));
refused('a changed file');
fs.writeFileSync(target, original);
const extra = path.join(kit, 'src', 'core', 'backdoor.ts');
fs.writeFileSync(extra, 'export {};\n');
refused('an added file');
fs.rmSync(extra);
const dep = path.join(kit, 'node_modules', 'undici', 'package.json');
const depBytes = fs.readFileSync(dep);
fs.rmSync(dep);
refused('a removed dependency file');
fs.writeFileSync(dep, depBytes);
const sigFile = path.join(kit, 'harness-plugin.sig');
const sig = fs.readFileSync(sigFile, 'utf8');
const forged = JSON.parse(sig);
forged.files['src/core/permissions.ts'] = '0'.repeat(64);
fs.writeFileSync(sigFile, JSON.stringify(forged));
refused('a file list edited to match');
fs.writeFileSync(sigFile, sig);
r = harness(['verify']);
check(r.code === 0, 'put back, it verifies again', r.out);
const { generateKeyPairSync } = await import('node:crypto');
const otherKey = path.join(root, 'other.pub.pem');
fs.writeFileSync(otherKey, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
r = harness(['verify', '--key', otherKey]);
check(r.code !== 0 && /untrusted key/.test(r.out), 'a key other than the publisher\'s is refused', r.out);

// Nothing that should not be there, checked here without the builder's word for it.
const names = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else names.push(path.relative(kit, p).split(path.sep).join('/')); } };
walk(kit);
check(!names.some((f) => /(^|\/)\.env$|\.env\.(local|production)$/.test(f)), 'no environment files');
check(!names.some((f) => /(^|\/)(test|__tests__)\//.test(f) && !f.startsWith('node_modules/') && !f.startsWith('templates/')), 'no test folders of the repository');
check(!names.some((f) => /^(solutions|apps|\.git|\.claude|\.harness-data)\//.test(f)), 'no solutions, apps or repository folders');
check(fs.readFileSync(path.join(kit, 'keys', fs.readdirSync(path.join(kit, 'keys'))[0]), 'utf8').includes('PUBLIC KEY'), 'keys/ holds a public key');
const build = JSON.parse(fs.readFileSync(path.join(kit, 'BUILD.json'), 'utf8'));
check(/^[0-9a-f]{40}$/.test(build.commit), `built from commit ${build.commit.slice(0, 12)}${build.dirty ? ' (DIRTY)' : ''}`);
check(typeof build.audit === 'object' && build.audit.high === 0 && build.audit.critical === 0, 'no high or critical advisories at build time', JSON.stringify(build.audit));

// An app of one's own, with no network: the kit needs nothing fetched.
r = harness(['new', 'my-agent'], { cwd: root });
check(r.code === 0, 'harness new makes an app', r.out);
const app = path.join(root, 'my-agent');
check(fs.existsSync(path.join(app, '.gitignore')) && fs.existsSync(path.join(app, '.env.example')), 'the app has .gitignore and .env.example');
r = sh('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app });
check(r.code === 0, 'npm install works offline', r.out);
check(fs.lstatSync(path.join(app, 'node_modules', '@harness', 'core')).isSymbolicLink(), 'the app links to the kit (no copy, TypeScript keeps running)');
r = sh('npm', ['test'], { cwd: app, timeout: 120000 });
check(r.code === 0 && /pass 1/.test(r.out), 'the new app\'s test passes', r.out);
r = harness(['verify']);
check(r.code === 0, 'installing and testing an app leaves the kit as signed', r.out);

// A plugin, with the SDK's own tools.
r = harness(['plugin', 'new', 'my-plugin', '--dir', path.join(root, 'my-plugin')], { cwd: root });
check(r.code === 0, 'harness plugin new makes a plugin', r.out);
r = harness(['plugin', 'test', path.join(root, 'my-plugin')], { cwd: root, timeout: 180000 });
check(r.code === 0, 'the new plugin\'s tests pass', r.out);
r = harness(['plugin', 'check', path.join(root, 'my-plugin')], { cwd: root, timeout: 180000 });
check(r.code === 0, 'the new plugin passes the review', r.out);
r = harness(['verify']);
check(r.code === 0, 'making a plugin leaves the kit as signed', r.out);

// The server.
const port = 43000 + Math.floor(Math.random() * 2000);
const token = 'check-kit-token-0123456789';
const server = spawn(process.execPath, [path.join(kit, 'bin', 'harness.mjs'), 'start'], { cwd: root, env: { ...env, HARNESS_PORT: String(port), HARNESS_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 120 && !/listening on/.test(log); i++) await new Promise((res) => setTimeout(res, 500));
check(/listening on http:\/\/127\.0\.0\.1:/.test(log), 'the server starts on loopback', log.slice(-800));
const url = `http://127.0.0.1:${port}`;
const get = (p, headers = {}) => fetch(`${url}${p}`, { headers }).catch((e) => ({ status: 0, text: async () => e.message }));
const anon = await get('/api/sessions');
check(anon.status === 401, 'without the token the API refuses', anon.status);
const authed = await get('/api/sessions', { authorization: `Bearer ${token}` });
check(authed.status === 200, 'with the token it answers', authed.status);
const page = await get('/', { authorization: `Bearer ${token}` });
check(page.status === 200, 'it serves the web interface', page.status);
const companion = await get('/companion.mjs', { authorization: `Bearer ${token}` });
check(companion.status === 200, 'it serves the companion script', companion.status);
check(!log.includes(token), 'a token set by the operator is not printed');
server.kill();
await new Promise((res) => { server.on('exit', res); setTimeout(res, 20000); });
r = harness(['verify']);
check(r.code === 0, 'running the server leaves the kit as signed', r.out);

// Read-only, last: the checks above needed to change files.
r = harness(['verify', '--lock']);
check(r.code === 0 && /read-only/.test(r.out), 'verify --lock passes', r.out);
let wrote = true;
try { fs.appendFileSync(target, 'x'); } catch { wrote = false; }
check(!wrote, 'a locked file cannot be written');
r = sh('npm', ['test'], { cwd: app, timeout: 120000 });
check(r.code === 0 && /pass 1/.test(r.out), 'the app still works on a locked kit', r.out);

if (liveModel) {
  const keys = Object.fromEntries(Object.entries(process.env).filter(([k]) => /_API_KEY$/.test(k)));
  r = sh('npm', ['start', '--', 'Look up order A1 and tell me its status in one short sentence.'], { cwd: app, env: { ...env, ...keys, MODEL: liveModel }, timeout: 180000 });
  check(r.code === 0 && /shipped/i.test(r.out) && /cost: \$0\.\d+/.test(r.out), `a real model (${liveModel}) used the app's tool`, r.out);
  console.log(`      ${r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 200)}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed  (left in ${root})`);
process.exit(failed ? 1 : 0);
