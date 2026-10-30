// Commands on inventory hosts through the system OpenSSH client, with the
// credential from the vault. The key goes into a private temporary file (0600
// in a 0700 folder) that is deleted when the command ends; a password goes to
// ssh through an askpass helper reading it from the child's environment. The
// host key is pinned: the first connection records it in the plugin's own
// known_hosts (outside every workspace), and a changed key is refused until a
// person confirms the new fingerprint.

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSafe } from './inventory.mjs';
import { cleanEnv, runProgram } from './proc.mjs';

/** The ssh client: HARNESS_OPS_SSH, else Windows' own OpenSSH where present, else ssh on PATH. */
export function sshBinary(name = 'ssh', env = process.env) {
  if (name === 'ssh' && env.HARNESS_OPS_SSH) return env.HARNESS_OPS_SSH;
  if (process.platform === 'win32') {
    const sys = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', `${name}.exe`);
    if (existsSync(sys)) return sys;
  }
  return name;
}

// ---------- read-only classification ----------
//
// An allowlist: a command is "read-only" only when every part of it is a known
// command in a form that cannot change anything or run something else. Anything
// unknown, any assignment in front of a command (LD_PRELOAD=...), any expansion
// that could hide an option, counts as a change. (Every ssh_exec call is asked
// about anyway unless a rule allows it; this label is what the person sees.)

/** Commands with no form that writes or runs another program. */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'df', 'du', 'free', 'uptime', 'ps', 'pgrep', 'pidof', 'uname', 'id', 'whoami', 'who', 'w', 'last',
  'stat', 'file', 'grep', 'egrep', 'fgrep', 'zgrep', 'cut', 'tr', 'nl', 'column', 'echo', 'printf', 'true',
  'ss', 'netstat', 'lsof', 'lsblk', 'blkid', 'findmnt', 'nproc', 'lscpu', 'vmstat', 'iostat', 'mpstat',
  'getent', 'printenv', 'which', 'type', 'readlink', 'realpath', 'basename', 'dirname', 'md5sum', 'sha256sum', 'test', '[', 'ulimit',
  'dig', 'nslookup', 'host', 'ping', 'traceroute', 'tracepath', 'zcat', 'od', 'strings', 'jq', 'tac', 'diff', 'cmp',
]);
/** Commands read-only only with some subcommands/flags (matched against the arguments as written). */
const SUB_READ_ONLY = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat|--failed)\b/,
  docker: /^(ps|logs|inspect|stats --no-stream|images|info|version|top|port|volume ls|volume inspect|network ls|network inspect|system df)\b/,
  apt: /^list\b/, 'apt-get': /^(-s|--simulate|--dry-run)\b/, dnf: /^(check-update|list|info|updateinfo)\b/, yum: /^(check-update|list|info|updateinfo)\b/, apk: /^(info|list|version|policy)\b/,
  ip: /^(-[46] )?(a|addr|address|r|route|link|neigh)( show| list)?\b(?!.*\b(add|del|flush|change|replace|set)\b)/,
  crontab: /^-l$/, sshd: /^-T\b/, openssl: /^(x509|s_client|version|crl|req -noout)\b(?!.*(^|\s)-(out|keyout)\b)/, timedatectl: /^(status)?$/, hostnamectl: /^(status)?$/,
  find: /^(?!.*(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b)/, mount: /^$/,
  kubectl: /^(get|describe|logs|top|version|cluster-info)\b/, nginx: /^-t$/,
};

const oneOf = (list) => (t) => list.includes(t);
/** Options a command may be given; positional arguments allowed unless `positional` is false. */
const flagsOnly = (allowed, { positional = true, max } = {}) => (ws) => {
  let n = 0;
  for (const w of ws) {
    if (w.startsWith('-') && w !== '-') { if (!allowed(w)) return false; } else n++;
  }
  return (positional || n === 0) && (max === undefined || n <= max);
};

