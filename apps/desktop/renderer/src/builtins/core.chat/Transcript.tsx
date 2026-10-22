/**
 * The transcript: rows from the shared timeline (user messages, replies, a turn's steps folded under
 * "Worked for ...", the files it wrote, notices, workflow runs), virtualised so thousands of messages
 * stay fast, kept at the bottom while a reply streams in. Every block is drawn by the rich renderers
 * of @harness/ui, and a plugin's renderer for a fence language, a tool or an event replaces the default.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { duration, summarize, toRows, workedLabel, type ArtifactFile, type ArtifactRef, type Item, type Row, type ToolItem } from '@harness/client';
import { Badge, Button, CodeBlock, DiffView, EmptyState, FencedBlock, Icon, IconButton, ImageStrip, ImageView, JsonView, Markdown, Popover, Reasoning, RenderBoundary, Spinner, Tabs, VirtualList, copyRich, copyText, cx, toast, type FenceRenderer, type VirtualListHandle, type Source } from '@harness/ui';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';
import { rendererFor } from '../../registry/registry';
import { PluginFrame } from '../../registry/Frame';
import { useArtifactRenderer, useEventComponent, useFenceRenderer } from '../../registry/renderers';
import { FilePreview } from '../../components/FilePreview';
import { WorkflowGraph } from '../../components/WorkflowGraph';

export { useArtifactRenderer, useFenceRenderer };

export interface TranscriptProps {
  sessionId: string;
  items: Item[];
  running: boolean;
  onRetry?: (text: string) => void;
  sources?: Source[];
  footer?: React.ReactNode;
}

const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

export function Transcript({ sessionId, items, running, onRetry, sources, footer }: TranscriptProps): React.ReactElement {
  const rows = useMemo(() => toRows(items, running), [items, running]);
  const list = useRef<VirtualListHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const lastUser = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) { const it = items[i]!; if (it.kind === 'user') return it.text; } return ''; }, [items]);
  const lastAnswerKey = useMemo(() => { for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]!; if (r.kind === 'item' && r.item.kind === 'assistant') return r.key; } return ''; }, [rows]);
  const fence = useFenceRenderer();
  const stepsPref = useApp((s) => s.prefs.steps);
  const chapters = useMemo(() => rows.flatMap((r) => (r.kind === 'item' && r.item.kind === 'chapter' ? [{ key: r.key, index: r.item.index, title: r.item.title, summary: r.item.summary }] : [])), [rows]);
  if (!rows.length) return <div className="flex flex-1 items-center justify-center"><EmptyState icon="chat" title="Nothing here yet">Send a message to start.</EmptyState></div>;
  return (
    <div className="relative min-h-0 flex-1">
      {chapters.length > 0 && <Contents chapters={chapters} onJump={(k) => list.current?.scrollToKey(k)} />}
      <VirtualList
        ref={list}
        items={rows}
        getKey={(r) => r.key}
        estimate={(r) => (r.kind === 'steps' ? 44 : r.kind === 'artifacts' ? 80 : r.kind === 'item' && r.item.kind === 'user' ? 64 : 160)}
        className="h-full"
        innerClassName="mx-auto w-full max-w-column px-4 pb-6 pt-4 sm:px-6"
        onAtBottomChange={setAtBottom}
        footer={footer}
        render={(r) => (
          <div className="py-1.5" data-row={r.kind === 'item' ? r.item.kind : r.kind}>
            <RowView row={r} sessionId={sessionId} fence={fence} sources={sources} running={running} stepsOpen={stepsPref === 'expanded'} isLastAnswer={r.key === lastAnswerKey} onRetry={onRetry && lastUser ? () => onRetry(lastUser) : undefined} />
          </div>
        )}
      />
      {!atBottom && (
        <button type="button" data-jump-latest aria-label="Jump to the latest" onClick={() => list.current?.scrollToBottom(true)}
          className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-hx-border bg-hx-elevated text-hx-secondary shadow-md hover:text-hx-primary">
          <Icon name="arrow-down" size={16} />
        </button>
      )}
    </div>
  );
}

/** The chapters the agent marked, as a floating table of contents: a click scrolls the transcript there. */
function Contents({ chapters, onJump }: { chapters: Array<{ key: string; index: number; title: string; summary?: string }>; onJump: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <div className="absolute left-3 top-2 z-10" data-toc>
      <button ref={btn} type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Chapters" data-toc-toggle
        className="flex h-8 items-center gap-1.5 rounded-full border border-hx-border bg-hx-elevated px-3 text-[12px] text-hx-secondary shadow-sm hover:text-hx-primary">
        <Icon name="list" size={14} />Chapters<span className="rounded-full bg-hx-pill px-1.5 text-[10.5px]">{chapters.length}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} placement="bottom-start" className="w-[300px]" role="dialog">
        <nav aria-label="Chapters" className="max-h-[60vh] overflow-auto p-1.5" data-toc-list>
          {chapters.map((c) => (
            <button key={c.key} type="button" data-toc-entry={c.index} onClick={() => { onJump(c.key); setOpen(false); }} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hx-hover">
              <span className="mt-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-hx-accent-soft px-1 text-[10.5px] font-semibold text-hx-accent-text">{c.index}</span>
              <span className="min-w-0"><span className="block text-[13px] text-hx-primary">{c.title}</span>{c.summary && <span className="block truncate text-[11.5px] text-hx-muted">{c.summary}</span>}</span>
            </button>
          ))}
        </nav>
      </Popover>
    </div>
  );
}

