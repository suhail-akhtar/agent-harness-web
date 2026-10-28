/**
 * The sidebar: navigation from the registry (primary, More, footer), projects, and conversations
 * (pinned first, with pin, rename, archive and delete). Collapses to a rail; resizable.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { cx, Icon, IconButton, Menu, ResizeHandle, Tooltip, toast, Input, useResizable, type MenuItem } from '@harness/ui';
import type { SessionMeta } from '@harness/client';
import { useApp, navigate, openSession, FOCUS } from '../state/app';
import { useData, client } from '../state/data';
import { interpolate, isHomeRoute, type MenuGroup, type NavItem } from '../registry/registry';
import { formatChord } from '../registry/keybindings';
import { runCommand } from '../registry/actions';
import { desktop, platform } from '../bridge';
import { ProductMark } from '../components/ProductMark';
import { SIDEBAR_PANE } from '../state/layout';
import { contextItems } from './ContextMenu';

/** The sidebar; a narrow window passes its own (unsaved) collapsed state and toggle. */
export function Sidebar({ collapsed: forced, onToggle }: { collapsed?: boolean; onToggle?: () => void } = {}): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  // Its width and collapsing are the 'sidebar' pane's (dragged below the threshold it collapses to the rail; dragged out again it expands).
  const pane = useResizable(SIDEBAR_PANE, { edge: 'end', ...(forced !== undefined ? { forceCollapsed: forced } : {}) });
  const collapsed = pane.collapsed;
  const registry = useData((s) => s.registry);
  const info = useApp((s) => s.info);
  const focused = FOCUS ? registry.plugins.find((p) => p.name === FOCUS) : undefined;
  const [moreOpen, setMoreOpen] = useState(false);
  // Items a plugin's menu shows are drawn in its group, not at the top level.
  const top = registry.navItems.filter((n) => !n.group);
  const primary = top.filter((n) => (n.placement ?? 'primary') === 'primary');
  const more = top.filter((n) => n.placement === 'more');
  const footer = top.filter((n) => n.placement === 'footer');

  return (
    <aside ref={pane.paneRef} id={pane.paneId} data-sidebar data-collapsed={collapsed ? '1' : '0'} className="relative flex h-full shrink-0 flex-col border-r border-hx-border-subtle bg-hx-sidebar" style={pane.paneStyle}>
      <div className="app-drag flex h-10 shrink-0 items-center gap-2 px-3">
        {!collapsed && !focused && <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-hx-primary"><Logo />{info?.product.brand.wordmark ?? info?.product.name ?? 'Harness'}</span>}
        {!collapsed && focused && (
          // A window focused on one plugin: its name and icon; the full app is a click away.
          <span data-focus-header={FOCUS} className="flex min-w-0 items-center gap-2 text-[14px] font-semibold tracking-tight text-hx-primary">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name={focused.ui?.icon ?? 'puzzle'} size={14} /></span>
            <span className="truncate">{focused.ui?.displayName ?? focused.name}</span>
          </span>
        )}
        {!collapsed && focused && <IconButton className="app-no-drag" icon="apps" size="sm" label={`Open ${info?.product.name ?? 'Harness'}: everything, not only ${focused.ui?.displayName ?? focused.name}`} onClick={() => void desktop.revealMain()} />}
        <div className="flex-1" />
        <IconButton className="app-no-drag" icon="sidebar" size="sm" label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} onClick={onToggle ?? (() => useApp.getState().setPrefs({ sidebar: { ...prefs.sidebar, collapsed: !collapsed } }))} />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 pb-2">
        {primary.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} />)}
        {collapsed && registry.groups.map((g) => <RailGroup key={g.plugin} group={g} />)}
        {more.length > 0 && (
          <>
            <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-hx-secondary hover:bg-hx-hover', collapsed && 'justify-center px-0')}>
              <Icon name={moreOpen ? 'chevron-down' : 'more'} size={16} />{!collapsed && 'More'}
            </button>
            {moreOpen && more.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} indent />)}
          </>
        )}
      </nav>
      {!collapsed && <div className="hx-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">{registry.groups.length > 0 && <Modules />}<Projects /><Conversations /></div>}
      {collapsed && <div className="flex-1" />}
      <div className="flex flex-col gap-0.5 border-t border-hx-border-subtle p-2">
        {footer.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} />)}
        {registry.commands.some((c) => c.qid === 'core.settings:open') && <button type="button" data-open-settings onClick={() => void runCommand('core.settings:open')} className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-hx-secondary hover:bg-hx-hover hover:text-hx-primary', collapsed && 'justify-center px-0')} title="Settings">
          <Icon name="settings" size={16} />{!collapsed && <span className="flex-1 text-left">Settings</span>}{!collapsed && <span className="text-[11px] text-hx-muted">{formatChord(registry.commands.find((c) => c.qid === 'core.settings:open')?.keys ?? '', platform)}</span>}
        </button>}
        <Profile collapsed={collapsed} />
      </div>
      {forced === undefined && <ResizeHandle r={pane} edge="end" />}
    </aside>
  );
}

