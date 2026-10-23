import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeGuide, GENERATED_MARKER, parseGuideMarkdown, uiEntries, validateUiManifest, type UiManifest } from '../packages/plugin-ui/src/index.ts';
import { registryAnswer } from '../apps/desktop/renderer/src/registry/frame-host.ts';
import { buildRegistry, type PluginEntry } from '../apps/desktop/renderer/src/registry/registry.ts';
import { describePlugin } from '../apps/desktop/renderer/src/registry/agent-surface.ts';
import { toolRendererContext, TOOL_CONTEXT_IMAGE_BYTES } from '../apps/desktop/renderer/src/registry/tool-context.ts';
import { Registry as ServerRegistry } from '../src/kernel/registry.ts';
import { loadPlugin } from '../src/plugins/loader.ts';
import { tempDir } from './helpers.ts';
import { barrelGlb, seedStudio } from './fixtures/desktop/studio-fixture.ts';

// Studio, the games and 3D module of the desktop (plugins/games3d/ui): its manifest against the
// plugin-ui contract, its guide (never stale), its pages (they load only their own files and
// call only what they declared), and its routes on a project seeded in the FORMATS.md shapes:
// what each returns, the one write (a stage's approval), the job queue, the engines, and every
// way a path could leave the folders it may read, refused.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'games3d');
const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'harness-plugin.json'), 'utf8'));
const ui = (): UiManifest => validateUiManifest(manifest.ui, { trustCeiling: 'frame' });

test('studio manifest: a frame module named Studio with the menu, home, guide, badge and the views its menu opens', () => {
  const u = ui();
  assert.equal(u.displayName, 'Studio');
  assert.equal(u.trust, 'frame');
  assert.equal(manifest.permissions?.routes, true, 'its pages read through its own routes');
  assert.deepEqual(u.menu!.items.map((i) => (typeof i === 'string' ? i : i.title)), ['Projects', 'Assets', 'Scenes', 'Renders', 'Builds', 'Playtests', 'Jobs', 'Engines']);
  const views = new Set(u.contributes.views.map((v) => v.id));
  for (const it of u.menu!.items) assert.ok(typeof it !== 'string' && views.has(it.view), `the menu item ${JSON.stringify(it)} opens a view`);
  assert.equal(u.home, 'home');
  assert.ok(u.badges!.some((b) => b.name === 'jobs' && b.route === 'studio/badges' && b.signal));
  assert.ok(u.menu!.items.some((i) => typeof i !== 'string' && i.badge === 'games3d.jobs'), 'the Jobs item shows the running jobs');
  for (const e of uiEntries(u)) assert.ok(fs.existsSync(path.join(plugin, e)), `${e} exists`);
  for (const v of ['viewer', 'sprites', 'audio']) assert.ok(views.has(v), `the ${v} view`);
  // The renderers: the model card for model_info, and the four cards as fences.
  assert.deepEqual(u.contributes.renderers.map((r) => Object.values(r.for)[0]), ['model_info', 'studio_sprite', 'studio_image', 'studio_audio', 'studio_procgen', 'game_playtest', 'studio-model', 'studio-sprite', 'studio-playtest', 'studio-build']);
  // Every button an operation an agent can call too: the views' openers, the stage decisions, cancel, detect, the quick starts.
  const agent = u.contributes.commands.filter((c) => c.agent).map((c) => c.id);
  for (const c of ['open-studio', 'open-project', 'open-asset', 'open-model', 'open-sprite', 'open-level', 'open-audio', 'open-build', 'open-playtest', 'open-jobs', 'open-engines', 'cancel-job', 'approve-stage', 'request-changes', 'comment-stage', 'detect-engines', 'new-2d-platformer', 'new-3d-game', 'new-model', 'new-sprite-sheet', 'new-level']) assert.ok(agent.includes(c), `${c} is agent-callable`);
  const routeCmds = u.contributes.commands.filter((c) => c.action?.type === 'route').map((c) => (c.action as { path: string }).path);
  assert.deepEqual(routeCmds.sort(), ['studio/engines', 'studio/jobs/cancel', 'studio/project/approve', 'studio/project/comment', 'studio/project/reopen', 'studio/project/request-changes']);
});

