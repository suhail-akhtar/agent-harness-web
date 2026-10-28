// studio_procgen: noise, heightmaps, levels (dungeons, caves, mazes, platformers proven by a
// solver, top-down maps, Wave Function Collapse), L-system plants and names. Levels are
// saved as JSON grids, Tiled .tmj maps with their tileset, and a rendered preview.

import { readIn, relIn } from '../lib-engines.mjs';
import { guarded, int, num, preview, save, seedIn, unknownAction } from './common.mjs';
import { heightmap, heightPreview, splatMap } from './gen/heightmap.mjs';
import { caves, checkConnected, dungeon, maze, shortestPath, PASSABLE, topdown } from './gen/levels.mjs';
import { drawLsystem, expand, PRESETS, turtle3d } from './gen/lsystem.mjs';
import { names, NAME_STYLES } from './gen/names.mjs';
import { noiseField } from './gen/noise.mjs';
import { LEGEND as PLATFORM_LEGEND, physicsOf, platformer, solvePlatformer } from './gen/platformer.mjs';
import { toTiled, toTilesetJson } from './gen/tiled.mjs';
import { TILESETS, wfcOverlapping, wfcTiled } from './gen/wfc.mjs';
import { parseColor } from './raster/color.mjs';
import { gradientAt, Image } from './raster/image.mjs';
import { encodeGray16 } from './raster/png.mjs';
import { renderSprite } from './sprites/sprite.mjs';
import { terrainTexture } from './sprites/tiles.mjs';

const sprite = (kind, size, seed = 1, o = {}) => Object.values(renderSprite({ kind, size, seed, ...o }).frames)[0][0];

