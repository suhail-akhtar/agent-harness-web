// Windows Job Objects for commands (docs/swarm/SWARM.md, phase 7): each command the harness runs on Windows is put
// in a job of its own as it starts, every process it starts joins that job (whatever breaks the parent links
// taskkill follows: MSYS's exec, `timeout`, a nested shell), and a stop terminates the job, all of it at once. Node
// has no API for jobs, so one PowerShell helper holds them for the whole harness, compiled once; if it cannot start,
// commands run as before (the tree kill and the tag sweep still stop them).
import { type ChildProcessByStdio, spawn } from 'node:child_process';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class HarnessJob {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr j, uint c);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
$jobs = @{}
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    if ($p[0] -eq 'A') {
      $j = [HarnessJob]::CreateJobObject([IntPtr]::Zero, $null)
      $h = [HarnessJob]::OpenProcess(0x0101, $false, [int]$p[2])
      $ok = ($h -ne [IntPtr]::Zero) -and [HarnessJob]::AssignProcessToJobObject($j, $h)
      if ($h -ne [IntPtr]::Zero) { [void][HarnessJob]::CloseHandle($h) }
      $jobs[$p[1]] = $j
      [Console]::Out.WriteLine("$($p[1]) $ok")
    } elseif ($p[0] -eq 'K') {
      if ($jobs.ContainsKey($p[1])) { [void][HarnessJob]::TerminateJobObject($jobs[$p[1]], 1) }
      [Console]::Out.WriteLine("$($p[1]) killed")
    } elseif ($p[0] -eq 'C') {
      if ($jobs.ContainsKey($p[1])) { [void][HarnessJob]::CloseHandle($jobs[$p[1]]); $jobs.Remove($p[1]) }
    }
  } catch { [Console]::Out.WriteLine("$($p[1]) error") }
}
`;

let helper: { p: ChildProcessByStdio<import('node:stream').Writable, import('node:stream').Readable, null>; ready: Promise<boolean>; up: boolean; waiters: Map<string, (ok: boolean) => void> } | undefined;
let n = 0;

function start() {
  if (helper || process.platform !== 'win32' || process.env.HARNESS_WIN_JOBS === 'off') return helper;
  // The script as -EncodedCommand: stdin is the helper's own line of commands.
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = new Map<string, (ok: boolean) => void>();
  let buf = '';
  let ready!: (ok: boolean) => void;
  // Timers that hold the process only while an answer is awaited (the helper itself never does).
  // `up` outlives the wait: a helper that took longer than this to start on a busy machine still serves later commands.
  const h = { p, up: false, ready: new Promise<boolean>((r) => { const t = setTimeout(() => r(false), 45_000); ready = (ok) => { clearTimeout(t); r(ok); }; }), waiters };
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line === 'ready') { h.up = true; ready(true); continue; }
      const [id, what] = line.split(' ');
      const w = id ? waiters.get(id) : undefined;
      if (w) { waiters.delete(id!); w(what === 'True' || what === 'killed'); }
    }
  });
  const gone = () => { h.up = false; ready(false); for (const w of waiters.values()) w(false); waiters.clear(); if (helper === h) helper = undefined; };
  p.on('error', gone); p.on('exit', gone);
  p.stdin.on('error', () => {});
  p.unref(); (p.stdout as unknown as { unref?: () => void }).unref?.(); (p.stdin as unknown as { unref?: () => void }).unref?.();
  helper = h;
  return h;
}

/** A line to the helper and its answer (undefined after 5 s without one: it may still act on it); the timer holds the process while it waits. */
function send(h: NonNullable<typeof helper>, line: string, id: string): Promise<boolean | undefined> {
  return new Promise<boolean | undefined>((resolve) => {
    const t = setTimeout(() => { if (h.waiters.delete(id)) resolve(undefined); }, 5000);
    h.waiters.set(id, (ok) => { clearTimeout(t); resolve(ok); });
    h.p.stdin.write(`${line}\n`);
  });
}

const up = async (h: NonNullable<typeof helper>): Promise<boolean> => h.up || (await h.ready) || h.up;

const ask = async (cmd: string, id: string): Promise<boolean> => {
  const h = start();
  if (!h || !(await up(h))) return false;
  return (await send(h, `${cmd} ${id}`, id)) === true;
};

/** Starts the helper ahead of the first command (compiling it takes a moment). */
export function warmJobs(): void { start(); }

/** Puts a just-started process in a job of its own; the job's id, or undefined (no jobs here). */
export async function assignJob(pid: number): Promise<string | undefined> {
  const h = start();
  if (!h || !(await up(h))) return undefined;
  const id = `j${++n}`;
  const ok = await send(h, `A ${id} ${Math.floor(pid)}`, id);
  // No answer in time on a busy machine: the helper still has the line and assigns when it reaches it, so the job
  // keeps its id (a stop on a job that was never made does nothing).
  return ok === false ? undefined : id;
}

/** Terminates every process in the job. */
export async function killJob(id: string): Promise<boolean> { return ask('K', id); }

/** Lets the job go (the command ended). */
export function closeJob(id: string): void { const h = helper; if (h) h.p.stdin.write(`C ${id}\n`); }
