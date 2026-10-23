// Sprites from a spec: { kind, seed, size, anims, colors, palette, outline, dither, view }.
// The template (kinds.mjs) gives parts and animations; this renders each frame at the size
// asked, outlines it, and maps it onto a palette when one is named.

import { paletteOf, quantize } from '../raster/palette.mjs';
import { template } from './kinds.mjs';
import { materials, renderParts, scaleParts, scaleTransforms } from './parts.mjs';

/**
 * Renders a sprite: { frames: { anim: [Image] }, size, info, fps }. size is the square frame
 * side in pixels (default: what the kind was designed for, 32 or 16); anims picks animations
 * (default: all the kind has).
 */
export function renderSprite(spec = {}) {
  const kind = spec.kind ?? 'character';
  const seed = spec.seed ?? 0;
  const t = template(kind, seed, spec);
  const size = Math.max(8, Math.min(256, Math.round(spec.size ?? t.size)));
  const k = size / t.size;
  const mats = materials({ ...t.colors, ...(spec.colors ?? {}) });
  const parts = scaleParts(t.parts, k);
  const wanted = spec.anims ? [].concat(spec.anims).map(String) : Object.keys(t.anims);
  const missing = wanted.filter((a) => !t.anims[a]);
  if (missing.length) throw new Error(`${kind} has no ${missing.join(', ')} animation: it has ${Object.keys(t.anims).join(', ')}`);
  const pal = paletteOf(spec.palette);
  const frames = {};
  for (const a of wanted) {
    frames[a] = t.anims[a].map((tr, i) => {
      const extra = scaleParts(t.frameParts?.[a]?.[i % (t.frameParts[a].length || 1)] ?? [], k);
      const { image } = renderParts([...parts, ...extra], mats, {
        width: size, height: size, transforms: scaleTransforms(tr, k), outline: spec.outline ?? 'auto', dither: spec.dither === true,
        ...(a === 'hurt' && i === 0 ? { tint: '#ffffff', tintAmount: 0.55 } : {}),
      });
      return pal ? quantize(image, pal) : image;
    });
  }
  return { frames, size, kind, seed, info: t.info ?? {}, fps: spec.fps ?? (kind === 'coin' || kind === 'gem' ? 10 : 8) };
}