function Logo() { return <ProductMark size={24} />; }

function NavRow({ item, collapsed, indent, depth = 0 }: { item: NavItem; collapsed: boolean; indent?: boolean; depth?: number }) {
  const route = useApp((s) => s.route);
  const badges = useApp((s) => s.badges);
  const active = route.view === item.view && (!item.params || JSON.stringify(item.params) === JSON.stringify(route.params ?? {}));
  const badge = item.badge ? badges[item.badge] : undefined;
  const row = (
    <button type="button" data-nav={item.qid} {...(item.group ? { 'data-in-group': item.group } : {})} aria-current={active ? 'page' : undefined} onClick={() => navigate({ view: item.view, ...(item.params ? { params: item.params } : {}) })}
      onContextMenu={contextItems(() => [
        { id: 'open', label: `Open ${item.title}`, icon: item.icon ?? 'puzzle', onSelect: () => navigate({ view: item.view, ...(item.params ? { params: item.params } : {}) }) },
        ...(item.plugin.startsWith('core.') ? [] : [{ id: 'app', label: 'Open as its own app', icon: 'external', onSelect: () => void desktop.openPluginWindow(item.plugin) }]),
      ], item.title)}
      className={cx('relative flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors', collapsed && 'justify-center px-0', indent && !collapsed && 'pl-6', depth === 1 && !collapsed && 'pl-7', depth >= 2 && !collapsed && 'h-7 pl-11 text-[12.5px]',
        active ? 'bg-hx-active font-medium text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover hover:text-hx-primary')}>
      <Icon name={item.icon ?? 'puzzle'} size={16} />
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>}
      {badge !== undefined && badge !== null && badge !== 0 && <span data-badge={item.badge} className={cx('flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-hx-accent px-1 text-[10.5px] font-semibold text-hx-on-accent', collapsed && 'absolute right-1 top-0.5')}>{String(badge)}</span>}
    </button>
  );
  return collapsed ? <Tooltip label={item.title} placement="right-start">{row}</Tooltip> : row;
}

// ---------------- plugins as modules ----------------

/** Folds or unfolds a group; remembered on this computer. */
function setFolded(plugin: string, folded: boolean) {
  if (FOCUS) { useFocusFolds.setState((s) => ({ folded: { ...s.folded, [plugin]: folded } })); return; }
  const p = useApp.getState().prefs;
  useApp.getState().setPrefs({ menus: { ...p.menus, collapsed: { ...p.menus.collapsed, [plugin]: folded } } });
}

