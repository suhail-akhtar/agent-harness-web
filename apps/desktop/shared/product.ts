/**
 * A product profile (products/<id>.json): the name, app id, brand, which plugins ship and are
 * required, the sidebar order and home cards. The same core ships under any profile.
 */

export interface ProductProfile {
  id: string;
  name: string;
  appId: string;
  description?: string;
  brand: { icon?: string; accent: string; wordmark?: string; tagline?: string };
  plugins: { bundled: string[]; enabled: string[]; required: string[] };
  nav: { order: string[] };
  home: { cards: string[]; greeting?: string };
  /** Official publishers' public keys (paths beside the profile): a plugin signed by one is official and verified. */
  trustedKeys?: string[];
  /** The solutions this edition ships inside its engine (solutions/<name>: "studio"); the others install as bundles. */
  solutions?: string[];
  /** A plugin the main window is focused on (a solution's own app): its menu first, the app opens on its home; everything else is there too. */
  focus?: string;
  /** This edition's harness home folder in the person's home (".harness-studio"): its own conversations and data, beside the others'. */
  homeFolder?: string;
  policy?: { lock?: Record<string, unknown>; defaults?: Record<string, unknown> };
  /** solutions: the shipped solutions a new local engine starts with ("aiops", "devops", ... or "all"); people install others later. */
  server: { mode: 'local' | 'remote'; url?: string; solutions?: string[] };
}

export const FALLBACK_PRODUCT: ProductProfile = {
  id: 'harness', name: 'Harness', appId: 'dev.harness.desktop',
  brand: { accent: '#d97757', wordmark: 'Harness' },
  plugins: { bundled: ['core.*'], enabled: ['core.*'], required: ['core.chat', 'core.settings', 'core.plugins'] },
  nav: { order: [] }, home: { cards: [] }, server: { mode: 'local' },
};

/**
 * A solution as an app of its own: the base profile (products/harness.json) with the solution's
 * package.json "harness.app" (name, appId, description, tagline, accent, icon, focus, homeFolder), shipping the
 * solution inside its engine with every one of its plugins installed. Any solution becomes one:
 * npm run desktop:build -- --solution <name>, npm run desktop:dev -- --solution <name>.
 */
export interface SolutionApp { name?: string; appId?: string; description?: string; tagline?: string; accent?: string; icon?: string; focus?: string; homeFolder?: string }
export function solutionProduct(base: unknown, solution: string, pkg: { description?: string; harness?: { title?: string; plugins?: string[]; app?: SolutionApp } }): Record<string, unknown> {
  const b = normaliseProduct(base);
  const app = pkg.harness?.app ?? {};
  const title = pkg.harness?.title ?? solution;
  const plugins = pkg.harness?.plugins ?? [];
  const focus = app.focus ?? plugins[0];
  return {
    ...b,
    id: solution,
    name: app.name ?? `${b.name} ${title}`,
    appId: app.appId ?? `${b.appId}.${solution.replace(/[^a-z0-9]/gi, '')}`,
    description: app.description ?? pkg.description ?? b.description,
    brand: { ...b.brand, wordmark: app.name ?? `${b.name} ${title}`, ...(app.accent ? { accent: app.accent } : {}), ...(app.tagline ? { tagline: app.tagline } : {}), ...(app.icon ? { icon: app.icon } : {}) },
    solutions: [...new Set([...(b.solutions ?? []), solution])],
    server: { ...b.server, solutions: plugins },
    ...(focus ? { focus } : {}),
    homeFolder: app.homeFolder ?? `.harness-${solution}`,
  };
}

/** Does a plugin name match a profile pattern ("core.*", "acme-notes")? */
export function matches(pattern: string, name: string): boolean {
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export function normaliseProduct(raw: unknown): ProductProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProductProfile>;
  return {
    ...FALLBACK_PRODUCT, ...r,
    brand: { ...FALLBACK_PRODUCT.brand, ...(r.brand ?? {}) },
    plugins: { ...FALLBACK_PRODUCT.plugins, ...(r.plugins ?? {}) },
    nav: { ...FALLBACK_PRODUCT.nav, ...(r.nav ?? {}) },
    home: { ...FALLBACK_PRODUCT.home, ...(r.home ?? {}) },
    server: { ...FALLBACK_PRODUCT.server, ...(r.server ?? {}) },
  };
}
