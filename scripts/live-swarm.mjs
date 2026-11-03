// Live check of a swarm across companies, seen into and talked to (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=.env scripts/live-swarm.mjs [--model claude-sonnet-5-5] [--report path/to/AGI-report.md]
//
// A person asks, in their own words, for three claims of a report to be fact-checked at once, one on each of three
// companies' models. While it works: what each sub-agent is doing is read from the session (as the Agents panel
// does), the person writes to one sub-agent and types a message to the lead. Checked: it fanned out across the
// models, the live activity was there (tools and model waits), the person's word and message arrived, and the answer
// holds to the sources (one claim is a misquote: the source says "milestone", the report "goal"). A spend cap
// (LIVE_MAX_USD, $3.00) stops the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const lead = arg('--model') ?? 'claude-sonnet-5-5';
const report = arg('--report') ?? 'E:/tmp/agi-research/research/AGI-report.md';
const CAP = Number(process.env.LIVE_MAX_USD ?? 3);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = String(CAP);
const has = (n) => !!process.env[n]?.trim();
for (const k of [['ANTHROPIC_API_KEY', 'GW_ANTHROPIC_API_KEY'], ['XAI_API_KEY'], ['DEEPSEEK_API_KEY']]) console.log(`keys: ${k.join(' or ')} ${k.some(has) ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { saveUserSettings } = await imp('src/core/settings.ts');

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-swarm-')));
const h = await createHarness({ dataDir: data, memory: 'off' });
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };

try {
  for (const id of [lead, 'grok-4.7', 'deepseek-flash']) if (!h.registry.listModels().some((m) => m.id === id && m.available)) throw new Error(`${id} is not available (its key is missing)`);
  await saveUserSettings(data, undefined, { delegation: { allowedModels: ['grok-4.7', 'deepseek-flash'] } });
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-swarm-ws-')));
  fs.copyFileSync(report, path.join(ws, 'AGI-report.md'));
  const s = await h.sessions.create({ model: lead, mode: 'bypass', runtime: { kind: 'local', network: 'full', path: ws } });

  const events = [];
  let done = false;
  s.subscribe(0, ({ event }) => {
    events.push(event);
    if (event.kind === 'turn_end' && !event.agent) done = true;
    if (event.kind === 'tool_call' && ['agent', 'tell_lead', 'send_message'].includes(event.name)) console.log(`   ${event.agent ? `[${event.agent}] ` : ''}${event.name} ${JSON.stringify(event.input).slice(0, 160)}`);
    if (event.kind === 'notice' && /no reply|stalled|goes on with|to the lead|You to/.test(event.text)) console.log(`   notice: ${event.text.slice(0, 200)}`);
  });
  const ask = 'Fact-check three claims from AGI-report.md at the same time, one each on Claude, Grok 4.7 and DeepSeek Flash. '
    + '(1) The Remote Labor Index best automation rate rose from 2.5% to 15.8%. (2) The IEA estimated data centres used about 415 TWh in 2024. '
    + '(3) OpenAI wrote that it "surpassed that goal" of 10GW for Stargate. Read the sources yourself and tell me which hold up, word for word.';
  const t0 = Date.now();
  await s.send(ask);

  // While it works: what the Agents panel reads (the session's live agents), the person's word to one, a message to the lead.
  const seen = new Map();
  let told, typed;
  while (!done) {
    await new Promise((r) => setTimeout(r, 3000));
    for (const a of s.liveAgents()) {
      const x = a.activity;
      const line = x.doing === 'tool' ? `running ${x.tool}` : `waiting on ${a.model}${x.retries ? ` (retry ${x.retries})` : ''}`;
      if (seen.get(a.name)?.at(-1) !== line) { seen.set(a.name, [...(seen.get(a.name) ?? []), line]); console.log(`   [${a.name}] ${line}`); }
      if (!told && x.doing === 'tool') { told = a.name; console.log(`   person -> ${a.name}: ${s.messageAgent(a.name, 'Quote the exact sentence from the source page in your report.')}`); }
    }
    if (told && !typed) { typed = true; console.log(`   person -> lead (typed while it works): ${await s.send('Keep the final answer to one line per claim.')}`); }
    if ((s.meta.cost ?? 0) > CAP) { console.log('   cap reached: stopping'); s.abort(); break; }
  }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(0)}s, $${(s.meta.cost ?? 0).toFixed(4)})`);
  const reply = s.history.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log(`\n   reply:\n${reply.slice(0, 1500)}\n`);

  const calls = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use' && b.name === 'agent');
  const models = new Set(calls.flatMap((c) => [c.input.model, ...(c.input.models ?? [])]).filter(Boolean));
  const usedModels = new Set(events.filter((e) => e.kind === 'usage' && e.agent && e.agent !== 'main').map((e) => e.model));
  check(usedModels.size >= 2, `sub-agents ran on ${[...usedModels].join(', ') || 'none'} (asked: ${[...models].join(', ') || 'none'})`);
  check([...seen.values()].some((v) => v.some((l) => l.startsWith('running'))) && [...seen.values()].some((v) => v.some((l) => l.startsWith('waiting'))), 'the live activity showed tools and model waits');
  check(!!told && events.some((e) => e.kind === 'notice' && e.text.startsWith(`You to ${told}:`)), `the person's word reached ${told ?? 'no agent'}`);
  const steer = events.filter((e) => e.kind === 'steering');
  check(steer.some((e) => e.texts.length) && steer.at(-1)?.texts.length === 0, 'the message typed while it worked was listed, then seen by the lead');
  check(/milestone/i.test(reply), 'the answer holds to the source on claim 3 ("milestone", not "goal")');
  const empty = /\| no report \|/.test(JSON.stringify(s.history));
  console.log(`   note: ${empty ? 'an agent gave no report (shown as "no report")' : 'every agent reported'}`);
} catch (e) {
  console.log(`ERROR ${e.message}`);
  checks.push({ ok: false, what: e.message });
} finally {
  await h.close?.();
}
const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
