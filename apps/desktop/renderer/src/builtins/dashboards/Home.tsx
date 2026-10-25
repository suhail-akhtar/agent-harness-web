/**
 * The Dashboards home (core.dashboards:home): the main entry to data, dashboards and reports.
 * Recent dashboards and reports, the datasets with their state, the sources, the templates, and the
 * ways to start (a new dashboard, one from a template, data to add, a question for the agent).
 */

import React, { useEffect, useState } from 'react';
import { BUILTIN_TEMPLATES } from '@harness/plugin-ui';
import { Badge, Button, Icon, Page } from '@harness/ui';
import { useData } from '../../state/data';
import { navigate, prefill } from '../../state/app';
import { HomeSection, ModuleHeader } from '../plugin-home';
import { homeModel } from '../../registry/modules';
import { useDataStore } from './api';
import { TemplateDialog } from './LayoutUi';

function Kpi({ label, value, onClick, id }: { label: string; value: React.ReactNode; onClick?: () => void; id: string }) {
  return (
    <button type="button" data-kpi={id} onClick={onClick} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-3.5 text-left hover:border-hx-border">
      <b className="block text-[24px] font-semibold leading-tight tracking-tight">{value}</b>
      <span className="text-[12px] text-hx-muted">{label}</span>
    </button>
  );
}

