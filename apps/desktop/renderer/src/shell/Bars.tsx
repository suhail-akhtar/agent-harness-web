/**
 * The top bar (back, forward, where you are, panels; the window's own drag area) and the status bar
 * (engine health, live event stream, running work, plugins' status items).
 */

import React from 'react';
import { cx, Icon, IconButton, Tooltip } from '@harness/ui';
import { useApp, navigate } from '../state/app';
import { useData } from '../state/data';
import { interpolate } from '../registry/registry';
import { crumbsFor, pageTitle } from '../registry/crumbs';
import { runCommand } from '../registry/actions';
import { formatChord } from '../registry/keybindings';
import { usePane } from '../registry/PluginView';
import { platform } from '../bridge';

export { crumbsFor, pageTitle };

export function TopBar({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }): React.ReactElement {
  const back = useApp((s) => s.back.length);
  const fwd = useApp((s) => s.forward.length);
  const route = useApp((s) => s.route);
  const crumb = useApp((s) => s.crumb);
  const registry = useData((s) => s.registry);
  const panel = useApp((s) => s.panel);
  const pane = usePane();
  const inSession = route.view === 'core.chat:session';
  const panels = pane.split ? [] : [...registry.panels.values()].filter((p) => (p.where ?? 'any') === 'any' || (p.where === 'session') === inSession);
  const c = crumbsFor(registry, route, crumb, typeof title === 'string' ? title : undefined);
  if (pane.split) {
    // Beside the main view: its title, open it here, close it.
    return (
      <header data-topbar="split" className="flex h-10 shrink-0 items-center gap-1 border-b border-hx-border-subtle bg-hx-bg px-2">
        <Icon name="split" size={14} className="ml-1 text-hx-muted" />
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-medium" data-breadcrumb>{title}</span>
        {children}
        <Tooltip label="Open here"><IconButton icon="pop-out" size="sm" label="Open here" onClick={pane.here} /></Tooltip>
        <Tooltip label="Close"><IconButton icon="x" size="sm" label="Close the view beside" onClick={pane.close} data-close-split /></Tooltip>
      </header>
    );
  }
  return (
    <header data-topbar className="app-drag flex h-10 shrink-0 items-center gap-1 border-b border-hx-border-subtle bg-hx-bg pl-2" style={{ paddingRight: 'max(8px, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px))' }}>
      <div className="app-no-drag flex items-center">
        <Tooltip label="Back" shortcut={formatChord('Alt+Left', platform)}><IconButton icon="arrow-left" size="sm" label="Back" disabled={!back} onClick={() => useApp.getState().goBack()} /></Tooltip>
        <Tooltip label="Forward" shortcut={formatChord('Alt+Right', platform)}><IconButton icon="arrow-right" size="sm" label="Forward" disabled={!fwd} onClick={() => useApp.getState().goForward()} /></Tooltip>
      </div>
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[13px]" data-crumbs>
        {c.parent && (c.parent.route
          ? <button type="button" data-crumb-parent onClick={() => navigate(c.parent!.route!)} className="app-no-drag shrink-0 rounded px-0.5 text-hx-muted hover:text-hx-primary">{c.parent.label}</button>
          : <span data-crumb-parent className="shrink-0 text-hx-muted">{c.parent.label}</span>)}
        {c.parent && <Icon name="chevron-right" size={12} className="shrink-0 text-hx-muted" />}
        <span className="min-w-0 truncate font-medium text-hx-primary" data-breadcrumb>{title ?? c.title}</span>
      </nav>
      <div className="app-no-drag flex items-center gap-0.5">
        {children}
        {panels.map((p) => (
          <Tooltip key={p.qid} label={p.title}>
            <IconButton icon={p.icon ?? 'panel-right'} size="sm" label={p.title} active={panel?.kind === 'plugin' && panel.panel === p.qid} data-panel-toggle={p.qid}
              onClick={() => useApp.setState({ panel: panel?.kind === 'plugin' && panel.panel === p.qid ? null : { kind: 'plugin', panel: p.qid, params: route.params } })} />
          </Tooltip>
        ))}
        <Tooltip label="Command palette" shortcut={formatChord('Mod+K', platform)}><IconButton icon="command" size="sm" label="Command palette" onClick={() => useApp.setState({ paletteOpen: true })} /></Tooltip>
      </div>
    </header>
  );
}

export function StatusBar(): React.ReactElement {
  const engine = useApp((s) => s.engine);
  const badges = useApp((s) => s.badges);
  const items = useData((s) => s.registry.statusItems);
  const mode = useData((s) => s.eventsMode);
  const info = useApp((s) => s.info);
  const dot = engine.status === 'ready' ? 'bg-hx-success' : engine.status === 'starting' ? 'bg-hx-warning' : 'bg-hx-danger';
  const label = engine.status === 'ready' ? (engine.remote ? `Connected to ${engine.origin.replace(/^https?:\/\//, '')}` : 'Engine ready') : engine.status === 'starting' ? 'Engine starting…' : engine.status === 'crashed' ? 'Engine stopped, retrying' : 'Engine stopped';
  const left = items.filter((i) => (i.align ?? 'left') === 'left');
  const right = items.filter((i) => i.align === 'right');
  const item = (i: (typeof items)[number]) => (
    <Tooltip key={i.qid} label={i.tooltip ?? i.text}>
      <button type="button" data-status-item={i.qid} disabled={!i.command} onClick={() => i.command && void runCommand(i.command.includes(':') ? i.command : `${i.plugin}:${i.command}`)} className="inline-flex h-full items-center px-2 hover:bg-hx-hover disabled:hover:bg-transparent">
        {interpolate(i.text, badges)}
      </button>
    </Tooltip>
  );
  return (
    <footer data-statusbar className="flex h-6 shrink-0 items-center border-t border-hx-border-subtle bg-hx-sidebar text-[11.5px] text-hx-muted">
      <button type="button" data-engine-status={engine.status} onClick={() => void runCommand('core.settings:engine')} className="inline-flex h-full items-center gap-1.5 px-2.5 hover:bg-hx-hover">
        <span className={cx('h-2 w-2 rounded-full', dot)} />{label}
      </button>
      {engine.status === 'ready' && <span className="px-2" title={mode === 'stream' ? 'Live updates from the server' : 'This server has no live stream: checking every few seconds'}>{mode === 'stream' ? 'Live' : mode === 'polling' ? 'Polling' : mode === 'retrying' ? 'Reconnecting…' : ''}</span>}
      {left.map(item)}
      <div className="flex-1" />
      {right.map(item)}
      <span className="px-2.5">{info ? `${info.product.name} ${info.version}` : ''}</span>
    </footer>
  );
}
