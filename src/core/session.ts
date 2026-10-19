import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CompanionHub } from '../runtime/companion.ts';
import { DockerHost, dockerDefaults } from '../runtime/docker.ts';
import type { ToolHost } from '../runtime/host.ts';
import { LocalHost, run } from '../runtime/host.ts';
import { ALL_TOOLS, EXPLORE_TOOLS } from '../tools/index.ts';
import type { FileStamp, Tool } from '../tools/types.ts';
import { Agent, type AgentHooks, type PermissionAnswer } from './agent.ts';
import { runHooks } from './hooks.ts';
import { type Effort, getModel, type ModelSpec } from './models.ts';
import { environmentBlock, firstMessageText, projectInstructions, SUBAGENT_PROMPT, SYSTEM_PROMPT } from './prompt.ts';
import { defaultSettings, loadProjectSettings, mergeSettings, type Settings } from './settings.ts';
import type { HarnessEvent, Message, PermissionMode, SessionStatus, Todo, TurnEndReason, Usage } from './types.ts';
import { addUsage, emptyUsage } from './types.ts';

export type RuntimeKind = 'docker' | 'local' | 'companion';

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  effort: Effort;
  mode: PermissionMode;
  runtime: { kind: RuntimeKind; network: 'none' | 'full'; companionId?: string; path?: string };
  createdAt: number;
  updatedAt: number;
  usage: Usage;
  cost: number;
  /** Cost and usage by model id (sub-agents can differ). */
  byModel: Record<string, { usage: Usage; cost: number; requests: number }>;
  todos: Todo[];
  /** Index into history where the model's current context starts (moves on compaction). */
  contextStart: number;
  compactions: number;
  lastPromptTokens: number;
  sessionRules: string[];
}

export interface StoredEvent { seq: number; at: number; event: HarnessEvent }

interface PendingRequest {
  kind: 'permission' | 'question' | 'plan';
  resolve(v: { decision: string; feedback?: string; answer?: string }): void;
  event: HarnessEvent;
}

export interface SessionDeps { dataDir: string; companions: CompanionHub }

const EVENT_BUFFER = 4000;

