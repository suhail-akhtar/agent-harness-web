// Tiled (mapeditor.org) files from character-grid levels: a .tmj map with a tile layer and
// an object layer (start, exit, pickups, spawns as points), and the .tsj tileset it uses.
// Godot (with the Tiled importer), Phaser, Defold, LDtk importers and most engines read them.

export const TILED_VERSION = '1.10.2';

/**
 * tiles: the characters in the tileset image's order (gid = index + 1); empty: characters
 * left blank (air); objects: { char: { type, under } } placed as points with `under` drawn
 * in the tile layer beneath.
 */
export function toTiled({ rows, tileSize = 16, tiles, empty = [], objects = {}, tilesetFile = 'tiles.tsj', tilesetImage = 'tiles.png', name = 'level', properties = {} }) {
  const height = rows.length, width = Math.max(...rows.map((r) => r.length));
  const data = [];
  const objs = [];
  let nextId = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ch = rows[y][x] ?? empty[0] ?? '.';
      const ob = objects[ch];
      if (ob) {
        objs.push({ id: nextId++, name: ob.name ?? ob.type, type: ob.type, x: (x + 0.5) * tileSize, y: (y + 0.5) * tileSize, width: 0, height: 0, point: true, rotation: 0, visible: true });
        ch = ob.under ?? empty[0] ?? '.';
      }
      const i = tiles.indexOf(ch);
      data.push(empty.includes(ch) || i < 0 ? 0 : i + 1);
    }
  }
  const props = Object.entries(properties).map(([k, v]) => ({ name: k, type: typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v === 'boolean' ? 'bool' : 'string', value: typeof v === 'object' ? JSON.stringify(v) : v }));
  const tmj = {
    compressionlevel: -1, height, width, infinite: false, orientation: 'orthogonal', renderorder: 'right-down',
    tiledversion: TILED_VERSION, version: '1.10', type: 'map', tileheight: tileSize, tilewidth: tileSize,
    nextlayerid: 3, nextobjectid: nextId,
    layers: [
      { id: 1, name: 'tiles', type: 'tilelayer', width, height, x: 0, y: 0, opacity: 1, visible: true, data },
      { id: 2, name: 'objects', type: 'objectgroup', draworder: 'topdown', x: 0, y: 0, opacity: 1, visible: true, objects: objs },
    ],
    tilesets: [{ firstgid: 1, source: tilesetFile }],
    ...(props.length ? { properties: props } : {}),
    class: name,
  };
  return tmj;
}

/** The .tsj tileset for an image of `count` tiles in `columns` columns, with each tile's character as a property. */
export function toTilesetJson({ image = 'tiles.png', tileSize = 16, count, columns, name = 'tiles', chars = [], wangsets } = {}) {
  const cols = columns ?? count;
  return {
    columns: cols, image, imagewidth: cols * tileSize, imageheight: Math.ceil(count / cols) * tileSize, margin: 0, spacing: 0, name,
    tilecount: count, tileheight: tileSize, tilewidth: tileSize, tiledversion: TILED_VERSION, version: '1.10', type: 'tileset',
    ...(chars.length ? { tiles: chars.map((c, id) => ({ id, properties: [{ name: 'char', type: 'string', value: c }] })) } : {}),
    ...(wangsets ? { wangsets } : {}),
  };
}

/** Checks a .tmj object: sizes, layer data length, gids within the tileset. Problems as strings. */
export function checkTiled(tmj, tilecount) {
  const p = [];
  if (tmj.type !== 'map') p.push('type is not "map"');
  const tl = (tmj.layers ?? []).filter((l) => l.type === 'tilelayer');
  if (!tl.length) p.push('no tile layer');
  for (const l of tl) {
    if (l.data?.length !== l.width * l.height) p.push(`layer ${l.name}: ${l.data?.length} tiles for ${l.width}x${l.height}`);
    if (tilecount !== undefined && l.data?.some((g) => g < 0 || g > tilecount)) p.push(`layer ${l.name}: a tile id beyond the tileset's ${tilecount}`);
  }
  return p;
}
