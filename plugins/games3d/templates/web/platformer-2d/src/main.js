// 2D platformer (Studio web template platformer-2d): run and jump through levels made of tiles,
// take every coin, stomp or dodge the walkers, avoid spikes and pits, and reach the exit once it
// opens. Levels are studio_procgen platformer levels (proven finishable by its solver with the
// same physics as here) or the built-in one; sprites, tiles, background and sounds are Studio
// assets named in game.json. Edit game.json first; this file is the gameplay.

import { Game, loadConfig, pauseCheck, pt, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { Animator, loadLevel, loadParallax, loadSheet, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { card, drawParallax, drawTile, hud, Particles, Shake, text } from './engine/draw.js';
import { Body, hazard, PlatformWorld, stepBody, stepWalker } from './engine/platformer.js';

const W = 640, H = 360;
const BUILT_IN = [
  '........................................',
  '........................................',
  '.....................o..................',
  '...................XXXX.................',
  '..........o.............................',
  '........XXXX.........-----........o.....',
  '..S..o..........e...............XXXX..E.',
  '########...###########...#####..########',
  '########...###########...#####..########',
  '########################################',
];
const COLORS = { '#': '#5a4636', G: '#4f8a3a', X: '#8a6a4a', '-': '#a8865a', '^': '#c8ccd8' };

const config = await loadConfig();
// lives 0: unlimited tries (a death puts you back at the last checkpoint and counts in the HUD).
const T = { lives: 0, coinScore: 10, stompScore: 50, scale: 2, ...(config.tuning ?? {}) };
const TS = 16 * T.scale; // screen pixels per tile
const canvas = document.getElementById('game');
const game = new Game({ canvas, width: W, height: H, config });
game.input = new InputMap(undefined, config.controls);
game.input.botOrder = ['left', 'right', 'jump'];
const sound = new Sound();
const art = {};
const fx = new Particles(game.random);
const shake = new Shake();

async function load() {
  const a = config.assets ?? {};
  [art.player, art.coin, art.enemy, art.background] = await Promise.all([loadSheet(a.player), loadSheet(a.coin), loadSheet(a.enemy), loadParallax(a.background)]);
  art.levels = [];
  for (const ref of config.levels ?? []) { const lv = await loadLevel(ref); if (lv) art.levels.push(lv); }
  if (!art.levels.length) art.levels.push({ type: 'platformer', rows: BUILT_IN, tile: 16 });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
}

// ---------- the play scene ----------

const S = game.data; // score, lives... (the won and gameover cards read it)
let world, player, anim, coins, enemies, exit, checkpoint, invuln, total, levelIndex, groundTime;

function startLevel(i) {
  levelIndex = i;
  const lv = art.levels[i];
  world = new PlatformWorld(lv.rows, { ...(lv.physics ?? {}), ...(config.physics ?? {}) });
  const [start] = world.take('S');
  const [ex] = world.take('E');
  coins = world.take('o').map((c) => ({ ...c, t: game.random() * 6 }));
  enemies = world.take('e').map((c) => Object.assign(new Body(c.x + 0.5, c.y + 1, 0.9, 0.9), { anim: art.enemy ? new Animator(art.enemy, 'walk') : null }));
  exit = ex ?? { x: world.W - 2, y: world.H - 3 };
  total = coins.length;
  const s = start ?? { x: 1, y: 1 };
  player = new Body(s.x + 0.5, s.y + 1, world.p.playerWidth, world.p.playerHeight);
  checkpoint = { x: player.x, y: player.y };
  anim = art.player ? new Animator(art.player, 'idle') : null;
  invuln = 1;
  groundTime = 0;
  game.emit('level', `level ${i + 1} of ${art.levels.length}`);
}

function die(why) {
  if (invuln > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', `${why}${T.lives > 0 ? `; lives ${S.lives}` : `; deaths ${S.deaths}`}`);
  sound.play('hit');
  shake.kick(6);
  fx.burst(player.x * TS, (player.y - 1) * TS, { color: '#ff6a5a', n: 16 });
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { x: checkpoint.x, y: checkpoint.y, vx: 0, vy: 0 });
  invuln = 1.2;
}

const play = {
  enter(g, data) {
    if (data.level === 0 || S.lives === undefined) { S.score = 0; S.lives = T.lives; S.deaths = 0; }
    startLevel(data.level ?? 0);
    sound.startMusic();
  },
  update(dt, g) {
    if (pauseCheck(g)) return;
    if (g.input.pressed('mute')) sound.toggleMute();
    invuln = Math.max(0, invuln - dt);
    const dir = g.input.axis('left', 'right');
    const r = stepBody(world, player, { dir, jump: g.input.pressed('jump') || g.input.pressed('up'), jumpHeld: g.input.held('jump') || g.input.held('up'), dt });
    if (r.jumped) { sound.play('jump'); g.emit('jump', ''); }
    if (r.landed) fx.burst(player.x * TS, player.y * TS, { n: 4, color: '#d8c8a8', speed: 40, life: 0.25 });
    // A checkpoint where the player stood still a moment on solid ground, away from spikes.
    groundTime = player.ground ? groundTime + dt : 0;
    if (groundTime > 0.25 && !hazard(world, player) && world.solid(Math.floor(player.x), Math.floor(player.y + 0.1))) checkpoint = { x: player.x, y: player.y };
    const h = hazard(world, player);
    if (h) die(h === 'fell' ? 'fell into a pit' : 'spikes');
    for (const c of coins) c.t += dt;
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      if (player.right > c.x + 0.15 && player.left < c.x + 0.85 && player.top < c.y + 0.85 && player.y > c.y + 0.15) {
        coins.splice(i, 1);
        S.score += T.coinScore;
        sound.play('coin');
        fx.burst((c.x + 0.5) * TS, (c.y + 0.5) * TS, { n: 8 });
        fx.float((c.x + 0.5) * TS, c.y * TS, `+${T.coinScore}`);
        g.emit('pickup', `coin ${total - coins.length}/${total}`);
        if (!coins.length) g.emit('exit-open', 'every coin taken: the exit is open');
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      stepWalker(world, e, dt);
      e.anim?.update(dt);
      if (!player.overlaps(e)) continue;
      if (player.vy > 0 && player.y - e.top < 0.6) {
        enemies.splice(i, 1);
        player.vy = -world.p.v0 * 0.6;
        S.score += T.stompScore;
        sound.play('stomp');
        fx.burst(e.x * TS, (e.y - 0.5) * TS, { color: '#8ad06a', n: 12 });
        g.emit('kill', 'stomped a walker');
      } else die('hit by a walker');
    }
    if (g.sceneName !== 'play') return;
    const atExit = player.right > exit.x && player.left < exit.x + 1 && player.top < exit.y + 1 && player.y > exit.y;
    if (atExit && !coins.length) {
      sound.play('win');
      g.emit('level-complete', `level ${levelIndex + 1}`);
      if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1);
      else g.go('won');
    }
    if (anim) {
      anim.play(!player.ground ? 'jump' : dir ? 'walk' : 'idle');
      anim.update(dt);
    }
    fx.update(dt);
    shake.update(dt);
  },
  draw(ctx, g) {
    const camX = Math.max(0, Math.min(world.W * TS - W, player.x * TS - W / 2));
    const camY = Math.max(Math.min(0, world.H * TS - H), Math.min(world.H * TS - H, (player.y - 2) * TS - H / 2));
    const [sx, sy] = shake.offset(g.random);
    ctx.fillStyle = '#86c5ee';
    ctx.fillRect(0, 0, W, H);
    drawParallax(ctx, art.background, camX, W, H, g.time);
    ctx.save();
    ctx.translate(Math.round(-camX + sx), Math.round(-camY + sy));
    const lv = art.levels[levelIndex];
    const strip = lv.tiles;
    const x0 = Math.floor(camX / TS), x1 = Math.ceil((camX + W) / TS);
    for (let y = 0; y < world.H; y++) {
      for (let x = x0; x <= x1; x++) {
        let c = world.at(x, y);
        if (c === '.' || x < 0 || x >= world.W) continue;
        if (c === '#' && !world.solid(x, y - 1)) c = 'G';
        const idx = strip?.chars ? strip.chars.indexOf(c) : -1;
        if (!drawTile(ctx, strip, idx, x * TS, y * TS, TS)) { ctx.fillStyle = COLORS[c] ?? '#666'; ctx.fillRect(x * TS, y * TS, TS, TS); }
      }
    }
    // The exit: a flag, green once open.
    const open = !coins.length;
    const ei = strip?.chars ? strip.chars.indexOf('E') : -1;
    if (!(open && drawTile(ctx, strip, ei, exit.x * TS, exit.y * TS, TS))) {
      ctx.fillStyle = '#5a4a3a'; ctx.fillRect(exit.x * TS + TS * 0.2, exit.y * TS - TS, 3, TS * 2);
      ctx.fillStyle = open ? '#3ac85a' : '#c84a3a'; ctx.fillRect(exit.x * TS + TS * 0.2 + 3, exit.y * TS - TS, TS * 0.6, TS * 0.45);
    }
    for (const c of coins) {
      const bob = Math.sin(c.t * 4) * 2;
      const spin = art.coin ? Object.assign(new Animator(art.coin, 'spin'), { t: c.t }) : null;
      if (!spin?.draw(ctx, (c.x + 0.5) * TS, (c.y + 0.5) * TS + bob, { scale: T.scale * 0.9, anchor: 'centre' })) {
        ctx.fillStyle = '#f6d23a'; ctx.beginPath(); ctx.arc((c.x + 0.5) * TS, (c.y + 0.5) * TS + bob, TS * 0.28, 0, Math.PI * 2); ctx.fill();
      }
    }
    for (const e of enemies) {
      if (!e.anim?.draw(ctx, e.x * TS, e.y * TS, { scale: T.scale * 0.9, flip: e.dir > 0 })) { ctx.fillStyle = '#6ac04a'; ctx.fillRect(e.left * TS, e.top * TS, e.w * TS, e.h * TS); }
    }
    const blink = invuln > 0 && Math.floor(invuln * 10) % 2;
    if (!blink && !anim?.draw(ctx, player.x * TS, player.y * TS + 1, { scale: T.scale, flip: player.facing < 0 })) {
      ctx.fillStyle = '#4a9ae8'; ctx.fillRect(player.left * TS, player.top * TS, player.w * TS, player.h * TS);
    }
    fx.draw(ctx);
    ctx.restore();
    hud(ctx, [`Coins ${total - coins.length}/${total}`, `Score ${S.score}`, T.lives > 0 ? `Lives ${S.lives}` : `Deaths ${S.deaths}`, art.levels.length > 1 ? `Level ${levelIndex + 1}/${art.levels.length}` : '']);
    if (open && Math.floor(g.time * 2) % 2) text(ctx, 'The exit is open!', W - 10, 16, { size: 14, align: 'right', color: '#9ae6b4' });
  },
};

game.scenes = standardScenes({
  load, play, title: config.title ?? 'Platformer', subtitle: 'Press Enter to start', card,
  onRestart: () => { S.lives = undefined; },
});
game.input.map.mute = ['KeyM'];

game.expose(() => {
  const inPlay = !!world;
  // Where to head next: the coins in the order the level runs (left to right), then the exit.
  const left = inPlay ? coins.map((c) => ({ x: c.x + 0.5, y: c.y + 1 })).sort((a, b) => a.x - b.x) : [];
  return {
    player: inPlay ? { ...pt(player), ground: player.ground } : null,
    coins: inPlay ? total - coins.length : 0, collected: inPlay ? total - coins.length : 0, total: inPlay ? total : 0,
    score: S.score ?? 0, lives: T.lives > 0 ? S.lives ?? T.lives : null, level: inPlay ? levelIndex + 1 : 0, levels: art.levels?.length ?? 0,
    exitOpen: inPlay && !coins.length,
    targets: inPlay ? (left.length ? [left[0]] : [{ x: exit.x + 0.5, y: exit.y + 1 }]) : [], remaining: left, deaths: S.deaths ?? 0,
    enemies: inPlay ? enemies.length : 0, missingAssets: missing.length,
  };
});
game.start('loading');
