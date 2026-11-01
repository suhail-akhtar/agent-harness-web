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

/**
 * GitHub Copilot's tool aliases (.github/agents) and its `server/tool` MCP names, as this harness's.
 * An alias stands for several tools; a name already ours passes through.
 */
// Only aliases that are not this harness's own tool names: "read", "edit" and "agent" are ours, and ours win.
const COPILOT_ALIASES: Record<string, string[]> = {
  execute: ['bash', 'run_script', 'task_output', 'task_stop', 'monitor'], search: ['glob', 'grep', 'web_search'], web: ['web_fetch', 'web_search'], todo: ['todo_write'],
};
const toolAlias = (n: string): string[] => {
  if (CLAUDE_CODE_TOOLS[n]) return [CLAUDE_CODE_TOOLS[n]!];
  if (COPILOT_ALIASES[n]) return COPILOT_ALIASES[n]!;
  // Copilot's "github/*" and "github/create_issue": an MCP server's tools.
  const mcp = /^([\w.-]+)\/([\w.*-]+)$/.exec(n);
  if (mcp) return [`mcp__${mcp[1]}__${mcp[2]}`];
  return [n];
};

/** Claude Code's model aliases (`model: sonnet`), as models this harness has. */
export const MODEL_ALIASES: Record<string, string> = { sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1' };
export const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'] as const;
/** Claude Code's modes as ours (bypassPermissions is never taken from a file: at most acceptEdits). */
const MODE_ALIASES: Record<string, AgentDef['permissionMode']> = { default: 'default', acceptEdits: 'acceptEdits', auto: 'auto', dontAsk: 'dontAsk', plan: 'plan', manual: 'default', bypassPermissions: 'acceptEdits' };
export const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

const listOf = (v: string | string[] | undefined): string[] | undefined => {
  const l = asList(v);
  return l?.length ? [...new Set(l)] : undefined;
};
const yes = (v: unknown): boolean | undefined => (v === 'true' ? true : v === 'false' ? false : undefined);
const num = (v: unknown, min: number, max: number): number | undefined => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n >= min && n <= max ? n : undefined; };

/**
 * Parses an agent definition file: frontmatter + instructions body. Claude Code's fields (name, description,
 * tools, disallowedTools, model, effort, permissionMode, maxTurns, skills, mcpServers, isolation, background,
 * color), GitHub Copilot's (`mcp-servers`, `disable-model-invocation`, `user-invocable`, its tool aliases) and
 * Cursor's (`readonly`, `is_background`).
 */
