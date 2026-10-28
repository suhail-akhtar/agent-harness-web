// Studio's game templates (registered by ../index.mjs with the production gates, ./gates.mjs).
//   studio_template  list | info | create (a web template into the workspace, with its Studio
//                    assets built by the studio_* builders) | build (a web build: build/web/ and a zip)
// Gates: studio-project (.studio/project.json and the design document), asset-plan (every asset
// the plan names exists), web-game (game.json's assets and levels resolve and levels are
// finishable), web-build (the build boots offline from its own folder).
// The web templates live in web/<id>/ (index.html, game.json, src/main.js, template.json) and
// share web/engine/ (loop, scenes, input map, assets, sound, drawing, platformer physics, 3D kit).
// Godot, Unreal and Unity projects start from their engine plugin's own templates.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextIn, relIn, writeIn } from '../lib-engines.mjs';
import { imageTool, spriteTool } from '../assets/tools-2d.mjs';
import { audioTool } from '../assets/tools-audio.mjs';
import { modelTool } from '../assets/tools-model.mjs';
import { procgenTool } from '../assets/tools-procgen.mjs';
import { writeZip } from './zip.mjs';
import { playableDir, playUrl } from '../lib-play.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_DIR = path.join(here, 'web');
const BUILDERS = { studio_sprite: spriteTool, studio_procgen: procgenTool, studio_audio: audioTool, studio_image: imageTool, studio_model: modelTool };
const join = (...p) => path.posix.join(...p.filter((x) => x && x !== '.'));

/** Every web template's template.json. */
export async function listTemplates() {
  const out = [];
  for (const d of (await fsp.readdir(WEB_DIR, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== 'engine')) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(WEB_DIR, d.name, 'template.json'), 'utf8'))); } catch { /* not a template */ }
  }
  return out.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
}
const ORDER = ['platformer-2d', 'topdown-2d', 'puzzle-2d', 'iso-2.5d', 'sidescroller-2.5d', 'thirdperson-3d', 'firstperson-3d'];
const ALIASES = { platformer: 'platformer-2d', topdown: 'topdown-2d', 'top-down': 'topdown-2d', puzzle: 'puzzle-2d', grid: 'puzzle-2d', iso: 'iso-2.5d', isometric: 'iso-2.5d', sidescroller: 'sidescroller-2.5d', 'side-scroller': 'sidescroller-2.5d', thirdperson: 'thirdperson-3d', 'third-person': 'thirdperson-3d', firstperson: 'firstperson-3d', 'first-person': 'firstperson-3d', fps: 'firstperson-3d' };

async function files(dir, rel = '') {
  const out = [];
  for (const e of await fsp.readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await files(dir, r));
    else out.push(r);
  }
  return out;
}

/** Writes .studio/project.json for a web game, or fills the web fields of an existing one. */
async function studioProject(host, project, t, name, signal) {
  const rel = join(project, '.studio', 'project.json');
  const text = await readTextIn(host, rel, signal);
  let p = {};
  try { p = text ? JSON.parse(text) : {}; } catch { p = {}; }
  const now = new Date().toISOString();
  const next = {
    name: p.name ?? name, engine: p.engine ?? 'web', dimension: p.dimension ?? t.dimension, genre: p.genre || t.genre, created: p.created ?? now,
    ...p,
    template: t.id, entry: 'index.html', engineProject: p.engineProject ?? 'index.html', design: p.design ?? 'design/GDD.md',
    budgets: { fps: 60, frameMs: 16.7, memoryMb: 512, trianglesPerAsset: t.dimension === '3d' ? 20000 : 5000, textureMax: 2048, ...(p.budgets ?? {}) },
    stages: p.stages ?? [], builds: p.builds ?? [], playtests: p.playtests ?? [],
  };
  if (next.engine !== 'web') next.engine = 'web';
  await writeIn(host, rel, `${JSON.stringify(next, null, 2)}\n`, signal);
  return rel;
}

