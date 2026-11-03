/**
 * What a session's agents are doing, for the Agents panel and page: sub-agents (type, model,
 * status, cost, duration, worktree), from the live events, the stored history (the agent tool's
 * calls and results) and the trace (cost per agent and model). Pure; unit-tested.
 */

// Relative (type-only) so the root type check and the tests see this repository's client types.
import type { AgentActivityInfo, HarnessEvent, Item, LiveAgentInfo, TraceSpan, Usage } from '../../../../../packages/client/src/index.ts';

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
  /** The person's computer it works on (placed there). */
  machine?: string;
  background?: boolean;
  /** Its last tool call, as a line. */
  last?: string;
  /** Its work as the harness last checked it: done criteria passed of run, and a verifier's verdict. */
  accepted?: { checks?: { passed: number; total: number }; verdict?: 'pass' | 'fail' | 'unknown'; verifier?: string; round: number; blocked?: boolean; corroborated?: boolean };
  /** In the swarm's tree: the agent that started it (absent: the conversation's own) and how deep it is. */
  parent?: string;
  depth?: number;
  /** While it works: waiting on its model (since, its last output, retries) or running a tool. */
  activity?: AgentActivityInfo;
}

/** A sub-agent's model quiet this long is shown as stalled (the server tells its lead at the same mark). */
export const STALL_MS = 150_000;

/** What a sub-agent at work is doing, in words, and whether it looks stalled (its model quiet past STALL_MS). */
export function activityLine(a: SubAgent, now = Date.now()): { text: string; stalled: boolean } | undefined {
  const x = a.activity;
  if (a.status !== 'running' || !x) return undefined;
  if (x.doing === 'tool') return { text: `running ${x.tool ?? 'a tool'} · ${dur(now - x.since)}`, stalled: false };
  if (x.lastOutputAt && now - x.lastOutputAt < 5000) return { text: 'writing', stalled: false };
  const quiet = now - Math.max(x.since, x.lastOutputAt ?? 0);
  const retry = x.retries ? ` · retry ${x.retries}${x.retryReason ? ` (${x.retryReason.slice(0, 60)})` : ''}` : '';
  return quiet >= STALL_MS
    ? { text: `no reply from ${a.model ?? 'its model'} for ${dur(quiet)}${retry}`, stalled: true }
    : { text: `waiting on ${a.model ?? 'its model'} · ${dur(quiet)}${retry}`, stalled: false };
}
const dur = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** The agents as the swarm's tree: each after the agent that started it, in the order they started. */
export function asTree(agents: SubAgent[]): SubAgent[] {
  const byStart = [...agents].sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0));
  const names = new Set(byStart.map((x) => x.name));
  const out: SubAgent[] = [];
  const add = (parent: string | undefined, guard: number) => {
    if (guard > 5) return;
    for (const x of byStart) if ((x.parent && names.has(x.parent) ? x.parent : undefined) === parent && !out.includes(x)) { out.push(x); add(x.name, guard + 1); }
  };
  add(undefined, 0);
  return [...out, ...byStart.filter((x) => !out.includes(x))];
}

export interface ModelCost { model: string; cost: number; requests: number; input: number; output: number; cacheRead: number }

export type Agents = Record<string, SubAgent>;

const STARTED = /^Started (\S+) \(([^,()]+), ([^)]+)\)(?: in worktree (\S+))?(?: on computer ([^:]+?))?(?:: ([\s\S]*))?$/;

const blank = (name: string, type = name.replace(/-\d+$/, '')): SubAgent => ({ name, type, status: 'running', cost: 0, calls: 0, tools: 0 });
const working = (x: SubAgent): SubAgent => { if (x.status === 'running') return x; const { endedAt: _e, ms: _m, ...rest } = x; return { ...rest, status: 'running' }; };

