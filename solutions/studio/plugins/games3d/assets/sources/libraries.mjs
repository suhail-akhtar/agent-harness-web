// CC0 asset libraries: Poly Haven (api.polyhaven.com: models, textures, HDRIs), ambientCG
// (ambientcg.com/api/v2: PBR materials as zips) and Kenney (kenney.nl: game asset packs as
// zips). Each one searches and downloads with the fetch it is given (the plugin's api.fetch,
// limited to the hosts in permissions.network), and records the licence and the source.

import { readZip } from './zip.mjs';

const UA = { 'User-Agent': 'agent-harness-studio/1.0 (game asset pipeline)' };
const MAX_BYTES = 200 * 1048576;

async function json(fetch, url) {
  const r = await fetch(url, { headers: { ...UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status} for ${url}`);
  return r.json();
}

/** Downloads bytes (refusing past maxBytes). */
export async function bytes(fetch, url, maxBytes = MAX_BYTES) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status} for ${url}`);
  const len = Number(r.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new Error(`${url} is ${(len / 1048576).toFixed(0)} MB, over the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length > maxBytes) throw new Error(`${url} is over the ${(maxBytes / 1048576).toFixed(0)} MB limit`);
  return b;
}

const words = (q) => String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
const matches = (hay, q) => words(q).every((w) => hay.includes(w));

// ---------- Poly Haven ----------

const PH_TYPES = { model: 'models', models: 'models', texture: 'textures', textures: 'textures', hdri: 'hdris', hdris: 'hdris' };
const PH_MAPS = { Diffuse: 'basecolor', nor_gl: 'normal', Rough: 'roughness', AO: 'ao', Displacement: 'height', arm: 'arm', Metal: 'metallic' };

export const polyhaven = {
  id: 'polyhaven', name: 'Poly Haven', license: 'CC0-1.0', hosts: ['api.polyhaven.com', 'dl.polyhaven.org'],
  async search(fetch, { query, type = 'models', limit = 20 } = {}) {
    const t = PH_TYPES[type] ?? 'models';
    const all = await json(fetch, `https://api.polyhaven.com/assets?type=${t}`);
    return Object.entries(all).filter(([id, a]) => !query || matches(`${id} ${a.name} ${(a.tags ?? []).join(' ')} ${(a.categories ?? []).join(' ')}`.toLowerCase(), query))
      .sort((x, y) => (y[1].download_count ?? 0) - (x[1].download_count ?? 0)).slice(0, limit)
      .map(([id, a]) => ({ id, name: a.name, type: t, tags: a.tags ?? [], categories: a.categories ?? [], authors: Object.keys(a.authors ?? {}), url: `https://polyhaven.com/a/${id}` }));
  },
  /** Files of one asset at a resolution: a model's glTF with its buffers and textures, a texture's maps, an HDRI. */
  async download(fetch, { id, resolution = '1k', format } = {}) {
    if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error('a Poly Haven id is letters, digits, _ and -');
    const [info, files] = await Promise.all([json(fetch, `https://api.polyhaven.com/info/${id}`), json(fetch, `https://api.polyhaven.com/files/${id}`)]);
    const out = [];
    let kind = 'texture';
    if (files.gltf) {
      kind = 'model';
      const g = files.gltf[resolution] ?? Object.values(files.gltf)[0];
      const main = g.gltf;
      out.push({ path: `${id}.gltf`, role: 'main', url: main.url });
      for (const [rel, f] of Object.entries(main.include ?? {})) out.push({ path: rel, role: rel.endsWith('.bin') ? 'buffer' : 'texture', url: f.url });
    } else if (files.hdri) {
      kind = 'texture';
      const h = files.hdri[resolution] ?? Object.values(files.hdri)[0];
      const f = h[format ?? 'hdr'] ?? Object.values(h)[0];
      out.push({ path: `${id}_${resolution}.${format ?? 'hdr'}`, role: 'main', url: f.url });
    } else {
      kind = 'material';
      for (const [map, role] of Object.entries(PH_MAPS)) {
        const m = files[map]?.[resolution];
        if (!m) continue;
        const fmt = format ?? (m.png && role === 'normal' ? 'png' : m.jpg ? 'jpg' : 'png');
        const f = m[fmt] ?? m.jpg ?? m.png;
        if (f) out.push({ path: `${id}_${role}_${resolution}.${fmt}`, role: out.length ? role : 'main', url: f.url });
      }
    }
    if (!out.length) throw new Error(`Poly Haven has no files for ${id} at ${resolution}`);
    for (const f of out) f.data = await bytes(fetch, f.url);
    const authors = Object.keys(info.authors ?? {});
    return {
      kind, name: info.name ?? id, files: out.map(({ url, ...f }) => f), tags: info.tags ?? [],
      license: { id: 'CC0-1.0', author: authors.join(', ') || 'Poly Haven', url: `https://polyhaven.com/a/${id}` },
      source: { type: 'library', provider: 'polyhaven', id, url: `https://polyhaven.com/a/${id}`, resolution },
      meta: { resolution, ...(info.dimensions ? { realWorldMm: info.dimensions } : {}) },
    };
  },
};

// ---------- ambientCG ----------

const ACG_MAPS = [['Color', 'basecolor'], ['NormalGL', 'normal'], ['Roughness', 'roughness'], ['AmbientOcclusion', 'ao'], ['Displacement', 'height'], ['Metalness', 'metallic'], ['Opacity', 'opacity']];

export const ambientcg = {
  id: 'ambientcg', name: 'ambientCG', license: 'CC0-1.0', hosts: ['ambientcg.com', 'acg-download.struffelproductions.com', 'acg-media.struffelproductions.com'],
  async search(fetch, { query, type = 'Material', limit = 20 } = {}) {
    const j = await json(fetch, `https://ambientcg.com/api/v2/full_json?type=${encodeURIComponent(type)}&q=${encodeURIComponent(query ?? '')}&limit=${limit}&include=downloadData,tagData`);
    return (j.foundAssets ?? []).map((a) => ({ id: a.assetId, name: a.displayName, type: a.dataType, tags: a.tags ?? [], downloads: (a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? []).map((d) => d.attribute), url: `https://ambientcg.com/view?id=${a.assetId}` }));
  },
  async download(fetch, { id, resolution = '1K-PNG' } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(id))) throw new Error('an ambientCG id is letters and digits (e.g. Bricks059)');
    const j = await json(fetch, `https://ambientcg.com/api/v2/full_json?id=${encodeURIComponent(id)}&include=downloadData,tagData`);
    const a = (j.foundAssets ?? [])[0];
    if (!a) throw new Error(`ambientCG has no asset ${id}`);
    const dl = (a.downloadFolders?.default?.downloadFiletypeCategories?.zip?.downloads ?? []);
    const pick = dl.find((d) => d.attribute === resolution) ?? dl.find((d) => /^1K/.test(d.attribute)) ?? dl[0];
    if (!pick) throw new Error(`ambientCG lists no zip downloads for ${id}`);
    const zip = readZip(await bytes(fetch, pick.downloadLink ?? pick.fullDownloadPath));
    const files = [];
    for (const [suffix, role] of ACG_MAPS) {
      const e = zip.find((z) => new RegExp(`_${suffix}\\.(png|jpg)$`, 'i').test(z.name));
      if (e) files.push({ path: `${id}_${role}${e.name.slice(e.name.lastIndexOf('.'))}`.toLowerCase(), role: files.length ? role : 'main', data: e.data() });
    }
    if (!files.length) throw new Error(`the ${id} zip had no texture maps (${zip.map((z) => z.name).join(', ')})`);
    return {
      kind: 'material', name: a.displayName ?? id, files, tags: a.tags ?? [],
      license: { id: 'CC0-1.0', author: 'ambientCG (Lennart Demes)', url: `https://ambientcg.com/view?id=${id}` },
      source: { type: 'library', provider: 'ambientcg', id, url: `https://ambientcg.com/view?id=${id}`, resolution: pick.attribute },
      meta: { resolution: pick.attribute },
    };
  },
};

