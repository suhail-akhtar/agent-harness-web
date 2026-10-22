/** The Dashboards and Reports pages: what there is, how much it is used, whether it is published; create one. */

import React, { useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Field, Icon, Input, Modal, Select, cx } from '@harness/ui';
import { navigate } from '../../state/app';
import { act, useDataStore } from './api';

export function Library({ params }: { params: Record<string, string> }): React.ReactElement {
  const type = params.type === 'report' ? 'report' : 'dashboard';
  const docs = useDataStore((s) => s.docs);
  const catalog = useDataStore((s) => s.catalog);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  useEffect(() => { void useDataStore.getState().refreshDocs(); void useDataStore.getState().refreshCatalog(); }, []);
  const list = (docs ?? []).filter((d) => d.type === type && (!q || d.title.toLowerCase().includes(q.toLowerCase())));
  const noun = type === 'report' ? 'report' : 'dashboard';
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-bi-library={type}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <h1 className="flex-1 text-[20px] font-semibold">{type === 'report' ? 'Reports' : 'Dashboards'}</h1>
          <Input icon="search" placeholder={`Search ${noun}s`} value={q} onChange={(e) => setQ(e.target.value)} className="w-56" aria-label={`Search ${noun}s`} />
          <Button variant="secondary" icon="database" onClick={() => navigate({ view: 'core.dashboards:data' })}>Data</Button>
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)} data-new-doc>New {noun}</Button>
        </div>
        {docs === null ? <p className="text-hx-muted">Loading…</p> : !list.length ? (
          <EmptyState icon={type === 'report' ? 'file-text' : 'chart'} title={q ? 'Nothing matches' : `No ${noun}s yet`} action={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>New {noun}</Button>}>
            {type === 'report' ? 'A report is a document with live numbers: prose and visuals, refreshed and frozen in a snapshot, printed with page headers.' : 'Add data on the Data page, then build a dashboard here; or ask the agent ("build a sales dashboard from sales.xlsx") and pin charts from any conversation.'}
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((d) => (
              <button key={d.id} type="button" data-doc-card={d.id} onClick={() => navigate({ view: 'core.dashboards:doc', params: { id: d.id } })} className="flex flex-col gap-2 rounded-xl border border-hx-border-subtle bg-hx-elevated p-4 text-left hover:border-hx-border">
                <div className="flex items-start gap-2"><Icon name={d.type === 'report' ? 'file-text' : 'chart'} size={18} className="mt-0.5 text-hx-accent-text" /><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{d.title}</span>{d.published && <Badge tone="accent">Published</Badge>}</div>
                <div className="text-[12px] text-hx-muted">{d.pages} page{d.pages === 1 ? '' : 's'} · {d.visuals} visual{d.visuals === 1 ? '' : 's'}{d.model ? ` · model ${d.model}` : ''}</div>
                <div className="flex items-center gap-2 text-[11.5px] text-hx-muted"><span>v{d.version}</span><span>· {new Date(d.updatedAt).toLocaleString()}</span><span className="ml-auto" title="Views (app and published)"><Icon name="eye" size={12} className="mr-0.5 inline" />{d.views}</span>{d.refresh !== 'manual' && <span title="Refreshes on its own"><Icon name="refresh" size={12} className="inline" /></span>}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      <NewDoc open={creating} type={type} models={catalog?.models.map((m) => ({ value: m.id, label: m.name })) ?? []} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewDoc({ open, type, models, onClose }: { open: boolean; type: 'dashboard' | 'report'; models: Array<{ value: string; label: string }>; onClose(): void }) {
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setTitle(''); setModel(models[0]?.value ?? ''); } }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const r = await act('doc.new', { doc: { type, title: title.trim() || (type === 'report' ? 'Untitled report' : 'Untitled dashboard'), ...(model ? { model } : {}) } });
      onClose();
      const id = r.results[0]?.data?.id;
      if (id) navigate({ view: 'core.dashboards:doc', params: { id, edit: '1' } });
    } catch { /* toasted */ } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`New ${type}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void create()} data-create-doc>Create</Button></>}>
      <div className="space-y-3">
        <Field label="Title" htmlFor="bi-new-title"><Input id="bi-new-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} placeholder={type === 'report' ? 'Monthly sales report' : 'Sales overview'} /></Field>
        <Field label="Model" help={models.length ? 'Its measures and relationships give the numbers. Without one, each dataset is a table.' : 'No model yet: visuals read datasets directly (make a model on the Data page for measures and relationships).'}>
          <Select value={model} onChange={setModel} options={[{ value: '', label: 'No model (datasets)' }, ...models]} className={cx(!models.length && 'opacity-60')} />
        </Field>
      </div>
    </Modal>
  );
}
