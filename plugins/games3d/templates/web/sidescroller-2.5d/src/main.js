// 2.5D side-scroller (Studio web template sidescroller-2.5d, Three.js): platformer rules on a 2D
// plane (the same physics and studio_procgen levels as platformer-2d), drawn in 3D: blocks and
// platforms as boxes, spinning coins, walkers, spikes, an exit door, and layers of hills, trees
// and mountains at several depths that the perspective camera scrolls past at their own speeds.
// Edit game.json first (levels, tuning, colours, an optional glTF player model).

import { Game, loadConfig, pauseCheck, standardScenes } from './engine/core.js';
import { InputMap } from './engine/input.js';
import { loadLevel, missing } from './engine/assets.js';
import { Sound } from './engine/audio.js';
import { Body, hazard, PlatformWorld, Route, SOLID, stepBody, stepWalker } from './engine/platformer.js';
import { capsule, coinMesh, createRenderer, exitMesh, lights, model, overlay, THREE, tileTexture } from './engine/three-kit.js';

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

const config = await loadConfig();
const T = { lives: 0, coinScore: 10, stompScore: 50, layers: true, ...(config.tuning ?? {}) };
const canvas = document.getElementById('game');
const game = new Game({ canvas, width: W, height: H, config });
game.input = new InputMap(undefined, config.controls);
game.input.map.mute = ['KeyM'];
game.input.botOrder = ['left', 'right', 'jump'];
const renderer = createRenderer(canvas, W, H, { clear: 0x9ad0f0 });
const ui = overlay(canvas);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9ad0f0, 25, 90);
const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 300);
lights(scene);
const sound = new Sound();
const art = {};

async function load() {
  const a = config.assets ?? {};
  const [ground, block, playerModel] = await Promise.all([tileTexture(a.ground), tileTexture(a.block), model(a.player, 1.7)]);
  Object.assign(art, { ground, block, playerModel });
  art.levels = [];
  for (const ref of config.levels ?? []) { const lv = await loadLevel(ref); if (lv) art.levels.push(lv); }
  if (!art.levels.length) art.levels.push({ type: 'platformer', rows: BUILT_IN });
  await sound.load(a.sounds ?? {}, a.music ? { music: a.music } : {});
  if (T.layers) backdrop();
  startLevel(0);
}

/** The 3D layers behind (and one in front of) the play plane: mountains, hills, trees. */
function backdrop() {
  const g = new THREE.Group();
  const r = game.random;
  const lv = art.levels[0];
  const len = Math.max(60, (lv.width ?? lv.rows[0].length) + 40);
  const cone = (h, rad, color, x, y, z) => { const m = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 6), new THREE.MeshLambertMaterial({ color, flatShading: true })); m.position.set(x, y + h / 2, z); g.add(m); };
  for (let x = -20; x < len; x += 14 + r() * 10) cone(16 + r() * 14, 10 + r() * 6, 0x7a86a8, x, -6, -45);
  for (let x = -15; x < len; x += 8 + r() * 6) { const m = new THREE.Mesh(new THREE.SphereGeometry(6 + r() * 4, 8, 6), new THREE.MeshLambertMaterial({ color: 0x5a9a4a, flatShading: true })); m.position.set(x, -6, -18); g.add(m); }
  for (let x = -10; x < len; x += 3 + r() * 4) { cone(2.5 + r() * 2, 1 + r() * 0.6, 0x2f6a3a, x, -1.5, -6 - r() * 3); const t = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.2), new THREE.MeshLambertMaterial({ color: 0x6a4a2a })); t.position.set(x, -1, -7); g.add(t); }
  scene.add(g);
}

const S = game.data;
let route, world, player, playerObj, coins, enemies, exit, exitObj, root, levelIndex, total, checkpoint, invuln, groundTime;
const wy = (y) => world.H - y; // tile rows (y down) to world y (up)

