/**
 * core.scheduled: work that runs later or when called. The Scheduled page (every schedule and trigger,
 * when it runs next, each run's record), shared with Settings > Schedules and Activity's recent runs.
 */

import type { BuiltinPlugin } from '../../state/data';
import { ScheduledPage, useScheduleDialog } from './Scheduled';
import type { Asks } from './templates';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreScheduled: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { ScheduledPage },
  handlers: {
    // Prefilled from the command's arguments (an agent's proposal): the person checks it and confirms.
    newSchedule: (args) => {
      const a = (args ?? {}) as { title?: unknown; prompt?: unknown; cron?: unknown; timeZone?: unknown; asks?: unknown; workflow?: unknown };
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const asks = ['dontAsk', 'auto', 'acceptEdits', 'default'].includes(String(a.asks)) ? a.asks as Asks : undefined;
      useScheduleDialog.getState().open({
        ...(str(a.title) ? { title: str(a.title) } : {}), ...(str(a.prompt) ? { prompt: str(a.prompt) } : {}), ...(str(a.cron) ? { cron: str(a.cron) } : {}),
        ...(str(a.timeZone) ? { timeZone: str(a.timeZone) } : {}), ...(asks ? { asks } : {}), ...(str(a.workflow) ? { workflow: { name: str(a.workflow)! } } : {}),
      });
    },
  },
};