/** One live event into the agents' state (a new object when something changed). */
export function foldAgent(a: Agents, e: HarnessEvent, now = Date.now()): Agents {
  const name = 'agent' in e && typeof e.agent === 'string' && e.agent !== 'main' ? e.agent : undefined;
  if (e.kind === 'task' && e.task.kind === 'agent') {
    const cur = a[e.task.id] ?? { ...blank(e.task.id), startedAt: e.task.startedAt };
    const status = e.task.status === 'running' ? 'running' : e.task.status === 'completed' ? 'done' : e.task.status === 'failed' ? 'failed' : 'stopped';
    return { ...a, [e.task.id]: { ...cur, background: true, description: cur.description ?? e.task.description, status, ...(e.task.endedAt ? { endedAt: e.task.endedAt } : {}), ...(e.task.cost !== undefined ? { cost: Math.max(cur.cost, e.task.cost) } : {}) } };
  }
  // The governor granted it: where it sits in the swarm's tree.
  if (e.kind === 'swarm') {
    if (e.phase !== 'start' || !e.agent) return a;
    const c = a[e.agent] ?? { ...blank(e.agent), startedAt: now };
    return { ...a, [e.agent]: { ...c, depth: e.depth ?? 1, ...(e.parent && e.parent !== 'main' ? { parent: e.parent } : {}) } };
  }
  // Critical stakes: the comparison is about both replicas.
  if (e.kind === 'acceptance' && e.phase === 'compare') {
    let out = a;
    for (const r of e.replicas ?? []) { const c = out[r.agent] ?? { ...blank(r.agent), startedAt: now }; out = { ...out, [r.agent]: { ...c, accepted: { round: 0, ...c.accepted, corroborated: !!e.agree } } }; }
    return out;
  }
  if (!name) return a;
  const cur = a[name] ?? { ...blank(name), startedAt: now };
  switch (e.kind) {
    case 'notice': {
      const m = STARTED.exec(e.text);
      if (!m || m[1] !== name) return a;
      return { ...a, [name]: { ...cur, type: m[2]!, model: m[3]!, ...(m[4] ? { worktree: m[4] } : {}), ...(m[5] ? { machine: m[5] } : {}), ...(m[6] ? { description: m[6] } : {}), startedAt: cur.startedAt ?? now, status: 'running' } };
    }
    // A call it makes is the proof it works now (shown as done from the trace, it was not).
    // The model of its latest call: one that failed over to another shows the one it works on now.
    case 'usage': return { ...a, [name]: { ...working(cur), cost: cur.cost + e.cost, calls: cur.calls + 1, model: e.model ?? cur.model, activity: { doing: 'model', since: now, retries: 0 } } };
    case 'tool_call': return { ...a, [name]: { ...working(cur), tools: cur.tools + 1, last: `${e.name}`, activity: { doing: 'tool', tool: e.name, since: now, retries: 0 } } };
    case 'tool_result': return { ...a, [name]: { ...cur, activity: { doing: 'model', since: now, retries: 0 } } };
    case 'retry': { const x = cur.activity ?? { doing: 'model' as const, since: cur.startedAt ?? now, retries: 0 }; return { ...a, [name]: { ...cur, activity: { ...x, retries: x.retries + 1, retryReason: e.reason.slice(0, 160) } } }; }
    // Its model writes: kept to one change every few seconds (a reply streams many deltas).
    case 'text_delta': case 'reasoning_delta': {
      const x = cur.activity;
      if (!x || x.doing !== 'model' || (x.lastOutputAt && now - x.lastOutputAt < 3000)) return a;
      return { ...a, [name]: { ...cur, activity: { ...x, lastOutputAt: now } } };
    }
    case 'turn_end': return { ...a, [name]: { ...cur, status: e.reason === 'done' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed', endedAt: now } };
    case 'acceptance': {
      const prev = cur.accepted;
      const accepted = e.phase === 'checks'
        ? { round: e.round, ...((e.results ?? []).length ? { checks: { passed: (e.results ?? []).filter((r) => r.ok).length, total: (e.results ?? []).length } } : {}), ...(e.blocked ? { blocked: true } : {}) }
        : { round: e.round, ...(prev?.round === e.round && prev.checks ? { checks: prev.checks } : {}), ...(e.verdict ? { verdict: e.verdict } : {}), ...(e.verifier ? { verifier: e.verifier } : {}) };
      return { ...a, [name]: { ...cur, accepted } };
    }
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

/**
 * The agents the server says are at work now: running, from when they started, wherever they sit in the
 * swarm's tree. A window opened after they started (or reloaded) heard none of their live events, and the
 * history and the trace alone would show them as done.
 */
export function withLive(a: Agents, live: LiveAgentInfo[] | undefined): Agents {
  if (!live?.length) return a;
  const out: Agents = { ...a };
  for (const l of live) {
    const cur = out[l.name] ?? blank(l.name, l.type);
    const { endedAt: _e, ms: _m, ...rest } = cur;
    out[l.name] = { ...rest, type: l.type, model: l.model, status: 'running', startedAt: l.startedAt, depth: l.depth, ...(l.parent !== 'main' ? { parent: l.parent } : {}), ...(l.description ? { description: cur.description ?? l.description } : {}), ...(l.worktree ? { worktree: l.worktree } : {}), ...(l.machine ? { machine: l.machine } : {}), ...(l.activity ? { activity: l.activity } : {}) };
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

/** A colour per model's company (fixed hues that read on light and dark), else one from its name. */
const PROVIDER_HUE: Array<[RegExp, string]> = [[/^claude/, '#d97757'], [/^grok/, '#8b5cf6'], [/^deepseek/, '#3b82f6'], [/^gpt|^o\d/, '#10a37f'], [/^kimi/, '#f59e0b'], [/^glm/, '#ec4899']];
export function modelColor(model?: string): string {
  if (!model) return '#9ca3af';
  for (const [re, c] of PROVIDER_HUE) if (re.test(model)) return c;
  let h = 0; for (const ch of model) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 55%)`;
}

/**
 * Agents still at work well past their finished siblings (more than twice the median, and a minute at
 * least): the ones a run waits on.
 */
export function stragglers(agents: SubAgent[], now = Date.now()): Set<string> {
  const out = new Set<string>();
  const byParent = new Map<string, SubAgent[]>();
  for (const a of agents) { const k = a.parent ?? 'main'; byParent.set(k, [...(byParent.get(k) ?? []), a]); }
  for (const group of byParent.values()) {
    const done = group.filter((a) => a.status === 'done').map((a) => agentMs(a, now) ?? 0).filter((ms) => ms > 0).sort((x, y) => x - y);
    if (done.length < 2) continue;
    const median = done[Math.floor(done.length / 2)]!;
    for (const a of group) if (a.status === 'running' && (agentMs(a, now) ?? 0) > Math.max(2 * median, 60_000)) out.add(a.name);
  }
  return out;
}

/** How long an agent ran (or has run). */
export function agentMs(a: SubAgent, now = Date.now()): number | undefined {
  if (a.ms !== undefined) return a.ms;
  if (a.startedAt === undefined) return undefined;
  return (a.endedAt ?? (a.status === 'running' ? now : a.startedAt)) - a.startedAt;
}
