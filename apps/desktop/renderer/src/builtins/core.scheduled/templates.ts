/**
 * Ready-made schedules the person starts from (the New schedule dialog and the empty Scheduled page),
 * and the shape of a prefilled dialog (a template, or what an agent proposes with core.scheduled:new).
 */

import type { WatchSpec } from '@harness/client';
import type { When } from '../../components/when.ts';

/** What a scheduled run does when it needs the person's approval: refuse, a checker decides (asking the rest), or ask. */
export type Asks = 'dontAsk' | 'auto' | 'acceptEdits' | 'default';

export interface ScheduleDraft {
  title?: string;
  prompt?: string;
  when?: Partial<When>;
  /** A cron, read into the picker (its simple shapes, else custom). */
  cron?: string;
  timeZone?: string;
  asks?: Asks;
  workflow?: { name: string; input?: Record<string, string> };
  maxCostUsd?: number;
  /** It runs when this changes instead of at a time. */
  watch?: WatchSpec;
}

export interface Template { id: string; title: string; icon: string; blurb: string; draft: ScheduleDraft }

export const TEMPLATES: Template[] = [
  {
    id: 'briefing', title: 'Morning briefing', icon: 'sun', blurb: 'Weekdays at 08:30: what changed and what needs you',
    draft: { title: 'Morning briefing', when: { freq: 'weekdays', time: '08:30' }, asks: 'dontAsk', prompt: 'Look through this folder and tell me, briefly, what changed since yesterday and anything that needs my attention today. If nothing does, end with [nothing to report].' },
  },
  {
    id: 'tests', title: 'Watch the tests', icon: 'bug', blurb: 'Every 30 minutes, no model unless a test fails',
    draft: { title: 'Watch the tests', watch: { kind: 'command', command: 'npm test', everyMinutes: 30, onlyWhen: 'a test fails' }, asks: 'auto', prompt: 'The test output changed and a test fails. Find which tests fail and the likely cause, tell me with notify_user, and suggest the fix.' },
  },
  {
    id: 'commits', title: 'Review new commits', icon: 'git-commit', blurb: 'When commits land: a review, only if something is serious',
    draft: { title: 'Review new commits', watch: { kind: 'git', everyMinutes: 15 }, asks: 'dontAsk', prompt: 'Review the new commits for bugs and risky changes. Tell me about anything serious with notify_user; otherwise end with [nothing to report].' },
  },
  {
    id: 'weekly', title: 'Weekly report', icon: 'file-text', blurb: 'Mondays at 09:00: last week\'s work in a page',
    draft: { title: 'Weekly report', when: { freq: 'weekly', days: [1], time: '09:00' }, asks: 'acceptEdits', prompt: 'Write a short report of last week\'s work in this folder (what changed, what is still open, what comes next) to reports/weekly-<date>.md, and give me its first lines.' },
  },
  {
    id: 'later', title: 'Check back later', icon: 'clock', blurb: 'Once, in 30 minutes: see whether something finished',
    draft: { title: 'Check back', when: { freq: 'once', onceMode: 'in', inAmount: 30, inUnit: 'minutes' }, asks: 'dontAsk', prompt: 'Check whether the long job I started has finished, and tell me how it went.' },
  },
];
