/**
 * The command palette (Mod+K): every command the registry has, every page ("Plugin › Item" for a
 * plugin's module), recent conversations
 * (searched on the server as you type) and projects. Arrow keys, Enter, Escape.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, Kbd, Portal, cx } from '@harness/ui';
import type { SessionMeta } from '@harness/client';
import { useApp, navigate, openSession } from '../state/app';
import { useData, client } from '../state/data';
import { fuzzyScore } from '../registry/registry';
import { paletteTitle } from '../registry/modules';
import { runCommand } from '../registry/actions';
import { formatChord } from '../registry/keybindings';
import { platform } from '../bridge';

interface Entry { id: string; group: string; title: string; hint?: string; icon: string; keys?: string; run: () => void; score?: number }

export function CommandPalette(): React.ReactElement | null {
  const open = useApp((s) => s.paletteOpen);
  const registry = useData((s) => s.registry);
  const sessions = useData((s) => s.sessions);
  const projects = useApp((s) => s.prefs.projects);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<SessionMeta[]>([]);
  const list = useRef<HTMLDivElement>(null);
  const close = () => { useApp.setState({ paletteOpen: false }); setQ(''); setActive(0); };

  useEffect(() => {
    if (!open || q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => { client.sessions.list({ query: q.trim(), limit: 20 }).then((r) => setFound(r.sessions)).catch(() => setFound([])); }, 150);
    return () => clearTimeout(t);
  }, [q, open]);

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const c of registry.commands) out.push({ id: `cmd:${c.qid}`, group: 'Commands', title: c.category ? `${c.category}: ${c.title}` : c.title, icon: c.icon ?? 'command', keys: c.keys, run: () => void runCommand(c.qid) });
    // A plugin that is a module: its home, then its items as "Plugin › Item".
    for (const g of registry.groups) out.push({ id: `home:${g.plugin}`, group: 'Go to', title: `${g.title} › Home`, icon: g.icon, run: () => navigate(g.home) });
    for (const n of registry.navItems) out.push({ id: `nav:${n.qid}`, group: 'Go to', title: paletteTitle(registry, n), icon: n.icon ?? 'arrow-right', run: () => navigate({ view: n.view, ...(n.params ? { params: n.params } : {}) }) });
    for (const p of projects) out.push({ id: `proj:${p.path}`, group: 'Projects', title: p.name, hint: p.path, icon: 'folder', run: () => navigate({ view: 'core.projects:project', params: { path: p.path } }) });
    const convs = q.trim().length >= 2 ? [...found, ...sessions.filter((s) => !found.some((f) => f.id === s.id))] : sessions.slice(0, 8);
    for (const s of convs.slice(0, 30)) out.push({ id: `s:${s.id}`, group: 'Conversations', title: s.title || 'New conversation', hint: new Date(s.updatedAt).toLocaleDateString(), icon: 'chat', run: () => openSession(s.id) });
    const scored = out.map((e) => ({ ...e, score: e.group === 'Conversations' && found.some((f) => `s:${f.id}` === e.id) ? 500 : fuzzyScore(q, `${e.title} ${e.hint ?? ''}`) })).filter((e) => e.score >= 0);
    if (q.trim()) scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60);
  }, [registry, sessions, projects, found, q]);

  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => { list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  if (!open) return null;
  const pick = (e: Entry | undefined) => { if (!e) return; close(); e.run(); };
  let lastGroup = '';
  return (
    <Portal>
      <div className="hx-fade-in fixed inset-0 z-[70] flex justify-center bg-[var(--hx-scrim)] px-4 pt-[12vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div role="dialog" aria-label="Command palette" data-palette className="hx-pop-in flex max-h-[min(560px,70vh)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-hx-border bg-hx-elevated shadow-[var(--hx-shadow)]">
          <div className="flex items-center gap-2.5 border-b border-hx-border-subtle px-4">
            <Icon name="search" size={16} className="text-hx-muted" />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search commands, pages, conversations…" aria-label="Search commands"
              className="h-12 flex-1 bg-transparent text-[14px] text-hx-primary outline-none placeholder:text-hx-muted"
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); close(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(entries.length - 1, a + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                else if (e.key === 'Enter') { e.preventDefault(); pick(entries[active]); }
              }} />
            <Kbd keys="Esc" />
          </div>
          <div ref={list} role="listbox" className="hx-scroll min-h-0 flex-1 overflow-y-auto p-1.5">
            {!entries.length && <div className="px-3 py-6 text-center text-[13px] text-hx-muted">Nothing matches.</div>}
            {entries.map((e, i) => {
              const head = !q.trim() && e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              return (
                <React.Fragment key={e.id}>
                  {head && <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-hx-muted">{head}</div>}
                  <button type="button" role="option" aria-selected={i === active} data-index={i} data-entry={e.id} onMouseMove={() => setActive(i)} onClick={() => pick(e)}
                    className={cx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px]', i === active ? 'bg-hx-hover text-hx-primary' : 'text-hx-secondary')}>
                    <Icon name={e.icon} size={15} className="shrink-0 text-hx-muted" />
                    <span className="min-w-0 flex-1 truncate">{e.title}{e.hint && <span className="ml-2 text-[12px] text-hx-muted">{e.hint}</span>}</span>
                    {q.trim() && <span className="text-[11px] text-hx-muted">{e.group}</span>}
                    {e.keys && <Kbd keys={formatChord(e.keys, platform)} />}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </Portal>
  );
}
