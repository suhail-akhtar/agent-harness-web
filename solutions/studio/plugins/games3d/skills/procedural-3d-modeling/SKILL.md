---
name: procedural-3d-modeling
description: How to model real objects with code in Three.js - plan from reference proportions, build from the right primitives (lathe, extrude, tube, rounded box), mirror and instance, materials, and the checks for a clean model. Use when making any 3D model or prop.
---
# Procedural 3D modelling

## Plan first (docs/model-plan.md)
- Real dimensions in metres (look them up or estimate from known objects: a door is 2.0 m, a chair seat 0.45 m high, a mug 0.1 m tall).
- The parts, each with its primitive, size and position; which parts are mirrored or repeated; the materials.
- The silhouette: what makes this object recognisable from the front and from the side. Get that right first; detail last.

## The right primitive
| Shape | Use |
|---|---|
| Round in plan (vase, bottle, lampshade, wheel hub, column) | `LatheGeometry(points, 64)` from a side profile |
| A flat outline with thickness (logo, plate, gear, panel with holes) | `ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelSize, bevelThickness })` |
| Along a path (pipe, cable, handle, rail, tentacle) | `TubeGeometry(new CatmullRomCurve3(points), 64, radius, 12)` |
| Boxy objects (furniture, devices, buildings) | `RoundedBoxGeometry(w, h, d, 4, r)` (sharp boxes look fake; r = 2-5% of size) |
| Many identical parts (bolts, leaves, chairs) | `InstancedMesh` |

```js
// model.js - a desk lamp-free example: a stool with a rounded seat, turned legs and a footrest ring.
import { RoundedBoxGeometry } from './vendor/three/examples/jsm/geometries/RoundedBoxGeometry.js';

export function buildModel(THREE) {
  const g = new THREE.Group();
  g.name = 'Stool';
  const wood = new THREE.MeshStandardMaterial({ color: 0x9b6a3c, roughness: 0.6, name: 'Oak' });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 1, roughness: 0.3, name: 'Steel' });

  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.04, 0.38, 4, 0.015), wood);
  seat.position.y = 0.66;
  seat.name = 'Seat';
  g.add(seat);

  // A turned leg: lathe a profile, then place four copies (mirror by position, splay by rotation).
  const profile = [[0.0, 0], [0.018, 0], [0.016, 0.3], [0.02, 0.32], [0.014, 0.64], [0, 0.64]].map(([x, y]) => new THREE.Vector2(x, y));
  const legGeo = new THREE.LatheGeometry(profile, 24);
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(sx * 0.14, 0, sz * 0.14);
    leg.rotation.set(sz * -0.06, 0, sx * 0.06); // splay outwards
    leg.name = 'Leg';
    g.add(leg);
  }

  // Footrest: a tube along a closed circle.
  const ring = new THREE.CatmullRomCurve3(Array.from({ length: 24 }, (_, i) => new THREE.Vector3(Math.cos(i / 24 * Math.PI * 2) * 0.16, 0.25, Math.sin(i / 24 * Math.PI * 2) * 0.16)), true);
  const foot = new THREE.Mesh(new THREE.TubeGeometry(ring, 96, 0.008, 12, true), steel);
  foot.name = 'Footrest';
  g.add(foot);

  // A plate with a hole: extrude a shape.
  const plate = new THREE.Shape().absarc(0, 0, 0.05, 0, Math.PI * 2);
  plate.holes.push(new THREE.Path().absarc(0, 0, 0.02, 0, Math.PI * 2, true));
  const badge = new THREE.Mesh(new THREE.ExtrudeGeometry(plate, { depth: 0.004, bevelEnabled: true, bevelSize: 0.001, bevelThickness: 0.001, curveSegments: 32 }), steel);
  badge.rotation.x = -Math.PI / 2;
  badge.position.set(0, 0.681, 0);
  badge.name = 'Badge';
  g.add(badge);
  return g;
}
```
(In index.html the import map maps `three/addons/`; inside model.js import addons by relative path as above, or pass them in.)

## Checks
- Every part touches what holds it: no floating parts, no gaps; parts may overlap slightly, never visibly intersect through a surface.
- Look at front, side, top and three-quarter views; compare the size (`window.__scene.size`) with the plan.
- Normals face out (a lathe profile goes bottom to top on the +X side); use `side: THREE.DoubleSide` only for thin shells.
- Materials: wood/plastic roughness 0.5-0.9, metal metalness 1 with roughness 0.2-0.5 (needs `scene.environment`), glass `MeshPhysicalMaterial({ transmission: 1, roughness: 0.05, thickness: 0.01 })`.
- Detail where the eye goes; keep triangles modest; reuse geometry for copies.
