import type { JsonSchema } from '../../packages/plugin-ui/src/manifest.ts';
import { commandArgsProblems, type DesktopTool } from '../core/client.ts';
import { fenceOutside } from '../core/untrusted.ts';
import type { Tool, ToolContext, ToolOutcome } from './types.ts';
import { clip, str } from './types.ts';

// Desktop tools: served by the person's desktop app while it is attached to the session.
// The server forwards each call to it on the event stream (client_call) and waits for its
// answer (POST /api/sessions/:id/client-result). Declared only for a session whose client
// said it serves them, so other sessions' tool lists (and caches) are untouched.

/** What a desktop tool reaches in the session. */
export interface ClientService {
  /** Forwards a call to the attached client and waits for its answer (or throws: not attached, timeout, stopped). */
  call(tool: DesktopTool, input: Record<string, unknown>, signal: AbortSignal): Promise<{ ok: boolean; result?: unknown; error?: string; untrusted?: boolean }>;
  /** An agent-callable command: from a server plugin's manifest (agent marker) or the client's own declaration. */
  command(id: string): { description: string; inputSchema?: JsonSchema; plugin: string } | { error: string };
  /** Whether a plugin named in the app is one this server ships (its text is not outside content). */
  firstParty(plugin: string): boolean;
}

const RESULT_MAX = 20_000;

function svc(ctx: ToolContext): ClientService | undefined { return ctx.services?.client; }

async function forward(tool: DesktopTool, input: Record<string, unknown>, ctx: ToolContext, opts: { untrusted?: (result: unknown) => boolean } = {}): Promise<ToolOutcome> {
  const s = svc(ctx);
  if (!s) return { content: 'No desktop app serves this session.', is_error: true };
  let r: Awaited<ReturnType<ClientService['call']>>;
  try { r = await s.call(tool, input, ctx.signal); } catch (e) { return { content: (e as Error).message, is_error: true }; }
  const outside = !!r.untrusted || (r.ok && !!opts.untrusted?.(r.result));
  const text = r.ok ? (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? 'done')) : `The desktop app refused or failed: ${String(r.error ?? 'no reason given')}`;
  const body = clip(text, RESULT_MAX, 'trimmed');
  return { content: outside ? fenceOutside(body, `the desktop app (${tool})`) : body, ...(r.ok ? {} : { is_error: true }), ...(outside ? { untrusted: true } : {}) };
}

export const desktopDescribeTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  spec: {
    name: 'desktop_describe',
    description: 'What the desktop app has now: plugins, views, panels, agent-callable commands, settings sections, renderers, themes.',
    input_schema: { type: 'object', properties: {} },
  },
  summarize: () => 'describe the desktop',
  async run(_input, ctx) {
    // Plugins' names, titles and descriptions are their authors' text: outside content unless this server ships them.
    return forward('desktop_describe', {}, ctx, {
      untrusted: (res) => {
        const plugins = (res && typeof res === 'object' ? (res as { plugins?: unknown }).plugins : undefined);
        if (!Array.isArray(plugins)) return true;
        const s = svc(ctx)!;
        return plugins.some((p) => !s.firstParty(String((p as { name?: unknown; id?: unknown })?.name ?? (p as { id?: unknown })?.id ?? '')));
      },
    });
  },
};

export const desktopOpenTool: Tool = {
  kind: 'read', parallelSafe: false, remoteable: false,
  // A URL opened in the person's browser can carry data out: confirmed after untrusted content.
  sendsOut: (i) => str(i.target) === 'url',
  spec: {
    name: 'desktop_open',
    description: 'Show something in the desktop app: a view or panel (id), a workspace file (path), an artifact (id) or a URL (url).',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['view', 'panel', 'file', 'artifact', 'url'] },
        id: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' },
        params: { type: 'object' },
      },
      required: ['target'],
    },
  },
  summarize: (i) => `open ${str(i.target)} ${str(i.id) || str(i.path) || str(i.url)}`,
  async run(input, ctx) {
    const target = str(input.target);
    const need = target === 'url' ? 'url' : target === 'file' ? 'path' : 'id';
    const value = str(input[need]).trim();
    if (!value || value.length > 2000) return { content: `desktop_open ${target} needs ${need}`, is_error: true };
    if (target === 'url' && !/^https?:\/\//i.test(value)) return { content: 'only http(s) URLs are opened', is_error: true };
    const params = input.params && typeof input.params === 'object' && !Array.isArray(input.params) && JSON.stringify(input.params).length <= 4000 ? input.params : undefined;
    return forward('desktop_open', { target, [need]: value, ...(params ? { params } : {}) }, ctx);
  },
};

export const desktopNotifyTool: Tool = {
  kind: 'read', parallelSafe: true, remoteable: false,
  sendsOut: false,
  spec: {
    name: 'desktop_notify',
    description: 'A notification from the desktop app (shown when it is in the background).',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title'] },
  },
  summarize: (i) => `notify: ${str(i.title)}`,
  async run(input, ctx) {
    return forward('desktop_notify', { title: str(input.title).slice(0, 120), body: str(input.body).slice(0, 1000) }, ctx);
  },
};

export const desktopCommandTool: Tool = {
  // It acts in the person's app: asked unless an operator's or the person's rule allows desktop_command(<command>).
  kind: 'external', parallelSafe: false, remoteable: false,
  ruleSubject: (i) => str(i.command),
  spec: {
    name: 'desktop_command',
    description: 'Run an agent-callable command of the desktop app ("<plugin>:<id>", see desktop_describe) with args.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'object' } }, required: ['command'] },
  },
  summarize: (i) => `desktop command ${str(i.command)}`,
  async run(input, ctx) {
    const s = svc(ctx);
    if (!s) return { content: 'No desktop app serves this session.', is_error: true };
    const id = str(input.command).trim();
    const c = s.command(id);
    if ('error' in c) return { content: c.error, is_error: true };
    const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? input.args : {};
    if (JSON.stringify(args).length > 20_000) return { content: 'args are larger than 20,000 characters', is_error: true };
    const problems = commandArgsProblems(c.inputSchema, args);
    if (problems.length) return { content: `Invalid args for ${id}: ${problems.slice(0, 8).join('; ')}`, is_error: true };
    return forward('desktop_command', { command: id, args }, ctx, { untrusted: () => !s.firstParty(c.plugin) });
  },
};

export const DESKTOP_TOOL_IMPLS: Record<DesktopTool, Tool> = {
  desktop_command: desktopCommandTool, desktop_describe: desktopDescribeTool, desktop_notify: desktopNotifyTool, desktop_open: desktopOpenTool,
};
