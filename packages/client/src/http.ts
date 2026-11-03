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
  isPending, PENDING_KINDS, type Approval, type FileTree, type SearchHit, type Attachment, type CatalogueEntry, type PluginReview, type PluginUpdateInfo, type PluginRevisionInfo, type Config, type Capabilities, type ContextBreakdown, type LiveProviderModels, type EffectiveSetting, type Effort, type FileContent, type FileEntry,
  type GitLogEntry, type GitStatus, type Health, type HarnessEvent, type HistoryPage, type McpBundle, type Me, type Mode, type ModelInfo, type PendingRequest, type PluginInfo, type SolutionImportInfo,
  type ProviderInfo, type ProviderTest, type InboxItem, type Interruptions, type NoticingOverview, type NoticeDetector, type AgentDef, type AgentInfo, type AgentOptions, type AgentRecord, type SkillInfo, type SkillImportResult, type CompanionInfo, type McpBuildDraft, type McpBuildRecord, type McpBuildSource, type McpBuildSpec, type McpImportResult, type McpServerConfig, type McpServerView, type McpTestResult, type McpToolPolicy, type Schedule, type ScheduleRun, type ScheduleStats, type WatchSpec, type SessionDetail, type SessionMeta, type SessionsPage, type TaskView, type VaultEntry, type VersionInfo, type WorkflowInfo, type WorkflowRunView,
  type ArtifactContent, type ArtifactMeta, type Proposal, type TraceSpan,
} from './types.ts';

export class ApiError extends Error {
  status: number;
  /** Seconds the server asked to wait before trying again (Retry-After on a 503). */
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) { super(message); this.status = status; this.name = 'ApiError'; if (retryAfter !== undefined) this.retryAfter = retryAfter; }
}

/** The server (or the app's proxy) is starting: worth asking again shortly. */
export const isStarting = (e: unknown): boolean => e instanceof ApiError && (e.status === 503 || e.status === 502 || e.status === 0);

/** The server does not have this endpoint (or this thing does not exist). */
export const isMissing = (e: unknown): boolean => e instanceof ApiError && (e.status === 404 || e.status === 405);

export interface ClientOptions {
  /** '' for same-origin (the desktop renderer), else e.g. "http://127.0.0.1:4310". */
  base?: string;
  fetch?: Fetch;
  /** Extra headers on every request (Authorization for Node callers). */
  headers?: () => Record<string, string>;
  /** Which client this is ("desktop"): its event streams say so (?client=), which makes it *attached* to its sessions. */
  clientKind?: string;
}

/** An agent-callable command of the app's own plugins (the server cannot read their manifests). */
export interface ClientCommand { id: string; description: string; inputSchema?: Record<string, unknown> }
/** Sent when a session is created: the client kind, its version, the fence languages and kinds it renders, the tools it answers (client_call) and its agent-callable commands. */
/** A plugin on in the app, for the session's one-line plugin index (its guide is the skill `<name>-guide`). */
export interface ClientPluginDecl { name: string; title?: string; purpose: string; from: 'app' | 'server'; tools?: string[] }
export interface ClientDescriptor { kind: 'desktop' | 'web' | string; version: string; renderers: string[]; tools: string[]; commands?: ClientCommand[]; plugins?: ClientPluginDecl[] }

