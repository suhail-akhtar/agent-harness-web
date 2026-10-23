// A fake Godot in step mode for the engine-godot driver tests: it speaks the controller's
// protocol (gd/play.gd) - reads the --harness=<config> argument, answers each stdin command
// with one "HARNESS_STEP {...}" line - and plays a tiny top-down game: the player moves 2 units
// a frame with Left/Right/Up/Down (or the move_* actions), takes three coins (pickup events),
// and wins on the last one. Frames are PNG files in the config's out folder when asked.
// FAKE_GODOT_CRASH_AT=<frame> makes it exit 1 there; FAKE_GODOT_FREEZE_AT=<frame> freezes the
// player from that frame on while the game still runs (a softlock: no input changes anything).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const cfgArg = args.find((a) => a.startsWith('--harness='));
const cfg = cfgArg ? JSON.parse(fs.readFileSync(cfgArg.slice(10), 'utf8')) : { mode: 'step', out: '' };
const crashAt = Number(process.env.FAKE_GODOT_CRASH_AT) || 0;
const freezeAt = Number(process.env.FAKE_GODOT_FREEZE_AT) || 0;

const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const o = Buffer.alloc(12 + d.length); o.writeUInt32BE(d.length, 0); o.write(t, 4, 'latin1'); d.copy(o, 8); o.writeUInt32BE(crc(o.subarray(4, 8 + d.length)), 8 + d.length); return o; };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const game = { player: [10, 10], score: 0, won: false };
const coins = [[70, 10], [70, 70], [10, 70]];
let frame = 0;
let inputs = [];
const held = new Set();
const events = [];
const DIR = { Left: [-1, 0], Right: [1, 0], Up: [0, -1], Down: [0, 1], A: [-1, 0], D: [1, 0], W: [0, -1], S: [0, 1], move_left: [-1, 0], move_right: [1, 0], move_up: [0, -1], move_down: [0, 1] };

function tick() {
  frame++;
  if (crashAt && frame >= crashAt) { process.stderr.write('ERROR: fake crash in _physics_process\n   at: res://scripts/main.gd:12\n'); process.exit(1); }
  for (const e of inputs.filter((x) => x.f <= frame)) { const k = e.action ?? e.key; if (e.down === false) held.delete(k); else held.add(k); }
  inputs = inputs.filter((x) => x.f > frame);
  let dx = 0, dy = 0;
  for (const k of held) if (DIR[k]) { dx += DIR[k][0]; dy += DIR[k][1]; }
  if (!game.won && !(freezeAt && frame >= freezeAt)) {
    const nx = Math.max(0, Math.min(100, game.player[0] + Math.sign(dx) * 2));
    const ny = Math.max(0, Math.min(100, game.player[1] + Math.sign(dy) * 2));
    game.player = [nx, ny];
  }
  for (let i = coins.length - 1; i >= 0; i--) {
    if (Math.hypot(coins[i][0] - game.player[0], coins[i][1] - game.player[1]) < 6) {
      coins.splice(i, 1);
      game.score++;
      events.push({ t: frame / 60, type: 'pickup', detail: `coin ${game.score} of 3` });
      if (!coins.length) { game.won = true; events.push({ t: frame / 60, type: 'win', detail: 'every coin' }); }
    }
  }
}

function capture() {
  if (!cfg.out || cfg.capture === false) return '';
  fs.mkdirSync(cfg.out, { recursive: true });
  const file = path.join(cfg.out, `frame_${String(frame).padStart(5, '0')}.png`).split(path.sep).join('/');
  const [px, py] = game.player;
  fs.writeFileSync(file, png(100, 60, (x, y) => (Math.abs(x - px) < 4 && Math.abs(y * 1.6 - py) < 6 ? [240, 200, 40] : [20 + x, 40, 80 + y])));
  return file;
}

const state = () => ({ frame, scene: 'res://scenes/main.tscn', game: { ...game, coinsLeft: coins.length, targets: coins.map((c) => [...c]) } });
const say = (file) => process.stdout.write(`HARNESS_STEP ${JSON.stringify({ ok: true, step: 0, frame, file, state: state(), events, metrics: { fps: 60, frames: frame, memoryMb: 12 } })}\n`);

process.stdout.write('Godot Engine v4.7.2.stable.fake\n');
tick();
say(capture());
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const cmd = JSON.parse(line);
    if (cmd.cmd === 'quit') process.exit(0);
    if (cmd.cmd === 'state') { say(''); continue; }
    inputs.push(...(cmd.inputs ?? []).map((e) => ({ ...e, f: frame + e.f })));
    cfg.capture = cmd.capture !== false;
    for (let n = 0; n < Math.max(1, cmd.frames ?? 1); n++) tick();
    say(capture());
  }
});
process.stdin.on('end', () => process.exit(0));
