/**
 * Run a workflow: a ready-made, multi-step process (specialised agents for each step, checks on the work,
 * pauses for the person's approval) started in a conversation. The person finds one (searched, grouped by
 * the plugin that adds it), sees how it runs (its steps in order, who does each, where it waits for them,
 * what repeats), fills in what it needs (choices, suggestions, defaults) and starts it, with tips on what
 * happens next. Opened from a page with no conversation open, it starts one in the folder picked here.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Field, Icon, Input, Modal, Select, Spinner, Textarea, cx, toast } from '@harness/ui';
import type { Effort, Mode, WorkflowInfo, WorkflowNodeView } from '@harness/client';
import type { IconName } from '@harness/plugin-ui';
import { useApp, openSession } from '../state/app';
import { useData, client, clientInfo } from '../state/data';
import { scratchFolder } from '../bridge';

type InputDef = WorkflowInfo['inputs'][string] & { title?: string; enum?: string[]; examples?: string[] };

/** "make-deck" -> "Make deck"; "fix_ci" -> "Fix ci". */
const human = (s: string) => { const w = s.replace(/[_.-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return w.charAt(0).toUpperCase() + w.slice(1); };

const STEP: Record<string, { icon: IconName; label: string }> = {
  agent: { icon: 'robot', label: 'Agent' },
  approval: { icon: 'user', label: 'Your approval' },
  gate: { icon: 'shield', label: 'Quality check' },
  shell: { icon: 'terminal', label: 'Command' },
  code: { icon: 'code', label: 'Script' },
  branch: { icon: 'git-branch', label: 'Decision' },
  parallel: { icon: 'layers', label: 'In parallel' },
  map: { icon: 'list', label: 'For each item' },
};

/** The steps in the order a run meets them (from the start, breadth first); a step that leads back marks a loop. */
function ordered(w: WorkflowInfo): Array<WorkflowNodeView & { repeats: boolean }> {
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  const seen: string[] = [];
  const queue = [w.start ?? w.nodes[0]?.id].filter((x): x is string => !!x);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.includes(id) || !byId.has(id)) continue;
    seen.push(id);
    for (const n of byId.get(id)!.next ?? []) queue.push(n);
  }
  for (const n of w.nodes) if (!seen.includes(n.id)) seen.push(n.id);
  const pos = new Map(seen.map((id, i) => [id, i]));
  return seen.map((id) => byId.get(id)!).filter((n) => n.type !== 'end').map((n) => ({ ...n, repeats: (n.next ?? []).some((x) => (pos.get(x) ?? Infinity) <= (pos.get(n.id) ?? 0)) }));
}

/** The choices an input offers: its enum, else the quoted words of its description when its default is one ("\"manual\" ..., \"auto\" ..."). */
function choicesOf(d: InputDef): string[] | undefined {
  if (d.enum?.length) return d.enum.map(String);
  const quoted = [...(d.description ?? '').matchAll(/"([a-z0-9][a-z0-9 _-]{0,24})"/gi)].map((m) => m[1]!);
  const unique = [...new Set(quoted)];
  return unique.length >= 2 && unique.length <= 5 && d.default !== undefined && unique.includes(d.default) ? unique : undefined;
}

const LONG = /^(brief|request|prompt|task|goal|description|details|context|spec|requirements?|notes?|question|topic|change)$/i;

