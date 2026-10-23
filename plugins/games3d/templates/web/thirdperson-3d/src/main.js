// 3D third-person collect-and-escape (Studio web template thirdperson-3d, Three.js): run and
// jump around walled courtyards, take every coin, keep clear of the rolling spike balls, and
// leave by the exit door once it turns green. The camera follows from behind and above at a fixed
// heading, so W is always "into the screen". Levels are grid rows in game.json or studio_procgen
// dungeons, caves and mazes ("asset:<id>": walls #, chests $ become coins, monsters m hazards);
// the floor, wall and platform textures and the player model are Studio assets.

import { Game, loadConfig, pauseCheck, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { loadLevel, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { Grid, waypoint } from './engine/grid.js';
import { buildGridWorld, capsule, coinMesh, createRenderer, exitMesh, hazardMesh, lights, model, moveCharacter, overlay, THREE, tileTexture } from './engine/three-kit.js';

const W = 640, H = 360;
const BUILT_IN = [
  '###############',
  '#S....C....#..#',
  '#..===...C.#.C#',
  '#..===........#',
  '#....H.....#..#',
  '#.C....#####..#',
  '#......#..C.E.#',
  '###############',
];

const config = await loadConfig();
const T = { lives: 0, coins: 3, health: 5, speed: 6, jump: 8, gravity: 22, cell: 2, coinScore: 10, hazardSpeed: 2.2, patrol: 3, ...(config.tuning ?? {}) };
const canvas = document.getElementById('game');
const game = new Game({ canvas, width: W, height: H, config });
game.input = new InputMap(undefined, { up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], ...(config.controls ?? {}) });
game.input.map.mute = ['KeyM'];
game.input.botOrder = ['up', 'down', 'left', 'right', 'jump'];
const renderer = createRenderer(canvas, W, H);
const ui = overlay(canvas);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8fc7ee, 30, 70);
const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 200);
lights(scene);
const sound = new Sound();
const art = { textures: {} };

async function load() {
  const a = config.assets ?? {};
  const [floor, wall, platform, playerModel] = await Promise.all([tileTexture(a.floor), tileTexture(a.wall, 2), tileTexture(a.platform), model(a.player, 1.7)]);
  art.textures = { floor, wall, platform };
  art.playerModel = playerModel;
  art.levels = [];
  for (const l of config.levels ?? []) {
    if (l && typeof l === 'object' && Array.isArray(l.rows)) art.levels.push({ rows: l.rows });
    else { const lv = await loadLevel(l); if (lv) art.levels.push({ rows: lv.rows.map((r) => r.replace(/\+/g, '.')) }); }
  }
  if (!art.levels.length) art.levels.push({ rows: BUILT_IN });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
  startLevel(0); // the title card shows the first level behind it
}

const S = game.data;
const round = (v) => Math.round(v * 1000) / 1000;
let world, grid, player, playerObj, coins, hazards, exitObj, levelIndex, total, invuln, root;

