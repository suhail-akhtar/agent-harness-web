import fs from 'node:fs/promises';
import path from 'node:path';
import type { Effort } from '../core/models.ts';
import type { AgentDef } from '../plugins/api.ts';
import type { Tool } from '../tools/types.ts';
import { str } from '../tools/types.ts';
import { asList, parseFrontmatter } from '../util/frontmatter.ts';

// Sub-agents are named specialists: a prompt, a tool subset, and optionally a
// cheaper or stronger model. Two are built in; plugins and projects add more
// (.harness/agents/*.md, and .claude/agents/*.md for Claude Code compatibility).

export const READ_ONLY_TOOLS = ['glob', 'grep', 'read', 'skill', 'tool_search', 'web_fetch'];
/** Tools a sub-agent never gets: they talk to the user or spawn more agents. */
export const INTERACTIVE_TOOLS = ['agent', 'ask_user', 'enter_plan_mode', 'exit_plan_mode', 'todo_write'];

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
  Bash: 'bash', BashOutput: 'bash', Glob: 'glob', Grep: 'grep', LS: 'glob', WebFetch: 'web_fetch',
  TodoWrite: 'todo_write', Task: 'agent', ExitPlanMode: 'exit_plan_mode', AskUserQuestion: 'ask_user', Skill: 'skill',
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

/** The `agent` tool for one session: its enum and description list exactly the agents available. */
export function makeAgentTool(agents: AgentDef[]): Tool {
  const names = agents.map((a) => a.name);
  const list = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return {
    kind: 'meta', parallelSafe: true, remoteable: false,
    spec: {
      name: 'agent',
      description: `Delegate a self-contained task to a sub-agent with its own fresh context; it returns only its final report. Write the prompt as a complete brief: the goal, what you already know, and what to report back. Several agent calls in one turn run in parallel. Agents:\n${list}`,
      input_schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Three to five words, shown to the user.' },
          prompt: { type: 'string' },
          type: { type: 'string', enum: names, description: 'Which agent; default explore.' },
        },
        required: ['description', 'prompt'],
      },
    },
    summarize: (i) => `${str(i.type) || 'explore'}: ${str(i.description)}`,
    async run(input, ctx) {
      if (!ctx.runSubagent) return { content: 'Sub-agents cannot start other sub-agents. Do the work directly.', is_error: true };
      const type = names.includes(str(input.type)) ? str(input.type) : 'explore';
      const report = await ctx.runSubagent({ description: str(input.description), prompt: str(input.prompt), type });
      return { content: report };
    },
  };
}
