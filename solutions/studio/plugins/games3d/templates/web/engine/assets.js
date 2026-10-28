// Assets from Studio's folders (plugins/games3d/sdk/FORMATS.md): a reference in game.json is
//   "asset:<id>"                 .studio/assets/<id>/ (its asset.json says which file is which)
//   "path/to/file.png"           a file in the game's folder
// Loaders: images, sprite sheets (sheet.png + sheet.frames.json, or Aseprite JSON, or the
// manifest's frameSize and animations), levels (level.json rows from studio_procgen, or a Tiled
// .tmj), tile strips, WAV sounds and glTF models (3D: the template passes its GLTFLoader).
// Nothing throws for a missing asset: it is logged (console.warn), listed in assets.missing,
// and the loader returns null so the game draws its fallback.

const cache = new Map();
export const missing = [];

const note = (ref, why) => { missing.push(`${ref}: ${why}`); console.warn(`studio asset ${ref}: ${why}`); return null; };

async function fetchOk(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r;
}

/** What a reference points at: { dir, manifest, url(role|path) } for asset:<id>; { url } for a path. */
export async function resolve(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (cache.has(`r:${ref}`)) return cache.get(`r:${ref}`);
  let out;
  if (ref.startsWith('asset:')) {
    const id = ref.slice(6);
    const dir = `.studio/assets/${id}/`;
    try {
      const manifest = await (await fetchOk(`${dir}asset.json`)).json();
      const fileOf = (pick) => manifest.files?.find(pick)?.path;
      out = {
        id, dir, manifest,
        main: fileOf((f) => f.role === 'main') ? dir + fileOf((f) => f.role === 'main') : null,
        file: (test) => { const f = fileOf(typeof test === 'function' ? test : (x) => x.role === test || x.path === test || x.path.endsWith(test)); return f ? dir + f : null; },
      };
    } catch (e) { out = note(ref, `no asset.json (${e.message})`); }
  } else out = { id: null, dir: ref.replace(/[^/]*$/, ''), manifest: null, main: ref, file: (t) => (typeof t === 'string' && !t.includes('/') ? ref.replace(/[^/]*$/, '') + t : null) };
  cache.set(`r:${ref}`, out);
  return out;
}

export function loadImageUrl(url) {
  if (cache.has(`i:${url}`)) return cache.get(`i:${url}`);
  const p = new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`image ${url} did not load`));
    img.src = url;
  });
  cache.set(`i:${url}`, p);
  return p;
}

/** An image asset (its main PNG). */
export async function loadImage(ref) {
  const r = await resolve(ref);
  if (!r?.main) return r ? note(ref, 'no main file') : null;
  try { return await loadImageUrl(r.main); } catch (e) { return note(ref, e.message); }
}

/**
 * A sprite sheet: { image, frameWidth, frameHeight, animations: { name: { frames: [{x, y, w, h, durationMs}], fps, loop } } }.
 * From sheet.frames.json (studio_sprite), an Aseprite JSON (frameTags), or the manifest's meta
 * (frameSize, columns, animations {row, from, count, fps, loop} or anims {name: count} in rows).
 */
