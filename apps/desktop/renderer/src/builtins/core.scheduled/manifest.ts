/** core.scheduled's manifest: plain data (tests read it as the app does). Its guide is GUIDE.md (skill core.scheduled-guide). */

export const meta = { name: 'core.scheduled', version: '0.1.0', description: 'Scheduled work: schedules and triggers, when each runs next, and what every run came to.' };

export const ui = {
  apiVersion: 1, displayName: 'Scheduled', icon: 'clock', trust: 'native', capabilities: [],
  guide: 'GUIDE.md',
  tools: ['schedule', 'notify_user'],
  contributes: {
    navItems: [{ id: 'scheduled', title: 'Scheduled', icon: 'clock', view: 'scheduled', order: 15 }],
    views: [
      { id: 'scheduled', title: 'Scheduled', icon: 'clock', description: 'Every schedule and trigger: when it runs next, its last result, each run (status, time, cost, summary, conversation); New, Edit, Run now, on/off, Delete.', kind: 'native', component: 'ScheduledPage' },
    ],
    commands: [
      { id: 'open', title: 'Show scheduled work', category: 'Scheduled', icon: 'clock', action: { type: 'open-view', view: 'scheduled' }, agent: { description: 'Open the Scheduled page: the person\'s schedules and triggers and what each run came to.' } },
    ],
  },
};
