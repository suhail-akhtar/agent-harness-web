import type { JsonSchema } from '../../packages/plugin-ui/src/manifest.ts';
import type { PluginEntry } from '../kernel/harness.ts';
import { applyUserSettings, loadProjectSettings, loadUserSettings, operatorSettings, type Settings, type UserSettings } from '../core/settings.ts';

// The settings in force for one person, each with where its value comes from, so a
// settings page can show what is theirs to change and what is locked:
//   default   the harness's own value
//   operator  the server's environment or settings file (HARNESS_SETTINGS); never changed through the API
//   account   the person's own (PUT /api/me/settings): rules add up, limits only go lower
//   project   the workspace's .harness/settings.json (with ?session=)
// Plugins' account-scope sections (their ui manifests' schemas) come with them, by plugin.

export type Tier = 'default' | 'operator' | 'account' | 'project';

export interface EffectiveSetting {
  key: string;
  value: unknown;
  source: Tier;
  /** Where it can be changed through the API: 'account' (PUT /api/me/settings), or nowhere ('operator': the server's configuration). */
  scope: 'account' | 'operator';
  /** The person cannot change it (operator-only, or a plugin's operator section). */
  locked: boolean;
  /** Limits: the most the person may set (the operator's value). */
  max?: number;
  /** Each tier's own value, where it has one. */
  layers: Partial<Record<Tier, unknown>>;
  /** A plugin's settings section the key belongs to. */
  plugin?: string;
  section?: string;
}

/** The harness's own defaults, before the environment (what defaultSettings gives with no HARNESS_* set). */
const BUILTIN = { maxSteps: 150, maxCostUsd: 5, maxTurnMinutes: 0, maxSubagentDepth: 1, maxParallelSubagents: 10, gatesOnStop: false } as const;

export async function effectiveSettings(o: { dataDir: string; owner: string | undefined; workspace?: string; plugins: PluginEntry[] }): Promise<{ settings: EffectiveSetting[]; project: boolean }> {
  const op = await operatorSettings();
  const user = await loadUserSettings(o.dataDir, o.owner);
  const eff = applyUserSettings(op, user);
  const project = o.workspace ? await loadProjectSettings(o.workspace).catch(() => ({} as Partial<Settings>)) : undefined;
  const out: EffectiveSetting[] = [];

  // Limits: the operator's (or the default), lowered by the person's own.
  for (const k of ['maxSteps', 'maxCostUsd', 'maxTurnMinutes'] as const) {
    const mine = user[k];
    const value = eff[k];
    const source: Tier = mine !== undefined && value === mine && mine !== op[k] ? 'account' : op[k] !== BUILTIN[k] ? 'operator' : 'default';
    out.push({ key: k, value, source, scope: 'account', locked: false, ...(op[k] > 0 ? { max: op[k] } : {}), layers: { default: BUILTIN[k], ...(op[k] !== BUILTIN[k] ? { operator: op[k] } : {}), ...(mine !== undefined ? { account: mine } : {}) } });
  }
  // The operator's alone.
  for (const k of ['maxSubagentDepth', 'maxParallelSubagents', 'compactAt', 'subagentModel', 'autoModel'] as const) {
    const v = op[k];
    const d = (BUILTIN as Record<string, unknown>)[k];
    out.push({ key: k, value: v ?? null, source: v !== undefined && v !== d ? 'operator' : 'default', scope: 'operator', locked: true, layers: { ...(d !== undefined ? { default: d } : {}), ...(v !== undefined && v !== d ? { operator: v } : {}) } });
  }
  // Delegation to other models: what the person allows, within the operator's cap; linked sessions: the person's choices.
  out.push({ key: 'delegation', value: eff.delegation, source: user.delegation ? 'account' : op.delegation?.allowedModels !== '*' ? 'operator' : 'default', scope: 'account', locked: false, layers: { default: { allowedModels: [] }, ...(op.delegation?.allowedModels !== '*' || op.delegation?.maxCostUsd !== undefined ? { operator: op.delegation } : {}), ...(user.delegation ? { account: user.delegation } : {}) } });
  out.push({ key: 'linkedSessions', value: { autoContinue: true, maxAutoContinues: 5, ...user.linkedSessions }, source: user.linkedSessions ? 'account' : 'default', scope: 'account', locked: false, layers: { default: { autoContinue: true, maxAutoContinues: 5 }, ...(user.linkedSessions ? { account: user.linkedSessions } : {}) } });
  const gates = op.gatesOnStop ?? (project?.gatesOnStop === true ? true : undefined);
  out.push({ key: 'gatesOnStop', value: gates ?? false, source: op.gatesOnStop !== undefined ? 'operator' : project?.gatesOnStop === true ? 'project' : 'default', scope: 'operator', locked: true, layers: { default: false, ...(op.gatesOnStop !== undefined ? { operator: op.gatesOnStop } : {}), ...(project?.gatesOnStop !== undefined ? { project: project.gatesOnStop } : {}) } });
  // Rules add up: every tier's list, the value their union; the source is the tier with the strongest say (operator first).
  for (const k of ['deny', 'ask', 'allow'] as const) {
    const layers: Partial<Record<Tier, string[]>> = {};
    if (op.permissions[k].length) layers.operator = op.permissions[k];
    if (user.permissions[k].length) layers.account = user.permissions[k];
    const pr = project?.permissions?.[k];
    if (Array.isArray(pr) && pr.length) layers.project = pr;
    const value = [...(layers.operator ?? []), ...(layers.account ?? []), ...(layers.project ?? [])];
    out.push({ key: `permissions.${k}`, value, source: layers.operator ? 'operator' : layers.account ? 'account' : layers.project ? 'project' : 'default', scope: 'account', locked: false, layers });
  }
  const hookEvents = Object.entries(op.hooks).filter(([, v]) => v?.length).map(([ev, v]) => `${ev} (${v!.length})`);
  out.push({ key: 'hooks', value: hookEvents, source: hookEvents.length ? 'operator' : 'default', scope: 'operator', locked: true, layers: hookEvents.length ? { operator: hookEvents } : {} });

  // Plugins' settings sections: the person's values for account ones, the schema's defaults otherwise.
  for (const p of o.plugins) {
    if (!p.enabled || !p.ui) continue;
    for (const sec of p.ui.contributes.settings) {
      if (sec.scope === 'app' || !sec.schema?.properties) continue;
      const mine = sec.scope === 'account' ? pluginValues(user, p.name) : {};
      for (const [prop, schema] of Object.entries(sec.schema.properties as Record<string, JsonSchema>)) {
        const has = Object.hasOwn(mine, prop);
        out.push({
          key: `plugins.${p.name}.${prop}`, value: has ? mine[prop] : schema.default ?? null, source: has ? 'account' : 'default',
          scope: sec.scope === 'account' ? 'account' : 'operator', locked: sec.scope !== 'account', plugin: p.name, section: sec.id,
          layers: { ...(schema.default !== undefined ? { default: schema.default } : {}), ...(has ? { account: mine[prop] } : {}) },
        });
      }
    }
  }
  return { settings: out, project: !!project };
}

const pluginValues = (u: UserSettings, plugin: string): Record<string, unknown> => u.plugins?.[plugin] ?? {};
