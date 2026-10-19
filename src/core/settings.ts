import fs from 'node:fs/promises';
import path from 'node:path';
import type { Rules } from './permissions.ts';

export type HookEvent = 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
export interface HookSpec { matcher?: string; command: string; timeoutMs?: number }

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
}

export const defaultSettings = (): Settings => ({
  permissions: { allow: [], deny: [], ask: [] },
  hooks: {},
  maxSteps: Number(process.env.HARNESS_MAX_STEPS ?? 150),
  maxCostUsd: Number(process.env.HARNESS_MAX_COST_USD ?? 5),
  ...(process.env.HARNESS_COMPACT_AT ? { compactAt: Number(process.env.HARNESS_COMPACT_AT) } : {}),
  ...(process.env.HARNESS_SUBAGENT_MODEL ? { subagentModel: process.env.HARNESS_SUBAGENT_MODEL } : {}),
});

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
    hooks: trustProject && project.hooks && typeof project.hooks === 'object' ? project.hooks : base.hooks,
  };
  return s;
}
