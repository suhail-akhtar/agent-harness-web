import type { InProcessHook } from '../kernel/registry.ts';
import type { Provider, ProviderRequest, ProviderResponse, ToolSpec } from '../providers/types.ts';
import { ProviderError } from '../providers/types.ts';
import type { ImageData, ToolHost } from '../runtime/host.ts';
import { validateInput } from '../tools/index.ts';
import { PathError } from '../tools/paths.ts';
import type { FileStamp, Tool, ToolContext, ToolOutcome } from '../tools/types.ts';
import { runHooks } from './hooks.ts';
import type { Effort, ModelSpec } from './models.ts';
import { costOf } from './models.ts';
import { decide, type Rules, suggestRule } from './permissions.ts';
import { COMPACT_PROMPT, todosText } from './prompt.ts';
import type { HookEvent, Settings } from './settings.ts';
import type { Block, HarnessEvent, Message, PermissionMode, Todo, ToolDisplay, ToolResultBlock, ToolUseBlock, TurnEndReason, Usage } from './types.ts';
import { promptTokens } from './types.ts';

// One model-driven loop, the same shape Claude Code and Codex document:
// call the model -> run the tools it asked for -> append the results -> repeat
// until it answers without a tool call. Around it:
//   - permissions and hooks, enforced in code on every call;
//   - read-only calls in one turn run in parallel, everything else in order;
//   - errors go back to the model in a form it can act on (bad JSON, unknown
//     tool, wrong parameter, denied call) instead of failing the turn;
//   - the context is append-only between compactions, so the provider's
//     prompt cache keeps hitting; compaction reuses that cache too.

export type PermissionAnswer = { allow: true } | { allow: false; feedback?: string };

/** One record per model call or tool call, for the session's trace. */
export type TraceSpan =
  | { type: 'model'; agent: string; model: string; ms: number; usage: Usage; cost: number; stop: string; retries: number; compaction?: boolean }
  | { type: 'tool'; agent: string; tool: string; ms: number; error: boolean; chars: number; images: number }
  | { type: 'clear'; agent: string; results: number; tokens: number };

export interface AgentHooks {
  emit(e: HarnessEvent): void;
  /** Persist a message appended to the context. */
  onAppend(m: Message): void;
  /** Replace the context after compaction. */
  onCompact(context: Message[]): void;
  onUsage(model: ModelSpec, usage: Usage, cost: number): void;
  onTrace?(span: TraceSpan): void;
  overBudget(): string | undefined;
  getMode(): PermissionMode;
  /** Current permission rules, including "always allow" choices made this session. */
  rules(): Rules;
  requestPermission(tool: Tool, input: Record<string, unknown>, summary: string, suggestion: string, agent: string): Promise<PermissionAnswer>;
  /** User messages typed while the agent was working, delivered at the next step. */
  takeQueuedUserText(): string[];
  todos(): Todo[];
  setTodos(t: Todo[]): void;
  /** Rebuilds the opening context (environment, project instructions, skills) after a compaction. */
  preamble(): Promise<string>;
  /** The user's most recent message, carried verbatim across a compaction. */
  latestUserPrompt(): string;
}

export interface AgentConfig {
  name: string;
  model: ModelSpec;
  provider: Provider;
  effort: Effort;
  system: string;
  tools: Tool[];
  host: ToolHost;
  settings: Settings;
  cacheKey: string;
  maxSteps: number;
  readFiles: Map<string, FileStamp>;
  /** Hooks registered by trusted code plugins. */
  inProcessHooks?: InProcessHook[];
  runSubagent?: ToolContext['runSubagent'];
  askUser?: ToolContext['askUser'];
  proposePlan?: ToolContext['proposePlan'];
  beforeWrite?: ToolContext['beforeWrite'];
  services?: ToolContext['services'];
}

