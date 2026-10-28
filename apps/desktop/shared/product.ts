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
