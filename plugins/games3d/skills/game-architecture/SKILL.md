---
name: game-architecture
description: Structure for a browser game that is fun, robust and testable - state machine, fixed-timestep loop, input map, seeded randomness, entities and collisions, HUD, restart - with a complete working template and its playtest.json. Use when designing or building any game (2D canvas or Three.js).
---
# Game architecture

## The non-negotiables
1. **State machine**: `title -> playing -> (paused) -> gameover -> title/playing`. Every state draws something and says what key to press.
2. **Fixed timestep** (60 updates/s) with an accumulator; render every animation frame. Game logic never depends on frame rate.
3. **Input map**: keys -> actions (`left`, `right`, `jump`, `fire`, `pause`); logic reads actions, not keys. Support arrows + WASD; Enter/Space to start; P/Escape to pause; R to restart.
4. **Seeded randomness**: `?seed=N` makes a run repeatable (tests and bug reports depend on it).
5. **Test hooks**: `window.__game` exposes `state`, `score`, `player`, entity counts, and `step(n)` to advance n fixed steps; `?autostart=1` skips the title.
6. **Feel**: immediate response to input, clear feedback (flash, shake, sound) on hits and points, difficulty that ramps, a restart in one key press.
7. **Assets are code or workspace files** - no network.

## Template (complete, runnable)
```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Dodge</title>
<style>html,body{margin:0;height:100%;background:#0e1117;display:grid;place-items:center;font-family:system-ui,sans-serif}canvas{max-width:100vw;max-height:100vh;image-rendering:pixelated}</style></head>
<body><canvas id="c" width="480" height="640"></canvas>
<script type="module">
const W = 480, H = 640, DT = 1 / 60;
const q = new URLSearchParams(location.search);
const ctx = document.getElementById('c').getContext('2d');

// Seeded RNG (mulberry32): same seed, same game.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Input: keys -> actions. Logic reads `held` and `pressed` (pressed = this step only).
const KEYS = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Enter: 'start', Space: 'start', KeyP: 'pause', Escape: 'pause', KeyR: 'restart' };
const held = new Set(), pressed = new Set();
addEventListener('keydown', (e) => { const a = KEYS[e.code]; if (!a) return; e.preventDefault(); if (!held.has(a)) pressed.add(a); held.add(a); });
addEventListener('keyup', (e) => { const a = KEYS[e.code]; if (a) held.delete(a); });

const g = { state: 'title', score: 0, best: 0, time: 0, player: null, rocks: [], rand: null, shake: 0 };
function reset() {
  g.rand = rng(Number(q.get('seed') ?? Date.now()));
  g.player = { x: W / 2, y: H - 60, w: 36, h: 18, speed: 300 };
  g.rocks = []; g.score = 0; g.time = 0; g.spawn = 0; g.shake = 0;
}
const overlap = (a, b) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

function update(dt) {
  if (pressed.has('restart')) { reset(); g.state = 'playing'; }
  switch (g.state) {
    case 'title': case 'gameover': if (pressed.has('start')) { reset(); g.state = 'playing'; } break;
    case 'paused': if (pressed.has('pause') || pressed.has('start')) g.state = 'playing'; break;
    case 'playing': {
      if (pressed.has('pause')) { g.state = 'paused'; break; }
      const p = g.player;
      const dir = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      p.x = Math.max(p.w / 2, Math.min(W - p.w / 2, p.x + dir * p.speed * dt));
      g.time += dt;
      g.score += dt * 10;
      g.spawn -= dt;
      const level = 1 + g.time / 20; // difficulty ramps
      if (g.spawn <= 0) { const s = 18 + g.rand() * 28; g.rocks.push({ x: s / 2 + g.rand() * (W - s), y: -s, w: s, h: s, vy: (120 + g.rand() * 120) * level }); g.spawn = 0.6 / level; }
      for (const r of g.rocks) r.y += r.vy * dt;
      g.rocks = g.rocks.filter((r) => r.y < H + 50);
      if (g.rocks.some((r) => overlap(p, r))) { g.state = 'gameover'; g.best = Math.max(g.best, Math.floor(g.score)); g.shake = 0.3; }
    }
  }
  g.shake = Math.max(0, g.shake - dt);
  pressed.clear();
}

function text(s, y, size = 28, colour = '#e6edf3') { ctx.fillStyle = colour; ctx.font = `600 ${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(s, W / 2, y); }
function draw() {
  ctx.save();
  if (g.shake) ctx.translate((Math.random() - 0.5) * 12 * g.shake / 0.3, 0);
  ctx.fillStyle = '#0e1117'; ctx.fillRect(0, 0, W, H);
  if (g.player) {
    ctx.fillStyle = '#58a6ff'; const p = g.player; ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h);
    ctx.fillStyle = '#f0883e'; for (const r of g.rocks) ctx.fillRect(r.x - r.w / 2, r.y - r.h / 2, r.w, r.h);
  }
  ctx.restore();
  text(`Score ${Math.floor(g.score)}   Best ${g.best}`, 32, 18, '#8b949e');
  if (g.state === 'title') { text('DODGE', H / 2 - 40, 56); text('Arrows or A/D to move', H / 2 + 10, 18, '#8b949e'); text('Press Enter to start', H / 2 + 50, 22); }
  if (g.state === 'paused') text('Paused - P to resume', H / 2, 26);
  if (g.state === 'gameover') { text('Game over', H / 2 - 20, 44, '#f85149'); text('Enter to play again', H / 2 + 30, 22); }
}

