/**
 * The Data page: sources (credentials only as key vault entry names), datasets with the query
 * editor (steps with a preview at each, profiling, SQL, refresh schedule, incremental refresh,
 * certification, lineage), the semantic model (tables, relationships, measures, calculated
 * columns, hierarchies, formats, roles, suggestions) and the refresh history. Every change is an op.
 */

import React, { useEffect, useState } from 'react';
import { COLUMN_TYPES, FILE_FORMATS, LOG_FORMATS, type MeasureSpec, type ModelSpec, type QueryResult, type SourceSpec, STEP_OPS, type StepSpec, TIME_CALCS, UI_ACTIONS } from '@harness/plugin-ui';
import { useApp } from '../../state/app';
import { Badge, BiVisual, Button, EmptyState, Field, Icon, IconButton, Input, Modal, Select, Spinner, Switch, Tabs, Textarea, cx, toast } from '@harness/ui';
import { client, useData } from '../../state/data';
import { desktop } from '../../bridge';
import { useDark } from './Doc';
import { act, type DatasetRow, modelFields, useDataStore } from './api';

export function DataPage({ params }: { params: Record<string, string> }): React.ReactElement {
  const [tab, setTab] = useState(params.tab ?? 'datasets');
  const catalog = useDataStore((s) => s.catalog);
  useEffect(() => { void useDataStore.getState().refreshCatalog(); }, []);
  return (
    <div className="flex h-full min-h-0 flex-col" data-bi-data>
      <div className="flex flex-wrap items-center gap-3 border-b border-hx-border-subtle px-6 py-3">
        <h1 className="text-[20px] font-semibold">Data</h1>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'sources', label: 'Sources', icon: 'plug', count: catalog?.sources.length }, { id: 'datasets', label: 'Datasets', icon: 'table', count: catalog?.datasets.length }, { id: 'model', label: 'Model', icon: 'layers', count: catalog?.models.length }, { id: 'history', label: 'Refresh history', icon: 'history' }]} />
      </div>
      <div className="min-h-0 flex-1">
        {!catalog ? <div className="p-6"><Spinner /></div> : tab === 'sources' ? <Sources /> : tab === 'datasets' ? <Datasets initial={params.dataset} /> : tab === 'model' ? <Models /> : <History />}
      </div>
    </div>
  );
}

const ResultTable = ({ r }: { r?: QueryResult }) => {
  const dark = useDark();
  if (!r) return null;
  return <div className="h-[300px] overflow-hidden rounded-lg border border-hx-border-subtle" data-result-rows={r.rowCount}><BiVisual v={{ id: 'preview', type: 'table', layout: { x: 0, y: 0, w: 12, h: 8 } }} result={r} theme={{ name: 'default', palette: [] }} dark={dark} /></div>;
};

// ---------------- sources ----------------

