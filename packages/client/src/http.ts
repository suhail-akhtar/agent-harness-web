/**
 * A typed client of the harness HTTP API.
 *
 * Every path here is the server's own. Some endpoints are new (the desktop needs them; another
 * change adds them to the server): those calls fall back when the server answers 404, so the same
 * client works against an older server with fewer features rather than failing.
 *
 * The desktop renderer uses it with `base: ''` (its own origin, harness://app, where main adds
 * the token on the way to the engine); Node callers pass `base` and an Authorization header.
 */

import { GlobalEvents, sessionEvents, type Fetch } from './events.ts';
import {
  isPending, type Approval, type Attachment, type CatalogueEntry, type Config, type Capabilities, type EffectiveSetting, type Effort, type FileContent, type FileEntry,
  type GitLogEntry, type GitStatus, type Health, type HarnessEvent, type HistoryPage, type McpBundle, type Me, type Mode, type ModelInfo, type PendingRequest, type PluginInfo,
  type ProviderInfo, type ProviderTest, type Schedule, type SessionDetail, type SessionMeta, type SessionsPage, type TaskView, type VaultEntry, type VersionInfo, type WorkflowInfo, type WorkflowRunView,
} from './types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'ApiError'; }
}

/** The server does not have this endpoint (or this thing does not exist). */
export const isMissing = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 405);

export interface ClientOptions {
  /** '' for same-origin (the desktop renderer), else e.g. "http://127.0.0.1:4310". */
  base?: string;
  fetch?: Fetch;
  /** Extra headers on every request (Authorization for Node callers). */
  headers?: () => Record<string, string>;
}

export interface NewSession {
  title?: string; model?: string; effort?: Effort; mode?: Mode;
  runtime?: 'docker' | 'local' | 'companion'; path?: string; sandbox?: string; network?: 'none' | 'full' | 'allowlist';
  companionId?: string; worktree?: boolean; outputStyle?: string; gitUrl?: string;
}

export class HarnessClient {
  readonly base: string;
  readonly fetch: Fetch;
  private extra: () => Record<string, string>;
  /** Endpoints this server answered 404 to; not asked again this run. */
  private missing = new Set<string>();

  constructor(o: ClientOptions = {}) {
    this.base = (o.base ?? '').replace(/\/+$/, '');
    const f = o.fetch ?? (globalThis.fetch as Fetch);
    this.fetch = (input, init) => f(input, init);
    this.extra = o.headers ?? (() => ({}));
  }

  /** Does the server have this (new) endpoint? False once it answered 404. */
  has(feature: string): boolean { return !this.missing.has(feature); }

