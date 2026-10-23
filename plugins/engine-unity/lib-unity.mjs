// Unity for Studio: finding the Hub and the editors, the editor's command lines,
// and reading what the editor wrote (logs, compile errors, test results, build
// reports). Pure functions; index.mjs and unity.mjs do the running.

import path from 'node:path';

// ---------- versions ----------

const VERSION = /^(\d+)\.(\d+)\.(\d+)([abfpx])(\d+)/;
const STREAM = { a: 0, b: 1, x: 1, f: 2, p: 3 };

/** A Unity version (6000.0.39f1) as numbers to compare, or null. */
export function parseVersion(v) {
  const m = VERSION.exec(String(v ?? '').trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], stream: m[4], build: +m[5], text: m[0] } : null;
}

/** Sorts newest first: major, minor, patch, then final over beta over alpha, then build. */
export function compareVersions(a, b) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  return (y.major - x.major) || (y.minor - x.minor) || (y.patch - x.patch) || (STREAM[y.stream] - STREAM[x.stream]) || (y.build - x.build);
}

/** Unity 6 (6000.x) and the yearly LTS lines (2022.3, 2021.3) are what the tool is written for. */
export const isUnity6 = (v) => (parseVersion(v)?.major ?? 0) >= 6000;

/** The version a project was made with, from ProjectSettings/ProjectVersion.txt. */
export function projectVersion(text) {
  const m = /m_EditorVersion:\s*(\S+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

// ---------- the Hub ----------

/**
 * The editors in `Unity Hub -- --headless editors -i` (or the combined list without -i):
 * "6000.0.23f1 , installed at C:\...\Unity.exe" and "2022.3.10f1 (Apple silicon) , installed at /Applications/...".
 */
export function parseHubEditors(out) {
  const editors = [];
  for (const raw of String(out ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const m = /^(\d+\.\d+\.\d+[abfpx]\d+)(?:\s*\(([^)]*)\))?\s*,?\s*installed at\s+(.+)$/i.exec(line);
    if (m) editors.push({ version: m[1], arch: m[2] || undefined, path: editorExecutable(m[3].trim()), source: 'hub' });
  }
  return editors;
}

/** The releases the Hub offers (`editors -r`): version lines without "installed at". */
export function parseHubReleases(out) {
  const out2 = [];
  for (const raw of String(out ?? '').replace(/\r/g, '').split('\n')) {
    const m = /^(\d+\.\d+\.\d+[abfpx]\d+)(?:\s*\(([^)]*)\))?\s*$/.exec(raw.trim());
    if (m) out2.push(m[1]);
  }
  return out2;
}

/** Hub's secondaryInstallPath.json: a JSON string (often ""), the folder editors are installed into. */
export function parseSecondaryInstallPath(text) {
  try { const v = JSON.parse(String(text ?? '')); return typeof v === 'string' && v.trim() ? v.trim() : null; } catch { return null; }
}

/** Editors located by hand in the Hub: editors-v2.json ({ data: [...] }) or the older editors.json ({ version: {...} }). */
export function parseHubEditorsJson(text) {
  let j;
  try { j = JSON.parse(String(text ?? '')); } catch { return []; }
  const items = Array.isArray(j?.data) ? j.data : j && typeof j === 'object' ? Object.values(j) : [];
  const out = [];
  for (const e of items) {
    if (!e || typeof e !== 'object') continue;
    const loc = Array.isArray(e.location) ? e.location[0] : e.location;
    if (typeof loc === 'string' && e.version) out.push({ version: String(e.version), path: editorExecutable(loc), source: 'hub-located' });
  }
  return out;
}

/** The editor program for a path that may be the program, Unity.app, or the version folder. */
export function editorExecutable(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  if (/\.app$/i.test(s)) return `${s}/Contents/MacOS/Unity`;
  if (/(^|[\\/])Unity(\.exe)?$/i.test(s)) return s;
  return s;
}

/** Where the Hub keeps its settings: %APPDATA%\UnityHub, ~/Library/Application Support/UnityHub, ~/.config/UnityHub. */
export function hubConfigDir(platform, env) {
  if (platform === 'win32') return env.APPDATA ? path.win32.join(env.APPDATA, 'UnityHub') : null;
  if (platform === 'darwin') return env.HOME ? `${env.HOME}/Library/Application Support/UnityHub` : null;
  return env.HOME ? `${env.HOME}/.config/UnityHub` : null;
}

/** The places a Hub program usually is (HARNESS_UNITY_HUB first). */
export function hubCandidates(platform, env) {
  const out = [];
  if (env.HARNESS_UNITY_HUB) out.push(env.HARNESS_UNITY_HUB);
  if (platform === 'win32') {
    for (const r of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (r) out.push(path.win32.join(r, 'Unity Hub', 'Unity Hub.exe'));
    if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Unity Hub', 'Unity Hub.exe'));
  } else if (platform === 'darwin') out.push('/Applications/Unity Hub.app/Contents/MacOS/Unity Hub');
  else out.push('/usr/bin/unityhub', '/opt/unityhub/unityhub', `${env.HOME ?? ''}/Applications/Unity-Hub.AppImage`);
  return [...new Set(out)];
}

/** The folders editors are installed into, each holding <version>/Editor/Unity.exe (or <version>/Unity.app). */
export function editorRoots(platform, env, { secondary, hubExe } = {}) {
  const out = [];
  if (secondary) out.push(secondary);
  if (platform === 'win32') {
    for (const r of [env.ProgramFiles, env.ProgramW6432, 'C:\\Program Files']) if (r) out.push(path.win32.join(r, 'Unity', 'Hub', 'Editor'));
    // A Hub installed somewhere else often keeps its editors beside it (<hub>\Editor).
    if (hubExe) out.push(path.win32.join(path.win32.dirname(hubExe), 'Editor'));
  } else if (platform === 'darwin') out.push('/Applications/Unity/Hub/Editor');
  else if (env.HOME) out.push(`${env.HOME}/Unity/Hub/Editor`);
  return [...new Set(out)];
}

/** The editor program inside a version folder. */
export function editorInFolder(platform, versionDir) {
  if (platform === 'win32') return path.win32.join(versionDir, 'Editor', 'Unity.exe');
  if (platform === 'darwin') return `${versionDir}/Unity.app/Contents/MacOS/Unity`;
  return `${versionDir}/Editor/Unity`;
}

/** The editor's Data folder (templates, playback engines) from its program path. */
export function editorDataDir(platform, exe) {
  if (platform === 'darwin') return `${exe.replace(/\/Contents\/MacOS\/Unity$/, '')}/Contents`;
  return platform === 'win32' ? path.win32.join(path.win32.dirname(exe), 'Data') : `${path.posix.dirname(exe)}/Data`;
}

/** A version from an editor path (…/Editor/6000.0.39f1/Editor/Unity.exe), or null. */
export function versionFromPath(p) {
  const m = /(?:^|[\\/])(\d+\.\d+\.\d+[abfpx]\d+)(?:-[a-z0-9]+)?(?:[\\/]|$)/i.exec(String(p));
  return m ? m[1] : null;
}

/** The build support modules a version folder has (PlaybackEngines), as Studio's names. */
export const MODULE_FOLDERS = {
  windowsstandalonesupport: 'windows', WindowsStandaloneSupport: 'windows', WebGLSupport: 'webgl', LinuxStandaloneSupport: 'linux',
  MacStandaloneSupport: 'mac', AndroidPlayer: 'android', iOSSupport: 'ios',
};
export function modulesFrom(names) {
  const out = new Set();
  for (const n of names ?? []) { const m = MODULE_FOLDERS[n] ?? MODULE_FOLDERS[Object.keys(MODULE_FOLDERS).find((k) => k.toLowerCase() === String(n).toLowerCase())]; if (m) out.add(m); }
  // The editor's own platform always builds Mono players.
  return [...out].sort();
}

/** The editor to use: the one the project names when it is there, else the newest Unity 6 final, else the newest. */
export function pickEditor(editors, want) {
  const list = [...editors].sort((a, b) => compareVersions(a.version, b.version));
  if (want) {
    const exact = list.find((e) => e.version === want);
    if (exact) return { editor: exact, exact: true };
  }
  const finals = list.filter((e) => parseVersion(e.version)?.stream === 'f');
  const pick = finals.find((e) => isUnity6(e.version)) ?? finals[0] ?? list[0];
  return { editor: pick ?? null, exact: false };
}

/** Editors found by several routes, once each (the Hub's word on the version wins). */
export function mergeEditors(lists) {
  const by = new Map();
  for (const e of lists.flat()) {
    if (!e?.path) continue;
    const key = String(e.path).replace(/\\/g, '/').toLowerCase();
    const prev = by.get(key);
    by.set(key, prev ? { ...e, ...prev, sources: [...new Set([...(prev.sources ?? [prev.source]), e.source])] } : { ...e, sources: [e.source] });
  }
  return [...by.values()];
}

// ---------- licences ----------

/** Where an activated licence leaves files (their presence only; never their contents). */
export function licensePlaces(platform, env) {
  if (platform === 'win32') {
    const pd = env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return {
      files: [path.win32.join(pd, 'Unity', 'Unity_lic.ulf')],
      dirs: env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Unity', 'licenses')] : [],
      server: [path.win32.join(pd, 'Unity', 'config', 'services-config.json')],
    };
  }
  if (platform === 'darwin') {
    return { files: ['/Library/Application Support/Unity/Unity_lic.ulf'], dirs: env.HOME ? [`${env.HOME}/Library/Unity/licenses`] : [], server: ['/Library/Application Support/Unity/config/services-config.json'] };
  }
  const home = env.HOME ?? '';
  return { files: [`${home}/.local/share/unity3d/Unity/Unity_lic.ulf`], dirs: [`${home}/.config/unity3d/Unity/licenses`], server: ['/usr/share/unity3d/config/services-config.json'] };
}

/** Licence status from what exists: activated (a .ulf or an entitlement licence), a licence server, or not activated. */
export function licenseStatus({ files = [], entitlements = [], server = [] }) {
  if (files.length || entitlements.length) return { status: 'activated', evidence: [...files, ...entitlements] };
  if (server.length) return { status: 'server', evidence: server };
  return { status: 'not-activated', evidence: [] };
}

// ---------- command lines ----------

/** The project and log arguments every batch run starts with. */
export function batchArgs({ project, log, quit = false, nographics = false, extra = [] }) {
  return ['-batchmode', ...(nographics ? ['-nographics'] : []), ...(quit ? ['-quit'] : []), '-projectPath', project, '-logFile', log, ...extra];
}

/**
 * A batch run of one of the bridge package's entry points (Harness.Bridge.Batch.<method>):
 * it reads -harnessArgs, writes -harnessResult and exits itself (no -quit: some wait for
 * the editor, as tests and play mode do).
 */
export function executeArgs({ project, log, method, argsFile, resultFile, nographics = false, buildTarget }) {
  return [
    ...batchArgs({ project, log, nographics, extra: buildTarget ? ['-buildTarget', buildTarget] : [] }),
    '-executeMethod', method.includes('.') ? method : `Harness.Bridge.Batch.${method}`,
    '-harnessArgs', argsFile, '-harnessResult', resultFile,
  ];
}

/** Unity Test Framework from the command line: results as NUnit XML. No -quit (the runner exits). */
export function testArgs({ project, log, platform = 'EditMode', results, filter, category, assemblies }) {
  return [
    ...batchArgs({ project, log }), '-runTests', '-testPlatform', platform, '-testResults', results,
    ...(filter ? ['-testFilter', filter] : []), ...(category ? ['-testCategory', category] : []), ...(assemblies ? ['-assemblyNames', assemblies] : []),
  ];
}

/** A new empty project (Unity writes the default settings); -quit once it has imported. */
export const createArgs = ({ project, log }) => ['-batchmode', '-quit', '-createProject', project, '-logFile', log];

/** Opening the project once headless: it imports, compiles every script and quits. */
export const openArgs = ({ project, log }) => batchArgs({ project, log, quit: true });

/** A built Windows/Linux/Mac player, windowed, with the harness playback file. */
export function playerArgs({ log, playFile, bridgeFile, width = 1280, height = 720 }) {
  return [
    '-logFile', log, '-screen-fullscreen', '0', '-screen-width', String(width), '-screen-height', String(height),
    ...(playFile ? ['-harnessPlay', playFile] : []), ...(bridgeFile ? ['-harnessBridgeFile', bridgeFile] : []),
  ];
}

/** Studio's platform names to Unity's BuildTarget names, with the file a build writes. */
export const TARGETS = {
  win64: { target: 'StandaloneWindows64', module: 'windows', file: (n) => `${n}.exe` },
  windows: { target: 'StandaloneWindows64', module: 'windows', file: (n) => `${n}.exe` },
  standalonewindows64: { target: 'StandaloneWindows64', module: 'windows', file: (n) => `${n}.exe` },
  webgl: { target: 'WebGL', module: 'webgl', file: () => '' },
  web: { target: 'WebGL', module: 'webgl', file: () => '' },
  linux64: { target: 'StandaloneLinux64', module: 'linux', file: (n) => `${n}.x86_64` },
  standalonelinux64: { target: 'StandaloneLinux64', module: 'linux', file: (n) => `${n}.x86_64` },
  mac: { target: 'StandaloneOSX', module: 'mac', file: (n) => `${n}.app` },
  standaloneosx: { target: 'StandaloneOSX', module: 'mac', file: (n) => `${n}.app` },
};
export function buildTarget(name) {
  const t = TARGETS[String(name ?? 'win64').toLowerCase().replace(/[\s_-]/g, '')];
  return t ?? null;
}

// ---------- the log ----------

const CS = /^(.+?\.cs)\((\d+),(\d+)\):\s*(error|warning)\s+(CS\d+):\s*(.+)$/;

/** C# compiler messages: Assets/Scripts/Player.cs(12,5): error CS1002: ; expected. */
export function compileMessages(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    const m = CS.exec(raw.trim());
    if (!m) continue;
    const key = m.slice(1).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ severity: m[4], code: m[5], message: `${m[5]}: ${m[6].trim()}`, file: m[1].replace(/\\/g, '/'), line: +m[2], column: +m[3] });
  }
  return out;
}

