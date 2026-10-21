import type { InProcessHook } from '../kernel/registry.ts';
import type { ToolHost } from '../runtime/host.ts';
import type { HookEvent, HookSpec, Settings } from './settings.ts';

// Hooks are deterministic steps the model cannot skip: a formatter after every
// edit, a test gate before the agent may stop, a policy check before a command,
// a message to a chat channel when the agent needs a person.
// Every kind has one contract - proceed, block with a reason, or (for
// PermissionRequest) decide the prompt:
//   - command hooks: a command on the session's host with the event as JSON on
//     stdin. Exit 0 = proceed (stdout becomes feedback, or JSON {"decision":
//     "allow"|"deny"|"block", "reason"}); exit 2 = block, stderr is the reason
//     the model sees; other codes are reported and ignored.
//   - http hooks: the event POSTed as JSON; a 2xx answer may carry the same JSON
//     ({"decision", "reason"} or {"block": true, "feedback"}); anything else is
//     reported and ignored.
//   - prompt hooks: a small model reads the event and an instruction and answers
//     {"ok": true|false, "reason"}; not ok blocks (denies, for PermissionRequest),
//     ok allows.
//   - in-process hooks (trusted code plugins): a function returning
//     { block?, feedback?, decision? }.

export interface HookResult {
  blocked: boolean;
  feedback: string;
  errors: string[];
  /** PermissionRequest: a hook answered the prompt itself. Deny wins over allow. */
  decision?: 'allow' | 'deny';
}

/** Asks a model whether an event is acceptable under an instruction (prompt hooks). */
export type HookJudge = (instruction: string, event: Record<string, unknown>, model?: string, signal?: AbortSignal) => Promise<{ ok: boolean; reason?: string }>;

/** What the session lends hooks that need more than a shell: a judging model, MCP tools, a verifying agent. */
export interface HookRunners {
  judge?: HookJudge;
  mcp?(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: string; is_error?: boolean }>;
  agent?(instruction: string, event: Record<string, unknown>, agentName?: string, signal?: AbortSignal): Promise<{ ok: boolean; reason?: string }>;
}

function matches(matcher: string | undefined, name: string | undefined, errors: string[]): boolean {
  if (!matcher || name === undefined) return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name); } catch { errors.push(`bad hook matcher ${matcher}`); return false; }
}

/** {"decision": ..., "reason": ...} or {"block": true, "feedback": ...}, if the text is that JSON. */
function parseAnswer(text: string): { decision?: 'allow' | 'deny' | 'block'; reason?: string; feedback?: string } | undefined {
  const t = text.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const j = JSON.parse(t) as { decision?: string; reason?: string; block?: boolean; feedback?: string };
    const decision = j.block === true ? 'block' : ['allow', 'deny', 'block'].includes(String(j.decision)) ? j.decision as 'allow' | 'deny' | 'block' : undefined;
    return { decision, reason: typeof j.reason === 'string' ? j.reason : undefined, feedback: typeof j.feedback === 'string' ? j.feedback : undefined };
  } catch { return undefined; }
}

/** "${VAR}" in an http hook's headers, from the server's environment. */
const fillEnv = (v: string) => v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, n: string) => process.env[n] ?? '');

function apply(result: HookResult, event: HookEvent, a: { decision?: 'allow' | 'deny' | 'block'; reason?: string; feedback?: string }) {
  const why = (a.reason ?? a.feedback ?? '').slice(0, 4000);
  if (a.decision === 'block' || (a.decision === 'deny' && event !== 'PermissionRequest')) {
    result.blocked = true;
    result.feedback += (why || 'blocked by a hook') + '\n';
  } else if (a.decision === 'deny') {
    result.decision = 'deny';
    if (why) result.feedback += why + '\n';
  } else if (a.decision === 'allow') {
    if ((event === 'PermissionRequest' || event === 'PreToolUse') && result.decision !== 'deny') result.decision = 'allow';
    if (why) result.feedback += why + '\n';
  } else if (why) result.feedback += why + '\n';
}

