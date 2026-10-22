/**
 * The full-page diagram view (core.diagrams:diagram). Three sources, by the route's params:
 *  - `session` + `artifact`: a diagram artifact, live (new versions update the canvas in place with
 *    their changes marked; a drag saves a new version; the ask box sends a request to the session);
 *  - `key`: a ```diagram block opened from the transcript (its session, when known, for asking);
 *  - `code`: the code map of a session's workspace (imports between folders).
 * Details go to the side panel (core.diagrams:details).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateDiagram, type DiagramLink, type DiagramSpec } from '@harness/plugin-ui';
import { Button, DiagramCanvas, DiagramError, EmptyState, Icon, Spinner, toast, viewName, type DiagramCanvasApi, type DiagramSelection } from '@harness/ui';
import { useApp } from '../../state/app';
import { client, globalBus } from '../../state/data';
import { desktop } from '../../bridge';
import type { NativeProps } from '../../registry/PluginView';
import { askMessage, changedBetween, scanImports, useLiveArtifact, type Changed } from './api';
import { codeMapSpec, type ImportScan } from './codemap';
import { stashed, stashPositions, useDetails } from './store';

const DETAILS = 'core.diagrams:details';

export function DiagramPage({ params }: NativeProps): React.ReactElement {
  if (params.code) return <CodeMapPage sessionId={params.code} />;
  if (params.session && params.artifact) return <ArtifactPage key={`${params.session}/${params.artifact}`} sessionId={params.session} id={params.artifact} compareTo={params.from ? Number(params.from) : undefined} />;
  if (params.key) return <StashedPage key={params.key} stashKey={params.key} />;
  return <div className="flex h-full items-center justify-center"><EmptyState icon="layers" title="No diagram here">Open a diagram from a conversation, or run "Show code map" from the command palette.</EmptyState></div>;
}

/** The page's header: back, title, what it is, and actions. */
function Header({ title, caption, children }: { title: string; caption: string; children?: React.ReactNode }) {
  const back = useApp((s) => s.back);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hx-border-subtle px-3" data-diagram-page-header>
      <Button size="sm" variant="ghost" icon="arrow-left" disabled={!back.length} onClick={() => useApp.getState().goBack()}>Back</Button>
      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-hx-accent-soft text-hx-accent-text"><Icon name="layers" size={14} /></span>
      <span className="min-w-0"><span className="block truncate text-[13.5px] font-semibold text-hx-primary" data-diagram-page-title>{title}</span></span>
      <span className="truncate text-[12px] text-hx-muted">{caption}</span>
      <span className="ml-auto flex items-center gap-1.5">{children}</span>
    </div>
  );
}

/** Wires the canvas's details to the side panel, and opens links (files in the panel, pages outside). */
function useDetailsPanel(owner: string, sessionId: string | undefined) {
  const api = useRef<DiagramCanvasApi | null>(null);
  const openLink = useCallback(async (l: DiagramLink) => {
    if (l.url) { await desktop.openExternal(l.url).catch((e: Error) => toast(e.message, { kind: 'error' })); return; }
    if (l.file && sessionId) {
      try {
        const r = await client.files.read(sessionId, l.file);
        if (r.content === null || r.content === undefined) { toast(r.note ?? 'That file cannot be shown', { kind: 'warning' }); return; }
        useApp.setState({ panel: { kind: 'file', title: l.file.split('/').pop() ?? l.file, path: l.file, sessionId, content: r.content } });
      } catch (e) { toast((e as Error).message, { kind: 'error' }); }
    } else if (l.file) toast(`${l.file} is in the workspace of the conversation this came from`, { kind: 'info' });
  }, [sessionId]);
  const onDetails = useCallback((d: { open: boolean; selection: DiagramSelection | null; spec: DiagramSpec; changed: ReadonlySet<string> }) => {
    const close = () => { useDetails.setState({ open: false }); api.current?.select(null); };
    useDetails.setState({ ...d, owner, select: (s) => api.current?.select(s), openLink: (l) => void openLink(l), close });
    const panel = useApp.getState().panel;
    const ours = panel?.kind === 'plugin' && panel.panel === DETAILS;
    if (d.open && !ours) useApp.setState({ panel: { kind: 'plugin', panel: DETAILS } });
    if (!d.open && ours) useApp.setState({ panel: null });
  }, [owner, openLink]);
  // Closing the panel from its own button closes the details.
  const [detailsOpen, setDetailsOpen] = useState<boolean | undefined>(undefined);
  useEffect(() => useApp.subscribe((s, prev) => {
    const was = prev.panel?.kind === 'plugin' && prev.panel.panel === DETAILS;
    const is = s.panel?.kind === 'plugin' && s.panel.panel === DETAILS;
    if (was && !is && useDetails.getState().owner === owner) setDetailsOpen((v) => (v === false ? undefined : false));
  }), [owner]);
  useEffect(() => () => {
    if (useDetails.getState().owner === owner) {
      useDetails.setState({ owner: null, open: false });
      const p = useApp.getState().panel;
      if (p?.kind === 'plugin' && p.panel === DETAILS) useApp.setState({ panel: null });
    }
  }, [owner]);
  return { api, onDetails, openLink, detailsOpen };
}

