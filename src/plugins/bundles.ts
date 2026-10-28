import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pack } from './archive.ts';
import { bundleInfo } from './bundle.ts';
import { findPluginDirs, readManifest } from './loader.ts';
import { signPlugin } from './signing.ts';

// Each plugin as its own installable bundle (`npm run plugin -- bundles`): <name>-<version>.tgz, signed when a
// key is given (in a copy: the source folder is left as it is), and an index.json listing them the way a
// catalogue does ({ plugins: [{ name, version, description, url, sha256 }] }) plus what the catalogue page
// shows (display name, solution, what it requires, publisher, tags). Serve the folder and point a server at
// it (HARNESS_PLUGIN_CATALOGUE=https://.../index.json), or import one file in the desktop app.

export interface WrittenBundle { name: string; version: string; file: string; size: number; sha256: string; signed: boolean }

export async function writeBundles(o: { from: string | string[]; out: string; base?: string; key?: string }): Promise<{ index: string; bundles: WrittenBundle[] }> {
  await fs.mkdir(o.out, { recursive: true });
  const bundles: WrittenBundle[] = [];
  const entries: Record<string, unknown>[] = [];
  const dirs = (await Promise.all((Array.isArray(o.from) ? o.from : [o.from]).map((f) => findPluginDirs(f)))).flat();
  for (const dir of dirs) {
    const m = await readManifest(dir).catch(() => undefined);
    if (!m) continue;
    let src = dir, tmp: string | undefined;
    if (o.key) {
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-bundle-'));
      src = path.join(tmp, m.name);
      await fs.cp(dir, src, { recursive: true });
      await signPlugin(src, o.key);
    }
    try {
      const data = await pack(src);
      const file = `${m.name}-${m.version ?? '0.0.0'}.tgz`;
      await fs.writeFile(path.join(o.out, file), data);
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      const info = await bundleInfo(m, dir);
      bundles.push({ name: m.name, version: m.version ?? '0.0.0', file, size: data.length, sha256, signed: !!o.key });
      entries.push({
        name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '',
        url: o.base ? new URL(file, o.base.replace(/\/?$/, '/')).toString() : file, sha256,
        displayName: info.displayName, ...(m.solution ? { solution: true } : {}), ...(m.requires?.length ? { requires: m.requires } : {}),
        ...(info.publisher ? { publisher: info.publisher.name } : {}), ...(info.license ? { license: info.license } : {}), tags: info.tags,
        ...(info.compat.harness ? { harness: info.compat.harness } : {}),
      });
    } finally { if (tmp) await fs.rm(tmp, { recursive: true, force: true }); }
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const index = path.join(o.out, 'index.json');
  await fs.writeFile(index, JSON.stringify({ plugins: entries }, null, 2));
  return { index, bundles };
}
