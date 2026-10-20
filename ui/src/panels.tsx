import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, type Capabilities, type CheckpointTurn, type TraceSpan } from './api.ts';
import { fmtCost, fmtTokens, Modal } from './components.tsx';

// Side-panel sections for what the framework adds: what this session can use
// (plugins, skills, agents, MCP), file checkpoints with rewind, and the trace.

export function CapabilitiesPanel({ sessionId }: { sessionId: string }): VNode | null {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api.get<Capabilities>(`/api/sessions/${sessionId}/capabilities`).then(setCaps).catch(() => setCaps(null)); }, [sessionId]);
  if (!caps) return null;
  const mcpTools = caps.mcp.reduce((a, m) => a + m.tools, 0);
  return (
    <div class="panel">
      <div class="panel-title">Capabilities <button class="link small" onClick={() => setOpen(!open)}>{open ? 'less' : 'more'}</button></div>
      <div class="stats">
        <div><span>Tools</span><b>{caps.tools.length}</b></div>
        <div><span>Sub-agents</span><b>{caps.agents.length}</b></div>
        <div><span>Skills</span><b>{caps.skills.length}</b></div>
        <div><span>MCP servers</span><b>{caps.mcp.filter((m) => m.ok).length}/{caps.mcp.length}{mcpTools ? ` · ${mcpTools} tools` : ''}</b></div>
        <div><span>Plugins</span><b>{caps.plugins.length}</b></div>
      </div>
      {caps.mcp.filter((m) => !m.ok).map((m) => <div key={m.name} class="notice notice-warn small">{m.name}: {m.error}</div>)}
      {open && (
        <div class="caps small">
          {caps.plugins.map((p) => <div key={p.name}><b>{p.name}</b> {p.version} <span class="muted">{p.contributes.join(', ')}</span></div>)}
          {caps.agents.map((a) => <div key={a.name}>◈ <b>{a.name}</b> <span class="muted">{a.description}</span></div>)}
          {caps.skills.map((x) => <div key={x.name}>✦ <b>{x.name}</b> <span class="muted">{x.description}</span></div>)}
          <div class="muted">{caps.tools.map((t) => t.name).join(' · ')}</div>
        </div>
      )}
    </div>
  );
}

