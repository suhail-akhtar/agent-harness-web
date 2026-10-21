// The computer tool's plan for one call: validated arguments turned into a
// bash script for the sandbox (start the desktop if needed, act with xdotool,
// take a screenshot with ImageMagick). Pure functions, so the command lines
// are tested without Docker.

export const DISPLAY = ':99';
export const DEFAULT_SIZE = { w: 1280, h: 800 };
/** Screenshots larger than this are scaled down to fit; the model's coordinates are scaled back. */
export const MAX_SHOT = { w: 1280, h: 800 };
export const ACTIONS = ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'left_click_drag', 'type', 'key', 'scroll', 'wait', 'cursor_position', 'zoom', 'launch'];
const STATE = '/tmp/home/.computer';
/** Browsers by process name (15 characters at most): what they show comes from the web. */
const BROWSERS = 'firefox(-esr|-bin)?|chromium|chrome|google-chrome|epiphany|falkon|midori|surf|qutebrowser|Web Content';

export const NO_DESKTOP = 'The computer tool needs a desktop, and this session has none. It works in a Docker sandbox session started from the desktop image: the operator builds it (npm run sandbox:image:desktop), allows it with HARNESS_SANDBOX_IMAGES=harness-sandbox-desktop:latest, and a new session picks that image.';

/** The display size from HARNESS_DESKTOP_SIZE ("1280x800"), within sane limits. */
export function desktopSize(env = process.env) {
  const m = /^\s*(\d{3,4})\s*x\s*(\d{3,4})\s*$/i.exec(env.HARNESS_DESKTOP_SIZE ?? '');
  if (!m) return { ...DEFAULT_SIZE };
  const w = Number(m[1]); const h = Number(m[2]);
  return w >= 640 && w <= 3840 && h >= 480 && h <= 2160 ? { w, h } : { ...DEFAULT_SIZE };
}

/** The screenshot size for a screen: the same, or scaled down to fit MAX_SHOT. */
export function shotSize(screen) {
  const f = Math.min(1, MAX_SHOT.w / screen.w, MAX_SHOT.h / screen.h);
  return { w: Math.round(screen.w * f), h: Math.round(screen.h * f) };
}

/** Single-quoted for bash. */
export const q = (s) => `'${String(s).replace(/'/g, `'"'"'`)}'`;

/** Common names models use for keys, mapped to X keysyms. */
const KEY_ALIASES = {
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', backspace: 'BackSpace', del: 'Delete', delete: 'Delete',
  tab: 'Tab', space: 'space', pageup: 'Page_Up', page_up: 'Page_Up', pagedown: 'Page_Down', page_down: 'Page_Down',
  home: 'Home', end: 'End', insert: 'Insert', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', super: 'super', cmd: 'super', win: 'super', meta: 'super',
};

