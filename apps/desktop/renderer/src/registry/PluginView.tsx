/**
 * Drawing contributions: a view (markdown, links, prompt board, form, frame or native), a home card,
 * a side panel. The same code draws a built-in's page and a third-party plugin's.
 */

import React, { createContext, useContext, useState } from 'react';
import { Button, EmptyState, Icon, Markdown, SchemaForm, withDefaults, validate, RenderBoundary, toast, Page, ListRow } from '@harness/ui';
import type { JsonSchema } from '@harness/plugin-ui';
import { client, useData } from '../state/data';
import { navigate, prefill, useApp, HOME } from '../state/app';
import type { HomeCard, Panel, View } from './registry';
import { runAction } from './actions';
import { PluginFrame } from './Frame';
import { desktop } from '../bridge';

export interface NativeProps { params: Record<string, string>; plugin: string; contribution: string; /** A panel's structured input (openPluginPanel). */ data?: unknown }

/** Where a view is drawn: the main place, or beside it (split view: close it, or open it here). */
export interface Pane { split: boolean; close?: () => void; here?: () => void }
export const PaneContext = createContext<Pane>({ split: false });
export const usePane = (): Pane => useContext(PaneContext);

function nativeComponent(plugin: string, component: string): React.ComponentType<NativeProps> | undefined {
  const e = useData.getState().registry.active.find((p) => p.name === plugin);
  return e?.native?.components[component] as React.ComponentType<NativeProps> | undefined;
}

/** Switches a plugin off: a built-in in this app's prefs, a dev plugin on this machine, a server plugin on the server (administrators). */
export async function disablePlugin(name: string): Promise<void> {
  const e = useData.getState().registry.plugins.find((p) => p.name === name);
  if (!e) throw new Error(`No plugin ${name}`);
  if (e.required) throw new Error(`${name} is required by this app and cannot be switched off.`);
  if (e.source === 'builtin') { const prefs = useApp.getState().prefs; useApp.getState().setPrefs({ disabledPlugins: [...new Set([...prefs.disabledPlugins, name])] }); useData.getState().rebuild(); return; }
  if (e.source === 'dev') { await desktop.toggleDevPlugin(name, false); await useData.getState().refreshPlugins(); return; }
  await client.plugins.disable(name);
  await useData.getState().refreshPlugins();
}

/** A contribution that threw: an error card (never a blank window), with Try again and, for a plugin that may be switched off, Disable. */
export function Failed({ what, error, retry, plugin }: { what: string; error: string; retry: () => void; plugin?: string }) {
  const entry = useData((s) => (plugin ? s.registry.plugins.find((p) => p.name === plugin) : undefined));
  const name = entry?.ui?.displayName ?? plugin;
  const canDisable = !!entry && !entry.required && !useApp.getState().info?.product.plugins.required.includes(entry.name);
  return (
    <div className="m-6 rounded-xl border border-hx-danger/30 bg-hx-danger/8 p-4 text-[13px]" data-render-error data-failed-plugin={plugin}>
      <div className="flex items-center gap-2"><Icon name="alert" size={16} className="text-hx-danger" /><b>{what} failed.</b></div>
      <p className="mt-1 break-words text-hx-secondary">{error}</p>
      {plugin && <p className="mt-1 text-[12px] text-hx-muted">It comes from the plugin {name}.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon="refresh" onClick={retry}>Try again</Button>
        {canDisable && <Button size="sm" variant="ghost" icon="x-circle" data-disable-plugin={plugin} onClick={() => void disablePlugin(plugin!).then(() => { toast(`${name} is switched off`, { kind: 'info' }); if (useApp.getState().route.view.startsWith(`${plugin}:`)) navigate(HOME, { replace: true }); }).catch((e: Error) => toast(e.message, { kind: 'error' }))}>Disable {name}</Button>}
        <Button size="sm" variant="ghost" icon="home" onClick={() => navigate(HOME)}>Go home</Button>
      </div>
    </div>
  );
}

/** Diagnostics: a view named here throws when drawn (the e2e test proves a failing page shows its error card). */
function crashProbe(qid: string): void {
  if ((globalThis as { __harnessCrashView?: string }).__harnessCrashView === qid) throw new Error(`${qid} failed on purpose (diagnostics)`);
}
function Probe({ qid, children }: { qid: string; children: React.ReactNode }) { crashProbe(qid); return <>{children}</>; }

export function ViewHost({ view, params }: { view: View; params: Record<string, string> }): React.ReactElement {
  const body = (() => {
    switch (view.kind) {
      case 'native': {
        const C = nativeComponent(view.plugin, view.component);
        return C ? <C params={params} plugin={view.plugin} contribution={view.qid} /> : <EmptyState icon="puzzle" title="This page is not available">{view.plugin} did not provide {view.component}.</EmptyState>;
      }
      // A frame page opened again with other params (an incident, a feature) starts again with them: its init carries them.
      case 'frame': return <div className="h-full p-0"><PluginFrame key={JSON.stringify(params)} plugin={view.plugin} contribution={view.qid} entry={view.entry} params={params} fill title={view.title} /></div>;
      case 'markdown': return <Page><Markdown text={view.markdown} /></Page>;
      case 'links': return (
        <Page title={view.title} subtitle={view.description}>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.links.map((l) => <ListRow key={l.url} card icon="external" onClick={() => void desktop.openExternal(l.url)} title={l.title} subtitle={l.description ? `${l.description} · ${l.url}` : l.url} />)}
          </div>
        </Page>
      );
      case 'prompt-board': return (
        <Page title={view.title}>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.prompts.map((p, i) => <ListRow key={i} card icon={<Icon name={p.icon ?? 'sparkles'} size={16} className="shrink-0 text-hx-accent-text" />} onClick={() => prefill(p.prompt, true)} title={p.title} subtitle={p.prompt} />)}
          </div>
        </Page>
      );
      case 'form': return <FormView view={view} />;
    }
  })();
  return <RenderBoundary fallback={(e, retry) => <Failed what={`The page "${view.title}"`} error={e} retry={retry} plugin={view.plugin} />}><Probe qid={view.qid}>{body}</Probe></RenderBoundary>;
}

