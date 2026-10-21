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
//       { "name": "acceptance", "run": "bash {{case}}/acceptance.sh {{ws}} {{port}}" }, // {{port}}: a free port
//       { "name": "documents", "gates": ["documents-render"] },
//       { "name": "deliverables", "files": ["docs/requirements.md"] },
//       { "name": "plays", "playtest": "hidden-playtest.json" }        // a playtest file in this folder
//     ],
//     "setup": "node {{case}}/../stack/stack.mjs reset",   // optional: before the agent starts (a failure skips the run)
//     "teardown": "node {{case}}/../stack/stack.mjs down"  // optional: after the checks, pass or fail
//   }

import fs from 'node:fs/promises';
import path from 'node:path';
import { runGates } from '../gates/gates.ts';
import type { Harness } from '../kernel/harness.ts';
import { createHarness } from '../kernel/harness.ts';
import { LocalHost, run } from '../runtime/host.ts';
import { defaultSettings } from '../core/settings.ts';
import { fileURLToPath } from 'node:url';
import type { ToolServices } from '../tools/types.ts';
import type { Effort } from '../core/models.ts';
import { findPluginDirs } from '../plugins/loader.ts';

/**
 * A named harness configuration: the same model runs under each, so the report can
 * separate the harness's effect from the model's (an ablation). Everything here is
 * an operator setting a real deployment can use: settings go through an operator
 * settings file (HARNESS_SETTINGS), switches through their HARNESS_* variables.
 */
export interface HarnessConfig {
  name: string;
  description?: string;
  /** Operator settings for this configuration, over HARNESS_SETTINGS if one is set. */
  settings?: { maxSteps?: number; maxCostUsd?: number; compactAt?: number; subagentModel?: string; autoModel?: string; maxSubagentDepth?: number; maxParallelSubagents?: number; gatesOnStop?: boolean };
  /** false: no run_script tool (code mode off). */
  codeMode?: boolean;
  /** Only these plugins (folder names under the plugin roots); default: all of them. */
  plugins?: string[];
  /** The session's reasoning effort. */
  effort?: Effort;
  /** The prompt-injection scan of outside content (HARNESS_INJECTION_SCAN). */
  injectionScan?: boolean;
  /** Memory across sessions. */
  memory?: 'on' | 'read' | 'off';
  /** Tools taken out of the harness for this configuration. */
  disableTools?: string[];
  /** Other HARNESS_* variables while this configuration's runs go. */
  env?: Record<string, string>;
}

const CONFIG_KEYS = ['name', 'description', 'settings', 'codeMode', 'plugins', 'effort', 'injectionScan', 'memory', 'disableTools', 'env'];
const SETTING_KEYS: Record<string, 'number' | 'string' | 'boolean'> = { maxSteps: 'number', maxCostUsd: 'number', compactAt: 'number', subagentModel: 'string', autoModel: 'string', maxSubagentDepth: 'number', maxParallelSubagents: 'number', gatesOnStop: 'boolean' };

