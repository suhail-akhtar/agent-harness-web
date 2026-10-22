/**
 * The registry: every contribution from every enabled plugin, resolved once into what the shell
 * draws. The built-in features are plugins here exactly like third-party ones (trust "native"); the
 * shell names no feature, it only reads this.
 *
 * Pure (no React, no DOM): unit-tested in test/desktop-registry.test.ts.
 */

import {
  qualify, type CommandContribution, type ComposerChipContribution, type HomeCardContribution, type NavItemContribution, type OnboardingContribution,
  type PanelContribution, type PromptContribution, type RendererContribution, type SettingsContribution, type SlashCommandContribution,
  type StatusItemContribution, type ThemeContribution, type UiManifest, type UiTrust, type ViewContribution,
} from '@harness/plugin-ui';
import { parseChord } from './keybindings.ts';

/** A built-in's code: components and command handlers by the names its manifest uses. */
export interface NativeModule { components: Record<string, unknown>; handlers?: Record<string, (args?: unknown) => unknown> }

export interface PluginEntry {
  name: string;
  version?: string;
  description?: string;
  /** builtin: ships with the app (native, signed with the app); else where the server says it came from, or "dev". */
  source: string;
  enabled: boolean;
  required?: boolean;
  ui?: UiManifest;
  uiError?: string;
  uiHash?: string;
  native?: NativeModule;
}

type Q<T> = T & { qid: string; plugin: string };
export type NavItem = Q<NavItemContribution>;
export type View = Q<ViewContribution> & { trust: UiTrust };
export type Panel = Q<PanelContribution> & { trust: UiTrust };
export type Command = Q<CommandContribution> & { keys?: string; defaultKeys?: string; /** Its chord is taken by this command (which keeps it). */ keyConflict?: string };
export type SlashCommand = SlashCommandContribution & { plugin: string };
export type ComposerChip = Q<ComposerChipContribution>;
export type SettingsSection = Q<SettingsContribution>;
export type Renderer = Q<RendererContribution> & { trust: UiTrust };
export type HomeCard = Q<HomeCardContribution> & { trust: UiTrust };
export type StatusItem = Q<StatusItemContribution>;
export type Theme = Q<ThemeContribution>;
export type Prompt = Q<PromptContribution>;
export type OnboardingStep = Q<OnboardingContribution> & { view: string };

export interface Registry {
  plugins: PluginEntry[];
  /** Plugins that contribute (enabled or required, with a valid ui section). */
  active: PluginEntry[];
  navItems: NavItem[];
  views: Map<string, View>;
  panels: Map<string, Panel>;
  commands: Command[];
  slashCommands: SlashCommand[];
  composerChips: ComposerChip[];
  settings: SettingsSection[];
  renderers: { tool: Map<string, Renderer>; event: Map<string, Renderer>; fence: Map<string, Renderer>; artifact: Map<string, Renderer> };
  homeCards: HomeCard[];
  statusItems: StatusItem[];
  themes: Theme[];
  prompts: Prompt[];
  onboarding: OnboardingStep[];
  errors: Array<{ plugin: string; error: string }>;
  conflicts: Array<{ kind: 'slash' | 'keybinding'; key: string; ids: string[] }>;
}

export interface RegistryOptions {
  /** The product's sidebar order: qualified nav item ids listed first, in this order. */
  navOrder?: string[];
  /** The product's home cards: qualified ids, in this order (others follow by their own order). */
  homeCards?: string[];
  /** Command id -> chord, from the person's prefs ("" unbinds). */
  keybindings?: Record<string, string>;
  /** How Mod reads (Ctrl, or Cmd on macOS) when deciding which chords collide. */
  platform?: string;
  /** Required plugins (the product's), always active. */
  required?: string[];
}

const GROUP_ORDER = ['app', 'agent', 'integrations', 'plugins', 'admin'];
const byOrder = <T extends { order?: number; title?: string; label?: string }>(a: T, b: T) => (a.order ?? 100) - (b.order ?? 100) || String(a.title ?? a.label ?? '').localeCompare(String(b.title ?? b.label ?? ''));
const isBuiltin = (p: PluginEntry) => p.source === 'builtin';