/** The editor's known failures, with what to do about each. */
export const LOG_FAILURES = [
  { re: /No valid Unity Editor license found|License is not active|Activation of the license failed|'?com\.unity\.editor\.headless'? was not found|Failed to activate\/update license|LICENSE SYSTEM .*Error/i, kind: 'license', message: 'license not activated: open Unity Hub, sign in, and add a licence (Preferences > Licenses > Add: Personal is free), then run again' },
  { re: /Multiple Unity instances cannot open the same project|another Unity instance is running with this project open|It looks like another Unity instance is running/i, kind: 'locked', message: 'the project is open in another Unity editor: work through the live bridge (bridge.connect), or close that editor' },
  { re: /Scripts have compiler errors/i, kind: 'compile', message: 'scripts have compiler errors' },
  { re: /An error occurred while resolving packages|Cannot perform upm operation|Package Manager.*error/i, kind: 'packages', message: 'the packages did not resolve (see the log: a version that does not exist for this editor, or no network for the registry)' },
  { re: /executeMethod (?:class|method) .* (?:could not be found|not found)/i, kind: 'method', message: 'the entry point was not found: the harness bridge package is not in Packages/ (project.create installs it; asset.import and script reinstall it)' },
  { re: /Error building Player|Build completed with a result of 'Failed'|BuildPlayerWindow\+BuildMethodException/i, kind: 'build', message: 'the build failed' },
  { re: /Currently selected scripting backend \(IL2CPP\) is not installed|IL2CPP.*not installed/i, kind: 'module', message: 'IL2CPP is not installed for this platform: add "Windows Build Support (IL2CPP)" in Unity Hub, or build with scriptingBackend "Mono"' },
  { re: /Build target platform .* not (?:installed|supported)|No platform module (?:loaded|installed)|is not supported by this Editor|Unity Editor does not support/i, kind: 'module', message: 'the build support module for this platform is not installed: add it in Unity Hub (Installs > the editor > Add modules)' },
];