  async request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = { ...this.extra() };
    if (method !== 'GET' && method !== 'HEAD') { headers['content-type'] = 'application/json'; headers['x-harness'] = '1'; }
    let res: Response;
    try {
      res = await this.fetch(this.base + path, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body ?? {}), signal: opts.signal });
    } catch (e) {
      throw new ApiError(0, `The engine did not answer: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | undefined)?.error ?? (typeof data === 'string' && data ? data.slice(0, 300) : `HTTP ${res.status}`));
    return data as T;
  }
  get<T>(p: string, o?: { signal?: AbortSignal }) { return this.request<T>('GET', p, undefined, o); }
  post<T>(p: string, b?: unknown) { return this.request<T>('POST', p, b ?? {}); }
  put<T>(p: string, b?: unknown) { return this.request<T>('PUT', p, b ?? {}); }
  patch<T>(p: string, b?: unknown) { return this.request<T>('PATCH', p, b ?? {}); }
  del<T>(p: string) { return this.request<T>('DELETE', p); }

  /** Calls a new endpoint; on 404 remembers it is missing and returns the fallback. */
  private async optional<T>(feature: string, call: () => Promise<T>, fallback: () => Promise<T> | T): Promise<T> {
    if (this.missing.has(feature)) return fallback();
    try { return await call(); } catch (e) {
      if (isMissing(e)) { this.missing.add(feature); return fallback(); }
      throw e;
    }
  }

  // ---------------- server ----------------

  health(): Promise<Health> {
    return this.optional('health', () => this.get<Health>('/api/health'), async () => { await this.get<Me>('/api/me'); return { ok: true, legacy: true }; });
  }
  version(): Promise<VersionInfo | null> { return this.optional('version', () => this.get<VersionInfo>('/api/version'), () => null); }
  me(): Promise<Me> { return this.get<Me>('/api/me'); }
  config(): Promise<Config> { return this.get<Config>('/api/config'); }

  /** Models with whether each has a key. GET /api/models (new), else the config's list. */
  models(): Promise<ModelInfo[]> {
    return this.optional('models', async () => { const r = await this.get<ModelInfo[] | { models: ModelInfo[] }>('/api/models'); return Array.isArray(r) ? r : r.models; }, async () => (await this.config()).models);
  }

  // ---------------- providers (new) ----------------

  providers = {
    list: (): Promise<ProviderInfo[] | null> => this.optional('providers', async () => { const r = await this.get<ProviderInfo[] | { providers: ProviderInfo[] }>('/api/providers'); return Array.isArray(r) ? r : r.providers; }, () => null),
    set: (id: string, body: { apiKey?: string; baseUrl?: string }) => this.put<ProviderInfo>(`/api/providers/${encodeURIComponent(id)}`, body),
    removeKey: (id: string) => this.del<{ ok: boolean }>(`/api/providers/${encodeURIComponent(id)}/key`),
    test: (id: string) => this.post<ProviderTest>(`/api/providers/${encodeURIComponent(id)}/test`),
  };

  // ---------------- sessions ----------------

  sessions = {
    /** GET /api/sessions with search and paging (new); an older server returns every session as an array. */
    list: async (q: { query?: string; archived?: boolean; limit?: number; before?: string } = {}): Promise<SessionsPage> => {
      const params = new URLSearchParams();
      if (q.query) params.set('query', q.query);
      if (q.archived !== undefined) params.set('archived', String(q.archived));
      if (q.limit) params.set('limit', String(q.limit));
      if (q.before) params.set('before', q.before);
      const qs = params.toString();
      const r = await this.get<SessionMeta[] | SessionsPage>(`/api/sessions${qs ? `?${qs}` : ''}`);
      if (Array.isArray(r)) {
        // An older server ignores the query: filter here so search still works.
        let list = r;
        if (q.query) { const t = q.query.toLowerCase(); list = list.filter((s) => s.title?.toLowerCase().includes(t)); }
        if (q.archived !== undefined) list = list.filter((s) => !!s.archived === q.archived);
        return { sessions: list.sort((a, b) => b.updatedAt - a.updatedAt), next: null };
      }
      return { sessions: r.sessions, next: r.next ?? null };
    },
    get: (id: string) => this.get<SessionDetail>(`/api/sessions/${id}`),
    create: (b: NewSession) => this.post<SessionMeta>('/api/sessions', b),
    patch: (id: string, b: { title?: string; model?: string; effort?: Effort; mode?: Mode; pinned?: boolean; group?: string | null }) => this.patch<SessionMeta>(`/api/sessions/${id}`, b),
    remove: (id: string) => this.del<{ ok: boolean }>(`/api/sessions/${id}`),
    /** Sends a message; attachments (new) need a server that accepts them. */
    send: (id: string, text: string, attachments?: Attachment[]) => this.post<{ state: string }>(`/api/sessions/${id}/messages`, { text, ...(attachments?.length ? { attachments } : {}) }),
    abort: (id: string) => this.post<{ ok: boolean }>(`/api/sessions/${id}/abort`),
    respond: (id: string, b: { requestId: string; decision: string; feedback?: string; answer?: string }) => this.post<{ ok: boolean }>(`/api/sessions/${id}/respond`, b),
    archive: (id: string) => this.post<SessionMeta>(`/api/sessions/${id}/archive`),
    unarchive: (id: string) => this.post<SessionMeta>(`/api/sessions/${id}/unarchive`),
    fork: (id: string, turn?: number) => this.post<SessionMeta>(`/api/sessions/${id}/fork`, turn ? { turn } : {}),
    history: (id: string, q: { after?: number; limit?: number } = {}) => this.optional(`history`, () => this.get<HistoryPage>(`/api/sessions/${id}/history?after=${q.after ?? 0}${q.limit ? `&limit=${q.limit}` : ''}`), async () => { const d = await this.sessions.get(id); return { messages: d.history, next: null, lastSeq: d.lastSeq }; }),
    workflows: (id: string) => this.get<{ workflows: WorkflowInfo[]; runs: WorkflowRunView[] }>(`/api/sessions/${id}/workflows`),
    startWorkflow: (id: string, name: string, input: Record<string, string>) => this.post<unknown>(`/api/sessions/${id}/workflows`, { name, input }),
    resumeRun: (id: string, runId: string) => this.post<unknown>(`/api/sessions/${id}/runs/${runId}/resume`),
    capabilities: (id: string) => this.get<Capabilities>(`/api/sessions/${id}/capabilities`),
    sources: (id: string) => this.get<Array<{ id?: string | number; url: string; title?: string; snippet?: string }>>(`/api/sessions/${id}/sources`),
    tasks: async (id: string): Promise<TaskView[]> => (await this.sessions.get(id)).tasks ?? [],
    events: (id: string, after: number, onEvent: (e: HarnessEvent, seq: number) => void, onState?: (s: 'open' | 'retrying' | 'closed' | 'missing') => void) =>
      sessionEvents({ fetch: this.fetch, base: this.base, id, after, headers: this.extra, onEvent, onState }),
  };

  // ---------------- files and git (new routes, with the old files route as a fallback) ----------------

  files = {
    tree: (id: string, path = '.') => this.optional('files.tree', () => this.get<{ entries: FileEntry[] } | FileEntry[]>(`/api/sessions/${id}/files/tree?path=${encodeURIComponent(path)}`).then((r) => (Array.isArray(r) ? r : r.entries)),
      async () => (await this.get<{ type: 'dir'; files: FileEntry[] }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`)).files),
    read: (id: string, path: string) => this.get<FileContent>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
    write: (id: string, path: string, content: string) => this.put<{ ok: boolean }>(`/api/sessions/${id}/files/write`, { path, content }),
    rename: (id: string, from: string, to: string) => this.post<{ ok: boolean }>(`/api/sessions/${id}/files/rename`, { from, to }),
    remove: (id: string, path: string) => this.post<{ ok: boolean }>(`/api/sessions/${id}/files/delete`, { path }),
    upload: (id: string, path: string, base64: string) => this.post<{ ok: boolean }>(`/api/sessions/${id}/files/upload`, { path, base64 }),
    search: (id: string, query: string, content = false) => this.get<{ results: Array<{ path: string; line?: number; text?: string }> }>(`/api/sessions/${id}/files/search?query=${encodeURIComponent(query)}${content ? '&content=1' : ''}`),
  };
  git = {
    status: (id: string) => this.optional('git', () => this.get<GitStatus>(`/api/sessions/${id}/git/status`), () => null),
    diff: (id: string, path?: string) => this.get<{ diff: string }>(`/api/sessions/${id}/git/diff${path ? `?path=${encodeURIComponent(path)}` : ''}`),
    log: (id: string, limit = 30) => this.get<GitLogEntry[]>(`/api/sessions/${id}/git/log?limit=${limit}`),
  };

  // ---------------- approvals ----------------

  /** Every pending request the person can answer. GET /api/approvals (new), else gathered from waiting sessions. */
  approvals(): Promise<Approval[]> {
    return this.optional('approvals', async () => normaliseApprovals(await this.get<unknown>('/api/approvals')), async () => {
      const { sessions } = await this.sessions.list();
      const waiting = sessions.filter((s) => s.status === 'waiting');
      const details = await Promise.all(waiting.map((s) => this.sessions.get(s.id).catch(() => null)));
      return details.flatMap((d) => (d ? d.pending.filter(isPending).map((request) => ({ sessionId: d.meta.id, sessionTitle: d.meta.title, request })) : []));
    });
  }

  /** The global event stream (with a polling fallback). Call start() on it. */
  globalEvents(pollMs?: number): GlobalEvents {
    return new GlobalEvents({ fetch: this.fetch, base: this.base, headers: this.extra, pollMs, listSessions: async () => (await this.sessions.list()).sessions, listApprovals: () => this.approvals() });
  }

  // ---------------- plugins ----------------

  plugins = {
    /** GET /api/plugins (new: with UI manifests); else the config's list, every plugin enabled. */
    list: (): Promise<PluginInfo[]> => this.optional('plugins', async () => { const r = await this.get<PluginInfo[] | { plugins: PluginInfo[] }>('/api/plugins'); return Array.isArray(r) ? r : r.plugins; },
      async () => ((await this.config()).plugins ?? []).map((p) => ({ ...p, enabled: true, source: 'bundled' }))),
    enable: (name: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/enable`),
    disable: (name: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/disable`),
    uninstall: (name: string) => this.del<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(name)}`),
    catalogue: () => this.get<CatalogueEntry[] | { plugins: CatalogueEntry[] }>('/api/plugins/catalogue').then((r) => (Array.isArray(r) ? r : r.plugins ?? [])),
    install: (name: string) => this.post<{ name: string; version: string }>('/api/plugins/install', { name }),
    /** The URL of a plugin's UI file on the engine (main proxies harness://app/plugins/<name>/<path> to it). */
    uiFile: (name: string, file: string) => `${this.base}/api/plugins/${encodeURIComponent(name)}/ui/${file.split('/').map(encodeURIComponent).join('/')}`,
    /** A plugin's own server route. */
    route: <T>(name: string, path: string, method: 'GET' | 'POST' = 'GET', body?: unknown) => this.request<T>(method, `/api/plugins/${encodeURIComponent(name)}/${path}`, method === 'POST' ? body ?? {} : undefined),
  };

  // ---------------- settings, instructions, memory ----------------

  settings = {
    effective: () => this.optional('settings.effective', () => this.get<EffectiveSetting[] | { settings: EffectiveSetting[] }>('/api/settings/effective').then((r) => (Array.isArray(r) ? r : r.settings)), () => null),
    mine: () => this.get<Record<string, unknown>>('/api/me/settings'),
    saveMine: (b: Record<string, unknown>) => this.put<Record<string, unknown>>('/api/me/settings', b),
    instructions: () => this.get<{ content: string }>('/api/me/instructions'),
    saveInstructions: (content: string) => this.put<{ ok: boolean }>('/api/me/instructions', { content }),
  };
  memory = {
    list: (session: string) => this.get<{ scopes: { scope: string; label?: string }[]; mode: string; files: Array<{ path: string; size?: number; scope?: string }>; changes: unknown[] }>(`/api/memory?session=${session}`),
    read: (session: string, path: string) => this.get<{ path: string; content: string }>(`/api/memory/file?session=${session}&path=${encodeURIComponent(path)}`),
    write: (session: string, path: string, content: string) => this.put<{ ok: boolean }>(`/api/memory/file?session=${session}&path=${encodeURIComponent(path)}`, { content }),
    remove: (session: string, path: string) => this.del<{ ok: boolean }>(`/api/memory/file?session=${session}&path=${encodeURIComponent(path)}`),
  };

  // ---------------- vault, schedules, MCP bundles ----------------

  vault = {
    list: () => this.get<{ entries: VaultEntry[]; backends: string[]; defaultBackend?: string }>('/api/vault/entries'),
    put: (b: { name: string; value?: string; generate?: boolean; kind?: string; description?: string; scope?: string }) => this.post<VaultEntry>('/api/vault/entries', b),
    remove: (name: string, scope?: string) => this.del<{ ok: boolean }>(`/api/vault/entries/${encodeURIComponent(name)}${scope ? `?scope=${scope}` : ''}`),
  };
  schedules = {
    list: () => this.get<Schedule[]>('/api/schedules'),
    create: (b: { title?: string; prompt: string; cron?: string; at?: string; inMinutes?: number; sessionId?: string; trigger?: boolean }) => this.post<Schedule>('/api/schedules', b),
    remove: (id: string) => this.del<{ ok: boolean }>(`/api/schedules/${id}`),
    run: (id: string) => this.post<unknown>(`/api/schedules/${id}/run`),
    setEnabled: (id: string, on: boolean) => this.post<Schedule>(`/api/schedules/${id}/${on ? 'enable' : 'disable'}`),
  };
  mcpb = {
    list: () => this.get<McpBundle[]>('/api/mcpb'),
    install: (bundleBase64: string, userConfig: Record<string, unknown> = {}) => this.post<McpBundle>('/api/mcpb', { bundle: bundleBase64, userConfig }),
    remove: (name: string) => this.del<{ ok: boolean }>(`/api/mcpb/${encodeURIComponent(name)}`),
  };

  // ---------------- desktop sign-in (OIDC with PKCE, new) ----------------

  auth = {
    config: () => this.get<{ oidc: boolean; only: boolean; login: string | null }>('/auth/config'),
    desktopStart: (b: { redirectUri: string; codeChallenge: string; state: string }) => this.post<{ url: string }>('/auth/desktop/start', b),
    desktopToken: (b: { code: string; codeVerifier: string; redirectUri: string }) => this.post<{ token: string; expiresAt?: number; me?: Me }>('/auth/desktop/token', b),
  };
}

/** Accepts the shapes /api/approvals may answer with and returns one. */
export function normaliseApprovals(raw: unknown): Approval[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { approvals?: unknown }).approvals) ? (raw as { approvals: unknown[] }).approvals : [];
  const out: Approval[] = [];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const sessionId = String(o.sessionId ?? o.session ?? '');
    const request = (o.request ?? o.event ?? o) as PendingRequest;
    if (!sessionId || !request || typeof request !== 'object' || typeof (request as { requestId?: unknown }).requestId !== 'string' || !isPending(request as HarnessEvent)) continue;
    out.push({ sessionId, sessionTitle: typeof o.sessionTitle === 'string' ? o.sessionTitle : typeof o.title === 'string' ? o.title : undefined, request, at: typeof o.at === 'number' ? o.at : undefined });
  }
  return out;
}