export function buildRegistry(entries: PluginEntry[], o: RegistryOptions = {}): Registry {
  const r: Registry = {
    plugins: entries, active: [], navItems: [], views: new Map(), panels: new Map(), commands: [], slashCommands: [], composerChips: [], settings: [],
    renderers: { tool: new Map(), event: new Map(), fence: new Map(), artifact: new Map() }, homeCards: [], statusItems: [], themes: [], prompts: [], onboarding: [], errors: [], conflicts: [],
  };
  const required = new Set(o.required ?? []);
  // Built-ins first, so a third-party plugin's renderer (later) replaces a built-in default.
  const ordered = [...entries].sort((a, b) => Number(!isBuiltin(a)) - Number(!isBuiltin(b)));
  for (const p of ordered) {
    if (p.uiError) r.errors.push({ plugin: p.name, error: p.uiError });
    const on = p.enabled || p.required || required.has(p.name);
    if (!on || !p.ui) continue;
    // Native UI only for the app's own plugins; anything else claiming it contributes nothing.
    if (p.ui.trust === 'native' && !isBuiltin(p)) { r.errors.push({ plugin: p.name, error: 'Native UI is only for plugins signed by a key this app trusts.' }); continue; }
    r.active.push(p);
    const c = p.ui.contributes;
    const trust = p.ui.trust;
    const q = <T extends { id: string }>(x: T): Q<T> => ({ ...x, qid: `${p.name}:${x.id}`, plugin: p.name });
    for (const n of c.navItems) r.navItems.push({ ...q(n), view: qualify(p.name, n.view) });
    for (const v of c.views) r.views.set(`${p.name}:${v.id}`, { ...q(v as ViewContribution & { id: string }), trust } as View);
    for (const v of c.panels) r.panels.set(`${p.name}:${v.id}`, { ...q(v), trust });
    for (const cmd of c.commands) {
      const qid = `${p.name}:${cmd.id}`;
      const override = o.keybindings?.[qid];
      r.commands.push({ ...q(cmd), defaultKeys: cmd.keybinding, keys: override !== undefined ? (override || undefined) : cmd.keybinding });
    }
    for (const s of c.slashCommands) {
      const taken = r.slashCommands.find((x) => x.name === s.name);
      if (taken) { r.conflicts.push({ kind: 'slash', key: `/${s.name}`, ids: [taken.plugin, p.name] }); continue; }
      r.slashCommands.push({ ...s, plugin: p.name });
    }
    for (const ch of c.composerChips) r.composerChips.push(q(ch));
    for (const s of c.settings) r.settings.push(q(s));
    for (const rd of c.renderers) {
      const f = rd.for as { tool?: string; event?: string; fence?: string; artifact?: string };
      const map = f.tool ? r.renderers.tool : f.event ? r.renderers.event : f.artifact ? r.renderers.artifact : r.renderers.fence;
      map.set((f.tool ?? f.event ?? f.artifact ?? f.fence)!, { ...q(rd), trust });
    }
    for (const h of c.homeCards) r.homeCards.push({ ...q(h), trust });
    for (const s of c.statusItems) r.statusItems.push(q(s));
    for (const t of c.themes) r.themes.push(q(t));
    for (const pr of c.prompts) r.prompts.push(q(pr));
    for (const ob of c.onboarding) r.onboarding.push({ ...q(ob), view: qualify(p.name, ob.view) });
  }
  const navOrder = o.navOrder ?? [];
  const rank = (qid: string, list: string[]) => { const i = list.indexOf(qid); return i < 0 ? 1e6 : i; };
  r.navItems.sort((a, b) => rank(a.qid, navOrder) - rank(b.qid, navOrder) || byOrder(a, b));
  r.homeCards.sort((a, b) => rank(a.qid, o.homeCards ?? []) - rank(b.qid, o.homeCards ?? []) || byOrder(a, b));
  r.settings.sort((a, b) => GROUP_ORDER.indexOf(a.group ?? 'plugins') - GROUP_ORDER.indexOf(b.group ?? 'plugins') || byOrder(a, b));
  r.statusItems.sort(byOrder);
  r.onboarding.sort(byOrder);
  // Two commands on one chord: the first keeps it, both are reported (Settings > Shortcuts shows them).
  // The core's commands come first (built-ins load first), so the core always keeps its keys; a later
  // command on a taken chord loses it (it can still be run from the palette or rebound) and the clash is reported.
  const taken = new Map<string, string>();
  for (const cmd of r.commands) {
    if (!cmd.keys) continue;
    const c = parseChord(cmd.keys, o.platform ?? 'win32');
    const k = c ? `${c.ctrl ? 'Ctrl+' : ''}${c.meta ? 'Meta+' : ''}${c.alt ? 'Alt+' : ''}${c.shift ? 'Shift+' : ''}${c.key}` : normaliseChordText(cmd.keys);
    const winner = taken.get(k);
    if (winner) {
      const existing = r.conflicts.find((x) => x.kind === 'keybinding' && x.ids[0] === winner && x.key === cmd.keys);
      if (existing) existing.ids.push(cmd.qid); else r.conflicts.push({ kind: 'keybinding', key: cmd.keys, ids: [winner, cmd.qid] });
      cmd.keyConflict = winner;
      cmd.keys = undefined;
    } else taken.set(k, cmd.qid);
  }
  return r;
}

