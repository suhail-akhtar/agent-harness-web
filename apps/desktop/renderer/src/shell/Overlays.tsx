/**
 * The shell's overlays: the engine gate (real status and log lines, Restart), the banner when the
 * engine drops after it was ready, the onboarding wizard (steps from the registry), the settings
 * modal (sections from the registry, searchable), the workflow start dialog and the confirm dialog.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, EmptyState, Icon, Input, Modal, SchemaForm, Select, Spinner, cx, schemaText, toast, Textarea, Field } from '@harness/ui';
import type { WorkflowInfo } from '@harness/client';
import type { JsonSchema } from '@harness/plugin-ui';
import { useApp, openSession } from '../state/app';
import { useData, client } from '../state/data';
import { desktop } from '../bridge';
import { ViewHost, type NativeProps } from '../registry/PluginView';
import type { SettingsSection } from '../registry/registry';

export function EngineGate(): React.ReactElement | null {
  const engine = useApp((s) => s.engine);
  const [everReady, setEverReady] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  useEffect(() => { if (engine.status === 'ready') setEverReady(true); }, [engine.status]);
  useEffect(() => {
    if (engine.status === 'ready') return;
    let alive = true;
    const tick = () => desktop.engineLogs().then((l) => { if (alive) setLogs(l.slice(-40)); }).catch(() => {});
    void tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
  }, [engine.status]);
  if (engine.status === 'ready') return null;
  const restart = () => void desktop.engineRestart().catch((e: Error) => toast(e.message, { kind: 'error' }));
  const message = engine.status === 'crashed' ? engine.message : engine.status === 'stopped' ? (engine.message ?? 'The engine is stopped.') : `Starting the engine${engine.attempt > 1 ? ` (attempt ${engine.attempt})` : ''}…`;
  if (everReady) {
    return (
      <div data-engine-banner role="alert" className="flex items-center gap-3 border-b border-hx-warning/30 bg-hx-warning/12 px-4 py-2 text-[13px] text-hx-primary">
        {engine.status === 'starting' ? <Spinner /> : <Icon name="warning" size={16} className="text-hx-warning" />}
        <span className="min-w-0 flex-1 truncate">{engine.status === 'starting' ? 'Reconnecting to the engine…' : `The engine stopped. ${engine.status === 'crashed' ? `Trying again in ${Math.round(engine.retryInMs / 1000)}s.` : ''}`} Your conversations are safe.</span>
        <Button size="sm" onClick={() => setShowLogs((v) => !v)}>{showLogs ? 'Hide log' : 'Log'}</Button>
        <Button size="sm" variant="primary" onClick={restart}>Restart</Button>
        {showLogs && <pre className="fixed bottom-8 right-4 z-50 max-h-72 w-[min(640px,90vw)] overflow-auto rounded-xl border border-hx-border bg-hx-elevated p-3 font-mono text-[11px] shadow-[var(--hx-shadow)]">{logs.join('\n')}</pre>}
      </div>
    );
  }
  return (
    <div data-engine-gate={engine.status} className="fixed inset-0 z-[80] flex items-center justify-center bg-hx-bg p-6">
      <div className="w-full max-w-xl">
        <div className="flex items-center gap-3">
          {engine.status === 'starting' ? <Spinner size={22} className="text-hx-accent-text" /> : <Icon name="alert" size={22} className="text-hx-danger" />}
          <h1 className="text-[18px] font-semibold text-hx-primary">{engine.status === 'starting' ? 'Getting things ready' : 'The engine could not start'}</h1>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-[13px] text-hx-secondary">{message}</p>
        <pre data-engine-log className="hx-scroll mt-4 max-h-64 overflow-auto rounded-xl border border-hx-border-subtle bg-hx-code p-3 font-mono text-[11.5px] leading-5 text-hx-secondary">{logs.length ? logs.join('\n') : 'No output yet.'}</pre>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" icon="refresh" onClick={restart}>Restart the engine</Button>
          <Button onClick={() => useApp.getState().openSettings('core.settings:servers')}>Use a server instead</Button>
          <Button variant="ghost" onClick={() => void desktop.openDataFolder()}>Open the data folder</Button>
        </div>
      </div>
    </div>
  );
}

export function Onboarding(): React.ReactElement | null {
  const open = useApp((s) => s.onboardingOpen);
  const steps = useData((s) => s.registry.onboarding);
  const views = useData((s) => s.registry.views);
  const [i, setI] = useState(0);
  if (!open || !steps.length) return null;
  const step = steps[Math.min(i, steps.length - 1)]!;
  const view = views.get(step.view);
  const finish = () => { useApp.setState({ onboardingOpen: false }); useApp.getState().setPrefs({ onboardingDone: true }); setI(0); };
  return (
    <Modal open onClose={finish} size="lg" bare label="Welcome">
      <div data-onboarding className="flex max-h-[calc(100vh-48px)] flex-col">
        <div className="border-b border-hx-border-subtle px-6 py-4">
          <div className="text-[12px] font-medium text-hx-muted">Welcome to {useApp.getState().info?.product.name ?? 'Harness'} · Step {i + 1} of {steps.length}</div>
          <div className="mt-1 text-[17px] font-semibold">{step.title}</div>
          {step.description && <div className="mt-0.5 text-[13px] text-hx-muted">{step.description}</div>}
          <div className="mt-3 flex gap-1.5">{steps.map((s, k) => <span key={s.qid} className={cx('h-1 flex-1 rounded-full', k <= i ? 'bg-hx-accent' : 'bg-hx-pill')} />)}</div>
        </div>
        <div className="hx-scroll min-h-[320px] flex-1 overflow-auto">{view ? <ViewHost view={view} params={{ onboarding: '1' }} /> : <EmptyState title="This step is not available" />}</div>
        <div className="flex items-center gap-2 border-t border-hx-border-subtle px-6 py-3">
          <Button variant="ghost" onClick={finish}>Skip setup</Button>
          <div className="flex-1" />
          {i > 0 && <Button onClick={() => setI(i - 1)}>Back</Button>}
          {i < steps.length - 1 ? <Button variant="primary" data-onboarding-next onClick={() => setI(i + 1)}>Next</Button> : <Button variant="primary" onClick={finish}>Done</Button>}
        </div>
      </div>
    </Modal>
  );
}

const GROUP_LABEL: Record<string, string> = { app: 'App', agent: 'Agent', integrations: 'Integrations', plugins: 'Plugins', admin: 'Admin' };

export function SettingsModal(): React.ReactElement | null {
  const section = useApp((s) => s.settingsSection);
  const sections = useData((s) => s.registry.settings);
  const [q, setQ] = useState('');
  const close = () => { useApp.setState({ settingsSection: null }); setQ(''); };
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return sections;
    return sections.filter((s) => `${s.title} ${s.plugin} ${s.schema ? schemaText(s.schema) : ''} ${(SEARCH_TEXT[s.qid] ?? '')}`.toLowerCase().includes(t));
  }, [q, sections]);
  if (section === null) return null;
  const current = sections.find((s) => s.qid === section) ?? filtered[0] ?? sections[0];
  let lastGroup = '';
  return (
    <Modal open onClose={close} size="xl" bare label="Settings" className="h-[min(760px,calc(100vh-48px))]">
      <div data-settings className="flex h-full min-h-0">
        <div className="flex w-56 shrink-0 flex-col border-r border-hx-border-subtle bg-hx-sidebar max-[700px]:w-40">
          <div className="p-3"><Input icon="search" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" data-autofocus /></div>
          <nav className="hx-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {filtered.map((s) => {
              const g = s.group ?? 'plugins';
              const head = g !== lastGroup ? GROUP_LABEL[g] : null;
              lastGroup = g;
              return (
                <React.Fragment key={s.qid}>
                  {head && <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-hx-muted">{head}</div>}
                  <button type="button" data-settings-section={s.qid} onClick={() => useApp.setState({ settingsSection: s.qid })}
                    className={cx('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px]', current?.qid === s.qid ? 'bg-hx-active font-medium text-hx-primary' : 'text-hx-secondary hover:bg-hx-hover')}>
                    <Icon name={s.icon ?? 'settings'} size={15} /><span className="truncate">{s.title}</span>
                  </button>
                </React.Fragment>
              );
            })}
            {!filtered.length && <div className="px-2.5 py-2 text-[12px] text-hx-muted">No section matches.</div>}
          </nav>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-hx-border-subtle px-6 py-3.5">
            <h2 className="flex-1 text-[16px] font-semibold" data-settings-title>{current?.title}</h2>
            <button type="button" aria-label="Close settings" onClick={close} className="rounded-md p-1.5 text-hx-muted hover:bg-hx-hover hover:text-hx-primary"><Icon name="x" size={16} /></button>
          </div>
          <div className="hx-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4">{current ? <SectionBody s={current} /> : null}</div>
        </div>
      </div>
    </Modal>
  );
}

/** Words that find a native section (its fields are not a schema). */
export const SEARCH_TEXT: Record<string, string> = {};

