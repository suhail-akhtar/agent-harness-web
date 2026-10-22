/**
 * The SDK a plugin frame imports (or loads as a script): a typed client of the host protocol.
 *
 *   import { connect } from '@harness/plugin-ui/sdk';
 *   const h = await connect();
 *   const sessions = await h.sessions.list();
 *   h.events.subscribe('approvals', (e) => render(e));
 *
 * Calls the frame was not granted fail with the host's reason; nothing here grants anything.
 */

import { type CallMessage, type EventMessage, type HostMessage, type InitMessage, PROTOCOL, type RegistryKind, type RegistryQuery, type ThemeVars } from './rpc.ts';

export interface HostLike { postMessage(message: unknown, targetOrigin: string): void }
export interface WindowLike {
  parent: HostLike;
  addEventListener(type: 'message', listener: (e: { data: unknown; source: unknown }) => void): void;
  addEventListener(type: 'pointerdown' | 'keydown', listener: () => void, opts?: { capture?: boolean }): void;
  document?: { documentElement: { style: { setProperty(name: string, value: string): void } }; body?: { scrollHeight: number } | null };
}

export interface Harness {
  /** Who this frame is, and where it is shown. */
  plugin: string;
  contribution: string;
  params: Record<string, string>;
  capabilities: string[];
  context: unknown;
  theme: { vars: ThemeVars; onChange(fn: (vars: ThemeVars) => void): () => void };
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  view: { open(view: string, params?: Record<string, string>): Promise<void> };
  panel: { open(panel: string): Promise<void> };
  notify: { toast(text: string, opts?: { kind?: 'info' | 'success' | 'warning' | 'error' }): Promise<void> };
  storage: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  composer: { prefill(text: string, opts?: { newChat?: boolean }): Promise<void> };
  frame: { resize(height?: number): Promise<void> };
  badge: { set(name: string, value: number | string | null): Promise<void> };
  /** What else is installed: `has({ renderer: 'diagram' })`, `has({ plugin: 'aiops' })`, `list('renderers')` (ids only). */
  registry: { has(q: RegistryQuery): Promise<boolean>; list(kind: RegistryKind): Promise<string[]> };
  /**
   * A block drawn by one of the host's renderers (a fence language, e.g. "diagram") over a rectangle
   * of this frame (its CSS pixels; keep it current on scroll and resize). Fails when the host has no
   * such renderer: draw it yourself then. One block per frame; hide() removes it.
   */
  render: { show(o: { fence: string; source: string; rect: { x: number; y: number; width: number; height: number } }): Promise<void>; hide(): Promise<void> };
  sessions: {
    list(opts?: { query?: string; limit?: number }): Promise<unknown[]>;
    get(id: string): Promise<unknown>;
    history(id: string, opts?: { after?: number; limit?: number }): Promise<unknown>;
    start(opts: { title: string; prompt?: string; workflow?: { name: string; input?: Record<string, string> }; model?: string }): Promise<{ id: string }>;
    send(id: string, text: string): Promise<void>;
  };
  events: { subscribe(topic: string, fn: (payload: unknown) => void, filter?: Record<string, string>): Promise<() => void> };
  approvals: { list(): Promise<unknown[]>; respond(sessionId: string, requestId: string, decision: string, feedback?: string): Promise<boolean> };
  routes: { call<T = unknown>(path: string, opts?: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> };
  files: { list(opts: { session?: string; path?: string }): Promise<unknown>; read(opts: { session?: string; path: string }): Promise<unknown> };
  workflows: { list(): Promise<unknown[]>; start(name: string, input?: Record<string, string>): Promise<unknown> };
  settings: { get<T = unknown>(key?: string): Promise<T>; set(key: string, value: unknown): Promise<void> };
  clipboard: { write(text: string): Promise<void> };
  browser: { open(url: string): Promise<void> };
  external: { open(url: string): Promise<void> };
}

/** Connects to the host: resolves once the host's init message arrives. */
export function connect(win: WindowLike = globalThis as unknown as WindowLike, opts: { timeoutMs?: number } = {}): Promise<Harness> {
  let next = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const themeFns = new Set<(v: ThemeVars) => void>();
  let lastGesture = 0;
  win.addEventListener('pointerdown', () => { lastGesture = Date.now(); }, { capture: true });
  win.addEventListener('keydown', () => { lastGesture = Date.now(); }, { capture: true });

  const applyTheme = (vars: ThemeVars) => {
    const st = win.document?.documentElement.style;
    if (st) for (const [k, v] of Object.entries(vars)) st.setProperty(k.startsWith('--') ? k : `--${k}`, v);
  };

  return new Promise<Harness>((resolveInit, rejectInit) => {
    const timer = setTimeout(() => rejectInit(new Error('no host answered (is this page open outside the app?)')), opts.timeoutMs ?? 10_000);
    let vars: ThemeVars = {};
    win.addEventListener('message', (e) => {
      // Only the parent speaks this protocol to us.
      if (e.source !== win.parent) return;
      const m = e.data as HostMessage;
      if (!m || typeof m !== 'object' || (m as { protocol?: unknown }).protocol !== PROTOCOL) return;
      if (m.kind === 'result') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error ?? 'refused'));
      } else if (m.kind === 'event') {
        const ev = m as EventMessage;
        if (ev.topic === 'theme') { vars = ev.payload as ThemeVars; applyTheme(vars); for (const f of themeFns) f(vars); return; }
        for (const f of listeners.get(ev.topic) ?? []) f(ev.payload);
      } else if (m.kind === 'init') {
        clearTimeout(timer);
        const init = m as InitMessage;
        vars = init.theme; applyTheme(vars);
        resolveInit(build(init));
      }
    });

