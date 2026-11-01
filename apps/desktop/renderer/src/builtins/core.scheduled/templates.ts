/**
 * Ready-made schedules the person starts from (the New schedule dialog and the empty Scheduled page),
 * and the shape of a prefilled dialog (a template, or what an agent proposes with core.scheduled:new).
 */

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
}

export interface Template { id: string; title: string; icon: string; blurb: string; draft: ScheduleDraft }

export const TEMPLATES: Template[] = [
  {
    id: 'briefing', title: 'Morning briefing', icon: 'sun', blurb: 'Weekdays at 08:30: what changed and what needs you',
    draft: { title: 'Morning briefing', when: { freq: 'weekdays', time: '08:30' }, asks: 'dontAsk', prompt: 'Look through this folder and tell me, briefly, what changed since yesterday and anything that needs my attention today. If nothing does, end with [nothing to report].' },
  },
  {
    id: 'tests', title: 'Watch the tests', icon: 'bug', blurb: 'Every hour: run them, tell me only when something fails',
    draft: { title: 'Watch the tests', when: { freq: 'hourly', minute: 0 }, asks: 'auto', prompt: 'Run this project\'s tests. If any fail, tell me which ones and the likely cause with notify_user. If they all pass, end with [nothing to report].' },
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
