import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../runtime/host.ts';
import { writeFileAtomic } from '../util/shared-file.ts';

// Publishing the agent's work: commit, push a branch, open a pull request.
//
// The workspace is the agent's, so nothing in it is trusted. Running git with a
// token inside it would hand the token to whatever its .git/config says
// (hooks, fsmonitor, url.insteadOf, credential helpers, includes). So the
// commits are fetched OUT of the workspace into a fresh repository the harness
// owns, with no system or global config, and pushed from there. The token
// travels in an HTTP header on that one command; it is never written to disk,
// never in the workspace, never in the model's context.
//
// It pushes only to the repository the session was cloned from, or one on the
// operator's list, and never force-pushes or pushes to the default branch.
// Least privilege besides: only branches under a prefix (agent/), never a branch
// that already existed unless this session made it, and pull requests as drafts
// - each widened only by the operator.

export interface PublishConfig {
  /** GitHub token with contents:write and pull_requests:write on the target repositories. */
  token?: string;
  /** Repositories (https URLs, or owner/name) a session may publish to besides the one it was cloned from. */
  repos?: string[];
  /** Branches are pushed under this prefix (default HARNESS_PUBLISH_PREFIX, else "agent/"; "" for none). */
  branchPrefix?: string;
  /** May push to a branch that existed before this session pushed it (HARNESS_PUBLISH_UPDATE=1). */
  allowUpdate?: boolean;
  /** May open ready-for-review pull requests; otherwise every one is a draft (HARNESS_PUBLISH_READY=1). */
  allowReady?: boolean;
  /**
   * Repositories (owner/name, https URLs, or "owner/*") cloned with the token at session
   * creation, for private ones (HARNESS_CLONE_REPOS; the publish repositories count too).
   */
  cloneRepos?: string[];
  /** GitHub API base (GitHub Enterprise or tests). Default https://api.github.com. */
  apiBase?: string;
  /** Commit author. */
  author?: { name: string; email: string };
  /** URL prefix rewrites for the push, like git's insteadOf (a mirror, or tests). */
  rewrite?: Record<string, string>;
  /** Hosts the token may be sent to when pushing, besides github.com and the API base's host. */
  tokenHosts?: string[];
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** The publishing limits, from the config or else the environment. */
export function publishPolicy(cfg: PublishConfig, env: NodeJS.ProcessEnv = process.env): { prefix: string; allowUpdate: boolean; allowReady: boolean; cloneRepos: string[] } {
  return {
    prefix: cfg.branchPrefix ?? env.HARNESS_PUBLISH_PREFIX ?? 'agent/',
    allowUpdate: cfg.allowUpdate ?? env.HARNESS_PUBLISH_UPDATE === '1',
    allowReady: cfg.allowReady ?? env.HARNESS_PUBLISH_READY === '1',
    cloneRepos: [...(cfg.cloneRepos ?? list(env.HARNESS_CLONE_REPOS)), ...(cfg.repos ?? [])],
  };
}

/** The branch the agent asked for, under the prefix (it is added when missing). */
export function prefixedBranch(branch: string, prefix: string): string {
  const b = branch.trim().replace(/^refs\/heads\//, '');
  return !prefix || b.startsWith(prefix) ? b : `${prefix}${b}`;
}

/** The branches this session has pushed (a file in the session's folder), to tell its own from others'. */
async function ledgerRead(file: string | undefined): Promise<string[]> {
  if (!file) return [];
  try { return ((JSON.parse(await fs.readFile(file, 'utf8')) as { branches?: string[] }).branches ?? []).map(String); } catch { return []; }
}

async function ledgerAdd(file: string | undefined, key: string): Promise<void> {
  if (!file) return;
  const have = await ledgerRead(file);
  if (have.includes(key)) return;
  await writeFileAtomic(file, JSON.stringify({ branches: [...have, key] }, null, 1), { mode: 0o600 });
}

/** A repository as a comparable key: "owner/name" on github.com, else host and path. */
function repoKey(u: string): string {
  const s = u.trim();
  const g = githubRepo(s) ?? (/^[\w.-]+\/[\w.-]+$/.test(s) ? githubRepo(`https://github.com/${s}`) : undefined);
  if (g) return `${g.owner}/${g.name}`.toLowerCase();
  try { const x = new URL(s); return `${x.host}${x.pathname}`.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase(); } catch { return s.toLowerCase(); }
}

/** Whether the operator lets the token clone this repository (entries: "owner/name", a URL, or "owner/*"). */
export function mayCloneWithToken(url: string, cfg: PublishConfig, env: NodeJS.ProcessEnv = process.env): boolean {
  const key = repoKey(url);
  return publishPolicy(cfg, env).cloneRepos.some((r) => {
    if (!r.endsWith('/*')) return repoKey(r) === key;
    // "owner/*": every repository of that owner (on github.com, or at that URL's host).
    const owner = repoKey(`${r.slice(0, -2)}/x`).replace(/\/x$/, '/');
    return key.startsWith(owner) && !key.slice(owner.length).includes('/');
  });
}

/**
 * Clones a session's repository. A public one plainly; one the operator lets the
 * token clone (HARNESS_CLONE_REPOS, or a publish repository) with the token in an
 * HTTP header for this one command - passed in git's environment config, so it is
 * in neither the command line nor the clone's .git/config, and only to GitHub
 * (or the operator's own git hosts), as for a push.
 */
export async function cloneRepository(url: string, dest: string, cfg: PublishConfig | undefined, o: { depth?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ withToken: boolean }> {
  const env = o.env ?? process.env;
  const withToken = !!cfg?.token && /^https?:\/\//.test(url) && tokenMayGoTo(url, cfg) && mayCloneWithToken(url, cfg, env);
  const auth: NodeJS.ProcessEnv = withToken ? {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${cfg!.token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
  } : {};
  const r = await run('git', ['clone', '--depth', String(o.depth ?? 50), '--', url, dest], { timeoutMs: 300_000, env: { ...SAFE_ENV(), ...auth } });
  if (r.code !== 0) {
    const err = r.stderr.trim().slice(0, 500);
    throw new Error(`git clone failed: ${err}${!withToken && /authentication|could not read Username|not found|403|401/i.test(err) ? ' (a private repository is cloned with the server\'s GitHub token only when the operator lists it in HARNESS_CLONE_REPOS)' : ''}`);
  }
  return { withToken };
}

/**
 * Whether the token may go with a push to this repository URL. The token is for
 * GitHub (or the operator's GitHub Enterprise); a session cloned from any other
 * host pushes without it, so a hostile git URL never collects it.
 */
export function tokenMayGoTo(url: string, cfg: PublishConfig): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const hosts = new Set(['github.com', ...(cfg.tokenHosts ?? []).map((h) => h.toLowerCase())]);
  if (cfg.apiBase) {
    try {
      const api = new URL(cfg.apiBase).hostname.toLowerCase();
      hosts.add(api === 'api.github.com' ? 'github.com' : api.replace(/^api\./, ''));
      hosts.add(api);
    } catch { /* a bad apiBase adds nothing */ }
  }
  return hosts.has(host);
}

/**
 * A .git folder the server may fetch from: a real folder, not a link or a gitfile,
 * with nothing that makes git read objects or refs from another repository on
 * this machine - a commondir, alternates, or a link anywhere git reads them through.
 */
async function checkGitDir(dir: string): Promise<void> {
  const st = await fs.lstat(dir).catch(() => null);
  if (!st) throw new PublishError('The workspace is not a git repository.');
  if (st.isSymbolicLink() || !st.isDirectory()) throw new PublishError('The workspace\'s .git is not a plain folder (a link or a gitfile), so it is not published from.');
  for (const f of ['commondir', path.join('objects', 'info', 'alternates')]) {
    if (await fs.lstat(path.join(dir, f)).catch(() => null)) throw new PublishError(`The workspace's .git has ${f.replace(/\\/g, '/')}, which points at another repository; it is not published from.`);
  }
  const linked = async (rel: string): Promise<string | undefined> => {
    const s = await fs.lstat(path.join(dir, rel)).catch(() => null);
    if (!s) return undefined;
    if (s.isSymbolicLink()) return rel;
    if (!s.isDirectory()) return undefined;
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isSymbolicLink()) return r;
      if (e.isDirectory()) { const hit = await linked(r); if (hit) return hit; }
    }
    return undefined;
  };
  for (const f of ['HEAD', 'packed-refs', 'shallow', 'config', 'objects', 'refs']) {
    const hit = await linked(f);
    if (hit) throw new PublishError(`The workspace's .git has a link (${hit.replace(/\\/g, '/')}), which could point at another repository; it is not published from.`);
  }
}

/** The workspace's .git, checked, and resolving to a folder inside the workspace. */
async function ownGitDir(workspace: string): Promise<string> {
  const dir = path.join(workspace, '.git');
  await checkGitDir(dir);
  const [real, root] = await Promise.all([fs.realpath(dir), fs.realpath(workspace)]);
  if (path.dirname(real) !== root) throw new PublishError('The workspace\'s .git resolves outside the workspace.');
  return real;
}

export interface PublishInput {
  branch: string;
  title: string;
  body?: string;
  draft?: boolean;
  base?: string;
  /** Commit everything changed first, with this message. */
  commitMessage?: string;
}

export interface PublishResult { branch: string; commit: string; pushedTo: string; pullRequest?: { number: number; url: string }; note?: string }

export class PublishError extends Error {}

// Git for Windows rejects os.devNull ("\\.\nul") as a config path but accepts NUL.
const NO_CONFIG = process.platform === 'win32' ? 'NUL' : os.devNull;

const SAFE_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'C', GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NO_CONFIG, GIT_ATTR_NOSYSTEM: '1',
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
  ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
  // (Windows names are case-insensitive: there these are the ones above.)
  ...(process.platform !== 'win32' && process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
  ...(process.platform !== 'win32' && process.env.no_proxy ? { no_proxy: process.env.no_proxy } : {}),
  ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
});

