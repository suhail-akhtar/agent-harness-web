// 2.5D isometric adventure (Studio web template iso-2.5d): a 2:1 isometric overworld drawn in
// Canvas 2D from Studio's iso tiles, with height (hills, mountains, snow), forests, water, slimes
// that chase, treasure chests to open and a portal that opens after the last one. The world is
// a studio_procgen "topdown" map (rows: ~ w water, s sand, g grass, h hills, f forest, M mountain,
// * snow, = road, T chest, S start, E exit) or the built-in one. Arrows move along the screen
// (up is north-west and north-east together: the iso diagonal).

import { Game, loadConfig, pauseCheck, pt, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { Animator, loadImageUrl, loadLevel, loadSheet, loadImage, missing, resolve } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { card, hud, Particles, Shake, text } from './engine/draw.js';
import { Grid, moveCircle, waypoint } from './engine/grid.js';

const W = 640, H = 360;
const BUILT_IN = [
  'MMMMMMMMMMMMMMMM',
  'MggggggfffgggggM',
  'MgSgg==gfgghhggM',
  'Mgggg=ggggghTggM',
  'Mwwgg=gggsggggfM',
  'M~wgg====sssgggM',
  'M~wwgggg=gwwgggM',
  'MggTgggg=gwwgfgM',
  'Mghhgfgg=ggggggM',
  'Mggggggg===gTgEM',
  'Mffgg*Mggggg=ggM',
  'MMMMMMMMMMMMMMMM',
];
const PASS = new Set(['s', 'g', 'f', 'h', '=', 'T', 'S', 'E']);
const TILE = { g: 'grass', h: 'grass', f: 'grass', T: 'grass', S: 'grass', s: 'sand', '=': 'dirt', E: 'dirt', w: 'water', '~': 'water', M: 'stone', '*': 'snow' };
const HEIGHT = { h: 1, M: 2, '*': 3, w: 0, '~': 0 };
const COLOR = { grass: '#5a9a3a', sand: '#d8c078', dirt: '#9a7a52', water: '#3a6ac8', stone: '#7a7a86', snow: '#e8eef4' };

const config = await loadConfig();
const T = { lives: 0, health: 5, speed: 4, chests: 3, monsters: 3, monsterSpeed: 1.8, chase: 4, chestScore: 50, scale: 2, ...(config.tuning ?? {}) };
const game = new Game({ canvas: document.getElementById('game'), width: W, height: H, config });
game.input = new InputMap(undefined, config.controls);
game.input.map.mute = ['KeyM'];
game.input.botOrder = ['left', 'right', 'up', 'down'];
const sound = new Sound();
const art = { tiles: {} };
const fx = new Particles(game.random);
const shake = new Shake();
const TW = 32 * T.scale, TH = TW / 2, DEPTH = 16 * T.scale; // a 2:1 diamond, blocks DEPTH tall per height step

async function load() {
  const a = config.assets ?? {};
  [art.player, art.monster, art.chest, art.tree] = await Promise.all([loadSheet(a.player), loadSheet(a.monster), loadSheet(a.chest), loadImage(a.tree)]);
  const iso = await resolve(a.tiles);
  if (iso) await Promise.all(Object.values(TILE).map(async (name) => { const url = iso.file(`${name}.png`); if (url) art.tiles[name] = await loadImageUrl(url).catch(() => null); }));
  art.levels = [];
  for (const ref of config.levels ?? []) { const lv = await loadLevel(ref); if (lv) art.levels.push(lv); }
  if (!art.levels.length) art.levels.push({ type: 'topdown', rows: BUILT_IN });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
}

const S = game.data;
let grid, player, anim, chests, monsters, exit, start, total, levelIndex, invuln;
const blocked = (x, y) => !PASS.has(grid.at(x, y));
const heightAt = (x, y) => HEIGHT[grid.at(Math.floor(x), Math.floor(y))] ?? 0;

function startLevel(i) {
  levelIndex = i;
  grid = new Grid(art.levels[i].rows, []);
  [start] = grid.take('S', 'g');
  [exit] = grid.take('E', '=');
  start ??= { x: 1, y: 1 };
  exit ??= { x: grid.W - 2, y: grid.H - 2 };
  chests = grid.take('T', 'g');
  // A world without towns gets its treasure on open ground it can reach, spread out (seeded).
  if (!chests.length && T.chests > 0) {
    const open = grid.reachable(start, blocked).filter((c) => c.d > 4 && grid.at(c.x, c.y) === 'g');
    for (let k = 0; k < T.chests && open.length; k++) chests.push(open.splice(Math.floor(((k + 0.5) / T.chests) * open.length * 0.999), 1)[0]);
  }
  total = chests.length;
  // Slimes on open grass, away from the start (seeded: the same seed, the same world).
  monsters = [];
  const open = [];
  grid.rows.forEach((r, y) => r.forEach((c, x) => { if (c === 'g' && Math.hypot(x - start.x, y - start.y) > 6) open.push({ x, y }); }));
  for (let k = 0; k < T.monsters && open.length; k++) {
    const c = open.splice(Math.floor(game.random() * open.length), 1)[0];
    monsters.push({ x: c.x + 0.5, y: c.y + 0.5, home: { x: c.x + 0.5, y: c.y + 0.5 }, t: 0, dir: 0, anim: art.monster ? new Animator(art.monster, 'walk') : null });
  }
  player = { x: start.x + 0.5, y: start.y + 0.5, fx: 1 };
  anim = art.player ? new Animator(art.player, 'idle') : null;
  S.health = T.health;
  invuln = 1;
  game.emit('level', `world ${i + 1} of ${art.levels.length}`);
}

function hurt(m) {
  if (invuln > 0) return;
  S.health--;
  invuln = 1.2;
  sound.play('hit');
  shake.kick(4);
  game.emit('damage', `a slime; health ${S.health}`);
  if (S.health > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', 'slimes');
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { x: start.x + 0.5, y: start.y + 0.5 });
  S.health = T.health;
  invuln = 1.5;
}

const toScreen = (x, y, h = 0) => [(x - y) * (TW / 2), (x + y) * (TH / 2) - h * DEPTH];

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
    // Screen directions on the iso grid: up = (-1, -1), right = (+1, -1).
    const sx = g.input.axis('left', 'right'), sy = g.input.axis('up', 'down');
    let dx = sx + sy, dy = sy - sx;
    const n = Math.hypot(dx, dy);
    if (n) { dx /= n; dy /= n; if (sx) player.fx = sx; }
    moveCircle(grid, player, dx * T.speed * dt, dy * T.speed * dt, 0.3, blocked);
    for (let i = chests.length - 1; i >= 0; i--) {
      const c = chests[i];
      if (Math.hypot(player.x - (c.x + 0.5), player.y - (c.y + 0.5)) < 0.65) {
        chests.splice(i, 1);
        S.score += T.chestScore;
        sound.play('chest');
        const [cx, cy] = toScreen(c.x + 0.5, c.y + 0.5, heightAt(c.x, c.y));
        fx.burst(cx, cy - 10, { n: 12 });
        g.emit('pickup', `chest ${total - chests.length}/${total}`);
        if (!chests.length) g.emit('exit-open', 'every chest opened: the portal is open');
      }
    }
    for (const m of monsters) {
      m.t -= dt;
      const d = Math.hypot(player.x - m.x, player.y - m.y);
      let mx = 0, my = 0;
      if (d < T.chase && d > 0.01) { mx = (player.x - m.x) / d; my = (player.y - m.y) / d; }
      else { if (m.t <= 0) { m.dir = Math.floor(g.random() * 5); m.t = 1 + g.random(); } [mx, my] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]][m.dir]; if (Math.hypot(m.x - m.home.x, m.y - m.home.y) > 3) { mx = Math.sign(m.home.x - m.x); my = Math.sign(m.home.y - m.y); } }
      moveCircle(grid, m, mx * T.monsterSpeed * dt, my * T.monsterSpeed * dt, 0.3, blocked);
      m.anim?.update(dt);
      if (d < 0.55) hurt(m);
    }
    if (g.sceneName !== 'play') return;
    if (!chests.length && Math.hypot(player.x - (exit.x + 0.5), player.y - (exit.y + 0.5)) < 0.6) {
      sound.play('win');
      g.emit('level-complete', `world ${levelIndex + 1}`);
      if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1); else g.go('won');
    }
    if (anim) { anim.play(n ? 'walk' : 'idle'); anim.update(dt); }
    fx.update(dt);
    shake.update(dt);
  },
  draw(ctx, g) {
    const ph = heightAt(player.x, player.y);
    const [px, py] = toScreen(player.x, player.y, ph);
    const [jx, jy] = shake.offset(g.random);
    ctx.fillStyle = '#1a2a3a';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(Math.round(W / 2 - px + jx), Math.round(H / 2 - py + jy));
    // Back to front: the diagonals x + y, entities with their cell's diagonal.
    const ents = [
      ...chests.map((c) => ({ x: c.x + 0.5, y: c.y + 0.5, kind: 'chest' })),
      ...monsters.map((m) => ({ ...m, kind: 'monster', ref: m })),
      { x: player.x, y: player.y, kind: 'player' },
    ].sort((a, b) => a.x + a.y - (b.x + b.y));
    let e = 0;
    const R = 13;
    const cx = Math.floor(player.x), cy = Math.floor(player.y);
    for (let s = Math.max(0, cx + cy - R * 2); s <= Math.min(grid.W + grid.H, cx + cy + R * 2); s++) {
      for (let x = Math.max(0, s - grid.H + 1); x <= Math.min(grid.W - 1, s); x++) {
        const y = s - x;
        if (Math.abs(x - cx) > R + 4 || Math.abs(y - cy) > R + 4) continue;
        const c = grid.at(x, y);
        const name = TILE[c] ?? 'grass';
        const h = HEIGHT[c] ?? 0;
        for (let k = 0; k <= h; k++) {
          const [sx, sy] = toScreen(x, y, k);
          const img = art.tiles[name];
          if (img) ctx.drawImage(img, Math.round(sx - TW / 2), Math.round(sy), TW, (img.height / img.width) * TW);
          else { ctx.fillStyle = COLOR[name]; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + TW / 2, sy + TH / 2); ctx.lineTo(sx, sy + TH); ctx.lineTo(sx - TW / 2, sy + TH / 2); ctx.fill(); }
        }
        if (c === 'f') { const [sx, sy] = toScreen(x + 0.5, y + 0.5); if (!(art.tree && (ctx.drawImage(art.tree, sx - TW * 0.35, sy - TW * 0.75, TW * 0.7, TW * 0.7), true))) { ctx.fillStyle = '#2a6a2a'; ctx.beginPath(); ctx.arc(sx, sy - TW * 0.35, TW * 0.25, 0, Math.PI * 2); ctx.fill(); } }
        if (x === exit.x && y === exit.y) {
          const [sx, sy] = toScreen(x + 0.5, y + 0.5);
          ctx.fillStyle = chests.length ? '#5a3a6a' : `hsl(${(g.time * 120) % 360} 80% 60%)`;
          ctx.beginPath(); ctx.ellipse(sx, sy - 18, 12, 18, 0, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Entities whose diagonal is this one.
      while (e < ents.length && Math.floor(ents[e].x) + Math.floor(ents[e].y) <= s) {
        const it = ents[e++];
        const [sx, sy] = toScreen(it.x, it.y, heightAt(it.x, it.y));
        const feet = sy + TH / 2;
        if (it.kind === 'chest') { if (!new Animator(art.chest, 'idle').draw(ctx, sx, feet, { scale: T.scale * 0.6 })) { ctx.fillStyle = '#c8a040'; ctx.fillRect(sx - 8, feet - 12, 16, 12); } }
        else if (it.kind === 'monster') { if (!it.ref.anim?.draw(ctx, sx, feet, { scale: T.scale * 0.7 })) { ctx.fillStyle = '#8ad06a'; ctx.beginPath(); ctx.arc(sx, feet - 8, 8, 0, Math.PI * 2); ctx.fill(); } }
        else {
          const blink = invuln > 0 && Math.floor(invuln * 10) % 2;
          if (!blink && !anim?.draw(ctx, sx, feet, { scale: T.scale * 0.85, flip: player.fx < 0 })) { ctx.fillStyle = '#4a9ae8'; ctx.fillRect(sx - 7, feet - 26, 14, 26); }
        }
      }
    }
    fx.draw(ctx);
    ctx.restore();
    hud(ctx, [`Chests ${total - chests.length}/${total}`, `Health ${'*'.repeat(Math.max(0, S.health))}`, `Score ${S.score}`, art.levels.length > 1 ? `World ${levelIndex + 1}` : '']);
    if (!chests.length && Math.floor(g.time * 2) % 2) text(ctx, 'The portal is open!', W - 10, 16, { size: 14, align: 'right', color: '#c8a8f8' });
  },
};

game.scenes = standardScenes({ load, play, title: config.title ?? 'Iso Isles', subtitle: 'Press Enter to start', card, onRestart: () => { S.lives = undefined; } });

game.expose(() => {
  if (!grid) return { player: null, targets: [] };
  const goals = chests.length ? chests : [exit];
  const w = waypoint(grid, player, goals, { ahead: 3, blocked });
  return {
    player: { ...pt(player), z: heightAt(player.x, player.y) }, score: S.score ?? 0, health: S.health, lives: T.lives > 0 ? S.lives : null, deaths: S.deaths ?? 0,
    collected: total - chests.length, total, exitOpen: !chests.length, level: levelIndex + 1, levels: art.levels.length,
    targets: w ? [{ x: w.x, y: w.y, z: heightAt(w.x, w.y) }] : [], objective: w?.goal ?? null, monsters: monsters.length, missingAssets: missing.length,
  };
});
game.start('loading');
