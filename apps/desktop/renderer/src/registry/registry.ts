/**
 * The registry: every contribution from every enabled plugin, resolved once into what the shell
 * draws. The built-in features are plugins here exactly like third-party ones (trust "native"); the
 * shell names no feature, it only reads this.
 *
 * Pure (no React, no DOM): unit-tested in test/desktop-registry.test.ts.
 */

import {
  qualify, GENERATED_HOME_VIEW, type MenuItemRef, type IconName, type CommandContribution, type ComposerChipContribution, type HomeCardContribution, type NavItemContribution, type OnboardingContribution,
  type PanelContribution, type PromptContribution, type RendererContribution, type SettingsContribution, type SlashCommandContribution,
  type StatusItemContribution, type ThemeContribution, type UiManifest, type UiTrust, type ViewContribution,
  type DataSourceContribution, type WidgetContribution, type BlockActionContribution, type DashboardTemplateContribution,
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
  /** The authored guide (Markdown) when the app has it: a built-in's GUIDE.md. */
  guide?: string;
  /** The server's word on its guide: the plugin's one-sentence purpose (server plugins). */
  guideInfo?: { purpose: string };
  /** Server plugins: what the loaded plugin added ("tool:name", "workflow:name" ...). */
  contributes?: string[];
  /** A plugin folder the person loaded in this app (its server half runs in the engine, listed there as the operator's). */
  loadedHere?: boolean;
  /** official: shipped with the harness or signed by an official publisher; custom: everything else. */
  tier?: 'official' | 'custom';
}

/** Added by the person (installed from the catalogue, or loaded from a folder here): these go under Custom. */
const addedByPerson = (p: PluginEntry) => p.source === 'installed' || p.source === 'dev' || !!p.loadedHere;

type Q<T> = T & { qid: string; plugin: string };
/** `group`: the plugin whose menu shows it (it is drawn there, not at the top level); `parent`: the item it is a sub-item of. */
export type NavItem = Q<NavItemContribution> & { group?: string; parent?: string };

export interface Route { view: string; params?: Record<string, string> }
/** One entry of a group: a nav item (this plugin's, another's, or one the menu defines), with its sub-items. */
export interface MenuEntry { qid: string; plugin: string; title: string; icon?: IconName; view: string; params?: Record<string, string>; badge?: string; children: MenuEntry[] }
/** A plugin as a module in the sidebar: a header (icon, title: opens its home) and its items. */
export interface MenuGroup {
  plugin: string;
  title: string;
  icon: IconName;
  order: number;
  /** Folded until the person unfolds it (their choice is remembered). */
  collapsed: boolean;
  home: Route;
  /** The plugin declared its home (else the shell draws one from the manifest). */
  homeDeclared: boolean;
  items: MenuEntry[];
}
export type View = Q<ViewContribution> & { trust: UiTrust };
export type Panel = Q<PanelContribution> & { trust: UiTrust };
export type Command = Q<CommandContribution> & { keys?: string; defaultKeys?: string; /** Its chord is taken by this command (which keeps it). */ keyConflict?: string };
export type SlashCommand = SlashCommandContribution & { plugin: string };
export type ComposerChip = Q<ComposerChipContribution>;
export type SettingsSection = Q<SettingsContribution>;
export type Renderer = Q<RendererContribution> & { trust: UiTrust };
/** A renderer of a plugin that is switched off: who made it, to say so. */
export interface OffRenderer { plugin: string; title: string }
export type HomeCard = Q<HomeCardContribution> & { trust: UiTrust };
export type StatusItem = Q<StatusItemContribution>;
export type Theme = Q<ThemeContribution>;
export type Prompt = Q<PromptContribution>;
export type OnboardingStep = Q<OnboardingContribution> & { view: string };
export type DataSourceType = Q<DataSourceContribution>;
export type Widget = Q<WidgetContribution>;
export type BlockAction = Q<BlockActionContribution> & { command: string };
export type DashboardTemplate = Q<DashboardTemplateContribution>;

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
  /**
   * What switched-off plugins would draw (and no plugin that is on does): an old conversation's tool
   * card or event, or an artifact, is drawn plainly with a note naming the plugin that is off.
   */
  offRenderers: { tool: Map<string, OffRenderer>; event: Map<string, OffRenderer>; fence: Map<string, OffRenderer>; artifact: Map<string, OffRenderer> };
  homeCards: HomeCard[];
  statusItems: StatusItem[];
  themes: Theme[];
  prompts: Prompt[];
  onboarding: OnboardingStep[];
  /** Data source types and dashboard widgets plugins add (core.dashboards lists them), and actions on rendered blocks. */
  dataSources: DataSourceType[];
  widgets: Widget[];
  blockActions: BlockAction[];
  dashboardTemplates: DashboardTemplate[];
  /** Plugins as modules: one group each in the sidebar, in the person's order. */
  groups: MenuGroup[];
  /** Every active plugin's home: its declared view, else the page the shell draws from its manifest. */
  homes: Map<string, Route>;
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
  /** The person's order of the sidebar's groups (plugin names); others follow by their menu's order. */
  menuOrder?: string[];
  /** A window focused on one plugin (open as its own app): its menu is the first group, out of Custom. */
  focus?: string;
}

