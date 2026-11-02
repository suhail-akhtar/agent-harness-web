// Live check of teams through the harness's own MCP server (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-team.mjs [--model claude-sonnet-5-5]
//
// A folder with two short notes. A person's agents: two summarisers (one note each) and a checker, and a team lead
// ("notes-team") with them as members and the checker as its reviewer. Another app (an MCP client over /mcp, the
// person's token) hands the team a task. Checked from the conversation: the lead delegated to both summarisers in
// one turn (in parallel), the checker reviewed, no other agent ran, and the answer covers both notes. A spend cap
// (LIVE_MAX_USD, $0.80) stops the run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const model = arg('--model') ?? 'claude-sonnet-5-5';
const CAP = Number(process.env.LIVE_MAX_USD ?? 0.8);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = String(CAP);
const has = (n) => !!process.env[n]?.trim();
console.log(`keys: ANTHROPIC_API_KEY or GW_ANTHROPIC_API_KEY ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}, DEEPSEEK_API_KEY ${has('DEEPSEEK_API_KEY') ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');
const { createApp } = await imp('src/server/app.ts');
const { HttpTransport, McpClient } = await imp('src/mcp/client.ts');

const tmp = fs.realpathSync(os.tmpdir());
const data = fs.mkdtempSync(path.join(tmp, 'live-team-'));
const work = fs.mkdtempSync(path.join(tmp, 'live-team-ws-'));
fs.writeFileSync(path.join(work, 'note-a.md'), '# Garden\nThe tomatoes need water every morning. The roses were pruned on Monday. Buy compost before Friday.\n');
fs.writeFileSync(path.join(work, 'note-b.md'), '# Car\nThe car is due for an oil change at 60,000 km (it is at 59,400). The left rear tyre loses pressure slowly.\n');
const TOKEN = 'live-team-operator-token';
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const { server } = createApp({ harness: h, token: TOKEN, loopback: true, localRoots: [tmp], uiDir: path.join(data, 'ui'), appRoot: data });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mcp`;
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
try {
  const mk = (d) => h.agentStore.create(undefined, { model, tools: ['read', 'glob', 'grep'], permissionMode: 'plan', ...d });
  await mk({ name: 'summariser-a', description: 'Summarises one note file into three short bullet points.', prompt: 'Read the file you are given and return exactly three short bullet points.' });
  await mk({ name: 'summariser-b', description: 'Summarises one note file into three short bullet points.', prompt: 'Read the file you are given and return exactly three short bullet points.' });
  await mk({ name: 'checker', description: 'Checks summaries against their source files and lists anything wrong or missing.', prompt: 'Compare each summary with its file; list what is wrong or missing, or say they are accurate.' });
  await mk({ name: 'notes-team', description: 'Summarises a folder of notes with a team: one summariser per note, then a check.', prompt: 'You lead the notes team.', tools: ['read', 'glob'], maxCostUsd: 0.6, team: { members: ['summariser-a', 'summariser-b', 'checker'], reviewer: 'checker' } });

  const c = new McpClient(new HttpTransport(url, { authorization: `Bearer ${TOKEN}` }), { callTimeoutMs: 900_000 });
  await c.initialize();
  const tools = (await c.listTools()).map((t) => t.name);
  check(tools.includes('agent_notes-team') && tools.includes('run_agent'), `the team is a tool for another app (${tools.filter((t) => t.startsWith('agent_')).join(', ')})`);
  const t0 = Date.now();
  const r = await c.callTool('run_agent', { agent: 'notes-team', task: `Summarise the two notes in ${work} (note-a.md and note-b.md): give one summariser each note, then have them checked. Report both summaries and the check.`, folder: work, mode: 'plan', waitSeconds: 600 });
  const text = r.content?.map((x) => x.text).join('') ?? '';
  console.log(`\n${text.slice(0, 1400)}\n(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const conv = r.structuredContent?.conversation;
  const s = conv ? h.sessions.get(conv) : undefined;
  check(!!s && r.structuredContent?.done === true, 'the team finished within the call');
  if (s) {
    const msgs = s.history.filter((m) => m.role === 'assistant');
    const turns = msgs.map((m) => m.content.filter((b) => b.type === 'tool_use' && b.name === 'agent').map((b) => b.input?.type));
    const both = turns.find((x) => x.includes('summariser-a') && x.includes('summariser-b'));
    check(!!both, `both summarisers started in one turn (in parallel): ${JSON.stringify(turns.filter((x) => x.length))}`);
    // A review that finds something sends that part back and checks it again: fine. A review before the work is not.
    check(turns.findIndex((x) => x.includes('checker')) > turns.indexOf(both) && !turns.some((x) => x.includes('checker') && x.some((y) => y !== 'checker')), `the checker reviewed after the work came back (${turns.flat().filter((t) => t === 'checker').length} review${turns.flat().filter((t) => t === 'checker').length === 1 ? '' : 's'})`);
    check(turns.flat().every((t) => ['summariser-a', 'summariser-b', 'checker'].includes(t)), 'no agent outside the team ran');
    check(/tomato|compost|rose/i.test(text) && /oil|tyre|tire/i.test(text), 'the answer covers both notes');
    console.log(`\nspent: $${s.meta.cost.toFixed(4)} on ${model}`);
  }
  await c.close();
} finally {
  server.close();
  await h.close();
}
const failed = checks.filter((x) => !x.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
