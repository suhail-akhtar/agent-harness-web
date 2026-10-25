// Where in a conversation each deferred tool was loaded (a load_tools result), for providers that take a
// tool's definition at that point instead of in the list on top (Kimi's dynamic tool loading, Claude's
// mid-conversation tool changes): the tool list stays the same from the first request, so the cached
// prefix and the history the provider checks never change when a group loads.

import { LOAD_TOOLS } from '../tools/deferred.ts';
import type { ProviderRequest } from './types.ts';

/**
 * The tools each load_tools result made callable, by the index of the message holding the result; each
 * tool once (its first load), and only those named in `sent`.
 */
export function loadedAt(messages: ProviderRequest['messages'], sent: ReadonlySet<string>): Map<number, string[]> {
  const calls = new Set<string>();
  const at = new Map<number, string[]>();
  const placed = new Set<string>();
  messages.forEach((m, i) => {
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === LOAD_TOOLS) calls.add(b.id);
      if (b.type !== 'tool_result' || !calls.has(b.tool_use_id) || b.is_error) continue;
      const body = /^Loaded; callable from your next step:\n([\s\S]*)$/.exec(b.content)?.[1] ?? '';
      const names = body.split('\n').flatMap((l) => /^[^:\s]+: (.+)$/.exec(l)?.[1]?.split(', ') ?? []).filter((n) => sent.has(n) && !placed.has(n));
      for (const n of names) placed.add(n);
      if (names.length) at.set(i, [...(at.get(i) ?? []), ...names]);
    }
  });
  return at;
}

