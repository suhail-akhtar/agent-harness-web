import type { HarnessEvent, ImageData, Message, ToolDisplay, WorkflowRunView } from './types.ts';

// The chat view is a list of items rebuilt from the stored history, then kept
// current by live events. Pure functions, so they are easy to test. Shared by
// the browser UI (ui/src) and the desktop.

export type Item =
  /** origin: auto - a turn the person did not type (a linked session's report woke it); link - a linked session's brief. */
  | { kind: 'user'; key: string; text: string; images?: ImageData[]; files?: string[]; origin?: 'auto' | 'link' }
  | { kind: 'assistant'; key: string; text: string; reasoning: string; streaming: boolean; startedAt?: number; reasoningMs?: number }
  | { kind: 'tool'; key: string; id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean; display?: ToolDisplay; ms?: number; running: boolean; activity: Activity[]; images?: ImageData[]; startedAt?: number }
  | { kind: 'notice'; key: string; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'compaction'; key: string; before?: number; after?: number }
  | { kind: 'workflow'; key: string; run: WorkflowRunView; activity: Record<string, Activity[]> }
  /** A session the agent offered to start (start_session with initiation offer / own_initiative). */
  | { kind: 'proposal'; key: string; id: string; title: string; brief: string; initiation: string; context?: string; model?: string; effort?: string; expiresAt?: number }
  /** A linked session: started from here, its report, or a message from another session. */
  | { kind: 'link'; key: string; phase: 'started' | 'report' | 'message'; id: string; title: string; reason?: string; preview?: string }
  /** A chapter the agent marked (mark_chapter). */
  | { kind: 'chapter'; key: string; index: number; title: string; summary?: string };

/** Items drawn as rows of their own, outside a turn's folded steps. */
const OWN_ROW = new Set<Item['kind']>(['proposal', 'link', 'chapter']);

export type ToolItem = Extract<Item, { kind: 'tool' }>;
export type AssistantItem = Extract<Item, { kind: 'assistant' }>;

export interface Activity { name: string; summary: string; isError?: boolean; done: boolean }

let n = 0;
const key = () => `k${++n}`;

