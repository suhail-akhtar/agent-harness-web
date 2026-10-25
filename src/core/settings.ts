import fs from 'node:fs/promises';
import path from 'node:path';
import type { Rules } from './permissions.ts';
import { writeFileAtomic } from '../util/shared-file.ts';
import { cleanProgressReview, defaultProgressReview, type ProgressReviewSettings } from './progress.ts';

/**
 * Lifecycle points a hook can run at (the matcher, where there is one, is a tool or
 * agent name, or for FileChanged the file's path). PreToolUse, PermissionRequest,
 * UserPromptSubmit, Stop and TaskCompleted can block or decide; the others observe
 * (and can add feedback where there is a model to read it).
 * Claude Code's CwdChanged has no counterpart: every command here runs in a fresh
 * shell started in the workspace, so the working directory never changes between calls.
 */
export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'Stop', 'StopFailure',
  'InstructionsLoaded', 'ConfigChange', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'TaskCreated', 'TaskCompleted',
] as const;
export type HookEvent = typeof HOOK_EVENTS[number];

/**
 * One hook. type "command" (the default): a shell command on the session's host, the
 * event as JSON on stdin; "http": a POST of that JSON to a URL; "prompt": a small model
 * judges the event against an instruction and answers ok or not.
 */
export interface HookSpec {
  type?: 'command' | 'http' | 'prompt' | 'mcp_tool' | 'agent';
  matcher?: string;
  command?: string;
  url?: string;
  /** http: headers; "${VAR}" is read from the server's environment (operator settings only). */
  headers?: Record<string, string>;
  /** prompt: what to check, e.g. "Allow only read-only git commands". */
  prompt?: string;
  /** prompt: the model that judges (default: the session's sub-agent model). */
  model?: string;
  /** mcp_tool: the connected MCP server and its tool, called with the event (plus `arguments`). */
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  /** agent: which agent verifies (default: explore, read-only); `prompt` is its instruction. */
  agent?: string;
  timeoutMs?: number;
  /** Set by the harness on hooks from the repository's .harness/settings.json: their "allow" answers are ignored. */
  fromProject?: boolean;
}

export interface Settings {
  permissions: Rules;
  hooks: Partial<Record<HookEvent, HookSpec[]>>;
  /** Model calls per user turn before the progress checkpoint (with progressReview off: before the harness stops and reports). */
  maxSteps: number;
  /** What happens at maxSteps: on track extends, stuck stops or restarts fresh (see progress.ts). */
  progressReview: ProgressReviewSettings;
  /** Model for progress reviews; defaults to the agent's own model. */
  reviewModel?: string;
  /** Spend cap per session in USD; the loop stops when it is reached. */
  maxCostUsd: number;
  /** Wall-clock minutes one turn may run before the loop stops and reports (0: no limit). */
  maxTurnMinutes: number;
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
  /**
   * Which models agents may hand work to (sub-agents, linked sessions, workflow nodes with a
   * model): the operator's cap, then (applyUserSettings) what the person allows within it.
   * Data goes to that model's company: only with consent. Default: the session's own model.
   */
  delegation?: Delegation;
  /** Linked sessions (start_session and friends): the person's choices. */
  linkedSessions?: LinkedSessionSettings;
  /** Token and cache savings, each a switch (README "Efficiency"; measured in evals/results/2026-10-24-efficiency.md). */
  efficiency: EfficiencySettings;
  /** Prompt caching on Anthropic: the TTL of the stable prefix (tools and system prompt). */
  promptCaching: PromptCachingSettings;
}

export interface EfficiencySettings {
  /** Plugin tools' schemas wait behind load_tools (one line per plugin) until the session uses them (HARNESS_DEFER_PLUGIN_TOOLS). */
  deferPluginTools: boolean;
  /** Tool output too long for the context is kept whole in a session file (head and tail shown) instead of cut (HARNESS_SPILL). */
  spill: boolean;
  /** Non-Anthropic models: old tool output is masked in rare large batches, never the last 8 steps (HARNESS_MASK_BATCHED); off: the older 60% rule. */
  batchedMasking: boolean;
  /** Which part of the prompt changed when the provider's cache missed: trace, debug event, session stats (HARNESS_CACHE_ATTRIBUTION). */
  cacheAttribution: boolean;
}