function ArtifactPage({ sessionId, id, compareTo }: { sessionId: string; id: string; compareTo?: number }) {
  const live = useLiveArtifact(sessionId, id, { compareTo });
  const { api, onDetails, openLink, detailsOpen } = useDetailsPanel(`artifact:${sessionId}/${id}`, sessionId);
  const parsed = useMemo(() => (live.doc ? validateDiagram(live.doc.content) : null), [live.doc]);
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (!live.waiting) setAsked(false); }, [live.waiting]);
  if (live.error && !live.doc) return <div className="flex h-full flex-col"><Header title="Diagram" caption={id} /><EmptyState icon="alert" title="This diagram could not be opened">{live.error}</EmptyState></div>;
  if (!live.doc || !parsed) return <div className="flex h-full items-center justify-center text-[12.5px] text-hx-muted"><Spinner size={14} className="mr-2" />Opening the diagram…</div>;
  const title = live.doc.meta.title;
  return (
    <div className="flex h-full flex-col" data-diagram-page="artifact" data-artifact={id} data-version={live.doc.version}>
      <Header title={title} caption={`${parsed.spec ? viewName(parsed.spec.view) : 'Diagram'} · v${live.doc.version}`}>
        <Button size="sm" variant="ghost" icon="chat" onClick={() => useApp.getState().navigate({ view: 'core.chat:session', params: { id: sessionId } })}>Conversation</Button>
      </Header>
      <div className="min-h-0 flex-1">
        {parsed.spec ? (
          <DiagramCanvas
            spec={parsed.spec}
            title={title}
            stableKey={`${sessionId}/${id}`}
            changed={live.changed}
            onClearChanged={live.clearChanged}
            onPositions={live.savePositions}
            onAsk={async (request) => {
              try {
                await client.sessions.send(sessionId, askMessage(request, { id, title, version: live.doc?.version }));
                setAsked(true);
                live.expectNewVersion();
                toast('Sent to the conversation', { kind: 'info' });
              } catch (e) { toast((e as Error).message, { kind: 'error' }); }
            }}
            askState={asked || live.waiting ? { pending: true, note: 'The agent is changing it…' } : null}
            details="external"
            detailsOpen={detailsOpen}
            onDetails={onDetails}
            onOpenLink={(l) => void openLink(l)}
            apiRef={api}
          />
        ) : <DiagramError error={parsed.error ?? 'unknown problem'} source={live.doc.content} />}
      </div>
    </div>
  );
}