const GROUP_ORDER = ['app', 'agent', 'integrations', 'plugins', 'admin'];
const byOrder = <T extends { order?: number; title?: string; label?: string }>(a: T, b: T) => (a.order ?? 100) - (b.order ?? 100) || String(a.title ?? a.label ?? '').localeCompare(String(b.title ?? b.label ?? ''));
const isBuiltin = (p: PluginEntry) => p.source === 'builtin';
/** The sidebar group of the plugins the person added that bring no menu of their own. */
export const CUSTOM_GROUP = 'custom';

export function buildRegistry(entries: PluginEntry[], o: RegistryOptions = {}): Registry {
  const r: Registry = {
    plugins: entries, active: [], navItems: [], views: new Map(), panels: new Map(), commands: [], slashCommands: [], composerChips: [], settings: [],
    renderers: { tool: new Map(), event: new Map(), fence: new Map(), artifact: new Map() }, offRenderers: { tool: new Map(), event: new Map(), fence: new Map(), artifact: new Map() }, homeCards: [], statusItems: [], themes: [], prompts: [], onboarding: [], dataSources: [], widgets: [], blockActions: [], dashboardTemplates: [], groups: [], homes: new Map(), errors: [], conflicts: [],
  };
  const required = new Set(o.required ?? []);
  // Built-ins first, so a third-party plugin's renderer (later) replaces a built-in default.
  const ordered = [...entries].sort((a, b) => Number(!isBuiltin(a)) - Number(!isBuiltin(b)));
  for (const p of ordered) {
    if (p.uiError) r.errors.push({ plugin: p.name, error: p.uiError });
    const on = p.enabled || p.required || required.has(p.name);
    if (!on && p.ui && !(p.ui.trust === 'native' && !isBuiltin(p))) {
      for (const rd of p.ui.contributes.renderers) {
        const f = rd.for as { tool?: string; event?: string; fence?: string; artifact?: string };
        const kind = f.tool ? 'tool' : f.event ? 'event' : f.artifact ? 'artifact' : 'fence';
        r.offRenderers[kind].set((f.tool ?? f.event ?? f.artifact ?? f.fence)!, { plugin: p.name, title: p.ui.displayName ?? p.name });
      }
    }
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
    for (const d of c.dataSources ?? []) r.dataSources.push(q(d));
    for (const w of c.dashboardWidgets ?? []) r.widgets.push(q(w));
    for (const b of c.blockActions ?? []) r.blockActions.push({ ...q(b), command: qualify(p.name, b.command) });
    for (const t of c.dashboardTemplates ?? []) r.dashboardTemplates.push(q(t));
  }
  // A kind a plugin that is on draws is drawn by it: no note.
  for (const k of ['tool', 'event', 'fence', 'artifact'] as const) for (const key of r.renderers[k].keys()) r.offRenderers[k].delete(key);
  const navOrder = o.navOrder ?? [];
  const rank = (qid: string, list: string[]) => { const i = list.indexOf(qid); return i < 0 ? 1e6 : i; };
  r.navItems.sort((a, b) => rank(a.qid, navOrder) - rank(b.qid, navOrder) || byOrder(a, b));
  r.homeCards.sort((a, b) => rank(a.qid, o.homeCards ?? []) - rank(b.qid, o.homeCards ?? []) || byOrder(a, b));
  r.settings.sort((a, b) => GROUP_ORDER.indexOf(a.group ?? 'plugins') - GROUP_ORDER.indexOf(b.group ?? 'plugins') || byOrder(a, b));
  r.statusItems.sort(byOrder);
  r.onboarding.sort(byOrder);
  buildMenus(r, o.menuOrder ?? [], o.focus);
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

/**
 * Plugins as modules. A plugin with a `ui.menu` (or a third-party plugin with several nav items and
 * none) becomes a group: its items are the nav items it names (its own, or another plugin's while that
 * one is on) and the ones the menu defines (sub-items one level deep). An item is drawn in one group
 * only (the first that names it). Groups follow the person's order, then their menu's, then title.
 * Every active plugin gets a home: its declared view, else the page the shell draws from its manifest.
 */
function buildMenus(r: Registry, personOrder: string[], focus?: string): void {
  const claimed = new Set<string>();
  // Plugins the person added (installed from the catalogue, loaded from a folder here) go under one "Custom" group,
  // like Studio's or Dashboards': a plugin with a menu of its own as an entry with its pages under it.
  // In a window focused on one plugin (focus), that plugin is a group of its own, first.
  const added = new Set(r.plugins.filter((p) => addedByPerson(p) && p.name !== focus).map((p) => p.name));
  const custom: MenuEntry[] = [];
  for (const p of r.active) {
    const ui = p.ui!;
    const declared = ui.home ? qualify(p.name, ui.home) : undefined;
    const home: Route = declared && r.views.has(declared) ? { view: declared } : r.views.has(GENERATED_HOME_VIEW) ? { view: GENERATED_HOME_VIEW, params: { plugin: p.name } } : (() => { const n = r.navItems.find((x) => x.plugin === p.name); return n ? { view: n.view, ...(n.params ? { params: n.params } : {}) } : { view: GENERATED_HOME_VIEW, params: { plugin: p.name } }; })();
    r.homes.set(p.name, home);
    let refs: MenuItemRef[] | undefined = ui.menu?.items;
    if (!refs && !isBuiltin(p)) {
      const own = r.navItems.filter((n) => n.plugin === p.name && n.placement !== 'footer');
      // Two pages or more make a menu; in a window focused on it, even one page is its group.
      if (own.length >= 2 || (p.name === focus && own.length)) refs = own.map((n) => n.id);
    }
    if (!refs) continue;
    const entry = (it: MenuItemRef, parent?: string): MenuEntry | undefined => {
      if (typeof it === 'string') {
        const qid = it.includes(':') ? it : `${p.name}:${it}`;
        const n = r.navItems.find((x) => x.qid === qid);
        if (!n || claimed.has(qid)) return undefined;
        claimed.add(qid);
        n.group = p.name;
        if (parent) n.parent = parent;
        return { qid, plugin: n.plugin, title: n.title, ...(n.icon ? { icon: n.icon } : {}), view: n.view, ...(n.params ? { params: n.params } : {}), ...(n.badge ? { badge: n.badge } : {}), children: [] };
      }
      const qid = `${p.name}:${it.id}`;
      if (claimed.has(qid)) return undefined;
      claimed.add(qid);
      const view = qualify(p.name, it.view);
      r.navItems.push({ id: it.id, title: it.title, view, qid, plugin: p.name, group: p.name, ...(it.icon ? { icon: it.icon } : {}), ...(it.params ? { params: it.params } : {}), ...(it.badge ? { badge: it.badge } : {}), ...(parent ? { parent } : {}) });
      const children = (it.children ?? []).map((c) => entry(c, qid)).filter((x): x is MenuEntry => !!x);
      return { qid, plugin: p.name, title: it.title, ...(it.icon ? { icon: it.icon } : {}), view, ...(it.params ? { params: it.params } : {}), ...(it.badge ? { badge: it.badge } : {}), children };
    };
    const items = refs.map((it) => entry(it)).filter((x): x is MenuEntry => !!x);
    if (!items.length) continue;
    const title = ui.menu?.title ?? ui.displayName ?? p.name;
    const icon = ui.menu?.icon ?? ui.icon ?? 'puzzle';
    if (added.has(p.name)) {
      // Under Custom: the plugin (opening its home), its pages one level under it.
      const pages = items.flatMap((e) => [{ ...e, children: [] }, ...e.children]);
      for (const e of pages) { const n = r.navItems.find((x) => x.qid === e.qid); if (n) { n.group = CUSTOM_GROUP; n.parent = `${p.name}:menu`; } }
      custom.push({ qid: `${p.name}:menu`, plugin: p.name, title, icon, view: home.view, ...(home.params ? { params: home.params } : {}), children: pages });
      // The entry is a row of the sidebar like any page (it opens the plugin's home).
      r.navItems.push({ id: 'menu', qid: `${p.name}:menu`, plugin: p.name, title, icon: icon as NavItem['icon'], view: home.view, ...(home.params ? { params: home.params } : {}), group: CUSTOM_GROUP });
      continue;
    }
    r.groups.push({ plugin: p.name, title, icon, order: p.name === focus ? -1 : ui.menu?.order ?? 100, collapsed: p.name === focus ? false : !!ui.menu?.collapsed, home, homeDeclared: !!declared && home.view === declared, items });
  }
  // Added plugins without a menu of their own: each page an entry of Custom.
  const loose = r.navItems.filter((n) => !n.group && added.has(n.plugin) && n.placement !== 'footer');
  for (const n of loose) {
    n.group = CUSTOM_GROUP;
    custom.push({ qid: n.qid, plugin: n.plugin, title: n.title, ...(n.icon ? { icon: n.icon } : {}), view: n.view, ...(n.params ? { params: n.params } : {}), ...(n.badge ? { badge: n.badge } : {}), children: [] });
  }
  if (custom.length) r.groups.push({ plugin: CUSTOM_GROUP, title: 'Custom', icon: 'puzzle', order: 900, collapsed: false, home: { view: 'core.plugins:plugins' }, homeDeclared: true, items: custom });
  const rank = (n: string) => (n === focus ? -2 : (() => { const i = personOrder.indexOf(n); return i < 0 ? 1e6 : i; })());
  r.groups.sort((a, b) => rank(a.plugin) - rank(b.plugin) || a.order - b.order || a.title.localeCompare(b.title));
}

/**
 * A plugin's menu as a group, wherever it sits: its own group, or its entry under Custom (an added
 * plugin with a menu), its pages as the items. Undefined for a plugin without a menu.
 */
export function menuOf(r: Registry, plugin: string): MenuGroup | undefined {
  const own = r.groups.find((g) => g.plugin === plugin);
  if (own) return own;
  const entry = r.groups.find((g) => g.plugin === CUSTOM_GROUP)?.items.find((e) => e.qid === `${plugin}:menu`);
  if (!entry) return undefined;
  const p = r.active.find((x) => x.name === plugin);
  const home = r.homes.get(plugin) ?? { view: entry.view, ...(entry.params ? { params: entry.params } : {}) };
  const declared = p?.ui?.home ? qualify(plugin, p.ui.home) : undefined;
  return { plugin, title: entry.title, icon: entry.icon ?? 'puzzle', order: 900, collapsed: false, home, homeDeclared: !!declared && home.view === declared, items: entry.children.map((c) => ({ ...c, children: [] })) };
}

/** The group a page belongs to: its plugin's, or the one whose items open it (for a page under Custom, its plugin's menu). */
export function groupOf(r: Registry, view: string): MenuGroup | undefined {
  const plugin = view.slice(0, Math.max(0, view.indexOf(':')));
  const flat = (g: MenuGroup) => g.items.flatMap((e) => [e, ...e.children]);
  const g = r.groups.find((x) => flat(x).some((e) => e.view === view)) ?? r.groups.find((x) => x.plugin === plugin);
  return g && g.plugin !== CUSTOM_GROUP ? g : menuOf(r, plugin);
}

/** Whether a route is a plugin's home (the generated one names its plugin in params). */
export function isHomeRoute(home: Route, route: Route): boolean {
  return home.view === route.view && (home.params?.plugin ?? '') === (route.params?.plugin ?? '');
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
/** The switched-off plugin that would draw this (when none that is on does). */
export function offRendererFor(r: Registry, kind: 'tool' | 'event' | 'fence' | 'artifact', key: string): OffRenderer | undefined { return r.offRenderers?.[kind].get(key); }

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