function InputField({ k, d, value, onChange }: { k: string; d: InputDef; value: string; onChange: (v: string) => void }): React.ReactElement {
  const choices = choicesOf(d);
  const long = LONG.test(k) || (d.default ?? '').length > 60;
  const changed = d.default !== undefined && value !== d.default;
  const help = (
    <span className="flex flex-wrap items-center gap-x-2">
      {d.description && <span>{d.description}</span>}
      {changed && <button type="button" className="text-hx-accent-text hover:underline" onClick={() => onChange(d.default!)} data-reset-input={k}>Reset to default</button>}
    </span>
  );
  return (
    <div data-workflow-input={k}>
      <Field label={d.title ?? human(k)} help={help} required={d.required}>
        {choices ? (
          <div role="radiogroup" aria-label={d.title ?? human(k)} className="inline-flex flex-wrap rounded-lg bg-hx-pill p-0.5">
            {choices.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={value === c} data-input-choice={c} onClick={() => onChange(c)}
                className={cx('h-7 rounded-md px-3 text-[12.5px]', value === c ? 'bg-hx-elevated font-medium text-hx-primary shadow-sm' : 'text-hx-muted hover:text-hx-primary')}>{human(c)}</button>
            ))}
          </div>
        ) : long ? (
          <Textarea rows={4} value={value} placeholder={d.required ? 'Required' : d.default} onChange={(e) => onChange(e.target.value)} />
        ) : (
          <Input value={value} placeholder={d.required ? 'Required' : d.default} onChange={(e) => onChange(e.target.value)} />
        )}
      </Field>
      {d.examples && d.examples.length > 0 && (
        <div className="-mt-1 mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-hx-muted">Suggestions:</span>
          {d.examples.map((x) => <button key={x} type="button" onClick={() => onChange(x)} className={cx('rounded-full border px-2 py-0.5 text-[12px]', value === x ? 'border-hx-accent/40 bg-hx-accent-soft text-hx-accent-text' : 'border-hx-border-subtle text-hx-secondary hover:text-hx-primary')}>{x}</button>)}
        </div>
      )}
    </div>
  );
}