async function create(input, ctx) {
  const { host, signal } = ctx;
  const want = String(input.template ?? '').toLowerCase();
  const list = await listTemplates();
  const t = list.find((x) => x.id === (ALIASES[want] ?? want));
  if (!t) return { content: `studio_template: no template "${input.template}". Templates: ${list.map((x) => `${x.id} (${x.name})`).join(', ')}.`, is_error: true };
  const project = await relIn(host, String(input.project ?? '.'));
  if (!input.overwrite && await readTextIn(host, join(project, 'game.json'), signal) !== null) return { content: `${join(project, 'game.json')} exists already: the template was not copied over it (overwrite: true replaces index.html, game.json and src/).`, is_error: true };
  const written = [];
  const src = path.join(WEB_DIR, t.id);
  for (const f of await files(src)) {
    if (f === 'template.json') continue;
    let data = await fsp.readFile(path.join(src, f));
    if (f === 'game.json' && input.title) { const j = JSON.parse(data.toString('utf8')); j.title = String(input.title); data = Buffer.from(`${JSON.stringify(j, null, 2)}\n`); }
    await writeIn(host, join(project, f), data, signal);
    written.push(join(project, f));
  }
  for (const f of await files(path.join(WEB_DIR, 'engine'))) {
    await writeIn(host, join(project, 'src', 'engine', f), await fsp.readFile(path.join(WEB_DIR, 'engine', f)), signal);
    written.push(join(project, 'src', 'engine', f));
  }
  const notes = [];
  if (t.three) {
    if (host.kind === 'companion') notes.push('Three.js is needed: add it with add_library {"name": "three"} (vendor/three).');
    else {
      const { addLibrary } = await import('@harness/plugins/visual/lib/libraries.mjs');
      const lib = await addLibrary(path.join(host.root, project), 'three');
      notes.push(`Three.js ${lib.version} vendored in ${join(project, 'vendor/three')} (offline).`);
    }
  }
  written.push(await studioProject(host, project, t, String(input.title ?? input.name ?? t.name), signal));
  const built = [], kept = [], failed = [];
  if (input.assets !== false) {
    for (const a of t.assets ?? []) {
      if (!input.overwrite && await readTextIn(host, join(project, '.studio', 'assets', a.id, 'asset.json'), signal) !== null) { kept.push(a.id); continue; }
      const tool = BUILDERS[a.tool];
      if (!tool) { failed.push(`${a.id}: no builder ${a.tool}`); continue; }
      const r = await tool.run({ ...a.input, id: a.id, project }, ctx);
      if (r?.is_error) failed.push(`${a.id}: ${String(r.content).split('\n')[0]}`); else built.push(a.id);
    }
  }
  const lines = [
    `Created a ${t.name} (${t.id}, ${t.dimension}) in ${project === '.' ? 'the workspace' : project}: ${written.length} files.`,
    t.description,
    ...notes,
    input.assets === false ? 'Assets: not built (assets: false); game.json names them, so build them with the studio_* tools under those ids, or the game draws its fallbacks.' : `Assets built with the Studio builders: ${built.join(', ') || 'none'}${kept.length ? `; already there: ${kept.join(', ')}` : ''}${failed.length ? `; FAILED: ${failed.join('; ')}` : ''}.`,
    'Edit game.json (title, controls, assets, levels, tuning) and src/main.js (the gameplay). The engine is in src/engine/ (shared; change it only for engine-level needs).',
    `Prove it: game_bot {"mode": "goal", "seconds": 120} (it should reach "${t.goal}"), then game_playtest {"goal": "${t.goal}"}; gates: web-game, game-starts, no-softlock, playtest-pass.`,
    'Package it: studio_template {"action": "build"} (build/web/ and a zip, recorded in .studio/project.json builds).',
  ];
  return { content: lines.join('\n'), is_error: failed.length > 0 };
}

/** Every "asset:<id>" a game.json names (in assets, levels and anywhere else). */
export function assetRefs(v, out = new Set()) {
  if (typeof v === 'string') { if (v.startsWith('asset:')) out.add(v.slice(6)); }
  else if (Array.isArray(v)) v.forEach((x) => assetRefs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => assetRefs(x, out));
  return out;
}

const SKIP_BUILD = new Set(['build', '.studio', '.harness', '.git', 'node_modules', 'design', 'docs', '.godot']);

