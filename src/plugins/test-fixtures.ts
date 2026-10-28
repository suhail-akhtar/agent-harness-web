// Fixtures for tests, the harness's and plugins' (re-exported by @harness/plugin-sdk/testing): plugin folders by
// name, temporary folders removed when the test process ends, a scripted model provider, small PNG and GLB files.
import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import type { Block, Usage } from '../core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from '../providers/types.ts';
import { shippedPluginDir, shippedPluginDirs } from './shipped.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');

/**
 * A plugin's folder by name: this harness's own (plugins/<name>, solutions/<solution>/plugins/<name>), else
 * wherever the plugin is installed (@harness/plugins/<name>, as its code imports it).
 */
export function pluginDir(name: string): string {
  return shippedPluginDir(ROOT, name) ?? path.dirname(fileURLToPath(import.meta.resolve(`@harness/plugins/${name}/harness-plugin.json`)));
}

/** The folders of plugins shipped with this harness (the core's and every solution's): createHarness({ plugins: shippedPlugins() }). */
export const shippedPlugins = (): string[] => shippedPluginDirs(ROOT);

/** Every folder a test made, removed when the test process ends (thousands piled up to 13 GB before). */
const made: string[] = [];
process.once('exit', () => {
  for (const d of made) { try { rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* in use (Windows) or not ours to remove */ } }
});

export async function tempDir(prefix = 'hw-test-'): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

export type ScriptedStep = { text?: string; calls?: { name: string; input?: Record<string, unknown>; parseError?: string }[]; stop?: StopKind; usage?: Partial<Usage> };

/** A provider that replays scripted turns and records every request it receives. */
export class FakeProvider implements Provider {
  requests: ProviderRequest[] = [];
  snapshots: string[] = [];
  private steps: ScriptedStep[];
  private n = 0;
  constructor(steps: ScriptedStep[]) { this.steps = steps; }
  async send(req: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(req);
    this.snapshots.push(JSON.stringify(req.messages));
    const s = this.steps.shift() ?? { text: 'done' };
    const content: Block[] = [];
    if (s.text) content.push({ type: 'text', text: s.text });
    for (const c of s.calls ?? []) content.push({ type: 'tool_use', id: `call_${++this.n}`, name: c.name, input: c.input ?? {}, ...(c.parseError ? { parseError: c.parseError } : {}) });
    const usage: Usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0, ...s.usage };
    return {
      message: { role: 'assistant', content, raw: { provider: 'deepseek', model: req.model.id, payload: { role: 'assistant', content: s.text ?? null } } },
      stop: s.stop ?? (s.calls?.length ? 'tool_use' : 'end'),
      usage,
    };
  }
}

/** A minimal GLB: one 1x1x1 triangle mesh used by two nodes, one rotated 90 degrees about Z and stretched along X. */
export function glbBytes(): Buffer {
  const pos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(pos.buffer);
  const s = Math.SQRT1_2;
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ children: [1, 2] }, { mesh: 0 }, { mesh: 0, translation: [0, 0, 5], rotation: [0, 0, s, s] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [2, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
  const ch = (len: number, type: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(bin.length, 0x004e4942), bin]);
}

/**
 * An 8-bit RGB (or RGBA) PNG whose pixels come from `pixel`. Rows cycle
 * through the five PNG filters, so a reader's unfiltering is exercised.
 */
export function pngBytes(width: number, height: number, pixel: (x: number, y: number) => number[], alpha = false): Buffer {
  const bpp = alpha ? 4 : 3;
  const stride = width * bpp;
  const rows: Buffer[] = [];
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(stride);
    for (let x = 0; x < width; x++) pixel(x, y).slice(0, bpp).forEach((v, i) => { row[x * bpp + i] = v; });
    const f = y % 5;
    const out = Buffer.alloc(stride + 1);
    out[0] = f;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp]! : 0;
      const b = prev[i]!;
      const c = i >= bpp ? prev[i - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f]!;
      out[i + 1] = (row[i]! - pred) & 0xff;
    }
    rows.push(out);
    prev = row;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** A small picture with something in it: a gradient with a square. */
export const testPicture = (w = 96, h = 64) => pngBytes(w, h, (x, y) => (x > w / 3 && x < (2 * w) / 3 && y > h / 3 && y < (2 * h) / 3 ? [220, 120, 30] : [x * 2, y * 3, 128]));