function StashedPage({ stashKey }: { stashKey: string }) {
  const s = stashed(stashKey);
  const parsed = useMemo(() => (s ? validateDiagram(s.source) : null), [s]);
  const { api, onDetails, openLink, detailsOpen } = useDetailsPanel(`block:${stashKey}`, s?.sessionId);
  const [waiting, setWaiting] = useState(false);
  // Asked to change a block: the agent saves an artifact; open it, with what changed marked.
  useEffect(() => {
    if (!waiting || !s?.sessionId) return;
    return globalBus.on((e) => {
      const p = (e.payload ?? {}) as { sessionId?: string; id?: string; kind?: string; version?: number };
      if (e.topic !== 'artifacts' || p.sessionId !== s.sessionId || p.kind !== 'diagram' || !p.id) return;
      setWaiting(false);
      useApp.getState().navigate({ view: 'core.diagrams:diagram', params: { session: s.sessionId!, artifact: p.id } }, { replace: true });
    });
  }, [waiting, s]);
  if (!s || !parsed) return <div className="flex h-full flex-col"><Header title="Diagram" caption="" /><EmptyState icon="layers" title="This diagram is no longer open">Open it again from its conversation.</EmptyState></div>;
  const spec = parsed.spec && s.positions ? { ...parsed.spec, layout: { ...parsed.spec.layout, positions: s.positions } } : parsed.spec;
  const title = s.title ?? parsed.spec?.title ?? 'Diagram';
  return (
    <div className="flex h-full flex-col" data-diagram-page="block">
      <Header title={title} caption={parsed.spec ? `${viewName(parsed.spec.view)} · from the conversation` : ''} />
      <div className="min-h-0 flex-1">
        {spec ? (
          <DiagramCanvas
            spec={spec} title={title} stableKey={`block:${stashKey}`}
            onPositions={(p) => stashPositions(stashKey, p)}
            onAsk={s.sessionId ? async (request) => {
              try { await client.sessions.send(s.sessionId!, askMessage(request, { title })); setWaiting(true); toast('Sent to the conversation', { kind: 'info' }); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
            } : undefined}
            askState={waiting ? { pending: true, note: 'The agent is changing it…' } : null}
            details="external" detailsOpen={detailsOpen} onDetails={onDetails} onOpenLink={(l) => void openLink(l)} apiRef={api}
          />
        ) : <DiagramError error={parsed.error ?? 'unknown problem'} source={s.source} />}
      </div>
    </div>
  );
}

function CodeMapPage({ sessionId }: { sessionId: string }) {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  const { api, onDetails, openLink, detailsOpen } = useDetailsPanel(`code:${sessionId}`, sessionId);
  useEffect(() => {
    let alive = true;
    setBusy(true); setError('');
    scanImports(sessionId).then((r) => { if (alive) setScan(r); }, (e: Error) => { if (alive) setError(e.message); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [sessionId, nonce]);
  const [title, setTitle] = useState('Code map');
  useEffect(() => { client.sessions.get(sessionId).then((d) => setTitle(`${(d.meta.runtime?.path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? d.meta.title ?? 'Workspace'} - code map`)).catch(() => {}); }, [sessionId]);
  const spec = useMemo(() => (scan ? codeMapSpec(scan, { title }) : null), [scan, title]);
  return (
    <div className="flex h-full flex-col" data-diagram-page="code">
      <Header title={title} caption={scan ? `${scan.files.length} files · ${spec?.nodes.length ?? 0} folders${scan.truncated ? ' · partial (large workspace)' : ''}` : 'reading imports…'}>
        <Button size="sm" variant="ghost" icon="refresh" loading={busy} onClick={() => setNonce((n) => n + 1)}>Rescan</Button>
      </Header>
      <div className="min-h-0 flex-1">
        {error ? <EmptyState icon="alert" title="The code map could not be made">{error}</EmptyState>
          : !spec ? <div className="flex h-full items-center justify-center text-[12.5px] text-hx-muted"><Spinner size={14} className="mr-2" />Reading the imports…</div>
            : !spec.nodes.length ? <EmptyState icon="code" title="No TypeScript, JavaScript or Python files here">The code map draws imports between folders of TS/JS and Python sources.</EmptyState>
              : <DiagramCanvas spec={spec} title={title} stableKey={`code:${sessionId}`} details="external" detailsOpen={detailsOpen} onDetails={onDetails} onOpenLink={(l) => void openLink(l)} apiRef={api} />}
      </div>
    </div>
  );
}

export { changedBetween, type Changed };