/** Moves a group up or down, or before another; the order is remembered (and the registry follows). */
export function moveGroup(plugin: string, to: -1 | 1 | { before: string }) {
  const order = useData.getState().registry.groups.map((g) => g.plugin);
  const i = order.indexOf(plugin);
  if (i < 0) return;
  order.splice(i, 1);
  const j = typeof to === 'number' ? Math.max(0, Math.min(order.length, i + to)) : Math.max(0, order.indexOf(to.before));
  order.splice(j, 0, plugin);
  const p = useApp.getState().prefs;
  useApp.getState().setPrefs({ menus: { ...p.menus, order } });
  useData.getState().rebuild();
}

function useFolded(g: MenuGroup): boolean {
  const mine = useApp((s) => s.prefs.menus?.collapsed?.[g.plugin]);
  // A window focused on one plugin: its group open, the others folded (until the person unfolds them here).
  const here = useFocusFolds((s) => s.folded[g.plugin]);
  if (FOCUS) return g.plugin === FOCUS ? here ?? false : here ?? true;
  return mine ?? g.collapsed;
}
/** Folds chosen in a focused window: this window's own (the main window keeps the person's). */
const useFocusFolds = create<{ folded: Record<string, boolean> }>(() => ({ folded: {} }));

/** The numbers of a folded group's items, added up (a folded group still says something is waiting). */
function groupCount(g: MenuGroup, badges: Record<string, unknown>): number {
  return g.items.flatMap((e) => [e, ...e.children]).reduce((n, e) => { const v = e.badge ? badges[e.badge] : undefined; return n + (typeof v === 'number' ? v : 0); }, 0);
}

function Modules() {
  const groups = useData((s) => s.registry.groups);
  const [over, setOver] = useState<string | null>(null);
  return (
    <div className="mt-1" data-modules>
      {groups.map((g, i) => <GroupBlock key={g.plugin} group={g} first={i === 0} last={i === groups.length - 1} over={over === g.plugin} setOver={setOver} />)}
    </div>
  );
}

