import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type HarnessEvent, type WorkflowInfo, type WorkflowRunView } from './api.ts';
import { fmtCost, Modal } from './components.tsx';
import { Markdown } from './markdown.tsx';
import type { Activity } from './timeline.ts';

const TYPE_ICON: Record<string, string> = { agent: '◆', gate: '▣', approval: '✋', shell: '$', parallel: '⫴', code: 'ƒ', branch: '⑂', end: '■' };
const RUN_LABEL: Record<string, string> = { running: 'Running', waiting: 'Needs you', succeeded: 'Succeeded', failed: 'Failed', aborted: 'Stopped', interrupted: 'Interrupted' };

const dur = (a: number, b?: number) => {
  const s = Math.round(((b ?? Date.now()) - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** A workflow run in the timeline: one row per step taken, with live activity for the running ones. */
export function WorkflowCard({ run, activity }: { run: WorkflowRunView; activity: Record<string, Activity[]> }): VNode {
  const [open, setOpen] = useState<number | null>(null);
  const title = (id: string) => run.nodes.find((n) => n.id === id)?.title ?? id;
  const live = run.status === 'running' || run.status === 'waiting';
  return (
    <div class={`wf wf-${run.status}`}>
      <div class="wf-head">
        <span class="wf-icon">⑂</span>
        <b>{run.workflow}</b>
        <span class={`wf-status wf-status-${run.status}`}>{live && <span class="spinner" />}{RUN_LABEL[run.status] ?? run.status}</span>
        <span class="grow" />
        <span class="muted small">{run.history.length} steps · {fmtCost(run.cost)}</span>
      </div>
      <ol class="wf-steps">
        {run.history.map((h, i) => {
          const acts = h.status === 'running' ? activity[h.node] ?? [] : [];
          const expandable = !!h.summary && h.type !== 'end' && h.type !== 'branch';
          return (
            <li key={i} class={`wf-step wf-step-${h.status}`}>
              <button class="wf-step-head" disabled={!expandable} onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                <span class="wf-step-icon">{h.status === 'running' ? <span class="spinner" /> : h.status === 'failed' ? '✕' : h.status === 'waiting' ? '…' : h.status === 'interrupted' ? '⏸' : TYPE_ICON[h.type] ?? '•'}</span>
                <span class="wf-step-title">{title(h.node)}</span>
                {h.outcome && <span class={`wf-outcome ${/REQUEST|REJECT|FAIL|CHANGES|BLOCK|exhausted|reject/.test(h.outcome) ? 'neg' : /pass|APPROVE|approve|all/.test(h.outcome) ? 'pos' : ''}`}>{h.outcome}</span>}
                <span class="grow" />
                <span class="muted small">{h.cost ? `${fmtCost(h.cost)} · ` : ''}{dur(h.startedAt, h.endedAt)}</span>
              </button>
              {acts.length > 0 && (
                <div class="tool-activity">
                  {acts.slice(-4).map((a, j) => <div key={j} class={a.isError ? 'err' : ''}>{a.done ? (a.isError ? '✕' : '✓') : '…'} <b>{a.name}</b> {a.summary}</div>)}
                </div>
              )}
              {open === i && h.summary && <div class="wf-summary">{h.type === 'gate' ? <pre class="out">{h.summary}</pre> : <Markdown text={h.summary} />}</div>}
            </li>
          );
        })}
      </ol>
      {run.error && <div class="notice notice-error">{run.error}</div>}
    </div>
  );
}

type Approval = Extract<HarnessEvent, { kind: 'approval_request' }>;

/** A workflow's approval step: the reviewer sees the message and the named files, then approves or sends it back. */
export function ApprovalPrompt({ p, respond }: { p: Approval; respond: (b: { requestId: string; decision: string; feedback?: string }) => void }): VNode {
  const [feedback, setFeedback] = useState('');
  const [file, setFile] = useState(0);
  const f = p.files[file];
  return (
    <div class="prompt prompt-approval">
      <div class="prompt-title">{p.title}</div>
      <div class="plan"><Markdown text={p.message} /></div>
      {p.files.length > 0 && (
        <div class="approval-files">
          <div class="row gap wrap">{p.files.map((x, i) => <button key={x.path} class={`btn small ${i === file ? 'primary' : ''}`} onClick={() => setFile(i)}>{x.path}</button>)}</div>
          {f && <div class="plan approval-file"><Markdown text={f.path.endsWith('.md') ? f.content : '```\n' + f.content + '\n```'} /></div>}
        </div>
      )}
      <textarea class="input" rows={2} placeholder="What to change, if you send it back" value={feedback} onInput={(e) => setFeedback((e.target as HTMLTextAreaElement).value)} />
      <div class="row gap">
        <button class="btn primary" onClick={() => respond({ requestId: p.requestId, decision: 'approve', feedback: feedback || undefined })}>Approve</button>
        <button class="btn danger" disabled={!feedback.trim()} title={feedback.trim() ? '' : 'Say what to change'} onClick={() => respond({ requestId: p.requestId, decision: 'reject', feedback })}>Send back</button>
      </div>
    </div>
  );
}

/** Picks a workflow and fills its inputs. */
export function WorkflowDialog({ sessionId, onClose, onStarted }: { sessionId: string; onClose: () => void; onStarted: () => void }): VNode {
  const [list, setList] = useState<WorkflowInfo[] | null>(null);
  const [name, setName] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ workflows: WorkflowInfo[] }>(`/api/sessions/${sessionId}/workflows`).then((r) => { setList(r.workflows); if (r.workflows[0]) pick(r.workflows[0]); }).catch((e) => setErr((e as Error).message));
  }, [sessionId]);
  const pick = (w: WorkflowInfo) => { setName(w.name); setInput(Object.fromEntries(Object.entries(w.inputs).map(([k, v]) => [k, v.default ?? '']))); };
  const w = list?.find((x) => x.name === name);
  const missing = w ? Object.entries(w.inputs).filter(([k, v]) => v.required && !input[k]?.trim()).map(([k]) => k) : [];
  const start = async () => {
    setBusy(true); setErr('');
    try { await api.post(`/api/sessions/${sessionId}/workflows`, { name, input }); onStarted(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Run a workflow" onClose={onClose} wide>
      {!list ? <p class="muted">{err || 'Loading…'}</p> : !list.length ? <p class="muted">No workflows are installed. Plugins add them, or put JSON graphs in .harness/workflows/.</p> : (
        <>
          <label class="field"><span>Workflow</span>
            <select class="input" value={name} onChange={(e) => { const x = list.find((y) => y.name === (e.target as HTMLSelectElement).value); if (x) pick(x); }}>
              {list.map((x) => <option key={x.name} value={x.name}>{x.name}{x.source ? ` (${x.source})` : ''}</option>)}
            </select>
          </label>
          {w && <p class="hint">{w.description}</p>}
          {w && <p class="muted small wf-path">{w.nodes.filter((n) => n.type !== 'end').map((n) => n.title ?? n.id).join(' → ')}</p>}
          {w && Object.entries(w.inputs).map(([k, v]) => (
            <label key={k} class="field"><span>{k}{v.required ? ' *' : ''}{v.description ? <span class="muted"> — {v.description}</span> : null}</span>
              {k === 'request'
                ? <textarea class="input" rows={6} value={input[k] ?? ''} onInput={(e) => setInput({ ...input, [k]: (e.target as HTMLTextAreaElement).value })} />
                : <input class="input" value={input[k] ?? ''} onInput={(e) => setInput({ ...input, [k]: (e.target as HTMLInputElement).value })} />}
            </label>
          ))}
        </>
      )}
      {err && list && <div class="notice notice-error">{err}</div>}
      <div class="row gap end">
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn primary" disabled={busy || !w || missing.length > 0} onClick={start}>{busy ? 'Starting…' : 'Start'}</button>
      </div>
    </Modal>
  );
}

/** The session's workflow runs, with resume for the ones that stopped. */
export function RunsPanel({ sessionId, refreshKey, busy }: { sessionId: string; refreshKey: number; busy: boolean }): VNode | null {
  const [runs, setRuns] = useState<WorkflowRunView[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { api.get<{ runs: WorkflowRunView[] }>(`/api/sessions/${sessionId}/workflows`).then((r) => setRuns(r.runs)).catch(() => {}); }, [sessionId, refreshKey]);
  if (!runs.length) return null;
  return (
    <div class="panel">
      <div class="panel-title">Workflow runs <span class="muted">{runs.length}</span></div>
      {runs.slice(0, 8).map((r) => (
        <div key={r.id} class="row gap run-row">
          <span class={`wf-status wf-status-${r.status}`}>{RUN_LABEL[r.status] ?? r.status}</span>
          <span class="grow small">{r.workflow}<span class="muted"> · {r.history.length} steps · {fmtCost(r.cost)}</span></span>
          {['interrupted', 'aborted', 'failed'].includes(r.status) && r.current && (
            <button class="btn small" disabled={busy} title={`Resume at ${r.current}`} onClick={() => api.post(`/api/sessions/${sessionId}/runs/${r.id}/resume`).catch((e) => setErr((e as Error).message))}>Resume</button>
          )}
        </div>
      ))}
      {err && <div class="notice notice-error">{err}</div>}
    </div>
  );
}