/** Tiles for a level type: { tiles: chars in order, image per char, objects, empty }. */
export function levelTiles(type, size = 16, seed = 1) {
  const t = (name, o) => terrainTexture(name, size, { seed, ...o });
  const on = (base, top) => { const im = base.clone(); im.draw(top, 0, 0); return im; };
  const marker = (base, color) => { const im = base.clone(); im.circle(size / 2, size / 2, size * 0.32, color); im.circle(size / 2, size / 2, size * 0.2, '#ffffff'); return im; };
  const stairs = (base) => { const im = base.clone(); for (let i = 0; i < 4; i++) im.rect(size * 0.15, size * (0.2 + i * 0.17), size * 0.7 - i * size * 0.1, size * 0.12, i % 2 ? '#2a2238' : '#4a3a58'); return im; };
  if (type === 'platformer') {
    const dirt = t('dirt'), grass = t('grass');
    const ground = dirt.clone();
    const top = dirt.clone();
    top.draw(grass.crop(0, 0, size, Math.ceil(size / 3)), 0, 0, { mode: 'replace' });
    for (let x = 0; x < size; x++) top.set(x, Math.ceil(size / 3), (x * 7) % 3 ? parseColor('#3f7a2a') : parseColor('#2a5a1a'));
    const plank = new Image(size, size); plank.draw(t('wood').crop(0, 0, size, Math.ceil(size / 3)), 0, 0);
    const spikes = new Image(size, size);
    for (let i = 0; i < 3; i++) spikes.polygon([[i * size / 3, size], [i * size / 3 + size / 6, size * 0.35], [(i + 1) * size / 3, size]], '#c8ccd8');
    const flag = new Image(size, size); flag.rect(size * 0.2, size * 0.1, Math.max(1, size / 16), size * 0.9, '#5a4a3a'); flag.polygon([[size * 0.25, size * 0.1], [size * 0.85, size * 0.25], [size * 0.25, size * 0.45]], '#e8403a');
    return { tiles: ['#', 'G', 'X', '-', '^', 'o', 'e', 'S', 'E'], images: { '#': ground, G: top, X: t('brick'), '-': plank, '^': spikes.outline('#2a2238'), o: sprite('coin', size), e: sprite('slime', size), S: flag, E: flag.clone().paint((x, y) => (flag.get(x, y)[0] === 232 ? [60, 200, 90, 255] : null), { blend: false }) }, empty: ['.'], objects: { S: { type: 'start', under: '.' }, E: { type: 'exit', under: '.' }, o: { type: 'coin', under: '.' }, e: { type: 'enemy', under: '.' } } };
  }
  if (type === 'maze') return { tiles: ['#', '.', 'S', 'E'], images: { '#': t('darkgrass'), '.': t('path'), S: marker(t('path'), '#3ac85a'), E: marker(t('path'), '#e8403a') }, empty: [], objects: { S: { type: 'start', under: '.' }, E: { type: 'exit', under: '.' } } };
  if (type === 'topdown') {
    const imgs = { '~': t('water', { color: '#2a5aa8' }), w: t('water'), s: t('sand'), g: t('grass'), f: on(t('darkgrass'), sprite('tree', size, seed)), h: t('grass', { color: '#8aa84a' }), M: t('stone'), '*': t('snow'), '=': t('path'), T: on(t('path'), sprite('chest', size)) };
    imgs.S = marker(imgs.g, '#3ac85a'); imgs.E = marker(imgs.g, '#e8403a');
    return { tiles: Object.keys(imgs), images: imgs, empty: [], objects: { S: { type: 'start', under: 'g' }, E: { type: 'exit', under: 'g' } } };
  }
  const floor = type === 'cave' ? t('dirt') : t('stone', { color: '#7a7480' });
  const wall = type === 'cave' ? t('stone', { color: '#4a4652' }) : t('wall');
  if (type !== 'cave') for (let x = 0; x < size; x++) { wall.set(x, 0, parseColor('#8a8aa0')); wall.set(x, size - 1, parseColor('#2a2a38')); }
  const door = t('wood'); door.rect(0, 0, size, size, '#3a2a1a', { fill: false });
  return {
    tiles: ['#', '.', '+', 'S', 'E', '$', 'm'],
    images: { '#': wall, '.': floor, '+': door, S: marker(floor, '#3ac85a'), E: stairs(floor), $: on(floor, sprite('chest', size)), m: on(floor, sprite(type === 'cave' ? 'bat' : 'slime', size, seed)) },
    empty: [], objects: { S: { type: 'start', under: '.' }, E: { type: 'exit', under: '.' }, $: { type: 'chest', under: '.' }, m: { type: 'monster', under: '.' } },
  };
}

/** Rows as they are drawn (a platformer's ground with air above gets its grass top). */
function drawRows(rows, type) {
  if (type !== 'platformer') return rows;
  return rows.map((r, y) => [...r].map((c, x) => (c === '#' && (y === 0 || !['#', 'X'].includes(rows[y - 1][x])) ? 'G' : c)).join(''));
}

/** A level's preview, its tileset image and its Tiled files. */
export function levelFiles(level, { size = 16, seed = 1, path: pathCells } = {}) {
  const lt = levelTiles(level.type, size, seed);
  const rows = drawRows(level.rows, level.type);
  const W = Math.max(...rows.map((r) => r.length)), H = rows.length;
  const img = new Image(W * size, H * size, level.type === 'platformer' ? '#8ac8f0' : '#000000');
  rows.forEach((r, y) => [...r].forEach((c, x) => { const im = lt.images[c]; if (im) img.draw(im, x * size, y * size); }));
  for (const [x, y] of pathCells ?? []) img.rect(x * size + size * 0.4, y * size + size * 0.4, size * 0.2, size * 0.2, '#ffe04a');
  const tilesImg = new Image(size * lt.tiles.length, size);
  lt.tiles.forEach((c, i) => tilesImg.draw(lt.images[c], i * size, 0));
  const tmj = toTiled({ rows, tileSize: size, tiles: lt.tiles, empty: lt.empty, objects: lt.objects, properties: { type: level.type, seed: String(level.seed ?? seed), ...(level.physics ? { physics: level.physics } : {}) } });
  const tsj = toTilesetJson({ image: 'tiles.png', tileSize: size, count: lt.tiles.length, columns: lt.tiles.length, name: `${level.type}-tiles`, chars: lt.tiles });
  return { preview: img, tilesImg, tmj, tsj };
}

