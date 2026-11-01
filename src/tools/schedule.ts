import type { Tool } from './types.ts';
import { bool, num, str } from './types.ts';
import { WORKFLOW_FORMAT } from '../graph/format.ts';
import { describeSchedule } from '../core/scheduler.ts';

// schedule: the agent sets up work for later, in its own session ("check the deploy in 20
// minutes") or in a new conversation each run ("every weekday at 9, summarise what changed"),
// a prompt or a workflow; it lists, deletes and tries what it set up.
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
    description: 'Run a prompt or workflow later: once (in_minutes or ISO at) or on a cron (five fields; time_zone, else the server\'s). It comes back here, or with new_conversation runs each time in a new one like this (routines the user asks for; results go to their Inbox; a checker approves its steps unless asks says refuse (never ask) or inbox (ask the user); asks is about approvals, not notifications: omit it unless the user says). list, delete, run_now.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'delete', 'run_now'] },
        prompt: { type: 'string', description: 'A complete instruction, as if the user typed it then' },
        in_minutes: { type: 'number' },
        at: { type: 'string' },
        cron: { type: 'string' },
        time_zone: { type: 'string' },
        new_conversation: { type: 'boolean' },
        asks: { type: 'string', enum: ['refuse', 'inbox'] },
        workflow: { type: 'string' },
        input: { type: 'object', additionalProperties: { type: 'string' } },
        watch: { type: 'object', description: 'Instead of a time: {kind: command|files|git|url, command, paths, url, everyMinutes, onlyWhen}' },
        id: { type: 'string' },
      },
      required: ['action'],
    },
  },
  summarize: (i) => str(i.action) === 'create' ? `schedule ${str(i.cron) || (i.in_minutes !== undefined ? `in ${str(i.in_minutes)} min` : str(i.at))}${bool(i.new_conversation) ? ' [new conversation each time]' : ''}: ${str(i.workflow) ? `workflow ${str(i.workflow)}` : str(i.prompt).slice(0, 80)}` : `schedule ${str(i.action)}${str(i.id) ? ` ${str(i.id)}` : ''}`,
  async run(input, ctx) {
    const sch = ctx.services?.schedules;
    if (!sch) return { content: 'Scheduling is not available here (sub-agents and scripts cannot schedule).', is_error: true };
    const action = str(input.action);
    try {
      if (action === 'list') {
        const items = await sch.list();
        return { content: items.length ? items.map((s) => `${s.id}: ${describeSchedule(s)}${s.enabled && s.nextRun ? `, next ${new Date(s.nextRun).toISOString()}` : s.enabled ? '' : ' (off)'}${s.newSession ? ', a new conversation each time' : ''}${s.workflow ? `, workflow ${s.workflow.name}` : ''}${s.lastResult ? `, last: ${s.lastResult}` : ''} - ${s.title}`).join('\n') : 'No schedules from this conversation.' };
      }
      if (action === 'delete') return { content: (await sch.remove(str(input.id))) ? `Deleted ${str(input.id)}.` : `No schedule ${str(input.id)} from this conversation.`, is_error: false };
      if (action === 'run_now') {
        const s = await sch.runNow?.(str(input.id));
        return s ? { content: `Started ${s.id} now (${s.lastResult}). Its result reaches the user's Inbox; list shows its last result.` } : { content: `No schedule ${str(input.id)} this conversation set up in new conversations (one that comes back here runs at its time).`, is_error: true };
      }
      if (action !== 'create') return { content: 'action must be create, list, delete or run_now', is_error: true };
      const at = str(input.at) ? Date.parse(str(input.at)) : undefined;
      if (at !== undefined && Number.isNaN(at)) return { content: `"${str(input.at)}" is not a date-time`, is_error: true };
      const raw = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
      const s = await sch.create({
        prompt: str(input.prompt), cron: str(input.cron) || undefined, inMinutes: num(input.in_minutes), at,
        timeZone: str(input.time_zone) || undefined, newConversation: bool(input.new_conversation), ...(str(input.asks) === 'inbox' || str(input.asks) === 'refuse' ? { asks: str(input.asks) as 'inbox' | 'refuse' } : {}),
        ...(input.watch && typeof input.watch === 'object' ? { watch: input.watch as Record<string, unknown> } : {}),
        ...(str(input.workflow) ? { workflow: { name: str(input.workflow), input: Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])) } } : {}),
      });
      if (s.watch) return { content: `Watching ${s.id}: ${describeSchedule(s)}${s.newSession ? ', each change run in a new conversation' : ', each change run here'}. Its first look is now; it runs only when what it watches changes. The user sees it on the Scheduled page${s.newSession ? ' and its results in their Inbox' : ''}.` };
      return { content: `Scheduled ${s.id}: ${s.cron ? `${describeSchedule(s)}, next run ${new Date(s.nextRun!).toISOString()}` : `once at ${new Date(s.nextRun!).toISOString()}`}${s.newSession ? ', each time in a new conversation' : ', here'}. The user sees it on the Scheduled page${s.newSession ? ' and its results in their Inbox; run_now tries it' : ''}.` };
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
    description: 'Run one of this session\'s workflows now - a fixed graph of agent steps, quality gates and approvals (e.g. build-feature: requirements, plan, test-first build, review; long-task: a project built feature by feature) - and get its outcome. Use it when the user asks for that process or a big job matches one; for ordinary work do it yourself. "list" shows the workflows and their inputs. To make a reusable one for this project (the user asks for a process to repeat, a pipeline with an approval): "format" gives the file format, write .harness/workflows/<name>.json, "check" validates it, then "run" it. With run_in_background the run starts and you get its id at once; its outcome reaches you as a reminder when it ends.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run', 'format', 'check'] },
        name: { type: 'string' },
        input: { type: 'object', description: 'The workflow\'s inputs, as strings', additionalProperties: { type: 'string' } },
        run_in_background: { type: 'boolean' },
      },
      required: ['action'],
    },
  },
  summarize: (i) => str(i.action) === 'run' ? `${bool(i.run_in_background) ? '[background] ' : ''}workflow ${str(i.name)}` : `workflow ${str(i.action) || 'list'}`,
  async run(input, ctx) {
    const wf = ctx.services?.workflows;
    if (!wf) return { content: 'Workflows are not available here (sub-agents and scripts cannot start them).', is_error: true };
    if (str(input.action) === 'format') return { content: WORKFLOW_FORMAT };
    if (str(input.action) === 'check') {
      const files = (await wf.check?.()) ?? [];
      if (!files.length) return { content: 'No workflow files in .harness/workflows/ yet. "format" shows how to write one.' };
      return { content: files.map((f) => `${f.file}${f.name ? ` (${f.name})` : ''}: ${f.loaded ? 'OK, loaded' : `NOT LOADED\n  - ${f.problems.join('\n  - ')}`}`).join('\n'), is_error: files.some((f) => !f.loaded) };
    }
    if (str(input.action) === 'list') {
      const all = await wf.list();
      const broken = ((await wf.check?.()) ?? []).filter((f) => !f.loaded);
      const note = broken.length ? `\n\nNot loaded (see "check"): ${broken.map((f) => f.file).join(', ')}` : '';
      return { content: `${all.length ? all.map((w) => `- ${w.name}${w.inputs.length ? ` (inputs: ${w.inputs.join(', ')})` : ''}: ${w.description}`).join('\n') : 'No workflows are installed.'}${note}\n\nYour own: "format" shows the file format for .harness/workflows/<name>.json.` };
    }
    const raw = input.input && typeof input.input === 'object' ? input.input as Record<string, unknown> : {};
    const values = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    try {
      if (bool(input.run_in_background) && wf.start) {
        const id = await wf.start(str(input.name), values);
        return { content: `Workflow ${str(input.name)} started in the background as ${id}. Keep working; its outcome reaches you as a reminder when it ends. task_output ${id} shows its steps so far, task_stop ${id} stops it.` };
      }
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
