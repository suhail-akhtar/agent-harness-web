// The 3D kit for the Three.js templates (2.5D side-scroller, third person, first person): a
// renderer that screenshots well, a DOM overlay for the HUD and the title/win/lose cards, a world
// built from grid rows (walls, platforms, coins, hazards, the exit), a character controller that
// slides along walls and steps onto low platforms, textures from Studio tile assets and glTF
// models from Studio model assets. Three.js comes from vendor/three (studio_template vendors it).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadImage, loadModel } from './assets.js';

export { THREE };

/** A renderer on the canvas: no antialiasing (cheap in a headless browser), the buffer kept for screenshots. */
export function createRenderer(canvas, width, height, { clear = 0x8fc7ee } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(clear);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/** The HUD and cards as DOM over the canvas. */
export function overlay(canvas) {
  const wrap = canvas.parentElement;
  wrap.style.position = 'relative';
  const hud = document.createElement('div');
  hud.style.cssText = 'position:absolute;left:10px;top:8px;font:700 14px system-ui,sans-serif;color:#f4f1e8;text-shadow:1px 1px 0 #000a;pointer-events:none;white-space:pre';
  const cardEl = document.createElement('div');
  cardEl.style.cssText = 'position:absolute;inset:0;display:none;place-items:center;background:#0b0d14b0;font:600 16px system-ui,sans-serif;color:#cfd6e6;text-align:center;pointer-events:none';
  wrap.append(hud, cardEl);
  return {
    hud(parts) { hud.textContent = parts.filter(Boolean).join('   '); },
    card(lines) {
      if (!lines) { cardEl.style.display = 'none'; return; }
      cardEl.style.display = 'grid';
      cardEl.innerHTML = `<div>${lines.filter(Boolean).map((l, i) => `<div style="${i ? 'margin-top:8px' : 'font-size:30px;color:#ffe27a'}">${String(l).replace(/[<&>]/g, '')}</div>`).join('')}</div>`;
    },
  };
}

/** A repeating texture from a Studio tile asset (studio_sprite tileset texture), or null. */
export async function tileTexture(ref, repeat = 1) {
  const img = await loadImage(ref);
  if (!img) return null;
  const t = new THREE.Texture(img);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

const gltf = new GLTFLoader();
/** A glTF model from a Studio model asset, scaled to a height in metres, its feet at y = 0; or null. */
export async function model(ref, height) {
  if (!ref) return null;
  const g = await loadModel(ref, gltf);
  if (!g?.scene) return null;
  const obj = g.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (height && size.y > 0) obj.scale.multiplyScalar(height / size.y);
  const b2 = new THREE.Box3().setFromObject(obj);
  obj.position.y -= b2.min.y;
  const holder = new THREE.Group();
  holder.add(obj);
  return holder;
}

export function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x5a4a3a, 1.4));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(6, 12, 4);
  scene.add(sun);
}

const mat = (color, map) => new THREE.MeshLambertMaterial({ color, map: map ?? null });

/**
 * A world from rows, CELL metres a cell: # wall, = low platform (steppable), U a platform with a
 * coin on it, C / $ / * / o a coin, H / m / e a hazard that patrols, S / P the start, E the exit,
 * anything else floor. Returns { group, walls (boxes), platforms, coins, hazards, start, exit, W, H }.
 */
export function buildGridWorld(rows, { cell = 2, wallHeight = 2.5, platform = 0.5, textures = {} } = {}) {
  const group = new THREE.Group();
  const H = rows.length, W = Math.max(...rows.map((r) => r.length));
  const floorTex = textures.floor?.clone(); if (floorTex) { floorTex.repeat.set(W, H); floorTex.needsUpdate = true; }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W * cell, H * cell), mat(textures.floor ? 0xffffff : 0x6a9a4a, floorTex));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set((W * cell) / 2, 0, (H * cell) / 2);
  group.add(floor);
  const walls = [], platforms = [], coins = [], hazards = [];
  let start = null, exit = null;
  const wallGeo = new THREE.BoxGeometry(cell, wallHeight, cell);
  const wallMat = mat(textures.wall ? 0xffffff : 0x7a7a8a, textures.wall ?? null);
  const platGeo = new THREE.BoxGeometry(cell, platform, cell);
  const platMat = mat(textures.platform ? 0xffffff : 0xa8865a, textures.platform ?? null);
  rows.forEach((r, z) => [...r].forEach((c, x) => {
    const cx = (x + 0.5) * cell, cz = (z + 0.5) * cell;
    if (c === '#') {
      walls.push({ minX: x * cell, maxX: (x + 1) * cell, minZ: z * cell, maxZ: (z + 1) * cell, top: wallHeight, cx, cz });
    } else if (c === '=' || c === 'U') {
      platforms.push({ minX: x * cell, maxX: (x + 1) * cell, minZ: z * cell, maxZ: (z + 1) * cell, top: platform, cx, cz });
      if (c === 'U') coins.push({ x: cx, y: platform + 0.8, z: cz });
    } else if ('C$*o'.includes(c)) coins.push({ x: cx, y: 0.8, z: cz });
    else if ('HmeX'.includes(c)) hazards.push({ x: cx, y: 0.5, z: cz, home: { x: cx, z: cz } });
    else if (c === 'S' || c === 'P') start = { x: cx, y: 0, z: cz };
    else if (c === 'E') exit = { x: cx, y: 0, z: cz };
  }));
  // Walls and platforms as instanced meshes: two draw calls however big the level.
  const m4 = new THREE.Matrix4();
  for (const [list, geo, material, y] of [[walls, wallGeo, wallMat, wallHeight / 2], [platforms, platGeo, platMat, platform / 2]]) {
    if (!list.length) continue;
    const inst = new THREE.InstancedMesh(geo, material, list.length);
    list.forEach((b, k) => inst.setMatrixAt(k, m4.makeTranslation(b.cx, y, b.cz)));
    group.add(inst);
  }
  return { group, walls, platforms, coins, hazards, start: start ?? { x: cell * 1.5, y: 0, z: cell * 1.5 }, exit: exit ?? { x: (W - 1.5) * cell, y: 0, z: (H - 1.5) * cell }, W, H, cell };
}