const RowView = React.memo(function RowView({ row, sessionId, fence, sources, running, stepsOpen, isLastAnswer, onRetry }: { row: Row; sessionId: string; fence: FenceRenderer; sources?: Source[]; running: boolean; stepsOpen: boolean; isLastAnswer: boolean; onRetry?: () => void }) {
  if (row.kind === 'steps') return <Steps row={row} sessionId={sessionId} fence={fence} defaultOpen={stepsOpen} />;
  if (row.kind === 'artifacts') return <ArtifactCards files={row.files} refs={row.refs} sessionId={sessionId} />;
  return <ItemView item={row.item} sessionId={sessionId} fence={fence} sources={sources} running={running} isLastAnswer={isLastAnswer} onRetry={onRetry} />;
});

function ItemView({ item, sessionId, fence, sources, running, isLastAnswer, onRetry, inSteps }: { item: Item; sessionId: string; fence: FenceRenderer; sources?: Source[]; running?: boolean; isLastAnswer?: boolean; onRetry?: () => void; inSteps?: boolean }): React.ReactElement | null {
  const registry = useData((s) => s.registry);
  const custom = rendererFor(registry, 'event', item.kind);
  if (custom && custom.kind === 'frame' && custom.entry) return <PluginFrame plugin={custom.plugin} contribution={custom.qid} entry={custom.entry} height={custom.height ?? 120} context={{ event: item }} />;
  const Native = custom?.component ? registry.active.find((p) => p.name === custom.plugin)?.native?.components[custom.component] as React.ComponentType<{ item: Item; sessionId: string }> | undefined : undefined;
  if (Native) return <Native item={item} sessionId={sessionId} />;
  switch (item.kind) {
    case 'user': return <UserMessage item={item} />;
    case 'assistant': return <AssistantMessage item={item} fence={fence} sources={sources} canRetry={!!isLastAnswer && !running} onRetry={onRetry} compact={inSteps} />;
    case 'tool': return <ToolCard item={item} sessionId={sessionId} />;
    case 'notice': return <div data-notice={item.level} className={cx('my-1 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', item.level === 'error' ? 'bg-hx-danger/8 text-hx-danger' : item.level === 'warn' ? 'bg-hx-warning/8 text-hx-warning' : 'bg-hx-pill text-hx-secondary')}><Icon name={item.level === 'error' ? 'alert' : item.level === 'warn' ? 'warning' : 'info'} size={14} className="mt-0.5 shrink-0" /><span className="whitespace-pre-wrap">{item.text}</span></div>;
    case 'compaction': return <div className="my-2 flex items-center gap-3 text-[11.5px] text-hx-muted"><span className="h-px flex-1 bg-hx-border-subtle" />Context compacted{item.before ? ` · ${fmtTokens(item.before)} → ${fmtTokens(item.after ?? 0)} tokens` : ''}<span className="h-px flex-1 bg-hx-border-subtle" /></div>;
    case 'workflow': return <WorkflowCard item={item} />;
    // Without the plugin that draws them (core.agents): a line each.
    case 'chapter': return <div data-chapter={item.index} className="mt-4 text-[14px] font-semibold">{item.index}. {item.title}</div>;
    case 'proposal': return <div data-proposal={item.id} className="rounded-lg bg-hx-pill px-3 py-2 text-[12.5px]">Proposed session: <b>{item.title}</b></div>;
    case 'link': return <div data-link={item.id} className="rounded-lg bg-hx-pill px-3 py-2 text-[12.5px]">Linked session {item.phase}: <b>{item.title}</b></div>;
  }
}

