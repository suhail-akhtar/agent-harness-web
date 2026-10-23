/**
 * The window: sidebar, top bar, the routed view (and optionally a second view beside it), an
 * optional side panel, the status bar, and the overlays. Which page shows is the registry's
 * business: the route names a view contribution.
 */

import React, { useEffect, useState } from 'react';
import { Artifact, BlockActionsContext, Button, EmptyState, IconButton, RenderBoundary, ResizablePane, Toaster, Tooltip } from '@harness/ui';
import { SIDE_PANEL_PANE, SPLIT_PANE } from '../state/layout';
import { useApp, navigate, HOME, NARROW_PX } from '../state/app';
import type { View } from '../registry/registry';
import { useData } from '../state/data';
import { ViewHost, PanelHost, PaneContext } from '../registry/PluginView';
import { runCommand } from '../registry/actions';
import { allowedWhileTyping, matches, parseChord } from '../registry/keybindings';
import { platform } from '../bridge';
import { Sidebar } from './Sidebar';
import { StatusBar, TopBar, pageTitle } from './Bars';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from '../components/FilePreview';
import { ConfirmHost, EngineGate, FullWindow, Onboarding, SettingsModal, ShortcutsSheet, WorkflowDialog } from './Overlays';

function useKeybindings() {
  const commands = useData((s) => s.registry.commands);
  useEffect(() => {
    const bound = commands.flatMap((c) => { const ch = c.keys ? parseChord(c.keys, platform) : null; return ch ? [{ qid: c.qid, ch }] : []; });
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
      for (const b of bound) {
        if (!matches(b.ch, e)) continue;
        if (typing && !allowedWhileTyping(b.ch)) continue;
        // A modal dialog keeps its keys (except the palette, settings and shortcuts toggles).
        if (document.querySelector('[aria-modal="true"]') && !['core.shell:palette', 'core.settings:open', 'core.shell:shortcuts'].includes(b.qid)) continue;
        e.preventDefault();
        void runCommand(b.qid);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands]);
}

function useNarrow(px: number) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < px);
  useEffect(() => { const f = () => setNarrow(window.innerWidth < px); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, [px]);
  return narrow;
}

/** The window's title follows the page: "<page> - <product>". */
function useWindowTitle() {
  const route = useApp((s) => s.route);
  const crumb = useApp((s) => s.crumb);
  const info = useApp((s) => s.info);
  const registry = useData((s) => s.registry);
  useEffect(() => {
    const name = info?.product.name ?? 'Harness';
    const page = pageTitle(registry, route, crumb);
    document.title = page && page !== name ? `${page} - ${name}` : name;
  }, [route, crumb, info, registry]);
}

