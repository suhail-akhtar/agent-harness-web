// The harness server as the desktop starts it (same environment variables as src/server/main.ts),
// with a scripted model instead of a real one, so the desktop e2e test spends nothing:
//   "write a file"      -> asks to write hello.txt (a permission request), then reports it
//   "stream"            -> streams a long reply (prose, tables, code, maths) in small pieces
//   "escape"            -> an HTML artifact that probes its sandbox
//   "crash the engine"  -> the process exits (the app must show it and recover)
//   diagrams            -> diagram-script.ts (artifacts of each view, a ```diagram block, the canvas's ask)
//   anything else       -> a short reply
import path from 'node:path';
import { createHarness } from '../../../src/kernel/harness.ts';
import { createApp } from '../../../src/server/app.ts';
import { SpendLedger, UserStore } from '../../../src/server/users.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../../../src/providers/types.ts';
import type { Block } from '../../../src/core/types.ts';
import { ESCAPE_ARTIFACT, STREAM_TEXT } from './rich.ts';
import { diagramTurn } from './diagram-script.ts';

const DATA = path.resolve(process.env.HARNESS_DATA ?? '.harness-e2e');
const PORT = Number(process.env.HARNESS_PORT ?? 4399);
const TOKEN = process.env.HARNESS_TOKEN ?? 'e2e-token';
const ROOTS = (process.env.HARNESS_LOCAL_ROOTS ?? '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const PLUGINS = (process.env.HARNESS_PLUGINS ?? '').split(path.delimiter).filter(Boolean);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ScriptedProvider implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const last = req.messages[req.messages.length - 1]!;
    const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
    const afterTool = last.role === 'user' && last.content.some((b) => b.type === 'tool_result');
    const said = textOf(last.content);
    const content: Block[] = [];
    let stop: ProviderResponse['stop'] = 'end';
    const say = async (text: string, chunks = 1, delay = 0) => {
      if (req.onText) {
        const size = Math.ceil(text.length / chunks);
        for (let i = 0; i < text.length; i += size) { req.onText(text.slice(i, i + size)); if (delay) await wait(delay); }
      }
      content.push({ type: 'text', text });
    };
    const diagram = diagramTurn(req.messages);
    if (diagram) {
      if (diagram.text) await say(diagram.text);
      if (diagram.call) { content.push({ type: 'tool_use', id: `call_${++this.n}`, name: diagram.call.name, input: diagram.call.input }); stop = 'tool_use'; }
    } else if (afterTool) {
      const ok = !last.content.some((b) => b.type === 'tool_result' && (b as { is_error?: boolean }).is_error);
      await say(ok ? 'I wrote **hello.txt**:\n\n```text\nHello from the desktop test\n```' : 'The write was refused, so nothing changed.');
    } else if (/write a file/i.test(said)) {
      req.onReasoning?.('The person wants a file. I will write hello.txt in the workspace.');
      await wait(300);
      content.push({ type: 'reasoning', text: 'The person wants a file. I will write hello.txt in the workspace.' } as Block);
      await say('I will create the file.');
      content.push({ type: 'tool_use', id: `call_${++this.n}`, name: 'write', input: { path: 'hello.txt', content: 'Hello from the desktop test\n' } });
      stop = 'tool_use';
    } else if (/stream/i.test(said)) {
      await say(STREAM_TEXT, 200, 12);
    } else if (/escape/i.test(said)) {
      await say(`Here is a page:\n\n${ESCAPE_ARTIFACT}`);
    } else if (/crash the engine/i.test(said)) {
      setTimeout(() => process.exit(3), 300);
      await say('Stopping now.');
    } else {
      await say('Hello! This is the scripted engine.', 4, 20);
    }
    return { message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('') || null } } } as never, stop, usage: { input: 1200, cacheRead: 800, cacheWrite: 0, output: 40, reasoning: 0 } };
  }
}

const users = await new UserStore(DATA).load();
const spend = await new SpendLedger(DATA).load();
const harness = await createHarness({ dataDir: DATA, plugins: PLUGINS, search: null, spend, memory: 'off', log: (m) => console.log(m) });
harness.registry.setProviderInstance('deepseek', new ScriptedProvider());
const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0 });
server.listen(PORT, '127.0.0.1', () => console.log(`scripted engine listening on http://127.0.0.1:${PORT} (plugins: ${harness.registry.plugins.map((p) => p.name).join(', ') || 'none'})`));
const stop = () => { server.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