/** Exceptions with where they were thrown (the first line of their stack in the project). */
function exceptions(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const m = /^([A-Z][A-Za-z0-9_.]*(?:Exception|Error)):\s*(.*)$/.exec(l);
    if (!m || /^(Debug|Log)/.test(l)) continue;
    let file; let line;
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      const at = /\bin\s+((?:[A-Za-z]:)?[^\s:]*?(?:Assets|Packages)[\\/][^:]+\.cs):(\d+)/i.exec(lines[j]) ?? /\(at\s+((?:Assets|Packages)\/[^:]+\.cs):(\d+)\)/.exec(lines[j]);
      if (at) { file = at[1].replace(/\\/g, '/').replace(/^.*?((?:Assets|Packages)\/)/, '$1'); line = +at[2]; break; }
    }
    out.push({ severity: 'error', message: `${m[1]}: ${m[2]}`.slice(0, 400), ...(file ? { file, line } : {}) });
  }
  return out;
}

/** What went wrong in a Unity log: compile errors with file and line, known failures, exceptions. */
export function logProblems(text, { warnings = false } = {}) {
  const t = String(text ?? '').replace(/\r/g, '');
  const lines = t.split('\n');
  const problems = compileMessages(t).filter((p) => warnings || p.severity === 'error');
  const kinds = new Set();
  for (const f of LOG_FAILURES) {
    if (!f.re.test(t)) continue;
    if (f.kind === 'compile' && problems.some((p) => p.code)) { kinds.add(f.kind); continue; }
    kinds.add(f.kind);
    problems.push({ severity: 'error', message: f.message, kind: f.kind });
  }
  const seen = new Set(problems.map((p) => p.message));
  for (const e of exceptions(lines)) if (!seen.has(e.message)) { seen.add(e.message); problems.push(e); }
  return { problems: problems.slice(0, 60), kinds: [...kinds] };
}

