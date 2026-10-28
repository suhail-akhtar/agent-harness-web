// Input mapping: keys (KeyboardEvent.code) -> named actions; game logic reads actions only.
//
//   const input = new InputMap({ left: ['ArrowLeft', 'KeyA'], jump: ['Space'] }, config.controls);
//   input.held('left'); input.pressed('jump'); input.released('jump'); input.axis('left', 'right');
//   input.mouse  { x, y, down, dx, dy }   (canvas pixels; dx/dy: movement this step, for mouse look)
//
// game.json "controls" replaces an action's keys ({"jump": ["Space", "KeyZ"]}). pressed() and
// released() hold for one fixed step (the Game calls beginStep/endStep around each update), so a
// tap between two steps is never lost. botKeys() is what window.__game.inputs offers the bots.

export const DEFAULT_CONTROLS = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  jump: ['Space'], action: ['KeyX', 'KeyJ'], start: ['Enter', 'NumpadEnter'], pause: ['KeyP', 'Escape'], restart: ['KeyR'],
};

// Actions a bot need not press (menus, pause): window.__game.inputs leaves them out except start.
const NOT_FOR_BOTS = new Set(['pause', 'restart', 'undo', 'look', 'turnLeft', 'turnRight']);

export class InputMap {
  constructor(defaults = DEFAULT_CONTROLS, overrides = {}, target = typeof window !== 'undefined' ? window : null) {
    this.map = {};
    for (const [a, keys] of Object.entries({ ...defaults, ...(overrides ?? {}) })) this.map[a] = (Array.isArray(keys) ? keys : [keys]).map(String);
    this.down = new Set();
    this.justDown = new Set();
    this.justUp = new Set();
    this.stepDown = new Set();
    this.stepUp = new Set();
    this.mouse = { x: 0, y: 0, down: false, dx: 0, dy: 0, clicked: false };
    this.acc = { dx: 0, dy: 0, clicked: false };
    this.botOrder = null;
    if (!target) return;
    const known = () => new Set(Object.values(this.map).flat());
    target.addEventListener('keydown', (e) => {
      if (!known().has(e.code)) return;
      e.preventDefault();
      if (!this.down.has(e.code)) this.justDown.add(e.code);
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => {
      if (!this.down.has(e.code)) return;
      this.down.delete(e.code);
      this.justUp.add(e.code);
    });
    target.addEventListener('blur', () => { for (const k of this.down) this.justUp.add(k); this.down.clear(); });
    target.addEventListener('mousemove', (e) => {
      this.mouse.x = e.offsetX ?? e.clientX;
      this.mouse.y = e.offsetY ?? e.clientY;
      this.acc.dx += e.movementX ?? 0;
      this.acc.dy += e.movementY ?? 0;
    });
    target.addEventListener('mousedown', () => { this.mouse.down = true; this.acc.clicked = true; });
    target.addEventListener('mouseup', () => { this.mouse.down = false; });
  }

  /** Called by the Game before each fixed step: this step's presses are the ones since the last. */
  beginStep() {
    this.stepDown = this.justDown; this.justDown = new Set();
    this.stepUp = this.justUp; this.justUp = new Set();
    this.mouse.dx = this.acc.dx; this.mouse.dy = this.acc.dy; this.mouse.clicked = this.acc.clicked;
    this.acc = { dx: 0, dy: 0, clicked: false };
  }

  endStep() {}

  keys(action) { return this.map[action] ?? []; }
  held(action) { return this.keys(action).some((k) => this.down.has(k)); }
  pressed(action) { return this.keys(action).some((k) => this.stepDown.has(k)); }
  released(action) { return this.keys(action).some((k) => this.stepUp.has(k)) && !this.held(action); }
  /** -1, 0 or 1 from two actions. */
  axis(neg, pos) { return (this.held(pos) ? 1 : 0) - (this.held(neg) ? 1 : 0); }

  /** The keys a bot should try: the first key of each gameplay action, then Enter. */
  botKeys(order) {
    const actions = order ?? this.botOrder ?? Object.keys(this.map);
    const out = [];
    for (const a of actions) if (!NOT_FOR_BOTS.has(a) && a !== 'start' && this.map[a]?.[0]) out.push(this.map[a][0]);
    if (this.map.start?.[0]) out.push(this.map.start[0]);
    return [...new Set(out)];
  }

  /** Named actions -> their first key (window.__game.controls, for {action: 'jump'} inputs). */
  controls() { return Object.fromEntries(Object.entries(this.map).map(([a, k]) => [a, k[0]])); }

  /** "Arrows/WASD move, Space jumps..." from the map, for the title screen. */
  describe(names = {}) {
    const pretty = (k) => k.replace(/^Key/, '').replace(/^Arrow/, '').replace(/^Digit/, '');
    return Object.entries(names).filter(([a]) => this.map[a]?.length).map(([a, what]) => `${this.map[a].slice(0, 2).map(pretty).join('/')} ${what}`).join(' - ');
  }
}
