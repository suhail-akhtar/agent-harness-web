// Visual verification: the agent looks at what it made, the way a person will.
//   render       documents, slides, sheets, PDFs, Markdown, SVG, HTML -> page images + fit checks
//   browser      open a workspace page offline, drive it (keys, clicks), read state, screenshot
//   add_library  put three / pptxgenjs / docx / jszip into the workspace without the network
// Gates: documents-render, web-console, playtest (playtest.json scenarios).
// Renderers run on the server, on the session's workspace folder. For a
// companion session (the folder is on the user's computer) they work on a
// server-side copy that is refreshed with the files that changed, and anything
// they write (an exported PDF, saved renders, a browser export) is sent back.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { defineTool } from '../../src/plugins/api.ts';
import { resolveIn } from '../../src/tools/paths.ts';
import { closeBrowser, describePage, runPage } from './lib/browser.mjs';
import { addLibrary, LIBRARIES } from './lib/libraries.mjs';
import { describeRender, OFFICE, RENDERABLE, renderFile, saveRenders } from './lib/render.mjs';

const EXCLUDE = new Set(['node_modules', '.git', 'vendor', '.harness', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target']);
const asImages = (list) => list.map((i) => ({ media_type: i.media_type, data: Buffer.from(i.data).toString('base64') }));

/**
 * Where a server-side tool finds the files: the workspace itself, or for a
 * companion session a mirrored copy (with `push` to write results back).
 */
async function siteOf(host, signal) {
  if (host.kind !== 'companion') return { host, root: host.root, push: null };
  if (!host.mirror || !host.pushFile) throw new Error('This tool runs on the server and cannot see files on your computer with this companion: update the companion (download it again from the web app).');
  const root = await host.mirror(signal);
  return { host: { root, displayRoot: host.displayRoot }, root, push: (rel, data) => host.pushFile(rel.split(path.sep).join('/'), data, signal) };
}

async function workspacePath(host, p) {
  const real = await resolveIn(host, p);
  return path.relative(await fsp.realpath(host.root), real) || '.';
}

async function walk(root, exts, max = 12, depth = 4, rel = '') {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= max) break;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (depth > 0 && !EXCLUDE.has(e.name) && !e.name.startsWith('.')) out.push(...await walk(root, exts, max - out.length, depth - 1, r)); }
    else if (exts.includes(path.extname(e.name).toLowerCase()) && !e.name.startsWith('~$')) out.push(r);
  }
  return out;
}

const exists = (f) => fsp.stat(f).then(() => true, () => false);

/** index.html at the root or in public/: a page meant to open as it is. */
async function entryPage(root) {
  for (const p of ['index.html', 'public/index.html']) if (await exists(path.join(root, p))) return p;
  return null;
}

const OPS = {
  '==': (a, b) => JSON.stringify(a) === JSON.stringify(b), '!=': (a, b) => JSON.stringify(a) !== JSON.stringify(b),
  '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b,
  truthy: (a) => !!a, falsy: (a) => !a, includes: (a, b) => (Array.isArray(a) || typeof a === 'string') && a.includes(b),
  increased: (a, _b, before) => a > before, decreased: (a, _b, before) => a < before, changed: (a, _b, before) => JSON.stringify(a) !== JSON.stringify(before),
};
const parse = (s) => { try { return s === 'undefined' ? undefined : JSON.parse(s); } catch { return s; } };

