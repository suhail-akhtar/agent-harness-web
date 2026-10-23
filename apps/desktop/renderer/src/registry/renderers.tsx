/**
 * The registry's renderers as hooks the rich renderers of @harness/ui call: a plugin's renderer for
 * a fence language or an artifact kind replaces the default. Shared by every view that draws
 * Markdown or artifacts (the transcript, the Artifacts panel, the Library).
 */

import React, { useCallback } from 'react';
import { ArtifactFrame, CodeBlock, DiagramPlaceholder, Icon, RenderBoundary, type ArtifactRenderer, type FenceRenderer } from '@harness/ui';
import { useData } from '../state/data';
import { navigate } from '../state/app';
import { offRendererFor, rendererFor, type OffRenderer } from './registry';
import { PluginFrame } from './Frame';

/**
 * Under something a switched-off plugin would draw (an old conversation's tool card or event, an
 * artifact of a kind it renders): what it is drawn with now, and where to switch the plugin on.
 */
export function OffPluginNote({ off }: { off: OffRenderer }): React.ReactElement {
  return (
    <div data-plugin-off={off.plugin} className="mt-1 flex items-center gap-2 rounded-md bg-hx-pill px-2 py-1 text-[11.5px] text-hx-muted">
      <Icon name="puzzle" size={12} className="shrink-0" />
      <span className="min-w-0 flex-1">Made with {off.title}, which is off. Switch it on to view it fully</span>
      <button type="button" data-open-plugins className="shrink-0 font-medium text-hx-secondary underline-offset-2 hover:text-hx-primary hover:underline" onClick={() => navigate({ view: 'core.plugins:plugins' })}>Plugins</button>
    </div>
  );
}

/** The plugin renderers as a fence hook for Markdown. */
export function useFenceRenderer(): FenceRenderer {
  const registry = useData((s) => s.registry);
  return useCallback((lang: string, source: string, streaming?: boolean) => {
    const r = rendererFor(registry, 'fence', lang.toLowerCase());
    if (!r) return undefined;
    // A frame gets its block once, when it loads: while the block still streams in it is shown as
    // code, and a frame starts again (key) if the finished block's text changes.
    if (r.kind === 'frame' && r.entry && streaming) return <CodeBlock code={source} language={lang} />;
    if (r.kind === 'frame' && r.entry) return <div className="my-3 overflow-hidden rounded-xl border border-hx-border-subtle" data-plugin-renderer={r.qid}><PluginFrame key={source} plugin={r.plugin} contribution={r.qid} entry={r.entry} height={r.height ?? 120} context={{ fence: lang, source }} /></div>;
    const C = r.component ? registry.active.find((p) => p.name === r.plugin)?.native?.components[r.component] as React.ComponentType<{ source: string; lang: string }> | undefined : undefined;
    return C ? <RenderBoundary fallback={() => <CodeBlock code={source} language={lang} />}><C source={source} lang={lang} /></RenderBoundary> : undefined;
  }, [registry]);
}

/** The plugin renderers for artifact kinds (html, svg, react, diagram ...), for @harness/ui's Artifact (setArtifactHost). */
export function useArtifactRenderer(): ArtifactRenderer {
  const registry = useData((s) => s.registry);
  return useCallback((kind, source, o) => {
    const r = rendererFor(registry, 'artifact', kind);
    if (!r) {
      // Only a switched-off plugin draws this kind: a basic view (the spec as JSON, the page as it is) and a note.
      const off = offRendererFor(registry, 'artifact', kind);
      if (!off) return undefined;
      return <div data-artifact-basic={kind}><div className="px-2"><OffPluginNote off={off} /></div>{kind === 'diagram' ? <DiagramPlaceholder source={source} /> : <ArtifactFrame kind={kind} source={source} fill={o.fill} />}</div>;
    }
    if (r.kind === 'frame' && r.entry) return <PluginFrame plugin={r.plugin} contribution={r.qid} entry={r.entry} height={r.height ?? 360} fill={o.fill} context={{ artifact: kind, source, title: o.title }} />;
    const C = r.component ? registry.active.find((p) => p.name === r.plugin)?.native?.components[r.component] as React.ComponentType<{ kind: string; source: string; title: string; fill?: boolean; origin?: typeof o.origin }> | undefined : undefined;
    return C ? <C kind={kind} source={source} title={o.title} fill={o.fill} origin={o.origin} /> : undefined;
  }, [registry]);
}

/** A native component a plugin registered for an event kind (or undefined). */
export function useEventComponent<P>(kind: string): React.ComponentType<P> | undefined {
  const registry = useData((s) => s.registry);
  const r = rendererFor(registry, 'event', kind);
  if (!r?.component) return undefined;
  return registry.active.find((p) => p.name === r.plugin)?.native?.components[r.component] as React.ComponentType<P> | undefined;
}