async function saveLevel(ctx, input, level, { name, extraMeta = {}, pathCells, proof } = {}) {
  const size = int(input.tileSize, 16, 4, 64);
  const f = levelFiles(level, { size, seed: seedIn(input), path: input.showPath ? pathCells : undefined });
  const json = { ...level, ...(proof ? { proof } : {}) };
  const r = await save(ctx, input, {
    id: input.id ?? `level-${level.type}-${seedIn(input)}`, name: name ?? `${level.type} ${seedIn(input)}`, kind: 'level',
    files: [{ path: 'level.json', role: 'level', data: JSON.stringify(json, null, 1) }, { path: 'level.tmj', role: 'tiled', data: JSON.stringify(f.tmj, null, 1) }, { path: 'tiles.tsj', role: 'tiled', data: JSON.stringify(f.tsj, null, 1) }, { path: 'tiles.png', role: 'tiles', image: f.tilesImg }, { path: 'preview.png', role: 'preview', image: f.preview }],
    meta: { levelType: level.type, width: level.width ?? level.rows[0].length, height: level.height ?? level.rows.length, tile: size, ...extraMeta },
    source: { type: 'procedural', generator: `studio:level:${level.type}`, seed: seedIn(input), params: input.params ?? {} }, tags: ['level', level.type],
  });
  return { r, f };
}

const ACTIONS = ['noise', 'heightmap', 'dungeon', 'cave', 'maze', 'platformer', 'topdown', 'wfc', 'lsystem', 'names', 'solve'];

