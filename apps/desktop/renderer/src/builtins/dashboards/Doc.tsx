/**
 * A dashboard or report: viewed live, or edited in place (drag, resize, the inspector). Every change
 * is an op (act), versioned, with Undo and Redo; the Ask box hands a question or a change request
 * to an agent that applies the same ops, and the change arrives here live.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type DocSpec, type FilterSpec, THEMES, VISUAL_TYPES, type ViewState, type VisualSpec } from '@harness/plugin-ui';
import { Badge, Button, DocView, EmptyState, FencedBlock, Field, IconButton, Input, Markdown, MenuList, Modal, Popover, Select, Spinner, Switch, Textarea, Tooltip, cx, toast, type MenuItem, ResizablePane } from '@harness/ui';
import { DASHBOARD_INSPECTOR_PANE } from '../../state/layout';
import { client, clientInfo, useData } from '../../state/data';
import { navigate, openPluginPanel, useApp } from '../../state/app';
import { useFenceRenderer } from '../core.chat/Transcript';
import { act, appClient, type DocDetail, useDataStore } from './api';
import { Inspector, PageInspector } from './Inspector';
import { LAYOUT_LABEL, LayoutDialog, TemplateDialog } from './LayoutUi';

export function useDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  useEffect(() => { const o = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark')); o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] }); return () => o.disconnect(); }, []);
  return dark;
}

const TYPE_LABEL: Record<string, string> = { card: 'Card', multicard: 'Multi-row card', kpi: 'KPI', gauge: 'Gauge', bar: 'Bar', column: 'Column', line: 'Line', area: 'Area', combo: 'Line and column', ribbon: 'Ribbon', waterfall: 'Waterfall', funnel: 'Funnel', pie: 'Pie', donut: 'Donut', treemap: 'Treemap', scatter: 'Scatter / bubble', table: 'Table', matrix: 'Matrix', map: 'Map', decomp: 'Decomposition tree', drivers: 'Key drivers', narrative: 'Smart narrative', slicer: 'Slicer', text: 'Text', image: 'Image', button: 'Button', fence: 'Science / diagram / plugin' };
export { TYPE_LABEL };

export function DocPage({ params }: { params: Record<string, string> }): React.ReactElement {
  const id = params.id ?? '';
  const [d, setD] = useState<DocDetail>();
  const [error, setError] = useState<string>();
  const [edit, setEdit] = useState(params.edit === '1');
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<string | undefined>(params.page);
  // Opened from another dashboard (a link, a button, a drill-through): the page and the filters it carried.
  useEffect(() => { setPage(params.page); }, [id, params.page]);
  const carried = useMemo(() => { try { return params.ctx ? JSON.parse(params.ctx) as FilterSpec[] : undefined; } catch { return undefined; } }, [params.ctx]);
  const [viewAs, setViewAs] = useState('');
  const [dialog, setDialog] = useState<'publish' | 'alerts' | 'subs' | 'refresh' | 'theme' | 'history' | 'verify' | 'layout' | 'template' | null>(null);
  const [state, setState] = useState<ViewState>({});
  const [asking, setAsking] = useState<null | 'ask' | 'bookmark'>(null);
  const [askVisual, setAskVisual] = useState<VisualSpec | null>(null);
  const version = useDataStore((s) => s.docVersion[id]);
  const catalog = useDataStore((s) => s.catalog);
  const dark = useDark();
  const fence = useFenceRenderer();
  const load = useCallback(async () => { try { setD(await client.get<DocDetail>(`/api/data/docs/${id}`)); setError(undefined); } catch (e) { setError((e as Error).message); } }, [id]);
  useEffect(() => { void load(); if (!catalog) void useDataStore.getState().refreshCatalog(); }, [id, version]);
  const bi = useMemo(() => appClient(id, viewAs || undefined), [id, viewAs]);
  const renderMarkdown = useCallback((t: string) => <Markdown text={t} renderFence={fence} />, [fence]);
  const renderFence = useCallback((lang: string, source: string) => <FencedBlock lang={lang} source={source} renderFence={fence} />, [fence]);
  if (error) return <EmptyState icon="alert" title="This document could not be opened" action={<Button onClick={() => navigate({ view: 'core.dashboards:dashboards' })}>All dashboards</Button>}>{error}</EmptyState>;
  if (!d) return <div className="flex h-full items-center justify-center"><Spinner size={20} /></div>;
  const doc = d.doc;
  const cur = doc.pages.find((p) => p.id === page) ?? doc.pages[0]!;
  const sel = selected ? doc.pages.flatMap((p) => p.visuals).find((v) => v.id === selected) : undefined;
  const addVisual = (type: VisualSpec['type']) => void act('doc.add-visual', { doc: id, page: cur.id, visual: { type, ...titled(type, starter(type, d)) } }).then((r) => { setEdit(true); setSelected(r.results[0]?.data?.id ?? null); }).catch(() => {});
  const visualMenu: MenuItem[] = (VISUAL_TYPES as readonly string[]).filter((t) => t !== 'fence' || true).map((t) => ({ id: t, label: TYPE_LABEL[t] ?? t, onSelect: () => addVisual(t as VisualSpec['type']) }));
  const exportAs = (format: string) => { if (format === 'html') { void client.get<{ path: string }>(`/api/data/docs/${id}/export?format=html`).then((r) => toast(`Static site written to ${r.path}`, { kind: 'success' }), (e: Error) => toast(e.message, { kind: 'error' })); return; } const a = document.createElement('a'); a.href = `/api/data/docs/${id}/export?format=${format}`; a.click(); };
  const more: MenuItem[] = [
    { id: 'verify', label: 'Verify every visual', icon: 'check-circle', onSelect: () => setDialog('verify') },
    { id: 'refresh', label: 'Refresh schedule…', icon: 'clock', onSelect: () => setDialog('refresh') },
    { id: 'theme', label: 'Theme…', icon: 'palette', onSelect: () => setDialog('theme') },
    { id: 'alerts', label: 'Alerts…', icon: 'bell', onSelect: () => setDialog('alerts') },
    { id: 'subs', label: 'Subscriptions…', icon: 'mail', onSelect: () => setDialog('subs') },
    { id: 'bookmark', label: 'Save a bookmark of this view', icon: 'bookmark', onSelect: () => setAsking('bookmark') },
    { id: 'history', label: 'Version history…', icon: 'history', onSelect: () => setDialog('history') },
    ...(doc.type === 'report' ? [{ id: 'snapshot', label: 'Refresh and snapshot', icon: 'camera', onSelect: () => void act('doc.snapshot', { doc: id }).catch(() => {}) }] : []),
    { id: 'delete', label: `Delete this ${doc.type}`, icon: 'trash', danger: true, onSelect: () => void useApp.getState().ask({ title: `Delete "${doc.title}"?`, body: 'Its versions go too, and a published page stops working.', confirmLabel: 'Delete', danger: true }).then((yes) => { if (yes) void act('doc.delete', { doc: id }).then(() => navigate({ view: 'core.dashboards:dashboards' })).catch(() => {}); }) },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col" data-bi-editor={id} data-bi-version={d.version}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-hx-border-subtle px-3 py-1.5">
        <IconButton icon="arrow-left" size="sm" label="All dashboards" onClick={() => navigate({ view: doc.type === 'report' ? 'core.dashboards:reports' : 'core.dashboards:dashboards' })} />
        {edit ? <input aria-label="Title" defaultValue={doc.title} key={doc.title} className="min-w-0 flex-1 rounded bg-transparent px-1 text-[15px] font-semibold hover:bg-hx-hover focus:bg-hx-bg" onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== doc.title) void act('doc.rename', { doc: id, patch: { title: t } }).catch(() => {}); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          : <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold" data-bi-doc-title>{doc.title}</h1>}
        {d.published && <Badge tone="accent">Published</Badge>}
        <span className="text-[11px] text-hx-muted" title="Version">v{d.version}</span>
        <Tooltip label="Undo"><IconButton icon="arrow-left" size="sm" label="Undo" onClick={() => void act('doc.undo', { doc: id }).catch(() => {})} data-bi-undo /></Tooltip>
        <Tooltip label="Redo"><IconButton icon="arrow-right" size="sm" label="Redo" onClick={() => void act('doc.redo', { doc: id }).catch(() => {})} data-bi-redo /></Tooltip>
        <Tooltip label="Read the sources again"><IconButton icon="refresh" size="sm" label="Refresh the data" onClick={() => void act('data.refresh', { doc: id }, { quiet: true }).then((r) => toast(r.results[0]?.message.split('\n')[0] ?? 'Refreshed', { kind: 'success' })).catch(() => {})} data-bi-refresh /></Tooltip>
        <PopMenu label="Add a visual" icon="plus" items={visualMenu} testid="add-visual" />
        <PopMenu label={LAYOUT_LABEL[cur.layout?.type ?? 'grid']!.replace(/ \(.*/, '')} icon="grid" testid="layout" items={[
          { id: 'layout', label: 'Layout type and options…', icon: 'grid', onSelect: () => setDialog('layout') },
          { id: 'template', label: 'Add a page from a template…', icon: 'apps', onSelect: () => setDialog('template') },
          { id: 'pack', label: 'Pack the page up (close gaps)', icon: 'arrow-up', onSelect: () => void act('layout.pack', { doc: id, page: cur.id, direction: 'up' }).catch(() => {}) },
          { id: 'tv', label: 'Make this page a TV wall', icon: 'monitor', onSelect: () => void act('layout.type', { doc: id, page: cur.id, layout: { type: 'tv' } }).catch(() => {}) },
          { id: 'print', label: 'Make this page printable', icon: 'printer', onSelect: () => void act('layout.type', { doc: id, page: cur.id, layout: { type: 'print' } }).catch(() => {}) },
        ]} />
        <Button size="sm" variant={edit ? 'primary' : 'secondary'} icon="edit" onClick={() => { setEdit(!edit); setSelected(null); }} data-bi-edit aria-pressed={edit}>{edit ? 'Done' : 'Edit'}</Button>
        <Button size="sm" icon="sparkles" onClick={() => setAsking('ask')} data-bi-ask>Ask</Button>
        <Button size="sm" icon="share" onClick={() => setDialog('publish')} data-bi-publish>Publish</Button>
        <PopMenu label="Export" icon="download" items={[{ id: 'xlsx', label: 'Excel workbook', onSelect: () => exportAs('xlsx') }, { id: 'csv', label: 'CSV (first visual)', onSelect: () => exportAs('csv') }, { id: 'pdf', label: 'PDF (paginated)', onSelect: () => exportAs('pdf') }, { id: 'png', label: 'PNG image', onSelect: () => exportAs('png') }, { id: 'html', label: 'Static site (folder)', onSelect: () => exportAs('html') }]} />
        {d.model?.roles.length ? <Select aria-label="View as" value={viewAs} onChange={setViewAs} options={[{ value: '', label: 'As owner' }, ...d.model.roles.map((r) => ({ value: r.name, label: `As ${r.name}` }))]} className="w-36" /> : null}
        <PopMenu label="More" icon="more" items={more} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1" onClick={() => edit && setSelected(null)}>
          <DocView key={`${id}:${params.ctx ?? ''}`} doc={doc} client={bi} hierarchies={d.model?.hierarchies} dark={dark} page={page} onPage={setPage} onState={setState} renderMarkdown={renderMarkdown} renderFence={renderFence}
            initialFilters={carried?.filter((f) => !d.model || d.model.tables.some((t) => f.field.startsWith(`${t.name}.`)))} onOpenDoc={(to) => navigate({ view: 'core.dashboards:doc', params: { id: to.doc, ...(to.page ? { page: to.page } : {}), ctx: JSON.stringify(to.filters) } })}
            visualActions={(v) => <IconButton size="xs" icon="sparkles" label="Ask the agent about this visual" data-ask-visual={v.id} onClick={(e) => { e.stopPropagation(); setAskVisual(v); setAsking('ask'); }} />}
            edit={edit ? {
              selected, onSelect: setSelected,
              onMove: (vid, pos) => void act('layout.drag', { doc: id, visual: vid, x: pos.x, y: pos.y, ...(pos.dx || pos.dy ? { dx: pos.dx, dy: pos.dy } : {}), ...(pos.breakpoint ? { breakpoint: pos.breakpoint } : {}) }, { quiet: true }).catch(() => {}),
              onResize: (vid, s) => void act('layout.resize', { doc: id, visual: vid, w: s.w, h: s.h, ...(s.breakpoint ? { breakpoint: s.breakpoint } : {}) }, { quiet: true }).catch(() => {}),
              onLayoutOptions: (patch) => void act('layout.sidebar-width', { doc: id, page: cur.id, layout: patch }, { quiet: true }).catch(() => {}),
              onSection: (sid, patch) => void act('layout.collapse', { doc: id, page: cur.id, section: sid, patch }, { quiet: true }).catch(() => {}),
            } : undefined} />
        </div>
        {edit && (
          <ResizablePane spec={DASHBOARD_INSPECTOR_PANE} edge="start" as="aside" className="flex flex-col border-l border-hx-border-subtle bg-hx-bg" data-bi-inspector="">
            <div className="hx-scroll min-h-0 flex-1 overflow-y-auto">
              {sel ? <Inspector docId={id} detail={d} v={sel} onClose={() => setSelected(null)} /> : <PageInspector docId={id} detail={d} page={cur} />}
            </div>
          </ResizablePane>
        )}
      </div>
      {dialog === 'publish' && <PublishDialog id={id} detail={d} onClose={() => setDialog(null)} />}
      {dialog === 'refresh' && <RefreshDialog id={id} doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'theme' && <ThemeDialog id={id} doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'alerts' && <AlertsDialog id={id} detail={d} onClose={() => setDialog(null)} />}
      {dialog === 'subs' && <SubsDialog id={id} doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'history' && <HistoryDialog id={id} onClose={() => setDialog(null)} />}
      {dialog === 'verify' && <VerifyDialog id={id} onClose={() => setDialog(null)} />}
      {dialog === 'layout' && <LayoutDialog id={id} page={cur} onClose={() => setDialog(null)} />}
      {dialog === 'template' && <TemplateDialog doc={d} onClose={() => setDialog(null)} />}
      {asking && <TextPrompt title={asking === 'ask' ? `Ask about ${askVisual ? `"${askVisual.title ?? askVisual.type}"` : `"${doc.title}"`}` : 'Save a bookmark'} placeholder={asking === 'ask' ? 'A question, or a change: "make Top countries a stacked bar by quarter and add YoY %"' : 'Bookmark name'} multiline={asking === 'ask'} ok={asking === 'ask' ? 'Ask the agent' : 'Save'}
        onClose={() => { setAsking(null); setAskVisual(null); }} onOk={(text) => { setAsking(null); const v = askVisual; setAskVisual(null); if (asking === 'ask') void startAsk(id, doc, cur.id, state, v ? `About visual ${v.id} ("${v.title ?? v.type}"): ${text}` : text); else void act('doc.bookmark', { doc: id, bookmark: { name: text, page: cur.id, filters: [...(state.filters ?? []), ...(state.selection?.filters ?? [])] } }).catch(() => {}); }} />}
    </div>
  );
}

