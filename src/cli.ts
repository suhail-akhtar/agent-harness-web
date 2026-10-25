import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SessionMeta } from './core/session.ts';
import type { HarnessEvent, Message, TurnEndReason } from './core/types.ts';
import { firstLine } from './graph/runner.ts';
import { createHarness } from './kernel/harness.ts';
import { ensureHome, harnessPaths } from './util/home.ts';

// Headless runs: one prompt, streamed to the terminal, for scripts and benchmarks.
//   npm run cli -- --model deepseek-flash --runtime docker|local [--image allowed-image] [--dir path] [--mode bypass] "task"
//   npm run cli -- --data dir --session <id> --resume <runId>

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

export function printEvent(e: HarnessEvent, quiet = false): void {
  const tag = 'agent' in e && e.agent && e.agent !== 'main' ? `[${e.agent}] ` : '';
  switch (e.kind) {
    case 'text_delta': if (!quiet && !tag) process.stdout.write(e.text); break;
    case 'tool_call': console.log(`\n${tag}> ${e.name} ${JSON.stringify(e.input).slice(0, 160)}`); break;
    case 'tool_result': if (!quiet) console.log(`${tag}  ${e.is_error ? 'ERROR ' : ''}${e.content.split('\n').slice(0, 3).join(' | ').slice(0, 200)} (${e.ms}ms)`); break;
    case 'usage': console.log(`\n${tag}  [${e.model}] in=${e.usage.input} cache_read=${e.usage.cacheRead} cache_write=${e.usage.cacheWrite} out=${e.usage.output} ctx=${e.contextTokens} $${e.cost.toFixed(5)}`); break;
    case 'notice': console.log(`\n${tag}[${e.level}] ${e.text}`); break;
    case 'retry': console.log(`\n[retry ${e.attempt} in ${e.delayMs}ms] ${e.reason}`); break;
    case 'progress': console.log(`\n${tag}[progress ${e.phase}] ${e.text}`); break;
    case 'compaction': console.log(`\n[compaction] ${e.before} -> ${e.after} tokens`); break;
    case 'turn_end': if (!tag) console.log(`\n[turn end: ${e.reason}]`); break;
    case 'workflow':
      if (e.phase === 'node_started') console.log(`\n=== [workflow] ${e.node} started`);
      if (e.phase === 'node_finished') { const h = [...e.run.history].reverse().find((x) => x.node === e.node); console.log(`=== [workflow] ${e.node} ${h?.status}${h?.outcome ? ` -> ${h.outcome}` : ''}: ${firstLine(h?.summary ?? '')} ($${(h?.cost ?? 0).toFixed(4)})`); }
      if (e.phase === 'finished') console.log(`\n=== [workflow] ${e.run.workflow} ${e.run.status}${e.run.error ? `: ${e.run.error}` : ''} ($${e.run.cost.toFixed(4)})`);
      break;
  }
}

/**
 * The process's exit code for how the run ended, so a script or CI step can tell
 * "finished" from "stopped by a limit" without parsing output. 2 is a usage error.
 */
export const EXIT_CODES: Record<TurnEndReason, number> = { done: 0, error: 1, max_steps: 3, budget: 4, time: 5, refusal: 6, max_tokens: 7, aborted: 130 };

/** What --output json prints: one object, after the run. */
export function headlessResult(s: { meta: SessionMeta; history: Message[] }, reason: TurnEndReason, spans: { type: string }[], error?: string) {
  const u = s.meta.usage;
  const input = u.input + u.cacheRead + u.cacheWrite;
  const last = [...s.history].reverse().find((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'text'));
  return {
    reason, exitCode: EXIT_CODES[reason] ?? 1,
    text: last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() ?? '',
    sessionId: s.meta.id,
    cost: Number(s.meta.cost.toFixed(6)),
    tokens: { input, uncached: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: u.output },
    cacheHit: input ? Number((u.cacheRead / input).toFixed(4)) : 0,
    modelCalls: spans.filter((x) => x.type === 'model').length,
    toolCalls: spans.filter((x) => x.type === 'tool').length,
    ...(error ? { error } : {}),
  };
}

