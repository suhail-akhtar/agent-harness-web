// The harness server as the desktop starts it, with scripted models (DeepSeek and Anthropic) for
// the agent-platform e2e test (test/desktop-e2e-agents.test.ts). Nothing is spent. What the person
// types picks a script; each script is a list of steps (one model call each):
//   "artifact"   -> creates an HTML artifact, updates it (v2), reports
//   "agents"     -> chapter, todos, a sub-agent, a linked session started now (user_asked) and one
//                   offered (a proposal card), a second chapter; reports wake it when they finish
//   "desktop"    -> desktop_describe, desktop_open (the Library), desktop_open (the Agents panel),
//                   desktop_notify, desktop_command (switch the theme: asked first), then a summary
//   "form"       -> ask_user with a JSON-Schema form, then thanks the person by the name they gave
//   "delegate"   -> a review sub-agent on claude-sonnet-5-5 (allowed by the delegation setting)
//   anything else -> a short reply
// Sub-agents (a <brief>), linked sessions ("CHILD:") and workflow agent nodes get one-step answers.
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { name: string; input: Record<string, unknown> };
type Step = { text?: string; calls?: Call[]; delay?: number };
type Script = Array<Step | ((results: string[]) => Step)>;

const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
// Only the person's words choose a script: the context blocks the harness adds (reminders, environment, the skills list) are removed.
const stripped = (t: string) => t.replace(/<(system-reminder|environment|skills|instructions|memory)>[\s\S]*?<\/\1>/g, '').trim();

export const HTML_V1 = '<!doctype html><html><body style="font-family:system-ui;padding:24px"><h1 id="title">Launch plan v1</h1><ol><li>Write the tests</li><li>Update the docs</li></ol></body></html>';

const SCRIPTS: Record<string, Script> = {
  artifact: [
    { text: 'I will make the plan as an artifact.', calls: [{ name: 'artifact', input: { action: 'create', title: 'Launch plan', kind: 'html', content: HTML_V1 } }] },
    (r) => ({ calls: [{ name: 'artifact', input: { action: 'update', id: /artifact (\S+) v1/.exec(r.at(-1) ?? '')?.[1] ?? 'missing', old_string: 'Launch plan v1', new_string: 'Launch plan v2' } }] }),
    { text: 'The **Launch plan** artifact is at version 2.' },
  ],
  agents: [
    { calls: [{ name: 'mark_chapter', input: { title: 'Exploration', summary: 'What is there' } }, { name: 'todo_write', input: { todos: [{ content: 'Survey the code', status: 'completed' }, { content: 'Write the tests', status: 'in_progress' }, { content: 'Update the docs', status: 'pending' }] } }] },
    { text: 'Surveying first.', calls: [{ name: 'agent', input: { description: 'Survey the code', prompt: 'List the modules.', type: 'explore' } }] },
    { calls: [{ name: 'mark_chapter', input: { title: 'Delegation', summary: 'Linked sessions' } }, { name: 'start_session', input: { title: 'Write the tests', prompt: 'CHILD: write the tests', context: 'fresh', initiation: 'user_asked', share_workspace: true } }, { name: 'start_session', input: { title: 'Update the docs', prompt: 'CHILD: update the docs', context: 'fresh', initiation: 'offer', share_workspace: true } }] },
    { text: 'The tests run in a linked session; I offered a second one for the docs.' },
  ],
  desktop: [
    { text: 'Let me see what the app has.', calls: [{ name: 'desktop_describe', input: {} }] },
    (r) => {
      let n = 0; try { n = (JSON.parse(r.at(-1) ?? '{}') as { commands?: unknown[] }).commands?.length ?? 0; } catch { n = -1; }
      return { text: `The app has ${n} agent-callable commands. Opening the Library.`, calls: [{ name: 'desktop_open', input: { target: 'view', id: 'core.artifacts:library' } }] };
    },
    { calls: [{ name: 'desktop_open', input: { target: 'panel', id: 'core.agents:agents' } }, { name: 'desktop_notify', input: { title: 'Library opened', body: 'Your artifacts are in the Library.' } }] },
    { calls: [{ name: 'desktop_command', input: { command: 'core.shell:set-theme', args: { theme: 'dark' } } }] },
    (r) => ({ text: `Done. The app answered: ${r.slice(-1)[0]?.slice(0, 80) ?? ''}` }),
  ],
  form: [
    { calls: [{ name: 'ask_user', input: { question: 'Who is the release for?', options: [], form: { type: 'object', properties: { name: { type: 'string', title: 'Name', minLength: 1 }, seats: { type: 'integer', title: 'Seats', minimum: 1, maximum: 50, default: 3 }, plan: { type: 'string', enum: ['team', 'enterprise'], default: 'team' } }, required: ['name'] } } }] },
    (r) => { let who = '?'; try { who = (JSON.parse(r.at(-1) ?? '{}') as { name?: string }).name ?? '?'; } catch { who = r.at(-1) ?? '?'; } return { text: `Thanks: the release is for **${who}**.` }; },
  ],
  delegate: [
    { calls: [{ name: 'agent', input: { description: 'Review the change', prompt: 'Review the change for bugs.', type: 'explore', model: 'claude-sonnet-5-5' } }] },
    (r) => ({ text: `The review on Claude says: ${(r.at(-1) ?? '').split('\n')[0]}` }),
  ],
};

