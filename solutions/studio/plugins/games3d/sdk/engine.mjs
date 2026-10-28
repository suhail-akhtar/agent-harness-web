// The engine contract: what every engine plugin (engine-blender, engine-godot, engine-unreal,
// engine-unity) gives agents, and the result shape its tools return. Engine plugins import
// this folder (and ../lib-engines.mjs for running commands where the session's commands run);
// they register their own tools (`<engine>` plus `<engine>_*`), skills, gates and agents, so
// each one can be switched off on its own. Studio (this plugin) holds no engine code.
//
// The operations an engine offers, as `action`s of its main tool (an engine may lack some;
// `detect` says which):
//   detect                       installs, versions, toolchain gaps ("no MSVC"), actions offered
//   install                      fetch the engine into ~/.harness/engines (asks first; checksums)
//   project.create / open / describe   from a template; the scene tree, assets, settings
//   script                       run code headless, or in the open editor (live: true)
//   asset.import / asset.export  files in the workspace <-> the engine's assets
//   capture                      a frame (viewport or rendered) as a PNG the agent sees
//   render                       images or a video (a heavy job)
//   build / package              an artifact plus its log (a heavy job)
//   test                         the engine's own tests, as structured results
//   play                         run the game N seconds with inputs: frames, logs, metrics
//   bridge.connect / status      the live link to an editor the person has open
//
// Heavy work goes through jobs.mjs (one at a time per engine by default, cancel, timeouts).

/** @typedef {'ok' | 'failed' | 'timed-out' | 'cancelled' | 'unavailable'} EngineStatus */

/**
 * @typedef {object} EngineResult
 * @property {string} engine            'blender' | 'godot' | 'unreal' | 'unity' | 'web'
 * @property {string} action
 * @property {EngineStatus} status
 * @property {string} summary           one line for people and agents
 * @property {string} [log]             the end of the output
 * @property {string} [logFile]         the whole log, a workspace path
 * @property {string[]} [files]         workspace paths it wrote (captures, builds, assets)
 * @property {Array<{severity: 'error' | 'warning', message: string, file?: string, line?: number}>} [problems]
 * @property {Record<string, number>} [metrics]   fps, frameMs, memoryMb, drawCalls, triangles, took...
 * @property {object} [data]            action-specific (a scene tree, test results, a detect report)
 */

/** @typedef {{ engine: string, installed: boolean, version?: string, path?: string, source?: 'host' | 'sandbox' | 'harness', gaps: string[], actions: string[] }} DetectReport */

export const ENGINES = ['blender', 'godot', 'unreal', 'unity', 'web'];

/** A tool result from an EngineResult: the text agents read, images it captured, is_error unless ok. */
export function toToolResult(r, images = []) {
  const lines = [`${r.engine} ${r.action}: ${r.status} - ${r.summary}`];
  if (r.problems?.length) lines.push('Problems:', ...r.problems.slice(0, 30).map((p) => `- ${p.severity}: ${p.message}${p.file ? ` (${p.file}${p.line ? `:${p.line}` : ''})` : ''}`));
  if (r.metrics && Object.keys(r.metrics).length) lines.push(`Metrics: ${Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (r.files?.length) lines.push(`Files: ${r.files.join(', ')}`);
  if (r.data !== undefined) lines.push(`Data: ${JSON.stringify(r.data).slice(0, 6000)}`);
  if (r.logFile) lines.push(`Full log: ${r.logFile}`);
  if (r.log) lines.push(`Output (end):\n${r.log}`);
  return { content: lines.join('\n'), is_error: r.status !== 'ok', images, details: r };
}

/** The result for an engine that is not there: what is missing and how to get it. */
export function unavailable(engine, action, why) {
  return { engine, action, status: 'unavailable', summary: why };
}