/** The result a batch entry point printed (HARNESS_RESULT {...}) when its result file is not there. */
export function markerResult(text) {
  const all = [...String(text ?? '').matchAll(/HARNESS_RESULT (\{.*\})\s*$/gm)];
  for (const m of all.reverse()) { try { return JSON.parse(m[1]); } catch { /* the next one */ } }
  return null;
}

// ---------- test results (NUnit 3 XML, as Unity writes it) ----------

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e.toLowerCase()]));

/** A small XML reader: elements with attributes, children and text (CDATA kept). Enough for NUnit results. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const s = String(xml ?? '');
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el = { name: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined && stack.length > 1) top.text += decode(m[6]);
  }
  return root;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
function walk(el, fn) { fn(el); for (const c of el.children) walk(c, fn); }

/** Where a failure happened: the first project file in its stack trace. */
export function stackLocation(trace) {
  const m = /(?:in|at)\s+([^\s]*?(?:Assets|Packages)[\\/][^:\s]+\.cs):(?:line\s*)?(\d+)/i.exec(String(trace ?? '')) ?? /([A-Za-z]:[\\/][^:\n]+\.cs):(?:line\s*)?(\d+)/.exec(String(trace ?? ''));
  if (!m) return {};
  return { file: m[1].replace(/\\/g, '/').replace(/^.*?((?:Assets|Packages)\/)/, '$1'), line: +m[2] };
}

