import crypto from 'node:crypto';
import { applyWrite, evaluateCondition, initState, outputInstruction, parseOutputs, renderShell, renderTemplate, resolveTemplate, type Scope } from './state.ts';
import type { AgentNode, MapNode, MapTemplate, NodeRecord, RunRecord, StateField, WorkflowDef, WorkflowHost, WorkflowNode } from './types.ts';
import { validateWorkflow } from './validate.ts';

// Runs a workflow graph durably: the run record is saved after every node, so
// a run interrupted by a restart resumes at the node it was in (that node runs
// again from its start - write nodes to be safe to repeat). Each agent node
// gets a FRESH context with a short brief; earlier work reaches it as files in
// the workspace and short summaries in state, not as a growing transcript.
// That keeps every node's prompt small and every node's cache prefix shared.

const SUMMARY_MAX = 4000;
const MAX_STEPS = 200;

/** state key holding an unfinished step's note until the next gate reports. */
const INCOMPLETE = '__incomplete';

/** Fills {{input.x}}, {{state.x}} (a declared field, else a node's output), {{feedback}}, and in a map item {{item}} and {{index}}. */
export function render(template: string, run: RunRecord, scope?: Scope): string {
  return renderTemplate(template, run, scope);
}

/**
 * A node's model: fixed, or from the run's input ("{{input.reviewerModel}}"), so a person picks
 * the model of a role when they start the run. Empty means the session's own model.
 */
export function nodeModel(model: string | undefined, run: RunRecord): string | undefined {
  if (!model) return undefined;
  return model.includes('{{') ? render(model, run).trim() || undefined : model;
}

export function newRun(w: WorkflowDef, sessionId: string, input: Record<string, string>): RunRecord {
  const now = Date.now();
  const filled: Record<string, string> = {};
  for (const [k, spec] of Object.entries(w.inputs ?? {})) {
    const v = input[k] ?? spec.default;
    if (spec.required && !v?.trim()) throw new Error(`workflow ${w.name} needs input "${k}": ${spec.description}`);
    if (v !== undefined) filled[k] = v;
  }
  for (const [k, v] of Object.entries(input)) if (!(k in filled)) filled[k] = v;
  const run: RunRecord = {
    id: `run_${crypto.randomBytes(6).toString('hex')}`,
    workflow: w.name, sessionId, status: 'running', input: filled, state: {}, feedback: '',
    current: w.start, counts: {}, agentRuns: 0, history: [], createdAt: now, updatedAt: now, cost: 0,
  };
  if (w.state) initState(run, w.state);
  return run;
}

function route(node: WorkflowNode, outcome: string | undefined): string | undefined {
  const n = node.next;
  if (!n) return undefined;
  if (typeof n === 'string') return n;
  if (outcome && n.on[outcome]) return n.on[outcome];
  return n.default;
}

const NEGATIVE = /REQUEST|REJECT|FAIL|CHANGES|BLOCK/i;

/**
 * The verdict in a report: a line that is only a decision word wins (agents are
 * asked to end with one), else the LAST whole-word mention. Earliest-mention lost
 * to "I would APPROVE if ... REQUEST_CHANGES", and substrings counted DISAPPROVE.
 */
