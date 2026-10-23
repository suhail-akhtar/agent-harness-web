// Running Unreal's programs where the session's commands run.
//
// On a Windows server folder (a local host, no OS sandbox there) Unreal is started directly:
// its own command-line parser wants a value with spaces quoted after the equals sign
// (-ExecutePythonScript="C:/a b/x.py"), and both Node's and Git Bash's argument quoting put
// the quotes around the whole argument instead, which Unreal reads as a value cut at the first
// space. Elsewhere (Linux and macOS, where Unreal rebuilds its command line from argv itself)
// it runs through host.exec like every other command. Long-lived processes (the bridge editor,
// a step-mode game) are started the same way and kept until stopped.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { scrubbedEnv } from '../../../src/runtime/host.ts';
import { runIn, stripAnsi } from '../../games3d/lib-engines.mjs';

/** One argument as Unreal's Windows command line wants it: -Key="value with spaces", or a quoted word. */
export function ueArg(a) {
  const s = String(a);
  if (!/[\s"]/.test(s)) return s;
  const m = /^(-[^=\s"]+=)([\s\S]*)$/.exec(s);
  const esc = (v) => v.replace(/"/g, '\\"');
  return m ? `${m[1]}"${esc(m[2])}"` : `"${esc(s)}"`;
}

/** The whole command line after the program: what Unreal's FCommandLine sees. */
export const ueCommandLine = (args) => args.map(ueArg).join(' ');

/** Whether Unreal can be started directly here (this machine's folder, no OS sandbox to go through). */
export const direct = (host) => host.kind === 'local' && !host.osSandbox && host.platform === process.platform;

const MAX_OUTPUT = 8 * 1024 * 1024;

/** Kills a process and its children (shader compilers, the cook's workers): only the tree it started. */
export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** Starts a program directly (see above): the child, its output lines through onLine. */
export function startDirect(exe, args, { cwd, onLine, env, raw = false } = {}) {
  const win = process.platform === 'win32';
  const child = win
    ? spawn(exe, [raw ? args.join(' ') : ueCommandLine(args)], { cwd, env: scrubbedEnv(env), windowsVerbatimArguments: true, argv0: `"${exe}"`, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(exe, args.map(String), { cwd, env: scrubbedEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let rest = '';
  const feed = (b) => {
    const text = rest + b.toString('utf8');
    const lines = text.split(/\r?\n/);
    rest = lines.pop();
    for (const l of lines) onLine?.(l);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('close', () => { if (rest) onLine?.(rest); rest = ''; });
  return child;
}

/**
 * Runs a program to the end: { code, output, timedOut, took }. onLine gets each line as it
 * comes (progress); logFile (an absolute path) gets the whole output. The output kept in
 * memory is the last 8 MB.
 */
export async function runUE(host, exe, args, { timeoutMs = 600_000, signal, onLine, logFile, cwd, raw = false, exitGraceMs = 0 } = {}) {
  const t0 = Date.now();
  if (!direct(host)) {
    const r = await runIn(host, exe, args.map(String), { timeoutMs, signal });
    if (logFile) await fsp.writeFile(logFile, r.output).catch(() => {});
    for (const l of r.output.split(/\r?\n/)) onLine?.(l);
    return { code: r.code, output: r.output, timedOut: r.timedOut, took: (Date.now() - t0) / 1000 };
  }
  if (logFile) await fsp.mkdir(path.dirname(logFile), { recursive: true });
  const log = logFile ? fs.createWriteStream(logFile) : null;
  let out = '';
  let exiting = null;
  const child = startDirect(exe, args, {
    raw,
    cwd: cwd ?? host.root,
    onLine: (l) => {
      const line = stripAnsi(l);
      log?.write(`${line}\n`);
      out += `${line}\n`;
      if (out.length > MAX_OUTPUT) out = out.slice(-MAX_OUTPUT / 2);
      // A game that asked to exit is done; some builds then spend half a minute in shutdown.
      if (exitGraceMs && !exiting && /Engine exit requested/.test(line)) exiting = setTimeout(() => killTree(child), exitGraceMs);
      try { onLine?.(line); } catch { /* a progress callback never stops the run */ }
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
  const onAbort = () => killTree(child);
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { out += `${e.message}\n`; resolve(127); });
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  if (exiting) clearTimeout(exiting);
  signal?.removeEventListener('abort', onAbort);
  await new Promise((r) => (log ? log.end(r) : r()));
  return { code, output: out, timedOut, took: (Date.now() - t0) / 1000, aborted: !!signal?.aborted, exitRequested: !!exiting };
}

/**
 * A Windows batch file (RunUAT.bat) as a program and a raw command line for cmd.exe: Node will
 * not start a .bat without a shell, and cmd /s /c strips one pair of outer quotes.
 */
export function batchCommand(bat, args, comspec = process.env.ComSpec || 'cmd.exe') {
  return { exe: comspec, args: ['/d', '/s', '/c', `""${bat}" ${ueCommandLine(args)}"`], raw: true };
}

/** Seconds as people read them. */
export const secs = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`);