async function main() {
  const prompt = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).join(' ');
  const workflow = arg('workflow');
  const json = arg('output') === 'json';
  if (!prompt && !workflow && !arg('resume')) { console.error('usage: npm run cli -- [--model id] [--runtime docker|local] [--dir path] [--mode default|acceptEdits|auto|dontAsk|plan|bypass] [--max-steps n] [--max-cost usd] [--max-minutes n] [--output text|json] "task"'); process.exit(2); }
  // Limits from flags, read where every session's settings are (an operator settings file still wins).
  for (const [flag, env] of [['max-steps', 'HARNESS_MAX_STEPS'], ['max-cost', 'HARNESS_MAX_COST_USD'], ['max-minutes', 'HARNESS_MAX_TURN_MINUTES']] as const) {
    const v = arg(flag);
    if (v === undefined) continue;
    if (!Number.isFinite(Number(v)) || Number(v) < 0) { console.error(`--${flag} needs a number`); process.exit(2); }
    process.env[env] = v;
  }
  // With --output json, stdout carries only the result object; progress goes to stderr.
  const log = json ? (...a: unknown[]) => console.error(...a) : (...a: unknown[]) => console.log(...a);
  // The same home as the server and the app (~/.harness, or HARNESS_HOME): its data unless --data or HARNESS_DATA says otherwise;
  // without --dir a run works in a folder of its own under the home's tmp/ (cleaned after some days), never in the server's data.
  const paths = harnessPaths();
  ensureHome(paths.layout);
  const dataDir = path.resolve(arg('data', paths.dataDir)!);
  const runtime = (arg('runtime', 'local') === 'docker' ? 'docker' : 'local') as 'docker' | 'local';
  const dir = arg('dir') ?? (arg('runtime', 'local') === 'local' && !arg('session') ? path.join(paths.layout.tmp, `cli-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${process.pid}`) : undefined);
  if (dir && !arg('dir')) fs.mkdirSync(dir, { recursive: true });
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const h = await createHarness({
    dataDir,
    // One job, then the process ends: its sandbox container goes too.
    releaseHosts: true,
    plugins: [path.join(appRoot, 'plugins'), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)],
    shippedPlugins: [path.join(appRoot, 'plugins')],
    installDir: paths.installDir,
    mcp: process.env.HARNESS_MCP_CONFIG || undefined,
    // One task from the command line: no plugin loops (an alert watch loop) alongside it.
    backgroundWork: false,
  });
  // --resume <runId> --session <id> continues a stopped workflow run from the step it was in.
  const resume = arg('resume');
  const existing = arg('session');
  const s = existing ? h.sessions.get(existing) : await h.sessions.create({
    model: arg('model', 'deepseek-flash')!,
    mode: (arg('mode', 'bypass') as 'bypass'),
    runtime: { kind: runtime, network: arg('network') === 'full' ? 'full' : 'none', ...(dir ? { path: path.resolve(dir) } : {}), ...(runtime === 'docker' && arg('image') ? { image: arg('image') } : {}) },
  });
  if (!s) { console.error(`no session ${existing} in ${dataDir}`); process.exit(2); }
  log(`session ${s.meta.id} workspace ${s.workspace}`);
  let reason = 'done' as TurnEndReason;
  let lastError: string | undefined;
  const done = new Promise<void>((resolve) => {
    s.subscribe(0, ({ event }) => {
      if (!json) printEvent(event);
      if (event.kind === 'notice' && event.level === 'error' && !event.agent) lastError = event.text;
      if (event.kind === 'turn_end' && !event.agent) reason = event.reason;
      if (event.kind === 'permission_request') s.respond(event.requestId, { decision: 'allow' });
      if (event.kind === 'question') s.respond(event.requestId, { decision: 'answer', answer: 'Use your best judgement.' });
      if (event.kind === 'plan_proposed') s.respond(event.requestId, { decision: 'approve' });
      if (event.kind === 'approval_request') { log(`\n[approval] ${event.title}: auto-approved (headless)`); s.respond(event.requestId, { decision: 'approve' }); }
      if (event.kind === 'turn_end' && !event.agent) resolve();
    });
  });
  if (resume) {
    await s.resumeRun(resume);
  } else if (workflow) {
    // --input key=value (repeatable); the prompt text, if any, becomes input.request.
    const input: Record<string, string> = {};
    process.argv.forEach((a, i) => { if (a === '--input') { const [k, ...v] = (process.argv[i + 1] ?? '').split('='); if (k) input[k] = v.join('='); } });
    if (prompt && !input.request) input.request = prompt;
    await s.startWorkflow(workflow, input);
  } else {
    await s.send(prompt);
  }
  await done;
  const spans = await s.readTrace();
  if (json) {
    const result = headlessResult(s, reason, spans, reason === 'error' ? lastError : undefined);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    await h.close();
    process.exit(result.exitCode);
  }
  const u = s.meta.usage;
  const total = u.input + u.cacheRead + u.cacheWrite;
  console.log(`\ntotal: $${s.meta.cost.toFixed(5)} | input ${total} (cache hit ${total ? Math.round((u.cacheRead / total) * 100) : 0}%) | output ${u.output}`);
  const models = spans.filter((x) => x.type === 'model');
  const tools = spans.filter((x) => x.type === 'tool');
  const byAgent = new Map<string, { calls: number; cost: number }>();
  for (const m of models) { const b = byAgent.get(m.agent) ?? { calls: 0, cost: 0 }; b.calls++; b.cost += m.cost; byAgent.set(m.agent, b); }
  if (byAgent.size > 1) console.log(`per agent: ${[...byAgent].map(([a, b]) => `${a} ${b.calls} calls $${b.cost.toFixed(4)}`).join(' | ')}`);
  console.log(`trace: ${models.length} model calls (${Math.round(models.reduce((a, x) => a + x.ms, 0) / 1000)}s), ${tools.length} tool calls (${tools.filter((x) => x.type === 'tool' && x.error).length} errors)`);
  await h.close();
  process.exitCode = EXIT_CODES[reason] ?? 1;
}

// pathToFileURL: on Windows the module URL is file:///C:/..., never file://C:\...
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    if (arg('output') === 'json') process.stdout.write(`${JSON.stringify({ reason: 'error', exitCode: 1, error: (e as Error).message ?? String(e) })}\n`);
    else console.error(e);
    process.exit(1);
  });
}