function Sources() {
  const catalog = useDataStore((s) => s.catalog)!;
  const [adding, setAdding] = useState(false);
  const [tested, setTested] = useState<Record<string, string>>({});
  return (
    <div className="hx-scroll h-full overflow-y-auto px-6 py-4">
      <div className="mb-3 flex items-center gap-2"><p className="flex-1 text-[12.5px] text-hx-secondary">Where data comes from. Secrets stay in the key vault: a source only names the entry, and its value is used on the server, never shown here or sent to a page.</p><Button variant="primary" icon="plus" onClick={() => setAdding(true)} data-add-source>Add a source</Button></div>
      {!catalog.sources.length ? <EmptyState icon="plug" title="No sources yet">Files (CSV, Excel, JSON, Parquet, GeoJSON), SQLite, Postgres, MySQL, HTTP APIs, values typed in, or a plugin's source.</EmptyState> : (
        <div className="space-y-2">{catalog.sources.map((s) => (
          <div key={s.id} className="rounded-xl border border-hx-border-subtle bg-hx-elevated p-3" data-source={s.id}>
            <div className="flex items-center gap-2"><Icon name={s.type === 'http' ? 'globe' : s.type === 'static' ? 'edit' : s.type === 'file' ? 'file' : 'database'} size={16} className="text-hx-accent-text" /><b className="min-w-0 flex-1 truncate text-[13.5px]">{s.name}</b><Badge>{s.type}</Badge>{s.origin === 'model' && <Badge tone="warning">typed by a model</Badge>}{s.secret && <Badge tone="neutral"><Icon name="key" size={11} className="mr-0.5 inline" />{s.secret}</Badge>}
              <Button size="sm" onClick={() => void act('data.test-source', { id: s.id }, { quiet: true }).then((r) => setTested({ ...tested, [s.id]: r.results[0]?.message ?? '' })).catch((e: Error) => setTested({ ...tested, [s.id]: `Failed: ${e.message}` }))}>Test</Button>
              <IconButton size="sm" icon="trash" label="Remove" onClick={() => void act('data.remove-source', { id: s.id }).catch(() => {})} />
            </div>
            <div className="mt-1 truncate text-[12px] text-hx-muted">{s.path ?? s.url ?? (s.host ? `${s.host}:${s.port ?? ''}/${s.database}` : s.type === 'static' ? `${s.rows?.length ?? 0} rows` : s.plugin ? `${s.plugin}:${s.kind}` : '')} · read by {catalog.datasets.filter((d) => d.source === s.id).map((d) => d.name).join(', ') || 'no dataset yet'}</div>
            {tested[s.id] && <div className="mt-1 text-[12px] text-hx-secondary" data-source-test>{tested[s.id]}</div>}
          </div>
        ))}</div>
      )}
      {adding && <AddSource onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSource({ onClose }: { onClose(): void }) {
  const registry = useData((s) => s.registry);
  const [type, setType] = useState<SourceSpec['type'] | string>('file');
  const [f, setF] = useState<Record<string, string>>({ name: '' });
  const [vault, setVault] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void client.get<Array<{ name: string }>>('/api/vault/entries').then((x) => setVault((Array.isArray(x) ? x : (x as unknown as { entries?: Array<{ name: string }> }).entries ?? []).map((e) => e.name))).catch(() => setVault([])); }, []);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const plugin = registry.dataSources.find((d) => d.qid === type);
  const pick = async () => {
    const files = await desktop.openFiles().catch(() => []);
    const file = files[0];
    if (!file) return;
    // Uploaded into this account's data folder (the file stays readable to the engine wherever the engine runs).
    const r = await client.post<{ path: string }>('/api/data/uploads', { name: file.name, base64: file.base64 });
    setF({ ...f, path: r.path, name: f.name || file.name.replace(/\.[^.]+$/, '') });
  };
  const save = async () => {
    const source: Record<string, unknown> = { name: f.name || 'Source', type: plugin ? 'plugin' : type };
    if (type === 'file' || type === 'sqlite') source.path = f.path;
    if (type === 'file' && f.format) source.format = f.format;
    if (type === 'file' && f.format === 'log') source.log = { format: f.logFormat || 'auto', ...(f.pattern ? { pattern: f.pattern } : {}) };
    if (type === 'postgres' || type === 'mysql' || type === 'mssql' || type === 'mongodb') Object.assign(source, { host: f.host, port: f.port ? Number(f.port) : undefined, database: f.database, user: f.user || undefined, secret: f.secret || undefined });
    if (type === 'http') Object.assign(source, { url: f.url, rowsPath: f.rowsPath || undefined, secret: f.secret || undefined, auth: f.auth || 'bearer', authName: f.authName || undefined });
    if (type === 'static') { const lines = (f.csv ?? '').trim().split(/\r?\n/); source.columns = lines[0]?.split(',').map((x) => x.trim()) ?? []; source.rows = lines.slice(1).map((l) => l.split(',').map((x) => (x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : x.trim()))); }
    if (plugin) Object.assign(source, { plugin: plugin.plugin, kind: plugin.id, params: f.params ? JSON.parse(f.params) as unknown : {} });
    setBusy(true);
    try { await act('data.add-source', { source }); onClose(); } catch { /* toasted */ } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title="Add a source" size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()} data-save-source>Add</Button></>}>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Type"><Select value={type} onChange={setType} options={[{ value: 'file', label: 'File (CSV, Excel, JSON, XML, Parquet, logs)' }, { value: 'sqlite', label: 'SQLite database' }, { value: 'postgres', label: 'Postgres' }, { value: 'mysql', label: 'MySQL or MariaDB' }, { value: 'mssql', label: 'SQL Server' }, { value: 'mongodb', label: 'MongoDB' }, { value: 'http', label: 'HTTP API (JSON, CSV, XML, logs)' }, { value: 'static', label: 'Values typed in' }, ...registry.dataSources.map((d) => ({ value: d.qid, label: `${d.title} (${d.plugin})` }))]} data-source-type /></Field>
        <Field label="Name"><Input value={f.name} onChange={set('name')} data-source-name /></Field>
      </div>
      {(type === 'file' || type === 'sqlite') && <Field label="Path" help="A file in one of your projects, or pick one to upload into your data folder."><div className="flex gap-1"><Input value={f.path ?? ''} onChange={set('path')} placeholder="C:\\data\\sales.xlsx" data-source-path /><Button onClick={() => void pick()}>Choose…</Button></div></Field>}
      {type === 'file' && <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="Format" help="Detected from the file's name when left as is."><Select value={f.format ?? ''} onChange={(v) => setF({ ...f, format: v })} options={[{ value: '', label: 'From the extension' }, ...FILE_FORMATS.map((x) => ({ value: x, label: x }))]} data-source-format /></Field>
        {f.format === 'log' && <Field label="Log format"><Select value={f.logFormat ?? 'auto'} onChange={(v) => setF({ ...f, logFormat: v })} options={LOG_FORMATS.map((x) => ({ value: x, label: x }))} data-source-log-format /></Field>}
        {f.format === 'log' && (f.logFormat === 'regex' || f.logFormat === 'grok') && <Field label="Pattern" help="Named groups: (?<status>\d{3}) or %{INT:status}"><Input value={f.pattern ?? ''} onChange={set('pattern')} /></Field>}
      </div>}
      {(type === 'postgres' || type === 'mysql' || type === 'mssql' || type === 'mongodb') && <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Host"><Input value={f.host ?? ''} onChange={set('host')} /></Field><Field label="Port"><Input value={f.port ?? ''} onChange={set('port')} placeholder={({ postgres: '5432', mysql: '3306', mssql: '1433', mongodb: '27017' } as Record<string, string>)[type]} /></Field>
        <Field label="Database"><Input value={f.database ?? ''} onChange={set('database')} /></Field><Field label="User"><Input value={f.user ?? ''} onChange={set('user')} /></Field>
      </div>}
      {type === 'http' && <>
        <Field label="URL" help="The only host this source may reach."><Input value={f.url ?? ''} onChange={set('url')} placeholder="https://api.example.com/v1/orders" /></Field>
        <div className="grid gap-x-4 sm:grid-cols-3"><Field label="Rows at" help="e.g. data.items"><Input value={f.rowsPath ?? ''} onChange={set('rowsPath')} /></Field><Field label="Send the secret as"><Select value={f.auth ?? 'bearer'} onChange={(v) => setF({ ...f, auth: v })} options={['bearer', 'basic', 'header', 'query'].map((x) => ({ value: x, label: x }))} /></Field><Field label="Header / parameter"><Input value={f.authName ?? ''} onChange={set('authName')} placeholder="x-api-key" /></Field></div>
      </>}
      {['postgres', 'mysql', 'mssql', 'mongodb', 'http'].includes(type) && <Field label="Secret (key vault entry)" help={vault.length ? 'Its value is read on the server when the source is read.' : 'Add the password or token in Settings > Vault first; then pick it here.'}><Select value={f.secret ?? ''} onChange={(v) => setF({ ...f, secret: v })} options={[{ value: '', label: 'None' }, ...vault.map((n) => ({ value: n, label: n }))]} /></Field>}
      {type === 'static' && <Field label="Values (CSV: a header, then rows)"><Textarea rows={6} value={f.csv ?? ''} onChange={set('csv')} placeholder={'region,target\nEMEA,1200000\nAmericas,1500000'} /></Field>}
      {plugin && <Field label="Parameters (JSON)" help={plugin.description}><Textarea rows={4} value={f.params ?? '{}'} onChange={set('params')} /></Field>}
    </Modal>
  );
}

