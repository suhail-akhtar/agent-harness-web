// Plays a web game in the person's browser. A Studio web game loads its scripts as modules and its data and
// assets with fetch, which browsers refuse from a file:// page ("blocked by CORS policy ... origin 'null'"), so
// opening index.html from the disk shows nothing. Its folder is served instead: on this computer only
// (127.0.0.1, a free port), only that folder, one server per folder, closed two hours after it was last opened
// (or when the harness stops).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { serveDir } from '@harness/plugin-sdk/runtime';

const IDLE_MS = 2 * 60 * 60_000;
/** Folder (real path) -> its server. */
const served = new Map();

/** The folder to play in a project: its web build when there is one, else the project itself (both need an index.html). */
export function playableDir(projectDir) {
  for (const d of [path.join(projectDir, 'build', 'web'), projectDir]) if (fs.existsSync(path.join(d, 'index.html'))) return d;
  return null;
}

/** A link that plays the game in `dir` (served as above); the same link again while it is served. */
export async function playUrl(dir) {
  const real = await fsp.realpath(dir);
  if (!fs.existsSync(path.join(real, 'index.html'))) throw new Error(`no index.html in ${dir}: build the game first (studio_template {"action": "build"})`);
  let s = served.get(real);
  if (!s) { s = await serveDir(real); served.set(real, s); }
  clearTimeout(s.timer);
  s.timer = setTimeout(() => void stopPlaying(real), IDLE_MS);
  s.timer.unref?.();
  return `${s.origin}/index.html`;
}

export async function stopPlaying(real) {
  const s = served.get(real);
  if (!s) return;
  served.delete(real);
  clearTimeout(s.timer);
  await s.close().catch(() => {});
}

export async function stopAllPlaying() { for (const k of [...served.keys()]) await stopPlaying(k); }
