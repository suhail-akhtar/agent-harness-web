import vm from 'node:vm';
import type { TaskView } from '../core/types.ts';
import type { Tool, ToolContext } from './types.ts';
import { bool, clip, num, str } from './types.ts';

// Background work in one session, as Claude Code keeps it: shells started with
// bash run_in_background, sub-agents and workflows started in the background,
// and monitors. Each is a task with an id; task_list, task_output, task_stop and
// monitor work on them, and send_message continues a sub-agent. The registry
// lives in memory with the session (a restart forgets it; shells keep running).

export type { TaskView };
export type TaskKind = TaskView['kind'];
export type TaskStatus = TaskView['status'];

export interface TaskEntry extends TaskView {
  /** Its output from `offset` on (a shell's log in bytes, an agent's report or a workflow's steps in characters), and the whole size. */
  read(offset?: number): Promise<{ text: string; size: number }>;
  /** Stops it. */
  stop(): Promise<void>;
  /** Checks where it runs whether it is still running (a shell's exit is written beside its log). */
  refresh?(): Promise<void>;
  /** Its output came from an agent that read outside content. */
  untrusted?(): boolean;
}

/** What the task tools reach in the session. Background starts are the main agent's alone. */
export interface TaskService {
  /** 'main' or the calling sub-agent's name. */
  caller: string;
  list(): Promise<TaskEntry[]>;
  get(id: string): TaskEntry | undefined;
  /** Stops a task the caller may stop (the main agent: any; a sub-agent: its own). */
  stop(id: string): Promise<string>;
  /** Registers a shell bash started in the background; returns its task id. */
  addShell(s: { id: string; pid: string; log: string; exitFile: string; command: string; description?: string }): string;
  /** Starts a sub-agent in the background (main agent only): returns its id at once. */
  startAgent?(a: { description: string; prompt: string; type: string }): Promise<string>;
  /** Continues a sub-agent the caller started, with its context intact. */
  sendMessage?(to: string, message: string, background: boolean, signal: AbortSignal): Promise<string>;
  /** Watches a task in the background (main agent only); fires as a reminder. */
  monitorInBackground?(task: TaskEntry, pattern: RegExp | undefined, timeoutMs: number, includeExisting: boolean): Promise<string>;
}

const KEEP_FINISHED = 100;

/** The tasks of one session: running ones, and the last finished ones. */
export class TaskRegistry {
  private tasks = new Map<string, TaskEntry>();
  private onChange?: (t: TaskView, phase: 'started' | 'finished') => void;
  constructor(onChange?: (t: TaskView, phase: 'started' | 'finished') => void) { this.onChange = onChange; }

  add(t: TaskEntry): TaskEntry {
    this.tasks.delete(t.id);
    this.tasks.set(t.id, t);
    const done = [...this.tasks.values()].filter((x) => x.status !== 'running');
    for (const old of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.tasks.delete(old.id);
    this.onChange?.(view(t), 'started');
    return t;
  }

  get(id: string): TaskEntry | undefined { return this.tasks.get(id); }

  all(): TaskEntry[] { return [...this.tasks.values()]; }

  running(kind?: TaskKind): TaskEntry[] { return this.all().filter((t) => t.status === 'running' && (!kind || t.kind === kind)); }

  /** Marks a task ended (once). Returns false when it had already ended. */
  finish(id: string, status: Exclude<TaskStatus, 'running'>, cost?: number): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== 'running') return false;
    t.status = status;
    t.endedAt = Date.now();
    if (cost !== undefined) t.cost = cost;
    this.onChange?.(view(t), 'finished');
    return true;
  }
}