function UserMessage({ item }: { item: Extract<Item, { kind: 'user' }> }) {
  if (item.origin === 'auto' && !item.text && !item.images?.length) return <div data-user-message="auto" className="my-1 flex items-center gap-3 text-[11.5px] text-hx-muted"><span className="h-px flex-1 bg-hx-border-subtle" /><Icon name="refresh" size={12} />Continued on its own after a linked session reported<span className="h-px flex-1 bg-hx-border-subtle" /></div>;
  return (
    <div className="group flex flex-col items-end" data-user-message>
      {item.images?.length ? <div className="mb-1"><ImageStrip images={item.images} /></div> : null}
      {item.files?.length ? <div className="mb-1 flex flex-wrap justify-end gap-1">{item.files.map((f) => <Badge key={f}><Icon name="file" size={11} className="mr-1" />{f}</Badge>)}</div> : null}
      {item.text && <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-hx-pill px-4 py-2.5 text-[14.5px] leading-6 text-hx-primary">{item.text}</div>}
      <div className="mt-0.5 opacity-0 transition-opacity group-hover:opacity-100"><IconButton size="xs" icon="copy" label="Copy" onClick={() => void copyText(item.text).then(() => toast('Copied'))} /></div>
    </div>
  );
}

function AssistantMessage({ item, fence, sources, canRetry, onRetry, compact }: { item: Extract<Item, { kind: 'assistant' }>; fence: FenceRenderer; sources?: Source[]; canRetry: boolean; onRetry?: () => void; compact?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const streamingReasoning = item.streaming && !item.text;
  return (
    <div className="group" data-assistant-message data-streaming={item.streaming ? '1' : '0'}>
      {item.reasoning && <Reasoning text={item.reasoning} streaming={streamingReasoning} ms={item.reasoningMs} />}
      {item.text && <div ref={body} className={compact ? 'text-[13.5px]' : ''}><Markdown text={item.text} streaming={item.streaming} renderFence={fence} sources={sources} /></div>}
      {item.streaming && item.text && <span className="hx-thinking ml-0.5 inline-block h-3 w-1.5 rounded-sm bg-hx-accent align-middle" aria-label="Writing" />}
      {!item.streaming && item.text && !compact && (
        <div className="mt-1 flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100" data-message-actions>
          <IconButton size="xs" icon="copy" label="Copy as Markdown" onClick={() => void copyText(item.text).then((ok) => ok && toast('Copied as Markdown'))} />
          <IconButton size="xs" icon="file-text" label="Copy as rich text" onClick={() => void copyRich(body.current?.innerHTML ?? item.text, item.text).then((ok) => ok && toast('Copied as rich text'))} />
          {canRetry && onRetry && <IconButton size="xs" icon="refresh" label="Retry" onClick={onRetry} />}
        </div>
      )}
    </div>
  );
}

function Steps({ row, sessionId, fence, defaultOpen }: { row: Extract<Row, { kind: 'steps' }>; sessionId: string; fence: FenceRenderer; defaultOpen: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { if (!row.running) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [row.running]);
  const isOpen = open ?? (row.running || defaultOpen);
  const errors = row.items.filter((i) => i.kind === 'tool' && i.isError).length;
  const last = [...row.items].reverse().find((i): i is ToolItem => i.kind === 'tool');
  return (
    <div data-steps data-open={isOpen ? '1' : '0'} className="my-1">
      <button type="button" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen} className="group flex w-full items-center gap-2 rounded-lg py-1 text-left text-[13px] text-hx-muted hover:text-hx-secondary">
        {row.running ? <Spinner size={13} className="text-hx-accent-text" /> : <Icon name={errors ? 'warning' : 'check-circle'} size={14} className={errors ? 'text-hx-warning' : 'text-hx-success'} />}
        <span data-worked>{workedLabel(row)}</span>
        {errors > 0 && !row.running && <span className="text-hx-warning">· {errors} failed</span>}
        {!isOpen && last && <span className="min-w-0 flex-1 truncate text-hx-muted/80">· {last.name} {summarize(last.name, last.input)}</span>}
        <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={13} className="ml-auto shrink-0" />
      </button>
      {isOpen && (
        <div className="ml-[7px] border-l border-hx-border-subtle pl-4">
          {row.items.map((it) => <div key={it.key} className="py-0.5"><ItemView item={it} sessionId={sessionId} fence={fence} inSteps /></div>)}
        </div>
      )}
      {!isOpen && <ToolOutputs items={row.items} sessionId={sessionId} />}
    </div>
  );
}

/** What a plugin's native renderer of a tool's result receives: the whole item, and its parts by name (renderers use either). */
export interface NativeToolProps { item: ToolItem; sessionId: string; tool: string; input: Record<string, unknown>; result?: string; isError?: boolean }

/** A plugin's native renderer of a tool's result, when it has one (it may draw nothing for a given call). */
function useNativeTool(name: string): { qid: string; C: React.ComponentType<NativeToolProps> } | undefined {
  const registry = useData((s) => s.registry);
  const r = rendererFor(registry, 'tool', name);
  if (!r || r.kind !== 'native' || !r.component) return undefined;
  const C = registry.active.find((p) => p.name === r.plugin)?.native?.components[r.component] as React.ComponentType<NativeToolProps> | undefined;
  return C ? { qid: r.qid, C } : undefined;
}

function NativeToolOutput({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const n = useNativeTool(item.name);
  if (!n || item.running) return null;
  return <div className="mt-1" data-plugin-renderer={n.qid}><RenderBoundary fallback={() => null}><n.C item={item} sessionId={sessionId} tool={item.name} input={item.input} result={item.result} isError={item.isError} /></RenderBoundary></div>;
}

/** What plugins draw for a turn's tools, shown even while its steps are folded (a diagram the turn made, say). */
function ToolOutputs({ items, sessionId }: { items: Item[]; sessionId: string }) {
  const tools = items.filter((i): i is ToolItem => i.kind === 'tool' && !i.running && !i.isError);
  if (!tools.length) return null;
  return <>{tools.map((t) => <NativeToolOutput key={t.key} item={t} sessionId={sessionId} />)}</>;
}

const TOOL_ICON: Record<string, string> = { bash: 'terminal', read: 'file-text', write: 'file-plus', edit: 'edit', glob: 'search', grep: 'search', web_fetch: 'globe', web_search: 'globe', agent: 'bot', todo_write: 'list', ask_user: 'help', exit_plan_mode: 'list', skill: 'sparkles', tool_search: 'search', workflow: 'workflow', render: 'image', browser: 'globe', artifact: 'layers', start_session: 'split', hand_off: 'split', list_sessions: 'list', mark_chapter: 'bookmark', desktop_describe: 'monitor', desktop_open: 'external', desktop_notify: 'bell', desktop_command: 'command', task_list: 'activity', send_message: 'mail' };
const VERB: Record<string, string> = { bash: 'Ran', read: 'Read', write: 'Wrote', edit: 'Edited', glob: 'Found files', grep: 'Searched', web_fetch: 'Fetched', web_search: 'Searched the web', agent: 'Delegated', todo_write: 'Updated tasks', ask_user: 'Asked', skill: 'Used skill', tool_search: 'Looked up tools', workflow: 'Ran workflow', artifact: 'Artifact', start_session: 'Linked session', hand_off: 'Handed off', list_sessions: 'Listed', mark_chapter: 'Chapter', desktop_describe: 'Looked at the app', desktop_open: 'Opened in the app', desktop_notify: 'Notified', desktop_command: 'Ran in the app', send_message: 'Messaged' };

export function ToolCard({ item, sessionId }: { item: ToolItem; sessionId: string }): React.ReactElement {
  const registry = useData((s) => s.registry);
  const [open, setOpen] = useState(false);
  const custom = rendererFor(registry, 'tool', item.name);
  const s = (k: string) => (typeof item.input[k] === 'string' ? (item.input[k] as string) : '');
  const status = item.running ? 'running' : item.isError ? 'error' : 'ok';
  const diff = item.display?.type === 'diff' ? item.display : item.name === 'edit' && !item.isError && s('path') ? { path: s('path'), before: s('old_string'), after: s('new_string') } : undefined;
  const resultLooksJson = !!item.result && /^\s*[[{]/.test(item.result) && item.result.length < 400_000 && (() => { try { JSON.parse(item.result!); return true; } catch { return false; } })();
  return (
    <div data-tool={item.name} data-tool-status={status} className={cx('rounded-lg', item.isError && 'bg-hx-danger/[0.04]')}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="group flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hx-hover">
        <Icon name={TOOL_ICON[item.name] ?? (item.name.startsWith('mcp__') ? 'plug' : 'wrench')} size={14} className={cx('shrink-0', item.running ? 'hx-thinking text-hx-accent-text' : item.isError ? 'text-hx-danger' : 'text-hx-muted')} />
        <span className={cx('shrink-0 text-[13px]', item.isError ? 'text-hx-danger' : 'text-hx-secondary')}>{VERB[item.name] ?? item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-hx-muted" title={summarize(item.name, item.input)}>{summarize(item.name, item.input)}</span>
        {diff && !item.isError && <DiffCount before={diff.before} after={diff.after} />}
        {item.running ? <Spinner size={12} className="text-hx-accent-text" /> : item.isError ? <span className="text-[11px] text-hx-danger">failed</span> : item.ms !== undefined ? <span className="text-[11px] tabular-nums text-hx-muted">{item.ms < 1000 ? `${item.ms}ms` : duration(item.ms)}</span> : null}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} className="shrink-0 text-hx-muted opacity-0 group-hover:opacity-100" />
      </button>
      {!(custom && custom.kind === 'frame') && <div className="ml-6"><NativeToolOutput item={item} sessionId={sessionId} /></div>}
      {item.name === 'agent' && item.activity.length > 0 && (
        <div className="ml-7 space-y-0.5 py-0.5 text-[12px] text-hx-muted">{item.activity.slice(open ? 0 : -3).map((a, i) => <div key={i} className={a.isError ? 'text-hx-danger' : ''}>{a.done ? (a.isError ? '✕' : '✓') : '…'} <b className="font-medium">{a.name}</b> {a.summary}</div>)}</div>
      )}
      {custom && !item.running && custom.kind === 'frame' && custom.entry ? (
        <div className="ml-6 mt-1" data-plugin-renderer={custom.qid}><PluginFrame plugin={custom.plugin} contribution={custom.qid} entry={custom.entry} height={custom.height ?? 140} context={{ tool: item.name, input: item.input, result: item.result, isError: item.isError }} /></div>
      ) : (
        <>
          {diff && !open && !item.isError && <div className="ml-6"><DiffView path={diff.path} before={diff.before} after={diff.after} collapsedLines={40} /></div>}
          {item.images?.length ? <div className="ml-6 mt-1"><ImageStrip images={item.images} /></div> : null}
          {open && (
            <div className="ml-6 mt-1 space-y-1.5" data-tool-body>
              {item.name === 'bash' && <CodeBlock code={s('command')} language="bash" collapseAt={20} />}
              {item.name === 'write' && <CodeBlock code={s('content').slice(0, 100_000)} filename={s('path')} language={extOf(s('path'))} />}
              {diff && <DiffView path={diff.path} before={diff.before} after={diff.after} />}
              {(item.name === 'agent' || item.name === 'exit_plan_mode') && <Markdown text={s('prompt') || s('plan')} />}
              {!['bash', 'write', 'edit', 'agent', 'exit_plan_mode'].includes(item.name) && Object.keys(item.input).length > 0 && <JsonView source={JSON.stringify(item.input, null, 2)} />}
              {item.result !== undefined && (item.name === 'agent' ? <Markdown text={item.result} />
                : resultLooksJson ? <JsonView source={item.result} />
                  : item.name === 'read' && !item.isError ? <CodeBlock code={item.result.slice(0, 200_000)} language={extOf(s('path'))} filename={s('path')} />
                    : <pre className={cx('hx-scroll max-h-80 overflow-auto rounded-lg bg-hx-code px-3 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words', item.isError ? 'text-hx-danger' : 'text-hx-secondary')}>{item.result.slice(-60_000)}</pre>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiffCount({ before, after }: { before: string; after: string }) {
  const a = after ? after.split('\n').length : 0;
  const r = before ? before.split('\n').length : 0;
  return <span className="shrink-0 text-[11px] tabular-nums"><span className="text-[var(--hx-diff-add-gutter)]">+{a}</span> <span className="text-[var(--hx-diff-remove-gutter)]">−{r}</span></span>;
}

const FILE_ICON: Record<string, string> = { html: 'globe', htm: 'globe', svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', md: 'file-text', txt: 'file-text', csv: 'table', tsv: 'table', json: 'code', js: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', css: 'palette', pdf: 'file' };

function ArtifactCards({ files, refs, sessionId }: { files: ArtifactFile[]; refs?: ArtifactRef[]; sessionId: string }) {
  // Artifacts (the artifact tool's) are drawn by the plugin that renders the "artifact" event kind.
  const Refs = useEventComponent<{ item: { kind: 'artifact'; refs: ArtifactRef[] }; sessionId: string }>('artifact');
  return (
    <div data-artifacts className="my-1 space-y-2">
      {refs?.length ? (Refs ? <Refs item={{ kind: 'artifact', refs }} sessionId={sessionId} /> : <div className="flex flex-wrap gap-1.5">{refs.map((r) => <Badge key={r.id}><Icon name="layers" size={11} className="mr-1" />{r.title} · v{r.version}</Badge>)}</div>) : null}
      {files.length > 0 && <div className="grid gap-2 sm:grid-cols-2">{files.slice(0, 12).map((f) => <ArtifactCard key={f.path} f={f} sessionId={sessionId} />)}</div>}
    </div>
  );
}

function ArtifactCard({ f, sessionId }: { f: ArtifactFile; sessionId: string }) {
  const ext = extOf(f.path);
  const name = f.path.split(/[\\/]/).pop() ?? f.path;
  const [preview, setPreview] = useState(false);
  const [content, setContent] = useState<string | null>(f.content ?? null);
  const load = async () => {
    if (content !== null) return content;
    try { const r = await client.files.read(sessionId, f.path); setContent(r.content ?? ''); return r.content ?? ''; } catch (e) { toast((e as Error).message, { kind: 'error' }); return null; }
  };
  const open = async () => {
    const c = await load();
    if (c === null) return;
    useApp.setState({ panel: { kind: 'file', title: name, path: f.path, sessionId, content: c } });
  };
  return (
    <div data-artifact-card={f.path} className="rounded-xl border border-hx-border-subtle bg-hx-elevated">
      <div className="flex items-center gap-2.5 p-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-hx-accent-soft text-hx-accent-text"><Icon name={FILE_ICON[ext] ?? 'file'} size={17} /></span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13px] font-medium text-hx-primary">{name}</span><span className="block truncate text-[11px] text-hx-muted">{f.tool === 'write' ? 'Created' : 'Edited'} · {ext.toUpperCase() || 'file'} · {f.path}</span></span>
        <Button size="sm" variant="ghost" onClick={() => void load().then(() => setPreview((v) => !v))}>{preview ? 'Hide' : 'Preview'}</Button>
        <Button size="sm" onClick={() => void open()}>Open</Button>
      </div>
      {preview && content !== null && <div className="border-t border-hx-border-subtle px-2 pb-2"><FilePreview path={f.path} content={content} /></div>}
    </div>
  );
}

function WorkflowCard({ item }: { item: Extract<Item, { kind: 'workflow' }> }) {
  const run = item.run;
  const [open, setOpen] = useState<number | null>(null);
  // The graph needs where each node goes (newer servers say); without it, the steps.
  const graphable = run.nodes.length > 1 && run.nodes.some((n) => n.next?.length);
  const [view, setView] = useState<'graph' | 'steps'>(graphable ? 'graph' : 'steps');
  const live = run.status === 'running' || run.status === 'waiting';
  const title = (id: string) => run.nodes.find((n) => n.id === id)?.title ?? id;
  return (
    <div data-workflow={run.workflow} data-status={run.status} className="my-2 rounded-xl border border-hx-border bg-hx-elevated">
      <div className="flex items-center gap-2 border-b border-hx-border-subtle px-3 py-2">
        <Icon name="workflow" size={15} className="text-hx-accent-text" />
        <b className="text-[13px]">{run.workflow}</b>
        <Badge tone={run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'danger' : run.status === 'waiting' ? 'warning' : 'accent'}>{live && <Spinner size={10} className="mr-1" />}{({ running: 'Running', waiting: 'Needs you', succeeded: 'Succeeded', failed: 'Failed', aborted: 'Stopped', interrupted: 'Interrupted' } as Record<string, string>)[run.status] ?? run.status}</Badge>
        <span className="ml-auto text-[11.5px] text-hx-muted">{run.history.length} steps · ${run.cost.toFixed(run.cost < 0.01 ? 4 : 2)}</span>
        {graphable && <Tabs size="sm" value={view} onChange={(v) => setView(v as 'graph' | 'steps')} tabs={[{ id: 'graph', label: 'Graph' }, { id: 'steps', label: 'Steps' }]} />}
      </div>
      {view === 'graph' && graphable ? <div className="py-2"><WorkflowGraph run={run} /></div> : <ol className="p-1.5">
        {run.history.map((h, i) => {
          const acts = h.status === 'running' ? item.activity[h.node] ?? [] : [];
          return (
            <li key={i}>
              <button type="button" disabled={!h.summary} onClick={() => setOpen(open === i ? null : i)} className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-hx-hover disabled:hover:bg-transparent">
                {h.status === 'running' ? <Spinner size={12} /> : <Icon name={h.status === 'failed' ? 'x-circle' : h.status === 'waiting' ? 'clock' : 'check-circle'} size={13} className={h.status === 'failed' ? 'text-hx-danger' : 'text-hx-success'} />}
                <span className="flex-1 truncate">{title(h.node)}</span>
                {h.outcome && <span className="rounded bg-hx-pill px-1.5 text-[11px] text-hx-secondary">{h.outcome}</span>}
                <span className="text-[11px] text-hx-muted">{duration((h.endedAt ?? Date.now()) - h.startedAt)}</span>
              </button>
              {acts.length > 0 && <div className="ml-7 text-[11.5px] text-hx-muted">{acts.slice(-3).map((a, j) => <div key={j}>{a.done ? '✓' : '…'} {a.name} {a.summary}</div>)}</div>}
              {open === i && h.summary && <div className="ml-7 mr-2 rounded-md bg-hx-bg p-2"><Markdown text={h.type === 'gate' ? `\`\`\`\n${h.summary}\n\`\`\`` : h.summary} /></div>}
            </li>
          );
        })}
      </ol>}
      {run.error && <div className="border-t border-hx-border-subtle px-3 py-2 text-[12px] text-hx-danger">{run.error}</div>}
    </div>
  );
}

export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtCost = (c: number) => (c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
export { ImageView };
