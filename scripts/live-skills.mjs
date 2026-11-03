// Live check of skills made by an agent and used by another (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=.env scripts/live-skills.mjs [--model claude-haiku-5-5] [--user-model claude-haiku-5-5]
//
// A person asks, in their own words, for a skill for exact work (reconciling a bank statement against invoices). The
// conversation finds the skill-creator, builds a skill with a script and its tests, checks it and keeps it. Then the
// person makes an agent with that skill and, in another conversation on another folder, asks it to reconcile two
// real files: the agent runs the skill's script, and its answer is held to the known result. A spend cap
// (LIVE_MAX_USD, $1.00) stops the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const makerModel = arg('--model') ?? 'claude-haiku-5-5';
const userModel = arg('--user-model') ?? makerModel;
const CAP = Number(process.env.LIVE_MAX_USD ?? 1);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = String(CAP);
const has = (n) => !!process.env[n]?.trim();
console.log(`keys: ANTHROPIC_API_KEY or GW_ANTHROPIC_API_KEY ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { checkSkillDir } = await imp('src/skills/package.ts');

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-skills-')));
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
let spent = 0;

const converse = async (s, text) => {
  let done = false; const waiters = [];
  const off = s.subscribe(0, ({ event }) => {
    if (event.kind === 'turn_end' && !event.agent) { done = true; for (const w of waiters.splice(0)) w(); }
    if (event.kind === 'tool_call') console.log(`   ${event.agent && event.agent !== 'main' ? `[${event.agent}] ` : ''}${event.name} ${JSON.stringify(event.input).slice(0, 140)}`);
  });
  const t0 = Date.now();
  await s.send(text);
  while (!done) await new Promise((r) => waiters.push(r));
  off?.();
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(0)}s, $${(s.meta.cost ?? 0).toFixed(4)})`);
  return s.history.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
};
const toolsUsed = (s) => s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => b.name);

try {
  for (const id of new Set([makerModel, userModel])) if (!h.registry.listModels().some((m) => m.id === id && m.available)) throw new Error(`${id} is not available (its key is missing)`);

  // 1. The person asks for a skill.
  const ws1 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-skills-make-')));
  const s1 = await h.sessions.create({ model: makerModel, mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws1 } });
  console.log(`\n1. making the skill on ${makerModel}`);
  const reply1 = await converse(s1, 'Make me a skill for reconciling our bank statement against our invoice list. Both are CSV exports. Each payment should be matched to an invoice by its reference when the description has one (people write INV-1002, INV1002 or inv 1002), otherwise by an exact amount. Banks take small fees, so a payment up to 3.00 short of the invoice still counts. I need the invoices nobody paid and the payments we can\'t place. It has to be exact, so do the matching in code, not by reading.');
  spent += s1.meta.cost ?? 0;
  console.log(`\n   reply: ${reply1.slice(0, 600)}`);
  const used1 = toolsUsed(s1);
  check(used1.includes('skill') && JSON.stringify(s1.history).includes('"skill-creator"'), 'it loaded the skill-creator');
  check(used1.includes('save_skill'), `it kept the skill (save_skill; tools: ${[...new Set(used1)].join(', ')})`);
  const names = await h.skillStore.names(undefined);
  check(names.length >= 1, `a skill is in the person's library (${names.join(', ') || 'none'})`);
  const name = names[0];
  if (!name) throw new Error('no skill was kept');
  const report = await checkSkillDir(path.join(h.skillStore.root(undefined), name));
  const m = report.manifest;
  console.log(`   ${name}: ${m.scripts.join(', ')}; tests ${m.tests.join(', ')}; references ${m.references.join(', ') || 'none'}; ${m.lines} lines in SKILL.md`);
  check(report.ok, `the kept skill passes its check${report.problems.length ? `: ${report.problems.join('; ')}` : ''}`);
  check(m.scripts.length >= 1, 'it has a script for the matching');
  check(m.tests.length >= 1, 'and tests of it');

  // 2. An agent of the person's with that skill, in another conversation on two real files.
  await h.agentStore.create(undefined, { name: 'reconciler', description: 'Reconciles bank statements against invoices.', prompt: 'You reconcile our bank statements against our invoices.', tools: ['read', 'glob'], skills: [name] });
  const ws2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-skills-use-')));
  fs.writeFileSync(path.join(ws2, 'invoices.csv'), 'invoice,customer,amount\nINV-1001,Acme Ltd,1200.00\nINV-1002,Beta Corp,450.50\nINV-1003,Gamma LLC,89.99\nINV-1004,Delta Inc,3000.00\nINV-1005,Echo Studio,75.00\nINV-1006,Foxtrot GmbH,640.00\n');
  fs.writeFileSync(path.join(ws2, 'bank-october.csv'), 'date,description,amount\n2026-10-02,ACME LTD INV-1001,1200.00\n2026-10-03,Payment Beta Corp ref INV1002,448.00\n2026-10-05,DELTA INC,3000.00\n2026-10-06,Unknown transfer,512.30\n2026-10-09,foxtrot inv 1006,640.00\n');
  const s2 = await h.sessions.create({ model: userModel, mode: 'bypass', agent: 'reconciler', runtime: { kind: 'local', network: 'none', path: ws2 } });
  console.log(`\n2. using it as the reconciler agent on ${userModel}`);
  const reply2 = await converse(s2, 'Reconcile bank-october.csv against invoices.csv. Which invoices are still unpaid, and which payments can\'t we place?');
  spent += s2.meta.cost ?? 0;
  console.log(`\n   reply: ${reply2.slice(0, 900)}`);
  const used2 = toolsUsed(s2);
  check(used2.includes('skill_script'), `the agent ran the skill's script (tools: ${[...new Set(used2)].join(', ')})`);
  check(/INV-?1003/i.test(reply2) && /INV-?1005/i.test(reply2), 'unpaid: INV-1003 and INV-1005');
  check(!/INV-?100[1246]\b[^\n]*(unpaid|outstanding|not paid)/i.test(reply2), 'no paid invoice called unpaid');
  check(/512\.30/.test(reply2), 'the payment it cannot place: 512.30');
  console.log(`\nspent: $${spent.toFixed(4)} (${makerModel}${userModel !== makerModel ? `, ${userModel}` : ''})`);
} finally {
  await h.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
