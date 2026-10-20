import type { HarnessEvent, Todo } from '../core/types.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { ToolHost, ToolOutcome } from '../runtime/host.ts';

/**
 * Permission class. read: no side effects. edit: changes workspace files.
 * exec: runs commands where tools run (free in a sandbox). network: fetches
 * the web. external: acts on another system (an MCP service) - always asks
 * unless allowed. meta: talks to the harness or the user.
 */
export type ToolKind = 'read' | 'edit' | 'exec' | 'network' | 'external' | 'meta';

export interface FileStamp { mtimeMs: number; size: number }

export interface ToolContext {
  host: ToolHost;
  signal: AbortSignal;
  /** Files read this session with the mtime seen, so writes can refuse stale edits. */
  readFiles: Map<string, FileStamp>;
  todos: Todo[];
  setTodos(todos: Todo[]): void;
  emit(e: HarnessEvent): void;
  runSubagent?(args: { description: string; prompt: string; type: string }): Promise<string>;
  /** Called with a file's real path before a tool changes it (checkpoints for rewind). */
  beforeWrite?(realPath: string): Promise<void>;
  askUser?(question: string, options: string[]): Promise<string>;
  proposePlan?(plan: string): Promise<{ approved: boolean; feedback?: string }>;
  isPlanMode?(): boolean;
}

export interface Tool {
  spec: ToolSpec;
  kind: ToolKind;
  /** Safe to run concurrently with other parallel-safe calls in the same turn. */
  parallelSafe: boolean;
  /** Runs on the user's machine when the session uses a companion host. */
  remoteable: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome>;
  /** One line for permission prompts and the UI. */
  summarize(input: Record<string, unknown>): string;
  /**
   * For dispatcher tools (tool_call): the real tool and input this call runs.
   * Permissions, hooks and validation then apply to THAT tool.
   */
  resolve?(input: Record<string, unknown>): { tool: Tool; input: Record<string, unknown> } | { error: string };
}

export type { ToolOutcome };

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
export const bool = (v: unknown): boolean => v === true || v === 'true';

/** Keeps the head and tail of long output; the middle is what a model needs least. */
export function clip(text: string, max: number, hint = ''): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n\n[... ${dropped} characters omitted${hint ? ` - ${hint}` : ''} ...]\n\n${text.slice(text.length - tail)}`;
}
