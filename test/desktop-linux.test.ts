import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { createApp } from '../src/server/app.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { docker, removeContainer } from './real-services.ts';
import { tempDir } from './helpers.ts';
// @ts-expect-error plain JS module
const lib = await import('../plugins/computer/lib.mjs');

// Computer use on a real Linux X11 desktop through the companion, end to end:
// the desktop image runs Xvfb and fluxbox, and the companion itself (this
// repository, mounted read-only, started with --allow-desktop) connects back to
// a harness server in this process. The computer tool's jobs then travel the
// real way: tool -> companion hub -> HTTP poll -> companion -> xdotool and
// ImageMagick on the X display -> result back over HTTP.
//
// The display is 1920x1200, larger than the 1280x800 the model sees, so the
// scaling both ways is exercised. Skipped without Docker or the desktop image.

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PLUGIN = path.join(ROOT, 'plugins', 'computer');
const IMAGE = 'harness-sandbox-desktop:latest';
const enabled = (await dockerAvailable()) && (await imageExists(IMAGE));
const SCREEN = { w: 1920, h: 1200 };

/** The node_modules folder the repository resolves packages from (a worktree has none of its own). */
function nodeModules(): string {
  const p = createRequire(import.meta.url).resolve('undici');
  return p.slice(0, p.lastIndexOf(`${path.sep}node_modules${path.sep}`) + `${path.sep}node_modules`.length);
}

