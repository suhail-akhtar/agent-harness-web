// The production gates: what proves each stage of make-game is done before the next starts.
//   studio-project  .studio/project.json is well formed (FORMATS.md) and the design document has
//                   the sections a team builds from (pitch, core loop, controls, rules/win-lose, scope)
//   asset-plan      every asset design/asset-plan.json names exists in .studio/assets with its kind
//   web-game        a web game's game.json resolves: every asset it names exists with its main file,
//                   every level is finishable (the platformer solver, or a start-to-exit path)
//   web-build       the web build (build/web) has what it names and boots offline from its own folder

import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkConnected } from '../assets/gen/levels.mjs';
import { solvePlatformer } from '../assets/gen/platformer.mjs';

const exists = (f) => fsp.stat(f).then(() => true, () => false);
const readJson = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
export const ENGINES = ['web', 'godot', 'unreal', 'unity', 'blender'];
export const DIMENSIONS = ['2d', '2.5d', '3d'];
export const STAGE_STATUS = ['pending', 'active', 'review', 'done', 'approved', 'changes-requested', 'failed', 'skipped'];

/** The design document's sections a team needs, each with the headings that count for it. */
export const GDD_SECTIONS = [
  { name: 'Pitch', re: /pitch|concept|overview|elevator/i },
  { name: 'Core loop', re: /core loop|gameplay loop|loop/i },
  { name: 'Controls', re: /controls|input/i },
  { name: 'Rules (win and lose)', re: /rules|win|lose|goal|objective/i },
  { name: 'Scope', re: /scope|milestone|cut|first version/i },
];
export const GDD_ADVISED = [
  { name: 'Mechanics', re: /mechanic/i }, { name: 'Levels', re: /level|world|map/i }, { name: 'Art direction', re: /art|style|visual|palette/i },
  { name: 'Audio', re: /audio|sound|music/i }, { name: 'UI', re: /\bui\b|hud|menu|screen/i }, { name: 'Balancing', re: /balanc|difficult|tuning|economy/i },
];

/** Problems with a project.json (FORMATS.md) as a list. */
export function projectProblems(p) {
  const bad = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not a JSON object'];
  if (typeof p.name !== 'string' || !p.name.trim()) bad.push('name: a string');
  if (!ENGINES.includes(p.engine)) bad.push(`engine: one of ${ENGINES.join(', ')} (got ${JSON.stringify(p.engine)})`);
  if (p.dimension !== undefined && !DIMENSIONS.includes(p.dimension)) bad.push(`dimension: one of ${DIMENSIONS.join(', ')}`);
  if (p.budgets !== undefined && (typeof p.budgets !== 'object' || Object.values(p.budgets).some((v) => typeof v !== 'number'))) bad.push('budgets: numbers (fps, frameMs, memoryMb, trianglesPerAsset, textureMax)');
  if (p.stages !== undefined) {
    if (!Array.isArray(p.stages)) bad.push('stages: a list');
    else for (const s of p.stages) if (!s || typeof s.id !== 'string' || (s.status !== undefined && !STAGE_STATUS.includes(s.status))) bad.push(`stages: {id, status: ${STAGE_STATUS.join('|')}} (got ${JSON.stringify(s).slice(0, 80)})`);
  }
  if (p.builds !== undefined && (!Array.isArray(p.builds) || p.builds.some((b) => !b || typeof b.platform !== 'string'))) bad.push('builds: [{id, platform, path, status, at}]');
  if (p.playtests !== undefined && (!Array.isArray(p.playtests) || p.playtests.some((x) => typeof x !== 'string'))) bad.push('playtests: [ids]');
  return bad;
}

