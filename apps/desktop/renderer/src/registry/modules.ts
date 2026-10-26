/**
 * Plugins as modules of the app, as plain data: the home the shell draws for a plugin that declares
 * none, the "Plugin > Item" names of the palette, the guides agents load (authored text merged with
 * sections generated from the manifest) and the one-line index of them a desktop session declares.
 * Pure (no React): unit-tested in test/desktop-modules.test.ts.
 */

import { composeGuide, guideSkillName, purposeOf, qualify, type GuideSource, type IconName, type UiAction } from '@harness/plugin-ui';
import { CUSTOM_GROUP, menuOf, type MenuEntry, type NavItem, type PluginEntry, type Registry, type Route } from './registry.ts';

export interface HomeAction { id: string; title: string; icon: IconName | string; kind: 'command' | 'slash' | 'prompt'; /** A command id, "/name", or a prompt's text. */ run: string; hint?: string; agent?: boolean }
export interface HomeModel {
  plugin: string;
  title: string;
  icon: IconName | string;
  /** What it is: the plugin's description. */
  description: string;
  purpose: string;
  /** Its pages, as cards (its menu's items, else its nav items, else its views). */
  pages: Array<{ id: string; title: string; icon?: string; route: Route; description?: string; badge?: string }>;
  /** Its commands and slash commands. */
  actions: HomeAction[];
  /** Its settings sections (qualified ids, for core.settings:open). */
  settings: Array<{ id: string; title: string }>;
  statusItems: Array<{ id: string; text: string; command?: string }>;
  homeCards: string[];
  prompts: Array<{ id: string; title: string; prompt: string; icon?: string }>;
  /** "Ask the agent about <plugin>": the prompt it types in. */
  ask: string;
  guide: string;
}

const titleOf = (p: PluginEntry | undefined, name: string) => p?.ui?.displayName ?? name;

/** The home the shell draws from a plugin's manifest (core.shell:plugin-home). */
export function homeModel(r: Registry, plugin: string): HomeModel | undefined {
  const p = r.active.find((x) => x.name === plugin);
  if (!p?.ui) return undefined;
  const c = p.ui.contributes;
  const group = menuOf(r, plugin);
  const title = group?.title ?? titleOf(p, plugin);
  const viewDesc = (qid: string) => { const v = r.views.get(qid); return v?.description; };
  const flat = (es: MenuEntry[]): MenuEntry[] => es.flatMap((e) => [e, ...e.children]);
  const fromGroup = group ? flat(group.items).map((e) => ({ id: e.qid, title: e.title, ...(e.icon ? { icon: e.icon } : {}), route: { view: e.view, ...(e.params ? { params: e.params } : {}) }, ...(viewDesc(e.view) ? { description: viewDesc(e.view) } : {}), ...(e.badge ? { badge: e.badge } : {}) })) : [];
  // Its entry under Custom (which opens this home) is not a page of it.
  const fromNav = r.navItems.filter((n) => n.plugin === plugin && n.qid !== `${plugin}:menu`).map((n) => ({ id: n.qid, title: n.title, ...(n.icon ? { icon: n.icon } : {}), route: { view: n.view, ...(n.params ? { params: n.params } : {}) }, ...(viewDesc(n.view) ? { description: viewDesc(n.view) } : {}), ...(n.badge ? { badge: n.badge } : {}) }));
  const shown = new Set([...fromGroup, ...fromNav].map((x) => x.route.view));
  // Pages a person can open on their own: views no menu or nav item reaches, that take no params (not onboarding steps).
  const fromViews = c.views.filter((v) => !shown.has(`${plugin}:${v.id}`) && !/^onboard/.test(v.id) && `${plugin}:${v.id}` !== r.homes.get(plugin)?.view && v.kind !== 'native')
    .map((v) => ({ id: `${plugin}:${v.id}`, title: v.title, ...(v.icon ? { icon: v.icon } : {}), route: { view: `${plugin}:${v.id}` }, ...(v.description ? { description: v.description } : {}) }));
  const seen = new Set<string>();
  const pages = [...fromGroup, ...fromNav, ...fromViews].filter((x) => { const k = JSON.stringify(x.route); if (seen.has(k)) return false; seen.add(k); return true; });
  const actions: HomeAction[] = [
    ...r.commands.filter((x) => x.plugin === plugin && !(x.action?.type === 'open-view' && pages.some((pg) => pg.route.view === qualify(plugin, (x.action as Extract<UiAction, { type: 'open-view' }>).view))))
      .map((x) => ({ id: x.qid, title: x.title, icon: x.icon ?? 'command', kind: 'command' as const, run: x.qid, ...(x.keys ? { hint: x.keys } : {}), ...(x.agent ? { agent: true } : {}) })),
    ...r.slashCommands.filter((s) => s.plugin === plugin).map((s) => ({ id: `/${s.name}`, title: `/${s.name}`, icon: 'command', kind: 'slash' as const, run: `/${s.name} `, hint: s.description })),
  ];
  return {
    plugin, title, icon: group?.icon ?? p.ui.icon ?? 'puzzle',
    description: p.description ?? '',
    purpose: purposeOf({ authored: p.guide, description: p.description, title, name: plugin }),
    pages,
    actions,
    settings: r.settings.filter((s) => s.plugin === plugin).map((s) => ({ id: s.qid, title: s.title })),
    statusItems: r.statusItems.filter((s) => s.plugin === plugin).map((s) => ({ id: s.qid, text: s.text, ...(s.command ? { command: qualify(plugin, s.command) } : {}) })),
    homeCards: r.homeCards.filter((h) => h.plugin === plugin).map((h) => h.qid),
    prompts: r.prompts.filter((x) => x.plugin === plugin).map((x) => ({ id: x.qid, title: x.title, prompt: x.prompt, ...(x.icon ? { icon: x.icon } : {}) })),
    ask: `What can the ${title} plugin do for me here? Load its guide (${guideSkillName(plugin)}), then tell me what it is for, its pages and the commands I can use, with an example for my work.`,
    guide: guideSkillName(plugin),
  };
}