// ---------------- datasets ----------------

function Datasets({ initial }: { initial?: string }) {
  const catalog = useDataStore((s) => s.catalog)!;
  const [sel, setSel] = useState(initial ?? catalog.datasets[0]?.name);
  const [defining, setDefining] = useState(false);
  const d = catalog.datasets.find((x) => x.name === sel);
  return (
    <div className="flex h-full min-h-0">
      <div className="hx-scroll w-64 shrink-0 overflow-y-auto border-r border-hx-border-subtle p-2">
        <Button size="sm" variant="primary" icon="plus" className="mb-2 w-full" onClick={() => setDefining(true)} data-new-dataset>New dataset</Button>
        {catalog.datasets.map((x) => (
          <button key={x.id} type="button" onClick={() => setSel(x.name)} data-dataset={x.name} className={cx('mb-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[13px]', sel === x.name ? 'bg-hx-accent-soft' : 'hover:bg-hx-hover')}>
            <Icon name="table" size={14} className="text-hx-muted" /><span className="min-w-0 flex-1 truncate">{x.name}</span>
            {x.certified && <Icon name="shield-check" size={13} className="text-hx-success" />}
            {x.state.error ? <Icon name="alert" size={13} className="text-hx-danger" /> : <span className="text-[11px] text-hx-muted">{x.state.rows?.toLocaleString() ?? ''}</span>}
          </button>
        ))}
      </div>
      <div className="hx-scroll min-w-0 flex-1 overflow-y-auto p-4">{d ? <DatasetDetail d={d} key={d.id} /> : <EmptyState icon="table" title="No dataset">A dataset is a named table the engine computes: a source's table or sheet, steps that shape it, and/or one SELECT over other datasets.</EmptyState>}</div>
      {defining && <DefineDataset onClose={(name) => { setDefining(false); if (name) setSel(name); }} />}
    </div>
  );
}

function DefineDataset({ onClose }: { onClose(name?: string): void }) {
  const catalog = useDataStore((s) => s.catalog)!;
  const [name, setName] = useState('');
  const [source, setSource] = useState(catalog.sources[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [sql, setSql] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  useEffect(() => { if (source) void act('data.test-source', { id: source }, { quiet: true }).then((r) => setTables(((r.results[0]?.data as { tables?: string[] })?.tables) ?? [])).catch(() => setTables([])); }, [source]);
  const save = () => void act('data.new-dataset', { dataset: { name, ...(source ? { source } : {}), ...(from ? { from } : {}), ...(sql.trim() ? { sql } : {}) } }).then(() => onClose(name)).catch(() => {});
  return (
    <Modal open onClose={() => onClose()} title="New dataset" size="lg" footer={<><Button onClick={() => onClose()}>Cancel</Button><Button variant="primary" onClick={save} disabled={!/^[A-Za-z_]\w*$/.test(name)} data-save-dataset>Define and read</Button></>}>
      <Field label="Name" help="Its name in SQL and in the model: letters, digits and _."><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="sales" data-dataset-name /></Field>
      <Field label="Source"><Select value={source} onChange={setSource} options={[{ value: '', label: 'None (SQL over other datasets)' }, ...catalog.sources.map((s) => ({ value: s.id, label: s.name }))]} data-dataset-source /></Field>
      {source && tables.length > 1 && <Field label="Table or sheet"><Select value={from} onChange={setFrom} options={[{ value: '', label: 'The first' }, ...tables.map((t) => ({ value: t, label: t }))]} /></Field>}
      <Field label="SQL (optional)" help="One read-only SELECT. The source (after steps) is base; other datasets by name; parameters as $name."><Textarea rows={4} className="font-mono text-[12px]" value={sql} onChange={(e) => setSql(e.target.value)} placeholder={source ? 'SELECT * FROM base WHERE amount > 0' : 'SELECT region, sum(amount) AS amount FROM sales GROUP BY 1'} /></Field>
    </Modal>
  );
}

const STEP_HELP: Record<string, string> = { filter: '{"where":"amount > 0"}', keep: '{"columns":["a","b"]}', remove: '{"columns":["c"]}', rename: '{"columns":{"old":"new"}}', type: '{"column":"day","to":"date"}', split: '{"column":"name","by":" ","into":["first","last"]}', filldown: '{"columns":["group"]}', replace: '{"column":"region","find":null,"with":"Unknown"}', group: '{"by":["region"],"aggs":[{"column":"amount","fn":"sum","as":"total"}]}', pivot: '{"on":"month","values":"amount","fn":"sum"}', unpivot: '{"columns":["q1","q2"],"name":"quarter","value":"amount"}', merge: '{"with":"regions","on":[["region_id","id"]],"how":"left"}', append: '{"with":["sales_2023"]}', dedupe: '{"columns":["id"]}', add: '{"name":"margin","expr":"revenue - cost"}', conditional: '{"name":"size","cases":[{"when":"amount > 1000","then":"big"}],"else":"small"}', dateparts: '{"column":"day","parts":["year","month"]}', sort: '{"by":[{"column":"amount","desc":true}]}', limit: '{"n":100}' };

function DatasetDetail({ d }: { d: DatasetRow }) {
  const catalog = useDataStore((s) => s.catalog)!;
  const [step, setStep] = useState<number | undefined>(undefined);
  const [preview, setPreview] = useState<QueryResult>();
  const [profile, setProfile] = useState<Array<{ name: string; type: string; nulls: number; distinct: number; min: unknown; max: unknown; mean: number | null; top: Array<[unknown, number]> }>>();
  const [rows, setRows] = useState(0);
  const [sql, setSql] = useState(d.sql ?? '');
  const [query, setQuery] = useState(`SELECT * FROM ${d.name} LIMIT 100`);
  const [queryResult, setQueryResult] = useState<QueryResult>();
  const [newStep, setNewStep] = useState<{ op: string; args: string }>({ op: 'filter', args: STEP_HELP.filter! });
  const [err, setErr] = useState<string>();
  const src = catalog.sources.find((s) => s.id === d.source);
  const load = () => {
    setErr(undefined);
    void act('data.preview', { dataset: d.name, ...(step !== undefined ? { step } : {}) }, { quiet: true }).then((r) => setPreview(r.results[0]?.data as unknown as QueryResult)).catch((e: Error) => setErr(e.message));
    void act('data.profile', { dataset: d.name, ...(step !== undefined ? { step } : {}) }, { quiet: true }).then((r) => { const p = r.results[0]?.data as unknown as { rows: number; columns: typeof profile }; setProfile(p.columns); setRows(p.rows); }).catch(() => setProfile(undefined));
  };
  useEffect(load, [d.id, step, d.state.at, JSON.stringify(d.steps)]);
  const users = [...catalog.models.filter((m) => m.tables.some((t) => t.dataset === d.name)).map((m) => `model ${m.name}`), ...catalog.datasets.filter((x) => x.steps?.some((s) => (s.op === 'merge' && s.with === d.name) || (s.op === 'append' && s.with.includes(d.name))) || (x.sql ?? '').includes(d.name) && x !== d).map((x) => `dataset ${x.name}`)];
  return (
    <div className="space-y-4" data-dataset-detail={d.name}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[17px] font-semibold">{d.name}</h2>
        {d.certified && <Badge tone="success">Certified</Badge>}{d.promoted && <Badge tone="accent">Promoted</Badge>}
        <span className="text-[12px] text-hx-muted">{d.state.error ? <span className="text-hx-danger">Refresh failed: {d.state.error}</span> : d.state.at ? `${d.state.rows?.toLocaleString() ?? ''} rows · read ${new Date(d.state.at).toLocaleString()}` : 'not read yet'}</span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" icon="refresh" onClick={() => void act('data.refresh', { dataset: d.name }).catch(() => {})} data-refresh-dataset>Refresh</Button>
          <Button size="sm" icon="shield-check" onClick={() => void act('data.certify', { dataset: d.name, certified: !d.certified }).catch(() => {})}>{d.certified ? 'Uncertify' : 'Certify'}</Button>
          <IconButton size="sm" icon="trash" label="Remove the dataset" onClick={() => void act('data.remove-dataset', { dataset: d.name }).catch(() => {})} />
        </div>
      </div>
      <div className="text-[12px] text-hx-muted" data-lineage-dataset>Lineage: {src ? `${src.name} (${src.type}${src.path ? `: ${src.path}` : src.url ? `: ${src.url}` : ''})` : 'SQL over datasets'}{d.from ? ` · ${d.from}` : ''} → {d.steps?.length ?? 0} steps{d.sql ? ' → SQL' : ''} → <b>{d.name}</b> → {users.join(', ') || 'not used yet'}</div>
      <div className="grid gap-4 xl:grid-cols-[minmax(260px,320px)_1fr]">
        <div className="space-y-3">
          <div className="rounded-xl border border-hx-border-subtle p-2" data-steps>
            <div className="mb-1 flex items-center"><b className="flex-1 text-[13px]">Applied steps</b><button type="button" className={cx('rounded px-1.5 text-[11.5px]', step === undefined ? 'bg-hx-accent-soft' : 'hover:bg-hx-hover')} onClick={() => setStep(undefined)}>result</button></div>
            <button type="button" className={cx('block w-full rounded px-1.5 py-0.5 text-left text-[12.5px]', step === 0 ? 'bg-hx-accent-soft' : 'hover:bg-hx-hover')} onClick={() => setStep(0)}>Source</button>
            {(d.steps ?? []).map((s, i) => (
              <div key={i} className={cx('flex items-center gap-1 rounded px-1.5 py-0.5 text-[12.5px]', step === i + 1 ? 'bg-hx-accent-soft' : 'hover:bg-hx-hover')} data-step={i}>
                <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => setStep(i + 1)} title={JSON.stringify(s)}>{i + 1}. {s.op} <span className="text-hx-muted">{JSON.stringify(s).slice(s.op.length + 9, 60)}</span></button>
                {i > 0 && <IconButton size="xs" icon="arrow-up" label="Move up" onClick={() => void act('data.move-step', { dataset: d.name, from: i, to: i - 1 }).catch(() => {})} />}
                <IconButton size="xs" icon="x" label="Remove the step" onClick={() => void act('data.remove-step', { dataset: d.name, index: i }).catch(() => {})} />
              </div>
            ))}
            <div className="mt-2 border-t border-hx-border-subtle pt-2">
              <Select aria-label="Step" value={newStep.op} onChange={(op) => setNewStep({ op, args: STEP_HELP[op] ?? '{}' })} options={(STEP_OPS as readonly string[]).map((x) => ({ value: x, label: x }))} />
              <Textarea aria-label="Step settings" rows={3} className="mt-1 font-mono text-[11.5px]" value={newStep.args} onChange={(e) => setNewStep({ ...newStep, args: e.target.value })} />
              <Button size="sm" className="mt-1" onClick={() => { let args: Record<string, unknown>; try { args = JSON.parse(newStep.args) as Record<string, unknown>; } catch { toast('The settings are not JSON', { kind: 'error' }); return; } void act('data.add-step', { dataset: d.name, step: { op: newStep.op, ...args } as StepSpec }).catch(() => {}); }} data-add-step>Add step</Button>
            </div>
          </div>
          <div className="rounded-xl border border-hx-border-subtle p-2">
            <b className="text-[13px]">Dataset SQL</b>
            <Textarea aria-label="Dataset SQL" rows={4} className="mt-1 font-mono text-[12px]" value={sql} onChange={(e) => setSql(e.target.value)} placeholder="SELECT * FROM base" />
            <Button size="sm" className="mt-1" onClick={() => void act('data.edit-sql', { dataset: d.name, patch: { sql: sql.trim() || null } }).catch(() => {})}>Save SQL</Button>
          </div>
          <RefreshSettings d={d} />
        </div>
        <div className="min-w-0 space-y-3">
          <div><b className="text-[13px]">{step === undefined ? 'Result' : step === 0 ? 'Source rows' : `After step ${step}`}</b> {err && <span className="text-[12px] text-hx-danger">{err}</span>}<ResultTable r={preview} /></div>
          {profile && <div className="rounded-xl border border-hx-border-subtle p-2" data-profile>
            <b className="text-[13px]">Column quality and distribution</b> <span className="text-[12px] text-hx-muted">{rows.toLocaleString()} rows</span>
            <div className="mt-1 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{profile.map((c) => {
              const valid = rows ? (rows - c.nulls) / rows : 0;
              const maxTop = Math.max(1, ...c.top.map((t) => t[1]));
              return (
                <div key={c.name} className="rounded-lg bg-hx-bg p-2 text-[11.5px]">
                  <div className="flex items-center gap-1"><b className="min-w-0 flex-1 truncate text-[12.5px]">{c.name}</b><span className="text-hx-muted">{c.type}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-hx-danger/30"><div className="h-full bg-hx-success" style={{ width: `${valid * 100}%` }} /></div>
                  <div className="text-hx-muted">{Math.round(valid * 1000) / 10}% valid · {c.nulls} empty · {c.distinct} distinct</div>
                  <div className="text-hx-muted">{String(c.min ?? '')} … {String(c.max ?? '')}{c.mean !== null ? ` · mean ${c.mean.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}</div>
                  {c.top.map(([v, n], i) => <div key={i} className="flex items-center gap-1"><span className="w-20 truncate">{String(v)}</span><span className="h-1.5 flex-1 rounded bg-hx-border-subtle"><span className="block h-full rounded bg-hx-accent" style={{ width: `${(n / maxTop) * 100}%` }} /></span><span className="w-8 text-right">{n}</span></div>)}
                </div>
              );
            })}</div>
          </div>}
          <div className="rounded-xl border border-hx-border-subtle p-2">
            <b className="text-[13px]">Query (read-only SQL over your datasets)</b>
            <Textarea aria-label="Query" rows={3} className="mt-1 font-mono text-[12px]" value={query} onChange={(e) => setQuery(e.target.value)} data-sql-editor />
            <Button size="sm" className="mt-1" icon="play" onClick={() => void act('data.run-sql', { sql: query }, { quiet: true }).then((r) => setQueryResult(r.results[0]?.data as unknown as QueryResult)).catch((e: Error) => toast(e.message, { kind: 'error' }))} data-run-sql>Run</Button>
            <ResultTable r={queryResult} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RefreshSettings({ d }: { d: DatasetRow }) {
  const [every, setEvery] = useState(String(d.refresh?.every ?? ''));
  const [inc, setInc] = useState(d.incremental?.column ?? '');
  const [win, setWin] = useState(String(d.incremental?.window ?? 30));
  const cols = d.state.sourceColumns ?? [];
  return (
    <div className="space-y-1 rounded-xl border border-hx-border-subtle p-2 text-[12.5px]">
      <b className="text-[13px]">Refresh</b>
      {d.source && <div className="flex items-center gap-1"><span className="w-28">Storage</span><Select aria-label="Storage" value={d.storage ?? 'import'} onChange={(m) => void act('data.storage', { dataset: d.name, storage: m }).catch(() => {})} options={[{ value: 'import', label: 'Import (an extract)' }, { value: 'live', label: 'Live (read when queried)' }]} data-storage /></div>}
      <div className="flex items-center gap-1"><span className="w-28">Every (seconds)</span><Input aria-label="Refresh every" type="number" value={every} onChange={(e) => setEvery(e.target.value)} placeholder="manual" /><Button size="sm" onClick={() => void act('data.schedule', { dataset: d.name, refresh: every ? { mode: 'interval', every: Number(every) } : { mode: 'manual' } }).catch(() => {})}>Save</Button></div>
      <div className="flex items-center gap-1"><span className="w-28">Incremental on</span><Select aria-label="Incremental column" value={inc} onChange={setInc} options={[{ value: '', label: 'Off (full refresh)' }, ...cols.filter((c) => /DATE|TIMESTAMP/.test(c.type)).map((c) => ({ value: c.name, label: c.name }))]} /></div>
      {inc && <div className="flex items-center gap-1"><span className="w-28">Last (days)</span><Input aria-label="Incremental window" type="number" value={win} onChange={(e) => setWin(e.target.value)} /></div>}
      <Button size="sm" onClick={() => void act('data.incremental', { dataset: d.name, incremental: inc ? { column: inc, window: Number(win) || 30, unit: 'day' } : null }).catch(() => {})}>Save incremental</Button>
      {d.state.incremental && <div className="text-hx-muted">Last run re-read rows from {d.state.incremental.cutoff}</div>}
    </div>
  );
}

// ---------------- the model ----------------

function Models() {
  const catalog = useDataStore((s) => s.catalog)!;
  const [sel, setSel] = useState(catalog.models[0]?.id ?? '');
  const [name, setName] = useState('');
  const m = catalog.models.find((x) => x.id === sel);
  return (
    <div className="hx-scroll h-full overflow-y-auto px-6 py-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select aria-label="Model" value={sel} onChange={setSel} options={catalog.models.length ? catalog.models.map((x) => ({ value: x.id, label: x.name })) : [{ value: '', label: 'No model yet' }]} className="w-56" />
        <Input aria-label="New model name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New model" className="w-44" />
        <Button size="sm" icon="plus" disabled={!name.trim()} onClick={() => void act('model.new', { model: { name: name.trim() } }).then((r) => { setSel(r.results[0]?.data?.id ?? ''); setName(''); }).catch(() => {})} data-new-model>Add model</Button>
        {m && <Button size="sm" icon="sparkles" onClick={() => void suggest(m)}>Suggest relationships and measures</Button>}
      </div>
      {m ? <ModelEditor m={m} /> : <EmptyState icon="layers" title="No model">A model joins datasets with relationships and defines measures (with time intelligence), hierarchies, formats and row-level security.</EmptyState>}
    </div>
  );
}

async function suggest(m: ModelSpec) {
  const r = await act('model.suggest', { datasets: m.tables.map((t) => t.dataset) }, { quiet: true }).catch(() => undefined);
  const s = r?.results[0]?.data as { text: string; ops: Array<Record<string, unknown>> } | undefined;
  if (!s) return;
  const ops: Array<Record<string, unknown>> = s.ops.filter((o) => o.op !== 'add_model' && o.op !== 'set_table').map((o) => ({ ...o, model: m.id }));
  if (!await useApp.getState().ask({ title: 'Apply the suggestions?', body: s.text, confirmLabel: 'Apply' })) return;
  // Each suggested op through the control that applies it (the same op).
  const action = (op: string) => Object.entries(UI_ACTIONS).find(([k, v]) => v === op && k.startsWith('model.'))?.[0] ?? '';
  const pairs = ops.map((o) => [action(String(o.op)), o] as [string, Record<string, unknown>]);
  const [first, ...rest] = pairs;
  if (first) await act(first[0], first[1], { more: rest }).catch(() => {});
}

function ModelEditor({ m }: { m: ModelSpec }) {
  const catalog = useDataStore((s) => s.catalog)!;
  const fields = modelFields(catalog, m).filter((f) => !f.field.includes(':')).map((f) => ({ value: f.field, label: f.label }));
  const [rel, setRel] = useState({ from: '', to: '', crossFilter: 'single' });
  const [meas, setMeas] = useState<Partial<MeasureSpec>>({ name: '', expr: '' });
  const [col, setCol] = useState({ table: m.tables[0]?.name ?? '', name: '', expr: '' });
  const [hier, setHier] = useState({ name: '', levels: '' });
  const [role, setRole] = useState({ name: '', members: '*', table: m.tables[0]?.name ?? '', filter: '' });
  const [addTable, setAddTable] = useState('');
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-model={m.id}>
      <div className="rounded-xl border border-hx-border-subtle p-3">
        <b className="text-[13px]">Tables and relationships</b>
        <div className="mt-1 flex flex-wrap gap-2">{m.tables.map((t) => (
          <div key={t.name} className="min-w-[160px] rounded-lg border border-hx-border bg-hx-elevated p-2 text-[12px]" data-model-table={t.name}>
            <div className="flex items-center"><b className="flex-1">{t.name}</b><IconButton size="xs" icon="x" label={`Remove ${t.name}`} onClick={() => void act('model.remove-table', { model: m.id, table: t.name }).catch(() => {})} /></div>
            {(() => {
              // Where the table's rows come from: tables of different sources relate in one model.
              const ds = catalog.datasets.find((d) => d.name === t.dataset);
              const src = ds?.source ? catalog.sources.find((s) => s.id === ds.source) : undefined;
              const kind = src ? (src.type === 'file' ? (src.format ?? src.path?.split('.').pop() ?? 'file').toUpperCase() : ({ sqlite: 'SQLite', postgres: 'Postgres', mysql: 'MySQL', mssql: 'SQL Server', mongodb: 'MongoDB', http: 'API', static: 'values', plugin: 'plugin' } as Record<string, string>)[src.type] ?? src.type) : 'SQL';
              return <div className="mb-0.5 flex flex-wrap items-center gap-1 text-[11px]" data-table-source={kind}><span className="rounded bg-hx-accent-soft px-1 font-medium text-hx-accent-text">{kind}</span><span className="truncate text-hx-secondary">{src?.name ?? 'over other datasets'}</span>{ds?.storage === 'live' && <span className="rounded bg-hx-success/15 px-1 text-hx-success" data-live>live</span>}</div>;
            })()}
            <div className="text-hx-muted">{catalog.datasets.find((d) => d.name === t.dataset)?.state.columns?.filter((c) => c.name !== '__rn').map((c) => c.name).join(', ')}</div>
            {(t.columns ?? []).map((c) => <div key={c.name} className="flex items-center text-hx-accent-text">ƒ {c.name}<IconButton size="xs" icon="x" label="Remove" onClick={() => void act('model.remove-column', { model: m.id, table: t.name, column: c.name }).catch(() => {})} /></div>)}
          </div>
        ))}</div>
        <div className="mt-2 flex gap-1"><Select aria-label="Add a table" value={addTable} onChange={setAddTable} options={[{ value: '', label: 'Add a dataset as a table…' }, ...catalog.datasets.filter((d) => !m.tables.some((t) => t.dataset === d.name)).map((d) => ({ value: d.name, label: d.name }))]} /><Button size="sm" disabled={!addTable} onClick={() => void act('model.add-table', { model: m.id, table: { name: addTable, dataset: addTable } }).then(() => setAddTable('')).catch(() => {})}>Add</Button></div>
        <div className="mt-3 space-y-0.5 text-[12.5px]">{m.relationships.map((r) => (
          <div key={r.id ?? `${r.from}->${r.to}`} className="flex items-center gap-1" data-relationship><span className="flex-1">{r.from} <Icon name="arrow-right" size={11} className="inline" /> {r.to} <span className="text-hx-muted">{r.cardinality ?? 'n:1'}{r.crossFilter === 'both' ? ', both ways' : ''}</span></span><IconButton size="xs" icon="x" label="Remove" onClick={() => void act('model.unrelate', { model: m.id, id: r.id ?? `${r.from}->${r.to}` }).catch(() => {})} /></div>
        ))}</div>
        <div className="mt-1 grid grid-cols-[1fr_1fr_auto_auto] gap-1">
          <Select aria-label="Relationship from (many)" value={rel.from} onChange={(v) => setRel({ ...rel, from: v })} options={[{ value: '', label: 'Many side…' }, ...fields]} />
          <Select aria-label="Relationship to (one)" value={rel.to} onChange={(v) => setRel({ ...rel, to: v })} options={[{ value: '', label: 'One side…' }, ...fields]} />
          <Select aria-label="Cross-filter" value={rel.crossFilter} onChange={(v) => setRel({ ...rel, crossFilter: v })} options={[{ value: 'single', label: 'Single' }, { value: 'both', label: 'Both' }]} />
          <Button size="sm" disabled={!rel.from || !rel.to} onClick={() => void act('model.relate', { model: m.id, relationship: rel }).catch(() => {})}>Relate</Button>
        </div>
        <div className="mt-3 text-[12.5px]"><b>Calculated column</b></div>
        <div className="grid grid-cols-[auto_1fr] gap-1"><Select aria-label="Table" value={col.table} onChange={(v) => setCol({ ...col, table: v })} options={m.tables.map((t) => ({ value: t.name, label: t.name }))} /><Input aria-label="Column name" placeholder="name" value={col.name} onChange={(e) => setCol({ ...col, name: e.target.value })} /></div>
        <div className="mt-1 flex gap-1"><Input aria-label="Column expression" placeholder="revenue - cost" value={col.expr} onChange={(e) => setCol({ ...col, expr: e.target.value })} /><Button size="sm" disabled={!col.name || !col.expr} onClick={() => void act('model.add-column', { model: m.id, table: col.table, column: { name: col.name, expr: col.expr } }).catch(() => {})}>Add</Button></div>
        <div className="mt-3 flex items-center gap-1 text-[12.5px]"><b className="w-28">Date field</b><Select aria-label="Date field" value={m.date ?? ''} onChange={(v) => void act('model.settings', { model: m.id, patch: { date: v } }).catch(() => {})} options={[{ value: '', label: 'None' }, ...fields]} /></div>
      </div>
      <div className="rounded-xl border border-hx-border-subtle p-3">
        <b className="text-[13px]">Measures</b>
        <div className="mt-1 space-y-0.5 text-[12.5px]">{m.measures.map((x) => (
          <div key={x.name} className="flex items-center gap-1" data-measure={x.name}>
            <span className="min-w-0 flex-1 truncate"><b>{x.name}</b> = <span className="font-mono text-[11.5px] text-hx-secondary">{x.expr ?? `${x.calc}(${x.base})`}{x.filter ? ` where ${x.filter}` : ''}</span></span>
            <Select aria-label={`Format of ${x.name}`} className="w-32" value={x.format ?? ''} onChange={(f) => void act('model.format', { model: m.id, field: x.name, format: f || null }).catch(() => {})} options={[{ value: '', label: 'Default' }, ...['currency:USD', 'currency:USD:0', 'currency:EUR', 'percent:1', 'number:2', 'integer', 'compact'].map((f) => ({ value: f, label: f }))]} />
            <IconButton size="xs" icon="edit" label="Edit" onClick={() => setMeas(x)} />
            <IconButton size="xs" icon="x" label="Remove" onClick={() => void act('model.remove-measure', { model: m.id, name: x.name }).catch(() => {})} />
          </div>
        ))}</div>
        <div className="mt-2 space-y-1 rounded-lg bg-hx-bg p-2" data-measure-editor>
          <Input aria-label="Measure name" placeholder="Name" value={meas.name ?? ''} onChange={(e) => setMeas({ ...meas, name: e.target.value })} />
          <Select aria-label="Measure kind" value={meas.calc ? 'calc' : 'expr'} onChange={(k) => setMeas(k === 'calc' ? { name: meas.name, base: m.measures[0]?.name, calc: 'ytd' } : { name: meas.name, expr: '' })} options={[{ value: 'expr', label: 'An aggregate (SQL)' }, { value: 'calc', label: 'A calculation on another measure' }]} />
          {meas.calc ? <div className="grid grid-cols-2 gap-1"><Select aria-label="Base measure" value={meas.base ?? ''} onChange={(b) => setMeas({ ...meas, base: b })} options={m.measures.map((x) => ({ value: x.name, label: x.name }))} /><Select aria-label="Calculation" value={meas.calc} onChange={(c) => setMeas({ ...meas, calc: c as MeasureSpec['calc'] })} options={(TIME_CALCS as readonly string[]).map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))} /></div>
            : <><Input aria-label="Measure expression" className="font-mono" placeholder="sum(orders.revenue), or [Revenue] / [Orders]" value={meas.expr ?? ''} onChange={(e) => setMeas({ ...meas, expr: e.target.value })} /><Input aria-label="Measure filter" placeholder="Only where (optional): countries.region = 'EMEA'" value={meas.filter ?? ''} onChange={(e) => setMeas({ ...meas, filter: e.target.value || undefined })} /></>}
          <Button size="sm" variant="primary" disabled={!meas.name || (!meas.expr && !meas.calc)} onClick={() => void act('model.measure', { model: m.id, measure: meas }).then(() => setMeas({ name: '', expr: '' })).catch(() => {})} data-save-measure>Save measure</Button>
        </div>
        <div className="mt-3 text-[12.5px]"><b>Hierarchies</b>{m.hierarchies.map((h) => <div key={h.name} className="flex items-center gap-1"><span className="flex-1">{h.name}: {h.levels.join(' › ')}</span><IconButton size="xs" icon="x" label="Remove" onClick={() => void act('model.remove-hierarchy', { model: m.id, name: h.name }).catch(() => {})} /></div>)}</div>
        <div className="mt-1 grid grid-cols-[auto_1fr_auto] gap-1"><Input aria-label="Hierarchy name" placeholder="Calendar" value={hier.name} onChange={(e) => setHier({ ...hier, name: e.target.value })} className="w-28" /><Input aria-label="Hierarchy levels" placeholder="orders.day:year, orders.day:month" value={hier.levels} onChange={(e) => setHier({ ...hier, levels: e.target.value })} /><Button size="sm" disabled={!hier.name || !hier.levels} onClick={() => void act('model.hierarchy', { model: m.id, hierarchy: { name: hier.name, levels: hier.levels.split(',').map((x) => x.trim()).filter(Boolean) } }).catch(() => {})}>Add</Button></div>
        <div className="mt-3 text-[12.5px]"><b>Row-level security</b>{m.roles.map((r) => <div key={r.name} className="flex items-center gap-1" data-role={r.name}><span className="flex-1">{r.name} ({r.members.join(', ')}): {Object.entries(r.filters).map(([t, p]) => `${t} where ${p}`).join('; ')}</span><IconButton size="xs" icon="x" label="Remove" onClick={() => void act('model.remove-role', { model: m.id, name: r.name }).catch(() => {})} /></div>)}</div>
        <div className="mt-1 grid grid-cols-2 gap-1">
          <Input aria-label="Role name" placeholder="Role" value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} />
          <Input aria-label="Role members" placeholder="usr_..., or *" value={role.members} onChange={(e) => setRole({ ...role, members: e.target.value })} />
          <Select aria-label="Role table" value={role.table} onChange={(v) => setRole({ ...role, table: v })} options={m.tables.map((t) => ({ value: t.name, label: t.name }))} />
          <Input aria-label="Role filter" placeholder="manager = {user}" value={role.filter} onChange={(e) => setRole({ ...role, filter: e.target.value })} />
        </div>
        <Button size="sm" className="mt-1" disabled={!role.name || !role.filter} onClick={() => void act('model.role', { model: m.id, role: { name: role.name, members: role.members.split(/[\s,]+/).filter(Boolean), filters: { [role.table]: role.filter } } }).catch(() => {})}>Save role</Button>
      </div>
    </div>
  );
}

function History() {
  const catalog = useDataStore((s) => s.catalog)!;
  const [runs, setRuns] = useState(catalog.runs);
  useEffect(() => { void client.get<Array<Record<string, unknown>>>('/api/data/runs').then(setRuns).catch(() => {}); }, [catalog.version]);
  return (
    <div className="hx-scroll h-full overflow-y-auto px-6 py-4">
      <table className="w-full text-[12.5px]" data-refresh-history>
        <thead><tr className="text-left text-hx-muted"><th className="py-1">When</th><th>What</th><th>Result</th><th>Rows</th><th>Time</th><th>Why</th></tr></thead>
        <tbody>{runs.map((r, i) => (
          <tr key={i} className="border-t border-hx-border-subtle">
            <td className="py-1">{new Date(Number(r.at)).toLocaleString()}</td><td>{String(r.kind)} {String(r.dataset ?? r.doc ?? '')}{r.alert ? ` · ${String(r.alert)}` : ''}</td>
            <td className={r.ok === false ? 'text-hx-danger' : r.state === 'firing' ? 'text-hx-warning' : 'text-hx-success'}>{r.ok === false ? `failed: ${String(r.error ?? '')}` : r.state ? String(r.state) : 'ok'}</td>
            <td>{r.rows !== undefined ? Number(r.rows).toLocaleString() : ''}</td><td>{r.ms !== undefined ? `${Number(r.ms)} ms` : ''}</td><td className="text-hx-muted">{String(r.reason ?? '')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export { Switch, COLUMN_TYPES };