export function App(): React.ReactElement {
  useKeybindings();
  useWindowTitle();
  const route = useApp((s) => s.route);
  const registry = useData((s) => s.registry);
  const panel = useApp((s) => s.panel);
  const split = useApp((s) => s.split);
  const narrow = useNarrow(NARROW_PX);
  const view = registry.views.get(route.view);
  const splitView = split ? registry.views.get(split.view) : undefined;
  // Leaving narrow closes the floating sidebar (it is the narrow window's own state).
  useEffect(() => { if (!narrow) useApp.setState({ narrowSidebarOpen: false }); }, [narrow]);
  // A conversation's panel follows the conversation on screen (open on another page, it keeps the one it showed).
  useEffect(() => {
    const p = useApp.getState().panel;
    const id = route.view === 'core.chat:session' ? route.params?.id : undefined;
    if (!id || p?.kind !== 'plugin' || registry.panels.get(p.panel)?.where !== 'session' || p.params?.id === id) return;
    useApp.setState({ panel: { kind: 'plugin', panel: p.panel, params: { id } } });
  }, [route.view, route.params?.id]);
  // Plugins' actions on drawn blocks (a chart's "Add to dashboard"): each runs its command with the block.
  const blockActions = React.useMemo(() => (registry.blockActions.length ? (b: { kind: string; lang: string; source: string }) => registry.blockActions.filter((a) => a.kinds.includes(b.kind)).map((a) => <IconButton key={a.qid} size="xs" icon={a.icon ?? 'plus'} label={a.title} data-block-action={a.qid} onClick={() => void runCommand(a.command, { lang: b.lang, source: b.source, kind: b.kind })} />) : null), [registry.blockActions]);
  return (
    <BlockActionsContext.Provider value={blockActions}>
    <div className="flex h-full flex-col bg-hx-bg text-hx-primary" data-app>
      <EngineGate />
      <div className="flex min-h-0 flex-1">
        {narrow ? <NarrowSidebar /> : <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col">
          {route.view !== 'core.chat:session' && <TopBar />}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1" data-view={route.view}>
              {view ? <ViewHost key={route.view} view={view} params={route.params ?? {}} />
                : (
                  <EmptyState icon="puzzle" title="This page is not available" action={<Button variant="primary" onClick={() => navigate(HOME)}>Go home</Button>}>
                    {registry.active.length ? `Nothing provides ${route.view}; its plugin may be switched off.` : 'Loading plugins…'}
                  </EmptyState>
                )}
            </div>
            {split && splitView && !narrow && <SplitPane view={splitView} params={split.params ?? {}} />}
            {panel && <SidePanel narrow={narrow} />}
          </div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsModal />
      <Onboarding />
      <WorkflowDialog />
      <ShortcutsSheet />
      <FullWindow />
      <ConfirmHost />
      <Toaster />
    </div>
    </BlockActionsContext.Provider>
  );
}

/**
 * The side panel (artifacts, agents, details, plugin panels): resizable from its left edge (its
 * width is the 'side-panel' pane's, kept in the prefs). A narrow window floats it over the page.
 */
function SidePanel({ narrow }: { narrow: boolean }) {
  const panel = useApp((s) => s.panel)!;
  const registry = useData((s) => s.registry);
  const panelDef = panel.kind === 'plugin' ? registry.panels.get(panel.panel) : undefined;
  const body = (
    <>
      <div className="flex h-10 items-center gap-2 border-b border-hx-border-subtle px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{panel.kind === 'plugin' ? panelDef?.title ?? 'Panel' : panel.title}</span>
        <IconButton icon="x" size="sm" label="Close the panel" onClick={() => useApp.setState({ panel: null })} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {panel.kind === 'artifact' ? <Artifact kind={panel.artifact} source={panel.source} language={panel.language} title={panel.title} fill />
          : panel.kind === 'file' ? <FilePreview path={panel.path} content={panel.content} fill />
          : panelDef ? <PanelHost panel={panelDef} params={panel.params} data={panel.data} /> : <EmptyState title="This panel is not available" />}
      </div>
    </>
  );
  if (narrow) return <aside data-side-panel className="absolute inset-y-10 right-0 z-30 flex w-[min(420px,92vw)] shrink-0 flex-col border-l border-hx-border-subtle bg-hx-bg shadow-[var(--hx-shadow)]">{body}</aside>;
  return <ResizablePane spec={SIDE_PANEL_PANE} edge="start" as="aside" data-side-panel="" className="flex flex-col border-l border-hx-border-subtle bg-hx-bg">{body}</ResizablePane>;
}

/**
 * A second view beside the first (a linked conversation next to this one): resizable with the
 * divider (drag, the arrow keys on it, double-click for the default), closeable, and "open here"
 * swaps it into the main place.
 */
function SplitPane({ view, params }: { view: View; params: Record<string, string> }) {
  const close = () => useApp.setState({ split: null });
  const here = () => { const r = useApp.getState().split; useApp.setState({ split: null }); if (r) navigate(r); };
  return (
    <ResizablePane spec={SPLIT_PANE} edge="start" handle={{ 'data-split-handle': '' }} data-split-view={view.qid} data-split-params={JSON.stringify(params)} className="flex min-w-0 flex-col border-l border-hx-border-subtle">
      <PaneContext.Provider value={{ split: true, close, here }}>
        {view.qid !== 'core.chat:session' && (
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hx-border-subtle px-3">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{view.title}</span>
            <Tooltip label="Open here"><IconButton icon="pop-out" size="sm" label="Open here" onClick={here} /></Tooltip>
            <IconButton icon="x" size="sm" label="Close the view beside" onClick={close} data-close-split />
          </div>
        )}
        <div className="min-h-0 flex-1"><ViewHost view={view} params={params} /></div>
      </PaneContext.Provider>
    </ResizablePane>
  );
}

/**
 * Below the narrow width the sidebar is a rail; expanding it floats over the page until a page is
 * picked, the scrim is clicked, Escape is pressed or the sidebar command (Ctrl+B) runs again. This
 * open state is the window's, not a saved preference.
 */
function NarrowSidebar() {
  const open = useApp((s) => s.narrowSidebarOpen);
  const route = useApp((s) => s.route);
  const setOpen = (v: boolean) => useApp.setState({ narrowSidebarOpen: v });
  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return <Sidebar collapsed onToggle={() => setOpen(true)} />;
  return (
    <>
      <div className="w-14 shrink-0" />
      <div className="fixed inset-y-0 left-0 z-40 shadow-[var(--hx-shadow)]" data-floating-sidebar><Sidebar collapsed={false} onToggle={() => setOpen(false)} /></div>
      <div className="fixed inset-0 z-30 bg-[var(--hx-scrim)]" onClick={() => setOpen(false)} />
    </>
  );
}

export { runCommand };
