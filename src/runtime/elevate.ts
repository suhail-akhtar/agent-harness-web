import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scrubbedEnv } from './host.ts';

// Running one command with administrator rights, on the person's own computer, only after they said yes in
// the app (the tool is asked every time) and again to the operating system:
//   Windows  a UAC prompt (Start-Process -Verb RunAs); the command is PowerShell.
//   Linux    sudo -n when it needs no password, else the desktop's polkit dialog (pkexec); the command is bash.
//   macOS    the system's administrator dialog (osascript ... with administrator privileges); bash.
// The password, where one is needed, is typed only into the operating system's own dialog: neither the app
// nor the agent ever sees it. The command's output comes back through files in a private temporary folder.
// The server's credentials are not passed to it (scrubbed environment).

export interface ElevatedResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The person said no to the operating system's prompt (or closed it). */
  declined?: boolean;
  /** It could not run elevated here, and why (no prompt is possible, no sudo, ...). */
  unavailable?: string;
  timedOut?: boolean;
  /** How it was elevated: "uac", "already-admin", "sudo", "pkexec", "osascript", "root". */
  how?: string;
}

const MAX = 200_000;

/** Text from a file PowerShell or bash wrote (PowerShell 5 writes UTF-16 with a BOM). */
async function readOut(file: string): Promise<string> {
  const b = await fs.readFile(file).catch(() => Buffer.alloc(0));
  const s = b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3).toString('utf8') : b.toString('utf8');
  return s.length > MAX ? `${s.slice(0, MAX)}\n[trimmed]` : s;
}

function run(cmd: string, args: string[], o: { timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? scrubbedEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (c) => { if (stdout.length < MAX) stdout += c; });
    child.stderr.on('data', (c) => { if (stderr.length < MAX) stderr += c; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, o.timeoutMs);
    const abort = () => child.kill();
    o.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); resolve({ code, stdout, stderr, timedOut }); });
  });
}

const exists = async (p: string) => fs.access(p).then(() => true, () => false);
async function which(name: string): Promise<string | undefined> {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) { const p = path.join(d, name); if (await exists(p)) return p; }
  return undefined;
}

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Windows: the command (command.ps1) and a wrapper (run.ps1) that runs it in cwd and writes its output
 * (out.txt, err.txt) and exit code (exit.txt) for the unelevated side to read. Exported for tests (which run
 * the wrapper without elevation).
 */
export async function writeWindowsScripts(command: string, cwd: string, dir: string): Promise<{ wrap: string; out: string; err: string; exit: string }> {
  const out = path.join(dir, 'out.txt'), err = path.join(dir, 'err.txt'), exit = path.join(dir, 'exit.txt');
  const body = path.join(dir, 'command.ps1'), wrap = path.join(dir, 'run.ps1');
  await fs.writeFile(body, `﻿${command}\n`, 'utf8');
  await fs.writeFile(wrap, `﻿$ErrorActionPreference = 'Continue'
$code = 0
try {
  Set-Location -LiteralPath ${psq(cwd)}
  & ${psq(body)} 2> ${psq(err)} | Out-File -LiteralPath ${psq(out)} -Encoding utf8
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { $code = $LASTEXITCODE } elseif (-not $?) { $code = 1 }
} catch { $_ | Out-String | Out-File -LiteralPath ${psq(err)} -Append -Encoding utf8; $code = 1 }
Set-Content -LiteralPath ${psq(exit)} -Value $code -Encoding ascii
`, 'utf8');
  return { wrap, out, err, exit };
}

export { readOut };

