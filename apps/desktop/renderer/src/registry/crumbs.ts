/**
 * Breadcrumbs: where a page sits, "<parent> > <page>". Pure; unit-tested.
 *
 * The parent is what the page says about itself (setCrumb), else the nav item of its plugin when
 * the page itself is not one (Projects > a project), else the plugin's name when it differs from
 * the page's (Notes > Board) - never the same word twice ("Plugins > Plugins").
 */

import type { Registry } from './registry.ts';

export interface CrumbRoute { view: string; params?: Record<string, string> }
export interface CrumbHint { view: string; title?: string; parent?: { label: string; route?: CrumbRoute } }

export function crumbsFor(registry: Registry, route: CrumbRoute, crumb: CrumbHint | null, title?: string): { parent?: { label: string; route?: CrumbRoute }; title: string } {
  const view = registry.views.get(route.view);
  const own = crumb && crumb.view === route.view ? crumb : null;
  const page = title ?? own?.title ?? view?.title ?? '';
  if (own?.parent) return { parent: own.parent, title: page };
  if (!view || view.plugin === 'core.chat') return { title: page };
  const isNav = registry.navItems.some((n) => n.view === view.qid);
  const nav = registry.navItems.find((n) => n.plugin === view.plugin && n.view !== view.qid);
  if (!isNav && nav && nav.title.toLowerCase() !== page.toLowerCase()) return { parent: { label: nav.title, route: { view: nav.view, ...(nav.params ? { params: nav.params } : {}) } }, title: page };
  const name = registry.active.find((p) => p.name === view.plugin)?.ui?.displayName ?? view.plugin;
  if (!view.plugin.startsWith('core.') && name.toLowerCase() !== page.toLowerCase()) return { parent: { label: name }, title: page };
  return { title: page };
}

/** The page's own title, for the window's title bar (the home page has none). */
export function pageTitle(registry: Registry, route: CrumbRoute, crumb: CrumbHint | null): string {
  if (route.view === 'core.chat:home') return '';
  return crumbsFor(registry, route, crumb).title;
}
