import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import type { Session } from '../core/session.ts';
import type { HarnessEvent } from '../core/types.ts';

// The harness as an MCP server (docs/agents-mcp/PLAN.md, phase 4): what an MCP client (Claude Desktop, Claude Code,
// Cursor, VS Code, another agent) gets from POST /mcp with a person's token: their agents, as tools. A call starts a
// conversation that runs as the agent, reports its progress, and returns the agent's answer; a long one goes on
// after the call returns and its result is fetched later. Runs never wait for a person: what would be asked is
// refused (dontAsk), unless the caller chooses a mode that approves edits, has a checking model approve, or asks the
// person (ask: the run waits for their approval in the app, where the request shows in their inbox).

export interface ExposedAgent { name: string; description: string; source: 'builtin' | 'plugin' | 'user'; model?: string }
export interface ExposeDeps {
  /** The agents the person may run (on, and for people: userInvocable). */
  agents(): Promise<ExposedAgent[]>;
  /** A new conversation as an agent (the same rules as POST /api/sessions). */
  start(o: { agent: string; title: string; folder?: string; model?: string; mode: string }): Promise<Session>;
  /** One of the person's conversations. */
  get(id: string): Session | undefined;
  /** The models the person may choose. */
  models(): string[];
}

const MODES = ['dontAsk', 'plan', 'acceptEdits', 'auto', 'ask'] as const;
const DEFAULT_WAIT_S = Number(process.env.HARNESS_MCP_WAIT_S ?? 600);
const toolOf = (agent: string) => `agent_${agent.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);

/** The agent's answer: its last message's text. */
function answerOf(s: Session): string {
  const last = [...s.history].reverse().find((m) => m.role === 'assistant');
  return last?.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim() || '(no answer)';
}

function summary(s: Session, done: boolean): string {
  const status = s.status === 'idle' ? (done ? 'finished' : 'idle') : s.status;
  return `\n\n---\nconversation: ${s.meta.id} (${status}) · agent: ${s.meta.agent ?? 'main'} · cost: $${s.meta.cost.toFixed(4)}`;
}

/** Waits for the run's turn to end (or `waitS`), telling the client what the agent does on the way. */
async function follow(s: Session, waitS: number, progress: (n: number, message: string) => Promise<void>, signal: AbortSignal): Promise<boolean> {
  let n = 0;
  return new Promise<boolean>((resolve) => {
    let done = false;
    // The caller gave up while waiting (cancelled the call): the run stops too. After the wait, it goes on.
    const cancelled = () => { if (!done) { s.abort(); finish(false); } };
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(t); off(); signal.removeEventListener('abort', cancelled); resolve(v); };
    const t = setTimeout(() => finish(false), waitS * 1000);
    signal.addEventListener('abort', cancelled, { once: true });
    const off = s.subscribe(s.lastSeq ?? 0, ({ event }: { event: HarnessEvent }) => {
      if (event.kind === 'tool_call' && !('agent' in event && event.agent)) void progress(++n, `${event.name}`).catch(() => {});
      if (event.kind === 'turn_end' && !('agent' in event && event.agent)) finish(true);
    });
  });
}

/** The MCP server one request is answered with (made per request: the protocol is stateless). */
export function harnessMcpServer(deps: ExposeDeps, agents: ExposedAgent[]): McpServer {
  const server = new McpServer({ name: 'agent-harness', version: '0.3.0', title: 'Agent Harness' }, {
    instructions: 'Your agents in Agent Harness. Each agent_<name> tool hands a task to that agent and returns its answer; run_agent does the same by name. A run that takes longer than the wait goes on: get_result fetches its answer later.',
    supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
  });
  const run = async (agent: string, args: Record<string, unknown>, ctx: { mcpReq: { signal: AbortSignal; _meta?: { progressToken?: string | number }; notify(n: unknown): Promise<void> } }) => {
    const task = String(args.task ?? '').trim();
    if (!task) return { isError: true, content: [{ type: 'text' as const, text: 'task: what the agent should do' }] };
    // ask: the conversation's own default mode, whose approvals wait for the person in the app.
    const picked = MODES.includes(args.mode as typeof MODES[number]) ? String(args.mode) : 'dontAsk';
    const mode = picked === 'ask' ? 'default' : picked;
    let s: Session;
    try {
      s = await deps.start({ agent, title: task.slice(0, 80), mode, ...(typeof args.folder === 'string' && args.folder ? { folder: args.folder } : {}), ...(typeof args.model === 'string' && args.model ? { model: args.model } : {}) });
    } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: `The ${agent} agent could not start: ${(e as Error).message}` }] }; }
    const token = ctx.mcpReq._meta?.progressToken;
    const progress = async (n: number, message: string) => { if (token !== undefined) await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } }); };
    const ended = follow(s, Math.min(3600, Math.max(5, Number(args.waitSeconds) || DEFAULT_WAIT_S)), progress, ctx.mcpReq.signal);
    await s.send(task);
    const done = await ended;
    if (!done) return { content: [{ type: 'text' as const, text: `The ${agent} agent is still working. Call get_result with conversation "${s.meta.id}" later.${summary(s, false)}` }], structuredContent: { conversation: s.meta.id, done: false } };
    return { content: [{ type: 'text' as const, text: `${answerOf(s)}${summary(s, true)}` }], structuredContent: { conversation: s.meta.id, done: true, answer: answerOf(s), costUsd: s.meta.cost } };
  };
  const common = {
    task: { type: 'string', description: 'What the agent should do: the goal, the context it needs, and what to return.' },
    folder: { type: 'string', description: 'A folder on the harness server to work in (administrators). Without it: a workspace of its own.' },
    mode: { type: 'string', enum: [...MODES], description: 'dontAsk (default): what would need approval is refused. plan: reads only. acceptEdits: edits files without asking. auto: a checking model approves. ask: what needs approval waits for the person to approve it in the harness app (the run waits; past waitSeconds it goes on, and get_result has its answer).' },
    waitSeconds: { type: 'number', description: `How long to wait for the answer (default ${DEFAULT_WAIT_S}). Past it, the run goes on: use get_result.` },
  };
  const models = deps.models();
  for (const a of agents.slice(0, 40)) {
    server.registerTool(toolOf(a.name), {
      title: `Agent: ${a.name}`,
      description: `${a.description} (Hands the task to the ${a.name} agent in Agent Harness and returns its answer.)`.slice(0, 1500),
      inputSchema: fromJsonSchema({ type: 'object', properties: common, required: ['task'] } as never),
      annotations: { readOnlyHint: false, openWorldHint: true },
    } as never, ((args: Record<string, unknown>, ctx: never) => run(a.name, args, ctx)) as never);
  }
  server.registerTool('run_agent', {
    title: 'Run an agent',
    description: `Hand a task to one of the person's agents by name (${agents.map((a) => a.name).join(', ').slice(0, 600)}) and return its answer.`,
    inputSchema: fromJsonSchema({ type: 'object', properties: { agent: { type: 'string', enum: agents.map((a) => a.name) }, ...common, ...(models.length ? { model: { type: 'string', enum: models, description: 'Another model for this run.' } } : {}) }, required: ['agent', 'task'] } as never),
    annotations: { readOnlyHint: false, openWorldHint: true },
  } as never, ((args: Record<string, unknown>, ctx: never) => {
    const name = String(args.agent ?? '');
    if (!agents.some((a) => a.name === name)) return { isError: true, content: [{ type: 'text', text: `No agent "${name}". Agents: ${agents.map((a) => a.name).join(', ')}` }] };
    return run(name, args, ctx);
  }) as never);
  server.registerTool('list_agents', {
    title: 'List agents',
    description: 'The agents you can hand work to, with what each is for.',
    inputSchema: fromJsonSchema({ type: 'object', properties: {} } as never),
    annotations: { readOnlyHint: true },
  } as never, (() => ({ content: [{ type: 'text', text: agents.map((a) => `${a.name} (${a.source}${a.model ? `, ${a.model}` : ''}): ${a.description}`).join('\n') || '(no agents)' }] })) as never);
  server.registerTool('get_result', {
    title: 'Get a run\'s result',
    description: 'The answer of a run that went on after its call returned (by its conversation id), or that it is still working.',
    inputSchema: fromJsonSchema({ type: 'object', properties: { conversation: { type: 'string' } }, required: ['conversation'] } as never),
    annotations: { readOnlyHint: true },
  } as never, ((args: Record<string, unknown>) => {
    const s = deps.get(String(args.conversation ?? ''));
    if (!s) return { isError: true, content: [{ type: 'text', text: 'No such conversation of yours.' }] };
    if (s.status !== 'idle') return { content: [{ type: 'text', text: `Still working.${summary(s, false)}` }], structuredContent: { conversation: s.meta.id, done: false } };
    return { content: [{ type: 'text', text: `${answerOf(s)}${summary(s, true)}` }], structuredContent: { conversation: s.meta.id, done: true, answer: answerOf(s) } };
  }) as never);
  return server;
}
