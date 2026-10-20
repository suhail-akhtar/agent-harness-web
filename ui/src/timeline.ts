import type { HarnessEvent, ImageData, Message, ToolDisplay, WorkflowRunView } from './api.ts';

// The chat view is a list of items rebuilt from the stored history, then kept
// current by live events. Pure functions, so they are easy to test.

export type Item =
  | { kind: 'user'; key: string; text: string }
  | { kind: 'assistant'; key: string; text: string; reasoning: string; streaming: boolean }
  | { kind: 'tool'; key: string; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; display?: ToolDisplay; ms?: number; running: boolean; activity: Activity[]; images?: ImageData[] }
  | { kind: 'notice'; key: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'compaction'; key: string; before?: number; after?: number }
  | { kind: 'workflow'; key: string; run: WorkflowRunView; activity: Record<string, Activity[]> };

export interface Activity { name: string; summary: string; isError?: boolean; done: boolean }

let n = 0;
const key = () => `k${++n}`;

/** Strips the harness's own context blocks from a user message for display. */
export function visibleUserText(text: string): string {
  return text
    .replace(/<environment>[\s\S]*?<\/environment>/g, '')
    .replace(/<project_instructions[\s\S]*?<\/project_instructions>/g, '')
    .replace(/<session_start_context>[\s\S]*?<\/session_start_context>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

export function fromHistory(history: Message[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: 'tool' }>>();
  for (const m of history) {
    if (m.compactionSummary) { items.push({ kind: 'compaction', key: key() }); continue; }
    if (m.role === 'user') {
      let lastTool: Extract<Item, { kind: 'tool' }> | undefined;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const t = tools.get(b.tool_use_id);
          if (t) { t.result = b.content; t.isError = !!b.is_error; t.running = false; if (b.images?.length) t.images = b.images; lastTool = t; }
        } else if (b.type === 'image') {
          if (lastTool) (lastTool.images ??= []).push({ media_type: b.media_type, data: b.data });
        } else if (b.type === 'text') {
          if (/^Image\(s\) from /.test(b.text)) continue;
          const added = /^The user added while you were working:\n/.exec(b.text);
          const text = added ? b.text.slice(added[0].length) : visibleUserText(b.text);
          if (text) items.push({ kind: 'user', key: key(), text });
        }
      }
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const reasoning = m.content.filter((b) => b.type === 'reasoning').map((b) => (b as { text: string }).text).join('\n');
      if (text || reasoning) items.push({ kind: 'assistant', key: key(), text, reasoning, streaming: false });
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          const t: Extract<Item, { kind: 'tool' }> = { kind: 'tool', key: key(), id: b.id, name: b.name, input: b.input, running: false, activity: [] };
          tools.set(b.id, t);
          items.push(t);
        }
      }
    }
  }
  return items;
}

export interface Live {
  items: Item[];
  contextTokens: number;
  contextWindow: number;
  retry?: string;
}

const isSub = (agent?: string) => !!agent && agent !== 'main';

