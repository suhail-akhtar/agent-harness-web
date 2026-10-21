import type { Tool } from './types.ts';
import { num, str } from './types.ts';

// schedule: the agent sets up work for later in its own session ("check the
// deploy in 20 minutes", "every morning, run the flaky test 50 times and report").
// notify_user: the agent tells the person something now, wherever they are
// (the session, and any Notification hooks: chat, phone).

export const scheduleTool: Tool = {
  // It makes the session act later with nobody asked: confirmed like an action on another system.
  kind: 'external', parallelSafe: false, remoteable: false,
  // What it saves runs in future turns: confirmed after untrusted content, like memory.
  persists: (i) => str(i.action) === 'create',
  sendsOut: false,
  spec: {
    name: 'schedule',
    description: 'Schedule a prompt to run later in this session, once (in_minutes, or at an ISO time) or repeatedly (cron, five fields: minute hour day-of-month month day-of-week, server time). Use it to check back on something slow (a deploy, a long job) or for recurring checks the user asked for. "list" shows this session\'s schedules; "delete" removes one by id.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete'] },
        prompt: { type: 'string', description: 'What to do when it runs: a complete instruction, as if the user typed it then.' },
        in_minutes: { type: 'number' },
        at: { type: 'string', description: 'ISO date-time' },
        cron: { type: 'string', description: 'e.g. "0 9 * * 1-5" for 9:00 on weekdays' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  summarize: (i) => str(i.action) === 'create' ? `schedule ${str(i.cron) || (i.in_minutes !== undefined ? `in ${str(i.in_minutes)} min` : str(i.at))}: ${str(i.prompt).slice(0, 80)}` : `schedule ${str(i.action)}`,
  async run(input, ctx) {
    const sch = ctx.services?.schedules;
    if (!sch) return { content: 'Scheduling is not available here (sub-agents and scripts cannot schedule).', is_error: true };
    const action = str(input.action);
    try {
      if (action === 'list') {
        const items = await sch.list();
        return { content: items.length ? items.map((s) => `${s.id}: ${s.cron ? `cron "${s.cron}"` : 'once'}, next ${s.nextRun ? new Date(s.nextRun).toISOString() : '(done)'}${s.lastResult ? `, last: ${s.lastResult}` : ''} - ${s.title}`).join('\n') : 'No schedules in this session.' };
      }
      if (action === 'delete') return { content: (await sch.remove(str(input.id))) ? `Deleted ${str(input.id)}.` : `No schedule ${str(input.id)} in this session.`, is_error: false };
      if (action !== 'create') return { content: 'action must be create, list or delete', is_error: true };
      const at = str(input.at) ? Date.parse(str(input.at)) : undefined;
      if (at !== undefined && Number.isNaN(at)) return { content: `"${str(input.at)}" is not a date-time`, is_error: true };
      const s = await sch.create({ prompt: str(input.prompt), cron: str(input.cron) || undefined, inMinutes: num(input.in_minutes), at });
      return { content: `Scheduled ${s.id}: next run ${new Date(s.nextRun!).toISOString()}${s.cron ? `, then on "${s.cron}"` : ''}.` };
    } catch (e) {
      return { content: (e as Error).message, is_error: true };
    }
  },
};

export const workflowTool: Tool = {
  // Its steps are agents and gates whose every call is checked; starting one decides nothing by itself.
  kind: 'meta', parallelSafe: false, remoteable: false,
  sendsOut: false,
  spec: {
    name: 'workflow',
    description: 'Run one of this session\'s workflows now - a fixed graph of agent steps, quality gates and approvals (e.g. build-feature: requirements, plan, test-first build, review; long-task: a project built feature by feature) - and get its outcome. Use it when the user asks for that process or a big job matches one; for ordinary work do it yourself. "list" shows the workflows and their inputs.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run'] },
        name: { type: 'string' },
        input: { type: 'object', description: 'The workflow\'s inputs, as strings', additionalProperties: { type: 'string' } },
      },
      required: ['action'],
    },
  },
  summarize: (i) => str(i.action) === 'run' ? `workflow ${str(i.name)}` : 'workflow list',
  async run(input, ctx) {
    const wf = ctx.services?.workflows;
    if (!wf) return { content: 'Workflows are not available here (sub-agents and scripts cannot start them).', is_error: true };
    if (str(input.action) === 'list') {
      const all = await wf.list();
      return { content: all.length ? all.map((w) => `- ${w.name}${w.inputs.length ? ` (inputs: ${w.inputs.join(', ')})` : ''}: ${w.description}`).join('\n') : 'No workflows are installed.' };
    }
    const raw = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
    const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    try {
      const r = await wf.run(str(input.name), values, ctx.signal);
      return { content: `Workflow ${str(input.name)} ${r.status} ($${r.cost.toFixed(4)}).\n${r.summary}`, is_error: r.status !== 'succeeded' };
    } catch (e) {
      return { content: (e as Error).message, is_error: true };
    }
  },
};

export const notifyTool: Tool = {
  kind: 'meta', parallelSafe: true, remoteable: false,
  sendsOut: false,
  spec: {
    name: 'notify_user',
    description: 'Tell the user something now, even when they are not watching the session (it also reaches any notification channel the operator set up). For results of long or scheduled work, or when you need them and cannot continue. Keep it to one or two sentences.',
    input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  },
  summarize: (i) => `notify: ${str(i.message).slice(0, 80)}`,
  async run(input, ctx) {
    const message = str(input.message).trim().slice(0, 1000);
    if (!message) return { content: 'message is empty', is_error: true };
    if (!ctx.services?.notify) return { content: 'Notifications are not available here.', is_error: true };
    await ctx.services.notify(message);
    return { content: 'Sent.' };
  },
};
