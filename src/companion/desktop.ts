import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ExecResult, run } from '../runtime/host.ts';

// The user's real desktop, for the computer tool, on a companion started with
// --allow-desktop. The server sends a validated plan in screen pixels (the
// computer plugin's lib.mjs); here it becomes a script for this OS, built only
// from what the OS ships with:
//   Windows  PowerShell: user32 SendInput / SetCursorPos through Add-Type, and
//            System.Drawing's CopyFromScreen for screenshots (DPI aware, so
//            coordinates are pixels)
//   macOS    osascript (JavaScript for Automation): CoreGraphics mouse events,
//            System Events keys, screencapture and sips
//   Linux    X11 with xdotool and ImageMagick, as in the sandbox; Wayland is not supported
// Every value from the server is checked again here, and text reaches the
// scripts only as base64 or a quoted literal: a plan cannot become code.

export type DesktopStep =
  | { t: 'move'; x: number; y: number }
  | { t: 'click'; button: 'left' | 'right' | 'middle'; count: 1 | 2 }
  | { t: 'down' | 'up'; button: 'left' }
  | { t: 'sleep'; ms: number }
  | { t: 'type'; text: string }
  | { t: 'key'; combos: string[] }
  | { t: 'scroll'; dir: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { t: 'cursor' };

export interface Size { w: number; h: number }

/** One computer call on the real desktop (the `desktop` job). */
export interface DesktopRequest {
  action: string;
  steps: DesktopStep[];
  /** The screen size the coordinates were read for: nothing is done when the screen is not this size. */
  screen?: Size;
  shot: boolean;
  /** A region of the screen, in screen pixels, enlarged to fit `max` (zoom). */
  crop?: { x: number; y: number; w: number; h: number };
  /** Screenshots are scaled down to fit this (a crop is scaled to fit it). */
  max: Size;
  settleMs: number;
  /** A command that starts an app, detached, in the companion's folder. */
  launch?: string;
  timeoutMs: number;
}

export interface DesktopResult {
  /** The screen size now (primary display; on macOS in points). */
  geom?: Size;
  /** The screen is not the size the coordinates were read for: nothing was done. */
  mismatch?: boolean;
  /** Something failed: why, and what to do (install a tool, an unsupported session). */
  error?: string;
  /** An action failed partway: its message. */
  failed?: string;
  cursor?: [number, number];
  /** The screenshot, base64 PNG. */
  png?: string;
  /** launch: where its output goes. */
  log?: string;
}

/** Runs one request on this computer's desktop (the default executor; tests use a stand-in). */
export type DesktopExecutor = (req: DesktopRequest, signal?: AbortSignal) => Promise<DesktopResult>;

const ACTIONS = new Set(['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'left_click_drag', 'type', 'key', 'scroll', 'wait', 'cursor_position', 'zoom', 'launch']);
const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const size = (v: unknown, lo = 1) => !!v && typeof v === 'object' && int((v as Size).w, lo, 20_000) && int((v as Size).h, lo, 20_000);

/** Throws unless the request is exactly the shape the server sends. */
export function checkRequest(req: DesktopRequest): void {
  const bad = (what: string) => { throw new Error(`desktop: ${what}`); };
  if (!req || typeof req !== 'object') bad('no request');
  if (!ACTIONS.has(req.action)) bad(`unknown action ${String(req.action).slice(0, 40)}`);
  if (!Array.isArray(req.steps) || req.steps.length > 50) bad('steps must be a list of at most 50');
  for (const s of req.steps) {
    switch (s?.t) {
      case 'move': if (!int(s.x, 0, 20_000) || !int(s.y, 0, 20_000)) bad('move needs whole x and y'); break;
      case 'click': if (!['left', 'right', 'middle'].includes(s.button) || (s.count !== 1 && s.count !== 2)) bad('click needs a button and a count of 1 or 2'); break;
      case 'down': case 'up': if (s.button !== 'left') bad('only the left button is held'); break;
      case 'sleep': if (!int(s.ms, 0, 5000)) bad('sleep is 0-5000 ms'); break;
      case 'type': if (typeof s.text !== 'string' || !s.text || s.text.length > 5000) bad('type needs 1-5000 characters'); break;
      case 'key':
        if (!Array.isArray(s.combos) || !s.combos.length || s.combos.length > 20) bad('key needs 1-20 combinations');
        for (const c of s.combos) if (typeof c !== 'string' || !c || c.length > 64 || /[\x00-\x20\x7f]/.test(c)) bad('a key combination is not a key name');
        break;
      case 'scroll': if (!['up', 'down', 'left', 'right'].includes(s.dir) || !int(s.amount, 1, 30)) bad('scroll needs a direction and 1-30 clicks'); break;
      case 'cursor': break;
      default: bad(`unknown step ${String((s as { t?: unknown })?.t).slice(0, 20)}`);
    }
  }
  if (req.screen !== undefined && !size(req.screen)) bad('screen must be {w, h}');
  if (req.crop !== undefined && (!int(req.crop.x, 0, 20_000) || !int(req.crop.y, 0, 20_000) || !size(req.crop))) bad('crop must be {x, y, w, h}');
  if (!size(req.max, 16)) bad('max must be {w, h}');
  if (!int(req.settleMs, 0, 10_000)) bad('settleMs is 0-10000');
  if (req.launch !== undefined && (typeof req.launch !== 'string' || !req.launch.trim() || req.launch.length > 2000)) bad('launch needs a command');
  if (!int(req.timeoutMs, 1000, 600_000)) bad('timeoutMs is 1-600 s');
}

/** "ctrl+shift+T" -> ["ctrl", "shift", "T"], names as xdotool spells them (lib.mjs has mapped the usual aliases). */
const parts = (combo: string) => combo.split('+').filter(Boolean);

// ---------------------------------------------------------------- Windows

/** xdotool key names -> Windows virtual-key codes (lower case). */
const WIN_VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, control_l: 0xa2, control_r: 0xa3, shift: 0x10, shift_l: 0xa0, shift_r: 0xa1,
  alt: 0x12, alt_l: 0xa4, alt_r: 0xa5, super: 0x5b, super_l: 0x5b, super_r: 0x5c, meta_l: 0x5b, meta_r: 0x5c,
  return: 0x0d, kp_enter: 0x0d, escape: 0x1b, backspace: 0x08, tab: 0x09, iso_left_tab: 0x09, space: 0x20,
  delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, page_up: 0x21, prior: 0x21, page_down: 0x22, next: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, print: 0x2c, pause: 0x13, caps_lock: 0x14, num_lock: 0x90, scroll_lock: 0x91, menu: 0x5d,
  minus: 0xbd, equal: 0xbb, plus: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf, semicolon: 0xba, apostrophe: 0xde,
  bracketleft: 0xdb, bracketright: 0xdd, backslash: 0xdc, grave: 0xc0,
  '-': 0xbd, '=': 0xbb, ',': 0xbc, '.': 0xbe, '/': 0xbf, ';': 0xba, '\'': 0xde, '[': 0xdb, ']': 0xdd, '\\': 0xdc, '`': 0xc0,
};

/** One key name as a virtual-key code; throws for a name Windows has no key for. */
export function winKey(name: string): number {
  const k = name.toLowerCase();
  if (k in WIN_VK) return WIN_VK[k]!;
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  const f = /^f([1-9]|1\d|2[0-4])$/.exec(k);
  if (f) return 0x70 + Number(f[1]) - 1;
  throw new Error(`key: "${name}" is not a key this companion knows on Windows (use names like Return, Tab, Escape, ctrl+l, F5, Page_Down)`);
}

/** user32 through P/Invoke: SendInput for buttons, wheel and keys (Unicode for text), SetCursorPos, GetCursorPos. */
const WIN_CS = `using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class HarnessDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static void Send(INPUT i) {
    if (SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput was blocked (error " + Marshal.GetLastWin32Error() + "): the window in front may belong to a program running as administrator");
  }
  public static void Move(int x, int y) { if (!SetCursorPos(x, y)) throw new Exception("SetCursorPos failed"); Thread.Sleep(30); }
  public static void Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = (uint)data; Send(i); }
  public static void Click(uint down, uint up, int count) { for (int n = 0; n < count; n++) { if (n > 0) Thread.Sleep(90); Mouse(down, 0); Mouse(up, 0); } }
  public static void Wheel(uint flags, int delta, int count) { for (int n = 0; n < count; n++) { Mouse(flags, delta); Thread.Sleep(40); } }
  static bool Extended(int vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0xA3 || vk == 0xA5 || vk == 0x90 || vk == 0x2C; }
  public static void Key(int vk, bool up) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = (ushort)vk; i.u.ki.dwFlags = (uint)((up ? 2 : 0) | (Extended(vk) ? 1 : 0)); Send(i); }
  public static void Combo(int[] vks) { foreach (int vk in vks) { Key(vk, false); Thread.Sleep(10); } for (int n = vks.Length - 1; n >= 0; n--) { Key(vks[n], true); Thread.Sleep(10); } Thread.Sleep(40); }
  static void Unicode(char c, bool up) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = c; i.u.ki.dwFlags = (uint)(4 | (up ? 2 : 0)); Send(i); }
  public static void Text(string s) {
    for (int n = 0; n < s.Length; n++) {
      char c = s[n];
      if (c == '\\r') { if (n + 1 < s.Length && s[n + 1] == '\\n') continue; Combo(new int[] { 0x0D }); continue; }
      if (c == '\\n') { Combo(new int[] { 0x0D }); continue; }
      if (c == '\\t') { Combo(new int[] { 0x09 }); continue; }
      Unicode(c, false); Unicode(c, true); Thread.Sleep(8);
    }
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + " " + p.Y; }
}`;

/** A PowerShell single-quoted string. */
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const psText = (s: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;

const WIN_BUTTON = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] } as const;

/** One step as PowerShell. */
export function winStep(s: DesktopStep): string {
  switch (s.t) {
    case 'move': return `[HarnessDesktop]::Move(${s.x}, ${s.y})`;
    case 'click': { const [d, u] = WIN_BUTTON[s.button]; return `[HarnessDesktop]::Click(0x${d.toString(16)}, 0x${u.toString(16)}, ${s.count})`; }
    case 'down': return '[HarnessDesktop]::Mouse(0x2, 0)';
    case 'up': return '[HarnessDesktop]::Mouse(0x4, 0)';
    case 'sleep': return `Start-Sleep -Milliseconds ${s.ms}`;
    case 'type': return `[HarnessDesktop]::Text(${psText(s.text)})`;
    case 'key': return s.combos.map((c) => `[HarnessDesktop]::Combo(@(${parts(c).map((k) => `0x${winKey(k).toString(16)}`).join(', ')}))`).join('; ');
    // WHEEL (0x800) is up/down, HWHEEL (0x1000) left/right; 120 per click.
    case 'scroll': return `[HarnessDesktop]::Wheel(${s.dir === 'up' || s.dir === 'down' ? '0x800' : '0x1000'}, ${s.dir === 'up' || s.dir === 'right' ? 120 : -120}, ${s.amount})`;
    case 'cursor': return '"@@CURSOR $([HarnessDesktop]::Cursor())"';
  }
}

/** The whole PowerShell script for one request. */
export function windowsScript(req: DesktopRequest, o: { shotFile: string; dir: string; logFile?: string }): string {
  const L = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Add-Type -TypeDefinition @'\n${WIN_CS}\n'@`,
    'Add-Type -AssemblyName System.Drawing',
    // Before anything measures the screen: coordinates and captures in real pixels, not scaled ones.
    '[void][HarnessDesktop]::SetProcessDPIAware()',
    '$w = [HarnessDesktop]::GetSystemMetrics(0); $h = [HarnessDesktop]::GetSystemMetrics(1)',
    '"@@GEOM $w $h"',
  ];
  if (req.screen) L.push(`if ($w -ne ${req.screen.w} -or $h -ne ${req.screen.h}) { '@@MISMATCH'; exit 0 }`);
  const acts = req.steps.map(winStep);
  if (req.launch) {
    acts.push(`Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', ${psText(req.launch)}) -WorkingDirectory ${psq(o.dir)} -WindowStyle Hidden`);
  }
  if (acts.length) {
    L.push('try {', ...acts.map((a) => `  ${a}`), "  '@@RC 0'", '} catch { \'@@RC 1\'; "@@OUT $($_.Exception.Message -replace \'\\s+\', \' \')" }');
  }
  if (req.shot) {
    if (req.settleMs) L.push(`Start-Sleep -Milliseconds ${req.settleMs}`);
    const c = req.crop;
    L.push(
      c ? `$cx = ${c.x}; $cy = ${c.y}; $cw = ${c.w}; $ch = ${c.h}` : '$cx = 0; $cy = 0; $cw = $w; $ch = $h',
      // Fit max: a full screen only ever shrinks, a zoomed region is enlarged.
      `$f = [Math]::Min(${c ? '[double]::MaxValue' : '1.0'}, [Math]::Min(${req.max.w} / $cw, ${req.max.h} / $ch))`,
      '$tw = [Math]::Max(1, [int][Math]::Round($cw * $f)); $th = [Math]::Max(1, [int][Math]::Round($ch * $f))',
      '$bmp = New-Object System.Drawing.Bitmap $cw, $ch',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($cx, $cy, 0, 0, $bmp.Size)',
      '$g.Dispose()',
      'if ($tw -ne $cw -or $th -ne $ch) {',
      '  $small = New-Object System.Drawing.Bitmap $tw, $th',
      '  $g = [System.Drawing.Graphics]::FromImage($small)',
      '  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
      '  $g.DrawImage($bmp, 0, 0, $tw, $th)',
      '  $g.Dispose(); $bmp.Dispose(); $bmp = $small',
      '}',
      `$bmp.Save(${psq(o.shotFile)}, [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$bmp.Dispose()',
      "'@@SHOT'",
    );
  }
  return `${L.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- macOS

/** xdotool key names -> macOS virtual key codes (ANSI layout). */
const MAC_KEY: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, equal: 24, 9: 25, 7: 26, minus: 27, 8: 28, 0: 29, bracketright: 30, o: 31, u: 32,
  bracketleft: 33, i: 34, p: 35, return: 36, kp_enter: 76, l: 37, j: 38, apostrophe: 39, k: 40, semicolon: 41, backslash: 42,
  comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, iso_left_tab: 48, space: 49, grave: 50, backspace: 51, escape: 53,
  super: 55, super_l: 55, meta_l: 55, shift: 56, shift_l: 56, caps_lock: 57, alt: 58, alt_l: 58, ctrl: 59, control: 59, control_l: 59,
  shift_r: 60, alt_r: 61, control_r: 62, f17: 64, f18: 79, f19: 80, f20: 90, f5: 96, f6: 97, f7: 98, f3: 99, f8: 100, f9: 101,
  f11: 103, f13: 105, f16: 106, f14: 107, f10: 109, f12: 111, f15: 113, insert: 114, home: 115, page_up: 116, prior: 116,
  delete: 117, f4: 118, end: 119, f2: 120, page_down: 121, next: 121, f1: 122, left: 123, right: 124, down: 125, up: 126,
  '-': 27, '=': 24, ',': 43, '.': 47, '/': 44, ';': 41, '\'': 39, '[': 33, ']': 30, '\\': 42, '`': 50,
};
/** Modifiers as System Events' `using` names. */
const MAC_MOD: Record<string, string> = {
  ctrl: 'control down', control: 'control down', control_l: 'control down', control_r: 'control down',
  shift: 'shift down', shift_l: 'shift down', shift_r: 'shift down', alt: 'option down', alt_l: 'option down', alt_r: 'option down',
  super: 'command down', super_l: 'command down', super_r: 'command down', meta_l: 'command down', meta_r: 'command down',
};

/** One combination as [key code, modifiers]; throws for a key macOS has no code for here. */
export function macKey(combo: string): [number, string[]] {
  const ks = parts(combo).map((k) => k.toLowerCase());
  const main = ks.at(-1) ?? '';
  const mods = ks.slice(0, -1).map((m) => {
    if (!(m in MAC_MOD)) throw new Error(`key: "${m}" is not a modifier (ctrl, shift, alt, super)`);
    return MAC_MOD[m]!;
  });
  if (!(main in MAC_KEY)) throw new Error(`key: "${main}" is not a key this companion knows on macOS (use names like Return, Tab, Escape, super+l, F5, Page_Down)`);
  return [MAC_KEY[main]!, mods];
}

const js = (v: unknown) => JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const MAC_BUTTON = { left: [1, 2, 0], right: [3, 4, 1], middle: [25, 26, 2] } as const;

/** One step as JXA. */
export function macStep(s: DesktopStep): string {
  switch (s.t) {
    case 'move': return `mouse(5, ${s.x}, ${s.y}, 0); at = [${s.x}, ${s.y}]; delay(0.03);`;
    case 'click': { const [d, u, b] = MAC_BUTTON[s.button]; return `for (let n = 1; n <= ${s.count}; n++) { if (n > 1) delay(0.09); mouse(${d}, at[0], at[1], ${b}, n); mouse(${u}, at[0], at[1], ${b}, n); }`; }
    case 'down': return 'mouse(1, at[0], at[1], 0, 1); held = true;';
    case 'up': return 'mouse(2, at[0], at[1], 0, 1); held = false;';
    case 'sleep': return `delay(${s.ms / 1000});`;
    case 'type': return `typeText(${js(s.text)});`;
    case 'key': return s.combos.map((c) => { const [code, mods] = macKey(c); return `se.keyCode(${code}${mods.length ? `, { using: ${js(mods)} }` : ''}); delay(0.05);`; }).join(' ');
    case 'scroll': return `scroll(${s.dir === 'up' ? s.amount : s.dir === 'down' ? -s.amount : 0}, ${s.dir === 'left' ? s.amount : s.dir === 'right' ? -s.amount : 0});`;
    case 'cursor': return "out.push('@@CURSOR ' + pos().join(' '));";
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;

/**
 * The whole JXA script for one request (osascript -l JavaScript). Coordinates
 * are points, as CoreGraphics events use them; screenshots are scaled to points.
 * Not run here (no Mac): tested as generated text.
 */
export function macScript(req: DesktopRequest, o: { shotFile: string; dir: string; logFile: string }): string {
  const L = [
    "ObjC.import('CoreGraphics');",
    'function run() {',
    '  const out = [];',
    '  const app = Application.currentApplication(); app.includeStandardAdditions = true;',
    "  const se = Application('System Events');",
    '  const bounds = $.CGDisplayBounds($.CGMainDisplayID());',
    '  const w = Math.round(bounds.size.width), h = Math.round(bounds.size.height);',
    "  out.push('@@GEOM ' + w + ' ' + h);",
  ];
  if (req.screen) L.push(`  if (w !== ${req.screen.w} || h !== ${req.screen.h}) { out.push('@@MISMATCH'); return out.join('\\n'); }`);
  L.push(
    '  const pos = () => { const p = $.CGEventGetLocation($.CGEventCreate(null)); return [Math.round(p.x), Math.round(p.y)]; };',
    '  let at = pos(); let held = false;',
    // kCGHIDEventTap = 0; field 1 = kCGMouseEventClickState (a double click is click state 2).
    '  const mouse = (type, x, y, button, clicks) => { const e = $.CGEventCreateMouseEvent(null, held && type === 5 ? 6 : type, { x: x, y: y }, button); if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); $.CGEventPost(0, e); };',
    '  const scroll = (dy, dx) => { const e = typeof $.CGEventCreateScrollWheelEvent2 === \'function\' ? $.CGEventCreateScrollWheelEvent2(null, 1, 2, dy, dx, 0) : $.CGEventCreateScrollWheelEvent(null, 1, 2, dy, dx); $.CGEventPost(0, e); };',
    "  const typeText = (t) => { t.replace(/\\r\\n?/g, '\\n').split('\\n').forEach((line, n) => { if (n) { se.keyCode(36); delay(0.05); } if (line) se.keystroke(line); }); };",
  );
  const acts = req.steps.map(macStep);
  if (req.launch) acts.push(`app.doShellScript(${js(`cd ${shq(o.dir)} && (nohup /bin/sh -c ${shq(req.launch)} >${shq(o.logFile)} 2>&1 </dev/null &)`)}); out.push(${js(`@@LOG ${o.logFile}`)});`);
  if (acts.length) L.push('  try {', ...acts.map((a) => `    ${a}`), "    out.push('@@RC 0');", "  } catch (e) { out.push('@@RC 1', '@@OUT ' + String(e).replace(/\\s+/g, ' ')); }");
  if (req.shot) {
    if (req.settleMs) L.push(`  delay(${req.settleMs / 1000});`);
    const c = req.crop;
    L.push(
      c ? `  const cw = ${c.w}, ch = ${c.h};` : '  const cw = w, ch = h;',
      `  const f = Math.min(${c ? 'Infinity' : '1'}, ${req.max.w} / cw, ${req.max.h} / ch);`,
      '  const tw = Math.max(1, Math.round(cw * f)), th = Math.max(1, Math.round(ch * f));',
      `  app.doShellScript('screencapture -x -t png ${c ? `-R${c.x},${c.y},${c.w},${c.h} ` : ''}' + ${js(shq(o.shotFile))});`,
      // A Retina capture has twice the points: scaled to fit, so its pixels are the points the events use.
      `  app.doShellScript('sips -z ' + th + ' ' + tw + ' ' + ${js(shq(o.shotFile))} + ' >/dev/null');`,
      "  out.push('@@SHOT');",
    );
  }
  L.push("  return out.join('\\n');", '}');
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------- Linux (X11)

const XBUTTON = { left: 1, middle: 2, right: 3 } as const;
const XSCROLL = { up: 4, down: 5, left: 6, right: 7 } as const;

/** One step as an xdotool command (the same lines the sandbox runs). */
export function xdoStep(s: DesktopStep): string {
  switch (s.t) {
    case 'move': return `xdotool mousemove ${s.x} ${s.y}`;
    case 'click': return s.count === 2 ? `xdotool click --repeat 2 --delay 100 ${XBUTTON[s.button]}` : `xdotool click ${XBUTTON[s.button]}`;
    case 'down': return 'xdotool mousedown 1';
    case 'up': return 'xdotool mouseup 1';
    case 'sleep': return `sleep ${(s.ms / 1000).toFixed(2)}`;
    case 'type': return (s.text.match(/[\s\S]{1,50}/g) ?? []).map((c) => `xdotool type --delay 12 -- ${shq(c)}`).join(' && ');
    case 'key': return `xdotool key --delay 50 -- ${s.combos.map(shq).join(' ')}`;
    case 'scroll': return `xdotool click --repeat ${s.amount} --delay 50 ${XSCROLL[s.dir]}`;
    case 'cursor': return 'eval "$(xdotool getmouselocation --shell)" && echo "@@CURSOR $X $Y"';
  }
}

/** The whole bash script for one request on an X11 desktop. */
export function linuxScript(req: DesktopRequest, o: { shotFile: string; dir: string; logFile: string }): string {
  const L = [
    'if [ "$XDG_SESSION_TYPE" = wayland ] || { [ -n "$WAYLAND_DISPLAY" ] && [ -z "$DISPLAY" ]; }; then echo "@@UNSUPPORTED This is a Wayland session: the companion controls X11 desktops only (log in to an X11 / Xorg session to use it)."; exit 0; fi',
    'if [ -z "$DISPLAY" ]; then echo "@@UNSUPPORTED There is no X display (DISPLAY is not set): start the companion from the desktop session."; exit 0; fi',
    'missing=""; for c in xdotool convert; do command -v $c >/dev/null 2>&1 || missing="$missing $c"; done',
    'command -v import >/dev/null 2>&1 || command -v xwd >/dev/null 2>&1 || missing="$missing import"',
    'if [ -n "$missing" ]; then echo "@@MISSING$missing"; exit 0; fi',
    'read -r w h <<EOF\n$(xdotool getdisplaygeometry)\nEOF',
    'echo "@@GEOM $w $h"',
  ];
  if (req.screen) L.push(`if [ "$w" != ${req.screen.w} ] || [ "$h" != ${req.screen.h} ]; then echo '@@MISMATCH'; exit 0; fi`);
  const acts = req.steps.map(xdoStep);
  // Only the app goes to the background (the braces). In `(cd && app &)` the whole list would, in a
  // subshell that keeps the $(...) pipe open until the app exits: the call hung until its timeout.
  if (req.launch) acts.push(`(cd ${shq(o.dir)} && { setsid nohup sh -c ${shq(req.launch)} >${shq(o.logFile)} 2>&1 </dev/null & }) && echo ${shq(`@@LOG ${o.logFile}`)}`);
  if (acts.length) {
    L.push(
      `out=$( { ${acts.join(' && ')}; } 2>&1 ); rc=$?`,
      'printf "%s\\n" "$out" | grep "^@@" ; echo "@@RC $rc"',
      'echo "@@OUT $(printf \'%s\' "$out" | grep -v "^@@" | tr \'\\n\' \' \')"',
    );
  }
  if (req.shot) {
    if (req.settleMs) L.push(`sleep ${(req.settleMs / 1000).toFixed(2)}`);
    const grab = 'if command -v import >/dev/null 2>&1; then import -window root png:-; else xwd -root -silent | convert xwd:- png:-; fi';
    const box = `${req.max.w}x${req.max.h}`;
    const fit = req.crop
      ? `convert png:- -crop ${req.crop.w}x${req.crop.h}+${req.crop.x}+${req.crop.y} +repage -resize ${box} png:${shq(o.shotFile)}`
      : `convert png:- -resize '${box}>' png:${shq(o.shotFile)}`;
    L.push(`{ ${grab}; } | ${fit} && echo '@@SHOT'`);
  }
  return `${L.join('\n')}\n`;
}

// ---------------------------------------------------------------- running it

/** The script's @@NAME value lines. */
export function markers(stdout: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const r = /^@@([A-Z]+)(?: (.*))?$/.exec(line.trimEnd());
    if (r) m[r[1]!] = r[2] ?? '';
  }
  return m;
}

const tail = (r: ExecResult) => (r.stderr || r.stdout).trim().slice(-1200);

/** What the script printed, as a result (the screenshot read from its file). */
export async function readResult(r: ExecResult, shotFile: string, platform: string, wantShot: boolean): Promise<DesktopResult> {
  const m = markers(r.stdout);
  if ('UNSUPPORTED' in m) return { error: m.UNSUPPORTED! };
  if ('MISSING' in m) return { error: `Desktop control on Linux needs xdotool and ImageMagick, and this computer lacks: ${m.MISSING!.trim()}. Install them (Debian/Ubuntu: sudo apt install xdotool imagemagick; Fedora: sudo dnf install xdotool ImageMagick) and try again.` };
  const g = /^(\d+)\s+(\d+)$/.exec((m.GEOM ?? '').trim());
  if (!g) {
    const hint = platform === 'darwin' ? ' On macOS the app running the companion (Terminal, iTerm) needs Accessibility and Screen Recording in System Settings > Privacy & Security.' : '';
    return { error: `The desktop did not answer (exit ${r.code}${r.timedOut ? ', timed out' : ''}).${hint}\n${tail(r)}` };
  }
  const geom = { w: Number(g[1]), h: Number(g[2]) };
  if ('MISMATCH' in m) return { geom, mismatch: true };
  const out: DesktopResult = { geom };
  if ('RC' in m && m.RC !== '0') out.failed = (m.OUT ?? '').trim() || `exit ${m.RC}`;
  const c = /^(-?\d+)\s+(-?\d+)$/.exec((m.CURSOR ?? '').trim());
  if (c) out.cursor = [Number(c[1]), Number(c[2])];
  if ('LOG' in m) out.log = m.LOG;
  if ('SHOT' in m) {
    const png = await fs.readFile(shotFile).catch(() => null);
    if (png) out.png = png.toString('base64');
  }
  if (wantShot && !out.png) out.failed = [out.failed, `the screenshot failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}): ${tail(r)}`].filter(Boolean).join('; ');
  return out;
}

/** The executor for this computer: writes the script for its OS, runs it, reads what it printed. */
export function systemDesktop(dir: string, platform: string = process.platform): DesktopExecutor {
  return async (req, signal) => {
    checkRequest(req);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-desktop-'));
    const shotFile = path.join(tmp, 'shot.png');
    // The app's output outlives this call: next to the other temp files, not in the folder.
    const logFile = path.join(os.tmpdir(), `harness-launch-${Date.now()}.log`);
    const opts = { timeoutMs: req.timeoutMs, signal, cwd: dir };
    try {
      let r: ExecResult;
      if (platform === 'win32') {
        const file = path.join(tmp, 'desktop.ps1');
        // A BOM: Windows PowerShell reads a file without one in the ANSI code page.
        await fs.writeFile(file, `\ufeff${windowsScript(req, { shotFile, dir })}`, 'utf8');
        r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], opts);
      } else if (platform === 'darwin') {
        const file = path.join(tmp, 'desktop.js');
        await fs.writeFile(file, macScript(req, { shotFile, dir, logFile }), 'utf8');
        r = await run('osascript', ['-l', 'JavaScript', file], opts);
      } else {
        const file = path.join(tmp, 'desktop.sh');
        await fs.writeFile(file, linuxScript(req, { shotFile, dir, logFile }), 'utf8');
        r = await run('bash', [file], opts);
      }
      return await readResult(r, shotFile, platform, req.shot);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  };
}
