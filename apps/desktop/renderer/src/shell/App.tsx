/**
 * The window: sidebar, top bar, the routed view, an optional side panel, the status bar, and the
 * overlays. Which page shows is the registry's business: the route names a view contribution.
 */

import React, { useEffect, useState } from 'react';
import { Artifact, Button, EmptyState, IconButton, Toaster, RenderBoundary } from '@harness/ui';
import { useApp, navigate, HOME } from '../state/app';
import { useData } from '../state/data';
import { ViewHost, PanelHost } from '../registry/PluginView';
import { runCommand } from '../registry/actions';
import { allowedWhileTyping, matches, parseChord } from '../registry/keybindings';
import { platform } from '../bridge';
import { Sidebar } from './Sidebar';
import { StatusBar, TopBar } from './Bars';
import { CommandPalette } from './CommandPalette';
import { FilePreview } from '../components/FilePreview';
import { ConfirmHost, EngineGate, Onboarding, SettingsModal, WorkflowDialog } from './Overlays';

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
        // A modal dialog keeps its keys (except the palette and settings toggles).
        if (document.querySelector('[aria-modal="true"]') && !['core.shell:palette', 'core.settings:open'].includes(b.qid)) continue;
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

export function App(): React.ReactElement {
  useKeybindings();
  const route = useApp((s) => s.route);
  const registry = useData((s) => s.registry);
  const panel = useApp((s) => s.panel);
  const prefs = useApp((s) => s.prefs);
  const narrow = useNarrow(760);
  const view = registry.views.get(route.view);
  const panelDef = panel?.kind === 'plugin' ? registry.panels.get(panel.panel) : undefined;
  return (
    <div className="flex h-full flex-col bg-hx-bg text-hx-primary" data-app>
      <EngineGate />
      <div className="flex min-h-0 flex-1">
        {narrow ? <NarrowSidebar /> : <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col">
          {route.view !== 'core.chat:session' && <TopBar />}
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1" data-view={route.view}>
              {view ? (
                <RenderBoundary key={`${route.view}`} fallback={(e, retry) => <EmptyState icon="alert" title="This page failed" action={<Button onClick={retry}>Try again</Button>}>{e}</EmptyState>}>
                  <ViewHost view={view} params={route.params ?? {}} />
                </RenderBoundary>
              ) : (
                <EmptyState icon="puzzle" title="This page is not available" action={<Button variant="primary" onClick={() => navigate(HOME)}>Go home</Button>}>
                  {registry.active.length ? `Nothing provides ${route.view}; its plugin may be switched off.` : 'Loading plugins…'}
                </EmptyState>
              )}
            </div>
            {panel && (
              <aside data-side-panel className={`flex shrink-0 flex-col border-l border-hx-border-subtle bg-hx-bg ${narrow ? 'absolute inset-y-10 right-0 z-30 w-[min(420px,92vw)] shadow-[var(--hx-shadow)]' : 'w-[min(520px,42vw)]'}`}>
                <div className="flex h-10 items-center gap-2 border-b border-hx-border-subtle px-3">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{panel.kind === 'plugin' ? panelDef?.title ?? 'Panel' : panel.title}</span>
                  <IconButton icon="x" size="sm" label="Close the panel" onClick={() => useApp.setState({ panel: null })} />
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2">
                  {panel.kind === 'artifact' ? <Artifact kind={panel.artifact} source={panel.source} language={panel.language} title={panel.title} fill />
                    : panel.kind === 'file' ? <FilePreview path={panel.path} content={panel.content} fill />
                    : panelDef ? <PanelHost panel={panelDef} params={panel.params} data={panel.data} /> : <EmptyState title="This panel is not available" />}
                </div>
              </aside>
            )}
          </div>
        </main>
      </div>
      <StatusBar />
      <CommandPalette />
      <SettingsModal />
      <Onboarding />
      <WorkflowDialog />
      <ConfirmHost />
      <Toaster />
    </div>
  );
}

/**
 * Below 760px the sidebar is a rail; expanding it floats over the page until a page is picked, the
 * scrim is clicked or Escape is pressed. This open state is the window's, not a saved preference.
 */
function NarrowSidebar() {
  const [open, setOpen] = useState(false);
  const route = useApp((s) => s.route);
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
      <div className="fixed inset-y-0 left-0 z-40 shadow-[var(--hx-shadow)]"><Sidebar collapsed={false} onToggle={() => setOpen(false)} /></div>
      <div className="fixed inset-0 z-30 bg-[var(--hx-scrim)]" onClick={() => setOpen(false)} />
    </>
  );
}

export { runCommand };
