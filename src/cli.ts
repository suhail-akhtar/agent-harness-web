import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent } from './core/types.ts';
import { createHarness } from './kernel/harness.ts';

// Headless runs: one prompt, streamed to the terminal, for scripts and benchmarks.
//   npm run cli -- --model deepseek-flash --runtime docker|local [--dir path] [--mode bypass] "task"

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
    case 'compaction': console.log(`\n[compaction] ${e.before} -> ${e.after} tokens`); break;
    case 'turn_end': if (!tag) console.log(`\n[turn end: ${e.reason}]`); break;
  }
}

async function main() {
  const prompt = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--')).join(' ');
  if (!prompt) { console.error('usage: npm run cli -- [--model id] [--runtime docker|local] [--dir path] [--mode default|acceptEdits|plan|bypass] "task"'); process.exit(2); }
  const dataDir = path.resolve(arg('data', path.join(os.tmpdir(), 'harness-cli'))!);
  const runtime = (arg('runtime', 'local') === 'docker' ? 'docker' : 'local') as 'docker' | 'local';
  const dir = arg('dir');
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const h = await createHarness({
    dataDir,
    plugins: [path.join(appRoot, 'plugins'), ...(process.env.HARNESS_PLUGINS || '').split(path.delimiter).filter(Boolean)],
    mcp: process.env.HARNESS_MCP_CONFIG || undefined,
  });
  const s = await h.sessions.create({
    model: arg('model', 'deepseek-flash')!,
    mode: (arg('mode', 'bypass') as 'bypass'),
    runtime: { kind: runtime, network: arg('network') === 'full' ? 'full' : 'none', ...(dir ? { path: path.resolve(dir) } : {}) },
  });
  console.log(`session ${s.meta.id} workspace ${s.workspace}`);
  const done = new Promise<void>((resolve) => {
    s.subscribe(0, ({ event }) => {
      printEvent(event);
      if (event.kind === 'permission_request') s.respond(event.requestId, { decision: 'allow' });
      if (event.kind === 'question') s.respond(event.requestId, { decision: 'answer', answer: 'Use your best judgement.' });
      if (event.kind === 'plan_proposed') s.respond(event.requestId, { decision: 'approve' });
      if (event.kind === 'turn_end' && !event.agent) resolve();
    });
  });
  await s.send(prompt);
  await done;
  const u = s.meta.usage;
  const total = u.input + u.cacheRead + u.cacheWrite;
  console.log(`\ntotal: $${s.meta.cost.toFixed(5)} | input ${total} (cache hit ${total ? Math.round((u.cacheRead / total) * 100) : 0}%) | output ${u.output}`);
  const spans = await s.readTrace();
  const models = spans.filter((x) => x.type === 'model');
  const tools = spans.filter((x) => x.type === 'tool');
  console.log(`trace: ${models.length} model calls (${Math.round(models.reduce((a, x) => a + x.ms, 0) / 1000)}s), ${tools.length} tool calls (${tools.filter((x) => x.type === 'tool' && x.error).length} errors)`);
  await h.close();
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
