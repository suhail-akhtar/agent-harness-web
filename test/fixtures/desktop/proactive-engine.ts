// The harness server as the desktop starts it, with a scripted model, for the proactive e2e test
// (test/desktop-e2e-proactive.test.ts). Nothing is spent. A keyword in the person's (or the schedule's)
// prompt picks a script; each script is a list of steps (one model call each):
//   "notify"   -> notify_user ("The build is green."), then a short report
//   "quiet"    -> "All quiet." and [nothing to report]
//   "costly"   -> three expensive steps (a large usage each): a run with a spend limit stops
//   "deploy"   -> a command asked about (node -e ...), then "Deployed."
//   "offer"    -> offers work (start_session own_initiative: "Fix the flaky test"), then "Offered a fix."
//   "routine"  -> sets up a schedule for the person (schedule tool: weekdays at 9, a new conversation each time), then says so
//   "propose"  -> opens the New schedule dialog filled in (desktop_command core.scheduled:new), then says so
//   "stuck"    -> runs a command that fails the same way twice (config.json is missing), then says so
//   "away"     -> a step of work, then the model service fails (the turn ends on an error)
//   "makeagent"-> opens the agent builder filled in (desktop_command core.agents:new), then says so
//   "delegate" -> hands a review to the person's security-reviewer agent (agent tool), then reports what it said
//   "teamwork" -> (a team lead) hands two parts to test-writer and security-reviewer at once, then reports
//   "usemcp"   -> adds with the person's own MCP server "notes" (mcp__notes__add), has it change its tools
//                 (mcp__notes__mutate), then tries the changed echo (refused), then says so
// The agent builder's Generate (its system prompt) gets a drafted security reviewer as JSON; the MCP server
// builder's description (its system prompt) gets a unit converter (code tools, nothing reaches the network).
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
type Step = { text?: string; calls?: Call[]; costly?: boolean; fail?: string };
const FAILING = { name: 'bash', input: { command: `node -e "console.error('Error: config.json is missing'); process.exit(3)"` } };

const textOf = (b: Block[]) => b.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
const stripped = (t: string) => t.replace(/<(system-reminder|environment|skills|instructions|memory)>[\s\S]*?<\/\1>/g, '').trim();

export const SCRIPTS: Record<string, Step[]> = {
  notify: [
    { calls: [{ name: 'notify_user', input: { message: 'The build is green.' } }] },
    { text: 'Checked the build and told you: it is green.' },
  ],
  quiet: [{ text: 'All quiet. [nothing to report]' }],
  deploy: [
    { calls: [{ name: 'bash', input: { command: 'node -e "console.log(40 + 2)"' } }] },
    { text: 'Deployed: the command printed 42.' },
  ],
  routine: [
    { calls: [{ name: 'schedule', input: { action: 'create', prompt: 'Summarise what changed in this folder since yesterday.', cron: '0 9 * * 1-5', new_conversation: true } }] },
    { text: 'Done: every weekday at 09:00, in a new conversation each time.' },
  ],
  propose: [
    { calls: [{ name: 'desktop_command', input: { command: 'core.scheduled:new', args: { title: 'Nightly tests', prompt: 'Run the tests and tell me what fails.', cron: '0 2 * * *', asks: 'auto' } } }] },
    { text: 'I filled in a schedule for you to check.' },
  ],
  offer: [
    { calls: [{ name: 'start_session', input: { title: 'Fix the flaky test', prompt: 'Fix the flaky test in parser.test.ts.', context: 'fresh', initiation: 'own_initiative', share_workspace: true } }] },
    { text: 'Offered a fix for the flaky test.' },
  ],
  stuck: [
    { calls: [FAILING] },
    { calls: [FAILING] },
    { text: 'The app does not start: config.json is missing.' },
  ],
  away: [
    { calls: [{ name: 'glob', input: { pattern: '*' } }] },
    { fail: 'the model service is down' },
  ],
  delegate: [
    { calls: [{ name: 'agent', input: { description: 'security review', type: 'security-reviewer', prompt: 'Review the login change for security problems.' } }] },
    { text: 'The security reviewer looked at the login change.' },
  ],
  teamwork: [
    { calls: [{ name: 'agent', input: { description: 'tests', type: 'test-writer', prompt: 'Write the tests for the release.' } }, { name: 'agent', input: { description: 'security pass', type: 'security-reviewer', prompt: 'Look over the release for security problems.' } }] },
    { text: 'The crew finished: tests written, and the security review found nothing.' },
  ],
  usemcp: [
    { calls: [{ name: 'mcp__notes__add', input: { a: 20, b: 22 } }] },
    { calls: [{ name: 'mcp__notes__mutate', input: {} }] },
    { calls: [{ name: 'mcp__notes__echo', input: { text: 'after' } }] },
    { text: 'The notes server added 20 and 22, then changed its tools.' },
  ],
  makeagent: [
    { calls: [{ name: 'desktop_command', input: { command: 'core.agents:new', args: { name: 'test-writer', description: 'Writes unit tests for a change and runs them.', prompt: 'Role: a test writer.', tools: ['read', 'write', 'bash'], permissionMode: 'acceptEdits' } } }] },
    { text: 'I filled in an agent for you to check.' },
  ],
  costly: [
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { calls: [{ name: 'glob', input: { pattern: '*' } }], costly: true },
    { text: 'Finished the expensive work.', costly: true },
  ],
};

