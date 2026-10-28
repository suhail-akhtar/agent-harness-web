// A 5x7 bitmap font (ASCII 32-126) drawn into images, and exported as a font: a PNG atlas
// with a BMFont .fnt (Godot, Unity, Phaser and most engines read it) and a JSON table.

import { parseColor } from './color.mjs';
import { Image } from './image.mjs';

// Seven rows of five columns per glyph, '#' set.
const GLYPHS = {
  ' ': '..... ..... ..... ..... ..... ..... .....', '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..', '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '#': '.#.#. .#.#. ##### .#.#. ##### .#.#. .#.#.', '$': '..#.. .#### #.#.. .###. ..#.# ####. ..#..', '%': '##... ##..# ...#. ..#.. .#... #..## ...##',
  '&': '.##.. #..#. #.#.. .#... #.#.# #..#. .##.#', "'": '..#.. ..#.. ..... ..... ..... ..... .....', '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...', '*': '..... ..#.. #.#.# .###. #.#.# ..#.. .....', '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  ',': '..... ..... ..... ..... .##.. ..#.. .#...', '-': '..... ..... ..... ##### ..... ..... .....', '.': '..... ..... ..... ..... ..... .##.. .##..',
  '/': '..... ....# ...#. ..#.. .#... #.... .....', 0: '.###. #...# #..## #.#.# ##..# #...# .###.', 1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  2: '.###. #...# ....# ...#. ..#.. .#... #####', 3: '##### ...#. ..#.. ...#. ....# #...# .###.', 4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  5: '##### #.... ####. ....# ....# #...# .###.', 6: '..##. .#... #.... ####. #...# #...# .###.', 7: '##### ....# ...#. ..#.. .#... .#... .#...',
  8: '.###. #...# #...# .###. #...# #...# .###.', 9: '.###. #...# #...# .#### ....# ...#. .##..', ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  ';': '..... .##.. .##.. ..... .##.. ..#.. .#...', '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.', '=': '..... ..... ##### ..... ##### ..... .....',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...', '?': '.###. #...# ....# ...#. ..#.. ..... ..#..', '@': '.###. #...# ....# .##.# #.#.# #.#.# .###.',
  A: '.###. #...# #...# ##### #...# #...# #...#', B: '####. #...# #...# ####. #...# #...# ####.', C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '###.. #..#. #...# #...# #...# #..#. ###..', E: '##### #.... #.... ####. #.... #.... #####', F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .####', H: '#...# #...# #...# ##### #...# #...# #...#', I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..', K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#', L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#', N: '#...# #...# ##..# #.#.# #..## #...# #...#', O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....', Q: '.###. #...# #...# #...# #.#.# #..#. .##.#', R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.', T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..', U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..', W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.', X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..', Z: '##### ....# ...#. ..#.. .#... #.... #####', '[': '.###. .#... .#... .#... .#... .#... .###.',
  '\\': '..... #.... .#... ..#.. ...#. ....# .....', ']': '.###. ...#. ...#. ...#. ...#. ...#. .###.', '^': '..#.. .#.#. #...# ..... ..... ..... .....',
  _: '..... ..... ..... ..... ..... ..... #####', '`': '.#... ..#.. ..... ..... ..... ..... .....', a: '..... ..... .###. ....# .#### #...# .####',
  b: '#.... #.... #.##. ##..# #...# #...# ####.', c: '..... ..... .###. #.... #.... #...# .###.', d: '....# ....# .##.# #..## #...# #...# .####',
  e: '..... ..... .###. #...# ##### #.... .###.', f: '..##. .#..# .#... ###.. .#... .#... .#...', g: '..... .#### #...# #...# .#### ....# .###.',
  h: '#.... #.... #.##. ##..# #...# #...# #...#', i: '..#.. ..... .##.. ..#.. ..#.. ..#.. .###.', j: '...#. ..... ..##. ...#. ...#. #..#. .##..',
  k: '#.... #.... #..#. #.#.. ##... #.#.. #..#.', l: '.##.. ..#.. ..#.. ..#.. ..#.. ..#.. .###.', m: '..... ..... ##.#. #.#.# #.#.# #...# #...#',
  n: '..... ..... #.##. ##..# #...# #...# #...#', o: '..... ..... .###. #...# #...# #...# .###.', p: '..... ..... ####. #...# ####. #.... #....',
  q: '..... ..... .##.# #..## .#### ....# ....#', r: '..... ..... #.##. ##..# #.... #.... #....', s: '..... ..... .###. #.... .###. ....# ####.',
  t: '.#... .#... ###.. .#... .#... .#..# ..##.', u: '..... ..... #...# #...# #...# #..## .##.#', v: '..... ..... #...# #...# #...# .#.#. ..#..',
  w: '..... ..... #...# #...# #.#.# #.#.# .#.#.', x: '..... ..... #...# .#.#. ..#.. .#.#. #...#', y: '..... ..... #...# #...# .#### ....# .###.',
  z: '..... ..... ##### ...#. ..#.. .#... #####', '{': '...#. ..#.. ..#.. .#... ..#.. ..#.. ...#.', '|': '..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  '}': '.#... ..#.. ..#.. ...#. ..#.. ..#.. .#...', '~': '..... ..... .#... #.#.# ...#. ..... .....',
};