export function decideFrom(report: string, words: string[] | undefined): string | undefined {
  if (!words?.length) return undefined;
  const norm = (x: string) => x.toUpperCase().replace(/[\s_-]+/g, '_');
  const lines = report.split('\n').map((l) => norm(l.replace(/[*_`#>.!:]+/g, ' ').trim()));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    const w = words.find((x) => norm(x) === lines[i]);
    if (w) return w;
    break; // only the last non-empty line can be the stand-alone verdict
  }
  let best: { w: string; i: number } | undefined;
  for (const w of words) {
    const re = new RegExp(`(?<![A-Z0-9_])${norm(w).replace(/_/g, '[\\s_-]+')}(?![A-Z0-9_])`, 'gi');
    for (const m of report.matchAll(re)) if (!best || m.index! > best.i) best = { w, i: m.index! };
  }
  return best?.w;
}

/** No verdict is never approval: the conservative word (REQUEST_CHANGES, REJECT, ...) if the node has one. */
const conservative = (words: string[] | undefined) => words?.find((w) => NEGATIVE.test(w));

type Result = { outcome?: string; summary?: string; failed?: boolean; cost?: number; output?: unknown; interrupted?: boolean; paused?: { plugin: string; reason: string } };

/** Runs fn for each item, at most n at once. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

const preview = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };

export class WorkflowRunner {
  private w: WorkflowDef;
  private host: WorkflowHost;
  run: RunRecord;
  /** Steps taken in this execution: every node, and every map item, counts toward MAX_STEPS. */
  private steps = 0;

  constructor(w: WorkflowDef, host: WorkflowHost, run: RunRecord) {
    const errors = validateWorkflow(w);
    if (errors.length) throw new Error(`workflow ${w.name} is invalid:\n- ${errors.join('\n- ')}`);
    this.w = w;
    this.host = host;
    this.run = run;
  }

  private get fields(): Record<string, StateField> { return this.w.state ?? {}; }

  private async save(): Promise<void> {
    this.run.updatedAt = Date.now();
    await this.host.save(this.run);
  }

  async execute(signal: AbortSignal): Promise<RunRecord> {
    const run = this.run;
    run.status = 'running';
    delete run.paused;
    // A run saved before a field was declared gets the field's initial value.
    initState(run, this.w.state);
    // A resumed run re-enters its current node; the record left open by the stop is closed as interrupted.
    for (const h of run.history) if (h.status === 'running' || h.status === 'waiting') { h.status = 'interrupted'; h.endedAt ??= run.updatedAt ?? Date.now(); }
    this.host.emit({ kind: 'workflow', run, phase: 'started' });
    try {
      while (run.current && this.steps < MAX_STEPS) {
        this.steps++;
        if (signal.aborted) { run.status = 'aborted'; break; }
        const id = run.current;
        const node = this.w.nodes[id]!;
        if (node.type === 'end') {
          run.status = node.status === 'failed' ? 'failed' : 'succeeded';
          run.history.push({ node: id, type: 'end', status: 'done', startedAt: Date.now(), endedAt: Date.now(), summary: node.title });
          run.current = undefined;
          break;
        }
        const r = await this.runNode(id, node, signal);
        if (signal.aborted) { run.status = 'aborted'; break; }
        // What the node needs is switched off: the run waits at it (it runs from its start when resumed).
        if (r.paused) { run.status = 'waiting'; run.paused = { node: id, ...r.paused }; await this.host.paused?.(run); break; }
        if (r.failed) { run.status = 'failed'; run.error = r.summary; break; }
        run.current = route(node, r.outcome);
        if (!run.current) { run.status = 'failed'; run.error = `${id}: no route for outcome "${r.outcome ?? ''}"`; break; }
        await this.save();
      }
      if (run.current && run.status === 'running') { run.status = 'failed'; run.error = `stopped after ${MAX_STEPS} steps`; }
    } catch (err) {
      run.status = signal.aborted ? 'aborted' : 'failed';
      run.error = (err as Error).message;
    }
    await this.save();
    this.host.emit({ kind: 'workflow', run, phase: 'finished' });
    return run;
  }

  /** Runs one node (or a parallel group); records it; applies its writes; returns its outcome. */
  private async runNode(id: string, node: WorkflowNode, signal: AbortSignal): Promise<Result> {
    const run = this.run;
    const rec: NodeRecord = { node: id, type: node.type, status: 'running', startedAt: Date.now() };
    run.history.push(rec);
    run.counts[id] = (run.counts[id] ?? 0) + 1;
    await this.save();
    this.host.emit({ kind: 'workflow', run, node: id, phase: 'node_started' });
    let out: Result = {};
    const held = this.host.blocked?.(node);
    if (held) {
      rec.status = 'waiting';
      rec.summary = held.reason;
      rec.endedAt = Date.now();
      rec.cost = 0;
      this.host.emit({ kind: 'workflow', run, node: id, phase: 'node_finished' });
      return { paused: held, summary: held.reason };
    }
    try {
      out = await this.exec(id, node, signal);
      if (!out.failed && !out.interrupted && !out.paused && node.type !== 'end' && node.writes) this.applyWrites(node.writes, { output: out.output });
      rec.status = out.failed ? 'failed' : out.interrupted ? 'interrupted' : out.paused ? 'waiting' : 'done';
    } catch (err) {
      out = { failed: true, summary: `${id} failed: ${(err as Error).message}`, cost: out.cost };
      rec.status = 'failed';
    }
    rec.outcome = out.outcome;
    rec.summary = out.summary?.slice(0, 2000);
    rec.endedAt = Date.now();
    // Each step reports its own cost: parallel branches finish in any order, so a
    // difference in the run total would count a sibling's spend.
    rec.cost = out.cost ?? 0;
    this.host.emit({ kind: 'workflow', run, node: id, phase: 'node_finished' });
    return out;
  }

  /**
   * The structured result of an agent step. A report that did the work but forgot the
   * fenced JSON block gets one short call that writes the block from the report (no new
   * work), before the step counts as failed: a format slip should not undo a correct job.
   */
  private async outputsOf(id: string, report: string, outputs: string[], signal: AbortSignal): Promise<ReturnType<typeof parseOutputs>> {
    const p = parseOutputs(report, outputs, this.fields);
    if (!p.error || signal.aborted) return p;
    const r = await this.host.runAgent({
      agent: 'general', label: `${id}-result`, maxSteps: 2, signal,
      prompt: `Below is the final report of the workflow step "${id}". The work is done: do not use any tools or do any work. Reply with only the step's result, read from the report.${outputInstruction(outputs, this.fields)}\n\n<report>\n${report.slice(-20_000)}\n</report>`,
    }).catch(() => undefined);
    if (!r) return p;
    this.run.cost += r.cost;
    const again = parseOutputs(r.report, outputs, this.fields);
    return again.error ? p : again;
  }

  /** Writes values into declared fields, all or none: one bad value leaves state as it was. */
  private commit(values: Record<string, unknown>): void {
    const trial: RunRecord = { ...this.run, values: structuredClone(this.run.values ?? {}) };
    for (const [k, v] of Object.entries(values)) applyWrite(trial, this.fields, k, v);
    this.run.values = trial.values;
  }

  private applyWrites(writes: Record<string, string>, scope: Scope): void {
    const values = Object.fromEntries(Object.entries(writes).map(([k, t]) => [k, resolveTemplate(t, this.run, scope)]));
    try { this.commit(values); } catch (e) { throw new Error(`writes: ${(e as Error).message}`); }
  }

  /** An agent's brief: the prompt, then what to end with (a JSON block of its outputs, a verdict word). */
  private brief(node: Omit<AgentNode, 'next'>, scope?: Scope): string {
    const outputs = node.outputs?.length ? outputInstruction(node.outputs, this.fields) : '';
    const decide = node.decide?.length ? `\n\n${outputs ? 'After the JSON block, end' : 'End'} your report with exactly one of these words on its own line: ${node.decide.join(' | ')}.` : '';
    return render(node.prompt, this.run, scope) + outputs + decide;
  }

  private async exec(id: string, node: WorkflowNode, signal: AbortSignal): Promise<Result> {
    const run = this.run;
    switch (node.type) {
      case 'agent': {
        if (this.w.maxAgentRuns && run.agentRuns >= this.w.maxAgentRuns) return { failed: true, summary: `agent-run limit (${this.w.maxAgentRuns}) reached` };
        run.agentRuns++;
        const r = await this.host.runAgent({ agent: node.agent ?? 'general', label: id, prompt: this.brief(node), model: nodeModel(node.model, run), effort: node.effort, maxSteps: node.maxSteps, signal });
        run.cost += r.cost;
        run.state[id] = r.report.slice(0, SUMMARY_MAX);
        // Out of steps (or of time, HARNESS_MAX_TURN_MINUTES) is unfinished work, not a failure: the next step (a gate) judges it.
        if (r.reason === 'max_steps' || r.reason === 'time') {
          run.feedback = `The "${id}" step ran out of ${r.reason === 'time' ? 'time' : 'steps'} before it finished. Its last report:\n${r.report.slice(-3000)}`;
          // A reviewer that did not finish has not approved.
          const no = conservative(node.decide);
          if (no) return { outcome: no, summary: `${r.report}\n\n(Ran out of ${r.reason === 'time' ? 'time' : 'steps'} before a verdict: treated as ${no}.)`, cost: r.cost, output: r.report };
          run.state[INCOMPLETE] = run.feedback;
          return { outcome: 'incomplete', summary: r.report, cost: r.cost, output: r.report };
        }
        if (r.reason !== 'done' && r.reason !== 'max_tokens') return { failed: true, summary: `agent stopped: ${r.reason}`, cost: r.cost };
        let output: unknown = r.report;
        if (node.outputs?.length) {
          const p = await this.outputsOf(id, r.report, node.outputs, signal);
          if (p.error) {
            run.feedback = `The "${id}" step's report could not be read: ${p.error}.`;
            if (typeof node.next === 'object' && 'invalid-output' in node.next.on) return { outcome: 'invalid-output', summary: `${r.report}\n\n(${p.error}.)`, cost: r.cost, output };
            return { failed: true, summary: `${id}: ${p.error}`, cost: r.cost };
          }
          this.commit(p.values!);
          output = p.values;
        }
        const found = decideFrom(r.report, node.decide);
        const no = node.decide?.length && !found ? conservative(node.decide) : undefined;
        return { outcome: found ?? no, summary: no ? `${r.report}\n\n(No verdict given: treated as ${no}.)` : r.report, cost: r.cost, output };
      }
      case 'gate': {
        const results = await this.host.runGates(node.gates, signal);
        const failed = results.filter((g) => !g.pass && g.severity !== 'advisory');
        const lines = results.map((g) => `${g.pass ? 'PASS' : g.severity === 'advisory' ? 'WARN' : 'FAIL'} ${g.name}: ${g.summary}`);
        run.state[id] = lines.join('\n');
        if (!failed.length) { run.feedback = ''; delete run.state[INCOMPLETE]; return { outcome: 'pass', summary: `${results.length} gate(s) passed\n${lines.join('\n')}`, output: run.state[id] }; }
        const fails = (run.counts[`${id}:fail`] = (run.counts[`${id}:fail`] ?? 0) + 1);
        const unfinished = run.state[INCOMPLETE] ? `${run.state[INCOMPLETE]}\n\n` : '';
        delete run.state[INCOMPLETE];
        run.feedback = `${unfinished}Quality gates failed:\n${failed.map((g) => `## ${g.name}: ${g.summary}\n${(g.details ?? '').slice(0, 3000)}`).join('\n\n')}`;
        if (node.maxFailures && fails >= node.maxFailures) return { outcome: 'exhausted', summary: `${failed.length} gate(s) still failing after ${fails} attempt(s)\n${lines.join('\n')}`, output: run.state[id] };
        return { outcome: 'fail', summary: `${failed.length} gate(s) failed: ${failed.map((g) => g.name).join(', ')}\n${lines.join('\n')}`, output: run.state[id] };
      }
      case 'approval': {
        const message = render(node.message, run);
        run.status = 'waiting';
        this.run.history[this.run.history.length - 1]!.status = 'waiting';
        await this.save();
        this.host.emit({ kind: 'workflow', run, node: id, phase: 'node_started' });
        const r = await this.host.approve({ runId: run.id, node: id, title: node.title ?? id, message, files: node.files ?? [] });
        run.status = 'running';
        run.state[id] = r.approved ? 'approved' : `rejected: ${r.feedback ?? ''}`;
        run.feedback = r.approved ? '' : `The reviewer rejected this: ${r.feedback || 'no reason given'}`;
        return { outcome: r.approved ? 'approve' : 'reject', summary: r.approved ? 'approved' : `rejected: ${r.feedback ?? ''}`, output: run.state[id] };
      }
      case 'shell': {
        const host = await this.host.host();
        // Values go in quoted: an input or an agent's output cannot add commands.
        const r = await host.exec(renderShell(node.command, run, {}, host.shell), { timeoutMs: node.timeoutMs ?? 300_000, signal });
        const out = `exit ${r.code}\n${(r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim().slice(-SUMMARY_MAX)}`;
        run.state[id] = out;
        if (r.code !== 0) run.feedback = `Command "${node.command.length > 120 ? `${node.command.slice(0, 117)}...` : node.command}" failed:\n${out}`;
        // "exit-N" routes a specific exit code when `next` names it; any other failure is "fail".
        const specific = typeof node.next === 'object' && r.code !== 0 && `exit-${r.code}` in node.next.on ? `exit-${r.code}` : undefined;
        return { outcome: r.code === 0 ? 'ok' : specific ?? 'fail', summary: `exit ${r.code}`, output: r.stdout.trim() };
      }
      case 'parallel': {
        const results = await Promise.all(node.branches.map((b) => this.runNode(b, this.w.nodes[b]!, signal)));
        const failed = results.filter((r) => r.failed);
        const cost = results.reduce((a, r) => a + (r.cost ?? 0), 0);
        const held = results.find((r) => r.paused);
        if (held && !failed.length) return { paused: held.paused, summary: held.summary, cost };
        if (failed.length) return { failed: true, summary: failed.map((f) => f.summary).join('; '), cost };
        // Outcome: "all" when no branch reported a negative decision, else the first negative one.
        // A branch that decides but gave no recognised verdict counts as negative.
        const outcomes = results.map((r, i) => {
          const words = (this.w.nodes[node.branches[i]!] as { decide?: string[] }).decide;
          return words?.length && !words.includes(r.outcome ?? '') ? conservative(words) ?? r.outcome : r.outcome;
        }).filter(Boolean) as string[];
        const negative = outcomes.find((o) => NEGATIVE.test(o));
        return { outcome: negative ?? 'all', summary: node.branches.map((b, i) => `${b}: ${results[i]!.outcome ?? 'done'}`).join(', '), cost };
      }
      case 'branch': {
        if (node.when !== undefined) {
          const v = evaluateCondition(node.when, run) ? 'true' : 'false';
          return { outcome: v, summary: `${node.when} → ${v}`, output: v };
        }
        const v = render(node.value ?? '', run).trim().toLowerCase();
        return { outcome: v, summary: `→ ${v || '(empty)'}`, output: v };
      }
      case 'code': {
        const r = await node.run({ run, host: await this.host.host(), signal });
        if (r?.output !== undefined) run.state[id] = typeof r.output === 'string' ? r.output : JSON.stringify(r.output).slice(0, SUMMARY_MAX);
        if (r?.state) this.commit(r.state);
        return { outcome: r?.outcome, summary: r?.outcome, output: r?.output };
      }
      case 'map':
        return this.runMap(id, node, signal);
      case 'end':
        return {};
    }
  }

  /**
   * Fans out over a list: the node's template runs once per item, at most
   * `concurrency` at once. Each finished item is saved with its result, so a
   * resumed run re-runs only the items that had not finished. Every item is a
   * step (the 200-step cap) and every agent item an agent run (maxAgentRuns);
   * a map that would pass either cap fails before it starts.
   */
  private async runMap(id: string, node: MapNode, signal: AbortSignal): Promise<Result> {
    const run = this.run;
    const maps = (run.maps ??= {});
    let prog = maps[id];
    if (!prog) {
      let items = resolveTemplate(node.over, run);
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch { /* reported below */ } }
      if (!Array.isArray(items)) return { failed: true, summary: `${id}: over "${node.over}" is not a list (got ${preview(items)})` };
      prog = maps[id] = { items, results: {} };
    }
    const p = prog;
    const todo = p.items.map((_, i) => i).filter((i) => !(String(i) in p.results));
    const left = MAX_STEPS - this.steps;
    // One step stays for routing on from the map (a map that used the last one would end the run).
    if (todo.length >= left) return { failed: true, summary: `${id}: ${todo.length} item(s) to run, but only ${Math.max(0, left - 1)} step(s) are left of the ${MAX_STEPS}-step cap after this one` };
    const t = node.node;
    if (t.type === 'agent' && this.w.maxAgentRuns && run.agentRuns + todo.length > this.w.maxAgentRuns) {
      return { failed: true, summary: `${id}: ${todo.length} agent run(s) would pass the agent-run limit (${this.w.maxAgentRuns}, ${run.agentRuns} used)` };
    }
    await this.save();
    const failures: string[] = [];
    let cost = 0;
    await pool(todo, node.concurrency ?? 4, async (i) => {
      if (signal.aborted) return;
      const r = await this.runItem(id, t, i, p.items[i], signal);
      cost += r.cost ?? 0;
      // An item the stop cut short is not a failure: it runs again on resume.
      if (r.failed) { if (!signal.aborted) failures.push(`[${i}] ${r.summary ?? 'failed'}`); return; }
      p.results[String(i)] = r.output ?? null;
      if (r.outcome) (p.outcomes ??= {})[String(i)] = r.outcome;
      await this.save();
    });
    const done = Object.keys(p.results).length;
    if (signal.aborted) return { interrupted: true, summary: `${done}/${p.items.length} item(s) done before the stop`, cost };
    if (failures.length) {
      const summary = `${failures.length} of ${p.items.length} item(s) failed:\n${failures.join('\n')}`;
      run.feedback = `In "${id}", ${summary}`.slice(0, SUMMARY_MAX);
      // Routed: the map is over (a later visit starts it fresh). Not routed: the run fails and a resume re-runs only these.
      if (typeof node.next === 'object' && 'fail' in node.next.on) { this.endMap(id); return { outcome: 'fail', summary, cost }; }
      return { failed: true, summary: `${id}: ${summary}`, cost };
    }
    const results = p.items.map((_, i) => p.results[String(i)]);
    const negative = Object.values(p.outcomes ?? {}).find((o) => NEGATIVE.test(o));
    this.endMap(id);
    if (node.collect) this.commit({ [node.collect]: results });
    run.state[id] = JSON.stringify(results).slice(0, SUMMARY_MAX);
    return { outcome: negative ?? 'all', summary: `${results.length} item(s) done`, cost, output: results };
  }

  private endMap(id: string): void {
    delete this.run.maps![id];
    if (!Object.keys(this.run.maps!).length) delete this.run.maps;
  }

  /** One map item: recorded in the history as "<map>[<index>]", with its own writes applied. */
  private async runItem(mapId: string, t: MapTemplate, index: number, item: unknown, signal: AbortSignal): Promise<Result> {
    const run = this.run;
    const label = `${mapId}[${index}]`;
    const rec: NodeRecord = { node: label, type: t.type, status: 'running', startedAt: Date.now() };
    run.history.push(rec);
    this.steps++;
    this.host.emit({ kind: 'workflow', run, node: label, phase: 'node_started' });
    const scope: Scope = { item, index };
    let out: Result = {};
    try {
      out = await this.work(label, t, scope, signal);
      if (!out.failed && t.writes) this.applyWrites(t.writes, { ...scope, output: out.output });
    } catch (err) {
      out = { failed: true, summary: (err as Error).message, cost: out.cost };
    }
    rec.status = out.failed ? (signal.aborted ? 'interrupted' : 'failed') : 'done';
    rec.outcome = out.outcome;
    rec.summary = out.summary?.slice(0, 2000);
    rec.endedAt = Date.now();
    rec.cost = out.cost ?? 0;
    this.host.emit({ kind: 'workflow', run, node: label, phase: 'node_finished' });
    return out;
  }

  /** A map item's work. Unlike a routed node, an item has no fix loop: anything short of done is a failed item. */
  private async work(label: string, t: MapTemplate, scope: Scope, signal: AbortSignal): Promise<Result> {
    const run = this.run;
    switch (t.type) {
      case 'agent': {
        if (this.w.maxAgentRuns && run.agentRuns >= this.w.maxAgentRuns) return { failed: true, summary: `agent-run limit (${this.w.maxAgentRuns}) reached` };
        run.agentRuns++;
        const r = await this.host.runAgent({ agent: t.agent ?? 'general', label, prompt: this.brief(t, scope), model: nodeModel(t.model, run), effort: t.effort, maxSteps: t.maxSteps, signal });
        run.cost += r.cost;
        if (r.reason !== 'done' && r.reason !== 'max_tokens') return { failed: true, summary: r.reason === 'max_steps' ? `ran out of steps: ${r.report.slice(-500)}` : `agent stopped: ${r.reason}`, cost: r.cost };
        let output: unknown = r.report;
        if (t.outputs?.length) {
          const p = await this.outputsOf(label, r.report, t.outputs, signal);
          if (p.error) return { failed: true, summary: p.error, cost: r.cost };
          this.commit(p.values!);
          output = p.values;
        }
        const found = decideFrom(r.report, t.decide);
        return { outcome: found ?? (t.decide?.length ? conservative(t.decide) : undefined), summary: r.report, cost: r.cost, output };
      }
      case 'shell': {
        const host = await this.host.host();
        const r = await host.exec(renderShell(t.command, run, scope, host.shell), { timeoutMs: t.timeoutMs ?? 300_000, signal });
        const out = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
        if (r.code !== 0) return { failed: true, summary: `exit ${r.code}: ${out.slice(-1000)}` };
        return { outcome: 'ok', summary: `exit 0\n${out.slice(-SUMMARY_MAX)}`, output: r.stdout.trim() };
      }
      case 'code': {
        const r = await t.run({ run, host: await this.host.host(), signal, item: scope.item, index: scope.index });
        if (r?.state) this.commit(r.state);
        return { outcome: r?.outcome, summary: r?.outcome ?? (r?.output === undefined ? 'done' : preview(r.output)), output: r?.output };
      }
    }
  }
}

/** The first line that says something: not a heading, rule or bare label like "Report:". */
export function firstLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => !/^(#{1,6}\s|[-*_=]{3,}$|\**(report|summary)\**:?\**$)/i.test(l));
  return (said ?? lines[0] ?? '').replace(/\*\*/g, '').slice(0, 200);
}