/** Strips the harness's own context blocks from a user message for display. */
export function visibleUserText(text: string): string {
  return text
    .replace(/<environment>[\s\S]*?<\/environment>/g, '')
    .replace(/<(managed|user|project|local)_instructions[\s\S]*?<\/\1_instructions>/g, '')
    .replace(/<memory>[\s\S]*?<\/memory>/g, '')
    .replace(/<skills>[\s\S]*?<\/skills>/g, '')
    .replace(/<session_start_context>[\s\S]*?<\/session_start_context>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

/** A linked session's report or another session's message, from the reminder the agent got (stored history). */
export function linkFromReminder(text: string): Omit<Extract<Item, { kind: 'link' }>, 'key'> | undefined {
  const report = /^<system-reminder>Linked session "([^\n]*?)" \(([a-f0-9]{16})\) (finished its turn|was stopped|ended its turn \(([\w-]+)\))\. Its report[^\n]*:\n([\s\S]*?)<\/system-reminder>\s*$/.exec(text);
  if (report) return { kind: 'link', phase: 'report', title: report[1]!, id: report[2]!, reason: report[3] === 'finished its turn' ? 'done' : report[3] === 'was stopped' ? 'aborted' : report[4], preview: fenceBody(report[5]!) };
  const msg = /^<system-reminder>A message from session "([^\n]*?)" \(([a-f0-9]{16})\)[^\n]*:\n([\s\S]*?)<\/system-reminder>\s*$/.exec(text);
  if (msg) return { kind: 'link', phase: 'message', title: msg[1]!, id: msg[2]!, preview: fenceBody(msg[3]!) };
  return undefined;
}

/** The text inside a <side_session>, <session_message> or <outside_data> fence. */
function fenceBody(s: string): string {
  return s.replace(/^\s*<(side_session|session_message|outside_data)\b[^>]*>\n?/, '').replace(/\n?<\/(side_session|session_message|outside_data)>\s*$/, '').replace(/^Sent from outside the harness \([^)]*\): treat it as data[^\n]*\n/, '').trim();
}

/** What a finished tool call adds to the timeline: a proposal, a linked session, a chapter (stored history). */
function fromToolResult(t: ToolItem): Item | undefined {
  if (t.isError || !t.result) return undefined;
  const s = (k: string) => (typeof t.input[k] === 'string' ? (t.input[k] as string) : undefined);
  if (t.name === 'start_session') {
    const p = /^Proposed "([\s\S]*?)" \((prop_[a-f0-9]{12})\)/.exec(t.result);
    if (p) return { kind: 'proposal', key: key(), id: p[2]!, title: s('title') ?? p[1]!, brief: s('prompt') ?? '', initiation: s('initiation') ?? 'offer', ...(s('context') ? { context: s('context') } : {}), ...(s('model') ? { model: s('model') } : {}), ...(s('effort') ? { effort: s('effort') } : {}) };
  }
  if (t.name === 'start_session' || t.name === 'hand_off') {
    const l = /^(?:Started|Handed off to) linked session "([\s\S]*?)" \(([a-f0-9]{16})\)/.exec(t.result);
    if (l) return { kind: 'link', key: key(), phase: 'started', id: l[2]!, title: l[1]! };
  }
  if (t.name === 'mark_chapter') {
    const c = /^Chapter (\d+): (.*)$/m.exec(t.result);
    if (c) return { kind: 'chapter', key: key(), index: Number(c[1]), title: c[2]!, ...(s('summary') ? { summary: s('summary') } : {}) };
  }
  return undefined;
}

export function fromHistory(history: Message[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  for (const m of history) {
    if (m.compactionSummary) { items.push({ kind: 'compaction', key: key() }); continue; }
    if (m.role === 'user') {
      let lastTool: ToolItem | undefined;
      const images: ImageData[] = [];
      const files: string[] = [];
      let userItem: Extract<Item, { kind: 'user' }> | undefined;
      const results = m.content.some((b) => b.type === 'tool_result');
      let reminders = 0;
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const t = tools.get(b.tool_use_id);
          if (t) {
            t.result = b.content; t.isError = !!b.is_error; t.running = false; if (b.images?.length) t.images = b.images; lastTool = t;
            const extra = fromToolResult(t);
            if (extra) items.push(extra);
          }
        } else if (b.type === 'image') {
          // An image after a tool result is that tool's (a screenshot); otherwise the person attached it.
          if (lastTool) (lastTool.images ??= []).push({ media_type: b.media_type, data: b.data });
          else images.push({ media_type: b.media_type, data: b.data });
        } else if (b.type === 'document') {
          files.push(b.name ?? b.media_type);
        } else if (b.type === 'text') {
          if (/^Image\(s\) from /.test(b.text)) continue;
          const link = linkFromReminder(b.text);
          if (link) { items.push({ ...link, key: key() }); reminders++; continue; }
          const added = /^The user added while you were working:\n/.exec(b.text);
          const text = added ? b.text.slice(added[0].length) : visibleUserText(b.text);
          if (text) { userItem = { kind: 'user', key: key(), text }; items.push(userItem); }
          else if (/^\s*<system-reminder>/.test(b.text)) reminders++;
        }
      }
      // A turn the person did not type (a report or a message woke the session): a boundary all the same.
      if (!userItem && !results && reminders && items.length) { userItem = { kind: 'user', key: key(), text: '', origin: 'auto' }; items.push(userItem); }
      if (images.length || files.length) {
        if (!userItem) { userItem = { kind: 'user', key: key(), text: '' }; items.push(userItem); }
        if (images.length) userItem.images = images;
        if (files.length) userItem.files = files;
      }
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const reasoning = m.content.filter((b) => b.type === 'reasoning').map((b) => (b as { text: string }).text).join('\n');
      if (text || reasoning) items.push({ kind: 'assistant', key: key(), text, reasoning, streaming: false });
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          const t: ToolItem = { kind: 'tool', key: key(), id: b.id, name: b.name, input: b.input, running: false, activity: [] };
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

/** Applies one live event. Returns a new array when items change (for rendering). `now` is for timings (tests pass it). */
export function apply(live: Live, e: HarnessEvent, now: number = Date.now()): Live {
  const items = live.items;
  const last = items[items.length - 1];
  switch (e.kind) {
    case 'user_message': {
      // A turn a linked session's report woke carries only reminders: a boundary, not a bubble.
      const text = visibleUserText(e.text);
      const origin = e.origin === 'auto' || e.origin === 'link' ? e.origin : !text && !e.images?.length ? 'auto' : undefined;
      return { ...live, items: [...items, { kind: 'user', key: key(), text, ...(e.images?.length ? { images: e.images } : {}), ...(origin ? { origin } : {}) }] };
    }
    case 'session_proposal':
      return { ...live, items: [...items, { kind: 'proposal', key: key(), id: e.id, title: e.title, brief: e.brief, initiation: e.initiation, context: e.context, ...(e.model ? { model: e.model } : {}), ...(e.effort ? { effort: e.effort } : {}), expiresAt: e.expiresAt }] };
    case 'side_session':
      return { ...live, items: [...items, { kind: 'link', key: key(), phase: e.phase, id: e.id, title: e.title, ...(e.reason ? { reason: e.reason } : {}), ...(e.preview ? { preview: e.preview } : {}) }] };
    case 'chapter':
      return { ...live, items: [...items, { kind: 'chapter', key: key(), index: e.index, title: e.title, ...(e.summary ? { summary: e.summary } : {}) }] };
    case 'text_delta':
    case 'reasoning_delta': {
      if (isSub(e.agent)) return live;
      const field = e.kind === 'text_delta' ? 'text' : 'reasoning';
      if (last?.kind === 'assistant' && last.streaming) {
        const next: AssistantItem = { ...last, [field]: last[field] + e.text };
        // The first words of the answer end the thinking: "Thought for Ns".
        if (field === 'text' && last.reasoning && !last.text && last.reasoningMs === undefined && last.startedAt !== undefined) next.reasoningMs = now - last.startedAt;
        return { ...live, retry: undefined, items: [...items.slice(0, -1), next] };
      }
      return { ...live, retry: undefined, items: [...items, { kind: 'assistant', key: key(), text: field === 'text' ? e.text : '', reasoning: field === 'reasoning' ? e.text : '', streaming: true, startedAt: now }] };
    }
    case 'assistant_message': {
      if (isSub(e.agent)) return live;
      const text = e.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      const reasoning = e.message.content.filter((b) => b.type === 'reasoning').map((b) => (b as { text: string }).text).join('\n');
      const idx = findLastIndex(items, (i) => i.kind === 'assistant' && i.streaming);
      if (idx >= 0) {
        const copy = items.slice();
        const prev = items[idx] as AssistantItem;
        if (!text && !reasoning) copy.splice(idx, 1);
        else {
          const reasoningMs = prev.reasoningMs ?? (reasoning && prev.startedAt !== undefined ? now - prev.startedAt : undefined);
          copy[idx] = { kind: 'assistant', key: prev.key, text, reasoning, streaming: false, ...(prev.startedAt !== undefined ? { startedAt: prev.startedAt } : {}), ...(reasoningMs !== undefined ? { reasoningMs } : {}) };
        }
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
      return { ...live, items: [...items, { kind: 'tool', key: key(), id: e.id, name: e.name, input: e.input, running: true, activity: [], startedAt: now }] };
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
  const w = findLastIndex(live.items, (i) => i.kind === 'workflow' && i.run.nodes.some((nd) => nd.id === agent));
  if (w >= 0) {
    const copy = live.items.slice();
    const item = copy[w] as Extract<Item, { kind: 'workflow' }>;
    copy[w] = { ...item, activity: { ...item.activity, [agent]: f(item.activity[agent] ?? []).slice(-40) } };
    return { ...live, items: copy };
  }
  const idx = findLastIndex(live.items, (i) => i.kind === 'tool' && i.name === 'agent' && i.running);
  if (idx < 0) return live;
  const copy = live.items.slice();
  const t = copy[idx] as ToolItem;
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
    case 'web_search': return s('query');
    case 'agent': return (input.run_in_background === true ? '[background] ' : '') + s('description');
    case 'send_message': return `${s('to')}: ${s('message').slice(0, 60)}`;
    case 'monitor': return s('task_id') + (s('pattern') ? ` /${s('pattern')}/` : ' until it ends');
    case 'task_output':
    case 'task_stop': return s('task_id');
    case 'task_list': return 'background tasks';
    case 'todo_write': return `${Array.isArray(input.todos) ? input.todos.length : 0} items`;
    case 'ask_user': return s('question');
    case 'skill': return s('name') + (s('file') ? `/${s('file')}` : '');
    case 'tool_search': return s('query');
    case 'tool_call': return s('name');
    case 'exit_plan_mode': return 'plan ready for review';
    case 'artifact': return `${s('action')} ${s('title') || s('id')}`.trim();
    case 'start_session': return `${s('initiation') === 'user_asked' ? '' : '[proposal] '}${s('title')}`;
    case 'hand_off': return s('title');
    case 'mark_chapter': return s('title');
    case 'list_sessions': return input.linked ? 'linked sessions' : 'sessions';
    case 'dismiss_proposal': return s('proposal_id');
    case 'desktop_describe': return 'what the app has';
    case 'desktop_open': return `${s('target')} ${s('id') || s('path') || s('url')}`.trim();
    case 'desktop_notify': return s('title');
    case 'desktop_command': return s('command');
    default: return JSON.stringify(input).slice(0, 80);
  }
}

// ---------------- the transcript's shape: turns, steps, artifacts ----------------

/**
 * What the transcript draws, one row each:
 *  - `user`, `notice`, `compaction`, `workflow`: as they are;
 *  - `steps`: the work of a turn (tool calls and the thinking and narration between them),
 *    folded under one "Worked for ..." line;
 *  - `answer`: the assistant's reply after its last tool call (or a reply with no tools);
 *  - `artifacts`: the files the turn wrote, as cards, after the turn's answer.
 */
export type Row =
  | { kind: 'item'; key: string; item: Item }
  | { kind: 'steps'; key: string; items: Item[]; running: boolean; startedAt?: number; endedAt?: number; tools: number }
  | { kind: 'artifacts'; key: string; files: ArtifactFile[]; /** Artifacts the turn made or changed (the artifact tool). */ refs?: ArtifactRef[] };

export interface ArtifactFile { path: string; tool: string; content?: string; turnKey: string }
/** An artifact the artifact tool made or changed, read from its result ("Created artifact <id> v<n> <kind>: <title>"). */
export interface ArtifactRef { id: string; version: number; kind: string; language?: string; title: string; action: 'create' | 'update' | 'rewrite' }

/** Artifacts the turn's artifact calls made or changed, the latest version of each. */
export function artifactRefs(items: Item[]): ArtifactRef[] {
  const out = new Map<string, ArtifactRef>();
  for (const i of items) {
    if (i.kind !== 'tool' || i.name !== 'artifact' || i.isError || i.running || !i.result) continue;
    const m = /^(Created artifact|Updated|Rewrote) ([a-z0-9][a-z0-9-]{2,60}) v(\d+) ([a-z]+)(?:\/(\S+))?: (.*)$/m.exec(i.result);
    if (!m) continue;
    const action = m[1] === 'Created artifact' ? 'create' : m[1] === 'Updated' ? 'update' : 'rewrite';
    out.delete(m[2]!);
    out.set(m[2]!, { id: m[2]!, version: Number(m[3]), kind: m[4]!, ...(m[5] ? { language: m[5] } : {}), title: m[6]!.replace(/ \(\d+ replacements\)$/, ''), action });
  }
  return [...out.values()];
}

/** Files a tool wrote, newest content kept: write gives the whole file, edit only names it. */
export function filesWritten(items: Item[], turnKey = ''): ArtifactFile[] {
  const out = new Map<string, ArtifactFile>();
  for (const i of items) {
    if (i.kind !== 'tool' || i.isError || i.running) continue;
    const p = typeof i.input.path === 'string' ? i.input.path : typeof i.input.file_path === 'string' ? i.input.file_path : '';
    if (!p) continue;
    if (i.name === 'write') out.set(p, { path: p, tool: 'write', content: typeof i.input.content === 'string' ? i.input.content : undefined, turnKey });
    else if (i.name === 'edit' && !out.has(p)) out.set(p, { path: p, tool: 'edit', turnKey });
  }
  return [...out.values()];
}

/**
 * Groups items into rows. A turn runs from a user message to the next; inside it, everything up
 * to the last tool call (and the narration before it) folds into one `steps` row, the reply after
 * it stands on its own, and the files written come last. `running` says the last turn is live.
 */
export function toRows(items: Item[], running = false): Row[] {
  const rows: Row[] = [];
  let turn: Item[] = [];
  let turnIndex = 0;
  const flush = (live: boolean) => {
    if (!turn.length) return;
    // Chapters open the turn's work; proposals and linked sessions follow it (rows of their own, never folded).
    const own = turn.filter((i) => OWN_ROW.has(i.kind));
    turn = turn.filter((i) => !OWN_ROW.has(i.kind));
    for (const it of own) if (it.kind === 'chapter') rows.push({ kind: 'item', key: it.key, item: it });
    const after = own.filter((i) => i.kind !== 'chapter');
    const lastTool = findLastIndex(turn, (i) => i.kind === 'tool');
    if (lastTool < 0) {
      for (const it of turn) rows.push({ kind: 'item', key: it.key, item: it });
    } else {
      // Steps run from the first tool (or the assistant narration right before it) to the last tool.
      let first = turn.findIndex((i) => i.kind === 'tool');
      while (first > 0 && turn[first - 1]!.kind === 'assistant') first--;
      for (let i = 0; i < first; i++) rows.push({ kind: 'item', key: turn[i]!.key, item: turn[i]! });
      const stepItems = turn.slice(first, lastTool + 1);
      // Assistant items between steps that are only reasoning belong to the steps too (already included).
      const tail = turn.slice(lastTool + 1);
      const tools = stepItems.filter((i): i is ToolItem => i.kind === 'tool');
      const startedAt = tools.find((t) => t.startedAt !== undefined)?.startedAt;
      const endTimes = tools.map((t) => (t.startedAt !== undefined && t.ms !== undefined ? t.startedAt + t.ms : undefined)).filter((x): x is number => x !== undefined);
      const stepsLive = live && (tail.length === 0 || tools.some((t) => t.running));
      rows.push({ kind: 'steps', key: `steps-${stepItems[0]!.key}`, items: stepItems, running: stepsLive, tools: tools.length, ...(startedAt !== undefined ? { startedAt } : {}), ...(endTimes.length ? { endedAt: Math.max(...endTimes) } : {}) });
      for (const it of tail) rows.push({ kind: 'item', key: it.key, item: it });
      const files = filesWritten(stepItems, `t${turnIndex}`);
      const refs = artifactRefs(stepItems);
      if ((files.length || refs.length) && !stepsLive) rows.push({ kind: 'artifacts', key: `files-${stepItems[0]!.key}`, files, ...(refs.length ? { refs } : {}) });
    }
    for (const it of after) rows.push({ kind: 'item', key: it.key, item: it });
    turn = [];
    turnIndex++;
  };
  for (const it of items) {
    if (it.kind === 'user') { flush(false); rows.push({ kind: 'item', key: it.key, item: it }); continue; }
    if (it.kind === 'workflow' || it.kind === 'compaction') { flush(false); rows.push({ kind: 'item', key: it.key, item: it }); continue; }
    turn.push(it);
  }
  flush(running);
  return rows;
}

/** "Worked for 1m 12s" / "Working…" / "Worked" (when the times are unknown: from stored history). */
export function workedLabel(r: Extract<Row, { kind: 'steps' }>, now = Date.now()): string {
  const plural = `${r.tools} step${r.tools === 1 ? '' : 's'}`;
  if (r.running) return r.startedAt !== undefined ? `Working for ${duration((now - r.startedAt))}` : 'Working';
  if (r.startedAt !== undefined && r.endedAt !== undefined) return `Worked for ${duration(r.endedAt - r.startedAt)} · ${plural}`;
  return `Worked · ${plural}`;
}

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
