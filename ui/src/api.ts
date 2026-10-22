// Thin client for the harness server. Auth is an HttpOnly cookie: a token set by
// /api/login, or a single sign-on session set by /auth/callback.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  patch: <T>(p: string, b: unknown) => call<T>('PATCH', p, b),
  del: <T>(p: string) => call<T>('DELETE', p),
};

// The API's shapes are shared with the desktop (packages/client).
export type { Effort, Mode, ModelInfo, CompanionInfo, Config, Usage, Todo, SessionMeta, Block, Message, ImageData, ToolDisplay, HarnessEvent, TaskView, SessionDetail, Capabilities, WorkflowRunView, WorkflowInfo } from '../../packages/client/src/types.ts';

export interface CheckpointTurn { turn: number; at: number; prompt: string; files: string[] }
export type TraceSpan =
  | { at: number; type: 'model'; agent: string; model: string; ms: number; usage: import('../../packages/client/src/types.ts').Usage; cost: number; stop: string; retries: number; compaction?: boolean }
  | { at: number; type: 'tool'; agent: string; tool: string; ms: number; error: boolean; chars: number; images: number }
  | { at: number; type: 'clear'; agent: string; results: number; tokens: number };
