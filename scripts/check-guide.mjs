// Follows docs/guide with only the kit, as a reader would, so what the guides say is what happens.
//   node --env-file=.env scripts/check-guide.mjs <harness-kit-x.y.z.tgz> [--model claude-haiku-5-5]
// Unpacks the kit, makes an app and a plugin, runs the expense-review example's tests and review, starts a server with
// it, and drives the whole example from examples/guide/client-app on a real model (spends a few cents).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const archive = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(archive)) { console.error('usage: check-guide.mjs <harness-kit-x.y.z.tgz> [--model m]'); process.exit(2); }
const model = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : 'claude-haiku-5-5';
const results = [];
const check = (ok, what, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && detail ? `\n      ${String(detail).slice(-900)}` : ''}`); };
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guide-check-')));
const keys = Object.fromEntries(Object.entries(process.env).filter(([k]) => /ANTHROPIC/.test(k)));
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^HARNESS_|^GW_/.test(k)));
const env = { ...clean, HARNESS_HOME: path.join(root, 'home') };
const sh = (cmd, args, o = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', env, shell: process.platform === 'win32' && cmd === 'npm', maxBuffer: 64 << 20, ...o }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }; };

// 03-getting-started.md
fs.copyFileSync(archive, path.join(root, path.basename(archive)));
check(sh('tar', ['-xzf', path.basename(archive)], { cwd: root }).code === 0, 'the kit unpacks');
const kit = path.join(root, path.basename(archive).replace(/\.tgz$/, ''));
const harness = (args, o) => sh(process.execPath, [path.join(kit, 'bin', 'harness.mjs'), ...args], { cwd: root, ...o });
let r = harness(['verify', '--lock']);
check(r.code === 0, 'harness verify --lock', r.out);
r = harness(['new', 'my-agent']);
check(r.code === 0, 'harness new my-agent', r.out);
const app = path.join(root, 'my-agent');
r = sh('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: app });
check(r.code === 0, 'npm install in the app', r.out);
r = sh('npm', ['test'], { cwd: app, timeout: 120000 });
check(r.code === 0 && /pass 1/.test(r.out), 'npm test in the app', r.out);
r = sh('npm', ['start', '--', 'Look up order A1 and tell me its status in one short sentence.'], { cwd: app, env: { ...env, ...keys, MODEL: model }, timeout: 180000 });
check(r.code === 0 && /shipped/i.test(r.out), `npm start in the app answers on ${model}`, r.out);

// 04-build-your-system.md
const example = path.join(root, 'plugins', 'expense-review');
fs.mkdirSync(path.dirname(example), { recursive: true });
check(harness(['example', 'expense-review', '--dir', example]).code === 0, 'harness example expense-review');
r = harness(['plugin', 'test', example], { timeout: 180000 });
check(r.code === 0 && /pass 5/.test(r.out), 'harness plugin test on the example', r.out);
r = harness(['plugin', 'check', example, '--deep'], { timeout: 180000 });
check(r.code === 0 && /OK \(score 100\/100/.test(r.out), 'harness plugin check --deep on the example: 100/100', r.out);

const port = 43000 + Math.floor(Math.random() * 2000);
const token = 'check-guide-token-0123456789';
const server = spawn(process.execPath, [path.join(kit, 'bin', 'harness.mjs'), 'start'], { cwd: root, env: { ...env, ...keys, HARNESS_PORT: String(port), HARNESS_TOKEN: token, HARNESS_PLUGINS: path.join(root, 'plugins') }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
for (let i = 0; i < 120 && !/listening on/.test(log); i++) await new Promise((res) => setTimeout(res, 500));
check(/plugins:.*expense-review/.test(log), 'harness start loads the plugin', log.slice(-600));

const client = path.join(root, 'client-app');
check(harness(['example', 'client-app', '--dir', client]).code === 0, 'harness example client-app');
const pkg = JSON.parse(fs.readFileSync(path.join(client, 'package.json'), 'utf8'));
pkg.dependencies = { '@harness/client': `file:${path.join(kit, 'packages', 'client').split(path.sep).join('/')}` };
fs.writeFileSync(path.join(client, 'package.json'), JSON.stringify(pkg, null, 2));
r = sh('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: client });
check(r.code === 0, 'npm install in the client app', r.out);
r = sh(process.execPath, ['--disable-warning=ExperimentalWarning', 'review.ts'], { cwd: client, env: { ...env, HARNESS_URL: `http://127.0.0.1:${port}`, HARNESS_TOKEN: token, MODEL: model }, timeout: 300000 });
console.log(r.out.split('\n').map((l) => `      ${l}`).join('\n').slice(0, 1800));
check(r.code === 0 && /tool: expense_add/.test(r.out) && /Approval asked/.test(r.out) && /tool: expense_decide|done:/.test(r.out), `the client drives the example on ${model}, with the approval answered`, r.out);

const auth = { authorization: `Bearer ${token}`, 'x-harness': '1' };
const rows = await fetch(`http://127.0.0.1:${port}/api/plugins/expense-review/expenses`, { headers: auth }).then((x) => x.json()).catch((e) => ({ error: e.message }));
const expenses = rows.expenses ?? [];
check(expenses.some((e) => e.who === 'Ana' && e.status === 'approved'), 'the claim within policy was approved', JSON.stringify(rows).slice(0, 400));
check(expenses.some((e) => e.who === 'Tom' && e.status === 'rejected' && /limit/i.test(e.reason ?? '')), 'the claim over the limit was rejected, with the reason from the policy', JSON.stringify(rows).slice(0, 400));
server.kill();
await new Promise((res) => { server.on('exit', res); setTimeout(res, 15000); });
spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed  (left in ${root})`);
process.exit(failed ? 1 : 0);
