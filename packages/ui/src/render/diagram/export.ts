/**
 * Saving a diagram: the whole drawing (not just what is on screen) as a standalone SVG, with the
 * theme's colours written in (a file has no CSS variables to inherit) and the interface-only parts
 * (hit areas, collapse buttons, selection rings) left out; and as a PNG at twice the size.
 */

import { PAD } from './Drawing.tsx';
import type { Scene } from './layout.ts';

const VAR = /var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g;

/** Replaces var(--x, fallback) with the values `from` has now (several passes: values may use variables too). */
export function resolveVars(text: string, lookup: (name: string) => string): string {
  let out = text;
  for (let i = 0; i < 6 && out.includes('var(--'); i++) {
    out = out.replace(VAR, (_m, name: string, fallback?: string) => lookup(name).trim() || (fallback ?? '').trim() || 'currentColor');
  }
  return out;
}

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** The drawing as an SVG file: `svg` is the live element (its colours are read from the page). */
export function exportSvg(svg: SVGSVGElement, scene: Scene, title?: string): { text: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  for (const el of clone.querySelectorAll('.dg-hit, .dg-gbtn, .dg-card-sel, .dg-match')) el.remove();
  clone.querySelector('[data-camera]')?.removeAttribute('transform');
  const head = title ? 34 : 0;
  const b = scene.bounds;
  const width = Math.ceil(b.w + PAD * 2);
  const height = Math.ceil(b.h + PAD * 2 + head);
  clone.setAttribute('viewBox', `${b.x - PAD} ${b.y - PAD - head} ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.removeAttribute('style');
  clone.removeAttribute('data-lod');
  clone.setAttribute('class', 'hx-dg');
  const ns = 'http://www.w3.org/2000/svg';
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('x', String(b.x - PAD)); bg.setAttribute('y', String(b.y - PAD - head));
  bg.setAttribute('width', String(width)); bg.setAttribute('height', String(height));
  bg.setAttribute('fill', 'var(--dg-bg)');
  const camera = clone.querySelector('[data-camera]');
  camera?.parentNode?.insertBefore(bg, camera);
  if (title) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(b.x - PAD + 20)); t.setAttribute('y', String(b.y - PAD - head + 26));
    t.setAttribute('font-size', '15'); t.setAttribute('font-weight', '650'); t.setAttribute('fill', 'var(--dg-text)');
    t.textContent = title;
    camera?.parentNode?.insertBefore(t, camera);
  }
  const live = getComputedStyle(svg);
  const text = resolveVars(new XMLSerializer().serializeToString(clone), (name) => live.getPropertyValue(name));
  return { text: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${escapeXml(title ?? 'Diagram')} -->\n${text}`, width, height };
}

/** The SVG drawn into a PNG, `scale` times its size (capped so a huge diagram still fits a canvas). */
export async function svgToPng(svgText: string, width: number, height: number, scale = 2): Promise<Blob> {
  const k = Math.min(scale, 16_000 / Math.max(width, height));
  const img = new Image();
  img.decoding = 'async';
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('the drawing could not be turned into an image')); img.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * k));
    canvas.height = Math.max(1, Math.round(height * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas here');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the image could not be made'))), 'image/png'));
  } finally { URL.revokeObjectURL(url); }
}

/** Saves a blob through the browser's download (the desktop asks where). */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fileSlug = (s: string | undefined) => (s ?? 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'diagram';