/** Runs playtest.json scenarios: steps, then expectations on page state. */
export async function runPlaytests(root, signal, only, given) {
  // given: a spec from elsewhere (an evaluation's hidden scenarios) instead of the workspace's playtest.json.
  const spec = given ?? JSON.parse(await fsp.readFile(path.join(root, 'playtest.json'), 'utf8'));
  const scenarios = (spec.scenarios ?? []).filter((s) => !only || s.name === only);
  const results = [];
  for (const sc of scenarios.slice(0, 20)) {
    const expects = sc.expect ?? [];
    const before = expects.filter((e) => ['increased', 'decreased', 'changed'].includes(e.op));
    const actions = [...before.map((e) => ({ eval: e.eval })), ...(sc.steps ?? []), ...expects.map((e) => ({ eval: e.eval }))];
    const r = await runPage({ root, file: sc.page ?? spec.page ?? 'index.html', query: sc.query ?? '', viewport: spec.viewport ?? { width: 1280, height: 720 }, actions, waitMs: sc.waitMs ?? spec.waitMs ?? 800, signal });
    const values = r.evals.map((e) => parse(e.value));
    const failures = [];
    expects.forEach((e, i) => {
      const op = OPS[e.op ?? 'truthy'];
      const after = values[before.length + (sc.steps ?? []).filter((s) => 'eval' in s).length + i];
      const prev = values[before.indexOf(e)];
      if (!op) failures.push(`unknown op ${e.op}`);
      else if (typeof after === 'string' && after.startsWith('error:')) failures.push(`${e.eval} threw: ${after}`);
      else if (!op(after, e.value, prev)) failures.push(`expected ${e.eval} ${e.op ?? 'truthy'}${e.value !== undefined ? ` ${JSON.stringify(e.value)}` : ''}${prev !== undefined ? ` (before: ${JSON.stringify(prev)})` : ''}, got ${JSON.stringify(after)}`);
    });
    for (const t of r.timeouts) failures.push(`waited for ${t}, which never became true`);
    if (r.errors.length) failures.push(`uncaught errors: ${r.errors.join(' | ').slice(0, 600)}`);
    if (r.shots[0]?.stats.blank) failures.push('the screen is blank at the end');
    results.push({ name: sc.name ?? `scenario ${results.length + 1}`, pass: failures.length === 0, failures, shot: r.shots[0] });
  }
  return results;
}