function SectionBody({ s }: { s: SettingsSection }) {
  if (s.component) {
    const e = useData.getState().registry.active.find((p) => p.name === s.plugin);
    const C = e?.native?.components[s.component] as React.ComponentType<NativeProps> | undefined;
    return C ? <C params={{}} plugin={s.plugin} contribution={s.qid} /> : <EmptyState title="Not available" />;
  }
  return <SchemaSection s={s} />;
}

/** A plugin's settings section from its schema: scope app (this machine), account (the server), operator (locked unless admin). */
function SchemaSection({ s }: { s: SettingsSection }) {
  const prefs = useApp((st) => st.prefs);
  const me = useData((st) => st.me);
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (s.scope === 'app') { const v = prefs.pluginSettings[s.plugin] ?? {}; setValue(v); setSaved(v); return; }
    client.settings.mine().then((m) => { const v = ((m.plugins as Record<string, Record<string, unknown>> | undefined)?.[s.plugin]) ?? {}; setValue(v); setSaved(v); }).catch(() => setSaved({}));
  }, [s.qid]);
  const locked = s.scope === 'operator' && me?.role !== 'admin';
  const save = async () => {
    try {
      if (s.scope === 'app') useApp.getState().setPrefs({ pluginSettings: { ...prefs.pluginSettings, [s.plugin]: value } });
      else { const m = await client.settings.mine(); await client.settings.saveMine({ ...m, plugins: { ...((m.plugins as object) ?? {}), [s.plugin]: value } }); }
      setSaved(value); toast('Saved', { kind: 'success' });
    } catch (e) { toast((e as Error).message, { kind: 'error' }); }
  };
  if (!saved) return <Spinner />;
  return (
    <div data-schema-section={s.qid}>
      <p className="mb-2 text-[12px] text-hx-muted">From the plugin {s.plugin} · {s.scope === 'app' ? 'kept on this computer' : s.scope === 'account' ? 'kept with your account on the server' : 'set by the operator'}</p>
      <SchemaForm schema={s.schema as JsonSchema} value={value} onChange={setValue} disabled={locked} lockedReason={locked ? 'Set by your administrator' : undefined} pickPath={() => desktop.openFolder()} idPrefix={s.qid.replace(/[^a-z0-9]/gi, '-')} />
      {!locked && <div className="mt-4 flex justify-end gap-2"><Button disabled={JSON.stringify(value) === JSON.stringify(saved)} onClick={() => setValue(saved)}>Reset</Button><Button variant="primary" disabled={JSON.stringify(value) === JSON.stringify(saved)} onClick={() => void save()}>Save</Button></div>}
    </div>
  );
}

