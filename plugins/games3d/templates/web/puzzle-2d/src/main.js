// 2D grid puzzle (Studio web template puzzle-2d): step from cell to cell, collect every gem,
// pick up keys to open locked doors, push boulders into holes to cross them, and leave by the
// exit once every gem is taken. Z undoes a move, R restarts the level. Levels are rows in
// game.json ({"rows": [...]}), or studio_procgen mazes and dungeons ("asset:<id>"). Legend:
// # wall, . floor, @ or S start, * gem, k key, D locked door, B boulder, O hole, E exit.

import { Game, loadConfig, pauseCheck, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { Animator, loadImage, loadLevel, loadSheet, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { card, hud, Particles, text } from './engine/draw.js';
import { Grid, waypoint } from './engine/grid.js';

const W = 640, H = 360;
const BUILT_IN = [
  ['#########', '#@..*...#', '#.###.#.#', '#...*.#E#', '#########'],
  ['###########', '#@..#..*..#', '#.k.D.###.#', '#...#..*.E#', '###########'],
  ['###########', '#@.B.O..*E#', '#.#########', '#....*....#', '###########'],
];

const config = await loadConfig();
const T = { repeat: 0.16, delay: 0.2, gemScore: 20, levelScore: 100, ...(config.tuning ?? {}) };
const game = new Game({ canvas: document.getElementById('game'), width: W, height: H, config });
game.input = new InputMap(undefined, { undo: ['KeyZ', 'Backspace'], ...(config.controls ?? {}) });
game.input.map.mute = ['KeyM'];
game.input.botOrder = ['left', 'right', 'up', 'down'];
const sound = new Sound();
const art = {};
const fx = new Particles(game.random);

async function load() {
  const a = config.assets ?? {};
  [art.player, art.gem, art.key, art.boulder, art.floor, art.wall] = await Promise.all([loadSheet(a.player), loadSheet(a.gem), loadImage(a.key), loadImage(a.boulder), loadImage(a.floor), loadImage(a.wall)]);
  art.levels = [];
  for (const l of config.levels ?? []) {
    if (l && typeof l === 'object' && Array.isArray(l.rows)) art.levels.push({ rows: l.rows, name: l.name });
    else { const lv = await loadLevel(l); if (lv) art.levels.push({ rows: lv.rows, name: lv.type }); }
  }
  if (!art.levels.length) art.levels.push(...BUILT_IN.map((rows) => ({ rows })));
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
}

const S = game.data;
let grid, player, anim, keys, total, levelIndex, history, moves, hold, lastDir;

const snapshot = () => ({ rows: grid.rows.map((r) => r.join('')), x: player.x, y: player.y, keys, score: S.score, moves });

function startLevel(i) {
  levelIndex = i;
  // Studio levels use S for the start and $ for treasure: here they are @ and *.
  const rows = art.levels[i].rows.map((r) => r.replace(/S/g, '@').replace(/\$/g, '*').replace(/[m+]/g, '.'));
  grid = new Grid(rows, ['#']);
  const [start] = grid.take('@');
  player = { x: start?.x ?? 1, y: start?.y ?? 1, fx: 0 };
  keys = 0;
  moves = 0;
  history = [];
  total = gems().length;
  anim = art.player ? new Animator(art.player, 'idle') : null;
  game.emit('level', `level ${i + 1} of ${art.levels.length}`);
}

const gems = () => { const out = []; grid.rows.forEach((r, y) => r.forEach((c, x) => { if (c === '*') out.push({ x, y }); })); return out; };

function tryMove(dx, dy) {
  const nx = player.x + dx, ny = player.y + dy;
  const c = grid.at(nx, ny);
  if (c === '#' || c === 'O') return false;
  if (c === 'D') { if (!keys) { game.emit('blocked', 'the door is locked'); return false; } }
  if (c === 'E' && gems().length) { game.emit('blocked', 'the exit opens once every gem is taken'); return false; }
  const before = snapshot();
  if (c === 'B') {
    const bx = nx + dx, by = ny + dy, d = grid.at(bx, by);
    if (d === 'O') { grid.set(bx, by, '.'); grid.set(nx, ny, '.'); sound.play('fill'); game.emit('fill', 'a boulder fills the hole'); fx.burst((bx + 0.5) * cell, (by + 0.5) * cell, { color: '#a89a8a', n: 10 }); }
    else if (d === '.') { grid.set(bx, by, 'B'); grid.set(nx, ny, '.'); sound.play('push'); }
    else return false;
  }
  history.push(before);
  if (history.length > 500) history.shift();
  player.x = nx; player.y = ny; moves++;
  if (dx) player.fx = dx;
  if (c === 'D') { keys--; grid.set(nx, ny, '.'); sound.play('door'); game.emit('door', 'a door unlocked'); }
  if (c === 'k') { keys++; grid.set(nx, ny, '.'); sound.play('key'); game.emit('pickup', 'a key'); }
  if (c === '*') {
    grid.set(nx, ny, '.');
    S.score += T.gemScore;
    sound.play('gem');
    fx.burst((nx + 0.5) * cell, (ny + 0.5) * cell, { n: 10 });
    game.emit('pickup', `gem ${total - gems().length}/${total}`);
    if (!gems().length) game.emit('exit-open', 'every gem taken: the exit is open');
  }
  if (c === 'E') {
    S.score += T.levelScore;
    sound.play('win');
    game.emit('level-complete', `level ${levelIndex + 1} in ${moves} moves`);
    if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1); else game.go('won');
  }
  return true;
}

let cell = 32, ox = 0, oy = 0;
const play = {
  enter(_g, data) {
    if (data.level === 0 || S.score === undefined) S.score = 0;
    startLevel(data.level ?? 0);
    hold = 0;
    sound.startMusic();
  },
  update(dt, g) {
    if (pauseCheck(g)) return;
    const inp = g.input;
    if (inp.pressed('mute')) sound.toggleMute();
    if (inp.pressed('restart')) { startLevel(levelIndex); g.emit('restart', `level ${levelIndex + 1}`); return; }
    if (inp.pressed('undo') && history.length) {
      const s = history.pop();
      grid = new Grid(s.rows, ['#']);
      Object.assign(player, { x: s.x, y: s.y });
      keys = s.keys; S.score = s.score; moves = s.moves;
      g.emit('undo', `${moves} moves`);
    }
    const dirs = [['left', -1, 0], ['right', 1, 0], ['up', 0, -1], ['down', 0, 1]];
    const now = dirs.find(([a]) => inp.pressed(a));
    const held = dirs.find(([a]) => inp.held(a));
    if (now) { tryMove(now[1], now[2]); hold = 0; lastDir = now[0]; }
    else if (held && held[0] === lastDir) { hold += dt; if (hold >= T.delay) { tryMove(held[1], held[2]); hold -= T.repeat; } }
    else hold = 0;
    if (anim) { anim.play(held ? 'walk' : 'idle'); anim.update(dt); }
    fx.update(dt);
  },
  draw(ctx, g) {
    ctx.fillStyle = '#161824';
    ctx.fillRect(0, 0, W, H);
    cell = Math.min(40, Math.floor(W / grid.W), Math.floor((H - 34) / grid.H));
    ox = Math.floor((W - grid.W * cell) / 2); oy = 30 + Math.floor((H - 30 - grid.H * cell) / 2);
    ctx.save();
    ctx.translate(ox, oy);
    for (let y = 0; y < grid.H; y++) for (let x = 0; x < grid.W; x++) {
      const c = grid.at(x, y);
      const img = c === '#' ? art.wall : art.floor;
      if (img) ctx.drawImage(img, 0, 0, Math.min(img.width, img.height), img.height, x * cell, y * cell, cell, cell);
      else { ctx.fillStyle = c === '#' ? '#3a3a52' : (x + y) % 2 ? '#5a5a70' : '#62627a'; ctx.fillRect(x * cell, y * cell, cell, cell); }
      const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell;
      if (c === 'O') { ctx.fillStyle = '#05050a'; ctx.beginPath(); ctx.ellipse(cx, cy, cell * 0.42, cell * 0.3, 0, 0, Math.PI * 2); ctx.fill(); }
      if (c === 'D') { ctx.fillStyle = '#8a5a2a'; ctx.fillRect(x * cell + 3, y * cell + 2, cell - 6, cell - 4); ctx.fillStyle = '#f2c042'; ctx.fillRect(cx - 2, cy - 3, 4, 7); }
      if (c === 'E') { const open = !gems().length; ctx.fillStyle = open ? '#3ac85a' : '#6a3a3a'; ctx.fillRect(x * cell + 4, y * cell + 4, cell - 8, cell - 8); text(ctx, open ? 'EXIT' : '', cx, cy, { size: Math.max(8, cell / 4), align: 'center' }); }
      if (c === 'k' && !(art.key && (ctx.drawImage(art.key, x * cell + cell * 0.2, y * cell + cell * 0.2, cell * 0.6, cell * 0.6), true))) { ctx.fillStyle = '#f2c042'; ctx.fillRect(cx - 6, cy - 2, 12, 4); }
      if (c === 'B' && !(art.boulder && (ctx.drawImage(art.boulder, x * cell, y * cell, cell, cell), true))) { ctx.fillStyle = '#9a8a7a'; ctx.beginPath(); ctx.arc(cx, cy, cell * 0.4, 0, Math.PI * 2); ctx.fill(); }
      if (c === '*') {
        const a = art.gem ? Object.assign(new Animator(art.gem, 'idle'), { t: g.time + x }) : null;
        if (!a?.draw(ctx, cx, cy, { scale: cell / 20, anchor: 'centre' })) { ctx.fillStyle = '#5ae0f0'; ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx + 7, cy); ctx.lineTo(cx, cy + 8); ctx.lineTo(cx - 7, cy); ctx.fill(); }
      }
    }
    if (!anim?.draw(ctx, (player.x + 0.5) * cell, (player.y + 1) * cell - 2, { scale: cell / 32, flip: player.fx < 0 })) { ctx.fillStyle = '#f0a040'; ctx.fillRect(player.x * cell + 6, player.y * cell + 6, cell - 12, cell - 12); }
    fx.draw(ctx);
    ctx.restore();
    hud(ctx, [`Level ${levelIndex + 1}/${art.levels.length}`, `Gems ${total - gems().length}/${total}`, keys ? `Keys ${keys}` : '', `Moves ${moves}`, `Score ${S.score}`, 'Z undo - R restart']);
  },
};

