// Live multi-agent check against the real APIs (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-multi-agent.mjs [--only split|delegate] [--models deepseek-flash,claude-sonnet-5-5]
//
// split (per model, effort medium): in a temp git repository, a desktop session asks its
//   agent to split a small task into two linked sessions that run in parallel (user_asked,
//   fresh, each in its own worktree): one writes a function and its test, one a README
//   section. The parent records the plan as an artifact, is woken by each report, updates
//   the artifact and summarises. Checked: two linked sessions, both reported, files in their
//   worktrees (and the test passes), the artifact has two versions.
// delegate: a deepseek-flash parent hands one review sub-task to claude-sonnet-5-5 (allowed by
//   the delegation setting), the reverse in a second run, and a third run without the
//   setting shows the refusal.
// A total spend cap ($1.50, LIVE_MAX_USD) stops the runs; each session also has its own cap.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const only = arg('--only');
const models = (arg('--models') ?? 'deepseek-flash,claude-sonnet-5-5').split(',');
const CAP = Number(process.env.LIVE_MAX_USD ?? 1.5);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = process.env.HARNESS_MAX_COST_USD ?? '0.45';

const has = (n) => !!process.env[n]?.trim();
console.log(`keys: DEEPSEEK_API_KEY ${has('DEEPSEEK_API_KEY') ? 'present' : 'absent'}, ANTHROPIC_API_KEY or GW_ANTHROPIC_API_KEY ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}`);

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { saveUserSettings } = await imp('src/core/settings.ts');

let spent = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function gitRepo() {
  const dir = tmp('live-repo-');
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 'live@example.com'); g('config', 'user.name', 'Live'); g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# strings\n\nSmall string helpers.\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'strings', version: '0.0.1', type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  g('add', '-A'); g('commit', '-q', '-m', 'init');
  return dir;
}

