/**
 * A plugin's frame: its HTML in a sandboxed iframe (allow-scripts allow-forms, never
 * allow-same-origin, so an opaque origin with no cookies, storage, DOM access or IPC), served from
 * harness://app/plugins/<name>/ under the plugin CSP, talking to the shell only by postMessage.
 * The host answers calls through frame-host.ts against what the manifest declared and the person
 * granted (TrustGate); the grant is tied to the plugin's uiHash.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PROTOCOL, UI_API_VERSION, qualify, type Capability, type InitMessage } from '@harness/plugin-ui';
import { Button, Icon, toast, Spinner } from '@harness/ui';
import { decide, grantRecord, CAPABILITY_TEXT } from '@desk/grants';
import { handleFrameCall, type Impl } from './frame-host';
import { useData, client, globalBus } from '../state/data';
import { navigate, prefill, useApp } from '../state/app';
import { onThemeChange, themeVars } from '../state/theme';
import { desktop } from '../bridge';

const skipped = new Set<string>();

export function pluginFileUrl(plugin: string, entry: string): string {
  return `harness://app/plugins/${encodeURIComponent(plugin)}/${entry.split('/').map(encodeURIComponent).join('/')}`;
}

export interface FrameProps { plugin: string; contribution: string; entry: string; params?: Record<string, string>; context?: unknown; height?: number; fill?: boolean; className?: string; title?: string }

export function PluginFrame(p: FrameProps): React.ReactElement {
  const entry = useData((s) => s.registry.plugins.find((x) => x.name === p.plugin));
  const grants = useData((s) => s.grants);
  const declared = (entry?.ui?.capabilities ?? []) as Capability[];
  const builtin = entry?.source === 'builtin';
  const decision = builtin ? { state: 'granted' as const, capabilities: declared } : decide(grants[p.plugin], entry?.uiHash, declared);
  const [, force] = useState(0);
  if (!entry) return <FrameNote icon="puzzle" text={`The plugin ${p.plugin} is not available.`} />;
  if (decision.state === 'ask' && declared.length && !skipped.has(`${p.plugin}:${entry.uiHash}`)) {
    return <TrustGate plugin={p.plugin} displayName={entry.ui?.displayName ?? p.plugin} declared={declared} changed={decision.changed} uiHash={entry.uiHash ?? ''} onSkip={() => { skipped.add(`${p.plugin}:${entry.uiHash}`); force((n) => n + 1); }} />;
  }
  const granted = decision.state === 'granted' ? decision.capabilities : [];
  return <FrameView {...p} granted={granted} />;
}

function FrameNote({ icon, text }: { icon: string; text: string }) {
  return <div className="flex items-center gap-2 rounded-lg border border-hx-border-subtle p-3 text-[12.5px] text-hx-muted"><Icon name={icon} size={15} />{text}</div>;
}

export function TrustGate({ plugin, displayName, declared, changed, uiHash, onSkip }: { plugin: string; displayName: string; declared: Capability[]; changed: boolean; uiHash: string; onSkip: () => void }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try { await desktop.setGrant(plugin, grantRecord(uiHash, declared, declared)); await useData.getState().refreshPlugins(); }
    catch (e) { toast((e as Error).message, { kind: 'error' }); setBusy(false); }
  };
  return (
    <div data-trust-gate={plugin} className="mx-auto my-6 max-w-md rounded-2xl border border-hx-border bg-hx-elevated p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-hx-accent-soft text-hx-accent-text"><Icon name="shield" size={20} /></div>
        <div>
          <div className="text-[14px] font-semibold text-hx-primary">{displayName} {changed ? 'changed and asks again' : 'asks for access'}</div>
          <div className="text-[12px] text-hx-muted">It runs in an isolated frame. It can only do what you allow here.</div>
        </div>
      </div>
      <ul className="mt-4 space-y-1.5">
        {declared.map((c) => <li key={c} className="flex items-start gap-2 text-[13px] text-hx-secondary"><Icon name="check" size={14} className="mt-0.5 text-hx-accent-text" />{CAPABILITY_TEXT[c] ?? c}</li>)}
      </ul>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onSkip}>Run without access</Button>
        <Button variant="primary" loading={busy} onClick={allow} data-grant>Allow</Button>
      </div>
    </div>
  );
}

function FrameView({ plugin, contribution, entry, params, context, height: initial, fill, className, title, granted }: FrameProps & { granted: Capability[] }): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initial ?? 320);
  const [loaded, setLoaded] = useState(false);
  const pointerInside = useRef(false);
  const subs = useRef(new Set<string>());
  const src = useMemo(() => pluginFileUrl(plugin, entry), [plugin, entry]);
  const post = (m: unknown) => ref.current?.contentWindow?.postMessage(m, '*');

  useEffect(() => {
    const store = (k: string) => `plugin-storage:${plugin}:${k}`;
    const impl: Impl = {
      'theme.get': () => themeVars(),
      'view.open': (x) => { navigate({ view: qualify(plugin, String(x.view)), ...(x.params && typeof x.params === 'object' ? { params: x.params as Record<string, string> } : {}) }); },
      'panel.open': (x) => { useApp.setState({ panel: { kind: 'plugin', panel: qualify(plugin, String(x.panel)) } }); },
      'notify.toast': (x) => { toast(String(x.text), { kind: (['info', 'success', 'warning', 'error'] as const).find((k) => k === x.kind) ?? 'info', source: plugin }); },
      'storage.get': (x) => { try { const v = localStorage.getItem(store(String(x.key))); return v === null ? undefined : JSON.parse(v); } catch { return undefined; } },
      'storage.set': (x) => {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith(`plugin-storage:${plugin}:`));
        if (!keys.includes(store(String(x.key))) && keys.length >= 200) throw new Error('this plugin has used all of its storage keys');
        if (x.value === undefined || x.value === null) localStorage.removeItem(store(String(x.key))); else localStorage.setItem(store(String(x.key)), JSON.stringify(x.value));
      },
      'composer.prefill': (x) => { prefill(String(x.text), x.newChat === true); },
      'frame.resize': (x) => { if (!fill) setHeight(Math.max(40, Math.min(2400, Number(x.height) + 2))); },
      'badge.set': (x) => { useApp.getState().setBadge(`${plugin}.${String(x.name)}`, x.value); },
      'sessions.list': async (x) => (await client.sessions.list({ query: typeof x.query === 'string' ? x.query : undefined, limit: Math.min(200, Number(x.limit) || 50) })).sessions.map((s) => ({ id: s.id, title: s.title, model: s.model, status: s.status, updatedAt: s.updatedAt, createdAt: s.createdAt, cost: s.cost })),
      'sessions.get': async (x) => { const d = await client.sessions.get(String(x.id)); return { meta: d.meta, status: d.status, pending: d.pending.length }; },
      'sessions.history': (x) => client.sessions.history(String(x.id), { after: Number(x.after) || 0, limit: Math.min(500, Number(x.limit) || 100) }),
      'sessions.start': async (x) => {
        const prefs = useApp.getState().prefs;
        const info = useApp.getState().info;
        const s = await client.sessions.create({ title: String(x.title), model: typeof x.model === 'string' ? x.model : prefs.defaultModel || undefined, runtime: 'local', path: info?.scratch });
        if (typeof x.prompt === 'string' && x.prompt.trim()) await client.sessions.send(s.id, x.prompt);
        navigate({ view: 'core.chat:session', params: { id: s.id } });
        return { id: s.id };
      },
      'sessions.send': async (x) => { await client.sessions.send(String(x.id), String(x.text)); },
      'events.subscribe': (x) => { subs.current.add(String(x.topic)); },
      'events.unsubscribe': (x) => { subs.current.delete(String(x.topic)); },
      'approvals.list': () => client.approvals(),
      'approvals.respond': async (x) => (await client.sessions.respond(String(x.sessionId), { requestId: String(x.requestId), decision: String(x.decision), ...(typeof x.feedback === 'string' ? { feedback: x.feedback } : {}) })).ok,
      'routes.call': (x) => client.plugins.route(plugin, String(x.path), x.method === 'POST' ? 'POST' : 'GET', x.body),
      'files.list': (x) => { const sid = typeof x.session === 'string' ? x.session : currentSession(); if (!sid) throw new Error('no conversation is open'); return client.files.tree(sid, typeof x.path === 'string' ? x.path : ''); },
      'files.read': (x) => { const sid = typeof x.session === 'string' ? x.session : currentSession(); if (!sid) throw new Error('no conversation is open'); return client.files.read(sid, String(x.path)); },
      'workflows.list': async () => { const sid = currentSession(); return sid ? (await client.sessions.workflows(sid)).workflows : []; },
      'workflows.start': (x) => { useApp.setState({ workflowDialog: { sessionId: currentSession(), workflow: String(x.name), input: (x.input as Record<string, string>) ?? {} } }); return { opened: true }; },
      'settings.get': (x) => { const all = useApp.getState().prefs.pluginSettings[plugin] ?? {}; return typeof x.key === 'string' ? all[x.key] : all; },
      'settings.set': (x) => { const prefs = useApp.getState().prefs; useApp.getState().setPrefs({ pluginSettings: { ...prefs.pluginSettings, [plugin]: { ...(prefs.pluginSettings[plugin] ?? {}), [String(x.key)]: x.value } } }); },
      'clipboard.write': async (x) => { await desktop.clipboard(String(x.text)); },
      'browser.open': async (x) => { await desktop.openExternal(String(x.url)); },
      'external.open': async (x) => { await desktop.openExternal(String(x.url)); },
    };
    const onMessage = async (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const res = await handleFrameCall(e.data, {
        plugin, granted, impl,
        gestureSeen: () => document.activeElement === ref.current && pointerInside.current,
        confirm: (q) => useApp.getState().ask({ title: 'A plugin asks', body: q, confirmLabel: 'Allow' }),
      });
      if (res) post(res);
    };
    window.addEventListener('message', onMessage);
    const offTheme = onThemeChange((v) => post({ protocol: PROTOCOL, kind: 'event', topic: 'theme', payload: v }));
    const offEvents = globalBus.on((ev) => { if (subs.current.has(ev.topic)) post({ protocol: PROTOCOL, kind: 'event', topic: ev.topic, payload: ev.payload }); });
    return () => { window.removeEventListener('message', onMessage); offTheme(); offEvents(); };
  }, [plugin, granted.join(','), fill]);

  const init = () => {
    setLoaded(true);
    const m: InitMessage = { protocol: PROTOCOL, kind: 'init', plugin, contribution, params: params ?? {}, theme: themeVars(), apiVersion: UI_API_VERSION, capabilities: granted, ...(context !== undefined ? { context } : {}) };
    post(m);
  };

  return (
    <div className={`relative ${fill ? 'h-full' : ''} ${className ?? ''}`} data-plugin-frame={plugin}>
      {!loaded && <div className="absolute inset-0 flex items-center justify-center text-hx-muted"><Spinner /></div>}
      <iframe
        ref={ref}
        src={src}
        title={title ?? `${plugin} ${contribution}`}
        // Never allow-same-origin: an opaque origin, whatever the plugin's code does.
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        onLoad={init}
        onMouseEnter={() => { pointerInside.current = true; }}
        onMouseLeave={() => { pointerInside.current = false; }}
        className="w-full border-0 bg-transparent"
        style={fill ? { height: '100%' } : { height }}
        data-capabilities={granted.join(' ')}
      />
    </div>
  );
}

function currentSession(): string | undefined {
  const r = useApp.getState().route;
  return r.view === 'core.chat:session' ? r.params?.id : undefined;
}
