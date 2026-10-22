/**
 * What changes in the window when the registry changes under it (a plugin switched on or off live,
 * installed or removed): nothing of a switched-off plugin may linger. Pure; the shell applies it.
 *
 *  - the page on screen belongs to a plugin that is gone: back home, and say why;
 *  - an open side panel of it closes; a settings section of it gives way to the first one;
 *  - its live values (badges, status item counts) go;
 *  - its keybindings, renderers, chips, themes and the rest need nothing: they are read from the
 *    registry, which no longer has them (a theme falls back to the default because the id no longer
 *    resolves; the preference is kept, so switching the plugin back on restores it, as do its grants
 *    and settings, which are never touched here).
 */

import type { Registry } from './registry.ts';

export interface WindowState {
  route: { view: string; params?: Record<string, string> };
  panel: { kind: string; panel?: string } | null;
  settingsSection: string | null;
  badges: Record<string, unknown>;
}

export interface Reconciled {
  /** Go home, because this plugin's page is gone (its name, for the note). */
  leaveView?: { plugin: string; label: string };
  closePanel?: boolean;
  settingsSection?: string | null;
  /** Live values whose owner is gone. */
  dropBadges: string[];
}

const pluginOf = (qid: string) => qid.slice(0, Math.max(0, qid.indexOf(':')));

export function reconcile(prev: Registry, next: Registry, s: WindowState): Reconciled {
  const out: Reconciled = { dropBadges: [] };
  const label = (name: string) => prev.plugins.find((p) => p.name === name)?.ui?.displayName ?? name;
  if (!next.views.has(s.route.view) && prev.views.has(s.route.view)) {
    const plugin = pluginOf(s.route.view);
    out.leaveView = { plugin, label: label(plugin) };
  }
  if (s.panel?.kind === 'plugin' && s.panel.panel && !next.panels.has(s.panel.panel)) out.closePanel = true;
  if (s.settingsSection && !next.settings.some((x) => x.qid === s.settingsSection)) out.settingsSection = next.settings[0]?.qid ?? null;
  const active = new Set(next.active.map((p) => p.name));
  for (const key of Object.keys(s.badges)) {
    // A badge is "<plugin>.<name>": the longest active plugin name it starts with owns it.
    const owner = [...prev.plugins.map((p) => p.name), ...next.plugins.map((p) => p.name)].filter((n) => key.startsWith(`${n}.`)).sort((a, b) => b.length - a.length)[0];
    if (owner && !active.has(owner)) out.dropBadges.push(key);
  }
  return out;
}