/** '5m': the default ephemeral TTL; '1h': the stable prefix for an hour (writes cost 2x input instead of 1.25x); 'auto': 1h once a tool call has run past 4 minutes. */
export interface PromptCachingSettings { prefixTtl: '5m' | '1h' | 'auto' }

const onOff = (v: string | undefined, dflt: boolean) => (v === undefined || v === '' ? dflt : !/^(off|0|false|no)$/i.test(v.trim()));
const TTLS = ['5m', '1h', 'auto'] as const;

/** The efficiency switches: HARNESS_* variables over the defaults. */
export function defaultEfficiency(env: NodeJS.ProcessEnv = process.env): EfficiencySettings {
  return {
    deferPluginTools: onOff(env.HARNESS_DEFER_PLUGIN_TOOLS, true),
    spill: onOff(env.HARNESS_SPILL, true),
    batchedMasking: onOff(env.HARNESS_MASK_BATCHED, true),
    cacheAttribution: onOff(env.HARNESS_CACHE_ATTRIBUTION, true),
  };
}

export function defaultPromptCaching(env: NodeJS.ProcessEnv = process.env): PromptCachingSettings {
  const t = env.HARNESS_PREFIX_TTL?.trim().toLowerCase();
  return { prefixTtl: (TTLS as readonly string[]).includes(t ?? '') ? t as PromptCachingSettings['prefixTtl'] : 'auto' };
}

/** An operator file's efficiency section over `base` (booleans only; unknown keys ignored). */
function cleanEfficiency(v: unknown, base: EfficiencySettings): EfficiencySettings {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return base;
  const o = v as Record<string, unknown>;
  const out = { ...base };
  for (const k of Object.keys(base) as (keyof EfficiencySettings)[]) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

export interface Delegation { allowedModels: string[] | '*'; maxCostUsd?: number; requireApproval?: boolean }
export interface LinkedSessionSettings { enabled?: boolean; autoContinue?: boolean; maxAutoContinues?: number }

/** A delegation setting from JSON: model ids (or "*"), a positive cost cap, a yes/no. */
export function cleanDelegation(v: unknown): Delegation | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const models = o.allowedModels === '*' ? '*' as const : Array.isArray(o.allowedModels) ? [...new Set(o.allowedModels.filter((m): m is string => typeof m === 'string' && /^[\w.:/-]{1,80}$/.test(m)))].slice(0, 50) : [];
  const out: Delegation = { allowedModels: models };
  if (typeof o.maxCostUsd === 'number' && Number.isFinite(o.maxCostUsd) && o.maxCostUsd > 0) out.maxCostUsd = o.maxCostUsd;
  if (o.requireApproval === true) out.requireApproval = true;
  return out;
}

function cleanLinked(v: unknown): LinkedSessionSettings | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const out: LinkedSessionSettings = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (typeof o.autoContinue === 'boolean') out.autoContinue = o.autoContinue;
  if (typeof o.maxAutoContinues === 'number' && Number.isFinite(o.maxAutoContinues) && o.maxAutoContinues >= 0) out.maxAutoContinues = Math.min(50, Math.floor(o.maxAutoContinues));
  return Object.keys(out).length ? out : undefined;
}

