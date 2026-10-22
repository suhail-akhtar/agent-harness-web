// A few helpers the plugin's frames share: connecting through the SDK, building DOM safely (text is
// always text: what the pages show comes from workspaces and monitoring, never trusted as HTML),
// formatting, a small Markdown reader, and keeping a frame's height to its content.
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

  window.Kit = Kit;
})();
