import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runScriptTool, scriptNetworkIsolated } from '../src/tools/code.ts';
import { editTool, globTool, grepTool, readTool, writeTool } from '../src/tools/files.ts';
import { todoTool } from '../src/tools/exec.ts';
import { makeAgent, results, tempDir } from './helpers.ts';

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

test('inside a script there is no require, files, processes or network, and no way out of the context', async () => {
  const { r } = await scripted(`
    const out = { require: typeof require, process: typeof process, fetch: typeof fetch, escapes: [] };
    try { eval("1") } catch (e) { out.eval = "blocked" }
    // The classic escape: any function or object from outside the context gives the outer realm.
    let err; try { await tools.read({ path: "missing-file" }) } catch (e) { err = e }
    const result = await tools.glob({ pattern: "*" });
    const candidates = {
      tool: () => tools.read, call: () => tools.call, log: () => console.log, sleep: () => sleep,
      console: () => console, tools: () => tools, error: () => err, sleeping: () => sleep(1),
      pending: () => tools.glob({ pattern: "*" }), result: () => result,
    };
    for (const [k, get] of Object.entries(candidates)) {
      for (const via of [(x) => x.constructor.constructor, (x) => x.constructor, (x) => Object.getPrototypeOf(x).constructor.constructor]) {
        try { const F = via(get()); const P = F("return process")(); if (P) out.escapes.push(k) } catch {}
      }
    }
    try { Error.prepareStackTrace = (e, cs) => cs.map((c) => c.getFunction && c.getFunction()).filter(Boolean); const fns = new Error().stack; for (const f of fns) try { if (f.constructor("return process")()) out.escapes.push("stack") } catch {} } catch {}
    return out;`);
  assert.equal(r.is_error, undefined, r.content);
  const o = JSON.parse(r.content.split('\n[')[0]!);
  assert.deepEqual([o.require, o.process, o.fetch, o.eval], ['undefined', 'undefined', 'undefined', 'blocked']);
  assert.deepEqual(o.escapes, [], 'no route reached the host realm');
});

test('the script process itself: no files, processes, signals or network, even from its own realm', async () => {
  // What a script would meet if it ever reached the host realm: run the same
  // sandbox flags with a probe in place of the runner.
  const { spawnSync } = await import('node:child_process');
  const probe = path.join(await tempDir(), 'script-probe.mjs');
  await fs.writeFile(probe, `const o = {};
for (const [k, f] of Object.entries({
  fs: () => process.getBuiltinModule('fs').readFileSync('/etc/hostname'),
  spawn: () => process.getBuiltinModule('child_process').execSync('id'),
  signal: () => process.kill(Number(process.argv[2]), 0),
})) { try { f(); o[k] = 'allowed' } catch (e) { o[k] = e.code || e.message } }
console.log(JSON.stringify(o));`);
  const node = [process.execPath, '--permission', `--allow-fs-read=${probe}`, probe, String(process.pid)];
  const args = scriptNetworkIsolated() ? ['unshare', '-rnpf', '--kill-child', ...node] : node;
  const r = spawnSync(args[0]!, args.slice(1), { encoding: 'utf8' });
  const o = JSON.parse(r.stdout);
  assert.equal(o.fs, 'ERR_ACCESS_DENIED');
  assert.equal(o.spawn, 'ERR_ACCESS_DENIED');
  if (scriptNetworkIsolated()) assert.equal(o.signal, 'ESRCH', 'the server\'s process is not visible to signal');
});

test('a script\'s tool calls get the same permission checks; interactive tools and runaway scripts are refused', async () => {
  // Default mode: a write from inside a script is asked about, and a "no" throws in the script.
  // Without network isolation (anything but Linux) run_script itself is asked about first.
  const answers = scriptNetworkIsolated() ? [false] : [true, false];
  const denied = await scripted(`try { await tools.write({ path: "x.txt", content: "hi" }); return "wrote" } catch (e) { return "refused: " + e.message }`, { mode: 'default', answers });
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
