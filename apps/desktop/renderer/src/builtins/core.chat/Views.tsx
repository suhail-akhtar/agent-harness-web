/**
 * core.chat's pages: the home ("Where should we begin?" with the Work-in picker, prompts and home
 * cards), a conversation (transcript, attention bar, composer, header with context and cost) and
 * search. Plus the "recent" home card.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Effort, Mode } from '@harness/client';
import { Button, EmptyState, Icon, IconButton, Input, Popover, MenuList, Spinner, Tooltip, Working, toast, type MenuItem, Page, PageState, ListRow } from '@harness/ui';
import { useApp, openSession, navigate, setCrumb } from '../../state/app';
import { useData, client, clientInfo, notePluginsTold, syncClientPlugins } from '../../state/data';
import { desktop, scratchFolder } from '../../bridge';
import { TopBar } from '../../shell/Bars';
import { HomeCardHost } from '../../registry/PluginView';
import { Composer, chipContext, type ComposerValue } from './Composer';
import { Transcript, fmtCost } from './Transcript';
import { useSessionLive } from './live';
import { PendingCard, respondFor } from '../../components/Pending';
import { usePane } from '../../registry/PluginView';
import { ProductMark } from '../../components/ProductMark';
import { recommendedModel } from '../../state/recommend';
import { CostByModel } from '../../components/CostByModel';
import { ContextMeter } from '../../components/ContextPanel';

const EFFORT_RANK: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Think on: at least "high", when the model offers it. */
function effortFor(v: ComposerValue, efforts: Effort[] | undefined): Effort | undefined {
  if (!v.think) return v.effort;
  const want = EFFORT_RANK.indexOf('high');
  const cur = v.effort ? EFFORT_RANK.indexOf(v.effort) : -1;
  if (cur >= want) return v.effort;
  return efforts?.find((e) => EFFORT_RANK.indexOf(e) >= want) ?? v.effort;
}

function defaultsNow(): ComposerValue { return defaultsFrom(useApp.getState().prefs, useData.getState().models); }
function defaultsFrom(prefs: ReturnType<typeof useApp.getState>['prefs'], models: ReturnType<typeof useData.getState>['models']): ComposerValue {
  const rec = recommendedModel(models)?.id;
  const model = models.find((m) => m.id === prefs.defaultModel && m.available) ?? models.find((m) => m.id === rec) ?? models.find((m) => m.available) ?? models[0];
  return { model: model?.id ?? '', effort: (prefs.defaultEffort as Effort) || model?.effort, mode: (prefs.defaultMode as Mode) || 'default', think: false };
}

function useDefaults(): ComposerValue {
  const prefs = useApp((s) => s.prefs);
  const models = useData((s) => s.models);
  return defaultsFrom(prefs, models);
}

