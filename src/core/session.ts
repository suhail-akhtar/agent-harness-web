import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { resolveIn } from '../tools/paths.ts';
import path from 'node:path';
import { BUILTIN_AGENTS, INTERACTIVE_TOOLS, loadAgentDir, makeAgentTool } from '../agents/agents.ts';
import { formatGates, makeGatesTool, runGates } from '../gates/gates.ts';
import { newRun, WorkflowRunner } from '../graph/runner.ts';
import type { RunRecord, WorkflowDef, WorkflowHost } from '../graph/types.ts';
import type { InProcessHook } from '../kernel/registry.ts';
import { loadWorkflowDir } from '../plugins/loader.ts';
import type { Registry } from '../kernel/registry.ts';
import type { McpManager, McpStatus } from '../mcp/manager.ts';
import { deferredTools, MCP_INLINE_MAX, type McpEntry, mcpTool } from '../mcp/tools.ts';
import type { AgentDef } from '../plugins/api.ts';
import type { CompanionHub } from '../runtime/companion.ts';
import { DockerHost, dockerDefaults } from '../runtime/docker.ts';
import type { ToolHost } from '../runtime/host.ts';
import { LocalHost, run } from '../runtime/host.ts';
import { makeSkillTool, type Skill, skillsIn, skillsListing, workspaceSkills } from '../skills/skills.ts';
import { sortTools } from '../tools/index.ts';
import type { FileStamp, Tool } from '../tools/types.ts';
import { Agent, type AgentHooks, type PermissionAnswer, type TraceSpan } from './agent.ts';
import { Checkpoints } from './checkpoints.ts';
import { runHooks } from './hooks.ts';
import type { Effort, ModelSpec } from './models.ts';
import { environmentBlock, firstMessageText, projectInstructions, SUBAGENT_PROMPT, SYSTEM_PROMPT } from './prompt.ts';
import { defaultSettings, loadProjectSettings, mergeSettings, type Settings } from './settings.ts';
import type { HarnessEvent, Message, PermissionMode, SessionStatus, Todo, ToolUseBlock, TurnEndReason, Usage, WorkflowRunView } from './types.ts';
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
  /** User turns started (checkpoints are numbered by it). */
  turns?: number;
  /** True while a turn runs; still true on load means the server stopped mid-turn. */
  running?: boolean;
}

export interface StoredEvent { seq: number; at: number; event: HarnessEvent }

interface PendingRequest {
  kind: 'permission' | 'question' | 'plan' | 'approval';
  resolve(v: { decision: string; feedback?: string; answer?: string }): void;
  event: HarnessEvent;
}

export interface SessionDeps {
  dataDir: string; companions: CompanionHub; registry: Registry; mcp: McpManager;
  /** Every trace span as it is written (OpenTelemetry export). */
  onSpan?: (sessionId: string, span: TraceSpan & { at: number }) => void;
}

/** What one session can use, assembled once (the tool list never changes mid-session: it would break the cache). */
interface Toolbox {
  tools: Tool[];
  agents: AgentDef[];
  skills: Skill[];
  mcp: McpStatus[];
  workflows: WorkflowDef[];
  closeProject(): Promise<void>;
}

const EVENT_BUFFER = 4000;
const TRUST_PROJECT = process.env.HARNESS_TRUST_PROJECT === '1';

export function runView(run: RunRecord, w?: WorkflowDef): WorkflowRunView {
  return {
    id: run.id, workflow: run.workflow, status: run.status, current: run.current, cost: run.cost, error: run.error,
    nodes: w ? Object.entries(w.nodes).map(([id, n]) => ({ id, type: n.type, title: n.title })) : [],
    history: run.history.map((h) => ({ node: h.node, type: h.type, status: h.status, outcome: h.outcome, summary: h.summary, startedAt: h.startedAt, endedAt: h.endedAt, cost: h.cost })),
  };
}

