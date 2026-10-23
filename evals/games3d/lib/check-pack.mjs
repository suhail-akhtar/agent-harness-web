// Hidden check for the asset-pack eval: at least N assets in the pack, each with a licence and a
// preview or main image, all of one kind family, one frame size, and one palette: the colours of
// every main image are close to the union of the pack's (no asset in a palette of its own).
//   node check-pack.mjs [--count 5]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { decodePNG } = await import(pathToFileURL(path.join(repo, 'plugins/games3d/assets/raster/png.mjs')).href);
const args = process.argv.slice(2);
const count = Number(args[args.indexOf('--count') + 1] ?? 5) || 5;
const root = process.cwd();
const problems = [];
const plan = JSON.parse(await fs.readFile(path.join(root, 'design', 'asset-plan.json'), 'utf8').catch(() => '{"assets": []}'));
const ids = (plan.assets ?? plan).map((a) => a.id).filter(Boolean);
if (ids.length < count) problems.push(`the plan has ${ids.length} assets, the brief asked for ${count}`);
const manifests = [];
for (const id of ids) {
  const m = JSON.parse(await fs.readFile(path.join(root, '.studio', 'assets', id, 'asset.json'), 'utf8').catch(() => 'null'));
  if (!m) { problems.push(`${id}: not made`); continue; }
  if (!m.license?.id) problems.push(`${id}: no licence`);
  manifests.push(m);
}
const sizes = new Set(manifests.filter((m) => m.meta?.frameSize).map((m) => m.meta.frameSize.join('x')));
if (sizes.size > 1) problems.push(`the pack mixes frame sizes: ${[...sizes].join(', ')}`);
const dims = new Set(manifests.map((m) => m.dimension));
if (dims.size > 1) problems.push(`the pack mixes 2D and 3D: ${[...dims].join(', ')}`);
// Palette: each asset's colours (quantized to 4 bits a channel) mostly come from colours other assets use too.
const sets = [];
for (const m of manifests) {
  const f = m.files.find((x) => x.role === 'main' && /\.png$/i.test(x.path));
  if (!f) continue;
  const img = decodePNG(await fs.readFile(path.join(root, '.studio', 'assets', m.id, f.path)));
  const s = new Map();
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3] > 128) { const k = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4); s.set(k, (s.get(k) ?? 0) + 1); }
  sets.push({ id: m.id, s });
}
for (const a of sets) {
  const others = new Set(sets.filter((b) => b !== a).flatMap((b) => [...b.s.keys()]));
  let shared = 0, total = 0;
  for (const [k, n] of a.s) { total += n; if (others.has(k)) shared += n; }
  if (sets.length > 1 && total && shared / total < 0.25) problems.push(`${a.id}: only ${Math.round((shared / total) * 100)}% of its pixels use colours the rest of the pack uses (its own palette)`);
}
console.log(`${manifests.length} assets: ${manifests.map((m) => `${m.id} (${m.kind})`).join(', ')}`);
if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1; } else console.log('a consistent pack');
