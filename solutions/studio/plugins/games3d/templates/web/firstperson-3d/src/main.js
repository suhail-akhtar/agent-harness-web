// 3D first-person explorer (Studio web template firstperson-3d, Three.js): walk the halls with
// WASD, turn with the mouse (click to capture it) or Q/E and the arrow keys, jump with Space,
// zap the patrolling drones with X, take every coin and leave by the exit door. Levels are grid
// rows in game.json or studio_procgen dungeons, caves and mazes ("asset:<id>"); textures and
// sounds are Studio assets.

import { Game, loadConfig, pauseCheck, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { loadLevel, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { Grid, waypoint } from './engine/grid.js';
import { buildGridWorld, coinMesh, createRenderer, exitMesh, hazardMesh, lights, moveCharacter, overlay, THREE, tileTexture } from './engine/three-kit.js';

const W = 640, H = 360;
const BUILT_IN = [
  '#############',
  '#C....#....C#',
  '#.###.#.###.#',
  '#.#.......#.#',
  '#.#.##H##.#.#',
  '#...#.C.#...#',
  '###.#...#.###',
  '#C..##.##..E#',
  '#.....S.....#',
  '#############',
];

const config = await loadConfig();
const T = { lives: 0, coins: 3, health: 5, speed: 5, turn: 2.6, mouse: 0.0025, jump: 7, gravity: 22, cell: 2, eye: 1.6, coinScore: 10, droneScore: 25, hazardSpeed: 2, patrol: 3, ...(config.tuning ?? {}) };
const canvas = document.getElementById('game');
const game = new Game({ canvas, width: W, height: H, config });
game.input = new InputMap(undefined, { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], turnLeft: ['ArrowLeft', 'KeyQ'], turnRight: ['ArrowRight', 'KeyE'], action: ['KeyX', 'KeyF'], ...(config.controls ?? {}) });
game.input.map.mute = ['KeyM'];
// The bots walk and jump; turning (mouse, Q/E, arrows) is for people, so a bot's W is always north.
game.input.botOrder = ['up', 'down', 'left', 'right', 'jump'];
const renderer = createRenderer(canvas, W, H, { clear: 0x223044 });
const ui = overlay(canvas);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x223044, 8, 40);
const camera = new THREE.PerspectiveCamera(70, W / H, 0.05, 120);
lights(scene);
const sound = new Sound();
const art = {};
canvas.addEventListener('click', () => canvas.requestPointerLock?.());

async function load() {
  const a = config.assets ?? {};
  const [floor, wall, platform] = await Promise.all([tileTexture(a.floor), tileTexture(a.wall, 2), tileTexture(a.platform)]);
  art.textures = { floor, wall, platform };
  art.levels = [];
  for (const l of config.levels ?? []) {
    if (l && typeof l === 'object' && Array.isArray(l.rows)) art.levels.push({ rows: l.rows });
    else { const lv = await loadLevel(l); if (lv) art.levels.push({ rows: lv.rows.map((r) => r.replace(/\+/g, '.')) }); }
  }
  if (!art.levels.length) art.levels.push({ rows: BUILT_IN });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
  startLevel(0);
}

const S = game.data;
const round = (v) => Math.round(v * 1000) / 1000;
let world, grid, player, coins, drones, exitObj, levelIndex, total, invuln, root, zap = 0;

function startLevel(i) {
  levelIndex = i;
  if (root) scene.remove(root);
  root = new THREE.Group();
  scene.add(root);
  const rows = art.levels[i].rows;
  world = buildGridWorld(rows, { cell: T.cell, textures: art.textures, wallHeight: 3 });
  grid = new Grid(rows, ['#']);
  root.add(world.group);
  // A level without coins (a maze) gets some at the far ends of what the start reaches (seeded).
  if (!world.coins.length && T.coins > 0) {
    const c0 = { x: Math.floor(world.start.x / T.cell), y: Math.floor(world.start.z / T.cell) };
    const far = grid.reachable(c0).filter((c) => c.d > 3).sort((a, b) => b.d - a.d);
    for (let k = 0; k < T.coins && far.length; k++) { const c = far.splice(Math.floor(game.random() * Math.min(far.length, 6)), 1)[0]; world.coins.push({ x: (c.x + 0.5) * T.cell, y: 0.8, z: (c.y + 0.5) * T.cell }); }
  }
  coins = world.coins.map((c) => { const m = coinMesh(); m.position.set(c.x, c.y + 0.3, c.z); root.add(m); return { ...c, mesh: m }; });
  drones = world.hazards.map((h, k) => { const m = hazardMesh(); root.add(m); return { ...h, mesh: m, t: k * 1.7, axis: k % 2 ? 'x' : 'z' }; });
  exitObj = exitMesh();
  exitObj.position.set(world.exit.x, 0, world.exit.z);
  root.add(exitObj);
  player = { ...world.start, vy: 0, ground: true, yaw: 0, pitch: 0 };
  total = coins.length;
  S.health = T.health;
  invuln = 1;
  game.emit('level', `level ${i + 1} of ${art.levels.length}`);
}

