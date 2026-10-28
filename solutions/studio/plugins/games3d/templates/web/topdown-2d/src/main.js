// 2D top-down action (Studio web template topdown-2d): explore a dungeon, open every treasure
// chest, fight or dodge the monsters (sword on X or J), and take the stairs down once the
// treasure is yours. Levels are studio_procgen dungeons, caves or mazes (rows: # wall, . floor,
// + door, S start, E exit, $ chest, m monster) or the built-in one; sprites, tiles and sounds are
// Studio assets named in game.json. Edit game.json first; this file is the gameplay.

import { Game, loadConfig, pauseCheck, pt, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { Animator, loadLevel, loadSheet, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { card, drawTile, hud, Particles, Shake, text } from './engine/draw.js';
import { Grid, moveCircle, waypoint } from './engine/grid.js';

const W = 640, H = 360;
const BUILT_IN = [
  '##########################',
  '#S.......#.......#.......#',
  '#........#...$...#...m...#',
  '#........+.......+.......#',
  '#...m....#.......#.......#',
  '####+#####.......####+####',
  '#........#########.......#',
  '#...$....+.......+...$...#',
  '#........#...m...#.......#',
  '#........#.......#.....E.#',
  '##########################',
];
const COLORS = { '#': '#3a3448', '.': '#7a7480', '+': '#8a5a32', E: '#4a3a58' };

const config = await loadConfig();
const T = { lives: 0, health: 5, speed: 5, monsterSpeed: 2.2, chase: 5, chestScore: 50, monsterScore: 25, scale: 2, ...(config.tuning ?? {}) };
const TS = 16 * T.scale;
const game = new Game({ canvas: document.getElementById('game'), width: W, height: H, config });
game.input = new InputMap(undefined, { ...(config.controls ?? {}) });
game.input.map.mute = ['KeyM'];
game.input.botOrder = ['left', 'right', 'up', 'down', 'action'];
const sound = new Sound();
const art = {};
const fx = new Particles(game.random);
const shake = new Shake();

async function load() {
  const a = config.assets ?? {};
  [art.player, art.monster, art.chest] = await Promise.all([loadSheet(a.player), loadSheet(a.monster), loadSheet(a.chest)]);
  art.levels = [];
  for (const ref of config.levels ?? []) { const lv = await loadLevel(ref); if (lv) art.levels.push(lv); }
  if (!art.levels.length) art.levels.push({ type: 'dungeon', rows: BUILT_IN, tile: 16 });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
}

const S = game.data;
let grid, player, anim, chests, monsters, exit, start, levelIndex, total, swing, invuln;

function startLevel(i) {
  levelIndex = i;
  grid = new Grid(art.levels[i].rows, ['#']);
  [start] = grid.take('S');
  [exit] = grid.take('E');
  start ??= { x: 1, y: 1 };
  exit ??= { x: grid.W - 2, y: grid.H - 2 };
  chests = grid.take('$');
  total = chests.length;
  monsters = grid.take('m').map((c) => ({ x: c.x + 0.5, y: c.y + 0.5, home: { x: c.x + 0.5, y: c.y + 0.5 }, dir: 0, t: 0, hp: 2, hurt: 0, anim: art.monster ? new Animator(art.monster, 'walk') : null }));
  player = { x: start.x + 0.5, y: start.y + 0.5, fx: 1, fy: 0 };
  anim = art.player ? new Animator(art.player, 'idle') : null;
  S.health = T.health;
  swing = 0;
  invuln = 1;
  game.emit('level', `level ${i + 1} of ${art.levels.length}`);
}

function hurt(from, why) {
  if (invuln > 0) return;
  S.health--;
  invuln = 1.2;
  sound.play('hit');
  shake.kick(5);
  const d = Math.hypot(player.x - from.x, player.y - from.y) || 1;
  moveCircle(grid, player, ((player.x - from.x) / d) * 0.6, ((player.y - from.y) / d) * 0.6);
  game.emit('damage', `${why}; health ${S.health}`);
  if (S.health > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', `${why}${T.lives > 0 ? `; lives ${S.lives}` : ''}`);
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { x: start.x + 0.5, y: start.y + 0.5 });
  S.health = T.health;
  invuln = 1.5;
}

const play = {
  enter(_g, data) {
    if (data.level === 0 || S.lives === undefined) { S.score = 0; S.lives = T.lives; S.deaths = 0; }
    startLevel(data.level ?? 0);
    sound.startMusic();
  },
  update(dt, g) {
    if (pauseCheck(g)) return;
    if (g.input.pressed('mute')) sound.toggleMute();
    invuln = Math.max(0, invuln - dt);
    let dx = g.input.axis('left', 'right'), dy = g.input.axis('up', 'down');
    if (dx || dy) { const n = Math.hypot(dx, dy); dx /= n; dy /= n; player.fx = dx; player.fy = dy; }
    moveCircle(grid, player, dx * T.speed * dt, dy * T.speed * dt);
    if ((g.input.pressed('action') || g.input.pressed('jump')) && swing <= 0) { swing = 0.25; sound.play('swing'); anim?.play('attack', true); }
    swing = Math.max(0, swing - dt);
    for (let i = chests.length - 1; i >= 0; i--) {
      const c = chests[i];
      if (Math.abs(player.x - (c.x + 0.5)) < 0.7 && Math.abs(player.y - (c.y + 0.5)) < 0.7) {
        chests.splice(i, 1);
        S.score += T.chestScore;
        sound.play('chest');
        fx.burst((c.x + 0.5) * TS, (c.y + 0.5) * TS, { n: 14, gravity: 0 });
        fx.float((c.x + 0.5) * TS, c.y * TS, `+${T.chestScore}`);
        g.emit('pickup', `chest ${total - chests.length}/${total}`);
        if (!chests.length) g.emit('exit-open', 'every chest opened: the stairs are open');
      }
    }
    const reach = { x: player.x + player.fx * 0.7, y: player.y + player.fy * 0.7 };
    for (let i = monsters.length - 1; i >= 0; i--) {
      const m = monsters[i];
      m.t -= dt;
      m.hurt = Math.max(0, m.hurt - dt);
      const d = Math.hypot(player.x - m.x, player.y - m.y);
      let mx = 0, my = 0;
      if (d < T.chase && d > 0.01) { mx = (player.x - m.x) / d; my = (player.y - m.y) / d; }
      else {
        if (m.t <= 0) { m.dir = Math.floor(g.random() * 5); m.t = 0.8 + g.random(); }
        [mx, my] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]][m.dir];
        if (Math.hypot(m.x - m.home.x, m.y - m.home.y) > 3) { mx = m.home.x - m.x; my = m.home.y - m.y; const n = Math.hypot(mx, my); mx /= n; my /= n; }
      }
      if (!m.hurt) moveCircle(grid, m, mx * T.monsterSpeed * dt, my * T.monsterSpeed * dt, 0.3);
      m.anim?.update(dt);
      if (swing > 0.1 && !m.hurt && Math.hypot(reach.x - m.x, reach.y - m.y) < 0.75) {
        m.hp--;
        m.hurt = 0.3;
        moveCircle(grid, m, player.fx * 0.8, player.fy * 0.8, 0.3);
        fx.burst(m.x * TS, m.y * TS, { color: '#ff8a5a', n: 8, gravity: 0 });
        if (m.hp <= 0) { monsters.splice(i, 1); S.score += T.monsterScore; sound.play('kill'); g.emit('kill', 'a monster'); continue; }
      }
      if (d < 0.6) hurt(m, 'a monster');
    }
    if (g.sceneName !== 'play') return;
    if (!chests.length && Math.abs(player.x - (exit.x + 0.5)) < 0.6 && Math.abs(player.y - (exit.y + 0.5)) < 0.6) {
      sound.play('win');
      g.emit('level-complete', `level ${levelIndex + 1}`);
      if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1); else g.go('won');
    }
    if (anim) { if (swing <= 0 || anim.done) anim.play(dx || dy ? 'walk' : 'idle'); anim.update(dt); }
    fx.update(dt);
    shake.update(dt);
  },
  draw(ctx, g) {
    const camX = Math.max(Math.min(0, grid.W * TS - W), Math.min(grid.W * TS - W, player.x * TS - W / 2));
    const camY = Math.max(Math.min(0, grid.H * TS - H), Math.min(grid.H * TS - H, player.y * TS - H / 2));
    const [sx, sy] = shake.offset(g.random);
    ctx.fillStyle = '#14121c';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(Math.round(-camX + sx), Math.round(-camY + sy));
    const strip = art.levels[levelIndex].tiles;
    const idx = (c) => (strip?.chars ? strip.chars.indexOf(c) : -1);
    for (let y = Math.max(0, Math.floor(camY / TS)); y <= Math.min(grid.H - 1, Math.ceil((camY + H) / TS)); y++) {
      for (let x = Math.max(0, Math.floor(camX / TS)); x <= Math.min(grid.W - 1, Math.ceil((camX + W) / TS)); x++) {
        const c = grid.at(x, y);
        const t = c === '#' || c === '+' ? c : '.';
        if (!drawTile(ctx, strip, idx(t), x * TS, y * TS, TS)) { ctx.fillStyle = COLORS[t]; ctx.fillRect(x * TS, y * TS, TS, TS); }
        // Walls darker, with a lit top edge where floor lies below: rooms read at a glance.
        if (t === '#') { ctx.fillStyle = '#0a0812a0'; ctx.fillRect(x * TS, y * TS, TS, TS); if (grid.at(x, y + 1) !== '#') { ctx.fillStyle = '#c8c0d860'; ctx.fillRect(x * TS, y * TS + TS - 4, TS, 4); } }
      }
    }
    const open = !chests.length;
    if (!drawTile(ctx, strip, idx('E'), exit.x * TS, exit.y * TS, TS)) { ctx.fillStyle = COLORS.E; ctx.fillRect(exit.x * TS, exit.y * TS, TS, TS); }
    if (!open) { ctx.fillStyle = '#00000088'; ctx.fillRect(exit.x * TS, exit.y * TS, TS, TS); }
    for (const c of chests) {
      if (!new Animator(art.chest, 'idle').draw(ctx, (c.x + 0.5) * TS, (c.y + 1) * TS, { scale: T.scale * 0.5 }) && !drawTile(ctx, strip, idx('$'), c.x * TS, c.y * TS, TS)) { ctx.fillStyle = '#c8a040'; ctx.fillRect(c.x * TS + 6, c.y * TS + 8, TS - 12, TS - 14); }
    }
    for (const m of monsters) {
      const blink = m.hurt > 0 && Math.floor(m.hurt * 20) % 2;
      if (!blink && !m.anim?.draw(ctx, m.x * TS, (m.y + 0.45) * TS, { scale: T.scale * 0.8, flip: player.x > m.x })) { ctx.fillStyle = '#8ad06a'; ctx.beginPath(); ctx.arc(m.x * TS, m.y * TS, TS * 0.3, 0, Math.PI * 2); ctx.fill(); }
    }
    if (swing > 0) {
      ctx.strokeStyle = '#f4f1e8'; ctx.lineWidth = 3; ctx.beginPath();
      const a = Math.atan2(player.fy, player.fx);
      ctx.arc(player.x * TS, player.y * TS, TS * 0.8, a - 0.9, a + 0.9); ctx.stroke();
    }
    const blink = invuln > 0 && Math.floor(invuln * 10) % 2;
    if (!blink && !anim?.draw(ctx, player.x * TS, (player.y + 0.5) * TS, { scale: T.scale * 0.8, flip: player.fx < 0 })) { ctx.fillStyle = '#4a9ae8'; ctx.beginPath(); ctx.arc(player.x * TS, player.y * TS, TS * 0.33, 0, Math.PI * 2); ctx.fill(); }
    fx.draw(ctx);
    ctx.restore();
    hud(ctx, [`Treasure ${total - chests.length}/${total}`, `Health ${'*'.repeat(Math.max(0, S.health))}`, `Score ${S.score}`, T.lives > 0 ? `Lives ${S.lives}` : '', art.levels.length > 1 ? `Floor ${levelIndex + 1}` : '']);
    if (open && Math.floor(g.time * 2) % 2) text(ctx, 'The stairs are open!', W - 10, 16, { size: 14, align: 'right', color: '#9ae6b4' });
  },
};

game.scenes = standardScenes({ load, play, title: config.title ?? 'Dungeon', subtitle: 'Press Enter to start', card, onRestart: () => { S.lives = undefined; } });

game.expose(() => {
  if (!grid) return { player: null, targets: [] };
  const goals = chests.length ? chests : [exit];
  // Where to head next: a few steps along the shortest way to the nearest chest, then the stairs.
  const w = waypoint(grid, player, goals, { ahead: 3 });
  return {
    player: pt(player), score: S.score ?? 0, health: S.health, lives: T.lives > 0 ? S.lives : null, deaths: S.deaths ?? 0,
    collected: total - chests.length, total, exitOpen: !chests.length, level: levelIndex + 1, levels: art.levels.length,
    targets: w ? [{ x: w.x, y: w.y }] : goals.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5 })), objective: w?.goal ?? null,
    monsters: monsters.length, missingAssets: missing.length,
  };
});
game.start('loading');