/** Unity's test results: counts, the duration and every failure with its message and place. */
export function parseTestResults(xml) {
  const doc = parseXml(xml);
  const run = kid(doc, 'test-run');
  if (!run) throw new Error('not an NUnit test-run file');
  const n = (k) => Number(run.attrs[k] ?? 0) || 0;
  const cases = [];
  walk(run, (el) => {
    if (el.name !== 'test-case') return;
    const failure = kid(el, 'failure');
    const reason = kid(el, 'reason');
    const message = (failure && kid(failure, 'message')?.text) || (reason && kid(reason, 'message')?.text) || '';
    const trace = failure && kid(failure, 'stack-trace')?.text;
    cases.push({
      name: el.attrs.name, fullName: el.attrs.fullname, result: el.attrs.result, label: el.attrs.label,
      durationS: Number(el.attrs.duration ?? 0), message: message.trim() || undefined, ...stackLocation(trace), output: kid(el, 'output')?.text?.trim() || undefined,
    });
  });
  const failed = cases.filter((c) => c.result === 'Failed');
  const summary = {
    result: run.attrs.result, total: n('total') || cases.length, passed: n('passed') || cases.filter((c) => c.result === 'Passed').length,
    failed: n('failed') || failed.length, skipped: n('skipped') + n('inconclusive'), durationS: Number(run.attrs.duration ?? 0),
  };
  return { ...summary, cases, failures: failed.map((c) => ({ name: c.fullName ?? c.name, message: c.message ?? c.label ?? 'failed', file: c.file, line: c.line })) };
}

