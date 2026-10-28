import { type JsonSchema, validateFormSchema } from '../../packages/plugin-ui/src/manifest.ts';
import { regex } from './tasks.ts';
import type { QuestionChoice } from '../core/types.ts';
import type { Tool } from './types.ts';
import { str } from './types.ts';

// Tools that talk to the harness rather than the workspace: delegation,
// questions to the user, and entering and leaving plan mode. They are always declared (the
// tool list never changes mid-session, which would break the cache); the
// harness decides whether a call is valid right now.

export const askUserTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'ask_user',
    description: 'Ask the user a decision only they can make. One short question, 2-4 options (mark the recommended one). A form only for multi-part answers: enum = one choice, array of enum items = several, examples = suggestions, default = the safe choice. They may reply in words or skip.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' } }, required: ['label'] } },
        form: { type: 'object', description: 'JSON Schema of fields; the answer is their JSON.' },
      },
      required: ['question'],
    },
  },
  summarize: (i) => `ask: ${str(i.question)}`,
  async run(input, ctx) {
    if (!ctx.askUser) return { content: 'No user is available to answer. Decide sensibly, state the assumption, and continue.', is_error: true };
    const choices = choicesOf(input.options);
    let form: Record<string, unknown> | undefined;
    if (input.form !== undefined) {
      try { form = checkForm(input.form); } catch (e) { return { content: `form is not usable: ${(e as Error).message}`, is_error: true }; }
    }
    const question = str(input.question).trim();
    if (!question) return { content: 'question is empty: say what you need the user to decide.', is_error: true };
    const r = await ctx.askUser(question, choices.map((c) => c.label), form, choices.some((c) => c.description || c.recommended) ? choices : undefined);
    if (typeof r === 'string') return { content: `The user answered: ${r}` };
    if ('skipped' in r) return { content: `The user skipped this question${r.note ? ` and said: ${r.note}` : ''}. Do not ask it again: decide sensibly, say what you assumed, and continue (or stop if going on without an answer is unsafe).` };
    if ('replied' in r) return { content: `The user did not pick a suggested answer${form ? ' or fill in the form' : ''}; they wrote: ${r.replied}\nTake it as their answer, or as new instructions if it asks for something else.` };
    return { content: `The user answered: ${r.answered}${r.note ? `\nTheir note: ${r.note}` : ''}` };
  },
};

/** The suggested answers: labels, or { label, description, recommended }; at most six, the recommended one first. */
function choicesOf(raw: unknown): QuestionChoice[] {
  if (!Array.isArray(raw)) return [];
  const out: QuestionChoice[] = [];
  for (const o of raw) {
    if (typeof o === 'string' && o.trim()) out.push({ label: o.trim().slice(0, 200) });
    else if (o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' && (o as { label: string }).label.trim()) {
      const x = o as { label: string; description?: unknown; recommended?: unknown };
      out.push({ label: x.label.trim().slice(0, 200), ...(typeof x.description === 'string' && x.description.trim() ? { description: x.description.trim().slice(0, 500) } : {}), ...(x.recommended === true ? { recommended: true } : {}) });
    }
  }
  const seen = new Set<string>();
  const unique = out.filter((c) => !seen.has(c.label) && seen.add(c.label));
  let marked = false;
  for (const c of unique) { if (c.recommended && marked) delete c.recommended; if (c.recommended) marked = true; }
  return [...unique.filter((c) => c.recommended), ...unique.filter((c) => !c.recommended)].slice(0, 6);
}

/** A form schema an agent wrote: the plugin-ui subset, and every pattern one that cannot stall the server. */
function checkForm(raw: unknown): Record<string, unknown> {
  const schema = validateFormSchema(raw);
  const walk = (s: JsonSchema): void => {
    if (s.pattern !== undefined) { const r = regex(String(s.pattern)); if (!(r instanceof RegExp)) throw new Error(r.error); }
    for (const p of Object.values(s.properties ?? {})) walk(p);
    if (s.items) walk(s.items);
  };
  walk(schema);
  return schema as Record<string, unknown>;
}

/**
 * The agent's own way into plan mode, for work that should be researched and
 * agreed before anything changes. Entering only restricts what it may do, so it
 * needs no approval; leaving is still the user's call (exit_plan_mode).
 */
export const enterPlanTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'enter_plan_mode',
    description: 'Switch to plan mode before a task that should be researched and agreed before anything changes (large, ambiguous or risky work). You then work read-only and present your plan with exit_plan_mode for the user to approve. Not needed for small, clear tasks.',
    input_schema: { type: 'object', properties: { reason: { type: 'string', description: 'Why planning first helps here, in one line.' } } },
  },
  summarize: () => 'enter plan mode',
  async run(input, ctx) {
    if (ctx.isPlanMode?.()) return { content: 'Already in plan mode: research with read-only tools, then present your plan with exit_plan_mode.' };
    if (!ctx.enterPlanMode) return { content: 'Plan mode is not available here; just proceed with the work.', is_error: true };
    const r = ctx.enterPlanMode(str(input.reason));
    if (!r.ok) return { content: r.reason ?? 'Plan mode is not available here; just proceed with the work.', is_error: true };
    return { content: 'Plan mode is on. Research with read-only tools (no edits, no commands that change anything), then present your plan with exit_plan_mode for the user to approve.' };
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
