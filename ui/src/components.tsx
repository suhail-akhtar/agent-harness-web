import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { HarnessEvent, Todo, Usage } from './api.ts';
import { Diff } from './diff.tsx';
import { Markdown } from './markdown.tsx';
import type { Item } from './timeline.ts';
import { summarize } from './timeline.ts';
import { WorkflowCard } from './workflow.tsx';

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtCost = (c: number) => (c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);

const TOOL_ICON: Record<string, string> = { bash: '›_', read: '◧', write: '✎', edit: '✎', glob: '⌕', grep: '⌕', web_fetch: '◍', agent: '◈', todo_write: '☑', ask_user: '?', exit_plan_mode: '▤', skill: '✦', tool_search: '⌕', tool_call: '⇄' };

export function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }): VNode {
  const [open, setOpen] = useState(false);
  const status = item.running ? 'running' : item.isError ? 'error' : 'ok';
  const s = (k: string) => (typeof item.input[k] === 'string' ? (item.input[k] as string) : '');
  return (
    <div class={`tool tool-${status}`}>
      <button class="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span class="tool-icon">{TOOL_ICON[item.name] ?? (item.name.startsWith('mcp__') ? '⇄' : '•')}</span>
        <span class="tool-name">{item.name}</span>
        <span class="tool-sum">{summarize(item.name, item.input)}</span>
        <span class="tool-status">{item.running ? <span class="spinner" /> : item.isError ? '✕' : '✓'}{item.ms !== undefined && !item.running ? <span class="tool-ms">{item.ms < 1000 ? `${item.ms}ms` : `${(item.ms / 1000).toFixed(1)}s`}</span> : null}</span>
      </button>
      {item.name === 'agent' && item.activity.length > 0 && (
        <div class="tool-activity">
          {item.activity.slice(open ? 0 : -4).map((a, i) => <div key={i} class={a.isError ? 'err' : ''}>{a.done ? (a.isError ? '✕' : '✓') : '…'} <b>{a.name}</b> {a.summary}</div>)}
        </div>
      )}
      {item.display?.type === 'diff' && (item.name === 'edit' || !open) && !item.isError && <Diff before={item.display.before} after={item.display.after} />}
      {item.images?.length ? <div class="tool-images">{item.images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} alt={`image ${i + 1} from ${item.name}`} />)}</div> : null}
      {open && (
        <div class="tool-body">
          {item.name === 'bash' && <pre class="cmd">$ {s('command')}</pre>}
          {item.name === 'agent' && <div class="tool-brief"><Markdown text={s('prompt')} /></div>}
          {item.name === 'exit_plan_mode' && <div class="tool-brief"><Markdown text={s('plan')} /></div>}
          {item.name === 'write' && <pre class="out">{s('content').slice(0, 20000)}</pre>}
          {!['bash', 'agent', 'exit_plan_mode', 'write', 'edit'].includes(item.name) && <pre class="in">{JSON.stringify(item.input, null, 2)}</pre>}
          {item.result !== undefined && (item.name === 'agent' ? <div class="tool-brief"><Markdown text={item.result} /></div> : <pre class={`out ${item.isError ? 'err' : ''}`}>{item.result}</pre>)}
        </div>
      )}
    </div>
  );
}

export function AssistantItem({ item }: { item: Extract<Item, { kind: 'assistant' }> }): VNode {
  const [showReasoning, setShowReasoning] = useState(false);
  return (
    <div class="msg msg-assistant">
      {item.reasoning && (
        <div class="reasoning">
          <button class="link" onClick={() => setShowReasoning(!showReasoning)}>{item.streaming && !item.text ? '∴ Thinking…' : showReasoning ? '∴ Hide reasoning' : '∴ Reasoning'}</button>
          {(showReasoning || (item.streaming && !item.text)) && <div class="reasoning-text">{item.reasoning.slice(-6000)}</div>}
        </div>
      )}
      {item.text && <Markdown text={item.text} />}
      {item.streaming && <span class="caret" />}
    </div>
  );
}

export function Timeline({ items }: { items: Item[] }): VNode {
  return (
    <>
      {items.map((it) => {
        switch (it.kind) {
          case 'user': return <div key={it.key} class="msg msg-user"><div class="bubble">{it.text}</div></div>;
          case 'assistant': return <AssistantItem key={it.key} item={it} />;
          case 'tool': return <ToolCard key={it.key} item={it} />;
          case 'notice': return <div key={it.key} class={`notice notice-${it.level}`}>{it.text}</div>;
          case 'workflow': return <WorkflowCard key={it.key} run={it.run} activity={it.activity} />;
          case 'progress': return <div key={it.key} data-progress={it.phase} class={`notice notice-${it.phase === 'stopped' || it.phase === 'flagged' ? 'warn' : 'info'}`} style="white-space: pre-wrap">{it.text}</div>;
          case 'compaction': return <div key={it.key} class="compaction"><span>Context compacted{it.before ? ` · ${fmtTokens(it.before)} → ${fmtTokens(it.after ?? 0)} tokens` : ''}</span></div>;
        }
      })}
    </>
  );
}

type Pending = Extract<HarnessEvent, { kind: 'permission_request' | 'question' | 'plan_proposed' }>;

