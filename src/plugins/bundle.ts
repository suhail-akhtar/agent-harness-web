import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PluginManifest } from './api.ts';

// A plugin as a bundle people find, trust, update and move: how it is shown (name, icon, tags), who makes it
// (author, publisher, licence, links), what changed (changelog), and which harness versions it runs on.
// Every field is optional: a plugin without them shows its name and description, and runs everywhere.

/** This harness's version (package.json): what a plugin's engines.harness range is checked against. */
export const HARNESS_VERSION: string = (() => {
  try { return String(JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0'); } catch { return '0.0.0'; }
})();

export interface BundleInfo {
  displayName: string;
  /** An icon name (for the app's icon set), when the manifest names one. */
  icon?: string;
  /** The manifest's icon image as a data: URL (at most 256 KB; png, svg, jpg, webp). */
  iconData?: string;
  tags: string[];
  category?: string;
  author?: { name: string; email?: string; url?: string };
  publisher?: { name: string; url?: string; email?: string };
  license?: string;
  links: { homepage?: string; docs?: string; support?: string; privacy?: string; terms?: string; repository?: string };
  /** The changelog's text (its first 32 KB). */
  changelog?: string;
  /** engines.harness and whether this harness is inside it. */
  compat: { harness?: string; ok: boolean; reason?: string };
  /** manifest.updates.url */
  updatesUrl?: string;
}

// ---- versions ----

type V = [number, number, number, string];
function parse(v: string): V | undefined {
  const m = /^\s*v?(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v);
  if (!m) return undefined;
  const n = (x?: string) => (x === undefined || x === 'x' || x === '*' ? NaN : Number(x));
  return [Number(m[1]), n(m[2]), n(m[3]), m[4] ?? ''];
}

/** -1, 0 or 1, by semver (a pre-release sorts before its release). Unparseable versions compare as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = parse(a) ?? [0, 0, 0, ''], y = parse(b) ?? [0, 0, 0, ''];
  for (let i = 0; i < 3; i++) { const d = (x[i] as number || 0) - (y[i] as number || 0); if (d) return d < 0 ? -1 : 1; }
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

/** Whether `version` is in `range`: npm-style (>=, <=, >, <, =, ^, ~, x ranges, "a - b", space for and, || for or). */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (!r || r === '*' || r === 'x') return true;
  return r.split('||').some((alt) => {
    const hy = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    const parts = hy ? [`>=${hy[1]}`, `<=${hy[2]}`] : alt.trim().split(/\s+/).filter(Boolean);
    return parts.every((p) => comparator(version, p));
  });
}

function comparator(version: string, c: string): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] ?? '';
  const t = parse(m[2]!);
  if (!t) throw new Error(`"${c}" is not a version range`);
  const [M, mi, pa] = t;
  const base = `${M}.${Number.isNaN(mi) ? 0 : mi}.${Number.isNaN(pa) ? 0 : pa}${t[3] ? `-${t[3]}` : ''}`;
  const cmp = compareVersions(version, base);
  const wild = Number.isNaN(mi) ? 'major' : Number.isNaN(pa) ? 'minor' : undefined;
  const upper = (u: string) => compareVersions(version, u) < 0;
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return wild ? upper(wild === 'major' ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`) : cmp <= 0;
    case '>': return wild ? !upper(wild === 'major' ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`) : cmp > 0;
    case '<': return cmp < 0;
    case '^': return cmp >= 0 && upper(M > 0 || wild === 'major' ? `${M + 1}.0.0` : mi > 0 || wild === 'minor' ? `0.${mi + 1}.0` : `0.0.${pa + 1}`);
    case '~': return cmp >= 0 && upper(wild === 'major' ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`);
    default: return wild ? cmp >= 0 && upper(wild === 'major' ? `${M + 1}.0.0` : `${M}.${mi + 1}.0`) : cmp === 0;
  }
}

/** Whether a plugin runs on this harness (its engines.harness range). HARNESS_PLUGIN_IGNORE_ENGINES=1 loads it anyway. */
export function compatibility(m: Pick<PluginManifest, 'engines'>, version = HARNESS_VERSION): BundleInfo['compat'] {
  const range = typeof m.engines?.harness === 'string' ? m.engines.harness : undefined;
  if (!range) return { ok: true };
  try {
    if (satisfies(version, range)) return { harness: range, ok: true };
    return { harness: range, ok: false, reason: `it runs on harness ${range}; this one is ${version}: update the harness, or get a version of the plugin made for it` };
  } catch (e) {
    return { harness: range, ok: false, reason: `its engines.harness ${(e as Error).message}` };
  }
}

// ---- the bundle ----

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const ICON_MAX = 256 * 1024;
const https = (u: unknown) => (typeof u === 'string' && /^(https:\/\/|mailto:)/i.test(u.trim()) ? u.trim() : undefined);

function person(x: unknown): BundleInfo['author'] {
  if (typeof x === 'string') {
    const m = /^\s*([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/.exec(x);
    return m ? { name: m[1]!, ...(m[2] ? { email: m[2] } : {}), ...(https(m[3]) ? { url: m[3]! } : {}) } : undefined;
  }
  if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
    const o = x as { name: string; email?: unknown; url?: unknown };
    return { name: o.name, ...(typeof o.email === 'string' ? { email: o.email } : {}), ...(https(o.url) ? { url: https(o.url)! } : {}) };
  }
  return undefined;
}

/** A path inside the plugin's folder (no "..", no absolute path), or undefined. */
function inside(dir: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return undefined;
  return path.join(dir, rel);
}

/** The manifest's bundle fields, normalised; the icon image and changelog read from the folder. */
export async function bundleInfo(m: PluginManifest, dir: string): Promise<BundleInfo> {
  const ui = (m.ui && typeof m.ui === 'object' ? m.ui : {}) as { displayName?: unknown; icon?: unknown };
  const sol = m.solution && typeof m.solution === 'object' ? m.solution : undefined;
  const displayName = [m.displayName, ui.displayName, sol?.title].find((x): x is string => typeof x === 'string' && !!x.trim()) ?? m.name;
  let icon: string | undefined, iconData: string | undefined;
  const ic = typeof m.icon === 'string' ? m.icon : undefined;
  const type = ic ? IMAGE_TYPES[path.extname(ic).toLowerCase()] : undefined;
  if (ic && type) {
    const f = inside(dir, ic);
    const data = f ? await fs.readFile(f).catch(() => undefined) : undefined;
    if (data && data.length <= ICON_MAX) iconData = `data:${type};base64,${data.toString('base64')}`;
  } else if (ic && /^[a-z0-9-]{1,40}$/.test(ic)) icon = ic;
  if (!icon && !iconData && typeof ui.icon === 'string') icon = ui.icon;
  const tags = [...new Set([...(Array.isArray(m.tags) ? m.tags : []), ...(Array.isArray(m.keywords) ? m.keywords : [])].filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim().toLowerCase()))].slice(0, 20);
  const repo = typeof m.repository === 'string' ? m.repository : m.repository?.url;
  const l = m.links ?? {};
  const links: BundleInfo['links'] = {};
  for (const [k, v] of Object.entries({ homepage: l.homepage ?? m.homepage, docs: l.docs, support: l.support, privacy: l.privacy, terms: l.terms, repository: l.repository ?? repo?.replace(/^git\+/, '') })) {
    const u = https(v);
    if (u) links[k as keyof BundleInfo['links']] = u;
  }
  let changelog: string | undefined;
  const cf = inside(dir, m.changelog ?? 'CHANGELOG.md');
  if (cf) { const t = await fs.readFile(cf, 'utf8').catch(() => undefined); if (t) changelog = t.length > 32_768 ? `${t.slice(0, 32_768)}\n...` : t; }
  const author = person(m.author);
  const publisher = person(m.publisher);
  return {
    displayName, ...(icon ? { icon } : {}), ...(iconData ? { iconData } : {}), tags,
    ...(typeof m.category === 'string' ? { category: m.category } : {}),
    ...(author ? { author } : {}), ...(publisher ? { publisher } : {}),
    ...(typeof m.license === 'string' ? { license: m.license } : {}),
    links, ...(changelog ? { changelog } : {}), compat: compatibility(m),
    ...(https(m.updates?.url) ? { updatesUrl: https(m.updates!.url) } : {}),
  };
}
