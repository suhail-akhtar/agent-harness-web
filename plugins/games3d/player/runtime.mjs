// What the web driver puts into a game page before any of its scripts run (window.__studio):
//  - a seeded Math.random, so a run with the same seed and inputs plays the same;
//  - clock 'fixed': performance.now, Date, requestAnimationFrame and timers follow a virtual
//    clock the driver advances frame by frame. The game is frozen between steps (an agent can
//    think without the game running away), runs faster than real time for bots, and replays
//    exactly. Frame cost is measured as the real time each frame's callbacks take;
//  - clock 'real': the page runs normally; frame intervals are measured for fps;
//  - reading window.__game as plain JSON (getters included, depth and size bounded), draining
//    window.__game.events, a 16x9 luminance hash of the biggest canvas, and the canvas rect.

function studioRuntime(cfg) {
  if (window.__studio) return;
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const S = { clock: cfg.clock, errors: [], frames: 0, intervals: [], cpu: [], eventsSeen: 0, loopSeen: false };
  Object.defineProperty(window, '__studio', { value: S, enumerable: false });

  let seed = (cfg.seed >>> 0) || 1;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const record = (e) => { if (S.errors.length < 50) S.errors.push(String((e && e.stack) || e).split('\n').slice(0, 4).join('\n').slice(0, 800)); };
  S.record = record;

  // A macrotask boundary (all microtasks run): async game loops get their turn between frames.
  const channel = new MessageChannel();
  const waiting = [];
  channel.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
  const yieldTask = () => new Promise((r) => { waiting.push(r); channel.port2.postMessage(0); });

  if (cfg.clock === 'fixed') {
    let now = 0;
    let raf = new Map();
    let rafId = 0;
    const timers = new Map();
    let timerId = 0;
    const epoch = cfg.epoch;
    const RealDate = Date;
    performance.now = () => now;
    class StudioDate extends RealDate {
      constructor(...a) { if (a.length) super(...a); else super(epoch + now); }
      static now() { return epoch + now; }
    }
    window.Date = StudioDate;
    window.requestAnimationFrame = (cb) => { const id = ++rafId; raf.set(id, cb); S.loopSeen = true; return id; };
    window.cancelAnimationFrame = (id) => { raf.delete(id); };
    // Nested zero timeouts are clamped (as browsers do), so a timer chain cannot spin a frame forever.
    window.setTimeout = (fn, ms = 0, ...args) => { const id = ++timerId; timers.set(id, { at: now + Math.max(4, Number(ms) || 0), fn, args }); return id; };
    window.setInterval = (fn, ms = 0, ...args) => { const every = Math.max(4, Number(ms) || 0); const id = ++timerId; timers.set(id, { at: now + every, fn, args, every }); return id; };
    window.clearTimeout = (id) => { timers.delete(id); };
    window.clearInterval = (id) => { timers.delete(id); };
    const call = (fn, args) => { try { if (typeof fn === 'function') fn(...args); else (0, eval)(String(fn)); } catch (e) { record(e); } };

    S.advance = async (n, dt = 1000 / 60) => {
      for (let i = 0; i < n; i++) {
        const t0 = realNow();
        const end = now + dt;
        for (;;) {
          let due = null;
          for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
          if (!due) break;
          const [id, t] = due;
          now = Math.max(now, t.at);
          if (t.every) t.at += t.every; else timers.delete(id);
          call(t.fn, t.args);
        }
        now = end;
        const cbs = raf;
        raf = new Map();
        if (cbs.size) S.frames++;
        for (const cb of cbs.values()) call(cb, [now]);
        S.cpu.push(realNow() - t0);
        if (S.cpu.length > 4000) S.cpu.splice(0, 2000);
        // The last frame's picture is hashed before the task ends (a WebGL buffer is cleared after it).
        if (i === n - 1) S.lastHash = S.hash();
        else await yieldTask();
      }
      return S.status();
    };
    const intervals = () => { for (const t of timers.values()) if (t.every) return true; return false; };
    S.status = () => ({ now, raf: raf.size, frames: S.frames, errors: S.errors.length, loop: S.loopSeen || intervals() ? raf.size > 0 || intervals() : null });
  } else {
    let last = 0;
    let lastRequest = 0;
    const tick = (t) => {
      if (last) { S.intervals.push(t - last); if (S.intervals.length > 6000) S.intervals.splice(0, 3000); }
      last = t;
      S.frames++;
      realRaf(tick);
    };
    realRaf(tick);
    window.requestAnimationFrame = (cb) => { lastRequest = realNow(); S.loopSeen = true; return realRaf(cb); };
    S.advance = (n, dt = 1000 / 60) => new Promise((r) => realSetTimeout(() => { S.lastHash = S.hash(); r(S.status()); }, n * dt));
    // The game's loop is alive while it asked for a frame in the last second.
    S.status = () => ({ now: realNow(), frames: S.frames, errors: S.errors.length, loop: S.loopSeen ? realNow() - lastRequest < 1000 : null });
  }

  const isPlain = (v) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  function clone(v, d) {
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') return num(v);
    if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}...` : v;
    if (typeof v !== 'object') return undefined;
    if (d > 4) return undefined;
    if (typeof Node !== 'undefined' && v instanceof Node) return undefined;
    if (v === window || v.isObject3D || v.isMaterial || v.isTexture || v.isBufferGeometry) return undefined;
    if (v.isVector3) return { x: num(v.x), y: num(v.y), z: num(v.z) };
    if (v.isVector2) return { x: num(v.x), y: num(v.y) };
    if (ArrayBuffer.isView(v)) return v.length <= 16 ? Array.from(v, num) : undefined;
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => { const c = clone(x, d + 1); return c === undefined ? null : c; });
    if (v instanceof Map) return clone(Object.fromEntries([...v.entries()].slice(0, 40)), d);
    if (v instanceof Set) return clone([...v].slice(0, 40), d);
    const out = {};
    const keys = new Set();
    for (const k in v) keys.add(k);
    // Class instances keep their getters on the prototype.
    if (!isPlain(v)) {
      for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
        for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && Object.getOwnPropertyDescriptor(p, k)?.get) keys.add(k);
      }
    }
    let n = 0;
    for (const k of keys) {
      if (k === 'events' && d === 0) continue;
      if (n++ >= 60) break;
      let x;
      try { x = v[k]; } catch { continue; }
      const c = clone(x, d + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  S.state = () => {
    let g;
    try { g = window.__game; } catch { return undefined; }
    if (g === undefined || g === null) return undefined;
    try { return clone(g, 0); } catch (e) { return { error: String(e) }; }
  };
  S.drainEvents = () => {
    const list = window.__game && Array.isArray(window.__game.events) ? window.__game.events : null;
    if (!list) return [];
    if (list.length < S.eventsSeen) S.eventsSeen = 0;
    const out = list.slice(S.eventsSeen, S.eventsSeen + 50).map((e) => clone(e, 1));
    S.eventsSeen = list.length;
    return out;
  };
  const biggestCanvas = () => {
    let best = null, area = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > area) { area = a; best = c; }
    }
    return best;
  };
  S.canvasRect = () => {
    const c = biggestCanvas();
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth - Math.max(0, r.left)), height: Math.min(r.height, innerHeight - Math.max(0, r.top)) };
  };
  let hc = null;
  S.hash = () => {
    const c = biggestCanvas();
    if (!c || !c.width || !c.height) return null;
    try {
      hc ??= document.createElement('canvas');
      hc.width = 16; hc.height = 9;
      const g = hc.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, 16, 9);
      g.drawImage(c, 0, 0, 16, 9);
      const d = g.getImageData(0, 0, 16, 9).data;
      let s = '';
      for (let i = 0; i < d.length; i += 4) s += Math.min(15, Math.floor((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 16)).toString(16);
      return s;
    } catch { return null; }
  };
  S.memoryMb = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
  S.yieldTask = yieldTask;
}

/** The init script for a page: the runtime above, called with its settings. */
export function runtimeScript({ clock = 'fixed', seed = 1, epoch = Date.UTC(2026, 0, 1) } = {}) {
  return `(${studioRuntime.toString()})(${JSON.stringify({ clock, seed, epoch })});`;
}
