// The web driver: a game page from the workspace, served on 127.0.0.1 and played in the visual
// plugin's offline headless Chromium (one shared browser, a context per session, every other
// request blocked). Input goes in as real keyboard and mouse events; the page's clock is the
// studio runtime's (runtime.mjs), fixed by default.

import { serveDir, withBrowser } from '@harness/plugins/visual/lib/browser.mjs';
import { frameMetrics } from './analysis.mjs';
import { prepareFrame } from './frames.mjs';
import { runtimeScript } from './runtime.mjs';

const FRAME_MS = 1000 / 60;
const TAP_MS = 50;

/** Starts a play session on a web game. See driver.mjs for the session interface. */
export async function startWebSession(opts) {
  const s = new WebSession(opts);
  await s.open();
  return s;
}

class WebSession {
  constructor({ root, game = 'index.html', query = '', seed = 1, clock = 'fixed', viewport, bootMs = 500, frameWidth = 512, signal }) {
    this.root = root;
    this.game = String(game).replace(/\\/g, '/').replace(/^\/+/, '');
    this.query = query && !String(query).startsWith('?') ? `?${query}` : String(query ?? '');
    this.seed = Number.isFinite(Number(seed)) ? Number(seed) : 1;
    this.clock = clock === 'real' ? 'real' : 'fixed';
    this.viewport = { width: Math.min(Math.max(Number(viewport?.width) || 960, 320), 1920), height: Math.min(Math.max(Number(viewport?.height) || 600, 240), 1200) };
    this.bootMs = bootMs;
    this.frameWidth = frameWidth;
    this.signal = signal;
    this.t = 0;
    this.frames = 0;
    this.pending = [];
    this.held = new Set();
    this.timeline = [];
    this.pageErrors = [];
    this.console = [];
    this.blocked = [];
    this.missing = [];
    this.pageSeen = 0;
    this.runtimeSeen = 0;
    this.runtimeErrors = [];
    this.crashed = false;
    this.closed = false;
    this.lastState = undefined;
    this.frameMap = null;
    this.engine = 'web';
  }

  get info() {
    const st = this.lastState && typeof this.lastState === 'object' ? this.lastState : {};
    return {
      engine: 'web', game: this.game, query: this.query, seed: this.seed, clock: this.clock, viewport: this.viewport,
      inputs: Array.isArray(st.inputs) ? st.inputs.filter((k) => typeof k === 'string') : Array.isArray(st.keys) ? st.keys.filter((k) => typeof k === 'string') : null,
      controls: st.controls && typeof st.controls === 'object' ? st.controls : null,
      hasState: this.lastState !== undefined,
    };
  }