function startLevel(i) {
  levelIndex = i;
  if (root) scene.remove(root);
  root = new THREE.Group();
  scene.add(root);
  const rows = art.levels[i].rows;
  world = buildGridWorld(rows, { cell: T.cell, textures: art.textures });
  grid = new Grid(rows, ['#']);
  root.add(world.group);
  // A level without coins (a maze) gets some at the far ends of what the start reaches (seeded).
  if (!world.coins.length && T.coins > 0) {
    const c0 = { x: Math.floor(world.start.x / T.cell), y: Math.floor(world.start.z / T.cell) };
    const far = grid.reachable(c0).filter((c) => c.d > 3).sort((a, b) => b.d - a.d);
    for (let k = 0; k < T.coins && far.length; k++) { const c = far.splice(Math.floor(game.random() * Math.min(far.length, 6)), 1)[0]; world.coins.push({ x: (c.x + 0.5) * T.cell, y: 0.8, z: (c.y + 0.5) * T.cell }); }
  }
  coins = world.coins.map((c) => { const m = coinMesh(); m.position.set(c.x, c.y, c.z); root.add(m); return { ...c, mesh: m }; });
  hazards = world.hazards.map((h, k) => { const m = hazardMesh(); root.add(m); return { ...h, mesh: m, t: k * 1.3, axis: k % 2 ? 'x' : 'z' }; });
  exitObj = exitMesh();
  exitObj.position.set(world.exit.x, 0, world.exit.z);
  root.add(exitObj);
  playerObj = art.playerModel ? art.playerModel.clone() : capsule();
  root.add(playerObj);
  player = { ...world.start, vy: 0, ground: true, heading: 0 };
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
  player.vy = 4;
  game.emit('damage', `a spike ball; health ${S.health}`);
  if (S.health > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', 'spike balls');
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { ...world.start, vy: 0 });
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
    let dx = g.input.axis('left', 'right'), dz = g.input.axis('up', 'down');
    const n = Math.hypot(dx, dz);
    if (n) { dx /= n; dz /= n; player.heading = Math.atan2(dx, dz); }
    if (g.input.pressed('jump') && player.ground) { player.vy = T.jump; sound.play('jump'); g.emit('jump', ''); }
    moveCharacter(world, player, dx * T.speed * dt, dz * T.speed * dt, dt, { gravity: T.gravity });
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.mesh.rotation.y += dt * 3;
      if (Math.hypot(player.x - c.x, player.z - c.z) < 0.9 && Math.abs(player.y + 0.9 - c.y) < 1.2) {
        root.remove(c.mesh);
        coins.splice(i, 1);
        S.score += T.coinScore;
        sound.play('coin');
        g.emit('pickup', `coin ${total - coins.length}/${total}`);
        if (!coins.length) { exitObj.userData.setOpen(true); g.emit('exit-open', 'every coin taken: the exit is open'); }
      }
    }
    for (const h of hazards) {
      h.t += dt;
      const off = Math.sin(h.t * (T.hazardSpeed / T.patrol)) * T.patrol;
      const want = { x: h.axis === 'x' ? h.home.x + off : h.home.x, z: h.axis === 'z' ? h.home.z + off : h.home.z };
      const probe = { x: h.x, y: 0, z: h.z, vy: 0 };
      moveCharacter(world, probe, want.x - h.x, want.z - h.z, 0, { gravity: 0, r: 0.4 });
      h.x = probe.x; h.z = probe.z;
      h.mesh.position.set(h.x, 0.45, h.z);
      h.mesh.rotation.x += dt * 4;
      if (Math.hypot(player.x - h.x, player.z - h.z) < 0.8 && player.y < 1) hurt(h);
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
    playerObj.position.set(player.x, player.y, player.z);
    playerObj.rotation.y = player.heading + Math.PI;
    playerObj.visible = !(invuln > 0 && Math.floor(invuln * 10) % 2);
    camera.position.set(player.x, player.y + 7, player.z + 8);
    camera.lookAt(player.x, player.y + 1, player.z);
    renderer.render(scene, camera);
    ui.card(null);
    ui.hud([`Coins ${total - coins.length}/${total}`, `Health ${'*'.repeat(Math.max(0, S.health))}`, `Score ${S.score}`, art.levels.length > 1 ? `Level ${levelIndex + 1}` : '', !coins.length ? 'The exit is open!' : '']);
  },
};

const card3d = (_ctx, game, lines) => { if (game.sceneName !== 'play' && world) renderer.render(scene, camera); ui.card(lines); };
game.scenes = standardScenes({ load, play, title: config.title ?? 'Courtyard Run', subtitle: 'Press Enter to start', card: card3d, onRestart: () => { S.lives = undefined; } });

game.expose(() => {
  if (!world) return { player: null, targets: [] };
  const cell = T.cell;
  const goals = (coins.length ? coins : [world.exit]).map((c) => ({ x: Math.floor(c.x / cell), y: Math.floor(c.z / cell) }));
  const w = waypoint(grid, { x: player.x / cell, y: player.z / cell }, goals, { ahead: 2 });
  return {
    player: { x: round(player.x), y: round(player.y), z: round(player.z) }, score: S.score ?? 0, health: S.health, lives: T.lives > 0 ? S.lives : null, deaths: S.deaths ?? 0,
    coins: total - coins.length, total, exitOpen: !coins.length, level: levelIndex + 1, levels: art.levels.length,
    targets: w ? [{ x: w.x * cell, y: 0, z: w.y * cell }] : [], hazards: hazards.length, missingAssets: missing.length,
  };
});
game.start('loading');
