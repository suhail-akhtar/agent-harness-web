import { render, type VNode } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, type CompanionInfo, type Config, type Effort, type HarnessEvent, type Mode, type SessionDetail, type SessionMeta, type Usage, type WorkflowRunView } from './api.ts';
import { ContextMeter, fmtCost, Modal, PendingPrompt, Timeline, TodoPanel, UsagePanel } from './components.tsx';
import { CapabilitiesPanel, CheckpointsPanel, TraceButton } from './panels.tsx';
import { apply, fromHistory, type Live } from './timeline.ts';
import { ApprovalPrompt, RunsPanel, WorkflowDialog } from './workflow.tsx';

const MODE_LABEL: Record<Mode, string> = { default: 'Ask before edits', acceptEdits: 'Auto-accept edits', plan: 'Plan mode', bypass: 'Bypass permissions' };
const RUNTIME_LABEL = { docker: 'Sandbox', local: 'Server folder', companion: 'My computer' } as const;

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash.slice(1));
  useEffect(() => {
    const on = () => setHash(location.hash.slice(1));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [hash, (h) => { location.hash = h; }];
}

function Login({ onDone }: { onDone: () => void }): VNode {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    try { await api.post('/api/login', { token: token.trim() }); onDone(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div class="login">
      <div class="login-card">
        <div class="brand big"><span class="logo">›_</span> Harness Web</div>
        <p class="muted">Enter the access token printed by the server (or set as HARNESS_TOKEN).</p>
        <input class="input" type="password" autoFocus placeholder="Access token" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <div class="notice notice-error">{err}</div>}
        <button class="btn primary" onClick={submit}>Sign in</button>
      </div>
    </div>
  );
}

function NewSession({ config, onClose, onCreated, onCompanions }: { config: Config; onClose: () => void; onCreated: (id: string) => void; onCompanions: () => void }): VNode {
  const available = config.models.filter((m) => m.available);
  const [model, setModel] = useState(available[0]?.id ?? config.models[0]?.id ?? '');
  const spec = config.models.find((m) => m.id === model);
  const [effort, setEffort] = useState<Effort | ''>('');
  const defaultRuntime = config.runtimes.docker && config.runtimes.dockerImage ? 'docker' : config.companions.length ? 'companion' : config.runtimes.local ? 'local' : 'docker';
  const [runtime, setRuntime] = useState<'docker' | 'local' | 'companion'>(defaultRuntime);
  const [network, setNetwork] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [path, setPath] = useState(config.runtimes.localRoots[0] ?? '');
  const [companionId, setCompanionId] = useState(config.companions.find((c) => c.online)?.id ?? config.companions[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>('default');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const create = async () => {
    setBusy(true); setErr('');
    try {
      const s = await api.post<SessionMeta>('/api/sessions', { model, effort: effort || undefined, runtime, network: network ? 'full' : 'none', gitUrl: gitUrl.trim() || undefined, path: runtime === 'local' ? path : undefined, companionId: runtime === 'companion' ? companionId : undefined, mode });
      onCreated(s.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title="New session" onClose={onClose}>
      <label class="field"><span>Model</span>
        <select class="input" value={model} onChange={(e) => { setModel((e.target as HTMLSelectElement).value); setEffort(''); }}>
          {config.models.map((m) => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}{m.available ? '' : ' (no API key on server)'}</option>)}
        </select>
      </label>
      {spec?.notes && <div class="notice notice-info small">{spec.notes}</div>}
      {spec && (
        <label class="field"><span>Effort</span>
          <select class="input" value={effort || spec.effort} onChange={(e) => setEffort((e.target as HTMLSelectElement).value as Effort)}>
            {spec.efforts.map((x) => <option key={x} value={x}>{x}{x === spec.effort ? ' (default)' : ''}</option>)}
          </select>
        </label>
      )}
      <div class="field"><span>Where the agent works</span>
        <div class="seg">
          {(['docker', 'companion', 'local'] as const).map((r) => (
            <button key={r} class={runtime === r ? 'on' : ''} onClick={() => setRuntime(r)} disabled={r === 'docker' ? !config.runtimes.docker : r === 'local' ? !config.runtimes.local : false}>{RUNTIME_LABEL[r]}</button>
          ))}
        </div>
      </div>
      {runtime === 'docker' && (
        <>
          {!config.runtimes.dockerImage && <div class="notice notice-warn">The sandbox image is not built on the server yet (npm run sandbox:image).</div>}
          <p class="hint">An isolated container per session; commands run inside it, so they don't need approval.</p>
          <label class="field"><span>Clone a git repository (optional)</span><input class="input" placeholder="https://github.com/owner/repo" value={gitUrl} onInput={(e) => setGitUrl((e.target as HTMLInputElement).value)} /></label>
          <label class="check"><input type="checkbox" checked={network} onChange={(e) => setNetwork((e.target as HTMLInputElement).checked)} /> Allow network access from commands (package installs)</label>
        </>
      )}
      {runtime === 'companion' && (
        config.companions.length ? (
          <label class="field"><span>Computer</span>
            <select class="input" value={companionId} onChange={(e) => setCompanionId((e.target as HTMLSelectElement).value)}>
              {config.companions.map((c) => <option key={c.id} value={c.id}>{c.name} {c.online ? `· online · ${c.info?.root ?? ''}` : '· offline'}</option>)}
            </select>
          </label>
        ) : <div class="notice notice-info">No computer connected yet. <button class="link" onClick={onCompanions}>Connect one</button></div>
      )}
      {runtime === 'local' && (
        <label class="field"><span>Folder on the server (under {config.runtimes.localRoots.join(', ')})</span><input class="input" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} /></label>
      )}
      <label class="field"><span>Permissions</span>
        <select class="input" value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as Mode)}>
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
        </select>
      </label>
      {err && <div class="notice notice-error">{err}</div>}
      <div class="row gap end">
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn primary" disabled={busy || !spec?.available || (runtime === 'companion' && !companionId)} onClick={create}>{busy ? 'Creating…' : 'Create session'}</button>
      </div>
    </Modal>
  );
}

function Companions({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }): VNode {
  const [list, setList] = useState<CompanionInfo[]>([]);
  const [name, setName] = useState('My computer');
  const [created, setCreated] = useState<{ token: string } | null>(null);
  const load = () => api.get<CompanionInfo[]>('/api/companions').then(setList).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const origin = location.origin;
  return (
    <Modal title="Your computers" onClose={() => { onChanged(); onClose(); }} wide>
      <p class="hint">A companion lets the agent work on a folder on your own computer. It connects out to this server (no open ports) and only touches the folder you start it in. Needs Node.js 18+.</p>
      {list.map((c) => (
        <div key={c.id} class="row gap companion">
          <span class={`dot ${c.online ? 'on' : ''}`} /><b>{c.name}</b><span class="muted grow">{c.online ? `${c.info?.platform} · ${c.info?.root}` : 'offline'}</span>
          <button class="btn small danger" onClick={async () => { await api.del(`/api/companions/${c.id}`); load(); }}>Remove</button>
        </div>
      ))}
      {created ? (
        <div class="panel">
          <div class="panel-title">Run this in the folder you want the agent to work in</div>
          <pre class="cmd copyable">{`curl -fsSL -o harness-companion.mjs ${origin}/companion.mjs\nnode harness-companion.mjs --server ${origin} --token ${created.token}`}</pre>
          <p class="hint">The token is shown once. Treat it like a password: it lets this server run commands in that folder.</p>
        </div>
      ) : (
        <div class="row gap">
          <input class="input grow" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button class="btn primary" onClick={async () => { const c = await api.post<{ id: string; token: string }>('/api/companions', { name }); setCreated(c); load(); }}>Connect a computer</button>
        </div>
      )}
    </Modal>
  );
}

function FilesPanel({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }): VNode | null {
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null);
  const [view, setView] = useState<{ path: string; content: string | null; note?: string } | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    api.get<{ type: string; files: { path: string; size: number }[] }>(`/api/sessions/${sessionId}/files?path=.`).then((r) => setFiles(r.files)).catch(() => setFiles(null));
  }, [sessionId, refreshKey]);
  if (!files) return null;
  const shown = files.filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())).slice(0, 300);
  return (
    <div class="panel">
      <div class="panel-title">Files <span class="muted">{files.length}</span></div>
      {files.length > 12 && <input class="input small" placeholder="Filter" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />}
      <ul class="files">
        {shown.map((f) => <li key={f.path}><button class="link" onClick={async () => setView(await api.get(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(f.path)}`))}>{f.path}</button></li>)}
      </ul>
      {view && (
        <Modal title={view.path} onClose={() => setView(null)} wide>
          {view.content === null ? <p class="muted">{view.note}</p> : <pre class="file-view">{view.content}</pre>}
        </Modal>
      )}
    </div>
  );
}

function SessionView({ id, config, onMeta }: { id: string; config: Config; onMeta: (m: SessionMeta) => void }): VNode {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'waiting'>('idle');
  const [live, setLive] = useState<Live>({ items: [], contextTokens: 0, contextWindow: 0 });
  const [pending, setPending] = useState<HarnessEvent[]>([]);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [filesKey, setFilesKey] = useState(0);
  const [showSide, setShowSide] = useState(false);
  const [wfDialog, setWfDialog] = useState(false);
  const [runsKey, setRunsKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const metaRef = useRef<SessionMeta | null>(null);

  useEffect(() => {
    let es: EventSource | undefined;
    let stopped = false;
    setLive({ items: [], contextTokens: 0, contextWindow: 0 });
    setPending([]);
    api.get<SessionDetail>(`/api/sessions/${id}`).then((d) => {
      if (stopped) return;
      const spec = config.models.find((m) => m.id === d.meta.model);
      metaRef.current = d.meta;
      setMeta(d.meta);
      setStatus(d.status);
      setPending(d.pending);
      setLive({ items: fromHistory(d.history), contextTokens: d.meta.lastPromptTokens, contextWindow: spec?.compactAt ?? 0 });
      // A run still going when the page opens gets its card back (finished ones are in the runs panel).
      api.get<{ runs: WorkflowRunView[] }>(`/api/sessions/${id}/workflows`).then((r) => {
        if (stopped) return;
        for (const run of r.runs.filter((x) => x.status === 'running' || x.status === 'waiting')) setLive((l) => apply(l, { kind: 'workflow', phase: 'started', run }));
      }).catch(() => {});
      es = new EventSource(`/api/sessions/${id}/events?after=${d.lastSeq}`);
      es.onmessage = (msg) => {
        const { event } = JSON.parse(msg.data) as { event: HarnessEvent };
        setLive((l) => apply(l, event));
        switch (event.kind) {
          case 'status': setStatus(event.status); break;
          case 'permission_request': case 'question': case 'plan_proposed': case 'approval_request': setPending((p) => [...p.filter((x) => (x as { requestId: string }).requestId !== event.requestId), event]); break;
          case 'request_resolved': setPending((p) => p.filter((x) => (x as { requestId: string }).requestId !== event.requestId)); break;
          case 'usage': {
            const m = metaRef.current;
            if (m) {
              const u = m.usage;
              const add: Usage = { input: u.input + event.usage.input, cacheRead: u.cacheRead + event.usage.cacheRead, cacheWrite: u.cacheWrite + event.usage.cacheWrite, output: u.output + event.usage.output, reasoning: u.reasoning + event.usage.reasoning };
              const b = m.byModel[event.model] ?? { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, cost: 0, requests: 0 };
              const next = { ...m, usage: add, cost: m.cost + event.cost, byModel: { ...m.byModel, [event.model]: { usage: b.usage, cost: b.cost + event.cost, requests: b.requests + 1 } } };
              metaRef.current = next; setMeta(next); onMeta(next);
            }
            break;
          }
          case 'todos': if (metaRef.current) { metaRef.current = { ...metaRef.current, todos: event.todos }; setMeta(metaRef.current); } break;
          case 'mode': if (metaRef.current) { metaRef.current = { ...metaRef.current, mode: event.mode }; setMeta(metaRef.current); } break;
          case 'tool_result': if (['write', 'edit', 'bash'].includes(event.name)) setFilesKey((k) => k + 1); break;
          case 'notice': if (/^Rewound/.test(event.text)) setFilesKey((k) => k + 1); break;
          case 'workflow': if (event.phase !== 'node_started') setRunsKey((k) => k + 1); if (event.phase === 'node_finished') setFilesKey((k) => k + 1); break;
          case 'turn_end': if (!event.agent) api.get<SessionDetail>(`/api/sessions/${id}`).then((d) => { metaRef.current = d.meta; setMeta(d.meta); onMeta(d.meta); }).catch(() => {}); break;
        }
      };
    }).catch((e) => setErr((e as Error).message));
    return () => { stopped = true; es?.close(); };
  }, [id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [live.items, pending]);

  const sendMsg = async () => {
    const t = text.trim();
    if (!t) return;
    setText(''); setErr('');
    stick.current = true;
    try { await api.post(`/api/sessions/${id}/messages`, { text: t }); } catch (e) { setErr((e as Error).message); setText(t); }
  };
  const patch = async (b: Record<string, unknown>) => {
    try { const m = await api.patch<SessionMeta>(`/api/sessions/${id}`, b); metaRef.current = m; setMeta(m); onMeta(m); } catch (e) { setErr((e as Error).message); }
  };
  const respond = useCallback((b: { requestId: string; decision: string; feedback?: string; answer?: string }) => {
    setPending((p) => p.filter((x) => (x as { requestId: string }).requestId !== b.requestId));
    api.post(`/api/sessions/${id}/respond`, b).catch((e) => setErr((e as Error).message));
  }, [id]);

  if (!meta) return <div class="empty">{err || 'Loading…'}</div>;
  const spec = config.models.find((m) => m.id === meta.model);
  const busy = status !== 'idle';
  return (
    <div class="session">
      <div class="chat">
        <div class="chat-head">
          <input class="title-input" value={meta.title} onChange={(e) => patch({ title: (e.target as HTMLInputElement).value })} aria-label="Session title" />
          <span class={`badge rt-${meta.runtime.kind}`}>{RUNTIME_LABEL[meta.runtime.kind]}{meta.runtime.kind === 'docker' ? (meta.runtime.network === 'full' ? ' · net' : ' · offline') : ''}</span>
          <span class={`status status-${status}`}>{status === 'running' ? 'Working' : status === 'waiting' ? 'Needs you' : 'Idle'}</span>
          <button class="icon-btn side-toggle" onClick={() => setShowSide(!showSide)} aria-label="Session details">☰</button>
        </div>
        <div class="timeline" ref={scroller} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          {live.items.length === 0 && <div class="empty-chat"><div class="logo big">›_</div><p>Describe a task. The agent reads, edits, runs and verifies in its workspace.</p></div>}
          <Timeline items={live.items} />
          {live.retry && <div class="notice notice-warn">{live.retry}</div>}
          {pending.map((p) => p.kind === 'approval_request'
            ? <ApprovalPrompt key={p.requestId} p={p} respond={respond} />
            : <PendingPrompt key={(p as { requestId: string }).requestId} p={p as never} respond={respond} />)}
        </div>
        <div class="composer">
          {err && <div class="notice notice-error">{err}</div>}
          <textarea class="input" rows={3} placeholder={busy ? 'Add a message for the agent (it sees it at its next step)…' : 'Ask for a change, a fix, an investigation…  (Enter to send, Shift+Enter for a new line)'} value={text}
            onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); } }} />
          <div class="row gap composer-bar">
            <select class="input small" value={meta.model} onChange={(e) => patch({ model: (e.target as HTMLSelectElement).value })} title="Model">
              {config.models.map((m) => <option key={m.id} value={m.id} disabled={!m.available}>{m.label}</option>)}
            </select>
            {spec && <select class="input small" value={meta.effort} onChange={(e) => patch({ effort: (e.target as HTMLSelectElement).value })} title="Reasoning effort">
              {spec.efforts.map((x) => <option key={x} value={x}>effort: {x}</option>)}
            </select>}
            <select class={`input small mode-${meta.mode}`} value={meta.mode} onChange={(e) => patch({ mode: (e.target as HTMLSelectElement).value })} title="Permission mode">
              {(Object.keys(MODE_LABEL) as Mode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
            <span class="grow" />
            {!busy && <button class="btn" onClick={() => setWfDialog(true)} title="Run a multi-step workflow (e.g. requirements to delivery)">Workflow…</button>}
            {busy && <button class="btn danger" onClick={() => api.post(`/api/sessions/${id}/abort`)}>Stop</button>}
            <button class="btn primary" disabled={!text.trim()} onClick={sendMsg}>{busy ? 'Queue' : 'Send'}</button>
          </div>
        </div>
      </div>
      <aside class={`side ${showSide ? 'open' : ''}`}>
        <ContextMeter used={live.contextTokens} window={live.contextWindow || spec?.compactAt || 0} />
        <UsagePanel usage={meta.usage} cost={meta.cost} byModel={meta.byModel} />
        <TodoPanel todos={meta.todos} />
        <RunsPanel sessionId={id} refreshKey={runsKey} busy={busy} />
        <CapabilitiesPanel sessionId={id} />
        {meta.runtime.kind !== 'companion' && <CheckpointsPanel sessionId={id} refreshKey={filesKey} busy={busy} />}
        {meta.runtime.kind !== 'companion' && <FilesPanel sessionId={id} refreshKey={filesKey} />}
        <div class="panel muted small">
          {meta.compactions ? <div>Compacted {meta.compactions}×</div> : null}
          <div>Session {meta.id} · <TraceButton sessionId={id} /></div>
          <button class="link danger" onClick={async () => { if (confirm('Delete this session and its workspace?')) { await api.del(`/api/sessions/${id}`); location.hash = ''; } }}>Delete session</button>
        </div>
      </aside>
      {wfDialog && <WorkflowDialog sessionId={id} onClose={() => setWfDialog(false)} onStarted={() => { setWfDialog(false); stick.current = true; }} />}
    </div>
  );
}

function App(): VNode {
  const [config, setConfig] = useState<Config | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [hash, setHash] = useHash();
  const [dialog, setDialog] = useState<'new' | 'companions' | null>(null);
  const [menu, setMenu] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      setConfig(await api.get<Config>('/api/config'));
      setSessions(await api.get<SessionMeta[]>('/api/sessions'));
      setNeedLogin(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedLogin(true);
      else setErr((e as Error).message);
    }
  };
  useEffect(() => { load(); const t = setInterval(() => api.get<SessionMeta[]>('/api/sessions').then(setSessions).catch(() => {}), 10_000); return () => clearInterval(t); }, []);

  if (needLogin) return <Login onDone={load} />;
  if (!config) return <div class="empty">{err || 'Loading…'}</div>;
  const current = sessions.find((s) => s.id === hash);
  const total = sessions.reduce((a, s) => a + s.cost, 0);
  return (
    <div class="app">
      <nav class={`sidebar ${menu ? 'open' : ''}`}>
        <div class="brand"><span class="logo">›_</span> Harness Web</div>
        <button class="btn primary block" onClick={() => setDialog('new')}>+ New session</button>
        <div class="sessions">
          {sessions.map((s) => (
            <a key={s.id} href={`#${s.id}`} class={`sess ${s.id === hash ? 'active' : ''}`} onClick={() => setMenu(false)}>
              <span class={`dot ${s.status === 'running' ? 'run' : s.status === 'waiting' ? 'wait' : ''}`} />
              <span class="sess-title">{s.title}</span>
              <span class="sess-meta">{s.model.replace('claude-', '')} · {fmtCost(s.cost)}</span>
            </a>
          ))}
          {!sessions.length && <p class="muted small pad">No sessions yet.</p>}
        </div>
        <div class="sidebar-foot">
          <button class="link" onClick={() => setDialog('companions')}>Your computers ({config.companions.filter((c) => c.online).length} online)</button>
          <div class="muted small">All sessions: {fmtCost(total)}</div>
        </div>
      </nav>
      <main class="main">
        <button class="icon-btn menu-toggle" onClick={() => setMenu(!menu)} aria-label="Sessions">☰</button>
        {current || hash ? <SessionView key={hash} id={hash} config={config} onMeta={(m) => setSessions((list) => list.map((s) => (s.id === m.id ? { ...s, ...m } : s)))} />
          : (
            <div class="welcome">
              <div class="logo big">›_</div>
              <h1>Harness Web</h1>
              <p class="muted">One model-driven loop, cache-first context, tools in a sandbox or on your machine.</p>
              <div class="model-cards">
                {config.models.map((m) => <div key={m.id} class={`model-card ${m.available ? '' : 'off'}`}><b>{m.label}</b><span>{m.available ? `${Math.round(m.contextWindow / 1000)}k context` : 'no API key on server'}</span></div>)}
              </div>
              <button class="btn primary" onClick={() => setDialog('new')}>Start a session</button>
            </div>
          )}
      </main>
      {dialog === 'new' && <NewSession config={config} onClose={() => setDialog(null)} onCompanions={() => setDialog('companions')} onCreated={(id) => { setDialog(null); load(); setHash(id); }} />}
      {dialog === 'companions' && <Companions onClose={() => setDialog(null)} onChanged={load} />}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
