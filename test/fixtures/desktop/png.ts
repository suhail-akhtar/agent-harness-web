// A screenshot is not blank: the e2e windows are never shown (HARNESS_DESKTOP_TEST), so every
// screenshot is checked to have real content (pixel variance), not a hidden window's empty frame.
// A small PNG reader for what Chromium writes (8-bit RGB or RGBA, not interlaced).
import zlib from 'node:zlib';

export interface PngStats { width: number; height: number; stddev: number; colours: number }

export function pngStats(buf: Buffer): PngStats {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8; let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const kind = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]!; type = data[9]!; interlace = data[12]!; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const bpp = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0; const b = prev ? prev[x]! : 0; const c = prev && x >= bpp ? prev[x - bpp]! : 0;
      let v = src[x]!;
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[x] = v & 255;
    }
  }
  // Luminance spread, sampled, and how many distinct colours (coarsely).
  let n = 0; let sum = 0; let sq = 0;
  const colours = new Set<number>();
  const step = Math.max(1, Math.floor((width * height) / 40_000));
  for (let i = 0; i < width * height; i += step) {
    const p = i * bpp; const l = 0.2126 * out[p]! + 0.7152 * out[p + 1]! + 0.0722 * out[p + 2]!;
    n++; sum += l; sq += l * l;
    colours.add(((out[p]! >> 4) << 8) | ((out[p + 1]! >> 4) << 4) | (out[p + 2]! >> 4));
  }
  const mean = sum / n;
  return { width, height, stddev: Math.sqrt(Math.max(0, sq / n - mean * mean)), colours: colours.size };
}

interface ElectronAppLike { evaluate<R, A>(fn: (electron: { BrowserWindow: { getAllWindows(): Array<{ webContents: { capturePage(rect?: unknown, opts?: unknown): Promise<{ toPNG(): Buffer }> } }> } }, arg: A) => R | Promise<R>, arg: A): Promise<R> }
interface LocatorLike { scrollIntoViewIfNeeded(): Promise<void>; boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }

/**
 * A screenshot of the app's window (or of one element in it) taken by Electron itself, which works
 * for a window that is never shown (capturePage with stayHidden: the page renders for the capture).
 * A CDP screenshot of a hidden window can wait for a frame that never comes.
 */
export async function capture(app: ElectronAppLike, el?: LocatorLike): Promise<Buffer> {
  let rect: { x: number; y: number; width: number; height: number } | null = null;
  if (el) {
    await el.scrollIntoViewIfNeeded();
    const b = await el.boundingBox();
    if (b) rect = { x: Math.max(0, Math.floor(b.x)), y: Math.max(0, Math.floor(b.y)), width: Math.max(1, Math.ceil(b.width)), height: Math.max(1, Math.ceil(b.height)) };
  }
  const b64 = await app.evaluate(async ({ BrowserWindow }, r) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    const img = await w.webContents.capturePage(r ?? undefined, { stayHidden: true, stayAwake: true });
    return img.toPNG().toString('base64');
  }, rect);
  return Buffer.from(b64, 'base64');
}

/** Throws when a screenshot is blank (one flat colour): a hidden window that did not paint. */
export function assertNotBlank(buf: Buffer, what: string): PngStats {
  const s = pngStats(buf);
  if (s.width < 8 || s.height < 8 || s.colours < 3 || s.stddev < 1) throw new Error(`${what}: the screenshot is blank (${s.width}x${s.height}, ${s.colours} colours, spread ${s.stddev.toFixed(2)})`);
  return s;
}
