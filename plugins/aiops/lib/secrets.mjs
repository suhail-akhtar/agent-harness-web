// Credentials for hosts and endpoints, and keeping them out of everything the
// model sees. The framework Key Vault (ctx.services.vault) is the source; until
// a harness has one, the operator's HARNESS_OPS_SECRETS (a declared secret: a
// JSON object of name -> value, or @<file> holding one) stands in for it.
// Values are used here, on the server, and never returned in a tool result:
// every output that leaves this plugin goes through redact() first.

import fs from 'node:fs/promises';

/** Whether this plugin may read a vault name (harness-plugin.json permissions.vault). */
export function vaultAllowed(name, patterns) {
  return patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

export class CredentialError extends Error {}

/**
 * Reads one credential by name. `secret` is the plugin's api.secret (declared
 * names only). Every value revealed is remembered in `seen` so redact() can
 * take it out of outputs.
 */
export async function revealCredential(name, { services, secret, patterns, purpose, seen }) {
  if (!vaultAllowed(name, patterns)) throw new CredentialError(`credential "${name}" is outside what the aiops plugin may read (permissions.vault: ${patterns.join(', ')}). Rename it in the vault and the inventory.`);
  const vault = services?.vault;
  let value;
  // The vault first; the operator's HARNESS_OPS_SECRETS when the vault has no such entry
  // (or there is no vault). Any other vault refusal (a permission, a broken key) stands.
  if (vault && typeof vault.reveal === 'function') {
    try { value = await vault.reveal(name, purpose); } catch (e) {
      if (!/no vault entry named/i.test(e.message) || !secret('HARNESS_OPS_SECRETS')) throw new CredentialError(`the Key Vault did not give "${name}": ${e.message}`);
    }
  }
  if (value === undefined) {
    const raw = secret('HARNESS_OPS_SECRETS');
    if (!raw) throw new CredentialError(`credential "${name}" is not available: ${vault ? 'it is not in the Key Vault' : 'this harness has no Key Vault'}, and the operator has not set HARNESS_OPS_SECRETS (a JSON object of name: value, or @<path to a JSON file>).`);
    let obj;
    try { obj = JSON.parse(raw.startsWith('@') ? await fs.readFile(raw.slice(1), 'utf8') : raw); } catch (e) { throw new CredentialError(`HARNESS_OPS_SECRETS could not be read as JSON (${e.code ?? 'parse error'})`); }
    value = obj?.[name];
    if (typeof value !== 'string' || !value) throw new CredentialError(`credential "${name}" is not in HARNESS_OPS_SECRETS (it has ${Object.keys(obj ?? {}).length} entries)`);
  }
  if (typeof value !== 'string' || !value) throw new CredentialError(`credential "${name}" is empty`);
  seen?.add(value);
  return value;
}

/** Names of the credentials the vault holds that this plugin may read (no values). */
export async function listCredentials(services, patterns) {
  const vault = services?.vault;
  if (!vault || typeof vault.list !== 'function') return undefined;
  const all = await vault.list();
  return all.filter((e) => vaultAllowed(e.name, patterns));
}

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/g,
  /\bsk-(ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
];
const ASSIGN = /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*)(\s*[=:]\s*)("?)([^\s"']{4,})\3/gi;

/** Takes known secret values and anything shaped like a credential out of text. */
export function redact(text, seen = new Set()) {
  let s = String(text ?? '');
  for (const v of seen) {
    if (!v || v.length < 4) continue;
    s = s.split(v).join('[REDACTED]');
    // A key file's body lines can show up alone (an error quoting part of it).
    if (v.includes('\n')) for (const line of v.split('\n')) if (line.trim().length >= 24 && !/^-----/.test(line.trim())) s = s.split(line.trim()).join('[REDACTED]');
  }
  for (const p of PATTERNS) s = s.replace(p, '[REDACTED]');
  s = s.replace(ASSIGN, (_m, k, sep) => `${k}${sep}[REDACTED]`);
  return s;
}

/** Environment variable names that look like they hold secrets. */
export const secretName = (k) => /PASS|SECRET|TOKEN|API_?KEY|PRIVATE|CREDENTIAL|ACCESS_?KEY|AUTH/i.test(k);
