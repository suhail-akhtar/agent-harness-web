import type { Tool } from './types.ts';
import { str } from './types.ts';

// Tools that talk to the harness rather than the workspace: delegation,
// questions to the user, and leaving plan mode. They are always declared (the
// tool list never changes mid-session, which would break the cache); the
// harness decides whether a call is valid right now.

export const agentTool: Tool = {
  kind: 'meta', parallelSafe: true, remoteable: false,
  spec: {
    name: 'agent',
    description: 'Delegate a self-contained task to a sub-agent with its own fresh context; it returns only its final report. Use "explore" (read-only: read/glob/grep/web_fetch) to search a codebase or research broadly without filling your own context; use "general" for an independent piece of work that also edits or runs commands. Write the prompt as a complete brief: the goal, what you already know, and what to report back. Several agent calls in one turn run in parallel.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Three to five words, shown to the user.' },
        prompt: { type: 'string' },
        type: { type: 'string', enum: ['explore', 'general'] },
      },
      required: ['description', 'prompt'],
    },
  },
  summarize: (i) => `${i.type === 'general' ? 'agent' : 'explore'}: ${str(i.description)}`,
  async run(input, ctx) {
    if (!ctx.runSubagent) return { content: 'Sub-agents cannot start other sub-agents. Do the work directly.', is_error: true };
    const type = input.type === 'general' ? 'general' : 'explore';
    const report = await ctx.runSubagent({ description: str(input.description), prompt: str(input.prompt), type });
    return { content: report };
  },
};

export const askUserTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'ask_user',
    description: 'Ask the user a question when you are blocked on a decision only they can make (a preference, a missing requirement). Offer 2-4 options when you can. Do not ask for things you can find out yourself.',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
      required: ['question'],
    },
  },
  summarize: (i) => `ask: ${str(i.question)}`,
  async run(input, ctx) {
    if (!ctx.askUser) return { content: 'No user is available to answer. Decide sensibly, state the assumption, and continue.', is_error: true };
    const options = Array.isArray(input.options) ? input.options.filter((o): o is string => typeof o === 'string').slice(0, 6) : [];
    const answer = await ctx.askUser(str(input.question), options);
    return { content: `The user answered: ${answer}` };
  },
};

export const exitPlanTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'exit_plan_mode',
    description: 'In plan mode only: present your implementation plan (markdown) for the user to approve. Call it once you have researched enough to plan; if approved, plan mode ends and you carry it out.',
    input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
  },
  summarize: () => 'propose plan',
  async run(input, ctx) {
    if (!ctx.isPlanMode?.()) return { content: 'Not in plan mode; just proceed with the work.', is_error: true };
    if (!ctx.proposePlan) return { content: 'No user is available to approve a plan.', is_error: true };
    const r = await ctx.proposePlan(str(input.plan));
    if (r.approved) return { content: 'The user approved the plan. Plan mode is off; carry it out now.' };
    return { content: `The user did not approve the plan.${r.feedback ? ` Their feedback: ${r.feedback}` : ''} Stay in plan mode and revise.`, is_error: true };
  },
};
