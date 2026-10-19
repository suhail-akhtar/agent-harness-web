import type { ToolHost } from '../runtime/host.ts';
import type { HookEvent, HookSpec, Settings } from './settings.ts';

// Hooks are deterministic steps the model cannot skip: a formatter after every
// edit, a test gate before the agent may stop, a policy check before a command.
// A hook is a shell command run on the session's host with the event as JSON
// on stdin. Exit 0 = proceed (stdout is added as context where noted);
// exit 2 = block, with stderr as the reason the model sees; other codes are
// reported to the user and ignored.

export interface HookResult { blocked: boolean; feedback: string; errors: string[] }

export async function runHooks(
  settings: Settings,
  host: ToolHost,
  event: HookEvent,
  payload: Record<string, unknown>,
  matchName?: string,
  signal?: AbortSignal,
): Promise<HookResult> {
  const specs: HookSpec[] = settings.hooks[event] ?? [];
  const result: HookResult = { blocked: false, feedback: '', errors: [] };
  for (const h of specs) {
    if (h.matcher && matchName !== undefined) {
      let re: RegExp;
      try { re = new RegExp(`^(?:${h.matcher})$`); } catch { result.errors.push(`bad hook matcher ${h.matcher}`); continue; }
      if (!re.test(matchName)) continue;
    }
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
  result.feedback = result.feedback.trim();
  return result;
}