export const defaultSettings = (): Settings => ({
  permissions: { allow: [], deny: [], ask: [] },
  hooks: {},
  maxSteps: Number(process.env.HARNESS_MAX_STEPS ?? 150),
  progressReview: defaultProgressReview(),
  ...(process.env.HARNESS_REVIEW_MODEL ? { reviewModel: process.env.HARNESS_REVIEW_MODEL } : {}),
  // Per conversation; 0 is no limit; anything unreadable keeps the default.
  maxCostUsd: ((n) => (Number.isFinite(n) && n >= 0 ? n : 5))(Number(process.env.HARNESS_MAX_COST_USD ?? 5)),
  maxTurnMinutes: Math.max(0, Number(process.env.HARNESS_MAX_TURN_MINUTES ?? 0) || 0),
  maxSubagentDepth: Math.min(3, Math.max(1, Number(process.env.HARNESS_SUBAGENT_DEPTH ?? 1) || 1)),
  maxParallelSubagents: Math.min(20, Math.max(1, Number(process.env.HARNESS_SUBAGENTS_PARALLEL ?? 10) || 10)),
  ...(process.env.HARNESS_COMPACT_AT ? { compactAt: Number(process.env.HARNESS_COMPACT_AT) } : {}),
  ...(process.env.HARNESS_SUBAGENT_MODEL ? { subagentModel: process.env.HARNESS_SUBAGENT_MODEL } : {}),
  ...(process.env.HARNESS_AUTO_MODEL ? { autoModel: process.env.HARNESS_AUTO_MODEL } : {}),
  ...(process.env.HARNESS_GATES_ON_STOP === '1' ? { gatesOnStop: true } : {}),
  // The operator's cap on delegation: HARNESS_DELEGATION_MODELS ("*" or a comma list); none by default.
  delegation: { allowedModels: process.env.HARNESS_DELEGATION_MODELS && process.env.HARNESS_DELEGATION_MODELS.trim() !== '*' ? process.env.HARNESS_DELEGATION_MODELS.split(',').map((m) => m.trim()).filter(Boolean) : '*' },
  efficiency: defaultEfficiency(),
  promptCaching: defaultPromptCaching(),
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
  const pr = cleanProgressReview((j as { progressReview?: unknown }).progressReview, base.progressReview);
  if (pr) base.progressReview = pr;
  if (typeof j.reviewModel === 'string') base.reviewModel = j.reviewModel;
  if (typeof j.maxTurnMinutes === 'number') base.maxTurnMinutes = Math.max(0, j.maxTurnMinutes);
  if (typeof j.maxSubagentDepth === 'number') base.maxSubagentDepth = Math.min(3, Math.max(1, Math.floor(j.maxSubagentDepth)));
  if (typeof j.maxParallelSubagents === 'number') base.maxParallelSubagents = Math.min(20, Math.max(1, Math.floor(j.maxParallelSubagents)));
  if (typeof j.compactAt === 'number') base.compactAt = j.compactAt;
  if (typeof j.subagentModel === 'string') base.subagentModel = j.subagentModel;
  if (typeof j.autoModel === 'string') base.autoModel = j.autoModel;
  if (typeof j.gatesOnStop === 'boolean') base.gatesOnStop = j.gatesOnStop;
  const d = cleanDelegation((j as { delegation?: unknown }).delegation);
  if (d) base.delegation = d;
  base.efficiency = cleanEfficiency((j as { efficiency?: unknown }).efficiency, base.efficiency);
  const ttl = (j as { promptCaching?: { prefixTtl?: unknown } }).promptCaching?.prefixTtl;
  if (typeof ttl === 'string' && (TTLS as readonly string[]).includes(ttl)) base.promptCaching = { prefixTtl: ttl as PromptCachingSettings['prefixTtl'] };
  return base;
}

/** Reads a workspace file by its workspace-relative path (null when absent). */
export type WorkspaceReader = (rel: string) => Promise<string | null>;

const parseJson = (raw: string | null): Partial<Settings> => {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw) as Partial<Settings>;
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
};

/**
 * Project settings come from <workspace>/.harness/settings.json, plus the
 * personal, gitignored .harness/settings.local.json stacked after it. Both are
 * workspace content and trusted alike: rules can only ADD deny/ask entries (and
 * allow entries when trusted) and hooks only run where the session trusts
 * project hooks (in the sandbox, by default). A companion's files are read
 * through the companion (pass a reader); a folder here, by path.
 */
export async function loadProjectSettings(src: string | WorkspaceReader): Promise<Partial<Settings>> {
  const read: WorkspaceReader = typeof src === 'string' ? (rel) => fs.readFile(path.join(src, rel), 'utf8').catch(() => null) : src;
  const [project, local] = await Promise.all([read('.harness/settings.json').catch(() => null), read('.harness/settings.local.json').catch(() => null)]);
  return stackProject(parseJson(project), parseJson(local));
}

