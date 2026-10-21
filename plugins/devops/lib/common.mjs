// What every devops tool and gate shares: running a command where the
// session's commands run (with secrets passed on stdin, never on a command
// line, and redacted from what comes back), finding the programs there, paths
// inside the workspace, and the Key Vault.
//
// Where commands run: the session's runtime (the Docker sandbox - the ops
// image has every program -, a server folder, or a companion started with
// --allow-hooks). A server-folder session can instead run them in a throwaway
// container of the ops image: HARNESS_DEVOPS_IMAGE=harness-sandbox-ops:latest
// (the workspace mounted at /workspace, network HARNESS_DEVOPS_NETWORK,
// default none).

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run } from '../../../src/runtime/host.ts';
import { PathError, resolveIn } from '../../../src/tools/paths.ts';

/** Names of the throwaway runner containers (tests use their own prefix). */
export const runner = { prefix: 'harness-devops-' };

const VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Loads secrets from stdin before the command: NUL-separated (kind, name,
 * value) triples. "e" exports the value; "f" writes it to a file in a private
 * temporary folder (outside the workspace) and exports the file's path. The
 * folder is removed when the command ends, however it ends.
 */
export const PRELUDE = [
  '__hw_t=$(mktemp -d) || exit 97',
  'trap \'rm -rf "$__hw_t"\' EXIT',
  'while IFS= read -r -d \'\' __k && IFS= read -r -d \'\' __n && IFS= read -r -d \'\' __v; do',
  '  if [ "$__k" = f ]; then (umask 077; printf \'%s\' "$__v" > "$__hw_t/$__n"); export "$__n=$__hw_t/$__n"; else export "$__n=$__v"; fi',
  'done',
  'unset __k __n __v',
].join('\n');

