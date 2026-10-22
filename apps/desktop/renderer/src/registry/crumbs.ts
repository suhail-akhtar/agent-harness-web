/**
 * Breadcrumbs: where a page sits, "<parent> > <page>". Pure; unit-tested.
 *
 * The parent is what the page says about itself (setCrumb), else the nav item of its plugin when
 * the page itself is not one (Projects > a project), else the plugin's name when it differs from
 * the page's (Notes > Board) - never the same word twice ("Plugins > Plugins").
 */

import { GENERATED_HOME_VIEW } from '@harness/plugin-ui';
import { groupOf, isHomeRoute, type Registry } from './registry.ts';

export interface CrumbRoute { view: string; params?: Record<string, string> }
export interface CrumbHint { view: string; title?: string; parent?: { label: string; route?: CrumbRoute } }

/**
 * A page of a plugin that is a module (a group in the sidebar) reads "<Plugin> > <Page>", the plugin
 * linking to its home; the home itself is the plugin's name.
 */
export function crumbsFor(registry: Registry, route: CrumbRoute, crumb: CrumbHint | null, title?: string): { parent?: { label: string; route?: CrumbRoute }; title: string } {
  const view = registry.views.get(route.view);
  const own = crumb && crumb.view === route.view ? crumb : null;
  if (route.view === GENERATED_HOME_VIEW) {
    const plugin = route.params?.plugin ?? '';
    const g = registry.groups.find((x) => x.plugin === plugin);
    return { title: title ?? g?.title ?? registry.active.find((p) => p.name === plugin)?.ui?.displayName ?? plugin };
  }
  const group = view ? groupOf(registry, view.qid) : undefined;
  if (group && isHomeRoute(group.home, route) && !own?.parent) return { title: title ?? group.title };
  const entry = group?.items.flatMap((e) => [e, ...e.children]).find((e) => e.view === route.view && (!e.params || JSON.stringify(e.params) === JSON.stringify(route.params ?? {})));
  const page = title ?? own?.title ?? entry?.title ?? view?.title ?? '';
  if (own?.parent) return { parent: own.parent, title: page };
  if (group && group.title.toLowerCase() !== page.toLowerCase()) return { parent: { label: group.title, route: group.home }, title: page };
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