export function parseAgentFile(text: string, fallbackName: string, source: string): AgentDef | undefined {
  const { data, body } = parseFrontmatter(text);
  const name = String(data.name ?? fallbackName).trim();
  const description = String(data.description ?? '').trim();
  if (!AGENT_NAME.test(name) || !description) return undefined;
  const effort = EFFORTS.find((e) => e === data.effort);
  const rawModel = typeof data.model === 'string' && data.model !== 'inherit' ? data.model.trim() : undefined;
  const model = rawModel ? MODEL_ALIASES[rawModel] ?? rawModel : undefined;
  const readonly = yes(data.readonly) === true;
  const tools = readonly ? READ_ONLY_TOOLS : listOf(data.tools)?.flatMap(toolAlias);
  const def: AgentDef = { name, description: description.slice(0, 1000), prompt: body.trim(), tools: normaliseToolNames(tools), model, effort, source };
  const deny = listOf(data.disallowedTools ?? data['disallowed-tools'])?.flatMap(toolAlias);
  if (deny) def.disallowedTools = normaliseToolNames(deny);
  const servers = listOf(data.mcpServers ?? data['mcp-servers']);
  if (servers) def.mcpServers = servers;
  const skills = listOf(data.skills);
  if (skills) def.skills = skills;
  const mode = MODE_ALIASES[String(data.permissionMode ?? '')];
  if (mode) def.permissionMode = mode;
  const turns = num(data.maxTurns, 1, 1000);
  if (turns) def.maxTurns = Math.round(turns);
  const cost = num(data.maxCostUsd, 0.001, 1000);
  if (cost) def.maxCostUsd = cost;
  if (data.isolation === 'worktree') def.isolation = 'worktree';
  const bg = yes(data.background) ?? yes(data.is_background);
  if (bg !== undefined) def.background = bg;
  if (yes(data['disable-model-invocation']) === true || yes(data.modelInvocable) === false) def.modelInvocable = false;
  if (yes(data['user-invocable']) === false || yes(data.userInvocable) === false) def.userInvocable = false;
  if (typeof data.color === 'string' && /^#?[\w-]{1,20}$/.test(data.color)) def.color = data.color;
  return def;
}

const yamlStr = (s: string) => (/^[\w .,/@()+-]*$/.test(s) && !/^[-\s]|:\s|\s$/.test(s) ? s : JSON.stringify(s));

/** An agent as a Claude Code agent file (.claude/agents/<name>.md): what other apps read, and what import reads back. */
export function agentToMarkdown(def: AgentDef): string {
  const lines = ['---', `name: ${def.name}`];
  // A long description in a block, so it never needs escaping.
  lines.push(def.description.includes('\n') || def.description.length > 120 ? `description: >\n  ${def.description.replace(/\s+/g, ' ').trim()}` : `description: ${yamlStr(def.description)}`);
  if (def.tools) lines.push(`tools: ${def.tools.join(', ')}`);
  if (def.disallowedTools?.length) lines.push(`disallowedTools: ${def.disallowedTools.join(', ')}`);
  if (def.model) lines.push(`model: ${def.model}`);
  if (def.effort) lines.push(`effort: ${def.effort}`);
  if (def.permissionMode) lines.push(`permissionMode: ${def.permissionMode}`);
  if (def.maxTurns) lines.push(`maxTurns: ${def.maxTurns}`);
  if (def.maxCostUsd) lines.push(`maxCostUsd: ${def.maxCostUsd}`);
  if (def.mcpServers?.length) lines.push(`mcpServers: ${def.mcpServers.join(', ')}`);
  if (def.skills?.length) lines.push(`skills: ${def.skills.join(', ')}`);
  if (def.isolation) lines.push(`isolation: ${def.isolation}`);
  if (def.background !== undefined) lines.push(`background: ${def.background}`);
  if (def.modelInvocable === false) lines.push('disable-model-invocation: true');
  if (def.userInvocable === false) lines.push('user-invocable: false');
  if (def.color) lines.push(`color: ${def.color}`);
  lines.push('---', '', def.prompt.trim(), '');
  return lines.join('\n');
}

export class AgentDefError extends Error {}

/**
 * An agent as given (the API, the app, a generator), checked and cleaned: a name, a description that says
 * when to use it, instructions, and only known values for the rest. Tool and server names are kept as given
 * (a tool that does not exist where it runs is simply not there); `bypass` is never accepted.
 */
export function checkAgentDef(x: unknown): AgentDef {
  if (!x || typeof x !== 'object') throw new AgentDefError('an agent is an object: {name, description, prompt, ...}');
  const o = x as Record<string, unknown>;
  const s = (k: string, max: number, required = false) => {
    const v = o[k];
    if (v === undefined || v === null || v === '') { if (required) throw new AgentDefError(`${k} is required`); return undefined; }
    if (typeof v !== 'string') throw new AgentDefError(`${k} is text`);
    if (v.length > max) throw new AgentDefError(`${k} is at most ${max} characters`);
    return v.trim();
  };
  const list = (k: string, re = /^[\w.*:/-]{1,128}$/) => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.length > 200 || !v.every((t) => typeof t === 'string' && re.test(t))) throw new AgentDefError(`${k} is a list of names`);
    return [...new Set(v as string[])];
  };
  const name = s('name', 41, true)!;
  if (!AGENT_NAME.test(name)) throw new AgentDefError('name is letters, digits, - and _ (at most 41), starting with a letter or digit');
  const description = s('description', 1000, true)!;
  if (description.length < 10) throw new AgentDefError('description says when to use it (at least a sentence)');
  const def: AgentDef = { name, description, prompt: s('prompt', 50_000) ?? '' };
  const tools = list('tools');
  if (tools) def.tools = normaliseToolNames(tools.flatMap(toolAlias));
  const deny = list('disallowedTools');
  if (deny?.length) def.disallowedTools = normaliseToolNames(deny.flatMap(toolAlias));
  const model = s('model', 100);
  if (model && model !== 'inherit') def.model = MODEL_ALIASES[model] ?? model;
  if (o.effort !== undefined && o.effort !== null && o.effort !== '') {
    if (!EFFORTS.includes(o.effort as Effort)) throw new AgentDefError(`effort is one of ${EFFORTS.join(', ')}`);
    def.effort = o.effort as Effort;
  }
  const servers = list('mcpServers', /^[\w.-]{1,64}$/);
  if (servers) def.mcpServers = servers;
  const skills = list('skills', /^[\w.:-]{1,64}$/);
  if (skills) def.skills = skills;
  if (o.permissionMode !== undefined && o.permissionMode !== null && o.permissionMode !== '') {
    if (!(PERMISSION_MODES as readonly string[]).includes(String(o.permissionMode))) throw new AgentDefError(`permissionMode is one of ${PERMISSION_MODES.join(', ')}`);
    def.permissionMode = o.permissionMode as AgentDef['permissionMode'];
  }
  if (o.maxTurns !== undefined && o.maxTurns !== null && o.maxTurns !== '') {
    const n = Number(o.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new AgentDefError('maxTurns is a whole number from 1 to 1000');
    def.maxTurns = n;
  }
  if (o.maxCostUsd !== undefined && o.maxCostUsd !== null && o.maxCostUsd !== '') {
    const n = Number(o.maxCostUsd);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new AgentDefError('maxCostUsd is an amount in dollars, above 0 and at most 1000');
    def.maxCostUsd = n;
  }
  if (o.isolation !== undefined && o.isolation !== null && o.isolation !== '') {
    if (o.isolation !== 'worktree') throw new AgentDefError('isolation is worktree');
    def.isolation = 'worktree';
  }
  for (const k of ['background', 'modelInvocable', 'userInvocable'] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    if (typeof o[k] !== 'boolean') throw new AgentDefError(`${k} is true or false`);
    def[k] = o[k] as boolean;
  }
  const color = s('color', 20);
  if (color) { if (!/^#?[\w-]{1,20}$/.test(color)) throw new AgentDefError('color is a name or #rrggbb'); def.color = color; }
  return def;
}

/** A tool name matched against an agent's list: exact, or a glob with `*` (`mcp__github__*`). */
export function toolMatches(patterns: string[], name: string): boolean {
  return patterns.some((p) => (p.includes('*') ? new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name) : p === name));
}

/** The MCP server a tool belongs to (`mcp__<server>__<tool>`), or undefined. */
export const mcpServerOf = (tool: string): string | undefined => /^mcp__(.+?)__/.exec(tool)?.[1];

/** How much a mode lets an agent do without asking, least first: an agent's mode never loosens the conversation's. */
const MODE_RANK: Record<string, number> = { plan: 0, dontAsk: 1, default: 2, auto: 3, acceptEdits: 4, bypass: 5 };
export function stricterMode<M extends string>(session: M, agent: string | undefined): M {
  if (!agent || MODE_RANK[agent] === undefined) return session;
  return (MODE_RANK[agent]! < (MODE_RANK[session] ?? 5) ? agent : session) as M;
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
  // One line each, in every request of the session: long descriptions and tool lists are cut (more so with many agents).
  const room = agents.length > 15 ? 140 : 300;
  const toolsOf = (t: string[]) => (t.length > 12 ? `${t.slice(0, 12).join(', ')}, +${t.length - 12}` : t.join(', '));
  const list = agents.map((a) => `- ${a.name}${a.tools ? ` [${toolsOf(a.tools)}]` : ''}${a.mcpServers?.length ? ` {mcp: ${a.mcpServers.join(', ')}}` : ''}${a.model ? ` (${a.model})` : ''}: ${a.description.length > room ? `${a.description.slice(0, room - 1)}…` : a.description}`).join('\n');
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
      // An agent made to work in the background does, unless the call says otherwise.
      const background = input.run_in_background === undefined || input.run_in_background === null ? !!agents.find((a) => a.name === type)?.background : bool(input.run_in_background);
      const effort = EFFORTS.find((e) => e === str(input.effort));
      const args: SubagentArgs = {
        description: str(input.description), prompt: str(input.prompt), type,
        ...(str(input.model) ? { model: str(input.model) } : {}), ...(effort ? { effort } : {}),
        ...(str(input.isolation) === 'worktree' ? { isolation: 'worktree' as const } : {}),
      };
      const start = ctx.services?.tasks?.startAgent;
      try {
        if (background && start) {
          const id = await start(args);
          return { content: `Started ${id} in the background. Keep working; its report reaches you as a reminder when it finishes. task_output ${id} shows its progress, task_stop ${id} stops it.` };
        }
        const report = await ctx.runSubagent(args);
        // Background work is the main agent's: a sub-agent's background request runs here and now.
        return { content: background ? `${report}\n(Run in the foreground: only the main agent starts background agents.)` : report };
      } catch (e) {
        // A refused delegation or worktree: the agent hears why and can do otherwise.
        if (ctx.signal.aborted) throw e;
        return { content: (e as Error).message, is_error: true };
      }
    },
  };
}