/** A spinning coin mesh. */
export function coinMesh() {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.08, 16), new THREE.MeshLambertMaterial({ color: 0xf6d23a, emissive: 0x403000 }));
  m.rotation.z = Math.PI / 2;
  const g = new THREE.Group();
  g.add(m);
  return g;
}

/** A spiked ball for hazards. */
export function hazardMesh() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.4, 0), new THREE.MeshLambertMaterial({ color: 0xd04040, flatShading: true })));
  return g;
}

/** The exit: a door frame whose panel turns from red to green when it opens. */
export function exitMesh() {
  const g = new THREE.Group();
  const frame = new THREE.MeshLambertMaterial({ color: 0x5a4a3a });
  for (const x of [-0.8, 0.8]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.4, 0.2), frame); p.position.set(x, 1.2, 0); g.add(p); }
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.2, 0.2), frame); top.position.y = 2.4; g.add(top);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(1.4, 2.2, 0.08), new THREE.MeshLambertMaterial({ color: 0xc84a3a, emissive: 0x200000 }));
  panel.position.y = 1.1;
  g.add(panel);
  g.userData.setOpen = (open) => { panel.material.color.set(open ? 0x3ac85a : 0xc84a3a); panel.material.emissive.set(open ? 0x0a3010 : 0x200000); };
  return g;
}

/** A capsule stand-in for the player (or a model from the config). */
export function capsule(color = 0x4a9ae8) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 4, 10), new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.8;
  g.add(body);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.3), new THREE.MeshLambertMaterial({ color: 0xf4f1e8 }));
  nose.position.set(0, 1.25, -0.35);
  g.add(nose);
  return g;
}

/**
 * Moves a character (feet at p.y, radius r) by (dx, dz), pushing it out of walls and stepping up
 * onto platforms no higher than `step`; gravity and jumps on p.vy. Returns { landed, ground }.
 */
export function moveCharacter(world, p, dx, dz, dt, { r = 0.4, gravity = 22, step = 0.55 } = {}) {
  const push = () => {
    for (const b of world.walls.concat(world.platforms)) {
      // Low enough to step onto (or already above it): not in the way.
      if (p.y >= b.top - step) continue;
      const nx = Math.max(b.minX, Math.min(p.x, b.maxX)), nz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
      const ddx = p.x - nx, ddz = p.z - nz, d2 = ddx * ddx + ddz * ddz;
      if (d2 >= r * r) continue;
      const d = Math.sqrt(d2) || 1e-4;
      if (d2 < 1e-8) { p.x += r; continue; }
      p.x = nx + (ddx / d) * r;
      p.z = nz + (ddz / d) * r;
    }
  };
  p.x += dx; push();
  p.z += dz; push();
  // Ground: the floor, or the top of a platform under the character.
  let ground = 0;
  for (const b of world.platforms) if (p.x > b.minX - r * 0.5 && p.x < b.maxX + r * 0.5 && p.z > b.minZ - r * 0.5 && p.z < b.maxZ + r * 0.5 && b.top <= p.y + step) ground = Math.max(ground, b.top);
  p.vy -= gravity * dt;
  p.y += p.vy * dt;
  const wasGround = p.ground;
  p.ground = false;
  if (p.y <= ground) { p.y = ground; p.vy = 0; p.ground = true; }
  return { landed: p.ground && !wasGround, ground: p.ground };
}