/** sed: only printing, deleting from the output, substitutions without the e and w flags, y///. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
const SED_CMD = new RegExp(String.raw`^(?:${SED_ADDR}(?:,(?:${SED_ADDR}|[+~]\d+))?)?!?\s*(?:[pdDqQ=lnNgGhHxz]\d*|s/(?:[^/\\]|\\.)*/(?:[^/\\]|\\.)*/[gpiImM0-9]*|y/(?:[^/\\]|\\.)*/(?:[^/\\]|\\.)*/)$`);
function sedReadOnly(ws) {
  const scripts = []; let i = 0;
  for (; i < ws.length; i++) {
    const w = ws[i];
    if (w === '-e' || w === '--expression') { if (i + 1 >= ws.length) return false; scripts.push(ws[++i]); continue; }
    if (w.startsWith('--expression=')) { scripts.push(w.slice(13)); continue; }
    if (['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--debug', '--sandbox'].includes(w)) continue;
    if (/^-[nErsuz]+$/.test(w)) continue;
    if (w.startsWith('-') && w !== '-') return false; // -i, -f, --in-place, --file, -l ...
    if (!scripts.length) { scripts.push(w); continue; }
  }
  if (!scripts.length) return false;
  return scripts.every((sc) => sc.split(/[;\n]/).map((c) => c.trim()).filter(Boolean).every((c) => SED_CMD.test(c)));
}

/** awk: no pipes to or from commands, no system(), no output redirection, no script files or extensions. */
function awkReadOnly(ws) {
  for (const w of ws) {
    if (/^-(f|i|E|l)/.test(w) || /^--(file|include|exec|load|source)/.test(w)) return false;
    if (/[|>]|system|getline|\bclose\b|@load|@include/.test(w)) return false;
  }
  return true;
}

/** git: what reads the repository; never --output (writes a file), never branch changes. */
const GIT_BRANCH_FLAGS = /^(-a|--all|-r|--remotes|-l|--list|-v|-vv|--verbose|--show-current|-i|--ignore-case|--no-color|--color(=\w+)?|--no-abbrev|--abbrev=\d+|--sort=\S+|--format=.*|--column(=\S+)?|--no-column|--contains|--no-contains|--merged|--no-merged|--points-at)$/;
function gitReadOnly(ws) {
  const [sub, ...rest] = ws;
  if (!['status', 'log', 'diff', 'show', 'rev-parse', 'branch'].includes(sub)) return false;
  if (rest.some((w) => /^--output(=|$)/.test(w) || /^--ext-diff$/.test(w))) return false;
  if (sub !== 'branch') return true;
  const listing = rest.some((w) => w === '-l' || w === '--list');
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.startsWith('-')) {
      if (!GIT_BRANCH_FLAGS.test(w)) return false;
      if (/^--(no-)?(contains|merged)$|^--points-at$/.test(w)) i++; // takes a commit
      continue;
    }
    if (!listing) return false; // "git branch NAME" creates a branch
  }
  return true;
}

const SAFE_FORMS = {
  sed: sedReadOnly,
  awk: awkReadOnly, gawk: awkReadOnly, mawk: awkReadOnly,
  git: gitReadOnly,
  sort: (ws) => !ws.some((w) => /^(-o|--output|--compress-program)/.test(w) || /^-[a-zA-Z]*o/.test(w)),
  uniq: flagsOnly(() => true, { max: 1 }), // a second file name is where it writes
  xxd: flagsOnly((w) => !/^-(r|revert)/.test(w), { max: 1 }),
  dmesg: flagsOnly((w) => !/^(-[a-zA-Z]*[cCnDE]|--(clear|read-clear|console-level|console-off|console-on))/.test(w)),
  sar: flagsOnly((w) => !/^-o/.test(w)),
  top: (ws) => ws.includes('-b') || ws.some((w) => /^-[a-zA-Z]*b/.test(w)),
  journalctl: flagsOnly((w) => !/^--(vacuum|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog|new-id128|verify)/.test(w)),
  hostname: flagsOnly(oneOf(['-f', '-s', '-i', '-I', '-A', '-d', '-y', '--fqdn', '--long', '--short', '--ip-address', '--all-ip-addresses', '--all-fqdns', '--domain']), { positional: false }),
  date: (ws) => {
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (w.startsWith('+') || ['-u', '--utc', '--universal', '-R', '--rfc-email'].includes(w) || /^-I\w*$|^--iso-8601(=\w+)?$|^--rfc-3339=\w+$|^--date=/.test(w)) continue;
      if (w === '-d' || w === '--date') { i++; continue; }
      return false; // -s / --set and anything else
    }
    return true;
  },
  dpkg: (ws) => ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '-p', '--print-avail', '--get-selections', '--print-architecture'].includes(ws[0]) && ws.slice(1).every((w) => !w.startsWith('-')),
  'dpkg-query': (ws) => ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '-W', '--show'].includes(ws[0]) && ws.slice(1).every((w) => !w.startsWith('-') || /^(-f|--showformat=.*)$/.test(w)),
  rpm: (ws) => /^(-q[ailfcdR]*|--query)$/.test(ws[0] ?? '') && ws.slice(1).every((w) => !w.startsWith('-') || /^(-[ailfcdR]+|--(all|info|list|file|changelog|whatprovides|whatrequires|requires|provides|last))$/.test(w)),
};

/** Splits a command line on |, &&, || and ; outside quotes; null when it redirects or substitutes. */
function segments(cmd) {
  const out = []; let cur = ''; let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = ''; else if (c === '\\' && q === '"') { cur += cmd[++i] ?? ''; } continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(')) return null;
    if (c === '>' || c === '<') {
      const rest = cmd.slice(i);
      if (c === '>' && (rest.startsWith('>&1') || rest.startsWith('>&2'))) { cur += rest.slice(0, 3); i += 2; continue; }
      const devnull = /^>\s*\/dev\/null/.exec(rest);
      if (devnull) { cur += devnull[0]; i += devnull[0].length - 1; continue; }
      return null;
    }
    if (c === '\n') return null;
    if (c === '|' || c === ';' || c === '&') { if (cur.trim()) out.push(cur.trim()); cur = ''; if (cmd[i + 1] === c) i++; continue; }
    cur += c;
  }
  if (q) return null;
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * A segment's words as the shell passes them (quotes removed); null when an
 * expansion could change them ($VAR, ${...}, {a,b} braces, ~user).
 */
function words(seg) {
  const out = []; let cur = ''; let q = ''; let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q === "'") { if (c === "'") q = ''; else cur += c; continue; }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '$') return null;
      else if (c === '\\' && '"\\$`'.includes(seg[i + 1] ?? '')) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\') { cur += seg[++i] ?? ''; has = true; continue; }
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ''; has = false; continue; }
    if (c === '$' || c === '{' || c === '}' || (c === '~' && !has)) return null;
    cur += c; has = true;
  }
  if (q) return null;
  if (has) out.push(cur);
  return out;
}