export interface NewSession {
  title?: string; model?: string; effort?: Effort; mode?: Mode;
  runtime?: 'docker' | 'local' | 'companion'; path?: string; sandbox?: string; network?: 'none' | 'full' | 'allowlist';
  companionId?: string; worktree?: boolean; outputStyle?: string; gitUrl?: string;
  /** Runs as this agent (its instructions, tools, skills and autonomy; its model when none is named). */
  agent?: string;
  /** What the client can draw and answer (a server that does not know it ignores it). */
  client?: ClientDescriptor;
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
    this.clientKind = o.clientKind;
  }
  readonly clientKind?: string;

  /** Does the server have this (new) endpoint? False once it answered 404. */
  has(feature: string): boolean { return !this.missing.has(feature); }

  async request<T>(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; raw?: { body: string | Uint8Array; type: string } } = {}): Promise<T> {
    const headers: Record<string, string> = { ...this.extra() };
    if (method !== 'GET' && method !== 'HEAD') { headers['content-type'] = opts.raw?.type ?? 'application/json'; headers['x-harness'] = '1'; }
    let res: Response;
    try {
      res = await this.fetch(this.base + path, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : opts.raw ? opts.raw.body as BodyInit : JSON.stringify(body ?? {}), signal: opts.signal });
    } catch (e) {
      throw new ApiError(0, `The engine did not answer: ${(e as Error).message}`);
    }
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
    if (!res.ok) {
      const ra = Number(res.headers?.get?.('retry-after'));
      throw new ApiError(res.status, (data as { error?: string } | undefined)?.error ?? (typeof data === 'string' && data ? data.slice(0, 300) : `HTTP ${res.status}`), Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
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

  /** What each provider with a key offers now (its own list), each model marked known when the harness can run it. */
  liveModels(refresh = false): Promise<{ providers: LiveProviderModels[] }> { return this.get(`/api/models/live${refresh ? '?refresh=1' : ''}`); }

  /**
   * Models with whether each has a key. GET /api/models (new), else the config's list. A server
   * still starting answers 503 with Retry-After (and the app's proxy 502/503 while the engine
   * restarts): asked again, a few times, rather than reporting no models.
   */
  async models(o: { attempts?: number; wait?: (ms: number) => Promise<void> } = {}): Promise<ModelInfo[]> {
    const attempts = Math.max(1, o.attempts ?? 6);
    const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 1; ; i++) {
      try {
        const list = await this.optional('models', async () => { const r = await this.get<ModelInfo[] | { models: ModelInfo[] }>('/api/models'); return Array.isArray(r) ? r : r.models; }, async () => (await this.config()).models);
        if (list.length || i >= attempts) return list;
        await wait(500);
      } catch (e) {
        if (!isStarting(e) || i >= attempts) throw e;
        await wait(Math.min(3000, ((e as ApiError).retryAfter ?? 0.5) * 1000));
      }
    }
  }

  // ---------------- providers (new) ----------------

  providers = {
    list: (): Promise<ProviderInfo[] | null> => this.optional('providers', async () => { const r = await this.get<ProviderInfo[] | { providers: ProviderInfo[] }>('/api/providers'); return Array.isArray(r) ? r : r.providers; }, () => null),
    set: (id: string, body: { apiKey?: string; baseUrl?: string | null; options?: Record<string, boolean> }) => this.put<ProviderInfo>(`/api/providers/${encodeURIComponent(id)}`, body),
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
    patch: (id: string, b: { title?: string; model?: string; effort?: Effort; mode?: Mode; pinned?: boolean; group?: string | null; /** The app's plugins now (one was switched on or off). */ clientPlugins?: ClientPluginDecl[] }) => this.patch<SessionMeta>(`/api/sessions/${id}`, b),
    remove: (id: string) => this.del<{ ok: boolean }>(`/api/sessions/${id}`),
    /** Sends a message; attachments (new) need a server that accepts them. */
    send: (id: string, text: string, attachments?: Attachment[]) => this.post<{ state: string; images?: number; files?: string[] }>(`/api/sessions/${id}/messages`, { text, ...(attachments?.length ? { attachments } : {}) }),
    abort: (id: string) => this.post<{ ok: boolean }>(`/api/sessions/${id}/abort`),
    /** The swarm's kill switch: every agent of the run stops; the conversation's own agent goes on. */
    stopAgents: (id: string) => this.post<{ stopped: number }>(`/api/sessions/${id}/stop_agents`),
    /** The run recorder: the record's check and its replay (the steps as they happened), or the bundle itself. */
    record: (id: string) => this.get<{ verify: { ok: boolean; lines: number; problems: string[]; head?: string }; steps: { n: number; at: string; who: string; what: string }[] }>(`/api/sessions/${id}/record?view=replay`),
    recordBundle: (id: string) => this.get<Record<string, unknown>>(`/api/sessions/${id}/record`),
    /** `answer`: text, or for a question with a form, the filled-in object. */
    respond: (id: string, b: { requestId: string; decision: string; feedback?: string; answer?: string | Record<string, unknown> }) => this.post<{ ok: boolean }>(`/api/sessions/${id}/respond`, b),
    archive: (id: string) => this.post<SessionMeta>(`/api/sessions/${id}/archive`),
    unarchive: (id: string) => this.post<SessionMeta>(`/api/sessions/${id}/unarchive`),
    fork: (id: string, turn?: number) => this.post<SessionMeta>(`/api/sessions/${id}/fork`, turn ? { turn } : {}),
    /** Back to just before the person's turn-th message (from 0), to send it again or edited; `expect`: its text. */
    cut: (id: string, turn: number, expect?: string) => this.post<{ removed: number }>(`/api/sessions/${id}/cut`, { turn, ...(expect !== undefined ? { expect } : {}) }),
    history: (id: string, q: { after?: number; limit?: number } = {}) => this.optional(`history`, () => this.get<HistoryPage>(`/api/sessions/${id}/history?after=${q.after ?? 0}${q.limit ? `&limit=${q.limit}` : ''}`), async () => { const d = await this.sessions.get(id); return { total: d.history.length, messages: d.history.slice(q.after ?? 0), next: null }; }),
    workflows: (id: string) => this.get<{ workflows: WorkflowInfo[]; runs: WorkflowRunView[] }>(`/api/sessions/${id}/workflows`),
    startWorkflow: (id: string, name: string, input: Record<string, string>) => this.post<unknown>(`/api/sessions/${id}/workflows`, { name, input }),
    resumeRun: (id: string, runId: string) => this.post<unknown>(`/api/sessions/${id}/runs/${runId}/resume`),
    capabilities: (id: string) => this.get<Capabilities>(`/api/sessions/${id}/capabilities`),
    /** What fills the conversation's context, part by part. */
    context: (id: string) => this.get<ContextBreakdown>(`/api/sessions/${id}/context`),
    sources: (id: string) => this.get<Array<{ id?: string | number; url: string; title?: string; snippet?: string }>>(`/api/sessions/${id}/sources`),
    tasks: async (id: string): Promise<TaskView[]> => (await this.sessions.get(id)).tasks ?? [],
    events: (id: string, after: number, onEvent: (e: HarnessEvent, seq: number) => void, onState?: (s: 'open' | 'retrying' | 'closed' | 'missing') => void) =>
      sessionEvents({ fetch: this.fetch, base: this.base, id, after, headers: this.extra, onEvent, onState, client: this.clientKind }),
    /** Answers a client_call (a desktop tool the agent asked this app to run). */
    clientResult: (id: string, b: { callId: string; ok: boolean; result?: unknown; error?: string; untrusted?: boolean }) => this.post<{ ok: boolean }>(`/api/sessions/${id}/client-result`, b),
    /** Every model and tool call (cost per agent and model). */
    trace: (id: string) => this.get<TraceSpan[]>(`/api/sessions/${id}/trace`),
    /** Open proposals: sessions the agent offered to start. */
    proposals: (id: string) => this.get<Proposal[]>(`/api/sessions/${id}/proposals`),
  };

  // ---------------- artifacts and proposals ----------------

  artifacts = {
    /** A session's artifacts, newest first. */
    list: (sessionId: string) => this.get<ArtifactMeta[]>(`/api/sessions/${sessionId}/artifacts`),
    /** One version (the latest by default). */
    get: (sessionId: string, id: string, version?: number) => this.get<ArtifactContent>(`/api/sessions/${sessionId}/artifacts/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`),
    /** The Library: artifacts across every session the person may use. */
    library: (q: { query?: string; limit?: number } = {}) => this.optional('library', () => this.get<ArtifactMeta[]>(`/api/artifacts?${new URLSearchParams({ ...(q.query ? { query: q.query } : {}), ...(q.limit ? { limit: String(q.limit) } : {}) }).toString()}`), () => [] as ArtifactMeta[]),
  };

  proposals = {
    start: (pid: string) => this.post<{ proposal: string; session: SessionMeta }>(`/api/proposals/${encodeURIComponent(pid)}/start`),
    dismiss: (pid: string) => this.post<Proposal>(`/api/proposals/${encodeURIComponent(pid)}/dismiss`),
  };

  // ---------------- files and git (new routes, with the old files route as a fallback) ----------------

  files = {
    /** One folder (depth 1-3). Falls back to the older flat listing. */
    tree: (id: string, path = '', depth = 1): Promise<FileTree> => this.optional('files.tree', () => this.get<FileTree>(`/api/sessions/${id}/files/tree?path=${encodeURIComponent(path)}&depth=${depth}`),
      async () => ({ path: path || '.', entries: (await this.get<{ type: 'dir'; files: FileEntry[] }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path || '.')}`)).files.map((x) => ({ ...x, type: 'file' as const })) })),
    read: (id: string, path: string) => this.get<FileContent>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
    /** The file's new content as the raw body (up to 10 MB). */
    write: (id: string, path: string, content: string | Uint8Array) => this.request<{ path: string; size: number }>('PUT', `/api/sessions/${id}/files?path=${encodeURIComponent(path)}`, undefined, { raw: { body: content, type: 'application/octet-stream' } }),
    rename: (id: string, from: string, to: string, overwrite = false) => this.post<{ from: string; to: string }>(`/api/sessions/${id}/files/rename`, { from, to, ...(overwrite ? { overwrite } : {}) }),
    remove: (id: string, path: string) => this.del<{ path: string }>(`/api/sessions/${id}/files?path=${encodeURIComponent(path)}`),
    upload: (id: string, path: string, base64: string) => this.post<unknown>(`/api/sessions/${id}/files/upload`, { path, base64 }),
    search: (id: string, q: string, content = false, limit = 100) => this.get<{ query: string; results: SearchHit[]; truncated?: boolean }>(`/api/sessions/${id}/files/search?q=${encodeURIComponent(q)}&content=${content ? 1 : 0}&limit=${limit}`),
  };
  git = {
    status: (id: string) => this.optional('git', () => this.get<GitStatus>(`/api/sessions/${id}/git/status`), () => null),
    diff: (id: string, path?: string, staged = false) => this.get<{ repo: boolean; path?: string; staged: boolean; diff: string; truncated?: boolean }>(`/api/sessions/${id}/git/diff?staged=${staged ? 1 : 0}${path ? `&path=${encodeURIComponent(path)}` : ''}`),
    log: (id: string, limit = 30) => this.get<{ repo: boolean; commits: GitLogEntry[] }>(`/api/sessions/${id}/git/log?limit=${limit}`),
  };

  // ---------------- approvals ----------------

  /** Every pending request the person can answer. GET /api/approvals (new), else gathered from waiting sessions. */
  approvals(): Promise<Approval[]> {
    return this.optional('approvals', async () => normaliseApprovals(await this.get<unknown>('/api/approvals')), async () => {
      const { sessions } = await this.sessions.list();
      const waiting = sessions.filter((s) => s.status === 'waiting');
      const details = await Promise.all(waiting.map((s) => this.sessions.get(s.id).catch(() => null)));
      return details.flatMap((d) => (d ? d.pending.filter(isPending).map((request) => toApproval({ sessionId: d.meta.id, title: d.meta.title, request })).filter((a): a is Approval => !!a) : []));
    });
  }

  /** The full pending event behind an approval (options, plan text, inputs), from its session. */
  async fullRequest(a: Approval): Promise<PendingRequest | undefined> {
    if (a.request) return a.request;
    const d = await this.sessions.get(a.sessionId);
    return d.pending.filter(isPending).find((p) => p.requestId === a.requestId);
  }

  /** The global event stream (with a polling fallback). Call start() on it. */
  globalEvents(pollMs?: number): GlobalEvents {
    return new GlobalEvents({ fetch: this.fetch, base: this.base, headers: this.extra, pollMs, client: this.clientKind, listSessions: async () => (await this.sessions.list()).sessions, listApprovals: () => this.approvals() });
  }

  // ---------------- plugins ----------------

  plugins = {
    /** GET /api/plugins (new: with UI manifests); else the config's list, every plugin enabled. */
    list: (): Promise<PluginInfo[]> => this.optional('plugins', async () => { const r = await this.get<PluginInfo[] | { plugins: PluginInfo[] }>('/api/plugins'); return Array.isArray(r) ? r : r.plugins; },
      async () => ((await this.config()).plugins ?? []).map((p) => ({ ...p, enabled: true, source: 'bundled' }))),
    enable: (name: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/enable`),
    disable: (name: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/disable`),
    /** Removes a catalogue-installed plugin; its data folder is kept unless `deleteData`. */
    uninstall: (name: string, o: { deleteData?: boolean } = {}) => this.request<{ ok: boolean; dataKept?: boolean }>('DELETE', `/api/plugins/${encodeURIComponent(name)}`, { deleteData: o.deleteData === true }),
    catalogue: () => this.get<CatalogueEntry[] | { plugins: CatalogueEntry[] }>('/api/plugins/catalogue').then((r) => (Array.isArray(r) ? r : r.plugins ?? [])),
    install: (name: string) => this.post<{ name: string; version: string }>('/api/plugins/install', { name }),
    /** A deep review: one the server has (`name`), or a folder (`dir`, a server on this computer only). Runs its code and tests in a child process. */
    review: (o: { name?: string; dir?: string; tests?: boolean }) => this.post<PluginReview>('/api/plugins/review', o),
    /** Loads a plugin's code again (it changed), or a folder for the first time (`dir`, a server on this computer only). */
    reload: (name: string, dir?: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/reload`, dir ? { dir } : {}),
    /** Newer versions of the plugins installed on the server (administrators). */
    checkUpdates: () => this.get<PluginUpdateInfo[]>('/api/plugins/updates'),
    /** Installs a plugin's newer version; the one before is kept (rollback). */
    update: (name: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/update`),
    /** The earlier versions kept on the server, newest first. */
    revisions: (name: string) => this.get<PluginRevisionInfo[]>(`/api/plugins/${encodeURIComponent(name)}/revisions`),
    /** Back to a kept version (default: the newest kept). */
    rollback: (name: string, id?: string) => this.post<PluginInfo>(`/api/plugins/${encodeURIComponent(name)}/rollback`, id ? { id } : {}),
    /** A plugin as a bundle (.tgz): add it on another server or computer. */
    exportBundle: async (name: string): Promise<Uint8Array> => {
      const res = await this.fetch(`${this.base}/api/plugins/${encodeURIComponent(name)}/export`, { headers: { ...this.extra() } });
      if (!res.ok) { const t = await res.text(); let msg = t; try { msg = (JSON.parse(t) as { error?: string }).error ?? t; } catch { /* text */ } throw new ApiError(res.status, msg || `HTTP ${res.status}`); }
      return new Uint8Array(await res.arrayBuffer());
    },
    /** Adds a plugin from a bundle (.tgz), or updates the installed one to the bundle's newer version. */
    importBundle: (bytes: Uint8Array) => this.request<PluginInfo>('POST', '/api/plugins/import', undefined, { raw: { body: bytes, type: 'application/gzip' } }),
    /** Adds a plugin's bundle or a whole solution's (all its plugins, in order, all or none). */
    importFile: (bytes: Uint8Array) => this.request<PluginInfo | SolutionImportInfo>('POST', '/api/plugins/import', undefined, { raw: { body: bytes, type: 'application/gzip' } }),
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
  /** The agent inbox: results of unattended runs, what agents told the person, suggestions. */
  inbox = {
    list: (view: 'open' | 'all' = 'open') => this.get<{ items: InboxItem[]; unread: number }>(`/api/inbox?view=${view}`),
    /** accept: what a finding offered, done (its message sent to its conversation as the person's). */
    act: (id: string, action: 'read' | 'unread' | 'open' | 'snooze' | 'dismiss' | 'accept', o: { reason?: InboxItem['reason']; note?: string; until?: number } = {}) => this.post<InboxItem>(`/api/inbox/${id}`, { action, ...o }),
    readAll: () => this.post<{ read: number }>('/api/inbox/read-all'),
    /** The person's limits on interruptions: quiet hours, a most a day, a digest time. */
    settings: () => this.get<Interruptions>('/api/inbox/settings'),
    setSettings: (b: Interruptions) => this.put<Interruptions>('/api/inbox/settings', b),
  };
  /** Agents: the catalogue, what one can be given, and the person's own (versioned). */
  agents = {
    list: () => this.get<AgentInfo[]>('/api/agents'),
    options: () => this.get<AgentOptions>('/api/agents/options'),
    mine: () => this.get<AgentRecord[]>('/api/me/agents'),
    get: (name: string) => this.get<AgentRecord>(`/api/me/agents/${encodeURIComponent(name)}`),
    create: (def: AgentDef & { enabled?: boolean }) => this.post<AgentRecord>('/api/me/agents', def),
    /** A new version; with expectVersion, refused (409) when it changed since. `{enabled}` alone switches it on or off. */
    update: (name: string, def: Partial<AgentDef> & { enabled?: boolean }, expectVersion?: number) => this.put<AgentRecord>(`/api/me/agents/${encodeURIComponent(name)}`, { agent: def, ...(expectVersion !== undefined ? { expectVersion } : {}) }),
    remove: (name: string) => this.del<{ ok: boolean }>(`/api/me/agents/${encodeURIComponent(name)}`),
    versions: (name: string) => this.get<Array<{ version: number; at: number; def: AgentDef }>>(`/api/me/agents/${encodeURIComponent(name)}/versions`),
    restore: (name: string, version: number) => this.post<AgentRecord>(`/api/me/agents/${encodeURIComponent(name)}/restore`, { version }),
    /** As a Claude Code agent file (.claude/agents/<name>.md). */
    export: (name: string) => this.get<string>(`/api/me/agents/${encodeURIComponent(name)}/export`),
    /** An agent file (Claude Code's, Copilot's, Cursor's): new, or a new version of one with its name. */
    import: (text: string, name?: string) => this.post<AgentRecord>('/api/me/agents/import', { text, ...(name ? { name } : {}) }),
    /** A draft from a description (not saved). */
    generate: (description: string, model?: string) => this.post<{ draft: AgentDef; costUsd: number; dropped: string[] }>('/api/me/agents/generate', { description, ...(model ? { model } : {}) }),
  };

  /** The person's own skills: kept, imported (.skill / .zip packages, SKILL.md), viewed, exported, removed. */
  /** The person's computers (companions): each runs work on that machine, under the policy its owner set there. */
  readonly companions = {
    list: () => this.get<CompanionInfo[]>('/api/companions'),
    /** A new one: its token is shown once, for `harness-companion --server <url> --token <token>`. */
    create: (name: string) => this.post<{ id: string; token: string }>('/api/companions', { name }),
    /** A new token; the old one stops working at once. */
    rotate: (id: string) => this.post<{ id: string; token: string }>(`/api/companions/${encodeURIComponent(id)}/token`, {}),
    remove: (id: string) => this.del<{ ok: boolean }>(`/api/companions/${encodeURIComponent(id)}`),
  };
  readonly skills = {
    list: () => this.get<SkillInfo[]>('/api/me/skills'),
    /** A package (bytes, as base64) or a SKILL.md (text). */
    import: (b: { data?: string; text?: string; replace?: boolean }) => this.post<{ skills: SkillImportResult[] }>('/api/me/skills/import', b),
    get: (name: string) => this.get<{ manifest: SkillInfo; skill: string; files: string[] }>(`/api/me/skills/${encodeURIComponent(name)}`),
    remove: (name: string) => this.del<{ removed: boolean }>(`/api/me/skills/${encodeURIComponent(name)}`),
    exportUrl: (name: string) => `/api/me/skills/${encodeURIComponent(name)}/export`,
  };
  /** The person's own MCP servers: connected by URL (or a command, for an administrator), signed in, their tools approved. */
  mcp = {
    list: () => this.get<{ servers: McpServerView[]; admin: boolean }>('/api/me/mcp'),
    get: (name: string) => this.get<McpServerView>(`/api/me/mcp/${encodeURIComponent(name)}`),
    create: (server: McpServerConfig & { enabled?: boolean }) => this.post<McpServerView>('/api/me/mcp', server),
    /** A changed config, or only { enabled }; refused (409) when it changed since `expectVersion`. */
    update: (name: string, change: Partial<McpServerConfig> & { enabled?: boolean }, expectVersion?: number) => this.put<McpServerView>(`/api/me/mcp/${encodeURIComponent(name)}`, { ...change, ...(expectVersion !== undefined ? { expectVersion } : {}) }),
    remove: (name: string) => this.del<{ ok: boolean }>(`/api/me/mcp/${encodeURIComponent(name)}`),
    /** Connects now: what it offers, and which tools wait for approval. */
    test: (name: string) => this.post<McpTestResult>(`/api/me/mcp/${encodeURIComponent(name)}/test`, {}),
    /** Approves the tools as the server describes them now (all new and changed ones, or those named). */
    approve: (name: string, tools?: string[]) => this.post<McpTestResult>(`/api/me/mcp/${encodeURIComponent(name)}/approve`, tools ? { tools } : {}),
    setPolicies: (name: string, policies: Record<string, McpToolPolicy>) => this.put<McpServerView>(`/api/me/mcp/${encodeURIComponent(name)}/tools`, { policies }),
    /** The address to open in the browser to sign in (or ok: nothing to do). */
    signIn: (name: string) => this.post<{ authorizeUrl?: string; ok?: boolean }>(`/api/me/mcp/${encodeURIComponent(name)}/signin`, {}),
    signOut: (name: string) => this.post<{ ok: boolean }>(`/api/me/mcp/${encodeURIComponent(name)}/signout`, {}),
    /** A Claude Desktop, Claude Code, Cursor or VS Code config: what it holds, or (apply) added. */
    import: (text: string, o: { apply?: boolean; names?: string[] } = {}) => this.post<McpImportResult>('/api/me/mcp/import', { text, ...o }),
    /** What an MCP bundle (.mcpb, base64) is and the settings it asks for. */
    inspectBundle: (base64: string) => this.post<{ name: string; version?: string; description?: string; settings: Array<{ key: string; title?: string; description?: string; required?: boolean; sensitive?: boolean; default?: unknown }> }>('/api/me/mcp/bundle', { base64, inspect: true }),
    /** Installs it as one of the person's servers (administrators); secrets as ${vault:name}. */
    installBundle: (base64: string, userConfig: Record<string, string>) => this.post<McpServerView>('/api/me/mcp/bundle', { base64, userConfig }),
  };
  /** The MCP server builder: a draft from an OpenAPI document, a database, a command or a description; built and checked; packed; added. */
  mcpBuilds = {
    list: () => this.get<McpBuildRecord[]>('/api/me/mcp-builds'),
    get: (name: string) => this.get<McpBuildRecord>(`/api/me/mcp-builds/${encodeURIComponent(name)}`),
    draft: (from: McpBuildSource) => this.post<McpBuildDraft>('/api/me/mcp-builds/draft', from),
    /** Writes and checks the server; `settings` are its environment values (secrets as ${vault:name}). */
    build: (spec: McpBuildSpec, settings: Record<string, string> = {}, source?: string) => this.post<McpBuildRecord>('/api/me/mcp-builds', { spec, settings, ...(source ? { source } : {}) }),
    pack: (name: string) => this.post<McpBuildRecord>(`/api/me/mcp-builds/${encodeURIComponent(name)}/pack`, {}),
    /** The address of its .mcpb (a download). */
    bundleUrl: (name: string) => `/api/me/mcp-builds/${encodeURIComponent(name)}/bundle`,
    bundle: (name: string) => this.get<{ name: string; base64: string }>(`/api/me/mcp-builds/${encodeURIComponent(name)}/bundle?as=base64`),
    file: (name: string, path: string) => this.get<{ path: string; text: string }>(`/api/me/mcp-builds/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`),
    register: (name: string) => this.post<{ created: boolean; server: McpServerView }>(`/api/me/mcp-builds/${encodeURIComponent(name)}/register`, {}),
    remove: (name: string) => this.del<{ ok: boolean }>(`/api/me/mcp-builds/${encodeURIComponent(name)}`),
  };
  /** What the harness notices by itself: its mode, detectors, what it would have said in practice, what it observed. */
  noticing = {
    get: () => this.get<NoticingOverview>('/api/noticing'),
    set: (b: { mode?: NoticingOverview['mode']; detectors?: Partial<Record<NoticeDetector, boolean>> }) => this.put<NoticingOverview>('/api/noticing', b),
    /** Forgets what was observed (its activity log); findings and choices stay. */
    clear: () => this.post<{ cleared: number }>('/api/noticing/clear'),
    /** Looks at the person's schedules now. */
    check: () => this.post<NoticingOverview>('/api/noticing/check'),
  };
  schedules = {
    list: () => this.get<Schedule[]>('/api/schedules'),
    get: (id: string) => this.get<Schedule>(`/api/schedules/${id}`),
    /** Goes to `sessionId`, or makes a new session each run from `newSession` (one of the two). */
    create: (b: { title?: string; prompt: string; cron?: string; at?: string; inMinutes?: number; sessionId?: string; newSession?: { model: string; runtime: 'local' | 'docker'; path?: string; network?: 'none' | 'allowlist' | 'full'; mode?: string }; trigger?: boolean; timeZone?: string; misfire?: 'once' | 'skip'; maxCostUsd?: number; askTimeoutMinutes?: number; workflow?: { name: string; input: Record<string, string> }; watch?: WatchSpec; notify?: Schedule['notify'] }) => this.post<Schedule & { token?: string; url?: string }>('/api/schedules', b),
    /** Its title, prompt, timing or limits; null (or '') clears the time zone or the cost limit. */
    update: (id: string, b: { title?: string; prompt?: string; cron?: string; at?: string; inMinutes?: number; timeZone?: string | null; misfire?: 'once' | 'skip'; maxCostUsd?: number | null; askTimeoutMinutes?: number | null; workflow?: { name: string; input: Record<string, string> }; watch?: WatchSpec; notify?: Schedule['notify'] }) => this.patch<Schedule>(`/api/schedules/${id}`, b),
    remove: (id: string) => this.del<{ ok: boolean }>(`/api/schedules/${id}`),
    run: (id: string) => this.post<Schedule>(`/api/schedules/${id}/run`),
    /** A watch looks now: whether what it watches changed, and whether that started a run. */
    /** How useful each schedule has been, the last 30 days, by id. */
    stats: () => this.get<Record<string, ScheduleStats>>('/api/schedules/stats'),
    check: (id: string) => this.post<{ changed: boolean; ran: boolean; note?: string; schedule: Schedule }>(`/api/schedules/${id}/check`),
    setEnabled: (id: string, on: boolean) => this.post<Schedule>(`/api/schedules/${id}/${on ? 'enable' : 'disable'}`),
    /** Its runs, newest first. */
    runs: (id: string, limit = 50) => this.get<ScheduleRun[]>(`/api/schedules/${id}/runs?limit=${limit}`),
    /** The runs of all of the person's schedules and triggers, newest first. */
    allRuns: (limit = 50) => this.get<ScheduleRun[]>(`/api/schedule-runs?limit=${limit}`),
    /** What a timing means before a schedule is made: in words and its next runs, or why it is refused. */
    preview: (b: { cron?: string; at?: string; inMinutes?: number; timeZone?: string; watch?: WatchSpec }) => this.post<{ when?: string; next?: number[]; error?: string }>('/api/schedules/preview', b),
    /** The workflows a new conversation in this folder can run (the plugins', the folder's own). */
    workflows: (path?: string) => this.get<WorkflowInfo[]>(`/api/workflows${path ? `?path=${encodeURIComponent(path)}` : ''}`),
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

/** One approval from the server's item shape ({sessionId, requestId, kind, title, summary, tool?, at}) or a full pending event. */
export function toApproval(x: unknown): Approval | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const o = x as Record<string, unknown>;
  const sessionId = String(o.sessionId ?? o.session ?? '');
  const full = (o.request && typeof o.request === 'object' ? o.request : undefined) as PendingRequest | undefined;
  const requestId = String(o.requestId ?? full?.requestId ?? '');
  const kind = String(o.kind ?? full?.kind ?? '');
  if (!sessionId || !requestId || !(PENDING_KINDS as readonly string[]).includes(kind)) return undefined;
  return {
    sessionId, requestId, kind: kind as PendingRequest['kind'],
    ...(typeof o.title === 'string' ? { title: o.title } : {}),
    ...(typeof o.summary === 'string' ? { summary: o.summary } : full ? { summary: summaryOf(full) } : {}),
    ...(typeof o.tool === 'string' ? { tool: o.tool } : full?.kind === 'permission_request' ? { tool: full.tool } : {}),
    at: typeof o.at === 'number' ? o.at : Date.now(),
    ...(full ? { request: full } : {}),
  };
}

/** Accepts the shapes /api/approvals may answer with and returns one. */
export function normaliseApprovals(raw: unknown): Approval[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { approvals?: unknown }).approvals) ? (raw as { approvals: unknown[] }).approvals : [];
  return list.map(toApproval).filter((a): a is Approval => !!a);
}

/** The one-line summary of a pending request, as the server words it. */
export function summaryOf(e: PendingRequest): string {
  switch (e.kind) {
    case 'permission_request': return e.summary;
    case 'question': return e.question;
    case 'plan_proposed': return e.plan.slice(0, 500);
    case 'approval_request': return `${e.title}${e.message ? `: ${e.message}` : ''}`.slice(0, 500);
  }
}
