// The child process behind run_script. It runs one script in a fresh V8
// context whose only way to act is `tools.*`: every call goes back to the
// harness over stdout and through the agent's permissions and hooks. The
// process itself runs under Node's permission model (no file access, no child
// processes, no workers) and, on Linux, in namespaces with no network and no
// view of other processes.
//
// No object from this (host) realm is ever reachable from the script: a host
// function's `.constructor` is the host's Function, which compiles code with
// `process` in scope. So `tools`, `console` and `sleep` are built INSIDE the
// context by a bootstrap that keeps the few host functions in a closure, calls
// them directly and passes only strings and numbers across.
//
// Protocol (JSON lines): in  {code, tools, timeoutMs} then {type:'result', id, ok, content}
//                        out {type:'call', id, name, input} ... then {type:'done', ok, output, error}

import readline from 'node:readline';
import vm from 'node:vm';

const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const pending = new Map();
let seq = 0;
let started = false;
let finished = false;
const lines = [];
let size = 0;
const MAX_OUT = 200_000;
const text = (v, max = 4000) => (typeof v === 'string' ? v : '').slice(0, max);

let dropped = 0;
let returned;
let lateNote;
/** Set when the script has returned while tool calls it never awaited are still out: it ends when they are back. */
let whenIdle;

function finish(ok, error) {
  if (finished) return;
  finished = true;
  // What was printed past the limit is counted, never dropped without a word; the return value is always kept.
  if (dropped) lines.push(`[${dropped} more line(s) not kept: the script printed over ${MAX_OUT} characters]`);
  if (returned !== undefined) lines.push(returned);
  if (lateNote) lines.push(lateNote);
  out({ type: 'done', ok, output: lines.join('\n'), ...(ok ? {} : { error }) });
}

// A tool call that failed with nobody awaiting it: said, instead of ending the process with a stack on stderr
// (or, after the script returned, not at all).
process.on('unhandledRejection', (e) => {
  let msg = 'a promise was rejected';
  try { msg = typeof e?.stack === 'string' ? e.stack : String(e?.message ?? e); } catch { /* a value from the script */ }
  finish(false, `a tool call failed and the script never awaited or caught it (a missing await?):\n${text(msg).split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 3).join('\n')}`);
});

// Host functions handed to the bootstrap. Each takes primitives only, never
// throws into the context, and never returns an object.
const bridge = {
  call(name, inputJson, resolve, reject) {
    try {
      let input = {};
      try { input = JSON.parse(text(inputJson, 5_000_000) || '{}'); } catch { /* bad input: an empty object */ }
      const id = ++seq;
      pending.set(id, { resolve, reject });
      out({ type: 'call', id, name: text(name, 200), input: input && typeof input === 'object' ? input : {} });
    } catch { /* nothing crosses back */ }
  },
  log(s) {
    try {
      const line = text(s, MAX_OUT);
      if (size < MAX_OUT) { lines.push(line); size += line.length + 1; } else dropped++;
    } catch { /* ignore */ }
  },
  ret(s) {
    try { returned = text(s, 20_000); } catch { /* ignore */ }
  },
  sleep(ms, resolve) {
    try { setTimeout(() => { try { resolve(); } catch { /* ignore */ } }, Math.min(Math.max(Number(typeof ms === 'number' ? ms : 0) || 0, 0), 30_000)); } catch { /* ignore */ }
  },
  done(ok, s) {
    try {
      // Returned with calls still out (never awaited): wait for them, so a failure among them is reported.
      if (ok === true && pending.size) { const late = pending.size; whenIdle = () => setImmediate(() => { lateNote = `[the script returned before ${late} of its tool call(s) had finished: await them]`; finish(true); }); return; }
      finish(ok === true, text(s) || 'the script threw an empty value');
    } catch { /* ignore */ }
  },
};

