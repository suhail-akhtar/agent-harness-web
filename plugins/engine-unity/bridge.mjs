// The harness side of the live bridge: reads Library/HarnessBridge/bridge.json (port and
// token) from the project folder, connects to 127.0.0.1 only, and sends one JSON request
// per line. Unity drops connections when it reloads scripts (after a compile, on entering
// play mode); calls made then are retried until the editor answers again.

import net from 'node:net';
import { readTextIn } from '@harness/plugins/games3d/lib-engines.mjs';

export const BRIDGE_FILE = 'Library/HarnessBridge/bridge.json';

/** The bridge file of a project (null when the editor never started the bridge there). */
export async function readBridgeFile(host, project, signal) {
  const text = await readTextIn(host, `${project === '.' ? '' : `${project}/`}${BRIDGE_FILE}`, signal);
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return Number.isInteger(j.port) && typeof j.token === 'string' ? j : null;
  } catch { return null; }
}

/** Whether a process id is alive on this machine (the editor that wrote the bridge file). */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const RETRY = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'closed']);

/**
 * A connection to a bridge: call(op, args, { timeoutMs, retryMs }) resolves with the result or
 * rejects with the bridge's error. Lines are matched to requests by id.
 */
export function connect({ port, token, host = '127.0.0.1', connectTimeoutMs = 5000 }) {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('the Unity bridge is reached on this machine only (127.0.0.1)');
  let socket = null;
  let buf = '';
  let seq = 0;
  const waiting = new Map();
  const fail = (err) => { for (const w of waiting.values()) w.reject(err); waiting.clear(); };

  const open = () => new Promise((resolve, reject) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('the bridge did not answer the connection'), { code: 'ETIMEDOUT' })); }, connectTimeoutMs);
    s.setNoDelay(true);
    s.once('connect', () => { clearTimeout(timer); socket = s; resolve(s); });
    s.once('error', (e) => { clearTimeout(timer); if (socket === s) socket = null; reject(e); fail(e); });
    s.on('close', () => { if (socket === s) socket = null; fail(Object.assign(new Error('the bridge closed the connection (Unity may be reloading scripts)'), { code: 'closed' })); });
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const w = waiting.get(msg.id);
        if (!w) continue;
        waiting.delete(msg.id);
        if (msg.ok) w.resolve(msg.result ?? null);
        else w.reject(Object.assign(new Error(String(msg.error ?? 'the bridge refused the request')), { bridge: true }));
      }
    });
  });

  const once = async (op, args, timeoutMs) => {
    if (!socket) { buf = ''; await open(); }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(Object.assign(new Error(`${op}: no answer from Unity in ${Math.round(timeoutMs / 1000)}s`), { code: 'ETIMEDOUT', noRetry: true })); }, timeoutMs);
      waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      socket.write(`${JSON.stringify({ id, token, op, args: { ...(args ?? {}), timeoutMs } })}\n`);
    });
  };

  return {
    async call(op, args = {}, { timeoutMs = 60_000, retryMs = 0, signal } = {}) {
      const until = Date.now() + retryMs;
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        try { return await once(op, args, timeoutMs); } catch (e) {
          const retry = !e.bridge && !e.noRetry && RETRY.has(e.code) && Date.now() < until;
          if (!retry) throw e;
          if (socket) { socket.destroy(); socket = null; }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    },
    close() { if (socket) socket.destroy(); socket = null; fail(Object.assign(new Error('closed'), { code: 'closed' })); },
    get connected() { return Boolean(socket); },
  };
}

/** Waits until a predicate on an op's result holds (play mode entered, compiling done). */
export async function waitFor(bridge, op, pred, { timeoutMs = 120_000, everyMs = 500, signal } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    if (signal?.aborted) throw new Error('cancelled');
    try { last = await bridge.call(op, {}, { timeoutMs: 10_000, retryMs: 0 }); if (pred(last)) return last; } catch (e) { if (e.bridge) throw e; }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw Object.assign(new Error(`${op}: the editor did not get there in ${Math.round(timeoutMs / 1000)}s${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`), { code: 'ETIMEDOUT' });
}
