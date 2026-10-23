// Unreal's command lines, one builder per kind of run. Values are passed as single arguments
// (-Key=value); run.mjs quotes them the way Unreal reads them.

/** Flags for a run nobody watches: no dialogs, no splash, no sound, no crash reporter UI. */
export const UNATTENDED = ['-unattended', '-nosplash', '-nosound', '-nopause', '-NoLiveCoding'];

/** Remote Control on a port of our own, bound to this machine only, open to our calls (an editor or game we started). */
export function remoteControlArgs({ httpPort, wsPort, python = true }) {
  const s = '[/Script/RemoteControlCommon.RemoteControlSettings]';
  const kv = [
    `${s}:RemoteControlHttpServerPort=${httpPort}`,
    `${s}:RemoteControlWebSocketServerPort=${wsPort}`,
    `${s}:RemoteControlWebsocketServerBindAddress=127.0.0.1`,
    `${s}:bAutoStartWebServer=True`,
    `${s}:bAutoStartWebSocketServer=True`,
    `${s}:bAllowAnyRemoteFunctionCall=True`,
    `${s}:bAllowConsoleCommandRemoteExecution=True`,
    ...(python ? [`${s}:bEnableRemotePythonExecution=True`] : []),
  ];
  return ['-RCWebControlEnable', `-ini:RemoteControl:${kv.join(',')}`, '-ini:Engine:[HTTPServer.Listeners]:DefaultBindAddress=127.0.0.1'];
}

/**
 * The editor running a Python file and exiting when it returns (unless the script keeps it
 * alive with unreal.EditorPythonScripting.set_keep_python_script_alive). rendering: false runs
 * with -nullrhi (faster, no GPU); captures and renders need it on.
 */
export function editorPythonArgs({ uproject, script, log, rendering = false, extra = [] }) {
  return [uproject, `-ExecutePythonScript=${script}`, ...UNATTENDED, ...(rendering ? ['-RenderOffScreen'] : ['-nullrhi']), '-stdout', '-FullStdOutLogOutput', `-abslog=${log}`, ...extra];
}

/** The pythonscript commandlet: no editor world or level subsystems, quicker for asset-only work. */
export function commandletPythonArgs({ uproject, script, log, extra = [] }) {
  return [uproject, '-run=pythonscript', `-script=${script}`, ...UNATTENDED, '-nullrhi', '-stdout', '-FullStdOutLogOutput', `-abslog=${log}`, ...extra];
}

/**
 * Automation tests: RunTests <filter> then quit, with a JSON report in reportDir.
 * filter: "Project." (the project's own), "Project.Functional Tests", a full test path, or several joined with "+".
 */
export function automationArgs({ uproject, filter = 'Project', reportDir, log, rendering = false, extra = [] }) {
  return [
    uproject, `-ExecCmds=Automation RunTests ${filter}; Quit`, '-TestExit=Automation Test Queue Empty', `-ReportExportPath=${reportDir}`,
    ...UNATTENDED, ...(rendering ? ['-RenderOffScreen'] : ['-nullrhi']), '-stdout', '-FullStdOutLogOutput', `-abslog=${log}`, '-buildmachine', ...extra,
  ];
}

/**
 * RunUAT BuildCookRun for a Blueprint-only project: cook, stage, pak and archive to dir.
 * No -build: the precompiled UnrealGame runs a content-only project, so no compiler is needed
 * (a project with C++ code or a runtime plugin that is not on by default needs one).
 */
export function buildCookRunArgs({ uproject, platform = 'Win64', config = 'Development', archiveDir, clean = false, build = false, map, extra = [] }) {
  return [
    'BuildCookRun', `-project=${uproject}`, '-noP4', `-platform=${platform}`, `-clientconfig=${config}`, `-serverconfig=${config}`,
    ...(build ? ['-build'] : ['-nocompileeditor', '-skipbuildeditor']),
    '-cook', '-stage', '-pak', '-archive', `-archivedirectory=${archiveDir}`,
    ...(clean ? ['-clean'] : []), ...(map ? [`-map=${map}`] : []),
    '-unattended', '-utf8output', ...extra,
  ];
}

/** The game: the editor binary in -game mode (uncooked) or a packaged exe. */
export function gameArgs({ uproject, map, width = 1280, height = 720, windowed = true, log, timeline, extra = [], packaged = false }) {
  return [
    ...(packaged ? [] : [uproject]), ...(map ? [map] : []), ...(packaged ? [] : ['-game']),
    ...(windowed ? ['-windowed', `-ResX=${width}`, `-ResY=${height}`] : []),
    '-nosplash', '-unattended', '-nosound', '-NoVerifyGC', '-NoLoadingScreen', '-stdout', '-FullStdOutLogOutput',
    ...(log ? [`-abslog=${log}`] : []),
    ...(timeline ? [`-HarnessTimeline=${timeline}`] : []),
    ...extra,
  ];
}

// ---------- the play timeline ----------

/** Keys by the names agents use, as Unreal FKey names. */
export const KEYS = {
  w: 'W', a: 'A', s: 'S', d: 'D', up: 'Up', down: 'Down', left: 'Left', right: 'Right', space: 'SpaceBar', jump: 'SpaceBar',
  shift: 'LeftShift', ctrl: 'LeftControl', e: 'E', f: 'F', q: 'Q', r: 'R', enter: 'Enter', escape: 'Escape', tab: 'Tab',
  mouse1: 'LeftMouseButton', mouse2: 'RightMouseButton',
};

export const keyName = (k) => KEYS[String(k).toLowerCase()] ?? String(k);

/**
 * A play script as the driver's timeline: "<ms>|<console command>;..." sorted by time.
 * inputs: [{ at: ms, key: "W", ms: 1500 }, { at, action: "IA_Jump", value: "true", ms }, { at, console: "..." }]
 * captures every captureEveryMs (HighResShot at width x height), a CSV profile around it all,
 * and quit at seconds.
 */
export function timeline({ inputs = [], seconds = 10, captureEveryMs = 0, width = 1280, height = 720, profile = true, quit = true }) {
  const out = [];
  const end = Math.round(seconds * 1000);
  if (profile) out.push([0, 'CsvProfile Start']);
  for (const i of inputs) {
    const at = Math.max(0, Math.round(Number(i.at ?? 0)));
    const hold = i.ms === undefined ? null : Math.max(0, Math.round(Number(i.ms)));
    if (i.console) out.push([at, String(i.console)]);
    else if (i.key) {
      const k = keyName(i.key);
      out.push([at, `Input.+key ${k}${i.value !== undefined ? ` ${i.value}` : ''}`]);
      out.push([at + (hold ?? 100), `Input.-key ${k}`]);
    } else if (i.action) {
      out.push([at, `Input.+action ${i.action}${i.value !== undefined ? ` ${i.value}` : ''}`]);
      out.push([at + (hold ?? 100), `Input.-action ${i.action}`]);
    }
  }
  if (captureEveryMs > 0) for (let t = captureEveryMs; t < end; t += captureEveryMs) out.push([t, `HighResShot ${width}x${height}`]);
  if (profile) out.push([Math.max(0, end - 200), 'CsvProfile Stop']);
  if (quit) out.push([end, 'quit']);
  for (const [, c] of out) {
    if (/[;|"]/.test(c)) throw new Error(`a play command cannot contain ; | or ": ${c}`);
  }
  // Stable: commands at one time keep their order.
  return out.map((e, i) => [...e, i]).sort((a, b) => a[0] - b[0] || a[2] - b[2]).map(([t, c]) => `${t}|${c}`).join(';');
}
