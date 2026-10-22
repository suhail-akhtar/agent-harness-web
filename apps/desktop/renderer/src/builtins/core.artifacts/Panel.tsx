/**
 * The Artifacts panel of a conversation: its artifacts (live: a new one or a new version shows at
 * once), and one artifact with Preview / Code / Changes, a version picker, the diff between two
 * versions, copy, download and open in full window.
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { ArtifactContent, ArtifactMeta } from '@harness/client';
import { Badge, CodeBlock, DiffView, EmptyState, Icon, IconButton, Select, Spinner, Tabs, Tooltip, cx } from '@harness/ui';
import { client } from '../../state/data';
import { openPluginPanel, showFullWindow } from '../../state/app';
import { useSessionLive } from '../core.chat/live';
import type { NativeProps } from '../../registry/PluginView';
import { ArtifactBody, codeLanguage, copyArtifact, isText, saveArtifact } from './body';

export const KIND_ICON: Record<string, string> = { markdown: 'file-text', html: 'globe', svg: 'image', react: 'atom', mermaid: 'workflow', code: 'code', csv: 'table', json: 'code', chart: 'chart', image: 'image', pdf: 'file', diagram: 'layers' };

export const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

/** One version's content, cached (versions never change). */
const cache = new Map<string, ArtifactContent>();
export async function loadVersion(sessionId: string, id: string, version: number): Promise<ArtifactContent> {
  const k = `${sessionId}/${id}@${version}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const c = await client.artifacts.get(sessionId, id, version);
  cache.set(k, c);
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return c;
}

export function ArtifactsPanel({ params }: NativeProps): React.ReactElement {
  const sessionId = params.id ?? '';
  const selected = params.artifact;
  const [live] = useSessionLive(sessionId);
  const [list, setList] = useState<ArtifactMeta[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    let alive = true;
    client.artifacts.list(sessionId).then((l) => { if (alive) { setList(l); setErr(''); } }).catch((e: Error) => { if (alive) { setErr(e.message); setList([]); } });
    return () => { alive = false; };
  }, [sessionId, live.artifactsSeq]);
  const select = (id?: string) => openPluginPanel('core.artifacts:artifacts', { id: sessionId, ...(id ? { artifact: id } : {}) });
  if (!sessionId) return <EmptyState icon="layers" title="Open a conversation">Its artifacts show here.</EmptyState>;
  if (!list) return <div className="flex justify-center p-6"><Spinner /></div>;
  const meta = selected ? list.find((a) => a.id === selected) : undefined;
  if (selected && meta) return <ArtifactDetail sessionId={sessionId} meta={meta} onBack={() => select()} />;
  return (
    <div data-artifacts-panel={sessionId} className="space-y-1.5">
      {err && <p className="px-1 text-[12px] text-hx-danger">{err}</p>}
      {!list.length && <EmptyState icon="layers" title="No artifacts yet">Documents, apps, diagrams and data the agent makes for you to keep show here, with every version.</EmptyState>}
      {list.map((a) => (
        <button key={a.id} type="button" data-artifact-item={a.id} onClick={() => select(a.id)} className="flex w-full items-center gap-2.5 rounded-xl border border-hx-border-subtle bg-hx-elevated p-2.5 text-left hover:border-hx-border">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-hx-accent-soft text-hx-accent-text"><Icon name={KIND_ICON[a.kind] ?? 'file'} size={16} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium">{a.title}</span><span className="block truncate text-[11.5px] text-hx-muted">{a.kind}{a.language ? ` · ${a.language}` : ''} · v{a.version} · {ago(a.updatedAt)}</span></span>
          <Icon name="chevron-right" size={14} className="text-hx-muted" />
        </button>
      ))}
    </div>
  );
}

/** One artifact: versions, preview / code / changes, and its actions. */
export function ArtifactDetail({ sessionId, meta, onBack, full }: { sessionId: string; meta: ArtifactMeta; onBack?: () => void; full?: boolean }): React.ReactElement {
  const [version, setVersion] = useState(meta.version);
  const [tab, setTab] = useState<'preview' | 'code' | 'changes'>('preview');
  const [c, setC] = useState<ArtifactContent | null>(null);
  const [other, setOther] = useState<ArtifactContent | null>(null);
  const [against, setAgainst] = useState(Math.max(1, meta.version - 1));
  const [err, setErr] = useState('');
  // A new version arriving moves the picker to it (unless an older one was picked on purpose).
  const [pinned, setPinned] = useState(false);
  useEffect(() => { if (!pinned) { setVersion(meta.version); setAgainst(Math.max(1, meta.version - 1)); } }, [meta.version]);
  useEffect(() => { let alive = true; setErr(''); loadVersion(sessionId, meta.id, version).then((x) => alive && setC(x)).catch((e: Error) => alive && setErr(e.message)); return () => { alive = false; }; }, [sessionId, meta.id, version]);
  useEffect(() => { if (tab !== 'changes') return; let alive = true; loadVersion(sessionId, meta.id, against).then((x) => alive && setOther(x)).catch(() => alive && setOther(null)); return () => { alive = false; }; }, [tab, against, sessionId, meta.id]);
  const versions = useMemo(() => [...meta.versions].sort((a, b) => b.n - a.n), [meta.versions]);
  const text = isText(meta.kind);
  const openFull = () => { if (c) showFullWindow(meta.title, <ArtifactBody c={c} title={meta.title} fill />); };
  return (
    <div data-artifact-detail={meta.id} data-version={version} className={cx('flex h-full min-h-0 flex-col', full && 'p-1')}>
      <div className="flex items-center gap-1.5 pb-2">
        {onBack && <IconButton icon="arrow-left" size="sm" label="All artifacts" onClick={onBack} />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium" data-artifact-title>{meta.title}</div>
          <div className="truncate text-[11px] text-hx-muted">{meta.kind}{meta.language ? ` · ${meta.language}` : ''} · {meta.id}</div>
        </div>
        <Tooltip label="Copy"><IconButton icon="copy" size="sm" label="Copy the content" disabled={!c || !text} onClick={() => c && copyArtifact(c)} /></Tooltip>
        <Tooltip label="Download"><IconButton icon="download" size="sm" label="Download this version" disabled={!c} onClick={() => c && saveArtifact(c, meta.title)} /></Tooltip>
        <Tooltip label="Open in full window"><IconButton icon="expand" size="sm" label="Open in full window" disabled={!c} onClick={openFull} data-open-full /></Tooltip>
      </div>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <Select aria-label="Version" data-version-picker value={String(version)} onChange={(v) => { setPinned(Number(v) !== meta.version); setVersion(Number(v)); if (Number(v) <= against) setAgainst(Math.max(1, Number(v) - 1)); }}
          options={versions.map((v) => ({ value: String(v.n), label: `v${v.n} · ${v.action === 'create' ? 'created' : v.action === 'update' ? 'edited' : 'rewritten'} · ${ago(v.at)}${v.n === meta.version ? ' (latest)' : ''}` }))} className="h-7 max-w-[260px] text-[12px]" />
        {versions.length > 1 && <Badge tone="accent">{versions.length} versions</Badge>}
        <div className="flex-1" />
        <Tabs size="sm" value={tab} onChange={(t) => setTab(t as typeof tab)} tabs={[{ id: 'preview', label: 'Preview' }, ...(text ? [{ id: 'code', label: 'Code' }] : []), ...(text && versions.length > 1 ? [{ id: 'changes', label: 'Changes' }] : [])]} />
      </div>
      {err && <p className="text-[12.5px] text-hx-danger">{err}</p>}
      <div className={cx('min-h-0 flex-1 overflow-auto', tab === 'preview' && (meta.kind === 'html' || meta.kind === 'react') && 'overflow-hidden')}>
        {!c ? <div className="flex justify-center p-6"><Spinner /></div>
          : tab === 'preview' ? <ArtifactBody c={c} title={meta.title} fill={meta.kind === 'html' || meta.kind === 'react' || meta.kind === 'svg'} />
            : tab === 'code' ? <CodeBlock code={c.content ?? ''} language={codeLanguage(meta.kind, meta.language)} collapseAt={1e9} />
              : (
                <div data-artifact-diff>
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-hx-secondary">
                    <span>Changes from</span>
                    <Select aria-label="Compare with" value={String(against)} onChange={(v) => setAgainst(Number(v))} options={versions.filter((v) => v.n !== version).map((v) => ({ value: String(v.n), label: `v${v.n}` }))} className="h-7 w-20 text-[12px]" />
                    <span>to v{version}</span>
                  </div>
                  {other ? <DiffView path={`${meta.id}`} before={other.content ?? ''} after={c.content ?? ''} mode="unified" /> : <Spinner />}
                </div>
              )}
      </div>
    </div>
  );
}

/** A card for an artifact the agent made or changed, in the transcript: opens it in the Artifacts panel. */
export function ArtifactRefCard({ item, sessionId }: { item: { kind: 'artifact'; refs: Array<{ id: string; title: string; kind: string; version: number; action: string }> }; sessionId: string }): React.ReactElement {
  const refs = item.refs;
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-artifact-refs>
      {refs.map((r) => (
        <button key={r.id} type="button" data-artifact-ref={r.id} data-artifact-version={r.version} onClick={() => openPluginPanel('core.artifacts:artifacts', { id: sessionId, artifact: r.id })}
          className="flex items-center gap-2.5 rounded-xl border border-hx-border-subtle bg-hx-elevated p-2.5 text-left hover:border-hx-accent/50">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hx-accent-soft text-hx-accent-text"><Icon name={KIND_ICON[r.kind] ?? 'layers'} size={17} /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-hx-primary">{r.title}</span><span className="block truncate text-[11px] text-hx-muted">{r.action === 'create' ? 'Created' : 'Updated'} · {r.kind} · version {r.version}</span></span>
          <Icon name="panel-right" size={15} className="text-hx-muted" />
        </button>
      ))}
    </div>
  );
}

/** Opens an artifact of a conversation in its panel (from a command, a deep link or an agent's desktop_open). */
export async function openArtifact(sessionId: string, id: string): Promise<void> {
  const list = await client.artifacts.list(sessionId);
  if (!list.some((a) => a.id === id)) throw new Error(`No artifact ${id} in this conversation.`);
  openPluginPanel('core.artifacts:artifacts', { id: sessionId, artifact: id });
}
