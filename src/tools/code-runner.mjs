// The child process behind run_script. It runs one script in a fresh V8
// context whose only way to act is `tools.*`: every call goes back to the
// harness over stdout and through the agent's permissions and hooks. The
// process itself runs under Node's permission model (no file access, no child
// processes, no workers) and, on Linux, in a namespace with no network.
//
// Protocol (JSON lines): in  {code, tools, timeoutMs} then {type:'result', id, ok, content}
//                        out {type:'call', id, name, input} ... then {type:'done', ok, output, error}

import readline from 'node:readline';
import vm from 'node:vm';

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const pending = new Map();
let seq = 0;
let started = false;
const lines = [];
let size = 0;
const MAX_OUT = 200_000;

const log = (...args) => {
  const s = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 1) ?? String(a))).join(' ');
  if (size < MAX_OUT) { lines.push(s); size += s.length + 1; }
};

function start(job) {
  const call = (name, input = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    out({ type: 'call', id, name: String(name), input });
  });
  const tools = Object.create(null);
  for (const n of job.tools) tools[n] = (input) => call(n, input);
  tools.call = call;
  const sandbox = {
    tools: Object.freeze(tools),
    console: Object.freeze({ log, info: log, warn: log, error: log }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(Number(ms) || 0, 30_000))),
  };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  let result;
  try {
    result = vm.runInContext(`(async () => {\n${job.code}\n})()`, ctx, { timeout: job.timeoutMs, filename: 'script.js' });
  } catch (e) {
    out({ type: 'done', ok: false, output: lines.join('\n'), error: String(e?.stack ?? e).split('\n').slice(0, 4).join('\n') });
    return;
  }
  Promise.resolve(result).then(
    (v) => {
      if (v !== undefined) log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
      out({ type: 'done', ok: true, output: lines.join('\n') });
    },
    (e) => out({ type: 'done', ok: false, output: lines.join('\n'), error: String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 4).join('\n') }),
  );
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!started) { started = true; start(m); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.content); else p.reject(new Error(m.content));
});