function FormView({ view }: { view: Extract<View, { kind: 'form' }> }) {
  const [value, setValue] = useState<Record<string, unknown>>(() => withDefaults(view.schema as JsonSchema, {}) as Record<string, unknown>);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setTried(true);
    if (Object.keys(validate(view.schema, value)).length) return;
    setBusy(true);
    const a = view.submit.action;
    try {
      if (a.type === 'workflow') await runAction({ ...a, input: { ...(a.input ?? {}), ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) } }, view.plugin);
      else if (a.type === 'route') await runAction({ ...a, body: value }, view.plugin);
      else if (a.type === 'prompt') await runAction({ ...a, prompt: a.prompt.replace(/\{(\w+)\}/g, (_, k: string) => String(value[k] ?? '')) }, view.plugin);
      else await runAction(a, view.plugin, value);
    } finally { setBusy(false); }
  };
  return (
    <Page width="narrow" title={view.title} subtitle={view.description}>
      <div className="rounded-xl border border-hx-border-subtle bg-hx-elevated px-4">
        <SchemaForm schema={view.schema} value={value} onChange={setValue} showAllErrors={tried} pickPath={() => desktop.openFolder()} />
      </div>
      <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={() => void submit()}>{view.submit.label ?? 'Submit'}</Button></div>
    </Page>
  );
}

export function HomeCardHost({ card }: { card: HomeCard }): React.ReactElement | null {
  const body = (() => {
    if (card.kind === 'markdown') return <Markdown text={card.markdown ?? ''} />;
    if (card.kind === 'frame' && card.entry) return <PluginFrame plugin={card.plugin} contribution={card.qid} entry={card.entry} height={160} />;
    const C = card.component ? nativeComponent(card.plugin, card.component) : undefined;
    return C ? <C params={{}} plugin={card.plugin} contribution={card.qid} /> : null;
  })();
  if (!body) return null;
  return (
    <section data-home-card={card.qid} className="rounded-2xl border border-hx-border-subtle bg-hx-elevated p-4">
      <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-hx-muted">{card.title}</div>
      <RenderBoundary fallback={(e, retry) => <Failed what={card.title} error={e} retry={retry} plugin={card.plugin} />}>{body}</RenderBoundary>
    </section>
  );
}

export function PanelHost({ panel, params, data }: { panel: Panel; params?: Record<string, string>; data?: unknown }): React.ReactElement {
  if (panel.kind === 'frame' && panel.entry) return <PluginFrame key={JSON.stringify(params ?? {})} plugin={panel.plugin} contribution={panel.qid} entry={panel.entry} params={params} fill title={panel.title} />;
  const C = panel.component ? nativeComponent(panel.plugin, panel.component) : undefined;
  return C ? <RenderBoundary key={JSON.stringify(params ?? {})} fallback={(e, retry) => <Failed what={`The ${panel.title} panel`} error={e} retry={retry} plugin={panel.plugin} />}><C params={params ?? {}} plugin={panel.plugin} contribution={panel.qid} data={data} /></RenderBoundary> : <EmptyState icon="puzzle" title="Panel not available" />;
}
