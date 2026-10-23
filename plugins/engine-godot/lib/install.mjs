// Installs the official Godot 4 build and its export templates into the harness's engines
// folder (<home>/engines/godot/<version>/), as the person approved: only from the
// godotengine/godot GitHub releases, every archive checked against the release's
// SHA512-SUMS.txt before it is opened, and nothing downloaded is run except that Godot.
//
// Each build sits in its own folder with an `_sc_` file beside the binary: Godot's
// self-contained mode, so its settings and export templates live in editor_data/ next to
// it and nothing is written to the person's own Godot folders.
//
//   <engines>/godot/4.7.2/engine.json         what is installed (lib-engines reads it)
//   <engines>/godot/4.7.2/windows/Godot_v4.7.2-stable_win64.exe (+ the _console wrapper, _sc_)
//   <engines>/godot/4.7.2/windows/editor_data/export_templates/4.7.2.stable/...
//   <engines>/godot/4.7.2/linux/Godot_v4.7.2-stable_linux.x86_64 (+ _sc_, editor_data/...)

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { enginesDir, installedEngines, platformKey } from '../../games3d/lib-engines.mjs';
import { extractZip, zipEntries } from './zip.mjs';

export const RELEASES_API = 'https://api.github.com/repos/godotengine/godot/releases';
/** The only place archives come from. */
export const OFFICIAL_DOWNLOADS = 'https://github.com/godotengine/godot/releases/download/';
/** Hosts the downloads go through (GitHub redirects release assets to its storage). */
export const NETWORK_HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

/** The builds per machine: the release asset, the files kept from it, the binary to run. */
export const BUILDS = {
  'win32-x64': { folder: 'windows', asset: (v) => `Godot_v${v}-stable_win64.exe.zip`, keep: (n) => /^Godot_v[^/]*_win64(_console)?\.exe$/.test(n), bin: (v) => `Godot_v${v}-stable_win64.exe` },
  // The main .exe, not the _console wrapper: the wrapper fails to start it from a path with a space
  // (CreateProcess error 193), and the main .exe writes to the pipes it is given.
  'linux-x64': { folder: 'linux', asset: (v) => `Godot_v${v}-stable_linux.x86_64.zip`, keep: (n) => /^Godot_v[^/]*_linux\.x86_64$/.test(n), bin: (v) => `Godot_v${v}-stable_linux.x86_64` },
  'darwin-x64': { folder: 'macos', asset: (v) => `Godot_v${v}-stable_macos.universal.zip`, keep: (n) => n.startsWith('Godot.app/'), bin: () => 'Godot.app/Contents/MacOS/Godot', sc: 'Godot.app/Contents/MacOS' },
};
BUILDS['darwin-arm64'] = BUILDS['darwin-x64'];
/** Short names people use for the builds. */
export const PLATFORM_NAMES = { windows: 'win32-x64', linux: 'linux-x64', macos: 'darwin-arm64', mac: 'darwin-arm64' };

/** Export templates by target: the files of the .tpz's templates/ folder each set keeps. */
export const TEMPLATE_SETS = {
  windows: (n) => /^windows_(debug|release)_x86_64(_console)?\.exe$/.test(n),
  web: (n) => /^web(_nothreads)?_(debug|release)\.zip$/.test(n),
  linux: (n) => /^linux_(debug|release)\.x86_64$/.test(n),
  macos: (n) => n === 'macos.zip',
};
const ALWAYS = (n) => n === 'version.txt' || n === 'icudt_godot.dat';

/** The default builds for this machine: its own, plus Linux for a sandbox. */
export function defaultPlatforms(key = platformKey()) {
  const own = BUILDS[key] ? [key] : [];
  return [...new Set([...own, 'linux-x64'])];
}

/** The default template sets: Windows desktop and the Web (and Linux, for sandboxes and servers). */
export const DEFAULT_TEMPLATES = ['windows', 'web', 'linux'];

const stableTag = (v) => /^4\.\d+(\.\d+)?$/.test(v);

/**
 * The release to install: the newest stable 4.x (by version, not by date), or the one asked
 * for ("4.7.2"). Returns { version, tag, assets: Map(name -> { url, size }) }.
 */