export function view(t: TaskView): TaskView {
  return { id: t.id, kind: t.kind, description: t.description, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, owner: t.owner, ...(t.cost !== undefined ? { cost: t.cost } : {}) };
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

export interface WatchResult { fired: 'match' | 'exit' | 'timeout' | 'aborted' | 'slow'; line?: string; status: TaskStatus; tail: string }

/**
 * Waits, without model calls, until a line of the task's output matches `pattern`,
 * the task ends, or the time is up. Only output written after `from` is searched.
 */
export async function watchTask(t: TaskEntry, pattern: RegExp | undefined, timeoutMs: number, signal: AbortSignal, from = 0, pollMs = 500): Promise<WatchResult> {
  const deadline = Date.now() + timeoutMs;
  let pos = from;
  let partial = '';
  const recent: string[] = [];
  const tail = () => recent.slice(-10).join('\n');
  // Each line is tested in a vm context with a time limit: a pattern that backtracks without
  // end on some line is cut off there instead of stalling the server's event loop.
  const ctx = pattern ? vm.createContext({ re: pattern, s: '' }) : undefined;
  const test = (line: string): boolean | 'slow' => {
    ctx!.s = line.length > MONITOR_LINE_MAX ? line.slice(0, MONITOR_LINE_MAX) : line;
    try { return vm.runInContext('re.test(s)', ctx!, { timeout: 50 }) === true; } catch { return 'slow'; }
  };
  for (;;) {
    await t.refresh?.();
    const r = await t.read(pos);
    pos = Math.max(pos, r.size);
    const lines = (partial + r.text).split('\n');
    // The last piece may be a line still being written: it is tested once the task ends.
    partial = t.status === 'running' ? lines.pop() ?? '' : '';
    for (const l of lines) {
      recent.push(l);
      if (recent.length > 50) recent.shift();
      const hit = pattern ? test(l) : false;
      if (hit === 'slow') return { fired: 'slow', line: l, status: t.status, tail: tail() };
      if (hit) return { fired: 'match', line: l, status: t.status, tail: tail() };
    }
    if (t.status !== 'running') return { fired: 'exit', status: t.status, tail: tail() };
    if (signal.aborted) return { fired: 'aborted', status: t.status, tail: tail() };
    if (Date.now() >= deadline) return { fired: 'timeout', status: t.status, tail: tail() };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
}

/**
 * A regex from the model, refused when it is not one - or when it could backtrack for
 * minutes on one line and stall the whole server (it runs in the server's event loop):
 * a quantified group that holds a quantifier or an alternation ("(a+)+", "(a|aa)*"),
 * or a backreference. Lines are also tested only up to MONITOR_LINE_MAX characters.
 */
export function regex(p: string): RegExp | { error: string } {
  if (p.length > 300) return { error: 'pattern is too long (at most 300 characters)' };
  const group = String.raw`\((?:[^()\\]|\\.)*`;
  if (new RegExp(String.raw`${group}[+*}](?:[^()\\]|\\.)*\)\s*[+*{]`).test(p) || new RegExp(String.raw`${group}\|(?:[^()\\]|\\.)*\)\s*[+*{]`).test(p) || /\\[1-9]|\\k</.test(p)) {
    return { error: 'pattern could take too long to test (a repeated group that repeats or alternates inside, or a backreference): use a simpler one, e.g. "ready|listening" or "Error: .*"' };
  }
  try { return new RegExp(p); } catch (e) { return { error: `pattern is not a valid regular expression: ${(e as Error).message}` }; }
}
const MONITOR_LINE_MAX = 4000;

const age = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

function tasksOf(ctx: ToolContext): TaskService | undefined { return ctx.services?.tasks; }
const UNAVAILABLE = { content: 'Background tasks are not available here.', is_error: true };

export const taskListTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: {
    name: 'task_list',
    description: 'List this session\'s background tasks: shells started with bash run_in_background, background sub-agents, background workflows and monitors - id, kind, status, age and the last line of output.',
    input_schema: { type: 'object', properties: {} },
  },
  summarize: () => 'list tasks',
  async run(_input, ctx) {
    const svc = tasksOf(ctx);
    if (!svc) return UNAVAILABLE;
    const all = await svc.list();
    if (!all.length) return { content: 'No background tasks in this session.' };
    const now = Date.now();
    const lines = await Promise.all(all.map(async (t) => {
      const r = await t.read().catch(() => ({ text: '', size: 0 }));
      const last = r.text.trimEnd().split('\n').pop()?.trim().slice(0, 160) ?? '';
      return `${t.id}  ${t.kind}  ${t.status}  started ${age(now - t.startedAt)} ago${t.endedAt ? `, ran ${age(t.endedAt - t.startedAt)}` : ''}${t.cost ? `, $${t.cost.toFixed(4)}` : ''}  - ${t.description.slice(0, 100)}${last ? `\n    last: ${last}` : ''}`;
    }));
    return { content: lines.join('\n'), untrusted: all.some((t) => t.untrusted?.()) };
  },
};

const OUTPUT_MAX = 30_000;

export const taskOutputTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: {
    name: 'task_output',
    description: 'Read a background task\'s output: a shell\'s log, a sub-agent\'s report (or latest message while it works), a workflow\'s steps. tail: only the last N lines; offset: from this position on (the size is given, so you can read only what is new). Capped at 30,000 characters.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        tail: { type: 'number', description: 'Only the last N lines.' },
        offset: { type: 'number', description: 'Start here (the size a previous read reported).' },
        max_chars: { type: 'number' },
      },
      required: ['task_id'],
    },
  },
  summarize: (i) => `output of ${str(i.task_id)}`,
  async run(input, ctx) {
    const svc = tasksOf(ctx);
    if (!svc) return UNAVAILABLE;
    const t = svc.get(str(input.task_id));
    if (!t) return { content: `No task ${str(input.task_id)}. task_list shows them.`, is_error: true };
    await t.refresh?.();
    const r = await t.read(Math.max(0, num(input.offset) ?? 0));
    let text = r.text;
    const tail = num(input.tail);
    if (tail !== undefined && tail > 0) text = text.split('\n').slice(-Math.floor(tail) - (text.endsWith('\n') ? 1 : 0)).join('\n');
    const max = Math.min(OUTPUT_MAX, Math.max(500, num(input.max_chars) ?? OUTPUT_MAX));
    const head = `[${t.id}: ${t.kind}, ${t.status}; size ${r.size}]`;
    return { content: `${head}\n${clip(text.trimEnd(), max, 'use tail or offset') || '(no output yet)'}`, untrusted: t.untrusted?.() };
  },
};