/** A new visual's title from what it shows ("Revenue by region"); cards show their measure's own name. */
function titled(type: VisualSpec['type'], v: Partial<VisualSpec>): Partial<VisualSpec> {
  if (['card', 'kpi', 'text', 'image', 'button'].includes(type)) return v;
  const m = (v.query?.measures ?? []).map((x) => (typeof x === 'string' ? x : x.name));
  const by = (v.query?.dims ?? []).map((x) => x.split('.').pop()!.replace(/:(\w+)$/, ' by $1'));
  const t = type === 'slicer' ? v.options?.slicer?.field.split('.').pop() : m.length ? `${m.join(' and ')}${by.length ? ` by ${by.join(' and ')}` : ''}` : TYPE_LABEL[type];
  return { ...v, ...(t ? { title: t } : {}) };
}

/** A sensible first query for a new visual: the model's first measure by its first text field. */
function starter(type: VisualSpec['type'], d: DocDetail): Partial<VisualSpec> {
  const m = d.model;
  const measure = m?.measures[0]?.name;
  const cat = useDataStore.getState().catalog;
  const dimField = (() => {
    for (const t of m?.tables ?? []) { const c = cat?.datasets.find((x) => x.name === t.dataset)?.state.columns?.find((x) => x.type === 'VARCHAR'); if (c) return `${t.name}.${c.name}`; }
    return undefined;
  })();
  const dateField = (() => { if (m?.date) return `${m.date.replace(/:.*$/, '')}:month`; return undefined; })();
  if (!measure) {
    // No model: the first dataset's first number and first text column.
    const ds = cat?.datasets.find((x) => x.state.columns?.length);
    const num = ds?.state.columns?.find((c) => /INT|DOUBLE|DECIMAL|FLOAT/.test(c.type) && !/id$/i.test(c.name));
    const txt = ds?.state.columns?.find((c) => c.type === 'VARCHAR');
    if (!ds || !num) return type === 'text' ? { options: { markdown: '## Notes\nWrite here.' } } : {};
    const m = { name: `Total ${num.name}`, expr: `sum(${ds.name}."${num.name}")` };
    const dim = txt ? `${ds.name}.${txt.name}` : undefined;
    if (['card', 'kpi', 'gauge', 'narrative'].includes(type)) return { query: { measures: [m] } };
    if (type === 'slicer') return dim ? { options: { slicer: { field: dim, style: 'buttons' } } } : {};
    if (type === 'text') return { options: { markdown: '## Notes\nWrite here.' } };
    return { query: { dims: dim ? [dim] : [], measures: [m] } };
  }
  switch (type) {
    case 'card': case 'kpi': case 'gauge': return { query: { measures: [measure] } };
    case 'multicard': return { query: { dims: dimField ? [dimField] : [], measures: [measure] } };
    case 'line': case 'area': return { query: { dims: [dateField ?? dimField ?? ''].filter(Boolean), measures: [measure] } };
    case 'scatter': return { query: { dims: dimField ? [dimField] : [], measures: m!.measures.slice(0, 2).map((x) => x.name) } };
    case 'table': case 'matrix': return { query: { dims: dimField ? [dimField] : [], measures: [measure] } };
    case 'slicer': return dimField ? { options: { slicer: { field: dimField, style: 'buttons' } } } : {};
    case 'text': return { options: { markdown: '## Notes\nWrite here.' } };
    case 'image': return { options: { url: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgNDAiPjx0ZXh0IHg9IjUwIiB5PSIyNCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1zaXplPSIxMCI+SW1hZ2U8L3RleHQ+PC9zdmc+' } };
    case 'button': return { options: { button: { label: 'Clear filters', action: 'clear' } } };
    case 'decomp': case 'drivers': return { query: { measures: [measure] }, options: { dims: dimField ? [dimField] : [] } };
    case 'narrative': return { query: { measures: [measure] } };
    case 'fence': return { options: { fence: { lang: 'smiles', source: 'CC(=O)Oc1ccccc1C(=O)O' } } };
    case 'map': return { query: { dims: dimField ? [dimField] : [], measures: [measure] } };
    default: return { query: { dims: dimField ? [dimField] : [], measures: [measure] } };
  }
}

function PopMenu({ label, icon, items, testid }: { label: string; icon: string; items: MenuItem[]; testid?: string }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={ref} size="sm" icon={icon} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} data-menu={testid ?? label}>{label}</Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} role="menu" label={label}><MenuList items={items} onDone={() => setOpen(false)} /></Popover>
    </>
  );
}