export async function findRelease(fetchFn, version = 'latest') {
  const ask = async (url) => {
    const r = await fetchFn(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'harness-engine-godot' } });
    if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${url}`);
    return r.json();
  };
  let rel;
  if (version && version !== 'latest') {
    const v = String(version).replace(/-stable$/, '');
    if (!stableTag(v)) throw new Error(`"${version}" is not a stable Godot 4 version (e.g. 4.7.2)`);
    rel = await ask(`${RELEASES_API}/tags/${v}-stable`);
  } else {
    const list = await ask(`${RELEASES_API}?per_page=40`);
    const stable = (Array.isArray(list) ? list : []).filter((r) => !r.draft && !r.prerelease && /^4\.\d+(\.\d+)?-stable$/.test(r.tag_name));
    stable.sort((a, b) => b.tag_name.localeCompare(a.tag_name, 'en', { numeric: true }));
    rel = stable[0];
    if (!rel) throw new Error('no stable Godot 4 release found on GitHub');
  }
  const v = String(rel.tag_name).replace(/-stable$/, '');
  const assets = new Map();
  for (const a of rel.assets ?? []) {
    const url = String(a.browser_download_url ?? '');
    // Only the release's own files on the official download path.
    if (url === `${OFFICIAL_DOWNLOADS}${rel.tag_name}/${a.name}`) assets.set(a.name, { url, size: Number(a.size) || 0 });
  }
  return { version: v, tag: rel.tag_name, assets };
}

/** SHA512-SUMS.txt as a map of file name -> hex digest. */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{128})\s+\*?(\S.*)$/i.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** Downloads one asset to `file`, hashing as it goes; keeps it only when the SHA-512 matches. */
export async function download(fetchFn, asset, file, sha512, { signal, onProgress } = {}) {
  if (!sha512) throw new Error(`${path.basename(file)} is not in the release's SHA512-SUMS.txt: not downloaded`);
  // A verified copy from an interrupted install is used again.
  if (fs.existsSync(file) && await hashFile(file) === sha512) return { reused: true, bytes: (await fsp.stat(file)).size };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const r = await fetchFn(asset.url, { signal, headers: { 'user-agent': 'harness-engine-godot' } });
  if (!r.ok || !r.body) throw new Error(`download failed: ${r.status} for ${asset.url}`);
  const hash = crypto.createHash('sha512');
  let bytes = 0;
  let last = 0;
  const partial = `${file}.partial`;
  const counted = Readable.fromWeb(r.body).map((chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
    if (onProgress && bytes - last > 50 * 1048576) { last = bytes; onProgress(bytes, asset.size); }
    return chunk;
  });
  try { await pipeline(counted, fs.createWriteStream(partial), { signal }); } catch (e) { await fsp.rm(partial, { force: true }); throw e; }
  const got = hash.digest('hex');
  if (got !== sha512) { await fsp.rm(partial, { force: true }); throw new Error(`${path.basename(file)}: SHA-512 mismatch (got ${got.slice(0, 16)}..., the release says ${sha512.slice(0, 16)}...): removed, nothing installed`); }
  await fsp.rename(partial, file);
  return { reused: false, bytes };
}