/** Checks configurations (a list, or { "configs": [...] }); throws naming the configuration and the field. */
export function parseConfigs(raw: unknown): HarnessConfig[] {
  const list = Array.isArray(raw) ? raw : (raw as { configs?: unknown })?.configs;
  if (!Array.isArray(list) || !list.length) throw new Error('configs: expected a list of configurations, or { "configs": [...] }');
  const seen = new Set<string>();
  return list.map((c, i) => {
    const at = `config ${typeof c?.name === 'string' ? `"${c.name}"` : `#${i + 1}`}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`configs: ${at} must be an object`);
    const x = c as HarnessConfig & Record<string, unknown>;
    if (typeof x.name !== 'string' || !/^[a-zA-Z0-9][\w.-]{0,39}$/.test(x.name)) throw new Error(`configs: ${at} needs a name (letters, digits, . _ -)`);
    if (seen.has(x.name)) throw new Error(`configs: ${at} appears twice`);
    seen.add(x.name);
    const unknown = Object.keys(x).filter((k) => !CONFIG_KEYS.includes(k));
    if (unknown.length) throw new Error(`configs: ${at}: unknown field(s) ${unknown.join(', ')} (known: ${CONFIG_KEYS.join(', ')})`);
    for (const [k, v] of Object.entries(x.settings ?? {})) {
      if (!SETTING_KEYS[k]) throw new Error(`configs: ${at}: settings.${k} is not a setting a configuration can change (${Object.keys(SETTING_KEYS).join(', ')})`);
      if (typeof v !== SETTING_KEYS[k]) throw new Error(`configs: ${at}: settings.${k} must be a ${SETTING_KEYS[k]}`);
    }
    if (x.codeMode !== undefined && typeof x.codeMode !== 'boolean') throw new Error(`configs: ${at}: codeMode must be true or false`);
    if (x.injectionScan !== undefined && typeof x.injectionScan !== 'boolean') throw new Error(`configs: ${at}: injectionScan must be true or false`);
    if (x.memory !== undefined && !['on', 'read', 'off'].includes(x.memory)) throw new Error(`configs: ${at}: memory must be on, read or off`);
    if (x.effort !== undefined && typeof x.effort !== 'string') throw new Error(`configs: ${at}: effort must be a string such as "high"`);
    for (const k of ['plugins', 'disableTools'] as const) if (x[k] !== undefined && !(Array.isArray(x[k]) && x[k]!.every((p) => typeof p === 'string'))) throw new Error(`configs: ${at}: ${k} must be a list of names`);
    for (const [k, v] of Object.entries(x.env ?? {})) if (!/^HARNESS_[A-Z0-9_]+$/.test(k) || typeof v !== 'string') throw new Error(`configs: ${at}: env.${k}: only HARNESS_* variables, as strings`);
    return x;
  });
}

/** --config name or --config 'name={"settings":{"compactAt":60000}}' */
export function parseInlineConfig(arg: string): HarnessConfig {
  const eq = arg.indexOf('=');
  if (eq < 0) return parseConfigs([{ name: arg.trim() }])[0]!;
  let body: unknown;
  try { body = JSON.parse(arg.slice(eq + 1)); } catch (e) { throw new Error(`--config ${arg.slice(0, eq)}: the part after = must be a JSON object (${(e as Error).message})`); }
  return parseConfigs([{ ...(body as object), name: arg.slice(0, eq).trim() }])[0]!;
}

/** One line saying what a configuration changes. */
export function describeConfig(c: HarnessConfig): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(c.settings ?? {})) parts.push(`${k} ${v}`);
  if (c.codeMode === false) parts.push('code mode off');
  if (c.codeMode === true) parts.push('code mode on');
  if (c.plugins) parts.push(`plugins ${c.plugins.join(' + ') || 'none'}`);
  if (c.effort) parts.push(`effort ${c.effort}`);
  if (c.injectionScan !== undefined) parts.push(`injection scan ${c.injectionScan ? 'on' : 'off'}`);
  if (c.memory) parts.push(`memory ${c.memory}`);
  if (c.disableTools?.length) parts.push(`without ${c.disableTools.join(', ')}`);
  for (const [k, v] of Object.entries(c.env ?? {})) parts.push(`${k}=${v}`);
  return `${parts.join(', ') || 'harness defaults'}${c.description ? ` - ${c.description}` : ''}`;
}

/** The plugin folders a configuration loads: all of them, or only the ones it names (each must exist). */
async function configPlugins(roots: string[], c?: HarnessConfig): Promise<string[]> {
  if (!c?.plugins) return roots;
  const dirs = (await Promise.all(roots.map((r) => findPluginDirs(path.resolve(r))))).flat();
  const missing = c.plugins.filter((n) => !dirs.some((d) => path.basename(d) === n));
  if (missing.length) throw new Error(`config "${c.name}": no plugin named ${missing.join(', ')} (have: ${dirs.map((d) => path.basename(d)).join(', ')})`);
  return dirs.filter((d) => c.plugins!.includes(path.basename(d)));
}

/**
 * Sets the process environment a configuration needs (an operator settings file, its
 * HARNESS_* switches) and returns how to put it back. Configurations therefore run one
 * after another; the runs inside one still run in parallel.
 */
