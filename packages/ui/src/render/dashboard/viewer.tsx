/**
 * The published-page viewer: the same DocView and renderers as the app, as a standalone page.
 * /p/<slug>#t=<token> reads the document and each visual's numbers from the harness server (the
 * token goes in a header, never in a URL the server logs); a static export (window.__BI_STATIC__)
 * draws its snapshot without a server. The server pushes "refreshed" and the page re-queries.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocSpec, FilterSpec, HierarchySpec, QueryResult, ViewState, VisualSpec } from '@harness/plugin-ui';
import { applyTheme, BUILTIN_THEMES } from '../../theme.ts';
import { FencedBlock, Markdown } from '../Markdown.tsx';
import { type BiClient, DocView } from './DocView.tsx';

declare global { interface Window { __BI_STATIC__?: { doc: DocSpec; exportedAt: number } } }

const params = new URLSearchParams(location.search);
const print = params.has('print');
const slug = /^\/p\/([A-Za-z0-9_-]{16})/.exec(location.pathname)?.[1];
const token = /[#&]t=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
const api = (p: string) => `/p/${slug}/api/${p}`;
const headers = (): Record<string, string> => ({ 'content-type': 'application/json', ...(token ? { 'x-harness-share': token } : {}) });

async function json<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(body.error ?? `HTTP ${r.status}`), { status: r.status });
  return body;
}

/** Server-sent events over fetch (EventSource cannot send the share token as a header). */
function listen(on: (e: { type: string }) => void): () => void {
  const ctl = new AbortController();
  let stopped = false;
  const run = async () => {
    while (!stopped) {
      try {
        const res = await fetch(api('events'), { headers: headers(), signal: ctl.signal });
        if (res.status === 404) { on({ type: 'gone' }); return; }
        const rd = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { value, done } = await rd.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) { const d = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1]; buf = buf.slice(i + 2); if (d) { const e = JSON.parse(d) as { type: string }; on(e); if (e.type === 'gone') return; } }
        }
      } catch { /* dropped: reconnect */ }
      if (!stopped) await new Promise((r) => setTimeout(r, 3000));
    }
  };
  void run();
  return () => { stopped = true; ctl.abort(); };
}

function useDark(): boolean {
  const q = window.matchMedia?.('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(!print && !!q?.matches);
  useEffect(() => { const f = () => setDark(!print && q.matches); q?.addEventListener('change', f); return () => q?.removeEventListener('change', f); }, []);
  useEffect(() => { applyTheme(document.documentElement, BUILTIN_THEMES.find((t) => t.id === (dark ? 'dark' : 'light'))!); }, [dark]);
  return dark;
}

const renderMarkdown = (t: string) => <Markdown text={t} />;
const renderFence = (lang: string, source: string) => <FencedBlock lang={lang} source={source} />;

/** A dashboard the published one links to, opened through it (the filters it carried live in the history entry, not the address). */
interface Linked { id: string; page?: string; filters?: FilterSpec[] }

function Viewer() {
  const dark = useDark();
  const [doc, setDoc] = useState<DocSpec>();
  const [hier, setHier] = useState<HierarchySpec[]>([]);
  const [error, setError] = useState<string>();
  const [linked, setLinked] = useState<Linked | undefined>(() => (history.state as { linked?: Linked } | null)?.linked);
  const [fields, setFields] = useState<string[]>([]);
  const stat = window.__BI_STATIC__;
  const q = linked ? `?linked=${encodeURIComponent(linked.id)}` : '';
  const load = () => {
    if (stat) { setDoc(stat.doc); return; }
    if (!slug) { setError('Not a published page.'); return; }
    fetch(api(`doc${q}`), { headers: headers() }).then((r) => json<{ doc: DocSpec; hierarchies: HierarchySpec[]; fields?: string[] }>(r)).then((x) => { setDoc(x.doc); setHier(x.hierarchies); setFields(x.fields ?? []); document.title = x.doc.title; }, (e: Error & { status?: number }) => setError(e.status === 401 ? 'This link needs its share token (the part after #t= in the address).' : e.status === 404 ? 'This page is not published (or was unpublished).' : e.message));
  };
  useEffect(load, [linked?.id]);
  useEffect(() => { const f = (e: PopStateEvent) => { setDoc(undefined); setLinked((e.state as { linked?: Linked } | null)?.linked); }; addEventListener('popstate', f); return () => removeEventListener('popstate', f); }, []);
  const client = useMemo<BiClient>(() => (stat ? {
    async visual(v: VisualSpec) { const r = stat.doc.snapshot?.results[v.id]; if (!r) throw new Error('Not in this export'); return r; },
  } : {
    async visual(v: VisualSpec, state: ViewState, signal: AbortSignal): Promise<QueryResult> { return json<QueryResult>(await fetch(api('visual'), { method: 'POST', headers: headers(), body: JSON.stringify({ visual: v.id, state, ...(linked ? { linked: linked.id } : {}) }), signal })); },
    async geo(source: string) { return json(await fetch(api(`geo/${encodeURIComponent(source)}${q}`), { headers: headers() })); },
    subscribe: (on) => listen((e) => { if (e.type === 'doc_changed') load(); on(e); }),
  }), [linked?.id]);
  // Another dashboard (linked from this one): opened here, with the filters it may take; Back returns.
  const openDoc = stat ? undefined : (to: { doc: string; page?: string; filters: FilterSpec[] }) => {
    const next: Linked = { id: to.doc, ...(to.page ? { page: to.page } : {}), filters: to.filters };
    history.pushState({ linked: next }, '', location.href);
    setDoc(undefined); setLinked(next);
  };
  const base = (f: string) => f.replace(/:.*$/, '');
  const carried = linked?.filters?.filter((f) => fields.includes(f.field) || fields.some((x) => base(x) === base(f.field) && !f.field.includes(':')));
  if (error) return <div className="flex h-full items-center justify-center p-8 text-center text-[15px] text-hx-secondary" data-bi-error>{error}</div>;
  if (!doc) return <div className="flex h-full items-center justify-center text-hx-muted">Loading…</div>;
  return (
    <div className="flex h-full flex-col">
      {!print && !doc.pages.filter((p) => !p.kind).every((p) => p.layout?.type === 'tv') && <header className="flex items-center gap-2 border-b border-hx-border-subtle px-3 py-2"><h1 className="min-w-0 flex-1 truncate text-[16px] font-semibold" data-bi-title>{doc.title}</h1>{stat && <span className="text-[11.5px] text-hx-muted">Static export · interactions need the live page</span>}</header>}
      {linked && <div className="flex items-center gap-2 border-b border-hx-border-subtle px-3 py-1 text-[12px]"><button type="button" className="text-hx-accent-text hover:underline" onClick={() => history.back()} data-bi-linked-back>Back</button><span className="text-hx-muted">Opened from a linked dashboard{carried?.length ? ` with ${carried.length} filter${carried.length === 1 ? '' : 's'}` : ''}</span></div>}
      <div className="min-h-0 flex-1"><DocView key={linked?.id ?? 'main'} doc={doc} client={client} hierarchies={hier} dark={dark} mode={stat ? 'static' : 'published'} print={print} renderMarkdown={renderMarkdown} renderFence={renderFence} page={linked?.page} initialFilters={carried} onOpenDoc={openDoc} /></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Viewer />);