export async function hashFile(file) {
  const hash = crypto.createHash('sha512');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

/** Hard links a file (no copy, no symlink); copies when the folders are on different drives. */
async function linkOrCopy(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rm(to, { force: true });
  try { await fsp.link(from, to); } catch { await fsp.copyFile(from, to); }
}

/**
 * Installs Godot. platforms: install keys (win32-x64, linux-x64, darwin-arm64) or names
 * (windows, linux, macos); templates: set names (windows, web, linux, macos) or [] for none.
 * What is already there and complete is kept. Returns the engine.json written.
 */
export async function installGodot({ fetch: fetchFn, version = 'latest', platforms, templates = DEFAULT_TEMPLATES, dir = enginesDir(), signal, log = () => {} }) {
  const keys = [...new Set((platforms?.length ? platforms : defaultPlatforms()).map((p) => PLATFORM_NAMES[p] ?? p))];
  for (const k of keys) if (!BUILDS[k]) throw new Error(`no official Godot build for ${k} (choose from windows, linux, macos)`);
  const sets = [...new Set(templates ?? [])];
  for (const s of sets) if (!TEMPLATE_SETS[s]) throw new Error(`unknown template set ${s} (choose from ${Object.keys(TEMPLATE_SETS).join(', ')})`);
  const rel = await findRelease(fetchFn, version);
  const v = rel.version;
  const root = path.join(dir, 'godot', v);
  const downloads = path.join(root, '.downloads');
  const sumsAsset = rel.assets.get('SHA512-SUMS.txt');
  if (!sumsAsset) throw new Error(`the ${rel.tag} release has no SHA512-SUMS.txt: nothing is installed without it`);
  const sr = await fetchFn(sumsAsset.url, { signal, headers: { 'user-agent': 'harness-engine-godot' } });
  if (!sr.ok) throw new Error(`could not read SHA512-SUMS.txt (${sr.status})`);
  const sums = parseSums(await sr.text());
  const previous = installedEngines('godot', dir).find((e) => e.version === v);
  const manifest = { name: 'godot', version: v, tag: rel.tag, source: `${OFFICIAL_DOWNLOADS}${rel.tag}/`, binaries: { ...(previous?.binaries ?? {}) }, sha512: { ...(previous?.sha512 ?? {}) }, templates: previous?.templates ?? null };
  const report = { version: v, downloaded: [], reused: [], kept: [], dir: root };
  const fetchAsset = async (name) => {
    const asset = rel.assets.get(name);
    if (!asset) throw new Error(`the ${rel.tag} release has no ${name}`);
    const file = path.join(downloads, name);
    log(`downloading ${name} (${(asset.size / 1048576).toFixed(0)} MB)`);
    const d = await download(fetchFn, asset, file, sums.get(name), { signal, onProgress: (b, t) => log(`${name}: ${(b / 1048576).toFixed(0)} of ${(t / 1048576).toFixed(0)} MB`) });
    (d.reused ? report.reused : report.downloaded).push(name);
    manifest.sha512[name] = sums.get(name);
    return file;
  };

  for (const k of keys) {
    const b = BUILDS[k];
    const binRel = `${b.folder}/${b.bin(v)}`;
    if (fs.existsSync(path.join(root, binRel))) { report.kept.push(binRel); manifest.binaries[k] = binRel; continue; }
    const zip = await fetchAsset(b.asset(v));
    const dest = path.join(root, b.folder);
    await extractZip(zip, (n) => (b.keep(n) ? path.join(dest, n) : null), { signal });
    if (!fs.existsSync(path.join(root, binRel))) throw new Error(`${b.asset(v)} did not hold ${b.bin(v)}`);
    // Self-contained: settings and templates in editor_data/ beside the binary.
    await fsp.writeFile(path.join(dest, b.sc ?? '', '_sc_'), '');
    if (process.platform !== 'win32') await fsp.chmod(path.join(root, binRel), 0o755);
    manifest.binaries[k] = binRel;
    await fsp.rm(zip, { force: true });
  }

  if (sets.length) {
    const want = (n) => ALWAYS(n) || sets.some((s) => TEMPLATE_SETS[s](n));
    const have = manifest.templates;
    const missingSet = !have || sets.some((s) => !have.sets?.includes(s)) || !have.files?.every((f) => fs.existsSync(path.join(root, f)));
    if (missingSet) {
      const tpz = await fetchAsset(`Godot_v${v}-stable_export_templates.tpz`);
      const staging = path.join(root, '.templates');
      const names = (await zipEntries(tpz)).map((e) => e.name).filter((n) => n.startsWith('templates/') && want(n.slice(10)));
      await extractZip(tpz, (n) => (names.includes(n) ? path.join(staging, n.slice(10)) : null), { signal });
      const tv = (await fsp.readFile(path.join(staging, 'version.txt'), 'utf8')).trim();
      const files = [];
      for (const k of Object.keys(manifest.binaries)) {
        const b = BUILDS[k];
        const tdir = path.join(root, b.folder, b.sc ?? '', 'editor_data', 'export_templates', tv);
        for (const f of await fsp.readdir(staging)) await linkOrCopy(path.join(staging, f), path.join(tdir, f));
        files.push(...(await fsp.readdir(tdir)).map((f) => path.relative(root, path.join(tdir, f)).split(path.sep).join('/')));
      }
      // Staged files are hard links to the ones kept: only the names go.
      await fsp.rm(staging, { recursive: true, force: true });
      manifest.templates = { version: tv, sets: [...new Set([...(have?.sets ?? []), ...sets])], files };
      await fsp.rm(tpz, { force: true });
    } else report.kept.push(`templates ${have.version}`);
  }
  await fsp.rm(downloads, { recursive: true, force: true });
  manifest.installedAt = new Date().toISOString();
  await fsp.writeFile(path.join(root, 'engine.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  return { manifest, report };
}

/** The templates folder Godot reads for this binary (self-contained or the user's), and whether it has the files a target needs. */
export function templatesFor(bin, version, { env = process.env, platform = process.platform, home = env.USERPROFILE ?? env.HOME ?? '' } = {}) {
  const tv = /^\d+\.\d+(\.\d+)?\.\w+$/.test(version) ? version : `${version}.stable`;
  const own = path.join(path.dirname(bin), 'editor_data', 'export_templates', tv);
  const sc = fs.existsSync(path.join(path.dirname(bin), '_sc_')) || fs.existsSync(path.join(path.dirname(bin), '._sc_'));
  const user = platform === 'win32' ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Godot', 'export_templates', tv)
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Godot', 'export_templates', tv)
      : path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'godot', 'export_templates', tv);
  const folder = sc ? own : user;
  let files = [];
  try { files = fs.readdirSync(folder); } catch { /* none */ }
  const targets = Object.keys(TEMPLATE_SETS).filter((s) => files.some((f) => TEMPLATE_SETS[s](f)));
  return { folder, selfContained: sc, files, targets };
}