/** Whether a command only reads (every part of a pipeline is a known read-only command in a safe form). */
export function isReadOnly(command) {
  const segs = segments(String(command ?? '').trim());
  if (!segs || !segs.length) return false;
  return segs.every((seg) => {
    // Redirections to /dev/null and between the output streams change nothing.
    const clean = seg.replace(/\s*\d?>&[12]/g, ' ').replace(/\s*\d?>\s*\/dev\/null/g, ' ').trim();
    const ws = words(clean);
    if (!ws || !ws.length) return false;
    // VAR=value before a command changes what it runs (LD_PRELOAD, PATH, PAGER): not read-only.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) return false;
    let i = 0;
    if (ws[0] === 'sudo') { i = 1; if (ws[1] === '-n') i = 2; }
    const head = ws[i];
    if (!head || head.startsWith('-')) return false;
    const name = head.replace(/^.*\//, '');
    const rest = ws.slice(i + 1);
    if (SAFE_FORMS[name]) return SAFE_FORMS[name](rest);
    if (SUB_READ_ONLY[name]) return SUB_READ_ONLY[name].test(rest.join(' '));
    return READ_ONLY.has(name);
  });
}

// ---------- known hosts ----------

/** The known_hosts name of a host: "host", or "[host]:port" off port 22. */
export const knownName = (address, port) => (Number(port) === 22 ? address : `[${address}]:${port}`);

export async function knownHostsHas(file, address, port, signal) {
  if (!existsSync(file)) return false;
  const r = await runProgram(sshBinary('ssh-keygen'), ['-F', knownName(address, port), '-f', file], { timeoutMs: 10_000, signal });
  return r.code === 0 && r.stdout.trim().length > 0;
}

const NUL = process.platform === 'win32' ? 'NUL' : '/dev/null';
/** The host keys last seen presented per address:port (what a person is shown, then confirms). */
const presented = new Map();
const sshPath = (p) => `"${p.replace(/\\/g, '/')}"`;

/**
 * The host key a host presents now, and its fingerprint. ssh-keyscan is
 * unreliable on Windows, so ssh itself connects with an empty known_hosts that
 * it may add to, offers no credential at all ("none"), and the key it recorded
 * is read back.
 */
export async function presentedFingerprints(address, port, signal) {
  assertSafe('address', address);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-ops-scan-'));
  try {
    const f = path.join(tmp, 'known_hosts');
    const r = await runProgram(sshBinary(), ['-p', String(port), '-T', '-F', NUL, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${sshPath(f)}`, '-o', `GlobalKnownHostsFile=${NUL}`, '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR', '-l', 'hostkey-probe', '--', address, 'exit'], { timeoutMs: 20_000, signal });
    const keys = (await fs.readFile(f, 'utf8').catch(() => '')).replace(/\r/g, '');
    if (!keys.trim()) return { keys: '', fingerprints: [], error: r.error ?? (r.stderr.trim().split('\n').pop() || 'no host key received') };
    const fp = await runProgram(sshBinary('ssh-keygen'), ['-l', '-f', f], { timeoutMs: 10_000, signal });
    const out = { keys, fingerprints: fp.stdout.trim().split('\n').filter(Boolean).map((l) => { const [, hash, , type] = l.split(/\s+/); return { hash, type: (type ?? '').replace(/[()]/g, '') }; }) };
    presented.set(`${address}:${port}`, { ...out, at: Date.now() });
    return out;
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

/** Fingerprints recorded for a host in our known_hosts. */
export async function pinnedFingerprints(file, address, port, signal) {
  if (!existsSync(file)) return [];
  const r = await runProgram(sshBinary('ssh-keygen'), ['-F', knownName(address, port), '-f', file], { timeoutMs: 10_000, signal });
  const lines = r.stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return [];
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-ops-pin-'));
  try {
    const f = path.join(tmp, 'k'); await fs.writeFile(f, lines.join('\n') + '\n');
    const fp = await runProgram(sshBinary('ssh-keygen'), ['-l', '-f', f], { timeoutMs: 10_000, signal });
    return fp.stdout.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)[1]);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}

/**
 * Replaces a host's pinned key with the one it presents now, only when that
 * key's fingerprint is the one a person confirmed.
 */
export async function repin(file, address, port, confirmed, signal) {
  // The key shown to the person (recorded when the change was detected) is the one they confirm; asking the
  // host again each time costs a connection that never authenticates, which OpenSSH 9.8+ penalises per source.
  const cached = presented.get(`${address}:${port}`);
  const now = cached && Date.now() - cached.at < 10 * 60_000 ? cached : await presentedFingerprints(address, port, signal);
  if (!now.fingerprints.length) throw new Error(`could not read ${address}:${port}'s host key: ${now.error}`);
  if (!now.fingerprints.some((f) => f.hash === confirmed)) throw new Error(`${address}:${port} presents ${now.fingerprints.map((f) => `${f.type} ${f.hash}`).join(', ')}, not the confirmed ${confirmed}: nothing changed`);
  if (existsSync(file)) await runProgram(sshBinary('ssh-keygen'), ['-R', knownName(address, port), '-f', file], { timeoutMs: 10_000, signal });
  await fs.mkdir(path.dirname(file), { recursive: true });
  // Only the keys of the confirmed type: a different key type presented alongside is not what was checked.
  const type = now.fingerprints.find((f) => f.hash === confirmed).type.toLowerCase();
  const keep = now.keys.split('\n').filter((l) => l && !l.startsWith('#') && l.toLowerCase().includes(type === 'ed25519' ? 'ssh-ed25519' : type === 'rsa' ? 'ssh-rsa' : type.startsWith('ecdsa') ? 'ecdsa-sha2' : type));
  await fs.appendFile(file, keep.join('\n') + '\n');
  await fs.rm(`${file}.old`, { force: true });
}

// ---------- running ----------

const isKey = (v) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v);

async function askpassScript(dir) {
  // In the desktop app execPath is the app itself: ELECTRON_RUN_AS_NODE runs it as Node (plain Node ignores it).
  const node = process.execPath;
  if (process.platform === 'win32') {
    const js = path.join(dir, 'askpass.cjs');
    await fs.writeFile(js, 'process.stdout.write((process.env.HW_OPS_ASKPASS || "") + "\\n")\n');
    const cmd = path.join(dir, 'askpass.cmd');
    await fs.writeFile(cmd, `@set "ELECTRON_RUN_AS_NODE=1"\r\n@"${node}" "${js}"\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'askpass.sh');
  await fs.writeFile(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node}" -e 'process.stdout.write((process.env.HW_OPS_ASKPASS||"")+"\\n")'\n`, { mode: 0o700 });
  return sh;
}

/**
 * The end of an ssh command line: the user as its own option, then "--" and the
 * destination, so nothing from the inventory is ever read as an ssh option
 * (a user "-oProxyCommand=..." would run a command here). Checked again here,
 * whatever the caller checked.
 */
export function destination(user, address) {
  return ['-l', assertSafe('user', user), '--', assertSafe('address', address)];
}

/**
 * Runs `command` on host { address, port, user } with `secret` (a private key
 * or a password). Returns { code, stdout, stderr, firstUse, fingerprint?, keyChanged?, error? }.
 */
export async function sshRun({ address, port = 22, user, secret, command, knownHosts, timeoutMs = 60_000, signal, connectTimeout = 10 }) {
  const dest = destination(user, address);
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error(`port ${port} is not a TCP port: refused`);
  await fs.mkdir(path.dirname(knownHosts), { recursive: true });
  const firstUse = !(await knownHostsHas(knownHosts, address, port, signal));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-ops-ssh-'));
  try {
    await fs.chmod(dir, 0o700).catch(() => {});
    const args = [
      '-p', String(port), '-T',
      '-o', 'BatchMode=' + (isKey(secret) ? 'yes' : 'no'),
      '-o', 'StrictHostKeyChecking=accept-new',
      // Quoted, with forward slashes: ssh splits option values on spaces (a profile folder named "First Last").
      '-o', `UserKnownHostsFile="${knownHosts.replace(/\\/g, '/')}"`,
      '-o', 'GlobalKnownHostsFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-o', 'HashKnownHosts=no',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none',
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'LogLevel=ERROR',
      '-F', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ];
    const env = cleanEnv();
    if (isKey(secret)) {
      const keyFile = path.join(dir, 'id');
      await fs.writeFile(keyFile, secret.replace(/\r\n/g, '\n').trimEnd() + '\n', { mode: 0o600 });
      await fs.chmod(keyFile, 0o600).catch(() => {});
      // Windows' OpenSSH reads the ACL, not the mode: only this account may have access.
      if (process.platform === 'win32') {
        const who = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : os.userInfo().username;
        const r = await runProgram('icacls', [keyFile, '/inheritance:r', '/grant:r', `${who}:F`], { timeoutMs: 15_000, signal });
        if (r.code !== 0) throw new Error(`could not restrict the temporary key file (icacls: ${(r.stderr || r.stdout).trim().slice(0, 200)})`);
      }
      args.push('-i', keyFile, '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'PreferredAuthentications=publickey');
    } else {
      args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1');
      env.SSH_ASKPASS = await askpassScript(dir);
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = env.DISPLAY || 'harness:0';
      env.HW_OPS_ASKPASS = secret;
    }
    args.push(...dest, command);
    const r = await runProgram(sshBinary(), args, { timeoutMs, signal, env });
    const stderr = r.stderr;
    const keyChanged = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr);
    let fingerprint;
    if (firstUse && !keyChanged && r.code !== null && r.code !== 255) fingerprint = (await pinnedFingerprints(knownHosts, address, port, signal))[0];
    return { ...r, firstUse, fingerprint, keyChanged };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A failed connection (exit 255) in words the model can act on. */
export function explainSshFailure(r, host) {
  const e = `${r.stderr}\n${r.error ?? ''}`;
  if (r.error && /not installed/.test(r.error)) return `The ssh client is not installed on the server (${r.error}). Install OpenSSH or set HARNESS_OPS_SSH to its path.`;
  if (r.keyChanged) return `The host key of ${host.name} (${host.address}:${host.port}) is NOT the one pinned on first use: refused. This can be a reinstalled host or a machine pretending to be it. Check with the host's owner; if the new key is right, call ssh_exec again with trust_host_key set to the new fingerprint (shown below) and a person will be asked to approve.`;
  if (/Permission denied/i.test(e)) return `${host.user}@${host.address} refused the credential "${host.credential}" (${e.trim().split('\n').pop()}). Check the user and that the vault entry matches the host's authorized key or password.`;
  if (/Connection refused/i.test(e)) return `Nothing accepts ssh connections on ${host.address}:${host.port} (connection refused).`;
  if (/timed out|Operation timed out/i.test(e)) return `${host.address}:${host.port} did not answer in time (down, firewalled, or the wrong address).`;
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(e)) return `The address ${host.address} does not resolve.`;
  if (r.code === 255 && !e.trim()) return `ssh to ${host.name} (${host.address}:${host.port}) was closed before it could log in, with no message. The server may be refusing this address for a while after failed or unauthenticated connections (OpenSSH PerSourcePenalties, MaxStartups): wait a minute and try once more, and check the server's sshd log.`;
  return `ssh to ${host.name} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${e.trim().slice(-400)}`;
}
