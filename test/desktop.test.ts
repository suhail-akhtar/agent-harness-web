import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkRequest, type DesktopExecutor, type DesktopRequest, type DesktopResult, linuxScript, macKey, macScript, readResult, systemDesktop, windowsScript, winKey } from '../src/companion/desktop.ts';
import { type CompanionJob, createCompanionHandler, DESKTOP_OFF } from '../src/companion/handler.ts';
import type { Block } from '../src/core/types.ts';
import { decide } from '../src/core/permissions.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { CompanionHub } from '../src/runtime/companion.ts';
import type { ToolHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { FakeProvider, makeAgent, results, tempDir, testPicture } from './helpers.ts';
// @ts-expect-error plain JS module
const lib = await import('../plugins/computer/lib.mjs');
// @ts-expect-error plain JS module
const { pngStats } = await import('../plugins/games3d/lib-png.mjs');

// Computer use on the user's real desktop, through a companion started with --allow-desktop.

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..', 'plugins', 'computer');
/** A high-DPI laptop screen: screenshots are half size, coordinates doubled. */
const SCREEN = { w: 2560, h: 1600 };
const REAL = process.env.HARNESS_TEST_REAL_DESKTOP === '1';

/** The companion job for one computer call on SCREEN. */
const req = (input: Record<string, unknown>, screen = SCREEN) => lib.desktopRequest(lib.plan(input, screen), screen) as DesktopRequest;
const W = { shotFile: 'C:\\Temp\\it\'s\\shot.png', dir: 'C:\\Users\\me\\project' };
const P = { shotFile: '/tmp/d/shot.png', dir: '/home/me/project', logFile: '/tmp/launch.log' };

async function setup() {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off' });
  return { h, tool: h.registry.tools.get('computer')! };
}
const ctxFor = (host: ToolHost) => ({ host, signal: new AbortController().signal, readFiles: new Map(), todos: [], setTodos() {}, emit() {} }) as unknown as ToolContext;

/** A stand-in for the OS: a screen of this size that remembers the pointer and answers with a picture. */
function fakeScreen(screen = SCREEN) {
  const seen: DesktopRequest[] = [];
  let at: [number, number] = [10, 10];
  const run: DesktopExecutor = async (r) => {
    checkRequest(r);
    seen.push(r);
    if (r.screen && (r.screen.w !== screen.w || r.screen.h !== screen.h)) return { geom: screen, mismatch: true };
    const out: DesktopResult = { geom: screen };
    for (const s of r.steps) {
      if (s.t === 'move') at = [s.x, s.y];
      if (s.t === 'cursor') out.cursor = at;
    }
    if (r.shot) {
      const box = r.crop ?? { w: screen.w, h: screen.h };
      const f = Math.min(r.crop ? Infinity : 1, r.max.w / box.w, r.max.h / box.h);
      out.png = testPicture(Math.round(box.w * f), Math.round(box.h * f)).toString('base64');
    }
    return out;
  };
  return { run, seen };
}

/** A companion host as the server sees one (no network: the stand-in answers in-process). */
function companionHost(exec: DesktopExecutor, desktop = true) {
  return {
    kind: 'companion', root: '', displayRoot: 'C:\\Users\\me\\project', platform: 'win32', shell: 'powershell', sandboxed: false, networkPolicy: 'full', desktop,
    async exec() { throw new Error('no commands here'); },
    desktopAction: (r: DesktopRequest) => exec(r),
  } as unknown as ToolHost;
}

// ---------------------------------------------------------------- generated scripts

test('Windows: each action becomes PowerShell over user32 (SendInput, SetCursorPos) and System.Drawing, DPI aware', () => {
  const ps = (input: Record<string, unknown>) => windowsScript(req(input), W);
  const shot = ps({ action: 'screenshot' });
  assert.match(shot, /\[void\]\[HarnessDesktop\]::SetProcessDPIAware\(\)\r\n\$w = \[HarnessDesktop\]::GetSystemMetrics\(0\); \$h = \[HarnessDesktop\]::GetSystemMetrics\(1\)/);
  assert.ok(shot.indexOf('SetProcessDPIAware()') < shot.indexOf('GetSystemMetrics(0)'), 'DPI aware before measuring');
  assert.match(shot, /\[DllImport\("user32\.dll", SetLastError = true\)\] public static extern uint SendInput/);
  assert.match(shot, /\$g\.CopyFromScreen\(\$cx, \$cy, 0, 0, \$bmp\.Size\)/);
  assert.match(shot, /\$f = \[Math\]::Min\(1\.0, \[Math\]::Min\(1280 \/ \$cw, 800 \/ \$ch\)\)/, 'a full screen only shrinks to fit 1280x800');
  assert.match(shot, /\$bmp\.Save\('C:\\Temp\\it''s\\shot\.png', \[System\.Drawing\.Imaging\.ImageFormat\]::Png\)/, 'the path is a quoted PowerShell string');
  assert.doesNotMatch(shot, /@@MISMATCH|HarnessDesktop\]::(Move|Click)/, 'a screenshot needs no known screen and does nothing');

  // Coordinates on a 2x screen are doubled, and nothing happens on a screen of another size.
  const click = ps({ action: 'left_click', coordinate: [640, 400] });
  assert.match(click, /if \(\$w -ne 2560 -or \$h -ne 1600\) \{ '@@MISMATCH'; exit 0 \}/);
  assert.match(click, /try \{\r\n {2}\[HarnessDesktop\]::Move\(1280, 800\)\r\n {2}\[HarnessDesktop\]::Click\(0x2, 0x4, 1\)\r\n {2}'@@RC 0'/);
  assert.match(ps({ action: 'right_click', coordinate: [1, 2] }), /Move\(2, 4\)\r\n {2}\[HarnessDesktop\]::Click\(0x8, 0x10, 1\)/);
  const middle = ps({ action: 'middle_click' });
  assert.match(middle, /Click\(0x20, 0x40, 1\)/);
  assert.doesNotMatch(middle, /::Move\(|@@MISMATCH/, 'at the pointer: no move, no size check');
  assert.match(ps({ action: 'double_click', coordinate: [5, 5] }), /Click\(0x2, 0x4, 2\)/);
  const move = ps({ action: 'mouse_move', coordinate: [100, 50] });
  assert.match(move, /\[HarnessDesktop\]::Move\(200, 100\)\r\n {2}'@@RC 0'/);
  assert.match(ps({ action: 'left_click_drag', start_coordinate: [10, 10], coordinate: [110, 60] }), /Move\(20, 20\)\r\n {2}\[HarnessDesktop\]::Mouse\(0x2, 0\)\r\n {2}Start-Sleep -Milliseconds 100\r\n {2}\[HarnessDesktop\]::Move\(120, 70\)\r\n {2}Start-Sleep -Milliseconds 50\r\n {2}\[HarnessDesktop\]::Move\(220, 120\)\r\n {2}Start-Sleep -Milliseconds 100\r\n {2}\[HarnessDesktop\]::Mouse\(0x4, 0\)/);

  // Text reaches the script only as base64: quotes, $() and newlines cannot become PowerShell.
  const nasty = "it's $(Remove-Item C:\\ -Recurse) `n\"x\"\nline 2";
  const typed = ps({ action: 'type', text: nasty });
  assert.ok(typed.includes(`[HarnessDesktop]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(nasty).toString('base64')}')))`));
  assert.ok(!typed.includes('Remove-Item'));
  assert.match(typed, /KEYEVENTF|i\.u\.ki\.dwFlags = \(uint\)\(4 \| \(up \? 2 : 0\)\)/, 'typed as Unicode key events');

  assert.match(ps({ action: 'key', text: 'ctrl+l Return' }), /\[HarnessDesktop\]::Combo\(@\(0x11, 0x4c\)\); \[HarnessDesktop\]::Combo\(@\(0xd\)\)/);
  assert.match(ps({ action: 'key', text: 'ctrl+shift+T F5 Page_Down super' }), /Combo\(@\(0x11, 0x10, 0x54\)\); \[HarnessDesktop\]::Combo\(@\(0x74\)\); \[HarnessDesktop\]::Combo\(@\(0x22\)\); \[HarnessDesktop\]::Combo\(@\(0x5b\)\)/);
  assert.match(ps({ action: 'scroll', scroll_direction: 'down' }), /\[HarnessDesktop\]::Wheel\(0x800, -120, 3\)/);
  assert.match(ps({ action: 'scroll', scroll_direction: 'up', scroll_amount: 2, coordinate: [10, 10] }), /Move\(20, 20\)\r\n {2}\[HarnessDesktop\]::Wheel\(0x800, 120, 2\)/);
  assert.match(ps({ action: 'scroll', scroll_direction: 'left', scroll_amount: 1 }), /Wheel\(0x1000, -120, 1\)/);
  assert.match(ps({ action: 'scroll', scroll_direction: 'right', scroll_amount: 1 }), /Wheel\(0x1000, 120, 1\)/);
  const cur = ps({ action: 'cursor_position' });
  assert.match(cur, /"@@CURSOR \$\(\[HarnessDesktop\]::Cursor\(\)\)"/);
  assert.doesNotMatch(cur, /CopyFromScreen/, 'no screenshot');

  const zoom = ps({ action: 'zoom', region: [100, 50, 420, 250] });
  assert.match(zoom, /\$cx = 200; \$cy = 100; \$cw = 640; \$ch = 400/);
  assert.match(zoom, /\[Math\]::Min\(\[double\]::MaxValue, /, 'a region is enlarged to fit');
  assert.match(zoom, /@@MISMATCH/, 'a region is read on a known screen');

  const launch = ps({ action: 'launch', text: 'start msedge https://example.com' });
  assert.ok(launch.includes(`Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from('start msedge https://example.com').toString('base64')}'))) -WorkingDirectory 'C:\\Users\\me\\project' -WindowStyle Hidden`));
  assert.match(launch, /Start-Sleep -Milliseconds 2500[\s\S]*CopyFromScreen/, 'then a screenshot once it had time to appear');
});

test('Windows key names: xdotool names map to virtual-key codes; unknown names are refused', () => {
  assert.equal(winKey('Return'), 0x0d);
  assert.equal(winKey('BackSpace'), 0x08);
  assert.equal(winKey('Escape'), 0x1b);
  assert.equal(winKey('Tab'), 0x09);
  assert.equal(winKey('a'), 0x41);
  assert.equal(winKey('T'), 0x54);
  assert.equal(winKey('7'), 0x37);
  assert.equal(winKey('F12'), 0x7b);
  assert.equal(winKey('slash'), 0xbf);
  assert.equal(winKey('/'), 0xbf);
  assert.equal(winKey('Left'), 0x25);
  assert.throws(() => winKey('Hyper_L'), /not a key this companion knows on Windows/);
  assert.throws(() => windowsScript(req({ action: 'key', text: 'ctrl+XF86AudioPlay' }), W), /XF86AudioPlay/);
});

test('macOS: each action becomes JavaScript for Automation (CoreGraphics events, System Events keys, screencapture) - checked as text, no Mac here', () => {
  const js = (input: Record<string, unknown>) => macScript(req(input), P);
  const shot = js({ action: 'screenshot' });
  assert.match(shot, /^ObjC\.import\('CoreGraphics'\);\nfunction run\(\) \{/);
  assert.match(shot, /const bounds = \$\.CGDisplayBounds\(\$\.CGMainDisplayID\(\)\);/);
  assert.match(shot, /app\.doShellScript\('screencapture -x -t png ' \+ "'\/tmp\/d\/shot\.png'"\);/);
  assert.match(shot, /app\.doShellScript\('sips -z ' \+ th \+ ' ' \+ tw \+ ' ' \+ "'\/tmp\/d\/shot\.png'" \+ ' >\/dev\/null'\);/);
  assert.match(shot, /const f = Math\.min\(1, 1280 \/ cw, 800 \/ ch\);/);
  assert.match(shot, /return out\.join\('\\n'\);\n\}\n$/, 'the result is what run() returns (osascript prints it)');

  const click = js({ action: 'left_click', coordinate: [640, 400] });
  assert.match(click, /if \(w !== 2560 \|\| h !== 1600\) \{ out\.push\('@@MISMATCH'\); return out\.join\('\\n'\); \}/);
  assert.match(click, /mouse\(5, 1280, 800, 0\); at = \[1280, 800\]; delay\(0\.03\);\n {4}for \(let n = 1; n <= 1; n\+\+\) \{ if \(n > 1\) delay\(0\.09\); mouse\(1, at\[0\], at\[1\], 0, n\); mouse\(2, at\[0\], at\[1\], 0, n\); \}/);
  assert.match(click, /\$\.CGEventCreateMouseEvent\(null, held && type === 5 \? 6 : type, \{ x: x, y: y \}, button\); if \(clicks\) \$\.CGEventSetIntegerValueField\(e, 1, clicks\); \$\.CGEventPost\(0, e\);/);
  assert.match(js({ action: 'right_click', coordinate: [1, 1] }), /mouse\(3, at\[0\], at\[1\], 1, n\); mouse\(4, at\[0\], at\[1\], 1, n\)/);
  assert.match(js({ action: 'middle_click' }), /mouse\(25, at\[0\], at\[1\], 2, n\); mouse\(26, at\[0\], at\[1\], 2, n\)/);
  assert.match(js({ action: 'double_click' }), /n <= 2/);
  assert.match(js({ action: 'mouse_move', coordinate: [3, 4] }), /mouse\(5, 6, 8, 0\); at = \[6, 8\];/);
  assert.match(js({ action: 'left_click_drag', start_coordinate: [0, 0], coordinate: [10, 10] }), /mouse\(5, 0, 0, 0\)[^\n]*\n {4}mouse\(1, at\[0\], at\[1\], 0, 1\); held = true;[\s\S]*mouse\(5, 20, 20, 0\)[\s\S]*mouse\(2, at\[0\], at\[1\], 0, 1\); held = false;/);
  const typed = js({ action: 'type', text: 'say "hi"\u2028 then' });
  assert.ok(typed.includes('typeText("say \\"hi\\"\\u2028 then");'), 'a JSON string literal');
  assert.match(js({ action: 'key', text: 'super+l Return' }), /se\.keyCode\(37, \{ using: \["command down"\] \}\); delay\(0\.05\); se\.keyCode\(36\); delay\(0\.05\);/);
  assert.match(js({ action: 'key', text: 'ctrl+shift+t' }), /se\.keyCode\(17, \{ using: \["control down","shift down"\] \}\)/);
  assert.match(js({ action: 'scroll', scroll_direction: 'up', scroll_amount: 2 }), /scroll\(2, 0\);/);
  assert.match(js({ action: 'scroll', scroll_direction: 'down' }), /scroll\(-3, 0\);/);
  assert.match(js({ action: 'scroll', scroll_direction: 'left', scroll_amount: 4 }), /scroll\(0, 4\);/);
  assert.match(js({ action: 'cursor_position' }), /out\.push\('@@CURSOR ' \+ pos\(\)\.join\(' '\)\);/);
  assert.doesNotMatch(js({ action: 'cursor_position' }), /screencapture/);
  const zoom = js({ action: 'zoom', region: [100, 50, 420, 250] });
  assert.match(zoom, /screencapture -x -t png -R200,100,640,400 /);
  assert.match(zoom, /Math\.min\(Infinity, 1280 \/ cw, 800 \/ ch\)/);
  assert.ok(js({ action: 'launch', text: "open -a Safari 'https://example.com'" }).includes(`app.doShellScript(${JSON.stringify(`cd '/home/me/project' && (nohup /bin/sh -c 'open -a Safari '"'"'https://example.com'"'"'' >'/tmp/launch.log' 2>&1 </dev/null &)`)});`));
  assert.deepEqual(macKey('super+shift+T'), [17, ['command down', 'shift down']]);
  assert.throws(() => macKey('hyper+x'), /not a modifier/);
  assert.throws(() => macKey('XF86Eject'), /not a key this companion knows on macOS/);
});

test('Linux: X11 with xdotool and ImageMagick (the sandbox\'s command lines); Wayland and missing tools are named', () => {
  const sh = (input: Record<string, unknown>) => linuxScript(req(input), P);
  const shot = sh({ action: 'screenshot' });
  assert.match(shot, /XDG_SESSION_TYPE" = wayland[^\n]*@@UNSUPPORTED This is a Wayland session/);
  assert.match(shot, /DISPLAY is not set/);
  assert.match(shot, /for c in xdotool convert; do command -v \$c[\s\S]*@@MISSING/);
  assert.match(shot, /if command -v import >\/dev\/null 2>&1; then import -window root png:-; else xwd -root -silent \| convert xwd:- png:-; fi; \} \| convert png:- -resize '1280x800>' png:'\/tmp\/d\/shot\.png' && echo '@@SHOT'/);
  const click = sh({ action: 'left_click', coordinate: [640, 400] });
  assert.match(click, /if \[ "\$w" != 2560 \] \|\| \[ "\$h" != 1600 \]; then echo '@@MISMATCH'; exit 0; fi/);
  assert.match(click, /out=\$\( \{ xdotool mousemove 1280 800 && xdotool click 1; \} 2>&1 \); rc=\$\?/);
  assert.match(sh({ action: 'double_click' }), /xdotool click --repeat 2 --delay 100 1/);
  assert.match(sh({ action: 'right_click' }), /xdotool click 3;/);
  assert.match(sh({ action: 'left_click_drag', start_coordinate: [0, 0], coordinate: [10, 10] }), /xdotool mousemove 0 0 && xdotool mousedown 1 && sleep 0\.10 && xdotool mousemove 10 10 && sleep 0\.05 && xdotool mousemove 20 20 && sleep 0\.10 && xdotool mouseup 1/);
  assert.match(sh({ action: 'type', text: "it's $HOME" }), /xdotool type --delay 12 -- 'it'"'"'s \$HOME'/);
  assert.match(sh({ action: 'key', text: 'ctrl+l Enter' }), /xdotool key --delay 50 -- 'ctrl\+l' 'Return'/);
  assert.match(sh({ action: 'scroll', scroll_direction: 'right', scroll_amount: 2 }), /xdotool click --repeat 2 --delay 50 7/);
  assert.match(sh({ action: 'cursor_position' }), /eval "\$\(xdotool getmouselocation --shell\)" && echo "@@CURSOR \$X \$Y"/);
  assert.match(sh({ action: 'zoom', region: [100, 50, 420, 250] }), /convert png:- -crop 640x400\+200\+100 \+repage -resize 1280x800 png:/);
  assert.match(sh({ action: 'launch', text: 'xterm' }), /\(cd '\/home\/me\/project' && setsid nohup sh -c 'xterm' >'\/tmp\/launch\.log' 2>&1 <\/dev\/null &\) && echo '@@LOG \/tmp\/launch\.log'/);
});

test('the companion checks every desktop job again: only the shape the server sends', () => {
  const ok = req({ action: 'left_click', coordinate: [1, 1] });
  checkRequest(ok);
  for (const a of lib.ACTIONS as string[]) {
    const input = { action: a, coordinate: [10, 10], start_coordinate: [1, 1], text: a === 'key' ? 'Return' : 'x', scroll_direction: 'up', region: [0, 0, 100, 100] };
    checkRequest(req(input));
  }
  const bad = (r: Partial<DesktopRequest> & Record<string, unknown>, why: RegExp) => assert.throws(() => checkRequest({ ...ok, ...r } as DesktopRequest), why);
  bad({ action: 'format_disk' }, /unknown action/);
  bad({ steps: [{ t: 'exec', command: 'calc' }] as never }, /unknown step exec/);
  bad({ steps: [{ t: 'move', x: -1, y: 0 }] }, /move needs whole/);
  bad({ steps: [{ t: 'move', x: 1.5, y: 0 }] }, /move needs whole/);
  bad({ steps: [{ t: 'key', combos: ['ctrl+l; calc'] }] }, /not a key name/);
  bad({ steps: [{ t: 'type', text: 'x'.repeat(5001) }] }, /1-5000/);
  bad({ steps: Array(51).fill({ t: 'cursor' }) }, /at most 50/);
  bad({ launch: 'x'.repeat(2001) }, /launch needs a command/);
  bad({ screen: { w: 0, h: 10 } }, /screen must be/);
  bad({ timeoutMs: 10 ** 9 }, /timeoutMs/);
});

test('what a desktop script prints becomes a result: a changed screen, missing tools, Wayland, the pointer, a failure', async () => {
  const r = (stdout: string, code = 0) => readResult({ stdout, stderr: code ? 'Add-Type: compile error' : '', code, timedOut: false }, '/nonexistent/shot.png', 'win32', false);
  assert.deepEqual(await r('@@GEOM 1920 1080\r\n@@MISMATCH\r\n'), { geom: { w: 1920, h: 1080 }, mismatch: true });
  assert.match((await r('@@MISSING xdotool convert\n')).error!, /lacks: xdotool convert\. Install them \(Debian\/Ubuntu: sudo apt install xdotool imagemagick/);
  assert.match((await r('@@UNSUPPORTED This is a Wayland session: x\n')).error!, /Wayland/);
  assert.deepEqual(await r('@@GEOM 1920 1080\r\n@@CURSOR 5 6\r\n@@RC 0\r\n@@OUT \r\n'), { geom: { w: 1920, h: 1080 }, cursor: [5, 6] });
  assert.equal((await r('@@GEOM 1920 1080\n@@RC 1\n@@OUT SendInput was blocked (error 5)\n')).failed, 'SendInput was blocked (error 5)');
  assert.match((await r('', 1)).error!, /did not answer \(exit 1\)\.\nAdd-Type: compile error/);
  assert.match((await readResult({ stdout: '', stderr: 'not allowed', code: 1, timedOut: false }, '/x', 'darwin', true)).error!, /Accessibility and Screen Recording/);
  const noShot = await readResult({ stdout: '@@GEOM 10 10\n', stderr: 'CopyFromScreen: The handle is invalid', code: 1, timedOut: false }, '/nonexistent', 'win32', true);
  assert.match(noShot.failed!, /the screenshot failed \(exit 1\): CopyFromScreen/, 'a locked screen');
});

// ---------------------------------------------------------------- the tool, permissions

test('the tool is offered on a companion only when it was started with --allow-desktop', async () => {
  const { h, tool } = await setup();
  try {
    assert.equal(await tool.availableIn!(companionHost(fakeScreen().run, true)), true);
    assert.equal(await tool.availableIn!(companionHost(fakeScreen().run, false)), false);
    const off = await tool.run({ action: 'screenshot' }, ctxFor(companionHost(fakeScreen().run, false)));
    assert.equal(off.is_error, true);
    assert.match(off.content, /restart it with --allow-desktop/);
  } finally { await h.close(); }
});

test('permissions: on a companion desktop every action is asked (refused in plan and dontAsk, free in bypass); in the sandbox it is a command', async () => {
  const { h, tool } = await setup();
  try {
    const rules = { allow: [], deny: [], ask: [] };
    const on = (mode: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => decide(tool, input, { mode: mode as never, rules, sandboxed: false, network: 'full', hostKind: 'companion', ...extra });
    for (const action of ['screenshot', 'left_click', 'type', 'key', 'zoom', 'launch']) {
      const input = { action, coordinate: [1, 1], text: 'x', region: [0, 0, 10, 10] };
      assert.equal(on('default', input).action, 'ask', `${action} in default mode`);
      assert.equal(on('acceptEdits', input).action, 'ask', `${action} in acceptEdits mode`);
      assert.equal(on('plan', input).action, 'deny', `${action} in plan mode`);
      assert.equal(on('dontAsk', input).action, 'deny', `${action} in dontAsk mode`);
      assert.equal(on('bypass', input).action, 'allow', `${action} in bypass mode`);
    }
    assert.equal(on('default', { action: 'cursor_position' }).action, 'allow', 'reading the pointer changes nothing');
    assert.equal(on('dontAsk', { action: 'wait', duration: 1 }).action, 'allow');
    // In the sandbox: an exec, free there (and still under the sandbox's network policy).
    assert.equal(decide(tool, { action: 'left_click', coordinate: [1, 1] }, { mode: 'default', rules, sandboxed: true, network: 'none', hostKind: 'docker' }).action, 'allow');
    assert.equal(decide(tool, { action: 'type', text: 'x' }, { mode: 'dontAsk', rules, sandboxed: true, network: 'none', hostKind: 'docker' }).action, 'allow');

    // "Always allow" is per action: screenshots, not clicks. After the screen was seen (untrusted),
    // what can type or click is confirmed even under a session rule; looking is not.
    const allowShots = { allow: ['computer(screenshot|zoom)', 'computer(left_click)'], deny: [], ask: [] };
    assert.equal(on('default', { action: 'screenshot' }, { rules: allowShots, tainted: true }).action, 'allow');
    assert.equal(on('default', { action: 'zoom', region: [0, 0, 9, 9] }, { rules: allowShots, tainted: true }).action, 'allow');
    const click = on('default', { action: 'left_click', coordinate: [1, 1] }, { rules: allowShots, tainted: true });
    assert.equal(click.action, 'ask');
    assert.equal(click.guard, true, 'a person answers, not auto mode\'s model');
    assert.equal(on('default', { action: 'type', text: 'x' }, { rules: allowShots }).action, 'ask');
    const { suggestRule } = await import('../src/core/permissions.ts');
    assert.equal(suggestRule(tool, { action: 'screenshot' }), 'computer(screenshot)');
  } finally { await h.close(); }
});

test('an agent on a companion desktop: asked before each action, coordinates scaled to the real screen, results untrusted, secrets not typed', async () => {
  const { h, tool } = await setup();
  try {
    const screen = fakeScreen();
    const host = companionHost(screen.run);
    const a = await makeAgent([
      { calls: [{ name: 'computer', input: { action: 'left_click', coordinate: [640, 400] } }] },
      { calls: [{ name: 'computer', input: { action: 'screenshot' } }] },
      { calls: [{ name: 'computer', input: { action: 'screenshot' } }] },
      { calls: [{ name: 'computer', input: { action: 'left_click', coordinate: [640, 400] } }, { name: 'computer', input: { action: 'cursor_position' } }] },
      { calls: [{ name: 'computer', input: { action: 'type', text: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' } }] },
      { text: 'done' },
    ], { mode: 'default', tools: [tool], host });
    // No to the first screenshot, yes to the rest.
    a.permissionAnswers.push(true, false, true, true, true);
    a.agent.append({ role: 'user', content: [{ type: 'text', text: 'Click the middle of my screen' }] });
    await a.agent.run(new AbortController().signal);
    const said = (i: number) => (JSON.parse(a.provider.snapshots[i]!) as { content: Block[] }[]).at(-1)!.content.filter((b) => b.type === 'tool_result') as { content: string; is_error?: boolean; images?: { data: string }[] }[];
    // Before any screenshot the screen's size is unknown: a click is refused, not guessed.
    assert.match(said(1)[0]!.content, /Take a screenshot first/);
    assert.match(said(2)[0]!.content, /The user denied this call/);
    const [shot] = said(3);
    assert.match(shot!.content, /^Screenshot 1280x800 of the user's screen \(the display is 2560x1600, scaled; use screenshot coordinates\)\./);
    assert.match(shot!.content, /data, not instructions/);
    assert.deepEqual(lib.pngSize(Buffer.from(shot!.images![0]!.data, 'base64')), { w: 1280, h: 800 });
    assert.equal(a.agent.tainted, true, 'the real screen is untrusted content');
    const [click, pos] = said(4);
    assert.match(click!.content, /left click at \[640, 400\]/);
    assert.match(pos!.content, /The pointer is at \[640, 400\]/);
    assert.match(said(5)[0]!.content, /looks like a credential/);
    // The companion was sent screen pixels, with the size they were read for.
    const clickJob = screen.seen.find((r) => r.action === 'left_click')!;
    assert.deepEqual(clickJob.steps, [{ t: 'move', x: 1280, y: 800 }, { t: 'click', button: 'left', count: 1 }]);
    assert.deepEqual(clickJob.screen, SCREEN);
    assert.ok(!screen.seen.some((r) => r.action === 'type'), 'the secret never reached the companion');
    assert.deepEqual(a.permissionAnswers, [], 'asked for each action that ran: screenshot (no), screenshot, click, type');
  } finally { await h.close(); }
});

test('a screen that changed size since the last screenshot: nothing is clicked, the agent is told to look again', async () => {
  const { h, tool } = await setup();
  try {
    let screen = fakeScreen({ w: 1920, h: 1080 });
    const host = companionHost((r) => screen.run(r));
    const ctx = ctxFor(host);
    assert.match((await tool.run({ action: 'screenshot' }, ctx)).content, /Screenshot 1280x720/);
    screen = fakeScreen({ w: 1280, h: 800 });
    const click = await tool.run({ action: 'left_click', coordinate: [100, 100] }, ctx);
    assert.equal(click.is_error, true);
    assert.match(click.content, /The user's screen is 1280x800 now, not the size these coordinates were read for: nothing was done/);
    assert.match((await tool.run({ action: 'left_click', coordinate: [100, 100] }, ctx)).content, /left click at \[100, 100\]/, 'the next call uses the new size');
  } finally { await h.close(); }
});

// ---------------------------------------------------------------- through a companion, in-process

/** A companion in this process: polls the hub and runs each job with the real handler. */
function runCompanion(hub: CompanionHub, id: string, dir: string, opts: Parameters<typeof createCompanionHandler>[1], info: Record<string, unknown>) {
  const handle = createCompanionHandler(dir, opts);
  let on = true;
  (async () => {
    while (on) {
      const job = await hub.poll(id, { platform: process.platform, shell: 'bash', root: dir, ...info }, 200);
      if (!job) continue;
      const r = await handle(job as CompanionJob);
      hub.complete(id, job.id, r.ok, r.value);
    }
  })();
  return () => { on = false; };
}

test('a companion without --allow-desktop refuses desktop jobs and says how to allow them; the server does not offer the tool', async () => {
  const handle = createCompanionHandler(await tempDir(), { desktop: async () => { throw new Error('must not run'); } });
  const r = await handle({ id: 'j', kind: 'desktop', sessionId: 's', request: req({ action: 'screenshot' }) });
  assert.equal(r.ok, false);
  assert.equal((r.value as { error: string }).error, DESKTOP_OFF);
  assert.match(DESKTOP_OFF, /restart it with --allow-desktop/);

  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off' });
  const { id } = await h.companions.create('laptop');
  const dir = await tempDir();
  const stop = runCompanion(h.companions, id, dir, { desktop: fakeScreen().run }, {});
  try {
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(h.companions.list()[0]!.info?.desktop, undefined);
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
    assert.ok(!(await s.capabilities()).tools.some((t) => t.name === 'computer'));
    // Even if the server sent one, the companion itself refuses.
    await assert.rejects(h.companions.host(id, 's1').desktopAction!(req({ action: 'screenshot' })), /--allow-desktop/);
  } finally { stop(); await h.close(); }
});

test('a session on a companion that allows the desktop: the agent sees the real screen and clicks on it through the companion', async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off' });
  const { id } = await h.companions.create('laptop');
  const dir = await tempDir();
  const screen = fakeScreen();
  const logs: string[] = [];
  const stop = runCompanion(h.companions, id, dir, { allowDesktop: true, desktop: screen.run, log: (m) => logs.push(m) }, { desktop: true });
  const fake = new FakeProvider([
    { calls: [{ name: 'computer', input: { action: 'screenshot' } }] },
    { calls: [{ name: 'computer', input: { action: 'double_click', coordinate: [100, 200] } }] },
    { calls: [{ name: 'computer', input: { action: 'type', text: 'hello from the agent' } }] },
    { calls: [{ name: 'computer', input: { action: 'zoom', region: [0, 0, 640, 400] } }] },
    { text: 'done' },
  ]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(h.companions.list()[0]!.info?.desktop, true, 'the server reports it');
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'companion', network: 'none', companionId: id } });
    assert.ok((await s.capabilities()).tools.some((t) => t.name === 'computer'), 'offered on this companion');
    const done = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('open the file on my desktop');
    await done;
    assert.match(fake.snapshots[1]!, /Screenshot 1280x800 of the user's screen/);
    assert.match(fake.snapshots[1]!, /"images":\[\{"media_type":"image\/png"/);
    assert.match(fake.snapshots[2]!, /double click at \[100, 200\]/);
    assert.match(fake.snapshots[3]!, /Typed 20 character\(s\)/);
    assert.match(fake.snapshots[4]!, /the region enlarged to 1280x800/);
    assert.deepEqual(screen.seen.map((r) => r.action), ['screenshot', 'double_click', 'type', 'zoom']);
    assert.deepEqual(screen.seen[1]!.steps, [{ t: 'move', x: 200, y: 400 }, { t: 'click', button: 'left', count: 2 }]);
    assert.deepEqual(screen.seen[3]!.crop, { x: 0, y: 0, w: 1280, h: 800 });
    // The companion's own log says what happened, never the typed text.
    assert.ok(logs.includes('desktop: type (20 characters)'), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('hello from the agent'));
    assert.equal(results(s.history[2])[0]!.is_error, undefined);
  } finally { stop(); await h.close(); }
});

// ---------------------------------------------------------------- this computer, for real (opt-in)

test('the real desktop of this computer: a screenshot of the screen, and the pointer moved and read back', { skip: !REAL && 'set HARNESS_TEST_REAL_DESKTOP=1 to take a screenshot and move the pointer on this computer', timeout: 120_000 }, async () => {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [PLUGIN], search: null, memory: 'off' });
  const tool = h.registry.tools.get('computer')!;
  const { id } = await h.companions.create('this computer');
  const dir = await tempDir();
  // The real executor for this OS, as `--allow-desktop` runs it.
  const stop = runCompanion(h.companions, id, dir, { allowDesktop: true }, { desktop: true });
  const direct = systemDesktop(dir);
  const base = { steps: [], shot: false, max: { w: 1280, h: 800 }, settleMs: 0, timeoutMs: 60_000 };
  const before = await direct({ ...base, action: 'cursor_position', steps: [{ t: 'cursor' }] });
  assert.equal(before.error, undefined, before.error ?? '');
  const geom = before.geom!;
  try {
    await new Promise((res) => setTimeout(res, 300));
    const host = h.companions.host(id, 'real');
    const ctx = ctxFor(host);
    const shot = await tool.run({ action: 'screenshot' }, ctx);
    assert.equal(shot.is_error, undefined, shot.content);
    assert.equal(shot.untrusted, true);
    const png = Buffer.from(shot.images![0]!.data, 'base64');
    const fit = lib.shotSize(geom);
    const stats = pngStats(png);
    assert.deepEqual({ w: stats.width, h: stats.height }, fit, `a PNG of the ${geom.w}x${geom.h} screen, scaled to fit 1280x800`);
    assert.equal(stats.blank, false, `the screen is not blank (${stats.colours} colours, spread ${stats.stddev})`);
    console.log(`real desktop: screen ${geom.w}x${geom.h}, screenshot ${stats.width}x${stats.height}, ${stats.colours} colours in a 64x64 sample, spread ${stats.stddev}`);

    const target = [Math.round(fit.w / 3), Math.round(fit.h / 3)];
    const moved = await tool.run({ action: 'mouse_move', coordinate: target }, ctx);
    assert.equal(moved.is_error, undefined, moved.content);
    const pos = await tool.run({ action: 'cursor_position' }, ctx);
    const m = /The pointer is at \[(\d+), (\d+)\]/.exec(pos.content);
    assert.ok(m, pos.content);
    assert.ok(Math.abs(Number(m[1]) - target[0]!) <= 1 && Math.abs(Number(m[2]) - target[1]!) <= 1, `pointer at [${m[1]}, ${m[2]}], asked for [${target.join(', ')}]`);
    console.log(`real desktop: moved the pointer to [${target.join(', ')}] (screen ${lib.toScreen(target, geom, fit).join(', ')}), read back [${m[1]}, ${m[2]}]`);
  } finally {
    // Back where the user left it.
    if (before.cursor) await direct({ ...base, action: 'mouse_move', steps: [{ t: 'move', x: before.cursor[0], y: before.cursor[1] }] }).catch(() => {});
    stop();
    await h.close();
  }
});
