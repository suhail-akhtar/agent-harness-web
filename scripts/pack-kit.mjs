// npm run kit: the harness as a signed local package, to build agent systems on without this repository.
//
//   node scripts/pack-kit.mjs [--out dir] [--dirty] [--unsigned] [--no-audit]
//
// Out: <out>/harness-kit-<version>/ (default release/kit), its .tgz and the archive's signature (.tgz.sig.json).
// The kit is the engine's sources, the core's plugins, the SDK and the production dependencies, as the desktop
// app's engine is: nothing is compiled, so what runs is what the suite tested. Keep it outside node_modules
// (Node strips types there for no one): a project links to it with file: dependencies (`harness new`).
//
// The build stops rather than ship: a dirty tree, a high or critical advisory in what ships, a secret file, a value
// from .env or a private key inside, or a symbolic link. Each --flag that loosens one is written into BUILD.json.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prodClosure, shipsFile, shipsSource } from './prod-closure.mjs';
import { keyIdOf, signPlugin, SIG_FILE } from '../src/plugins/signing.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const flag = (n) => process.argv.includes(n);
const rootPkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const version = rootPkg.version;
const name = `harness-kit-${version}`;
const out = path.resolve(arg('--out') ?? path.join(repo, 'release', 'kit'));
const kit = path.join(out, name);
const step = (m) => console.log(`\n[kit] ${m}`);
const stop = (m) => { console.error(`\n[kit] STOPPED: ${m}`); process.exit(1); };
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim();

step(`${name}: what it is built from`);
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain');
if (dirty && !flag('--dirty')) stop(`the working tree has changes, so the kit would not match a commit (--dirty to build anyway):\n${dirty.split('\n').slice(0, 10).join('\n')}`);
console.log(`  commit ${commit.slice(0, 12)}${dirty ? ' + uncommitted changes' : ''}`);

const publisherKey = process.env.HARNESS_PUBLISHER_KEY ?? (() => {
  const d = path.join(os.homedir(), '.harness-publisher');
  const f = fs.existsSync(d) ? fs.readdirSync(d).filter((x) => x.endsWith('.pem')).sort()[0] : undefined;
  return f ? path.join(d, f) : undefined;
})();
if (!publisherKey && !flag('--unsigned')) stop('no publisher key (HARNESS_PUBLISHER_KEY, or a .pem in ~/.harness-publisher); --unsigned to build without');

step('dependencies: advisories in what ships');
const closure = prodClosure(repo, rootPkg);
const shipped = new Set([...closure].map((d) => JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name));
let audit = 'skipped';
if (!flag('--no-audit')) {
  const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 << 20 });
  let report;
  try { report = JSON.parse(r.stdout); } catch { stop('npm audit gave no report (offline? --no-audit to build anyway)'); }
  const found = Object.values(report.vulnerabilities ?? {}).filter((v) => shipped.has(v.name));
  const serious = found.filter((v) => ['high', 'critical'].includes(v.severity));
  if (serious.length) stop(`advisories in what ships: ${serious.map((v) => `${v.name} (${v.severity})`).join(', ')}`);
  audit = { high: 0, critical: 0, other: found.map((v) => `${v.name} (${v.severity})`) };
  console.log(`  ${shipped.size} packages: no high or critical advisories${found.length ? `; ${audit.other.join(', ')}` : ''}`);
}

step('the web interface');
const b = spawnSync(process.execPath, [path.join(repo, 'scripts', 'build.mjs')], { cwd: repo, stdio: 'inherit' });
if (b.status !== 0) stop('the web interface did not build');

step('staging');
fs.rmSync(kit, { recursive: true, force: true });
fs.mkdirSync(kit, { recursive: true });
const skip = shipsSource(repo);
const copy = (from, to, filter = skip) => fs.cpSync(path.join(repo, from), path.join(kit, to ?? from), { recursive: true, dereference: true, filter });
copy('src');
copy('plugins');
for (const p of ['plugin-sdk', 'plugin-ui', 'client']) { copy(`packages/${p}/src`); copy(`packages/${p}/package.json`); }
copy('ui/dist');
copy('ui/index.html');
copy('ui/styles.css');
copy('dist/companion.mjs');
copy('docs/plugin-sdk');
copy('examples/plugins');
copy('kit/bin', 'bin');
copy('kit/templates', 'templates', () => true);
copy('kit/README.md', 'README.md');
copy('kit/SECURITY.md', 'SECURITY.md');
copy('LICENSE');
copy('CHANGELOG.md');
copy('products/keys', 'keys');
for (const dir of closure) fs.cpSync(dir, path.join(kit, path.relative(repo, dir)), { recursive: true, dereference: true, filter: (p) => shipsFile(dir, p) });
console.log(`  ${closure.size} dependencies`);

