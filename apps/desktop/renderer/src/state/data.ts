/**
 * What the shell knows from the server: models, providers, sessions, pending approvals, plugins
 * (server, dev and built-in) and the registry built from them. Kept current by the global event
 * stream (or its polling fallback when the server has none).
 */

import { create } from 'zustand';
import { HarnessClient, toApproval, type ClientDescriptor, type Approval, type GlobalEvent, type Me, type ModelInfo, type PluginInfo, type ProviderInfo, type SessionMeta, type GlobalEvents, type Config } from '@harness/client';
import { validateUiManifest } from '@harness/plugin-ui';
import { toast, DECLARED_FENCES } from '@harness/ui';
import { buildRegistry, type PluginEntry, type Registry } from '../registry/registry';
import { desktop, platform, type DevPluginInfo } from '../bridge';
import { useApp } from './app';
import type { Grants } from '@desk/grants';

/** The engine through the harness:// proxy (main adds the token). */
export const client = new HarnessClient({ base: '', clientKind: 'desktop' });

export interface BuiltinPlugin { name: string; version: string; description: string; ui: unknown; components: Record<string, unknown>; handlers?: Record<string, (args?: unknown) => unknown>; /** Runs once at start (live values, subscriptions). */ activate?: () => void }
let builtins: BuiltinPlugin[] = [];
export function setBuiltins(b: BuiltinPlugin[]) { builtins = b; for (const p of b) { try { p.activate?.(); } catch (e) { console.error(`${p.name} failed to start`, e); } } }
export function builtinEntries(): PluginEntry[] {
  const disabled = useApp.getState().prefs.disabledPlugins;
  return builtins.map((b) => {
    try {
      return { name: b.name, version: b.version, description: b.description, source: 'builtin', enabled: !disabled.includes(b.name), ui: validateUiManifest(b.ui, { trustCeiling: 'native' }), native: { components: b.components, handlers: b.handlers } };
    } catch (e) {
      return { name: b.name, version: b.version, source: 'builtin', enabled: false, uiError: (e as Error).message };
    }
  });
}

export interface DataState {
  me: Me | null;
  config: Config | null;
  models: ModelInfo[];
  providers: ProviderInfo[] | null;
  sessions: SessionMeta[];
  sessionsLoaded: boolean;
  approvals: Approval[];
  serverPlugins: PluginInfo[];
  devPlugins: DevPluginInfo[];
  grants: Grants;
  registry: Registry;
  eventsMode: GlobalEvents['mode'];
  refreshModels(): Promise<void>;
  refreshSessions(): Promise<void>;
  refreshApprovals(): Promise<void>;
  refreshPlugins(): Promise<void>;
  rebuild(): void;
  upsertSession(m: SessionMeta): void;
}