const DRAFT = { name: 'security-reviewer', description: 'Reviews code changes for security problems and returns each finding with a fix.', prompt: ['Role: a careful security reviewer.', 'Procedure: 1. Read the change. 2. Check auth, input handling and secrets.', 'Checks: re-read each finding against the code.', 'Never: change files.', 'Report: findings, each with a fix.'].join('\n'), tools: ['read', 'grep', 'glob', 'teleport'], effort: 'high', permissionMode: 'plan', maxTurns: 30 };

const SERVER_DRAFT = {
  name: 'unit-converter', title: 'Unit converter', description: 'Converts temperatures and lengths between units.',
  tools: [
    { name: 'convert_temperature', description: 'Convert a temperature between celsius and fahrenheit.', inputSchema: { type: 'object', properties: { value: { type: 'number', description: 'The temperature.' }, to: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'The unit to convert to.' } }, required: ['value', 'to'] }, annotations: { readOnlyHint: true, idempotentHint: true }, run: { kind: 'code', code: "const v = Number(args.value);\nreturn args.to === 'fahrenheit' ? `${v} C is ${(v * 9) / 5 + 32} F` : `${v} F is ${((v - 32) * 5) / 9} C`;" }, example: { value: 100, to: 'fahrenheit' } },
    { name: 'convert_length', description: 'Convert a length between metres and feet.', inputSchema: { type: 'object', properties: { value: { type: 'number' }, to: { type: 'string', enum: ['metres', 'feet'] } }, required: ['value', 'to'] }, annotations: { readOnlyHint: true }, run: { kind: 'code', code: "const v = Number(args.value);\nreturn args.to === 'feet' ? `${(v * 3.28084).toFixed(2)} ft` : `${(v / 3.28084).toFixed(2)} m`;" }, example: { value: 10, to: 'feet' } },
  ],
};

class ScriptedProvider implements Provider {
  private n = 0;
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.system.startsWith('You design MCP servers')) {
      return { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(SERVER_DRAFT) }], raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: JSON.stringify(SERVER_DRAFT) } } } as never, stop: 'end', usage: { input: 1200, cacheRead: 0, cacheWrite: 0, output: 400, reasoning: 0 } };
    }
    if (req.system.startsWith('You design specialist AI agents')) {
      return { message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(DRAFT) }], raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: JSON.stringify(DRAFT) } } } as never, stop: 'end', usage: { input: 900, cacheRead: 0, cacheWrite: 0, output: 120, reasoning: 0 } };
    }
    const msgs = req.messages;
    let at = -1;
    for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]!; if (m.role === 'user' && !m.content.some((b) => b.type === 'tool_result') && stripped(textOf(m.content))) { at = i; break; } }
    const prompt = at >= 0 ? stripped(textOf(msgs[at]!.content)) : '';
    const key = Object.keys(SCRIPTS).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(prompt));
    const step = msgs.slice(at + 1).filter((m: Message) => m.role === 'assistant').length;
    const s = key ? SCRIPTS[key]![step] : undefined;
    if (s?.fail) throw new Error(s.fail);
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