function startLevel(i) {
  levelIndex = i;
  if (root) scene.remove(root);
  root = new THREE.Group();
  scene.add(root);
  const lv = art.levels[i];
  world = new PlatformWorld(lv.rows, { ...(lv.physics ?? {}), ...(config.physics ?? {}) });
  route = new Route(lv.proof?.moves);
  const [start] = world.take('S');
  const [ex] = world.take('E');
  exit = ex ?? { x: world.W - 2, y: world.H - 3 };
  coins = world.take('o').map((c) => { const m = coinMesh(); m.scale.setScalar(0.9); m.position.set(c.x + 0.5, wy(c.y + 0.5), 0); root.add(m); return { ...c, mesh: m }; });
  enemies = world.take('e').map((c) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshLambertMaterial({ color: 0x6ac04a })); root.add(m); return Object.assign(new Body(c.x + 0.5, c.y + 1, 0.9, 0.9), { mesh: m }); });
  // The level's blocks: one instanced box per solid tile, ground and blocks in their own materials.
  const box = new THREE.BoxGeometry(1, 1, 2);
  const groundMat = new THREE.MeshLambertMaterial({ color: art.ground ? 0xffffff : 0x6a8a4a, map: art.ground ?? null });
  const blockMat = new THREE.MeshLambertMaterial({ color: art.block ? 0xffffff : 0x9a7a5a, map: art.block ?? null });
  const plankMat = new THREE.MeshLambertMaterial({ color: 0xb08a5a });
  const spikeMat = new THREE.MeshLambertMaterial({ color: 0xc8ccd8, flatShading: true });
  // Solid tiles as two instanced meshes (two draw calls however long the level).
  const cells = { ground: [], block: [] };
  for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) { const c = world.at(x, y); if (SOLID.has(c)) cells[c === 'X' ? 'block' : 'ground'].push([x, y]); }
  for (const [kind, list] of Object.entries(cells)) {
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(box, kind === 'block' ? blockMat : groundMat, list.length);
    const m4 = new THREE.Matrix4();
    list.forEach(([x, y], k) => inst.setMatrixAt(k, m4.makeTranslation(x + 0.5, wy(y + 0.5), 0)));
    root.add(inst);
  }
  for (let y = 0; y < world.H; y++) for (let x = 0; x < world.W; x++) {
    const c = world.at(x, y);
    if (SOLID.has(c)) continue;
    if (c === '-') { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1.6), plankMat); m.position.set(x + 0.5, wy(y + 0.1), 0); root.add(m); }
    else if (c === '^') for (const dz of [-0.4, 0.4]) { const m = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 5), spikeMat); m.position.set(x + 0.5, wy(y + 1) + 0.27, dz); root.add(m); }
  }
  exitObj = exitMesh();
  exitObj.scale.setScalar(0.8);
  exitObj.position.set(exit.x + 0.5, wy(exit.y + 1), 0);
  root.add(exitObj);
  playerObj = art.playerModel ? art.playerModel.clone() : capsule();
  root.add(playerObj);
  total = coins.length;
  const s = start ?? { x: 1, y: 1 };
  player = new Body(s.x + 0.5, s.y + 1, world.p.playerWidth, world.p.playerHeight);
  checkpoint = { x: player.x, y: player.y };
  invuln = 1;
  groundTime = 0;
  game.emit('level', `level ${i + 1} of ${art.levels.length}`);
}

