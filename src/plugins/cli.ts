// npm run plugin -- keygen <name> [--out dir]      writes <name>.key.pem (keep secret) and <name>.pub.pem
//                   sign <plugin-dir> --key <name>.key.pem
//                   verify <plugin-dir> --keys <pub.pem or folder>
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPair, loadTrustedKeys, signPlugin, verifyPlugin } from './signing.ts';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [cmd, target] = process.argv.slice(2);

if (cmd === 'keygen' && target) {
  const out = path.resolve(arg('out') ?? '.');
  const k = generateKeyPair();
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${target}.key.pem`), k.privatePem, { mode: 0o600 });
  await fs.writeFile(path.join(out, `${target}.pub.pem`), k.publicPem);
  console.log(`key ${k.keyId}: ${path.join(out, `${target}.key.pem`)} (secret) and ${path.join(out, `${target}.pub.pem`)} (give this to operators)`);
} else if (cmd === 'sign' && target && arg('key')) {
  const s = await signPlugin(path.resolve(target), await fs.readFile(arg('key')!, 'utf8'));
  console.log(`signed ${Object.keys(s.files).length} files with key ${s.keyId}`);
} else if (cmd === 'verify' && target && arg('keys')) {
  const v = await verifyPlugin(path.resolve(target), await loadTrustedKeys(path.resolve(arg('keys')!)));
  console.log(v.ok ? `OK: ${v.files} files, signed by ${v.keyName} (${v.keyId})` : `REFUSED: ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
} else {
  console.error('usage: npm run plugin -- keygen <name> [--out dir] | sign <dir> --key <x.key.pem> | verify <dir> --keys <pub.pem|dir>');
  process.exit(2);
}
