import type { PluginAPI, PluginDefinition, PluginRouteRequest } from '@harness/plugin-sdk';
import type { Data, Expense, Status } from './types.ts';

// The worked example of docs/guide/04-build-your-system.md: expense claims an agent audits against a policy, and a
// person approves. Everything it needs comes through `api`, so it runs wherever it is installed.

/** The most one claim may be, by category. A rule in code: the model reads the result and never does the sum. */
export const LIMITS: Record<string, number> = { meals: 75, travel: 1500, software: 300, other: 100 };

/** Why a claim breaks the policy, or undefined. */
export function policyProblem(e: Pick<Expense, 'category' | 'amount' | 'note'>): string | undefined {
  const limit = LIMITS[e.category];
  if (limit === undefined) return `unknown category "${e.category}" (known: ${Object.keys(LIMITS).join(', ')})`;
  if (e.amount > limit) return `${e.amount} is over the ${e.category} limit of ${limit}`;
  if (e.amount >= 25 && !e.note.trim()) return 'a claim of 25 or more needs a note saying what it was for';
  return undefined;
}

const plugin = {
  name: 'expense-review',
  setup(api: PluginAPI) {
    // The plugin's data: one JSON document, versioned. When its shape changes, raise `version` and add a migration.
    const db = api.store<Data>('expenses', { version: 1, initial: () => ({ expenses: [] }) });
    const newId = () => `E-${Math.random().toString(36).slice(2, 8)}`;
    const line = (e: Expense) => `${e.id} [${e.status}] ${e.who}: ${e.amount} ${e.category}${e.note ? ` - ${e.note}` : ''}${e.reason ? ` (${e.reason})` : ''}`;
    const changed = () => api.signal('expenses'); // open pages refresh at once

    async function add(who: string, category: string, amount: number, note: string): Promise<Expense> {
      const e: Expense = { id: newId(), who, category, amount, note, status: 'pending', createdAt: new Date().toISOString() };
      await db.update((d) => { d.expenses.unshift(e); });
      changed();
      return e;
    }

    async function decide(id: string, status: Status, reason: string): Promise<Expense | undefined> {
      let found: Expense | undefined;
      await db.update((d) => { found = d.expenses.find((x) => x.id === id); if (found) { found.status = status; found.reason = reason; } });
      if (found) changed();
      return found;
    }

    api.registerTool({
      name: 'expense_add',
      description: 'Record an expense claim. Use when the person gives you one.',
      parameters: {
        type: 'object',
        properties: {
          who: { type: 'string', description: 'Who is claiming' },
          category: { type: 'string', enum: Object.keys(LIMITS), description: 'What kind of expense it is' },
          amount: { type: 'number', description: 'The amount, above 0' },
          note: { type: 'string', description: 'What it was for' },
        },
        required: ['who', 'category', 'amount'],
      },
      kind: 'edit', // it changes something: asked about in "Ask first" mode
      sendsOut: false,
      summarize: (i) => `add a claim of ${i.amount} for ${i.who}`,
      async run(input) {
        const amount = Number(input.amount);
        if (!(amount > 0)) return { content: 'The amount must be above 0.', is_error: true };
        return `Added ${line(await add(String(input.who).trim(), String(input.category), amount, String(input.note ?? '').trim()))}`;
      },
    });

    api.registerTool({
      name: 'expense_list',
      description: 'The pending claims, each with its id. Pass status for another list.',
      parameters: { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'], description: 'Which claims to list (default pending)' } } },
      kind: 'read',
      parallelSafe: true,
      sendsOut: false,
      async run(input) {
        const wanted = String(input.status ?? 'pending');
        const shown = (await db.read()).expenses.filter((e) => e.status === wanted);
        return shown.length ? shown.map(line).join('\n') : `No ${wanted} claims.`;
      },
    });

    api.registerTool({
      name: 'expense_policy_check',
      description: 'Checks every pending claim against the expense policy and says which break it and why. Use this, never your own arithmetic.',
      parameters: { type: 'object', properties: {} },
      kind: 'read',
      parallelSafe: true,
      sendsOut: false,
      async run() {
        const pending = (await db.read()).expenses.filter((e) => e.status === 'pending');
        if (!pending.length) return 'No pending claims.';
        return pending.map((e) => { const p = policyProblem(e); return `${e.id}: ${p ? `BREAKS POLICY: ${p}` : 'within policy'}`; }).join('\n');
      },
    });

    api.registerTool({
      name: 'expense_decide',
      description: 'Record the decision on a pending claim, with the reason. Use only after a person has approved the decision.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The claim, e.g. E-x1y2z3' }, decision: { type: 'string', enum: ['approved', 'rejected'], description: 'The decision a person approved' }, reason: { type: 'string', description: 'Why, in one line' } },
        required: ['id', 'decision', 'reason'],
      },
      kind: 'edit',
      sendsOut: false,
      summarize: (i) => `${i.decision} ${i.id}`,
      async run(input) {
        const e = await decide(String(input.id), input.decision as Status, String(input.reason));
        return e ? `Decided: ${line(e)}` : { content: `No claim ${input.id}. expense_list shows the ids.`, is_error: true };
      },
    });

    // The page's routes: auth 'user' (signed in, as the app's own pages are). GET reads, POST changes.
    const json = (status: number, body: unknown) => ({ status, body: body as object });
    const parse = (req: PluginRouteRequest) => { try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { return {}; } };

    api.registerRoute({
      method: 'GET', path: 'expenses', auth: 'user',
      async handler() {
        const { expenses } = await db.read();
        return json(200, { expenses: expenses.map((e) => ({ ...e, problem: e.status === 'pending' ? policyProblem(e) ?? null : null })) });
      },
    });
    api.registerRoute({
      method: 'POST', path: 'expenses', auth: 'user',
      async handler(req) {
        const b = parse(req);
        const amount = Number(b.amount);
        if (!String(b.who ?? '').trim() || !(amount > 0)) return json(400, { error: 'Who and an amount above 0 are required.' });
        return json(201, { expense: await add(String(b.who).trim(), String(b.category ?? 'other'), amount, String(b.note ?? '').trim()) });
      },
    });
  },
} satisfies PluginDefinition;

export default plugin;