/** One argument as a bash word. */
export const q = (s) => {
  const v = String(s);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`;
};

// ---------- redaction ----------

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (service-account tokens)
  // The ones with a group keep the group (the key name) and redact what follows.
  /((?:client-key-data|client-certificate-data|token|password|secret)\s*:\s*)[^\s"']{12,}/gi,
  /((?:Authorization|authorization)\s*:\s*(?:Bearer|Basic|token)\s+)\S+/g,
];

/**
 * Text with every secret value we handed the command, and anything that looks
 * like a credential, replaced. Multi-line secrets (a kubeconfig, a key) are
 * also redacted line by line, so a certificate echoed in an error is caught.
 */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  const pieces = new Set();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 4) continue;
    pieces.add(s);
    for (const line of s.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= 16) pieces.add(t);
      const m = /:\s*(\S{16,})\s*$/.exec(t);
      if (m) pieces.add(m[1]);
    }
  }
  for (const p of [...pieces].sort((a, b) => b.length - a.length)) out = out.split(p).join('[REDACTED]');
  for (const re of PATTERNS) out = out.replace(re, (m, keep) => (typeof keep === 'string' && m.startsWith(keep) ? `${keep}[REDACTED]` : '[REDACTED]'));
  return out;
}

// ---------- running commands ----------

export const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The last lines of a command's output. */
export function tail(text, lines = 60, chars = 6000) {
  const t = stripAnsi(text).replace(/\r/g, '').trimEnd().split('\n').slice(-lines).join('\n');
  return t.length > chars ? `...${t.slice(-chars)}` : t;
}

/** Whether this session's commands run in the ops image through the local runner. */
export const usesRunner = (host) => host.kind === 'local' && !!process.env.HARNESS_DEVOPS_IMAGE?.trim();

/** Whether commands certainly have no network where they run (a sandbox or the runner without one). */
export const offline = (host) => (usesRunner(host) ? (process.env.HARNESS_DEVOPS_NETWORK?.trim() || 'none') === 'none' : host.sandboxed && host.networkPolicy === 'none');

async function runnerExec(host, cmd, opts) {
  const image = process.env.HARNESS_DEVOPS_IMAGE.trim();
  const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const uid = process.getuid?.();
  const args = [
    'run', '--rm', '-i', '--name', `${runner.prefix}${crypto.randomBytes(5).toString('hex')}`,
    '--network', process.env.HARNESS_DEVOPS_NETWORK?.trim() || 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', process.env.HARNESS_SANDBOX_MEMORY || '4g',
    ...(uid !== undefined ? ['--user', `${uid}:${process.getgid?.() ?? uid}`] : []),
    '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-v', `${host.root}:/workspace`, '-w', '/workspace', '--label', 'harness-web=1',
    image, 'timeout', '-k', '5', String(secs), 'bash', '-c', `mkdir -p /tmp/home; ${cmd}`,
  ];
  const r = await run('docker', args, { ...opts, timeoutMs: opts.timeoutMs + 30_000 });
  if (r.code === 124) r.timedOut = true;
  if (r.code === 125) r.stderr = `the devops runner (docker run ${image}) could not start: ${r.stderr.trim()}`;
  return r;
}

/**
 * Runs a bash command where the session's commands run. `env` values are
 * exported, `files` values written to private temporary files whose paths are
 * exported (KUBECONFIG); both travel on stdin, and both are redacted from the
 * output.
 */
export async function sh(host, cmd, { signal, timeoutMs = 300_000, env = {}, files = {} } = {}) {
  if (host.shell === 'powershell' && !usesRunner(host)) throw new Error('The devops tools run bash commands; this runtime has PowerShell only (on Windows, install Git for Windows for Git Bash, or set HARNESS_DEVOPS_IMAGE to run them in the ops image).');
  const triples = [
    ...Object.entries(env).map(([n, v]) => ['e', n, v]),
    ...Object.entries(files).map(([n, v]) => ['f', n, v]),
  ];
  for (const [, n, v] of triples) {
    if (!VAR.test(n)) throw new Error(`${n} is not a valid environment variable name`);
    if (typeof v !== 'string' || v.includes('\0')) throw new Error(`the value for ${n} is not text`);
  }
  const stdin = triples.length ? triples.map((t) => `${t.join('\0')}\0`).join('') : undefined;
  const full = triples.length ? `${PRELUDE}\n${cmd}` : cmd;
  const opts = { timeoutMs, signal, ...(stdin !== undefined ? { stdin } : {}) };
  let r;
  try {
    r = usesRunner(host) ? await runnerExec(host, full, opts) : await host.exec(full, opts);
  } catch (e) {
    if (host.kind === 'companion' && /--allow-hooks/.test(e.message)) throw new Error('The devops tools run their programs on the companion\'s computer, which it allows only when started with --allow-hooks (as for the quality gates). Ask the user to restart the companion with --allow-hooks.');
    throw e;
  }
  const secrets = triples.map((t) => t[2]);
  return { ...r, stdout: redact(r.stdout, secrets), stderr: redact(r.stderr, secrets), output: redact(`${r.stdout}${r.stdout && r.stderr ? '\n' : ''}${r.stderr}`, secrets) };
}

const found = new WeakMap();

/** The first of `names` on the runtime's PATH, or null. Only hits are remembered (a program may be installed later). */
export async function locate(host, names, signal) {
  const list = Array.isArray(names) ? names : [names];
  const key = list.join(' ');
  let m = found.get(host);
  if (!m) found.set(host, (m = new Map()));
  if (m.has(key)) return m.get(key);
  const r = await sh(host, `for n in ${list.map(q).join(' ')}; do command -v "$n" >/dev/null 2>&1 && { echo "$n"; exit 0; }; done; exit 1`, { signal, timeoutMs: 30_000 });
  const bin = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop()?.trim() || null : null;
  if (bin) m.set(key, bin);
  return bin;
}

/** Why a program is not there, and how to get it, for this kind of runtime. */
export function missing(host, what) {
  if (host.kind === 'docker') return `${what} is not installed in this sandbox. Use the ops sandbox image: the operator builds it (npm run sandbox:image:ops), allows it with HARNESS_SANDBOX_IMAGES=harness-sandbox-ops:latest, and a new session picks it.`;
  if (usesRunner(host)) return `${what} is not in the devops runner image ${process.env.HARNESS_DEVOPS_IMAGE} (build harness-sandbox-ops:latest with npm run sandbox:image:ops).`;
  return `${what} is not installed where this session's commands run${host.kind === 'companion' ? ' (the computer the companion runs on)' : ''}. Install it, or (server folders) set HARNESS_DEVOPS_IMAGE=harness-sandbox-ops:latest to run the devops tools in the ops image.`;
}