export function WorkflowDialog(): React.ReactElement | null {
  const req = useApp((s) => s.workflowDialog);
  const [list, setList] = useState<WorkflowInfo[] | null>(null);
  const [name, setName] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionId = req?.sessionId;
  useEffect(() => {
    if (!req) return;
    setErr(''); setList(null);
    if (!sessionId) { setErr('Open a conversation first: a workflow runs inside one.'); setList([]); return; }
    client.sessions.workflows(sessionId).then((r) => {
      setList(r.workflows);
      const w = r.workflows.find((x) => x.name === req.workflow) ?? r.workflows[0];
      if (w) { setName(w.name); setInput({ ...Object.fromEntries(Object.entries(w.inputs).map(([k, v]) => [k, v.default ?? ''])), ...(req.input ?? {}) }); }
    }).catch((e: Error) => { setErr(e.message); setList([]); });
  }, [req]);
  if (!req) return null;
  const close = () => useApp.setState({ workflowDialog: null });
  const w = list?.find((x) => x.name === name);
  const missing = w ? Object.entries(w.inputs).filter(([k, v]) => v.required && !input[k]?.trim()).map(([k]) => k) : [];
  const start = async () => {
    setBusy(true); setErr('');
    try { await client.sessions.startWorkflow(sessionId!, name, input); close(); openSession(sessionId!); toast(`Workflow ${name} started`, { kind: 'success' }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={close} title="Run a workflow" size="lg" footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" loading={busy} disabled={!w || missing.length > 0} onClick={() => void start()} data-start-workflow>Start</Button></>}>
      <div data-workflow-dialog>
        {!list ? <Spinner /> : !list.length ? <p className="text-[13px] text-hx-muted">{err || 'No workflows are installed. Plugins add them, or put JSON graphs in .harness/workflows/.'}</p> : (
          <>
            <Field label="Workflow"><Select value={name} onChange={(v) => { const x = list.find((y) => y.name === v); if (x) { setName(x.name); setInput(Object.fromEntries(Object.entries(x.inputs).map(([k, d]) => [k, d.default ?? '']))); } }} options={list.map((x) => ({ value: x.name, label: `${x.name}${x.source ? ` (${x.source})` : ''}` }))} /></Field>
            {w && <p className="text-[12.5px] text-hx-secondary">{w.description}</p>}
            {w && <p className="mt-1 text-[11.5px] text-hx-muted">{w.nodes.filter((n) => n.type !== 'end').map((n) => n.title ?? n.id).join(' → ')}</p>}
            {w && Object.entries(w.inputs).map(([k, v]) => (
              <Field key={k} label={k} help={v.description} required={v.required}>
                {k === 'request' ? <Textarea rows={5} value={input[k] ?? ''} onChange={(e) => setInput({ ...input, [k]: e.target.value })} /> : <Input value={input[k] ?? ''} onChange={(e) => setInput({ ...input, [k]: e.target.value })} />}
              </Field>
            ))}
            {err && <p className="mt-2 text-[12.5px] text-hx-danger">{err}</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

export function ConfirmHost(): React.ReactElement | null {
  const c = useApp((s) => s.confirm);
  if (!c) return null;
  return <ConfirmDialog open title={c.title} body={<span className="whitespace-pre-wrap">{c.body}</span>} confirmLabel={c.confirmLabel} danger={c.danger} onAnswer={c.resolve} />;
}