// No "dependencies": they are already inside. npm then has nothing to fetch when a project links to the kit.
fs.writeFileSync(path.join(kit, 'package.json'), JSON.stringify({
  name: '@harness/core', version, private: true, type: 'module', description: 'The agent harness: engine, SDK and core plugins, as a signed local kit.', license: rootPkg.license,
  bin: { harness: 'bin/harness.mjs' },
  exports: { '.': './src/index.ts', './src/*': './src/*', './plugins/*': './plugins/*', './package.json': './package.json' },
  engines: rootPkg.engines,
}, null, 2) + '\n');

const components = [...closure].map((d) => {
  const p = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));
  return { type: 'library', name: p.name, version: p.version, licenses: p.license ? [{ license: { name: String(p.license) } }] : [], purl: `pkg:npm/${encodeURIComponent(p.name)}@${p.version}` };
}).sort((a, c) => a.name.localeCompare(c.name));
fs.writeFileSync(path.join(kit, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: '@harness/core', version } }, components }, null, 1) + '\n');

step('nothing secret inside');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) stop(`a symbolic link: ${path.relative(kit, p)}`); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(kit);
const envFile = path.join(repo, '.env');
const secrets = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map((l) => /^\s*(?:export\s+)?[A-Za-z_][\w]*\s*=\s*["']?(.*?)["']?\s*$/.exec(l)?.[1]).filter((v) => v && v.length >= 12).map((v) => Buffer.from(v)) : [];
const pem = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----\s+[A-Za-z0-9+/]{40}/;
for (const f of files) {
  const r = path.relative(kit, f).split(path.sep).join('/');
  const base = path.basename(f);
  if (/^\.env(\.|$)/.test(base) && base !== '.env.example') stop(`an environment file: ${r}`);
  if (/\.(key|p12|pfx)$|^id_(rsa|ed25519|ecdsa)$/.test(base) || (base.endsWith('.pem') && !r.startsWith('keys/') && !r.startsWith('node_modules/'))) stop(`a key file: ${r}`);
  const bytes = fs.readFileSync(f);
  // Only the position is said: a secret's value never reaches a log.
  if (secrets.some((s) => bytes.includes(s))) stop(`a value from .env is in ${r}`);
  if (pem.test(bytes.toString('latin1'))) stop(`a private key is in ${r}`);
}
console.log(`  ${files.length} files: no secret files, no .env values (${secrets.length} checked), no private keys`);

fs.writeFileSync(path.join(kit, 'BUILD.json'), JSON.stringify({
  version, commit, dirty: !!dirty, builtAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`,
  audit, files: files.length, dependencies: closure.size,
}, null, 2) + '\n');

step('signing');
if (publisherKey) {
  const pemKey = fs.readFileSync(publisherKey, 'utf8');
  const sig = await signPlugin(kit, pemKey);
  console.log(`  ${Object.keys(sig.files).length} files signed by key ${sig.keyId} (${SIG_FILE})`);
} else console.log('  unsigned (--unsigned)');

step('archive');
const tgz = `${name}.tgz`;
const t = spawnSync('tar', ['-czf', tgz, name], { cwd: out, stdio: 'inherit' });
if (t.status !== 0) stop('tar failed');
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, tgz))).digest('hex');
if (publisherKey) {
  const key = crypto.createPrivateKey(fs.readFileSync(publisherKey, 'utf8'));
  fs.writeFileSync(path.join(out, `${tgz}.sig.json`), JSON.stringify({ file: tgz, sha256, keyId: keyIdOf(crypto.createPublicKey(key)), signature: crypto.sign(null, Buffer.from(sha256), key).toString('base64') }, null, 1) + '\n');
}
console.log(`\n[kit] done: ${path.join(out, tgz)}  ${(fs.statSync(path.join(out, tgz)).size / 1048576).toFixed(0)} MB\n      sha256 ${sha256}`);