class ScriptedProvider implements Provider {
  private n = 0;
  private provider: string;
  constructor(provider: string) { this.provider = provider; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const msgs = req.messages;
    const first = textOf(msgs[0]?.content ?? []);
    const last = msgs[msgs.length - 1]!;
    const lastText = textOf(last.content);
    const content: Block[] = [];
    let stop: ProviderResponse['stop'] = 'end';
    const say = async (text: string) => { if (req.onText) for (let i = 0; i < text.length; i += 24) { req.onText(text.slice(i, i + 24)); await wait(5); } content.push({ type: 'text', text }); };
    const brief = /<brief>\n?([\s\S]*?)\n?<\/brief>/.exec(first)?.[1];
    if (brief !== undefined && last.role === 'user' && !last.content.some((b) => b.type === 'tool_result')) {
      // A sub-agent or a workflow agent node: one answer.
      await wait(400);
      await say(/review/i.test(brief) ? `No bugs found (reviewed on ${req.model.id}).` : /modules/i.test(brief) ? 'Three modules: core, server, ui.' : `Done: ${brief.slice(0, 60)}`);
    } else if (/CHILD:/.test(first) && !msgs.slice(1).some((m) => m.role === 'assistant')) {
      // A linked session's first turn.
      await wait(600);
      await say(/tests/.test(first) ? 'Tests written: 4 pass.' : 'Docs updated: README has a Usage section.');
    } else if (last.role === 'user' && !last.content.some((b) => b.type === 'tool_result') && !stripped(lastText) && /Linked session|another session/i.test(lastText)) {
      // Woken by a linked session's report.
      await say('A linked session reported back; all good.');
    } else {
      // The person's prompt: the last user message with text of its own; the steps since are the assistant messages after it.
      let at = -1;
      for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]!; if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result') && stripped(textOf(m.content))) { at = i; break; } }
      const prompt = at >= 0 ? stripped(textOf(msgs[at]!.content)) : '';
      const key = Object.keys(SCRIPTS).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(prompt));
      const step = msgs.slice(at + 1).filter((m: Message) => m.role === 'assistant').length;
      const results = msgs.slice(at + 1).flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => (b as { content: string }).content));
      const s = key ? SCRIPTS[key]![step] : undefined;
      if (!s) await say(key ? 'Done.' : 'Hello! This is the scripted agents engine.');
      else {
        const st = typeof s === 'function' ? s(results) : s;
        if (st.delay) await wait(st.delay);
        if (st.text) await say(st.text);
        for (const c of st.calls ?? []) content.push({ type: 'tool_use', id: `call_${this.provider}_${++this.n}`, name: c.name, input: c.input });
        if (st.calls?.length) stop = 'tool_use';
      }
    }
    const text = content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    const raw = this.provider === 'anthropic'
      ? { provider: 'anthropic', model: req.model.id, payload: content.map((b) => (b.type === 'text' ? { type: 'text', text: (b as { text: string }).text } : { type: 'tool_use', id: (b as { id: string }).id, name: (b as { name: string }).name, input: (b as { input: unknown }).input })) }
      : { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: text || null, ...(content.some((b) => b.type === 'tool_use') ? { tool_calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: (b as { id: string }).id, type: 'function', function: { name: (b as { name: string }).name, arguments: JSON.stringify((b as { input: unknown }).input) } })) } : {}) } };
    return { message: { role: 'assistant', content, raw } as never, stop, usage: this.provider === 'anthropic' ? { input: 900, cacheRead: 0, cacheWrite: 300, output: 60, reasoning: 0 } : { input: 1200, cacheRead: 800, cacheWrite: 0, output: 40, reasoning: 0 } };
  }
}

const users = await new UserStore(DATA).load();
const spend = await new SpendLedger(DATA).load();
const harness = await createHarness({ dataDir: DATA, plugins: PLUGINS, search: null, spend, memory: 'off', log: (m) => console.log(m) });
harness.registry.setProviderInstance('deepseek', new ScriptedProvider('deepseek'));
harness.registry.setProviderInstance('anthropic', new ScriptedProvider('anthropic'));
const { server } = createApp({ harness, token: TOKEN, loopback: true, localRoots: ROOTS, uiDir: path.join(DATA, 'ui'), appRoot: path.resolve(import.meta.dirname, '..', '..', '..'), users, spend, messageRateLimit: 0, rateLimit: 0 });
server.listen(PORT, '127.0.0.1', () => console.log(`scripted agents engine listening on http://127.0.0.1:${PORT}`));
const stop = () => { server.close(); void harness.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