/** "ctrl+shift+p" and "Shift+Ctrl+P" are the same chord. */
export function normaliseChordText(s: string): string {
  const parts = s.split('+').map((x) => x.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const mods = ['Mod', 'Ctrl', 'Cmd', 'Meta', 'Alt', 'Shift'].filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** Looks a view up by a reference made inside a plugin ("<id>" means its own). */
export function findView(r: Registry, plugin: string, ref: string): View | undefined { return r.views.get(qualify(plugin, ref)); }

/** Replaces {name} with live values (badges); unknown names become "0". */
export function interpolate(text: string, values: Record<string, unknown>): string {
  return text.replace(/\{([a-zA-Z0-9._-]{1,64})\}/g, (_, k: string) => { const v = values[k]; return v === undefined || v === null ? '0' : String(v); });
}

/** The renderer for a tool's results, an event kind or a fence language, if a plugin brings one. */
export function rendererFor(r: Registry, kind: 'tool' | 'event' | 'fence' | 'artifact', key: string): Renderer | undefined { return r.renderers[kind].get(key); }

/** Fuzzy match for the command palette: every character of the query in order; better when contiguous and early. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return 1000 - direct * 2 - (t.length - q.length) * 0.1;
  let ti = 0; let score = 0; let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 5 - Math.min(found - ti, 10);
    ti = found + 1;
  }
  return score;
}

/**
 * The live registry as plain data (no components): what the window has right now, for the agent's
 * desktop_describe tool and for diagnostics.
 */
export function describeRegistry(r: Registry) {
  return {
    plugins: r.plugins.map((p) => ({ name: p.name, version: p.version, source: p.source, enabled: p.enabled, active: r.active.includes(p), trust: p.ui?.trust, capabilities: p.ui?.capabilities ?? [], uiError: p.uiError })),
    navItems: r.navItems.map((n) => ({ id: n.qid, title: n.title, view: n.view, placement: n.placement ?? 'primary' })),
    views: [...r.views.values()].map((v) => ({ id: v.qid, title: v.title, kind: v.kind })),
    panels: [...r.panels.values()].map((p) => ({ id: p.qid, title: p.title, kind: p.kind, where: p.where ?? 'any' })),
    commands: r.commands.map((c) => ({ id: c.qid, title: c.title, keys: c.keys ?? null })),
    slashCommands: r.slashCommands.map((s) => ({ name: s.name, plugin: s.plugin, description: s.description })),
    settings: r.settings.map((s) => ({ id: s.qid, title: s.title, scope: s.scope, group: s.group ?? 'plugins' })),
    renderers: { tool: [...r.renderers.tool.keys()], event: [...r.renderers.event.keys()], fence: [...r.renderers.fence.keys()], artifact: [...r.renderers.artifact.keys()] },
    themes: r.themes.map((t) => ({ id: t.qid, label: t.label, mode: t.mode })),
    conflicts: r.conflicts,
    errors: r.errors,
  };
}