export const useData = create<DataState>((set, get) => ({
  me: null, config: null, models: [], providers: null, sessions: [], sessionsLoaded: false, approvals: [], serverPlugins: [], devPlugins: [], grants: {},
  registry: buildRegistry([]),
  eventsMode: 'stopped',
  async refreshModels() {
    const [fetched, providers, me, config] = await Promise.all([client.models().catch(() => get().models), client.providers.list().catch(() => null), client.me().catch(() => get().me), client.config().catch(() => get().config)]);
    // An engine mid-restart can answer with nothing: keep the list we had rather than empty the pickers.
    const models = Array.isArray(fetched) && (fetched.length || !get().models.length) ? fetched : get().models;
    set({ models, providers: providers ?? get().providers, me, config });
  },
  async refreshSessions() {
    try {
      const { sessions } = await client.sessions.list({ limit: 500, archived: useApp.getState().prefs.sidebar.showArchived ? undefined : false });
      set({ sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), sessionsLoaded: true });
    } catch { /* engine down: the gate says so */ }
  },
  async refreshApprovals() { try { set({ approvals: await client.approvals() }); } catch { /* engine down */ } },
  async refreshPlugins() {
    const [serverPlugins, devPlugins, grants] = await Promise.all([client.plugins.list().catch(() => get().serverPlugins), desktop.devPlugins(), desktop.grants()]);
    set({ serverPlugins, devPlugins, grants });
    get().rebuild();
  },
  rebuild() {
    const { prefs, info } = useApp.getState();
    const product = info?.product;
    const server: PluginEntry[] = get().serverPlugins.filter((p) => !builtins.some((b) => b.name === p.name)).map((p) => ({ name: p.name, version: p.version, description: p.description, source: p.source ?? 'bundled', enabled: p.enabled, required: p.required, ui: p.ui, uiError: p.uiError, uiHash: p.uiHash }));
    const dev: PluginEntry[] = get().devPlugins.filter((d) => !server.some((s) => s.name === d.name)).map((d) => ({ name: d.name, version: d.version, description: d.description, source: 'dev', enabled: d.enabled, ui: d.ui, uiError: d.uiError, uiHash: d.uiHash }));
    const registry = buildRegistry([...builtinEntries(), ...server, ...dev], { navOrder: product?.nav.order, homeCards: product?.home.cards, keybindings: prefs.keybindings, required: product?.plugins.required, platform });
    set({ registry });
  },
  upsertSession(m) {
    const list = get().sessions.filter((s) => s.id !== m.id);
    const hide = m.archived && !useApp.getState().prefs.sidebar.showArchived;
    set({ sessions: (hide ? list : [{ ...get().sessions.find((s) => s.id === m.id), ...m }, ...list]).sort((a, b) => b.updatedAt - a.updatedAt) });
  },
}));

/** The desktop tools this window answers (client_call). */
export const DESKTOP_TOOLS = ['desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'] as const;

/**
 * What this window renders and answers, sent when it creates a session (the server may ignore it).
 * Short on purpose: the renderers and tools are part of the session's cached prefix (fence names
 * only, fixed when the session is made). The commands are not in the prompt: the server checks a
 * desktop_command against them (the app's own plugins, whose manifests it cannot read).
 */
export function clientInfo(): ClientDescriptor {
  const { registry } = useData.getState();
  const plugin = [...registry.renderers.fence.keys()].map((l) => l);
  const own = new Set(registry.active.filter((p) => p.source === 'builtin' || p.source === 'dev').map((p) => p.name));
  const commands = registry.commands.filter((c) => c.agent && own.has(c.plugin)).slice(0, 100).map((c) => ({ id: c.qid, description: c.agent!.description.slice(0, 300), ...(c.agent!.inputSchema && JSON.stringify(c.agent!.inputSchema).length <= 4000 ? { inputSchema: c.agent!.inputSchema as Record<string, unknown> } : {}) }));
  return { kind: 'desktop', version: useApp.getState().info?.version ?? '0.0.0', renderers: [...new Set([...DECLARED_FENCES, ...plugin])].slice(0, 100), tools: [...DESKTOP_TOOLS], ...(commands.length ? { commands } : {}) };
}

/** Answers one desktop tool call: what it returns is the result; a throw is the error the agent reads. */
export type ClientCallHandler = (sessionId: string, tool: string, input: Record<string, unknown>) => Promise<{ result: unknown; untrusted?: boolean }>;
let clientCallHandler: ClientCallHandler = async () => { throw new Error('not supported by this version'); };
export function setClientCallHandler(h: ClientCallHandler): void { clientCallHandler = h; }

/** How long a call may take here; the server waits 60 s by default, so the answer always arrives before. */
export const CLIENT_CALL_MS = 20_000;

/**
 * Runs a desktop tool call and answers it, once per call (the global stream and the session's may
 * both bring it). Answered within CLIENT_CALL_MS whatever happens, with a clear error on failure.
 */
