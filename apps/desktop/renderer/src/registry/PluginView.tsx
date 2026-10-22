/**
 * Drawing contributions: a view (markdown, links, prompt board, form, frame or native), a home card,
 * a side panel. The same code draws a built-in's page and a third-party plugin's.
 */

import React, { useState } from 'react';
import { Button, EmptyState, Icon, Markdown, SchemaForm, withDefaults, validate, RenderBoundary } from '@harness/ui';
import type { JsonSchema } from '@harness/plugin-ui';
import { useData } from '../state/data';
import { prefill } from '../state/app';
import type { HomeCard, Panel, View } from './registry';
import { runAction } from './actions';
import { PluginFrame } from './Frame';
import { desktop } from '../bridge';

export interface NativeProps { params: Record<string, string>; plugin: string; contribution: string; /** A panel's structured input (openPluginPanel). */ data?: unknown }

function nativeComponent(plugin: string, component: string): React.ComponentType<NativeProps> | undefined {
  const e = useData.getState().registry.active.find((p) => p.name === plugin);
  return e?.native?.components[component] as React.ComponentType<NativeProps> | undefined;
}

function Failed({ what, error, retry }: { what: string; error: string; retry: () => void }) {
  return <div className="m-6 rounded-xl border border-hx-danger/30 bg-hx-danger/8 p-4 text-[13px]" data-render-error><b>{what} failed.</b> {error} <button type="button" className="ml-2 underline" onClick={retry}>Try again</button></div>;
}

export function ViewHost({ view, params }: { view: View; params: Record<string, string> }): React.ReactElement {
  const body = (() => {
    switch (view.kind) {
      case 'native': {
        const C = nativeComponent(view.plugin, view.component);
        return C ? <C params={params} plugin={view.plugin} contribution={view.qid} /> : <EmptyState icon="puzzle" title="This page is not available">{view.plugin} did not provide {view.component}.</EmptyState>;
      }
      case 'frame': return <div className="h-full p-0"><PluginFrame plugin={view.plugin} contribution={view.qid} entry={view.entry} params={params} fill title={view.title} /></div>;
      case 'markdown': return <div className="hx-scroll h-full overflow-auto"><div className="mx-auto max-w-column px-6 py-8"><Markdown text={view.markdown} /></div></div>;
      case 'links': return (
        <div className="hx-scroll h-full overflow-auto"><div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="mb-4 text-[20px] font-semibold">{view.title}</h1>
          {view.description && <p className="mb-4 text-[13px] text-hx-muted">{view.description}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {view.links.map((l) => (
              <button key={l.url} type="button" onClick={() => void desktop.openExternal(l.url)} className="flex items-start gap-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3 text-left hover:border-hx-border">
                <Icon name="external" size={16} className="mt-0.5 text-hx-muted" />
                <span><span className="block text-[13.5px] font-medium">{l.title}</span>{l.description && <span className="block text-[12px] text-hx-muted">{l.description}</span>}<span className="block truncate text-[11px] text-hx-muted">{l.url}</span></span>
              </button>
            ))}
          </div>
        </div></div>
      );
      case 'prompt-board': return (
        <div className="hx-scroll h-full overflow-auto"><div className="mx-auto max-w-3xl px-6 py-8">
          <h1 className="mb-4 text-[20px] font-semibold">{view.title}</h1>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.prompts.map((p, i) => (
              <button key={i} type="button" onClick={() => prefill(p.prompt, true)} className="flex items-start gap-3 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3 text-left hover:border-hx-border">
                <Icon name={p.icon ?? 'sparkles'} size={16} className="mt-0.5 text-hx-accent-text" />
                <span><span className="block text-[13.5px] font-medium">{p.title}</span><span className="line-clamp-2 block text-[12px] text-hx-muted">{p.prompt}</span></span>
              </button>
            ))}
          </div>
        </div></div>
      );
      case 'form': return <FormView view={view} />;
    }
  })();
  return <RenderBoundary fallback={(e, retry) => <Failed what={view.title} error={e} retry={retry} />}>{body}</RenderBoundary>;
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
    <div className="hx-scroll h-full overflow-auto"><div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-[20px] font-semibold">{view.title}</h1>
      {view.description && <p className="mt-1 text-[13px] text-hx-muted">{view.description}</p>}
      <div className="mt-4 rounded-xl border border-hx-border-subtle bg-hx-elevated px-4">
        <SchemaForm schema={view.schema} value={value} onChange={setValue} showAllErrors={tried} pickPath={() => desktop.openFolder()} />
      </div>
      <div className="mt-4 flex justify-end"><Button variant="primary" loading={busy} onClick={() => void submit()}>{view.submit.label ?? 'Submit'}</Button></div>
    </div></div>
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
      <RenderBoundary fallback={(e, retry) => <Failed what={card.title} error={e} retry={retry} />}>{body}</RenderBoundary>
    </section>
  );
}

export function PanelHost({ panel, params, data }: { panel: Panel; params?: Record<string, string>; data?: unknown }): React.ReactElement {
  if (panel.kind === 'frame' && panel.entry) return <PluginFrame plugin={panel.plugin} contribution={panel.qid} entry={panel.entry} params={params} fill title={panel.title} />;
  const C = panel.component ? nativeComponent(panel.plugin, panel.component) : undefined;
  return C ? <C params={params ?? {}} plugin={panel.plugin} contribution={panel.qid} data={data} /> : <EmptyState icon="puzzle" title="Panel not available" />;
}
