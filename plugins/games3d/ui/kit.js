// A few helpers Studio's frames share: connecting through the SDK, building DOM safely (text is
// always text: what the pages show comes from workspaces, never trusted as HTML), formatting, a
// small Markdown reader, keeping a frame's height to its content, and Studio's own: its routes,
// files as blob URLs (frames have no network: files come through the routes), icons.
(function () {
  'use strict';
  const Kit = {};

  /** h('div', {class: 'x', onclick}, 'text', child...) */
  Kit.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  };
  Kit.clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  Kit.mount = (el, ...kids) => { Kit.clear(el).append(...kids.flat(Infinity).filter((x) => x !== undefined && x !== null && x !== false).map((x) => (x instanceof Node ? x : document.createTextNode(String(x))))); return el; };

  Kit.ago = function ago(t) {
    const ms = Date.now() - (typeof t === 'number' ? t : Date.parse(t));
    if (!Number.isFinite(ms)) return '';
    if (ms < 45_000) return 'just now';
    const m = Math.round(ms / 60_000);
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 48) return `${hr} h ago`;
    return `${Math.round(hr / 24)} d ago`;
  };
  Kit.age = function age(t) {
    const ms = Date.now() - (typeof t === 'number' ? t : Date.parse(t));
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60_000);
    if (m < 60) return `${m}m`;
    const hr = Math.floor(m / 60);
    if (hr < 48) return `${hr}h ${m % 60}m`;
    return `${Math.floor(hr / 24)}d`;
  };
  Kit.money = (v) => (typeof v === 'number' && v > 0 ? (v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`) : '$0.00');
  Kit.dur = (a, b) => { const ms = (b ?? Date.now()) - a; if (!(ms >= 0)) return ''; return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`; };
  Kit.time = (t) => { const d = new Date(t); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  Kit.chip = (text, tone) => Kit.h('span', { class: `chip ${tone || ''}` }, text);

  /** Cites like [ev-1a2b3c] as marked spans. */
  Kit.withEvidence = function (text) {
    const out = [];
    let last = 0;
    const s = String(text ?? '');
    for (const m of s.matchAll(/\bev-[0-9a-f]{6}\b/g)) { out.push(s.slice(last, m.index)); out.push(Kit.h('span', { class: 'ev', title: 'Evidence the harness recorded' }, m[0])); last = m.index + m[0].length; }
    out.push(s.slice(last));
    return out;
  };

  function inline(text) {
    // `code`, **bold**, evidence ids; everything else stays text.
    const parts = [];
    const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(...Kit.withEvidence(text.slice(last, m.index)));
      parts.push(m[1] !== undefined ? Kit.h('code', {}, m[1]) : Kit.h('b', {}, m[2]));
      last = m.index + m[0].length;
    }
    parts.push(...Kit.withEvidence(text.slice(last)));
    return parts;
  }

  /** A small, safe Markdown reader: headings, lists, code blocks, tables, paragraphs. */
  Kit.markdown = function markdown(src) {
    const root = Kit.h('div', { class: 'prose' });
    const lines = String(src ?? '').replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const body = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i++;
        root.append(Kit.h('pre', {}, Kit.h('code', {}, body.join('\n'))));
        continue;
      }
      const hd = /^(#{1,4})\s+(.*)$/.exec(line);
      if (hd) { root.append(Kit.h(`h${Math.min(3, hd[1].length)}`, {}, inline(hd[2]))); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(line); i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        root.append(Kit.h('table', {}, Kit.h('thead', {}, Kit.h('tr', {}, head.map((c) => Kit.h('th', {}, inline(c))))), Kit.h('tbody', {}, rows.map((r) => Kit.h('tr', {}, r.map((c) => Kit.h('td', {}, inline(c))))))));
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const list = Kit.h(ordered ? 'ol' : 'ul', {});
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { list.append(Kit.h('li', {}, inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')))); i++; }
        root.append(list);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
      root.append(Kit.h('p', {}, inline(para.join(' '))));
    }
    return root;
  };

  /** Keeps a frame that is not full-height (a home card, a renderer) as tall as its content. */
  Kit.autoHeight = function (harness) {
    let last = 0;
    const send = () => { const hgt = Math.ceil(document.body.getBoundingClientRect().height); if (Math.abs(hgt - last) > 2) { last = hgt; harness.frame.resize(hgt).catch(() => {}); } };
    new ResizeObserver(send).observe(document.body);
    send();
  };

  /** Connects to the host; shows why when it cannot (opened outside the app). */
  Kit.start = function start(run) {
    const sdk = window.HarnessPluginUI;
    const fail = (e) => {
      document.body.dataset.error = '1';
      document.body.append(Kit.h('div', { class: 'error', style: { margin: '16px' } }, `This page runs inside the app. ${e && e.message ? e.message : e}`));
    };
    if (!sdk) { fail(new Error('the plugin SDK did not load')); return; }
    sdk.connect().then(async (harness) => {
      try { await run(harness); document.body.dataset.ready = '1'; } catch (e) { fail(e); }
    }, fail);
  };

  /** Calls a route of this plugin; a refusal comes back as an Error with the host's reason. */
  Kit.route = (harness, path, body) => harness.routes.call(path, body === undefined ? { method: 'GET' } : { method: 'POST', body });

  /** Runs fn now and again on events of the topics and every `ms` (faster while `busy()` says so). */
  Kit.live = async function live(harness, fn, { topics = ['session', 'sessions'], ms = 15_000, busyMs = 2_500, busy = () => false } = {}) {
    let timer; let running = false; let again = false;
    const tick = async () => {
      if (running) { again = true; return; }
      running = true;
      try { await fn(); } catch (e) { console.warn(e); } finally { running = false; }
      if (again) { again = false; return tick(); }
      clearTimeout(timer);
      timer = setTimeout(tick, busy() ? busyMs : ms);
    };
    let soon;
    for (const t of topics) await harness.events.subscribe(t, () => { clearTimeout(soon); soon = setTimeout(tick, 300); }).catch(() => {});
    await tick();
    return () => clearTimeout(timer);
  };

  // ---------------- Studio ----------------

  /** Calls one of Studio's routes (studio/<p>); args go as a POST body. */
  Kit.studio = (harness, p, args) => harness.routes.call(`studio/${p}`, args === undefined ? { method: 'GET' } : { method: 'POST', body: args });

  /** How a view names a file: {project, asset, root, session, library, path} from its params. */
  Kit.fileArgs = function (params, extra) {
    const a = {};
    for (const k of ['project', 'asset', 'root', 'session', 'path']) if (params && typeof params[k] === 'string' && params[k]) a[k] = params[k];
    if (params && (params.library === '1' || params.library === 'true' || params.library === true)) a.library = true;
    return Object.assign(a, extra || {});
  };

  /** How to name an asset's files (an asset card from studio/assets): its project and folder, or the library. */
  Kit.assetArgs = (a) => (a.library ? { asset: a.ref } : { project: a.project, asset: a.folder || a.folderName || a.id });
  /** The view params that open an asset's file in a viewer. */
  Kit.assetParams = (a, path) => (a.library ? { asset: a.ref, path } : { project: a.project, asset: a.folder || a.folderName || a.id, path });

  Kit.bytes = function (b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };

  // At most four file reads at once (a grid of thumbnails asks for many).
  let active = 0;
  const waiting = [];
  const slot = () => new Promise((resolve) => { if (active < 4) { active++; resolve(); } else waiting.push(resolve); });
  const free = () => { const next = waiting.shift(); if (next) next(); else active--; };

  /** A file through studio/file: { name, size, mime, bytes }. */
  Kit.readFile = async function (harness, args) {
    await slot();
    try {
      const f = await Kit.studio(harness, 'file', args);
      return { name: f.name, size: f.size, mime: f.mime, mtime: f.mtime, bytes: Kit.bytes(f.base64) };
    } finally { free(); }
  };
  const urls = new Map();
  /** A blob: URL for a file (images, audio), remembered for the page's life. */
  Kit.fileUrl = function (harness, args) {
    const key = JSON.stringify(args);
    if (!urls.has(key)) {
      urls.set(key, Kit.readFile(harness, args).then((f) => URL.createObjectURL(new Blob([f.bytes], { type: f.mime }))));
      urls.get(key).catch(() => urls.delete(key));
    }
    return urls.get(key);
  };
  /** An <img> that loads its file through the routes (a quiet placeholder until then, or if it fails). */
  Kit.img = function (harness, args, attrs) {
    const el = Kit.h('img', Object.assign({ alt: '', loading: 'lazy', decoding: 'async' }, attrs || {}));
    el.style.opacity = '0';
    el.addEventListener('load', () => { el.style.transition = 'opacity .18s'; el.style.opacity = '1'; });
    Kit.fileUrl(harness, args).then((u) => { el.src = u; }, (e) => { el.dataset.failed = e && e.message ? e.message.slice(0, 120) : '1'; el.replaceWith(Kit.glyph('image', 'not readable')); });
    return el;
  };

  Kit.size = (n) => (typeof n !== 'number' ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  Kit.secs = (s) => (typeof s !== 'number' ? '' : s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')} min`);
  Kit.num = (n) => (typeof n !== 'number' ? '' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  Kit.base = (p) => String(p || '').split(/[\\/]/).pop();

  const ICONS = {
    box: 'M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5Zm0 0v19M3.5 7 12 11.5 20.5 7',
    image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4 2.5-2.5L20 18M15.5 9.5a1 1 0 1 0 0 .01',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
    music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3Zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z',
    map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
    play: 'M7 4v16l13-8L7 4Z',
    font: 'M5 20 12 4l7 16M8 14h8',
    palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.7 1.5-1.5 0-1.2-1-1.6-1-2.6 0-.8.7-1.4 1.5-1.4H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5ZM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  };
  /** A small line icon (SVG built from paths, never from text). */
  Kit.icon = function (name, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', String(size || 22)); s.setAttribute('height', String(size || 22));
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', ICONS[name] || ICONS.file); s.append(p);
    return s;
  };
  Kit.glyph = (name, text) => Kit.h('div', { class: 'glyph' }, Kit.icon(name, 26), text ? Kit.h('span', {}, text) : null);
  Kit.kindIcon = (kind) => ({ model: 'box', sprite: 'image', spritesheet: 'film', tileset: 'grid', texture: 'image', material: 'palette', audio: 'music', music: 'music', font: 'font', ui: 'image', level: 'map', heightmap: 'map' }[kind] || 'file');
  const ENGINE_NAMES = { web: 'Web', godot: 'Godot', unreal: 'Unreal', unity: 'Unity', blender: 'Blender' };
  Kit.engineName = (e) => ENGINE_NAMES[e] || String(e || 'web');
  Kit.logo = (engine, small) => Kit.h('span', { class: `logo ${small ? 'sm' : ''} ${engine}`, 'aria-hidden': 'true' }, { web: 'W', godot: 'Go', unreal: 'UE', unity: 'U', blender: 'B' }[engine] || '?');

  /**
   * Whether a project's engine can be driven here: its engine plugin is on (the web always; Blender
   * and Godot also through Studio's own tools). Otherwise the project opens read-only with a note.
   */
  Kit.engineOn = async function (harness, engine) {
    if (!engine || engine === 'web') return true;
    const has = async (q) => { try { return await harness.registry.has(q); } catch { return false; } };
    if (await has({ plugin: `engine-${engine}` })) return true;
    return engine === 'blender' || engine === 'godot';
  };

  /**
   * The frames of a sprite sheet: its animations, each a list of {x, y} cells of fw x fh. From a
   * frames JSON ({animations: {name: {fps, frames: [{x, y, w, h}]}}}), the asset's meta (anims
   * {name: count} one row each, with padding; or animations {name: [first, last] | [i, j...]}),
   * else every cell of the grid in order (up to meta.frames).
   */
  Kit.sheetFrames = function (meta, imgW, imgH, o) {
    const m = meta || {}; const opt = o || {};
    const pos = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.round(x) : undefined; };
    const fsz = Array.isArray(m.frameSize) ? m.frameSize : [];
    const fps = pos(opt.fps) || pos(m.fps) || 8;
    if (opt.json && opt.json.animations && typeof opt.json.animations === 'object') {
      const anims = Object.entries(opt.json.animations).map(([name, a]) => ({ name, fps: pos(a && a.fps) || fps, frames: (Array.isArray(a && a.frames) ? a.frames : []).map((f) => ({ x: Number(f.x) || 0, y: Number(f.y) || 0 })) })).filter((a) => a.frames.length);
      const f0 = Object.values(opt.json.animations)[0]?.frames?.[0];
      if (anims.length) return { fw: pos(opt.json.frameWidth) || pos(f0 && f0.w) || 16, fh: pos(opt.json.frameHeight) || pos(f0 && f0.h) || 16, anims, from: 'frames JSON' };
    }
    let fw = pos(opt.frameWidth) || pos(fsz[0]); let fh = pos(opt.frameHeight) || pos(fsz[1]) || fw;
    const pad = Number(m.padding) > 0 ? Math.round(Number(m.padding)) : 0;
    if (!fw) {
      const n = pos(opt.frames) || pos(m.frames);
      fh = imgH; fw = n ? Math.floor(imgW / n) : imgH;
    }
    const cols = Math.max(1, Math.floor((imgW + pad) / (fw + pad))); const rows = Math.max(1, Math.floor((imgH + pad) / (fh + pad)));
    const cell = (i) => ({ x: (i % cols) * (fw + pad), y: Math.floor(i / cols) * (fh + pad) });
    if (m.anims && typeof m.anims === 'object' && !Array.isArray(m.anims) && Object.values(m.anims).every((v) => typeof v === 'number')) {
      const anims = Object.entries(m.anims).slice(0, rows).map(([name, n], row) => ({ name, fps, frames: Array.from({ length: Math.min(cols, Math.max(1, Math.round(n))) }, (_, i) => ({ x: i * (fw + pad), y: row * (fh + pad) })) }));
      if (anims.length) return { fw, fh, cols, rows, pad, anims, from: 'rows' };
    }
    const total = Math.min(cols * rows, pos(opt.frames) || pos(m.frames) || cols * rows);
    if (m.animations && typeof m.animations === 'object' && !Array.isArray(m.animations)) {
      const anims = Object.entries(m.animations).map(([name, v]) => {
        const idx = Array.isArray(v) ? (v.length === 2 && v[1] > v[0] + 1 ? Array.from({ length: v[1] - v[0] + 1 }, (_, i) => v[0] + i) : v.map(Number)) : [];
        return { name, fps, frames: idx.filter((i) => i >= 0 && i < cols * rows).map(cell) };
      }).filter((a) => a.frames.length);
      if (anims.length) return { fw, fh, cols, rows, pad, anims, from: 'animations' };
    }
    return { fw, fh, cols, rows, pad, anims: [{ name: 'all frames', fps, frames: Array.from({ length: total }, (_, i) => cell(i)) }], from: 'grid' };
  };

  /** A small confirm dialog in the page (the buttons that start something ask first). */
  Kit.confirm = function (title, body, ok) {
    return new Promise((resolve) => {
      const done = (v) => { back.remove(); resolve(v); };
      const back = Kit.h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) done(false); } },
        Kit.h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          Kit.h('h2', {}, title), Kit.h('div', { class: 'small', style: { whiteSpace: 'pre-wrap', color: 'var(--hx-text-secondary)' } }, body),
          Kit.h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } },
            Kit.h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'Cancel'),
            Kit.h('button', { type: 'button', class: 'btn primary', 'data-confirm': '', onclick: () => done(true) }, ok || 'Continue'))));
      document.body.append(back);
      back.querySelector('[data-confirm]').focus();
      back.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
    });
  };

  window.Kit = Kit;
})();