// Fixed-timestep loop.
let last = performance.now(), acc = 0;
function frame(now) {
  acc += Math.min(0.25, (now - last) / 1000); last = now;
  while (acc >= DT) { update(DT); acc -= DT; }
  draw();
  requestAnimationFrame(frame);
}
reset();
if (q.get('autostart') === '1') g.state = 'playing';
requestAnimationFrame(frame);

// Test hooks: state for playtest.json, and step(n) to advance deterministically.
window.__game = {
  get state() { return g.state; }, get score() { return Math.floor(g.score); }, get player() { return { ...g.player }; },
  get rocks() { return g.rocks.length; },
  step(n = 1) { for (let i = 0; i < n; i++) update(DT); draw(); return g.state; },
};
</script>
</body>
</html>
```

```json
{
  "page": "index.html",
  "viewport": { "width": 520, "height": 680 },
  "scenarios": [
    { "name": "opens on the title screen", "expect": [{ "eval": "window.__game.state", "op": "==", "value": "title" }] },
    { "name": "Enter starts the game", "query": "?seed=1", "steps": [{ "press": "Enter" }, { "wait": 200 }], "expect": [{ "eval": "window.__game.state", "op": "==", "value": "playing" }] },
    { "name": "left arrow moves the player left", "query": "?seed=1&autostart=1", "steps": [{ "press": "ArrowLeft", "hold": 400 }], "expect": [{ "eval": "window.__game.player.x", "op": "decreased" }] },
    { "name": "score rises while playing", "query": "?seed=1&autostart=1", "steps": [{ "wait": 1000 }], "expect": [{ "eval": "window.__game.score", "op": "increased" }] },
    { "name": "standing still eventually loses", "query": "?seed=3&autostart=1", "steps": [{ "eval": "window.__game.step(60 * 60)" }], "expect": [{ "eval": "window.__game.state", "op": "==", "value": "gameover" }] },
    { "name": "P pauses", "query": "?seed=1&autostart=1", "steps": [{ "press": "KeyP" }, { "wait": 100 }], "expect": [{ "eval": "window.__game.state", "op": "==", "value": "paused" }] }
  ]
}
```
(Playwright key names: `ArrowLeft`, `Enter`, `Space`, `KeyP`, `KeyA`...)

## Testing a game
- `playtest.json` covers: the start screen, starting, every control, scoring, losing (use `step(n)` to fast-forward), pause, restart. The `playtest` gate runs it; `web-console` checks the page opens clean.
- Then **play it** with the browser tool and look: `browser {query: "?seed=2&autostart=1", actions: [{"press":"ArrowRight","hold":800},{"screenshot":"mid-game"},{"eval":"window.__game.step(600)"},{"screenshot":"later"}]}`. Is it readable, does it feel responsive, is the difficulty right, is game over clear?

## Three.js games
Same structure; the renderer replaces `draw()`. Load threejs-essentials for the setup. Keep logic in plain objects (positions, velocities) and copy them to meshes in `draw()`, so `__game` reads logic state and `step(n)` works without rendering.
