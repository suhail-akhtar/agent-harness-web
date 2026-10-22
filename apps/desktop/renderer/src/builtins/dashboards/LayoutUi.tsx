/** Layout controls: the layout type and its options, templates for purposes, sections and tabs, canvas arrangement. All ops. */

import React, { useEffect, useState } from 'react';
import { LAYOUT_TYPES, type LayoutSpec, type PageSpec, type TemplateSpec, type VisualSpec } from '@harness/plugin-ui';
import { Button, Field, Icon, IconButton, Input, Modal, Select, Spinner, Switch, cx } from '@harness/ui';
import { navigate } from '../../state/app';
import { act, type DocDetail, useDataStore } from './api';

export const LAYOUT_LABEL: Record<string, string> = { grid: 'Grid', canvas: 'Free-form canvas', sections: 'Sections', tabs: 'Tabs', sidebar: 'Sidebar and content', masonry: 'Masonry (cards by height)', story: 'Story (one column)', tv: 'TV / kiosk', print: 'Print (paper pages)' };
const LAYOUT_HELP: Record<string, string> = { grid: 'Responsive columns that snap; wide, medium and phone arrangements.', canvas: 'Free positions, layers, guides, groups and locks.', sections: 'Collapsible bands, each a grid; for long pages.', tabs: 'Tabbed panels in one page.', sidebar: 'Filters in a fixed column beside the content.', masonry: 'Cards flow by height: a KPI wall.', story: 'A narrative top to bottom, full width.', tv: 'Full screen, 16:9 or 21:9, large type, pages rotating.', print: 'A4 or Letter pages with headers, footers and page breaks.' };