/** Runs `command` with administrator rights in `cwd`. Never throws for the command's own failure. */
export async function runElevated(command: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; platform?: NodeJS.Platform }): Promise<ElevatedResult> {
  const platform = o.platform ?? process.platform;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-elevated-'));
  await fs.chmod(dir, 0o700).catch(() => {});
  const out = path.join(dir, 'out.txt'), err = path.join(dir, 'err.txt'), exit = path.join(dir, 'exit.txt');
  try {
    if (platform === 'win32') {
      const { wrap } = await writeWindowsScripts(command, o.cwd, dir);
      const launch = `try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psq(`"${wrap}"`)}); exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1223 }`;
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { timeoutMs: o.timeoutMs, signal: o.signal });
      if (r.timedOut) return { code: null, stdout: await readOut(out), stderr: await readOut(err), timedOut: true, how: 'uac' };
      if (!(await exists(exit))) {
        // No exit file: the elevated process never ran (UAC declined, or no administrator account).
        if (r.code === 1223 && /cancel/i.test(r.stderr)) return { code: null, stdout: '', stderr: '', declined: true, how: 'uac' };
        return { code: null, stdout: '', stderr: '', unavailable: `Windows did not start it elevated: ${r.stderr.trim() || `exit ${r.code}`}`, how: 'uac' };
      }
      return { code: Number((await fs.readFile(exit, 'utf8')).trim()) || 0, stdout: await readOut(out), stderr: await readOut(err), how: 'uac' };
    }

    // Linux and macOS: bash, in cwd, its output to files.
    const script = path.join(dir, 'run.sh');
    await fs.writeFile(script, `#!/bin/bash\ncd ${shq(o.cwd)} || exit 1\n${command}\n`, { mode: 0o700 });
    const wrapped = `/bin/bash ${shq(script)} > ${shq(out)} 2> ${shq(err)}; echo $? > ${shq(exit)}`;
    const result = async (how: string, r: { code: number | null; timedOut: boolean; stderr: string }) => {
      if (r.timedOut) return { code: null, stdout: await readOut(out), stderr: await readOut(err), timedOut: true, how };
      if (!(await exists(exit))) return null;
      return { code: Number((await fs.readFile(exit, 'utf8')).trim()), stdout: await readOut(out), stderr: await readOut(err), how };
    };
    if (process.getuid?.() === 0) return (await result('root', await run('/bin/bash', ['-c', wrapped], { timeoutMs: o.timeoutMs, signal: o.signal })))!;
    if (platform === 'darwin') {
      const osa = `do shell script ${JSON.stringify(wrapped)} with administrator privileges`;
      const r = await run('/usr/bin/osascript', ['-e', osa], { timeoutMs: o.timeoutMs, signal: o.signal });
      const done = await result('osascript', r);
      if (done) return done;
      if (/-128|cancel/i.test(r.stderr)) return { code: null, stdout: '', stderr: '', declined: true, how: 'osascript' };
      return { code: null, stdout: '', stderr: '', unavailable: `macOS did not run it as an administrator: ${r.stderr.trim()}`, how: 'osascript' };
    }
    // Linux: no password needed (NOPASSWD, or the account's rules), else the desktop's own dialog.
    const sudo = await which('sudo');
    if (sudo && (await run(sudo, ['-n', 'true'], { timeoutMs: 10_000 })).code === 0) {
      const done = await result('sudo', await run(sudo, ['-n', '/bin/bash', '-c', wrapped], { timeoutMs: o.timeoutMs, signal: o.signal }));
      if (done) return done;
    }
    const pkexec = await which('pkexec');
    if (pkexec && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
      const r = await run(pkexec, ['/bin/bash', '-c', wrapped], { timeoutMs: o.timeoutMs, signal: o.signal, env: { ...scrubbedEnv(), DISPLAY: process.env.DISPLAY ?? '', WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '', XAUTHORITY: process.env.XAUTHORITY ?? '' } });
      const done = await result('pkexec', r);
      if (done) return done;
      // 126: the dialog was dismissed or not authorised; 127: authentication failed.
      if (r.code === 126 || r.code === 127) return { code: null, stdout: '', stderr: '', declined: true, how: 'pkexec' };
      return { code: null, stdout: '', stderr: '', unavailable: `pkexec did not run it: ${r.stderr.trim() || `exit ${r.code}`}`, how: 'pkexec' };
    }
    return {
      code: null, stdout: '', stderr: '',
      unavailable: sudo
        ? 'sudo needs a password here and there is no desktop password dialog (pkexec with a display) to ask for it; the app never types passwords. Run it yourself in a terminal, or let this account run it without a password (sudo visudo, a NOPASSWD rule for the exact command).'
        : 'Neither sudo nor pkexec is installed, so nothing can run as an administrator here.',
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
