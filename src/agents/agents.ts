import fs from 'node:fs/promises';
import path from 'node:path';
import type { Effort } from '../core/models.ts';
import type { AgentDef } from '../plugins/api.ts';
import type { Tool } from '../tools/types.ts';
import { bool, str } from '../tools/types.ts';
import { asList, parseFrontmatter } from '../util/frontmatter.ts';

// Sub-agents are named specialists: a prompt, a tool subset, and optionally a
// cheaper or stronger model. Two are built in; plugins and projects add more
// (.harness/agents/*.md, and .claude/agents/*.md for Claude Code compatibility).

export const READ_ONLY_TOOLS = ['glob', 'grep', 'read', 'skill', 'tool_search', 'web_fetch'];
/** Tools a sub-agent never gets: they talk to the user or spawn more agents. */
export const INTERACTIVE_TOOLS = ['agent', 'ask_user', 'dismiss_proposal', 'enter_plan_mode', 'exit_plan_mode', 'hand_off', 'list_sessions', 'mark_chapter', 'send_message', 'start_session', 'todo_write', 'desktop_command', 'desktop_describe', 'desktop_notify', 'desktop_open'];
/** The ones a sub-agent does get when it may start its own (settings.maxSubagentDepth). */
export const NESTING_TOOLS = ['agent', 'send_message'];

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: 'explore',
    description: 'Read-only research: search and read a codebase or the web and report findings, without filling your context.',
    prompt: 'You are read-only: research and report; never try to change files or run commands that change anything.',
    tools: READ_ONLY_TOOLS,
    effort: 'low',
    source: 'builtin',
  },
  {
    name: 'general',
    description: 'An independent piece of work that may edit files and run commands, done in its own context.',
    prompt: '',
    source: 'builtin',
  },
];

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Claude Code's tool names, as they appear in .claude/agents files, mapped to
 * this harness's. Unmapped, a Claude Code agent's "tools: Read, Grep, Glob" matched
 * nothing and the agent ran with no tools at all.
 */
const CLAUDE_CODE_TOOLS: Record<string, string> = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', NotebookRead: 'read',
  Bash: 'bash', BashOutput: 'task_output', Glob: 'glob', Grep: 'grep', LS: 'glob', WebFetch: 'web_fetch',
  TodoWrite: 'todo_write', Task: 'agent', Agent: 'agent', ExitPlanMode: 'exit_plan_mode', AskUserQuestion: 'ask_user', Skill: 'skill',
  SendMessage: 'send_message', TaskOutput: 'task_output', TaskList: 'task_list', TaskStop: 'task_stop', KillShell: 'task_stop', KillBash: 'task_stop', Monitor: 'monitor',
};

/** A tools list in either vocabulary, without duplicates; MCP and plugin tool names pass through. */
export function normaliseToolNames(names: string[] | undefined): string[] | undefined {
  if (!names) return undefined;
  return [...new Set(names.map((n) => CLAUDE_CODE_TOOLS[n] ?? n))];
}

/** Parses an agent definition file: frontmatter (name, description, tools, model, effort) + prompt body. */
export function parseAgentFile(text: string, fallbackName: string, source: string): AgentDef | undefined {
  const { data, body } = parseFrontmatter(text);
  const name = String(data.name ?? fallbackName).trim();
  const description = String(data.description ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name) || !description) return undefined;
  const effort = EFFORTS.find((e) => e === data.effort);
  const model = typeof data.model === 'string' && data.model !== 'inherit' ? data.model : undefined;
  return { name, description: description.slice(0, 300), prompt: body, tools: normaliseToolNames(asList(data.tools)), model, effort, source };
}

export async function loadAgentDir(dir: string, source: string): Promise<AgentDef[]> {
  let names: string[];
  try { names = await fs.readdir(dir); } catch { return []; }
  const out: AgentDef[] = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.md')) continue;
    try {
      const def = parseAgentFile(await fs.readFile(path.join(dir, n), 'utf8'), n.replace(/\.md$/, ''), source);
      if (def) out.push(def);
    } catch { /* unreadable */ }
  }
  return out;
}

