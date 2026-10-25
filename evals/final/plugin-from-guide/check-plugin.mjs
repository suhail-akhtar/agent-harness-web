// Hidden check: the habit-tracker plugin loads the way the server loads it (npm run plugin -- check),
// its tools follow the contract on dated check-ins (streaks, duplicates, bad dates), its route answers,
// its data survives a restart, and it has a skill and a desktop page wired to the route.
//   node check-plugin.mjs <plugin dir>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = path.resolve(process.argv[2] ?? '.');
const fails = [];
let ok = 0;
const check = (name, cond, got) => { if (cond) ok++; else fails.push(`${name}${got === undefined ? '' : `: got ${JSON.stringify(got).slice(0, 300)}`}`); };

const cli = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(repo, 'src', 'plugins', 'cli.ts'), 'check', dir], { encoding: 'utf8', timeout: 120_000 });
console.log(cli.stdout.trim());
if (cli.status !== 0) { console.log(cli.stderr.trim()); console.log('FAIL: npm run plugin -- check reports a problem'); process.exit(1); }

const { createHarness } = await import(pathToFileURL(path.join(repo, 'src', 'kernel', 'harness.ts')).href);
const { LocalHost } = await import(pathToFileURL(path.join(repo, 'src', 'runtime', 'host.ts')).href);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-check-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-ws-'));
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const open = () => createHarness({ dataDir: data, plugins: [dir], backgroundWork: false, scheduler: false, search: null, log: () => {} });

async function call(h, name, input) {
  const t = h.registry.tools.get(name);
  if (!t) return { missing: true, error: true, text: `no tool ${name}` };
  const ctx = { host: new LocalHost(work), signal: AbortSignal.timeout(30_000), readFiles: new Map(), todos: [], setTodos() {}, emit() {} };
  try {
    const r = await t.run(input, ctx);
    const text = typeof r === 'string' ? r : String(r?.content ?? '');
    return { error: typeof r === 'object' && !!r?.is_error, text };
  } catch (e) { return { error: true, text: String(e?.message ?? e) }; }
}
async function route(h) {
  const r = h.registry.routes.find((x) => x.plugin === 'habit-tracker' && x.method === 'GET' && x.path.replace(/^\//, '') === 'habits');
  if (!r) return { missing: true };
  const out = await r.handler({ method: 'GET', path: 'habits', query: {}, headers: {}, body: Buffer.alloc(0), ip: '127.0.0.1', user: { id: 'u1', name: 'tester', role: 'admin' } });
  const body = typeof out.body === 'string' ? JSON.parse(out.body) : Buffer.isBuffer(out.body) ? JSON.parse(out.body.toString('utf8')) : out.body;
  return { status: out.status ?? 200, auth: r.auth, body };
}

let h = await open();
try {
  for (const t of ['habit_add', 'habit_checkin', 'habit_report']) check(`tool ${t} exists`, h.registry.tools.has(t));
  check('add Read', !(await call(h, 'habit_add', { name: 'Read', why: 'learn' })).error);
  check('add a duplicate ignoring case is an error', (await call(h, 'habit_add', { name: 'read' })).error);
  check('add Run', !(await call(h, 'habit_add', { name: 'Run' })).error);
  check('add Stretch', !(await call(h, 'habit_add', { name: 'Stretch' })).error);
  for (const d of [0, -1, -2]) check(`Read on day ${d}`, !(await call(h, 'habit_checkin', { name: 'Read', date: day(d) })).error);
  check('Read again today (counts once)', true, (await call(h, 'habit_checkin', { name: 'Read', date: day(0) })).text);
  check('Read today with no date', true, (await call(h, 'habit_checkin', { name: 'Read' })).text);
  for (const d of [-1, -3]) check(`Run on day ${d}`, !(await call(h, 'habit_checkin', { name: 'Run', date: day(d) })).error);
  check('Stretch three days ago', !(await call(h, 'habit_checkin', { name: 'Stretch', date: day(-3) })).error);
  check('an unknown habit is an error', (await call(h, 'habit_checkin', { name: 'Juggle' })).error);
  check('a malformed date is an error', (await call(h, 'habit_checkin', { name: 'Read', date: '2026-13-40' })).error);
  check('a future date is an error', (await call(h, 'habit_checkin', { name: 'Read', date: day(1) })).error);
  const report = (await call(h, 'habit_report', {})).text;
  check('Read: 3-day streak', /Read: 3-day streak/i.test(report), report);
  check('Run: 1-day streak (ends yesterday)', /Run: 1-day streak/i.test(report), report);
  check('Stretch: 0-day streak', /Stretch: 0-day streak/i.test(report), report);
  const r = await route(h);
  check('route GET habits exists', !r.missing);
  if (!r.missing) {
    check('route is for signed-in users', r.auth === 'user', r.auth);
    const list = r.body?.habits ?? [];
    const read = list.find((x) => /^read$/i.test(x.name));
    const stretch = list.find((x) => /^stretch$/i.test(x.name));
    check('route lists three habits', list.length === 3, list);
    check('route: Read streak 3, total 3, last today', read && read.streak === 3 && read.total === 3 && read.lastCheckin === day(0), read);
    check('route: Stretch streak 0, total 1', stretch && stretch.streak === 0 && stretch.total === 1 && stretch.lastCheckin === day(-3), stretch);
  }
} finally { await h.close(); }

// A restart: the same data folder, a new harness.
h = await open();
try {
  const report = (await call(h, 'habit_report', {})).text;
  check('the data survives a restart', /Read: 3-day streak/i.test(report) && /Run: 1-day streak/i.test(report), report);
  const e = h.plugins.list().find((x) => x.name === 'habit-tracker');
  const c = e?.ui?.contributes ?? {};
  const views = (c.views ?? []).filter((v) => v.kind === 'frame' && v.entry);
  check('a frame page', views.length >= 1, c.views);
  check('opened from the sidebar', (c.navItems ?? []).some((n) => views.some((v) => v.id === n.view)), c.navItems);
  check('the page may call its routes', (e?.ui?.capabilities ?? []).includes('routes.call'), e?.ui?.capabilities);
  const html = views[0] ? fs.readFileSync(path.join(dir, views[0].entry), 'utf8') : '';
  check('the page loads the SDK and reads the route', /plugin-ui\.js/.test(html) && /routes\.call/.test(html) && /habits/.test(html));
  check('a skill', fs.existsSync(path.join(dir, 'skills')) && fs.readdirSync(path.join(dir, 'skills'), { recursive: true }).some((f) => String(f).endsWith('SKILL.md')));
} finally { await h.close(); fs.rmSync(data, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); }

for (const f of fails) console.log(`FAIL ${f}`);
console.log(`plugin checks: ${ok} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
