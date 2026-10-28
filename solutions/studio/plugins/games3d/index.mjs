// Games and 3D (Studio's core): agents, skills and workflows live in their folders; this adds
// the gltf-valid and model-preview gates (and a model_info tool) for exported models, and
// Studio's assets, player and templates parts (studio_template and the production gates). The
// engines are plugins of their own (engine-blender, engine-godot, engine-unreal, engine-unity),
// each with its tool, gates, skills and agent: the
// workflows here name their tools and gates (blender, godot, blender-file, godot-project,
// godot-selftest), which are there when those plugins are on.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '@harness/plugin-sdk/runtime';
import { resolveIn } from '@harness/plugin-sdk/runtime';
import { findFiles } from './lib-engines.mjs';
import { describeGltf, inspectGltf } from './lib-gltf.mjs';
import { pngStats } from './lib-png.mjs';
import { setupAssets } from './assets/index.mjs';
import { setupPlayer } from './player/index.mjs';
import { templateTool } from './templates/index.mjs';
import { registerProductionGates } from './templates/gates.mjs';
import { setupUiRoutes } from './ui/routes.mjs';
import { stopAllPlaying } from './lib-play.mjs';

const isPng = (n) => /\.png$/i.test(n);

const SKIP = new Set(['node_modules', '.git', 'vendor', '.harness', 'dist', 'build']);
async function findModels(root, rel = '', depth = 4, out = []) {
  let entries = [];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth > 0 && !SKIP.has(e.name) && !e.name.startsWith('.')) await findModels(root, r, depth - 1, out); }
    else if (/\.(glb|gltf)$/i.test(e.name)) out.push(r);
    if (out.length >= 20) break;
  }
  return out;
}

export default {
  name: 'games3d',
  // The games served for playing (studio_template play) stop with the harness.
  close: () => stopAllPlaying(),
  setup(api) {
    setupAssets(api);
    setupPlayer(api);
    api.registerTool(defineTool(templateTool));
    registerProductionGates(api);
    setupUiRoutes(api);
    api.registerTool(defineTool({
      name: 'model_info',
      description: 'Inspect a glTF model (.glb/.gltf) in the workspace: valid or not, meshes, triangles, materials, textures, animations and approximate size in metres (glTF units are metres).',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'The model file in the workspace, e.g. "assets/models/barrel.glb"' } }, required: ['path'] },
      kind: 'read',
      // Reads a local file: the plugin's declared hosts (image and text-to-3D services) are not its concern.
      sendsOut: false,
      parallelSafe: true,
      summarize: (i) => String(i.path),
      async run(input, { host }) {
        if (host.kind === 'companion') return { content: 'model_info runs on the server; not available in companion sessions.', is_error: true };
        const file = await resolveIn(host, String(input.path));
        try { return describeGltf(String(input.path), await inspectGltf(file)); } catch (e) { return { content: `${input.path} is not a valid glTF model: ${e.message}`, is_error: true }; }
      },
    }));

    api.registerGate({
      name: 'gltf-valid',
      description: 'Every glTF model in the workspace (.glb/.gltf) is a valid glTF 2.0 file with geometry and a plausible size.',
      applies: async (host) => host.kind !== 'companion' && (await findModels(host.root)).length > 0,
      async run({ host }) {
        const files = await findModels(host.root);
        const bad = [];
        const ok = [];
        for (const f of files) {
          try {
            const g = await inspectGltf(path.join(host.root, f));
            if (!g.meshes || !g.triangles) bad.push(`${f}: no geometry`);
            else if (g.size && (Math.max(...g.size) > 1000 || Math.max(...g.size) < 0.001)) bad.push(`${f}: implausible size ${g.size.join(' x ')} m (glTF units are metres)`);
            else ok.push(describeGltf(f, g));
          } catch (e) { bad.push(`${f}: ${e.message}`); }
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${files.length} model(s) invalid`, details: bad.join('\n') }
          : { pass: true, summary: `${files.length} valid model(s)`, details: ok.join('\n') };
      },
    });

    api.registerGate({
      name: 'model-preview',
      description: 'Rendered previews of the models (PNG files in previews/) exist, were rendered after the last export, and show something (not one colour).',
      applies: async (host) => {
        if (host.kind === 'companion') return false;
        return (await findModels(host.root)).length > 0 && (await findFiles(path.join(host.root, 'previews'), isPng, { max: 1, depth: 2 })).length > 0;
      },
      async run({ host, signal }) {
        const root = host.kind === 'companion' ? await host.mirror?.(signal) : host.root;
        if (!root) return { pass: false, summary: 'this companion cannot send files to the server' };
        const models = await findModels(root);
        if (!models.length) return { pass: false, summary: 'no model (.glb/.gltf) to preview', details: 'Export the model first (model.glb).' };
        const shots = (await findFiles(path.join(root, 'previews'), isPng, { max: 20, depth: 2 })).sort();
        const how = 'Render previews of the exported model into previews/ (e.g. previews/front.png, side.png, top.png) after the last export, and look at them (blender-scripting: previews).';
        if (!shots.length) return { pass: false, summary: 'no preview renders in previews/', details: how };
        const newest = Math.max(...await Promise.all(models.map(async (m) => (await fsp.stat(path.join(root, m))).mtimeMs)));
        const bad = [];
        const ok = [];
        for (const s of shots) {
          const file = path.join(root, 'previews', s);
          try {
            const st = await fsp.stat(file);
            const p = pngStats(await fsp.readFile(file));
            // A companion's copy has the copy's times, not the originals': there the order is not checked.
            if (host.kind !== 'companion' && st.mtimeMs + 2000 < newest) bad.push(`previews/${s}: older than the last model export (render it again)`);
            else if (p.width < 64 || p.height < 64) bad.push(`previews/${s}: ${p.width}x${p.height} is too small to judge`);
            else if (p.blank) bad.push(`previews/${s}: blank (${p.colours} colour(s)): the model is not in view or not lit`);
            else ok.push(`previews/${s} ${p.width}x${p.height}${p.colours === null ? '' : `, ${p.colours} colours`}`);
          } catch (e) { bad.push(`previews/${s}: ${e.message}`); }
        }
        return bad.length
          ? { pass: false, summary: `${bad.length} of ${shots.length} preview(s) unusable`, details: `${bad.join('\n')}\n${how}` }
          : { pass: true, summary: `${shots.length} preview(s) of ${models.length} model(s): ${ok.join(', ')}` };
      },
    });
  },
};
