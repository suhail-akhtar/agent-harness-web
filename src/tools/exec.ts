import type { Tool, ToolContext, ToolOutcome } from './types.ts';
import { clip, num, str } from './types.ts';

/**
 * Shell commands that write file CONTENT the file tools should write instead.
 * Those go through write/edit so they get a checkpoint (undo), a diff, the
 * stale-file check and edit permissions - a sandboxed shell would otherwise
 * be a way around "ask before edits". Build steps, installers and redirects
 * to /tmp or /dev are not affected. Returns the offending pattern, if any.
 */
export function shellFileWrite(cmd: string): string | undefined {
  if (process.env.HARNESS_SHELL_WRITE_GUARD === 'off') return undefined;
  const target = (t: string | undefined) => !!t && !/^['"]?\/(tmp|dev)\//.test(t) && !/^&?\d?$/.test(t);
  let m = /\bcat\s+(?:<<-?\s*['"]?\w+['"]?\s*)?>>?\s*([^\s|&;<>]+)/.exec(cmd) ?? /\bcat\s*>>?\s*([^\s|&;<>]+)\s*<</.exec(cmd);
  if (m && target(m[1])) return `cat > ${m[1]}`;
  m = /<<-?\s*['"]?\w+['"]?\s*>>?\s*([^\s|&;<>]+)/.exec(cmd);
  if (m && target(m[1])) return `heredoc > ${m[1]}`;
  if (/\b(sed|perl)\s+(?:-[a-zA-Z]*i\b|-i\S*|--in-place)/.test(cmd)) return 'in-place sed/perl edit';
  m = /\btee\s+(?:-a\s+)?([^\s|&;<>]+)/.exec(cmd);
  if (m && target(m[1]) && m[1] !== '-a') return `tee ${m[1]}`;
  m = /\b(?:echo|printf)\b[^|;&]*?>>?\s*([^\s|&;<>]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|scala|sh|md|html?|css|scss|json|ya?ml|toml|sql|vue|svelte))\b/.exec(cmd);
  if (m && target(m[1])) return `echo/printf > ${m[1]}`;
  return undefined;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 30_000;

export const bashTool: Tool = {
  kind: 'exec', parallelSafe: false, remoteable: true,
  spec: {
    name: 'bash',
    description: 'Run a shell command in the workspace and return its exit code and output. For builds, tests, git, package managers and scripts. Use the file tools rather than cat/sed/grep/find to read, edit or search; writing file contents from the shell (cat > file, heredocs, sed -i, tee, echo > file.js) is refused - use write or edit, which record undo checkpoints and show diffs. Each call is a fresh shell (cd does not persist; use `cd dir && cmd`). Default timeout 120s, max 600s. Long output is trimmed to its head and tail, so filter it (| tail -50, | grep) when you can. For servers and watchers set run_in_background: it returns at once with the PID and a log file; check the log with tail and stop it with kill.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
        run_in_background: { type: 'boolean', description: 'Start a long-running process (a dev server) and return immediately.' },
        description: { type: 'string', description: 'Five words or fewer on what it does (shown to the user).' },
      },
      required: ['command'],
    },
  },
  summarize: (i) => `${i.run_in_background === true ? '[background] ' : ''}${str(i.command)}`,
  async run(input, ctx) {
    const command = str(input.command);
    if (!command.trim()) return { content: 'command is empty.', is_error: true };
    const write = shellFileWrite(command);
    if (write) return { content: `Not run: this command writes file contents from the shell (${write}). Use the write tool for new or fully rewritten files and edit for changes - they keep undo checkpoints, diffs and edit permissions. Run the rest of the command separately if needed.`, is_error: true };
    if (input.run_in_background === true || input.run_in_background === 'true') return background(command, ctx);
    const timeoutMs = Math.min(MAX_TIMEOUT, Math.max(1000, num(input.timeout_ms) ?? DEFAULT_TIMEOUT));
    const r = await ctx.host.exec(command, { timeoutMs, signal: ctx.signal });
    const parts: string[] = [];
    if (r.timedOut) parts.push(`Timed out after ${timeoutMs / 1000}s (the command was killed).`);
    parts.push(`exit code: ${r.code ?? 'killed'}`);
    if (r.stdout.trim()) parts.push(clip(r.stdout.trimEnd(), MAX_OUTPUT, 'filter the output to see this part'));
    if (r.stderr.trim()) parts.push(`stderr:\n${clip(r.stderr.trimEnd(), Math.floor(MAX_OUTPUT / 2))}`);
    if (!r.stdout.trim() && !r.stderr.trim()) parts.push('(no output)');
    if (r.orphansKilled) parts.push('Note: processes this command left running in the background (`&`) were stopped when it finished. Start servers with run_in_background instead.');
    if (ctx.host.networkPolicy === 'none' && /could not resolve|network is unreachable|temporary failure in name resolution|ENOTFOUND|EAI_AGAIN/i.test(r.stderr + r.stdout)) {
      parts.push('Note: this sandbox has no network access. The user can enable it in the session settings.');
    }
    return { content: parts.join('\n'), is_error: r.code !== 0 };
  },
};

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Starts a detached process (own session, all stdio redirected to a log in the
 * workspace) so the tool call returns at once and the process outlives it.
 */
async function background(command: string, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.host.shell === 'powershell') return { content: 'run_in_background is not supported on Windows hosts; use Start-Process in a normal command.', is_error: true };
  const id = Math.random().toString(36).slice(2, 8);
  const log = `.harness/bg/${id}.log`;
  const script = `mkdir -p .harness/bg && (setsid nohup bash -c ${shq(command)} > ${log} 2>&1 < /dev/null & echo $!)`;
  const r = await ctx.host.exec(script, { timeoutMs: 15_000, signal: ctx.signal });
  const pid = r.stdout.trim().split('\n').pop();
  if (r.code !== 0 || !pid) return { content: `could not start: ${r.stderr.trim() || r.stdout.trim()}`, is_error: true };
  await new Promise((res) => setTimeout(res, 2500));
  const peek = await ctx.host.exec(`tail -n 20 ${log}; kill -0 ${pid} 2>/dev/null && echo "[running]" || echo "[exited]"`, { timeoutMs: 10_000, signal: ctx.signal });
  return { content: `Started in the background: pid ${pid}, output in ${log}.\nFirst output:\n${clip(peek.stdout.trim(), 4000)}\nCheck later with \`tail -n 50 ${log}\`; stop with \`kill ${pid}\`.` };
}

export const todoTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'todo_write',
    description: 'Keep a task list for multi-step work (3+ steps). Send the whole list each time. Exactly one item in_progress while working; mark items completed as soon as they are done. Skip it for simple tasks.',
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  summarize: (i) => `update todos (${Array.isArray(i.todos) ? i.todos.length : 0})`,
  async run(input, ctx) {
    if (!Array.isArray(input.todos)) return { content: 'todos must be an array of {content, status}.', is_error: true };
    const todos = input.todos
      .filter((t): t is { content: string; status: string } => !!t && typeof t === 'object' && typeof (t as { content?: unknown }).content === 'string')
      .map((t) => ({ content: t.content, status: (['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending') as 'pending' | 'in_progress' | 'completed' }));
    ctx.setTodos(todos);
    const done = todos.filter((t) => t.status === 'completed').length;
    const open = todos.filter((t) => t.status !== 'completed');
    return { content: `Todos updated: ${done}/${todos.length} done.${open.length ? ` Next: ${open[0]!.content}` : ' All done - verify, then report.'}` };
  },
};
