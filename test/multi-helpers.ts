import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HarnessEvent } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { Provider, ProviderRequest, ProviderResponse } from '../src/providers/types.ts';
import { createApp } from '../src/server/app.ts';
import { UserStore } from '../src/server/users.ts';
import type { Session } from '../src/core/session.ts';
import { tempDir } from './helpers.ts';

// Shared by the multi-agent tests: a scripted provider that serves several agents and
// sessions at once (each request is routed by the last [[key]] in its user text), a
// harness with an HTTP server and accounts, a git repository, and event helpers.

export type Step = { text?: string; calls?: { name: string; input?: Record<string, unknown> }[]; wait?: Promise<unknown> };
export type Script = (Step | ((req: ProviderRequest) => Step))[];

/** All user-role text of a request (tool results left out). */
export function userText(req: ProviderRequest): string {
  return req.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)).join('\n');
}

const keyOf = (req: ProviderRequest) => [...userText(req).matchAll(/\[\[([\w-]+)\]\]/g)].at(-1)?.[1] ?? 'main';

export class Scripted implements Provider {
  requests: ProviderRequest[] = [];
  byKey: Record<string, ProviderRequest[]> = {};
  sent: Record<string, string[]> = {};
  scripts: Record<string, Script>;
  readonly id: string;
  private n = 0;
  constructor(id: string, scripts: Record<string, Script> = {}) { this.id = id; this.scripts = scripts; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const key = keyOf(req);
    this.requests.push(req);
    (this.byKey[key] ??= []).push(req);
    (this.sent[key] ??= []).push(JSON.stringify(req.messages));
    const next = this.scripts[key]?.shift() ?? { text: `done (${key})` };
    const s = typeof next === 'function' ? next(req) : next;
    if (s.wait) {
      await Promise.race([s.wait, new Promise((r) => req.signal.addEventListener('abort', r, { once: true }))]);
      if (req.signal.aborted) throw new Error('aborted');
    }
    const content: ProviderResponse['message']['content'] = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    for (const c of s.calls ?? []) content.push({ type: 'tool_use', id: `${this.id}_call_${++this.n}`, name: c.name, input: c.input ?? {} });
    return {
      message: { role: 'assistant', content, raw: { provider: this.id, model: req.model.id, payload: { role: 'assistant', content: s.text ?? null } } },
      stop: s.calls?.length ? 'tool_use' : 'end',
      usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 },
    };
  }
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

export async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await delay(20);
  }
}

/** Every event of a session from now on (and the replay buffer). */
export function record(s: Session): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  s.subscribe(0, ({ event }) => out.push(event));
  return out;
}

export const turnsEnded = (ev: HarnessEvent[]) => ev.filter((e) => e.kind === 'turn_end' && !e.agent).length;

/** A git repository with one commit. */
export async function gitRepo(): Promise<string> {
  const dir = await tempDir('hw-repo-');
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(dir, 'README.md'), '# repo\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return dir;
}

export const OPERATOR = 'operator-token-multi';

/** A harness on a temp data folder with two scripted providers (deepseek and anthropic), accounts and an HTTP server. */
export async function setupServer(o: { plugins?: string[]; env?: Record<string, string> } = {}) {
  const saved = Object.fromEntries(Object.keys(o.env ?? {}).map((k) => [k, process.env[k]]));
  Object.assign(process.env, o.env ?? {});
  const data = await tempDir();
  const users = await new UserStore(data).load();
  const harness = await createHarness({ dataDir: data, search: null, memory: 'off', plugins: o.plugins ?? [] });
  const ds = new Scripted('deepseek');
  const an = new Scripted('anthropic');
  harness.registry.setProviderInstance('deepseek', ds);
  harness.registry.setProviderInstance('anthropic', an);
  const { server } = createApp({ harness, token: OPERATOR, loopback: true, localRoots: [await fs.realpath(os.tmpdir())], uiDir: path.join(data, 'ui'), appRoot: data, users });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (token: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-harness': '1' } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: json as any, headers: res.headers, text };
  };
  const member = async (name: string) => (await call(OPERATOR, 'POST', '/api/users', { name })).body as { id: string; token: string };
  /** An event stream as an app reads it (?client=desktop attaches it). */
  const stream = async (token: string, p: string) => {
    const ctl = new AbortController();
    const res = await fetch(base + p, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const got: any[] = [];
    let buf = '';
    const dec = new TextDecoder();
    (async () => {
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (data) got.push(JSON.parse(data));
          }
        }
      } catch { /* closed */ }
    })();
    await delay(50);
    return { got, close: () => ctl.abort() };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await harness.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  return { data, harness, users, ds, an, base, call, member, stream, close };
}
