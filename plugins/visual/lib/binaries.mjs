// Finds the converters the render tool uses, and Blender and Godot for the
// games3d plugin, on Linux, macOS and Windows. On Windows and macOS they usually
// live in an install folder, not on the PATH. HARNESS_<NAME> (e.g.
// HARNESS_SOFFICE, HARNESS_BLENDER, HARNESS_GODOT) points at one explicitly.

import fs from 'node:fs';
import path from 'node:path';

const HINTS = {
  soffice: { what: 'LibreOffice', win: 'install it from https://www.libreoffice.org (or: winget install TheDocumentFoundation.LibreOffice)', mac: 'brew install --cask libreoffice', linux: 'apt install libreoffice-writer libreoffice-impress libreoffice-calc' },
  pdftoppm: { what: 'poppler', win: 'winget install oschwartz10612.Poppler (or: scoop install poppler), then reopen the terminal', mac: 'brew install poppler', linux: 'apt install poppler-utils' },
  pandoc: { what: 'pandoc', win: 'winget install JohnMacFarlane.Pandoc', mac: 'brew install pandoc', linux: 'apt install pandoc' },
  blender: { what: 'Blender', win: 'winget install BlenderFoundation.Blender.LTS.4.2 (or download it from https://www.blender.org)', mac: 'brew install --cask blender', linux: 'download the Linux build from https://www.blender.org into /opt/blender, or use the 3D sandbox image (npm run sandbox:image:3d)' },
  godot: { what: 'Godot 4', win: 'winget install GodotEngine.GodotEngine (or download it from https://godotengine.org)', mac: 'brew install --cask godot', linux: 'download Godot 4 from https://godotengine.org to /usr/local/bin/godot, or use the 3D sandbox image (npm run sandbox:image:3d)' },
};
HINTS.pdfinfo = HINTS.pdftoppm;
HINTS.pdftotext = HINTS.pdftoppm;

/** Other names a program goes by on the PATH. Godot ships as Godot_v4.x-stable_<platform>[.exe]. */
const ALIASES = { godot: ['godot4'] };
const PATTERNS = { godot: /^godot_v4(?![\w.-]*\.(zip|tpz)$)[\w.-]*$/i };

/** Newest first: "Blender 4.10" before "Blender 4.2". */
const newestFirst = (names) => [...names].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
/** Godot downloads, newest first; of one version the console build first (a pipe can read its output). */
const godotFirst = (names) => names.filter((n) => PATTERNS.godot.test(n)).sort((a, b) => {
  const key = (n) => n.replace(/_console/i, '');
  return key(b).localeCompare(key(a), 'en', { numeric: true }) || Number(/_console/i.test(b)) - Number(/_console/i.test(a));
});