export const procgenTool = {
  name: 'studio_procgen',
  description: 'Procedural generation, deterministic by seed. action: "noise" a noise texture (type value|perlin|simplex|worley|ridged, scale, octaves, tileable, warp, colour stops); "heightmap" terrain heights as a 16-bit PNG plus a shaded preview and splat masks (R sand, G grass, B rock, A snow) and JSON (size 2^n+1 for Unity/Unreal: 257, 513, 1025); "dungeon" BSP rooms and corridors; "cave" cellular automata, all pockets joined; "maze" (algorithm backtracker|prim|kruskal|binary, braid for loops); "platformer" a side-scroller level built from the player\'s physics (jumpHeight tiles, runSpeed tiles/s, gravity, difficulty 0-1) and proven finishable by a solver that simulates every walk, jump and fall; "topdown" an overworld (biomes, towns, roads); "wfc" Wave Function Collapse: model "tiled" (tiles with edge sockets, or the built-in sets roads|coast) or "overlapping" (learns NxN patterns from `sample` rows); "lsystem" a plant from a preset (tree, bush, pine, fern, weed) or your axiom and rules, drawn as a sprite plus 3D branch segments (for studio_model tree); "names" (fantasy, elven, dwarven, orcish, scifi, place, tavern, item); "solve" checks a level (rows, or a level.json path) and returns its path. Levels are saved as assets: level.json (rows of characters, legend, start, exit, physics, proof), a Tiled .tmj with its tileset .tsj + tiles.png, and a preview you see.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'What to generate: noise, heightmap, dungeon, cave, maze, platformer, topdown, wfc, lsystem, names or solve' },
      seed: { type: ['number', 'string'], description: 'Same seed, same result (default 1)' },
      width: { type: 'number', description: 'Width in px (noise, default 256) or in tiles (dungeon 48, cave 64, maze cells 16, topdown 64, wfc 24)' }, height: { type: 'number', description: 'Height in px (noise, default the width) or in tiles (dungeon 32, cave 40, maze cells 12, topdown 48, platformer 18, wfc 16)' }, size: { type: 'number', description: 'heightmap side, noise size' },
      type: { type: 'string', description: 'noise: value|perlin|simplex|worley|ridged; solve: the level type' },
      scale: { type: 'number', description: 'noise/heightmap: feature size in px, larger is smoother (default a quarter of the width for noise, a third of the size for heightmap)' }, octaves: { type: 'number', description: 'noise/heightmap: layers of detail, 1-10 (default 4 for noise, 6 for heightmap)' }, tileable: { type: 'boolean', description: 'noise/heightmap: make the result wrap seamlessly at its edges (default false)' }, warp: { type: 'number', description: 'noise/heightmap: domain-warp amount that swirls the pattern (default 0 for noise, 0.6 for heightmap)' },
      stops: { type: 'array', description: 'noise: colour stops [[0,"#000"],[1,"#fff"]]' },
      ridges: { type: 'number', description: 'heightmap: how much ridged mountain noise is mixed in, 0-1 (default 0.3)' }, island: { type: 'boolean', description: 'heightmap: fall off to low ground at the edges, making an island (default false)' }, erosion: { type: 'number', description: 'heightmap: thermal erosion passes, 0-200 (default 20)' }, heightM: { type: 'number', description: 'heightmap: metres between black and white (recorded for engines)' },
      minRoom: { type: 'number', description: 'dungeon: smallest room side in tiles (default 4)' }, maxRoom: { type: 'number', description: 'dungeon: largest room side in tiles (default 10)' }, fill: { type: 'number', description: 'cave: share of cells that start as rock before smoothing, 0.3-0.6 (default 0.46)' },
      cols: { type: 'number', description: 'maze: cell columns (default the width, else 16)' }, rows: { type: ['number', 'array'], description: 'maze: cell rows; solve: the level rows' },
      algorithm: { type: 'string', description: 'maze: backtracker, prim, kruskal or binary (default backtracker)' }, braid: { type: 'number', description: 'maze: share of dead ends opened into loops, 0-1 (default 0)' },
      length: { type: 'number', description: 'platformer: columns' }, difficulty: { type: 'number', description: 'platformer: 0 (easy) to 1 (hard), default 0.5' },
      jumpHeight: { type: 'number', description: 'platformer/solve: the player\'s jump height in tiles (default 3.2)' }, runSpeed: { type: 'number', description: 'platformer/solve: the player\'s run speed in tiles per second (default 6)' }, gravity: { type: 'number', description: 'platformer/solve: gravity in tiles per second squared (default 40)' },
      towns: { type: 'number', description: 'topdown: how many towns, 2-20 (default 4)' },
      model: { type: 'string', enum: ['tiled', 'overlapping'], description: 'wfc: tiled (tiles with edge sockets) or overlapping (patterns from a sample); default overlapping when a sample is given, else tiled' }, tiles: { type: ['string', 'array'], description: 'wfc tiled: a built-in set (roads or coast, default roads) or a list of tiles like {"name":"road","sockets":["grg","ggg","grg","ggg"],"weight":2,"rotate":true}' }, sample: { type: ['string', 'array'], description: 'wfc overlapping: the example map as rows of characters (a list, or one string with newlines), e.g. ["##..", "#..."]' }, n: { type: 'number', description: 'wfc overlapping: pattern size N for NxN patterns, 2-4 (default 3)' }, symmetry: { type: 'number', description: 'wfc overlapping: how many rotations and reflections of each pattern to learn, 1-8 (default 8)' }, periodic: { type: 'boolean', description: 'wfc: the output wraps around at its edges (default false)' },
      preset: { type: 'string', description: 'lsystem: tree, bush, pine, fern or weed (default tree)' }, axiom: { type: 'string', description: 'lsystem: a start string replacing the preset\'s, e.g. "FA"' }, rules: { type: 'object', description: 'lsystem: rewrite rules replacing the preset\'s, e.g. {"F":"F[+F]F[-F]F"}' }, iterations: { type: 'number', description: 'lsystem: rewrite passes, 1-8 (default the preset\'s)' }, angle: { type: 'number', description: 'lsystem: turn angle in degrees (default the preset\'s)' },
      style: { type: 'string', description: 'names: fantasy, elven, dwarven, orcish, scifi, place, tavern or item (default fantasy); also a style label for saved assets' }, count: { type: 'number', description: 'names: how many names, 1-200 (default 12)' },
      level: { type: 'string', description: 'solve: a level.json in the workspace' },
      tileSize: { type: 'number', description: 'Tile size in px for previews and Tiled maps (16)' },
      showPath: { type: 'boolean', description: 'Draw the solution path on the preview' },
      id: { type: 'string', description: 'Asset id (default from the action and seed, e.g. "level-dungeon-1")' }, name: { type: 'string', description: 'What the asset is called on the Assets page (default from the id)' }, project: { type: 'string', description: 'Project folder (with .studio/project.json); default found' }, tags: { type: 'array', items: { type: 'string' }, description: 'Extra library tags for the asset, e.g. ["act1"]' }, export: { type: 'string', description: 'Also copy the files into this workspace folder (an engine project\'s assets)' },
    },
    required: ['action'],
  },
  kind: 'edit',
  sendsOut: false,
  summarize: (i) => `${i.action} ${i.seed ?? ''}`.trim(),
  run: guarded('studio_procgen', async (input, ctx) => {
    const a = String(input.action ?? '');
    const seed = seedIn(input);
    if (a === 'names') return names({ style: input.style ?? 'fantasy', count: int(input.count, 12, 1, 200), seed }).join('\n') + `\n(styles: ${NAME_STYLES.join(', ')})`;
    if (a === 'noise') {
      const w = int(input.width ?? input.size, 256, 8, 4096), h = int(input.height ?? input.size, w, 8, 4096);
      const f = noiseField({ width: w, height: h, type: input.type ?? 'perlin', scale: num(input.scale, w / 4, 1), octaves: int(input.octaves, 4, 1, 10), seed, tileable: !!input.tileable, warp: num(input.warp, 0, 0, 10) });
      const stops = input.stops ?? [[0, '#000000'], [1, '#ffffff']];
      const img = new Image(w, h);
      img.paint((x, y) => gradientAt(stops, f[y * w + x]), { blend: false });
      const r = await save(ctx, input, { id: input.id ?? `noise-${input.type ?? 'perlin'}-${seed}`, name: `${input.type ?? 'perlin'} noise`, kind: 'texture', files: [{ path: 'noise.png', role: 'main', image: img }], meta: { size: [w, h], tileable: !!input.tileable }, source: { type: 'procedural', generator: `studio:noise:${input.type ?? 'perlin'}`, seed, params: { scale: input.scale, octaves: input.octaves, warp: input.warp } }, tags: ['noise'] });
      return { content: r.lines.join('\n'), images: [preview(img)] };
    }
    if (a === 'heightmap') {
      const size = int(input.size, 257, 17, 4097);
      const h = heightmap({ size, seed, scale: input.scale, octaves: int(input.octaves, 6, 1, 10), ridges: num(input.ridges, 0.3, 0, 1), warp: num(input.warp, 0.6, 0, 5), island: !!input.island, erosion: int(input.erosion, 20, 0, 200), tileable: !!input.tileable });
      const pv = heightPreview(h, size);
      const splat = splatMap(h, size);
      const heightM = num(input.heightM, 100, 1, 10000);
      const r = await save(ctx, input, { id: input.id ?? `heightmap-${size}-${seed}`, name: `heightmap ${size}`, kind: 'heightmap', dimension: '3d', files: [{ path: 'height16.png', role: 'main', data: encodeGray16(h, size, size) }, { path: 'splat.png', role: 'splat', image: splat }, { path: 'preview.png', role: 'preview', image: pv }, { path: 'heightmap.json', role: 'data', data: JSON.stringify({ size, heightM, format: '16-bit greyscale PNG, black lowest', splat: { r: 'sand', g: 'grass', b: 'rock', a: 'snow' } }, null, 1) }], meta: { size: [size, size], heightM, bits: 16 }, source: { type: 'procedural', generator: 'studio:heightmap', seed, params: { ridges: input.ridges, island: input.island, erosion: input.erosion } }, tags: ['terrain', 'heightmap'] });
      return { content: `${r.lines.join('\n')}\n16-bit PNG (Unity terrain: import as RAW after converting, or Unreal Landscape import; Godot: HeightMapShape or a terrain add-on; Blender: studio_model action "terrain").`, images: [preview(pv)] };
    }
    if (['dungeon', 'cave', 'maze', 'topdown'].includes(a)) {
      const level = a === 'dungeon' ? dungeon({ width: int(input.width, 48, 16, 256), height: int(input.height, 32, 16, 256), seed, minRoom: int(input.minRoom, 4, 3, 20), maxRoom: int(input.maxRoom, 10, 4, 40) })
        : a === 'cave' ? caves({ width: int(input.width, 64, 16, 256), height: int(input.height, 40, 16, 256), seed, fill: num(input.fill, 0.46, 0.3, 0.6) })
          : a === 'maze' ? maze({ cols: int(input.cols ?? input.width, 16, 2, 128), rows: int(typeof input.rows === 'number' ? input.rows : input.height, 12, 2, 128), seed, algorithm: input.algorithm ?? 'backtracker', braid: num(input.braid, 0, 0, 1) })
            : topdown({ width: int(input.width, 64, 16, 256), height: int(input.height, 48, 16, 256), seed, towns: int(input.towns, 4, 2, 20) });
      const check = checkConnected(level.rows, level.type);
      if (!check.ok) throw new Error(`the ${a} came out unplayable (${check.reason}); try another seed`);
      const pathCells = shortestPath(level.rows, level.start, level.exit, PASSABLE[level.type]);
      const { r, f } = await saveLevel(ctx, input, level, { pathCells, extraMeta: { pathLength: check.pathLength }, proof: { connected: true, pathLength: check.pathLength, reachable: check.reachable } });
      return { content: `${r.lines.join('\n')}\n${level.width}x${level.height}; start ${level.start} to exit ${level.exit}: ${check.pathLength} steps; legend ${JSON.stringify(level.legend)}`, images: [preview(f.preview, { max: 1024 })] };
    }
    if (a === 'platformer') {
      const physics = { jumpHeight: num(input.jumpHeight, 3.2, 1, 20), runSpeed: num(input.runSpeed, 6, 1, 40), gravity: num(input.gravity, 40, 5, 200) };
      const level = platformer({ length: int(input.length ?? input.width, 120, 30, 1000), height: int(input.height, 18, 10, 64), seed, difficulty: num(input.difficulty, 0.5, 0, 1), physics });
      const { r, f } = await saveLevel(ctx, input, level, { extraMeta: { physics: level.physics, solvable: true, moves: level.proof.steps, coins: level.proof.coins }, proof: { solvable: true, moves: level.proof.moves, coinsReached: level.proof.coinsReached, coins: level.proof.coins } });
      return { content: `${r.lines.join('\n')}\nProven finishable: ${level.proof.steps} moves (${level.proof.moves.slice(1, 12).map((m) => m.move).join(', ')}${level.proof.steps > 11 ? ', ...' : ''}); ${level.proof.coinsReached}/${level.proof.coins} coins reachable; physics: jump ${level.physics.jumpHeight} tiles (v0 ${level.physics.v0.toFixed(1)} tiles/s), run ${level.physics.runSpeed} tiles/s, gravity ${level.physics.gravity}, longest flat jump ${level.physics.jumpDistance.toFixed(1)} tiles. Legend: ${JSON.stringify(PLATFORM_LEGEND)}`, images: [preview(f.preview, { max: 1600 })] };
    }
    if (a === 'wfc') {
      const w = int(input.width, 24, 2, 128), h = int(input.height, 16, 2, 128);
      if ((input.model ?? (input.sample ? 'overlapping' : 'tiled')) === 'overlapping') {
        if (!input.sample) throw new Error('the overlapping model needs a sample: rows of characters');
        const res = wfcOverlapping({ sample: input.sample, n: int(input.n, 3, 2, 4), width: w, height: h, seed, symmetry: int(input.symmetry, 8, 1, 8), periodic: !!input.periodic });
        if (!res.ok) throw new Error(res.reason);
        const level = { type: 'wfc', width: w, height: h, rows: res.rows ?? res.grid.map((r) => r.join('')), seed, legend: {} };
        const r = await save(ctx, input, { id: input.id ?? `wfc-${seed}`, name: `wfc map ${seed}`, kind: 'level', files: [{ path: 'level.json', role: 'level', data: JSON.stringify(level, null, 1) }], meta: { levelType: 'wfc', patterns: res.patterns }, source: { type: 'procedural', generator: 'studio:wfc:overlapping', seed, params: { n: input.n, sample: input.sample } }, tags: ['wfc'] });
        return `${r.lines.join('\n')}\n${res.patterns} patterns, ${res.attempts} attempt(s):\n${level.rows.join('\n')}`;
      }
      const res = wfcTiled({ tiles: input.tiles ?? 'roads', width: w, height: h, seed, periodic: !!input.periodic });
      if (!res.ok) throw new Error(res.reason);
      const size = int(input.tileSize, 16, 4, 64);
      const img = renderWfcTiles(res, size);
      const r = await save(ctx, input, { id: input.id ?? `wfc-${typeof input.tiles === 'string' ? input.tiles : 'tiles'}-${seed}`, name: `wfc ${seed}`, kind: 'level', files: [{ path: 'map.json', role: 'level', data: JSON.stringify({ type: 'wfc', width: w, height: h, grid: res.grid, tiles: res.tiles, seed }, null, 1) }, { path: 'preview.png', role: 'preview', image: img }], meta: { levelType: 'wfc', tiles: res.tiles.length }, source: { type: 'procedural', generator: 'studio:wfc:tiled', seed, params: { tiles: input.tiles ?? 'roads' } }, tags: ['wfc'] });
      return { content: `${r.lines.join('\n')}\n${res.tiles.length} tile variants (with rotations), ${res.attempts} attempt(s). map.json has the tile id per cell ("name@90" = rotated 90 degrees clockwise). Built-in sets: ${Object.keys(TILESETS).join(', ')}.`, images: [preview(img)] };
    }
    if (a === 'lsystem') {
      const p = { ...(PRESETS[input.preset ?? 'tree'] ?? PRESETS.tree), ...(input.axiom ? { axiom: input.axiom } : {}), ...(input.rules ? { rules: input.rules } : {}), ...(input.iterations != null ? { iterations: int(input.iterations, 4, 1, 8) } : {}), ...(input.angle != null ? { angle: num(input.angle, 25) } : {}) };
      const str = expand({ ...p, seed });
      const size = int(input.size, 64, 16, 512);
      const img = drawLsystem(str, { ...p, seed }, { width: size, height: size });
      const t3 = p.flat ? null : turtle3d(str, { ...p, seed });
      const r = await save(ctx, input, { id: input.id ?? `lsystem-${input.preset ?? 'custom'}-${seed}`, name: `${input.preset ?? 'custom'} plant`, kind: 'sprite', files: [{ path: 'plant.png', role: 'main', image: img.outline('auto') }, { path: 'lsystem.json', role: 'data', data: JSON.stringify({ ...p, seed, string: str.length > 20000 ? `${str.slice(0, 20000)}...` : str, ...(t3 ? { segments: t3.segments, leaves: t3.leaves } : {}) }) }], meta: { frameSize: [size, size], frames: 1, symbols: str.length, segments: t3?.segments.length }, source: { type: 'procedural', generator: `studio:lsystem:${input.preset ?? 'custom'}`, seed, params: p }, tags: ['plant', 'lsystem'] });
      return { content: `${r.lines.join('\n')}\n${str.length} symbols${t3 ? `, ${t3.segments.length} branch segments and ${t3.leaves.length} leaves in 3D (studio_model build tree uses the same rules)` : ''}.`, images: [preview(img)] };
    }
    if (a === 'solve') {
      let lv;
      if (input.level) lv = JSON.parse((await readIn(ctx.host, await relIn(ctx.host, String(input.level)), ctx.signal)).toString('utf8'));
      else if (Array.isArray(input.rows)) lv = { type: input.type ?? 'platformer', rows: input.rows.map(String), physics: { jumpHeight: input.jumpHeight, runSpeed: input.runSpeed, gravity: input.gravity } };
      else throw new Error('solve needs rows (a list of strings) or level (a level.json path)');
      if (lv.type === 'platformer') {
        const phys = { ...(lv.physics ?? {}), ...Object.fromEntries(['jumpHeight', 'runSpeed', 'gravity'].filter((k) => input[k] !== undefined).map((k) => [k, input[k]])) };
        const res = solvePlatformer(lv.rows, phys);
        const P = physicsOf(phys);
        return { content: res.ok ? `Finishable in ${res.steps} moves: ${res.moves.map((m) => `${m.move} -> (${m.x}, ${m.y})`).join('; ')}. Coins reachable ${res.coinsReached}/${res.coins}.` : `NOT finishable: ${res.reason}. Searched ${res.states} standing places with jump ${P.jumpHeight} tiles, run ${P.runSpeed} tiles/s, gravity ${P.gravity} (flat jump ${P.jumpDistance.toFixed(1)} tiles).`, is_error: !res.ok };
      }
      const res = checkConnected(lv.rows, lv.type);
      return { content: res.ok ? `Start reaches the exit in ${res.pathLength} steps; ${Math.round(res.reachable * 100)}% of the walkable cells are reachable.` : `NOT finishable: ${res.reason}`, is_error: !res.ok };
    }
    return unknownAction('studio_procgen', a, ACTIONS);
  }),
};

