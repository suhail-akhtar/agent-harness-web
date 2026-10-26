/**
 * What an agent sees of the window and may do in it (the desktop tools): the live registry as a
 * compact description (desktop_describe), and the checks before an agent opens something or runs
 * a command (desktop_open, desktop_command). Pure: unit-tested in test/desktop-agents-ui.test.ts.
 */

import { GENERATED_HOME_VIEW, guideSkillName, validateValue, type JsonSchema } from '@harness/plugin-ui';
import { menuOf, type Registry } from './registry.ts';
import { guideFor, guideIndex, pluginTools } from './modules.ts';

export interface WindowNow { view: string; panel?: string | null; split?: string | null; sessionId?: string }

/**
 * The live registry for desktop_describe: enabled plugins (each with its purpose, home, menu, the
 * commands an agent may run, its tools and its guide), views, panels, agent-callable commands with
 * their argument schemas, settings sections, renderers and themes, and what is on screen. Compact on
 * purpose (it is a tool result the model reads); `{plugin}` gives one plugin in depth (describePlugin).
 */
export function describeForAgent(r: Registry, now: WindowNow, app?: { name: string; version: string }) {
  const titleOf = (name: string) => r.active.find((p) => p.name === name)?.ui?.displayName ?? name;
  const index = new Map(guideIndex(r).map((g) => [g.name, g]));
  const home = (name: string) => { const h = r.homes.get(name); return h ? (h.view === GENERATED_HOME_VIEW ? 'generated' : h.view) : undefined; };
  const menu = (name: string) => { const g = menuOf(r, name); return g ? g.items.flatMap((e) => [e, ...e.children]).map((e) => `${e.title}=${e.view}`) : undefined; };
  const extra = [...index.values()].filter((g) => !r.active.some((p) => p.name === g.name));
  return {
    ...(app ? { app: `${app.name} ${app.version}` } : {}),
    now: { view: now.view, ...(now.panel ? { panel: now.panel } : {}), ...(now.split ? { beside: now.split } : {}) },
    plugins: r.active.map((p) => {
      const g = index.get(p.name);
      const m = menu(p.name);
      const tools = pluginTools(p);
      const cmds = r.commands.filter((c) => c.plugin === p.name && c.agent).map((c) => c.qid);
      return { name: p.name, title: titleOf(p.name), ...(g ? { purpose: g.purpose, guide: guideSkillName(p.name) } : {}), ...(g || m ? { home: home(p.name) } : {}), ...(m ? { menu: m } : {}), ...(cmds.length ? { commands: cmds } : {}), ...(tools.length ? { tools } : {}) };
    }),
    // The server's plugins with a guide but no pages here (their tools work in sessions).
    ...(extra.length ? { serverPlugins: extra.map((g) => ({ name: g.name, purpose: g.purpose, guide: guideSkillName(g.name) })) } : {}),
    off: r.plugins.filter((p) => !r.active.includes(p) && !extra.some((g) => g.name === p.name)).map((p) => p.name),
    views: [...r.views.values()].filter((v) => !/^onboard/.test(v.id) && v.qid !== GENERATED_HOME_VIEW).map((v) => `${v.qid}${v.title ? ` (${v.title})` : ''}`),
    panels: [...r.panels.values()].map((p) => `${p.qid}${p.where === 'session' ? ' [conversation]' : ''}`),
    commands: r.commands.filter((c) => c.agent).map((c) => ({ id: c.qid, does: c.agent!.description, ...(c.agent!.inputSchema ? { args: c.agent!.inputSchema } : {}) })),
    settings: r.settings.map((s) => s.qid),
    renderers: { fence: [...r.renderers.fence.keys()], artifact: [...r.renderers.artifact.keys()], tool: [...r.renderers.tool.keys()], event: [...r.renderers.event.keys()] },
    themes: ['light', 'dark', 'system', ...r.themes.map((t) => t.qid)],
    more: 'desktop_describe {"plugin": name} for one plugin in depth; desktop_open {"target":"view","id": a plugin name} opens its home.',
  };
}

/**
 * One plugin in depth (desktop_describe {plugin}): purpose, home and menu, its pages and panels, its
 * commands (agent-callable ones with their schemas), slash commands, settings, tools, renderers, home
 * cards and status items; with `guide`, its whole guide (what the skill <plugin>-guide loads).
 */