const MAX_RETRIES = 6;
const RESULT_PREVIEW = 8000;
/** Images larger than this are not echoed to the UI (they still reach the model). */
const UI_IMAGE_MAX = 1_500_000;
/** Tool results kept verbatim when clearing old ones. */
const CLEAR_KEEP = 6;
/** Rough prompt cost of one attached image (a 1000px-wide render is ~1-1.5k tokens). */
const IMAGE_TOKENS = 1200;
const CLEARED = '[Old tool output cleared to keep the context lean. Run the tool again if you need it.]';

export class Agent {
  cfg: AgentConfig;
  hooks: AgentHooks;
  messages: Message[];
  /** Prompt size of the last request: what the context window holds now. */
  lastPromptTokens = 0;
  private specs: ToolSpec[];
  private recentCalls: string[] = [];
  /** Untrusted content (a web page, an MCP result, a sub-agent that read some) has entered this context. */
  tainted = false;
  private stepsSinceTodo = 0;

  constructor(cfg: AgentConfig, hooks: AgentHooks, messages: Message[] = []) {
    this.cfg = cfg;
    this.hooks = hooks;
    this.messages = messages;
    this.specs = cfg.tools.map((t) => t.spec).sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  append(m: Message): void {
    this.messages.push(m);
    this.hooks.onAppend(m);
  }

  compactThreshold(): number {
    const at = Math.min(this.cfg.settings.compactAt ?? this.cfg.model.compactAt, Math.floor(this.cfg.model.contextWindow * 0.85));
    // A provider that compacts itself does it at `at`; ours is only the backstop.
    return this.cfg.provider.compactsServerSide?.(this.cfg.model) ? Math.min(Math.floor(this.cfg.model.contextWindow * 0.85), Math.round(at * 1.5)) : at;
  }

  private hookRun(event: HookEvent, payload: Record<string, unknown>, matchName: string | undefined, signal: AbortSignal) {
    return runHooks(this.cfg.settings, this.cfg.host, event, payload, matchName, signal, this.cfg.inProcessHooks);
  }

  /** Runs model calls and tools until the model stops calling tools (or a limit hits). */
  async run(signal: AbortSignal): Promise<TurnEndReason> {
    const agent = this.cfg.name;
    let stopHookBlocks = 0;
    let continuations = 0;
    for (let step = 0; step < this.cfg.maxSteps; step++) {
      if (signal.aborted) return 'aborted';
      const over = this.hooks.overBudget();
      if (over) {
        this.hooks.emit({ kind: 'notice', level: 'warn', text: over, agent });
        return 'budget';
      }
      if (this.lastPromptTokens > this.compactThreshold()) {
        await this.compact(signal);
        if (signal.aborted) return 'aborted';
      } else {
        this.maybeClear();
      }

      this.hooks.emit({ kind: 'turn_start', turn: step, agent });
      const resp = await this.callModel(this.messages, signal);
      this.append(resp.message);
      this.hooks.emit({ kind: 'assistant_message', message: resp.message, agent });
      this.recordUsage(resp);

      if (resp.stop === 'refusal') {
        this.hooks.emit({ kind: 'notice', level: 'warn', text: resp.notice ?? 'The model declined to continue.', agent });
        return 'refusal';
      }

      const calls = resp.message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      if (!calls.length) {
        if (resp.stop === 'max_tokens' && continuations < 2) {
          continuations++;
          this.append({ role: 'user', content: [{ type: 'text', text: '<system-reminder>Your reply was cut off at the output limit. Continue exactly where it stopped.</system-reminder>' }] });
          continue;
        }
        const queued = this.hooks.takeQueuedUserText();
        if (queued.length) {
          this.append({ role: 'user', content: queued.map((t) => ({ type: 'text' as const, text: t })) });
          continue;
        }
        const stopHook = await this.hookRun('Stop', { agent }, undefined, signal);
        for (const e of stopHook.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
        if (stopHook.blocked && stopHookBlocks < 3) {
          stopHookBlocks++;
          this.append({ role: 'user', content: [{ type: 'text', text: `<system-reminder>A Stop hook did not let the task end yet:\n${stopHook.feedback}\nAddress this, then finish.</system-reminder>` }] });
          continue;
        }
        return resp.stop === 'max_tokens' ? 'max_tokens' : 'done';
      }

      let results: { block: ToolResultBlock; images?: ImageData[]; label?: string }[];
      if (resp.stop === 'max_tokens') {
        // A tool input cut off at the output limit parses as a plausible but
        // truncated object; never run it.
        results = calls.map((c) => ({ block: { type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'This call was cut off at the output limit, so it was not run. Split large content into smaller pieces (several edits, or write a smaller file and extend it).' } }));
      } else {
        results = await this.executeAll(calls, signal);
      }
      // Tool results first (providers require it), then any images they
      // produced, then harness notes - all appended, never inserted earlier.
      const content: Block[] = results.map((r) => (r.images?.length && this.cfg.model.vision ? { ...r.block, images: r.images } : r.block));
      for (const r of results) {
        if (r.images?.length && !this.cfg.model.vision) content.push({ type: 'text', text: `<system-reminder>${r.label} produced ${r.images.length} image(s), but this model cannot view images.</system-reminder>` });
      }
      for (const r of this.reminders(calls)) content.push({ type: 'text', text: `<system-reminder>${r}</system-reminder>` });
      for (const t of this.hooks.takeQueuedUserText()) {
        content.push({ type: 'text', text: t.startsWith('<system-reminder>') ? t : `The user added while you were working:\n${t}` });
      }
      this.append({ role: 'user', content });
      if (signal.aborted) return 'aborted';
    }
    this.hooks.emit({ kind: 'notice', level: 'warn', text: `Stopped after ${this.cfg.maxSteps} steps. Send a message to continue.`, agent });
    return 'max_steps';
  }

  private recordUsage(resp: ProviderResponse): number {
    const cost = costOf(this.cfg.model, resp.usage);
    this.lastPromptTokens = resp.contextTokens ?? promptTokens(resp.usage);
    if (resp.compacted) this.hooks.emit({ kind: 'compaction', before: resp.compacted.before, after: this.lastPromptTokens, summaryTokens: resp.compacted.summaryTokens });
    this.hooks.onUsage(this.cfg.model, resp.usage, cost);
    this.hooks.emit({
      kind: 'usage', model: this.cfg.model.id, usage: resp.usage, cost,
      contextTokens: this.lastPromptTokens + resp.usage.output,
      contextWindow: Math.min(this.cfg.model.contextWindow, this.compactThreshold()), agent: this.cfg.name,
    });
    return cost;
  }

  async callModel(messages: Message[], signal: AbortSignal, compaction = false): Promise<ProviderResponse> {
    const req: ProviderRequest = {
      model: this.cfg.model,
      system: this.cfg.system,
      tools: this.specs,
      messages,
      effort: this.cfg.effort,
      cacheKey: this.cfg.cacheKey,
      signal,
      onText: (text) => this.hooks.emit({ kind: 'text_delta', text, agent: this.cfg.name }),
      onReasoning: (text) => this.hooks.emit({ kind: 'reasoning_delta', text, agent: this.cfg.name }),
    };
    const t0 = Date.now();
    let imagesDropped = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const resp = await this.cfg.provider.send(req);
        this.hooks.onTrace?.({ type: 'model', agent: this.cfg.name, model: this.cfg.model.id, ms: Date.now() - t0, usage: resp.usage, cost: costOf(this.cfg.model, resp.usage), stop: resp.stop, retries: attempt, ...(compaction || resp.compacted ? { compaction: true } : {}) });
        return resp;
      } catch (err) {
        if (signal.aborted) throw err;
        // A provider that rejects an image (format, size) would fail every later
        // request too: replace images with a note in the live context and go on.
        if (err instanceof ProviderError && err.status === 400 && /image/i.test(err.message) && !imagesDropped && hasImages(req.messages)) {
          imagesDropped = true;
          const stripped = stripImages(req.messages);
          if (messages === this.messages) this.messages = stripped;
          req.messages = stripped;
          this.hooks.emit({ kind: 'notice', level: 'warn', text: `The provider rejected an image (${err.message.slice(0, 120)}); continuing without images.`, agent: this.cfg.name });
          continue;
        }
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= MAX_RETRIES) throw err;
        const delay = Math.min(60_000, err.retryAfterMs ?? 1000 * 2 ** attempt + Math.random() * 500);
        this.hooks.emit({ kind: 'retry', attempt: attempt + 1, delayMs: Math.round(delay), reason: err.message.slice(0, 200) });
        await sleep(delay, signal);
      }
    }
  }

  private findTool(name: string): Tool | undefined {
    return this.cfg.tools.find((t) => t.spec.name === name);
  }

  private async executeAll(calls: ToolUseBlock[], signal: AbortSignal) {
    const results: { block: ToolResultBlock; images?: ImageData[]; label?: string }[] = [];
    let i = 0;
    while (i < calls.length) {
      if (this.findTool(calls[i]!.name)?.parallelSafe) {
        let j = i;
        while (j < calls.length && this.findTool(calls[j]!.name)?.parallelSafe) j++;
        results.push(...await Promise.all(calls.slice(i, j).map((c) => this.executeOne(c, signal))));
        i = j;
      } else {
        results.push(await this.executeOne(calls[i]!, signal));
        i++;
      }
    }
    return results;
  }

  private async executeOne(call: ToolUseBlock, signal: AbortSignal): Promise<{ block: ToolResultBlock; images?: ImageData[]; label?: string }> {
    const agent = this.cfg.name;
    const started = Date.now();
    this.hooks.emit({ kind: 'tool_call', id: call.id, name: call.name, input: call.input, agent });
    const finish = (content: string, is_error: boolean, display?: ToolDisplay, images?: ImageData[], label?: string) => {
      const uiImages = images?.filter((im) => im.data.length <= UI_IMAGE_MAX);
      this.hooks.emit({ kind: 'tool_result', id: call.id, name: call.name, content: content.length > RESULT_PREVIEW ? content.slice(0, RESULT_PREVIEW) + '\n…' : content, is_error, display, ms: Date.now() - started, agent, ...(uiImages?.length ? { images: uiImages } : {}) });
      this.hooks.onTrace?.({ type: 'tool', agent, tool: label ?? call.name, ms: Date.now() - started, error: is_error, chars: content.length, images: images?.length ?? 0 });
      return { block: { type: 'tool_result' as const, tool_use_id: call.id, content, ...(is_error ? { is_error: true } : {}) }, images, label: label ?? call.name };
    };
    if (signal.aborted) return finish('Interrupted by the user before this ran.', true);

    let tool = this.findTool(call.name);
    let routed: { tool: Tool; input: Record<string, unknown> } | undefined;
    if (!tool) {
      // A model that calls a deferred tool by its own name (seen with Haiku)
      // is routed through the dispatcher instead of costing a round trip.
      for (const d of this.cfg.tools.filter((t) => t.resolve)) {
        const r = d.resolve!({ name: call.name, arguments: call.input });
        if (!('error' in r)) { tool = d; routed = r; break; }
      }
      if (!tool) return finish(`There is no tool named "${call.name}". Available tools: ${this.specs.map((s) => s.name).join(', ')}.`, true);
    }
    if (call.parseError) return finish(`Your arguments for ${call.name} were not valid JSON (${call.parseError}). Send the call again with a JSON object matching: ${JSON.stringify(tool.spec.input_schema.properties)}`, true);
    const invalid = routed ? undefined : validateInput(tool.spec, call.input);
    if (invalid) return finish(`Invalid arguments for ${call.name}: ${invalid}. Expected parameters: ${JSON.stringify(tool.spec.input_schema.properties)}; required: ${(tool.spec.input_schema.required ?? []).join(', ')}.`, true);

    // A dispatcher (tool_call) names the real tool; everything below applies to that one.
    let input = call.input;
    if (routed) {
      tool = routed.tool;
      input = routed.input;
    } else if (tool.resolve) {
      const r = tool.resolve(call.input);
      if ('error' in r) return finish(r.error, true);
      tool = r.tool;
      input = r.input;
    }
    const name = tool.spec.name;

    const decision = decide(tool, input, { mode: this.hooks.getMode(), rules: this.hooks.rules(), sandboxed: this.cfg.host.sandboxed, tainted: this.tainted });
    if (decision.action === 'deny') return finish(`Permission denied: ${decision.reason}.`, true, undefined, undefined, name);
    if (decision.action === 'ask') {
      const answer = await this.hooks.requestPermission(tool, input, tool.summarize(input), suggestRule(tool, input), agent);
      if (!answer.allow) return finish(`The user denied this call.${answer.feedback ? ` They said: ${answer.feedback}` : ' Do not retry it unchanged; ask or take another approach.'}`, true, undefined, undefined, name);
    }

    const pre = await this.hookRun('PreToolUse', { tool: name, input }, name, signal);
    for (const e of pre.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
    if (pre.blocked) return finish(`A PreToolUse hook blocked this call: ${pre.feedback}`, true, undefined, undefined, name);

    let outcome: ToolOutcome;
    try {
      const ctx = this.toolContext(signal);
      outcome = this.cfg.host.remoteTool && tool.remoteable
        ? await this.cfg.host.remoteTool(name, input, signal)
        : await tool.run(input, ctx);
    } catch (err) {
      if (signal.aborted) return finish('Interrupted by the user.', true, undefined, undefined, name);
      const msg = err instanceof PathError ? err.message : `${name} failed: ${(err as Error).message ?? String(err)}`;
      return finish(msg, true, undefined, undefined, name);
    }
    if (name === 'todo_write') this.stepsSinceTodo = 0;
    if (tool.kind === 'network' || tool.kind === 'external' || outcome.untrusted) this.tainted = true;

    let content = outcome.content;
    const post = await this.hookRun('PostToolUse', { tool: name, input, is_error: !!outcome.is_error }, name, signal);
    for (const e of post.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
    if (post.feedback) content += `\n<hook_feedback>\n${post.feedback}\n</hook_feedback>`;
    return finish(content, !!outcome.is_error || post.blocked, outcome.display, outcome.images, name);
  }

  private toolContext(signal: AbortSignal): ToolContext {
    return {
      host: this.cfg.host,
      signal,
      readFiles: this.cfg.readFiles,
      todos: this.hooks.todos(),
      setTodos: (t) => { this.hooks.setTodos(t); this.hooks.emit({ kind: 'todos', todos: t }); },
      emit: (e) => this.hooks.emit(e),
      runSubagent: this.cfg.runSubagent,
      askUser: this.cfg.askUser,
      proposePlan: this.cfg.proposePlan,
      beforeWrite: this.cfg.beforeWrite,
      isPlanMode: () => this.hooks.getMode() === 'plan',
      services: this.cfg.services,
    };
  }

  /** Harness notes appended after tool results (never inserted earlier: the history stays append-only). */
  private reminders(calls: ToolUseBlock[]): string[] {
    const out: string[] = [];
    for (const c of calls) this.recentCalls.push(`${c.name}:${JSON.stringify(c.input)}`);
    this.recentCalls = this.recentCalls.slice(-12);
    for (const c of calls) {
      const sig = `${c.name}:${JSON.stringify(c.input)}`;
      const n = this.recentCalls.filter((s) => s === sig).length;
      if (n >= 3 && c.name !== 'todo_write') {
        out.push(`You have called ${c.name} with identical arguments ${n} times recently. Its result will not change; try a different approach.`);
        break;
      }
    }
    this.stepsSinceTodo++;
    const todos = this.hooks.todos();
    if (todos.some((t) => t.status !== 'completed') && this.stepsSinceTodo >= 12) {
      this.stepsSinceTodo = 0;
      out.push(`Your todo list may be stale; update it if your progress changed.\n${todosText(todos)}`);
    }
    return out;
  }

  /**
   * Clears old tool results for providers without server-side context editing
   * (Claude's is done by the API, which keeps our transcript append-only).
   * Rewriting history resets the cache from that point, so it happens rarely
   * and in one large batch: only past 60% of the compaction threshold, and only
   * if it frees a meaningful amount.
   */
  private maybeClear(): void {
    if (this.cfg.model.provider === 'anthropic') return;
    if (this.lastPromptTokens < this.compactThreshold() * 0.6) return;
    const names = new Map<string, string>();
    for (const m of this.messages) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
    const positions: { mi: number; bi: number; tokens: number }[] = [];
    this.messages.forEach((m, mi) => m.content.forEach((b, bi) => {
      if (b.type !== 'tool_result' || b.content === CLEARED) return;
      const n = names.get(b.tool_use_id) ?? '';
      if (n === 'todo_write' || n === 'agent' || n === 'skill') return;
      positions.push({ mi, bi, tokens: Math.ceil(b.content.length / 4) + (b.images?.length ?? 0) * IMAGE_TOKENS });
    }));
    const old = positions.slice(0, Math.max(0, positions.length - CLEAR_KEEP)).filter((p) => p.tokens > 200);
    const total = old.reduce((a, p) => a + p.tokens, 0);
    if (total < 12_000) return;
    for (const p of old) {
      const m = this.messages[p.mi]!;
      // Copy, never mutate: the stored history keeps the original.
      const content = m.content.slice();
      content[p.bi] = { ...(content[p.bi] as ToolResultBlock), content: CLEARED, images: undefined };
      this.messages[p.mi] = { ...m, content };
    }
    this.lastPromptTokens -= total;
    this.hooks.onTrace?.({ type: 'clear', agent: this.cfg.name, results: old.length, tokens: total });
    this.hooks.emit({ kind: 'notice', level: 'info', text: `Cleared ${old.length} old tool results (~${Math.round(total / 1000)}k tokens) to keep the context lean.`, agent: this.cfg.name });
  }

  /**
   * Summarise the context and restart from the summary. The summary request is
   * the current context plus one appended instruction, so it reads the cache
   * the loop has been building. The new context replays nothing older - the
   * shape that keeps thinking-block checks valid on every provider.
   */
  async compact(signal: AbortSignal): Promise<void> {
    const before = this.lastPromptTokens;
    const request: Message[] = [...this.messages, { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] }];
    const resp = await this.callModel(request, signal, true);
    this.recordUsage(resp);
    const summary = resp.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
    if (!summary) {
      this.hooks.emit({ kind: 'notice', level: 'warn', text: 'Compaction produced no summary; continuing with the full context.', agent: this.cfg.name });
      return;
    }
    const lastUserText = this.hooks.latestUserPrompt();
    const parts = [
      '<system-reminder>This session was compacted to save context. The summary below replaces the earlier conversation. Files you read before are no longer in context: read them again before editing.</system-reminder>',
      await this.hooks.preamble(),
      `<summary>\n${summary}\n</summary>`,
      todosText(this.hooks.todos()),
      lastUserText ? `<latest_user_message>\n${lastUserText.slice(0, 8000)}\n</latest_user_message>` : '',
      'Continue the work from where it stopped.',
    ].filter(Boolean);
    this.messages = [{ role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }], compactionSummary: true }];
    this.cfg.readFiles.clear();
    this.recentCalls = [];
    this.lastPromptTokens = Math.ceil(parts.join('').length / 4);
    this.hooks.onCompact(this.messages);
    this.hooks.emit({ kind: 'compaction', before, after: this.lastPromptTokens, summaryTokens: resp.usage.output });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function hasImages(messages: Message[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === 'image' || (b.type === 'tool_result' && !!b.images?.length)));
}

const IMAGE_REJECTED = '[The image(s) here were not sent: the model provider rejected an image. Rely on the text results, or make a smaller or simpler image.]';

/** Copies of the messages with every image replaced by a note (the stored history keeps them). */
function stripImages(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (!hasImages([m])) return m;
    return {
      ...m,
      content: m.content.map((b): Block => {
        if (b.type === 'image') return { type: 'text', text: IMAGE_REJECTED };
        if (b.type === 'tool_result' && b.images?.length) return { ...b, images: undefined, content: `${b.content}\n${IMAGE_REJECTED}` };
        return b;
      }),
    };
  });
}