export const taskStopTool: Tool = {
  // Stopping work the agent itself started takes nothing away from anyone.
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'task_stop',
    description: 'Stop a background task by id: a background shell (its whole process tree), a sub-agent, a workflow run or a monitor.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  summarize: (i) => `stop ${str(i.task_id)}`,
  async run(input, ctx) {
    const svc = tasksOf(ctx);
    if (!svc) return UNAVAILABLE;
    try { return { content: await svc.stop(str(input.task_id)) }; } catch (e) { return { content: (e as Error).message, is_error: true }; }
  },
};

const WAIT_DEFAULT = 60_000;
const WAIT_MAX = 600_000;
const BG_DEFAULT = 1_800_000;
const BG_MAX = 3_600_000;

export const monitorTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: {
    name: 'monitor',
    description: 'Wait for a background task without spending anything while waiting: until a line of a shell\'s output matches `pattern` (a regex, e.g. "listening on|error"), or until the task ends, or the timeout (default 60s, max 600s). Only output from now on is searched unless include_existing is true. With run_in_background it returns at once and you get a reminder when it fires (timeout default 30 min, max 60).',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        pattern: { type: 'string', description: 'A regular expression matched against each output line. Omit to wait for the task to end.' },
        timeout_ms: { type: 'number' },
        include_existing: { type: 'boolean', description: 'Also search the output written before this call.' },
        run_in_background: { type: 'boolean' },
      },
      required: ['task_id'],
    },
  },
  summarize: (i) => `${bool(i.run_in_background) ? '[background] ' : ''}watch ${str(i.task_id)}${str(i.pattern) ? ` for /${str(i.pattern)}/` : ' until it ends'}`,
  async run(input, ctx) {
    const svc = tasksOf(ctx);
    if (!svc) return UNAVAILABLE;
    const t = svc.get(str(input.task_id));
    if (!t) return { content: `No task ${str(input.task_id)}. task_list shows them.`, is_error: true };
    const p = str(input.pattern) ? regex(str(input.pattern)) : undefined;
    if (p && !(p instanceof RegExp)) return { content: p.error, is_error: true };
    const background = bool(input.run_in_background);
    if (background) {
      if (!svc.monitorInBackground) return { content: 'Background monitors are the main agent\'s; wait here with a timeout instead.', is_error: true };
      const ms = Math.min(BG_MAX, Math.max(1000, num(input.timeout_ms) ?? BG_DEFAULT));
      const id = await svc.monitorInBackground(t, p, ms, bool(input.include_existing));
      return { content: `Monitor ${id} is watching ${t.id}${p ? ` for /${p.source}/` : ' until it ends'} (up to ${age(ms)}). You will get a reminder when it fires; keep working.` };
    }
    const ms = Math.min(WAIT_MAX, Math.max(100, num(input.timeout_ms) ?? WAIT_DEFAULT));
    const from = bool(input.include_existing) ? 0 : (await t.read(Number.MAX_SAFE_INTEGER)).size;
    const r = await watchTask(t, p, ms, ctx.signal, from);
    return { content: describeWatch(t.id, p, r, ms), untrusted: t.untrusted?.() };
  },
};