function TextPrompt({ title, placeholder, ok, multiline, onOk, onClose }: { title: string; placeholder: string; ok: string; multiline?: boolean; onOk(t: string): void; onClose(): void }) {
  const [t, setT] = useState('');
  const go = () => { if (t.trim()) onOk(t.trim()); };
  return (
    <Modal open onClose={onClose} title={title} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go} disabled={!t.trim()} data-prompt-ok>{ok}</Button></>}>
      {multiline ? <Textarea autoFocus rows={3} value={t} onChange={(e) => setT(e.target.value)} placeholder={placeholder} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }} data-prompt-input />
        : <Input autoFocus value={t} onChange={(e) => setT(e.target.value)} placeholder={placeholder} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} data-prompt-input />}
    </Modal>
  );
}

/** Ask: a question or a change request about this dashboard goes to an agent (the same ops); its conversation opens beside it. */
export async function startAsk(id: string, doc: DocSpec, page: string, state: ViewState, text: string): Promise<string | undefined> {
  const { models } = useData.getState();
  const prefs = useApp.getState().prefs;
  const model = models.find((m) => m.id === prefs.defaultModel && m.available) ?? models.find((m) => m.available) ?? models[0];
  if (!model) { toast('Choose a model first (Settings > Models & providers).', { kind: 'warning' }); return undefined; }
  const filters = [...(state.filters ?? []), ...(state.selection?.filters ?? [])];
  const brief = `On ${doc.type} ${id} ("${doc.title}"), page ${page}${filters.length ? `, with filters ${JSON.stringify(filters)}` : ''}: ${text}\n\nUse the dashboard, model and dataset tools (dashboard {op:"describe", doc:"${id}"} first; op help for the guide). Apply changes as ops, run verify, and answer with the diff. Numbers only from executed results. If the request is ambiguous, ask me with ask_user.`;
  try {
    const s = await client.sessions.create({ title: `${doc.title}: ${text.slice(0, 50)}`, model: model.id, mode: 'acceptEdits', runtime: 'local', client: clientInfo() });
    useData.getState().upsertSession(s);
    openPluginPanel('core.dashboards:ask', { session: s.id, doc: id });
    await client.sessions.send(s.id, brief);
    return s.id;
  } catch (e) { toast((e as Error).message, { kind: 'error' }); return undefined; }
}