test('studio pages: every file they load is in ui/, their scripts compile, text is never HTML, and they call only what the manifest declares', () => {
  const u = ui();
  const caps = new Set(u.capabilities);
  const dir = path.join(plugin, 'ui');
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 7);
  const shared = ['kit.js', 'model.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const f of shared) new vm.Script(f);
  const NEEDS: Record<string, string> = { 'routes.call': 'routes.call', 'sessions.get': 'sessions.read', 'workflows.start': 'workflows.start', 'settings.get': 'settings.read', 'external.open': 'external.open', 'events.subscribe': 'events.subscribe' };
  for (const p of pages) {
    const html = fs.readFileSync(path.join(dir, p), 'utf8');
    for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      const ref = m[1]!;
      if (ref === 'harness://app/sdk/plugin-ui.js') continue;
      assert.ok(!/^[a-z]+:/i.test(ref), `${p}: ${ref} is the plugin's own file, never another origin`);
      assert.ok(fs.existsSync(path.join(dir, ref)), `${p}: ${ref} exists`);
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length >= 1, `${p} has its script`);
    for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s), `${p}: its script compiles`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), `${p}: text from workspaces is never parsed as HTML`);
    const code = [html, ...shared].join('\n');
    for (const [call, cap] of Object.entries(NEEDS)) {
      const used = code.includes(`harness.${call.replace('.', '.')}`) || (call === 'events.subscribe' && /Kit\.live\(/.test(html)) || (call === 'routes.call' && /Kit\.(studio|readFile|fileUrl|img)\(|Studio3D\.(load|thumbnail)/.test(html));
      if (used) assert.ok(caps.has(cap as never), `${p} uses ${call}: the manifest declares ${cap}`);
    }
  }
  // The vendored Three.js: a pinned build with its license, loaded only from the plugin.
  const three = fs.readFileSync(path.join(dir, 'vendor', 'three-studio.js'), 'utf8');
  assert.match(three.slice(0, 300), /three\.js r\d+ \(0\.\d+\.\d+\)/);
  assert.ok(fs.existsSync(path.join(dir, 'vendor', 'THREE-LICENSE')));
  assert.ok(three.length < 2_000_000, 'one minified bundle');
});

test('studio guide: a one-sentence purpose, what it is for, the engines and flows, worked examples; the generated half lists every command, view and argument', () => {
  const u = ui();
  const text = fs.readFileSync(path.join(plugin, 'GUIDE.md'), 'utf8');
  assert.ok(!/\r/.test(text), 'LF only');
  const parsed = parseGuideMarkdown(text);
  assert.ok(parsed.purpose && parsed.purpose.length > 30 && parsed.purpose.length <= 200, String(parsed.purpose));
  for (const h of ['## What it is for', '## What the person sees', '## Showing things in the conversation', '## The files Studio reads', '## The engines, and how to choose one', '## Typical flows', '## Worked examples']) assert.ok(parsed.body.includes(h), h);
  assert.ok(parsed.body.includes(GENERATED_MARKER));
  for (const e of ['Blender', 'Godot', 'Unreal', 'Unity', 'Web']) assert.ok(text.includes(`**${e}`), `how to choose ${e}`);
  for (const f of ['.studio/project.json', '.studio/assets/<id>/asset.json', '.studio/playtests/<id>/report.json']) assert.ok(text.includes(f), f);
  const full = composeGuide({ name: 'games3d', title: u.displayName, description: manifest.description, ui: u, authored: text });
  assert.ok(!full.includes(GENERATED_MARKER));
  for (const c of u.contributes.commands) assert.ok(full.includes(`\`games3d:${c.id}\``), `command ${c.id}`);
  for (const v of u.contributes.views) assert.ok(full.includes(`\`games3d:${v.id}\``), `view ${v.id}`);
  for (const s of u.contributes.settings) assert.ok(full.includes(`\`games3d:${s.id}\``), `settings ${s.id}`);
  for (const s of u.contributes.slashCommands) assert.ok(full.includes(`\`/${s.name}\``), `/${s.name}`);
  for (const c of u.contributes.commands.filter((x) => x.agent?.inputSchema?.properties)) for (const k of Object.keys(c.agent!.inputSchema!.properties!)) assert.ok(full.includes(`\`${k}\``), `${c.id}: ${k}`);
  for (const t of u.tools ?? []) assert.ok(full.includes(`\`${t}\``), t);
  // In desktop_describe, the agent sees Studio with its commands and their arguments.
  const entry: PluginEntry = { name: 'games3d', source: 'local', enabled: true, ui: u, guideInfo: { purpose: parsed.purpose! } };
  const d = describePlugin(buildRegistry([entry]), 'games3d') as { commands?: Array<{ command: string }> } | undefined;
  assert.ok(d && JSON.stringify(d).includes('games3d:open-model'), 'desktop_describe {plugin: games3d} lists its operations');
});