export default {
  name: 'visual',
  close: closeBrowser,
  setup(api) {
    api.registerTool(defineTool({
      name: 'render',
      description: 'Render a document the way a reader sees it and look at the pages: .pptx/.docx/.xlsx/.odt/.odp/.pdf, .md, .html, .svg or an image. Returns page images plus checks that need no eyes: page count, words per page, and slide text that does not fit (cut off at the slide edge). Use it after you create or change a document, deck, chart or page, before you say it is done.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File in the workspace' },
          pages: { type: 'string', description: 'Pages to show, e.g. "1-3,7" (default: the first 4)' },
          width: { type: 'number', description: 'Image width in pixels, 400-1600 (default 1000; use 1400 to read small print)' },
          export: { type: 'string', enum: ['pdf'], description: 'Also save a PDF of an office file beside it (deck.pptx -> deck.pdf)' },
        },
        required: ['path'],
      },
      kind: 'read',
      kindsFor: (i) => (i.export ? ['read', 'edit'] : ['read']), // export writes a PDF into the workspace
      parallelSafe: true,
      summarize: (i) => `${i.path}${i.pages ? ` pages ${i.pages}` : ''}${i.export ? ' (export PDF)' : ''}`,
      async run(input, { host: h, signal, beforeWrite }) {
        const site = await siteOf(h, signal);
        const host = site.host;
        const rel = await workspacePath(host, String(input.path));
        if (!RENDERABLE.includes(path.extname(rel).toLowerCase())) return { content: `Cannot render ${rel}. Supported: ${RENDERABLE.join(' ')}`, is_error: true };
        const r = await renderFile({ root: host.root, rel, pages: input.pages, width: Math.min(Math.max(Number(input.width) || 1000, 400), 1600), max: 6, signal });
        if (input.export === 'pdf' && r.pdf && r.pdf !== path.join(host.root, rel)) {
          const out = rel.replace(/\.[^./]+$/, '.pdf');
          await beforeWrite?.(path.join(host.root, out));
          await fsp.copyFile(r.pdf, path.join(host.root, out));
          await site.push?.(out, await fsp.readFile(path.join(host.root, out)));
          r.exported = out;
        }
        const saved = await saveRenders(host.root, r);
        if (site.push) for (const f of saved) await site.push(f, await fsp.readFile(path.join(host.root, f)));
        return { content: describeRender(r, saved), images: asImages(r.images) };
      },
    }));

    api.registerTool(defineTool({
      name: 'browser',
      description: 'Open a page from the workspace in a headless browser (offline: only workspace files load), optionally drive it, and see the result: uncaught errors, console errors, missing files, a screenshot (flagged if blank), and values you read with JavaScript. For web apps, games and 3D scenes. actions run in order; each is one of {"wait": ms} {"press": "ArrowLeft", "hold": ms} {"down": key} {"up": key} {"type": "text"} {"click": "css selector" or [x, y]} {"move": [x, y]} {"drag": [[x1,y1],[x2,y2]]} {"scroll": dy} {"eval": "js expression"} {"waitFor": "js expression", "timeout": ms} {"screenshot": "label"}.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'HTML file in the workspace (default index.html)' },
          query: { type: 'string', description: 'Query string, e.g. "?seed=1&debug=1"' },
          width: { type: 'number' },
          height: { type: 'number' },
          actions: { type: 'array', items: { type: 'object' } },
          eval: { type: 'string', description: 'JavaScript expression read at the end, e.g. "window.game.state" (JSON result)' },
          screenshot: { type: 'boolean', description: 'Final screenshot (default true)' },
          save: { type: 'object', description: 'Write what a page expression returns into the workspace: {"path": "model.glb", "js": "window.exportGLB()"}. The expression may return a Promise, Blob, ArrayBuffer/typed array, data: URL, or text. For exports that need a browser (GLTFExporter, canvas.toDataURL).', properties: { path: { type: 'string' }, js: { type: 'string' } } },
          fullPage: { type: 'boolean' },
        },
      },
      kind: 'exec',
      kindsFor: (i) => (i.save ? ['exec', 'edit'] : ['exec']), // save writes a file into the workspace
      parallelSafe: true,
      summarize: (i) => `${i.save && typeof i.save === 'object' ? `save ${i.save.path} from ` : ''}${i.path ?? 'index.html'}${i.query ?? ''}${Array.isArray(i.actions) && i.actions.length ? ` +${i.actions.length} actions` : ''}`,
      async run(input, { host: h, signal, beforeWrite }) {
        const site = await siteOf(h, signal);
        const host = site.host;
        const rel = await workspacePath(host, String(input.path ?? 'index.html'));
        const sv = input.save && typeof input.save === 'object' ? input.save : null;
        let save;
        if (sv) {
          if (typeof sv.path !== 'string' || typeof sv.js !== 'string') return { content: 'save needs {"path": "...", "js": "..."}', is_error: true };
          const file = await resolveIn(host, sv.path);
          await beforeWrite?.(file);
          save = { file, js: sv.js, label: path.relative(await fsp.realpath(host.root), file) };
        }
        const r = await runPage({
          root: host.root, file: rel, query: typeof input.query === 'string' ? input.query : '',
          viewport: { width: Math.min(Math.max(Number(input.width) || 1280, 320), 1920), height: Math.min(Math.max(Number(input.height) || 720, 240), 1200) },
          actions: Array.isArray(input.actions) ? input.actions : [], evaluate: typeof input.eval === 'string' ? input.eval : undefined,
          screenshot: input.screenshot !== false, fullPage: input.fullPage === true, save, signal,
        });
        if (r.saved && save) r.saved.label = save.label;
        if (r.saved && save && site.push) await site.push(save.label, await fsp.readFile(save.file));
        return { content: describePage(r), is_error: r.errors.length > 0 && !r.shots.length, images: r.shots.map((s) => ({ media_type: 'image/png', data: s.png.toString('base64') })) };
      },
    }));

    api.registerTool(defineTool({
      name: 'add_library',
      description: `Copy a library into the workspace from the server's install (works offline, pinned versions). ${Object.entries(LIBRARIES).map(([k, v]) => `${k}: ${v.description}`).join(' ')}`,
      parameters: { type: 'object', properties: { name: { type: 'string', enum: Object.keys(LIBRARIES) } }, required: ['name'] },
      kind: 'edit',
      summarize: (i) => String(i.name),
      async run(input, { host, beforeWrite }) {
        if (host.kind === 'companion') return { content: 'add_library copies files from the server into a server workspace; on your computer, install the library with your package manager instead (e.g. npm install three).', is_error: true };
        await beforeWrite?.(path.join(host.root, 'package.json'));
        const r = await addLibrary(host.root, String(input.name));
        return `Added ${input.name} ${r.version}: ${r.files}\n${r.usage}`;
      },
    }));

    api.registerGate({
      name: 'documents-render',
      description: 'Every document in the workspace (docx, pptx, xlsx, odt, odp, pdf) opens and renders, and no slide has text cut off at its edge.',
      applies: async (h, signal) => (await walk((await siteOf(h, signal)).root, [...OFFICE, '.pdf'], 1)).length > 0,
      async run({ host: h, signal }) {
        const host = (await siteOf(h, signal)).host;
        const files = await walk(host.root, [...OFFICE, '.pdf'], 8);
        const problems = [];
        const ok = [];
        for (const f of files) {
          try {
            const r = await renderFile({ root: host.root, rel: f, pages: '0', max: 0, signal });
            await r.cleanup?.();
            const over = r.facts.filter((x) => x.overflow);
            const small = r.facts.filter((x) => x.smallText);
            if (!r.pages) problems.push(`${f}: no pages`);
            else if (over.length || small.length) problems.push(`${f}: ${[...over.map((x) => `slide ${x.page}: text does not fit (${x.overflow})`), ...small.map((x) => `slide ${x.page}: text too small (${x.smallText})`)].join('; ')}`);
            else ok.push(`${f} (${r.pages} pages)`);
          } catch (e) { problems.push(`${f}: ${e.message}`); }
        }
        return problems.length
          ? { pass: false, summary: `${problems.length} of ${files.length} document(s) have problems`, details: `${problems.join('\n')}\nRender a file with the render tool to see it.` }
          : { pass: true, summary: `${files.length} document(s) render: ${ok.join(', ')}` };
      },
    });

    api.registerGate({
      name: 'web-console',
      description: 'The workspace page (index.html) opens offline with no uncaught errors, console errors or missing files, and draws something.',
      applies: async (h, signal) => !!(await entryPage((await siteOf(h, signal)).root)),
      async run({ host: h, signal }) {
        const host = (await siteOf(h, signal)).host;
        const page = await entryPage(host.root);
        const r = await runPage({ root: host.root, file: page, waitMs: 2000, signal });
        const problems = [
          ...r.errors.map((e) => `uncaught: ${e}`),
          ...r.console.filter((c) => c.startsWith('error:')).map((c) => `console ${c}`),
          ...r.missing.map((m) => `missing ${m}`),
          ...r.blocked.map((b) => `needs the network: ${b} (put it in the workspace, e.g. add_library)`),
          ...(r.shots[0]?.stats.blank ? ['the page is blank after 2 s'] : []),
        ];
        return problems.length
          ? { pass: false, summary: `${page}: ${problems.length} problem(s)`, details: problems.join('\n') }
          : { pass: true, summary: `${page} opens cleanly${r.console.length ? ` (${r.console.length} warning(s))` : ''}` };
      },
    });

    api.registerGate({
      name: 'playtest',
      description: 'The scenarios in playtest.json pass: scripted input, then checks on the page state (window.* values).',
      applies: async (h, signal) => exists(path.join((await siteOf(h, signal)).root, 'playtest.json')),
      async run({ host: h, signal }) {
        const host = (await siteOf(h, signal)).host;
        let results;
        try { results = await runPlaytests(host.root, signal); } catch (e) { return { pass: false, summary: 'playtest.json could not run', details: e.message }; }
        if (!results.length) return { pass: false, summary: 'playtest.json has no scenarios' };
        const failed = results.filter((r) => !r.pass);
        return failed.length
          ? { pass: false, summary: `${failed.length} of ${results.length} playtest scenario(s) failed`, details: failed.map((f) => `${f.name}:\n  ${f.failures.join('\n  ')}`).join('\n') }
          : { pass: true, summary: `${results.length} playtest scenario(s) passed` };
      },
    });
  },
};
