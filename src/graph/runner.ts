import crypto from 'node:crypto';
import type { NodeRecord, RunRecord, WorkflowDef, WorkflowHost, WorkflowNode } from './types.ts';
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

export function render(template: string, run: RunRecord): string {
  return template.replace(/\{\{\s*(input|state)\.([a-zA-Z0-9_-]+)\s*\}\}|\{\{\s*feedback\s*\}\}/g, (m, scope?: string, key?: string) => {
    if (!scope) return run.feedback || '(none)';
    const v = scope === 'input' ? run.input[key!] : run.state[key!];
    return v ?? '';
  });
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
  return {
    id: `run_${crypto.randomBytes(6).toString('hex')}`,
    workflow: w.name, sessionId, status: 'running', input: filled, state: {}, feedback: '',
    current: w.start, counts: {}, agentRuns: 0, history: [], createdAt: now, updatedAt: now, cost: 0,
  };
}

function route(node: WorkflowNode, outcome: string | undefined): string | undefined {
  const n = node.next;
  if (!n) return undefined;
  if (typeof n === 'string') return n;
  if (outcome && n.on[outcome]) return n.on[outcome];
  return n.default;
}

function decideFrom(report: string, words: string[] | undefined): string | undefined {
  if (!words?.length) return undefined;
  // The first decision word that appears wins (agents are asked to lead with it).
  let best: { w: string; i: number } | undefined;
  for (const w of words) {
    const i = report.toUpperCase().indexOf(w.toUpperCase());
    if (i >= 0 && (!best || i < best.i)) best = { w, i };
  }
  return best?.w;
}

export class WorkflowRunner {
  private w: WorkflowDef;
  private host: WorkflowHost;
  run: RunRecord;

  constructor(w: WorkflowDef, host: WorkflowHost, run: RunRecord) {
    const errors = validateWorkflow(w);
    if (errors.length) throw new Error(`workflow ${w.name} is invalid:\n- ${errors.join('\n- ')}`);
    this.w = w;
    this.host = host;
    this.run = run;
  }

  private async save(): Promise<void> {
    this.run.updatedAt = Date.now();
    await this.host.save(this.run);
  }