async function enterConfig(c: HarnessConfig, out: string): Promise<() => void> {
  const env: Record<string, string> = { ...(c.env ?? {}) };
  if (c.injectionScan !== undefined) env.HARNESS_INJECTION_SCAN = c.injectionScan ? 'on' : 'off';
  if (c.settings && Object.keys(c.settings).length) {
    const base = process.env.HARNESS_SETTINGS ? JSON.parse(await fs.readFile(process.env.HARNESS_SETTINGS, 'utf8')) as Record<string, unknown> : {};
    const file = path.join(out, `config-${c.name}.settings.json`);
    await fs.writeFile(file, JSON.stringify({ ...base, ...c.settings }, null, 1));
    env.HARNESS_SETTINGS = file;
  }
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  return () => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

export interface EvalCheck { name: string; run?: string; gates?: string[]; files?: string[]; playtest?: string; timeoutSec?: number }
export interface EvalCase {
  name: string; description?: string; dir: string; pack: string;
  workflow?: string; input?: Record<string, string>; prompt?: string;
  fixtures?: string; timeoutMin?: number; checks: EvalCheck[];
  /** A command run before the agent starts (bring up a test environment); a failure skips the run. */
  setup?: string;
  /** A command run after the checks, whatever happened. */
  teardown?: string;
}
export interface CheckResult { name: string; pass: boolean; detail: string }
export interface EvalRun {
  pack: string; case: string; model: string; repeat: number;
  /** The harness configuration it ran under (absent: the harness as configured, no ablation). */
  config?: string;
  status: string; pass: boolean; checks: CheckResult[];
  cost: number; inputTokens: number; cacheHit: number; output: number; modelCalls: number; toolCalls: number; seconds: number;
  workspace: string; error?: string;
  /** The run stopped on the provider's side (credits, a key, an outage), not the model's or the harness's: not counted. */
  unscored?: boolean;
}

/** A provider's own failure (billing, authentication, an outage), as opposed to the agent failing the task. */
export function providerProblem(texts: (string | undefined)[]): string | undefined {
  const re = /no credits|insufficient[_ ]quota|exceeded your current quota|billing|credit balance is too low|invalid[_ ]?api[_ ]?key|incorrect api key|authentication|unauthori[sz]ed|\b40[13]\b|overloaded|\b5(02|03|29)\b|service unavailable/i;
  return texts.find((t) => !!t && re.test(t))?.slice(0, 300);
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

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as { port: number }).port; srv.close(() => resolve(port)); });
  });
}

/**
 * A case's command with {{case}}, {{ws}} and {{port}} filled in. Paths go into a shell command:
 * forward slashes (bash on Windows eats backslashes) and quoted (spaces) together with what
 * follows them ({{case}}/check.mjs is one word), in the quoting of the shell that runs it
 * (PowerShell doubles a quote; bash closes and reopens). {{port}}: a free port for this
 * command, so runs in parallel never collide.
 */
async function caseCommand(host: LocalHost, c: EvalCase, ws: string, cmd: string): Promise<string> {
  const quote = (s: string) => host.shell === 'powershell' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
  const fill = (s: string, token: string, p: string) => s.replace(new RegExp(`\\{\\{${token}\\}\\}([^\\s'"|;&<>()]*)`, 'g'), (_m, rest: string) => quote(p.split(path.sep).join('/') + rest));
  return fill(fill(cmd, 'case', c.dir), 'ws', ws).replaceAll('{{port}}', String(await freePort()));
}

/** A case's setup or teardown command; throws with its output when it fails. */
async function caseStep(c: EvalCase, ws: string, which: 'setup' | 'teardown'): Promise<void> {
  const host = new LocalHost(ws);
  const r = await host.exec(await caseCommand(host, c, ws, c[which]!), { timeoutMs: 15 * 60_000 });
  if (r.code !== 0 || r.timedOut) throw new Error(`${which} ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${`${r.stdout}\n${r.stderr}`.trim().slice(-600)}`);
}

