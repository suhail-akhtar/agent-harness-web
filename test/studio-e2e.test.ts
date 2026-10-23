// Studio end to end: the real Electron app against the real harness server with the games3d
// plugin and a scripted model (test/fixtures/desktop/scripted-agents-engine.ts: nothing is spent),
// on a project seeded in the FORMATS.md shapes (test/fixtures/desktop/studio-fixture.ts).
//
//   1. Studio in the sidebar (its menu), its home: recent projects, jobs, engines, quick starts
//   2. Projects and a project: stages, approving one (project.json written), the design document
//   3. Assets: the grid with previews (3D thumbnails drawn), filters, an asset's page
//   4. the 3D viewer: the canvas draws the model (not blank), its numbers, shading modes, LODs, animations
//   5. the 2D viewer: the sprite sheet plays; a level drawn with its tileset; the audio player
//   6. Scenes (a Godot outline), Renders (side by side), Builds (problems linked to the source),
//      Playtests (the timeline, frames, charts, issues), Jobs and Engines
//   7. a scripted agent opens Studio's views through its operations (desktop_command, asked first)
//      and its results draw as Studio's cards (a model card, sprite, playtest and build cards)
//   8. Studio off: the cards fall back to the plain tool card and code, with a note; on again
//
// HARNESS_DESKTOP_SCREENSHOTS=1 writes a screenshot of every stage to docs/screenshots/desktop/studio/
// (else to a temporary folder, named in the test's output).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertNotBlank, capture } from './fixtures/desktop/png.ts';
import { seedStudio } from './fixtures/desktop/studio-fixture.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'apps', 'desktop');
const SHOTS = process.env.HARNESS_DESKTOP_SCREENSHOTS === '1' ? path.join(root, 'docs', 'screenshots', 'desktop', 'studio') : fs.mkdtempSync(path.join(os.tmpdir(), 'hd-studio-shots-'));
const electronExe = (() => { try { return String(createRequire(import.meta.url)('electron')); } catch { return ''; } })();

function newest(dir: string): number {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
function ensureBuilt(): string | null {
  const out = path.join(desktop, 'dist', 'renderer', 'index.html');
  const src = Math.max(newest(path.join(desktop, 'electron')), newest(path.join(desktop, 'renderer')), newest(path.join(desktop, 'shared')), newest(path.join(root, 'packages')));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= src) return null;
  const r = spawnSync(process.execPath, [path.join(desktop, 'scripts', 'build.mjs')], { cwd: root, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });
  return r.status === 0 ? null : `build failed: ${(r.stderr || r.stdout).slice(-800)}`;
}