function die(why) {
  if (invuln > 0) return;
  S.deaths++;
  if (T.lives > 0) S.lives--;
  game.emit('death', why);
  sound.play('hit');
  if (T.lives > 0 && S.lives <= 0) { game.go('gameover'); return; }
  Object.assign(player, { x: checkpoint.x, y: checkpoint.y, vx: 0, vy: 0 });
  invuln = 1.2;
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
    const dir = g.input.axis('left', 'right');
    const r = stepBody(world, player, { dir, jump: g.input.pressed('jump') || g.input.pressed('up'), jumpHeld: g.input.held('jump'), dt });
    if (r.jumped) { sound.play('jump'); g.emit('jump', ''); }
    const safe = route.update(player);
    if (safe && !hazard(world, player)) checkpoint = { x: player.x, y: player.y };
    groundTime = player.ground ? groundTime + dt : 0;
    if (groundTime > 0.25 && !hazard(world, player)) checkpoint = { x: player.x, y: player.y };
    const h = hazard(world, player);
    if (h) die(h === 'fell' ? 'fell into a pit' : 'spikes');
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      c.mesh.rotation.y += dt * 3;
      if (player.right > c.x + 0.15 && player.left < c.x + 0.85 && player.top < c.y + 0.85 && player.y > c.y + 0.15) {
        root.remove(c.mesh); coins.splice(i, 1);
        S.score += T.coinScore; sound.play('coin');
        g.emit('pickup', `coin ${total - coins.length}/${total}`);
        if (!coins.length) { exitObj.userData.setOpen(true); g.emit('exit-open', 'every coin taken: the exit is open'); }
      }
    }
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      stepWalker(world, e, dt);
      e.mesh.position.set(e.x, wy(e.y) + 0.45, 0);
      e.mesh.scale.y = 1 + Math.sin(g.time * 8 + i) * 0.1;
      if (!player.overlaps(e)) continue;
      if (player.vy > 0 && player.y - e.top < 0.6) { root.remove(e.mesh); enemies.splice(i, 1); player.vy = -world.p.v0 * 0.6; S.score += T.stompScore; sound.play('stomp'); g.emit('kill', 'stomped a walker'); }
      else die('hit by a walker');
    }
    if (g.sceneName !== 'play') return;
    if (!coins.length && player.right > exit.x && player.left < exit.x + 1 && player.top < exit.y + 1 && player.y > exit.y) {
      sound.play('win');
      g.emit('level-complete', `level ${levelIndex + 1}`);
      if (levelIndex + 1 < art.levels.length) startLevel(levelIndex + 1); else g.go('won');
    }
  },
  draw() {
    if (!world) return;
    playerObj.position.set(player.x, wy(player.y), 0);
    playerObj.rotation.y = player.facing > 0 ? -Math.PI / 2 : Math.PI / 2;
    playerObj.visible = !(invuln > 0 && Math.floor(invuln * 10) % 2);
    camera.position.set(player.x, wy(player.y) + 2.5, 15);
    camera.lookAt(player.x, wy(player.y) + 1, 0);
    renderer.render(scene, camera);
    ui.card(null);
    ui.hud([`Coins ${total - coins.length}/${total}`, `Score ${S.score}`, T.lives > 0 ? `Lives ${S.lives}` : `Deaths ${S.deaths}`, !coins.length ? 'The exit is open!' : '']);
  },
};

const card3d = (_ctx, game, lines) => { if (world) { play.draw(); } ui.card(lines); };
game.scenes = standardScenes({ load, play, title: config.title ?? 'Layer Run', subtitle: 'Press Enter to start', card: card3d, onRestart: () => { S.lives = undefined; } });

game.expose(() => {
  if (!world) return { player: null, targets: [] };
  const left = coins.map((c) => ({ x: c.x + 0.5, y: c.y + 1 })).sort((a, b) => a.x - b.x);
  return {
    player: { x: Math.round(player.x * 1000) / 1000, y: Math.round(player.y * 1000) / 1000, ground: player.ground }, score: S.score ?? 0, lives: T.lives > 0 ? S.lives : null, deaths: S.deaths ?? 0,
    coins: total - coins.length, total, exitOpen: !coins.length, level: levelIndex + 1, levels: art.levels.length,
    targets: [route.next(player, left[0] ?? { x: exit.x + 0.5, y: exit.y + 1 })], remaining: left, enemies: enemies.length, missingAssets: missing.length,
  };
});
game.start('loading');