/** A PNG's size, read from its header. */
function pngInfo(b: Buffer): { w: number; h: number } {
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', 'a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('computer use on a real Linux X11 desktop through the companion: screenshot, move, click into xterm, type, Return, zoom', { skip: !enabled && `no Docker or ${IMAGE} (npm run sandbox:image:desktop)`, timeout: 300_000 }, async () => {
  const name = `hwtest-desktop-${process.pid}`;
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [PLUGIN], search: null, memory: 'off', scheduler: false });
  const tool = h.registry.tools.get('computer')!;
  const { server } = createApp({ harness: h, token: 'operator-desktop-test', loopback: true, localRoots: [], uiDir: path.join(data, 'ui'), appRoot: data });
  // Docker Desktop forwards host.docker.internal to the host's loopback; a Linux
  // Docker host reaches the host only on the bridge, so listen there.
  await new Promise<void>((r) => server.listen(0, process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const { id, token } = await h.companions.create('linux desktop');
  const sh = async (cmd: string) => (await docker(['exec', name, 'bash', '-c', cmd], { timeoutMs: 30_000 })).stdout;
  try {
    const startup = [
      `Xvfb :99 -screen 0 ${SCREEN.w}x${SCREEN.h}x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &`,
      'for i in $(seq 1 50); do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep 0.2; done',
      'fluxbox >/tmp/fluxbox.log 2>&1 &',
      'mkdir -p /work && cd /work',
      `exec node /repo/src/companion/main.ts --server http://host.docker.internal:${port} --token "$HWC_TOKEN" --token-file /tmp/companion.token --dir /work --sandbox off --allow-desktop`,
    ].join('\n');
    const r = await docker(['run', '-d', '--name', name, '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${ROOT}:/repo:ro`, '-v', `${nodeModules()}:/node_modules:ro`,
      '-e', `HWC_TOKEN=${token}`, '-e', 'DISPLAY=:99', '--shm-size', '256m', '--entrypoint', 'bash', IMAGE, '-c', startup], { timeoutMs: 120_000 });
    assert.equal(r.code, 0, r.stderr);

    // The companion connects and says desktop control is on.
    let online = false;
    for (let i = 0; i < 120 && !online; i++) {
      const c = h.companions.list().find((x) => x.id === id);
      online = !!c?.online && c.info?.desktop === true;
      if (!online) await new Promise((res) => setTimeout(res, 500));
    }
    const logs = async () => (await docker(['logs', name], { timeoutMs: 20_000 }));
    if (!online) { const l = await logs(); assert.fail(`the companion did not connect: ${l.stdout}\n${l.stderr}`); }
    assert.equal(h.companions.list().find((x) => x.id === id)!.info!.platform, 'linux');
    assert.match((await logs()).stdout, /DESKTOP CONTROL IS ON/);

    const host = h.companions.host(id, 'desktop-test');
    assert.equal(await tool.availableIn!(host), true, 'the tool is offered on this companion');
    const ctx = { host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} } as unknown as ToolContext;
    const call = async (input: Record<string, unknown>) => {
      const res = await tool.run(input, ctx);
      assert.equal(res.is_error, undefined, `${JSON.stringify(input)}: ${res.content}`);
      return res;
    };

    // Screenshot: a PNG of the real display, scaled to fit 1280x800, and not blank.
    const fit = lib.shotSize(SCREEN);
    assert.deepEqual(fit, { w: 1280, h: 800 });
    const first = await call({ action: 'screenshot' });
    assert.equal(first.untrusted, true, 'a real screen is always untrusted');
    const png = Buffer.from(first.images![0]!.data, 'base64');
    assert.deepEqual(pngInfo(png), fit);

    // Move and read back: model coordinates are scaled to screen pixels and back.
    await call({ action: 'mouse_move', coordinate: [400, 300] });
    const pos = await call({ action: 'cursor_position' });
    assert.match(pos.content, /The pointer is at \[400, 300\]/);
    const real = (await sh('DISPLAY=:99 xdotool getmouselocation --shell')).match(/X=(\d+)\s+Y=(\d+)/);
    assert.deepEqual([Number(real![1]), Number(real![2])], [600, 450], 'on the 1920x1200 screen the pointer is at 1.5x');

    // Start xterm, click into it, type a command, press Return: the file appears.
    await call({ action: 'launch', text: 'xterm -geometry 80x20+150+150' });
    let win = '';
    for (let i = 0; i < 60 && !win; i++) {
      win = (await sh('DISPLAY=:99 xdotool search --class xterm 2>/dev/null | head -1')).trim();
      if (!win) await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(win, 'xterm opened a window on the display');
    await new Promise((res) => setTimeout(res, 1000));
    // xterm's text area starts at screen (150,150): (300,250) on screen is (200,167) for the model.
    await call({ action: 'left_click', coordinate: [200, 167] });
    await call({ action: 'type', text: 'echo hello-linux-desktop > /work/typed.txt' });
    await call({ action: 'key', text: 'Return' });
    let typed = '';
    for (let i = 0; i < 40 && !typed; i++) {
      typed = (await sh('cat /work/typed.txt 2>/dev/null')).trim();
      if (!typed) await new Promise((res) => setTimeout(res, 250));
    }
    assert.equal(typed, 'hello-linux-desktop', 'the command typed into xterm ran');

    // The screen now shows the terminal: many colours, and it differs from the first screenshot.
    const after = await call({ action: 'screenshot' });
    const png2 = Buffer.from(after.images![0]!.data, 'base64');
    assert.deepEqual(pngInfo(png2), fit);
    fs.writeFileSync(path.join(data, 'after.png'), png2);
    assert.notDeepEqual(png2, png, 'the screen changed');
    await docker(['cp', path.join(data, 'after.png'), `${name}:/tmp/after.png`]);
    const colours = Number((await sh('identify -format %k /tmp/after.png')).trim());
    assert.ok(colours > 4, `the screen is not blank (${colours} colours)`);

    // Zoom: a region of the screen enlarged to 1280x800 (to read small text).
    const zoom = await call({ action: 'zoom', region: [100, 100, 420, 300] });
    assert.deepEqual(pngInfo(Buffer.from(zoom.images![0]!.data, 'base64')), fit);
    assert.match(zoom.content, /enlarged/);
    console.log(`# linux desktop ${SCREEN.w}x${SCREEN.h}: screenshot ${fit.w}x${fit.h}, ${colours} colours after typing; xterm ran "${typed}"`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
    await removeContainer(name);
  }
});
