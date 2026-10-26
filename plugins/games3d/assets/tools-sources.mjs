// studio_source: optional outside sources, each off unless the operator turns it on
// (HARNESS_STUDIO_SOURCES=polyhaven,ambientcg,kenney,openai,meshy,tripo or "all"):
// the CC0 libraries Poly Haven, ambientCG and Kenney (search, download with the licence
// recorded), image generation with OpenAI (post-processed into textures and sprites,
// costed and capped), and text-to-3D with Meshy or Tripo3D (cleaned in Blender, gated).

import path from 'node:path';
import { writeIn, removeIn } from '../lib-engines.mjs';
import { guarded, int, num, preview, save, unknownAction } from './common.mjs';
import { projectOf, publishAsset, slug } from './library.mjs';
import { decodePNG, encodePNG } from './raster/png.mjs';
import { normalMap } from './raster/image.mjs';
import { budgets, estimateImageUsd, openaiImage, SpendLedger, TEXT3D, waitTask } from './sources/generators.mjs';
import { LIBRARIES } from './sources/libraries.mjs';
import { applyOps } from './tools-2d.mjs';
import { modelTool } from './tools-model.mjs';

export const SOURCE_IDS = ['polyhaven', 'ambientcg', 'kenney', 'openai', 'meshy', 'tripo'];

