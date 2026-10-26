// What every page of the desk shares: the connection, the status and priority badges, live refresh.
// Each page loads the SDK, this file, then its own script.
const { ui } = HarnessPluginUI;

const STATUS_TONE = { open: 'info', waiting: 'warning', closed: 'neutral' };
const PRIORITY_TONE = { urgent: 'danger', high: 'warning', normal: 'neutral', low: 'neutral' };
const statusBadge = (s) => ui.badge(s, STATUS_TONE[s] ?? 'neutral');
const priorityBadge = (p) => ui.badge(p, PRIORITY_TONE[p] ?? 'neutral');

/**
 * Connects, then calls start(harness). Pages refresh when the server signals a change (api.signal('desk')):
 * `onChange(fn)` registers what to run then.
 */
function deskPage(start) {
  const root = document.getElementById('root');
  HarnessPluginUI.connect().then(async (harness) => {
    const listeners = [];
    await harness.events.subscribe('plugins', (e) => {
      if (e && e.type === 'signal' && e.plugin === harness.plugin && e.name === 'desk') for (const f of listeners) f();
    });
    await start(harness, root, (fn) => listeners.push(fn));
  }).catch((e) => { root.textContent = 'This page runs inside the Harness app: ' + e.message; });
}

/** The form for a new ticket, in a dialog; resolves with the ticket made (or nothing). */
function newTicketDialog(harness) {
  return new Promise((resolve) => {
    const d = ui.dialog({
      title: 'New ticket',
      onClose: () => resolve(undefined),
      body: ui.form({
        fields: [
          { name: 'title', label: 'Title', required: true, placeholder: 'What is wrong, in a few words' },
          { name: 'body', label: 'Details', type: 'textarea' },
          { name: 'priority', label: 'Priority', type: 'select', options: ['normal', 'low', 'high', 'urgent'], value: 'normal' },
        ],
        submitLabel: 'Open ticket',
        onCancel: () => d.close(),
        onSubmit: async (v) => {
          try {
            const r = await harness.routes.call('tickets', { method: 'POST', body: v });
            void harness.notify.toast(`Opened ${r.ticket.id}`, { kind: 'success' });
            d.close();
            resolve(r.ticket);
          } catch (e) { void harness.notify.toast(e.message, { kind: 'error' }); }
        },
      }),
    });
  });
}
