---
name: threejs-essentials
description: A working Three.js setup (vendored, offline) - renderer, camera, lights, shadows, resize, animation loop, PBR materials, orbit controls, screenshots from fixed views, and GLB export. Use for any 3D scene, model viewer or 3D game.
---
# Three.js essentials

`add_library three` puts Three.js in `vendor/three/` (the check browser and a sandbox are offline: no CDN links).

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Model viewer</title>
<style>html,body{margin:0;height:100%;background:#1b1d22;overflow:hidden}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"./vendor/three/build/three.module.js","three/addons/":"./vendor/three/examples/jsm/"}}</script>
</head>
<body>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildModel } from './model.js';

// preserveDrawingBuffer: screenshots show the frame (the check tool reads the canvas).
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // (PCFSoftShadowMap was removed in r18x)
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1d22);
// An environment map: without one, metals have nothing to reflect and render black.
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 200);

// Three-point light + ambient fill. Units are metres.
scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30281f, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(4, 6, 3);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0005; // no shadow acne (moire stripes) on curved and double-sided surfaces
key.shadow.normalBias = 0.02;
Object.assign(key.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
scene.add(key);
const rim = new THREE.DirectionalLight(0x9fc4ff, 0.8);
rim.position.set(-5, 3, -4);
scene.add(rim);

const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const model = buildModel(THREE); // a THREE.Group, origin at the base centre, +Y up, +Z front
model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
scene.add(model);

// Frame the model whatever its size.
const box = new THREE.Box3().setFromObject(model);
const size = box.getSize(new THREE.Vector3());
const centre = box.getCenter(new THREE.Vector3());
const dist = Math.max(size.x, size.y, size.z) * 2.2 + 0.5;
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(centre);
controls.enableDamping = true;

// Fixed views for checks: ?view=front|side|back|top|three-quarter (default three-quarter).
const VIEWS = { front: [0, 0.15, 1], side: [1, 0.15, 0], back: [0, 0.15, -1], top: [0, 1, 0.001], 'three-quarter': [0.8, 0.45, 1] };
function setView(name) {
  const d = new THREE.Vector3(...(VIEWS[name] ?? VIEWS['three-quarter'])).normalize().multiplyScalar(dist);
  camera.position.copy(centre).add(d);
  camera.lookAt(centre);
  controls.update();
}
setView(new URLSearchParams(location.search).get('view'));

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// For checks and export.
window.__scene = {
  ready: true, setView,
  size: size.toArray().map((v) => +v.toFixed(3)),
  meshes: (() => { let n = 0; model.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
  triangles: (() => { let t = 0; model.traverse((o) => { if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return t; })(),
};
window.exportGLB = () => new GLTFExporter().parseAsync(model, { binary: true }); // ArrayBuffer
</script>
</body>
</html>
```

```js
// model.js - the model as code (re-run = rebuild). Origin at the base centre, metres.
export function buildModel(THREE) {
  const g = new THREE.Group();
  g.name = 'Lamp';
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.9, roughness: 0.35, name: 'Brushed steel' });
  const shade = new THREE.MeshStandardMaterial({ color: 0xf2e6c9, roughness: 0.8, side: THREE.DoubleSide, name: 'Linen' });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.03, 48), metal);
  base.position.y = 0.015;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.45, 24), metal);
  stem.position.y = 0.03 + 0.225;
  // A lathe turns a profile into a solid of revolution: shades, vases, bottles.
  const profile = [[0.16, 0], [0.09, 0.2]].map(([x, y]) => new THREE.Vector2(x, y));
  const lampshade = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), shade);
  lampshade.position.y = 0.42;
  g.add(base, stem, lampshade);
  return g;
}
```

## Checking it
- `browser {path: "index.html?view=front", eval: "window.__scene"}` - errors, size, triangles, and a screenshot. Look at front, side, top and three-quarter views.
- Export: `browser {path: "index.html", save: {path: "model.glb", js: "window.exportGLB()"}}`, then `model_info {path: "model.glb"}`.

## Rules
- Units are metres; +Y up; the model's front faces +Z; origin at the base centre (it sits on the ground at y = 0).
- MeshStandardMaterial with real `roughness`/`metalness`; name materials and parts (`mesh.name`) - names survive the export.
- Keep triangles reasonable (props < 50k, characters < 100k); `CylinderGeometry` with 24-64 segments is plenty.
- Shadows: `castShadow` on meshes, a shadow camera that covers the model, a ground that receives, `shadow.bias`/`normalBias` against acne.
- Always set `scene.environment` (RoomEnvironment as above) when anything is metallic or glossy.
- Animate with `renderer.setAnimationLoop` and a clock (`THREE.Clock`), never `setInterval`. Dispose geometries/materials you replace.