/**
 * Draws a tiled-model result: a tile with a colour as that colour; a socket tile as a 3x3
 * of terrains read from its sockets (edges clockwise, the middle the commonest middle letter).
 */
function renderWfcTiles(res, size) {
  const img = new Image(res.width * size, res.height * size);
  const TERR = { g: 'grass', r: 'path', w: 'water', s: 'sand', f: 'darkgrass', d: 'dirt', m: 'stone' };
  const tex = {};
  const texOf = (ch) => (tex[ch] ??= terrainTexture(TERR[ch] ?? 'stone', size, { seed: 1 }));
  const byId = Object.fromEntries(res.tiles.map((t) => [t.id, t]));
  res.grid.forEach((row, y) => row.forEach((id, x) => {
    const t = byId[id];
    const X = x * size, Y = y * size;
    if (t.color) { img.rect(X, Y, size, size, t.color); return; }
    const [n, e, s, w] = t.sockets.map((k) => [...String(k).padEnd(3, String(k).slice(-1))]);
    const mids = [n[1], e[1], s[1], w[1]];
    const count = (c) => mids.filter((m) => m === c).length;
    const center = mids.find((c) => c !== mids[0] && count(c) >= 1 && c === 'r') ?? [...mids].sort((a, b) => count(b) - count(a))[0];
    const cell = [[n[0], n[1], n[2]], [w[1], center, e[1]], [s[2], s[1], s[0]]];
    cell[0][0] = n[0]; cell[0][2] = e[0] === n[2] ? n[2] : e[0]; cell[2][2] = s[0]; cell[2][0] = w[0];
    const third = size / 3;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const x0 = Math.round(i * third), y0 = Math.round(j * third), x1 = Math.round((i + 1) * third), y1 = Math.round((j + 1) * third);
      img.draw(texOf(cell[j][i]).crop(x0, y0, x1 - x0, y1 - y0), X + x0, Y + y0);
    }
  }));
  return img;
}

