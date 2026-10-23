// What every Studio asset tool shares: saving an asset (files, manifest, an optional copy
// into the engine project), previews the agent sees, and small input readers.

import path from 'node:path';
import { readIn, relIn, writeIn } from '../lib-engines.mjs';
import { projectOf, slug, writeAsset } from './library.mjs';
import { decodePNG, encodePNG } from './raster/png.mjs';

export const num = (v, def, lo = -Infinity, hi = Infinity) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
export const int = (v, def, lo, hi) => Math.round(num(v, def, lo, hi));
export const seedIn = (input) => (input.seed === undefined || input.seed === null || input.seed === '' ? 1 : typeof input.seed === 'number' ? input.seed : String(input.seed));

/** A preview the agent sees: small pixel art scaled up (nearest) to about 256-512 px. */
export function preview(img, { min = 256, max = 768 } = {}) {
  const big = Math.max(img.width, img.height);
  const k = big >= min ? 1 : Math.max(1, Math.floor(min / big));
  const out = k > 1 ? img.scale(img.width * k, img.height * k, 'nearest') : big > max ? img.scale((img.width * max) / big, (img.height * max) / big, 'bilinear') : img;
  return { media_type: 'image/png', data: encodePNG(out).toString('base64') };
}

/** Reads a PNG from the workspace as an Image. */
export async function readImage(host, p, signal) {
  const rel = await relIn(host, String(p));
  return decodePNG(await readIn(host, rel, signal));
}

/**
 * Saves a built asset: the files into .studio/assets/<id>/ with asset.json, and with `export`
 * a copy of the main files into a workspace folder (an engine project's assets folder).
 * Returns the text lines and the asset.
 */
export async function save(ctx, input, a) {
  const { host, signal } = ctx;
  const project = await projectOf(host, input.project);
  const id = input.id ? slug(input.id) : a.id;
  const files = a.files.map((f) => ({ ...f, data: f.image ? encodePNG(f.image) : f.data }));
  const { dir, manifest } = await writeAsset(host, project, { ...a, id, files, tags: [...(a.tags ?? []), ...[].concat(input.tags ?? [])], style: input.style ?? a.style }, signal);
  const lines = [`Asset ${manifest.id} (${manifest.kind}) in ${dir}: ${files.map((f) => f.path).join(', ')}`];
  if (input.export) {
    const to = await relIn(host, String(input.export));
    for (const f of files.filter((x) => x.role !== 'preview')) await writeIn(host, path.posix.join(to, f.path), f.data, signal);
    lines.push(`Copied into ${to}/ for the engine.`);
  }
  return { lines, manifest, dir };
}

/** An action dispatcher's error for an unknown action. */
export const unknownAction = (tool, action, actions) => ({ content: `${tool}: unknown action "${action}". Actions: ${actions.join(', ')}.`, is_error: true });

/** Wraps a handler so thrown errors come back as tool errors the agent can act on. */
export const guarded = (name, fn) => async (input, ctx) => {
  try { return await fn(input, ctx); } catch (e) { return { content: `${name} ${input.action ?? ''}: ${e.message}`, is_error: true }; }
};
