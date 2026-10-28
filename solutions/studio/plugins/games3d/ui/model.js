// Studio's 3D helpers, shared by the viewer, the asset grid and the model card: Three.js loaded on
// demand (vendor/three-studio.js, a pinned copy: frames are offline), a glTF read through Studio's
// routes and parsed in the page (a .gltf with separate .bin and image files is packed into one GLB
// first: a frame cannot fetch), the model's numbers, and thumbnails drawn once by one shared
// renderer (a page keeps a single WebGL context however many thumbnails it shows).
(function () {
  'use strict';
  const S = {};
  let three = null;

  /** window.StudioThree, loading the bundle the first time. */
  S.three = function () {
    if (window.StudioThree) return Promise.resolve(window.StudioThree);
    if (!three) {
      three = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/three-studio.js';
        s.onload = () => (window.StudioThree ? resolve(window.StudioThree) : reject(new Error('Three.js did not load')));
        s.onerror = () => reject(new Error('Three.js did not load'));
        document.head.append(s);
      });
    }
    return three;
  };

  const dirOf = (p) => { const i = String(p).replace(/\\/g, '/').lastIndexOf('/'); return i >= 0 ? String(p).replace(/\\/g, '/').slice(0, i + 1) : ''; };
  const join = (dir, rel) => {
    const out = [];
    for (const seg of `${dir}${rel}`.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); }
    return (/^[a-z]:/i.test(dir) || dir.startsWith('/')) && !/^[a-z]:/i.test(out[0] || '') ? `/${out.join('/')}` : out.join('/');
  };
  const pad4 = (n) => (n + 3) & ~3;

  /** A .gltf (JSON) and the files it names, as one GLB: every buffer in one BIN chunk, images as buffer views. */
  S.packGltf = async function (json, readRel) {
    const g = JSON.parse(JSON.stringify(json));
    const parts = [];
    let length = 0;
    const add = (bytes) => { const offset = length; parts.push({ offset, bytes }); length = pad4(length + bytes.length); return offset; };
    const dataUri = (uri) => { const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri); if (!m) return null; return m[2] ? window.Kit.bytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); };
    const bufferOffsets = [];
    for (const b of g.buffers || []) {
      const bytes = b.uri ? (dataUri(b.uri) || await readRel(decodeURIComponent(b.uri))) : new Uint8Array(b.byteLength || 0);
      bufferOffsets.push(add(bytes));
    }
    for (const v of g.bufferViews || []) { v.byteOffset = (v.byteOffset || 0) + bufferOffsets[v.buffer || 0]; v.buffer = 0; }
    for (const img of g.images || []) {
      if (!img.uri) continue;
      const bytes = dataUri(img.uri) || await readRel(decodeURIComponent(img.uri));
      const mime = img.mimeType || (/\.jpe?g$/i.test(img.uri) ? 'image/jpeg' : /\.webp$/i.test(img.uri) ? 'image/webp' : 'image/png');
      g.bufferViews = g.bufferViews || [];
      g.bufferViews.push({ buffer: 0, byteOffset: add(bytes), byteLength: bytes.length });
      img.bufferView = g.bufferViews.length - 1; img.mimeType = mime; delete img.uri;
    }
    g.buffers = length ? [{ byteLength: length }] : [];
    const bin = new Uint8Array(length);
    for (const p of parts) bin.set(p.bytes, p.offset);
    const jsonBytes = new TextEncoder().encode(JSON.stringify(g));
    const jsonLen = pad4(jsonBytes.length);
    const total = 12 + 8 + jsonLen + (length ? 8 + length : 0);
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20); for (let i = 20 + jsonBytes.length; i < 20 + jsonLen; i++) out[i] = 0x20;
    if (length) { dv.setUint32(20 + jsonLen, length, true); dv.setUint32(24 + jsonLen, 0x004e4942, true); out.set(bin, 28 + jsonLen); }
    return out;
  };

  /** A glTF model ({file args}) parsed: { gltf, bytes (file size), name }. */
  S.load = async function (harness, args) {
    const T = await S.three();
    const f = await window.Kit.readFile(harness, args);
    let data = f.bytes;
    const isGlb = data.length >= 4 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46;
    if (!isGlb) {
      let json;
      try { json = JSON.parse(new TextDecoder().decode(data)); } catch { throw new Error(`${f.name} is neither a .glb nor .gltf JSON`); }
      const dir = dirOf(args.path);
      const readRel = async (uri) => (await window.Kit.readFile(harness, { ...args, path: join(dir, uri) })).bytes;
      data = await S.packGltf(json, readRel);
    }
    const loader = new T.GLTFLoader();
    // Textures through <img> and blob: URLs (allowed), not createImageBitmap's fetch (a frame has no network).
    loader.register((parser) => { parser.textureLoader = new T.THREE.TextureLoader(parser.options.manager); return { name: 'studio_texture_loader' }; });
    const gltf = await new Promise((resolve, reject) => {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      loader.parse(ab, '', resolve, (e) => reject(new Error(/draco|meshopt|KHR_draco|EXT_meshopt/i.test(String(e && e.message)) ? 'This model is compressed (Draco or meshopt): the viewer reads uncompressed glTF. Keep an uncompressed copy for viewing.' : `Not a glTF model Studio can read: ${e && e.message ? e.message : e}`)));
    });
    return { gltf, size: f.size, name: f.name };
  };

  /** The numbers of a model: triangles, vertices, meshes, materials, textures, size in metres. */
  S.stats = function (T, root) {
    const { THREE } = T;
    let triangles = 0; let vertices = 0; let meshes = 0; let skinned = 0; let withoutUv = 0;
    const materials = new Set(); const textures = new Set();
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.isSkinnedMesh) skinned++;
      const g = o.geometry;
      const pos = g.attributes.position;
      if (!pos) return;
      vertices += pos.count;
      triangles += Math.floor((g.index ? g.index.count : pos.count) / 3) * (o.isInstancedMesh ? o.count : 1);
      if (!g.attributes.uv) withoutUv++;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m) continue;
        materials.add(m);
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) if (m[k]) textures.add(m[k]);
      }
    });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.isEmpty() ? [0, 0, 0] : box.getSize(new THREE.Vector3()).toArray();
    return { triangles, vertices, meshes, skinned, withoutUv, materials: materials.size, textures: textures.size, size, box };
  };

  /** Puts the camera where the whole model is in view (from the front, a little above), looking at its centre. */
  S.frame = function (T, camera, object, controls, dir) {
    const { THREE } = T;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (r / Math.sin(fov / 2)) * 1.08;
    const d = (dir || new THREE.Vector3(0.55, 0.42, 1)).clone().normalize();
    camera.position.copy(sphere.center).addScaledVector(d, dist);
    camera.near = Math.max(dist / 1000, 1e-4); camera.far = dist * 100;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);
    if (controls) { controls.target.copy(sphere.center); controls.update(); }
    return { center: sphere.center, radius: r, box };
  };

  /** Lights that show form on any model (no environment map: frames load nothing else). */
  S.light = function (T, scene) {
    const { THREE } = T;
    scene.add(new THREE.HemisphereLight(0xf2f4ff, 0x40362e, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(3, 5, 4); scene.add(key);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.7); fill.position.set(-4, 2, -3); scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  };

  let shared = null;
  const queue = [];
  let busy = false;
  /** A PNG data URL of the model ({file args}) drawn at w x h, one at a time, by one renderer. */
  S.thumbnail = function (harness, args, w = 320, h = 240) {
    return new Promise((resolve, reject) => { queue.push({ harness, args, w, h, resolve, reject }); pump(); });
  };
  async function pump() {
    if (busy || !queue.length) return;
    busy = true;
    const job = queue.shift();
    try { job.resolve(await draw(job)); } catch (e) { job.reject(e); } finally { busy = false; pump(); }
  }
  async function draw({ harness, args, w, h }) {
    const T = await S.three();
    const { THREE } = T;
    if (!shared) {
      const canvas = document.createElement('canvas');
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      shared = { renderer, canvas };
    }
    const { gltf } = await S.load(harness, args);
    const scene = new THREE.Scene();
    S.light(T, scene);
    const root = gltf.scene || gltf.scenes[0];
    scene.add(root);
    const camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 1000);
    S.frame(T, camera, root);
    shared.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    shared.renderer.setSize(w, h, false);
    shared.renderer.setClearColor(0x000000, 0);
    shared.renderer.render(scene, camera);
    const url = shared.canvas.toDataURL('image/png');
    const stats = S.stats(T, root);
    root.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (!m) continue; for (const k of Object.keys(m)) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } } });
    return { url, stats };
  }

  window.Studio3D = S;
})();