/** A web build: the game's files and the assets it names, in build/web; a zip beside it; recorded in project.json. */
export async function buildWeb(host, project, { out = 'build/web', zip = true, name } = {}, signal) {
  if (host.kind === 'companion') throw new Error('build copies files on the server: in a companion session copy index.html, game.json, src/, vendor/ and the .studio/assets folders game.json names yourself');
  const root = path.join(host.root, project);
  const cfgText = await readTextIn(host, join(project, 'game.json'), signal);
  if (cfgText === null) throw new Error(`no game.json in ${project}: build packages a Studio web game (studio_template create makes one)`);
  const cfg = JSON.parse(cfgText);
  const outRel = join(project, out);
  const outAbs = path.join(host.root, outRel);
  await fsp.rm(outAbs, { recursive: true, force: true });
  const entries = [];
  const copy = async (rel) => {
    const data = await fsp.readFile(path.join(root, rel));
    await fsp.mkdir(path.dirname(path.join(outAbs, rel)), { recursive: true });
    await fsp.writeFile(path.join(outAbs, rel), data);
    entries.push({ name: rel, data });
  };
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    if (SKIP_BUILD.has(e.name) || e.name.startsWith('.') || /\.(md|zip)$/i.test(e.name) || e.name === 'playtest.json') continue;
    if (e.isDirectory()) { for (const f of await files(root, e.name)) await copy(f); } else await copy(e.name);
  }
  const ids = [...assetRefs(cfg)];
  const missing = [];
  for (const id of ids) {
    const dir = `.studio/assets/${id}`;
    try { for (const f of await files(root, dir)) await copy(f); } catch { missing.push(id); }
  }
  const info = { builtAt: new Date().toISOString(), title: cfg.title, template: cfg.template, assets: ids, missing, files: entries.length };
  await fsp.writeFile(path.join(outAbs, 'build.json'), `${JSON.stringify(info, null, 1)}\n`);
  entries.push({ name: 'build.json', data: Buffer.from(JSON.stringify(info)) });
  let zipRel = null, bytes = entries.reduce((a, e) => a + e.data.length, 0);
  if (zip) {
    const slug = String(name ?? cfg.title ?? 'game').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
    zipRel = join(path.posix.dirname(outRel), `${slug}-web.zip`);
    const z = await writeZip(path.join(host.root, zipRel), entries);
    bytes = z.bytes;
  }
  // Recorded where Studio's Builds page and the gates look.
  const pj = join(project, '.studio', 'project.json');
  const text = await readTextIn(host, pj, signal);
  let id = null;
  if (text !== null) {
    try {
      const p = JSON.parse(text);
      id = `b${(p.builds?.length ?? 0) + 1}`;
      p.builds = [...(Array.isArray(p.builds) ? p.builds : []), { id, platform: 'web', engine: 'web', path: join(out, 'index.html'), zip: zipRel ? path.posix.relative(project === '.' ? '' : project, zipRel) : null, status: missing.length ? 'failed' : 'ok', at: info.builtAt, files: entries.length, bytes }];
      await writeIn(host, pj, `${JSON.stringify(p, null, 2)}\n`, signal);
    } catch { /* not ours to fix */ }
  }
  return { out: outRel, zip: zipRel, files: entries.length, bytes, assets: ids, missing, id };
}

