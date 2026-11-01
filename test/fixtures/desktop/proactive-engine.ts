// The harness server as the desktop starts it, with a scripted model, for the proactive e2e test
// (test/desktop-e2e-proactive.test.ts). Nothing is spent. A keyword in the person's (or the schedule's)
// prompt picks a script; each script is a list of steps (one model call each):
//   "notify"   -> notify_user ("The build is green."), then a short report
//   "quiet"    -> "All quiet." and [nothing to report]
//   "costly"   -> three expensive steps (a large usage each): a run with a spend limit stops
//   anything else -> a short reply
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { SpendLedger, UserStore } from '../../../src/server/users.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';
import type { Block, Message } from '../../../src/core/types.ts';

const DATA = path.resolve(process.env.HARNESS_DATA ?? '.harness-e2e');
const PORT = Number(process.env.HARNESS_PORT ?? 4399);
const TOKEN = process.env.HARNESS_TOKEN ?? 'e2e-token';
const ROOTS = (process.env.HARNESS_LOCAL_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const PLUGINS = (process.env.HARNESS_PLUGINS ?? '').split(path.delimiter).filter(Boolean);

type Call = { name: string; input: Record<string, unknown> };
type Step = { text?: string; calls?: Call[]; costly?: boolean };

const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
const stripped = (t: string) => t.replace(/<(system-reminder|environment|skills|instructions|memory)>[\s\S]*?<\/\1>/g, '').trim();

export const SCRIPTS: Record<string, Step[]> = {
  notify: [
    { calls: [{ name: 'notify_user', input: { message: 'The build is green.' } }] },
    { text: 'Checked the build and told you: it is green.' },
  ],
  quiet: [{ text: 'All quiet. [nothing to report]' }],
  costly: [
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { text: 'Finished the expensive work.', costly: true },
  ],
};

class ScriptedProvider implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const msgs = req.messages;
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]!; if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result') && stripped(textOf(m.content))) { at = i; break; } }
    const prompt = at >= 0 ? stripped(textOf(msgs[at]!.content)) : '';
    const key = Object.keys(SCRIPTS).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(prompt));
    const step = msgs.slice(at + 1).filter((m: Message) => m.role === 'assistant').length;
    const s = key ? SCRIPTS[key]![step] : undefined;
    const content: Block[] = [];
    if (!s) content.push({ type: 'text', text: key ? 'Done.' : 'Hello from the proactive engine.' });
    else {
      if (s.text) { req.onText?.(s.text); content.push({ type: 'text', text: s.text }); }
      for (const c of s.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input });
    }
    const calls = content.filter((b) => b.type === 'tool_use') as Array<{ id: string; name: string; input: unknown }>;
    const text = textOf(content);
    return {
      message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) } } } as never,
      stop: calls.length ? 'tool_use' : 'end',
      usage: s?.costly ? { input: 400_000, cacheRead: 0, cacheWrite: 0, output: 20_000, reasoning: 0 } : { input: 1200, cacheRead: 800, cacheWrite: 0, output: 40, reasoning: 0 },
    };
  }
}

const users = await new UserStore(DATA).load();
const spend = await new SpendLedger(DATA).load();
const harness = await createHarness({ dataDir: DATA, plugins: PLUGINS, search: null, spend, memory: 'off', log: (m) => console.log(m) });
harness.registry.setProviderInstance('deepseek', new ScriptedProvider());
const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0 });
server.listen(PORT, '127.0.0.1', () => console.log(`proactive engine listening on http://127.0.0.1:${PORT}`));
const stop = () => { server.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
