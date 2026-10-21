import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../runtime/host.ts';

// Parallel sessions on one repository, each in its own git worktree on its own
// branch (harness/<slug>-<id>), as the Claude Code desktop app does: two agents
// never edit the same checkout. The worktree lives in the harness's data folder;
// its git data stays in the repository's .git.
//
// A sandboxed session may write only what committing on its own branch needs:
// the object store, refs/heads/harness/ and their logs, and the worktree's own
// folder. hooks/ and config stay read-only: a hook written from the sandbox would
// run on the host the next time someone used git there.

export interface Worktree { repo: string; dir: string; branch: string; name: string; commonDir: string; base: string }

export class WorktreeError extends Error {}

/** Git here never runs the repository's hooks (it is the server's own git, acting for the harness). */
const NO_HOOKS = ['-c', `core.hooksPath=${path.join(os.tmpdir(), 'harness-no-hooks')}`];

async function git(cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const r = await run('git', [...NO_HOOKS, ...args], { cwd, timeoutMs });
  if (r.code !== 0) throw new WorktreeError(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'session';

/** A new worktree of `repo` at its current HEAD, on a new branch. */
export async function createWorktree(repo: string, dir: string, title: string): Promise<Worktree> {
  const top = await git(repo, ['rev-parse', '--show-toplevel']).catch(() => { throw new WorktreeError(`${repo} is not a git repository, so it cannot get a worktree.`); });
  const commonDir = path.resolve(top, await git(top, ['rev-parse', '--git-common-dir']));
  const base = await git(top, ['rev-parse', 'HEAD']).catch(() => { throw new WorktreeError(`${repo} has no commits yet; commit once before starting a worktree session.`); });
  const branch = `harness/${slug(title)}-${crypto.randomBytes(3).toString('hex')}`;
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await git(top, ['worktree', 'add', '-b', branch, dir, base]);
  // The worktree's own folder under .git/worktrees is named after the directory (made unique by git).
  const gitFile = (await fs.readFile(path.join(dir, '.git'), 'utf8')).trim();
  const name = path.basename(gitFile.replace(/^gitdir:\s*/, ''));
  // Folders a sandbox will bind writable must exist before it starts.
  await fs.mkdir(path.join(commonDir, 'refs', 'heads', 'harness'), { recursive: true });
  await fs.mkdir(path.join(commonDir, 'logs', 'refs', 'heads', 'harness'), { recursive: true });
  return { repo: top, dir, branch, name, commonDir, base };
}

/**
 * Removes the worktree. Its branch stays when it has commits (the work is the
 * user's to merge); a branch with nothing on it is deleted.
 */
export async function removeWorktree(w: Worktree): Promise<{ kept: boolean; commits: number }> {
  const commits = Number(await git(w.repo, ['rev-list', '--count', `${w.base}..${w.branch}`]).catch(() => '0')) || 0;
  await git(w.repo, ['worktree', 'remove', '--force', w.dir]).catch(async () => { await fs.rm(w.dir, { recursive: true, force: true }); await git(w.repo, ['worktree', 'prune']).catch(() => {}); });
  if (!commits) await git(w.repo, ['branch', '-D', w.branch]).catch(() => {});
  return { kept: commits > 0, commits };
}

/** What a sandboxed command in this worktree may write besides the worktree itself. */
export function worktreeWritable(w: Pick<Worktree, 'commonDir' | 'name'>): string[] {
  return [
    path.join(w.commonDir, 'objects'),
    path.join(w.commonDir, 'refs', 'heads', 'harness'),
    path.join(w.commonDir, 'logs', 'refs', 'heads', 'harness'),
    path.join(w.commonDir, 'worktrees', w.name),
  ];
}
