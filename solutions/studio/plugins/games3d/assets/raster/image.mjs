// RGBA images in plain JS: drawing (shapes, lines, polygons, gradients), compositing,
// scaling, blur, outlines, colour keys and normal maps. Coordinates are pixels; shapes are
// sampled at pixel centres, so a shape drawn at whole numbers gives crisp pixel art, and
// `aa: true` gives smooth edges (4x4 supersampling) for painted art.

import { mix, parseColor } from './color.mjs';

/** The 4x4 Bayer matrix as thresholds in [0, 1): ordered dithering. */
export const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
export const bayer = (x, y) => BAYER4[(y & 3) * 4 + (x & 3)];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A gradient's colour at t from stops [[t, colour], ...] (sorted). */
export function gradientAt(stops, t) {
  const s = stops.map(([p, c]) => [p, parseColor(c)]);
  if (t <= s[0][0]) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) return mix(s[i - 1][1], s[i][1], (t - s[i - 1][0]) / ((s[i][0] - s[i - 1][0]) || 1));
  }
  return s[s.length - 1][1];
}

export class Image {
  constructor(width, height, fill) {
    if (!(width > 0 && height > 0) || width > 16384 || height > 16384) throw new Error(`bad image size ${width}x${height}`);
    this.width = width | 0;
    this.height = height | 0;
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
    if (fill) this.fill(fill);
  }

  static from(width, height, data) {
    const img = new Image(width, height);
    img.data.set(data);
    return img;
  }