export function Home(): React.ReactElement {
  const info = useApp((s) => s.info);
  const projects = useApp((s) => s.prefs.projects);
  const registry = useData((s) => s.registry);
  const models = useData((s) => s.models);
  const defaults = useDefaults();
  const [value, setValue] = useState<ComposerValue>(defaults);
  const [where, setWhere] = useState<string>(() => { try { return localStorage.getItem('harness.workIn') ?? ''; } catch { return ''; } });
  useEffect(() => { if (!value.model && defaults.model) setValue(defaults); }, [defaults.model]);
  // A default changed in Settings (or by an agent) while the page is open: the composer follows it.
  useEffect(() => { setValue((v) => ({ ...v, mode: defaults.mode, ...(defaults.effort ? { effort: defaults.effort } : {}) })); }, [defaults.mode, defaults.effort]);
  useEffect(() => { try { localStorage.setItem('harness.workIn', where); } catch { /* none */ } }, [where]);
  const homePrompts = registry.prompts.filter((p) => p.home);
  const noModel = models.length > 0 && !models.some((m) => m.available);

  const start = async (text: string, attachments: Attachment[]) => {
    const path = where || await scratchFolder(info?.scratch);
    // The model chosen, else the default now (the models may have arrived after this page did).
    let model = value.model || defaultsNow().model;
    // Just after an engine restart the list may still be on its way: ask once more before giving up.
    if (!model) { await useData.getState().refreshModels().catch(() => {}); model = defaultsNow().model; }
    if (!model) { toast('Choose a model first (add a key in Settings > Models & providers).', { kind: 'warning' }); return false; }
    try {
      const spec = useData.getState().models.find((m) => m.id === model);
      const s = await client.sessions.create({ title: text.replace(/\s+/g, ' ').slice(0, 60) || 'New conversation', model, effort: effortFor({ ...value, model }, spec?.efforts), mode: value.mode, runtime: 'local', ...(path ? { path } : {}), ...(useApp.getState().prefs.commandSandbox === 'docker' ? { sandbox: 'docker' } : {}), client: clientInfo() });
      useData.getState().upsertSession(s);
      notePluginsTold(s.id);
      openSession(s.id);
      await client.sessions.send(s.id, text + chipContext(), attachments);
      return true;
    } catch (e) { toast((e as Error).message, { kind: 'error' }); return false; }
  };

  return (
    <div className="flex h-full flex-col" data-home>
      <div className="hx-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-column flex-col items-center px-4 pt-[14vh] sm:px-6">
          <div className="mb-6 flex items-center gap-3">
            <ProductMark size={36} />
            <h1 className="text-[26px] font-semibold tracking-tight text-hx-primary" data-greeting>{info?.product.brand.tagline ?? 'Where should we begin?'}</h1>
          </div>
          {noModel && (
            <button type="button" onClick={() => useApp.setState({ onboardingOpen: true })} className="mb-4 flex w-full items-center gap-3 rounded-xl border border-hx-warning/35 bg-hx-warning/8 px-4 py-3 text-left text-[13px]">
              <Icon name="key" size={16} className="text-hx-warning" /><span className="flex-1">No model has a key yet. Set one up to start.</span><span className="font-medium text-hx-accent-text">Set up</span>
            </button>
          )}
        </div>
        <Composer draftKey="home" keepDraft={false} value={value} onChange={(v) => setValue((x) => ({ ...x, ...v }))} onSend={(t, a) => start(t, a)} autoFocus left={<WorkIn value={where} onChange={setWhere} projects={projects} scratch={info?.scratch} />} />
        <div className="mx-auto w-full max-w-column px-4 sm:px-6">
          {homePrompts.length > 0 && (
            <div className="mt-2 flex flex-wrap justify-center gap-2" data-home-prompts>
              {homePrompts.map((p) => <button key={p.qid} type="button" onClick={() => useApp.setState({ prefill: { text: p.prompt, nonce: Date.now() } })} className="inline-flex items-center gap-1.5 rounded-full border border-hx-border-subtle bg-hx-elevated px-3 py-1.5 text-[12.5px] text-hx-secondary hover:border-hx-border hover:text-hx-primary"><Icon name={p.icon ?? 'sparkles'} size={13} />{p.title}</button>)}
            </div>
          )}
          <div className="mt-8 grid gap-3 pb-10 md:grid-cols-2">
            {registry.homeCards.map((c) => <HomeCardHost key={c.qid} card={c} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkIn({ value, onChange, projects, scratch }: { value: string; onChange: (p: string) => void; projects: { path: string; name: string }[]; scratch?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = projects.find((p) => p.path === value);
  const items: MenuItem[] = [
    { id: 'scratch', label: 'Scratch space', hint: 'a folder of its own', icon: 'box', checked: !value, onSelect: () => onChange('') },
    ...projects.map((p): MenuItem => ({ id: p.path, label: p.name, hint: p.path, icon: 'folder', checked: p.path === value, onSelect: () => onChange(p.path) })),
    { id: 'sep', label: '', separator: true },
    { id: 'open', label: 'Open a folder…', icon: 'folder-plus', onSelect: () => void desktop.openFolder('Work in a folder').then(async (dir) => { if (!dir) return; await desktop.addProject(dir); onChange(dir); toast(`Added ${dir}`); }).catch((e: Error) => toast(e.message, { kind: 'error' })) },
  ];
  return (
    <>
      <button ref={ref} type="button" data-work-in onClick={() => setOpen(!open)} title={value || scratch} className="inline-flex h-7 max-w-[200px] items-center gap-1 rounded-lg px-2 text-[12.5px] text-hx-secondary hover:bg-hx-hover hover:text-hx-primary">
        <Icon name={current ? 'folder' : 'box'} size={14} /><span className="truncate">Work in: {current?.name ?? 'Scratch'}</span><Icon name="chevron-down" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top-start" className="w-[320px]" role="presentation"><MenuList items={items} onDone={() => setOpen(false)} /></Popover>
    </>
  );
}

export function Session({ params }: { params: Record<string, string> }): React.ReactElement {
  const id = params.id ?? '';
  const [s, set] = useSessionLive(id);
  const models = useData((st) => st.models);
  const [queue, setQueue] = useState<string[]>([]);
  const [think, setThink] = useState(false);
  const [sources, setSources] = useState<Array<{ n: number; url: string; title?: string; snippet?: string }>>([]);
  const running = s.status !== 'idle';
  const workingPref = useApp((x) => x.prefs.working);
  const spec = models.find((m) => m.id === s.meta?.model);
  const value: ComposerValue = { model: s.meta?.model ?? '', effort: s.meta?.effort, mode: s.meta?.mode ?? 'default', think };
  useEffect(() => { void desktop.busy(running); }, [running]);
  useEffect(() => { client.sessions.sources(id).then((list) => setSources(list.map((x, i) => ({ n: typeof x.id === 'number' ? x.id : i + 1, url: x.url, title: x.title, snippet: x.snippet })))).catch(() => setSources([])); }, [id, s.status]);
  // Queued messages go when the turn ends.
  useEffect(() => {
    if (running || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void syncClientPlugins(id).then(() => client.sessions.send(id, next!)).catch((e: Error) => toast(e.message, { kind: 'error' }));
  }, [running, queue.length]);

  const patch = async (v: Partial<ComposerValue>) => {
    if (v.think !== undefined) setThink(v.think);
    const b: { model?: string; effort?: Effort; mode?: Mode } = {};
    if (v.model && v.model !== s.meta?.model) b.model = v.model;
    if (v.effort && v.effort !== s.meta?.effort) b.effort = v.effort;
    if (v.mode && v.mode !== s.meta?.mode) b.mode = v.mode;
    if (!Object.keys(b).length) return;
    try { const m = await client.sessions.patch(id, b); set((x) => ({ ...x, meta: m })); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
  };
  const send = async (text: string, attachments: Attachment[], how: 'send' | 'queue') => {
    if (how === 'queue' && running) { setQueue((q) => [...q, text]); return true; }
    try {
      const want = effortFor(value, spec?.efforts);
      if (want && want !== s.meta?.effort) { const m = await client.sessions.patch(id, { effort: want }); set((x) => ({ ...x, meta: m })); }
      // A plugin switched on or off since this conversation was told: its plugin index and guides follow.
      await syncClientPlugins(id);
      await client.sessions.send(id, text + chipContext(), attachments);
      return true;
    } catch (e) { toast((e as Error).message, { kind: 'error' }); return false; }
  };
  const stop = () => void client.sessions.abort(id).catch((e: Error) => toast(e.message, { kind: 'error' }));
  const respond = respondFor(id);
  const pane = usePane();
  useEffect(() => { if (!pane.split && s.meta) setCrumb({ view: 'core.chat:session', title: s.meta.title }); }, [s.meta?.title, pane.split]);

  if (!s.loaded) return <div className="flex h-full flex-col"><TopBar title="Loading…" /><div className="flex flex-1 items-center justify-center"><PageState kind="loading" /></div></div>;
  if (s.error) return <div className="flex h-full flex-col"><TopBar title="Conversation" /><PageState kind="error" title="This conversation could not be opened" detail={s.error} action={<Button onClick={() => navigate({ view: 'core.chat:home' })}>Go home</Button>} /></div>;
  return (
    <div className="flex h-full flex-col" data-session={id} data-status={s.status}>
      <TopBar title={s.meta?.title}>
        {s.meta && (
          <div className="mr-1 hidden items-center gap-3 text-[11.5px] text-hx-muted md:flex" data-session-meter>
            <ContextMeter sessionId={id} tokens={s.live.contextTokens} window={s.live.contextWindow} />
            <UsageButton meta={s.meta} />
          </div>
        )}
        <Tooltip label="Run a workflow"><IconButton icon="workflow" size="sm" label="Run a workflow" onClick={() => useApp.setState({ workflowDialog: { sessionId: id } })} /></Tooltip>
      </TopBar>
      {s.stream === 'retrying' && <div className="bg-hx-warning/12 px-4 py-1 text-center text-[12px] text-hx-warning">Reconnecting to the conversation…</div>}
      <Transcript sessionId={id} items={s.live.items} running={running} onRetry={(t) => void send(t, [], 'send')} sources={sources} />
      {s.live.retry && <div className="mx-auto w-full max-w-column px-6 pb-1 text-[12px] text-hx-warning">{s.live.retry}</div>}
      {s.pending.length > 0 && (
        <div data-attention className="hx-scroll mx-auto max-h-[65vh] w-full max-w-column shrink-0 space-y-2 overflow-y-auto px-4 pb-2 sm:px-6">
          {s.pending.map((p) => <PendingCard key={p.requestId} p={p} respond={respond} />)}
        </div>
      )}
      {running && !s.pending.length && (
        <div className="mx-auto flex w-full max-w-column items-center gap-2 px-6 pb-1 text-[12px] text-hx-muted" data-working><Working style={workingPref} className="text-hx-accent-text" />Working… <span className="text-hx-muted/70">Enter steers, Queue waits for the end</span></div>
      )}
      <Composer draftKey={`s:${id}`} value={value} onChange={(v) => void patch(v)} onSend={send} running={running} onStop={stop} sessionId={id} queued={queue} onUnqueue={(i) => setQueue((q) => q.filter((_, j) => j !== i))} autoFocus />
    </div>
  );
}

/** The conversation's cost; a click shows it per model (its own and the ones its agents delegated to). */
function UsageButton({ meta }: { meta: import('@harness/client').SessionMeta }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const models = Object.keys(meta.byModel ?? {}).length;
  return (
    <>
      <Tooltip label="What this conversation has cost, per model"><button ref={ref} type="button" data-cost onClick={() => setOpen(!open)} className="rounded px-1 hover:bg-hx-hover hover:text-hx-primary">{fmtCost(meta.cost)}{models > 1 ? ` · ${models} models` : ''}</button></Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="bottom-end" className="w-[360px]" role="dialog" label="Usage">
        <div className="p-3" data-usage-panel>
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-hx-muted">Usage</div>
          <CostByModel meta={meta} />
          {meta.delegationCost ? <p className="mt-2 text-[11.5px] text-hx-muted">Agents on other models: {fmtCost(meta.delegationCost)} (Settings › Models & providers › Delegation).</p> : null}
        </div>
      </Popover>
    </>
  );
}

export function Search(): React.ReactElement {
  const asked = useApp((s) => (s.route.view === 'core.chat:search' ? s.route.params?.q : undefined));
  const [q, setQ] = useState(asked ?? '');
  useEffect(() => { if (asked !== undefined) setQ(asked); }, [asked]);
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<import('@harness/client').SessionMeta[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { client.sessions.list({ query: q.trim() || undefined, archived, limit: 100 }).then((r) => setList(r.sessions)).catch(() => setList([])); }, 180);
    return () => clearTimeout(t);
  }, [q, archived]);
  return (
    <Page data-search title="Search conversations">
        <div className="flex gap-2"><Input icon="search" autoFocus placeholder="Titles and first messages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" /><Button variant={archived ? 'subtle' : 'ghost'} icon="archive" onClick={() => setArchived(!archived)}>{archived ? 'Archived' : 'Active'}</Button></div>
        <div className="mt-4 divide-y divide-hx-border-subtle">
          {list === null ? <PageState kind="loading" /> : !list.length ? <PageState kind="empty" icon="search" title="Nothing found" /> : list.map((s) => (
            <ListRow key={s.id} icon="chat" onClick={() => openSession(s.id)} className="rounded-none px-1 py-2.5" title={s.title || 'New conversation'}
              subtitle={`${new Date(s.updatedAt).toLocaleString()} · ${s.model} · ${fmtCost(s.cost)}`}
              meta={s.status && s.status !== 'idle' ? <span className="text-hx-accent-text">{s.status}</span> : undefined} />
          ))}
        </div>
    </Page>
  );
}

export function RecentCard(): React.ReactElement {
  const sessions = useData((s) => s.sessions);
  const recent = useMemo(() => sessions.slice(0, 5), [sessions]);
  if (!recent.length) return <p className="text-[12.5px] text-hx-muted">Your conversations will show here.</p>;
  return (
    <div className="space-y-0.5">
      {recent.map((s) => <ListRow key={s.id} icon="chat" onClick={() => openSession(s.id)} className="px-1.5 py-1" title={s.title || 'New conversation'} meta={new Date(s.updatedAt).toLocaleDateString()} />)}
    </div>
  );
}
