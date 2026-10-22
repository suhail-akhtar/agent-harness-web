/**
 * The renderer's start: register the built-in plugins, read prefs and the product, apply the theme,
 * follow the engine (connect the event stream each time it is ready), and draw the window.
 */

import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { setArtifactHost, toast } from '@harness/ui';
import { App } from './shell/App';
import { useApp, navigate, openSession, prefill, HOME } from './state/app';
import { reconcile } from './registry/reconcile';
import { describeRegistry } from './registry/registry';
import { useData, setBuiltins, client, applyGlobal, setClientCallHandler, globalBus } from './state/data';
import { badgePlan, runBadges } from './state/badges';
import { handleClientCall } from './state/client-calls';
import * as theme from './state/theme';
import { desktop, on, type EngineState } from './bridge';
import { runCommand } from './registry/actions';
import { BUILTINS } from './builtins';
import { useArtifactRenderer } from './builtins/core.chat/Transcript';
import type { DesktopPrefs } from '@desk/prefs';
import type { GlobalEvents } from '@harness/client';

setBuiltins(BUILTINS);
// The desktop tools agents call in this window (desktop_describe, desktop_open, desktop_notify, desktop_command).
setClientCallHandler(handleClientCall);
// An internal surface for the agent's desktop tools (desktop_describe) and diagnostics: the live registry as data.
(globalThis as unknown as { harnessDesktopInternal?: unknown }).harnessDesktopInternal = { describe: () => describeRegistry(useData.getState().registry) };

function reapplyTheme() { theme.apply(useApp.getState().prefs, useData.getState().registry, useApp.getState().info?.product.brand.accent); }

let events: GlobalEvents | null = null;

// Badge sources (ui.badges): plugins' badges kept current with none of their pages open; re-planned when the registry changes.
let badges: ReturnType<typeof runBadges> | null = null;
let badgeKey = '';
function replanBadges() {
  const plan = useApp.getState().engine.status === 'ready' ? badgePlan(useData.getState().registry) : [];
  const key = JSON.stringify(plan);
  if (key === badgeKey) return;
  badgeKey = key;
  badges?.stop();
  badges = plan.length ? runBadges(plan, {
    call: (plugin, route, method) => client.plugins.route(plugin, route, method),
    set: (k, v) => useApp.getState().setBadge(k, v),
    // Paused while the window is hidden (the e2e tests' windows are never shown, yet driven: they count as visible).
    hidden: () => document.visibilityState === 'hidden' && !useApp.getState().info?.test,
    onVisibility: (fn) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); },
  }) : null;
}
globalBus.on((e) => { const p = (e.payload ?? {}) as { type?: string; plugin?: string }; if (e.topic === 'plugins' && p.type === 'signal' && typeof p.plugin === 'string') badges?.signal(p.plugin); });
async function onReady() {
  const d = useData.getState();
  await Promise.all([d.refreshModels(), d.refreshSessions(), d.refreshPlugins(), d.refreshApprovals()]);
  events?.stop();
  events = client.globalEvents(3000);
  events.on(applyGlobal);
  events.onState((m) => useData.setState({ eventsMode: m }));
  events.start();
  replanBadges();
  const { models } = useData.getState();
  const { prefs } = useApp.getState();
  if (!prefs.onboardingDone && models.length && !models.some((m) => m.available)) useApp.setState({ onboardingOpen: true });
}

async function boot() {
  const [info, prefs, state] = await Promise.all([desktop.info().catch(() => null), desktop.prefs().catch(() => null), desktop.engineStatus().catch((): EngineState => ({ status: 'ready', origin: location.origin, startedAt: Date.now() }))]);
  useApp.setState({ info, ...(prefs ? { prefs } : {}), engine: state });
  if (info) document.title = info.product.name;
  setArtifactHost({
    register: info ? (html) => desktop.registerPreview(html).then((r) => r.url) : undefined,
    runtimeUrl: info?.previewRuntime,
    openPanel: (a) => useApp.setState({ panel: { kind: 'artifact', title: a.title, artifact: a.kind, source: a.source, language: a.language } }),
    useRenderer: useArtifactRenderer,
  });
  useData.getState().rebuild();
  reapplyTheme();
  theme.watchSystem(() => { if (useApp.getState().prefs.theme === 'system') reapplyTheme(); });
  useData.subscribe((s, prev) => {
    if (s.registry === prev.registry) return;
    // A plugin switched on or off live: nothing of it may linger (reconcile.ts).
    const app = useApp.getState();
    const r = reconcile(prev.registry, s.registry, { route: app.route, panel: app.panel, settingsSection: app.settingsSection, badges: app.badges });
    if (r.leaveView) { navigate(HOME, { replace: true }); toast(`${r.leaveView.label} was switched off`, { kind: 'info' }); }
    if (r.closePanel) useApp.setState({ panel: null });
    if (r.settingsSection !== undefined) useApp.setState({ settingsSection: r.settingsSection });
    if (r.dropBadges.length) { const b = { ...useApp.getState().badges }; for (const k of r.dropBadges) delete b[k]; useApp.setState({ badges: b }); }
    replanBadges();
    reapplyTheme();
  });

  on<EngineState>('engine:state', (s) => {
    const was = useApp.getState().engine.status;
    useApp.setState({ engine: s });
    if (s.status === 'ready' && was !== 'ready') void onReady();
    if (s.status !== 'ready') { events?.stop(); replanBadges(); }
  });
  on<DesktopPrefs>('prefs:changed', (p) => {
    const before = useApp.getState().prefs;
    useApp.setState({ prefs: p });
    if (JSON.stringify(before.keybindings) !== JSON.stringify(p.keybindings) || JSON.stringify(before.disabledPlugins) !== JSON.stringify(p.disabledPlugins) || JSON.stringify(before.menus?.order) !== JSON.stringify(p.menus?.order)) useData.getState().rebuild();
    reapplyTheme();
  });
  on<{ id: string }>('command:run', (c) => void runCommand(c.id));
  on<{ text: string }>('engine:notice', (n) => toast(n.text));
  on<boolean>('win:focus', (f) => useApp.setState({ focused: f }));
  on<{ route: string }>('notify:clicked', ({ route }) => {
    const [view, query] = route.split('?');
    navigate({ view: view!, ...(query ? { params: Object.fromEntries(new URLSearchParams(query)) } : {}) });
  });
  on<{ action: string; params: Record<string, string> }>('deeplink:open', ({ action, params }) => {
    if (action === 'open' && params.session && /^[a-f0-9]{16}$/.test(params.session)) openSession(params.session);
    else if (action === 'new') prefill(params.prompt ?? '', true);
    else if (action === 'settings') useApp.getState().openSettings(params.section);
    else toast(`Unknown link: ${action}`, { kind: 'warning' });
  });

  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
  if (state.status === 'ready') void onReady();
  // Outside the desktop (a plain browser), assume the API is served alongside.
  if (!info) void onReady();
}

void boot();
