// Evaluation: run a pack's cases on several models, several times, in fresh
// workspaces, and judge them with checks the agent never saw.
//
//   evals/<pack>/<case>/eval.json
//   {
//     "name": "url-shortener", "description": "...",
//     "workflow": "build-feature", "input": { "request": "..." },   // or "prompt": "..."
//     "fixtures": "fixtures",            // copied into the workspace first (optional)
//     "timeoutMin": 90,
//     "checks": [
//       { "name": "own tests pass", "run": "npm test" },             // exit 0 passes; {{case}} = this folder
//       { "name": "acceptance", "run": "bash {{case}}/acceptance.sh" },
//       { "name": "documents", "gates": ["documents-render"] },
//       { "name": "deliverables", "files": ["docs/requirements.md"] },
//       { "name": "plays", "playtest": "hidden-playtest.json" }        // a playtest file in this folder
//     ]
//   }

import fs from 'node:fs/promises';
import path from 'node:path';
import { runGates } from '../gates/gates.ts';
import type { Harness } from '../kernel/harness.ts';
import { createHarness } from '../kernel/harness.ts';
import { LocalHost } from '../runtime/host.ts';

export interface EvalCheck { name: string; run?: string; gates?: string[]; files?: string[]; playtest?: string; timeoutSec?: number }
export interface EvalCase {
  name: string; description?: string; dir: string; pack: string;
  workflow?: string; input?: Record<string, string>; prompt?: string;
  fixtures?: string; timeoutMin?: number; checks: EvalCheck[];
}
export interface CheckResult { name: string; pass: boolean; detail: string }
export interface EvalRun {
  pack: string; case: string; model: string; repeat: number;
  status: string; pass: boolean; checks: CheckResult[];
  cost: number; inputTokens: number; cacheHit: number; output: number; modelCalls: number; toolCalls: number; seconds: number;
  workspace: string; error?: string;
}

export async function loadCases(root: string, packs?: string[], only?: string[]): Promise<EvalCase[]> {
  const out: EvalCase[] = [];
  for (const pack of (await fs.readdir(root)).sort()) {
    if (packs?.length && !packs.includes(pack)) continue;
    const pdir = path.join(root, pack);
    if (!(await fs.stat(pdir)).isDirectory()) continue;
    for (const c of (await fs.readdir(pdir)).sort()) {
      const f = path.join(pdir, c, 'eval.json');
      const raw = await fs.readFile(f, 'utf8').catch(() => null);
      if (!raw) continue;
      const def = JSON.parse(raw) as Omit<EvalCase, 'dir' | 'pack'>;
      if (only?.length && !only.includes(def.name)) continue;
      if (!def.workflow && !def.prompt) throw new Error(`${f}: needs "workflow" or "prompt"`);
      if (!Array.isArray(def.checks) || !def.checks.length) throw new Error(`${f}: needs "checks"`);
      out.push({ ...def, dir: path.join(pdir, c), pack });
    }
  }
  return out;
}

export async function runChecks(h: Harness, c: EvalCase, ws: string, signal: AbortSignal): Promise<CheckResult[]> {
  const host = new LocalHost(ws);
  const results: CheckResult[] = [];
  for (const ch of c.checks) {
    try {
      if (ch.run) {
        const cmd = ch.run.replaceAll('{{case}}', c.dir).replaceAll('{{ws}}', ws);
        const r = await host.exec(cmd, { timeoutMs: (ch.timeoutSec ?? 300) * 1000, signal });
        const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join('\n');
        results.push({ name: ch.name, pass: r.code === 0 && !r.timedOut, detail: r.timedOut ? 'timed out' : `exit ${r.code}${out ? `: ${out.slice(-600)}` : ''}` });
      } else if (ch.gates) {
        const gs = await runGates(h.registry, host, ch.gates, signal);
        const missing = ch.gates.filter((n) => !gs.some((g) => g.name === n));
        const bad = gs.filter((g) => !g.pass);
        results.push({ name: ch.name, pass: !bad.length && !missing.length, detail: [...gs.map((g) => `${g.pass ? 'PASS' : 'FAIL'} ${g.name}: ${g.summary}${g.pass ? '' : ` ${(g.details ?? '').slice(0, 400)}`}`), ...missing.map((m) => `gate ${m} not registered`)].join('\n') });
      } else if (ch.files) {
        const absent: string[] = [];
        for (const f of ch.files) if (!(await fs.stat(path.join(ws, f)).then((s) => s.size > 0, () => false))) absent.push(f);
        results.push({ name: ch.name, pass: !absent.length, detail: absent.length ? `missing or empty: ${absent.join(', ')}` : `${ch.files.length} file(s) present` });
      } else if (ch.playtest) {
        // Hidden scenarios: the agent never saw them; they run against its workspace.
        // @ts-expect-error plain JS module
        const { runPlaytests } = await import('../../plugins/visual/index.mjs');
        const spec = JSON.parse(await fs.readFile(path.join(c.dir, ch.playtest), 'utf8'));
        const rs = await runPlaytests(ws, signal, undefined, spec) as { name: string; pass: boolean; failures: string[] }[];
        const failed = rs.filter((r) => !r.pass);
        results.push({ name: ch.name, pass: rs.length > 0 && !failed.length, detail: `${rs.length - failed.length}/${rs.length} scenarios${failed.length ? `\n${failed.map((f) => `${f.name}: ${f.failures.join('; ')}`).join('\n').slice(0, 800)}` : ''}` });
      } else {
        results.push({ name: ch.name, pass: false, detail: 'check has no run, gates, files or playtest' });
      }
    } catch (e) {
      results.push({ name: ch.name, pass: false, detail: `check failed to run: ${(e as Error).message}` });
    }
  }
  return results;
}