test('Studio: the games and 3D module in the desktop, its views and viewers, driven by the person and by an agent', { timeout: 20 * 60_000 }, async (t) => {
  if (!electronExe || !fs.existsSync(electronExe)) { t.skip('Electron is not installed (npm install, or node node_modules/electron/install.js)'); return; }
  let pw: typeof import('playwright-core');
  try { pw = await import('playwright-core'); } catch { t.skip('playwright-core is not installed'); return; }
  const failed = ensureBuilt();
  if (failed) assert.fail(failed);

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-studio-'));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-studio-ws-')));
  const seed = seedStudio(ws);
  const dir = seed.projectDir;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|^GW_|^HARNESS_|^NODE_TEST_CONTEXT$/.test(k)) env[k] = v;
  Object.assign(env, {
    HARNESS_DESKTOP_DATA: data, HARNESS_DESKTOP_TEST: '1', ...(process.env.HARNESS_E2E_SHOW ? { HARNESS_E2E_SHOW: process.env.HARNESS_E2E_SHOW } : {}),
    HARNESS_DESKTOP_ENGINE: path.join(root, 'test', 'fixtures', 'desktop', 'scripted-agents-engine.ts'), HARNESS_DESKTOP_NO_TRAY: '1', HARNESS_PLUGIN_LOOPS: 'off',
    HARNESS_PLUGINS: path.join(root, 'plugins', 'games3d'),
  });
  let app: import('playwright-core').ElectronApplication;
  try { app = await pw._electron.launch({ executablePath: electronExe, args: [desktop], env, timeout: 60_000 }); }
  catch (e) { t.skip(`Electron could not start here: ${(e as Error).message.split('\n')[0]}`); return; }
  fs.mkdirSync(SHOTS, { recursive: true });
  t.diagnostic(`screenshots: ${SHOTS}`);
  const page = await app.firstWindow();
  let phase = 'start';
  const errors: Array<{ phase: string; text: string }> = [];
  const frameErrors: Array<{ phase: string; text: string }> = [];
  page.on('pageerror', (e) => errors.push({ phase, text: `exception: ${e.message}` }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location().url ?? '';
    (/\/plugins\//.test(where) ? frameErrors : errors).push({ phase, text: `${m.text()} (${where})` });
  });
  let shotN = 0;
  const shot = async (name: string, el?: import('playwright-core').Locator) => { await page.waitForTimeout(450); shotN++; const png = await capture(app, el); assertNotBlank(png, name); fs.writeFileSync(path.join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`), png); };
  const setSize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, s) => { const win = BrowserWindow.getAllWindows()[0]!; if (win.isMaximized()) win.unmaximize(); win.setSize(s.w, s.h); }, { w, h });
  const invoke = (channel: string, ...args: unknown[]) => page.evaluate(([c, a]) => (window as unknown as { harnessDesktop: { invoke: (c: string, ...x: unknown[]) => Promise<unknown> } }).harnessDesktop.invoke(c as string, ...(a as unknown[])), [channel, args] as const);
  const api = (method: string, p: string, body?: unknown) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u as string, { method: m as string, headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; }, [method, p, body] as const);
  const ready = () => page.waitForSelector('[data-engine-status="ready"]', { timeout: 90_000 });
  const view = (qid: string) => page.frameLocator(`[data-view="${qid}"] [data-plugin-frame] iframe`);
  const frameOf = async (file: string) => {
    for (let i = 0; i < 100; i++) { const f = page.frames().find((x) => x.url().includes(`/plugins/games3d/ui/${file}`)); if (f) return f; await page.waitForTimeout(150); }
    throw new Error(`no frame of ${file}`);
  };
  const nav = async (id: string) => { await page.click(`[data-nav="games3d:${id}"]`); await view(`games3d:${id}`).locator('body[data-ready="1"]').waitFor({ timeout: 30_000 }); };
  const send = async (text: string) => { const box = page.locator('[data-composer-input]').first(); await box.fill(text); await box.press('Enter'); };
  const step = (name: string, fn: () => Promise<void>) => t.test(name, async () => {
    phase = name;
    try { await fn(); } catch (e) {
      await capture(app).then((png) => fs.writeFileSync(path.join(os.tmpdir(), `hd-studio-fail-${name.slice(0, 40).replace(/[^a-z0-9]+/gi, '-')}.png`), png)).catch(() => {});
      for (let i = 0; i < 3; i++) await page.keyboard.press('Escape').catch(() => {});
      throw e;
    }
  });
  await setSize(1360, 860);
  let pid = '';

  try {
    await step('setup: the engine is ready with the project folder', async () => {
      await ready();
      await page.waitForSelector('[data-home]');
      await invoke('prefs:set', { defaultModel: 'deepseek-flash', defaultMode: 'acceptEdits', onboardingDone: true });
      await page.evaluate(() => { const w = window as unknown as { __restarted: boolean }; w.__restarted = false; const el = document.querySelector('[data-engine-status]')!; new MutationObserver(() => { if (el.getAttribute('data-engine-status') !== 'ready') w.__restarted = true; }).observe(el, { attributes: true }); });
      await invoke('projects:add', dir);
      await page.waitForFunction(() => (window as unknown as { __restarted: boolean }).__restarted, null, { timeout: 20_000 }).catch(() => {});
      await ready();
      await page.waitForSelector('[data-nav="games3d:projects"]', { timeout: 30_000 });
    });

    await step('1. Studio is a module: its menu in the sidebar and its home (projects, jobs, engines and their gaps, quick starts)', async () => {
      const items = await page.$$eval('[data-in-group="games3d"]', (els) => els.map((e) => e.getAttribute('data-nav')));
      assert.deepEqual(items, ['projects', 'assets', 'scenes', 'renders', 'builds', 'playtests', 'jobs', 'engines'].map((x) => `games3d:${x}`));
      await page.click('[data-group-home="games3d"]');
      await page.waitForSelector('[data-trust-gate="games3d"]');
      await shot('trust');
      await page.click('[data-grant]');
      const home = view('games3d:home');
      await home.locator('body[data-ready="1"]').waitFor({ timeout: 30_000 });
      await home.locator('[data-home-project]').first().waitFor({ timeout: 30_000 });
      assert.equal(await home.locator('[data-quick-start]').count(), 5);
      assert.equal(await home.locator('[data-home-engine]').count(), 5, 'Blender, Godot, Unreal, Unity, web');
      pid = (await home.locator('[data-home-project]').first().getAttribute('data-home-project'))!;
      assert.match(await home.locator('[data-home-project]').first().innerText(), /Coin Escape[\s\S]*waits for you/);
      await home.locator('[data-home-asset]').nth(4).waitFor();
      await page.waitForTimeout(1500);
      await shot('home');
    });

    await step('2. Projects and a project: stages (approving one writes project.json), the design document, builds, playtests, assets', async () => {
      await nav('projects');
      await view('games3d:projects').locator('[data-project]').first().waitFor();
      await shot('projects');
      await view('games3d:projects').locator(`[data-project="${pid}"]`).click();
      const p = view('games3d:projects');
      await p.locator('[data-project-page]').waitFor({ timeout: 20_000 });
      assert.equal(await p.locator('[data-stage="prototype"]').getAttribute('aria-current'), 'true', 'the stage that waits for the person');
      await p.locator('[data-design] h1, [data-design] h2').first().waitFor();
      await p.locator('[data-stage-comment]').fill('Great prototype: keep the door timing for the vertical slice.');
      await shot('project');
      await p.locator('[data-stage-action="approve"]').click();
      await p.locator('[data-stage="prototype"][data-status="approved"]').waitFor({ timeout: 20_000 });
      const json = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'project.json'), 'utf8'));
      const st = json.stages.find((s: { id: string }) => s.id === 'prototype');
      assert.equal(st.status, 'approved');
      assert.match(st.comments[0].text, /keep the door timing/);
      await p.locator('[data-comment]').first().waitFor();
      await shot('project-approved');
    });

    await step('3. Assets: a grid with previews (the model drawn in 3D), filters, an asset page with provenance, license, checks and files', async () => {
      await nav('assets');
      const a = view('games3d:assets');
      await a.locator('[data-asset]').nth(4).waitFor({ timeout: 20_000 });
      assert.equal(await a.locator('[data-asset]').count(), 5);
      await a.locator('[data-model-thumb]').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
      await shot('assets');
      await a.locator('[data-facet="kind"] [data-value="spritesheet"]').click();
      await page.waitForFunction(async () => true);
      await a.locator('[data-asset]').first().waitFor();
      await page.waitForTimeout(500);
      assert.equal(await a.locator('[data-asset]').count(), 1);
      await a.locator('[data-asset]').first().click();
      const s = view('games3d:assets');
      await s.locator('[data-asset-page]').waitFor({ timeout: 20_000 });
      assert.match(await s.locator('[data-provenance]').innerText(), /generated[\s\S]*pixel-lab[\s\S]*8-frame walk cycle/);
      assert.equal(await s.locator('[data-check][data-pass="0"]').count(), 1, 'the palette check fails');
      await shot('asset-sprite-sheet');
    });

    await step('4. the 3D viewer: the barrel is drawn (not blank), with its numbers, shading modes, the LOD and its animations', async () => {
      await page.click('[data-nav="games3d:assets"]');
      const a = view('games3d:assets');
      await a.locator(`[data-asset="${pid}:barrel-wood-01"]`).click();
      await a.locator('[data-asset-page]').waitFor({ timeout: 20_000 });
      await a.locator('[data-asset-preview] img').waitFor({ timeout: 30_000 });
      await shot('asset-model');
      await a.locator('[data-open-viewer="3d"]').click();
      const v = view('games3d:viewer');
      await v.locator('body[data-rendered="1"]').waitFor({ timeout: 40_000 });
      const f = await frameOf('viewer3d.html');
      const spread = await f.evaluate(() => (window as unknown as { __viewer: { spread(): { colours: number; stddev: number } } }).__viewer.spread());
      assert.ok(spread.colours >= 20 && spread.stddev >= 6, `the canvas draws the model: ${JSON.stringify(spread)}`);
      assert.equal(await v.locator('[data-stat="triangles"]').innerText(), seed.triangles.toLocaleString());
      assert.equal(await v.locator('[data-clips] option').count(), 2, 'spin and hop');
      const t0 = await f.evaluate(() => (window as unknown as { __viewer: { time(): number } }).__viewer.time());
      await page.waitForTimeout(400);
      const t1 = await f.evaluate(() => (window as unknown as { __viewer: { time(): number } }).__viewer.time());
      assert.notEqual(t0, t1, 'the animation plays');
      await shot('viewer-3d');
      await v.locator('[data-mode="wireframe"]').click();
      await page.waitForTimeout(300);
      await shot('viewer-3d-wireframe');
      await v.locator('[data-mode="uv"]').click();
      await page.waitForTimeout(300);
      await shot('viewer-3d-uv-checker');
      await v.locator('[data-mode="shaded"]').click();
      await v.locator('#lod').selectOption('barrel_lod1.glb');
      await page.waitForFunction(async () => true);
      await v.locator('body[data-rendered="1"]').waitFor({ timeout: 30_000 });
      const lodTris = Number((await v.locator('[data-stat="triangles"]').innerText()).replace(/\D/g, ''));
      assert.ok(lodTris > 0 && lodTris < seed.triangles, `LOD 1 has fewer triangles (${lodTris} < ${seed.triangles})`);
    });

    await step('5. the 2D viewer: the sprite sheet plays at its frame rate; the level is drawn with its tileset; the audio player draws the waveform', async () => {
      await page.click('[data-nav="games3d:assets"]');
      const a = view('games3d:assets');
      await a.locator(`[data-asset="${pid}:hero-walk"]`).click();
      await a.locator('[data-open-viewer="2d"]').click();
      const v = view('games3d:sprites');
      await v.locator('body[data-ready2d="1"]').waitFor({ timeout: 30_000 });
      const f1 = await v.locator('body').getAttribute('data-frame');
      await page.waitForTimeout(450);
      const f2 = await v.locator('body').getAttribute('data-frame');
      assert.notEqual(f1, f2, 'the frames advance');
      assert.match(await v.locator('[data-frame-label]').innerText(), /of 8/);
      await shot('sprite-sheet');
      await page.click('[data-nav="games3d:assets"]');
      await a.locator(`[data-asset="${pid}:level-1"]`).click();
      await a.locator('[data-open-viewer="level"]').click();
      const l = view('games3d:sprites');
      await l.locator('body[data-ready2d="1"]').waitFor({ timeout: 30_000 });
      assert.ok(Number(await l.locator('body').getAttribute('data-tiles')) > 50);
      assert.equal(await l.locator('[data-layers] input').count(), 3, 'two tile layers and the objects');
      assert.equal(await l.locator('.note').count(), 0, 'the tileset loaded');
      await shot('level');
      await page.click('[data-nav="games3d:assets"]');
      await a.locator(`[data-asset="${pid}:sfx-coin"]`).click();
      await a.locator('[data-open-viewer="audio"]').click();
      const au = view('games3d:audio');
      await au.locator('body[data-waveform="1"]').waitFor({ timeout: 30_000 });
      assert.ok(Math.abs(Number(await au.locator('body').getAttribute('data-duration')) - 0.45) < 0.02);
      await shot('audio');
    });

    await step('6. Scenes, Renders side by side, a build\'s problems linked to the source, a playtest\'s timeline, frames, charts and issues, Jobs, Engines', async () => {
      await nav('scenes');
      const sc = view('games3d:scenes');
      await sc.locator('[data-outline="game/levels/level_1.tscn"]').click();
      await sc.locator('[data-scene-outline] li').nth(5).waitFor();
      await shot('scenes');
      await nav('renders');
      const r = view('games3d:renders');
      await r.locator('[data-render]').nth(1).click();
      await r.locator('[data-render]').nth(0).click();
      await r.locator('[data-comparing] img').nth(1).waitFor({ timeout: 20_000 });
      await shot('renders-compare');
      await nav('builds');
      const b = view('games3d:builds');
      await b.locator('[data-build="b1"]').click();
      await b.locator('[data-build-page="b1"]').waitFor({ timeout: 20_000 });
      await b.locator('[data-problem-link="game/scripts/player.gd"]').first().click();
      await b.locator('[data-source-file="game/scripts/player.gd"] .at').waitFor({ timeout: 20_000 });
      assert.match(await b.locator('[data-source-file] .at').innerText(), /velocty/);
      await shot('build');
      await nav('playtests');
      const p = view('games3d:playtests');
      await p.locator('[data-playtest]').first().click();
      await p.locator('[data-playtest-page]').waitFor({ timeout: 20_000 });
      assert.equal(await p.locator('[data-event]').count(), 9);
      await p.locator('[data-chart="fps"]').waitFor();
      await p.locator('[data-chart="budgets"]').waitFor();
      await p.locator('[data-event="stuck"]').click();
      await p.locator('[data-big-frame][data-frame$="0120.png"] img').waitFor({ timeout: 20_000 });
      await p.locator('[data-recording] img').waitFor({ timeout: 20_000 });
      assert.equal(await p.locator('[data-issue]').count(), 2);
      await shot('playtest');
      await setSize(1360, 1500);
      await page.evaluate(() => { document.documentElement.style.zoom = '0.7'; });
      try { await page.waitForTimeout(600); await shot('playtest-full'); } finally { await page.evaluate(() => { document.documentElement.style.zoom = ''; }); await setSize(1360, 860); }
      await nav('jobs');
      await view('games3d:jobs').locator('[data-empty]').waitFor();
      await shot('jobs');
      await nav('engines');
      const e = view('games3d:engines');
      assert.equal(await e.locator('[data-engine]').count(), 5);
      await shot('engines');
    });

    let sid = '';
    await step('7. an agent opens Studio\'s views through its operations (asked first), and its results draw as Studio\'s cards', async () => {
      await page.click('[data-nav="core.chat:new"]');
      await page.waitForSelector('[data-home]');
      await page.click('[data-work-in]');
      await page.locator('[role="menuitemcheckbox"]', { hasText: path.basename(dir) }).click();
      if (await page.locator('[role="menu"]').count()) await page.keyboard.press('Escape');
      await send(`Show me the studio "${dir}"`);
      await page.waitForSelector('[data-session]', { timeout: 20_000 });
      sid = (await page.getAttribute('[data-session]', 'data-session'))!;
      for (const target of ['viewer', 'playtests'] as const) {
        const ask = page.locator(`[data-session="${sid}"] [data-attention] [data-pending="permission_request"]`).first();
        await ask.waitFor({ timeout: 40_000 });
        assert.match(await ask.innerText(), target === 'viewer' ? /games3d:open-model/ : /games3d:open-playtest/);
        await ask.locator('[data-decision="allow"]').click();
        if (target === 'viewer') {
          await view('games3d:viewer').locator('body[data-rendered="1"]').waitFor({ timeout: 40_000 });
          await shot('agent-opened-viewer');
        } else {
          await view('games3d:playtests').locator('[data-playtest-page="pt-20261023-1"]').waitFor({ timeout: 30_000 });
        }
        await page.click(`[data-session-row="${sid}"] button`);
        await page.waitForSelector(`[data-session="${sid}"]`);
      }
      await page.waitForSelector(`[data-session="${sid}"][data-status="idle"]`, { timeout: 60_000 });
      for (const st of await page.locator('[data-steps]').all()) if ((await st.getAttribute('data-open')) !== '1') await st.locator('button').first().click().catch(() => {});
      const card = page.frameLocator('[data-plugin-renderer="games3d:model-card"] iframe');
      await card.locator('[data-studio-card="model"] [data-thumb]').waitFor({ timeout: 30_000 });
      const sprite = page.frameLocator('[data-plugin-renderer="games3d:sprite-fence"] iframe');
      await sprite.locator('[data-studio-card="sprite"] canvas').waitFor({ timeout: 30_000 });
      const pt = page.frameLocator('[data-plugin-renderer="games3d:playtest-fence"] iframe');
      await pt.locator('[data-studio-card="playtest"][data-result="pass"]').waitFor({ timeout: 30_000 });
      const bd = page.frameLocator('[data-plugin-renderer="games3d:build-fence"] iframe');
      await bd.locator('[data-studio-card="build"][data-status="failed"]').waitFor({ timeout: 30_000 });
      assert.match(await bd.locator('[data-studio-card="build"]').innerText(), /velocty/);
      const hist = JSON.stringify((await api('GET', `/api/sessions/${sid}`)).body.history);
      assert.match(hist, /games3d:open-model/);
      assert.ok(!/"is_error":true/.test(hist), 'every call answered');
      await page.waitForTimeout(800);
      await shot('agent-conversation');
      await page.locator('[data-plugin-renderer="games3d:build-fence"]').scrollIntoViewIfNeeded();
      await shot('agent-cards');
    });

    await step('8. Studio off: the cards fall back to the plain tool card and the JSON, with a note; on again, drawn again', async () => {
      assert.equal((await api('POST', '/api/plugins/games3d/disable')).status, 200);
      await page.waitForSelector('[data-nav="games3d:projects"]', { state: 'detached', timeout: 20_000 });
      assert.equal(await page.locator('[data-plugin-renderer^="games3d:"]').count(), 0);
      for (const st of await page.locator('[data-steps]').all()) if ((await st.getAttribute('data-open')) !== '1') await st.locator('button').first().click().catch(() => {});
      const note = page.locator(`[data-session="${sid}"] [data-tool="model_info"] [data-plugin-off="games3d"]`).first();
      await note.waitFor({ timeout: 20_000 });
      assert.match(await note.innerText(), /Made with Studio, which is off/);
      await page.waitForTimeout(500);
      await shot('studio-off');
      assert.equal((await api('POST', '/api/plugins/games3d/enable')).status, 200);
      await page.waitForSelector('[data-plugin-renderer="games3d:model-card"]', { timeout: 30_000 });
    });

    t.diagnostic(`frame console errors: ${JSON.stringify(frameErrors.slice(0, 8))}`);
    const unexpected = errors.filter((e) => !(/^setup/.test(e.phase) && /(502|ERR_FAILED)/.test(e.text)));
    assert.deepEqual(unexpected, [], 'no errors in the window');
    // A request on its way when Studio is switched off finds its route gone: only then.
    assert.deepEqual(frameErrors.filter((e) => /\/plugins\/games3d\//.test(e.text) && !(/^8\./.test(e.phase) && /status of (404|503)/.test(e.text))), [], 'none in Studio\'s frames');
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(data, { recursive: true, force: true, maxRetries: 3 }); fs.rmSync(ws, { recursive: true, force: true, maxRetries: 3 }); } catch { /* in use (Windows) */ }
  }
});
