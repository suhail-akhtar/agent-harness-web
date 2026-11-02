// A companion's own key (docs/swarm/SWARM.md, phase 7, recommendations 5 and 6): an Ed25519 key made on the machine
// and never sent anywhere. The server pins its public key the first time the machine polls; from then on every
// result must be signed with it, and so is the policy the machine reports. A stolen token alone can then neither
// forge a machine's results nor pass for it (another key is refused), and what the server shows as "this machine
// allows" is what the machine signed.
import crypto from 'node:crypto';

/** What a result's signature covers: the job, whether it succeeded, and its value. */
export const resultPayload = (jobId: string, ok: boolean, value: unknown) => `harness-result\n${jobId}\n${ok ? 1 : 0}\n${crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')}`;
/** What a policy's signature covers. */
export const policyPayload = (policy: unknown) => `harness-policy\n${JSON.stringify(policy ?? null)}`;

export function sign(privateKeyPem: string, payload: string): string {
  return crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKeyPem)).toString('base64');
}

export function verify(publicKeyPem: string, payload: string, signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  try { return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, 'base64')); } catch { return false; }
}

/** A public key from a poll: an Ed25519 key in PEM, or undefined. */
export function cleanPublicKey(pem: unknown): string | undefined {
  if (typeof pem !== 'string' || pem.length > 1000 || !pem.includes('BEGIN PUBLIC KEY')) return undefined;
  try { return crypto.createPublicKey(pem).asymmetricKeyType === 'ed25519' ? crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString() : undefined; } catch { return undefined; }
}

/** The machine's key, made the first time (owner-only file), and its public half. */
export function machineKey(file: string, fs: typeof import('node:fs'), path: typeof import('node:path')): { privateKey: string; publicKey: string } {
  let privateKey = '';
  try { privateKey = fs.readFileSync(file, 'utf8'); crypto.createPrivateKey(privateKey); } catch {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
  }
  return { privateKey, publicKey: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() };
}
