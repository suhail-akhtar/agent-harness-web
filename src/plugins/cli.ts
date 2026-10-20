// npm run plugin -- keygen <name> [--out dir]      writes <name>.key.pem (keep secret) and <name>.pub.pem
//                   sign <plugin-dir> --key <name>.key.pem
//                   verify <plugin-dir> --keys <pub.pem or folder>
//                   pack <plugin-dir> [--out file.tgz]   an archive for a remote catalogue (sign first)
//                   index <folder of .tgz> [--base url]   writes index.json for those archives
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pack, unpack } from './archive.ts';
import { readManifest } from './loader.ts';
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
} else if (cmd === 'pack' && target) {
  const dir = path.resolve(target);
  const m = await readManifest(dir);
  if (!m) { console.error(`no harness-plugin.json in ${dir}`); process.exit(1); }
  const out = path.resolve(arg('out') ?? `${m.name}-${m.version ?? '0.0.0'}.tgz`);
  const data = await pack(dir);
  await fs.writeFile(out, data);
  console.log(`${out}\nsha256 ${crypto.createHash('sha256').update(data).digest('hex')}`);
} else if (cmd === 'index' && target) {
  const dir = path.resolve(target);
  const plugins = [];
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.tgz')).sort()) {
    const data = await fs.readFile(path.join(dir, f));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-index-'));
    try {
      await unpack(data, path.join(tmp, 'p'));
      const m = await readManifest(path.join(tmp, 'p'));
      if (!m) { console.error(`skipped ${f}: no harness-plugin.json`); continue; }
      plugins.push({ name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '', url: arg('base') ? new URL(f, arg('base')!.replace(/\/?$/, '/')).toString() : f, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ plugins }, null, 2));
  console.log(`index.json: ${plugins.length} plugin(s)`);
} else {
  console.error('usage: npm run plugin -- keygen <name> [--out dir] | sign <dir> --key <x.key.pem> | verify <dir> --keys <pub.pem|dir> | pack <dir> [--out f.tgz] | index <dir> [--base url]');
  process.exit(2);
}