/** The sources the operator turned on. */
export function enabledSources(env = process.env) {
  const v = String(env.HARNESS_STUDIO_SOURCES ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return v.includes('all') ? [...SOURCE_IDS] : SOURCE_IDS.filter((s) => v.includes(s));
}

const off = (id) => ({ content: `The ${id} source is off. The operator turns it on with HARNESS_STUDIO_SOURCES=${id} (comma-separated, or "all")${['openai', 'meshy', 'tripo'].includes(id) ? ` and the key ${id === 'openai' ? 'OPENAI_API_KEY' : id === 'meshy' ? 'MESHY_API_KEY' : 'TRIPO_API_KEY'} on the server` : ''}. Procedural assets need no source: studio_sprite, studio_model, studio_procgen.`, is_error: true });

const ACTIONS = ['status', 'search', 'download', 'image', 'text3d', 'spend'];

export function sourceTool(api) {
  const ledger = new SpendLedger(api.dataDir);
  const secret = (name) => { try { return api.secret(name); } catch { return undefined; } };
  return {
    name: 'studio_source',
    description: 'Optional outside asset sources, each off unless the operator turned it on (status says which). action: "status"; "search" a CC0 library: source polyhaven (type models|textures|hdris), ambientcg (PBR materials), kenney (game asset packs) with query; "download" one (id, resolution e.g. "1k" or "1K-PNG") into the project as an asset with its CC0 licence and source recorded (library: true also publishes it to the shared library); "image" generates with OpenAI (gpt-image-1, quality low|medium|high, size 1024x1024|1024x1536|1536x1024; every call is costed from its usage and refused when it would cross the spend cap) and post-processes it for purpose "texture" (power-of-two resize, tileable, normal map) or "sprite" (transparent background or colour-keyed, trimmed, square, resized to size with nearest, quantized to a palette or colours, sliced into cols x rows frames); "text3d" makes a model with Meshy or Tripo3D from a prompt (waits up to wait seconds; with task, resumes), then cleans it in Blender (scale, origin, normals, decimate to maxTriangles) and checks it; "spend" shows the generation spend and caps.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'What to do: status, search, download, image, text3d or spend' },
        source: { type: 'string', enum: SOURCE_IDS, description: 'search/download: the library, polyhaven, ambientcg or kenney' },
        query: { type: 'string', description: 'search: words to look for, e.g. "wooden crate"' }, type: { type: 'string', description: 'search: polyhaven models, textures or hdris (default models); ambientcg an asset type (default Material)' }, limit: { type: 'number', description: 'search: most results, 1-100 (default 20)' },
        id: { type: 'string', description: 'download: the library\'s asset id; otherwise the Studio asset id to save as' },
        resolution: { type: 'string', description: 'download: polyhaven e.g. "1k", "2k" (default 1k); ambientcg e.g. "1K-PNG", "2K-JPG" (default 1K-PNG)' }, format: { type: 'string', description: 'download polyhaven: file format, e.g. "hdr" or "exr" for HDRIs, "png" or "jpg" for texture maps (default hdr for HDRIs, else chosen per map)' }, include: { type: 'string', description: 'kenney: a regex of the files to keep' },
        library: { type: 'boolean', description: 'download: also publish to the shared library' },
        prompt: { type: 'string', description: 'image/text3d: what to make, e.g. "mossy cobblestone" or "a wooden treasure chest"' }, model: { type: 'string', description: 'image: the OpenAI image model (default gpt-image-1)' }, quality: { type: 'string', enum: ['low', 'medium', 'high'], description: 'image: generation quality, higher costs more (default low)' }, size: { type: ['string', 'number'], description: 'image: 1024x1024, 1024x1536 or 1536x1024 (default 1024x1024)' },
        purpose: { type: 'string', enum: ['texture', 'sprite', 'concept'], description: 'image: how to post-process it: texture, sprite, or concept (kept as generated); default texture' }, palette: { type: ['string', 'array'], description: 'image sprite: quantize onto a named palette (e.g. "db32") or a colour list' }, colors: { type: 'number', description: 'image sprite: quantize to this many colours (24 when only a palette is given)' },
        textureSize: { type: 'number', description: 'image texture: output size in px, 16-4096 (default 512)' }, tileable: { type: 'boolean', description: 'image texture: make it seamless (default true)' }, normal: { type: 'boolean', description: 'image texture: also make a normal map (default false)' }, spriteSize: { type: 'number', description: 'image sprite: sprite (or frame) size in px, 8-1024 (default 64)' }, cols: { type: 'number', description: 'image sprite: frame columns to slice the image into (default 1)' }, rows: { type: 'number', description: 'image sprite: frame rows to slice the image into (default 1)' },
        provider: { type: 'string', enum: ['meshy', 'tripo'], description: 'text3d: the text-to-3D service (default meshy)' }, task: { type: 'string', description: 'text3d: a task id from an earlier call, to resume waiting for it' }, wait: { type: 'number', description: 'text3d: seconds to wait for the task, 0-1800 (default 600)' },
        targetHeight: { type: 'number', description: 'text3d: scale the model to this height in metres (default 1)' }, maxTriangles: { type: 'number', description: 'text3d: triangle budget, 500-100000 (default 10000)' }, artStyle: { type: 'string', description: 'text3d meshy: the art style, e.g. "realistic" (default) or "sculpture"' },
        assetId: { type: 'string', description: 'The Studio asset id to save as (download/text3d)' },
        project: { type: 'string', description: 'Project folder (with .studio/project.json); default found' }, tags: { type: 'array', items: { type: 'string' }, description: 'Extra library tags for the saved asset, e.g. ["forest"]' }, export: { type: 'string', description: 'Also copy the files into this workspace folder (an engine project\'s assets)' },
      },
      required: ['action'],
    },
    kind: 'network',
    kindsFor: (i) => (['status', 'spend'].includes(String(i.action)) ? ['read'] : ['network', 'edit']),
    sendsOut: (i) => ['image', 'text3d', 'search', 'download'].includes(String(i.action)),
    untrusted: true,
    summarize: (i) => `${i.action} ${i.source ?? i.provider ?? ''} ${i.query ?? i.id ?? (i.prompt ? String(i.prompt).slice(0, 40) : '')}`.trim(),
    run: guarded('studio_source', async (input, ctx) => {
      const { host, signal } = ctx;
      const a = String(input.action ?? '');
      const on = enabledSources();
      const project = await projectOf(host, input.project);
      if (a === 'status') {
        const b = budgets();
        const s = await ledger.spent(host.root, project);
        return [
          `Sources on: ${on.length ? on.join(', ') : 'none'} (HARNESS_STUDIO_SOURCES; off: ${SOURCE_IDS.filter((x) => !on.includes(x)).join(', ') || 'none'})`,
          `Keys: OPENAI_API_KEY ${secret('OPENAI_API_KEY') ? 'set' : 'not set'}, MESHY_API_KEY ${secret('MESHY_API_KEY') ? 'set' : 'not set'}, TRIPO_API_KEY ${secret('TRIPO_API_KEY') ? 'set' : 'not set'}`,
          `Image spend: USD ${s.workspace.toFixed(4)} of ${b.workspace.toFixed(2)} in this workspace, ${s.project.toFixed(4)} of ${b.project.toFixed(2)} in this project${Number.isFinite(b.total) ? `, ${s.total.toFixed(4)} of ${b.total.toFixed(2)} in all` : ''}; text-to-3D tasks ${s.tasks3d} of ${b.tasks3d}.`,
        ].join('\n');
      }
      if (a === 'spend') {
        const all = (await ledger.entries()).filter((e) => e.workspace === host.root);
        return all.length ? all.map((e) => `${e.at} ${e.provider} ${e.model ?? ''} ${e.kind} ${e.usd !== undefined && e.usd !== null ? `USD ${e.usd.toFixed(4)}` : ''} ${e.asset ?? ''}`).join('\n') : 'No paid generation in this workspace yet.';
      }
      if (a === 'search' || a === 'download') {
        const src = LIBRARIES[input.source];
        if (!src) throw new Error(`source must be one of ${Object.keys(LIBRARIES).join(', ')} for ${a}`);
        if (!on.includes(src.id)) return off(src.id);
        if (a === 'search') {
          const res = await src.search(api.fetch, { query: input.query, type: input.type, limit: int(input.limit, 20, 1, 100) });
          return { content: res.length ? `${src.name} (${src.license}):\n${res.map((r) => `${r.id}: ${r.name}${r.tags?.length ? ` [${r.tags.slice(0, 8).join(', ')}]` : ''}${r.downloads ? ` downloads ${r.downloads.slice(0, 6).join(' ')}` : ''}`).join('\n')}` : `Nothing in ${src.name} for "${input.query ?? ''}".`, untrusted: true };
        }
        if (!input.id) throw new Error('download needs id (from search)');
        const d = await src.download(api.fetch, { id: String(input.id), resolution: input.resolution, format: input.format, include: input.include });
        const assetId = input.assetId ?? slug(`${src.id}-${input.id}`);
        const r = await save(ctx, { ...input, id: assetId }, { id: assetId, name: d.name, kind: d.kind, dimension: d.kind === 'model' || d.kind === 'material' ? '3d' : '2d', files: d.files, license: d.license, source: d.source, tags: [...(d.tags ?? []).slice(0, 12), src.id], meta: d.meta });
        const lines = [...r.lines, `Licence ${d.license.id} (${d.license.author}), from ${d.source.url}.`];
        if (input.library) { const p = await publishAsset(host, project, assetId, { overwrite: true }, signal); lines.push(`Published to the shared library: ${p.to}`); }
        const img = d.files.find((f) => /\.png$/i.test(f.path));
        let images = [];
        try { if (img) images = [preview(decodePNG(img.data), { max: 512 })]; } catch { /* a PNG this reader does not decode */ }
        return { content: lines.join('\n'), images, untrusted: true };
      }
      if (a === 'image') {
        if (!on.includes('openai')) return off('openai');
        const key = secret('OPENAI_API_KEY');
        if (!key) return { content: 'OPENAI_API_KEY is not set on the server (declared in permissions.secrets).', is_error: true };
        if (!input.prompt) throw new Error('image needs a prompt');
        const model = String(input.model ?? 'gpt-image-1');
        const size = String(input.size ?? '1024x1024');
        if (!['1024x1024', '1024x1536', '1536x1024'].includes(size)) throw new Error('size is 1024x1024, 1024x1536 or 1536x1024');
        const quality = String(input.quality ?? 'low');
        const purpose = String(input.purpose ?? 'texture');
        const prompt = purpose === 'sprite' ? `${input.prompt}. A single game sprite, centred, whole subject visible, flat transparent background, crisp edges, no text.` : purpose === 'texture' ? `${input.prompt}. A seamless, evenly lit, top-down texture filling the whole frame, no objects, no text, no shadows from a light direction.` : String(input.prompt);
        const est = estimateImageUsd({ model, quality, size, prompt });
        if (est === null) throw new Error(`no price known for ${model}: set HARNESS_STUDIO_IMAGE_PRICES={"${model}":{"text":..,"imageIn":..,"out":..}} (USD per million tokens) so its cost can be checked`);
        await ledger.check(host.root, project, est);
        const res = await openaiImage(api.fetch, key, { prompt, model, size, quality, background: purpose === 'sprite' ? 'transparent' : 'opaque' });
        const usd = res.usd ?? est;
        const assetId = input.assetId ?? input.id ?? slug(`gen-${purpose}-${String(input.prompt).slice(0, 30)}`);
        await ledger.add({ workspace: host.root, project, provider: 'openai', model, kind: 'image', usd, estimated: est, usage: res.usage, asset: assetId, quality, size });
        ctx.services?.charge?.(`openai ${model} image`, usd);
        let img = decodePNG(res.png);
        const raw = img;
        const files = [{ path: 'generated.png', role: 'original', data: res.png }];
        const ops = [];
        let kind = 'texture';
        if (purpose === 'sprite') {
          kind = 'sprite';
          const transparent = img.alpha(0, 0) < 16 && img.alpha(img.width - 1, img.height - 1) < 16;
          if (!transparent) ops.push({ op: 'colorKey', color: 'auto', tolerance: 48, feather: 1 });
          ops.push({ op: 'trim', threshold: 24, pad: 2 }, { op: 'square', bottom: true });
          const s = int(input.spriteSize, 64, 8, 1024);
          ops.push({ op: 'resize', width: s, height: s, method: 'bilinear' }, { op: 'hardAlpha', threshold: 110 });
          if (input.palette || input.colors) ops.push({ op: 'quantize', palette: input.palette, colors: input.colors ?? 24 });
          ops.push({ op: 'outline', color: 'auto' });
          if (input.cols || input.rows) ops.splice(0, ops.length, ...[!transparent && { op: 'colorKey', color: 'auto', tolerance: 48 }].filter(Boolean), { op: 'resize', width: int(input.cols, 1, 1, 64) * s, height: int(input.rows, 1, 1, 64) * s }, { op: 'hardAlpha' }, { op: 'slice', cols: int(input.cols, 1, 1, 64), rows: int(input.rows, 1, 1, 64) });
        } else if (purpose === 'texture') {
          const t = int(input.textureSize, 512, 16, 4096);
          ops.push({ op: 'resize', width: t, height: t, method: 'bilinear' });
          if (input.tileable !== false) ops.push({ op: 'tileable' });
        } else kind = 'texture';
        const r = applyOps(img, ops);
        img = r.img;
        files.unshift({ path: purpose === 'sprite' ? 'sprite.png' : 'texture.png', role: 'main', data: encodePNG(img) });
        r.extra.forEach((f, i) => files.push({ path: `frame_${String(i).padStart(2, '0')}.png`, role: 'frame', data: encodePNG(f) }));
        if (purpose === 'texture' && input.normal) files.push({ path: 'normal.png', role: 'normal', data: encodePNG(normalMap(img.heights(), img.width, img.height, { strength: 3 })) });
        if (purpose === 'concept') files.splice(0, 1);
        const saved = await save(ctx, { ...input, id: assetId }, {
          id: assetId, name: String(input.prompt).slice(0, 60), kind: purpose === 'concept' ? 'texture' : kind, dimension: '2d',
          files: purpose === 'concept' ? [{ path: 'concept.png', role: 'main', data: res.png }] : files,
          license: { id: 'LicenseRef-OpenAI-Terms', author: 'generated with OpenAI (output owned by the user under OpenAI\'s terms)', url: 'https://openai.com/policies/terms-of-use' },
          source: { type: 'generated', provider: 'openai', model, prompt: input.prompt, sentPrompt: prompt, ...(res.revisedPrompt ? { revisedPrompt: res.revisedPrompt } : {}), quality, size, costUsd: Math.round(usd * 1e6) / 1e6, estimatedUsd: Math.round(est * 1e6) / 1e6, usage: res.usage, postprocess: ops },
          meta: { size: [img.width, img.height], ...(purpose === 'sprite' ? { frameSize: r.extra.length ? [r.extra[0].width, r.extra[0].height] : [img.width, img.height], frames: r.extra.length || 1 } : {}), ...(purpose === 'texture' ? { tileable: input.tileable !== false } : {}) },
          tags: ['generated', purpose],
        });
        const s = await ledger.spent(host.root, project);
        return { content: `${saved.lines.join('\n')}\nCost USD ${usd.toFixed(4)} (estimated ${est.toFixed(4)}; usage ${JSON.stringify(res.usage ?? {})}). Spent in this project: USD ${s.project.toFixed(4)} of ${budgets().project.toFixed(2)}.`, images: [preview(raw, { max: 384 }), preview(img, { max: 512 })] };
      }
      if (a === 'text3d') {
        const prov = TEXT3D[input.provider ?? 'meshy'];
        if (!prov) throw new Error('provider is meshy or tripo');
        if (!on.includes(prov.id)) return off(prov.id);
        const key = secret(prov.secret);
        if (!key) return { content: `${prov.secret} is not set on the server.`, is_error: true };
        let task = input.task ? String(input.task) : null;
        if (!task) {
          if (!input.prompt) throw new Error('text3d needs a prompt (or task to resume)');
          const s = await ledger.spent(host.root, project);
          if (s.tasks3d >= budgets().tasks3d) throw new Error(`text-to-3D refused: this workspace has made ${s.tasks3d} of its ${budgets().tasks3d} tasks (HARNESS_STUDIO_3D_TASKS raises it)`);
          task = await prov.start(api.fetch, key, { prompt: String(input.prompt), artStyle: input.artStyle, targetPolycount: int(input.maxTriangles, 10000, 500, 100000), faceLimit: int(input.maxTriangles, 10000, 500, 100000) });
          await ledger.add({ workspace: host.root, project, provider: prov.id, kind: 'text3d', task, prompt: input.prompt });
        }
        const st = await waitTask(prov, api.fetch, key, task, { waitSec: num(input.wait, 600, 0, 1800), signal });
        if (st.status === 'failed') return { content: `${prov.id} task ${task} failed: ${st.error ?? 'no reason given'}`, is_error: true };
        if (st.status !== 'done') return `${prov.id} task ${task} is still running (${st.progress}%). Call again with {"action":"text3d","provider":"${prov.id}","task":"${task}"} to wait for it.`;
        if (!st.modelUrl) throw new Error(`${prov.id} finished task ${task} without a model URL`);
        const r = await api.fetch(st.modelUrl);
        if (!r.ok) throw new Error(`downloading the model answered ${r.status}`);
        const glb = Buffer.from(await r.arrayBuffer());
        const tmp = `.harness/studio/text3d-${slug(task)}.glb`;
        await writeIn(host, tmp, glb, signal);
        const assetId = input.assetId ?? slug(`gen3d-${String(input.prompt ?? task).slice(0, 30)}`);
        const source = { type: 'generated', provider: prov.id, task, prompt: input.prompt, url: st.modelUrl, cleaned: 'studio_model cleanup' };
        try {
          const out = await modelTool.run({ action: 'cleanup', file: tmp, targetHeight: input.targetHeight ?? 1, maxTriangles: int(input.maxTriangles, 10000, 500, 100000), id: assetId, project: input.project, license: prov.license, source, tags: ['generated', prov.id, ...[].concat(input.tags ?? [])], export: input.export }, ctx);
          if (/Blender is not installed/.test(out.content)) {
            const saved = await save(ctx, { ...input, id: assetId }, { id: assetId, name: String(input.prompt ?? task).slice(0, 60), kind: 'model', dimension: '3d', files: [{ path: 'model.glb', role: 'main', data: glb }], license: prov.license, source: { ...source, cleaned: 'not cleaned: Blender missing' }, tags: ['generated', prov.id, 'raw'] });
            return { content: `${saved.lines.join('\n')}\nSaved the raw model: Blender is not here to clean it (scale, origin, normals, triangle budget). Run the asset-3d and asset-budget gates before using it.`, is_error: false };
          }
          return out;
        } finally { await removeIn(host, tmp, signal).catch(() => {}); }
      }
      return unknownAction('studio_source', a, ACTIONS);
    }),
  };
}

