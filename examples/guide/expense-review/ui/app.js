// The Expense review page: built from the UI kit (HarnessPluginUI.ui), so it looks like the app and follows its theme.
// It reads through the plugin's own routes and refreshes when the server signals a change.
const { ui } = HarnessPluginUI;
const root = document.getElementById('root');

HarnessPluginUI.connect().then(async (harness) => {
  const view = ui.view(root, { data: null, error: null }, (s) => {
    if (s.error) return ui.page({ title: 'Expense review' }, ui.error(s.error, load));
    if (!s.data) return ui.page({ title: 'Expense review' }, ui.loading());
    const { expenses } = s.data;
    const pending = expenses.filter((e) => e.status === 'pending');
    return ui.page({
      title: 'Expense review',
      subtitle: 'Claims the agent audits against the policy. You approve the decisions.',
      actions: [ui.button('Review the claims', { kind: 'primary', onClick: () => harness.composer.prefill('Review the pending expense claims.') })],
    },
      ui.grid({ min: 160 }, ui.stat({ label: 'Pending', value: pending.length }), ui.stat({ label: 'Break the policy', value: pending.filter((e) => e.problem).length, tone: 'warning' })),
      ui.section(null, expenses.length ? ui.table({
        columns: [
          { key: 'who', label: 'Who', sort: true },
          { key: 'category', label: 'Category', sort: true },
          { key: 'amount', label: 'Amount', sort: true },
          { key: 'status', label: 'Status', sort: true },
          { key: 'problem', label: 'Policy', render: (r) => r.problem ?? '' },
        ],
        rows: expenses,
      }) : ui.empty({ title: 'No claims yet', detail: 'Give the agent a claim, for example: Ana spent 40 on a team lunch.' })),
    );
  });

  async function load() {
    try { view.set({ data: await harness.routes.call('expenses'), error: null }); }
    catch (e) { view.set({ error: e }); }
  }
  await load();
  // The server's api.signal('expenses'): refresh without polling.
  await harness.events.subscribe('plugins', (e) => { if (e && e.type === 'signal' && e.plugin === 'expense-review' && e.name === 'expenses') void load(); });
}).catch((e) => { root.textContent = 'This page runs inside the Harness app: ' + e.message; });
