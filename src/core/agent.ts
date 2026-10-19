import { providerFor } from '../providers/index.ts';
import type { ProviderRequest, ProviderResponse, ToolSpec } from '../providers/types.ts';
import { ProviderError } from '../providers/types.ts';
import type { ToolHost } from '../runtime/host.ts';
import { validateInput } from '../tools/index.ts';
import { PathError } from '../tools/paths.ts';
import type { FileStamp, Tool, ToolContext } from '../tools/types.ts';
import { runHooks } from './hooks.ts';
import type { Effort, ModelSpec } from './models.ts';
import { costOf } from './models.ts';
import { decide, type Rules, suggestRule } from './permissions.ts';
import { COMPACT_PROMPT, todosText } from './prompt.ts';
import type { Settings } from './settings.ts';
import type { Block, HarnessEvent, Message, PermissionMode, Todo, ToolResultBlock, ToolUseBlock, TurnEndReason, Usage } from './types.ts';
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

export interface AgentHooks {
  emit(e: HarnessEvent): void;
  /** Persist a message appended to the context. */
  onAppend(m: Message): void;
  /** Replace the context after compaction. */
  onCompact(context: Message[]): void;
  onUsage(model: ModelSpec, usage: Usage, cost: number): void;
  overBudget(): string | undefined;
  getMode(): PermissionMode;
  /** Current permission rules, including "always allow" choices made this session. */
  rules(): Rules;
  requestPermission(tool: Tool, input: Record<string, unknown>, summary: string, suggestion: string, agent: string): Promise<PermissionAnswer>;
  /** User messages typed while the agent was working, delivered at the next step. */
  takeQueuedUserText(): string[];
  todos(): Todo[];
  setTodos(t: Todo[]): void;
  /** Rebuilds the opening context (environment + project instructions) after a compaction. */
  preamble(): Promise<string>;
  /** The user's most recent message, carried verbatim across a compaction. */
  latestUserPrompt(): string;
}

export interface AgentConfig {
  name: string;
  model: ModelSpec;
  effort: Effort;
  system: string;
  tools: Tool[];
  host: ToolHost;
  settings: Settings;
  cacheKey: string;
  maxSteps: number;
  readFiles: Map<string, FileStamp>;
  runSubagent?: ToolContext['runSubagent'];
  askUser?: ToolContext['askUser'];
  proposePlan?: ToolContext['proposePlan'];
}

const MAX_RETRIES = 6;
const RESULT_PREVIEW = 8000;

export class Agent {
  cfg: AgentConfig;
  hooks: AgentHooks;
  messages: Message[];
  /** Prompt size of the last request: what the context window holds now. */
  lastPromptTokens = 0;
  private specs: ToolSpec[];
  private recentCalls: string[] = [];
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