export function describePlugin(r: Registry, name: string, o: { guide?: boolean } = {}) {
  const p = r.plugins.find((x) => x.name === name) ?? r.plugins.find((x) => x.ui?.displayName?.toLowerCase() === name.toLowerCase());
  if (!p) throw new Error(`No plugin "${name}". Plugins: ${r.plugins.map((x) => x.name).join(', ')}`);
  const active = r.active.includes(p);
  const g = guideIndex(r).find((x) => x.name === p.name);
  const own = <T extends { plugin: string }>(list: T[]) => list.filter((x) => x.plugin === p.name);
  const group = menuOf(r, p.name);
  const out = {
    name: p.name, title: p.ui?.displayName ?? p.name, enabled: active || !!g, source: p.source,
    ...(p.description ? { description: p.description } : {}),
    ...(g ? { purpose: g.purpose, guide: guideSkillName(p.name) } : {}),
    ...(active ? {
      home: r.homes.get(p.name),
      ...(group ? { menu: group.items.map((e) => ({ title: e.title, view: e.view, ...(e.params ? { params: e.params } : {}), ...(e.children.length ? { children: e.children.map((c) => ({ title: c.title, view: c.view, ...(c.params ? { params: c.params } : {}) })) } : {}) })) } : {}),
      views: [...r.views.values()].filter((v) => v.plugin === p.name).map((v) => ({ id: v.qid, title: v.title, ...(v.description ? { description: v.description } : {}) })),
      panels: [...r.panels.values()].filter((x) => x.plugin === p.name).map((x) => ({ id: x.qid, title: x.title, where: x.where ?? 'any' })),
      commands: own(r.commands).map((c) => ({ id: c.qid, title: c.title, ...(c.agent ? { agent: c.agent.description, ...(c.agent.inputSchema ? { args: c.agent.inputSchema } : {}) } : {}), ...(c.keys ? { keys: c.keys } : {}) })),
      slashCommands: own(r.slashCommands).map((s) => ({ name: `/${s.name}`, description: s.description })),
      settings: own(r.settings).map((s) => ({ id: s.qid, title: s.title, scope: s.scope })),
      renderers: (['tool', 'event', 'fence', 'artifact'] as const).flatMap((k) => [...r.renderers[k].entries()].filter(([, v]) => v.plugin === p.name).map(([key]) => `${k}:${key}`)),
      homeCards: own(r.homeCards).map((h) => h.qid),
      statusItems: own(r.statusItems).map((s) => s.text),
    } : {}),
    tools: pluginTools(p),
  };
  if (!o.guide) return out;
  const text = guideFor(r, p.name);
  if (!text) throw new Error(`${p.name} has no guide here.`);
  return { ...out, guideText: text };
}

/** Why an agent may not run this command with these args (undefined: it may). The server checked too; the app checks again. */
export function commandRefusal(r: Registry, id: string, args: unknown): string | undefined {
  const cmd = r.commands.find((c) => c.qid === id);
  if (!cmd) return `No command ${id} in the app now (its plugin may be off). desktop_describe lists the agent-callable ones.`;
  if (!cmd.agent) return `${id} is not agent-callable: its plugin does not mark it "agent". Ask the person to run it.`;
  const problems = cmd.agent.inputSchema ? validateValue(cmd.agent.inputSchema as JsonSchema, args ?? {}, 'args') : (args && typeof args === 'object' && Object.keys(args).length ? ['args: this command takes none'] : []);
  return problems.length ? `Invalid args for ${id}: ${problems.slice(0, 8).join('; ')}` : undefined;
}

export type OpenTarget =
  | { target: 'view'; view: string; params?: Record<string, string> }
  | { target: 'panel'; panel: string; params?: Record<string, string> }
  | { target: 'file'; path: string }
  | { target: 'artifact'; id: string }
  | { target: 'url'; url: string };

/** Reads desktop_open's input into what to open, or the reason it cannot be (a view or panel resolved against the registry; only http(s) URLs). */
export function resolveOpen(r: Registry, input: Record<string, unknown>): OpenTarget | { error: string } {
  const target = String(input.target ?? '');
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? Object.fromEntries(Object.entries(input.params as Record<string, unknown>).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, String(v)]))
    : undefined;
  const find = <T extends { qid: string; id: string }>(list: T[], want: string): T | undefined => list.find((x) => x.qid === want) ?? (want.includes(':') ? undefined : list.filter((x) => x.id === want).length === 1 ? list.find((x) => x.id === want) : undefined);
  switch (target) {
    case 'view': {
      const want = str('id') || str('view');
      // A plugin's name (or display name) opens its home: its declared view, or the page the app draws for it.
      const home = r.homes.get(want) ?? r.homes.get(r.active.find((p) => !!want && p.ui?.displayName?.toLowerCase() === want.toLowerCase())?.name ?? '');
      if (home) return { target: 'view', view: home.view, ...(home.params || params ? { params: { ...(home.params ?? {}), ...(params ?? {}) } } : {}) };
      const v = find([...r.views.values()], want) ?? (() => { const n = r.navItems.find((x) => x.qid === want); return n ? r.views.get(n.view) : undefined; })();
      if (!v) return { error: `No view "${want}". Views: ${[...r.views.keys()].filter((k) => !/:onboard/.test(k) && k !== GENERATED_HOME_VIEW).slice(0, 30).join(', ')}; or a plugin's name for its home (${[...r.homes.keys()].slice(0, 20).join(', ')})` };
      return { target: 'view', view: v.qid, ...(params ? { params } : {}) };
    }
    case 'panel': {
      const want = str('id') || str('panel');
      const p = find([...r.panels.values()], want);
      if (!p) return { error: `No panel "${want}". Panels: ${[...r.panels.keys()].join(', ') || 'none'}` };
      return { target: 'panel', panel: p.qid, ...(params ? { params } : {}) };
    }
    case 'file': {
      const p = str('path');
      if (!p) return { error: 'desktop_open file needs path (a file in this conversation\'s workspace)' };
      return { target: 'file', path: p };
    }
    case 'artifact': {
      const id = str('id');
      if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(id)) return { error: 'desktop_open artifact needs id (as the artifact tool gave it)' };
      return { target: 'artifact', id };
    }
    case 'url': {
      const url = str('url');
      let u: URL;
      try { u = new URL(url); } catch { return { error: 'desktop_open url needs a full http(s) URL' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http(s) URLs are opened (in the system browser).' };
      return { target: 'url', url: u.toString() };
    }
    default: return { error: 'target is view, panel, file, artifact or url' };
  }
}
