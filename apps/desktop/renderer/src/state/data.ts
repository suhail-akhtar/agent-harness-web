/**
 * What the shell knows from the server: models, providers, sessions, pending approvals, plugins
 * (server, dev and built-in) and the registry built from them. Kept current by the global event
 * stream (or its polling fallback when the server has none).
 */

import { create } from 'zustand';
import { guideIndex } from '../registry/modules';
import { HarnessClient, toApproval, type ClientDescriptor, type ClientPluginDecl, type Approval, type GlobalEvent, type Me, type ModelInfo, type PluginInfo, type ProviderInfo, type SessionMeta, type GlobalEvents, type Config } from '@harness/client';
import { validateUiManifest } from '@harness/plugin-ui';
import { toast, DECLARED_FENCES } from '@harness/ui';
import { buildRegistry, type PluginEntry, type Registry } from '../registry/registry';
import { desktop, platform, type DevPluginInfo } from '../bridge';
import { FOCUS, useApp } from './app';
import type { Grants } from '@desk/grants';

/** The engine through the harness:// proxy (main adds the token). */
export const client = new HarnessClient({ base: '', clientKind: 'desktop' });

export interface BuiltinPlugin { name: string; version: string; description: string; ui: unknown; /** Its guide for agents (GUIDE.md, Markdown with a `description` frontmatter: the plugin's purpose). */ guide?: string; components: Record<string, unknown>; handlers?: Record<string, (args?: unknown) => unknown>; /** Runs once at start (live values, subscriptions). */ activate?: () => void }
let builtins: BuiltinPlugin[] = [];
export function setBuiltins(b: BuiltinPlugin[]) { builtins = b; for (const p of b) { try { p.activate?.(); } catch (e) { console.error(`${p.name} failed to start`, e); } } }
export function builtinEntries(): PluginEntry[] {
  const disabled = useApp.getState().prefs.disabledPlugins;
  return builtins.map((b) => {
    try {
      return { name: b.name, version: b.version, description: b.description, source: 'builtin', enabled: !disabled.includes(b.name), ui: validateUiManifest(b.ui, { trustCeiling: 'native' }), native: { components: b.components, handlers: b.handlers }, ...(b.guide ? { guide: b.guide } : {}) };
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
  /** Bumped when a plugin folder loaded in the app changes on disk: its frames load again. */
  pluginEpochs: Record<string, number>;
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
  me: null, config: null, models: [], providers: null, sessions: [], sessionsLoaded: false, approvals: [], serverPlugins: [], devPlugins: [], pluginEpochs: {}, grants: {},
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
    const server: PluginEntry[] = get().serverPlugins.filter((p) => !builtins.some((b) => b.name === p.name)).map((p) => ({ name: p.name, version: p.version, description: p.description, source: p.source ?? 'bundled', enabled: p.enabled, required: p.required, ui: p.ui, uiError: p.uiError, uiHash: p.uiHash, ...(p.guide ? { guideInfo: p.guide } : {}), ...(p.contributes ? { contributes: p.contributes } : {}) }));
    const dev: PluginEntry[] = get().devPlugins.filter((d) => !server.some((s) => s.name === d.name)).map((d) => ({ name: d.name, version: d.version, description: d.description, source: 'dev', enabled: d.enabled, ui: d.ui, uiError: d.uiError, uiHash: d.uiHash }));
    const registry = buildRegistry([...builtinEntries(), ...server, ...dev], { navOrder: product?.nav.order, homeCards: product?.home.cards, keybindings: prefs.keybindings, required: product?.plugins.required, platform, menuOrder: prefs.menus?.order, ...(FOCUS ? { focus: FOCUS } : {}) });
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
  const plugins = clientPlugins();
  return { kind: 'desktop', version: useApp.getState().info?.version ?? '0.0.0', renderers: [...new Set([...DECLARED_FENCES, ...plugin])].slice(0, 100), tools: [...DESKTOP_TOOLS], ...(commands.length ? { commands } : {}), ...(plugins.length ? { plugins } : {}) };
}

/** The plugins on in the app with a guide, one line each in a session's system prompt (registry/modules.ts guideIndex). */
export function clientPlugins(): ClientPluginDecl[] {
  return guideIndex(useData.getState().registry).slice(0, 60).map((g) => ({ name: g.name, title: g.title, purpose: g.purpose.slice(0, 200), from: g.from, ...(g.tools?.length ? { tools: g.tools } : {}) }));
}

/** What each conversation was told about the app's plugins, this run: sent again only when a plugin came or went. */
const toldPlugins = new Map<string, string>();
/** A conversation this window just made with clientInfo(): it was told the plugins of now. */
export function notePluginsTold(sessionId: string): void { toldPlugins.set(sessionId, JSON.stringify(clientPlugins())); }
/**
 * Before a message is sent: if the app's plugins changed since the conversation was told (a plugin
 * switched on or off), the server re-renders its plugin index and guide skills (from this turn on).
 * The first message of a run asks once; the server keeps a session it has as it is when nothing changed.
 */
export async function syncClientPlugins(sessionId: string): Promise<void> {
  const now = clientPlugins();
  const key = JSON.stringify(now);
  if (toldPlugins.get(sessionId) === key) return;
  try { await client.sessions.patch(sessionId, { clientPlugins: now }); toldPlugins.set(sessionId, key); } catch { /* an older server: it keeps what it was told */ }
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
/** How long a request must stay open before it gets a desktop notification. */
const NOTIFY_AFTER_MS = 4_000;
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
          // Notify only if it is still waiting a moment later: in Auto mode the checker settles most requests
          // within a second or two, and a "Waiting for your approval" for something no longer waiting leads nowhere.
          setTimeout(() => {
            if (!useData.getState().approvals.some((x) => x.requestId === a.requestId)) return;
            void desktop.notify({ title: a.kind === 'question' ? 'A question for you' : 'Waiting for your approval', body: `${a.title ?? 'A conversation'}: ${a.summary ?? a.tool ?? ''}`.slice(0, 200), route: `core.chat:session?id=${a.sessionId}` });
          }, NOTIFY_AFTER_MS);
        }
      } else if (p.type === 'resolved') useData.setState({ approvals: d.approvals.filter((x) => x.requestId !== p.requestId) });
      return;
    }
    // A plugin's server half signalled (api.signal): its badge sources read again (state/badges.ts); nothing else changed.
    case 'plugins': if (p.type === 'signal') return; void d.refreshPlugins(); return;
    case 'notices': if (p.level === 'error' || p.level === 'warn') toast(String(p.text ?? ''), { kind: p.level === 'error' ? 'error' : 'warning' }); return;
    case 'schedules': if (p.type === 'fired') toast(`Scheduled: ${String(p.title ?? 'a prompt')} ran`, { kind: 'info' }); return;
  }
}