game.scenes = standardScenes({ load, play, title: config.title ?? 'Gem Vault', subtitle: 'Press Enter to start', card });

game.expose(() => {
  if (!grid) return { player: null, targets: [] };
  const left = gems();
  // Where to head next: the nearest gem it can walk to; else a key for a locked door, the door,
  // a boulder to push; then the exit. Boulders count as passable (they can be pushed).
  const blockedBy = (withDoors) => (x, y) => { const c = grid.at(x, y); return c === '#' || (c === 'D' && !withDoors) || (c === 'E' && left.length > 0); };
  const find = (ch) => { const o = []; grid.rows.forEach((r, y) => r.forEach((c, x) => { if (c === ch) o.push({ x, y }); })); return o; };
  let w = null;
  if (left.length) w = waypoint(grid, player, left, { ahead: 1, blocked: blockedBy(keys > 0) }) ?? (keys ? null : waypoint(grid, player, find('k'), { ahead: 1, blocked: blockedBy(false) }));
  else w = waypoint(grid, player, find('E'), { ahead: 1, blocked: blockedBy(keys > 0) });
  return {
    player: { x: player.x + 0.5, y: player.y + 0.5 }, score: S.score ?? 0, gems: total - left.length, total, keys, moves,
    exitOpen: !left.length, level: levelIndex + 1, levels: art.levels.length,
    targets: w ? [{ x: w.x, y: w.y }] : [], objective: w?.goal ?? null, missingAssets: missing.length,
  };
});
game.start('loading');
