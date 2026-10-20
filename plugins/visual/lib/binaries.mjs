// Finds the converters the render tool uses, on Linux, macOS and Windows. On
// Windows and macOS they usually live in an install folder, not on the PATH.
// HARNESS_<NAME> (e.g. HARNESS_SOFFICE) points at one explicitly.

import fs from 'node:fs';
import path from 'node:path';

const HINTS = {
  soffice: { what: 'LibreOffice', win: 'install it from https://www.libreoffice.org (or: winget install TheDocumentFoundation.LibreOffice)', mac: 'brew install --cask libreoffice', linux: 'apt install libreoffice-writer libreoffice-impress libreoffice-calc' },
  pdftoppm: { what: 'poppler', win: 'winget install oschwartz10612.Poppler (or: scoop install poppler), then reopen the terminal', mac: 'brew install poppler', linux: 'apt install poppler-utils' },
  pandoc: { what: 'pandoc', win: 'winget install JohnMacFarlane.Pandoc', mac: 'brew install pandoc', linux: 'apt install pandoc' },
};
HINTS.pdfinfo = HINTS.pdftoppm;
HINTS.pdftotext = HINTS.pdftoppm;

/** Standard install folders to look in, per platform. */
function places(name, platform, env, listDir) {
  if (platform === 'win32') {
    const pf = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files'].filter(Boolean);
    const user = [env.LOCALAPPDATA, env.USERPROFILE].filter(Boolean);
    if (name === 'soffice') return pf.map((p) => path.win32.join(p, 'LibreOffice', 'program', 'soffice.exe'));
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
    return ['/opt/homebrew/bin', '/usr/local/bin'].map((d) => path.posix.join(d, name));
  }
  return [];
}

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
  for (const dir of (env.Path ?? env.PATH ?? '').split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = (win ? path.win32 : path.posix).join(dir, name + ext);
      if (exists(p)) return p;
    }
  }
  return places(name, platform, env, listDir).find((p) => exists(p)) ?? null;
}

export function missingMessage(name, platform = process.platform) {
  const h = HINTS[name] ?? { what: name };
  const how = platform === 'win32' ? h.win : platform === 'darwin' ? h.mac : h.linux;
  return `${h.what} is not installed (looked for ${name} on the PATH and in the usual install folders)${how ? `: ${how}` : ''}. Or set HARNESS_${name.toUpperCase()} to its path.`;
}