/** The headings of a markdown document. */
export const headings = (md) => [...String(md).matchAll(/^#{1,4}\s+(.+?)\s*#*\s*$/gm)].map((m) => m[1]);

/** The levels and the "asset:<id>" names in a game.json. */
function refsOf(v, out = []) {
  if (typeof v === 'string') { if (v.startsWith('asset:')) out.push(v.slice(6)); }
  else if (Array.isArray(v)) v.forEach((x) => refsOf(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => refsOf(x, out));
  return out;
}

/** Whether a level (level.json) can be finished: { ok, note } or { ok: false, reason }. */
export function levelFinishable(lv) {
  if (!Array.isArray(lv?.rows)) return { ok: false, reason: 'no rows' };
  if (lv.type === 'platformer') {
    const r = solvePlatformer(lv.rows, lv.physics ?? {});
    return r.ok ? { ok: true, note: `solved in ${r.steps} moves, ${r.coinsReached}/${r.coins} coins reachable` } : { ok: false, reason: r.reason };
  }
  if (!lv.rows.some((r) => r.includes('S'))) return { ok: true, note: 'no start marked (a map)' };
  const r = checkConnected(lv.rows, lv.type);
  return r.ok ? { ok: true, note: `start to exit in ${r.pathLength} steps` } : { ok: false, reason: r.reason };
}

/** Checks the assets a game.json names inside a folder (the project, or a build): problems and notes. */
export async function checkGameAssets(root, cfg) {
  const problems = [], notes = [];
  for (const id of [...new Set(refsOf(cfg))]) {
    const dir = path.join(root, '.studio', 'assets', id);
    let m;
    try { m = await readJson(path.join(dir, 'asset.json')); } catch { problems.push(`asset:${id}: no .studio/assets/${id}/asset.json (build it with a studio_* tool under that id, or change game.json)`); continue; }
    const main = m.files?.find((f) => f.role === 'main') ?? m.files?.[0];
    if (!main || !(await exists(path.join(dir, main.path)))) { problems.push(`asset:${id}: its main file ${main?.path ?? '(none listed)'} is missing`); continue; }
    if (m.kind === 'spritesheet' && !m.files.some((f) => /\.json$/.test(f.path))) problems.push(`asset:${id}: a sprite sheet without its frames JSON`);
    if (m.kind === 'level') {
      const lf = m.files.find((f) => f.role === 'level') ?? m.files.find((f) => f.path === 'level.json');
      if (lf) {
        try {
          const r = levelFinishable(await readJson(path.join(dir, lf.path)));
          if (r.ok) notes.push(`asset:${id}: ${r.note}`); else problems.push(`asset:${id}: the level cannot be finished: ${r.reason}`);
        } catch (e) { problems.push(`asset:${id}: ${e.message}`); }
      }
    }
  }
  return { problems, notes };
}

export function registerProductionGates(api) {
  api.registerGate({
    name: 'studio-project',
    description: 'The Studio project is set up: .studio/project.json is well formed (name, engine, dimension, budgets, stages, builds as in FORMATS.md) and its design document (design/GDD.md by default) exists with a pitch, the core loop, controls, the rules (win and lose) and the scope.',
    applies: async (host) => host.kind !== 'companion' && exists(path.join(host.root, '.studio', 'project.json')),
    async run({ host }) {
      if (host.kind === 'companion') return { pass: false, severity: 'advisory', summary: 'not checked: the files are on the companion\'s computer' };
      const f = path.join(host.root, '.studio', 'project.json');
      let p;
      try { p = await readJson(f); } catch (e) { return { pass: false, summary: `.studio/project.json ${(await exists(f)) ? `is not valid JSON (${e.message})` : 'is missing'}`, details: 'Write it as plugins/games3d/sdk/FORMATS.md describes: {"name", "engine", "dimension", "genre", "design": "design/GDD.md", "budgets", "stages", "builds", "playtests"}.' }; }
      const bad = projectProblems(p).map((x) => `project.json ${x}`);
      const design = String(p.design ?? 'design/GDD.md');
      const md = await fsp.readFile(path.join(host.root, design), 'utf8').catch(() => null);
      const advice = [];
      if (md === null) bad.push(`the design document ${design} is missing`);
      else {
        const hs = headings(md);
        for (const s of GDD_SECTIONS) if (!hs.some((h) => s.re.test(h))) bad.push(`${design} has no "${s.name}" section (a heading)`);
        for (const s of GDD_ADVISED) if (!hs.some((h) => s.re.test(h))) advice.push(s.name);
        if (md.trim().length < 300) bad.push(`${design} is too short to build from (${md.trim().length} characters)`);
      }
      return bad.length
        ? { pass: false, summary: `the project is not set up: ${bad[0]}`, details: `${bad.join('\n')}${advice.length ? `\nAlso advised: ${advice.join(', ')}` : ''}` }
        : { pass: true, summary: `${p.name}: ${p.engine} ${p.dimension ?? ''} ${p.genre ?? ''}; ${design} has every section${advice.length ? ` (advised, missing: ${advice.join(', ')})` : ''}; ${p.stages?.length ?? 0} stage(s)` };
    },
  });

  api.registerGate({
    name: 'asset-plan',
    description: 'Every asset the asset plan (design/asset-plan.json: {"assets": [{"id", "kind", ...}]}) names exists in .studio/assets with that kind and a licence, so the art made matches the art planned.',
    applies: async (host) => host.kind !== 'companion' && exists(path.join(host.root, 'design', 'asset-plan.json')),
    async run({ host }) {
      let plan;
      try { plan = await readJson(path.join(host.root, 'design', 'asset-plan.json')); } catch (e) { return { pass: false, summary: `design/asset-plan.json: ${e.code === 'ENOENT' ? 'missing' : e.message}`, details: 'Write {"style": "...", "assets": [{"id": "hero-sheet", "kind": "spritesheet", "tool": "studio_sprite", "input": {...}, "purpose": "the player"}]}.' }; }
      const list = Array.isArray(plan) ? plan : plan.assets;
      if (!Array.isArray(list) || !list.length) return { pass: false, summary: 'design/asset-plan.json lists no assets' };
      const bad = [], ok = [];
      for (const a of list) {
        if (!a?.id) { bad.push(`an entry without an id: ${JSON.stringify(a).slice(0, 80)}`); continue; }
        let m;
        try { m = await readJson(path.join(host.root, '.studio', 'assets', a.id, 'asset.json')); } catch { bad.push(`${a.id}: not made yet (.studio/assets/${a.id}/asset.json)`); continue; }
        if (a.kind && m.kind !== a.kind) bad.push(`${a.id}: planned as ${a.kind}, made as ${m.kind}`);
        else if (!m.license?.id) bad.push(`${a.id}: no licence recorded`);
        else ok.push(a.id);
      }
      return bad.length ? { pass: false, summary: `${bad.length} of ${list.length} planned asset(s) are not right`, details: bad.join('\n') } : { pass: true, summary: `all ${list.length} planned asset(s) made: ${ok.join(', ')}` };
    },
  });

  api.registerGate({
    name: 'web-game',
    description: 'A Studio web game (game.json beside index.html) is wired: game.json parses, every "asset:<id>" it names exists with its main file (sprite sheets with their frames JSON), every level can be finished (the platformer solver with the level\'s physics, or a start-to-exit path), and src/main.js exists.',
    applies: async (host) => host.kind !== 'companion' && await exists(path.join(host.root, 'game.json')) && exists(path.join(host.root, 'index.html')),
    async run({ host }) {
      let cfg;
      try { cfg = await readJson(path.join(host.root, 'game.json')); } catch (e) { return { pass: false, summary: `game.json: ${e.message}` }; }
      const { problems, notes } = await checkGameAssets(host.root, cfg);
      if (!(await exists(path.join(host.root, 'src', 'main.js')))) problems.push('src/main.js is missing (the gameplay module index.html loads)');
      const html = await fsp.readFile(path.join(host.root, 'index.html'), 'utf8').catch(() => '');
      if (!/<script[^>]+type="module"/.test(html)) problems.push('index.html loads no module script');
      if (!Array.isArray(cfg.levels) && cfg.levels !== undefined) problems.push('game.json levels: a list of level references');
      return problems.length
        ? { pass: false, summary: `${problems.length} problem(s) in game.json's wiring: ${problems[0]}`, details: problems.join('\n') }
        : { pass: true, summary: `game.json resolves: ${refsOf(cfg).length} asset reference(s)${notes.length ? `; ${notes.join('; ')}` : ''}` };
    },
  });

  api.registerGate({
    name: 'web-build',
    description: 'The web build (build/web, made by studio_template build) holds index.html, game.json and every asset it names, and boots offline from its own folder in the headless browser: a non-blank frame, the game\'s state, no uncaught errors.',
    applies: async (host) => host.kind !== 'companion' && exists(path.join(host.root, 'build', 'web', 'index.html')),
    async run({ host, signal }) {
      const dir = path.join(host.root, 'build', 'web');
      if (!(await exists(path.join(dir, 'index.html')))) return { pass: false, summary: 'no web build: build/web/index.html is missing', details: 'Build it: studio_template {"action": "build"}.' };
      const problems = [];
      let cfg = {};
      try { cfg = await readJson(path.join(dir, 'game.json')); } catch { problems.push('build/web/game.json is missing or broken'); }
      problems.push(...(await checkGameAssets(dir, cfg)).problems.map((p) => `in the build: ${p}`));
      const { chromiumPath } = await import('@harness/plugins/visual/lib/browser.mjs');
      if (!chromiumPath()) return problems.length ? { pass: false, summary: problems[0], details: problems.join('\n') } : { pass: false, severity: 'advisory', summary: 'the build has its files; not booted: no Chromium here' };
      const { startWebSession } = await import('../player/web-driver.mjs');
      let s, o, fin;
      try {
        s = await startWebSession({ root: dir, game: 'index.html', clock: 'fixed', bootMs: 1500, signal });
        o = await s.step([{ key: 'Enter' }], 1000, { frame: true, width: 256 });
      } catch (e) { problems.push(`it did not boot: ${e.message}`); } finally { fin = await s?.stop().catch(() => null); }
      if (o) {
        if (o.frame?.stats?.blank) problems.push('the screen is blank after 2.5 s');
        if (o.state === undefined) problems.push('no window.__game state');
      }
      const errs = [...new Set(fin?.errors ?? [])];
      if (errs.length) problems.push(`uncaught: ${errs[0].split('\n')[0]}`);
      if (fin?.missing?.length) problems.push(`files missing from the build: ${fin.missing.slice(0, 5).join(', ')}`);
      if (fin?.blocked?.length) problems.push(`it reaches for the network: ${fin.blocked.slice(0, 3).join(', ')}`);
      return problems.length
        ? { pass: false, summary: `the web build is not right: ${problems[0]}`, details: problems.join('\n') }
        : { pass: true, summary: `build/web boots offline: state "${o.state?.state ?? '?'}", ${o.frame?.stats?.colours ?? '?'} colours, no errors, every file there` };
    },
  });
}
