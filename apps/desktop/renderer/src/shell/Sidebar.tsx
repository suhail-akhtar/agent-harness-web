/**
 * The sidebar: navigation from the registry (primary, More, footer), projects, and conversations
 * (pinned first, with pin, rename, archive and delete). Collapses to a rail; resizable.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cx, Icon, IconButton, Menu, Tooltip, toast, Input } from '@harness/ui';
import type { SessionMeta } from '@harness/client';
import { useApp, navigate, openSession } from '../state/app';
import { useData, client } from '../state/data';
import { interpolate, type NavItem } from '../registry/registry';
import { formatChord } from '../registry/keybindings';
import { runCommand } from '../registry/actions';
import { platform } from '../bridge';

export function Sidebar(): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const collapsed = prefs.sidebar.collapsed;
  const width = prefs.sidebar.width;
  const registry = useData((s) => s.registry);
  const info = useApp((s) => s.info);
  const [moreOpen, setMoreOpen] = useState(false);
  const primary = registry.navItems.filter((n) => (n.placement ?? 'primary') === 'primary');
  const more = registry.navItems.filter((n) => n.placement === 'more');
  const footer = registry.navItems.filter((n) => n.placement === 'footer');
  const drag = useRef<{ x: number; w: number } | null>(null);

  return (
    <aside data-sidebar data-collapsed={collapsed ? '1' : '0'} className="relative flex h-full shrink-0 flex-col border-r border-hx-border-subtle bg-hx-sidebar" style={{ width: collapsed ? 56 : width }}>
      <div className="app-drag flex h-10 shrink-0 items-center gap-2 px-3">
        {!collapsed && <span className="flex items-center gap-2 text-[14px] font-semibold tracking-tight text-hx-primary"><Logo />{info?.product.brand.wordmark ?? info?.product.name ?? 'Harness'}</span>}
        <div className="flex-1" />
        <IconButton className="app-no-drag" icon="sidebar" size="sm" label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} onClick={() => useApp.getState().setPrefs({ sidebar: { ...prefs.sidebar, collapsed: !collapsed } })} />
      </div>
      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2 pb-2">
        {primary.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} />)}
        {more.length > 0 && (
          <>
            <button type="button" onClick={() => setMoreOpen((o) => !o)} aria-expanded={moreOpen} className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-hx-secondary hover:bg-hx-hover', collapsed && 'justify-center px-0')}>
              <Icon name={moreOpen ? 'chevron-down' : 'more'} size={16} />{!collapsed && 'More'}
            </button>
            {moreOpen && more.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} indent />)}
          </>
        )}
      </nav>
      {!collapsed && <div className="hx-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2"><Projects /><Conversations /></div>}
      {collapsed && <div className="flex-1" />}
      <div className="flex flex-col gap-0.5 border-t border-hx-border-subtle p-2">
        {footer.map((n) => <NavRow key={n.qid} item={n} collapsed={collapsed} />)}
        {registry.commands.some((c) => c.qid === 'core.settings:open') && <button type="button" data-open-settings onClick={() => void runCommand('core.settings:open')} className={cx('flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-hx-secondary hover:bg-hx-hover hover:text-hx-primary', collapsed && 'justify-center px-0')} title="Settings">
          <Icon name="settings" size={16} />{!collapsed && <span className="flex-1 text-left">Settings</span>}{!collapsed && <span className="text-[11px] text-hx-muted">{formatChord(registry.commands.find((c) => c.qid === 'core.settings:open')?.keys ?? '', platform)}</span>}
        </button>}
        <Profile collapsed={collapsed} />
      </div>
      {!collapsed && (
        <div role="separator" aria-orientation="vertical" aria-label="Resize the sidebar" tabIndex={0}
          className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
          onPointerDown={(e) => { drag.current = { x: e.clientX, w: width }; (e.target as Element).setPointerCapture(e.pointerId); }}
          onPointerMove={(e) => { if (drag.current) useApp.setState({ prefs: { ...useApp.getState().prefs, sidebar: { ...prefs.sidebar, width: Math.min(480, Math.max(200, drag.current.w + e.clientX - drag.current.x)) } } }); }}
          onPointerUp={() => { if (drag.current) { drag.current = null; useApp.getState().setPrefs({ sidebar: useApp.getState().prefs.sidebar }); } }}
          onKeyDown={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') useApp.getState().setPrefs({ sidebar: { ...prefs.sidebar, width: width + (e.key === 'ArrowLeft' ? -16 : 16) } }); }}
        />
      )}
    </aside>
  );
}

function Logo() {
  return <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent text-[12px] font-bold text-hx-on-accent">H</span>;
}

function NavRow({ item, collapsed, indent }: { item: NavItem; collapsed: boolean; indent?: boolean }) {
  const route = useApp((s) => s.route);
  const badges = useApp((s) => s.badges);
  const active = route.view === item.view && (!item.params || JSON.stringify(item.params) === JSON.stringify(route.params ?? {}));
  const badge = item.badge ? badges[item.badge] : undefined;
  const row = (
    <button type="button" data-nav={item.qid} aria-current={active ? 'page' : undefined} onClick={() => navigate({ view: item.view, ...(item.params ? { params: item.params } : {}) })}
      className={cx('relative flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors', collapsed && 'justify-center px-0', indent && !collapsed && 'pl-6',
        active ? 'bg-hx-active font-medium text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover hover:text-hx-primary')}>
      <Icon name={item.icon ?? 'puzzle'} size={16} />
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>}
      {badge !== undefined && badge !== null && badge !== 0 && <span data-badge={item.badge} className={cx('flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-hx-accent px-1 text-[10.5px] font-semibold text-hx-on-accent', collapsed && 'absolute right-1 top-0.5')}>{String(badge)}</span>}
    </button>
  );
  return collapsed ? <Tooltip label={item.title} placement="right-start">{row}</Tooltip> : row;
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
  return (
    <div data-session-row={s.id} className={cx('group relative flex h-8 items-center rounded-lg pr-1', active ? 'bg-hx-active' : 'hover:bg-hx-hover')}>
      <button type="button" onClick={() => openSession(s.id)} className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left text-[13px]">
        {s.status === 'running' ? <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-hx-accent" title="Working" /> : s.status === 'waiting' ? <span className="h-2 w-2 shrink-0 rounded-full bg-hx-warning" title="Needs you" /> : s.pinned ? <Icon name="pin" size={12} className="shrink-0 text-hx-muted" /> : null}
        <span className={cx('min-w-0 flex-1 truncate', active ? 'text-hx-primary' : 'text-hx-secondary')}>{s.title || 'New conversation'}</span>
      </button>
      <Menu placement="bottom-end" items={[
        { id: 'pin', label: s.pinned ? 'Unpin' : 'Pin', icon: 'pin', onSelect: () => void act(() => client.sessions.patch(s.id, { pinned: !s.pinned })) },
        { id: 'rename', label: 'Rename', icon: 'edit', onSelect: () => setRenaming(true) },
        { id: 'fork', label: 'Fork', icon: 'git-branch', onSelect: () => void act(async () => { const m = await client.sessions.fork(s.id); openSession(m.id); }, 'Forked') },
        { id: 'archive', label: s.archived ? 'Unarchive' : 'Archive', icon: 'archive', onSelect: () => void act(() => (s.archived ? client.sessions.unarchive(s.id) : client.sessions.archive(s.id)), s.archived ? 'Unarchived' : 'Archived') },
        { id: 'sep', label: '', separator: true },
        { id: 'delete', label: 'Delete', icon: 'trash', danger: true, onSelect: () => void useApp.getState().ask({ title: 'Delete this conversation?', body: `"${s.title}" and its workspace history are removed. This cannot be undone.`, confirmLabel: 'Delete', danger: true }).then((yes) => { if (yes) void act(async () => { await client.sessions.remove(s.id); if (active) navigate({ view: 'core.chat:home' }); }, 'Deleted'); }) },
      ]} trigger={({ ref, toggle, open }) => <IconButton ref={ref} icon="more" size="xs" label="Conversation actions" onClick={toggle} className={cx('opacity-0 group-hover:opacity-100 focus:opacity-100', open && 'opacity-100')} />} />
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
