import type { HarnessEvent, Todo } from '../core/types.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { ToolHost, ToolOutcome } from '../runtime/host.ts';

export type ToolKind = 'read' | 'edit' | 'exec' | 'network' | 'meta';

export interface FileStamp { mtimeMs: number; size: number }

export interface ToolContext {
  host: ToolHost;
  signal: AbortSignal;
  /** Files read this session with the mtime seen, so writes can refuse stale edits. */
  readFiles: Map<string, FileStamp>;
  todos: Todo[];
  setTodos(todos: Todo[]): void;
  emit(e: HarnessEvent): void;
  runSubagent?(args: { description: string; prompt: string; type: 'explore' | 'general' }): Promise<string>;
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