export function describeWatch(id: string, p: RegExp | undefined, r: WatchResult, ms: number): string {
  const tail = r.tail ? `\nRecent output:\n${clip(r.tail, 4000)}` : '';
  if (r.fired === 'match') return `${id} printed a line matching /${p!.source}/:\n${r.line!.slice(0, 2000)}${tail}`;
  if (r.fired === 'exit') return `${id} ended (${r.status})${p ? ` without a line matching /${p.source}/` : ''}.${tail}`;
  if (r.fired === 'aborted') return `Stopped watching ${id}.`;
  if (r.fired === 'slow') return `Stopped watching ${id}: /${p!.source}/ took too long to test on one of its lines. Use a simpler pattern.${tail}`;
  return `Timed out after ${age(ms)} watching ${id} (still ${r.status})${p ? `: no line matched /${p.source}/` : ''}.${tail}`;
}

export const sendMessageTool: Tool = {
  // Like the agent tool: it runs a sub-agent whose every call is checked.
  kind: 'meta', parallelSafe: true, remoteable: false,
  spec: {
    name: 'send_message',
    description: 'Continue a sub-agent you started (by its id, e.g. general-2), with its context intact: a follow-up question, a correction, the next piece of work. A finished agent runs again and you get its new report (with run_in_background, later as a reminder). A background agent still working sees the message at its next step. The last 20 finished sub-agents of the session are kept.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'The agent id.' },
        message: { type: 'string' },
        run_in_background: { type: 'boolean' },
      },
      required: ['to', 'message'],
    },
  },
  summarize: (i) => `${bool(i.run_in_background) ? '[background] ' : ''}message ${str(i.to)}: ${str(i.message).slice(0, 80)}`,
  async run(input, ctx) {
    const svc = tasksOf(ctx);
    if (!svc?.sendMessage) return { content: 'Sub-agents cannot be continued from here.', is_error: true };
    if (!str(input.message).trim()) return { content: 'message is empty', is_error: true };
    try { return { content: await svc.sendMessage(str(input.to), str(input.message), bool(input.run_in_background), ctx.signal) }; } catch (e) { return { content: (e as Error).message, is_error: true }; }
  },
};

export const TASK_TOOLS: Tool[] = [monitorTool, sendMessageTool, taskListTool, taskOutputTool, taskStopTool];
