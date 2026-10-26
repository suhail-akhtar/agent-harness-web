import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, type Harness } from '../kernel/harness.ts';
import { createApp } from '../server/app.ts';
import { LocalHost } from '../runtime/host.ts';
import { skillsIn } from '../skills/skills.ts';
import { readManifest } from './loader.ts';
import { validateInput } from '../tools/index.ts';
import type { Block, Message, PermissionMode, Usage } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../providers/types.ts';
import type { FileStamp, ToolContext } from '../tools/types.ts';

// The test kit for plugins (@harness/plugin-sdk/testing): loads a plugin folder into a real harness, the
// way a server does, in a throwaway data folder and workspace, and calls what it adds: its tools (with a
// real tool context on a workspace), its routes (over HTTP, signed in or not, through the server's own
// checks), and a whole conversation, scripted (no model, no cost: the agent calls its tools as a model
// would) or with a real model. Use it from a plugin's own tests:
//
//   import { test } from 'node:test';
//   import assert from 'node:assert/strict';
//   import { loadPlugin } from '@harness/plugin-sdk/testing';
//
//   test('saves a link', async () => {
//     const kit = await loadPlugin(new URL('..', import.meta.url));
//     try {
//       const r = await kit.tool('reading_list_add', { url: 'https://example.com' });
//       assert.match(r.content, /Saved/);
//       assert.equal((await kit.route('GET', 'links')).body.links.length, 1);
//     } finally { await kit.close(); }
//   });
//
// and run them with `npm run plugin -- test <dir>`.

export interface ScriptedTurn {
  /** What the model says. */
  text?: string;
  /** The tools it calls (their results go back to it, and to the next turn). */
  calls?: Array<{ name: string; input?: Record<string, unknown> }>;
}

export interface ToolCallRecord { name: string; input: Record<string, unknown>; result: string; isError: boolean }

export interface ChatResult {
  /** What the model said, all turns joined. */
  text: string;
  /** Every tool call of the conversation, with its result. */
  calls: ToolCallRecord[];
  /** USD (0 for a scripted conversation). */
  cost: number;
  /** The conversation (for anything the fields above do not show). */
  history: Message[];
}

export interface RouteResult {
  status: number;
  /** The body: parsed when it is JSON, else the text. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  headers: Record<string, string>;
}

export interface PluginTestKit {
  /** The plugin's name, folder, data folder (api.dataDir) and the test workspace tools run in. */
  name: string;
  dir: string;
  dataDir: string;
  workspace: string;
  /** What the plugin added: names of its tools, skills, agents, workflows, gates and routes ("GET path"). */
  adds: { tools: string[]; skills: string[]; agents: string[]; workflows: string[]; gates: string[]; routes: string[] };
  /** Why it did not load (then nothing else works), or undefined. */
  error?: string;
  /** Calls one of its tools (or any tool the harness has) on the test workspace. */
  tool(name: string, input?: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  /**
   * Calls one of its routes over HTTP, as the server serves it: signed in as the operator by default
   * (an auth "user" route sees `user`), `as: 'anonymous'` for none, `token` for an auth "token" route.
   */
  route(method: 'GET' | 'POST', routePath: string, o?: { body?: unknown; query?: Record<string, string>; headers?: Record<string, string>; as?: 'operator' | 'anonymous'; token?: string }): Promise<RouteResult>;
  /** A conversation with the plugin loaded: scripted (`script`), or a real model (`model`, keys from the environment). */
  chat(prompt: string, o?: { script?: ScriptedTurn[]; model?: string; mode?: PermissionMode; timeoutMs?: number }): Promise<ChatResult>;
  /** Its api.signal() calls so far, and its api.log() lines. */
  signals: string[];
  logs: string[];
  /** The harness it runs in (for anything else). */
  harness: Harness;
  /** Stops it and removes the throwaway folders. */
  close(): Promise<void>;
}

/** A model that replays scripted turns (then says "done"). */
class ScriptedProvider implements Provider {
  private turns: ScriptedTurn[];
  private n = 0;
  constructor(turns: ScriptedTurn[]) { this.turns = [...turns]; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const t = this.turns.shift() ?? { text: 'done' };
    const content: Block[] = [];
    if (t.text) content.push({ type: 'text', text: t.text });
    for (const c of t.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input ?? {} });
    const usage: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    return { message: { role: 'assistant', content, raw: { provider: 'scripted', model: req.model.id, payload: null } }, stop: t.calls?.length ? 'tool_use' : 'end', usage };
  }
}

const TOKEN = 'plugin-testkit-operator-token';