/** How the palette names a nav item: "Plugin › Item" for an item of a group. */
export function paletteTitle(r: Registry, n: NavItem): string {
  if (!n.group) return n.title;
  // Under Custom: "Plugin › Page" (its menu's title), not "Custom › ...".
  if (n.group === CUSTOM_GROUP) {
    const m = menuOf(r, n.plugin);
    if (n.qid === `${n.plugin}:menu`) return n.title;
    const title = m?.title ?? r.active.find((p) => p.name === n.plugin)?.ui?.displayName ?? n.plugin;
    return title.toLowerCase() === n.title.toLowerCase() ? n.title : `${title} › ${n.title}`;
  }
  const g = r.groups.find((x) => x.plugin === n.group);
  if (!g) return n.title;
  const parent = n.parent ? r.navItems.find((x) => x.qid === n.parent) : undefined;
  return [g.title, ...(parent ? [parent.title] : []), n.title].join(' › ');
}

/** Tools a plugin names: its manifest's `tools` and, for a server plugin, what it registered. */
export function pluginTools(p: PluginEntry): string[] {
  return [...new Set([...(p.ui?.tools ?? []), ...(p.contributes ?? []).filter((x) => x.startsWith('tool:')).map((x) => x.slice(5))])];
}

/** The guide of a plugin as the app knows it: its authored text with sections generated from its manifest. */
export function guideFor(r: Registry, plugin: string): string | undefined {
  const p = r.plugins.find((x) => x.name === plugin);
  if (!p) return undefined;
  const src: GuideSource = {
    name: p.name, title: p.ui?.displayName, description: p.description, ui: p.ui, authored: p.guide,
    tools: pluginTools(p).map((name) => ({ name })),
    workflows: (p.contributes ?? []).filter((x) => x.startsWith('workflow:')).map((x) => ({ name: x.slice(9) })),
    gates: (p.contributes ?? []).filter((x) => x.startsWith('gate:')).map((x) => ({ name: x.slice(5) })),
  };
  return composeGuide(src);
}

/** A plugin is a "full" one, with a guide line, when it has authored guide text, a menu or a home, or its server has a guide. */
export function hasGuide(p: PluginEntry): boolean {
  return !!(p.guide || p.guideInfo || p.ui?.menu || p.ui?.home || p.ui?.guide);
}

export interface GuideIndexEntry { name: string; title: string; purpose: string; /** Whose guide: the app's (it answers desktop_describe {plugin, guide}) or the server's. */ from: 'app' | 'server'; tools?: string[] }

/**
 * The plugins a desktop session lists, one line each: every enabled plugin with a guide (the app's
 * active ones, and the server's enabled ones, UI or not). Sorted by name, so the line set changes only
 * when a plugin comes or goes.
 */
export function guideIndex(r: Registry): GuideIndexEntry[] {
  const out: GuideIndexEntry[] = [];
  for (const p of r.plugins) {
    const on = r.active.includes(p) || (p.source !== 'builtin' && p.source !== 'dev' && p.enabled && !!p.guideInfo);
    if (!on || !hasGuide(p)) continue;
    const server = p.source !== 'builtin' && p.source !== 'dev';
    const title = titleOf(p, p.name);
    out.push({ name: p.name, title, purpose: p.guideInfo?.purpose ?? purposeOf({ authored: p.guide, description: p.description, title, name: p.name }), from: server ? 'server' : 'app', ...(pluginTools(p).length && !server ? { tools: pluginTools(p).slice(0, 40) } : {}) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
