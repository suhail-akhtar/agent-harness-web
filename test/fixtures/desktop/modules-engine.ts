// The harness server as the desktop starts it, for the modules journey (test/desktop-modules-e2e.test.ts):
// the real server with the sdlc, quality-gates, research and aiops plugins (aiops on fixture
// monitoring) and a scripted model that drives the app the way a model reading the plugins' guides
// would: nothing is spent.
//
//   "what can the Operations plugin do ..."  loads the aiops guide (skill aiops-guide), opens the
//                                            plugin's home (desktop_open on the plugin's name), runs
//                                            the agent-callable ops check (desktop_command), opens
//                                            its incidents page, then answers from the guide
//   "build me a dashboard ..."               loads core.dashboards-guide (answered by the app through
//                                            desktop_describe), opens the Dashboards home
//   "which plugin guides do you see"         reads its own system prompt's plugin index back
import fs from 'node:fs';
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { SpendLedger, UserStore } from '../../../src/server/users.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';
import type { Block, Message } from '../../../src/core/types.ts';
import { startOpsFixture } from './ops-fixture.ts';

const DATA = path.resolve(process.env.HARNESS_DATA ?? '.harness-e2e');
const PORT = Number(process.env.HARNESS_PORT ?? 4399);
const TOKEN = process.env.HARNESS_TOKEN ?? 'e2e-token';
const ROOTS = (process.env.HARNESS_LOCAL_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const PLUGINS = (process.env.HARNESS_PLUGINS ?? '').split(path.delimiter).filter(Boolean);

const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
const resultText = (m: Message | undefined) => (m?.content ?? []).map((b) => (b.type === 'tool_result' ? String((b as { content?: unknown }).content ?? '') : '')).join('\n');
type Call = { name: string; input: Record<string, unknown> };

class ModulesProvider implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const msgs = req.messages;
    const lastAsk = msgs.findLastIndex((m) => m.role === 'user' && textOf(m.content).trim() && !m.content.some((b) => b.type === 'tool_result'));
    const asked = lastAsk >= 0 ? textOf(msgs[lastAsk]!.content) : '';
    const since = msgs.slice(lastAsk + 1);
    const step = since.filter((m) => m.role === 'assistant').length;
    const results = since.map(resultText).join('\n');
    let text: string | undefined;
    let calls: Call[] = [];
    if (/what can the Operations plugin do/i.test(asked)) {
      const plan: Call[] = [
        { name: 'skill', input: { name: 'aiops-guide' } },
        { name: 'desktop_open', input: { target: 'view', id: 'aiops' } },
        { name: 'desktop_command', input: { command: 'aiops:run-ops-check' } },
        { name: 'desktop_open', input: { target: 'view', id: 'aiops:incidents' } },
      ];
      if (step < plan.length) calls = [plan[step]!];
      else {
        const guide = /<skill name="aiops-guide">[\s\S]*## What it is for/.test(results) ? 'yes' : 'no';
        const check = /Ops check: [^\n]*/.exec(results)?.[0] ?? 'no ops check';
        text = `Operations covers alerts, incidents with evidence, SLOs and safe runbooks (guide loaded: ${guide}). I opened its home, ran the ops check (${check}) and opened Incidents.`;
      }
    } else if (/build me a dashboard/i.test(asked)) {
      const plan: Call[] = [
        { name: 'skill', input: { name: 'core.dashboards-guide' } },
        { name: 'desktop_open', input: { target: 'view', id: 'core.dashboards' } },
      ];
      if (step < plan.length) calls = [plan[step]!];
      else text = `Dashboards guide loaded: ${/<skill name="core\.dashboards-guide">[\s\S]*# Dashboards \(core\.dashboards\)[\s\S]*core\.dashboards:open-doc/.test(results) ? 'yes' : 'no'}. The Dashboards home is open.`;
    } else if (/which plugin guides do you see/i.test(asked)) {
      const names = req.system.split('\n').map((l) => /^- (\S+): .*; guide: load skill \S+-guide$/.exec(l)?.[1]).filter(Boolean);
      text = `Guides: ${names.join(', ') || 'none'}.`;
    } else text = 'Hello! This is the scripted engine.';
    const content: Block[] = [];
    if (text) { req.onText?.(text); content.push({ type: 'text', text }); }
    for (const c of calls) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input });
    await new Promise((r) => setTimeout(r, 40));
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: text ?? null } } } as never, stop: calls.length ? 'tool_use' : 'end', usage: { input: 1200, cacheRead: 800, cacheWrite: 0, output: 60, reasoning: 0 } };
  }
}

const ops = await startOpsFixture(DATA);
process.env.HARNESS_OPS_INVENTORY ??= ops.inventory;
const users = await new UserStore(DATA).load();
const spend = await new SpendLedger(DATA).load();
const harness = await createHarness({ dataDir: DATA, plugins: PLUGINS, search: null, spend, memory: 'off', log: (m) => console.log(m) });
harness.registry.setProviderInstance('deepseek', new ModulesProvider());
const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0, routeRateLimit: 0 });
server.listen(PORT, '127.0.0.1', () => {
  if (process.env.HARNESS_E2E_ORIGIN_FILE) fs.writeFileSync(process.env.HARNESS_E2E_ORIGIN_FILE, `http://127.0.0.1:${PORT}`);
  console.log(`modules engine listening on http://127.0.0.1:${PORT} (plugins: ${harness.registry.plugins.map((p) => p.name).join(', ') || 'none'})`);
});
const stop = () => { server.close(); ops.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
