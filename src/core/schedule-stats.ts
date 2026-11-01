import type { InboxFeedback, InboxItem } from './inbox.ts';
import type { ScheduleRun } from './schedule-runs.ts';

// How useful a schedule has been, from its runs and what the person did with what they brought: the
// measures proactive work is judged by (precision, not satisfaction): how often a run found something,
// how much of it the person opened, dismissed (and why) or left, and what it cost. When most of what a
// schedule brings is dismissed as not useful, or left unread, it says so and offers to make it quieter;
// it never changes the schedule on its own.

export interface ScheduleStats {
  /** Runs that ran (not skipped), of which: found something (not "nothing to report"), failed or stopped. */
  runs: number;
  found: number;
  failed: number;
  /** Runs skipped (a filter said no, a limit, a busy conversation). */
  skipped: number;
  /** Updates it brought to the inbox, and what the person did with them. */
  updates: number;
  opened: number;
  dismissed: number;
  /** Dismissed as not useful or wrong. */
  notUseful: number;
  /** Still unread after a day. */
  ignored: number;
  costUsd: number;
  /** A suggestion to make it quieter, with why (when what it brings is mostly not wanted). */
  quieter?: string;
}

const DAY = 86_400_000;

export function scheduleStats(runs: ScheduleRun[], items: InboxItem[], feedback: InboxFeedback[], now = Date.now()): ScheduleStats {
  const ran = runs.filter((r) => r.status !== 'skipped');
  const opened = new Set(feedback.filter((f) => f.action === 'open').map((f) => f.itemId));
  const dismissed = items.filter((i) => i.status === 'dismissed' && i.reason);
  const notUseful = dismissed.filter((i) => i.reason === 'not_useful' || i.reason === 'wrong').length;
  const ignored = items.filter((i) => i.status === 'new' && now - i.at > DAY).length;
  const s: ScheduleStats = {
    runs: ran.length,
    found: ran.filter((r) => r.status === 'completed' && !r.noOp).length,
    failed: ran.filter((r) => r.status === 'failed' || r.status === 'stopped' || r.status === 'interrupted').length,
    skipped: runs.length - ran.length,
    updates: items.length,
    opened: items.filter((i) => opened.has(i.id)).length,
    dismissed: dismissed.length,
    notUseful,
    ignored,
    costUsd: Math.round(runs.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 1e4) / 1e4,
  };
  // Enough to judge by (4 updates), and most of them not wanted.
  if (items.length >= 4) {
    const unwanted = notUseful + ignored;
    if (unwanted / items.length >= 0.6) s.quieter = `${unwanted} of its last ${items.length} updates were dismissed as not useful or left unread`;
  }
  return s;
}
