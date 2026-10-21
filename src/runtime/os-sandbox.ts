import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Commands that run on a real machine (a server folder, or the companion on
// someone's computer) are contained by the operating system where it can:
//   Linux    bubblewrap: the whole filesystem read-only except the workspace and
//            /tmp, credential folders in the home directory hidden, no network
//            unless allowed, its own process tree;
//   macOS    Seatbelt (sandbox-exec): writes only to the workspace and temp
//            folders, credential folders unreadable, no network unless allowed;
//   anywhere Docker: the folder mounted into a sandbox container (the only choice
//            on Windows, which has no built-in sandbox for a command).
// The sandbox is the boundary, so permission prompts for its commands go away -
// as Claude Code's own sandbox does.

export type OsSandboxKind = 'bwrap' | 'seatbelt';
export type LocalSandbox = OsSandboxKind | 'docker' | 'off';

/** Folders in a home directory that hold credentials: never readable from a sandboxed command. */
export const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.config/gcloud', '.config/gh', '.password-store', '.local/share/keyrings'];
export const SECRET_FILES = ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.env'];

let detected: OsSandboxKind | null | undefined;
/** The OS sandbox this machine has, if any (checked once: it must actually run, not just exist). */
export function detectOsSandbox(platform: string = process.platform, probe: (cmd: string, args: string[]) => boolean = works): OsSandboxKind | null {
  if (platform === process.platform && detected !== undefined) return detected;
  let kind: OsSandboxKind | null = null;
  if (platform === 'linux' && probe('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', 'true'])) kind = 'bwrap';
  else if (platform === 'darwin' && probe('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'])) kind = 'seatbelt';
  if (platform === process.platform) detected = kind;
  return kind;
}

function works(cmd: string, args: string[]): boolean {
  try { return spawnSync(cmd, args, { timeout: 5000, stdio: 'ignore' }).status === 0; } catch { return false; }
}

/**
 * Which sandbox a local runtime uses. 'auto': the OS sandbox if there is one, else
 * Docker if it is usable, else none. An explicit choice that is not available is
 * an error the caller reports, never a silent fallback to running unsandboxed.
 */
export function chooseSandbox(want: LocalSandbox | 'auto' | undefined, have: { os: OsSandboxKind | null; docker: boolean }): { kind: LocalSandbox; why: string } {
  const w = want ?? 'off';
  if (w === 'off') return { kind: 'off', why: 'sandbox off' };
  if (w === 'auto') {
    if (have.os) return { kind: have.os, why: `${have.os} (the OS sandbox)` };
    if (have.docker) return { kind: 'docker', why: 'Docker (no OS sandbox here)' };
    return { kind: 'off', why: 'no OS sandbox and no Docker here: commands run unsandboxed and need approval' };
  }
  if (w === 'docker') {
    if (!have.docker) throw new Error('the Docker sandbox was asked for, but Docker (with the sandbox image) is not available');
    return { kind: 'docker', why: 'Docker' };
  }
  if (have.os !== w) throw new Error(`the ${w} sandbox was asked for, but this machine ${have.os ? `has ${have.os}` : 'has no OS sandbox'}`);
  return { kind: w, why: w };
}

export interface WrapOptions {
  root: string;
  network: 'none' | 'full';
  home?: string;
  shell?: string;
  /** For tests: which of the secret paths exist (only existing ones can be masked). */
  exists?: (p: string) => boolean;
  /** More folders commands may write (a worktree's git data in the repository's .git). */
  writable?: string[];
  /** Folders that must be visible read-only even under /tmp (a worktree's repository .git), bound before `writable`. */
  readable?: string[];
}

/** bubblewrap: the command line that runs `cmd` contained. */
export function bwrapArgs(cmd: string, o: WrapOptions): string[] {
  const home = o.home ?? os.homedir();
  // Only what exists can be masked: bubblewrap cannot create a mount point on the read-only root.
  const exists = o.exists ?? existsSync;
  const root = path.posix.resolve(o.root);
  const args = [
    '--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    ...(o.network === 'none' ? ['--unshare-net'] : []),
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  ];
  // Credentials in the home folder: an empty folder over each, /dev/null over each file.
  for (const d of SECRET_DIRS) { const p = path.posix.join(home, d); if (exists(p) && !root.startsWith(p)) args.push('--tmpfs', p); }
  for (const f of SECRET_FILES) { const p = path.posix.join(home, f); if (exists(p)) args.push('--ro-bind', '/dev/null', p); }
  // The workspace last, so it is writable even under a masked or read-only parent.
  for (const r of o.readable ?? []) { const p = path.posix.resolve(r); args.push('--ro-bind', p, p); }
  for (const w of o.writable ?? []) { const p = path.posix.resolve(w); args.push('--bind', p, p); }
  args.push('--bind', root, root, '--chdir', root, '--setenv', 'TMPDIR', '/tmp', '--', o.shell ?? 'bash', '-c', cmd);
  return args;
}

const sbString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Seatbelt: the profile for `sandbox-exec -p`. */
export function seatbeltProfile(o: WrapOptions): string {
  const home = o.home ?? os.homedir();
  const root = path.posix.resolve(o.root);
  // macOS keeps temp folders under /private (var/folders for per-user temp).
  const writable = [root, '/private/tmp', '/private/var/folders', '/dev', ...(o.writable ?? []).map((w) => path.posix.resolve(w))];
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${sbString(p)})`).join(' ')})`,
    `(deny file-read* file-write* ${[...SECRET_DIRS.map((d) => `(subpath ${sbString(path.posix.join(home, d))})`), ...SECRET_FILES.map((f) => `(literal ${sbString(path.posix.join(home, f))})`)].join(' ')})`,
  ];
  // The workspace itself stays readable even if it sits under one of those.
  lines.push(`(allow file-read* file-write* (subpath ${sbString(root)}))`);
  if (o.network === 'none') lines.push('(deny network*)', '(allow network* (local unix-socket))');
  return lines.join('\n');
}

/** The program and arguments that run `cmd` in the given OS sandbox. */
export function wrapCommand(kind: OsSandboxKind, cmd: string, o: WrapOptions): { file: string; args: string[] } {
  if (kind === 'bwrap') return { file: 'bwrap', args: bwrapArgs(cmd, o) };
  return { file: 'sandbox-exec', args: ['-p', seatbeltProfile(o), o.shell ?? 'bash', '-c', cmd] };
}