/** A tool that needs a program: its path, or an error outcome naming how to get it. */
export async function need(host, names, what, signal) {
  const bin = await locate(host, names, signal);
  return bin ? { bin } : { error: { content: missing(host, what), is_error: true } };
}

/** Whether a session on this host gets the ops tools: a sandbox needs the ops image (kubeconform marks it). */
export function opsAvailable(host) {
  if (host.kind !== 'docker') return true;
  return typeof host.hasCommands === 'function' ? host.hasCommands(['kubeconform']) : true;
}

// ---------- paths ----------

/** A workspace path from the model as a path relative to the workspace (forward slashes); throws outside it. */
export async function relIn(host, p, def = '.') {
  const s = p === undefined || p === null || p === '' ? def : String(p);
  if (host.kind === 'companion') {
    const posix = s.replace(/\\/g, '/');
    const disp = host.displayRoot.replace(/\\/g, '/').replace(/\/$/, '');
    const rel = path.posix.normalize(posix === disp ? '.' : posix.startsWith(disp + '/') ? posix.slice(disp.length + 1) : posix);
    if (path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel) || rel === '..' || rel.startsWith('../')) throw new PathError(`${s} is outside the workspace (${host.displayRoot})`);
    return rel;
  }
  const real = await resolveIn(host, s);
  return path.relative(await fsp.realpath(host.root), real).split(path.sep).join('/') || '.';
}

/** A list of workspace paths (a string or an array). */
export async function relList(host, v, def) {
  const list = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? (def ? [def] : []) : [v];
  return Promise.all(list.slice(0, 50).map((p) => relIn(host, p)));
}

// ---------- the Key Vault ----------

export class UserError extends Error {}

/**
 * Secret values for a command, from the framework's Key Vault: { ENV_VAR:
 * secret name } -> { ENV_VAR: value }. Values stay on the server side of the
 * tool (into the command's stdin), never in its output.
 */
export async function fromVault(ctx, map, purpose) {
  const entries = Object.entries(map ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return {};
  for (const [k, v] of entries) {
    if (!VAR.test(k)) throw new UserError(`${k} is not a valid environment variable name`);
    if (typeof v !== 'string') throw new UserError(`the secret for ${k} must be a Key Vault secret name`);
  }
  const vault = ctx.services?.vault;
  if (!vault) throw new UserError(`This needs secrets from the Key Vault (${entries.map(([, v]) => v).join(', ')}), and this server has no Key Vault for this session. Ask the operator to set it up, or run without them.`);
  try {
    return await vault.envFor(Object.fromEntries(entries), purpose);
  } catch (e) {
    throw new UserError(`The Key Vault refused: ${e.message}`);
  }
}

/** Whether the vault has a secret of this name (false without a vault). */
export async function vaultHas(ctx, name) {
  try { return (await ctx.services?.vault?.list())?.some((s) => s.name === name) ?? false; } catch { return false; }
}

/** Runs a tool body; a UserError or path error becomes an error outcome the agent can act on. */
export async function guard(fn) {
  try {
    const r = await fn();
    return r;
  } catch (e) {
    if (e instanceof UserError || e instanceof PathError) return { content: e.message, is_error: true };
    throw e;
  }
}

/** Shell-quoted list of workspace-relative paths. */
export const words = (list) => list.map(q).join(' ');

/** A short random id for files the tools write. */
export const newId = () => `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;

/** Parses JSON output, or undefined. Tolerates text before the JSON (warnings). */
export function parseJson(text) {
  const t = String(text ?? '').trim();
  try { return JSON.parse(t); } catch { /* try from the first brace */ }
  const i = t.search(/[[{]/);
  if (i > 0) { try { return JSON.parse(t.slice(i)); } catch { /* not JSON */ } }
  return undefined;
}

/** Seconds from input, clamped. */
export const seconds = (v, def, max = 1800) => Math.min(Math.max(Number(v) || def, 5), max);
