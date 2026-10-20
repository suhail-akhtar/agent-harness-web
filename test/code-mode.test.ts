import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runScriptTool, scriptNetworkIsolated } from '../src/tools/code.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from '../src/tools/files.ts';
import { todoTool } from '../src/tools/exec.ts';
import { makeAgent, results } from './helpers.ts';

const tools = [runScriptTool, readTool, globTool, grepTool, writeTool, editTool, todoTool];

async function scripted(code: string, opts: { mode?: 'bypass' | 'default'; setup?: (root: string) => Promise<void>; answers?: boolean[] } = {}) {
  const h = await makeAgent([{ calls: [{ name: 'run_script', input: { code, timeout_seconds: 20 } }] }, { text: 'done' }], { mode: opts.mode ?? 'bypass', tools });
  await opts.setup?.(h.root);
  h.permissionAnswers.push(...(opts.answers ?? []));
  await h.agent.run(new AbortController().signal);
  return { h, r: results(h.persisted[1])[0]! };
}

test('a script calls tools and only its result enters the context', async () => {
  const { h, r } = await scripted(`
    const files = (await tools.glob({ pattern: "**/*.txt" })).split("\\n").filter(Boolean);
    let todo = 0;
    for (const f of files) if ((await tools.read({ path: f })).includes("TODO")) todo++;
    console.log("checked", files.length);
    return { todo };`, {
    setup: async (root) => { for (let i = 0; i < 12; i++) await fs.writeFile(path.join(root, `f${i}.txt`), i % 3 === 0 ? 'x TODO y\n'.repeat(200) : 'clean\n'.repeat(200)); },
  });
  assert.equal(r.is_error, undefined, r.content);
  assert.match(r.content, /^checked 12\n\{\n "todo": 4\n\}\n\[13 tool call\(s\) inside the script\]$/);
  assert.ok(r.content.length < 200, 'twelve files were read; none of their text came back');
  // The calls inside are visible in the UI like any other.
  assert.equal(h.events.filter((e) => e.kind === 'tool_call' && e.name === 'read').length, 12);
});

test('inside a script there is no require, files, processes or network; escaping the context hits the process sandbox', async () => {
  const { r } = await scripted(`
    const out = { require: typeof require, process: typeof process, fetch: typeof fetch };
    try { eval("1") } catch (e) { out.eval = "blocked" }
    // The classic escape: a function from outside the context gives the outer realm.
    const P = tools.read.constructor.constructor("return process")();
    try { P.binding("fs"); out.binding = "allowed" } catch (e) { out.binding = "blocked" }
    try { const m = P.getBuiltinModule("fs"); m.readFileSync("/etc/hostname"); out.fs = "allowed" } catch (e) { out.fs = e.code || e.message }
    try { P.getBuiltinModule("child_process").execSync("id"); out.spawn = "allowed" } catch (e) { out.spawn = e.code || e.message }
    try { await P.getBuiltinModule("http").get ? await new Promise((res) => { const q = P.getBuiltinModule("http").get("http://1.1.1.1", () => res("connected")); q.on("error", (e) => res(e.code)); q.setTimeout(3000, () => { q.destroy(); res("timeout") }) }).then((v) => out.net = v) : 0 } catch (e) { out.net = e.code }
    return out;`);
  const o = JSON.parse(r.content.split('\n[')[0]!);
  assert.deepEqual([o.require, o.process, o.fetch, o.eval], ['undefined', 'undefined', 'undefined', 'blocked']);
  assert.equal(o.fs, 'ERR_ACCESS_DENIED');
  assert.equal(o.spawn, 'ERR_ACCESS_DENIED');
  if (scriptNetworkIsolated()) assert.match(o.net, /ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|timeout/);
});

test('a script\'s tool calls get the same permission checks; interactive tools and runaway scripts are refused', async () => {
  // Default mode: a write from inside a script is asked about, and a "no" throws in the script.
  const denied = await scripted(`try { await tools.write({ path: "x.txt", content: "hi" }); return "wrote" } catch (e) { return "refused: " + e.message }`, { mode: 'default', answers: [false] });
  assert.match(denied.r.content, /^refused: The user denied this call/);
  await assert.rejects(fs.stat(path.join(denied.h.root, 'x.txt')));
  const inter = await scripted(`try { await tools.call("todo_write", { todos: [] }) } catch (e) { return e.message }`);
  assert.match(inter.r.content, /todo_write cannot be called from a script/);
  const slow = await makeAgent([{ calls: [{ name: 'run_script', input: { code: 'while (true) {}', timeout_seconds: 1 } }] }, { text: 'done' }], { tools });
  await slow.agent.run(new AbortController().signal);
  assert.match(results(slow.persisted[1])[0]!.content, /The script failed after 0 tool call\(s\)/);
  const bad = await scripted('return undefinedThing.x');
  assert.equal(bad.r.is_error, true);
  assert.match(bad.r.content, /ReferenceError: undefinedThing is not defined/);
});