export const templateTool = {
  name: 'studio_template',
  // Local only (files in the workspace and the library): never sends what it is given anywhere, so the taint guard need not ask.
  sendsOut: false,
  description: 'Studio\'s web game templates, ready to fill: "list" them, "info" one (its files, game.json fields, the window.__game hook, the assets it builds), "create" one in the workspace (template: platformer-2d, topdown-2d, puzzle-2d, iso-2.5d, sidescroller-2.5d, thirdperson-3d or firstperson-3d; it copies index.html, game.json and src/ with the shared engine, vendors Three.js for 2.5D/3D, writes .studio/project.json, and builds the template\'s Studio assets with studio_sprite/studio_procgen/studio_audio unless assets: false), "build" a web build (build/web/ with only the assets game.json names, a zip, recorded in .studio/project.json builds). Every template has a title, play, pause, win and game-over state machine, an input map, assets loaded from .studio/assets, and the window.__game hook the AI player and bots read. Godot, Unreal and Unity projects start from their engine tools (godot project.create).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'info', 'create', 'build', 'play'], description: 'What to do: list, info, create, build, or play (a link that plays the game in a browser) (default list)' },
      template: { type: 'string', description: 'create/info: the template id' },
      project: { type: 'string', description: 'The game folder (default the workspace root)' },
      title: { type: 'string', description: 'create: the game\'s title (game.json and project.json)' },
      assets: { type: 'boolean', description: 'create: build the template\'s default Studio assets (default true)' },
      overwrite: { type: 'boolean', description: 'create: replace an existing game.json, index.html, src/ and the default assets' },
      out: { type: 'string', description: 'build: the output folder (default build/web)' }, zip: { type: 'boolean', description: 'build: also a zip (default true)' },
    },
    required: ['action'],
  },
  kind: 'edit',
  summarize: (i) => `${i.action} ${i.template ?? ''}`.trim(),
  async run(input, ctx) {
    const a = String(input.action ?? 'list');
    try {
      if (a === 'list') return (await listTemplates()).map((t) => `${t.id}: ${t.name} (${t.dimension}${t.three ? ', Three.js' : ', Canvas 2D'}) - ${t.description}`).join('\n');
      if (a === 'info') {
        const t = (await listTemplates()).find((x) => x.id === (ALIASES[String(input.template).toLowerCase()] ?? input.template));
        if (!t) return { content: `no template "${input.template}"`, is_error: true };
        const cfg = await fsp.readFile(path.join(WEB_DIR, t.id, 'game.json'), 'utf8');
        return [`${t.id}: ${t.name} (${t.dimension}, ${t.genre})`, t.description, `Goal for the bots: ${t.goal}`, `Files: index.html, game.json, src/main.js (gameplay), src/engine/* (shared engine)${t.three ? ', vendor/three' : ''}.`, `Assets it builds: ${t.assets.map((x) => `${x.id} (${x.tool} ${x.input.action}${x.input.kind ? ` ${x.input.kind}` : ''})`).join(', ')}.`, `game.json:\n${cfg}`, `window.__game: state (loading, title, play, paused, won, gameover), player {x, y${t.dimension === '2d' ? '' : ', z'}}, score, lives, coins/total or collected, targets (where to head next), exitOpen, won, lost, level/levels, flags, events, inputs, controls.`].join('\n');
      }
      if (a === 'create') return create(input, ctx);
      if (a === 'build') {
        const project = await relIn(ctx.host, String(input.project ?? '.'));
        const b = await buildWeb(ctx.host, project, { out: input.out ? String(input.out) : undefined, zip: input.zip !== false }, ctx.signal);
        return { content: `Web build ${b.id ?? ''} in ${b.out}/: ${b.files} files, ${(b.bytes / 1048576).toFixed(2)} MB${b.zip ? `, packaged as ${b.zip}` : ''}; assets: ${b.assets.join(', ') || 'none'}${b.missing.length ? `; MISSING: ${b.missing.join(', ')} (build them, or fix game.json)` : ''}. To let the person play it: studio_template {"action": "play"} gives a link (never a file:// path or index.html to double-click: browsers refuse a module game from the disk); the web-build gate boots it offline.`, is_error: b.missing.length > 0 };
      }
      if (a === 'play') {
        // Served from this computer: a link the person opens (a file:// page cannot load the game's modules and data).
        if (ctx.host.kind === 'companion') return { content: "studio_template play: the game is on the companion's computer: serve its build folder there (npx http-server build/web) and open the address it prints.", is_error: true };
        const project = await relIn(ctx.host, String(input.project ?? '.'));
        const dir = playableDir(path.join(ctx.host.root, project));
        if (!dir) return { content: `studio_template play: no index.html in ${project}/build/web or ${project}: build the game first ({"action": "build"}).`, is_error: true };
        const url = await playUrl(dir);
        return `Play it at ${url} (served from ${path.relative(ctx.host.root, dir).split(path.sep).join('/') || '.'} on this computer only; open again for a fresh link after two hours). Give the person this link, not a file path: a web game does not run from file://.`;
      }
      return { content: `studio_template: unknown action ${a} (list, info, create, build, play)`, is_error: true };
    } catch (e) { return { content: `studio_template ${a}: ${e.message}`, is_error: true }; }
  },
};