// ---------- Kenney ----------

export const kenney = {
  id: 'kenney', name: 'Kenney', license: 'CC0-1.0', hosts: ['kenney.nl', 'www.kenney.nl'],
  async search(fetch, { query, limit = 20 } = {}) {
    const r = await fetch(`https://kenney.nl/assets?search=${encodeURIComponent(query ?? '')}`, { headers: UA });
    if (!r.ok) throw new Error(`kenney.nl answered ${r.status}`);
    const html = await r.text();
    const slugs = [...new Set([...html.matchAll(/https:\/\/kenney\.nl\/assets\/([a-z0-9-]+)["']/g)].map((m) => m[1]))].filter((s) => !['category', 'series', 'tag', 'page'].includes(s));
    return slugs.slice(0, limit).map((s) => ({ id: s, name: s.replace(/-/g, ' '), url: `https://kenney.nl/assets/${s}` }));
  },
  /** A pack: its page, the zip it links, the files in it (up to `max`, images, models, audio, fonts and the licence). */
  async download(fetch, { id, max = 400, include } = {}) {
    if (!/^[a-z0-9-]+$/.test(String(id))) throw new Error('a Kenney asset id is the slug in its address, e.g. tiny-dungeon');
    const r = await fetch(`https://kenney.nl/assets/${id}`, { headers: UA });
    if (!r.ok) throw new Error(`kenney.nl answered ${r.status} for ${id}`);
    const html = await r.text();
    const link = (html.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/[^"'\s]+\.zip/) ?? [])[0];
    if (!link) throw new Error(`no download link on the ${id} page`);
    const zip = readZip(await bytes(fetch, link));
    const keep = zip.filter((z) => /\.(png|glb|gltf|bin|fbx|obj|mtl|ogg|wav|mp3|ttf|otf|txt|svg|tsx|tmx|json)$/i.test(z.name) && (!include || new RegExp(include, 'i').test(z.name))).slice(0, max);
    const licence = zip.find((z) => /licen[cs]e\.txt$/i.test(z.name));
    const files = keep.map((z, i) => ({ path: z.name.replace(/^[^/]*\//, '').replace(/[^\w./-]/g, '_'), role: i ? 'extra' : 'main', data: z.data() }));
    const lic = licence ? licence.data().toString('utf8') : '';
    return {
      kind: 'pack', name: id.replace(/-/g, ' '), files, tags: ['kenney', ...id.split('-')],
      license: { id: /CC0|Creative Commons Zero|public domain/i.test(lic) || !lic ? 'CC0-1.0' : 'LicenseRef-Kenney', author: 'Kenney (www.kenney.nl)', url: `https://kenney.nl/assets/${id}`, ...(lic ? { text: lic.slice(0, 600) } : {}) },
      source: { type: 'library', provider: 'kenney', id, url: `https://kenney.nl/assets/${id}`, zip: link },
      meta: { files: files.length, inZip: zip.length },
    };
  },
};

export const LIBRARIES = { polyhaven, ambientcg, kenney };
