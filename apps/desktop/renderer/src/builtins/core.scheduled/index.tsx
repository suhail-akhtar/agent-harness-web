/**
 * core.scheduled: work that runs later or when called. The Scheduled page (every schedule and trigger,
 * when it runs next, each run's record), shared with Settings > Schedules and Activity's recent runs.
 */

import type { BuiltinPlugin } from '../../state/data';
import { ScheduledPage } from './Scheduled';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreScheduled: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { ScheduledPage },
};
