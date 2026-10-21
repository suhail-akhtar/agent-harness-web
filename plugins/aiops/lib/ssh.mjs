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

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'df', 'du', 'free', 'uptime', 'ps', 'pgrep', 'pidof', 'uname', 'hostname', 'id', 'whoami', 'who', 'w', 'last',
  'date', 'stat', 'file', 'grep', 'egrep', 'fgrep', 'zgrep', 'sort', 'uniq', 'cut', 'tr', 'nl', 'column', 'less', 'more', 'echo', 'printf', 'true',
  'journalctl', 'dmesg', 'ss', 'netstat', 'lsof', 'lsblk', 'blkid', 'findmnt', 'nproc', 'lscpu', 'vmstat', 'iostat', 'mpstat', 'sar', 'top',
  'getent', 'env', 'printenv', 'which', 'type', 'readlink', 'realpath', 'basename', 'dirname', 'md5sum', 'sha256sum', 'test', '[', 'ulimit',
  'dpkg', 'rpm', 'dig', 'nslookup', 'host', 'ping', 'traceroute', 'tracepath', 'zcat', 'xxd', 'od', 'strings', 'jq', 'tac', 'diff', 'cmp',
]);
/** Commands read-only only with some subcommands/flags. */
const SUB_READ_ONLY = {
  systemctl: /^(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|show|cat|--failed)\b/,
  docker: /^(ps|logs|inspect|stats --no-stream|images|info|version|top|port|volume ls|volume inspect|network ls|network inspect|system df)\b/,
  apt: /^list\b/, 'apt-get': /^(-s|--simulate|--dry-run)\b/, dnf: /^(check-update|list|info|updateinfo)\b/, yum: /^(check-update|list|info|updateinfo)\b/, apk: /^(info|list|version|policy)\b/,
  ip: /^(-[46] )?(a|addr|address|r|route|link|neigh)( show| list)?\b(?!.*\b(add|del|flush|change|replace|set)\b)/,
  crontab: /^-l\b/, sshd: /^-T\b/, openssl: /^(x509|s_client|version|crl|req -noout)\b/, timedatectl: /^(status)?$/, hostnamectl: /^(status)?$/,
  find: /^(?!.*(^|\s)-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b)/, sed: /^(?!.*(^|\s)(-i|--in-place|-[a-hj-z]*i))/, awk: /^(?!.*(system\s*\(|>|\|\s*getline|print\s*>))/, mount: /^$/,
  kubectl: /^(get|describe|logs|top|version|cluster-info)\b/, nginx: /^-t\b/, git: /^(status|log|diff|show|rev-parse|branch)\b/,
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

/** Whether a command only reads (every part of a pipeline is a known read-only command). */
export function isReadOnly(command) {
  const segs = segments(String(command ?? '').trim());
  if (!segs || !segs.length) return false;
  return segs.every((seg) => {
    let s = seg.replace(/^(\w+=\S*\s+)+/, '');
    s = s.replace(/^sudo\s+(-n\s+)?/, '');
    const [head, ...rest] = s.split(/\s+/);
    const name = head.replace(/^.*\//, '');
    const args = rest.join(' ').replace(/\s*2>&1\s*/g, ' ').replace(/\s*2?>\s*\/dev\/null\s*/g, ' ').trim();
    if (name === 'tee' || name === 'xargs') return false;
    if (name === 'sort' && /(^|\s)(-o|--output)/.test(args)) return false;
    if (name === 'top' && !/-b/.test(args)) return false;
    if (SUB_READ_ONLY[name]) return SUB_READ_ONLY[name].test(args);
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-ops-scan-'));
  try {
    const f = path.join(tmp, 'known_hosts');
    const r = await runProgram(sshBinary(), ['-p', String(port), '-T', '-F', NUL, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${sshPath(f)}`, '-o', `GlobalKnownHostsFile=${NUL}`, '-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no', '-o', 'IdentityAgent=none', '-o', 'ConnectTimeout=8', '-o', 'LogLevel=ERROR', `hostkey-probe@${address}`, 'exit'], { timeoutMs: 20_000, signal });
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
  const node = process.execPath;
  if (process.platform === 'win32') {
    const js = path.join(dir, 'askpass.cjs');
    await fs.writeFile(js, 'process.stdout.write((process.env.HW_OPS_ASKPASS || "") + "\\n")\n');
    const cmd = path.join(dir, 'askpass.cmd');
    await fs.writeFile(cmd, `@"${node}" "${js}"\r\n`);
    return cmd;
  }
  const sh = path.join(dir, 'askpass.sh');
  await fs.writeFile(sh, `#!/bin/sh\nexec "${node}" -e 'process.stdout.write((process.env.HW_OPS_ASKPASS||"")+"\\n")'\n`, { mode: 0o700 });
  return sh;
}

/**
 * Runs `command` on host { address, port, user } with `secret` (a private key
 * or a password). Returns { code, stdout, stderr, firstUse, fingerprint?, keyChanged?, error? }.
 */
export async function sshRun({ address, port = 22, user, secret, command, knownHosts, timeoutMs = 60_000, signal, connectTimeout = 10 }) {
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
    args.push(`${user}@${address}`, '--', command);
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
