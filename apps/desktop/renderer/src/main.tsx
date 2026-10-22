/**
 * The renderer's start: register the built-in plugins, read prefs and the product, apply the theme,
 * follow the engine (connect the event stream each time it is ready), and draw the window.
 */

import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { setArtifactHost, toast } from '@harness/ui';
import { App } from './shell/App';
import { useApp, navigate, openSession, prefill } from './state/app';
import { useData, setBuiltins, client, applyGlobal } from './state/data';
import * as theme from './state/theme';
import { desktop, on, type EngineState } from './bridge';
import { runCommand } from './registry/actions';
import { BUILTINS } from './builtins';
import type { DesktopPrefs } from '@desk/prefs';
import type { GlobalEvents } from '@harness/client';

setBuiltins(BUILTINS);

function reapplyTheme() { theme.apply(useApp.getState().prefs, useData.getState().registry, useApp.getState().info?.product.brand.accent); }

let events: GlobalEvents | null = null;
async function onReady() {
  const d = useData.getState();
  await Promise.all([d.refreshModels(), d.refreshSessions(), d.refreshPlugins(), d.refreshApprovals()]);
  events?.stop();
  events = client.globalEvents(3000);
  events.on(applyGlobal);
  events.onState((m) => useData.setState({ eventsMode: m }));
  events.start();
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
  });
  useData.getState().rebuild();
  reapplyTheme();
  theme.watchSystem(() => { if (useApp.getState().prefs.theme === 'system') reapplyTheme(); });
  useData.subscribe((s, prev) => { if (s.registry !== prev.registry) reapplyTheme(); });

  on<EngineState>('engine:state', (s) => {
    const was = useApp.getState().engine.status;
    useApp.setState({ engine: s });
    if (s.status === 'ready' && was !== 'ready') void onReady();
    if (s.status !== 'ready') { events?.stop(); }
  });
  on<DesktopPrefs>('prefs:changed', (p) => {
    const before = useApp.getState().prefs;
    useApp.setState({ prefs: p });
    if (JSON.stringify(before.keybindings) !== JSON.stringify(p.keybindings) || JSON.stringify(before.disabledPlugins) !== JSON.stringify(p.disabledPlugins)) useData.getState().rebuild();
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