function Steps({ w }: { w: WorkflowInfo }): React.ReactElement {
  const steps = ordered(w);
  return (
    <ol className="relative space-y-0" data-workflow-steps>
      {steps.map((n, i) => {
        const t = STEP[n.type] ?? { icon: 'workflow' as IconName, label: human(n.type) };
        const yours = n.type === 'approval';
        return (
          <li key={n.id} className="relative flex gap-2.5 pb-2.5" data-step={n.id} data-step-type={n.type}>
            {i < steps.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-22px)] w-px bg-hx-border-subtle" aria-hidden />}
            <span className={cx('flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border text-[11px]', yours ? 'border-hx-accent/50 bg-hx-accent-soft text-hx-accent-text' : n.type === 'gate' ? 'border-hx-success/40 bg-hx-success/10 text-hx-success' : 'border-hx-border-subtle bg-hx-elevated text-hx-secondary')}>
              <Icon name={t.icon} size={13} />
            </span>
            <span className="min-w-0 pt-0.5">
              <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-hx-primary">
                <span className="text-hx-muted">{i + 1}.</span>{n.title ?? human(n.id)}
                {yours && <Badge tone="accent">You approve</Badge>}
                {n.repeats && <span className="inline-flex items-center gap-0.5 text-[11px] font-normal text-hx-muted" title="Goes back to an earlier step when its result asks for it"><Icon name="refresh" size={11} />may repeat</span>}
              </span>
              <span className="block text-[11.5px] text-hx-muted">{t.label}{n.agent ? `: ${n.agent}` : ''}{n.model ? ` · ${n.model}` : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Tips({ w, inputs }: { w?: WorkflowInfo; inputs: Record<string, string> }): React.ReactElement {
  const approvals = w?.nodes.filter((n) => n.type === 'approval').length ?? 0;
  const checks = w?.nodes.filter((n) => n.type === 'gate').length ?? 0;
  const files = Object.entries(inputs).filter(([k, v]) => /file|path|output/i.test(k) && v).map(([, v]) => v);
  const tips = [
    'It runs in this conversation: each step appears in its workflow card with what it did, and you can keep chatting meanwhile.',
    approvals ? `It stops ${approvals === 1 ? 'once' : `${approvals} times`} for your approval: answer in the conversation or the Inbox (you can send it back with what to change).` : 'It runs to the end on its own; the result is reported in the conversation.',
    ...(checks ? [`${checks === 1 ? 'A quality check verifies' : `${checks} quality checks verify`} the work before it goes on.`] : []),
    ...(files.length ? [`What it makes is saved in the conversation's folder (${files.join(', ')}).`] : []),
    'Stop it any time with Stop in the composer; a run that waits for you costs nothing meanwhile.',
  ];
  return (
    <div className="rounded-lg border border-hx-border-subtle bg-hx-bg p-3" data-workflow-tips>
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-hx-muted"><Icon name="info" size={12} />What happens when you start it</div>
      <ul className="ml-4 list-disc space-y-0.5 text-[12.5px] text-hx-secondary">{tips.map((t) => <li key={t}>{t}</li>)}</ul>
    </div>
  );
}

const defaultsOf = (w: WorkflowInfo) => Object.fromEntries(Object.entries(w.inputs).map(([k, v]) => [k, v.default ?? '']));
const remember = (name: string) => { try { localStorage.setItem('harness.lastWorkflow', name); } catch { /* private window */ } };
const lastPicked = () => { try { return localStorage.getItem('harness.lastWorkflow') ?? ''; } catch { return ''; } };

export function WorkflowDialog(): React.ReactElement | null {
  const req = useApp((s) => s.workflowDialog);
  const projects = useApp((s) => s.prefs.projects);
  const models = useData((s) => s.models);
  const [list, setList] = useState<WorkflowInfo[] | null>(null);
  const [name, setName] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});
  const [where, setWhere] = useState('');
  const [model, setModel] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const sessionId = req?.sessionId;
  // Opened from a page (a plugin's form, a command) with no conversation open: it runs in a new one,
  // in a folder the person picks; the workflow's inputs are checked once that conversation exists.
  const fresh = !!req && !sessionId;
  useEffect(() => {
    if (!req) return;
    setErr(''); setList(null); setQ('');
    if (!sessionId) {
      if (!req.workflow) { setErr('Open a conversation first: a workflow runs inside one.'); setList([]); return; }
      setName(req.workflow); setInput({ ...(req.input ?? {}) });
      try { setWhere(localStorage.getItem('harness.workIn') ?? ''); } catch { setWhere(''); }
      setModel(useApp.getState().prefs.defaultModel || '');
      return;
    }
    client.sessions.workflows(sessionId).then((r) => {
      setList(r.workflows);
      const w = r.workflows.find((x) => x.name === req.workflow) ?? r.workflows.find((x) => x.name === lastPicked()) ?? r.workflows[0];
      if (w) { setName(w.name); setInput({ ...defaultsOf(w), ...(req.input ?? {}) }); }
    }).catch((e: Error) => { setErr(e.message); setList([]); });
  }, [req]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (list ?? []).filter((w) => !needle || `${w.name} ${w.description} ${w.source ?? ''}`.toLowerCase().includes(needle));
    const by = new Map<string, WorkflowInfo[]>();
    for (const w of hit) by.set(w.source ?? 'This project', [...(by.get(w.source ?? 'This project') ?? []), w]);
    return [...by.entries()];
  }, [list, q]);
  if (!req) return null;
  const close = () => useApp.setState({ workflowDialog: null });
  const w = list?.find((x) => x.name === name);
  const missing = w ? Object.entries(w.inputs).filter(([k, v]) => v.required && !input[k]?.trim()).map(([k, v]) => (v as InputDef).title ?? human(k)) : [];
  const choose = (x: WorkflowInfo) => { setName(x.name); setInput(defaultsOf(x)); setErr(''); };
  const start = async () => {
    if (!w || missing.length) return;
    setBusy(true); setErr('');
    try { await client.sessions.startWorkflow(sessionId!, name, input); remember(name); close(); openSession(sessionId!); toast(`${human(name)} started: follow it in the conversation`, { kind: 'success' }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const startFresh = async () => {
    setBusy(true); setErr('');
    let made: string | undefined;
    try {
      const { prefs, info } = useApp.getState();
      const all = useData.getState().models;
      // The one picked here, else the default, else any that has a key.
      const chosen = all.find((m) => m.id === (model || prefs.defaultModel) && m.available) ?? all.find((m) => m.available);
      if (!chosen) throw new Error('Choose a model first (add a key in Settings > Models & providers).');
      const first = Object.values(input).find((v) => v.trim()) ?? '';
      const path = where || await scratchFolder(info?.scratch);
      const s = await client.sessions.create({ title: `${human(name)}: ${first.replace(/\s+/g, ' ')}`.slice(0, 60), model: chosen.id, ...(prefs.defaultEffort ? { effort: prefs.defaultEffort as Effort } : {}), mode: (prefs.defaultMode || 'default') as Mode, runtime: 'local', ...(path ? { path } : {}), ...(prefs.commandSandbox === 'docker' ? { sandbox: 'docker' } : {}), client: clientInfo() });
      made = s.id;
      const wf = (await client.sessions.workflows(s.id)).workflows.find((x) => x.name === name);
      if (!wf) throw new Error(`There is no workflow "${name}" in that folder.`);
      const values = { ...defaultsOf(wf), ...input };
      const need = Object.entries(wf.inputs).filter(([k, v]) => v.required && !values[k]?.trim()).map(([k]) => human(k));
      if (need.length) throw new Error(`Fill in: ${need.join(', ')}.`);
      useData.getState().upsertSession(s);
      await client.sessions.startWorkflow(s.id, name, values);
      made = undefined;
      remember(name); close(); openSession(s.id); toast(`${human(name)} started`, { kind: 'success' });
    } catch (e) {
      setErr((e as Error).message);
      // Nothing ran in it: the empty conversation is not kept.
      if (made) await client.sessions.remove(made).catch(() => {});
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void (fresh ? startFresh() : start()); } };
  const intro = (
    <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-hx-accent-soft/50 px-3 py-2 text-[12.5px] text-hx-secondary" data-workflow-intro>
      <Icon name="workflow" size={16} className="mt-0.5 shrink-0 text-hx-accent-text" />
      <span>A <b className="text-hx-primary">workflow</b> is a ready-made, multi-step process: specialised agents do each step, checks verify the work, and it waits for you where your approval is needed. Pick one, say what you want, and start it.</span>
    </div>
  );

  if (fresh && name) {
    const options = [{ value: '', label: 'Scratch space' }, ...projects.map((p) => ({ value: p.path, label: p.name }))];
    return (
      <Modal open onClose={close} title={`Run ${human(name)}`} size="lg" footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" icon="play" loading={busy} onClick={() => void startFresh()} data-start-workflow>Start</Button></>}>
        <div data-workflow-dialog data-fresh onKeyDown={onKey}>
          {intro}
          <p className="mb-2 text-[12.5px] text-hx-secondary">It starts in a new conversation.</p>
          <Field label="Work in" help="The folder the workflow reads and changes."><Select value={where} onChange={setWhere} options={options} data-work-in-select /></Field>
          <Field label="Model" help="Runs the workflow's agents unless a step names its own."><Select value={model} onChange={setModel} options={[{ value: '', label: 'The default model' }, ...models.filter((m) => m.available).map((m) => ({ value: m.id, label: m.label ?? m.id }))]} data-workflow-model /></Field>
          {Object.entries(input).map(([k, v]) => <InputField key={k} k={k} d={{ description: undefined }} value={v} onChange={(x) => setInput({ ...input, [k]: x })} />)}
          {err && <p className="mt-2 text-[12.5px] text-hx-danger" role="alert">{err}</p>}
        </div>
      </Modal>
    );
  }

  const footer = (
    <>
      <span className="mr-auto hidden text-[12px] text-hx-muted sm:inline" data-workflow-summary>
        {w ? `${ordered(w).length} step${ordered(w).length === 1 ? '' : 's'}${w.nodes.some((n) => n.type === 'approval') ? ' · waits for your approval' : ''}${missing.length ? ` · fill in ${missing.join(', ')}` : ' · Ctrl+Enter starts'}` : ''}
      </span>
      <Button variant="ghost" onClick={close}>Cancel</Button>
      <Button variant="primary" icon="play" loading={busy} disabled={!w || missing.length > 0} title={missing.length ? `Fill in: ${missing.join(', ')}` : ''} onClick={() => void start()} data-start-workflow>Start</Button>
    </>
  );
  return (
    <Modal open onClose={close} title="Run a workflow" size="xl" footer={footer}>
      <div data-workflow-dialog onKeyDown={onKey}>
        {intro}
        {!list ? <div className="flex justify-center py-10"><Spinner /></div> : !list.length ? (
          <div className="py-8 text-center text-[13px] text-hx-muted">{err || <>No workflows here yet. Plugins add them (Plugins &gt; Catalogue: Studio, Operations, Engineering, DevOps, Documents), or put JSON graphs in <code>.harness/workflows/</code> of the project.</>}</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[250px_1fr]">
            <div className="flex min-h-0 flex-col gap-2" data-workflow-list>
              <Input icon="search" placeholder={list.length === 1 ? 'Search workflows' : `Search ${list.length} workflows`} value={q} onChange={(e) => setQ(e.target.value)} data-workflow-search />
              <div className="hx-scroll max-h-[52vh] space-y-3 overflow-y-auto pr-1">
                {!groups.length && <p className="px-1 text-[12.5px] text-hx-muted">Nothing matches “{q}”.</p>}
                {groups.map(([src, ws]) => (
                  <div key={src}>
                    <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-hx-muted">{human(src)}</div>
                    <div className="space-y-1">
                      {ws.map((x) => (
                        <button key={x.name} type="button" onClick={() => choose(x)} data-workflow-option={x.name} aria-pressed={x.name === name}
                          className={cx('w-full rounded-lg border px-2.5 py-1.5 text-left', x.name === name ? 'border-hx-accent/50 bg-hx-accent-soft/50' : 'border-transparent hover:bg-hx-hover')}>
                          <span className="flex items-center gap-1.5 text-[13px] font-medium text-hx-primary">{human(x.name)}{x.nodes.some((n) => n.type === 'approval') && <Icon name="user" size={11} className="text-hx-accent-text" title="Waits for your approval" />}</span>
                          <span className="line-clamp-2 text-[11.5px] leading-snug text-hx-muted">{x.description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {w ? (
              <div className="hx-scroll min-w-0 max-h-[60vh] space-y-4 overflow-y-auto pr-1" data-workflow-detail={w.name}>
                <div>
                  <div className="flex flex-wrap items-center gap-2"><h3 className="text-[16px] font-semibold text-hx-primary">{human(w.name)}</h3>{w.source && <Badge>{human(w.source)}</Badge>}</div>
                  <p className="mt-1 text-[13px] leading-relaxed text-hx-secondary">{w.description}</p>
                </div>
                <section>
                  <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-hx-muted">How it runs</div>
                  <Steps w={w} />
                </section>
                <section>
                  <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-hx-muted">What it needs</div>
                  {Object.keys(w.inputs).length ? Object.entries(w.inputs).map(([k, d]) => <InputField key={`${w.name}:${k}`} k={k} d={d as InputDef} value={input[k] ?? ''} onChange={(v) => setInput({ ...input, [k]: v })} />)
                    : <p className="text-[12.5px] text-hx-muted">Nothing: it works from the conversation and its folder.</p>}
                </section>
                <Tips w={w} inputs={input} />
                {err && <p className="text-[12.5px] text-hx-danger" role="alert">{err}</p>}
              </div>
            ) : <p className="text-[13px] text-hx-muted">Pick a workflow.</p>}
          </div>
        )}
      </div>
    </Modal>
  );
}