// ---------- build reports ----------

/**
 * The report Harness.Bridge.Batch.Build writes from UnityEditor.Build.Reporting.BuildReport:
 * the result, sizes and times, error and warning messages per step.
 */
export function parseBuildReport(r) {
  if (!r || typeof r !== 'object') return { ok: false, problems: [{ severity: 'error', message: 'no build report was written' }], metrics: {} };
  const problems = [];
  for (const s of r.steps ?? []) {
    for (const m of s.messages ?? []) {
      const type = String(m.type ?? '');
      if (!/error|exception|assert|warning/i.test(type)) continue;
      const cs = compileMessages(m.content)[0];
      problems.push(cs ?? { severity: /warning/i.test(type) ? 'warning' : 'error', message: `${s.name}: ${String(m.content ?? '').split('\n')[0]}`.slice(0, 400) });
    }
  }
  const ok = r.result === 'Succeeded';
  if (!ok && !problems.some((p) => p.severity === 'error')) problems.push({ severity: 'error', message: `the build ${String(r.result ?? 'failed').toLowerCase()}${r.error ? `: ${r.error}` : ''}` });
  const metrics = {};
  if (r.totalSize !== undefined) metrics.sizeMb = Math.round((Number(r.totalSize) / 1048576) * 10) / 10;
  if (r.totalTimeS !== undefined) metrics.buildS = Math.round(Number(r.totalTimeS) * 10) / 10;
  if (r.totalErrors !== undefined) metrics.errors = Number(r.totalErrors);
  if (r.totalWarnings !== undefined) metrics.warnings = Number(r.totalWarnings);
  return { ok, result: r.result, outputPath: r.outputPath, problems, metrics, steps: (r.steps ?? []).map((s) => ({ name: s.name, durationS: s.durationS })) };
}

/** The result line Unity prints at the end of a build, when no report was written. */
export function buildResultFromLog(text) {
  const m = /Build (?:Finished, Result: |completed with a result of ')(\w+)/i.exec(String(text ?? ''));
  return m ? (/^succe/i.test(m[1]) ? 'Succeeded' : m[1]) : null;
}

// ---------- inputs and layouts ----------

/**
 * The input timeline for play, as events at a time in seconds:
 *   { t, key: "W", down: true } / { t, key: "W", up: true } / { t, key: "Space", press: 0.2 } (down, then up after 0.2 s)
 *   { t, axis: "Horizontal", value: 1 } / { t, keys: ["W", "LeftShift"], duration: 2 }
 * Key names are Unity KeyCode names (W, Space, LeftArrow, Mouse0).
 */
export function normalizeInputs(list, seconds = Infinity) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || typeof e !== 'object') continue;
    const t = Math.max(0, Number(e.t ?? e.time ?? 0) || 0);
    if (t > seconds) continue;
    const keys = Array.isArray(e.keys) ? e.keys : e.key ? [e.key] : [];
    for (const k of keys.map((x) => keyName(x)).filter(Boolean)) {
      const hold = Number(e.press ?? e.duration);
      if (Number.isFinite(hold) && hold >= 0) { out.push({ t, type: 'key', key: k, down: true }, { t: t + hold, type: 'key', key: k, down: false }); }
      else out.push({ t, type: 'key', key: k, down: e.up ? false : e.down !== false });
    }
    if (e.axis) out.push({ t, type: 'axis', axis: String(e.axis), value: Math.max(-1, Math.min(1, Number(e.value) || 0)) });
  }
  return out.sort((a, b) => a.t - b.t);
}