export function DashboardsHome(): React.ReactElement {
  const registry = useData((s) => s.registry);
  const docs = useDataStore((s) => s.docs);
  const catalog = useDataStore((s) => s.catalog);
  const [templating, setTemplating] = useState(false);
  useEffect(() => { void useDataStore.getState().refreshDocs(); void useDataStore.getState().refreshCatalog(); }, []);
  const m = homeModel(registry, 'core.dashboards');
  if (!m) return <div />;
  const recent = [...(docs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const dashboards = (docs ?? []).filter((d) => d.type === 'dashboard').length;
  const reports = (docs ?? []).filter((d) => d.type === 'report').length;
  const templates = [...BUILTIN_TEMPLATES.map((t) => ({ id: t.id, title: t.title, purpose: t.purpose })), ...registry.dashboardTemplates.map((t) => ({ id: t.qid, title: t.title, purpose: t.purpose ?? t.description ?? '' }))];
  const data = (tab: string, extra: Record<string, string> = {}) => () => navigate({ view: 'core.dashboards:data', params: { tab, ...extra } });
  return (
    <Page data-module-home="core.dashboards" width="wide">
        <ModuleHeader model={m}>
          <Button size="sm" icon="apps" onClick={() => setTemplating(true)} data-home-template>From a template</Button>
          <Button size="sm" icon="database" onClick={data('sources')} data-home-add-data>Add data</Button>
        </ModuleHeader>
        <div className="mb-7 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Kpi id="dashboards" label="dashboards" value={docs ? dashboards : '…'} onClick={() => navigate({ view: 'core.dashboards:dashboards' })} />
          <Kpi id="reports" label="reports" value={docs ? reports : '…'} onClick={() => navigate({ view: 'core.dashboards:reports' })} />
          <Kpi id="datasets" label="datasets" value={catalog ? catalog.datasets.length : '…'} onClick={data('datasets')} />
          <Kpi id="sources" label="sources" value={catalog ? catalog.sources.length : '…'} onClick={data('sources')} />
          <Kpi id="published" label="published as live pages" value={docs ? docs.filter((d) => d.published).length : '…'} onClick={() => navigate({ view: 'core.dashboards:dashboards' })} />
        </div>
        <HomeSection title="Recent dashboards and reports" id="recent" action={<Button size="sm" variant="ghost" icon="chart" onClick={() => navigate({ view: 'core.dashboards:dashboards' })}>All dashboards</Button>}>
          {!recent.length ? (
            <div className="rounded-xl border border-dashed border-hx-border-subtle p-5 text-[13px] text-hx-muted" data-empty>
              No dashboards yet. Add a file or a database on <button type="button" className="text-hx-accent-text hover:underline" onClick={data('sources')}>Data</button>, start from a template, or ask the agent: "build me a dashboard from sales.csv".
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {recent.map((d) => (
                <button key={d.id} type="button" data-home-doc={d.id} onClick={() => navigate({ view: 'core.dashboards:doc', params: { id: d.id } })} className="flex flex-col gap-1.5 rounded-xl border border-hx-border-subtle bg-hx-elevated p-4 text-left hover:border-hx-border">
                  <span className="flex items-start gap-2"><Icon name={d.type === 'report' ? 'file-text' : 'chart'} size={17} className="mt-0.5 text-hx-accent-text" /><span className="min-w-0 flex-1 truncate text-[14px] font-medium">{d.title}</span>{d.published && <Badge tone="accent">Published</Badge>}</span>
                  <span className="text-[12px] text-hx-muted">{d.pages} page{d.pages === 1 ? '' : 's'} · {d.visuals} visual{d.visuals === 1 ? '' : 's'} · v{d.version} · {new Date(d.updatedAt).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          )}
        </HomeSection>
        <div className="grid gap-6 md:grid-cols-2">
          <HomeSection title="Datasets" id="datasets" action={<Button size="sm" variant="ghost" icon="table" onClick={data('datasets')}>Data</Button>}>
            {!catalog?.datasets.length ? <p className="text-[13px] text-hx-muted">No datasets yet: a dataset is a query over a source, cleaned and typed.</p> : (
              <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
                {catalog.datasets.slice(0, 8).map((d) => (
                  <button key={d.id} type="button" data-home-dataset={d.id} onClick={data('datasets', { dataset: d.id })} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-hx-hover">
                    <Icon name="table" size={14} className="text-hx-muted" /><span className="min-w-0 flex-1 truncate">{d.name}</span>
                    {d.state.error ? <Badge tone="danger">error</Badge> : <span className="text-[11.5px] text-hx-muted">{d.state.rows ?? 0} rows{d.state.at ? ` · ${new Date(d.state.at).toLocaleDateString()}` : ''}</span>}
                  </button>
                ))}
              </div>
            )}
          </HomeSection>
          <HomeSection title="Sources" id="sources" action={<Button size="sm" variant="ghost" icon="plus" onClick={data('sources')}>Add</Button>}>
            {!catalog?.sources.length ? <p className="text-[13px] text-hx-muted">No sources yet: files (CSV, Excel, JSON, logs), databases (Postgres, MySQL, SQLite, SQL Server, MongoDB) and APIs.</p> : (
              <div className="divide-y divide-hx-border-subtle rounded-xl border border-hx-border-subtle">
                {catalog.sources.slice(0, 8).map((s) => (
                  <button key={s.id} type="button" data-home-source={s.id} onClick={data('sources')} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-hx-hover">
                    <Icon name={s.type === 'file' ? 'file' : s.type === 'http' ? 'globe' : 'database'} size={14} className="text-hx-muted" /><span className="min-w-0 flex-1 truncate">{s.name}</span><Badge>{s.type}</Badge>
                  </button>
                ))}
              </div>
            )}
          </HomeSection>
        </div>
        <HomeSection title="Templates" id="templates">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <button key={t.id} type="button" data-home-template-card={t.id} onClick={() => setTemplating(true)} className="flex flex-col gap-1 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left hover:bg-hx-hover">
                <span className="text-[13px] font-medium">{t.title}</span><span className="line-clamp-2 text-[12px] text-hx-muted">{t.purpose}</span>
              </button>
            ))}
          </div>
        </HomeSection>
        <HomeSection title="Ask the agent" id="ask">
          <div className="grid gap-2 sm:grid-cols-2">
            {['Build a dashboard from this file: ', 'Make a monthly report with the main numbers and what changed: ', 'Add a measure for year-over-year growth to my model: ', 'Connect my Postgres database and build an overview dashboard: '].map((p) => (
              <button key={p} type="button" data-home-action={p} onClick={() => prefill(p, true)} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left text-[13px] hover:bg-hx-hover"><Icon name="sparkles" size={15} className="text-hx-accent-text" /><span className="flex-1">{p.replace(/: $/, '')}</span></button>
            ))}
          </div>
        </HomeSection>
      {templating && <TemplateDialog onClose={() => setTemplating(false)} />}
    </Page>
  );
}
