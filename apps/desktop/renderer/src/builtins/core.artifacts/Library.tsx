/**
 * The Library: every artifact of every conversation the person may use (GET /api/artifacts),
 * searched as they type, filtered by kind, in a grid or a list. Opening one goes to its
 * conversation with the Artifacts panel on it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ArtifactMeta } from '@harness/client';
import { Badge, EmptyState, Icon, IconButton, Input, Select, Spinner, Tooltip, cx } from '@harness/ui';
import { client } from '../../state/data';
import { openPluginPanel, openSession } from '../../state/app';
import { KIND_ICON, ago } from './Panel';

const KINDS = ['markdown', 'html', 'svg', 'react', 'mermaid', 'code', 'csv', 'json', 'chart', 'image', 'pdf'];

function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { return (localStorage.getItem(key) as T | null) ?? initial; } catch { return initial; } });
  return [v, (x) => { setV(x); try { localStorage.setItem(key, x); } catch { /* private mode */ } }];
}

export function Library(): React.ReactElement {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [layout, setLayout] = usePref<'grid' | 'list'>('harness.library.layout', 'grid');
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      client.artifacts.library({ query: q.trim() || undefined, limit: 200 }).then((l) => { setList(l); setErr(''); }).catch((e: Error) => { setErr(e.message); setList([]); });
    }, 160);
    return () => clearTimeout(t);
  }, [q]);
  // Conversations that work in the same folder see the same artifact files: one entry each, with how many share it.
  const shown = useMemo(() => {
    const seen = new Map<string, ArtifactMeta & { shared: number }>();
    for (const a of list ?? []) {
      if (kind && a.kind !== kind) continue;
      const k = `${a.id}@${a.createdAt}`;
      const cur = seen.get(k);
      if (cur) cur.shared++; else seen.set(k, { ...a, shared: 0 });
    }
    return [...seen.values()];
  }, [list, kind]);
  const kinds = useMemo(() => [...new Set([...(list ?? []).map((a) => a.kind), ...KINDS])], [list]);
  const open = (a: ArtifactMeta) => { if (!a.sessionId) return; openSession(a.sessionId); openPluginPanel('core.artifacts:artifacts', { id: a.sessionId, artifact: a.id }); };
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-library>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-4 flex items-center gap-3"><h1 className="flex-1 text-[20px] font-semibold">Library</h1><span className="text-[12px] text-hx-muted">{list ? `${shown.length} artifact${shown.length === 1 ? '' : 's'}` : ''}</span></div>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="min-w-[220px] flex-1"><Input icon="search" placeholder="Search titles, kinds and languages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the library" data-library-search /></div>
          <Select aria-label="Kind" data-library-kind value={kind} onChange={setKind} options={[{ value: '', label: 'Every kind' }, ...kinds.map((k) => ({ value: k, label: k }))]} className="h-9 w-40" />
          <div className="flex rounded-lg border border-hx-border-subtle p-0.5">
            <Tooltip label="Grid"><IconButton icon="grid" size="sm" label="Show as a grid" active={layout === 'grid'} onClick={() => setLayout('grid')} /></Tooltip>
            <Tooltip label="List"><IconButton icon="list" size="sm" label="Show as a list" active={layout === 'list'} onClick={() => setLayout('list')} /></Tooltip>
          </div>
        </div>
        {err && <p className="mb-2 text-[12.5px] text-hx-danger">{err}</p>}
        {!list ? <div className="flex justify-center p-10"><Spinner /></div>
          : !shown.length ? <EmptyState icon="library" title={q || kind ? 'Nothing matches' : 'Your library is empty'}>{q || kind ? 'Try other words or every kind.' : 'Documents, apps, diagrams and data agents make in your conversations are kept here, with every version.'}</EmptyState>
            : layout === 'grid' ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-library-layout="grid">
                {shown.map((a) => (
                  <button key={`${a.sessionId}/${a.id}`} type="button" data-library-item={a.id} onClick={() => open(a)} className="flex flex-col gap-2 rounded-xl border border-hx-border-subtle bg-hx-elevated p-3 text-left hover:border-hx-border">
                    <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-hx-accent-soft text-hx-accent-text"><Icon name={KIND_ICON[a.kind] ?? 'file'} size={16} /></span><Badge>{a.kind}</Badge><span className="ml-auto text-[11px] text-hx-muted">v{a.version}</span></div>
                    <div className="line-clamp-2 text-[13.5px] font-medium">{a.title}</div>
                    <div className="mt-auto flex items-center gap-1.5 text-[11.5px] text-hx-muted"><Icon name="chat" size={12} /><span className="min-w-0 flex-1 truncate">{a.sessionTitle || a.sessionId}{a.shared ? ` +${a.shared}` : ''}</span><span>{ago(a.updatedAt)}</span></div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle" data-library-layout="list">
                {shown.map((a) => (
                  <button key={`${a.sessionId}/${a.id}`} type="button" data-library-item={a.id} onClick={() => open(a)} className={cx('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-hx-hover')}>
                    <Icon name={KIND_ICON[a.kind] ?? 'file'} size={15} className="text-hx-accent-text" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px]">{a.title}</span><span className="block truncate text-[11.5px] text-hx-muted">{a.sessionTitle || a.sessionId}{a.shared ? ` and ${a.shared} more conversation${a.shared === 1 ? '' : 's'} in the same folder` : ''}</span></span>
                    <Badge>{a.kind}</Badge><span className="w-10 text-right text-[11.5px] text-hx-muted">v{a.version}</span><span className="w-24 text-right text-[11.5px] text-hx-muted">{ago(a.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
      </div>
    </div>
  );
}