export async function loadSheet(ref) {
  const r = await resolve(ref);
  if (!r?.main) return r ? note(ref, 'no main file') : null;
  let image;
  try { image = await loadImageUrl(r.main); } catch (e) { return note(ref, e.message); }
  const meta = r.manifest?.meta ?? {};
  const framesUrl = r.file((f) => /frames\.json$/.test(f.path)) ?? (r.manifest ? null : r.main.replace(/\.png$/i, '.frames.json'));
  if (framesUrl) {
    try {
      const j = await (await fetchOk(framesUrl)).json();
      if (j.animations) return { image, frameWidth: j.frameWidth, frameHeight: j.frameHeight, animations: j.animations };
    } catch { /* fall through to the other descriptions */ }
  }
  const aseUrl = r.file((f) => /aseprite\.json$/.test(f.path));
  if (aseUrl) {
    try {
      const j = await (await fetchOk(aseUrl)).json();
      const list = Array.isArray(j.frames) ? j.frames : Object.values(j.frames);
      const animations = {};
      for (const t of j.meta?.frameTags ?? []) animations[t.name] = { fps: 1000 / (list[t.from]?.duration || 100), loop: true, frames: list.slice(t.from, t.to + 1).map((f) => ({ ...f.frame, durationMs: f.duration })) };
      if (Object.keys(animations).length) return { image, frameWidth: list[0].frame.w, frameHeight: list[0].frame.h, animations };
    } catch { /* fall through */ }
  }
  const [fw, fh] = meta.frameSize ?? [image.width, image.height];
  const columns = meta.columns ?? Math.max(1, Math.floor(image.width / fw));
  const fps = meta.fps ?? 8;
  const animations = {};
  const cell = (i) => ({ x: (i % columns) * fw, y: Math.floor(i / columns) * fh, w: fw, h: fh, durationMs: 1000 / fps });
  if (meta.animations && typeof meta.animations === 'object' && !Array.isArray(meta.animations)) {
    for (const [name, a] of Object.entries(meta.animations)) {
      const start = (a.row ?? 0) * columns + (a.from ?? 0);
      animations[name] = { fps: a.fps ?? fps, loop: a.loop !== false, frames: Array.from({ length: a.count ?? 1 }, (_, i) => cell(start + i)) };
    }
  } else if (meta.anims) {
    Object.entries(meta.anims).forEach(([name, count], row) => { animations[name] = { fps, loop: true, frames: Array.from({ length: count }, (_, i) => ({ ...cell(0), x: i * fw, y: row * fh })) }; });
  } else animations.default = { fps, loop: true, frames: Array.from({ length: meta.frames ?? columns }, (_, i) => cell(i)) };
  return { image, frameWidth: fw, frameHeight: fh, animations };
}

/** Plays a sheet's animations: play(name) switches (or keeps) the animation; draw() at a point (feet or centre). */
export class Animator {
  constructor(sheet, name) { this.sheet = sheet; this.t = 0; this.name = null; this.play(name ?? Object.keys(sheet?.animations ?? {})[0]); }
  has(name) { return !!this.sheet?.animations?.[name]; }
  play(name, restart = false) {
    if (!this.sheet) return;
    const pick = this.sheet.animations[name] ? name : this.sheet.animations.idle ? 'idle' : Object.keys(this.sheet.animations)[0];
    if (pick !== this.name || restart) { this.name = pick; this.t = 0; }
  }
  update(dt) { this.t += dt; }
  frame() {
    const a = this.sheet?.animations?.[this.name];
    if (!a?.frames?.length) return null;
    const ms = a.frames[0].durationMs ?? 1000 / (a.fps ?? 8);
    const i = Math.floor((this.t * 1000) / ms);
    return a.frames[a.loop === false ? Math.min(i, a.frames.length - 1) : i % a.frames.length];
  }
  get done() { const a = this.sheet?.animations?.[this.name]; return !a || (a.loop === false && this.t * 1000 >= a.frames.length * (a.frames[0].durationMs ?? 100)); }
  /** Draws the current frame with its bottom centre at (x, y), scaled, flipped horizontally if asked. */
  draw(ctx, x, y, { scale = 1, flip = false, anchor = 'bottom', alpha = 1 } = {}) {
    const f = this.frame();
    if (!f) return false;
    const w = f.w * scale, h = f.h * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(Math.round(x), Math.round(y));
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(this.sheet.image, f.x, f.y, f.w, f.h, -w / 2, anchor === 'bottom' ? -h : -h / 2, w, h);
    ctx.restore();
    return true;
  }
}

/**
 * A level: { type, rows, width, height, tile, start: [x, y], exit: [x, y], physics, legend, objects, tiles: {image, chars} }.
 * From a level asset (level.json rows, tiles.png in tiles.tsj's order), a level.json path, or a Tiled .tmj.
 */