export function LayoutDialog({ id, page, onClose }: { id: string; page: PageSpec; onClose(): void }): React.ReactElement {
  const cur: LayoutSpec = page.layout ?? { type: 'grid' };
  const [l, setL] = useState<LayoutSpec>(cur);
  const set = (patch: Partial<LayoutSpec>) => setL({ ...l, ...patch });
  const save = () => void act(l.type !== cur.type ? 'layout.type' : 'layout.options', { doc: id, page: page.id, layout: l }).then(onClose).catch(() => {});
  return (
    <Modal open onClose={onClose} title={`Layout of "${page.name}"`} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} data-save-layout>Apply</Button></>}>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Layout type">
        {LAYOUT_TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={l.type === t} data-layout-type={t} onClick={() => setL({ ...(t === cur.type ? cur : {}), type: t })} className={cx('rounded-lg border p-2 text-left', l.type === t ? 'border-hx-accent bg-hx-accent-soft' : 'border-hx-border hover:bg-hx-hover')}>
            <div className="text-[13px] font-medium">{LAYOUT_LABEL[t]}</div><div className="text-[11.5px] text-hx-muted">{LAYOUT_HELP[t]}</div>
          </button>
        ))}
      </div>
      {l.type !== cur.type && <p className="mt-2 text-[12px] text-hx-secondary">Every widget is kept and re-arranged for the new layout; Undo brings the old one back.</p>}
      <div className="mt-2 grid gap-x-4 sm:grid-cols-2">
        {['grid', 'sections', 'tabs', 'sidebar'].includes(l.type) && <Field label="Columns"><Input type="number" min={2} max={24} value={l.columns ?? 12} onChange={(e) => set({ columns: Number(e.target.value) || 12 })} /></Field>}
        {l.type === 'grid' && <Field label="Auto-pack"><Select value={l.compact ?? 'none'} onChange={(v) => set({ compact: v as 'up' })} options={[{ value: 'none', label: 'Off' }, { value: 'up', label: 'Pack up' }, { value: 'left', label: 'Pack left' }]} /></Field>}
        {['grid', 'canvas'].includes(l.type) && <Field label="Width"><div className="flex items-center gap-2"><Switch checked={l.responsive !== false} onChange={(v) => set({ responsive: v })} label="Responsive" />{l.responsive === false && <Input type="number" value={l.width ?? 1200} onChange={(e) => set({ width: Number(e.target.value) })} aria-label="Fixed width" />}</div></Field>}
        {l.type === 'canvas' && <Field label="Snap (px)"><Input type="number" value={l.snap ?? 8} onChange={(e) => set({ snap: Number(e.target.value) || 8 })} /></Field>}
        {l.type === 'sidebar' && <Field label="Sidebar"><div className="flex gap-1"><Select value={l.sidebar?.side ?? 'left'} onChange={(v) => set({ sidebar: { ...l.sidebar, side: v as 'left' } })} options={[{ value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} /><Input type="number" value={l.sidebar?.width ?? 260} onChange={(e) => set({ sidebar: { ...l.sidebar, width: Number(e.target.value) } })} aria-label="Sidebar width" /></div></Field>}
        {l.type === 'masonry' && <Field label="Card width (px)"><Input type="number" value={l.cardWidth ?? 320} onChange={(e) => set({ cardWidth: Number(e.target.value) })} /></Field>}
        {l.type === 'tv' && <>
          <Field label="Screen"><Select value={l.aspect ?? '16:9'} onChange={(v) => set({ aspect: v as '16:9' })} options={[{ value: '16:9', label: '16:9' }, { value: '21:9', label: '21:9' }]} /></Field>
          <Field label="Seconds per page (0: no rotation)"><Input type="number" min={0} value={l.rotate ?? 30} onChange={(e) => set({ rotate: Number(e.target.value) })} data-tv-rotate /></Field>
          <Field label="Type size"><Input type="number" step={0.05} value={l.scale ?? 1.25} onChange={(e) => set({ scale: Number(e.target.value) })} /></Field>
        </>}
        {l.type === 'print' && <>
          <Field label="Paper"><Select value={l.paper ?? 'A4'} onChange={(v) => set({ paper: v as 'A4' })} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} /></Field>
          <Field label="Orientation"><Select value={l.orientation ?? 'landscape'} onChange={(v) => set({ orientation: v as 'landscape' })} options={[{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' }]} /></Field>
          <Field label="Margins (mm)"><Input type="number" value={l.margins ?? 12} onChange={(e) => set({ margins: Number(e.target.value) })} /></Field>
        </>}
      </div>
    </Modal>
  );
}

/** Templates for purposes (and a blank page of each layout), filled from a model's measures and fields. */
export function TemplateDialog({ doc, onClose }: { doc?: DocDetail; onClose(): void }): React.ReactElement {
  const catalog = useDataStore((s) => s.catalog);
  const [list, setList] = useState<TemplateSpec[]>();
  const [pick, setPick] = useState('executive');
  const [model, setModel] = useState(doc?.doc.model ?? catalog?.models[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void act('layout.templates', {}, { quiet: true }).then((r) => setList(r.results[0]?.data as unknown as TemplateSpec[])).catch(() => setList([])); if (!catalog) void useDataStore.getState().refreshCatalog(); }, []);
  const t = list?.find((x) => x.id === pick);
  const apply = async () => {
    setBusy(true);
    try {
      const r = await act('layout.template', { template: pick, ...(doc ? { doc: doc.id } : { title: title || t?.title }), ...(model ? { model } : {}) });
      const out = r.results[0]?.data as { id?: string; skipped?: string[] } | undefined;
      onClose();
      if (!doc && out?.id) navigate({ view: 'core.dashboards:doc', params: { id: out.id } });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={doc ? 'Add a page from a template' : 'New from a template'} size="xl" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void apply()} disabled={!t} data-apply-template>{doc ? 'Add the page' : 'Create'}</Button></>}>
      {!list ? <Spinner /> : (
        <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
          <div className="grid max-h-[55vh] gap-2 overflow-auto sm:grid-cols-2" role="radiogroup" aria-label="Templates">
            {list.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={pick === x.id} data-template={x.id} onClick={() => setPick(x.id)} className={cx('rounded-lg border p-2 text-left', pick === x.id ? 'border-hx-accent bg-hx-accent-soft' : 'border-hx-border hover:bg-hx-hover')}>
                <div className="flex items-center gap-1 text-[13px] font-medium"><Icon name={x.id.startsWith('blank') ? 'grid' : 'chart'} size={13} />{x.title}{x.plugin && <span className="text-[11px] text-hx-muted">({x.plugin})</span>}</div>
                <div className="text-[11.5px] text-hx-muted">{x.purpose}</div>
                <div className="mt-1 text-[11px] text-hx-secondary">{x.pages.map((p) => `${LAYOUT_LABEL[p.layout?.type ?? 'grid']} · ${p.visuals.length} widgets`).join('; ')}</div>
              </button>
            ))}
          </div>
          <div className="space-y-2">
            {t && <p className="text-[12.5px] text-hx-secondary">{t.description}</p>}
            {!doc && <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t?.title} /></Field>}
            <Field label="Model" help="Its measures, date and fields fill the template; a widget with nothing to fill is left out and named."><Select value={model} onChange={setModel} options={[{ value: '', label: 'None (blank templates only)' }, ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.name }))]} /></Field>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The inspector's arrangement section: section or tab, canvas layers, lock, group and alignment. */