  async open() {
    this.srv = await serveDir(this.root);
    let release;
    this.held_ = new Promise((r) => { release = r; });
    this.release = release;
    await new Promise((resolve, reject) => {
      this.browserDone = withBrowser(async (browser) => {
        try {
          this.ctx = await browser.newContext({ viewport: this.viewport, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false });
          await this.ctx.route('**/*', (route) => {
            const u = route.request().url();
            if (u.startsWith(`${this.srv.origin}/`)) return route.continue();
            if (this.blocked.length < 20) this.blocked.push(u.slice(0, 200));
            return route.abort('blockedbyclient');
          });
          await this.ctx.routeWebSocket?.(/.*/, (ws) => ws.close());
          await this.ctx.addInitScript(runtimeScript({ clock: this.clock, seed: this.seed }));
          this.page = await this.ctx.newPage();
          this.page.on('console', (m) => {
            const t = m.type();
            if ((t === 'error' || t === 'warning') && this.console.length < 60) this.console.push(`${t}: ${m.text()}`.slice(0, 500));
          });
          this.page.on('pageerror', (e) => { if (this.pageErrors.length < 50) this.pageErrors.push(String(e?.stack ?? e).split('\n').slice(0, 4).join('\n').slice(0, 800)); });
          this.page.on('crash', () => { this.crashed = true; });
          this.page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(this.srv.origin) && this.missing.length < 20) this.missing.push(`${r.status()} ${r.url().slice(this.srv.origin.length)}`); });
          this.url = `${this.srv.origin}/${this.game}${this.query}`;
          await this.page.goto(this.url, { waitUntil: 'load', timeout: 30_000 });
          this.startedAt = Date.now();
          resolve();
        } catch (e) { reject(e); return; }
        await this.held_;
        await this.ctx.close().catch(() => {});
      }).catch(reject);
    }).catch(async (e) => { this.release?.(); await this.srv.close(); throw e; });
    this.signal?.addEventListener('abort', () => { this.stop().catch(() => {}); }, { once: true });
    // A game still loading its files (window.__game.state "loading", or ready === false) gets real
    // time for it, a frame at a time: its clock does not run ahead while the files arrive.
    // A module game sets window.__game only once its scripts (Three.js...) are in: up to 2 s for that.
    for (let i = 0; i < 400; i++) {
      const loading = await this.page.evaluate(() => { try { const g = window.__game; return g === undefined ? 'none' : g.ready === false || g.state === 'loading'; } catch { return false; } }).catch(() => false);
      if (!loading || (loading === 'none' && i >= 80)) break;
      await this.page.waitForTimeout(25);
      if (this.clock === 'fixed') await this.advance(FRAME_MS);
    }
    if (this.bootMs) await this.advance(this.bootMs);
    // The state only (info.inputs): errors and events stay for the first observation.
    this.lastState = await this.page.evaluate(() => window.__studio?.state()).catch(() => undefined);
  }

  /** Page coordinates for a point in the last frame the agent saw. */
  toPage([x, y], page = false) {
    if (page || !this.frameMap) return [Number(x), Number(y)];
    const m = this.frameMap;
    return [m.x + Number(x) * m.scale, m.y + Number(y) * m.scale];
  }

  resolveKey(input) {
    if (input.key) return String(input.key);
    if (input.action) {
      const c = this.info.controls;
      const k = c?.[input.action];
      if (typeof k === 'string') return k;
      if (Array.isArray(k) && typeof k[0] === 'string') return k[0];
      throw new Error(`the game names no key for the action "${input.action}" (window.__game.controls)`);
    }
    return null;
  }

  /**
   * Turns inputs into timed low-level events from now: a key with ms is held that long, a key
   * alone is tapped, down/up hold or let go; mouse [x, y] in frame pixels (page: true for page
   * pixels) with click, down, up or move. `at` delays an input within the step (ms).
   */
  schedule(inputs = []) {
    for (const raw of Array.isArray(inputs) ? inputs : [inputs]) {
      if (!raw || typeof raw !== 'object') continue;
      const at = this.t + Math.max(0, Number(raw.at) || 0);
      if (raw.mouse) {
        const [x, y] = this.toPage(raw.mouse, raw.page === true);
        const button = raw.button === 'right' ? 'right' : 'left';
        this.pending.push({ t: at, type: 'move', x, y });
        if (raw.click || raw.press) this.pending.push({ t: at, type: 'mousedown', x, y, button }, { t: at + (Number(raw.ms) || TAP_MS), type: 'mouseup', x, y, button });
        else if (raw.down) this.pending.push({ t: at, type: 'mousedown', x, y, button });
        else if (raw.up) this.pending.push({ t: at, type: 'mouseup', x, y, button });
        continue;
      }
      const key = this.resolveKey(raw);
      if (!key) continue;
      if (raw.down) this.pending.push({ t: at, type: 'down', key });
      else if (raw.up) this.pending.push({ t: at, type: 'up', key });
      else {
        const ms = Math.max(FRAME_MS, Number(raw.ms) || TAP_MS);
        this.pending.push({ t: at, type: 'down', key }, { t: at + ms, type: 'up', key });
      }
    }
    this.pending.sort((a, b) => a.t - b.t);
    return this.pending.length ? this.pending[this.pending.length - 1].t - this.t : 0;
  }

  async apply(ev) {
    const kb = this.page.keyboard, mouse = this.page.mouse;
    if (ev.type === 'down') { if (this.held.has(ev.key)) return; this.held.add(ev.key); await kb.down(ev.key); }
    else if (ev.type === 'up') { if (!this.held.has(ev.key)) return; this.held.delete(ev.key); await kb.up(ev.key); }
    else if (ev.type === 'move') await mouse.move(ev.x, ev.y);
    else if (ev.type === 'mousedown') await mouse.down({ button: ev.button });
    else if (ev.type === 'mouseup') await mouse.up({ button: ev.button });
    this.timeline.push({ ...ev, t: Math.round(this.t * 100) / 100 });
  }

  /** Runs the game for ms (game time), applying scheduled inputs at their frames. */
  async advance(ms) {
    if (this.closed) throw new Error('the session has stopped');
    const end = this.t + Math.max(0, Number(ms) || 0);
    const half = FRAME_MS / 2;
    for (;;) {
      while (this.pending.length && this.pending[0].t <= this.t + half) await this.apply(this.pending.shift());
      if (this.t >= end - half) break;
      const target = Math.min(end, this.pending.length ? this.pending[0].t : end);
      if (this.clock === 'fixed') {
        const n = Math.max(1, Math.round((target - this.t) / FRAME_MS));
        this.status = await this.page.evaluate((k) => window.__studio.advance(k), n);
        this.frames += n;
        this.t += n * FRAME_MS;
      } else {
        await this.page.waitForTimeout(Math.max(1, target - this.t));
        this.t = Math.max(target, this.t + 1);
      }
    }
    if (this.clock === 'real') this.status = await this.page.evaluate(() => window.__studio.status()).catch(() => this.status);
  }

  /** Low-level events at absolute game times (a recording's), applied as the game reaches them. */
  inject(events) {
    for (const e of events) if (e && typeof e.t === 'number' && ['down', 'up', 'move', 'mousedown', 'mouseup'].includes(e.type)) this.pending.push({ ...e });
    this.pending.sort((a, b) => a.t - b.t);
  }

  /** Applies inputs now (taps let go on the next advance). */
  async act(inputs) {
    this.schedule(inputs);
    await this.advance(0);
  }

  /** Inputs, then ms of game time (default: until the last input ends, at least one frame), then an observation. */
  async step(inputs, ms, observe = {}) {
    const span = this.schedule(inputs);
    await this.advance(ms !== undefined && ms !== null ? Number(ms) : Math.max(span, FRAME_MS));
    return this.observe(observe);
  }

  async capture(width = this.frameWidth) {
    const rect = await this.page.evaluate(() => window.__studio?.canvasRect() ?? null).catch(() => null);
    const vp = this.viewport;
    const useCanvas = rect && rect.width * rect.height >= 0.15 * vp.width * vp.height;
    const clip = useCanvas ? { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.max(1, Math.floor(rect.width)), height: Math.max(1, Math.floor(rect.height)) } : { x: 0, y: 0, width: vp.width, height: vp.height };
    const png = await this.page.screenshot({ clip, timeout: 15_000 });
    const f = prepareFrame(png, width);
    this.frameMap = { x: clip.x, y: clip.y, scale: clip.width / f.width };
    return { ...f, t: this.t };
  }

  /** The state, the events since the last observation, new errors, and (frame: true) a frame. */
  async observe({ frame = true, width } = {}) {
    if (this.closed) throw new Error('the session has stopped');
    const got = await this.page.evaluate(() => {
      const S = window.__studio;
      if (!S) return null;
      return { state: S.state(), events: S.drainEvents(), status: S.status(), hash: S.lastHash ?? S.hash(), errors: S.errors.slice(), memoryMb: S.memoryMb() };
    }).catch((e) => ({ failed: String(e?.message ?? e).split('\n')[0] }));
    if (!got || got.failed) {
      const why = got?.failed ?? 'the studio runtime is missing from the page';
      if (/crash|closed|Target/i.test(why)) this.crashed = true;
      return { t: this.t, state: undefined, events: [{ t: this.t / 1000, type: 'crash', detail: why }], errors: [], crashed: true, status: null };
    }
    // Uncaught errors from event handlers (pageerror) and from frame callbacks and timers (the runtime).
    const fresh = [...this.pageErrors.slice(this.pageSeen), ...got.errors.slice(this.runtimeSeen)];
    this.pageSeen = this.pageErrors.length;
    this.runtimeSeen = got.errors.length;
    this.runtimeErrors = got.errors;
    this.lastState = got.state;
    this.memoryMb = got.memoryMb ?? this.memoryMb;
    const out = {
      t: this.t, state: got.state, events: (got.events ?? []).map((e) => ({ t: Math.round(this.t) / 1000, type: String(e?.type ?? 'game'), detail: typeof e?.detail === 'string' ? e.detail : JSON.stringify(e?.detail ?? e).slice(0, 200) })),
      errors: fresh, status: got.status, hash: got.hash, crashed: this.crashed,
      loopStopped: got.status?.loop === false,
    };
    if (frame) out.frame = await this.capture(width ?? this.frameWidth);
    return out;
  }

  async metrics() {
    const raw = this.closed ? this.lastRaw : await this.page.evaluate(() => ({ intervals: window.__studio?.intervals ?? [], cpu: window.__studio?.cpu ?? [] })).catch(() => null);
    this.lastRaw = raw ?? this.lastRaw;
    return { clock: this.clock, ...frameMetrics(raw ?? {}), memoryMb: this.memoryMb ?? null, gameSeconds: Math.round(this.t) / 1000, realSeconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 100) / 10 : 0 };
  }

  /** The inputs as they went in, with what replays them exactly (clock fixed). */
  recording() {
    return { version: 1, engine: 'web', game: this.game, query: this.query, seed: this.seed, clock: this.clock, viewport: this.viewport, bootMs: this.bootMs, durationMs: Math.round(this.t), events: this.timeline.slice() };
  }

  async stop() {
    if (this.closed) return this.final;
    let metrics = null;
    try {
      // Let go of held keys, so the recording ends clean.
      for (const k of [...this.held]) await this.apply({ type: 'up', key: k }).catch(() => {});
      this.runtimeErrors = await this.page.evaluate(() => window.__studio?.errors.slice() ?? []).catch(() => this.runtimeErrors);
      metrics = await this.metrics();
    } catch { /* the page is gone */ }
    this.closed = true;
    this.release?.();
    await this.browserDone?.catch(() => {});
    await this.srv?.close();
    this.final = { metrics, errors: [...this.pageErrors, ...this.runtimeErrors], console: this.console.slice(), blocked: this.blocked.slice(), missing: this.missing.slice(), recording: this.recording() };
    return this.final;
  }
}