/** Two project layers as one: lists concatenate (the second's entries after the first's). */
export function stackProject(a: Partial<Settings>, b: Partial<Settings>): Partial<Settings> {
  const list = (s: Partial<Settings>, k: keyof Rules) => (Array.isArray(s.permissions?.[k]) ? s.permissions[k].map(String) : []);
  const hooks: Partial<Record<HookEvent, HookSpec[]>> = {};
  for (const s of [a, b]) {
    for (const [ev, specs] of Object.entries(s.hooks && typeof s.hooks === 'object' ? s.hooks : {})) {
      if (Array.isArray(specs)) hooks[ev as HookEvent] = [...(hooks[ev as HookEvent] ?? []), ...specs];
    }
  }
  return {
    permissions: { allow: [...list(a, 'allow'), ...list(b, 'allow')], deny: [...list(a, 'deny'), ...list(b, 'deny')], ask: [...list(a, 'ask'), ...list(b, 'ask')] },
    hooks,
    ...(a.gatesOnStop === true || b.gatesOnStop === true ? { gatesOnStop: true } : {}),
  };
}

/**
 * A person's own settings (per account, kept under the data directory and changed
 * through /api/me/settings). Only what is safe for anyone to set: permission rules,
 * which apply to their own sessions, and limits, which can only be lowered. Never
 * hooks: a person's command would run on the server's host for a server folder,
 * and http or prompt hooks are the operator's to configure.
 */
export interface UserSettings {
  permissions: Rules; maxSteps?: number; maxCostUsd?: number; maxTurnMinutes?: number;
  /** Plugins' account-scope settings sections (their ui manifests' JSON Schemas), by plugin: values only, never code. */
  plugins?: Record<string, Record<string, unknown>>;
  /** Models agents may delegate to (default: only the session's own), within the operator's cap. */
  delegation?: Delegation;
  /** Linked sessions: on for sessions without a desktop or web client, auto-continue of an idle parent and its cap. */
  linkedSessions?: LinkedSessionSettings;
}

const PLUGIN_SETTINGS_MAX = 64 * 1024;

/** Where an account's own files live (settings, instructions); the single-user server is "default". */
export function accountDir(dataDir: string, owner: string | undefined): string {
  return path.join(dataDir, 'accounts', (owner ?? 'default').replace(/[^\w.@-]/g, '_').slice(0, 80) || 'default');
}

export function cleanUserSettings(j: unknown): UserSettings {
  const o = (j && typeof j === 'object' ? j : {}) as Record<string, unknown>;
  const p = (o.permissions && typeof o.permissions === 'object' ? o.permissions : {}) as Record<string, unknown>;
  const rules = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string' && !!r.trim() && r.length <= 500).map((r) => r.trim()).slice(0, 200) : []);
  const pos = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const out: UserSettings = { permissions: { allow: rules(p.allow), deny: rules(p.deny), ask: rules(p.ask) } };
  if (pos(o.maxSteps)) out.maxSteps = Math.floor(pos(o.maxSteps)!);
  if (pos(o.maxCostUsd)) out.maxCostUsd = pos(o.maxCostUsd);
  if (pos(o.maxTurnMinutes)) out.maxTurnMinutes = pos(o.maxTurnMinutes);
  if (o.plugins && typeof o.plugins === 'object' && !Array.isArray(o.plugins)) {
    const plugins = Object.fromEntries(Object.entries(o.plugins as Record<string, unknown>)
      .filter(([k, v]) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(k) && v && typeof v === 'object' && !Array.isArray(v))
      .slice(0, 100)) as Record<string, Record<string, unknown>>;
    if (Object.keys(plugins).length && JSON.stringify(plugins).length <= PLUGIN_SETTINGS_MAX) out.plugins = plugins;
  }
  const d = cleanDelegation(o.delegation);
  if (d) out.delegation = d;
  const l = cleanLinked(o.linkedSessions);
  if (l) out.linkedSessions = l;
  return out;
}

export async function loadUserSettings(dataDir: string, owner: string | undefined): Promise<UserSettings> {
  try { return cleanUserSettings(JSON.parse(await fs.readFile(path.join(accountDir(dataDir, owner), 'settings.json'), 'utf8'))); } catch { return cleanUserSettings({}); }
}

export async function saveUserSettings(dataDir: string, owner: string | undefined, raw: unknown): Promise<UserSettings> {
  const clean = cleanUserSettings(raw);
  // Plugins' sections are kept unless the body speaks of them (a page that edits only the core settings).
  if (!(raw && typeof raw === 'object' && 'plugins' in raw)) {
    const was = (await loadUserSettings(dataDir, owner)).plugins;
    if (was) clean.plugins = was;
  }
  await writeFileAtomic(path.join(accountDir(dataDir, owner), 'settings.json'), JSON.stringify(clean, null, 1));
  return clean;
}

