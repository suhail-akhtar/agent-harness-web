// The live link to a Godot editor the person has open: the Harness Bridge EditorPlugin
// (addons/harness_bridge) serves a WebSocket on 127.0.0.1 with a token it writes to
// <project>/.godot/harness_bridge.json. Each call here opens a connection, sends the
// token with one command and closes: nothing is kept open between tool calls.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readTextIn, writeIn } from '../../games3d/lib-engines.mjs';
import { inProject } from './play.mjs';
import { PLUGIN_DIR } from './templates.mjs';

export const BRIDGE_INFO = '.godot/harness_bridge.json';
export const BRIDGE_PLUGIN = 'res://addons/harness_bridge/plugin.cfg';
export const COMMANDS = ['ping', 'tree', 'add_node', 'set', 'remove', 'run', 'save', 'open', 'play', 'stop', 'capture'];

/** project.godot with the plugin in [editor_plugins] enabled (kept as it was when it is there). */
export function withEditorPlugin(text, plugin = BRIDGE_PLUGIN) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => l.trim() === '[editor_plugins]');
  if (start < 0) return `${String(text).replace(/\s*$/, '')}\n\n[editor_plugins]\n\nenabled=PackedStringArray("${plugin}")\n`;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && /^\s*enabled\s*=/.test(l));
  if (at < 0) { lines.splice(start + 1, 0, '', `enabled=PackedStringArray("${plugin}")`); return lines.join('\n'); }
  const list = [...lines[at].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (list.includes(plugin)) return String(text);
  lines[at] = `enabled=PackedStringArray(${[...list, plugin].map((p) => `"${p}"`).join(', ')})`;
  return lines.join('\n');
}

/** Copies the EditorPlugin into the project and enables it in project.godot. */
export async function installBridge(host, project, signal) {
  const files = [];
  for (const f of ['plugin.cfg', 'plugin.gd']) {
    const rel = inProject(project, `addons/harness_bridge/${f}`);
    await writeIn(host, rel, await fs.readFile(path.join(PLUGIN_DIR, 'addons', 'harness_bridge', f)), signal);
    files.push(rel);
  }
  const cfgRel = inProject(project, 'project.godot');
  const before = await readTextIn(host, cfgRel, signal);
  const after = withEditorPlugin(before ?? '');
  if (after !== before) { await writeIn(host, cfgRel, after, signal); files.push(cfgRel); }
  return { files, enabledNow: after !== before };
}

/** The bridge's port and token, or null when no editor with the plugin has this project open. */
export async function bridgeInfo(host, project, signal) {
  const text = await readTextIn(host, inProject(project, BRIDGE_INFO), signal);
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return Number.isInteger(j.port) && typeof j.token === 'string' ? j : null;
  } catch { return null; }
}

/** One command to the editor: resolves with its result, rejects with its error. */
export function bridgeCall(info, cmd, params = {}, { timeoutMs = 30_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!WebSocketImpl) return Promise.reject(new Error('this Node has no WebSocket client (Node 22 or later)'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(`ws://127.0.0.1:${info.port}`);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`the editor did not answer ${cmd} in ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, token: info.token, cmd, params }));
    ws.onerror = () => done(reject, new Error(`could not reach the Godot editor's bridge on 127.0.0.1:${info.port} (is the editor open with the Harness Bridge plugin on?)`));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return done(reject, new Error('a broken reply from the editor')); }
      if (msg.ok) done(resolve, msg.result);
      else done(reject, new Error(`the editor refused ${cmd}: ${msg.error}`));
    };
  });
}