function hurt(from) {
  if (invuln > 0) return;
  S.health--;
  invuln = 1.2;
  sound.play('hit');
  const d = Math.hypot(player.x - from.x, player.z - from.z) || 1;
  moveCharacter(world, player, ((player.x - from.x) / d) * 1.2, ((player.z - from.z) / d) * 1.2, 0, { gravity: 0 });
  game.emit('damage', `a drone; health ${S.health}`);
  if (S.health > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', 'drones');
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { ...world.start, vy: 0, yaw: 0 });
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
    const inp = g.input;
    if (inp.pressed('mute')) sound.toggleMute();
    invuln = Math.max(0, invuln - dt);
    zap = Math.max(0, zap - dt);
    player.yaw += (inp.axis('turnRight', 'turnLeft') * T.turn * dt) - (document.pointerLockElement === canvas ? inp.mouse.dx * T.mouse : 0);
    if (document.pointerLockElement === canvas) player.pitch = Math.max(-1.2, Math.min(1.2, player.pitch - inp.mouse.dy * T.mouse));
    const f = inp.axis('down', 'up'), s = inp.axis('left', 'right');
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    let dx = fx * f + Math.cos(player.yaw) * s, dz = fz * f - Math.sin(player.yaw) * s;
    const n = Math.hypot(dx, dz);
    if (n) { dx /= n; dz /= n; }
    if (inp.pressed('jump') && player.ground) { player.vy = T.jump; sound.play('jump'); }
    moveCharacter(world, player, dx * T.speed * dt, dz * T.speed * dt, dt, { gravity: T.gravity, r: 0.35 });
    if (inp.pressed('action') && zap <= 0) {
      zap = 0.3;
      sound.play('zap');
      // A hit-scan zap: the nearest drone within a few degrees of where the player looks.
      let best = null;
      for (const d of drones) {
        const vx = d.x - player.x, vz = d.z - player.z, dist = Math.hypot(vx, vz);
        if (dist > 14 || dist < 0.01) continue;
        const cos = (vx * fx + vz * fz) / dist;
        if (cos > 0.985 && (!best || dist < best.dist)) best = { d, dist };
      }
      if (best) { drones.splice(drones.indexOf(best.d), 1); root.remove(best.d.mesh); S.score += T.droneScore; g.emit('kill', 'a drone'); }
    }
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.mesh.rotation.y += dt * 3;
      if (Math.hypot(player.x - c.x, player.z - c.z) < 0.8) {
        root.remove(c.mesh); coins.splice(i, 1);
        S.score += T.coinScore; sound.play('coin');
        g.emit('pickup', `coin ${total - coins.length}/${total}`);
        if (!coins.length) { exitObj.userData.setOpen(true); g.emit('exit-open', 'every coin taken: the exit is open'); }
      }
    }
    for (const d of drones) {
      d.t += dt;
      const off = Math.sin(d.t * (T.hazardSpeed / T.patrol)) * T.patrol;
      const probe = { x: d.x, y: 0, z: d.z, vy: 0 };
      moveCharacter(world, probe, (d.axis === 'x' ? d.home.x + off : d.home.x) - d.x, (d.axis === 'z' ? d.home.z + off : d.home.z) - d.z, 0, { gravity: 0 });
      d.x = probe.x; d.z = probe.z;
      d.mesh.position.set(d.x, 1.3 + Math.sin(d.t * 3) * 0.15, d.z);
      d.mesh.rotation.y += dt * 2;
      if (Math.hypot(player.x - d.x, player.z - d.z) < 0.75) hurt(d);
    }
    if (g.sceneName !== 'play') return;
    if (!coins.length && Math.hypot(player.x - world.exit.x, player.z - world.exit.z) < 1) {
      sound.play('win');
      g.emit('level-complete', `level ${levelIndex + 1}`);
      if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1); else g.go('won');
    }
  },
  draw() {
    if (!world) return;
    camera.position.set(player.x, player.y + T.eye, player.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
    renderer.render(scene, camera);
    ui.card(null);
    ui.hud([`Coins ${total - coins.length}/${total}`, `Health ${'*'.repeat(Math.max(0, S.health))}`, `Score ${S.score}`, !coins.length ? 'The exit is open!' : '', zap > 0.2 ? 'ZAP' : '']);
  },
};

const card3d = (_ctx, game, lines) => { if (world) { camera.position.set(player.x, player.y + T.eye, player.z); camera.rotation.set(0, player.yaw, 0, 'YXZ'); renderer.render(scene, camera); } ui.card(lines); };
game.scenes = standardScenes({ load, play, title: config.title ?? 'Coin Halls', subtitle: 'Press Enter to start (click to look with the mouse)', card: card3d, onRestart: () => { S.lives = undefined; } });

game.expose(() => {
  if (!world) return { player: null, targets: [] };
  const cell = T.cell;
  const goals = (coins.length ? coins : [world.exit]).map((c) => ({ x: Math.floor(c.x / cell), y: Math.floor(c.z / cell) }));
  const w = waypoint(grid, { x: player.x / cell, y: player.z / cell }, goals, { ahead: 2 });
  return {
    player: { x: round(player.x), y: round(player.y), z: round(player.z) }, heading: round(player.yaw), score: S.score ?? 0, health: S.health, lives: T.lives > 0 ? S.lives : null, deaths: S.deaths ?? 0,
    coins: total - coins.length, total, exitOpen: !coins.length, level: levelIndex + 1, levels: art.levels.length,
    targets: w ? [{ x: w.x * cell, y: 0, z: w.y * cell }] : [], drones: drones.length, missingAssets: missing.length,
  };
});
game.start('loading');
