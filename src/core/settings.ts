import fs from 'node:fs/promises';
import path from 'node:path';
import type { Rules } from './permissions.ts';

/**
 * Lifecycle points a hook can run at (the matcher, where there is one, is a tool or
 * agent name). PreToolUse, PermissionRequest, UserPromptSubmit and Stop can block or
 * decide; the others observe (and can add feedback where there is a model to read it).
 */
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'StopFailure',
] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/**
 * One hook. type "command" (the default): a shell command on the session's host, the
 * event as JSON on stdin; "http": a POST of that JSON to a URL; "prompt": a small model
 * judges the event against an instruction and answers ok or not.
 */
export interface HookSpec {
  type?: 'command' | 'http' | 'prompt';
  matcher?: string;
  command?: string;
  url?: string;
  /** http: headers; "${VAR}" is read from the server's environment (operator settings only). */
  headers?: Record<string, string>;
  /** prompt: what to check, e.g. "Allow only read-only git commands". */
  prompt?: string;
  /** prompt: the model that judges (default: the session's sub-agent model). */
  model?: string;
  timeoutMs?: number;
}

export interface Settings {
  permissions: Rules;
  hooks: Partial<Record<HookEvent, HookSpec[]>>;
  /** Model calls per user turn before the harness stops and reports. */
  maxSteps: number;
  /** Spend cap per session in USD; the loop stops when it is reached. */
  maxCostUsd: number;
  /** Overrides the model's compaction threshold (prompt tokens). */
  compactAt?: number;
  /** Model for sub-agents; defaults to the session's model. */
  subagentModel?: string;
  /** Model that checks calls in auto mode; defaults to the sub-agent model. */
  autoModel?: string;
  /** How deep sub-agents may start their own (1: they cannot; at most 3, as Claude Code). */
  maxSubagentDepth: number;
  /** Sub-agents running at once in a session; more wait their turn. */
  maxParallelSubagents: number;
  /** Run blocking quality gates when the agent tries to finish, and send it back if any fail. */
  gatesOnStop?: boolean;
}

export const defaultSettings = (): Settings => ({
  permissions: { allow: [], deny: [], ask: [] },
  hooks: {},
  maxSteps: Number(process.env.HARNESS_MAX_STEPS ?? 150),
  maxCostUsd: Number(process.env.HARNESS_MAX_COST_USD ?? 5),
  maxSubagentDepth: Math.min(3, Math.max(1, Number(process.env.HARNESS_SUBAGENT_DEPTH ?? 1) || 1)),
  maxParallelSubagents: Math.min(20, Math.max(1, Number(process.env.HARNESS_SUBAGENTS_PARALLEL ?? 10) || 10)),
  ...(process.env.HARNESS_COMPACT_AT ? { compactAt: Number(process.env.HARNESS_COMPACT_AT) } : {}),
  ...(process.env.HARNESS_SUBAGENT_MODEL ? { subagentModel: process.env.HARNESS_SUBAGENT_MODEL } : {}),
  ...(process.env.HARNESS_AUTO_MODEL ? { autoModel: process.env.HARNESS_AUTO_MODEL } : {}),
  ...(process.env.HARNESS_GATES_ON_STOP === '1' ? { gatesOnStop: true } : {}),
});

/**
 * The operator's settings for every session (Claude Code's "managed" level):
 * HARNESS_SETTINGS names a JSON file with permissions, hooks of any type, and
 * limits. They come first and a project can never loosen them. A file that is
 * named but cannot be read is an error: silently running without the operator's
 * deny rules would be worse than not starting.
 */
export async function operatorSettings(env: NodeJS.ProcessEnv = process.env): Promise<Settings> {
  const base = defaultSettings();
  const file = env.HARNESS_SETTINGS?.trim();
  if (!file) return base;
  const j = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<Settings>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  base.permissions = { allow: list(j.permissions?.allow), deny: list(j.permissions?.deny), ask: list(j.permissions?.ask) };
  for (const [ev, specs] of Object.entries(j.hooks ?? {})) {
    if (!(HOOK_EVENTS as readonly string[]).includes(ev)) throw new Error(`${file}: unknown hook event "${ev}" (known: ${HOOK_EVENTS.join(', ')})`);
    if (Array.isArray(specs)) base.hooks[ev as HookEvent] = specs.filter((h) => h && typeof h === 'object');
  }
  if (typeof j.maxSteps === 'number') base.maxSteps = j.maxSteps;
  if (typeof j.maxCostUsd === 'number') base.maxCostUsd = j.maxCostUsd;
  if (typeof j.maxSubagentDepth === 'number') base.maxSubagentDepth = Math.min(3, Math.max(1, Math.floor(j.maxSubagentDepth)));
  if (typeof j.maxParallelSubagents === 'number') base.maxParallelSubagents = Math.min(20, Math.max(1, Math.floor(j.maxParallelSubagents)));
  if (typeof j.compactAt === 'number') base.compactAt = j.compactAt;
  if (typeof j.subagentModel === 'string') base.subagentModel = j.subagentModel;
  if (typeof j.autoModel === 'string') base.autoModel = j.autoModel;
  if (typeof j.gatesOnStop === 'boolean') base.gatesOnStop = j.gatesOnStop;
  return base;
}

/**
 * Project settings come from <workspace>/.harness/settings.json. They are
 * repository content: rules can only ADD deny/ask entries and hooks only run
 * where the session trusts project hooks (in the sandbox, by default).
 */
export async function loadProjectSettings(root: string): Promise<Partial<Settings>> {
  try {
    const raw = await fs.readFile(path.join(root, '.harness', 'settings.json'), 'utf8');
    const j = JSON.parse(raw) as Partial<Settings>;
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

export function mergeSettings(base: Settings, project: Partial<Settings>, trustProject: boolean): Settings {
  const p = project.permissions;
  const s: Settings = {
    ...base,
    permissions: {
      allow: [...base.permissions.allow, ...(trustProject && Array.isArray(p?.allow) ? p.allow : [])],
      deny: [...base.permissions.deny, ...(Array.isArray(p?.deny) ? p.deny : [])],
      ask: [...base.permissions.ask, ...(Array.isArray(p?.ask) ? p.ask : [])],
    },
    hooks: { ...base.hooks },
    // Gates run the project's own commands (npm test, ...): a project may switch this on only when it is trusted.
    gatesOnStop: base.gatesOnStop ?? (trustProject && project.gatesOnStop === true),
  };
  // Operator hooks always run; the project's run in addition, when trusted - and
  // only as commands on the session's host. An http hook runs on the server (it could
  // reach internal addresses, and its headers read the server's environment), and a
  // prompt hook spends the operator's money: those are the operator's to configure.
  if (trustProject && project.hooks && typeof project.hooks === 'object') {
    for (const [ev, specs] of Object.entries(project.hooks)) {
      if (!Array.isArray(specs) || !(HOOK_EVENTS as readonly string[]).includes(ev)) continue;
      const k = ev as HookEvent;
      const commands = specs.filter((h): h is HookSpec => !!h && typeof h === 'object' && (h.type ?? 'command') === 'command' && typeof h.command === 'string');
      s.hooks[k] = [...(s.hooks[k] ?? []), ...commands.map((h) => ({ ...h, type: 'command' as const }))];
    }
  }
  return s;
}