    function call<T>(method: string, params?: unknown): Promise<T> {
      const id = next++;
      const msg: CallMessage = { protocol: PROTOCOL, kind: 'call', id, method, ...(params === undefined ? {} : { params }), gesture: Date.now() - lastGesture < 1500 };
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        win.parent.postMessage(msg, '*');
      });
    }

    function build(init: InitMessage): Harness {
      const v = <T = void>(method: string) => (params?: unknown) => call<T>(method, params);
      return {
        plugin: init.plugin, contribution: init.contribution, params: init.params, capabilities: init.capabilities, context: init.context,
        theme: { get vars() { return vars; }, onChange(fn) { themeFns.add(fn); return () => themeFns.delete(fn); } },
        call,
        view: { open: (view, params) => call('view.open', { view, params }) },
        panel: { open: (panel) => call('panel.open', { panel }) },
        notify: { toast: (text, o) => call('notify.toast', { text, ...o }) },
        storage: { get: (key) => call('storage.get', { key }), set: (key, value) => call('storage.set', { key, value }) },
        composer: { prefill: (text, o) => call('composer.prefill', { text, ...o }) },
        frame: { resize: (height) => call('frame.resize', { height: height ?? win.document?.body?.scrollHeight ?? 0 }) },
        badge: { set: (name, value) => call('badge.set', { name, value }) },
        registry: { has: (q) => call('registry.has', q), list: (kind) => call('registry.list', { kind }) },
        render: { show: (o) => call('render.show', o), hide: () => call('render.hide', {}) },
        sessions: {
          list: (o) => call('sessions.list', o ?? {}), get: (id) => call('sessions.get', { id }),
          history: (id, o) => call('sessions.history', { id, ...o }), start: (o) => call('sessions.start', o),
          send: (id, text) => call('sessions.send', { id, text }),
        },
        events: {
          async subscribe(topic, fn, filter) {
            await call('events.subscribe', { topic, ...(filter ? { filter } : {}) });
            let set = listeners.get(topic);
            if (!set) { set = new Set(); listeners.set(topic, set); }
            set.add(fn);
            return () => { set!.delete(fn); if (!set!.size) { listeners.delete(topic); void call('events.unsubscribe', { topic }).catch(() => {}); } };
          },
        },
        approvals: { list: v('approvals.list') as () => Promise<unknown[]>, respond: (sessionId, requestId, decision, feedback) => call('approvals.respond', { sessionId, requestId, decision, feedback }) },
        routes: { call: (path, o) => call('routes.call', { path, ...o }) },
        files: { list: (o) => call('files.list', o), read: (o) => call('files.read', o) },
        workflows: { list: v('workflows.list') as () => Promise<unknown[]>, start: (name, input) => call('workflows.start', { name, input }) },
        settings: { get: (key) => call('settings.get', { key }), set: (key, value) => call('settings.set', { key, value }) },
        clipboard: { write: (text) => call('clipboard.write', { text }) },
        browser: { open: (url) => call('browser.open', { url }) },
        external: { open: (url) => call('external.open', { url }) },
      };
    }
  });
}