export async function runChecks(h: Harness, c: EvalCase, ws: string, signal: AbortSignal, services?: ToolServices): Promise<CheckResult[]> {
  const host = new LocalHost(ws);
  const results: CheckResult[] = [];
  for (const ch of c.checks) {
    try {
      if (ch.run) {
        const cmd = await caseCommand(host, c, ws, ch.run);
        const r = await host.exec(cmd, { timeoutMs: (ch.timeoutSec ?? 300) * 1000, signal });
        const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-6).join('\n');
        results.push({ name: ch.name, pass: r.code === 0 && !r.timedOut, detail: r.timedOut ? 'timed out' : `exit ${r.code}${out ? `: ${out.slice(-600)}` : ''}` });
      } else if (ch.gates) {
        const gs = await runGates(h.registry, host, ch.gates, signal, services);
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
export async function runOne(c: EvalCase, model: string, repeat: number, out: string, opts: { plugins: string[]; shipped?: string[]; log?: (s: string) => void; setup?: (h: Harness, config?: HarnessConfig) => void; config?: HarnessConfig }): Promise<EvalRun> {
  const cfg = opts.config;
  const base = path.join(out, `${c.pack}-${c.name}${cfg ? `-${cfg.name}` : ''}-${model}-${repeat}`);
  const ws = path.join(base, 'ws');
  await fs.mkdir(ws, { recursive: true });
  if (c.fixtures) await fs.cp(path.join(c.dir, c.fixtures), ws, { recursive: true });
  const t0 = Date.now();
  if (c.setup) {
    try { await caseStep(c, ws, 'setup'); } catch (e) {
      const failed: EvalRun = { pack: c.pack, case: c.name, model, repeat, ...(cfg ? { config: cfg.name } : {}), status: 'setup-failed', pass: false, checks: [], cost: 0, inputTokens: 0, cacheHit: 0, output: 0, modelCalls: 0, toolCalls: 0, seconds: Math.round((Date.now() - t0) / 1000), workspace: ws, error: (e as Error).message };
      opts.log?.(`FAIL ${c.pack}/${c.name} ${model} #${repeat}: ${failed.error}`);
      await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(failed, null, 1));
      return failed;
    }
  }
  const h = await createHarness({ dataDir: path.join(base, 'data'), plugins: await configPlugins(opts.plugins, cfg), shippedPlugins: opts.shipped, ...(cfg?.memory ? { memory: cfg.memory } : {}) });
  // Code mode is the run_script tool; a configuration can take it (or any tool) out.
  for (const t of [...(cfg?.codeMode === false ? ['run_script'] : []), ...(cfg?.disableTools ?? [])]) h.registry.tools.delete(t);
  opts.setup?.(h, cfg);
  const run: EvalRun = { pack: c.pack, case: c.name, model, repeat, ...(cfg ? { config: cfg.name } : {}), status: 'error', pass: false, checks: [], cost: 0, inputTokens: 0, cacheHit: 0, output: 0, modelCalls: 0, toolCalls: 0, seconds: 0, workspace: ws };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (c.timeoutMin ?? 90) * 60_000);
  try {
    const s = await h.sessions.create({ model, ...(cfg?.effort ? { effort: cfg.effort } : {}), mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
    const errors: string[] = [];
    const done = new Promise<void>((resolve) => {
      s.subscribe(0, ({ event }) => {
        if (event.kind === 'notice' && event.level === 'error') errors.push(event.text);
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
    // A provider failure (no credits, a bad key, an outage) says nothing about the model or the harness.
    const problem = run.status !== 'succeeded' && run.status !== 'done' ? providerProblem([runs[0]?.error, ...errors]) : undefined;
    if (problem) { run.status = 'provider-error'; run.error = problem; run.unscored = true; }
    run.checks = await runChecks(h, c, ws, new AbortController().signal, { sources: s.sources });
    run.pass = ['succeeded', 'done'].includes(run.status) && run.checks.every((x) => x.pass);
  } catch (e) {
    run.error = (e as Error).message;
  } finally {
    clearTimeout(timer);
    run.seconds = Math.round((Date.now() - t0) / 1000);
    await h.close();
    if (c.teardown) await caseStep(c, ws, 'teardown').catch((e) => { opts.log?.(`${c.pack}/${c.name}: ${(e as Error).message}`); });
  }
  opts.log?.(`${run.unscored ? 'NOT SCORED' : run.pass ? 'PASS' : 'FAIL'} ${c.pack}/${c.name} ${model}${cfg ? ` [${cfg.name}]` : ''} #${repeat}: ${run.status}, ${run.checks.filter((x) => x.pass).length}/${run.checks.length} checks, $${run.cost.toFixed(4)}, ${run.seconds}s`);
  await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(run, null, 1));
  return run;
}

/**
 * Judges finished runs again with the current checks, without running the agents
 * (no model spend): for a checker that was wrong, or a check added later. Each run
 * folder's workspace, session and sources are as the run left them.
 */
export async function rejudge(out: string, cases: EvalCase[], opts: { plugins: string[]; shipped?: string[]; log?: (s: string) => void }): Promise<EvalRun[]> {
  const runs: EvalRun[] = [];
  for (const e of (await fs.readdir(out, { withFileTypes: true })).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const base = path.join(out, e.name);
    let run: EvalRun;
    try { run = JSON.parse(await fs.readFile(path.join(base, 'result.json'), 'utf8')) as EvalRun; } catch { continue; }
    const c = cases.find((x) => x.pack === run.pack && x.name === run.case);
    if (!c) { opts.log?.(`skip ${e.name}: case ${run.pack}/${run.case} not found`); runs.push(run); continue; }
    const h = await createHarness({ dataDir: path.join(base, 'data'), plugins: opts.plugins, shippedPlugins: opts.shipped, scheduler: false });
    try {
      const s = h.sessions.list()[0] ? h.sessions.get(h.sessions.list()[0]!.id) : undefined;
      // A run recorded before provider errors were told apart: its workflow record says why it stopped.
      if (!run.unscored && !['succeeded', 'done'].includes(run.status) && s) {
        const problem = providerProblem([(await s.listRuns())[0]?.error, run.error]);
        if (problem) { run.status = 'provider-error'; run.error = problem; run.unscored = true; }
      }
      const before = run.checks.filter((x) => x.pass).length;
      run.checks = await runChecks(h, c, run.workspace, new AbortController().signal, s ? { sources: s.sources } : undefined);
      run.pass = ['succeeded', 'done'].includes(run.status) && run.checks.every((x) => x.pass);
      opts.log?.(`${run.unscored ? 'NOT SCORED' : run.pass ? 'PASS' : 'FAIL'} ${c.pack}/${c.name} ${run.model}${run.config ? ` [${run.config}]` : ''} #${run.repeat}: ${before} -> ${run.checks.filter((x) => x.pass).length}/${run.checks.length} checks`);
      await fs.writeFile(path.join(base, 'result.json'), JSON.stringify(run, null, 1));
    } finally { await h.close(); }
    runs.push(run);
  }
  // The configurations the runs were made under, as the first report recorded them (baseline first).
  const prior = JSON.parse(await fs.readFile(path.join(out, 'results.json'), 'utf8').catch(() => '{}')) as { configs?: HarnessConfig[] };
  const configs = prior.configs?.length ? prior.configs : undefined;
  const env = await harnessDisclosure(opts.plugins, configs);
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify({ harness: env, ...(configs ? { configs } : {}), rejudged: new Date().toISOString(), runs }, null, 1));
  await fs.writeFile(path.join(out, 'report.md'), report(runs, { ...env, judged: 'checks re-run on the finished workspaces (no agent re-run)' }, configs?.map((x) => x.name)));
  return runs;
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

/**
 * Every case on every model, `repeats` times - and with `configs`, under every
 * harness configuration too (the first is the baseline the report compares with).
 * Configurations run one after another, since each sets its own environment.
 */
export async function runEvals(opts: { cases: EvalCase[]; models: string[]; repeats: number; out: string; concurrency: number; plugins: string[]; shipped?: string[]; configs?: HarnessConfig[]; log?: (s: string) => void; setup?: (h: Harness, config?: HarnessConfig) => void }): Promise<EvalRun[]> {
  const configs = opts.configs?.length ? opts.configs : undefined;
  for (const c of configs ?? []) await configPlugins(opts.plugins, c); // a missing plugin fails before anything runs
  const runs: EvalRun[] = [];
  for (const config of configs ?? [undefined]) {
    const leave = config ? await enterConfig(config, opts.out) : () => {};
    try {
      const jobs = opts.cases.flatMap((c) => opts.models.flatMap((m) => Array.from({ length: opts.repeats }, (_, r) => () => runOne(c, m, r + 1, opts.out, { ...opts, config }))));
      runs.push(...await pool(jobs, opts.concurrency));
    } finally { leave(); }
  }
  const env = await harnessDisclosure(opts.plugins, configs);
  await fs.writeFile(path.join(opts.out, 'results.json'), JSON.stringify({ harness: env, ...(configs ? { configs } : {}), runs }, null, 1));
  await fs.writeFile(path.join(opts.out, 'report.md'), report(runs, env, configs?.map((c) => c.name)));
  return runs;
}

/**
 * What produced these numbers. A score describes a model and a harness together
 * (the same two models swap places by tens of points across harnesses), so every
 * report names the harness: its version and commit, the settings that shape the
 * loop, the plugins, where it ran - and each configuration an ablation compared.
 */
export async function harnessDisclosure(plugins: string[] = [], configs?: HarnessConfig[]): Promise<Record<string, string>> {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}')) as { version?: string };
  const git = await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeoutMs: 10_000 });
  const dirty = await run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 10_000 });
  const s = defaultSettings();
  return {
    harness: `harness-web ${pkg.version ?? '?'}`,
    commit: git.code === 0 ? `${git.stdout.trim()}${dirty.stdout.trim() ? ' (with local changes)' : ''}` : 'unknown',
    settings: `maxSteps ${s.maxSteps}, maxCostUsd ${s.maxCostUsd}, compactAt ${s.compactAt ?? 'model default'}, subagentModel ${s.subagentModel ?? 'session model'}, gatesOnStop ${s.gatesOnStop ? 'on' : 'off'}, subagent depth ${s.maxSubagentDepth}`,
    plugins: plugins.map((p) => path.basename(p)).join(', ') || 'none',
    platform: `${process.platform} ${process.arch}, Node ${process.versions.node}`,
    ...Object.fromEntries((configs ?? []).map((c, i) => [`config ${c.name}`, `${i === 0 ? '(baseline) ' : ''}${describeConfig(c)}`])),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0; };

/**
 * The 95% Wilson score interval for k passes in n runs. Unlike "k/n ± 1.96·SE" it
 * stays inside 0-100% and is honest at the small n and extreme rates evals have
 * (0/3 is not "0%, certainly").
 */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** "median (min-max)" over repeats; one value, or all the same, prints alone. */
function spread(xs: number[], f: (x: number) => string): string {
  if (!xs.length) return '-';
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return lo === hi ? f(lo) : `${f(median(xs))} (${f(lo)}-${f(hi)})`;
}

const usd = (x: number) => `$${x.toFixed(3)}`;
const time = (s: number) => (s < 120 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);
const ci = (k: number, n: number) => { const [lo, hi] = wilson(k, n); return `${pct(lo)}-${pct(hi)}`; };
const signed = (x: number, f: (v: number) => string) => (x > 0 ? `+${f(x)}` : x < 0 ? `-${f(-x)}` : `±${f(0)}`);

/** Pass rate and cost of `rs` against the baseline's `base`: "+25 pp", "+$0.012". */
function delta(rs: EvalRun[], base: EvalRun[] | undefined): [string, string] {
  if (!base?.length) return ['-', '-'];
  const rate = (xs: EvalRun[]) => xs.filter((r) => r.pass).length / xs.length;
  return [signed(Math.round((rate(rs) - rate(base)) * 100), (v) => `${v} pp`), signed(median(rs.map((r) => r.cost)) - median(base.map((r) => r.cost)), usd)];
}

/**
 * The markdown report. Each row is a case and model (and harness configuration);
 * cells over repeats read "median (min-max)", and the pass rate carries a 95%
 * Wilson interval. With configurations, every row also shows its change against
 * the baseline configuration (the first), and a summary per model and
 * configuration across all cases separates the harness's effect from the model's.
 */
export function report(all: EvalRun[], harness?: Record<string, string>, configOrder?: string[]): string {
  // Runs the provider stopped (credits, keys, outages) are listed, never counted.
  const runs = all.filter((r) => !r.unscored);
  const unscored = all.filter((r) => r.unscored);
  const lines = ['# Evaluation report', '', `${runs.length} run(s)${unscored.length ? ` scored, ${unscored.length} not scored (provider errors, listed at the end)` : ''}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  if (harness) lines.push('Harness (a score describes the model and the harness together):', '', ...Object.entries(harness).map(([k, v]) => `- ${k}: ${v}`), '');
  const order = [...new Set([...(configOrder ?? []), ...runs.map((r) => r.config).filter((x): x is string => !!x)])];
  const ablation = order.length > 1;
  const baseline = order[0];
  const group = (key: (r: EvalRun) => string) => {
    const m = new Map<string, EvalRun[]>();
    for (const r of runs) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); }
    return m;
  };
  const rank = (c?: string) => (c ? order.indexOf(c) : 0);
  const sorted = (m: Map<string, EvalRun[]>) => [...m.values()].sort((a, b) => `${a[0]!.pack}/${a[0]!.case}|${a[0]!.model}`.localeCompare(`${b[0]!.pack}/${b[0]!.case}|${b[0]!.model}`) || rank(a[0]!.config) - rank(b[0]!.config));
  const rows = group((r) => `${r.pack}/${r.case}|${r.model}|${r.config ?? ''}`);
  const passes = (rs: EvalRun[]) => rs.filter((r) => r.pass).length;
  lines.push(
    `| Case | Model |${order.length ? ' Config |' : ''} Pass | 95% CI | Checks passed | Cost | Time | Cache hit | Calls |${ablation ? ' Δ pass | Δ cost |' : ''}`,
    `|---|---|${order.length ? '---|' : ''}---|---|---|---|---|---|---|${ablation ? '---|---|' : ''}`,
  );
  for (const rs of sorted(rows)) {
    const r0 = rs[0]!;
    const checks = rs.reduce((a, r) => a + r.checks.filter((x) => x.pass).length, 0);
    const total = rs.reduce((a, r) => a + r.checks.length, 0);
    const cells = [
      `${r0.pack}/${r0.case}`, r0.model, ...(order.length ? [r0.config ?? '-'] : []),
      `${passes(rs)}/${rs.length}`, ci(passes(rs), rs.length), `${checks}/${total}`,
      spread(rs.map((r) => r.cost), usd), spread(rs.map((r) => r.seconds), time), spread(rs.map((r) => r.cacheHit), pct), spread(rs.map((r) => r.modelCalls), String),
    ];
    if (ablation) cells.push(...(r0.config === baseline ? ['baseline', 'baseline'] : delta(rs, rows.get(`${r0.pack}/${r0.case}|${r0.model}|${baseline}`))));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('', `Cells over repeats read median (min-max). 95% CI: the Wilson score interval for the pass rate${ablation ? `; Δ: against the baseline configuration (${baseline}) on the same case and model, pass rate in percentage points and median cost` : ''}.`);
  if (ablation) {
    // The harness's effect: the same model and cases, only the configuration differs.
    const byModel = group((r) => `${r.model}|${r.config ?? ''}`);
    lines.push('', '## Harness configurations', '', 'All cases together, per model. The model and the cases are the same in every row of a model, so the differences are the harness configuration\'s effect. Where two rows\' intervals overlap, the difference may be chance: add repeats before trusting it.', '');
    lines.push('| Model | Config | Pass | 95% CI | Δ pass | Cost | Δ cost | Time |', '|---|---|---|---|---|---|---|---|');
    for (const rs of [...byModel.values()].sort((a, b) => a[0]!.model.localeCompare(b[0]!.model) || rank(a[0]!.config) - rank(b[0]!.config))) {
      const r0 = rs[0]!;
      const [dp, dc] = r0.config === baseline ? ['baseline', 'baseline'] : delta(rs, byModel.get(`${r0.model}|${baseline}`));
      lines.push(`| ${r0.model} | ${r0.config ?? '-'} | ${passes(rs)}/${rs.length} | ${ci(passes(rs), rs.length)} | ${dp} | ${spread(rs.map((r) => r.cost), usd)} | ${dc} | ${spread(rs.map((r) => r.seconds), time)} |`);
    }
  }
  lines.push('', '## Failed checks', '');
  const failed = runs.filter((r) => !r.pass);
  if (!failed.length) lines.push('None.');
  for (const r of failed) {
    lines.push(`- **${r.pack}/${r.case} ${r.model}${r.config ? ` [${r.config}]` : ''} #${r.repeat}** (${r.status}${r.error ? `: ${r.error}` : ''})`);
    for (const ch of r.checks.filter((x) => !x.pass)) lines.push(`  - ${ch.name}: ${ch.detail.replace(/\n/g, ' | ').slice(0, 400)}`);
  }
  if (unscored.length) {
    lines.push('', '## Not scored', '', 'These runs stopped on the provider\'s side; they say nothing about the model or the harness. Run them again.', '');
    for (const r of unscored) lines.push(`- ${r.pack}/${r.case} ${r.model}${r.config ? ` [${r.config}]` : ''} #${r.repeat}: ${r.error}`);
  }
  return lines.join('\n') + '\n';
}