const KEY_ALIASES = { up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow', space: 'Space', enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', shift: 'LeftShift', ctrl: 'LeftControl', control: 'LeftControl', alt: 'LeftAlt', tab: 'Tab', mouse0: 'Mouse0', mouse1: 'Mouse1', click: 'Mouse0' };
/** A key as a Unity KeyCode name: "w" -> "W", "up" -> "UpArrow", "1" -> "Alpha1". */
export function keyName(k) {
  const s = String(k ?? '').trim();
  if (!s) return null;
  const alias = KEY_ALIASES[s.toLowerCase()];
  if (alias) return alias;
  if (/^[a-z]$/i.test(s)) return s.toUpperCase();
  if (/^\d$/.test(s)) return `Alpha${s}`;
  const arrow = /^(?:arrow)?(up|down|left|right)(?:arrow)?$/i.exec(s);
  if (arrow) return `${arrow[1][0].toUpperCase()}${arrow[1].slice(1).toLowerCase()}Arrow`;
  return /^[A-Za-z][A-Za-z0-9]*$/.test(s) ? s : null;
}

/** The cell letters a layout grid may use, and what each one makes. */
export const LEGEND = { '#': 'wall', '.': 'floor', ' ': 'empty', P: 'player', C: 'collectible', E: 'exit', H: 'hazard', '=': 'platform', S: 'spawn' };

/**
 * Checks a level layout for BuildLevelFromLayout and fills defaults:
 *   { name, dimension: "3d" | "2.5d" | "2d", cell: 1, grid: ["#####", "#P.C#", ...], legend?, objects?: [...],
 *     camera?: { mode: "follow" | "perspective" | "orthographic" | "isometric", size?, height?, distance? },
 *     rules?: { collect: "all", exitNeedsAll: true, timeLimitS? }, scene?: "Assets/Scenes/Level1.unity" }
 * Returns { layout, errors, counts }.
 */
export function validateLayout(input) {
  const errors = [];
  const l = { ...(input && typeof input === 'object' ? input : {}) };
  l.name = String(l.name ?? 'Level1').replace(/[^\w -]/g, '').trim() || 'Level1';
  l.dimension = String(l.dimension ?? '3d').toLowerCase();
  if (!['2d', '2.5d', '3d'].includes(l.dimension)) errors.push(`dimension must be "2d", "2.5d" or "3d", not "${l.dimension}"`);
  l.cell = Number(l.cell ?? 1) || 1;
  const legend = { ...LEGEND, ...(l.legend ?? {}) };
  const counts = { wall: 0, floor: 0, player: 0, collectible: 0, exit: 0, hazard: 0, platform: 0, spawn: 0, objects: 0 };
  if (l.grid !== undefined) {
    if (!Array.isArray(l.grid) || !l.grid.every((r) => typeof r === 'string')) errors.push('grid is a list of strings, one per row (top row first)');
    else {
      if (l.grid.length > 256 || l.grid.some((r) => r.length > 256)) errors.push('grid is at most 256 x 256 cells');
      l.grid.forEach((row, y) => [...row].forEach((ch, x) => {
        const what = legend[ch];
        if (!what) errors.push(`grid row ${y} column ${x}: "${ch}" is not in the legend (${Object.keys(legend).map((k) => JSON.stringify(k)).join(', ')})`);
        else if (counts[what] !== undefined) counts[what]++;
      }));
    }
  }
  const TYPES = ['player', 'collectible', 'exit', 'wall', 'floor', 'hazard', 'platform', 'light', 'camera', 'prefab', 'sprite', 'primitive', 'spawn'];
  l.objects = Array.isArray(l.objects) ? l.objects : [];
  l.objects.forEach((o, i) => {
    if (!o || !TYPES.includes(o.type)) { errors.push(`objects[${i}].type must be one of ${TYPES.join(', ')}`); return; }
    for (const k of ['position', 'rotation', 'scale']) {
      if (o[k] !== undefined && !(Array.isArray(o[k]) && o[k].length >= 2 && o[k].length <= 3 && o[k].every((v) => Number.isFinite(Number(v))))) errors.push(`objects[${i}].${k} is [x, y] or [x, y, z]`);
    }
    if (o.type === 'prefab' && !/^Assets\/.+\.prefab$/.test(String(o.prefab ?? ''))) errors.push(`objects[${i}].prefab is a path like Assets/Prefabs/Door.prefab`);
    if (o.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(o.color))) errors.push(`objects[${i}].color is #rrggbb`);
    if (counts[o.type] !== undefined) counts[o.type]++;
    counts.objects++;
  });
  if (!counts.player) errors.push('the level needs a player (P in the grid, or an object of type "player")');
  if (counts.player > 1) errors.push(`the level has ${counts.player} players; one is expected`);
  const mode = l.camera?.mode ?? (l.dimension === '2.5d' ? 'isometric' : l.dimension === '2d' ? 'orthographic' : 'follow');
  l.camera = { ...(l.camera ?? {}), mode };
  if (!['follow', 'perspective', 'orthographic', 'isometric'].includes(mode)) errors.push(`camera.mode must be follow, perspective, orthographic or isometric, not "${mode}"`);
  l.rules = { collect: 'all', exitNeedsAll: true, ...(l.rules ?? {}) };
  l.scene = String(l.scene ?? `Assets/Scenes/${l.name.replace(/\s+/g, '')}.unity`);
  if (!/^Assets\/.+\.unity$/.test(l.scene)) errors.push('scene is a path like Assets/Scenes/Level1.unity');
  l.legend = legend;
  return { layout: l, errors, counts };
}

