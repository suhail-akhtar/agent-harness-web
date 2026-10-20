import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function files(dir: string, exts: string[], out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', '.harness-data', '.work'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await files(p, exts, out);
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

test('scripts and sources use LF line endings (a Windows checkout runs them in Linux containers)', async () => {
  const attrs = await fs.readFile(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attrs, /^\*\s+text=auto\s+eol=lf$/m);
  const crlf: string[] = [];
  for (const f of await files(root, ['.sh', '.mjs', '.ts', '.json', '.yml'])) {
    if ((await fs.readFile(f)).includes('\r\n')) crlf.push(path.relative(root, f));
  }
  assert.deepEqual(crlf, []);
});
