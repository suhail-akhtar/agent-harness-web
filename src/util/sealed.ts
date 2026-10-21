import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Secrets at rest: AES-256-GCM under the server's key. The key is
// HARNESS_SECRET_KEY (a long random string, e.g. `openssl rand -hex 32`; it is
// hashed to 256 bits), else a key generated on first use and kept in
// <data>/secret.key (owner-only). Whoever can read that file - or the server's
// environment - can read the secrets: it guards against a copied data folder,
// a backup or a stray `cat`, not against the server's own account. A headless
// server has no OS keychain to put the key in.

const KEY_FILE = 'secret.key';
const PREFIX = 'aes256gcm:v1:';

export class SealError extends Error {}

/** The server's key: from HARNESS_SECRET_KEY, else the data folder's key file (made 0600 when missing). */
export async function serverKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  const fromEnv = env.HARNESS_SECRET_KEY?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new SealError('HARNESS_SECRET_KEY is too short: use at least 32 random characters (e.g. openssl rand -hex 32).');
    return crypto.createHash('sha256').update(fromEnv).digest();
  }
  const file = path.join(dataDir, KEY_FILE);
  try {
    const k = Buffer.from((await fs.readFile(file, 'utf8')).trim(), 'base64');
    if (k.length !== 32) throw new SealError(`${file} does not hold a 32-byte key (base64).`);
    return k;
  } catch (e) {
    if (e instanceof SealError || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  await fs.mkdir(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  try {
    // "wx": two processes starting at once do not each make a key.
    await fs.writeFile(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return serverKey(dataDir, env);
    throw e;
  }
}

/** Encrypts text: "aes256gcm:v1:" + base64(iv | tag | ciphertext). */
export function seal(key: Buffer, text: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** Decrypts what seal made; a wrong key or a changed value is an error, never garbage. */
export function unseal(key: Buffer, sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new SealError('not a sealed value');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64');
  if (raw.length < 28) throw new SealError('the sealed value is damaged');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  try { return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'); } catch { throw new SealError('cannot decrypt: the server key (HARNESS_SECRET_KEY or secret.key) is not the one it was sealed with'); }
}

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
