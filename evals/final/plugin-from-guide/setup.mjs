// Before the agent starts: the guide and the two example plugins, as a newcomer would have them (the current ones, never a stale copy).
//   node setup.mjs <workspace>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ws = path.resolve(process.argv[2] ?? '.');
fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
fs.copyFileSync(path.join(repo, 'docs', 'BUILD-A-PLUGIN.md'), path.join(ws, 'docs', 'BUILD-A-PLUGIN.md'));
for (const p of ['acme', 'hello-frame']) fs.cpSync(path.join(repo, 'examples', 'plugins', p), path.join(ws, 'examples', p), { recursive: true });
console.log('guide and examples in place');