// ---------------- dialogs ----------------

function PublishDialog({ id, detail, onClose }: { id: string; detail: DocDetail; onClose(): void }) {
  const [access, setAccess] = useState<'token' | 'signed-in'>('token');
  const [accounts, setAccounts] = useState('');
  const [role, setRole] = useState('');
  const [showSql, setShowSql] = useState(false);
  const [out, setOut] = useState<{ url: string; token?: string }>();
  const [busy, setBusy] = useState(false);
  const publish = async () => {
    setBusy(true);
    try {
      const r = await act('doc.publish', { doc: id, access, ...(accounts.trim() ? { accounts: accounts.split(/[\s,]+/).filter(Boolean) } : {}), ...(role ? { role } : {}), showSql });
      const data = r.results[0]?.data as { url: string; fullUrl?: string; token?: string };
      setOut({ ...data, url: data.fullUrl ?? data.url });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  const full = (u: string) => u;
  return (
    <Modal open onClose={onClose} title="Publish as a live page" footer={<>{detail.published && <Button variant="danger" onClick={() => void act('doc.unpublish', { doc: id }).then(onClose).catch(() => {})} data-bi-unpublish>Unpublish</Button>}<Button onClick={onClose}>Close</Button><Button variant="primary" loading={busy} onClick={() => void publish()} data-bi-publish-go>{detail.published ? 'Publish again (new link)' : 'Publish'}</Button></>}>
      <div className="space-y-2 text-[13px]">
        <p className="text-hx-secondary">The page looks and works as it does here, read-only. Its numbers refresh on the server on this dashboard's schedule and reach viewers live. Viewers never get SQL, sources or credentials{showSql ? ' (except the SQL: you allow it below)' : ''}.</p>
        <Field label="Who can see it"><Select value={access} onChange={(v) => setAccess(v as 'token')} options={[{ value: 'token', label: 'Anyone with the link (a secret token)' }, { value: 'signed-in', label: 'Signed-in accounts of this server' }]} /></Field>
        {access === 'signed-in' && <Field label="Accounts" help="Account ids (usr_...), comma separated; empty: every account; * for all signed-in."><Input value={accounts} onChange={(e) => setAccounts(e.target.value)} /></Field>}
        {detail.model?.roles.length ? <Field label="Row-level security" help="A link shows the rows of this role. Signed-in viewers see their own roles' rows."><Select value={role} onChange={setRole} options={[{ value: '', label: access === 'token' ? 'No role: every row' : 'By membership' }, ...detail.model.roles.map((r) => ({ value: r.name, label: r.name }))]} /></Field> : null}
        <Switch checked={showSql} onChange={setShowSql} label="Let viewers see the SQL behind each visual" />
        {out && (
          <div className="space-y-1 rounded-lg border border-hx-border-subtle bg-hx-code p-2" data-bi-published-url>
            <div className="break-all font-mono text-[12px]">{full(out.url)}</div>
            <div className="flex gap-1"><Button size="sm" icon="copy" onClick={() => void navigator.clipboard.writeText(full(out.url)).then(() => toast('Link copied'))}>Copy link</Button><Button size="sm" icon="code" onClick={() => void navigator.clipboard.writeText(`<iframe src="${full(out.url)}" style="border:0;width:100%;height:720px" loading="lazy"></iframe>`).then(() => toast('Embed code copied'))}>Copy embed code</Button></div>
            {out.token && <p className="text-[11.5px] text-hx-muted">The token is shown once (it is part of the link). Publishing again makes a new one; unpublishing stops every link at once.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function RefreshDialog({ id, doc, onClose }: { id: string; doc: DocSpec; onClose(): void }) {
  const [mode, setMode] = useState(doc.refresh?.mode ?? 'manual');
  const [every, setEvery] = useState(String(doc.refresh?.every ?? 3600));
  const [cron, setCron] = useState(doc.refresh?.cron ?? '0 * * * *');
  const [event, setEvent] = useState(doc.refresh?.event ?? 'data:dataset_refreshed');
  const save = () => void act('doc.refresh-policy', { doc: id, refresh: { mode, ...(mode === 'interval' ? { every: Number(every) } : {}), ...(mode === 'cron' ? { cron } : {}), ...(mode === 'event' ? { event } : {}) } }).then(onClose).catch(() => {});
  return (
    <Modal open onClose={onClose} title="Refresh schedule" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} data-bi-save-refresh>Save</Button></>}>
      <Field label="Read the sources again"><Select value={mode} onChange={(v) => setMode(v as 'manual')} options={[{ value: 'manual', label: 'Only when asked' }, { value: 'interval', label: 'Every N seconds' }, { value: 'cron', label: 'On a schedule (cron)' }, { value: 'event', label: 'When an event happens' }]} /></Field>
      {mode === 'interval' && <Field label="Seconds" help="3600 = hourly; at least 10."><Input type="number" min={10} value={every} onChange={(e) => setEvery(e.target.value)} /></Field>}
      {mode === 'cron' && <Field label="Cron (five fields)" help="0 * * * * = hourly; 0 8 * * 1-5 = weekdays at 8."><Input value={cron} onChange={(e) => setCron(e.target.value)} /></Field>}
      {mode === 'event' && <Field label="Event" help="A global event topic, or topic:type."><Input value={event} onChange={(e) => setEvent(e.target.value)} /></Field>}
    </Modal>
  );
}

function ThemeDialog({ id, doc, onClose }: { id: string; doc: DocSpec; onClose(): void }) {
  const cur = typeof doc.theme === 'string' ? doc.theme : doc.theme?.name ?? 'default';
  return (
    <Modal open onClose={onClose} title="Theme">
      <div className="grid grid-cols-2 gap-2">{THEMES.map((t) => (
        <button key={t.name} type="button" aria-pressed={cur === t.name} onClick={() => void act('doc.theme', { doc: id, theme: t.name }).then(onClose).catch(() => {})} className={cx('rounded-lg border p-2 text-left', cur === t.name ? 'border-hx-accent' : 'border-hx-border hover:bg-hx-hover')} style={t.background ? { background: t.background, color: t.foreground } : undefined}>
          <div className="mb-1 text-[13px] font-medium capitalize">{t.name}</div><div className="flex gap-0.5">{t.palette.slice(0, 8).map((c) => <span key={c} className="h-3 w-5 rounded-sm" style={{ background: c }} />)}</div>
        </button>
      ))}</div>
    </Modal>
  );
}

function AlertsDialog({ id, detail, onClose }: { id: string; detail: DocDetail; onClose(): void }) {
  const [name, setName] = useState('');
  const [measure, setMeasure] = useState(detail.model?.measures[0]?.name ?? '');
  const [op, setOp] = useState('lt');
  const [value, setValue] = useState('0');
  const [notify, setNotify] = useState(true);
  return (
    <Modal open onClose={onClose} title="Alerts" footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-2 text-[12.5px] text-hx-secondary">Checked after every refresh: when a measure crosses its threshold the alert fires once (and again only after it recovers), is recorded, and can notify you.</p>
      {(detail.doc.alerts ?? []).map((a) => <div key={a.id} className="flex items-center gap-2 py-1 text-[13px]"><span className="flex-1">{a.name}: {a.measure} {a.op} {a.value}{a.notify ? ' · notifies' : ''}</span><IconButton icon="trash" size="xs" label="Remove" onClick={() => void act('doc.remove-alert', { doc: id, alert: a.id }).catch(() => {})} /></div>)}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Alert name" />
        <Select value={measure} onChange={setMeasure} options={(detail.model?.measures ?? []).map((m) => ({ value: m.name, label: m.name }))} aria-label="Measure" />
        <Select value={op} onChange={setOp} options={['gt', 'ge', 'lt', 'le', 'eq', 'ne'].map((x) => ({ value: x, label: { gt: 'above', ge: 'at or above', lt: 'below', le: 'at or below', eq: 'equal to', ne: 'not equal to' }[x]! }))} aria-label="Condition" />
        <Input type="number" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Threshold" />
      </div>
      <div className="mt-2 flex items-center gap-2"><Switch checked={notify} onChange={setNotify} label="Notify me" /><Button size="sm" variant="primary" className="ml-auto" onClick={() => void act('doc.alert', { doc: id, alert: { name: name || `${measure} ${op} ${value}`, measure, op, value: Number(value), notify } }).catch(() => {})}>Add alert</Button></div>
    </Modal>
  );
}

function SubsDialog({ id, doc, onClose }: { id: string; doc: DocSpec; onClose(): void }) {
  const [cron, setCron] = useState('0 8 * * 1');
  const [format, setFormat] = useState('pdf');
  const [deliver, setDeliver] = useState('save');
  return (
    <Modal open onClose={onClose} title="Subscriptions" footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-2 text-[12.5px] text-hx-secondary">A snapshot on a schedule: saved in your exports, or announced as a notification.</p>
      {(doc.subscriptions ?? []).map((s) => <div key={s.id} className="flex items-center gap-2 py-1 text-[13px]"><span className="flex-1">{s.format.toUpperCase()} at {s.cron} · {s.deliver}</span><IconButton icon="trash" size="xs" label="Remove" onClick={() => void act('doc.unsubscribe', { doc: id, subscription: s.id }).catch(() => {})} /></div>)}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Input value={cron} onChange={(e) => setCron(e.target.value)} aria-label="Cron" />
        <Select value={format} onChange={setFormat} options={['pdf', 'xlsx', 'csv', 'png', 'html'].map((x) => ({ value: x, label: x.toUpperCase() }))} aria-label="Format" />
        <Select value={deliver} onChange={setDeliver} options={[{ value: 'save', label: 'Save' }, { value: 'notify', label: 'Notify' }]} aria-label="Delivery" />
      </div>
      <div className="mt-2 flex justify-end"><Button size="sm" variant="primary" onClick={() => void act('doc.subscribe', { doc: id, subscription: { cron, format, deliver } }).catch(() => {})}>Add subscription</Button></div>
    </Modal>
  );
}

function HistoryDialog({ id, onClose }: { id: string; onClose(): void }) {
  const [rows, setRows] = useState<Array<{ version: number; at: number; by: string; ops: string[]; kind: string; session?: string }>>();
  useEffect(() => { void act('doc.history', { doc: id }, { quiet: true }).then((r) => setRows((r.results[0]?.data as unknown as typeof rows) ?? [])).catch(() => setRows([])); }, [id]);
  return (
    <Modal open onClose={onClose} title="Version history" size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      {!rows ? <Spinner /> : (
        <div className="max-h-[60vh] overflow-auto text-[12.5px]">{[...rows].reverse().map((r) => (
          <div key={r.version} className="flex items-center gap-2 border-b border-hx-border-subtle py-1">
            <b className="w-10">v{r.version}</b><span className="w-40 text-hx-muted">{new Date(r.at).toLocaleString()}</span>
            <span className="min-w-0 flex-1 truncate">{r.by.startsWith('agent:') ? '🤖 agent' : r.by ? 'you' : ''} {r.kind !== 'ops' ? r.kind : ''} {r.ops.join(', ')}</span>
            <Button size="sm" onClick={() => void act('doc.restore', { doc: id, version: r.version }).then(onClose).catch(() => {})}>Restore</Button>
          </div>
        ))}</div>
      )}
    </Modal>
  );
}

function VerifyDialog({ id, onClose }: { id: string; onClose(): void }) {
  const [text, setText] = useState<string>();
  useEffect(() => { void act('doc.verify', { doc: id }, { quiet: true }).then((r) => setText(r.results[0]?.message ?? '')).catch((e: Error) => setText(e.message)); }, [id]);
  return (
    <Modal open onClose={onClose} title="Verify" size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      {text === undefined ? <div className="flex items-center gap-2"><Spinner />Running every visual…</div> : <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-[12px]" data-bi-verify>{text}</pre>}
    </Modal>
  );
}

export { Textarea, FilterSpec };
