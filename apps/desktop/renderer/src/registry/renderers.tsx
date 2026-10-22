/**
 * The registry's renderers as hooks the rich renderers of @harness/ui call: a plugin's renderer for
 * a fence language or an artifact kind replaces the default. Shared by every view that draws
 * Markdown or artifacts (the transcript, the Artifacts panel, the Library).
 */

import React, { useCallback } from 'react';
import type { ArtifactRenderer, FenceRenderer } from '@harness/ui';
import { useData } from '../state/data';
import { rendererFor } from './registry';
import { PluginFrame } from './Frame';

/** The plugin renderers as a fence hook for Markdown. */
export function useFenceRenderer(): FenceRenderer {
  const registry = useData((s) => s.registry);
  return useCallback((lang: string, source: string) => {
    const r = rendererFor(registry, 'fence', lang.toLowerCase());
    if (!r) return undefined;
    if (r.kind === 'frame' && r.entry) return <div className="my-3 overflow-hidden rounded-xl border border-hx-border-subtle" data-plugin-renderer={r.qid}><PluginFrame plugin={r.plugin} contribution={r.qid} entry={r.entry} height={r.height ?? 120} context={{ fence: lang, source }} /></div>;
    const C = r.component ? registry.active.find((p) => p.name === r.plugin)?.native?.components[r.component] as React.ComponentType<{ source: string; lang: string }> | undefined : undefined;
    return C ? <C source={source} lang={lang} /> : undefined;
  }, [registry]);
}

/** The plugin renderers for artifact kinds (html, svg, react, diagram ...), for @harness/ui's Artifact (setArtifactHost). */
export function useArtifactRenderer(): ArtifactRenderer {
  const registry = useData((s) => s.registry);
  return useCallback((kind, source, o) => {
    const r = rendererFor(registry, 'artifact', kind);
    if (!r) return undefined;
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
