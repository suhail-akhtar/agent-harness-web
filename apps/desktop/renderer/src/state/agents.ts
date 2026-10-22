/**
 * What a session's agents are doing, for the Agents panel and page: sub-agents (type, model,
 * status, cost, duration, worktree), from the live events, the stored history (the agent tool's
 * calls and results) and the trace (cost per agent and model). Pure; unit-tested.
 */

// Relative (type-only) so the root type check and the tests see this repository's client types.
import type { HarnessEvent, Item, TraceSpan, Usage } from '../../../../../packages/client/src/index.ts';

export interface SubAgent {
  name: string;
  type: string;
  model?: string;
  description?: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  startedAt?: number;
  endedAt?: number;
  /** Duration when only that is known (from the stored history). */
  ms?: number;
  cost: number;
  calls: number;
  tools: number;
  worktree?: string;
  background?: boolean;
  /** Its last tool call, as a line. */
  last?: string;
}

export interface ModelCost { model: string; cost: number; requests: number; input: number; output: number; cacheRead: number }

export type Agents = Record<string, SubAgent>;

const STARTED = /^Started (\S+) \(([^,()]+), ([^)]+)\)(?: in worktree (\S+))?(?:: ([\s\S]*))?$/;

const blank = (name: string, type = name.replace(/-\d+$/, '')): SubAgent => ({ name, type, status: 'running', cost: 0, calls: 0, tools: 0 });

/** One live event into the agents' state (a new object when something changed). */
export function foldAgent(a: Agents, e: HarnessEvent, now = Date.now()): Agents {
  const name = 'agent' in e && typeof e.agent === 'string' && e.agent !== 'main' ? e.agent : undefined;
  if (e.kind === 'task' && e.task.kind === 'agent') {
    const cur = a[e.task.id] ?? { ...blank(e.task.id), startedAt: e.task.startedAt };
    const status = e.task.status === 'running' ? 'running' : e.task.status === 'completed' ? 'done' : e.task.status === 'failed' ? 'failed' : 'stopped';
    return { ...a, [e.task.id]: { ...cur, background: true, description: cur.description ?? e.task.description, status, ...(e.task.endedAt ? { endedAt: e.task.endedAt } : {}), ...(e.task.cost !== undefined ? { cost: Math.max(cur.cost, e.task.cost) } : {}) } };
  }
  if (!name) return a;
  const cur = a[name] ?? { ...blank(name), startedAt: now };
  switch (e.kind) {
    case 'notice': {
      const m = STARTED.exec(e.text);
      if (!m || m[1] !== name) return a;
      return { ...a, [name]: { ...cur, type: m[2]!, model: m[3]!, ...(m[4] ? { worktree: m[4] } : {}), ...(m[5] ? { description: m[5] } : {}), startedAt: cur.startedAt ?? now, status: 'running' } };
    }
    case 'usage': return { ...a, [name]: { ...cur, cost: cur.cost + e.cost, calls: cur.calls + 1, model: cur.model ?? e.model } };
    case 'tool_call': return { ...a, [name]: { ...cur, tools: cur.tools + 1, last: `${e.name}` } };
    case 'turn_end': return { ...a, [name]: { ...cur, status: e.reason === 'done' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed', endedAt: now } };
    default: return a;
  }
}

/** Sub-agents from the stored history: each agent call, its id and worktree from its result. */
export function agentsFromItems(items: Item[], sessionModel?: string): Agents {
  const out: Agents = {};
  for (const i of items) {
    if (i.kind !== 'tool' || i.name !== 'agent') continue;
    const s = (k: string) => (typeof i.input[k] === 'string' ? (i.input[k] as string) : undefined);
    const bg = i.input.run_in_background === true;
    const id = (i.result && (/\(agent id: (\S+?)\)\s*$/.exec(i.result)?.[1] ?? (bg ? /^Started (\S+) in the background/.exec(i.result)?.[1] : undefined))) || undefined;
    const name = id ?? `${s('type') ?? 'explore'}-${i.id.slice(-4)}`;
    const wt = i.result ? /branch (\S+?), \d+ commit/.exec(i.result)?.[1] : undefined;
    out[name] = {
      name, type: s('type') ?? 'explore', model: s('model') ?? sessionModel, description: s('description'),
      status: i.running ? 'running' : i.isError ? 'failed' : bg ? 'running' : 'done',
      ...(i.startedAt ? { startedAt: i.startedAt } : {}), ...(i.ms !== undefined ? { ms: i.ms } : {}),
      cost: 0, calls: 0, tools: 0, ...(wt ? { worktree: wt } : {}), ...(bg ? { background: true } : {}),
    };
  }
  return out;
}

/** Cost, model and calls per agent from the trace (what the history does not keep). */
export function withTrace(a: Agents, spans: TraceSpan[]): Agents {
  const out: Agents = { ...a };
  const seen = new Map<string, { cost: number; calls: number; tools: number; model: string; first: number; last: number }>();
  for (const s of spans) {
    if (!s.agent || s.agent === 'main') continue;
    const x = seen.get(s.agent) ?? { cost: 0, calls: 0, tools: 0, model: '', first: s.at, last: s.at };
    if (s.type === 'model') { x.cost += s.cost; x.calls++; x.model = s.model; }
    if (s.type === 'tool') x.tools++;
    x.first = Math.min(x.first, s.at); x.last = Math.max(x.last, s.at);
    seen.set(s.agent, x);
  }
  for (const [name, x] of seen) {
    // Hook checks and workflow nodes are agents too; only the named sub-agents are listed.
    if (/^hook-check-/.test(name)) continue;
    const cur = out[name] ?? { ...blank(name), status: 'done' as const };
    out[name] = { ...cur, cost: Math.max(cur.cost, x.cost), calls: Math.max(cur.calls, x.calls), tools: Math.max(cur.tools, x.tools), model: cur.model ?? x.model, startedAt: cur.startedAt ?? x.first, ...(cur.status !== 'running' && !cur.endedAt && cur.ms === undefined ? { endedAt: x.last } : {}) };
  }
  return out;
}

/** Cost per model: the session's byModel, else summed from the trace. */
export function costByModel(byModel: Record<string, { usage: Usage; cost: number; requests: number }> | undefined): ModelCost[] {
  return Object.entries(byModel ?? {}).map(([model, v]) => ({ model, cost: v.cost, requests: v.requests, input: v.usage.input + v.usage.cacheWrite, output: v.usage.output, cacheRead: v.usage.cacheRead })).sort((x, y) => y.cost - x.cost);
}

/** Adds one usage event to a byModel map (live). */
export function addModelUsage(byModel: Record<string, { usage: Usage; cost: number; requests: number }> | undefined, e: Extract<HarnessEvent, { kind: 'usage' }>): Record<string, { usage: Usage; cost: number; requests: number }> {
  const cur = byModel?.[e.model] ?? { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, cost: 0, requests: 0 };
  const u = cur.usage;
  return { ...(byModel ?? {}), [e.model]: { usage: { input: u.input + e.usage.input, cacheRead: u.cacheRead + e.usage.cacheRead, cacheWrite: u.cacheWrite + e.usage.cacheWrite, output: u.output + e.usage.output, reasoning: u.reasoning + e.usage.reasoning }, cost: cur.cost + e.cost, requests: cur.requests + 1 } };
}

/** How long an agent ran (or has run). */
export function agentMs(a: SubAgent, now = Date.now()): number | undefined {
  if (a.ms !== undefined) return a.ms;
  if (a.startedAt === undefined) return undefined;
  return (a.endedAt ?? (a.status === 'running' ? now : a.startedAt)) - a.startedAt;
}
