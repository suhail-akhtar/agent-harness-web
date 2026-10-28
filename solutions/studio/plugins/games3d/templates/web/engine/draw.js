// 2D drawing helpers and juice: text with a shadow, a title card, a HUD line, screen shake,
// particle bursts, floating score text, a parallax background and tile strips.

export function text(ctx, s, x, y, { size = 16, color = '#f4f1e8', align = 'left', shadow = '#00000099', weight = 700, font = 'system-ui, sans-serif' } = {}) {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (shadow) { ctx.fillStyle = shadow; ctx.fillText(s, x + Math.max(1, size / 12), y + Math.max(1, size / 12)); }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

/** A centred card over the game: the first line big, the rest smaller. */
export function card(ctx, game, lines) {
  const W = game.width, H = game.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0d14cc';
  ctx.fillRect(0, 0, W, H);
  const list = lines.filter(Boolean);
  list.forEach((l, i) => text(ctx, l, W / 2, H / 2 - (list.length - 1) * 14 + i * 28 + (i ? 6 : 0), { size: i ? 15 : 30, align: 'center', color: i ? '#cfd6e6' : '#ffe27a' }));
  ctx.restore();
}

export class Shake {
  constructor() { this.t = 0; this.power = 0; }
  kick(power = 4, t = 0.25) { this.power = Math.max(this.power, power); this.t = Math.max(this.t, t); }
  update(dt) { this.t = Math.max(0, this.t - dt); if (!this.t) this.power = 0; }
  offset(random) { if (!this.t) return [0, 0]; const p = this.power * (this.t / 0.25); return [(random() - 0.5) * 2 * p, (random() - 0.5) * 2 * p]; }
}

export class Particles {
  constructor(random) { this.list = []; this.random = random; }
  burst(x, y, { n = 10, color = '#ffe27a', speed = 90, life = 0.5, size = 3, gravity = 200 } = {}) {
    for (let i = 0; i < n; i++) {
      const a = this.random() * Math.PI * 2, v = speed * (0.4 + this.random() * 0.8);
      this.list.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life, max: life, color, size, gravity });
    }
    if (this.list.length > 400) this.list.splice(0, this.list.length - 400);
  }
  float(x, y, label, color = '#ffe27a') { this.list.push({ x, y, vx: 0, vy: -30, life: 0.8, max: 0.8, color, label, gravity: 0 }); }
  update(dt) {
    for (const p of this.list) { p.life -= dt; p.vy += p.gravity * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    this.list = this.list.filter((p) => p.life > 0);
  }
  draw(ctx) {
    for (const p of this.list) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      if (p.label) text(ctx, p.label, p.x, p.y, { size: 12, align: 'center', color: p.color });
      else { ctx.fillStyle = p.color; ctx.fillRect(Math.round(p.x - p.size / 2), Math.round(p.y - p.size / 2), p.size, p.size); }
    }
    ctx.globalAlpha = 1;
  }
}

/** Draws parallax layers (loadParallax) for a camera x; each layer tiles horizontally. */
export function drawParallax(ctx, layers, camX, W, H, time = 0) {
  if (!layers?.length) return false;
  for (const l of layers) {
    const s = H / l.image.height;
    const w = l.image.width * s;
    let x = -(((camX * l.factor + time * (l.drift ?? 0)) % w) + w) % w;
    for (; x < W; x += w) ctx.drawImage(l.image, Math.floor(x), 0, Math.ceil(w) + 1, H);
  }
  return true;
}

/** Draws tile `index` of a horizontal strip (a level's tiles.png) at (x, y), size px on screen. */
export function drawTile(ctx, strip, index, x, y, size) {
  if (!strip?.image || index < 0) return false;
  const t = strip.size ?? strip.image.height;
  ctx.drawImage(strip.image, index * t, 0, t, t, Math.floor(x), Math.floor(y), size, size);
  return true;
}

/** A HUD line at the top left. */
export function hud(ctx, parts, x = 10, y = 16) {
  text(ctx, parts.filter(Boolean).join('   '), x, y, { size: 14 });
}