  async execute(signal: AbortSignal): Promise<RunRecord> {
    const run = this.run;
    run.status = 'running';
    // A resumed run re-enters its current node; the record left open by the stop is closed as interrupted.
    for (const h of run.history) if (h.status === 'running' || h.status === 'waiting') { h.status = 'interrupted'; h.endedAt ??= run.updatedAt ?? Date.now(); }
    this.host.emit({ kind: 'workflow', run, phase: 'started' });
    try {
      for (let step = 0; step < MAX_STEPS && run.current; step++) {
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

  /** Runs one node (or a parallel group); records it; returns its outcome. */
  private async runNode(id: string, node: WorkflowNode, signal: AbortSignal): Promise<{ outcome?: string; summary?: string; failed?: boolean; cost?: number }> {
    const run = this.run;
    const rec: NodeRecord = { node: id, type: node.type, status: 'running', startedAt: Date.now() };
    run.history.push(rec);
    run.counts[id] = (run.counts[id] ?? 0) + 1;
    await this.save();
    this.host.emit({ kind: 'workflow', run, node: id, phase: 'node_started' });
    let out: { outcome?: string; summary?: string; failed?: boolean; cost?: number };
    try {
      out = await this.exec(id, node, signal);
      rec.status = out.failed ? 'failed' : 'done';
    } catch (err) {
      out = { failed: true, summary: `${id} failed: ${(err as Error).message}` };
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

  private async exec(id: string, node: WorkflowNode, signal: AbortSignal): Promise<{ outcome?: string; summary?: string; failed?: boolean; cost?: number }> {
    const run = this.run;
    switch (node.type) {
      case 'agent': {
        if (this.w.maxAgentRuns && run.agentRuns >= this.w.maxAgentRuns) return { failed: true, summary: `agent-run limit (${this.w.maxAgentRuns}) reached` };
        run.agentRuns++;
        const decide = node.decide?.length ? `\n\nEnd your report with exactly one of these words on its own line: ${node.decide.join(' | ')}.` : '';
        const r = await this.host.runAgent({ agent: node.agent ?? 'general', label: id, prompt: render(node.prompt, run) + decide, model: node.model, effort: node.effort, maxSteps: node.maxSteps, signal });
        run.cost += r.cost;
        run.state[id] = r.report.slice(0, SUMMARY_MAX);
        // Out of steps is unfinished work, not a failure: the next step (a gate) judges it.
        if (r.reason === 'max_steps') {
          run.feedback = `The "${id}" step ran out of steps before it finished. Its last report:\n${r.report.slice(-3000)}`;
          run.state[INCOMPLETE] = run.feedback;
          return { outcome: 'incomplete', summary: r.report, cost: r.cost };
        }
        if (r.reason !== 'done' && r.reason !== 'max_tokens') return { failed: true, summary: `agent stopped: ${r.reason}`, cost: r.cost };
        const outcome = decideFrom(r.report.slice(-600), node.decide) ?? decideFrom(r.report, node.decide);
        return { outcome, summary: r.report, cost: r.cost };
      }
      case 'gate': {
        const results = await this.host.runGates(node.gates, signal);
        const failed = results.filter((g) => !g.pass && g.severity !== 'advisory');
        const lines = results.map((g) => `${g.pass ? 'PASS' : g.severity === 'advisory' ? 'WARN' : 'FAIL'} ${g.name}: ${g.summary}`);
        run.state[id] = lines.join('\n');
        if (!failed.length) { run.feedback = ''; delete run.state[INCOMPLETE]; return { outcome: 'pass', summary: `${results.length} gate(s) passed\n${lines.join('\n')}` }; }
        const fails = (run.counts[`${id}:fail`] = (run.counts[`${id}:fail`] ?? 0) + 1);
        const unfinished = run.state[INCOMPLETE] ? `${run.state[INCOMPLETE]}\n\n` : '';
        delete run.state[INCOMPLETE];
        run.feedback = `${unfinished}Quality gates failed:\n${failed.map((g) => `## ${g.name}: ${g.summary}\n${(g.details ?? '').slice(0, 3000)}`).join('\n\n')}`;
        if (node.maxFailures && fails >= node.maxFailures) return { outcome: 'exhausted', summary: `${failed.length} gate(s) still failing after ${fails} attempt(s)\n${lines.join('\n')}` };
        return { outcome: 'fail', summary: `${failed.length} gate(s) failed: ${failed.map((g) => g.name).join(', ')}\n${lines.join('\n')}` };
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
        return { outcome: r.approved ? 'approve' : 'reject', summary: r.approved ? 'approved' : `rejected: ${r.feedback ?? ''}` };
      }
      case 'shell': {
        const host = await this.host.host();
        const r = await host.exec(render(node.command, run), { timeoutMs: node.timeoutMs ?? 300_000, signal });
        const out = `exit ${r.code}\n${(r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim().slice(-SUMMARY_MAX)}`;
        run.state[id] = out;
        if (r.code !== 0) run.feedback = `Command "${node.command}" failed:\n${out}`;
        return { outcome: r.code === 0 ? 'ok' : 'fail', summary: `exit ${r.code}` };
      }
      case 'parallel': {
        const results = await Promise.all(node.branches.map((b) => this.runNode(b, this.w.nodes[b]!, signal)));
        const failed = results.filter((r) => r.failed);
        const cost = results.reduce((a, r) => a + (r.cost ?? 0), 0);
        if (failed.length) return { failed: true, summary: failed.map((f) => f.summary).join('; '), cost };
        // Outcome: "all" when no branch reported a negative decision, else the first negative one.
        const outcomes = results.map((r) => r.outcome).filter(Boolean) as string[];
        const negative = outcomes.find((o) => /REQUEST|REJECT|FAIL|CHANGES|BLOCK/i.test(o));
        return { outcome: negative ?? 'all', summary: node.branches.map((b, i) => `${b}: ${results[i]!.outcome ?? 'done'}`).join(', '), cost };
      }
      case 'branch': {
        const v = render(node.value, run).trim().toLowerCase();
        return { outcome: v, summary: `→ ${v || '(empty)'}` };
      }
      case 'code': {
        const r = await node.run({ run, host: await this.host.host(), signal });
        if (r?.output !== undefined) run.state[id] = typeof r.output === 'string' ? r.output : JSON.stringify(r.output).slice(0, SUMMARY_MAX);
        return { outcome: r?.outcome, summary: r?.outcome };
      }
      case 'end':
        return {};
    }
  }
}

/** The first line that says something: not a heading, rule or bare label like "Report:". */
export function firstLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => !/^(#{1,6}\s|[-*_=]{3,}$|\**(report|summary)\**:?\**$)/i.test(l));
  return (said ?? lines[0] ?? '').replace(/\*\*/g, '').slice(0, 200);
}