// Runs inside the context, before the script. It captures every intrinsic it
// uses, so a script that later replaces Promise, JSON or Array methods changes
// only its own behaviour.
const BOOTSTRAP = `(() => {
  'use strict';
  const { call: hCall, log: hLog, ret: hRet, sleep: hSleep, done: hDone } = globalThis.__bridge;
  delete globalThis.__bridge;
  const names = JSON.parse(globalThis.__names); delete globalThis.__names;
  const P = Promise, E = Error, S = String, stringify = JSON.stringify, apply = Reflect.apply;
  const then = Promise.prototype.then, join = Array.prototype.join, freeze = Object.freeze, define = Object.defineProperty;
  const fmt = (a) => { try { return typeof a === 'string' ? a : (stringify(a, null, 1) ?? S(a)); } catch { try { return S(a); } catch { return '[unprintable]'; } } };
  const errText = (e) => { try { const s = e && e.stack; return typeof s === 'string' ? s : S(e && e.message !== undefined ? e.message : e); } catch { return 'error'; } };
  const call = (name, input) => new P((res, rej) => {
    hCall(S(name), stringify(input === undefined ? {} : input), (c) => res(c), (m) => rej(new E(m)));
  });
  const tools = Object.create(null);
  for (let i = 0; i < names.length; i++) { const n = names[i]; tools[n] = (input) => call(n, input); }
  tools.call = call;
  const log = (...a) => { const parts = []; for (let i = 0; i < a.length; i++) parts[i] = fmt(a[i]); hLog(apply(join, parts, [' '])); };
  define(globalThis, 'tools', { value: freeze(tools) });
  define(globalThis, 'console', { value: freeze({ log, info: log, warn: log, error: log }) });
  define(globalThis, 'sleep', { value: (ms) => new P((r) => hSleep(+ms, () => r())) });
  define(globalThis, '__entry', { value: (fn) => {
    let p;
    try { p = typeof fn === 'function' ? fn() : fn; } catch (e) { hDone(false, errText(e)); return; }
    try { apply(then, p, [(v) => { if (v !== undefined) hRet(fmt(v)); hDone(true, ''); }, (e) => hDone(false, errText(e))]); } catch (e) { hDone(false, errText(e)); }
  } });
})()`;

function lockDown() {
  // Defence in depth, should anything ever reach this realm: no signals, no
  // native bindings, no native addons. The parent ends this process itself.
  const refuse = () => { throw new Error('not available in a script process'); };
  for (const k of ['kill', '_kill', 'binding', '_linkedBinding', 'dlopen', 'abort', 'chdir', 'setuid', 'setgid', 'setgroups', 'seteuid', 'setegid']) {
    try { Object.defineProperty(process, k, { value: refuse, writable: false, configurable: false }); } catch { /* ignore */ }
  }
}

function start(job) {
  const ctx = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  ctx.__bridge = bridge;
  ctx.__names = JSON.stringify(Array.isArray(job.tools) ? job.tools.filter((n) => typeof n === 'string') : []);
  try {
    vm.runInContext(BOOTSTRAP, ctx, { filename: 'bootstrap.js' });
    // Just before the parent's own limit: what the script printed, and what it was waiting on, go back with the failure.
    if (job.timeoutMs > 0) setTimeout(() => finish(false, `the script ran longer than ${job.timeoutMs / 1000}s${pending.size ? ` (still waiting on ${pending.size} tool call(s))` : ' (waiting on something that never finished)'}`), Math.max(0, job.timeoutMs - 500)).unref();
    // lineOffset: the wrapper's own first line is not counted, so "script.js:2" is line 2 of what the model wrote.
    vm.runInContext(`__entry(async () => {\n${text(job.code, 1_000_000)}\n})`, ctx, { timeout: job.timeoutMs, filename: 'script.js', lineOffset: -1 });
  } catch (e) {
    let msg = 'the script could not run';
    try { msg = typeof e?.stack === 'string' ? e.stack : String(e?.message); } catch { /* a value from the script */ }
    // Where it is and what it is ("SyntaxError: ..." is the fifth line), without the frames of this runner.
    finish(false, text(msg).split('\n').filter((l) => !/^\s+at /.test(l)).slice(0, 6).join('\n').trimEnd());
  }
}

lockDown();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (!started) { started = true; start(m); return; }
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  try { if (m.ok) p.resolve(text(m.content, 10_000_000)); else p.reject(text(m.content)); } catch { /* ignore */ }
  if (whenIdle && !pending.size) whenIdle();
});