/** What the agent tool passes on: the brief, which agent, and optionally another model, an effort, a worktree of its own. */
export interface SubagentArgs { description: string; prompt: string; type: string; model?: string; effort?: Effort; isolation?: 'worktree' }

/**
 * The `agent` tool for one session: its enum and description list exactly the agents available
 * (with their tools), the other models it may use (`catalogue`, from the delegation setting) and,
 * where the session's folder can have worktrees, `isolation`. Fixed for the session (cached).
 */
export function makeAgentTool(agents: AgentDef[], opts: { catalogue?: string; isolation?: boolean } = {}): Tool {
  const names = agents.map((a) => a.name);
  const list = agents.map((a) => `- ${a.name}${a.tools ? ` [${a.tools.join(', ')}]` : ''}${a.model ? ` (${a.model})` : ''}: ${a.description}`).join('\n');
  const extra: Record<string, unknown> = {};
  if (opts.catalogue) {
    extra.model = { type: 'string', description: 'Another allowed model (below).' };
    extra.effort = { type: 'string', enum: EFFORTS };
  }
  if (opts.isolation) extra.isolation = { type: 'string', enum: ['worktree'], description: 'Work in a fresh git worktree on its own branch (kept and reported if it changed anything).' };
  return {
    kind: 'meta', parallelSafe: true, remoteable: false,
    spec: {
      name: 'agent',
      description: `Delegate a self-contained task to a sub-agent with its own fresh context; it returns only its final report, with its id (send_message continues it later with its context). Write the prompt as a complete brief: the goal, what you already know, and what to report back. Several agent calls in one turn run in parallel. With run_in_background it starts and you get its id at once; keep working, and its report reaches you as a reminder when it finishes. Agents:\n${list}${opts.catalogue ? `\n${opts.catalogue}` : ''}`,
      input_schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Three to five words, shown to the user.' },
          prompt: { type: 'string' },
          type: { type: 'string', enum: names, description: 'Which agent; default explore.' },
          run_in_background: { type: 'boolean', description: 'Start it and return at once; its report arrives later.' },
          ...extra,
        },
        required: ['description', 'prompt'],
      },
    },
    summarize: (i) => `${bool(i.run_in_background) ? '[background] ' : ''}${str(i.type) || 'explore'}${str(i.model) ? ` on ${str(i.model)}` : ''}${str(i.isolation) ? ' (worktree)' : ''}: ${str(i.description)}`,
    async run(input, ctx) {
      if (!ctx.runSubagent) return { content: 'Sub-agents cannot start other sub-agents. Do the work directly.', is_error: true };
      const type = names.includes(str(input.type)) ? str(input.type) : 'explore';
      const effort = EFFORTS.find((e) => e === str(input.effort));
      const args: SubagentArgs = {
        description: str(input.description), prompt: str(input.prompt), type,
        ...(str(input.model) ? { model: str(input.model) } : {}), ...(effort ? { effort } : {}),
        ...(str(input.isolation) === 'worktree' ? { isolation: 'worktree' as const } : {}),
      };
      const start = ctx.services?.tasks?.startAgent;
      try {
        if (bool(input.run_in_background) && start) {
          const id = await start(args);
          return { content: `Started ${id} in the background. Keep working; its report reaches you as a reminder when it finishes. task_output ${id} shows its progress, task_stop ${id} stops it.` };
        }
        const report = await ctx.runSubagent(args);
        // Background work is the main agent's: a sub-agent's background request runs here and now.
        return { content: bool(input.run_in_background) ? `${report}\n(Run in the foreground: only the main agent starts background agents.)` : report };
      } catch (e) {
        // A refused delegation or worktree: the agent hears why and can do otherwise.
        if (ctx.signal.aborted) throw e;
        return { content: (e as Error).message, is_error: true };
      }
    },
  };
}
