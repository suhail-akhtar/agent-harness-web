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