async function git(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000) {
  const r = await run('git', args, { cwd, env: SAFE_ENV(), signal, timeoutMs });
  if (r.code !== 0) {
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c') ?? '';
    const err = (r.stderr || r.stdout).trim();
    if (sub === 'push' && /\[rejected\]|non-fast-forward|fetch first/.test(err)) throw new PublishError('The branch has commits on the remote that are not in this workspace, and it is never overwritten. Publish to a new branch name.');
    throw new PublishError(`git ${sub} failed: ${err.slice(0, 500)}`);
  }
  return r.stdout.trim();
}

/** github.com/owner/name from any form of a GitHub remote; undefined if it is not one. */
export function githubRepo(remote: string, host = 'github.com'): { owner: string; name: string; url: string } | undefined {
  const m = new RegExp(`^(?:https://(?:[^@/]+@)?${host.replace(/\./g, '\\.')}/|git@${host.replace(/\./g, '\\.')}:)([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`, 'i').exec(remote.trim());
  return m ? { owner: m[1]!, name: m[2]!, url: `https://${host}/${m[1]}/${m[2]}.git` } : undefined;
}

export function validBranch(b: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(b) && !/\.\.|\/\/|@\{|\.lock$|\/$|\.$/.test(b);
}

/**
 * Where a session may publish: the repository it was cloned from (gitUrl), or
 * one the operator listed. The workspace's own remote settings are not trusted.
 */
export function publishTarget(sessionGitUrl: string | undefined, wanted: string | undefined, cfg: PublishConfig): { url: string; owner?: string; name?: string } {
  const allowed = [...(sessionGitUrl ? [sessionGitUrl] : []), ...(cfg.repos ?? [])];
  if (!allowed.length) throw new PublishError('This session has no repository to publish to: it was not created from a git URL, and the operator has listed none (HARNESS_PUBLISH_REPOS).');
  const norm = (u: string) => {
    const g = githubRepo(u) ?? githubRepo(`https://github.com/${u}`);
    return g ? { url: g.url, owner: g.owner, name: g.name, key: `${g.owner}/${g.name}`.toLowerCase() } : { url: u, key: u.replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase() };
  };
  const list = allowed.map(norm);
  if (!wanted) return list[0]!;
  const w = norm(wanted);
  const hit = list.find((x) => x.key === w.key);
  if (!hit) throw new PublishError(`${wanted} is not a repository this session may publish to. Allowed: ${list.map((x) => x.key).join(', ')}.`);
  return hit;
}

export async function publish(o: {
  workspace: string; sessionGitUrl?: string; repo?: string; input: PublishInput; cfg: PublishConfig; signal?: AbortSignal; fetchImpl?: typeof fetch;
  /** Runs `git add -A && git commit` where the session's commands run (the sandbox), never on the server. */
  commit?: (message: string, author: { name: string; email: string }) => Promise<void>;
  /** The workspace is a sandbox's: move .git out of its reach while fetching from it. */
  isolate?: boolean;
  /**
   * The workspace is a git worktree of a repository on this machine (its .git is a
   * gitfile): its commits are fetched from that repository's git data, by the
   * session's own branch.
   */
  worktree?: { commonDir: string; branch: string };
  /** A file in the session's folder listing the branches this session pushed: only those may be pushed again. */
  ledger?: string;
}): Promise<PublishResult> {
  const { cfg } = o;
  const policy = publishPolicy(cfg);
  const input = { ...o.input, branch: prefixedBranch(o.input.branch, policy.prefix) };
  if (!validBranch(input.branch)) throw new PublishError(`"${input.branch}" is not a valid branch name (letters, digits, . _ / -).`);
  if (!input.title.trim()) throw new PublishError('a pull request title is required');
  const target = publishTarget(o.sessionGitUrl, o.repo, cfg);
  const notes: string[] = [];
  if (input.branch !== o.input.branch.trim()) notes.push(`Branches are published under ${policy.prefix}, so the branch is ${input.branch}.`);
  const own = async () => {
    if (!o.worktree) return ownGitDir(o.workspace);
    await checkGitDir(o.worktree.commonDir);
    return o.worktree.commonDir;
  };
  let gitDir = await own();

  // 1. Commit, if asked - where the session's commands run. `git add` in an
  // agent's workspace runs whatever filters its .git/config defines, so it never
  // runs on the server for a sandboxed session.
  if (input.commitMessage?.trim()) {
    if (!o.commit) throw new PublishError('Commit your changes with git first (this workspace cannot be committed for you).');
    await o.commit(input.commitMessage.trim(), cfg.author ?? { name: 'Harness Agent', email: 'agent@harness.invalid' });
    gitDir = await own(); // the commit ran the agent's code; look again
  }

  // 2. Copy the commits into a repository the harness owns.
  const clean = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-publish-'));
  try {
    await git(['init', '-q', '--bare', clean], os.tmpdir(), o.signal);
    // Fetching from a local path runs upload-pack against the workspace; its config cannot add hooks to a fetch.
    const source = o.worktree ? `refs/heads/${o.worktree.branch}` : 'HEAD';
    const fetchFrom = (dir: string) => git(['-c', 'protocol.file.allow=always', 'fetch', '-q', '--no-tags', dir, `+${source}:refs/heads/${input.branch}`], clean, o.signal);
    if (o.isolate && !o.worktree) {
      // A sandbox may still be running the agent's processes, which could swap .git
      // between the check and the fetch. Move it out of the sandbox's reach first
      // (a rename takes the entry itself, link or not), check it there, and put it back.
      const held = path.join(path.dirname(o.workspace), `.publish-${path.basename(o.workspace)}-${crypto.randomUUID().slice(0, 8)}`);
      await fs.rename(path.join(o.workspace, '.git'), held);
      try {
        await checkGitDir(held);
        await fetchFrom(held);
      } finally {
        await fs.rename(held, path.join(o.workspace, '.git'))
          .catch(() => fs.rename(held, path.join(o.workspace, `.git-publish-${crypto.randomUUID().slice(0, 8)}`)))
          .catch(() => {});
      }
    } else {
      await fetchFrom(gitDir);
    }
    const commit = await git(['rev-parse', `refs/heads/${input.branch}`], clean, o.signal);

    // 3. Push from there, with the token in a header for this one command - and only
    // when the target is GitHub's (a rewrite is the operator's own config).
    let pushUrl = target.url;
    for (const [from, to] of Object.entries(cfg.rewrite ?? {})) if (pushUrl.startsWith(from)) { pushUrl = to + pushUrl.slice(from.length); break; }
    const isHttp = /^https?:\/\//.test(pushUrl);
    const auth = cfg.token && isHttp && tokenMayGoTo(target.url, cfg) ? ['-c', 'http.followRedirects=false', '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${cfg.token}`).toString('base64')}`] : [];
    const remoteHeads = await run('git', [...auth, '-c', 'protocol.file.allow=always', 'ls-remote', '--symref', pushUrl, 'HEAD', `refs/heads/${input.branch}`], { cwd: clean, env: SAFE_ENV(), signal: o.signal, timeoutMs: 60_000 });
    if (remoteHeads.code !== 0) throw new PublishError(`Cannot reach ${target.owner ? `${target.owner}/${target.name}` : target.url}: ${remoteHeads.stderr.trim().slice(0, 300)}`);
    const defaultBranch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remoteHeads.stdout)?.[1];
    const base = input.base ?? defaultBranch ?? 'main';
    if (input.branch === base || input.branch === defaultBranch) throw new PublishError(`Refusing to push to ${input.branch}: it is the base branch. Use a new branch name.`);
    // A branch that is already there is someone's: only this session's own, unless the operator allows updates.
    const ledgerKey = `${target.owner ? `${target.owner}/${target.name}` : target.url}#${input.branch}`;
    const exists = remoteHeads.stdout.split('\n').some((l) => l.trim().endsWith(`\trefs/heads/${input.branch}`));
    if (exists && !policy.allowUpdate && !(await ledgerRead(o.ledger)).includes(ledgerKey)) {
      throw new PublishError(`The branch ${input.branch} already exists and this session did not create it, so it is not pushed to (the operator allows that with HARNESS_PUBLISH_UPDATE=1). Publish to a new branch name.`);
    }
    // No "+": a branch that moved on the remote is not overwritten.
    await git([...auth, '-c', 'protocol.file.allow=always', 'push', '-q', pushUrl, `refs/heads/${input.branch}:refs/heads/${input.branch}`], clean, o.signal, 300_000);
    if (!exists) await ledgerAdd(o.ledger, ledgerKey);
    const result: PublishResult = { branch: input.branch, commit, pushedTo: target.owner ? `${target.owner}/${target.name}` : target.url, ...(notes.length ? { note: notes.join(' ') } : {}) };
    const withNote = (r: PublishResult, n: string): PublishResult => ({ ...r, note: [...notes, n].join(' ') });

    // 4. The pull request (GitHub only).
    if (target.owner && target.name) {
      if (!cfg.token) return withNote(result, 'Pushed. No GitHub token is configured (HARNESS_GITHUB_TOKEN), so no pull request was opened.');
      // A draft unless the operator allows ready pull requests (and the agent did not ask for a draft).
      const draft = policy.allowReady ? input.draft !== false : true;
      if (input.draft === false && !policy.allowReady) notes.push('The pull request is a draft: this server opens only drafts (the operator allows ready ones with HARNESS_PUBLISH_READY=1).');
      const f = o.fetchImpl ?? fetch;
      const api = (cfg.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
      const headers = { authorization: `Bearer ${cfg.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'harness-web', 'x-github-api-version': '2022-11-28' };
      const res = await f(`${api}/repos/${target.owner}/${target.name}/pulls`, { method: 'POST', headers, body: JSON.stringify({ title: input.title.trim(), head: input.branch, base, body: input.body ?? '', draft }), signal: o.signal });
      const j = await res.json().catch(() => ({})) as { number?: number; html_url?: string; message?: string; errors?: { message?: string }[] };
      if (res.status === 422 && /already exists/i.test(JSON.stringify(j))) {
        const open = await f(`${api}/repos/${target.owner}/${target.name}/pulls?head=${encodeURIComponent(`${target.owner}:${input.branch}`)}&state=open`, { headers, signal: o.signal });
        const prs = await open.json().catch(() => []) as { number: number; html_url: string }[];
        if (prs[0]) return withNote({ ...result, pullRequest: { number: prs[0].number, url: prs[0].html_url } }, 'The branch already had an open pull request; the new commits are on it.');
      }
      if (!res.ok || !j.number) throw new PublishError(`Pushed ${input.branch}, but GitHub refused the pull request (HTTP ${res.status}): ${j.message ?? ''} ${(j.errors ?? []).map((e) => e.message).join('; ')}`.trim());
      result.pullRequest = { number: j.number, url: j.html_url ?? '' };
      if (notes.length) result.note = notes.join(' ');
    }
    return result;
  } finally {
    await fs.rm(clean, { recursive: true, force: true });
  }
}

/** Shell-quotes for the commit command run in the session's runtime. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const newBranchName = (prefix = 'agent') => `${prefix}/${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
