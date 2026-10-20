import type { InProcessHook } from '../kernel/registry.ts';
import type { ToolHost } from '../runtime/host.ts';
import type { HookEvent, HookSpec, Settings } from './settings.ts';

// Hooks are deterministic steps the model cannot skip: a formatter after every
// edit, a test gate before the agent may stop, a policy check before a command.
// Two kinds, same contract:
//   - shell hooks (settings, plugin manifests): a command run on the session's
//     host with the event as JSON on stdin. Exit 0 = proceed (stdout becomes
//     feedback); exit 2 = block, stderr is the reason the model sees; other
//     codes are reported and ignored.
//   - in-process hooks (trusted code plugins): a function returning
//     { block?, feedback? }.

export interface HookResult { blocked: boolean; feedback: string; errors: string[] }

function matches(matcher: string | undefined, name: string | undefined, errors: string[]): boolean {
  if (!matcher || name === undefined) return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name); } catch { errors.push(`bad hook matcher ${matcher}`); return false; }
}

export async function runHooks(
  settings: Settings,
  host: ToolHost,
  event: HookEvent,
  payload: Record<string, unknown>,
  matchName?: string,
  signal?: AbortSignal,
  inProcess: InProcessHook[] = [],
): Promise<HookResult> {
  const specs: HookSpec[] = settings.hooks[event] ?? [];
  const result: HookResult = { blocked: false, feedback: '', errors: [] };
  for (const h of specs) {
    if (!matches(h.matcher, matchName, result.errors)) continue;
    const r = await host.exec(h.command, { timeoutMs: h.timeoutMs ?? 60_000, stdin: JSON.stringify({ event, ...payload }), signal });
    if (r.code === 2) {
      result.blocked = true;
      result.feedback += (r.stderr || r.stdout).trim().slice(0, 4000) + '\n';
    } else if (r.code === 0) {
      if (r.stdout.trim()) result.feedback += r.stdout.trim().slice(0, 4000) + '\n';
    } else {
      result.errors.push(`${event} hook "${h.command}" exited ${r.code}${r.timedOut ? ' (timed out)' : ''}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
    }
  }
  for (const h of inProcess) {
    if (h.event !== event || !matches(h.matcher, matchName, result.errors)) continue;
    try {
      const r = await h.handler({ event, ...payload }, { host, signal: signal ?? new AbortController().signal });
      if (r?.block) result.blocked = true;
      if (r?.feedback) result.feedback += r.feedback.slice(0, 4000) + '\n';
    } catch (err) {
      result.errors.push(`${event} hook from ${h.plugin} failed: ${(err as Error).message}`);
    }
  }
  result.feedback = result.feedback.trim();
  return result;
}