/** One case, one model, one repeat, in its own data folder and workspace. */
export async function runOne(c: EvalCase, model: string, repeat: number, out: string, opts: { plugins: string[]; shipped?: string[]; log?: (s: string) => void; setup?: (h: Harness) => void }): Promise<EvalRun> {
  const base = path.join(out, `${c.pack}-${c.name}-${model}-${repeat}`);
  const ws = path.join(base, 'ws');
  await fs.mkdir(ws, { recursive: true });
  if (c.fixtures) await fs.cp(path.join(c.dir, c.fixtures), ws, { recursive: true });
  const t0 = Date.now();
  const h = await createHarness({ dataDir: path.join(base, 'data'), plugins: opts.plugins, shippedPlugins: opts.shipped });
  opts.setup?.(h);
  const run: EvalRun = { pack: c.pack, case: c.name, model, repeat, status: 'error', pass: false, checks: [], cost: 0, inputTokens: 0, cacheHit: 0, output: 0, modelCalls: 0, toolCalls: 0, seconds: 0, workspace: ws };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (c.timeoutMin ?? 90) * 60_000);
  try {
    const s = await h.sessions.create({ model, mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const done = new Promise<void>((resolve) => {
      s.subscribe(0, ({ event }) => {
        if (event.kind === 'permission_request') s.respond(event.requestId, { decision: 'allow' });
        if (event.kind === 'question') s.respond(event.requestId, { decision: 'answer', answer: 'Use your best judgement.' });
        if (event.kind === 'plan_proposed' || event.kind === 'approval_request') s.respond(event.requestId, { decision: 'approve' });
        if (event.kind === 'turn_end' && !event.agent) resolve();
      });
    });
    ac.signal.addEventListener('abort', () => s.abort(), { once: true });
    if (c.workflow) await s.startWorkflow(c.workflow, { approval: 'auto', ...(c.input ?? {}) });
    else await s.send(c.prompt!);
    await done;
    const runs = await s.listRuns();
    run.status = c.workflow ? (runs[0]?.status ?? 'unknown') : (ac.signal.aborted ? 'timeout' : 'done');
    if (ac.signal.aborted) run.status = 'timeout';
    const u = s.meta.usage;
    run.inputTokens = u.input + u.cacheRead + u.cacheWrite;
    run.cacheHit = run.inputTokens ? u.cacheRead / run.inputTokens : 0;
    run.output = u.output;
    run.cost = s.meta.cost;
    const spans = await s.readTrace();
    run.modelCalls = spans.filter((x) => x.type === 'model').length;
    run.toolCalls = spans.filter((x) => x.type === 'tool').length;
    run.checks = await runChecks(h, c, ws, new AbortController().signal);
    run.pass = ['succeeded', 'done'].includes(run.status) && run.checks.every((x) => x.pass);
  } catch (e) {
    run.error = (e as Error).message;
  } finally {
    clearTimeout(timer);
    run.seconds = Math.round((Date.now() - t0) / 1000);
    await h.close();
  }
  opts.log?.(`${run.pass ? 'PASS' : 'FAIL'} ${c.pack}/${c.name} ${model} #${repeat}: ${run.status}, ${run.checks.filter((x) => x.pass).length}/${run.checks.length} checks, $${run.cost.toFixed(4)}, ${run.seconds}s`);
  await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(run, null, 1));
  return run;
}

/** Runs jobs with at most `n` at once. */
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i]!(); }
  }));
  return out;
}

export async function runEvals(opts: { cases: EvalCase[]; models: string[]; repeats: number; out: string; concurrency: number; plugins: string[]; shipped?: string[]; log?: (s: string) => void; setup?: (h: Harness) => void }): Promise<EvalRun[]> {
  const jobs = opts.cases.flatMap((c) => opts.models.flatMap((m) => Array.from({ length: opts.repeats }, (_, r) => () => runOne(c, m, r + 1, opts.out, opts))));
  const runs = await pool(jobs, opts.concurrency);
  await fs.writeFile(path.join(opts.out, 'results.json'), JSON.stringify(runs, null, 1));
  await fs.writeFile(path.join(opts.out, 'report.md'), report(runs));
  return runs;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

export function report(runs: EvalRun[]): string {
  const lines = ['# Evaluation report', '', `${runs.length} run(s), ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  lines.push('| Case | Model | Pass | Checks passed | Median cost | Median time | Cache hit | Calls |', '|---|---|---|---|---|---|---|---|');
  const groups = new Map<string, EvalRun[]>();
  for (const r of runs) { const k = `${r.pack}/${r.case}|${r.model}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [k, rs] of groups) {
    const [c, m] = k.split('|');
    const checks = rs.reduce((a, r) => a + r.checks.filter((x) => x.pass).length, 0);
    const total = rs.reduce((a, r) => a + r.checks.length, 0);
    lines.push(`| ${c} | ${m} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${checks}/${total} | $${median(rs.map((r) => r.cost)).toFixed(3)} | ${Math.round(median(rs.map((r) => r.seconds)) / 60)} min | ${pct(median(rs.map((r) => r.cacheHit)))} | ${median(rs.map((r) => r.modelCalls))} |`);
  }
  lines.push('', '## Failed checks', '');
  const failed = runs.filter((r) => !r.pass);
  if (!failed.length) lines.push('None.');
  for (const r of failed) {
    lines.push(`- **${r.pack}/${r.case} ${r.model} #${r.repeat}** (${r.status}${r.error ? `: ${r.error}` : ''})`);
    for (const ch of r.checks.filter((x) => !x.pass)) lines.push(`  - ${ch.name}: ${ch.detail.replace(/\n/g, ' | ').slice(0, 400)}`);
  }
  return lines.join('\n') + '\n';
}