  private compactThreshold(): number {
    return Math.min(this.cfg.settings.compactAt ?? this.cfg.model.compactAt, Math.floor(this.cfg.model.contextWindow * 0.85));
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
        const stopHook = await runHooks(this.cfg.settings, this.cfg.host, 'Stop', { agent }, undefined, signal);
        for (const e of stopHook.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
        if (stopHook.blocked && stopHookBlocks < 3) {
          stopHookBlocks++;
          this.append({ role: 'user', content: [{ type: 'text', text: `<system-reminder>A Stop hook did not let the task end yet:\n${stopHook.feedback}\nAddress this, then finish.</system-reminder>` }] });
          continue;
        }
        return resp.stop === 'max_tokens' ? 'max_tokens' : 'done';
      }

      let results: ToolResultBlock[];
      if (resp.stop === 'max_tokens') {
        // A tool input cut off at the output limit parses as a plausible but
        // truncated object; never run it.
        results = calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, is_error: true, content: 'This call was cut off at the output limit, so it was not run. Split large content into smaller pieces (several edits, or write a smaller file and extend it).' }));
      } else {
        results = await this.executeAll(calls, signal);
      }
      const content: Block[] = [...results];
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

  private recordUsage(resp: ProviderResponse): void {
    const cost = costOf(this.cfg.model, resp.usage);
    this.lastPromptTokens = promptTokens(resp.usage);
    this.hooks.onUsage(this.cfg.model, resp.usage, cost);
    this.hooks.emit({
      kind: 'usage', model: this.cfg.model.id, usage: resp.usage, cost,
      contextTokens: this.lastPromptTokens + resp.usage.output,
      contextWindow: Math.min(this.cfg.model.contextWindow, this.compactThreshold()), agent: this.cfg.name,
    });
  }

  async callModel(messages: Message[], signal: AbortSignal): Promise<ProviderResponse> {
    const provider = providerFor(this.cfg.model);
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
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.send(req);
      } catch (err) {
        if (signal.aborted) throw err;
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= MAX_RETRIES) throw err;
        const delay = Math.min(60_000, err.retryAfterMs ?? 1000 * 2 ** attempt + Math.random() * 500);
        this.hooks.emit({ kind: 'retry', attempt: attempt + 1, delayMs: Math.round(delay), reason: err.message.slice(0, 200) });
        await sleep(delay, signal);
      }
    }
  }

  private async executeAll(calls: ToolUseBlock[], signal: AbortSignal): Promise<ToolResultBlock[]> {
    const results: ToolResultBlock[] = [];
    let i = 0;
    while (i < calls.length) {
      const tool = this.cfg.tools.find((t) => t.spec.name === calls[i]!.name);
      if (tool?.parallelSafe) {
        let j = i;
        while (j < calls.length && this.cfg.tools.find((t) => t.spec.name === calls[j]!.name)?.parallelSafe) j++;
        results.push(...await Promise.all(calls.slice(i, j).map((c) => this.executeOne(c, signal))));
        i = j;
      } else {
        results.push(await this.executeOne(calls[i]!, signal));
        i++;
      }
    }
    return results;
  }

  private async executeOne(call: ToolUseBlock, signal: AbortSignal): Promise<ToolResultBlock> {
    const agent = this.cfg.name;
    const started = Date.now();
    this.hooks.emit({ kind: 'tool_call', id: call.id, name: call.name, input: call.input, agent });
    const finish = (content: string, is_error: boolean, display?: import('./types.ts').ToolDisplay): ToolResultBlock => {
      this.hooks.emit({ kind: 'tool_result', id: call.id, name: call.name, content: content.length > RESULT_PREVIEW ? content.slice(0, RESULT_PREVIEW) + '\n…' : content, is_error, display, ms: Date.now() - started, agent });
      return { type: 'tool_result', tool_use_id: call.id, content, ...(is_error ? { is_error: true } : {}) };
    };
    if (signal.aborted) return finish('Interrupted by the user before this ran.', true);

    const tool = this.cfg.tools.find((t) => t.spec.name === call.name);
    if (!tool) return finish(`There is no tool named "${call.name}". Available tools: ${this.specs.map((s) => s.name).join(', ')}.`, true);
    if (call.parseError) return finish(`Your arguments for ${call.name} were not valid JSON (${call.parseError}). Send the call again with a JSON object matching: ${JSON.stringify(tool.spec.input_schema.properties)}`, true);
    const invalid = validateInput(tool.spec, call.input);
    if (invalid) return finish(`Invalid arguments for ${call.name}: ${invalid}. Expected parameters: ${JSON.stringify(tool.spec.input_schema.properties)}; required: ${(tool.spec.input_schema.required ?? []).join(', ')}.`, true);

    const decision = decide(tool, call.input, { mode: this.hooks.getMode(), rules: this.hooks.rules(), sandboxed: this.cfg.host.sandboxed });
    if (decision.action === 'deny') return finish(`Permission denied: ${decision.reason}.`, true);
    if (decision.action === 'ask') {
      const answer = await this.hooks.requestPermission(tool, call.input, tool.summarize(call.input), suggestRule(tool, call.input), agent);
      if (!answer.allow) return finish(`The user denied this call.${answer.feedback ? ` They said: ${answer.feedback}` : ' Do not retry it unchanged; ask or take another approach.'}`, true);
    }

    const pre = await runHooks(this.cfg.settings, this.cfg.host, 'PreToolUse', { tool: call.name, input: call.input }, call.name, signal);
    for (const e of pre.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
    if (pre.blocked) return finish(`A PreToolUse hook blocked this call: ${pre.feedback}`, true);

    let outcome;
    try {
      const ctx = this.toolContext(signal);
      outcome = this.cfg.host.remoteTool && tool.remoteable
        ? await this.cfg.host.remoteTool(call.name, call.input, signal)
        : await tool.run(call.input, ctx);
    } catch (err) {
      if (signal.aborted) return finish('Interrupted by the user.', true);
      const msg = err instanceof PathError ? err.message : `${call.name} failed: ${(err as Error).message ?? String(err)}`;
      return finish(msg, true);
    }
    if (call.name === 'todo_write') this.stepsSinceTodo = 0;

    let content = outcome.content;
    const post = await runHooks(this.cfg.settings, this.cfg.host, 'PostToolUse', { tool: call.name, input: call.input, is_error: !!outcome.is_error }, call.name, signal);
    for (const e of post.errors) this.hooks.emit({ kind: 'notice', level: 'warn', text: e, agent });
    if (post.feedback) content += `\n<hook_feedback>\n${post.feedback}\n</hook_feedback>`;
    return finish(content, !!outcome.is_error || post.blocked, outcome.display);
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
      isPlanMode: () => this.hooks.getMode() === 'plan',
    };
  }

  /** Harness notes appended after tool results (never inserted earlier: the history stays append-only). */
  private reminders(calls: ToolUseBlock[]): string[] {
    const out: string[] = [];
    for (const c of calls) {
      const sig = `${c.name}:${JSON.stringify(c.input)}`;
      this.recentCalls.push(sig);
    }
    this.recentCalls = this.recentCalls.slice(-12);
    for (const c of calls) {
      const sig = `${c.name}:${JSON.stringify(c.input)}`;
      if (this.recentCalls.filter((s) => s === sig).length >= 3 && c.name !== 'todo_write') {
        out.push(`You have called ${c.name} with identical arguments ${this.recentCalls.filter((s) => s === sig).length} times recently. Its result will not change; try a different approach.`);
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
   * Summarise the context and restart from the summary. The summary request is
   * the current context plus one appended instruction, so it reads the cache
   * the loop has been building. The new context replays nothing older - the
   * shape that keeps thinking-block checks valid on every provider.
   */
  async compact(signal: AbortSignal): Promise<void> {
    const before = this.lastPromptTokens;
    const request: Message[] = [...this.messages, { role: 'user', content: [{ type: 'text', text: COMPACT_PROMPT }] }];
    const resp = await this.callModel(request, signal);
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