export const FONT_W = 5;
export const FONT_H = 7;

const rows = (ch) => (GLYPHS[ch] ?? GLYPHS['?']).split(' ');

/** The columns a glyph uses: [first, last] (a space is 3 wide). */
function span(ch) {
  if (ch === ' ') return [0, 2];
  let lo = 5, hi = -1;
  for (const r of rows(ch)) for (let x = 0; x < 5; x++) if (r[x] === '#') { lo = Math.min(lo, x); hi = Math.max(hi, x); }
  return hi < 0 ? [0, 2] : [lo, hi];
}

/** How far the pen moves for a character, in font pixels (mono: always 6). */
export const advance = (ch, mono = false) => (mono ? FONT_W + 1 : span(ch)[1] - span(ch)[0] + 2);

export function measureText(text, { scale = 1, mono = false } = {}) {
  const lines = String(text).split('\n');
  const w = Math.max(...lines.map((l) => [...l].reduce((s, ch) => s + advance(ch, mono), 0) - 1));
  return { width: Math.max(0, w) * scale, height: (lines.length * (FONT_H + 2) - 2) * scale };
}

/** Draws text with its top-left at (x, y). shadow and outline take a colour. */
export function drawText(img, text, x, y, color = '#ffffff', { scale = 1, mono = false, shadow, outline } = {}) {
  const col = parseColor(color);
  const put = (px, py, c) => img.rect(px, py, scale, scale, c);
  const pass = (ox, oy, c) => {
    let cy = y;
    for (const line of String(text).split('\n')) {
      let cx = x;
      for (const ch of line) {
        const [lo] = mono ? [0] : span(ch);
        rows(ch).forEach((r, ry) => { for (let rx = 0; rx < 5; rx++) if (r[rx] === '#') put(cx + (rx - lo) * scale + ox, cy + ry * scale + oy, c); });
        cx += advance(ch, mono) * scale;
      }
      cy += (FONT_H + 2) * scale;
    }
  };
  if (outline) { const o = parseColor(outline); for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) pass(dx * scale, dy * scale, o); }
  if (shadow) pass(scale, scale, parseColor(shadow));
  pass(0, 0, col);
  return img;
}

/**
 * The font as an atlas: 16 columns of cells, one glyph each (ASCII 32-126), a BMFont text
 * file and a JSON table of the same. Cells leave room for an outline when there is one.
 */
export function fontAtlas({ scale = 1, color = '#ffffff', outline, shadow, mono = false, face = 'Studio5x7', file = 'font.png' } = {}) {
  const chars = [];
  for (let c = 32; c <= 126; c++) chars.push(String.fromCharCode(c));
  const pad = outline || shadow ? 1 : 0;
  const cw = (FONT_W + 2 * pad + 1) * scale, chh = (FONT_H + 2 * pad + 1) * scale;
  const cols = 16, rowsN = Math.ceil(chars.length / cols);
  const img = new Image(cols * cw, rowsN * chh);
  const table = [];
  chars.forEach((ch, i) => {
    const cx = (i % cols) * cw, cy = Math.floor(i / cols) * chh;
    drawText(img, ch, cx + pad * scale, cy + pad * scale, color, { scale, mono, outline, shadow });
    const [lo, hi] = mono ? [0, FONT_W - 1] : span(ch);
    const w = ch === ' ' ? 0 : (hi - lo + 1 + 2 * pad) * scale;
    table.push({ id: ch.charCodeAt(0), char: ch, x: cx, y: cy, width: w, height: ch === ' ' ? 0 : (FONT_H + 2 * pad) * scale, xoffset: -pad * scale, yoffset: 0, xadvance: advance(ch, mono) * scale });
  });
  const lineHeight = (FONT_H + 2) * scale;
  const fnt = [
    `info face="${face}" size=${lineHeight} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=${pad},${pad},${pad},${pad} spacing=1,1`,
    `common lineHeight=${lineHeight} base=${FONT_H * scale} scaleW=${img.width} scaleH=${img.height} pages=1 packed=0`,
    `page id=0 file="${file}"`,
    `chars count=${table.length}`,
    ...table.map((t) => `char id=${t.id} x=${t.x} y=${t.y} width=${t.width} height=${t.height} xoffset=${t.xoffset} yoffset=${t.yoffset} xadvance=${t.xadvance} page=0 chnl=15`),
    '',
  ].join('\n');
  return { image: img, fnt, json: { face, file, lineHeight, base: FONT_H * scale, scale, chars: table } };
}