/** Standard install folders to look in, per platform. */
function places(name, platform, env, listDir) {
  if (platform === 'win32') {
    const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
    const user = [env.LOCALAPPDATA, env.USERPROFILE].filter(Boolean);
    if (name === 'soffice') return pf.map((p) => path.win32.join(p, 'LibreOffice', 'program', 'soffice.exe'));
    if (name === 'blender') {
      // The installer and winget: "Blender Foundation\Blender 4.2\blender.exe"; scoop: apps\blender\current.
      const found = pf.flatMap((p) => {
        const base = path.win32.join(p, 'Blender Foundation');
        return newestFirst(listDir(base).filter((d) => /^blender/i.test(d))).map((d) => path.win32.join(base, d, 'blender.exe'));
      });
      return [...found, ...(env.USERPROFILE ? [path.win32.join(env.USERPROFILE, 'scoop', 'apps', 'blender', 'current', 'blender.exe')] : [])];
    }
    if (name === 'godot') {
      // Godot is a single exe people keep anywhere; these are the usual spots,
      // plus winget's portable package folder and its command links, and scoop.
      const dirs = [
        ...pf.map((p) => path.win32.join(p, 'Godot')),
        ...user.flatMap((u) => [path.win32.join(u, 'Godot'), path.win32.join(u, 'Programs', 'Godot')]),
        ...(env.LOCALAPPDATA ? listDir(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')).filter((d) => /godot/i.test(d)).map((d) => path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', d)) : []),
      ];
      const links = [
        env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'godot.exe'),
        env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop', 'shims', 'godot.exe'),
        env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop', 'apps', 'godot', 'current', 'godot.exe'),
      ].filter(Boolean);
      return [...dirs.flatMap((d) => godotFirst(listDir(d)).map((f) => path.win32.join(d, f))), ...links];
    }
    if (name === 'pandoc') return [...user.map((u) => path.win32.join(u, 'Pandoc', 'pandoc.exe')), ...pf.map((p) => path.win32.join(p, 'Pandoc', 'pandoc.exe'))];
    // poppler: scoop and chocolatey shims, or a winget/zip folder like "poppler-24.08.0\Library\bin".
    const dirs = [
      env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop', 'shims'),
      'C:\\ProgramData\\chocolatey\\bin',
      ...pf.flatMap((p) => listDir(p).filter((d) => /^poppler/i.test(d)).map((d) => path.win32.join(p, d, 'Library', 'bin'))),
      ...(env.LOCALAPPDATA ? listDir(path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')).filter((d) => /poppler/i.test(d)).flatMap((d) => {
        const base = path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages', d);
        return listDir(base).filter((x) => /^poppler/i.test(x)).map((x) => path.win32.join(base, x, 'Library', 'bin'));
      }) : []),
    ].filter(Boolean);
    return dirs.map((d) => path.win32.join(d, `${name}.exe`));
  }
  if (platform === 'darwin') {
    if (name === 'soffice') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
    if (name === 'blender') return ['/Applications/Blender.app/Contents/MacOS/Blender'];
    if (name === 'godot') return ['/Applications/Godot.app/Contents/MacOS/Godot', '/opt/homebrew/bin/godot', '/usr/local/bin/godot'];
    return ['/opt/homebrew/bin', '/usr/local/bin'].map((d) => path.posix.join(d, name));
  }
  if (name === 'blender') return ['/opt/blender/blender', '/usr/local/blender/blender', '/snap/bin/blender'];
  if (name === 'godot') return ['/usr/local/bin/godot', '/opt/godot/godot'];
  return [];
}

/** The names a program is looked for under on the PATH. */
export const pathNames = (name) => [name, ...(ALIASES[name] ?? [])];

/** Fixed install paths on Linux or macOS (no folder listing): for probes run inside another machine or container. */
export const installPlaces = (name, platform) => places(name, platform, {}, () => []);

/**
 * Where a converter is: an override, the PATH, or a standard install folder.
 * Returns null when it is not installed.
 */
export function findBinary(name, { platform = process.platform, env = process.env, exists = fs.existsSync, listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } } } = {}) {
  const override = env[`HARNESS_${name.toUpperCase()}`];
  if (override) return override;
  const win = platform === 'win32';
  const sep = win ? ';' : ':';
  const exts = win ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = (env.Path ?? env.PATH ?? '').split(sep).filter(Boolean);
  const join = (win ? path.win32 : path.posix).join;
  for (const n of [name, ...(ALIASES[name] ?? [])]) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = join(dir, n + ext);
        if (exists(p)) return p;
      }
    }
  }
  if (PATTERNS[name]) {
    for (const dir of dirs) {
      const hit = godotFirst(listDir(dir)).find((f) => exists(join(dir, f)));
      if (hit) return join(dir, hit);
    }
  }
  return places(name, platform, env, listDir).find((p) => exists(p)) ?? null;
}

export function missingMessage(name, platform = process.platform) {
  const h = HINTS[name] ?? { what: name };
  const how = platform === 'win32' ? h.win : platform === 'darwin' ? h.mac : h.linux;
  return `${h.what} is not installed (looked for ${name} on the PATH and in the usual install folders)${how ? `: ${how}` : ''}. Or set HARNESS_${name.toUpperCase()} to its path.`;
}
