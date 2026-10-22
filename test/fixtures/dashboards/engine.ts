// The harness server for the dashboards e2e, with a scripted model (nothing is spent):
//   "chart please"      -> a reply with an ECharts chart (numbers typed by the model)
//   "On dashboard ...: make the by-region chart a bar ..." -> an agent that describes the dashboard,
//                          applies ops (bar, stacked, a YoY card) in one batch, verifies, and reports
//   anything else       -> a short reply
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { SpendLedger, UserStore } from '../../../src/server/users.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';
import type { Block } from '../../../src/core/types.ts';

const DATA = path.resolve(process.env.HARNESS_DATA ?? '.harness-e2e');
const PORT = Number(process.env.HARNESS_PORT ?? 4399);
const TOKEN = process.env.HARNESS_TOKEN ?? 'e2e-token';
const ROOTS = (process.env.HARNESS_LOCAL_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));

export const CHART = { title: { text: 'Revenue by region' }, xAxis: { type: 'category', data: ['EMEA', 'Americas', 'APAC'] }, yAxis: { type: 'value' }, series: [{ name: 'Revenue', type: 'bar', data: [120, 200, 150] }] };

class Scripted implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const text = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
    const firstUser = req.messages.find((m) => m.role === 'user');
    const asked = firstUser ? text(firstUser.content) : '';
    const results = req.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result')) as Array<{ content: unknown }>;
    const lastResult = results.length ? String(typeof results.at(-1)!.content === 'string' ? results.at(-1)!.content : JSON.stringify(results.at(-1)!.content)) : '';
    const content: Block[] = [];
    let stop: ProviderResponse['stop'] = 'end';
    const call = (name: string, input: Record<string, unknown>) => { content.push({ type: 'tool_use', id: `call_${++this.n}`, name, input }); stop = 'tool_use'; };
    const doc = /dashboard (dash-[a-z0-9]+)/.exec(asked)?.[1];
    if (/chart please/i.test(asked) && !results.length) {
      content.push({ type: 'text', text: `Here is revenue by region:\n\n\`\`\`chart\n${JSON.stringify(CHART)}\n\`\`\`` });
    } else if (doc && /make the by-region chart a bar/i.test(asked)) {
      if (results.length === 0) call('dashboard', { op: 'describe', doc });
      else if (results.length === 1) {
        // The column chart's id, read from the description (edit by id, never by guess).
        const v = /(v-[0-9a-f]+) column/.exec(lastResult)?.[1] ?? /(v-[0-9a-f]+) bar/.exec(lastResult)?.[1];
        call('dashboard', { ops: [
          { op: 'update_visual', doc, visual: v, patch: { type: 'bar', title: 'Revenue by region (bar)', options: { labels: true } } },
          { op: 'add_visual', doc, visual: { type: 'card', title: 'Orders', query: { measures: ['Orders'] } } },
        ] });
      } else if (results.length === 2) call('dashboard', { op: 'verify', doc });
      else content.push({ type: 'text', text: `Done. ${/verified: every visual ran/.test(lastResult) ? 'Every visual ran and its totals reconcile.' : 'Verify found problems.'} Changed: the region chart is now a bar with labels, and an Orders card was added. Undo is one click away.` });
    } else {
      content.push({ type: 'text', text: 'Hello from the dashboards engine.' });
    }
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('') || null } } } as never, stop, usage: { input: 1000, cacheRead: 800, cacheWrite: 0, output: 40, reasoning: 0 } };
  }
}

if (import.meta.main) {
  const users = await new UserStore(DATA).load();
  const spend = await new SpendLedger(DATA).load();
  const harness = await createHarness({ dataDir: DATA, search: null, spend, memory: 'off', log: (m) => console.log(m) });
  harness.registry.setProviderInstance('deepseek', new Scripted());
  const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0 });
  server.listen(PORT, '127.0.0.1', () => console.log(`dashboards engine listening on http://127.0.0.1:${PORT}`));
  const stop = () => { server.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