export async function loadLevel(ref) {
  const r = await resolve(ref);
  if (!r) return null;
  const levelUrl = r.manifest ? r.file('level') ?? r.file('level.json') : r.main;
  const tmjUrl = r.manifest ? r.file((f) => f.path.endsWith('.tmj')) : /\.tmj$/.test(r.main) ? r.main : null;
  let level = null;
  if (levelUrl && !/\.tmj$/.test(levelUrl)) {
    try { level = await (await fetchOk(levelUrl)).json(); } catch (e) { note(ref, e.message); }
  }
  if (!level && tmjUrl) {
    try { level = fromTiled(await (await fetchOk(tmjUrl)).json()); } catch (e) { return note(ref, e.message); }
  }
  if (!level || !Array.isArray(level.rows)) return note(ref, 'no rows (level.json) or tile layer (.tmj)');
  level.width ??= Math.max(...level.rows.map((x) => x.length));
  level.height ??= level.rows.length;
  level.tile ??= r.manifest?.meta?.tile ?? 16;
  // The level's tiles: a strip of tile images in tiles.tsj's character order.
  const tilesUrl = r.manifest ? r.file('tiles') ?? r.file('tiles.png') : null;
  if (tilesUrl) {
    try {
      const image = await loadImageUrl(tilesUrl);
      let chars = null;
      const tsj = r.file('tiles.tsj');
      if (tsj) {
        try {
          const t = await (await fetchOk(tsj)).json();
          // studio_procgen names each tile's level character in a "char" property.
          const named = (t.tiles ?? []).map((x) => [x.id, x.properties?.find((p) => p.name === 'char')?.value]).filter(([, c]) => typeof c === 'string');
          if (named.length) { chars = []; for (const [id, c] of named) chars[id] = c; }
        } catch { /* default order */ }
      }
      level.tiles = { image, chars, size: image.height };
    } catch { /* drawn with colours */ }
  }
  return level;
}

/** A Tiled map as level rows: '#' where the first tile layer has a tile, objects as their letters. */
export function fromTiled(map) {
  const layer = map.layers.find((l) => l.type === 'tilelayer');
  const W = map.width, H = map.height;
  const rows = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (layer?.data?.[y * W + x] ? '#' : '.')));
  const letter = { start: 'S', exit: 'E', coin: 'o', enemy: 'e', gem: '*', chest: '$', monster: 'm', key: 'k' };
  let start = null, exit = null;
  for (const g of map.layers.filter((l) => l.type === 'objectgroup')) {
    for (const o of g.objects ?? []) {
      const kind = String(o.type || o.class || o.name).toLowerCase();
      const x = Math.floor(o.x / map.tilewidth), y = Math.floor((o.y - (o.point ? 0 : 0)) / map.tileheight);
      if (y < 0 || y >= H || x < 0 || x >= W) continue;
      if (letter[kind]) rows[y][x] = letter[kind];
      if (kind === 'start') start = [x, y];
      if (kind === 'exit') exit = [x, y];
    }
  }
  const props = Object.fromEntries((map.properties ?? []).map((p) => [p.name, p.value]));
  let physics;
  try { physics = props.physics ? JSON.parse(props.physics) : undefined; } catch { physics = undefined; }
  return { type: props.type ?? 'tiled', rows: rows.map((r) => r.join('')), width: W, height: H, tile: map.tilewidth, start, exit, physics };
}

/** Finds the cells of a character in level rows. */
export function cellsOf(rows, ch) {
  const out = [];
  rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === ch) out.push([x, y]); });
  return out;
}

/** A GLB model (3D templates): loader is a three/addons GLTFLoader instance. */
export async function loadModel(ref, loader) {
  const r = await resolve(ref);
  if (!r?.main) return r ? note(ref, 'no main file') : null;
  try { return await new Promise((res, rej) => loader.load(r.main, res, undefined, rej)); } catch (e) { return note(ref, `the model did not load (${e?.message ?? e})`); }
}

/** A parallax background asset: [{ image, factor, drift }] back to front (studio_sprite parallax). */
export async function loadParallax(ref) {
  const r = await resolve(ref);
  if (!r) return null;
  const url = r.file('parallax.json');
  if (!url) return note(ref, 'no parallax.json');
  try {
    const j = await (await fetchOk(url)).json();
    return Promise.all(j.layers.map(async (l) => ({ image: await loadImageUrl(r.dir + l.file), factor: l.factor, drift: l.driftPxPerSecond ?? 0 })));
  } catch (e) { return note(ref, e.message); }
}