test('studio on the server: the plugin loads with its routes (signed-in: user), next to its tools and gates', async () => {
  const reg = new ServerRegistry();
  await loadPlugin(reg, plugin);
  const paths = reg.routes.filter((r) => r.plugin === 'games3d').map((r) => `${r.method} ${r.path}`);
  for (const p of ['GET studio/summary', 'POST studio/projects', 'GET studio/file', 'POST studio/project/approve', 'POST studio/jobs/cancel', 'GET studio/badges', 'GET studio/engines']) assert.ok(paths.includes(p), p);
  assert.ok(reg.routes.filter((r) => r.plugin === 'games3d').every((r) => r.auth === 'user'));
  assert.ok(reg.tools.get('model_info'));
});

// ---------------- the routes ----------------

type Res = { status: number; body: Record<string, unknown> & { error?: string } };
async function studio() {
  const home = await tempDir('studio-home-');
  const ws = await tempDir('studio-ws-');
  const data = await tempDir('studio-data-');
  const outside = await tempDir('studio-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for Studio');
  Object.assign(process.env, { HARNESS_HOME: home, HARNESS_LOCAL_ROOTS: ws, HARNESS_DATA: data });
  const seed = seedStudio(ws, { home });
  const routes = new Map<string, { handler: (req: unknown) => Promise<Res> }>();
  const signals: string[] = [];
  // @ts-expect-error plain JS module
  const { setupUiRoutes, parseProblems, probeEngines } = await import('../plugins/games3d/ui/routes.mjs');
  setupUiRoutes({ registerRoute: (r: { method: string; path: string; handler: (req: unknown) => Promise<Res> }) => routes.set(`${r.method} ${r.path}`, r), signal: (n: string) => signals.push(n), log: () => {} });
  const call = async (p: string, body: Record<string, unknown> = {}, user: unknown = { name: 'Suhail' }): Promise<Res> => {
    const r = routes.get(`POST studio/${p}`);
    assert.ok(r, `a route studio/${p}`);
    return r.handler({ method: 'POST', path: `studio/${p}`, query: {}, headers: {}, body: Buffer.from(JSON.stringify(body)), ip: '127.0.0.1', user });
  };
  const ok = async (p: string, body?: Record<string, unknown>) => { const r = await call(p, body); assert.equal(r.status, 200, `${p}: ${r.body?.error}`); return r.body as any; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { home, ws, outside, seed, call, ok, signals, parseProblems, probeEngines };
}

test('studio routes: projects, a project, assets with facets, an asset, files, scenes, renders, builds with problems, playtests', async () => {
  const s = await studio();
  const list = await s.ok('projects');
  assert.equal(list.projects.length, 1);
  const p = list.projects[0];
  assert.equal(p.name, 'Coin Escape');
  assert.equal(p.engine, 'godot');
  assert.equal(p.stage, 'prototype', 'the first stage not done or approved');
  assert.deepEqual(p.waiting, ['prototype']);
  assert.deepEqual(p.counts, { assets: 5, playtests: 1, builds: 2 });
  // By its folder too (what an agent knows).
  const byDir = await s.ok('project', { project: s.seed.projectDir });
  assert.equal(byDir.project.id, p.id);
  assert.match(byDir.design.text, /Collect \*\*ten coins\*\*/);
  assert.equal(byDir.playtests[0].result, 'pass');
  assert.equal(byDir.assets.length, 5);

  const sum = await s.ok('summary');
  assert.equal(sum.counts.projects, 1);
  assert.equal(sum.counts.assets, 6, 'the five of the project and the library\'s');
  assert.equal(sum.engines.length, 5);

  const all = await s.ok('assets');
  assert.equal(all.total, 6);
  assert.deepEqual(all.facets.kind.map((f: { value: string }) => f.value).sort(), ['audio', 'level', 'model', 'sprite', 'spritesheet', 'tileset']);
  assert.ok(all.facets.license.some((f: { value: string; count: number }) => f.value === 'CC0-1.0' && f.count === 5));
  assert.equal(all.assets.find((x: { id: string }) => x.id === 'level-1').level, 'level_1.json', 'a level opens in the level viewer');
  const models = await s.ok('assets', { kind: 'model' });
  assert.equal(models.assets.length, 1);
  const barrel = models.assets[0];
  assert.equal(barrel.model, 'barrel.glb');
  assert.equal(barrel.viewer, '3d');
  assert.deepEqual(barrel.lods, [{ role: 'lod1', path: 'barrel_lod1.glb' }]);
  assert.ok(barrel.files.every((f: { exists: boolean }) => f.exists));
  assert.equal((await s.ok('assets', { license: 'CC-BY-4.0' })).assets[0].id, 'hero-walk');
  assert.equal((await s.ok('assets', { q: 'meadow' })).total, 2, 'the tileset and the level');
  assert.equal((await s.ok('assets', { project: 'library' })).assets[0].library, true);
  const sheet = (await s.ok('asset', { asset: 'hero-walk', project: s.seed.projectDir })).asset;
  assert.deepEqual(sheet.meta.frameSize, [32, 32]);
  assert.equal(sheet.source.prompt, 'a small hero in a blue tunic, 8-frame walk cycle, 32x32 pixel art');
  assert.equal(sheet.checksFailed, 1);
  assert.equal(sheet.preview, 'hero_walk.png', 'a sprite sheet is its own preview');
  assert.equal((await s.ok('asset', { asset: 'library:crate-kenney' })).asset.license.author, 'Kenney');

  // Files: an asset's, a project's, by absolute path, as text.
  const glb = await s.ok('file', { project: p.id, asset: 'barrel-wood-01', path: 'barrel.glb' });
  assert.equal(glb.mime, 'model/gltf-binary');
  assert.deepEqual(Buffer.from(glb.base64, 'base64'), barrelGlb(24).glb);
  const frame = await s.ok('file', { project: p.id, path: '.studio/playtests/pt-20261023-1/frames/0000.png' });
  assert.equal(frame.mime, 'image/png');
  const abs = await s.ok('file', { path: path.join(s.seed.projectDir, 'design', 'GDD.md'), text: true });
  assert.match(abs.text, /^# Coin Escape/);
  // A level's tileset in a sibling asset: reached through the project.
  assert.equal((await s.ok('file', { project: p.id, asset: 'level-1', path: '.studio/assets/tiles-meadow/tiles.png' })).mime, 'image/png');

  const scenes = await s.ok('scenes');
  const tscn = scenes.scenes.find((x: { path: string }) => x.path === 'game/levels/level_1.tscn');
  assert.equal(tscn.kind.viewer, 'outline');
  const outline = await s.ok('scene', { project: p.id, path: tscn.path });
  assert.deepEqual(outline.nodes.map((n: { path: string }) => n.path), ['.', 'Player', 'Player/Camera', 'Coins', 'Coins/Coin1', 'ExitDoor']);
  const renders = await s.ok('renders');
  assert.deepEqual(renders.renders.map((x: { path: string }) => x.path).sort(), ['renders/level_1_v1.png', 'renders/level_1_v2.png']);

  const builds = await s.ok('builds');
  assert.deepEqual(builds.builds.map((b: { id: string }) => b.id), ['b2', 'b1'], 'newest first');
  const b1 = await s.ok('build', { project: p.id, id: 'b1' });
  assert.equal(b1.logPath, '.studio/builds/b1/build.log');
  const parse = b1.problems.find((x: { message: string }) => /velocty/.test(x.message));
  assert.equal(parse.file, 'res://scripts/player.gd');
  assert.equal(parse.line, 9);
  assert.equal(parse.link, 'game/scripts/player.gd', 'res:// is the Godot project\'s folder');
  assert.equal(b1.artifact.exists, false);
  const src = await s.ok('source', { project: p.id, path: parse.file, line: parse.line });
  assert.equal(src.path, 'game/scripts/player.gd');
  assert.match(src.lines[src.line - src.from], /velocty/);

  const tests = await s.ok('playtests');
  assert.equal(tests.playtests[0].issues, 2);
  assert.equal(tests.playtests[0].majorIssues, 1);
  const t = (await s.ok('playtest', { project: p.id, id: 'pt-20261023-1' })).playtest;
  assert.equal(t.result, 'pass');
  assert.equal(t.frames.length, 9);
  assert.ok(t.frames.every((f: string) => f.startsWith('.studio/playtests/pt-20261023-1/frames/')));
  assert.equal(t.recording, '.studio/playtests/pt-20261023-1/playthrough.gif');
  assert.equal(t.events.find((e: { type: string }) => e.type === 'stuck').frame, '.studio/playtests/pt-20261023-1/frames/0120.png');
  assert.equal(t.series.fps.length, 9);
  assert.equal(t.issues[0].evidence, '.studio/playtests/pt-20261023-1/frames/0120.png');
});

test('studio routes refuse every path outside their folders: "..", absolute paths elsewhere, links out, bad ids; members see nothing', async () => {
  const s = await studio();
  const pid = (await s.ok('projects')).projects[0].id;
  const refused = async (p: string, body: Record<string, unknown>, status: number, why: RegExp) => { const r = await s.call(p, body); assert.equal(r.status, status, `${p} ${JSON.stringify(body)}: ${r.status} ${r.body.error}`); assert.match(String(r.body.error), why); };
  await refused('file', { project: pid, path: '../../secret.txt' }, 403, /"\.\." is not allowed/);
  await refused('file', { project: pid, path: 'design/../../x' }, 403, /"\.\."/);
  await refused('file', { project: pid, path: '..\\..\\secret.txt' }, 403, /"\.\."/);
  await refused('file', { project: pid, path: path.join(s.outside, 'secret.txt') }, 400, /relative to its folder/);
  await refused('file', { path: path.join(s.outside, 'secret.txt') }, 403, /outside the folders Studio may read/);
  await refused('file', { root: s.outside, path: 'secret.txt' }, 403, /outside the folders/);
  await refused('file', { project: pid, path: '~/secret.txt' }, 400, /relative/);
  await refused('file', { project: pid, path: 'nope.png' }, 404, /not there/);
  await refused('file', { project: 'ffffffffffff', path: 'x' }, 404, /no such project/);
  await refused('file', { project: pid, asset: '../x', path: 'a' }, 400, /asset is an asset id/);
  await refused('playtest', { project: pid, id: '../../..' }, 400, /playtest id/);
  await refused('project', { project: s.outside }, 403, /outside the folders/);
  await refused('source', { project: pid, path: path.join(s.outside, 'secret.txt'), line: 1 }, 403, /outside the project/);
  // A link (a junction on Windows) inside the project that leads out is not followed out.
  // (Removed right after, as a link only: the folders' cleanup never meets it.)
  const link = path.join(s.seed.projectDir, 'escape');
  fs.symlinkSync(s.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  try { await refused('file', { project: pid, path: 'escape/secret.txt' }, 403, /leads outside/); } finally { fs.unlinkSync(link); }
  assert.ok(fs.existsSync(path.join(s.outside, 'secret.txt')), 'removing the link left its target alone');
  // The library is its own folder: an asset id cannot climb out of it either.
  await refused('file', { asset: 'library:..', path: 'x' }, 400, /asset id/);
  // Members: the server's folders are an administrator's.
  const member = await s.call('projects', {}, { id: 'u1', name: 'Mo', role: 'member' });
  assert.equal(member.status, 403);
  assert.equal((await s.call('projects', {}, null)).status, 403, 'never without a person');
  assert.equal((await s.call('projects', {}, { id: 'a1', name: 'Ad', role: 'admin' })).status, 200);
  // The operator's own token (no account id): the desktop.
  assert.equal((await s.call('projects', {}, { name: 'operator', role: 'admin' })).status, 200);
});

test('studio routes: a stage approved, commented on and sent back writes project.json and keeps every other field', async () => {
  const s = await studio();
  const pid = (await s.ok('projects')).projects[0].id;
  const file = path.join(s.seed.projectDir, '.studio', 'project.json');
  const before = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = await s.ok('project/approve', { project: pid, stage: 'prototype', comment: 'Looks good: keep the door timing.' });
  assert.match(a.text, /Approved the prototype stage of Coin Escape/);
  let now = JSON.parse(fs.readFileSync(file, 'utf8'));
  const st = now.stages.find((x: { id: string }) => x.id === 'prototype');
  assert.equal(st.status, 'approved');
  assert.equal(st.approvedBy, 'Suhail');
  assert.equal(st.comments[0].text, 'Looks good: keep the door timing.');
  assert.deepEqual({ ...now, stages: undefined }, { ...before, stages: undefined }, 'nothing else changed');
  assert.ok(s.signals.includes('projects'));
  const bad = await s.call('project/comment', { project: pid, stage: 'prototype' });
  assert.equal(bad.status, 400, 'a comment needs words');
  await s.ok('project/request-changes', { project: pid, stage: 'design', comment: 'Add a pause screen.' });
  now = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(now.stages.find((x: { id: string }) => x.id === 'design').status, 'changes-requested');
  assert.equal((await s.call('project/approve', { project: pid, stage: 'no-such' })).status, 404);
  assert.equal((await s.call('project/stage', { project: pid, stage: 'brief', action: 'delete' })).status, 400);
  await s.ok('project/reopen', { project: pid, stage: 'prototype' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stages.find((x: { id: string }) => x.id === 'prototype').status, 'active');
});

test('studio routes: the job queue (running, waiting, cancelled from the page or an agent) and the Jobs badge', async () => {
  const s = await studio();
  // @ts-expect-error plain JS module
  const { runJob } = await import('../plugins/games3d/sdk/jobs.mjs');
  const long = (sig: AbortSignal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, 20_000); sig.addEventListener('abort', () => { clearTimeout(t); reject(sig.reason); }); });
  const a = runJob('unreal', 'Render the turntable', long).catch((e: Error) => e);
  const b = runJob('unreal', 'BuildCookRun Win64', long).catch((e: Error) => e);
  const jobs = await s.ok('jobs');
  const mine = jobs.jobs.filter((j: { engine: string; title: string }) => j.engine === 'unreal' && /turntable|BuildCookRun/.test(j.title));
  assert.deepEqual(mine.map((j: { status: string }) => j.status).sort(), ['running', 'waiting'], 'one per engine at a time');
  assert.ok((await s.ok('badges')).jobs >= 2);
  for (const j of mine) { const r = await s.ok('jobs/cancel', { id: j.id }); assert.equal(r.ok, true); assert.match(r.text, /Cancelled job-\d+/); }
  assert.match(String(await a), /cancelled/);
  assert.match(String(await b), /cancelled/);
  const after = await s.ok('jobs');
  assert.ok(after.jobs.filter((j: { id: string }) => mine.some((m: { id: string }) => m.id === j.id)).every((j: { status: string }) => j.status === 'cancelled'));
  assert.equal((await s.call('jobs/cancel', { id: '../x' })).status, 400);
  assert.equal((await s.call('jobs/cancel', { id: 'job-999999' })).status, 404);
});

test('studio engines: found from files (no engine started): versions, Unreal without MSVC is Blueprints and Python only, Unity from the Hub, Godot missing', async () => {
  const s = await studio();
  const files = new Set([
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    'D:\\UnrealEngine\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
    'D:\\UnrealEngine\\UE_5.8\\Engine\\Plugins\\Experimental\\PythonScriptPlugin',
    'D:\\UnrealEngine\\UE_5.8\\Engine\\Plugins\\VirtualProduction\\RemoteControl',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Unity\\Hub\\Editor\\6000.0.23f1\\Editor\\Unity.exe',
  ]);
  const dirs: Record<string, string[]> = { 'C:\\Program Files\\Blender Foundation': ['Blender 4.2'], 'D:\\UnrealEngine': ['UE_5.8'], 'C:\\Program Files\\Unity\\Hub\\Editor': ['6000.0.23f1'] };
  const ran: string[][] = [];
  const list = await s.probeEngines({
    platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: '' }, home: 'C:\\h',
    exists: (p: string) => files.has(p), listDir: (d: string) => dirs[d] ?? [],
    readText: (f: string) => (f.endsWith('Build.version') ? JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 4 }) : null),
    run: async (bin: string, args: string[]) => { ran.push([bin, ...args]); return ''; },
  });
  const by = Object.fromEntries(list.map((e: { engine: string }) => [e.engine, e]));
  assert.deepEqual(Object.keys(by), ['blender', 'godot', 'unreal', 'unity', 'web']);
  assert.equal(by.blender.version, '4.2');
  assert.equal(by.godot.installed, false);
  assert.equal(by.unreal.version, '5.8.4');
  assert.deepEqual(by.unreal.features, { python: true, remoteControl: true, msvc: false });
  assert.match(by.unreal.gaps.join('\n'), /no MSVC[^\n]*Blueprints and Python only/);
  assert.ok(ran[0]![0]!.endsWith('vswhere.exe') && ran[0]!.includes('Microsoft.VisualStudio.Component.VC.Tools.x86.x64'));
  assert.equal(by.unity.installed, true);
  assert.equal(by.unity.version, '6000.0.23f1');
  assert.match(by.unity.gaps[0], /license is activated by you/);
  assert.equal(by.web.installed, true);
  // With MSVC there is no gap.
  const withMsvc = await s.probeEngines({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', PATH: '' }, home: 'C:\\h', exists: (p: string) => files.has(p), listDir: (d: string) => dirs[d] ?? [], readText: () => null, run: async () => 'C:\\VS\\2022\\Community\n' });
  assert.deepEqual(withMsvc.find((e: { engine: string }) => e.engine === 'unreal').gaps, []);
  // The route says it in a line too (what an agent hears from detect-engines).
  const r = await s.ok('engines', { refresh: true });
  assert.match(r.text, /^Engines on this machine: Blender: /);
});

test('build logs: problems with their files and lines from MSVC, GCC/TypeScript, Godot, Unreal, Unity and Python', async () => {
  const s = await studio();
  const p = s.parseProblems([
    'D:\\Game\\Source\\Coin\\Coin.cpp(42): error C2065: \'Scor\': undeclared identifier',
    'Assets/Scripts/Player.cs(12,8): warning CS0168: The variable \'e\' is declared but never used',
    'src/main.ts:7:3 - error TS2304: Cannot find name \'foo\'.',
    'res://scripts/enemy.gd:21 - Parse Error: Expected end of statement',
    'SCRIPT ERROR: Invalid call. Nonexistent function \'jump\'.',
    '   at: _process (res://scripts/player.gd:33)',
    '[2026.10.23-10.00.00:000][  0]LogBlueprint: Error: [Compiler] Unknown pin type in /Game/Blueprints/BP_Door',
    'Traceback (most recent call last):', '  File "tools/model.py", line 9, in <module>', 'NameError: name \'bpy2\' is not defined',
    'Compiled 12 files with 0 errors',
  ].join('\n'));
  const brief = p.map((x: { severity: string; file?: string; line?: number }) => `${x.severity} ${x.file ?? '-'}:${x.line ?? '-'}`);
  assert.deepEqual(brief, ['error D:/Game/Source/Coin/Coin.cpp:42', 'warning Assets/Scripts/Player.cs:12', 'error src/main.ts:7', 'error res://scripts/enemy.gd:21', 'error res://scripts/player.gd:33', 'error /Game/Blueprints/BP_Door:-', 'error tools/model.py:9']);
  assert.match(p[6].message, /NameError/);
});

test('the desktop for any plugin: registry.has({plugin}) is true for a server plugin that is on without pages; a tool renderer gets its conversation and images', () => {
  const r = buildRegistry([
    { name: 'games3d', source: 'local', enabled: true, ui: ui() },
    { name: 'engine-unreal', source: 'local', enabled: true },
    { name: 'engine-unity', source: 'local', enabled: false },
  ] as PluginEntry[]);
  assert.equal(registryAnswer(r, 'games3d', 'registry.has', { plugin: 'engine-unreal' }), true);
  assert.equal(registryAnswer(r, 'games3d', 'registry.has', { plugin: 'engine-unity' }), false, 'switched off');
  assert.equal(registryAnswer(r, 'games3d', 'registry.has', { plugin: 'engine-godot' }), false, 'not installed');
  assert.deepEqual(registryAnswer(r, 'games3d', 'registry.list', { kind: 'plugins' }), ['games3d', 'engine-unreal']);
  const img = (n: number) => ({ media_type: 'image/png', data: 'a'.repeat(n) });
  const c = toolRendererContext({ name: 'model_info', input: { path: 'm.glb' }, result: 'm.glb: 1 mesh(es)', images: [img(10), img(TOOL_CONTEXT_IMAGE_BYTES), img(5)] }, '0123456789abcdef');
  assert.equal(c.sessionId, '0123456789abcdef');
  assert.equal(c.tool, 'model_info');
  assert.deepEqual(c.images!.map((x) => x.data.length), [10], 'within the budget, in order: the rest are left out');
  assert.equal(toolRendererContext({ name: 'x', input: {} }, 's').images, undefined);
});