function GroupBlock({ group: g, first, last, over, setOver }: { group: MenuGroup; first: boolean; last: boolean; over: boolean; setOver: (p: string | null) => void }) {
  const folded = useFolded(g);
  const route = useApp((s) => s.route);
  const badges = useApp((s) => s.badges);
  const nav = useData((s) => s.registry.navItems);
  const isHome = isHomeRoute(g.home, route);
  const count = folded ? groupCount(g, badges) : 0;
  const item = (qid: string) => nav.find((n) => n.qid === qid);
  const open = () => navigate(g.home);
  const actions = [
    { id: 'home', label: `Open ${g.title}`, icon: 'home', onSelect: open },
    { id: 'fold', label: folded ? 'Unfold' : 'Fold', icon: folded ? 'chevron-down' : 'chevron-right', onSelect: () => setFolded(g.plugin, !folded) },
    { id: 'sep', label: '', separator: true },
    { id: 'up', label: 'Move up', icon: 'arrow-up', disabled: first, onSelect: () => moveGroup(g.plugin, -1) },
    { id: 'down', label: 'Move down', icon: 'arrow-down', disabled: last, onSelect: () => moveGroup(g.plugin, 1) },
  ];
  return (
    <div data-group={g.plugin} data-folded={folded ? '1' : '0'} onContextMenu={contextItems(() => [
      ...actions,
      { id: 'sep2', label: '', separator: true },
      ...(g.plugin.startsWith('core.') ? [] : [{ id: 'app', label: 'Open as its own app', icon: 'external', onSelect: () => void desktop.openPluginWindow(g.plugin) }]),
      { id: 'manage', label: 'Manage plugins…', icon: 'puzzle', onSelect: () => navigate({ view: 'core.plugins:plugins' }) },
    ], g.title)} className={cx('mb-0.5 rounded-lg', over && 'ring-1 ring-hx-accent/60')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-harness-group')) { e.preventDefault(); setOver(g.plugin); } }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => { const from = e.dataTransfer.getData('application/x-harness-group'); setOver(null); if (from && from !== g.plugin) { e.preventDefault(); moveGroup(from, { before: g.plugin }); } }}>
      <div className="group/head relative flex h-8 items-center rounded-lg">
        <button type="button" tabIndex={-1} data-group-fold={g.plugin} aria-expanded={!folded} aria-label={`${folded ? 'Unfold' : 'Fold'} ${g.title}`} onClick={() => setFolded(g.plugin, !folded)}
          className="absolute left-0 top-0 z-10 flex h-8 w-6 items-center justify-center rounded-md text-hx-muted hover:text-hx-primary">
          <Icon name={folded ? 'chevron-right' : 'chevron-down'} size={12} />
        </button>
        <button type="button" draggable data-group-home={g.plugin} aria-current={isHome ? 'page' : undefined} aria-expanded={!folded} title={`${g.title}: open its home (Alt+Shift+Up/Down moves it, Left/Right folds it)`}
          onClick={open}
          onKeyDown={(e) => {
            if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveGroup(g.plugin, e.key === 'ArrowUp' ? -1 : 1); setTimeout(() => document.querySelector<HTMLElement>(`[data-group-home="${g.plugin}"]`)?.focus(), 0); }
            else if (e.key === 'ArrowLeft' && !folded) { e.preventDefault(); setFolded(g.plugin, true); }
            else if (e.key === 'ArrowRight' && folded) { e.preventDefault(); setFolded(g.plugin, false); }
          }}
          onDragStart={(e) => { e.dataTransfer.setData('application/x-harness-group', g.plugin); e.dataTransfer.effectAllowed = 'move'; }}
          className={cx('flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg pl-6 pr-8 text-[13px] font-medium transition-colors', isHome ? 'bg-hx-active text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover hover:text-hx-primary')}>
          <Icon name={g.icon} size={16} />
          <span className="min-w-0 flex-1 truncate text-left">{g.title}</span>
          {count > 0 && <span data-group-badge={g.plugin} className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-hx-accent px-1 text-[10.5px] font-semibold text-hx-on-accent">{count}</span>}
        </button>
        <Menu placement="bottom-end" items={actions} trigger={({ ref, toggle, open: o }) => <IconButton ref={ref} tabIndex={-1} icon="more" size="xs" label={`${g.title} menu`} data-group-menu={g.plugin} onClick={toggle} className={cx('absolute right-1 top-1.5 opacity-0 group-hover/head:opacity-100 focus:opacity-100', o && 'opacity-100')} />} />
      </div>
      {!folded && (
        <div role="group" aria-label={g.title}>
          {g.items.map((e) => {
            const n = item(e.qid);
            if (!n) return null;
            return (
              <React.Fragment key={e.qid}>
                <NavRow item={n} collapsed={false} depth={1} />
                {e.children.map((c) => { const cn = item(c.qid); return cn ? <NavRow key={c.qid} item={cn} collapsed={false} depth={2} /> : null; })}
              </React.Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The narrow rail: a group is one icon; its items open in a flyout beside it. */
function RailGroup({ group: g }: { group: MenuGroup }) {
  const route = useApp((s) => s.route);
  const badges = useApp((s) => s.badges);
  const inside = isHomeRoute(g.home, route) || g.items.some((e) => [e, ...e.children].some((x) => x.view === route.view));
  const count = groupCount(g, badges);
  const go = (r: { view: string; params?: Record<string, string> }) => () => navigate(r);
  const items = [
    { id: 'head', label: g.title, section: true },
    { id: 'home', label: 'Home', icon: 'home', onSelect: go(g.home) },
    ...g.items.flatMap((e) => [
      { id: e.qid, label: e.title, icon: e.icon ?? 'puzzle', ...(e.badge && badges[e.badge] ? { hint: String(badges[e.badge]) } : {}), onSelect: go({ view: e.view, ...(e.params ? { params: e.params } : {}) }) },
      ...e.children.map((c) => ({ id: c.qid, label: `  ${c.title}`, icon: c.icon ?? 'chevron-right', onSelect: go({ view: c.view, ...(c.params ? { params: c.params } : {}) }) })),
    ]),
  ];
  return (
    <Menu placement="right-start" items={items} className="min-w-[220px]" trigger={({ ref, toggle, open }) => (
      <Tooltip label={g.title} placement="right-start">
        <button ref={ref} type="button" data-group-rail={g.plugin} aria-haspopup="menu" aria-expanded={open} aria-label={g.title} onClick={toggle}
          className={cx('relative flex h-8 w-full items-center justify-center rounded-lg text-[13px] transition-colors', inside || open ? 'bg-hx-active text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover hover:text-hx-primary')}>
          <Icon name={g.icon} size={16} />
          {count > 0 && <span className="absolute right-1 top-0.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-hx-accent px-1 text-[10px] font-semibold text-hx-on-accent">{count}</span>}
        </button>
      </Tooltip>
    )} />
  );
}

function Projects() {
  const projects = useApp((s) => s.prefs.projects);
  const route = useApp((s) => s.route);
  const [open, setOpen] = useState(true);
  if (!projects.length) return null;
  return (
    <div className="mt-2">
      <SectionHead label="Projects" open={open} onToggle={() => setOpen(!open)} />
      {open && projects.map((p) => {
        const active = route.view === 'core.projects:project' && route.params?.path === p.path;
        return (
          <button key={p.path} type="button" title={p.path} onClick={() => navigate({ view: 'core.projects:project', params: { path: p.path } })}
            onContextMenu={contextItems(() => [
              { id: 'open', label: 'Open project', icon: 'folder', onSelect: () => navigate({ view: 'core.projects:project', params: { path: p.path } }) },
              { id: 'reveal', label: 'Show in folder', icon: 'folder-open', onSelect: () => void desktop.showItem(p.path) },
              { id: 'copy', label: 'Copy path', icon: 'copy', onSelect: () => void desktop.clipboard(p.path) },
              { id: 'sep', label: '', separator: true },
              { id: 'remove', label: 'Remove from projects', icon: 'x', onSelect: () => void desktop.removeProject(p.path).then((projects) => useApp.getState().setPrefs({ projects })) },
            ], p.name)}
            className={cx('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px]', active ? 'bg-hx-active text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover')}>
            <Icon name="folder" size={15} /><span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function SectionHead({ label, open, onToggle, action }: { label: string; open: boolean; onToggle: () => void; action?: React.ReactNode }) {
  return (
    <div className="group flex h-7 items-center px-2.5">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex flex-1 items-center gap-1 text-[11.5px] font-medium text-hx-muted hover:text-hx-secondary">
        {label}<Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} className="opacity-0 group-hover:opacity-100" />
      </button>
      {action}
    </div>
  );
}

function Conversations() {
  const sessions = useData((s) => s.sessions);
  const loaded = useData((s) => s.sessionsLoaded);
  const [open, setOpen] = useState(true);
  const [limit, setLimit] = useState(60);
  const sorted = useMemo(() => [...sessions].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt), [sessions]);
  return (
    <div className="mt-2" data-conversations>
      <SectionHead label="Recents" open={open} onToggle={() => setOpen(!open)} />
      {open && loaded && !sorted.length && <div className="px-2.5 py-1 text-[12px] text-hx-muted">No conversations yet.</div>}
      {open && sorted.slice(0, limit).map((s) => <ConversationRow key={s.id} s={s} />)}
      {open && sorted.length > limit && <button type="button" className="px-2.5 py-1 text-[12px] text-hx-muted hover:text-hx-primary" onClick={() => setLimit(limit + 100)}>Show more</button>}
    </div>
  );
}

function ConversationRow({ s }: { s: SessionMeta }) {
  const route = useApp((st) => st.route);
  const active = route.view === 'core.chat:session' && route.params?.id === s.id;
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(s.title);
  useEffect(() => setTitle(s.title), [s.title]);
  const act = async (f: () => Promise<unknown>, done?: string) => { try { await f(); if (done) toast(done); await useData.getState().refreshSessions(); } catch (e) { toast((e as Error).message, { kind: 'error' }); } };
  if (renaming) {
    return <div className="px-1 py-0.5"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => setRenaming(false)} onKeyDown={(e) => { if (e.key === 'Enter') { setRenaming(false); void act(() => client.sessions.patch(s.id, { title })); } if (e.key === 'Escape') setRenaming(false); }} /></div>;
  }
  const items: MenuItem[] = [
    { id: 'open', label: 'Open', icon: 'chat', onSelect: () => openSession(s.id) },
    { id: 'pin', label: s.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => void act(() => client.sessions.patch(s.id, { pinned: !s.pinned })) },
    { id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) },
    { id: 'fork', label: 'Fork', icon: 'git-branch', onSelect: () => void act(async () => { const m = await client.sessions.fork(s.id); openSession(m.id); }, 'Forked') },
    { id: 'archive', label: s.archived ? 'Unarchive' : 'Archive', icon: 'archive', onSelect: () => void act(() => (s.archived ? client.sessions.unarchive(s.id) : client.sessions.archive(s.id)), s.archived ? 'Unarchived' : 'Archived') },
    ...(s.runtime?.path ? [{ id: 'folder', label: 'Show its folder', icon: 'folder-open', onSelect: () => void desktop.showItem(s.runtime!.path!) }] : []),
    { id: 'copy-title', label: 'Copy title', icon: 'copy', onSelect: () => void desktop.clipboard(s.title || 'New conversation') },
    { id: 'sep', label: '', separator: true },
    { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => void useApp.getState().ask({ title: 'Delete this conversation?', body: `"${s.title}" and its workspace history are removed. This cannot be undone.`, confirmLabel: 'Delete', danger: true }).then((yes) => { if (yes) void act(async () => { await client.sessions.remove(s.id); if (active) navigate({ view: 'core.chat:home' }); }, 'Deleted'); }) },
  ];
  return (
    <div data-session-row={s.id} onContextMenu={contextItems(() => items, 'Conversation')} className={cx('group relative flex h-8 items-center rounded-lg pr-1', active ? 'bg-hx-active' : 'hover:bg-hx-hover')}>
      <button type="button" onClick={() => openSession(s.id)} className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left text-[13px]">
        {s.status === 'running' ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-hx-accent" title="Working" /> : s.status === 'waiting' ? <span className="h-2 w-2 shrink-0 rounded-full bg-hx-warning" title="Needs you" /> : s.pinned ? <Icon name="pin" size={12} className="shrink-0 text-hx-muted" /> : null}
        <span className={cx('min-w-0 flex-1 truncate', active ? 'text-hx-primary' : 'text-hx-secondary')}>{s.title || 'New conversation'}</span>
      </button>
      <Menu placement="bottom-end" items={items.filter((x) => x.id !== 'open')} trigger={({ ref, toggle, open }) => <IconButton ref={ref} icon="more" size="xs" label="Conversation actions" onClick={toggle} className={cx('opacity-0 group-hover:opacity-100 focus:opacity-100', open && 'opacity-100')} />} />
    </div>
  );
}

function Profile({ collapsed }: { collapsed: boolean }) {
  const me = useData((s) => s.me);
  const engine = useApp((s) => s.engine);
  const remote = engine.status === 'ready' && engine.remote;
  if (collapsed) return null;
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-1.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-hx-pill text-[12px] font-semibold text-hx-secondary">{(me?.name ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-hx-primary">{me?.name === 'operator' ? 'You' : me?.name ?? '...'}</span>
        <span className="block truncate text-[11px] text-hx-muted">{remote ? engine.origin.replace(/^https?:\/\//, '') : 'This computer'}</span>
      </span>
    </div>
  );
}

export function badgeText(text: string): string { return interpolate(text, useApp.getState().badges); }
