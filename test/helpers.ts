import { Agent, type AgentConfig, type AgentHooks } from '../src/core/agent.ts';
import { getModel } from '../src/core/models.ts';
import { defaultSettings, type Settings } from '../src/core/settings.ts';
import type { HarnessEvent, Message, PermissionMode, Todo } from '../src/core/types.ts';
import { LocalHost, type ToolHost } from '../src/runtime/host.ts';
import { BUILTIN_TOOLS } from '../src/tools/index.ts';
import { FakeProvider, type ScriptedStep, tempDir } from '../src/plugins/test-fixtures.ts';
import type { FileStamp, Tool } from '../src/tools/types.ts';

// The plugin test kit's fixtures (@harness/plugin-sdk/testing), here for the harness's own tests too.
export { FakeProvider, tempDir } from '../src/plugins/test-fixtures.ts';
type Step = ScriptedStep;

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

export async function makeAgent(steps: Step[], opts: { mode?: PermissionMode; settings?: Partial<Settings>; tools?: Tool[]; root?: string; host?: ToolHost; /** More of the agent's config (tool groups, a spill store, a model). */ config?: Partial<AgentConfig>; /** More hooks (onTrace, onCacheMiss). */ hooks?: Partial<AgentHooks> } = {}): Promise<Harness> {
  const provider = new FakeProvider(steps);
  const root = opts.root ?? opts.host?.root ?? await tempDir();
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
    ...opts.hooks,
  };
  const agent = new Agent({
    name: 'main', model: getModel('deepseek-flash'), provider, effort: 'high', system: 'SYSTEM', tools: opts.tools ?? BUILTIN_TOOLS,
    host: opts.host ?? new LocalHost(root), settings, cacheKey: 'test', maxSteps: 20, readFiles: new Map<string, FileStamp>(),
    ...opts.config,
  }, hooks);
  return { agent, provider, events, persisted, root, mode, permissionAnswers, get todos() { return todos; } } as Harness;
}

export function results(m: Message | undefined): { content: string; is_error?: boolean }[] {
  return (m?.content ?? []).filter((b) => b.type === 'tool_result') as { content: string; is_error?: boolean }[];
}

export { glbBytes, pngBytes, testPicture } from '../src/plugins/test-fixtures.ts';