export class Session {
  meta: SessionMeta;
  history: Message[] = [];
  status: SessionStatus = 'idle';
  private dir: string;
  private deps: SessionDeps;
  private host?: ToolHost;
  private settings?: Settings;
  private agent?: Agent;
  private events: StoredEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: StoredEvent) => void>();
  private pending = new Map<string, PendingRequest>();
  private queued: string[] = [];
  private abortCtl?: AbortController;
  private readFiles = new Map<string, FileStamp>();
  private subagents = 0;
  private latestPrompt = '';
  private saveTimer?: NodeJS.Timeout;

  constructor(meta: SessionMeta, deps: SessionDeps) {
    this.meta = meta;
    this.deps = deps;
    this.dir = path.join(deps.dataDir, 'sessions', meta.id);
  }

  get workspace(): string {
    return this.meta.runtime.kind === 'local' && this.meta.runtime.path ? this.meta.runtime.path : path.join(this.deps.dataDir, 'workspaces', this.meta.id);
  }

  static async create(deps: SessionDeps, opts: { title?: string; model: string; effort?: Effort; mode?: PermissionMode; runtime: SessionMeta['runtime']; gitUrl?: string }): Promise<Session> {
    const model = getModel(opts.model);
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const s = new Session({
      id, title: opts.title?.slice(0, 80) || 'New session', model: model.id, effort: opts.effort && model.efforts.includes(opts.effort) ? opts.effort : model.effort,
      mode: opts.mode ?? 'default', runtime: opts.runtime, createdAt: now, updatedAt: now,
      usage: emptyUsage(), cost: 0, byModel: {}, todos: [], contextStart: 0, compactions: 0, lastPromptTokens: 0, sessionRules: [],
    }, deps);
    await fs.mkdir(s.dir, { recursive: true });
    if (opts.runtime.kind !== 'companion') {
      await fs.mkdir(s.workspace, { recursive: true });
      if (opts.gitUrl) {
        if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(opts.gitUrl)) throw new Error('Only https git URLs are supported.');
        const r = await run('git', ['clone', '--depth', '50', '--', opts.gitUrl, s.workspace], { timeoutMs: 300_000 });
        if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.trim().slice(0, 500)}`);
      }
    }
    await s.saveMeta();
    return s;
  }

  static async load(deps: SessionDeps, id: string): Promise<Session> {
    const dir = path.join(deps.dataDir, 'sessions', id);
    const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as SessionMeta;
    const s = new Session(meta, deps);
    try {
      const lines = (await fs.readFile(path.join(dir, 'history.jsonl'), 'utf8')).split('\n').filter(Boolean);
      for (const l of lines) { try { s.history.push(JSON.parse(l)); } catch { /* torn last line */ } }
    } catch { /* new */ }
    return s;
  }

  // ---------- events ----------

  emit(event: HarnessEvent): void {
    const e = { seq: ++this.seq, at: Date.now(), event };
    // Deltas are only useful live; keep the replay buffer for everything else.
    if (event.kind !== 'text_delta' && event.kind !== 'reasoning_delta') {
      this.events.push(e);
      if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    }
    for (const l of this.listeners) l(e);
  }

  subscribe(after: number, fn: (e: StoredEvent) => void): () => void {
    for (const e of this.events) if (e.seq > after) fn(e);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get lastSeq(): number { return this.seq; }

  pendingRequests(): HarnessEvent[] { return [...this.pending.values()].map((p) => p.event); }

  private setStatus(s: SessionStatus): void {
    this.status = s;
    this.emit({ kind: 'status', status: s });
  }

  // ---------- persistence ----------

  private async appendHistory(m: Message): Promise<void> {
    this.history.push(m);
    await fs.appendFile(path.join(this.dir, 'history.jsonl'), JSON.stringify(m) + '\n');
  }

  async saveMeta(): Promise<void> {
    this.meta.updatedAt = Date.now();
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, 'meta.json.tmp');
    await fs.writeFile(tmp, JSON.stringify(this.meta, null, 1));
    await fs.rename(tmp, path.join(this.dir, 'meta.json'));
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveMeta().catch(() => {}); }, 300);
  }

  // ---------- host & agent ----------

  private async getHost(): Promise<ToolHost> {
    if (this.host) return this.host;
    const r = this.meta.runtime;
    if (r.kind === 'docker') this.host = new DockerHost(this.meta.id, this.workspace, { ...dockerDefaults(), network: r.network });
    else if (r.kind === 'local') this.host = new LocalHost(this.workspace);
    else this.host = this.deps.companions.host(r.companionId ?? '', this.meta.id);
    return this.host;
  }

  async stopSandbox(): Promise<void> {
    if (this.host instanceof DockerHost && this.status === 'idle') await this.host.stop();
  }

  async destroy(): Promise<void> {
    this.abort();
    if (this.host instanceof DockerHost) await this.host.close();
    await fs.rm(this.dir, { recursive: true, force: true });
    if (this.meta.runtime.kind === 'docker' || (this.meta.runtime.kind === 'local' && !this.meta.runtime.path)) {
      await fs.rm(path.join(this.deps.dataDir, 'workspaces', this.meta.id), { recursive: true, force: true });
    }
  }

  private async getSettings(host: ToolHost): Promise<Settings> {
    if (this.settings) return this.settings;
    const project = host.kind === 'companion' ? {} : await loadProjectSettings(host.root);
    // Project hooks and allow-rules are repository content: trusted only when
    // commands are sandboxed.
    this.settings = mergeSettings(defaultSettings(), project, host.sandboxed);
    return this.settings;
  }

  private rules(): Settings['permissions'] {
    const base = this.settings!.permissions;
    return { ...base, allow: [...base.allow, ...this.meta.sessionRules] };
  }

  private async preamble(host: ToolHost): Promise<string> {
    let branch: string | undefined;
    if (host.kind !== 'companion') {
      const r = await run('git', ['-C', host.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
      if (r.code === 0) branch = r.stdout.trim();
    }
    return firstMessageText(await environmentBlock(host, { gitBranch: branch }), await projectInstructions(host), '');
  }

  private hooksFor(name: string, model: ModelSpec): AgentHooks {
    return {
      emit: (e) => this.emit(name === 'main' ? e : { ...e, agent: name } as HarnessEvent),
      onAppend: (m) => { if (name === 'main') this.appendHistory(m).catch((err) => this.emit({ kind: 'notice', level: 'error', text: `could not save history: ${err.message}` })); },
      onCompact: (ctx) => {
        if (name !== 'main') return;
        this.meta.contextStart = this.history.length;
        this.meta.compactions++;
        for (const m of ctx) this.appendHistory(m).catch(() => {});
        this.scheduleSave();
      },
      onUsage: (m, u, cost) => {
        this.meta.usage = addUsage(this.meta.usage, u);
        this.meta.cost += cost;
        const b = (this.meta.byModel[m.id] ??= { usage: emptyUsage(), cost: 0, requests: 0 });
        b.usage = addUsage(b.usage, u);
        b.cost += cost;
        b.requests++;
        if (name === 'main') this.meta.lastPromptTokens = u.input + u.cacheRead + u.cacheWrite;
        this.scheduleSave();
      },
      overBudget: () => this.meta.cost >= (this.settings?.maxCostUsd ?? Infinity) ? `Stopped: this session reached its spend limit of $${this.settings!.maxCostUsd.toFixed(2)}. Raise HARNESS_MAX_COST_USD to continue.` : undefined,
      getMode: () => this.meta.mode,
      rules: () => this.rules(),
      requestPermission: (tool, input, summary, suggestion, agent) => this.askPermission(tool, input, summary, suggestion, agent),
      takeQueuedUserText: () => (name === 'main' ? this.queued.splice(0) : []),
      todos: () => this.meta.todos,
      setTodos: (t) => { this.meta.todos = t; this.scheduleSave(); },
      preamble: async () => this.preamble(await this.getHost()),
      latestUserPrompt: () => this.latestPrompt,
    };
  }

  private async mainAgent(): Promise<Agent> {
    const host = await this.getHost();
    const settings = await this.getSettings(host);
    const model = getModel(this.meta.model);
    const cfg = {
      name: 'main', model, effort: this.meta.effort, system: SYSTEM_PROMPT, tools: ALL_TOOLS, host, settings,
      cacheKey: `hw-${this.meta.id}`, maxSteps: settings.maxSteps, readFiles: this.readFiles,
      runSubagent: (a: { description: string; prompt: string; type: 'explore' | 'general' }) => this.runSubagent(a),
      askUser: (q: string, o: string[]) => this.ask(q, o),
      proposePlan: (p: string) => this.proposePlan(p),
    };
    if (!this.agent) {
      this.agent = new Agent(cfg, this.hooksFor('main', model), this.history.slice(this.meta.contextStart));
      this.agent.lastPromptTokens = this.meta.lastPromptTokens;
    } else {
      // Model or effort may have changed between turns; the context stays.
      this.agent.cfg = { ...this.agent.cfg, ...cfg };
    }
    return this.agent;
  }

  private async runSubagent(a: { description: string; prompt: string; type: 'explore' | 'general' }): Promise<string> {
    const n = ++this.subagents;
    const name = `${a.type === 'explore' ? 'explore' : 'agent'}-${n}`;
    const host = await this.getHost();
    const settings = await this.getSettings(host);
    const model = getModel(settings.subagentModel ?? this.meta.model);
    const tools: Tool[] = ALL_TOOLS.filter((t) => (a.type === 'explore' ? EXPLORE_TOOLS.has(t.spec.name) : !['agent', 'ask_user', 'exit_plan_mode', 'todo_write'].includes(t.spec.name)));
    const readFiles = new Map<string, FileStamp>();
    const sub = new Agent({
      name, model, effort: a.type === 'explore' ? (model.efforts.includes('low') ? 'low' : model.effort) : this.meta.effort,
      system: SUBAGENT_PROMPT, tools, host, settings: { ...settings, permissions: this.rules() },
      cacheKey: `hw-${this.meta.id}-${a.type}`, maxSteps: Math.min(60, settings.maxSteps), readFiles,
    }, this.hooksFor(name, model));
    const env = await this.preamble(host);
    sub.append({ role: 'user', content: [{ type: 'text', text: `${env}\n\n<brief>\n${a.prompt}\n</brief>${a.type === 'explore' ? '\n\nYou are read-only: research and report; do not try to change files.' : ''}` }] });
    this.emit({ kind: 'notice', level: 'info', text: `Started ${name}: ${a.description}`, agent: name });
    const reason = await sub.run(this.abortCtl?.signal ?? new AbortController().signal);
    this.emit({ kind: 'turn_end', reason, agent: name });
    const last = [...sub.messages].reverse().find((m) => m.role === 'assistant');
    const text = last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() ?? '';
    const report = text ? (text.length > 16_000 ? text.slice(0, 16_000) + '\n[report truncated]' : text) : 'The sub-agent finished without a report.';
    return reason === 'done' ? report : `${report}\n\n(The sub-agent stopped early: ${reason}.)`;
  }

  // ---------- user interaction ----------

  private request(kind: PendingRequest['kind'], event: HarnessEvent & { requestId: string }): Promise<{ decision: string; feedback?: string; answer?: string }> {
    return new Promise((resolve) => {
      this.pending.set(event.requestId, { kind, resolve, event });
      this.setStatus('waiting');
      this.emit(event);
      this.abortCtl?.signal.addEventListener('abort', () => {
        if (this.pending.delete(event.requestId)) resolve({ decision: 'deny', feedback: 'The user interrupted.' });
      }, { once: true });
    });
  }

  respond(requestId: string, r: { decision: string; feedback?: string; answer?: string }): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.emit({ kind: 'request_resolved', requestId, decision: r.decision });
    if (this.pending.size === 0 && this.status === 'waiting') this.setStatus('running');
    p.resolve(r);
    return true;
  }

  private async askPermission(tool: Tool, input: Record<string, unknown>, summary: string, suggestion: string, agent: string): Promise<PermissionAnswer> {
    const requestId = crypto.randomUUID();
    const r = await this.request('permission', { kind: 'permission_request', requestId, tool: tool.spec.name, summary, input, suggestion, agent: agent === 'main' ? undefined : agent });
    if (r.decision === 'allow_always') {
      if (suggestion === 'edit_all') this.setMode('acceptEdits');
      else if (!this.meta.sessionRules.includes(suggestion)) { this.meta.sessionRules.push(suggestion); this.settings && this.scheduleSave(); }
      return { allow: true };
    }
    if (r.decision === 'allow') return { allow: true };
    return { allow: false, feedback: r.feedback };
  }

  private async ask(question: string, options: string[]): Promise<string> {
    const r = await this.request('question', { kind: 'question', requestId: crypto.randomUUID(), question, options });
    return r.answer?.trim() || r.feedback || '(no answer)';
  }

  private async proposePlan(plan: string): Promise<{ approved: boolean; feedback?: string }> {
    const r = await this.request('plan', { kind: 'plan_proposed', requestId: crypto.randomUUID(), plan });
    if (r.decision === 'approve' || r.decision === 'approve_accept_edits') {
      this.setMode(r.decision === 'approve_accept_edits' ? 'acceptEdits' : 'default');
      return { approved: true };
    }
    return { approved: false, feedback: r.feedback };
  }

  setMode(mode: PermissionMode): void {
    if (this.meta.mode === mode) return;
    const was = this.meta.mode;
    this.meta.mode = mode;
    this.emit({ kind: 'mode', mode });
    // Tell the model on its next turn, by appending (never by editing the system prompt).
    if (mode === 'plan') this.queued.push('<system-reminder>Plan mode is on: research with read-only tools, then present your plan with exit_plan_mode. Do not edit files or run commands that change anything.</system-reminder>');
    else if (was === 'plan') this.queued.push(`<system-reminder>Plan mode is off (permission mode: ${mode}).</system-reminder>`);
    this.scheduleSave();
  }

  update(patch: { title?: string; model?: string; effort?: Effort; mode?: PermissionMode }): void {
    if (patch.title) this.meta.title = patch.title.slice(0, 80);
    if (patch.model && patch.model !== this.meta.model) {
      const m = getModel(patch.model);
      this.meta.model = m.id;
      if (!m.efforts.includes(this.meta.effort)) this.meta.effort = m.effort;
      this.emit({ kind: 'notice', level: 'info', text: `Model switched to ${m.label}. The provider cache starts fresh for this conversation.` });
    }
    if (patch.effort) {
      const m = getModel(this.meta.model);
      if (m.efforts.includes(patch.effort)) this.meta.effort = patch.effort;
    }
    if (patch.mode) this.setMode(patch.mode);
    this.scheduleSave();
  }

  // ---------- turns ----------

  /** Starts a turn, or queues the text for the running one. */
  async send(text: string): Promise<'started' | 'queued'> {
    const t = text.trim();
    if (!t) throw new Error('empty message');
    if (this.status !== 'idle') {
      this.queued.push(t);
      this.latestPrompt = t;
      this.emit({ kind: 'notice', level: 'info', text: 'Message queued; the agent will see it at its next step.' });
      return 'queued';
    }
    this.latestPrompt = t;
    if (this.meta.title === 'New session') this.meta.title = t.replace(/\s+/g, ' ').slice(0, 60);
    this.runTurn(t).catch(() => {});
    return 'started';
  }

  private async runTurn(text: string): Promise<void> {
    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    this.setStatus('running');
    let reason: TurnEndReason = 'done';
    try {
      const agent = await this.mainAgent();
      const host = await this.getHost();
      const prompt = await runHooks(this.settings!, host, 'UserPromptSubmit', { prompt: text }, undefined, signal);
      if (prompt.blocked) {
        this.emit({ kind: 'notice', level: 'warn', text: `A UserPromptSubmit hook blocked this message: ${prompt.feedback}` });
        return;
      }
      const first = agent.messages.length === 0;
      let body = text;
      if (first) {
        const start = await runHooks(this.settings!, host, 'SessionStart', {}, undefined, signal);
        body = firstMessageText(await this.preamble(host), start.feedback ? `<session_start_context>\n${start.feedback}\n</session_start_context>` : '', text);
      }
      if (prompt.feedback) body += `\n\n<system-reminder>${prompt.feedback}</system-reminder>`;
      const pre = this.queued.splice(0).filter((q) => q.startsWith('<system-reminder>'));
      agent.append({ role: 'user', content: [...pre.map((q) => ({ type: 'text' as const, text: q })), { type: 'text', text: body }] });
      this.emit({ kind: 'user_message', text });
      reason = await agent.run(signal);
    } catch (err) {
      if (signal.aborted) reason = 'aborted';
      else {
        reason = 'error';
        this.emit({ kind: 'notice', level: 'error', text: (err as Error).message ?? String(err) });
      }
    } finally {
      this.abortCtl = undefined;
      for (const [id] of this.pending) this.respond(id, { decision: 'deny', feedback: 'turn ended' });
      this.emit({ kind: 'turn_end', reason });
      this.setStatus('idle');
      await this.saveMeta().catch(() => {});
      // A message typed after the last step starts the next turn.
      const rest = this.queued.splice(0).filter((q) => !q.startsWith('<system-reminder>'));
      if (rest.length && reason !== 'aborted') this.send(rest.join('\n\n')).catch(() => {});
    }
  }

  abort(): void {
    this.queued = this.queued.filter((q) => q.startsWith('<system-reminder>'));
    this.abortCtl?.abort(new Error('interrupted by the user'));
  }
}
