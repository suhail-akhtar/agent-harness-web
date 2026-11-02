// Live check of the MCP server builder against a real model and a real API (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-mcp-build.mjs [--model claude-sonnet-5-5]
//
// The model drafts a server from a plain description of a public API that needs no key (Open-Meteo: geocoding,
// current weather, a forecast). The harness checks the spec, builds the server on the official SDK, and checks it
// with its own client: both protocol eras, stdio and HTTP, and each read-only tool called with its example, so the
// real API answers. Then the server joins a person's servers and a conversation on the same model uses it to
// answer a question. A spend cap (LIVE_MAX_USD, $0.60) stops the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const modelId = arg('--model') ?? 'claude-sonnet-5-5';
const CAP = Number(process.env.LIVE_MAX_USD ?? 0.6);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = String(CAP);
const has = (n) => !!process.env[n]?.trim();
console.log(`keys: ANTHROPIC_API_KEY or GW_ANTHROPIC_API_KEY ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}, DEEPSEEK_API_KEY ${has('DEEPSEEK_API_KEY') ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-mcp-build-')));
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
let spent = 0;
try {
  const model = h.registry.listModels().find((m) => m.id === modelId && m.available);
  if (!model) throw new Error(`${modelId} is not available (its key is missing)`);
  const description = 'A weather server using the free Open-Meteo APIs (no key needed). Tools: find a place by name (the geocoding API at https://geocoding-api.open-meteo.com/v1/search, returning name, country, latitude and longitude), the current weather at a latitude and longitude, and a daily forecast for the next few days (https://api.open-meteo.com/v1/forecast). Temperatures in celsius.';
  const t0 = Date.now();
  const draft = await h.mcpBuilder.draft(undefined, { source: 'description', description }, { model, provider: h.registry.provider(model) });
  spent += draft.costUsd ?? 0;
  console.log(`drafted in ${((Date.now() - t0) / 1000).toFixed(1)}s ($${(draft.costUsd ?? 0).toFixed(4)}): ${draft.spec.name}: ${draft.spec.tools.map((t) => `${t.name} [${t.run.kind}${t.run.kind === 'http' ? ` ${t.run.method} ${t.run.url}` : ''}]`).join(', ')}`);
  check(draft.spec.tools.length >= 2 && draft.spec.tools.length <= 8, `a few workflow tools (${draft.spec.tools.length})`);
  check(draft.spec.tools.every((t) => t.annotations.readOnlyHint === true), 'every tool is marked read-only (they only read)');
  check(/open-meteo\.com/.test(JSON.stringify(draft.spec)), 'the tools call the real Open-Meteo addresses');
  check(draft.spec.tools.filter((t) => t.example).length >= 2, 'examples to check them with');

  const rec = await h.mcpBuilder.build(undefined, draft.spec, {}, 'description');
  for (const c of rec.report.checks) console.log(`   ${c.ok ? 'ok ' : 'NO '} ${c.name}${c.detail ? `: ${c.detail.replace(/\s+/g, ' ').slice(0, 140)}` : ''}`);
  check(rec.report.ok, `built and checked by the harness (${rec.report.checks.filter((c) => c.ok).length}/${rec.report.checks.length})`);
  check(rec.report.checks.some((c) => /works \(called with its example\)/.test(c.name) && c.ok && /latitude|temperature|°|celsius|\d+\.\d+/i.test(c.detail ?? '')), 'a tool called the real API and got weather data');

  if (rec.report.ok) {
    await h.mcpBuilder.register(undefined, rec.name);
    const s = await h.sessions.create({ model: modelId, mode: 'bypass', runtime: { kind: 'local', network: 'none', path: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-mcp-build-ws-'))) } });
    let turns = 0; const waiters = [];
    s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) { turns++; for (const w of waiters.splice(0)) w(); } });
    await s.send('Using my weather server, what is the weather in Lisbon right now, and the forecast for tomorrow? Keep it short.');
    while (turns < 1) await new Promise((r) => waiters.push(r));
    const used = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => b.name);
    check(used.filter((n) => n.startsWith(`mcp__${rec.name}__`)).length >= 2, `the conversation used its tools (${used.join(', ')})`);
    const reply = s.history.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    check(/lisbon|lisboa/i.test(reply) && /°|celsius|\bC\b/i.test(reply), 'the answer has Lisbon\'s weather');
    console.log(`\nreply: ${reply.slice(0, 700)}`);
    spent += s.meta.cost ?? 0;
  }
  const b = await h.mcpBuilder.pack(undefined, rec.name).catch((e) => ({ error: e.message }));
  check(!!b.bundle, b.bundle ? `packed as a .mcpb (${b.bundle.bytes} bytes)` : `packed: ${b.error}`);
  console.log(`\nspent: $${spent.toFixed(4)} on ${modelId}`);
} finally {
  await h.close();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