async function runOne(h: HookSpec, event: HookEvent, payload: Record<string, unknown>, host: ToolHost, signal: AbortSignal | undefined, runners: HookRunners, result: HookResult): Promise<void> {
  const judge = runners.judge;
  const type = h.type ?? 'command';
  const body = JSON.stringify({ event, ...payload });
  const timeoutMs = h.timeoutMs ?? 60_000;
  if (type === 'command') {
    if (!h.command) return void result.errors.push(`${event} hook has no command`);
    const r = await host.exec(h.command, { timeoutMs, stdin: body, signal });
    if (r.code === 2) {
      result.blocked = true;
      result.feedback += (r.stderr || r.stdout).trim().slice(0, 4000) + '\n';
    } else if (r.code === 0) {
      const a = parseAnswer(r.stdout);
      if (a) apply(result, event, a);
      else if (r.stdout.trim()) result.feedback += r.stdout.trim().slice(0, 4000) + '\n';
    } else {
      result.errors.push(`${event} hook "${h.command}" exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    }
    return;
  }
  if (type === 'http') {
    if (!h.url || !/^https?:\/\//i.test(h.url)) return void result.errors.push(`${event} hook has no http(s) url`);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = fillEnv(String(v));
    try {
      const res = await fetch(h.url, { method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      const text = (await res.text()).slice(0, 64_000);
      if (!res.ok) return void result.errors.push(`${event} hook ${h.url} answered HTTP ${res.status}`);
      const a = parseAnswer(text);
      if (a) apply(result, event, a);
    } catch (e) {
      result.errors.push(`${event} hook ${h.url} failed: ${(e as Error).message}`);
    }
    return;
  }
  if (type === 'prompt') {
    if (!h.prompt) return void result.errors.push(`${event} prompt hook has no prompt`);
    if (!judge) return void result.errors.push(`${event} prompt hook: no model to ask here`);
    try {
      const v = await judge(h.prompt, { event, ...payload }, h.model, signal);
      apply(result, event, { decision: v.ok ? 'allow' : event === 'PermissionRequest' ? 'deny' : 'block', reason: v.reason });
    } catch (e) {
      result.errors.push(`${event} prompt hook failed: ${(e as Error).message}`);
    }
    return;
  }
  if (type === 'mcp_tool') {
    if (!h.server || !h.tool) return void result.errors.push(`${event} mcp_tool hook needs server and tool`);
    if (!runners.mcp) return void result.errors.push(`${event} mcp_tool hook: no MCP servers here`);
    try {
      const r = await runners.mcp(h.server, h.tool, { ...(h.arguments ?? {}), event: { event, ...payload } }, signal);
      if (r.is_error) return void result.errors.push(`${event} hook ${h.server}.${h.tool} failed: ${r.content.slice(0, 300)}`);
      const a = parseAnswer(r.content);
      if (a) apply(result, event, a);
      else if (r.content.trim()) result.feedback += r.content.trim().slice(0, 4000) + '\n';
    } catch (e) {
      result.errors.push(`${event} hook ${h.server}.${h.tool} failed: ${(e as Error).message}`);
    }
    return;
  }
  if (type === 'agent') {
    if (!h.prompt) return void result.errors.push(`${event} agent hook has no prompt`);
    if (!runners.agent) return void result.errors.push(`${event} agent hook: no agents here`);
    try {
      const v = await runners.agent(h.prompt, { event, ...payload }, h.agent, signal);
      apply(result, event, { decision: v.ok ? 'allow' : event === 'PermissionRequest' ? 'deny' : 'block', reason: v.reason });
    } catch (e) {
      result.errors.push(`${event} agent hook failed: ${(e as Error).message}`);
    }
    return;
  }
  result.errors.push(`${event} hook has an unknown type "${type}"`);
}

export async function runHooks(
  settings: Settings,
  host: ToolHost,
  event: HookEvent,
  payload: Record<string, unknown>,
  matchName?: string,
  signal?: AbortSignal,
  inProcess: InProcessHook[] = [],
  runners?: HookRunners | HookJudge,
): Promise<HookResult> {
  const r0: HookRunners = typeof runners === 'function' ? { judge: runners } : runners ?? {};
  const specs: HookSpec[] = settings.hooks[event] ?? [];
  const result: HookResult = { blocked: false, feedback: '', errors: [] };
  for (const h of specs) {
    if (!h || typeof h !== 'object' || !matches(h.matcher, matchName, result.errors)) continue;
    await runOne(h, event, payload, host, signal, r0, result);
  }
  for (const h of inProcess) {
    if (h.event !== event || !matches(h.matcher, matchName, result.errors)) continue;
    try {
      const r = await h.handler({ event, ...payload }, { host, signal: signal ?? new AbortController().signal });
      if (r?.block) result.blocked = true;
      if (r?.decision === 'allow' || r?.decision === 'deny') apply(result, event, { decision: r.decision });
      if (r?.feedback) result.feedback += r.feedback.slice(0, 4000) + '\n';
    } catch (err) {
      result.errors.push(`${event} hook from ${h.plugin} failed: ${(err as Error).message}`);
    }
  }
  result.feedback = result.feedback.trim();
  return result;
}

/** Hooks that only observe (SessionEnd, Notification, ...): run them without holding anything up; problems are logged. */
export function fireHooks(settings: Settings | undefined, host: ToolHost | undefined, event: HookEvent, payload: Record<string, unknown>, inProcess: InProcessHook[] = [], log?: (m: string) => void): void {
  if (!settings || !host) return;
  if (!(settings.hooks[event]?.length) && !inProcess.some((h) => h.event === event)) return;
  runHooks(settings, host, event, payload, undefined, undefined, inProcess)
    .then((r) => { for (const e of r.errors) log?.(e); })
    .catch((e) => log?.(`${event} hooks failed: ${(e as Error).message}`));
}