export function ArrangeSection({ docId, detail, v }: { docId: string; detail: DocDetail; v: VisualSpec }): React.ReactElement | null {
  const page = detail.doc.pages.find((p) => p.visuals.some((x) => x.id === v.id))!;
  const type = page.layout?.type ?? 'grid';
  const [other, setOther] = useState('');
  const [group, setGroup] = useState(v.group ?? '');
  if (!['sections', 'tabs', 'sidebar', 'canvas'].includes(type)) return null;
  return (
    <section className="border-b border-hx-border-subtle px-3 py-2.5" data-arrange>
      <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-hx-muted">Arrange</h3>
      {(type === 'sections' || type === 'tabs') && <label className="flex items-center gap-2 text-[12.5px]"><span className="w-24 text-hx-secondary">{type === 'tabs' ? 'Tab' : 'Section'}</span><Select aria-label="Section" value={v.section ?? page.layout?.sections?.[0]?.id ?? ''} onChange={(s) => void act('layout.drag', { doc: docId, visual: v.id, section: s }).catch(() => {})} options={(page.layout?.sections ?? []).map((s) => ({ value: s.id, label: s.title }))} /></label>}
      {type === 'sidebar' && <Switch checked={v.section === 'sidebar'} onChange={(on) => void act('layout.drag', { doc: docId, visual: v.id, section: on ? 'sidebar' : null }).catch(() => {})} label="In the sidebar" />}
      {type === 'canvas' && <div className="space-y-1.5">
        <div className="flex gap-1"><Button size="sm" onClick={() => void act('layout.front', { doc: docId, visual: v.id, z: 'front' }).catch(() => {})} data-bring-front>Bring to front</Button><Button size="sm" onClick={() => void act('layout.back', { doc: docId, visual: v.id, z: 'back' }).catch(() => {})}>Send to back</Button></div>
        <Switch checked={!!v.locked} onChange={(on) => void act('layout.lock', { doc: docId, visual: v.id, lock: on }).catch(() => {})} label="Locked" />
        <div className="flex gap-1"><Input aria-label="Group" placeholder="group name" value={group} onChange={(e) => setGroup(e.target.value)} /><Button size="sm" onClick={() => void act('layout.group', { doc: docId, visual: v.id, group }).catch(() => {})}>Group</Button></div>
        <div className="flex gap-1"><Select aria-label="Align with" value={other} onChange={setOther} options={[{ value: '', label: 'Align with…' }, ...page.visuals.filter((x) => x.id !== v.id).map((x) => ({ value: x.id, label: x.title ?? x.type }))]} />
          {other && ['left', 'top', 'hcenter', 'size'].map((e) => <IconButton key={e} size="sm" icon={{ left: 'arrow-left', top: 'arrow-up', hcenter: 'split', size: 'expand' }[e]!} label={`Align ${e}`} onClick={() => void act('layout.align', { doc: docId, visuals: [other, v.id], edge: e }).catch(() => {})} />)}
        </div>
      </div>}
    </section>
  );
}

/** Sections and tabs of a page: add, rename, collapse, reorder, remove. */
export function SectionsEditor({ docId, page }: { docId: string; page: PageSpec }): React.ReactElement | null {
  const [title, setTitle] = useState('');
  if (!['sections', 'tabs'].includes(page.layout?.type ?? '')) return null;
  const list = page.layout?.sections ?? [];
  return (
    <div className="space-y-1" data-sections-editor>
      {list.map((s, i) => (
        <div key={s.id} className="flex items-center gap-1 text-[12.5px]">
          <Input aria-label="Section title" key={s.title} defaultValue={s.title} onBlur={(e) => { if (e.target.value && e.target.value !== s.title) void act('layout.edit-section', { doc: docId, page: page.id, section: s.id, patch: { title: e.target.value } }).catch(() => {}); }} />
          {i > 0 && <IconButton size="xs" icon="arrow-up" label="Move up" onClick={() => void act('layout.edit-section', { doc: docId, page: page.id, section: s.id, patch: { to: i - 1 } }).catch(() => {})} />}
          {list.length > 1 && <IconButton size="xs" icon="x" label="Remove" onClick={() => void act('layout.remove-section', { doc: docId, page: page.id, section: s.id }).catch(() => {})} />}
        </div>
      ))}
      <div className="flex gap-1"><Input aria-label="New section" placeholder={page.layout?.type === 'tabs' ? 'New tab' : 'New section'} value={title} onChange={(e) => setTitle(e.target.value)} /><Button size="sm" disabled={!title.trim()} onClick={() => { void act('layout.add-section', { doc: docId, page: page.id, section: { title: title.trim() } }).catch(() => {}); setTitle(''); }}>Add</Button></div>
    </div>
  );
}