export function PendingPrompt({ p, respond }: { p: Pending; respond: (body: { requestId: string; decision: string; feedback?: string; answer?: string }) => void }): VNode {
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');
  if (p.kind === 'permission_request') {
    const cmd = typeof p.input.command === 'string' ? p.input.command : null;
    return (
      <div class="prompt prompt-perm">
        <div class="prompt-title">{p.agent ? `${p.agent} wants to` : 'Allow'} <b>{p.tool}</b>?</div>
        {cmd ? <pre class="cmd">$ {cmd}</pre> : <div class="prompt-sum">{p.summary}</div>}
        {(p.tool === 'edit' || p.tool === 'write') && typeof p.input.path === 'string' && (
          p.tool === 'edit'
            ? <Diff before={String(p.input.old_string ?? '')} after={String(p.input.new_string ?? '')} />
            : <pre class="out">{String(p.input.content ?? '').slice(0, 4000)}</pre>
        )}
        <input class="input" placeholder="Optional note to the agent if you deny" value={feedback} onInput={(e) => setFeedback((e.target as HTMLInputElement).value)} />
        <div class="row gap">
          <button class="btn primary" onClick={() => respond({ requestId: p.requestId, decision: 'allow' })}>Allow once</button>
          {p.suggestion && <button class="btn" onClick={() => respond({ requestId: p.requestId, decision: 'allow_always' })}>{p.suggestion === 'edit_all' ? 'Allow all edits this session' : `Always allow ${p.suggestion}`}</button>}
          <button class="btn danger" onClick={() => respond({ requestId: p.requestId, decision: 'deny', feedback: feedback || undefined })}>Deny</button>
        </div>
      </div>
    );
  }
  if (p.kind === 'question') {
    return (
      <div class="prompt prompt-question">
        <div class="prompt-title">{p.question}</div>
        <div class="row gap wrap">{p.options.map((o) => <button key={o} class="btn" onClick={() => respond({ requestId: p.requestId, decision: 'answer', answer: o })}>{o}</button>)}</div>
        <div class="row gap">
          <input class="input grow" placeholder="Or type an answer" value={answer} onInput={(e) => setAnswer((e.target as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && answer.trim()) respond({ requestId: p.requestId, decision: 'answer', answer }); }} />
          <button class="btn primary" disabled={!answer.trim()} onClick={() => respond({ requestId: p.requestId, decision: 'answer', answer })}>Answer</button>
        </div>
      </div>
    );
  }
  return (
    <div class="prompt prompt-plan">
      <div class="prompt-title">The agent proposes this plan</div>
      <div class="plan"><Markdown text={p.plan} /></div>
      <input class="input" placeholder="Feedback if you want changes" value={feedback} onInput={(e) => setFeedback((e.target as HTMLInputElement).value)} />
      <div class="row gap">
        <button class="btn primary" onClick={() => respond({ requestId: p.requestId, decision: 'approve_accept_edits' })}>Approve, auto-accept edits</button>
        <button class="btn" onClick={() => respond({ requestId: p.requestId, decision: 'approve' })}>Approve, review edits</button>
        <button class="btn" onClick={() => respond({ requestId: p.requestId, decision: 'revise', feedback: feedback || 'Please revise the plan.' })}>Keep planning</button>
      </div>
    </div>
  );
}

export function ContextMeter({ used, window: win }: { used: number; window: number }): VNode {
  const pct = win ? Math.min(100, Math.round((used / win) * 100)) : 0;
  return (
    <div class="meter" title={`${used.toLocaleString()} of ${win.toLocaleString()} tokens before automatic compaction`}>
      <div class="meter-bar"><div class={`meter-fill ${pct > 85 ? 'hot' : pct > 60 ? 'warm' : ''}`} style={{ width: `${pct}%` }} /></div>
      <div class="meter-label"><span>Context</span><span>{fmtTokens(used)} / {fmtTokens(win)} · {pct}%</span></div>
    </div>
  );
}

export function UsagePanel({ usage, cost, byModel }: { usage: Usage; cost: number; byModel: Record<string, { usage: Usage; cost: number; requests: number }> }): VNode {
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const hit = prompt ? Math.round((usage.cacheRead / prompt) * 100) : 0;
  return (
    <div class="panel">
      <div class="panel-title">Spend</div>
      <div class="stat-big">{fmtCost(cost)}</div>
      <div class="stats">
        <div><span>Cache hit</span><b class={hit >= 70 ? 'good' : ''}>{hit}%</b></div>
        <div><span>Input (uncached)</span><b>{fmtTokens(usage.input)}</b></div>
        <div><span>Cache reads</span><b>{fmtTokens(usage.cacheRead)}</b></div>
        <div><span>Cache writes</span><b>{fmtTokens(usage.cacheWrite)}</b></div>
        <div><span>Output</span><b>{fmtTokens(usage.output)}</b></div>
      </div>
      {Object.keys(byModel).length > 1 && (
        <div class="stats small">
          {Object.entries(byModel).map(([m, b]) => <div key={m}><span>{m}</span><b>{fmtCost(b.cost)} · {b.requests} calls</b></div>)}
        </div>
      )}
    </div>
  );
}

export function TodoPanel({ todos }: { todos: Todo[] }): VNode | null {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div class="panel">
      <div class="panel-title">Tasks <span class="muted">{done}/{todos.length}</span></div>
      <ul class="todos">
        {todos.map((t, i) => <li key={i} class={`todo-${t.status}`}><span class="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>{t.content}</li>)}
      </ul>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: preact.ComponentChildren; wide?: boolean }): VNode {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="modal-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title}>
        <div class="modal-head"><span>{title}</span><button class="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}
