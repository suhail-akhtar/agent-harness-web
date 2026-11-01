import type { StoredEvent } from './session.ts';
import type { RunEnd } from './schedule-runs.ts';
import { NOTHING_TO_REPORT } from './schedule-runs.ts';
import type { Message } from './types.ts';

// Follows one scheduled or triggered run in its session, from the prompt it sent to the end of that
// turn, and says what came of it: completed or not (and why), its cost, what it said, what it did.

/** What a run's session offers to follow it. */
export interface Followed {
  subscribe(after: number, fn: (e: StoredEvent) => void): () => void;
  readonly meta: { cost: number };
}

/** A tool's kind by name (a tool it does not know counts as acting). */
export type KindOf = (tool: string) => string | undefined;

const QUIET = new Set(['read', 'meta']);

/** The text of an assistant message, without its reasoning. */
const textOf = (m: Message) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();

/** The first lines of a reply, on one line, at most 280 characters. */
export function summaryOf(text: string): string {
  const one = text.replace(NOTHING_TO_REPORT, '').replace(/```[\s\S]*?```/g, ' ').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  return one.length > 280 ? `${one.slice(0, 279)}…` : one;
}

/**
 * Settles when the main agent's turn that began after `from` ends. `from` is the session's last event
 * before the run's prompt was sent; `costBefore` its cost then.
 */
export function followRun(s: Followed, from: number, costBefore: number, kindOf: KindOf): Promise<RunEnd> {
  return new Promise((resolve) => {
    let tools = 0, actions = 0, waited = 0, proposed = 0, notified = false, last = '', warning = '';
    const off = s.subscribe(from, ({ event }) => {
      if ('agent' in event && event.agent && event.agent !== 'main') return;
      if (event.kind === 'tool_call') {
        tools++;
        if (event.name === 'notify_user') notified = true;
        else if (!QUIET.has(kindOf(event.name) ?? 'unknown')) actions++;
      } else if (event.kind === 'assistant_message') {
        const t = textOf(event.message);
        if (t) last = t;
      } else if (event.kind === 'session_proposal') {
        proposed++;
      } else if (event.kind === 'permission_request' || event.kind === 'question' || event.kind === 'plan_proposed') {
        waited++;
      } else if (event.kind === 'notice' && event.level !== 'info') {
        warning = event.text;
      } else if (event.kind === 'turn_end') {
        queueMicrotask(off);
        const costUsd = Math.max(0, s.meta.cost - costBefore);
        const noOp = last.includes(NOTHING_TO_REPORT) || (!last && actions === 0 && !notified && !proposed);
        const status: RunEnd['status'] = event.reason === 'done' ? 'completed' : event.reason === 'aborted' ? 'stopped' : event.reason === 'error' || event.reason === 'refusal' ? 'failed' : 'stopped';
        const why = event.reason === 'done' ? undefined
          : event.reason === 'aborted' ? 'stopped by the person'
            : event.reason === 'budget' ? warning || 'it reached its spend limit'
              : event.reason === 'time' ? warning || 'it reached its time limit'
                : event.reason === 'max_steps' ? warning || 'it reached its step limit'
                  : warning || event.reason;
        resolve({ status, ...(why ? { reason: why } : {}), costUsd: Math.round(costUsd * 1e6) / 1e6, summary: summaryOf(last), tools, actions, notified, noOp, ...(waited ? { waited } : {}), ...(proposed ? { proposed } : {}) });
      }
    });
  });
}