const answered = new Set<string>();
export function dispatchClientCall(sessionId: string, callId: string, tool: string, input: unknown): void {
  if (!sessionId || !callId || answered.has(callId)) return;
  answered.add(callId);
  if (answered.size > 500) answered.delete(answered.values().next().value!);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${tool} took longer than ${CLIENT_CALL_MS / 1000} s in the app`)), CLIENT_CALL_MS); });
  void Promise.race([clientCallHandler(sessionId, tool, args), timeout])
    .then((r) => client.sessions.clientResult(sessionId, { callId, ok: true, result: r.result, ...(r.untrusted ? { untrusted: true } : {}) }))
    .catch((e: Error) => client.sessions.clientResult(sessionId, { callId, ok: false, error: (e?.message || String(e)).slice(0, 1000) }))
    .catch(() => { /* answered already, or the call ended */ })
    .finally(() => clearTimeout(timer));
}

/** Every global event, for plugin frames that subscribed (events.subscribe). */
const busListeners = new Set<(e: GlobalEvent) => void>();
export const globalBus = { on(f: (e: GlobalEvent) => void): () => void { busListeners.add(f); return () => { busListeners.delete(f); }; } };

/** Applies one global event to the stores (stream or polling fallback). */
export function applyGlobal(e: GlobalEvent): void {
  for (const f of busListeners) { try { f(e); } catch { /* a frame bug is its own */ } }
  const d = useData.getState();
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.topic) {
    case 'sessions': {
      if (Array.isArray(p.sessions)) { useData.setState({ sessions: (p.sessions as SessionMeta[]).filter((s) => !s.archived || useApp.getState().prefs.sidebar.showArchived).sort((a, b) => b.updatedAt - a.updatedAt), sessionsLoaded: true }); return; }
      const s = p.session as SessionMeta | undefined;
      if (!s) return;
      if (p.type === 'deleted') useData.setState({ sessions: d.sessions.filter((x) => x.id !== s.id) });
      else d.upsertSession(s);
      return;
    }
    case 'session': {
      const id = String(p.id ?? '');
      const cur = d.sessions.find((s) => s.id === id);
      if (cur) useData.setState({ sessions: d.sessions.map((s) => (s.id === id ? { ...s, ...(p.status ? { status: p.status as SessionMeta['status'] } : {}), ...(typeof p.title === 'string' ? { title: p.title } : {}), updatedAt: Date.now() } : s)) });
      else void d.refreshSessions();
      // A turn ended: its cost and models changed (the Agents panel and page show them for sessions not on screen).
      if (cur && p.status === 'idle') void client.sessions.get(id).then((x) => { const now = useData.getState().sessions.find((s) => s.id === id); if (now) useData.getState().upsertSession({ ...now, cost: x.meta.cost, byModel: x.meta.byModel, usage: x.meta.usage, status: x.status }); }).catch(() => {});
      return;
    }
    case 'client': {
      // A desktop tool an agent asked this app to run.
      if (p.type === 'call' && typeof p.sessionId === 'string' && typeof p.callId === 'string') dispatchClientCall(p.sessionId, p.callId, String(p.tool ?? ''), p.input);
      return;
    }
    case 'approvals': {
      if (Array.isArray(p.approvals)) { useData.setState({ approvals: p.approvals as Approval[] }); return; }
      if (p.type === 'added') {
        const a = toApproval(p);
        if (a && !d.approvals.some((x) => x.requestId === a.requestId)) {
          useData.setState({ approvals: [...d.approvals, a] });
          void desktop.notify({ title: a.kind === 'question' ? 'A question for you' : 'Waiting for your approval', body: `${a.title ?? 'A conversation'}: ${a.summary ?? a.tool ?? ''}`.slice(0, 200), route: `core.chat:session?id=${a.sessionId}` });
        }
      } else if (p.type === 'resolved') useData.setState({ approvals: d.approvals.filter((x) => x.requestId !== p.requestId) });
      return;
    }
    case 'plugins': void d.refreshPlugins(); return;
    case 'notices': if (p.level === 'error' || p.level === 'warn') toast(String(p.text ?? ''), { kind: p.level === 'error' ? 'error' : 'warning' }); return;
    case 'schedules': if (p.type === 'fired') toast(`Scheduled: ${String(p.title ?? 'a prompt')} ran`, { kind: 'info' }); return;
  }
}