/** The account's own instructions for every session (like Claude Code's ~/.claude/CLAUDE.md). */
export const USER_INSTRUCTIONS_MAX = 24_000;
export async function loadUserInstructions(dataDir: string, owner: string | undefined): Promise<string> {
  return fs.readFile(path.join(accountDir(dataDir, owner), 'instructions.md'), 'utf8').catch(() => '');
}
export async function saveUserInstructions(dataDir: string, owner: string | undefined, text: string): Promise<void> {
  if (text.length > USER_INSTRUCTIONS_MAX) throw new Error(`instructions are limited to ${USER_INSTRUCTIONS_MAX} characters`);
  await writeFileAtomic(path.join(accountDir(dataDir, owner), 'instructions.md'), text);
}

/**
 * The person's settings on top of the operator's: their rules are added (deny and
 * ask still beat allow, so an operator's deny or ask can never be loosened), and
 * their limits apply only where they are lower.
 */
export function applyUserSettings(base: Settings, u: UserSettings): Settings {
  // A person's limit applies where it is lower; where the operator has none (0), theirs is the limit.
  const lower = (b: number, v: number | undefined) => (v ? (b > 0 ? Math.min(b, v) : v) : b);
  return {
    ...base,
    // The operator's allow rules are remembered apart: only they hold after untrusted content (see decide()).
    permissions: { allow: [...base.permissions.allow, ...u.permissions.allow], deny: [...base.permissions.deny, ...u.permissions.deny], ask: [...base.permissions.ask, ...u.permissions.ask], operatorAllow: base.permissions.operatorAllow ?? [...base.permissions.allow] },
    maxSteps: lower(base.maxSteps, u.maxSteps),
    maxCostUsd: lower(base.maxCostUsd, u.maxCostUsd),
    // 0 is "no limit": a person may set one where the operator has none.
    maxTurnMinutes: u.maxTurnMinutes ? (base.maxTurnMinutes > 0 ? Math.min(base.maxTurnMinutes, u.maxTurnMinutes) : u.maxTurnMinutes) : base.maxTurnMinutes,
    delegation: effectiveDelegation(base.delegation, u.delegation),
    ...(u.linkedSessions ? { linkedSessions: u.linkedSessions } : {}),
  };
}

/**
 * What the person allows, within the operator's cap: the models both allow ("*" on both: any),
 * the lower cost cap, and approval when either asks for it. Without a choice of the person's,
 * no other model (an empty list: agents stay on the session's own model).
 */
export function effectiveDelegation(cap: Delegation | undefined, mine: Delegation | undefined): Delegation {
  const c = cap ?? { allowedModels: '*' as const };
  const u = mine ?? { allowedModels: [] };
  const models = u.allowedModels === '*' ? c.allowedModels : c.allowedModels === '*' ? u.allowedModels : u.allowedModels.filter((m) => (c.allowedModels as string[]).includes(m));
  const costs = [c.maxCostUsd, u.maxCostUsd].filter((x): x is number => typeof x === 'number');
  return { allowedModels: models, ...(costs.length ? { maxCostUsd: Math.min(...costs) } : {}), ...(c.requireApproval || u.requireApproval ? { requireApproval: true } : {}) };
}

export function mergeSettings(base: Settings, project: Partial<Settings>, trustProject: boolean): Settings {
  const p = project.permissions;
  const s: Settings = {
    ...base,
    permissions: {
      allow: [...base.permissions.allow, ...(trustProject && Array.isArray(p?.allow) ? p.allow : [])],
      // Only the operator's allow rules hold after untrusted content was read (see decide()).
      operatorAllow: base.permissions.operatorAllow ?? [...base.permissions.allow],
      // The repository's: they cover what the sandbox contains, never a call that leaves it.
      projectAllow: trustProject && Array.isArray(p?.allow) ? [...p.allow] : [],
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
      s.hooks[k] = [...(s.hooks[k] ?? []), ...commands.map((h) => ({ ...h, type: 'command' as const, fromProject: true }))];
    }
  }
  return s;
}
