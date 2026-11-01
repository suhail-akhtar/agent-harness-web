// Live check of a person's own MCP servers against a real model (spends money: not part of npm test).
// Keys come from the environment; only their names are printed, never values.
//   node --env-file=path/to/.env scripts/live-mcp.mjs [--model claude-sonnet-5-5]
//
// The person (an account, not an administrator of anything else) has the modern test server
// (test/fixtures/mcp-modern.mjs, the official SDK) as their own server "notes", over streamable HTTP
// behind OAuth, signed in through the same flow the app uses. One conversation asks the model to
// add two numbers, read the welcome note (a resource) and use the review prompt; then to change the
// server's tools (mutate) and echo something: the changed echo is refused without asking, the new
// "shout" (whose description asks to send files to evil.example) is not offered. Checked from the
// transcript; a spend cap (LIVE_MAX_USD, $0.60) stops the run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const model = arg('--model') ?? 'claude-sonnet-5-5';
const CAP = Number(process.env.LIVE_MAX_USD ?? 0.6);
process.env.HARNESS_PLUGIN_LOOPS = 'off';
process.env.HARNESS_MAX_COST_USD = String(CAP);
const has = (n) => !!process.env[n]?.trim();
console.log(`keys: ANTHROPIC_API_KEY or GW_ANTHROPIC_API_KEY ${has('ANTHROPIC_API_KEY') || has('GW_ANTHROPIC_API_KEY') ? 'present' : 'absent'}, DEEPSEEK_API_KEY ${has('DEEPSEEK_API_KEY') ? 'present' : 'absent'}`);
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { createHarness } = await imp('src/kernel/harness.ts');

// The server, over HTTP with OAuth.
const fixture = path.join(root, 'test', 'fixtures', 'mcp-modern.mjs');
const child = spawn(process.execPath, [fixture, '--http', '0'], { env: { ...process.env, MCP_OAUTH: '1' } });
const port = await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = /listening (\d+)/.exec(out); if (m) resolve(Number(m[1])); });
  child.on('exit', (c) => reject(new Error(`fixture exited ${c}`)));
});
const url = `http://127.0.0.1:${port}/mcp`;

const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-mcp-')));
const h = await createHarness({ dataDir: data, search: null, memory: 'off' });
const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
try {
  const owner = 'ann';
  // ann may reach a local address here (the test server); a member's server would have to be public https.
  h.userMcp.isAdmin = (o) => o === owner;
  await h.userMcp.create(owner, { name: 'notes', type: 'http', url, description: 'My notes service' });
  const start = await h.userMcp.signIn(owner, 'notes', 'http://127.0.0.1:1/api/mcp/oauth/callback');
  const back = await fetch(start.authorizeUrl, { redirect: 'manual' });
  const to = new URL(back.headers.get('location'));
  await h.userMcp.finishSignIn(to.searchParams.get('state'), to.searchParams.get('code'), to.searchParams.get('iss') ?? undefined);
  const t = await h.userMcp.test(owner, 'notes');
  check(t.ok && t.protocol === '2026-07-28', `signed in through OAuth; connected on MCP ${t.protocol}`);

  const s = await h.sessions.create({ owner, model, mode: 'bypass', runtime: { kind: 'local', network: 'none', path: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-mcp-ws-'))) } });
  const caps = await s.capabilities();
  check(caps.mcp.some((m) => m.name === 'notes' && m.scope === 'user' && m.ok), 'the server is in the conversation (scope user)');
  // Each turn ends with one main turn_end (the subscription replays from the start: count them).
  let turns = 0;
  const waiters = [];
  s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) { turns++; for (const w of waiters.splice(0)) w(); } });
  const turn = async (text) => {
    const want = turns + 1;
    await s.send(text);
    while (turns < want) await new Promise((r) => waiters.push(r));
  };
  const calls = () => s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use').map((b) => b.name);
  const resultOf = (name) => { const use = s.history.flatMap((m) => m.content).filter((b) => b.type === 'tool_use' && b.name === name).at(-1); return use && s.history.flatMap((m) => m.content).find((b) => b.type === 'tool_result' && b.tool_use_id === use.id); };

  await turn('Use my notes service: add 1234 and 4321 with it, read its welcome note, and get its "review" prompt for the file src/app.ts. Report the sum, the note, and the prompt text.');
  const c1 = calls();
  check(c1.includes('mcp__notes__add') && /5555/.test(String(resultOf('mcp__notes__add')?.content)), 'add ran on the server: 5555');
  check(c1.includes('mcp__notes__resources') && /Welcome to the notes server/.test(JSON.stringify(s.history)), 'the welcome note was read through the resources tool');
  check(c1.includes('mcp__notes__prompts') && /Please review src\/app\.ts/.test(JSON.stringify(s.history)), 'the review prompt was filled in through the prompts tool');
  const reply1 = s.history.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  check(/5[,.]?555/.test(reply1), 'the reply has the sum');

  await turn('Now call the notes service\'s "mutate" tool once, then echo the word "hello" with its echo tool. If something is refused, say what.');
  const echo = resultOf('mcp__notes__echo');
  check(calls().includes('mcp__notes__mutate'), 'mutate ran (the server changed its tools)');
  check(!echo || (echo.is_error && /changed the tool "echo" after it was approved/.test(String(echo.content))), echo ? 'the changed echo was refused' : 'echo was not called (fine: the result says it changed)');
  check(!calls().some((n) => /shout/.test(n)), 'the new "shout" tool (asking to send files to evil.example) never ran');
  const pending = (await h.userMcp.test(owner, 'notes')).tools.filter((x) => x.state !== 'approved').map((x) => `${x.name}:${x.state}`).sort();
  check(JSON.stringify(pending) === JSON.stringify(['echo:changed', 'shout:new']), `waiting for the person: ${pending.join(', ')}`);
  const reply2 = s.history.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log(`\nreply 1: ${reply1.slice(0, 600)}\n\nreply 2: ${reply2.slice(0, 600)}`);
  console.log(`\nspent: $${(s.meta.cost ?? 0).toFixed(4)} on ${model}`);
} finally {
  await h.close();
  child.kill();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