export async function loadPlugin(dir: string | URL, o: { env?: Record<string, string>; workspaceFiles?: Record<string, string> } = {}): Promise<PluginTestKit> {
  const root = path.resolve(dir instanceof URL ? fileURLToPath(dir) : dir);
  const m = await readManifest(root);
  if (!m) throw new Error(`no harness-plugin.json in ${root}`);
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `hw-plugin-test-${m.name}-`)));
  const data = path.join(tmp, 'data');
  const workspace = path.join(tmp, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  for (const [rel, text] of Object.entries(o.workspaceFiles ?? {})) {
    const f = path.join(workspace, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  }
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(o.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v; }
  const logs: string[] = [];
  const signals: string[] = [];
  const harness = await createHarness({ dataDir: data, plugins: [root], backgroundWork: false, scheduler: false, search: null, log: (x) => logs.push(x) });
  const prevSignal = harness.bridge.signal;
  harness.bridge.signal = (plugin, name) => { if (plugin === m.name) signals.push(name); prevSignal?.(plugin, name); };
  const reg = harness.registry;
  const entry = harness.plugins.get(m.name);
  const mine = <T>(map: Map<string, T>) => [...map.entries()].filter(([, v]) => reg.ownerOf(v) === m.name).map(([k]) => k);
  const adds = {
    tools: mine(reg.tools), agents: mine(reg.agents), workflows: mine(reg.workflows),
    gates: [...reg.gates.values()].filter((g) => g.plugin === m.name).map((g) => g.name),
    routes: reg.routes.filter((r) => r.plugin === m.name).map((r) => `${r.method} ${r.path}`),
    skills: (await Promise.all(reg.skillDirs.filter((d) => d.source === m.name).map((d) => skillsIn(d.dir, d.source)))).flat().map((x) => x.name),
  };
  const error = !entry ? logs.filter((l) => l.includes(root) || l.includes(m.name)).join(' | ') || 'it did not load' : entry.error;

  let server: http.Server | undefined;
  let base = '';
  const serve = async () => {
    if (server) return;
    const { server: s } = createApp({ harness, token: TOKEN, loopback: true, localRoots: [workspace], uiDir: path.join(tmp, 'ui'), appRoot: tmp, routeRateLimit: 0 });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    server = s;
    base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  };

  const host = new LocalHost(workspace);
  const ctx = (): ToolContext => {
    let todos: never[] = [];
    return {
      host, signal: AbortSignal.timeout(10 * 60_000), readFiles: new Map<string, FileStamp>(), todos, setTodos: (t) => { todos = t as never[]; }, emit: () => {},
      // A tool that calls another (ctx.callTool): here straight to it, schema-checked (no permission prompts in a test).
      callTool: async (name, input) => { const r = await kit.tool(name, input); return { content: r.content, ...(r.isError ? { is_error: true } : {}) }; },
      toolNames: () => [...reg.tools.keys()],
    };
  };

  const kit: PluginTestKit = {
    name: m.name, dir: root, dataDir: path.join(data, 'plugin-data', m.name), workspace, adds, ...(error ? { error } : {}), signals, logs, harness,
    async tool(name, input = {}) {
      const t = reg.tools.get(name);
      if (!t) throw new Error(`No tool "${name}". ${m.name} adds: ${adds.tools.join(', ') || 'no tools'}${error ? ` (it did not load: ${error})` : ''}`);
      // As the agent does: input that does not fit the tool's schema never reaches it.
      const invalid = validateInput(t.spec, input);
      if (invalid) return { content: invalid, isError: true };
      try {
        const r = await t.run(input, ctx());
        return { content: r.content, isError: !!r.is_error };
      } catch (e) { return { content: (e as Error).message, isError: true }; }
    },
    async route(method, routePath, ro = {}) {
      await serve();
      const u = new URL(`/api/plugins/${encodeURIComponent(m.name)}/${routePath.replace(/^\//, '')}`, base);
      for (const [k, v] of Object.entries(ro.query ?? {})) u.searchParams.set(k, v);
      const headers: Record<string, string> = { ...(ro.headers ?? {}) };
      if ((ro.as ?? 'operator') === 'operator') { headers.authorization = `Bearer ${TOKEN}`; headers['x-harness'] = '1'; }
      if (ro.token) headers['x-harness-route-token'] = ro.token;
      let body: string | undefined;
      if (method === 'POST') { headers['content-type'] ??= 'application/json'; body = typeof ro.body === 'string' ? ro.body : JSON.stringify(ro.body ?? {}); }
      const res = await fetch(u, { method, headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body: parsed, text, headers: Object.fromEntries(res.headers.entries()) };
    },
    async chat(prompt, co = {}) {
      const model = co.model ?? 'deepseek-flash';
      const scripted = co.script ? new ScriptedProvider(co.script) : undefined;
      const providerId = reg.models.get(model)?.provider;
      if (scripted && providerId) reg.setProviderInstance(providerId, scripted);
      try {
        const s = await harness.sessions.create({ model, runtime: { kind: 'local', network: 'none', path: workspace }, mode: co.mode ?? 'bypass' });
        await s.send(prompt);
        const end = Date.now() + (co.timeoutMs ?? (scripted ? 60_000 : 10 * 60_000));
        await new Promise((r) => setTimeout(r, 20));
        while (harness.sessions.statusOf(s.meta.id) !== 'idle') {
          if (Date.now() > end) throw new Error(`the conversation did not finish within ${Math.round((co.timeoutMs ?? 0) / 1000) || (scripted ? 60 : 600)} s`);
          await new Promise((r) => setTimeout(r, 25));
        }
        const history = s.history;
        const results = new Map(history.flatMap((x) => x.content).filter((b) => b.type === 'tool_result').map((b) => [(b as { tool_use_id: string }).tool_use_id, b as { content: string; is_error?: boolean }]));
        const calls = history.filter((x) => x.role === 'assistant').flatMap((x) => x.content).filter((b) => b.type === 'tool_use').map((b) => {
          const u = b as { id: string; name: string; input: Record<string, unknown> };
          const r = results.get(u.id);
          return { name: u.name, input: u.input, result: r?.content ?? '', isError: !!r?.is_error };
        });
        const text = history.filter((x) => x.role === 'assistant').flatMap((x) => x.content).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
        return { text, calls, cost: scripted ? 0 : s.meta.cost ?? 0, history };
      } finally { if (scripted && providerId) reg.setProviderInstance(providerId, undefined); }
    },
    async close() {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      await harness.close();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };
  return kit;
}
