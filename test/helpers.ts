import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, type AgentHooks } from '../src/core/agent.ts';
import { getModel } from '../src/core/models.ts';
import { defaultSettings, type Settings } from '../src/core/settings.ts';
import type { Block, HarnessEvent, Message, PermissionMode, Todo, Usage } from '../src/core/types.ts';
import { setProvider } from '../src/providers/index.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from '../src/providers/types.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { ALL_TOOLS } from '../src/tools/index.ts';
import type { FileStamp, Tool } from '../src/tools/types.ts';

export async function tempDir(prefix = 'hw-test-'): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

type Step = { text?: string; calls?: { name: string; input?: Record<string, unknown>; parseError?: string }[]; stop?: StopKind; usage?: Partial<Usage> };

/** A provider that replays scripted turns and records every request it receives. */
export class FakeProvider implements Provider {
  requests: ProviderRequest[] = [];
  snapshots: string[] = [];
  private steps: Step[];
  private n = 0;
  constructor(steps: Step[]) { this.steps = steps; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    this.snapshots.push(JSON.stringify(req.messages));
    const s = this.steps.shift() ?? { text: 'done' };
    const content: Block[] = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    for (const c of s.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input ?? {}, ...(c.parseError ? { parseError: c.parseError } : {}) });
    const usage: Usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, ...s.usage };
    return {
      message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: s.text ?? null } } },
      stop: s.stop ?? (s.calls?.length ? 'tool_use' : 'end'),
      usage,
    };
  }
}

export interface Harness {
  agent: Agent;
  provider: FakeProvider;
  events: HarnessEvent[];
  persisted: Message[];
  root: string;
  mode: { value: PermissionMode };
  permissionAnswers: boolean[];
  todos: Todo[];
}

export async function makeAgent(steps: Step[], opts: { mode?: PermissionMode; settings?: Partial<Settings>; tools?: Tool[]; root?: string } = {}): Promise<Harness> {
  const provider = new FakeProvider(steps);
  setProvider('deepseek', provider);
  const root = opts.root ?? await tempDir();
  const events: HarnessEvent[] = [];
  const persisted: Message[] = [];
  const mode = { value: opts.mode ?? 'bypass' as PermissionMode };
  const permissionAnswers: boolean[] = [];
  let todos: Todo[] = [];
  const settings = { ...defaultSettings(), ...opts.settings };
  const hooks: AgentHooks = {
    emit: (e) => events.push(e),
    onAppend: (m) => persisted.push(m),
    onCompact: (ctx) => persisted.push(...ctx),
    onUsage: () => {},
    overBudget: () => undefined,
    getMode: () => mode.value,
    rules: () => settings.permissions,
    requestPermission: async () => {
      const a = permissionAnswers.shift() ?? false;
      return a ? { allow: true } : { allow: false, feedback: 'no thanks' };
    },
    takeQueuedUserText: () => [],
    todos: () => todos,
    setTodos: (t) => { todos = t; },
    preamble: async () => '<environment>test</environment>',
    latestUserPrompt: () => 'the task',
  };
  const agent = new Agent({
    name: 'main', model: getModel('deepseek-flash'), effort: 'high', system: 'SYSTEM', tools: opts.tools ?? ALL_TOOLS,
    host: new LocalHost(root), settings, cacheKey: 'test', maxSteps: 20, readFiles: new Map<string, FileStamp>(),
  }, hooks);
  return { agent, provider, events, persisted, root, mode, permissionAnswers, get todos() { return todos; } } as Harness;
}

export function results(m: Message | undefined): { content: string; is_error?: boolean }[] {
  return (m?.content ?? []).filter((b) => b.type === 'tool_result') as { content: string; is_error?: boolean }[];
}