export function CheckpointsPanel({ sessionId, refreshKey, busy }: { sessionId: string; refreshKey: number; busy: boolean }): VNode | null {
  const [turns, setTurns] = useState<CheckpointTurn[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => api.get<CheckpointTurn[]>(`/api/sessions/${sessionId}/checkpoints`).then(setTurns).catch(() => setTurns([]));
  useEffect(() => { load(); }, [sessionId, refreshKey]);
  if (!turns.length) return null;
  const rewind = async (t: CheckpointTurn) => {
    if (!confirm(`Put ${t.files.length} file(s) back the way they were before turn ${t.turn}? Later file changes are undone too.`)) return;
    try {
      const r = await api.post<{ files: string[] }>(`/api/sessions/${sessionId}/rewind`, { turn: t.turn });
      setMsg(`Restored ${r.files.length} file(s).`);
      load();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div class="panel">
      <div class="panel-title">Checkpoints</div>
      <ul class="checkpoints">
        {[...turns].reverse().map((t) => (
          <li key={t.turn}>
            <div class="cp-head"><b>Turn {t.turn}</b><button class="btn small" disabled={busy} onClick={() => rewind(t)} title="Restore files to before this turn">Rewind</button></div>
            <div class="muted small cp-prompt">{t.prompt}</div>
            <div class="muted small">{t.files.length} file(s): {t.files.slice(0, 4).join(', ')}{t.files.length > 4 ? '…' : ''}</div>
          </li>
        ))}
      </ul>
      {msg && <div class="notice notice-info small">{msg}</div>}
    </div>
  );
}

export function TraceButton({ sessionId }: { sessionId: string }): VNode {
  const [spans, setSpans] = useState<TraceSpan[] | null>(null);
  const open = async () => setSpans(await api.get<TraceSpan[]>(`/api/sessions/${sessionId}/trace`));
  const models = (spans ?? []).filter((s): s is Extract<TraceSpan, { type: 'model' }> => s.type === 'model');
  const tools = (spans ?? []).filter((s): s is Extract<TraceSpan, { type: 'tool' }> => s.type === 'tool');
  const byTool = new Map<string, { n: number; ms: number; errors: number }>();
  for (const t of tools) { const b = byTool.get(t.tool) ?? { n: 0, ms: 0, errors: 0 }; b.n++; b.ms += t.ms; if (t.error) b.errors++; byTool.set(t.tool, b); }
  return (
    <>
      <button class="link small" onClick={open}>Open trace</button>
      {spans && (
        <Modal title="Trace" onClose={() => setSpans(null)} wide>
          <p class="muted small">{models.length} model calls · {Math.round(models.reduce((a, m) => a + m.ms, 0) / 1000)}s · {fmtCost(models.reduce((a, m) => a + m.cost, 0))} · {tools.length} tool calls</p>
          <div class="md-table"><table class="trace">
            <thead><tr><th>#</th><th>agent</th><th>model</th><th>time</th><th>uncached</th><th>cache read</th><th>cache write</th><th>out</th><th>cost</th><th>stop</th></tr></thead>
            <tbody>{models.map((m, i) => (
              <tr key={i} class={m.compaction ? 'compaction-row' : ''}>
                <td>{i + 1}</td><td>{m.agent}</td><td>{m.model}{m.compaction ? ' (compaction)' : ''}</td><td>{(m.ms / 1000).toFixed(1)}s{m.retries ? ` ↻${m.retries}` : ''}</td>
                <td>{fmtTokens(m.usage.input)}</td><td>{fmtTokens(m.usage.cacheRead)}</td><td>{fmtTokens(m.usage.cacheWrite)}</td><td>{fmtTokens(m.usage.output)}</td><td>{fmtCost(m.cost)}</td><td>{m.stop}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div class="md-table"><table class="trace">
            <thead><tr><th>tool</th><th>calls</th><th>total time</th><th>errors</th></tr></thead>
            <tbody>{[...byTool].sort((a, b) => b[1].n - a[1].n).map(([name, b]) => <tr key={name}><td>{name}</td><td>{b.n}</td><td>{(b.ms / 1000).toFixed(1)}s</td><td>{b.errors}</td></tr>)}</tbody>
          </table></div>
        </Modal>
      )}
    </>
  );
}

interface MemoryFileInfo { scope: string; path: string; size: number; modified: number }
interface MemoryListing { scopes: { scope: string; label?: string }[]; mode: string; files: MemoryFileInfo[]; changes: { at: number; session?: string; op: string; path: string }[] }

/** What the agent remembers across sessions: readable, editable and deletable by its owner. */
export function MemoryPanel({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }): VNode | null {
  const [list, setList] = useState<MemoryListing | null>(null);
  const [edit, setEdit] = useState<{ path: string; content: string; isNew?: boolean } | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => api.get<MemoryListing>(`/api/memory?session=${sessionId}`).then(setList).catch(() => setList(null));
  useEffect(() => { load(); }, [sessionId, refreshKey]);
  if (!list) return null;
  const q = (p: string) => `/api/memory/file?session=${sessionId}&path=${encodeURIComponent(p)}`;
  const open = async (p: string) => setEdit({ path: p, content: (await api.get<{ content: string }>(q(p))).content });
  const save = async () => {
    if (!edit) return;
    try { await call('PUT', q(edit.path), { content: edit.content }); setEdit(null); setMsg('Saved.'); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const remove = async (p: string) => {
    if (!confirm(`Delete ${p}? Future sessions will not see it.`)) return;
    try { await api.del(q(p)); setEdit(null); load(); } catch (e) { setMsg((e as Error).message); }
  };
  const project = list.scopes.find((s) => s.scope === 'project');
  return (
    <div class="panel">
      <div class="panel-title">Memory <button class="link small" onClick={() => setEdit({ path: '/memories/user/', content: '', isNew: true })}>add</button></div>
      <div class="muted small">{project ? `This project${project.label ? ` (${project.label})` : ''} and you. ` : 'You. '}{list.mode === 'read' ? 'Agents may read it, not change it.' : 'Agents add to it; you can correct it.'}</div>
      <ul class="memory-files small">
        {list.files.map((f) => <li key={f.path}><button class="link" onClick={() => open(f.path)}>{f.path.replace('/memories/', '')}</button> <span class="muted">{f.size} chars</span></li>)}
        {!list.files.length && <li class="muted">Nothing remembered yet.</li>}
      </ul>
      {list.changes.length > 0 && <div class="muted small">Last change: {list.changes[0]!.op} {list.changes[0]!.path} by {list.changes[0]!.session?.startsWith('user:') ? list.changes[0]!.session.slice(5) : 'an agent'}, {new Date(list.changes[0]!.at).toLocaleString()}</div>}
      {msg && <div class="notice notice-info small">{msg}</div>}
      {edit && (
        <Modal title={edit.isNew ? 'New memory file' : edit.path} onClose={() => setEdit(null)} wide>
          {edit.isNew && <input class="input" value={edit.path} onInput={(e) => setEdit({ ...edit, path: (e.target as HTMLInputElement).value })} placeholder="/memories/user/preferences.md" />}
          <textarea class="input mono" rows={16} value={edit.content} onInput={(e) => setEdit({ ...edit, content: (e.target as HTMLTextAreaElement).value })} />
          <div class="row-end">
            {!edit.isNew && <button class="btn danger" onClick={() => remove(edit.path)}>Delete</button>}
            <button class="btn primary" onClick={save}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface SourceInfo { url: string; finalUrl: string; title?: string; fetchedAt: number; chars: number }

/** Pages read in this session: what citations may point to. */
export function SourcesPanel({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }): VNode | null {
  const [list, setList] = useState<SourceInfo[]>([]);
  useEffect(() => { api.get<SourceInfo[]>(`/api/sessions/${sessionId}/sources`).then(setList).catch(() => setList([])); }, [sessionId, refreshKey]);
  if (!list.length) return null;
  return (
    <div class="panel">
      <div class="panel-title">Sources read ({list.length})</div>
      <ul class="sources small">
        {[...list].reverse().slice(0, 30).map((s) => (
          <li key={s.finalUrl}><a href={s.finalUrl} target="_blank" rel="noopener noreferrer">{s.title || s.finalUrl}</a> <span class="muted">{Math.round(s.chars / 1000)}k chars</span></li>
        ))}
      </ul>
    </div>
  );
}

/** The hosts an allowlist sandbox may reach; changes apply to the next connection. */
export function NetworkPanel({ sessionId }: { sessionId: string }): VNode | null {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get<{ hosts: string[] }>(`/api/sessions/${sessionId}/network`).then((r) => { setHosts(r.hosts); setText(r.hosts.join('\n')); }).catch(() => setHosts(null)); }, [sessionId]);
  if (!hosts) return null;
  const save = async () => {
    try {
      const r = await call('PUT', `/api/sessions/${sessionId}/network`, { hosts: text.split(/[\s,]+/).filter(Boolean) }) as { hosts: string[] };
      setHosts(r.hosts); setText(r.hosts.join('\n')); setMsg('Saved; applies to the next connection.');
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div class="panel">
      <div class="panel-title">Allowed hosts</div>
      <div class="muted small">Commands reach only these hosts, through a proxy. One per line; *.example.com for subdomains, host:port for other ports.</div>
      <textarea class="input mono" rows={5} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      <div class="row-end"><button class="btn small" onClick={save}>Save</button></div>
      {msg && <div class="notice notice-info small">{msg}</div>}
    </div>
  );
}

async function call(method: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-harness': '1' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}