export class Session {
  meta: SessionMeta;
  history: Message[] = [];
  status: SessionStatus = 'idle';
  private dir: string;
  private deps: SessionDeps;
  private host?: ToolHost;
  private settings?: Settings;
  private toolbox?: Promise<Toolbox>;
  private agent?: Agent;
  private checkpoints?: Checkpoints;
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
    const model = deps.registry.model(opts.model);
    const id = crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const s = new Session({
      id, title: opts.title?.slice(0, 80) || 'New session', model: model.id, effort: opts.effort && model.efforts.includes(opts.effort) ? opts.effort : model.effort,
      mode: opts.mode ?? 'default', runtime: opts.runtime, createdAt: now, updatedAt: now,
      usage: emptyUsage(), cost: 0, byModel: {}, todos: [], contextStart: 0, compactions: 0, lastPromptTokens: 0, sessionRules: [], turns: 0,
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

  private trace(span: TraceSpan): void {
    const rec = { at: Date.now(), ...span };
    fs.appendFile(path.join(this.dir, 'trace.jsonl'), JSON.stringify(rec) + '\n').catch(() => {});
    this.deps.onSpan?.(this.meta.id, rec);
  }

  async readTrace(): Promise<(TraceSpan & { at: number })[]> {
    try {
      return (await fs.readFile(path.join(this.dir, 'trace.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  /**
   * The server stopped while this session was mid-turn. Close it out in an
   * append-only way: every tool call left without a result gets one saying
   * so, and the session is idle again (and can be resumed).
   */
  async recoverInterrupted(): Promise<boolean> {
    if (!this.meta.running) return false;
    const ctx = this.history.slice(this.meta.contextStart);
    const last = ctx[ctx.length - 1];
    if (last?.role === 'assistant') {
      const dangling = last.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (dangling.length) {
        await this.appendHistory({
          role: 'user',
          content: [
            ...dangling.map((d) => ({ type: 'tool_result' as const, tool_use_id: d.id, is_error: true, content: 'Not run: the server restarted before this call completed.' })),
            { type: 'text' as const, text: '<system-reminder>The server restarted while you were working. Check the state of anything you were changing before continuing.</system-reminder>' },
          ],
        });
      }
    }
    this.meta.running = false;
    await this.saveMeta();
    this.emit({ kind: 'notice', level: 'warn', text: 'The server restarted while this session was working. Send "continue" to resume.' });
    return true;
  }

  // ---------- host, settings, toolbox ----------

  private async getHost(): Promise<ToolHost> {
    if (this.host) return this.host;
    const r = this.meta.runtime;
    if (r.kind === 'docker') this.host = new DockerHost(this.meta.id, this.workspace, { ...dockerDefaults(), network: r.network });
    else if (r.kind === 'local') this.host = new LocalHost(this.workspace);
    else this.host = this.deps.companions.host(r.companionId ?? '', this.meta.id);
    if (this.host.kind !== 'companion') this.checkpoints = new Checkpoints(this.dir, this.workspace);
    return this.host;
  }

  /** Repository content is trusted to run code only inside the sandbox (or when the operator says so). */
  private projectTrusted(host: ToolHost): boolean {
    return host.sandboxed || TRUST_PROJECT;
  }

  async stopSandbox(): Promise<void> {
    if (this.host instanceof DockerHost && this.status === 'idle') {
      if (this.toolbox) { (await this.toolbox).closeProject().catch(() => {}); this.toolbox = undefined; this.agent = undefined; }
      await this.host.stop();
    }
  }

  async destroy(): Promise<void> {
    this.abort();
    if (this.toolbox) await (await this.toolbox).closeProject().catch(() => {});
    if (this.host instanceof DockerHost) await this.host.close();
    await fs.rm(this.dir, { recursive: true, force: true });
    if (this.meta.runtime.kind === 'docker' || (this.meta.runtime.kind === 'local' && !this.meta.runtime.path)) {
      await fs.rm(path.join(this.deps.dataDir, 'workspaces', this.meta.id), { recursive: true, force: true });
    }
  }

  private async getSettings(host: ToolHost): Promise<Settings> {
    if (this.settings) return this.settings;
    const project = host.kind === 'companion' ? {} : await loadProjectSettings(host.root);
    const base = defaultSettings();
    // Operator hooks from plugin manifests apply everywhere.
    for (const [ev, specs] of Object.entries(this.deps.registry.shellHooks)) {
      (base.hooks[ev as keyof Settings['hooks']] ??= []).push(...(specs ?? []));
    }
    // Project hooks and allow-rules are repository content: trusted only when
    // commands are sandboxed.
    this.settings = mergeSettings(base, project, this.projectTrusted(host));
    return this.settings;
  }

  private rules(): Settings['permissions'] {
    const base = this.settings!.permissions;
    return { ...base, allow: [...base.allow, ...this.meta.sessionRules] };
  }

  private getToolbox(host: ToolHost): Promise<Toolbox> {
    this.toolbox ??= this.buildToolbox(host).catch((err) => { this.toolbox = undefined; throw err; });
    return this.toolbox;
  }

  private async buildToolbox(host: ToolHost): Promise<Toolbox> {
    const reg = this.deps.registry;
    const tools: Tool[] = [...reg.tools.values()];

    // Skills: operator plugins first, then the workspace's (a name is taken once).
    const skills: Skill[] = [];
    const seen = new Set<string>();
    for (const sd of reg.skillDirs) for (const s of await skillsIn(sd.dir, sd.source)) if (!seen.has(s.name)) { seen.add(s.name); skills.push(s); }
    for (const s of await workspaceSkills(host).catch(() => [])) if (!seen.has(s.name)) { seen.add(s.name); skills.push(s); }
    if (skills.length) tools.push(makeSkillTool(skills));

    // Agents: built-in, plugins, then the workspace's definitions.
    const agents = new Map<string, AgentDef>();
    for (const a of BUILTIN_AGENTS) agents.set(a.name, a);
    for (const a of reg.agents.values()) agents.set(a.name, a);
    if (host.kind !== 'companion') {
      for (const rel of ['.claude/agents', '.harness/agents']) {
        for (const a of await loadAgentDir(path.join(host.root, rel), 'project')) if (!BUILTIN_AGENTS.some((b) => b.name === a.name)) agents.set(a.name, a);
      }
    }
    tools.push(makeAgentTool([...agents.values()]));
    if (reg.gates.size) tools.push(makeGatesTool(reg));

    // Workflows: plugins', then the project's (JSON; a shell node runs only where project commands are trusted).
    const workflows = new Map<string, WorkflowDef>(reg.workflows);
    if (host.kind !== 'companion') {
      for (const w of await loadWorkflowDir(path.join(host.root, '.harness', 'workflows'), 'project')) {
        if (!this.projectTrusted(host) && Object.values(w.nodes).some((n) => n.type === 'shell')) continue;
        workflows.set(w.name, w);
      }
    }

    // MCP: operator servers (shared) and the project's (this session's).
    const server = await this.deps.mcp.serverEntries(new Map([...reg.mcpServers].map(([k, v]) => [k, v])));
    const project = await this.deps.mcp.projectEntries(host, this.projectTrusted(host));
    const entries: McpEntry[] = [...server.entries, ...project.entries];
    if (entries.length && entries.length <= MCP_INLINE_MAX) {
      const names = new Set(tools.map((t) => t.spec.name));
      for (const e of entries) if (!names.has(e.qualified)) tools.push(mcpTool(e));
    } else if (entries.length) {
      const d = deferredTools(entries);
      tools.push(d.search, d.call);
    }
    const mcp = [...server.status, ...project.status];
    for (const st of mcp.filter((x) => !x.ok)) this.emit({ kind: 'notice', level: 'warn', text: `MCP server ${st.name} (${st.scope}) is not available: ${st.error}` });
    return { tools: sortTools(tools), agents: [...agents.values()], skills, mcp, workflows: [...workflows.values()], closeProject: project.close };
  }

  async capabilities(): Promise<{ tools: { name: string; kind: string }[]; agents: { name: string; description: string; source?: string }[]; skills: { name: string; description: string; source: string }[]; mcp: McpStatus[]; plugins: Registry['plugins'] }> {
    const tb = await this.getToolbox(await this.getHost());
    return {
      tools: tb.tools.map((t) => ({ name: t.spec.name, kind: t.kind })),
      agents: tb.agents.map((a) => ({ name: a.name, description: a.description, source: a.source })),
      skills: tb.skills.map((s) => ({ name: s.name, description: s.description, source: s.source })),
      mcp: tb.mcp,
      plugins: this.deps.registry.plugins,
    };
  }

  private async preamble(host: ToolHost): Promise<string> {
    let branch: string | undefined;
    if (host.kind !== 'companion') {
      const r = await run('git', ['-C', host.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 });
      if (r.code === 0) branch = r.stdout.trim();
    }
    const tb = await this.getToolbox(host);
    return firstMessageText(await environmentBlock(host, { gitBranch: branch }), [await projectInstructions(host), skillsListing(tb.skills)].filter(Boolean).join('\n\n'), '');
  }

  private hooksFor(name: string, costSink?: (c: number) => void): AgentHooks {
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
        costSink?.(cost);
        this.meta.usage = addUsage(this.meta.usage, u);
        this.meta.cost += cost;
        const b = (this.meta.byModel[m.id] ??= { usage: emptyUsage(), cost: 0, requests: 0 });
        b.usage = addUsage(b.usage, u);
        b.cost += cost;
        b.requests++;
        if (name === 'main') this.meta.lastPromptTokens = u.input + u.cacheRead + u.cacheWrite;
        this.scheduleSave();
      },
      onTrace: (span) => this.trace(span),
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
    const tb = await this.getToolbox(host);
    const model = this.deps.registry.model(this.meta.model);
    const cfg = {
      name: 'main', model, provider: this.deps.registry.provider(model), effort: this.meta.effort, system: SYSTEM_PROMPT, tools: tb.tools, host, settings,
      cacheKey: `hw-${this.meta.id}`, maxSteps: settings.maxSteps, readFiles: this.readFiles,
      inProcessHooks: [...this.deps.registry.hooks, ...this.gatesOnStopHook(settings)],
      runSubagent: (a: { description: string; prompt: string; type: string }) => this.runSubagent(a),
      askUser: (q: string, o: string[]) => this.ask(q, o),
      proposePlan: (p: string) => this.proposePlan(p),
      beforeWrite: this.checkpoints ? (p: string) => this.checkpoints!.before(p) : undefined,
    };
    if (!this.agent) {
      this.agent = new Agent(cfg, this.hooksFor('main'), this.history.slice(this.meta.contextStart));
      this.agent.lastPromptTokens = this.meta.lastPromptTokens;
    } else {
      // Model or effort may have changed between turns; the context stays.
      this.agent.cfg = { ...this.agent.cfg, ...cfg };
    }
    return this.agent;
  }

  private subagentModel(def: AgentDef, settings: Settings): ModelSpec {
    for (const id of [def.model, settings.subagentModel]) {
      if (!id) continue;
      const m = this.deps.registry.listModels().find((x) => x.id === id && x.available);
      if (m) return m;
    }
    return this.deps.registry.model(this.meta.model);
  }

  /** "Don't finish while a blocking gate fails" (settings.gatesOnStop / HARNESS_GATES_ON_STOP=1). */
  private gatesOnStopHook(settings: Settings): InProcessHook[] {
    if (!settings.gatesOnStop || !this.deps.registry.gates.size) return [];
    return [{
      event: 'Stop', plugin: 'harness', handler: async (_p, ctx) => {
        const results = await runGates(this.deps.registry, ctx.host, 'applicable', ctx.signal);
        const failing = results.filter((r) => !r.pass && r.severity !== 'advisory');
        if (!failing.length) return undefined;
        return { block: true, feedback: `Quality gates are failing - fix them before you finish:\n${formatGates(results)}` };
      },
    }];
  }

  private async runSubagent(a: { description: string; prompt: string; type: string }): Promise<string> {
    const r = await this.runAgent({ agent: a.type, description: a.description, prompt: a.prompt, signal: this.abortCtl?.signal ?? new AbortController().signal });
    return r.report;
  }

  /**
   * Runs a named agent in a fresh context: a chat sub-agent, or a workflow's
   * agent node. One cache key per agent kind, so sibling runs share a prefix.
   */
  async runAgent(a: { agent: string; prompt: string; signal: AbortSignal; label?: string; description?: string; model?: string; effort?: Effort; maxSteps?: number; allowTodos?: boolean }): Promise<{ report: string; reason: string; cost: number }> {
    const host = await this.getHost();
    const settings = await this.getSettings(host);
    const tb = await this.getToolbox(host);
    const def = tb.agents.find((x) => x.name === a.agent) ?? tb.agents.find((x) => x.name === 'general')!;
    const n = ++this.subagents;
    const name = a.label ?? `${def.name}-${n}`;
    const model = this.subagentModel({ ...def, model: a.model ?? def.model }, settings);
    const banned = a.allowTodos ? INTERACTIVE_TOOLS.filter((t) => t !== 'todo_write') : INTERACTIVE_TOOLS;
    const tools = tb.tools.filter((t) => (def.tools ? def.tools.includes(t.spec.name) || (a.allowTodos && t.spec.name === 'todo_write') : !banned.includes(t.spec.name)) && t.spec.name !== 'agent');
    const wanted = a.effort ?? def.effort;
    const effort = wanted && model.efforts.includes(wanted) ? wanted : (model.efforts.includes(this.meta.effort) ? this.meta.effort : model.effort);
    let cost = 0;
    const sub = new Agent({
      name, model, provider: this.deps.registry.provider(model), effort,
      system: SUBAGENT_PROMPT, tools, host, settings,
      cacheKey: `hw-${this.meta.id}-${def.name}`, maxSteps: Math.min(a.maxSteps ?? (a.allowTodos ? 150 : 60), settings.maxSteps), readFiles: new Map<string, FileStamp>(),
      inProcessHooks: this.deps.registry.hooks,
      beforeWrite: this.checkpoints ? (p: string) => this.checkpoints!.before(p) : undefined,
    }, this.hooksFor(name, (c) => { cost += c; }));
    const env = await this.preamble(host);
    sub.append({ role: 'user', content: [{ type: 'text', text: `${env}${def.prompt ? `\n\n<role>\n${def.prompt}\n</role>` : ''}\n\n<brief>\n${a.prompt}\n</brief>` }] });
    this.emit({ kind: 'notice', level: 'info', text: `Started ${name} (${def.name}, ${model.id})${a.description ? `: ${a.description}` : ''}`, agent: name });
    const reason = await sub.run(a.signal);
    this.emit({ kind: 'turn_end', reason, agent: name });
    const last = [...sub.messages].reverse().find((m) => m.role === 'assistant');
    const text = last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim() ?? '';
    const report = text ? (text.length > 16_000 ? text.slice(0, 16_000) + '\n[report truncated]' : text) : 'The agent finished without a report.';
    return { report: reason === 'done' ? report : `${report}\n\n(The agent stopped early: ${reason}.)`, reason, cost };
  }

  // ---------- workflows ----------

  private runsDir() { return path.join(this.dir, 'runs'); }

  async workflows(): Promise<WorkflowDef[]> {
    return (await this.getToolbox(await this.getHost())).workflows;
  }

  async listRuns(): Promise<WorkflowRunView[]> {
    let names: string[];
    try { names = await fs.readdir(this.runsDir()); } catch { return []; }
    const wfs = await this.workflows().catch(() => [] as WorkflowDef[]);
    const out: WorkflowRunView[] = [];
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      try {
        const r = JSON.parse(await fs.readFile(path.join(this.runsDir(), n), 'utf8')) as RunRecord;
        out.push(runView(r, wfs.find((w) => w.name === r.workflow)));
      } catch { /* partial */ }
    }
    return out.sort((a, b) => (b.history[0]?.startedAt ?? 0) - (a.history[0]?.startedAt ?? 0));
  }

  async readRun(runId: string): Promise<RunRecord> {
    if (!/^run_[a-f0-9]+$/.test(runId)) throw new Error('bad run id');
    return JSON.parse(await fs.readFile(path.join(this.runsDir(), `${runId}.json`), 'utf8')) as RunRecord;
  }

  private runWrites = new Map<string, Promise<void>>();

  /** Saves are queued per run: parallel branches save at the same moment. */
  private saveRun(run: RunRecord): Promise<void> {
    const body = JSON.stringify(run, null, 1);
    const prev = this.runWrites.get(run.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      await fs.mkdir(this.runsDir(), { recursive: true });
      const f = path.join(this.runsDir(), `${run.id}.json`);
      const tmp = `${f}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, body);
      await fs.rename(tmp, f);
    });
    this.runWrites.set(run.id, next);
    return next;
  }

  /** Runs marked running when the server stopped become "interrupted" (resumable). */
  async recoverRuns(): Promise<void> {
    let names: string[];
    try { names = await fs.readdir(this.runsDir()); } catch { return; }
    for (const n of names.filter((x) => x.endsWith('.json'))) {
      const r = JSON.parse(await fs.readFile(path.join(this.runsDir(), n), 'utf8')) as RunRecord;
      if (r.status === 'running' || r.status === 'waiting') { r.status = 'interrupted'; await this.saveRun(r); }
    }
  }

  private workflowHost(w: WorkflowDef): WorkflowHost {
    return {
      host: () => this.getHost(),
      runAgent: (a) => this.runAgent({ ...a, allowTodos: true }),
      runGates: async (names, signal) => runGates(this.deps.registry, await this.getHost(), names, signal),
      approve: async ({ runId, node, title, message, files }) => {
        const host = await this.getHost();
        const shown: { path: string; content: string }[] = [];
        for (const f of files.slice(0, 4)) {
          if (host.kind === 'companion') break;
          // Workflow files may come from the workspace: resolve inside it, symlinks included.
          const real = await resolveIn(host, f).catch(() => null);
          const content = real ? await fs.readFile(real, 'utf8').catch(() => '') : '';
          if (content) shown.push({ path: f, content: content.slice(0, 30_000) });
        }
        const r = await this.request('approval', { kind: 'approval_request', requestId: crypto.randomUUID(), runId, node, title, message, files: shown });
        return { approved: r.decision === 'approve', feedback: r.feedback };
      },
      emit: (e) => this.emit({ kind: 'workflow', phase: e.phase, node: e.node, run: runView(e.run, w) }),
      save: (run) => this.saveRun(run),
    };
  }

  /** Starts a workflow run in this session's workspace. */
  async startWorkflow(name: string, input: Record<string, string>): Promise<WorkflowRunView> {
    if (this.status !== 'idle') throw new Error('The session is busy; wait for it to finish or stop it.');
    const w = (await this.workflows()).find((x) => x.name === name);
    if (!w) throw new Error(`No workflow named "${name}".`);
    const run = newRun(w, this.meta.id, input);
    if (this.meta.title === 'New session') {
      const first = Object.values(run.input).find((v) => v.trim()) ?? '';
      this.meta.title = `${w.name}: ${first.replace(/\s+/g, ' ')}`.slice(0, 60);
    }
    await this.saveRun(run);
    this.executeRun(w, run).catch(() => {});
    return runView(run, w);
  }

  async resumeRun(runId: string): Promise<WorkflowRunView> {
    if (this.status !== 'idle') throw new Error('The session is busy.');
    const run = await this.readRun(runId);
    if (!['interrupted', 'aborted', 'failed'].includes(run.status) || !run.current) throw new Error(`Run ${runId} cannot be resumed (status ${run.status}).`);
    const w = (await this.workflows()).find((x) => x.name === run.workflow);
    if (!w) throw new Error(`Workflow ${run.workflow} is no longer available.`);
    run.error = undefined;
    this.executeRun(w, run).catch(() => {});
    return runView(run, w);
  }

  private async executeRun(w: WorkflowDef, run: RunRecord): Promise<void> {
    this.abortCtl = new AbortController();
    const signal = this.abortCtl.signal;
    this.setStatus('running');
    this.meta.turns = (this.meta.turns ?? 0) + 1;
    try {
      await this.mainAgent();
      this.checkpoints?.begin(this.meta.turns, `workflow ${w.name}`);
      const runner = new WorkflowRunner(w, this.workflowHost(w), run);
      const done = await runner.execute(signal);
      this.emit({ kind: 'notice', level: done.status === 'succeeded' ? 'info' : 'warn', text: `Workflow ${w.name} ${done.status}${done.error ? `: ${done.error}` : ''} ($${done.cost.toFixed(4)}).` });
    } catch (err) {
      this.emit({ kind: 'notice', level: 'error', text: `Workflow ${w.name} could not run: ${(err as Error).message}` });
    } finally {
      this.abortCtl = undefined;
      for (const [id] of this.pending) this.respond(id, { decision: 'deny', feedback: 'run ended' });
      this.emit({ kind: 'turn_end', reason: signal.aborted ? 'aborted' : 'done' });
      this.setStatus('idle');
      await this.saveMeta().catch(() => {});
    }
  }

  // ---------- checkpoints ----------

  async listCheckpoints() {
    await this.getHost();
    return this.checkpoints ? this.checkpoints.list() : [];
  }

  /** Puts files back as they were before `turn`. The conversation is not edited; the agent is told. */
  async rewind(turn: number): Promise<string[]> {
    if (this.status !== 'idle') throw new Error('Stop the agent before rewinding.');
    await this.getHost();
    if (!this.checkpoints) throw new Error('Checkpoints are not available for this workspace.');
    const files = await this.checkpoints.rewind(turn);
    this.readFiles.clear();
    if (files.length) {
      this.queued.push(`<system-reminder>The user rewound these files to how they were before turn ${turn}: ${files.join(', ')}. Your earlier changes to them are gone; read them again before editing.</system-reminder>`);
      this.emit({ kind: 'notice', level: 'info', text: `Rewound ${files.length} file(s) to before turn ${turn}: ${files.join(', ')}` });
    }
    return files;
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
      else if (!this.meta.sessionRules.includes(suggestion)) { this.meta.sessionRules.push(suggestion); this.scheduleSave(); }
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
      const m = this.deps.registry.model(patch.model);
      this.meta.model = m.id;
      if (!m.efforts.includes(this.meta.effort)) this.meta.effort = m.effort;
      this.emit({ kind: 'notice', level: 'info', text: `Model switched to ${m.label}. The provider cache starts fresh for this conversation.` });
    }
    if (patch.effort) {
      const m = this.deps.registry.model(this.meta.model);
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
    this.meta.turns = (this.meta.turns ?? 0) + 1;
    this.meta.running = true;
    await this.saveMeta().catch(() => {});
    let reason: TurnEndReason = 'done';
    try {
      const agent = await this.mainAgent();
      const host = await this.getHost();
      this.checkpoints?.begin(this.meta.turns, text);
      const hooks = this.deps.registry.hooks;
      const prompt = await runHooks(this.settings!, host, 'UserPromptSubmit', { prompt: text }, undefined, signal, hooks);
      if (prompt.blocked) {
        this.emit({ kind: 'notice', level: 'warn', text: `A UserPromptSubmit hook blocked this message: ${prompt.feedback}` });
        return;
      }
      const first = agent.messages.length === 0;
      let body = text;
      if (first) {
        const start = await runHooks(this.settings!, host, 'SessionStart', {}, undefined, signal, hooks);
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
      this.meta.running = false;
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