/** What each agent did: its model, cost, turns, the tools it called, and the start of its last reply. */
function summary(s) {
  const tools = {};
  for (const m of s.history) for (const b of m.content) if (b.type === 'tool_use') tools[b.name] = (tools[b.name] ?? 0) + 1;
  const last = [...s.history].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text' && b.text.trim()));
  return {
    id: s.meta.id, title: s.meta.title, model: s.meta.model, cost: Number(s.meta.cost.toFixed(4)), turns: s.meta.turns, tools,
    byModel: Object.fromEntries(Object.entries(s.meta.byModel).map(([k, v]) => [k, Number(v.cost.toFixed(4))])),
    worktree: s.meta.runtime.worktree?.branch, last: (last?.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') ?? '').replace(/\s+/g, ' ').slice(0, 300),
  };
}

async function harness() {
  const data = tmp('live-data-');
  const h = await createHarness({ dataDir: data, search: null, memory: 'off', backgroundWork: false, scheduler: false });
  return { h, data };
}

async function split(model) {
  const { h } = await harness();
  const repo = gitRepo();
  const t0 = Date.now();
  const s = await h.sessions.create({ title: `split on ${model}`, model, effort: 'medium', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: repo }, client: { kind: 'desktop', version: 'live', renderers: ['mermaid'], tools: [] } });
  const events = [];
  s.subscribe(0, ({ event }) => { if (event.kind !== 'text_delta' && event.kind !== 'reasoning_delta') events.push({ at: Date.now() - t0, event }); });
  await s.send([
    'This repository needs two independent pieces of work. Do them in parallel with two linked sessions (start_session: initiation user_asked, context fresh, use_worktree true), each with a complete brief:',
    '1. "slugify": write src/slugify.js exporting slugify(text) (lower-case, ASCII letters and digits, words joined by single hyphens, no leading or trailing hyphen) and test/slugify.test.js with node:test covering three cases; run `node --test` and make it pass; commit.',
    '2. "readme": add a "## Usage" section to README.md showing how to import and call slugify; commit.',
    'Before starting them, record the plan as a markdown artifact titled "Plan" (one line per task). Then end your turn without waiting.',
    'When their reports reach you, update the Plan artifact (artifact update) to mark each task done, and when both are done reply with a three-bullet summary of what each session did.',
  ].join('\n'));
  // Wait for both linked sessions to report and everyone to be idle for a few seconds.
  const deadline = Date.now() + 12 * 60_000;
  let quiet = 0;
  for (;;) {
    await sleep(1000);
    const kids = (s.meta.linked ?? []).map((id) => h.sessions.get(id)).filter(Boolean);
    const reported = new Set(events.filter((e) => e.event.kind === 'side_session' && e.event.phase === 'report').map((e) => e.event.id));
    const idle = s.status === 'idle' && kids.every((k) => k.status === 'idle');
    const total = s.meta.cost + kids.reduce((a, k) => a + k.meta.cost, 0);
    if (spent + total > CAP) { s.abort(); for (const k of kids) k.abort(); console.log(`stopping: the spend cap ($${CAP}) would be passed`); break; }
    quiet = idle && kids.length >= 2 && kids.every((k) => reported.has(k.meta.id)) ? quiet + 1 : 0;
    if (quiet >= 5) break;
    if (Date.now() > deadline) { console.log('stopping: 12 minutes passed'); s.abort(); for (const k of kids) k.abort(); break; }
  }
  const kids = (s.meta.linked ?? []).map((id) => h.sessions.get(id)).filter(Boolean);
  const files = kids.map((k) => ({ id: k.meta.id, files: ['src/slugify.js', 'test/slugify.test.js', 'README.md'].filter((f) => fs.existsSync(path.join(k.workspace, f)) && (f !== 'README.md' || /## Usage/.test(fs.readFileSync(path.join(k.workspace, f), 'utf8')))) }));
  let testPass = null;
  const coder = kids.find((k) => fs.existsSync(path.join(k.workspace, 'test', 'slugify.test.js')));
  if (coder) { try { execFileSync(process.execPath, ['--test'], { cwd: coder.workspace, stdio: 'pipe', timeout: 60_000 }); testPass = true; } catch { testPass = false; } }
  const arts = await s.artifactStore().list();
  const total = s.meta.cost + kids.reduce((a, k) => a + k.meta.cost, 0);
  spent += total;
  const reports = events.filter((e) => e.event.kind === 'side_session' && e.event.phase === 'report').map((e) => ({ at: Math.round(e.at / 1000), id: e.event.id, reason: e.event.reason, preview: e.event.preview.slice(0, 160) }));
  const r = {
    check: `split (${model})`, pass: kids.length === 2 && reports.length >= 2 && testPass === true && files.some((f) => f.files.includes('README.md')) && arts.some((a) => a.version >= 2),
    seconds: Math.round((Date.now() - t0) / 1000), cost: Number(total.toFixed(4)), autoContinues: s.meta.autoContinues,
    parent: summary(s), children: kids.map(summary), files, testPass, artifacts: arts.map((a) => ({ id: a.id, title: a.title, versions: a.version })), reports,
    reportTimes: reports.map((x) => x.at), startedAt: events.filter((e) => e.event.kind === 'side_session' && e.event.phase === 'started').map((e) => Math.round(e.at / 1000)),
  };
  results.push(r);
  console.log(JSON.stringify(r, null, 1));
  await h.close();
}

async function delegate(parentModel, otherModel, allowed) {
  const { h, data } = await harness();
  if (allowed) await saveUserSettings(data, undefined, { delegation: { allowedModels: [otherModel] } });
  const ws = tmp('live-ws-');
  fs.writeFileSync(path.join(ws, 'sum.js'), 'export function sum(xs) {\n  let t = 0;\n  for (let i = 0; i <= xs.length; i++) t += xs[i];\n  return t;\n}\n');
  const t0 = Date.now();
  const s = await h.sessions.create({ title: `delegate ${parentModel} -> ${otherModel}`, model: parentModel, effort: 'medium', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
  const done = new Promise((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
  await s.send(`Have a reviewer on another model check sum.js: call the agent tool once with type explore and model "${otherModel}", asking it to find bugs in sum.js and report them in two sentences. Then tell me in one sentence what it found (or why it could not run).`);
  await Promise.race([done, sleep(5 * 60_000)]);
  const calls = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use' && b.name === 'agent').map((b) => b.input.model);
  const res = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => b.content).join('\n');
  spent += s.meta.cost;
  const ran = Object.keys(s.meta.byModel).includes(otherModel);
  const r = {
    check: `delegate ${parentModel} -> ${otherModel} (${allowed ? 'allowed' : 'not allowed'})`,
    // Not allowed: the agent tool offers no model parameter at all (nothing to pick), and a model named anyway is refused by name.
    pass: allowed ? ran && /<=|off.by.one|undefined|NaN|bound/i.test(res) : !ran,
    ...(allowed ? {} : { refusal: /not allowed[\s\S]*delegation\.allowedModels/.test(res) ? 'explicit (the agent named the model; the harness refused it)' : 'no model parameter offered (the agent could not name another model)' }),
    seconds: Math.round((Date.now() - t0) / 1000), cost: Number(s.meta.cost.toFixed(4)), agentCalls: calls, byModel: summary(s).byModel, answer: summary(s).last.slice(0, 240),
  };
  results.push(r);
  console.log(JSON.stringify(r, null, 1));
  await h.close();
}

if (!only || only === 'split') for (const m of models) { if (spent < CAP) await split(m); }
if (only === 'refuse') await delegate('deepseek-flash', 'claude-sonnet-5-5', false);
if (!only || only === 'delegate') {
  if (spent < CAP) await delegate('deepseek-flash', 'claude-sonnet-5-5', true);
  if (spent < CAP) await delegate('claude-sonnet-5-5', 'deepseek-flash', true);
  if (spent < CAP) await delegate('deepseek-flash', 'claude-sonnet-5-5', false);
}
console.log('\nSUMMARY');
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.check}  $${r.cost}  ${r.seconds}s`);
console.log(`total spent: $${spent.toFixed(4)} (cap $${CAP})`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
