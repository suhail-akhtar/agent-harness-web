// Plugin signatures: Ed25519 over the SHA-256 of every file in the plugin
// folder. A plugin's code runs in the server, so an operator can require that
// every plugin they did not ship themselves is signed by a key they trust:
// any added, removed or changed file breaks the signature.
//
//   harness-plugin.sig  { "keyId", "signedAt", "files": { "<path>": "<sha256>" }, "signature" }

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const SIG_FILE = 'harness-plugin.sig';
const SKIP = new Set([SIG_FILE, '.git', 'node_modules', '.DS_Store']);

export interface PluginSignature { keyId: string; signedAt: string; files: Record<string, string>; signature: string }
export interface TrustedKey { keyId: string; name: string; key: crypto.KeyObject }
export type Verdict = { ok: true; keyId: string; keyName: string; files: number } | { ok: false; reason: string; keyId?: string };

export function keyIdOf(pub: crypto.KeyObject): string {
  return crypto.createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

export function generateKeyPair(): { privatePem: string; publicPem: string; keyId: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    keyId: keyIdOf(publicKey),
  };
}

/** Every file under the plugin folder (symlinks refused: what is signed must be what loads). */
export async function hashTree(dir: string, rel = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await fs.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!rel && SKIP.has(e.name)) continue;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`${r} is a symbolic link; signed plugins cannot contain links`);
    if (e.isDirectory()) Object.assign(out, await hashTree(dir, r));
    else if (e.isFile()) out[r] = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, r))).digest('hex');
  }
  return out;
}

/** The exact bytes that are signed: one "<sha256>  <path>" line per file, sorted by path. */
const canonical = (files: Record<string, string>) => Object.keys(files).sort().map((p) => `${files[p]}  ${p}\n`).join('');

export async function signPlugin(dir: string, privatePem: string): Promise<PluginSignature> {
  const key = crypto.createPrivateKey(privatePem);
  const files = await hashTree(dir);
  const sig: PluginSignature = {
    keyId: keyIdOf(crypto.createPublicKey(key)),
    signedAt: new Date().toISOString(),
    files,
    signature: crypto.sign(null, Buffer.from(canonical(files)), key).toString('base64'),
  };
  await fs.writeFile(path.join(dir, SIG_FILE), JSON.stringify(sig, null, 1) + '\n');
  return sig;
}

/** Public keys (*.pub.pem or *.pem) from a folder or a single file. */
export async function loadTrustedKeys(where: string): Promise<TrustedKey[]> {
  const st = await fs.stat(where);
  const files = st.isDirectory() ? (await fs.readdir(where)).filter((f) => f.endsWith('.pem')).map((f) => path.join(where, f)) : [where];
  const keys: TrustedKey[] = [];
  for (const f of files) {
    const pem = await fs.readFile(f, 'utf8');
    if (/PRIVATE KEY/.test(pem)) throw new Error(`${f} is a private key; trust lists hold public keys only`);
    const key = crypto.createPublicKey(pem);
    keys.push({ keyId: keyIdOf(key), name: path.basename(f).replace(/(\.pub)?\.pem$/, ''), key });
  }
  return keys;
}

export async function verifyPlugin(dir: string, trusted: TrustedKey[]): Promise<Verdict> {
  let sig: PluginSignature;
  try { sig = JSON.parse(await fs.readFile(path.join(dir, SIG_FILE), 'utf8')) as PluginSignature; } catch { return { ok: false, reason: 'not signed' }; }
  const key = trusted.find((k) => k.keyId === sig.keyId);
  if (!key) return { ok: false, reason: `signed by an untrusted key (${sig.keyId})`, keyId: sig.keyId };
  if (!crypto.verify(null, Buffer.from(canonical(sig.files ?? {})), key.key, Buffer.from(String(sig.signature), 'base64'))) {
    return { ok: false, reason: 'the signature does not match its file list', keyId: sig.keyId };
  }
  let now: Record<string, string>;
  try { now = await hashTree(dir); } catch (e) { return { ok: false, reason: (e as Error).message, keyId: sig.keyId }; }
  const changed = Object.keys(sig.files).filter((p) => now[p] !== undefined && now[p] !== sig.files[p]);
  const missing = Object.keys(sig.files).filter((p) => now[p] === undefined);
  const added = Object.keys(now).filter((p) => sig.files[p] === undefined);
  if (changed.length || missing.length || added.length) {
    const say = (label: string, xs: string[]) => (xs.length ? `${label}: ${xs.slice(0, 5).join(', ')}${xs.length > 5 ? ` (+${xs.length - 5})` : ''}` : '');
    return { ok: false, reason: `files differ from what was signed - ${[say('changed', changed), say('missing', missing), say('added', added)].filter(Boolean).join('; ')}`, keyId: sig.keyId };
  }
  return { ok: true, keyId: sig.keyId, keyName: key.name, files: Object.keys(now).length };
}