// ---------- scripts ----------

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const scriptName = (n) => (IDENT.test(String(n ?? '')) ? String(n) : null);

/**
 * C# for Assets/Editor/Harness/<name>.cs. A whole file (it has a class) is kept; a body is
 * wrapped in Harness.Scripts.<name>.Run(), which may return a value to report.
 */
export function wrapScript(name, code) {
  const src = String(code ?? '');
  if (/\b(class|struct)\s+[A-Za-z_]/.test(src)) {
    const ns = /namespace\s+([\w.]+)/.exec(src)?.[1];
    const cls = /(?:class|struct)\s+([A-Za-z_]\w*)/.exec(src)[1];
    return { source: src, method: `${ns ? `${ns}.` : ''}${cls}.Run`, wrapped: false };
  }
  const body = /\breturn\b/.test(src) ? src : `${src}\n        return null;`;
  const source = [
    '// Written by the harness (unity script). Safe to delete.',
    'using System;', 'using System.Collections.Generic;', 'using System.Linq;', 'using UnityEditor;', 'using UnityEditor.SceneManagement;', 'using UnityEngine;', 'using UnityEngine.SceneManagement;', 'using Object = UnityEngine.Object;',
    '', 'namespace Harness.Scripts', '{', `    public static class ${name}`, '    {', '        public static object Run()', '        {',
    ...body.split('\n').map((l) => `            ${l}`), '        }', '    }', '}', '',
  ].join('\n');
  return { source, method: `Harness.Scripts.${name}.Run`, wrapped: true };
}

/** Balanced braces, brackets and parentheses outside strings, chars and comments: a structural check of C#. */
export function csharpBalanced(src) {
  const s = String(src);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let line = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') { line++; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; line++; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') line++; i++; } i++; continue; }
    if (c === '@' && s[i + 1] === '"') { i += 2; while (i < s.length && !(s[i] === '"' && s[i + 1] !== '"')) { if (s[i] === '"') i++; if (s[i] === '\n') line++; i++; } continue; }
    const interpolated = c === '$' && s[i + 1] === '"';
    if (c === '"' || interpolated) {
      if (interpolated) i++;
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; if (s[i] === '\n') return { ok: false, error: `unterminated string at line ${line}` }; i++; }
      continue;
    }
    if (c === "'") { i++; while (i < s.length && s[i] !== "'") { if (s[i] === '\\') i++; i++; } continue; }
    if ('([{'.includes(c)) stack.push({ c, line });
    else if (')]}'.includes(c)) {
      const top = stack.pop();
      if (!top || top.c !== pairs[c]) return { ok: false, error: `unbalanced "${c}" at line ${line}` };
    }
  }
  return stack.length ? { ok: false, error: `"${stack.at(-1).c}" opened at line ${stack.at(-1).line} is never closed` } : { ok: true };
}