/** Applies one live event. Returns a new array when items change (for rendering). */
export function apply(live: Live, e: HarnessEvent): Live {
  const items = live.items;
  const last = items[items.length - 1];
  switch (e.kind) {
    case 'user_message':
      return { ...live, items: [...items, { kind: 'user', key: key(), text: e.text }] };
    case 'text_delta':
    case 'reasoning_delta': {
      if (isSub(e.agent)) return live;
      const field = e.kind === 'text_delta' ? 'text' : 'reasoning';
      if (last?.kind === 'assistant' && last.streaming) {
        const next = { ...last, [field]: last[field] + e.text };
        return { ...live, retry: undefined, items: [...items.slice(0, -1), next] };
      }
      return { ...live, retry: undefined, items: [...items, { kind: 'assistant', key: key(), text: field === 'text' ? e.text : '', reasoning: field === 'reasoning' ? e.text : '', streaming: true }] };
    }
    case 'assistant_message': {
      if (isSub(e.agent)) return live;
      const text = e.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const reasoning = e.message.content.filter((b) => b.type === 'reasoning').map((b) => (b as { text: string }).text).join('\n');
      const idx = findLastIndex(items, (i) => i.kind === 'assistant' && i.streaming);
      if (idx >= 0) {
        const copy = items.slice();
        if (!text && !reasoning) copy.splice(idx, 1);
        else copy[idx] = { kind: 'assistant', key: items[idx]!.key, text, reasoning, streaming: false };
        return { ...live, items: copy };
      }
      if (!text && !reasoning) return live;
      return { ...live, items: [...items, { kind: 'assistant', key: key(), text, reasoning, streaming: false }] };
    }
    case 'workflow': {
      const idx = findLastIndex(items, (i) => i.kind === 'workflow' && i.run.id === e.run.id);
      if (idx < 0) return { ...live, items: [...items, { kind: 'workflow', key: key(), run: e.run, activity: {} }] };
      const copy = items.slice();
      copy[idx] = { ...(copy[idx] as Extract<Item, { kind: 'workflow' }>), run: e.run };
      return { ...live, items: copy };
    }
    case 'tool_call': {
      if (isSub(e.agent)) return withActivity(live, e.agent!, (a) => [...a, { name: e.name, summary: summarize(e.name, e.input), done: false }]);
      return { ...live, items: [...items, { kind: 'tool', key: key(), id: e.id, name: e.name, input: e.input, running: true, activity: [] }] };
    }
    case 'tool_result': {
      if (isSub(e.agent)) {
        return withActivity(live, e.agent!, (a) => {
          const i = findLastIndex(a, (x) => x.name === e.name && !x.done);
          if (i < 0) return a;
          const copy = a.slice();
          copy[i] = { ...copy[i]!, done: true, isError: e.is_error };
          return copy;
        });
      }
      return { ...live, items: items.map((i) => (i.kind === 'tool' && i.id === e.id ? { ...i, result: e.content, isError: e.is_error, display: e.display, ms: e.ms, running: false, images: e.images } : i)) };
    }
    case 'notice':
      if (isSub(e.agent) && e.level === 'info') return live;
      return { ...live, items: [...items, { kind: 'notice', key: key(), level: e.level, text: e.text }] };
    case 'compaction':
      return { ...live, items: [...items, { kind: 'compaction', key: key(), before: e.before, after: e.after }], contextTokens: e.after };
    case 'usage':
      if (isSub(e.agent)) return live;
      return { ...live, contextTokens: e.contextTokens, contextWindow: e.contextWindow };
    case 'retry':
      return { ...live, retry: `Provider busy; retry ${e.attempt} in ${Math.round(e.delayMs / 1000)}s` };
    case 'turn_end':
      if (isSub(e.agent)) return live;
      return { ...live, retry: undefined, items: items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i.kind === 'tool' && i.running ? { ...i, running: false } : i)) };
    default:
      return live;
  }
}

/**
 * Sub-agent activity is shown inside the running workflow card when the agent
 * is one of its nodes, else inside the most recent running `agent` tool card.
 */
function withActivity(live: Live, agent: string, f: (a: Activity[]) => Activity[]): Live {
  const w = findLastIndex(live.items, (i) => i.kind === 'workflow' && i.run.nodes.some((n) => n.id === agent));
  if (w >= 0) {
    const copy = live.items.slice();
    const item = copy[w] as Extract<Item, { kind: 'workflow' }>;
    copy[w] = { ...item, activity: { ...item.activity, [agent]: f(item.activity[agent] ?? []).slice(-40) } };
    return { ...live, items: copy };
  }
  const idx = findLastIndex(live.items, (i) => i.kind === 'tool' && i.name === 'agent' && i.running);
  if (idx < 0) return live;
  const copy = live.items.slice();
  const t = copy[idx] as Extract<Item, { kind: 'tool' }>;
  copy[idx] = { ...t, activity: f(t.activity).slice(-40) };
  return { ...live, items: copy };
}

function findLastIndex<T>(a: T[], f: (x: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i]!)) return i;
  return -1;
}

export function summarize(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'bash': return s('description') || s('command');
    case 'read': return s('path') + (input.offset ? `:${input.offset}` : '');
    case 'write':
    case 'edit': return s('path');
    case 'glob': return s('pattern');
    case 'grep': return `"${s('pattern')}"${s('glob') ? ` in ${s('glob')}` : ''}`;
    case 'web_fetch': return s('url');
    case 'agent': return s('description');
    case 'todo_write': return `${Array.isArray(input.todos) ? input.todos.length : 0} items`;
    case 'ask_user': return s('question');
    case 'skill': return s('name') + (s('file') ? `/${s('file')}` : '');
    case 'tool_search': return s('query');
    case 'tool_call': return s('name');
    case 'exit_plan_mode': return 'plan ready for review';
    default: return JSON.stringify(input).slice(0, 80);
  }
}