  clone() { return Image.from(this.width, this.height, this.data); }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }

  get(x, y) {
    x |= 0; y |= 0;
    if (!this.inside(x, y)) return [0, 0, 0, 0];
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x, y) { return this.inside(x | 0, y | 0) ? this.data[((y | 0) * this.width + (x | 0)) * 4 + 3] : 0; }

  /** Replaces a pixel. */
  set(x, y, c) {
    x |= 0; y |= 0;
    if (!this.inside(x, y)) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3] ?? 255;
  }

  /** Paints a colour over a pixel (source over), with a coverage in [0, 1]. */
  blend(x, y, c, coverage = 1) {
    x |= 0; y |= 0;
    if (!this.inside(x, y)) return;
    const sa = ((c[3] ?? 255) / 255) * coverage;
    if (sa <= 0) return;
    const i = (y * this.width + x) * 4;
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) this.data[i + k] = (c[k] * sa + this.data[i + k] * da * (1 - sa)) / (oa || 1);
    this.data[i + 3] = oa * 255;
  }

  fill(c) {
    const col = parseColor(c);
    for (let i = 0; i < this.data.length; i += 4) { this.data[i] = col[0]; this.data[i + 1] = col[1]; this.data[i + 2] = col[2]; this.data[i + 3] = col[3]; }
    return this;
  }

  /** Calls fn(x, y) -> colour|null for every pixel (null leaves it). */
  paint(fn, { blend = true, x0 = 0, y0 = 0, x1 = this.width, y1 = this.height } = {}) {
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, x0 | 0); x < Math.min(this.width, Math.ceil(x1)); x++) {
        const c = fn(x, y);
        if (c) blend ? this.blend(x, y, c) : this.set(x, y, c);
      }
    }
    return this;
  }

  rect(x, y, w, h, c, { fill = true, blend = true } = {}) {
    const col = parseColor(c);
    const put = (px, py) => (blend ? this.blend(px, py, col) : this.set(px, py, col));
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) if (fill || py === y0 || py === y1 - 1 || px === x0 || px === x1 - 1) put(px, py);
    }
    return this;
  }

  /** A line: 1 px with Bresenham, thicker as a row of discs. */
  line(x0, y0, x1, y1, c, width = 1) {
    const col = parseColor(c);
    if (width <= 1) {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let n = 0; n < 100000; n++) {
        this.blend(x0, y0, col);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      return this;
    }
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(len * 2));
    const r = width / 2;
    const seen = new Set();
    for (let s = 0; s <= steps; s++) {
      const cx = x0 + ((x1 - x0) * s) / steps, cy = y0 + ((y1 - y0) * s) / steps;
      for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) {
        for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
          const k = py * 65536 + px;
          if (seen.has(k)) continue;
          if ((px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 <= r * r) { seen.add(k); this.blend(px, py, col); }
        }
      }
    }
    return this;
  }

  /** A filled (or 1 px ring) ellipse; aa gives smooth edges. */
  ellipse(cx, cy, rx, ry, c, { fill = true, aa = false } = {}) {
    const col = parseColor(c);
    const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const x0 = Math.floor(cx - rx - 1), x1 = Math.ceil(cx + rx + 1), y0 = Math.floor(cy - ry - 1), y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (aa) { const cov = coverage(inside, x, y); if (cov) this.blend(x, y, col, cov); continue; }
        const inn = inside(x + 0.5, y + 0.5);
        if (!inn) continue;
        if (fill) { this.blend(x, y, col); continue; }
        if (!inside(x + 1.5, y + 0.5) || !inside(x - 0.5, y + 0.5) || !inside(x + 0.5, y + 1.5) || !inside(x + 0.5, y - 0.5)) this.blend(x, y, col);
      }
    }
    return this;
  }

  circle(cx, cy, r, c, o) { return this.ellipse(cx, cy, r, r, c, o); }

  /** A filled polygon [[x, y], ...] (even-odd rule). */
  polygon(points, c, { aa = false } = {}) {
    const col = parseColor(c);
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
    const inside = (x, y) => pointInPolygon(points, x, y);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (aa) { const cov = coverage(inside, x, y); if (cov) this.blend(x, y, col, cov); } else if (inside(x + 0.5, y + 0.5)) this.blend(x, y, col);
      }
    }
    return this;
  }

  /**
   * A linear gradient over a rectangle from (x0,y0) to (x1,y1). steps > 1 bands it into that
   * many colours with ordered dithering between bands (the pixel-art sky).
   */
  linearGradient(x0, y0, x1, y1, stops, { rect = [0, 0, this.width, this.height], steps = 0 } = {}) {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    return this.paint((x, y) => {
      let t = clamp(((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / len2, 0, 1);
      if (steps > 1) t = Math.min(steps - 1, Math.floor(t * (steps - 1) + bayer(x, y))) / (steps - 1);
      return gradientAt(stops, t);
    }, { x0: rect[0], y0: rect[1], x1: rect[0] + rect[2], y1: rect[1] + rect[3] });
  }

  radialGradient(cx, cy, r, stops, { steps = 0 } = {}) {
    return this.paint((x, y) => {
      let t = clamp(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r, 0, 1);
      if (steps > 1) t = Math.min(steps - 1, Math.floor(t * (steps - 1) + bayer(x, y))) / (steps - 1);
      return gradientAt(stops, t);
    }, { x0: cx - r, y0: cy - r, x1: cx + r + 1, y1: cy + r + 1 });
  }

  /** Draws another image onto this one. mode: normal | multiply | add | replace. */
  draw(src, dx, dy, { opacity = 1, mode = 'normal', sx = 0, sy = 0, sw = src.width, sh = src.height } = {}) {
    dx = Math.round(dx); dy = Math.round(dy);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const tx = dx + x, ty = dy + y;
        if (!this.inside(tx, ty)) continue;
        const c = src.get(sx + x, sy + y);
        if (mode === 'replace') { this.set(tx, ty, c); continue; }
        if (!c[3]) continue;
        if (mode === 'multiply' || mode === 'add') {
          const d = this.get(tx, ty);
          const m = mode === 'multiply' ? d.map((v, k) => (k < 3 ? (v * c[k]) / 255 : v)) : d.map((v, k) => (k < 3 ? Math.min(255, v + c[k]) : v));
          this.blend(tx, ty, [m[0], m[1], m[2], c[3]], opacity);
        } else this.blend(tx, ty, c, opacity);
      }
    }
    return this;
  }

  crop(x, y, w, h) {
    const out = new Image(w, h);
    out.draw(this, -x, -y, { mode: 'replace' });
    return out;
  }

  /** Resized: nearest keeps pixel art crisp; bilinear (premultiplied) for painted art and textures. */
  scale(w, h, method = 'nearest') {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const out = new Image(w, h);
    const sx = this.width / w, sy = this.height / h;
    if (method === 'nearest') {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(x, y, this.get(Math.floor((x + 0.5) * sx), Math.floor((y + 0.5) * sy)));
      return out;
    }
    // Shrinking by more than 2x: box-average first so bilinear does not alias.
    if (sx >= 2 || sy >= 2) return this.boxShrink(Math.max(1, Math.floor(sx)), Math.max(1, Math.floor(sy))).scale(w, h, 'bilinear');
    const d = this.data, W = this.width, H = this.height;
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) * sy - 0.5, 0, H - 1), y0 = Math.floor(fy), y1 = Math.min(H - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = clamp((x + 0.5) * sx - 0.5, 0, W - 1), x0 = Math.floor(fx), x1 = Math.min(W - 1, x0 + 1), tx = fx - x0;
        const acc = [0, 0, 0, 0];
        for (const [px, py, wgt] of [[x0, y0, (1 - tx) * (1 - ty)], [x1, y0, tx * (1 - ty)], [x0, y1, (1 - tx) * ty], [x1, y1, tx * ty]]) {
          const i = (py * W + px) * 4, a = d[i + 3] / 255;
          acc[0] += d[i] * a * wgt; acc[1] += d[i + 1] * a * wgt; acc[2] += d[i + 2] * a * wgt; acc[3] += a * wgt;
        }
        out.set(x, y, acc[3] > 0 ? [acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3], acc[3] * 255] : [0, 0, 0, 0]);
      }
    }
    return out;
  }

  /** Averages fx x fy blocks (premultiplied): a clean downscale by whole factors. */
  boxShrink(fx, fy = fx) {
    const w = Math.max(1, Math.floor(this.width / fx)), h = Math.max(1, Math.floor(this.height / fy));
    const out = new Image(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) {
          const c = this.get(x * fx + i, y * fy + j), al = c[3] / 255;
          r += c[0] * al; g += c[1] * al; b += c[2] * al; a += al;
        }
        out.set(x, y, a ? [r / a, g / a, b / a, (a / (fx * fy)) * 255] : [0, 0, 0, 0]);
      }
    }
    return out;
  }

  flipX() { const o = new Image(this.width, this.height); for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) o.set(this.width - 1 - x, y, this.get(x, y)); return o; }
  flipY() { const o = new Image(this.width, this.height); for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) o.set(x, this.height - 1 - y, this.get(x, y)); return o; }
  /** Rotated 90 degrees clockwise. */
  rotate90() { const o = new Image(this.height, this.width); for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) o.set(this.height - 1 - y, x, this.get(x, y)); return o; }

  /**
   * A 1 px outline around the opaque pixels, on the transparent pixels next to them (4
   * neighbours, or 8 with corners). colour 'auto' takes a darkened version of the pixel it borders.
   */
  outline(c = [20, 12, 28, 255], { corners = false, threshold = 128, darkenBy } = {}) {
    const out = this.clone();
    const col = c === 'auto' ? null : parseColor(c);
    const n4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const n8 = [...n4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.alpha(x, y) >= threshold) continue;
        const hit = (corners ? n8 : n4).find(([dx, dy]) => this.alpha(x + dx, y + dy) >= threshold);
        if (!hit) continue;
        if (col) out.set(x, y, col);
        else { const nb = this.get(x + hit[0], y + hit[1]); out.set(x, y, [nb[0] * (darkenBy ?? 0.35), nb[1] * (darkenBy ?? 0.3), nb[2] * (darkenBy ?? 0.4) + 10, 255]); }
      }
    }
    return out;
  }

  /** A gaussian-like blur (three box passes, premultiplied alpha); wrap for tileable textures. */
  blur(radius, { wrap = false } = {}) {
    const r = Math.max(0, Math.round(radius));
    if (!r) return this.clone();
    const W = this.width, H = this.height;
    const ch = [0, 1, 2, 3].map(() => new Float32Array(W * H));
    for (let i = 0; i < W * H; i++) {
      const a = this.data[i * 4 + 3] / 255;
      ch[0][i] = this.data[i * 4] * a; ch[1][i] = this.data[i * 4 + 1] * a; ch[2][i] = this.data[i * 4 + 2] * a; ch[3][i] = a;
    }
    const pass = (src, horizontal) => {
      const dst = new Float32Array(W * H);
      const n = horizontal ? W : H, lines = horizontal ? H : W;
      for (let l = 0; l < lines; l++) {
        const at = (k) => {
          if (wrap) k = ((k % n) + n) % n; else k = clamp(k, 0, n - 1);
          return src[horizontal ? l * W + k : k * W + l];
        };
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += at(k);
        for (let k = 0; k < n; k++) {
          dst[horizontal ? l * W + k : k * W + l] = sum / (2 * r + 1);
          sum += at(k + r + 1) - at(k - r);
        }
      }
      return dst;
    };
    for (let c = 0; c < 4; c++) for (let p = 0; p < 3; p++) ch[c] = pass(pass(ch[c], true), false);
    const out = new Image(W, H);
    for (let i = 0; i < W * H; i++) {
      const a = ch[3][i];
      out.data[i * 4] = a ? ch[0][i] / a : 0; out.data[i * 4 + 1] = a ? ch[1][i] / a : 0; out.data[i * 4 + 2] = a ? ch[2][i] / a : 0; out.data[i * 4 + 3] = a * 255;
    }
    return out;
  }

  /** The bounds of the pixels with alpha, or null when it is empty. */
  bounds(threshold = 1) {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
      if (this.alpha(x, y) >= threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** The distinct opaque colours (alpha above the threshold). */
  colors(threshold = 128) {
    const set = new Set();
    for (let i = 0; i < this.data.length; i += 4) if (this.data[i + 3] >= threshold) set.add((this.data[i] << 16) | (this.data[i + 1] << 8) | this.data[i + 2]);
    return set;
  }

  /**
   * Makes a background colour transparent: pixels within `tolerance` (0-255 per channel,
   * as a distance) of `key`; with flood, only those connected to the border (so the same
   * colour inside the subject stays). feather softens the edge.
   */
  colorKey(key, { tolerance = 40, flood = true, feather = 0 } = {}) {
    const k = parseColor(key);
    const out = this.clone();
    const W = this.width, H = this.height;
    const dist = (x, y) => { const c = this.get(x, y); return Math.hypot(c[0] - k[0], c[1] - k[1], c[2] - k[2]); };
    const clear = new Uint8Array(W * H);
    if (flood) {
      const stack = [];
      for (let x = 0; x < W; x++) stack.push([x, 0], [x, H - 1]);
      for (let y = 0; y < H; y++) stack.push([0, y], [W - 1, y]);
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= W || y >= H || clear[y * W + x] || dist(x, y) > tolerance) continue;
        clear[y * W + x] = 1;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
    } else for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dist(x, y) <= tolerance) clear[y * W + x] = 1;
    for (let i = 0; i < W * H; i++) if (clear[i]) out.data[i * 4 + 3] = 0;
    if (feather > 0) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (clear[i]) continue;
        const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => x + dx >= 0 && y + dy >= 0 && x + dx < W && y + dy < H && clear[(y + dy) * W + x + dx]);
        if (near) out.data[i * 4 + 3] = Math.min(out.data[i * 4 + 3], clamp((dist(x, y) - tolerance) / (feather * 40), 0.2, 1) * 255);
      }
    }
    return out;
  }

  /** The most common colour on the border: the background of a generated image. */
  borderColor() {
    const counts = new Map();
    const add = (x, y) => { const c = this.get(x, y); const key = ((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3); const e = counts.get(key) ?? { n: 0, c }; e.n++; counts.set(key, e); };
    for (let x = 0; x < this.width; x++) { add(x, 0); add(x, this.height - 1); }
    for (let y = 0; y < this.height; y++) { add(0, y); add(this.width - 1, y); }
    return [...counts.values()].sort((a, b) => b.n - a.n)[0].c;
  }

  /** Sets every opaque pixel's alpha to 0 or 255 (pixel art has no half-transparent edges). */
  hardAlpha(threshold = 128) {
    for (let i = 3; i < this.data.length; i += 4) this.data[i] = this.data[i] >= threshold ? 255 : 0;
    return this;
  }

  /** Luminance (or alpha) as heights in [0, 1]. */
  heights(channel = 'luma') {
    const h = new Float32Array(this.width * this.height);
    for (let i = 0; i < h.length; i++) {
      const d = this.data;
      h[i] = channel === 'alpha' ? d[i * 4 + 3] / 255 : (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
    }
    return h;
  }
}

/** Fraction of a pixel's 4x4 samples inside a shape. */
export function coverage(inside, x, y) {
  let n = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside(x + (i + 0.5) / 4, y + (j + 0.5) / 4)) n++;
  return n / 16;
}

export function pointInPolygon(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * A tangent-space normal map from heights in [0, 1] (Sobel). strength scales the slopes;
 * 'opengl' is +Y up (Blender, Godot, Unity), 'directx' flips green (Unreal). wrap: tileable.
 */
export function normalMap(heights, width, height, { strength = 2, convention = 'opengl', wrap = true } = {}) {
  const out = new Image(width, height);
  const at = (x, y) => {
    if (wrap) { x = ((x % width) + width) % width; y = ((y % height) + height) % height; } else { x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1); }
    return heights[y * width + x];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      if (convention === 'directx') ny = -ny;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      out.set(x, y, [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255]);
    }
  }
  return out;
}
