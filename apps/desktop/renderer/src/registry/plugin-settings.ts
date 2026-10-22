/**
 * A frame's own settings (settings.get / settings.set) across its sections' scopes: `app` values
 * live on this computer (prefs), `account` values with the person's account on the server
 * (/api/me/settings `plugins`), `operator` values are the operator's and read-only. A key belongs
 * to the section whose schema names it; the scope is enforced here and again by the server.
 * Pure: unit-tested in test/desktop-plugin-followups.test.ts.
 */

import { validateValue, type JsonSchema, type UiManifest } from '@harness/plugin-ui';

export type SettingScope = 'app' | 'account' | 'operator';
export type SettingKeys = Map<string, { scope: SettingScope; schema: JsonSchema }>;

/** Each declared key's scope and schema (the first section that names it wins). */
export function settingKeys(ui: UiManifest | undefined): SettingKeys {
  const out: SettingKeys = new Map();
  for (const s of ui?.contributes.settings ?? []) {
    for (const [k, schema] of Object.entries(s.schema?.properties ?? {})) if (!out.has(k)) out.set(k, { scope: s.scope, schema });
  }
  return out;
}

/** Whether the plugin has account-scope keys (the host then reads the account's values). */
export const hasAccountKeys = (keys: SettingKeys): boolean => [...keys.values()].some((k) => k.scope === 'account');

/**
 * What settings.get answers: account keys from the account (falling back to a value this computer
 * kept before the key moved to the account), every other key from this computer.
 */
export function mergedSettings(keys: SettingKeys, app: Record<string, unknown>, account: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(app)) if (keys.get(k)?.scope !== 'account' || !Object.hasOwn(account, k)) out[k] = v;
  for (const [k, v] of Object.entries(account)) if (keys.get(k)?.scope === 'account') out[k] = v;
  return out;
}

/** Where settings.set writes a key, or why it may not: operator keys are read-only; an account value must fit its schema. */
export function settingWrite(keys: SettingKeys, key: string, value: unknown): { target: 'app' | 'account' } | { error: string } {
  const k = keys.get(key);
  if (!k) return { target: 'app' };
  if (k.scope === 'operator') return { error: `"${key}" is set by the operator` };
  if (k.scope === 'account') {
    const problems = value === null || value === undefined ? [] : validateValue(k.schema, value, key);
    return problems.length ? { error: problems.slice(0, 4).join('; ') } : { target: 'account' };
  }
  return { target: 'app' };
}