/** "ctrl+L Enter" -> ["ctrl+L", "Return"]; throws on something that is not a key. */
export function keys(text) {
  const parts = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('key needs text: xdotool key names, e.g. "Return", "ctrl+l", "ctrl+shift+t", "F5"');
  if (parts.length > 20) throw new Error('key: at most 20 keys at a time');
  return parts.map((combo) => {
    if (combo.length > 64 || /[\x00-\x1f\x7f'"`$\\;|&<>()]/.test(combo)) throw new Error(`key: "${combo.slice(0, 64)}" is not a key name (use xdotool names, e.g. "Return", "ctrl+l", "slash")`);
    return combo.split('+').map((k) => KEY_ALIASES[k.toLowerCase()] ?? k).join('+');
  });
}

/** A coordinate in screenshot pixels, checked against the screenshot. */
function point(v, name, shot) {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${name} must be [x, y] in screenshot pixels`);
  const [x, y] = v.map(Math.round);
  if (x < 0 || y < 0 || x >= shot.w || y >= shot.h) throw new Error(`${name} [${x}, ${y}] is outside the screen (${shot.w}x${shot.h}; x 0-${shot.w - 1}, y 0-${shot.h - 1})`);
  return [x, y];
}

/** Screenshot pixels -> screen pixels. */
export function toScreen([x, y], screen, shot) {
  return [Math.min(screen.w - 1, Math.round((x * screen.w) / shot.w)), Math.min(screen.h - 1, Math.round((y * screen.h) / shot.h))];
}

/** Screen pixels -> screenshot pixels. */
export function toShot([x, y], screen, shot) {
  return [Math.round((x * shot.w) / screen.w), Math.round((y * shot.h) / screen.h)];
}

const BUTTON = { left_click: 1, middle_click: 2, right_click: 3, double_click: 1 };
const SCROLL_BUTTON = { up: 4, down: 5, left: 6, right: 7 };

/**
 * One call as a plan: { xdo: xdotool command (or ''), shot: take a screenshot,
 * settleMs, waitMs, crop, launch, say: what was done, timeoutMs }.
 * Throws an Error with a message for the model when the arguments are wrong.
 */
export function plan(input, screen) {
  const shot = shotSize(screen);
  const action = String(input.action ?? '');
  if (!ACTIONS.includes(action)) throw new Error(`Unknown action "${action}". One of: ${ACTIONS.join(', ')}`);
  const at = (v, name = 'coordinate') => toScreen(point(v, name, shot), screen, shot);
  const text = typeof input.text === 'string' ? input.text : '';
  const out = { action, xdo: '', shot: true, settleMs: 300, timeoutMs: 30_000, say: '' };
  switch (action) {
    case 'screenshot':
      out.settleMs = 0;
      out.say = 'Screenshot';
      break;
    case 'left_click': case 'right_click': case 'middle_click': case 'double_click': {
      const b = BUTTON[action];
      const click = action === 'double_click' ? `click --repeat 2 --delay 100 ${b}` : `click ${b}`;
      if (input.coordinate !== undefined) {
        const [x, y] = at(input.coordinate);
        out.xdo = `xdotool mousemove ${x} ${y} ${click}`;
        out.say = `${action.replace('_', ' ')} at [${input.coordinate.map(Math.round).join(', ')}]`;
      } else {
        out.xdo = `xdotool ${click}`;
        out.say = `${action.replace('_', ' ')} at the pointer`;
      }
      break;
    }
    case 'mouse_move': {
      if (input.coordinate === undefined) throw new Error('mouse_move needs coordinate [x, y]');
      const [x, y] = at(input.coordinate);
      out.xdo = `xdotool mousemove ${x} ${y}`;
      out.say = `Moved the pointer to [${input.coordinate.map(Math.round).join(', ')}]`;
      break;
    }
    case 'left_click_drag': {
      if (input.start_coordinate === undefined || input.coordinate === undefined) throw new Error('left_click_drag needs start_coordinate and coordinate [x, y]');
      const [sx, sy] = at(input.start_coordinate, 'start_coordinate');
      const [x, y] = at(input.coordinate);
      out.xdo = `xdotool mousemove ${sx} ${sy} mousedown 1 sleep 0.1 mousemove ${x} ${y} sleep 0.1 mouseup 1`;
      out.say = `Dragged from [${input.start_coordinate.map(Math.round).join(', ')}] to [${input.coordinate.map(Math.round).join(', ')}]`;
      break;
    }
    case 'type': {
      if (!text) throw new Error('type needs text');
      if (text.length > 5000) throw new Error('type: at most 5000 characters at a time');
      // In chunks, as Anthropic's reference does: long xdotool type runs drop characters.
      const chunks = text.match(/[\s\S]{1,50}/g) ?? [];
      out.xdo = chunks.map((c) => `xdotool type --delay 12 -- ${q(c)}`).join(' && ');
      out.timeoutMs = 30_000 + text.length * 40;
      out.say = `Typed ${text.length} character(s)`;
      break;
    }
    case 'key': {
      const k = keys(text);
      out.xdo = `xdotool key --delay 50 -- ${k.map(q).join(' ')}`;
      out.say = `Pressed ${k.join(' ')}`;
      break;
    }
    case 'scroll': {
      const dir = String(input.scroll_direction ?? '');
      if (!(dir in SCROLL_BUTTON)) throw new Error('scroll needs scroll_direction: up, down, left or right');
      const n = input.scroll_amount === undefined ? 3 : Number(input.scroll_amount);
      if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('scroll_amount must be a whole number from 1 to 30');
      const move = input.coordinate !== undefined ? `mousemove ${at(input.coordinate).join(' ')} ` : '';
      out.xdo = `xdotool ${move}click --repeat ${n} --delay 50 ${SCROLL_BUTTON[dir]}`;
      out.say = `Scrolled ${dir} ${n}${input.coordinate ? ` at [${input.coordinate.map(Math.round).join(', ')}]` : ''}`;
      break;
    }
    case 'wait': {
      const s = input.duration === undefined ? 1 : Number(input.duration);
      if (!Number.isFinite(s) || s <= 0 || s > 30) throw new Error('wait: duration is seconds, more than 0 and at most 30');
      out.shot = false;
      out.waitMs = Math.round(s * 1000);
      out.say = `Waited ${s} s`;
      break;
    }
    case 'cursor_position':
      out.shot = false;
      out.xdo = 'xdotool getmouselocation --shell';
      out.say = 'Pointer position';
      break;
    case 'zoom': {
      const r = input.region;
      if (!Array.isArray(r) || r.length !== 4) throw new Error('zoom needs region [x1, y1, x2, y2] in screenshot pixels');
      const [x1, y1] = at([r[0], r[1]], 'region start');
      const [x2, y2] = at([Math.max(0, r[2] - 1), Math.max(0, r[3] - 1)], 'region end');
      if (x2 <= x1 || y2 <= y1) throw new Error('zoom: region must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1');
      out.crop = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
      out.settleMs = 0;
      out.say = `Zoomed into [${r.map(Math.round).join(', ')}]`;
      break;
    }
    case 'launch': {
      const cmd = text.trim();
      if (!cmd) throw new Error('launch needs text: the command that starts the app, e.g. "xterm" or "firefox-esr https://example.com"');
      if (cmd.length > 2000) throw new Error('launch: the command is too long');
      out.launch = cmd;
      out.settleMs = 2500;
      out.say = `Launched ${cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd}`;
      break;
    }
  }
  return out;
}

/** Starts Xvfb and the window manager when the display is not up (they outlive the call: setsid, nohup). */
export function ensureScript(screen) {
  return [
    `if ! command -v Xvfb >/dev/null 2>&1 || ! command -v xdotool >/dev/null 2>&1; then echo '@@NODESKTOP'; exit 0; fi`,
    `export DISPLAY=${DISPLAY}`,
    `mkdir -p ${STATE}`,
    'if ! xdpyinfo >/dev/null 2>&1; then',
    `  pgrep -x Xvfb >/dev/null 2>&1 || rm -f /tmp/.X99-lock /tmp/.X11-unix/X99`,
    `  setsid nohup Xvfb ${DISPLAY} -screen 0 ${screen.w}x${screen.h}x24 -nolisten tcp >${STATE}/xvfb.log 2>&1 </dev/null &`,
    '  for i in $(seq 1 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.1; done',
    `  xdpyinfo >/dev/null 2>&1 || { echo '@@NOSTART'; tail -n 20 ${STATE}/xvfb.log; exit 0; }`,
    `  setsid nohup fluxbox >${STATE}/wm.log 2>&1 </dev/null &`,
    '  sleep 1',
    'fi',
    'echo "@@GEOM $(xdotool getdisplaygeometry)"',
  ].join('\n');
}

/** The whole script for one call: ensure the desktop, act, settle, screenshot, look for a browser. */
export function callScript(p, screen) {
  const lines = [ensureScript(screen)];
  if (p.launch) {
    const log = `${STATE}/launch-$(date +%s%N).log`;
    lines.push(
      `log=${log}`,
      `(cd /workspace && setsid nohup bash -lc ${q(p.launch)} >"$log" 2>&1 </dev/null &)`,
      `sleep ${(p.settleMs / 1000).toFixed(1)}`,
      'echo "@@LOG $log"',
      `echo "@@LAUNCHTAIL $(tail -c 600 "$log" | tr '\\n' ' ')"`,
    );
  } else if (p.xdo) {
    lines.push(
      `out=$( { ${p.xdo}; } 2>&1 ); rc=$?`,
      'echo "@@RC $rc"',
      `echo "@@OUT $(printf '%s' "$out" | tr '\\n' ' ')"`,
    );
    if (p.shot && p.settleMs) lines.push(`sleep ${(p.settleMs / 1000).toFixed(1)}`);
  }
  if (p.shot) {
    const box = `${MAX_SHOT.w}x${MAX_SHOT.h}`;
    const grab = p.crop
      ? `import -window root -crop ${p.crop.w}x${p.crop.h}+${p.crop.x}+${p.crop.y} +repage png:- | convert png:- -resize ${box} png:-`
      : `import -window root png:- | convert png:- -resize '${box}>' png:-`;
    lines.push(`echo "@@SHOT $(${grab} | base64 -w0)"`);
    lines.push(`if pgrep -x ${q(BROWSERS)} >/dev/null 2>&1; then echo '@@BROWSER 1'; else echo '@@BROWSER 0'; fi`);
  }
  return lines.join('\n');
}

/** The script's markers: @@NAME value lines. */
export function parseOutput(stdout) {
  const m = {};
  for (const line of stdout.split('\n')) {
    const r = /^@@([A-Z]+)(?: (.*))?$/.exec(line.trimEnd());
    if (r) m[r[1]] = r[2] ?? '';
  }
  return m;
}

/** Width and height from a PNG's header, or null when it is not a PNG. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
