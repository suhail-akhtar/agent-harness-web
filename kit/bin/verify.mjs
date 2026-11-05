// harness verify: is this kit, file for file, what the publisher signed?
//   --key k.pem      trust this public key instead of the kit's own keys/ (the stronger check: see SECURITY.md)
//   --archive f.tgz  check an archive against its f.tgz.sig.json instead, before unpacking it
//   --lock           after a good check, make every file read-only
//   --quiet          say nothing when it passes
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrustedKeys, verifyPlugin } from '../src/plugins/signing.ts';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const quiet = argv.includes('--quiet');
const fail = (m) => { console.error(`NOT VERIFIED: ${m}`); process.exit(1); };
const trusted = await loadTrustedKeys(arg('--key') ? path.resolve(arg('--key')) : path.join(kit, 'keys'));

if (arg('--archive')) {
  const file = path.resolve(arg('--archive'));
  let sig;
  try { sig = JSON.parse(fs.readFileSync(`${file}.sig.json`, 'utf8')); } catch { fail(`${path.basename(file)} has no ${path.basename(file)}.sig.json`); }
  const key = trusted.find((k) => k.keyId === sig.keyId);
  if (!key) fail(`signed by an untrusted key (${sig.keyId})`);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (sha256 !== sig.sha256) fail('the archive differs from what was signed');
  if (!crypto.verify(null, Buffer.from(sig.sha256), key.key, Buffer.from(String(sig.signature), 'base64'))) fail('the signature does not match');
  console.log(`verified: ${path.basename(file)}, signed by ${key.name} (key ${key.keyId}), sha256 ${sha256}`);
  process.exit(0);
}

const v = await verifyPlugin(kit, trusted);
if (!v.ok) fail(v.reason);
if (argv.includes('--lock')) {
  const lock = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) lock(p); else fs.chmodSync(p, 0o444); } };
  lock(kit);
}
if (!quiet) console.log(`verified: ${v.files} files, signed by ${v.keyName} (key ${v.keyId})${argv.includes('--lock') ? ', now read-only' : ''}`);
