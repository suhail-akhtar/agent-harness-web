// Games and 3D: agents, skills and workflows live in their folders; this adds
// the gltf-valid gate (and a model_info tool) for exported models.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '../../src/plugins/api.ts';
import { resolveIn } from '../../src/tools/paths.ts';
import { describeGltf, inspectGltf } from './lib-gltf.mjs';

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
  setup(api) {
    api.registerTool(defineTool({
      name: 'model_info',
      description: 'Inspect a glTF model (.glb/.gltf) in the workspace: valid or not, meshes, triangles, materials, textures, animations and approximate size in metres (glTF units are metres).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      kind: 'read',
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
  },
};
