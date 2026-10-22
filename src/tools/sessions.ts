import type { Effort } from '../core/models.ts';
import type { StartArgs } from '../core/linked.ts';
import type { Tool } from './types.ts';
import { bool, str } from './types.ts';

// The main agent's tools for other sessions: start a linked session (or propose one), list
// sessions, hand the current task off, dismiss a proposal, and mark a chapter in this one.
// Declared only where linked sessions are on for the session (a desktop or web client, or
// the person's setting), so other sessions' prompts do not grow.

export interface SessionsService {
  start(a: StartArgs, signal: AbortSignal): Promise<string>;
  list(f: { linked?: boolean; status?: string }): Promise<string>;
  send(to: string, message: string): Promise<string>;
  handOff(title: string, plan: string): Promise<string>;
  dismiss(proposalId: string): Promise<string>;
  chapter(title: string, summary?: string): string;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const UNAVAILABLE = { content: 'Linked sessions are not available here.', is_error: true };

async function attempt(f: () => Promise<string> | string) {
  try { return { content: await f() }; } catch (e) { return { content: (e as Error).message, is_error: true }; }
}

/** start_session; `catalogue` lists the other models allowed (fixed for the session). */
export function makeStartSessionTool(catalogue?: string): Tool {
  return {
    kind: 'meta', parallelSafe: false, remoteable: false,
    spec: {
      name: 'start_session',
      description: `Start a separate linked session that works in parallel and reports to you when its turns end. context: fresh (only prompt: write a complete brief) or fork (your conversation so far, then prompt). initiation: user_asked (the person asked for it: starts now), offer or own_initiative (a proposal the person starts or dismisses). use_worktree: its own git worktree and branch; share_workspace: this same folder.${catalogue ? `\n${catalogue}` : ''}`,
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, prompt: { type: 'string' },
          context: { type: 'string', enum: ['fresh', 'fork'] },
          initiation: { type: 'string', enum: ['user_asked', 'offer', 'own_initiative'] },
          use_worktree: { type: 'boolean' }, share_workspace: { type: 'boolean' },
          ...(catalogue ? { model: { type: 'string' }, effort: { type: 'string', enum: EFFORTS } } : {}),
        },
        required: ['title', 'prompt', 'context', 'initiation'],
      },
    },
    summarize: (i) => `${str(i.initiation) === 'user_asked' ? 'start' : 'propose'} session: ${str(i.title)}`,
    async run(input, ctx) {
      const s = ctx.services?.sessions;
      if (!s) return UNAVAILABLE;
      const effort = EFFORTS.find((e) => e === str(input.effort));
      const initiation = (['user_asked', 'offer', 'own_initiative'] as const).find((x) => x === str(input.initiation)) ?? 'offer';
      return attempt(() => s.start({
        title: str(input.title), prompt: str(input.prompt), context: str(input.context) === 'fork' ? 'fork' : 'fresh', initiation,
        ...(input.use_worktree !== undefined ? { useWorktree: bool(input.use_worktree) } : {}), ...(bool(input.share_workspace) ? { shareWorkspace: true } : {}),
        ...(str(input.model) ? { model: str(input.model) } : {}), ...(effort ? { effort } : {}),
      }, ctx.signal));
    },
  };
}

export const listSessionsTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: {
    name: 'list_sessions',
    description: 'This account\'s other sessions (id, status, model, cost, title); linked: only those linked to this one.',
    input_schema: { type: 'object', properties: { linked: { type: 'boolean' }, status: { type: 'string', enum: ['idle', 'running', 'waiting'] } } },
  },
  summarize: (i) => `list sessions${bool(i.linked) ? ' (linked)' : ''}`,
  async run(input, ctx) {
    const s = ctx.services?.sessions;
    if (!s) return UNAVAILABLE;
    return attempt(() => s.list({ linked: bool(input.linked), ...(str(input.status) ? { status: str(input.status) } : {}) }));
  },
};

export const handOffTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'hand_off',
    description: 'Move the task you are in the middle of to a new linked session (a fork; remaining_plan is its brief), then answer the person\'s new message here.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, remaining_plan: { type: 'string' } }, required: ['title', 'remaining_plan'] },
  },
  summarize: (i) => `hand off: ${str(i.title)}`,
  async run(input, ctx) {
    const s = ctx.services?.sessions;
    if (!s) return UNAVAILABLE;
    return attempt(() => s.handOff(str(input.title), str(input.remaining_plan)));
  },
};

export const dismissProposalTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'dismiss_proposal',
    description: 'Withdraw a session you proposed that the person has not started (it went stale or was done here).',
    input_schema: { type: 'object', properties: { proposal_id: { type: 'string' } }, required: ['proposal_id'] },
  },
  summarize: (i) => `dismiss ${str(i.proposal_id)}`,
  async run(input, ctx) {
    const s = ctx.services?.sessions;
    if (!s) return UNAVAILABLE;
    return attempt(() => s.dismiss(str(input.proposal_id)));
  },
};

export const markChapterTool: Tool = {
  kind: 'meta', parallelSafe: true, remoteable: false,
  sendsOut: false,
  spec: {
    name: 'mark_chapter',
    description: 'Start a new chapter of this session when the work moves to a different phase (shown as a table of contents). Sparingly.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' } }, required: ['title'] },
  },
  summarize: (i) => `chapter: ${str(i.title)}`,
  async run(input, ctx) {
    const s = ctx.services?.sessions;
    if (!s) return UNAVAILABLE;
    return attempt(() => s.chapter(str(input.title), str(input.summary) || undefined));
  },
};
