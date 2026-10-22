/**
 * The editor's side pane: a selected visual (type, fields, filters, options, formatting,
 * conditional formatting, interactions, tooltip page, phone layout) or, with nothing selected, the
 * page and the document (pages, drill-through fields, page and report filters). Each change is one op.
 */

import React, { useState } from 'react';
import { type CondFormat, type FilterSpec, type PageSpec, VISUAL_TYPES, type VisualOptions, type VisualSpec } from '@harness/plugin-ui';
import { Button, IconButton, Input, Select, Switch, Textarea, cx } from '@harness/ui';
import { act, type DocDetail, modelFields, useDataStore } from './api';
import { TYPE_LABEL } from './Doc';
import { ArrangeSection, SectionsEditor } from './LayoutUi';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="border-b border-hx-border-subtle px-3 py-2.5"><h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-hx-muted">{title}</h3><div className="space-y-1.5">{children}</div></section>
);
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex items-center gap-2 text-[12.5px]"><span className="w-24 shrink-0 text-hx-secondary">{label}</span><span className="min-w-0 flex-1">{children}</span></label>
);

/** A list of fields (or measures) with add and remove. */
function Picker({ label, values, options, onChange, testid }: { label: string; values: string[]; options: Array<{ value: string; label: string }>; onChange(v: string[]): void; testid: string }) {
  const [add, setAdd] = useState('');
  return (
    <div data-picker={testid}>
      <div className="mb-0.5 text-[12px] text-hx-secondary">{label}</div>
      {values.map((v, i) => (
        <div key={`${v}-${i}`} className="mb-0.5 flex items-center gap-1 rounded bg-hx-pill px-1.5 py-0.5 text-[12px]">
          <span className="min-w-0 flex-1 truncate">{v}</span>
          {i > 0 && <IconButton size="xs" icon="arrow-up" label="Move up" onClick={() => { const n = [...values]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; onChange(n); }} />}
          <IconButton size="xs" icon="x" label={`Remove ${v}`} onClick={() => onChange(values.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Select aria-label={`Add to ${label}`} value={add} onChange={(x) => { setAdd(''); if (x) onChange([...values, x]); }} options={[{ value: '', label: `+ add ${label.toLowerCase()}` }, ...options.filter((o) => !values.includes(o.value))]} />
    </div>
  );
}

export function Inspector({ docId, detail, v, onClose }: { docId: string; detail: DocDetail; v: VisualSpec; onClose(): void }): React.ReactElement {
  const catalog = useDataStore((s) => s.catalog);
  const fields = modelFields(catalog, detail.model).map((f) => ({ value: f.field, label: f.label }));
  const measures = (detail.model?.measures ?? []).map((m) => ({ value: m.name, label: m.name }));
  const page = detail.doc.pages.find((p) => p.visuals.some((x) => x.id === v.id))!;
  const patch = (p: Partial<VisualSpec> | Record<string, unknown>) => void act('doc.edit-visual', { doc: docId, visual: v.id, patch: p }).catch(() => {});
  const opt = (o: Partial<VisualOptions> | Record<string, unknown>) => patch({ options: o });
  const q = v.query ?? {};
  const msNames = (q.measures ?? []).map((m) => (typeof m === 'string' ? m : m.name));
  const o = v.options ?? {};
  const [newMeasure, setNewMeasure] = useState({ name: '', expr: '' });
  return (
    <div data-inspector-visual={v.id}>
      <div className="flex items-center gap-1 border-b border-hx-border-subtle px-3 py-2">
        <b className="min-w-0 flex-1 truncate text-[13px]">{v.title ?? TYPE_LABEL[v.type]}</b>
        <IconButton size="sm" icon="copy" label="Duplicate" onClick={() => void act('doc.duplicate', { doc: docId, visual: v.id }).catch(() => {})} />
        <IconButton size="sm" icon="trash" label="Remove the visual" onClick={() => { void act('doc.remove-visual', { doc: docId, visual: v.id }).catch(() => {}); onClose(); }} data-remove-visual />
        <IconButton size="sm" icon="x" label="Close" onClick={onClose} />
      </div>
      {[...(q.dims ?? []), ...(q.columns ?? []), ...(q.measures ?? []).map((m) => (typeof m === 'string' ? '' : m.expr ?? ''))].some((f) => /\bpinned_\d+\./.test(f)) && <BindSection docId={docId} detail={detail} v={v} fields={fields} />}
      <Section title="Visual">
        <Row label="Type"><Select aria-label="Visual type" value={v.type} onChange={(t) => patch({ type: t })} options={(VISUAL_TYPES as readonly string[]).map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t }))} data-inspector-type /></Row>
        <Row label="Title"><Input aria-label="Title" key={v.title} defaultValue={v.title ?? ''} onBlur={(e) => { if (e.target.value !== (v.title ?? '')) patch({ title: e.target.value || null }); }} /></Row>
        <Row label="Subtitle"><Input aria-label="Subtitle" key={v.subtitle} defaultValue={v.subtitle ?? ''} onBlur={(e) => { if (e.target.value !== (v.subtitle ?? '')) patch({ subtitle: e.target.value || null }); }} /></Row>
      </Section>
      {!['text', 'image', 'button', 'slicer', 'fence'].includes(v.type) && (
        <Section title="Data">
          {v.type === 'table' && <Picker label="Columns (detail rows)" testid="columns" values={q.columns ?? []} options={fields} onChange={(c) => patch({ query: { columns: c.length ? c : null } })} />}
          <Picker label="Dimensions" testid="dims" values={q.dims ?? []} options={fields} onChange={(d) => patch({ query: { dims: d } })} />
          <Picker label="Measures" testid="measures" values={msNames} options={measures} onChange={(m) => patch({ query: { measures: m.map((n) => (q.measures ?? []).find((x) => (typeof x === 'string' ? x : x.name) === n) ?? n) } })} />
          <div className="rounded border border-dashed border-hx-border p-1.5">
            <div className="mb-1 text-[11.5px] text-hx-muted">A measure for this visual only (an SQL aggregate over model fields)</div>
            <Input aria-label="New measure name" placeholder="Name" value={newMeasure.name} onChange={(e) => setNewMeasure({ ...newMeasure, name: e.target.value })} />
            <Input aria-label="New measure expression" placeholder="sum(orders.revenue)" className="mt-1" value={newMeasure.expr} onChange={(e) => setNewMeasure({ ...newMeasure, expr: e.target.value })} />
            <Button size="sm" className="mt-1" disabled={!newMeasure.name || !newMeasure.expr} onClick={() => { patch({ query: { measures: [...(q.measures ?? []), { name: newMeasure.name, expr: newMeasure.expr }] } }); setNewMeasure({ name: '', expr: '' }); }}>Add measure</Button>
          </div>
          <Row label="Top N"><Input aria-label="Limit rows" type="number" key={q.limit} defaultValue={q.limit ?? ''} placeholder="all" onBlur={(e) => patch({ query: { limit: e.target.value ? Number(e.target.value) : null } })} /></Row>
          <FiltersEditor filters={q.filters ?? []} fields={fields} measures={msNames} onChange={(f) => patch({ query: { filters: f } })} />
        </Section>
      )}
      <Section title="Options">
        {['bar', 'column', 'area', 'ribbon', 'combo'].includes(v.type) && <Row label="Stacking"><Select aria-label="Stacking" value={o.stack ?? 'clustered'} onChange={(s) => opt({ stack: s })} options={[{ value: 'clustered', label: 'Clustered' }, { value: 'stacked', label: 'Stacked' }, { value: 'percent', label: '100% stacked' }]} /></Row>}
        {['line', 'area', 'combo', 'ribbon'].includes(v.type) && <Switch checked={!!o.smooth} onChange={(x) => opt({ smooth: x })} label="Smooth lines" />}
        {['bar', 'column', 'line', 'area', 'combo', 'waterfall', 'pie', 'donut'].includes(v.type) && <Switch checked={!!o.labels} onChange={(x) => opt({ labels: x })} label="Data labels" />}
        {v.type === 'combo' && <Picker label="As lines (right axis)" testid="lines" values={o.lines ?? []} options={msNames.map((m) => ({ value: m, label: m }))} onChange={(l) => opt({ lines: l })} />}
        {['line', 'area', 'combo'].includes(v.type) && <>
          <Row label="Forecast"><Input aria-label="Forecast periods" type="number" key={o.forecast?.periods} defaultValue={o.forecast?.periods ?? ''} placeholder="periods" onBlur={(e) => opt({ forecast: e.target.value ? { periods: Number(e.target.value) } : null })} /></Row>
          <Switch checked={!!o.anomalies} onChange={(x) => opt({ anomalies: x })} label="Mark anomalies" />
        </>}
        {(v.type === 'kpi' || v.type === 'gauge') && <>
          <Row label="Target"><Select aria-label="Target" value={typeof o.target === 'string' ? o.target : ''} onChange={(t) => opt({ target: t || null })} options={[{ value: '', label: typeof o.target === 'number' ? `${o.target}` : 'None' }, ...measures]} /></Row>
          {v.type === 'kpi' && <Row label="Trend"><Select aria-label="Trend" value={o.trend ?? ''} onChange={(t) => opt({ trend: t || null })} options={[{ value: '', label: 'None' }, ...fields.filter((f) => f.value.includes(':'))]} /></Row>}
          {v.type === 'gauge' && <Row label="Maximum"><Input aria-label="Maximum" type="number" key={o.max} defaultValue={o.max ?? ''} onBlur={(e) => opt({ max: e.target.value ? Number(e.target.value) : null })} /></Row>}
        </>}
        {v.type === 'scatter' && <Row label="Play axis"><Select aria-label="Play axis" value={o.play ?? ''} onChange={(t) => opt({ play: t || null })} options={[{ value: '', label: 'None' }, ...fields.filter((f) => f.value.includes(':'))]} /></Row>}
        {v.type === 'matrix' && <>
          <Row label="Row fields"><Input aria-label="Row fields" type="number" min={1} key={o.rows} defaultValue={o.rows ?? 1} onBlur={(e) => opt({ rows: Number(e.target.value) || 1 })} /></Row>
          <Switch checked={o.stepped !== false} onChange={(x) => opt({ stepped: x })} label="Stepped (expand and collapse)" />
        </>}
        {(v.type === 'table' || v.type === 'matrix') && <Switch checked={o.subtotals !== false} onChange={(x) => opt({ subtotals: x })} label="Totals" />}
        {(v.type === 'decomp' || v.type === 'drivers') && <Picker label={v.type === 'decomp' ? 'Split by' : 'Factors'} testid="analysis-dims" values={o.dims ?? []} options={fields} onChange={(d) => opt({ dims: d })} />}
        {v.type === 'map' && <>
          <Row label="GeoJSON"><Select aria-label="GeoJSON source" value={o.geo?.source ?? ''} onChange={(s) => opt({ geo: { ...o.geo, source: s || undefined } })} options={[{ value: '', label: 'None (points only)' }, ...(catalog?.sources ?? []).filter((s) => /json$/i.test(s.path ?? '')).map((s) => ({ value: s.id, label: s.name }))]} /></Row>
          <Row label="Key property"><Input aria-label="Key property" key={o.geo?.key} defaultValue={o.geo?.key ?? 'name'} onBlur={(e) => opt({ geo: { ...o.geo, key: e.target.value } })} /></Row>
          <Row label="Latitude"><Select aria-label="Latitude" value={o.geo?.lat ?? ''} onChange={(s) => opt({ geo: { ...o.geo, lat: s || undefined } })} options={[{ value: '', label: 'None (filled map)' }, ...fields]} /></Row>
          <Row label="Longitude"><Select aria-label="Longitude" value={o.geo?.lon ?? ''} onChange={(s) => opt({ geo: { ...o.geo, lon: s || undefined } })} options={[{ value: '', label: 'None' }, ...fields]} /></Row>
        </>}
        {v.type === 'slicer' && <>
          <Row label="Field"><Select aria-label="Slicer field" value={o.slicer?.field ?? ''} onChange={(f) => opt({ slicer: { ...o.slicer, field: f } })} options={[{ value: '', label: 'Choose' }, ...fields]} /></Row>
          <Row label="Style"><Select aria-label="Slicer style" value={o.slicer?.style ?? 'list'} onChange={(s) => opt({ slicer: { ...o.slicer, style: s } })} options={['list', 'dropdown', 'buttons', 'range', 'relative'].map((x) => ({ value: x, label: x }))} /></Row>
          <Switch checked={o.slicer?.multi !== false} onChange={(x) => opt({ slicer: { ...o.slicer, multi: x } })} label="Several values" />
        </>}
        {v.type === 'text' && <Textarea aria-label="Text (Markdown)" rows={6} key={o.markdown} defaultValue={o.markdown ?? ''} onBlur={(e) => opt({ markdown: e.target.value })} />}
        {v.type === 'narrative' && <Textarea aria-label="Narrative" rows={5} key={o.text} defaultValue={o.text ?? ''} placeholder="Numbers as {{Measure}} or {{Measure[table.field=value]}}" onBlur={(e) => { if (e.target.value !== (o.text ?? '')) void act('doc.narrative', { doc: docId, visual: v.id, text: e.target.value }).catch(() => {}); }} />}
        {v.type === 'image' && <Row label="URL"><Input aria-label="Image URL" key={o.url} defaultValue={o.url ?? ''} onBlur={(e) => opt({ url: e.target.value })} /></Row>}
        {v.type === 'button' && <>
          <Row label="Label"><Input aria-label="Button label" key={o.button?.label} defaultValue={o.button?.label ?? ''} onBlur={(e) => opt({ button: { ...o.button, label: e.target.value } })} /></Row>
          <Row label="Action"><Select aria-label="Button action" value={o.button?.action ?? 'clear'} onChange={(a) => opt({ button: { ...o.button, label: o.button?.label ?? 'Go', action: a } })} options={['clear', 'back', 'page', 'bookmark', 'url'].map((x) => ({ value: x, label: x }))} /></Row>
          {(o.button?.action === 'page' || o.button?.action === 'bookmark') && <Row label="Target"><Select aria-label="Button target" value={o.button?.target ?? ''} onChange={(t) => opt({ button: { ...o.button, target: t } })} options={[{ value: '', label: 'Choose' }, ...(o.button.action === 'page' ? detail.doc.pages.map((p) => ({ value: p.id, label: p.name })) : (detail.doc.bookmarks ?? []).map((b) => ({ value: b.id, label: b.name })))]} /></Row>}
        </>}
        {v.type === 'fence' && <>
          <Row label="Renderer"><Input aria-label="Fence language" key={o.fence?.lang} defaultValue={o.fence?.lang ?? ''} placeholder="smiles, pdb, plot, dot, mermaid, diagram" onBlur={(e) => opt({ fence: { ...o.fence, lang: e.target.value } })} /></Row>
          <Textarea aria-label="Source" rows={5} key={o.fence?.source} defaultValue={o.fence?.source ?? ''} placeholder="Static source (empty: the query's rows as JSON)" onBlur={(e) => opt({ fence: { lang: o.fence?.lang ?? 'json', ...(e.target.value ? { source: e.target.value } : {}) } })} />
        </>}
        {detail.model?.hierarchies.length ? <Row label="Drill"><Select aria-label="Hierarchy" value={o.hierarchy ?? ''} onChange={(h) => opt({ hierarchy: h || null })} options={[{ value: '', label: 'No hierarchy' }, ...detail.model.hierarchies.map((h) => ({ value: h.name, label: h.name }))]} /></Row> : null}
        <Picker label="See records shows" testid="detail" values={o.detail ?? []} options={fields} onChange={(d) => opt({ detail: d })} />
      </Section>
      {!['text', 'image', 'button', 'slicer'].includes(v.type) && (
        <Section title="Formatting">
          {[...(q.dims ?? []), ...msNames].map((f) => (
            <Row key={f} label={f.split('.').pop()!}><Select aria-label={`Format of ${f}`} value={o.formats?.[f] ?? ''} onChange={(x) => opt({ formats: { ...o.formats, [f]: x || undefined } })} options={[{ value: '', label: 'Default' }, ...['currency:USD', 'currency:USD:0', 'currency:EUR', 'percent:1', 'percent:0', 'number:2', 'integer', 'compact', 'date:month', 'date:day'].map((x) => ({ value: x, label: x }))]} /></Row>
          ))}
          <CondEditor list={o.conditional ?? []} fields={msNames} onChange={(c) => opt({ conditional: c })} />
        </Section>
      )}
      <Section title="Interactions">
        <p className="text-[11.5px] text-hx-muted">When something is selected here, the other visuals on this page:</p>
        {page.visuals.filter((x) => x.id !== v.id).map((x) => (
          <Row key={x.id} label={(x.title ?? x.type).slice(0, 18)}><Select aria-label={`Interaction with ${x.title ?? x.id}`} value={v.interactions?.[x.id] ?? 'default'} onChange={(m) => void act('doc.interaction', { doc: docId, from: v.id, to: x.id, mode: m === 'default' ? 'filter' : m }).catch(() => {})} options={[{ value: 'default', label: 'Default' }, { value: 'filter', label: 'Filter' }, { value: 'highlight', label: 'Highlight' }, { value: 'none', label: 'None' }]} /></Row>
        ))}
        {detail.doc.pages.some((p) => p.kind === 'tooltip') && <Row label="Tooltip page"><Select aria-label="Tooltip page" value={v.tooltip ?? ''} onChange={(t) => patch({ tooltip: t || null })} options={[{ value: '', label: 'None' }, ...detail.doc.pages.filter((p) => p.kind === 'tooltip').map((p) => ({ value: p.id, label: p.name }))]} /></Row>}
      </Section>
      <ArrangeSection docId={docId} detail={detail} v={v} />
      <Section title="Layout">
        <div className="grid grid-cols-4 gap-1">{(['x', 'y', 'w', 'h'] as const).map((k) => <Input key={`${k}${v.layout[k]}`} aria-label={`Layout ${k}`} type="number" defaultValue={v.layout[k]} onBlur={(e) => { const n = Number(e.target.value); if (n !== v.layout[k]) void act(k === 'x' || k === 'y' ? 'layout.drag' : 'layout.resize', { doc: docId, visual: v.id, [k]: n }).catch(() => {}); }} />)}</div>
        <div className="text-[11.5px] text-hx-muted">Phone layout</div>
        <div className="grid grid-cols-2 gap-1">
          <Input aria-label="Phone order" type="number" placeholder="order" key={`o${v.mobile?.order}`} defaultValue={v.mobile?.order ?? ''} onBlur={(e) => void act('doc.drag', { doc: docId, visual: v.id, mobile: { order: e.target.value ? Number(e.target.value) : undefined } }).catch(() => {})} />
          <Input aria-label="Phone height" type="number" placeholder="height" key={`h${v.mobile?.h}`} defaultValue={v.mobile?.h ?? ''} onBlur={(e) => void act('doc.drag', { doc: docId, visual: v.id, mobile: { h: e.target.value ? Number(e.target.value) : undefined } }).catch(() => {})} />
        </div>
        <Switch checked={!!v.mobile?.hidden} onChange={(x) => void act('doc.drag', { doc: docId, visual: v.id, mobile: { hidden: x } }).catch(() => {})} label="Hide on phones" />
      </Section>
    </div>
  );
}

/** A pinned visual shows numbers a model typed: bind it to real data (one op, the whole query at once). */
function BindSection({ docId, detail, v, fields }: { docId: string; detail: DocDetail; v: VisualSpec; fields: Array<{ value: string; label: string }> }) {
  const plain = fields.filter((f) => !/^pinned_/.test(f.value));
  const [dim, setDim] = useState('');
  const [measure, setMeasure] = useState(detail.model?.measures[0]?.name ?? '');
  const [col, setCol] = useState('');
  const [agg, setAgg] = useState('sum');
  const bind = () => {
    const m = detail.model && measure ? measure : { name: v.title?.replace(/ by .*/i, '') || 'Value', expr: `${agg}(${col.replace(/^([^.]+)\.(.+)$/, '$1."$2"')})` };
    void act('doc.bind', { doc: docId, visual: v.id, query: { ...(dim ? { dims: [dim] } : {}), measures: [m] } }).catch(() => {});
  };
  return (
    <Section title="Bind to data">
      <p className="text-[11.5px] text-hx-warning">These numbers were typed by a model in a conversation. Bind the visual to a dataset or model so the engine computes them.</p>
      <Row label="By"><Select aria-label="Bind dimension" value={dim} onChange={setDim} options={[{ value: '', label: 'Nothing (one number)' }, ...plain]} data-bind-dim /></Row>
      {detail.model ? <Row label="Measure"><Select aria-label="Bind measure" value={measure} onChange={setMeasure} options={detail.model.measures.map((m) => ({ value: m.name, label: m.name }))} /></Row> : <>
        <Row label="Value"><Select aria-label="Bind value" value={col} onChange={setCol} options={[{ value: '', label: 'Column…' }, ...plain.filter((f) => !f.value.includes(':'))]} data-bind-value /></Row>
        <Row label="As"><Select aria-label="Bind aggregation" value={agg} onChange={setAgg} options={['sum', 'avg', 'count', 'min', 'max', 'median'].map((x) => ({ value: x, label: x }))} /></Row>
      </>}
      <Button size="sm" variant="primary" disabled={!detail.model && !col} onClick={bind} data-bind-go>Bind</Button>
    </Section>
  );
}

export function FiltersEditor({ filters, fields, measures = [], onChange }: { filters: FilterSpec[]; fields: Array<{ value: string; label: string }>; measures?: string[]; onChange(f: FilterSpec[]): void }) {
  const [field, setField] = useState('');
  const [op, setOp] = useState<FilterSpec['op']>('in');
  const [value, setValue] = useState('');
  const parse = (x: string) => (x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : x.trim());
  const add = () => {
    if (!field) return;
    const vals = value.split(',').map((x) => x.trim()).filter(Boolean).map(parse);
    const f: FilterSpec = op === 'in' || op === 'not_in' ? { field, op, values: vals } : op === 'between' ? { field, op, value: vals[0] ?? null, to: vals[1] ?? null } : op === 'relative' ? { field, op, n: Number(vals[0] ?? 1), unit: (String(vals[1] ?? 'month') as 'month'), current: true } : op === 'top' || op === 'bottom' ? { field, op, n: Number(vals[0] ?? 10), by: String(vals[1] ?? measures[0] ?? '') } : { field, op, value: vals[0] ?? null };
    onChange([...filters, f]); setValue('');
  };
  return (
    <div data-filters-editor>
      <div className="mb-0.5 text-[12px] text-hx-secondary">Filters</div>
      {filters.map((f, i) => <div key={i} className="mb-0.5 flex items-center gap-1 rounded bg-hx-pill px-1.5 py-0.5 text-[12px]"><span className="min-w-0 flex-1 truncate">{f.field} {f.op} {JSON.stringify(f.values ?? f.value ?? [f.n, f.unit ?? f.by].filter(Boolean))}</span><IconButton size="xs" icon="x" label="Remove the filter" onClick={() => onChange(filters.filter((_, j) => j !== i))} /></div>)}
      <div className="grid grid-cols-2 gap-1">
        <Select aria-label="Filter field" value={field} onChange={setField} options={[{ value: '', label: 'Field…' }, ...fields, ...measures.map((m) => ({ value: m, label: `${m} (measure)` }))]} />
        <Select aria-label="Filter operator" value={op} onChange={(x) => setOp(x as FilterSpec['op'])} options={['in', 'not_in', 'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'contains', 'relative', 'top', 'bottom', 'is_null', 'not_null'].map((x) => ({ value: x, label: x }))} />
      </div>
      <div className="mt-1 flex gap-1"><Input aria-label="Filter value" value={value} onChange={(e) => setValue(e.target.value)} placeholder={op === 'relative' ? '12, month' : op === 'top' ? '5, Revenue' : op === 'between' ? 'from, to' : 'values, comma separated'} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} /><Button size="sm" onClick={add} disabled={!field}>Add</Button></div>
    </div>
  );
}

function CondEditor({ list, fields, onChange }: { list: CondFormat[]; fields: string[]; onChange(c: CondFormat[]): void }) {
  const [field, setField] = useState('');
  const [kind, setKind] = useState<CondFormat['kind']>('scale');
  const [rule, setRule] = useState('');
  return (
    <div data-conditional-editor>
      <div className="mb-0.5 text-[12px] text-hx-secondary">Conditional formatting</div>
      {list.map((c, i) => <div key={i} className="mb-0.5 flex items-center gap-1 rounded bg-hx-pill px-1.5 py-0.5 text-[12px]"><span className="flex-1">{c.field}: {c.kind}{c.rules?.length ? ` (${c.rules.map((r) => `${r.op} ${r.value} ${r.color ?? r.icon ?? ''}`).join('; ')})` : ''}</span><IconButton size="xs" icon="x" label="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))} /></div>)}
      <div className="grid grid-cols-2 gap-1">
        <Select aria-label="Conditional field" value={field} onChange={setField} options={[{ value: '', label: 'Field…' }, ...fields.map((f) => ({ value: f, label: f }))]} />
        <Select aria-label="Conditional kind" value={kind} onChange={(k) => setKind(k as CondFormat['kind'])} options={[{ value: 'scale', label: 'Colour scale' }, { value: 'bars', label: 'Data bars' }, { value: 'icons', label: 'Icons' }, { value: 'rules', label: 'Rules' }]} />
      </div>
      {kind === 'rules' && <Input className="mt-1" aria-label="Rule" value={rule} onChange={(e) => setRule(e.target.value)} placeholder="lt 1000 #c43030" />}
      <Button size="sm" className={cx('mt-1')} disabled={!field} onClick={() => {
        const [op, val, color] = rule.trim().split(/\s+/);
        onChange([...list, { field, kind, ...(kind === 'rules' && op ? { rules: [{ op: op as 'lt', value: Number(val), color: color ?? '#c43030' }] } : {}) }]);
        setRule('');
      }}>Add formatting</Button>
    </div>
  );
}

/** With nothing selected: the page (name, kind, drill-through fields, its filters), the report's filters and the pages. */
export function PageInspector({ docId, detail, page }: { docId: string; detail: DocDetail; page: PageSpec }): React.ReactElement {
  const catalog = useDataStore((s) => s.catalog);
  const fields = modelFields(catalog, detail.model).map((f) => ({ value: f.field, label: f.label }));
  const [newPage, setNewPage] = useState('');
  return (
    <div data-inspector-page={page.id}>
      <Section title="Page">
        <Row label="Name"><Input aria-label="Page name" key={page.name} defaultValue={page.name} onBlur={(e) => { if (e.target.value && e.target.value !== page.name) void act('doc.rename-page', { doc: docId, page: page.id, patch: { name: e.target.value } }).catch(() => {}); }} /></Row>
        <Row label="Kind"><Select aria-label="Page kind" value={page.kind ?? 'page'} onChange={(k) => void act('doc.rename-page', { doc: docId, page: page.id, patch: { kind: k === 'page' ? null : k, ...(k === 'drillthrough' && !page.drillFields?.length && fields[0] ? { drillFields: [fields[0].value] } : {}) } }).catch(() => {})} options={[{ value: 'page', label: 'Page' }, { value: 'drillthrough', label: 'Drill-through target' }, { value: 'tooltip', label: 'Tooltip' }]} /></Row>
        {page.kind === 'drillthrough' && <Picker label="Drill-through fields" testid="drill-fields" values={page.drillFields ?? []} options={fields} onChange={(d) => void act('doc.rename-page', { doc: docId, page: page.id, patch: { drillFields: d } }).catch(() => {})} />}
        <FiltersEditor filters={page.filters ?? []} fields={fields} onChange={(f) => void act('doc.rename-page', { doc: docId, page: page.id, patch: { filters: f } }).catch(() => {})} />
        <SectionsEditor docId={docId} page={page} />
        {detail.doc.pages.length > 1 && <Button size="sm" variant="danger" onClick={() => void act('doc.remove-page', { doc: docId, page: page.id }).catch(() => {})}>Remove this page</Button>}
      </Section>
      <Section title="Pages">
        {detail.doc.pages.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1 text-[12.5px]"><span className="min-w-0 flex-1 truncate">{p.name}{p.kind ? ` (${p.kind})` : ''}</span>{i > 0 && <IconButton size="xs" icon="arrow-up" label={`Move ${p.name} up`} onClick={() => void act('doc.move-page', { doc: docId, page: p.id, to: i - 1 }).catch(() => {})} />}</div>
        ))}
        <div className="flex gap-1"><Input aria-label="New page name" value={newPage} onChange={(e) => setNewPage(e.target.value)} placeholder="New page" /><Button size="sm" disabled={!newPage.trim()} onClick={() => { void act('doc.add-page', { doc: docId, page: { name: newPage.trim() } }).catch(() => {}); setNewPage(''); }} data-add-page>Add</Button></div>
      </Section>
      <Section title={detail.doc.type === 'report' ? 'Report filters' : 'Dashboard filters'}>
        <FiltersEditor filters={detail.doc.filters ?? []} fields={fields} onChange={(f) => {
          const cur = detail.doc.filters ?? [];
          const removed = cur.filter((x) => !f.includes(x));
          const added = f.filter((x) => !cur.includes(x));
          for (const r of removed) void act('doc.clear-filter', { doc: docId, scope: 'doc', field: r.field }).catch(() => {});
          for (const a of added) void act('doc.filter', { doc: docId, scope: 'doc', filter: a }).catch(() => {});
        }} />
      </Section>
      {detail.doc.type === 'report' && (
        <Section title="Print">
          <Row label="Header"><Input aria-label="Header" key={detail.doc.header} defaultValue={detail.doc.header ?? ''} onBlur={(e) => void act('doc.rename', { doc: docId, patch: { header: e.target.value } }).catch(() => {})} /></Row>
          <Row label="Footer"><Input aria-label="Footer" key={detail.doc.footer} defaultValue={detail.doc.footer ?? ''} onBlur={(e) => void act('doc.rename', { doc: docId, patch: { footer: e.target.value } }).catch(() => {})} /></Row>
        </Section>
      )}
      <Section title="Model">
        <Row label="Model"><Select aria-label="Model" value={detail.doc.model ?? ''} onChange={(m) => void act('doc.rename', { doc: docId, patch: { model: m || null } }).catch(() => {})} options={[{ value: '', label: 'No model (datasets)' }, ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.name }))]} /></Row>
      </Section>
    </div>
  );
}
