// The live bridge: Unreal's Remote Control API (HTTP, and WebSocket for events) on an editor
// this tool launched for a project the agent works on, on ports of its own, bound to this
// machine. It never touches an editor someone else opened: attaching to an existing editor's
// Remote Control (the default port 30010) is only done when asked for by port.

import net from 'node:net';
import { remoteControlArgs, UNATTENDED } from './args.mjs';
import { killTree, startDirect } from './run.mjs';

/** A free TCP port on 127.0.0.1 (the OS picks one). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** A Remote Control client for one HTTP port. fetchImpl is replaceable for tests. */
export function rcClient(port, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  async function req(method, path, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await r.text();
      let data = text;
      try { data = text ? JSON.parse(text) : {}; } catch { /* plain text */ }
      if (!r.ok) {
        const msg = typeof data === 'object' ? (data.errorMessage ?? data.ErrorMessage ?? JSON.stringify(data)) : data;
        throw Object.assign(new Error(`Remote Control ${method} ${path}: ${r.status} ${String(msg).slice(0, 500)}`), { status: r.status, data });
      }
      return data;
    } finally { clearTimeout(t); }
  }
  return {
    port,
    info: () => req('GET', '/remote/info'),
    /** Calls a function on an object: a CDO for static libraries (/Script/Engine.Default__KismetSystemLibrary), an actor path... */
    call: (objectPath, functionName, parameters = {}, transaction = false) => req('PUT', '/remote/object/call', { objectPath, functionName, parameters, generateTransaction: transaction }),
    /** Reads one property (or every property when propertyName is empty). */
    get: (objectPath, propertyName) => req('PUT', '/remote/object/property', { objectPath, ...(propertyName ? { propertyName } : {}), access: 'READ_ACCESS' }),
    /** Writes one property in an undoable transaction. */
    set: (objectPath, propertyName, value) => req('PUT', '/remote/object/property', { objectPath, propertyName, propertyValue: { [propertyName]: value }, access: 'WRITE_TRANSACTION_ACCESS' }),
    describe: (objectPath) => req('PUT', '/remote/object/describe', { objectPath }),
    presets: () => req('GET', '/remote/presets'),
    preset: (name) => req('GET', `/remote/preset/${encodeURIComponent(name)}`),
    searchAssets: (query, classNames = []) => req('PUT', '/remote/search/assets', { Query: query, Filter: { ClassNames: classNames, RecursiveClasses: true } }),
    batch: (requests) => req('PUT', '/remote/batch', { Requests: requests.map((r, i) => ({ RequestId: i, URL: r.url, Verb: r.verb ?? 'PUT', Body: r.body })) }),
    /** Runs Python in the editor (PythonScriptLibrary.ExecutePythonCommandEx): { ok, result, output }. */
    async python(code) {
      const r = await req('PUT', '/remote/object/call', {
        objectPath: '/Script/PythonScriptPlugin.Default__PythonScriptLibrary', functionName: 'ExecutePythonCommandEx',
        parameters: { PythonCommand: code, ExecutionMode: 'ExecuteFile', FileExecutionScope: 'Public' },
      });
      const output = (r.LogOutput ?? []).map((e) => `${e.Type && e.Type !== 'Info' ? `${e.Type}: ` : ''}${e.Output}`).join('\n');
      return { ok: r.ReturnValue !== false, result: r.CommandResult ?? '', output };
    },
    /** A console command in the editor world (KismetSystemLibrary.ExecuteConsoleCommand). */
    console: (command, worldContext) => req('PUT', '/remote/object/call', { objectPath: '/Script/Engine.Default__KismetSystemLibrary', functionName: 'ExecuteConsoleCommand', parameters: { WorldContextObject: worldContext, Command: command } }),
  };
}

/** Waits until the Remote Control server answers, the process dies, or the time is up. */
export async function waitForRc(client, { timeoutMs = 300_000, child, signal, every = 1000 } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    if (signal?.aborted) throw new Error('cancelled');
    if (child && child.exitCode !== null) throw new Error(`the editor exited (code ${child.exitCode}) before Remote Control answered`);
    try { await client.info(); return Date.now() - t0; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, every));
  }
  throw new Error(`Remote Control did not answer on port ${client.port} within ${Math.round(timeoutMs / 1000)} s${last ? ` (${last.message})` : ''}`);
}

/**
 * Starts an editor for a project with Remote Control on free ports. offscreen: no window
 * (-RenderOffScreen; it still renders, so viewport captures work); else a normal editor the
 * person can watch. Returns { child, client, httpPort, wsPort, log }.
 */
export async function launchEditor({ editor, uproject, log, offscreen = true, httpPort, wsPort, onLine }) {
  const http = httpPort ?? await freePort();
  const ws = wsPort ?? await freePort();
  const args = [uproject, ...remoteControlArgs({ httpPort: http, wsPort: ws }), ...(offscreen ? [...UNATTENDED, '-RenderOffScreen'] : ['-nosplash', '-NoLiveCoding']), `-abslog=${log}`];
  const child = startDirect(editor, args, { onLine });
  return { child, client: rcClient(http), httpPort: http, wsPort: ws, log, args };
}

/** Asks an editor we started to close (saving nothing), then makes sure it is gone. */
export async function stopEditor(session, { graceMs = 30_000 } = {}) {
  if (!session?.child || session.child.exitCode !== null) return 'not running';
  try { await session.client.python('import unreal\nunreal.SystemLibrary.quit_editor()'); } catch { /* it may close before it answers */ }
  const exited = await new Promise((resolve) => {
    if (session.child.exitCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), graceMs);
    session.child.once('close', () => { clearTimeout(t); resolve(true); });
  });
  if (!exited) killTree(session.child);
  return exited ? 'closed' : 'killed after the grace time';
}
