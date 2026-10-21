import { rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Agent, type AgentHooks } from '../src/core/agent.ts';
import { getModel } from '../src/core/models.ts';
import { defaultSettings, type Settings } from '../src/core/settings.ts';
import type { Block, HarnessEvent, Message, PermissionMode, Todo, Usage } from '../src/core/types.ts';
import type { Provider, ProviderRequest, ProviderResponse, StopKind } from '../src/providers/types.ts';
import { LocalHost } from '../src/runtime/host.ts';
import { BUILTIN_TOOLS } from '../src/tools/index.ts';
import type { FileStamp, Tool } from '../src/tools/types.ts';

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

type Step = { text?: string; calls?: { name: string; input?: Record<string, unknown>; parseError?: string }[]; stop?: StopKind; usage?: Partial<Usage> };

/** A provider that replays scripted turns and records every request it receives. */
export class FakeProvider implements Provider {
  requests: ProviderRequest[] = [];
  snapshots: string[] = [];
  private steps: Step[];
  private n = 0;
  constructor(steps: Step[]) { this.steps = steps; }
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

export interface Harness {
  agent: Agent;
  provider: FakeProvider;
  events: HarnessEvent[];
  persisted: Message[];
  root: string;
  mode: { value: PermissionMode };
  permissionAnswers: boolean[];
  todos: Todo[];
}

export async function makeAgent(steps: Step[], opts: { mode?: PermissionMode; settings?: Partial<Settings>; tools?: Tool[]; root?: string } = {}): Promise<Harness> {
  const provider = new FakeProvider(steps);
  const root = opts.root ?? await tempDir();
  const events: HarnessEvent[] = [];
  const persisted: Message[] = [];
  const mode = { value: opts.mode ?? 'bypass' as PermissionMode };
  const permissionAnswers: boolean[] = [];
  let todos: Todo[] = [];
  const settings = { ...defaultSettings(), ...opts.settings };
  const hooks: AgentHooks = {
    emit: (e) => events.push(e),
    onAppend: (m) => persisted.push(m),
    onCompact: (ctx) => persisted.push(...ctx),
    onUsage: () => {},
    overBudget: () => undefined,
    getMode: () => mode.value,
    rules: () => settings.permissions,
    requestPermission: async () => {
      const a = permissionAnswers.shift() ?? false;
      return a ? { allow: true } : { allow: false, feedback: 'no thanks' };
    },
    takeQueuedUserText: () => [],
    todos: () => todos,
    setTodos: (t) => { todos = t; },
    preamble: async () => '<environment>test</environment>',
    latestUserPrompt: () => 'the task',
  };
  const agent = new Agent({
    name: 'main', model: getModel('deepseek-flash'), provider, effort: 'high', system: 'SYSTEM', tools: opts.tools ?? BUILTIN_TOOLS,
    host: new LocalHost(root), settings, cacheKey: 'test', maxSteps: 20, readFiles: new Map<string, FileStamp>(),
  }, hooks);
  return { agent, provider, events, persisted, root, mode, permissionAnswers, get todos() { return todos; } } as Harness;
}

export function results(m: Message | undefined): { content: string; is_error?: boolean }[] {
  return (m?.content ?? []).filter((b) => b.type === 'tool_result') as { content: string; is_error?: boolean }[];
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

/**
 * A stand-in for Godot 4 (a sh script) that understands the command lines the
 * games3d plugin builds: import, the check script, frames for --write-movie,
 * --selftest (SELFTEST PASS when a script says so, a push_error when one says
 * FAKE_FAIL) and --export-release (FAKE_NO_TEMPLATES=1: "No export template
 * found"). Every call is appended to calls.log beside it. For HARNESS_GODOT.
 */
export async function fakeGodot(): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await tempDir('hw-fake-godot-');
  const file = path.join(dir, 'godot');
  const log = path.join(dir, 'calls.log');
  const frame = testPicture(32, 24).toString('base64');
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${log.split(path.sep).join('/')}'`,
    'proj=.; movie=; frames=60; selftest=0; import=0; check=; out=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --path) proj=$2; shift;;',
    '    --write-movie) movie=$2; shift;;',
    '    --quit-after) frames=$2; shift;;',
    '    --import) import=1;;',
    '    --script) check=$2; shift;;',
    '    --export-release|--export-debug) out=$3; shift 2;;',
    '    --selftest) selftest=1;;',
    '  esac',
    '  shift',
    'done',
    'echo "Godot Engine v4.7.2.stable.fake"',
    '[ "$import" = 1 ] && exit 0',
    'if [ -n "$check" ]; then echo "HARNESS_CHECKED $(find "$proj" -name "*.gd" -o -name "*.tscn" | grep -v "/.godot/" | wc -l | tr -d " ")"; exit 0; fi',
    'if [ -n "$out" ]; then',
    '  if [ "${FAKE_NO_TEMPLATES:-}" = 1 ]; then echo "ERROR: Cannot export project with preset: No export template found at the expected path"; exit 1; fi',
    '  mkdir -p "$(dirname "$out")" && echo binary > "$out" && echo pack > "${out%.*}.pck"; exit 0',
    'fi',
    'if [ -n "$movie" ]; then',
    '  i=0',
    `  while [ $i -lt "$frames" ]; do printf '%s' '${frame}' | base64 -d > "\${movie%.png}$(printf '%08d' $i).png"; i=$((i+1)); done`,
    'fi',
    'if [ "$selftest" = 1 ]; then',
    '  if grep -rq FAKE_FAIL --include="*.gd" "$proj"; then printf "ERROR: selftest: the player did not move\\n   at: push_error (core/variant/variant_utility.cpp:1023)\\n   GDScript backtrace (most recent call first):\\n       [0] _physics_process (res://main.gd:9)\\n";',
    '  elif grep -rq "SELFTEST PASS" --include="*.gd" "$proj"; then echo "SELFTEST PASS"; fi',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(file, script, { mode: 0o755 });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { bin: file.split(path.sep).join('/'), calls };
}
