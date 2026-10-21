import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { McpServerConfig } from '../plugins/api.ts';

// MCP bundles (.mcpb, formerly .dxt): a zip with a manifest.json and the server's
// code, the format Claude Desktop installs as "Desktop Extensions" with one click.
// Installing one unpacks it into the data folder and registers its server as an
// operator MCP server; the person installing it fills in the values the bundle
// asks for (user_config) - an API key, a folder.

export class McpbError extends Error {}

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

/** The files in a zip archive (stored or deflated entries). Paths that leave the folder, and links, are refused. */
export function readZip(buf: Buffer): { name: string; data: Buffer }[] {
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new McpbError('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new McpbError('the archive has too many files');
  const out: { name: string; data: Buffer }[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new McpbError('the zip directory is damaged');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const extAttr = buf.readUInt32LE(off + 38);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8').replace(/\\/g, '/');
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    // Unix mode in the high 16 bits: a symbolic link (0o120000) is never unpacked.
    if (((extAttr >>> 16) & 0o170000) === 0o120000) throw new McpbError(`the archive holds a link (${name})`);
    if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.split('/').some((p) => p === '..')) throw new McpbError(`the archive holds a path outside its folder (${name})`);
    total += usize;
    if (total > MAX_TOTAL) throw new McpbError('the archive unpacks to more than 200 MB');
    const lnlen = buf.readUInt16LE(local + 26), lelen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lelen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }) : (() => { throw new McpbError(`unsupported compression in ${name}`); })();
    out.push({ name, data });
  }
  return out;
}

export interface McpbManifest {
  name: string;
  version?: string;
  display_name?: string;
  description?: string;
  server: { type: 'node' | 'python' | 'binary' | 'uv'; entry_point: string; mcp_config?: { command?: string; args?: string[]; env?: Record<string, string> } };
  user_config?: Record<string, { type?: string; title?: string; description?: string; required?: boolean; sensitive?: boolean; default?: unknown }>;
}

export interface InstalledMcpb { name: string; version?: string; description?: string; dir: string; config: McpServerConfig; installedAt: number }

/** ${__dirname} -> the install folder; ${user_config.key} -> the value given at install. */
function fill(v: string, dir: string, values: Record<string, string>): string {
  return v.replace(/\$\{__dirname\}/g, dir).replace(/\$\{user_config\.([\w-]+)\}/g, (_m, k: string) => values[k] ?? '');
}

/** Unpacks a bundle into `root/<name>` and returns how to start its server. */
export async function installMcpb(bundle: Buffer, root: string, userConfig: Record<string, unknown> = {}): Promise<InstalledMcpb> {
  const files = readZip(bundle);
  const mf = files.find((f) => f.name === 'manifest.json');
  if (!mf) throw new McpbError('the bundle has no manifest.json');
  let m: McpbManifest;
  try { m = JSON.parse(mf.data.toString('utf8')) as McpbManifest; } catch { throw new McpbError('manifest.json is not valid JSON'); }
  if (typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name)) throw new McpbError('the manifest needs a name of letters, digits, . _ and -');
  if (!m.server || typeof m.server.entry_point !== 'string') throw new McpbError('the manifest needs server.entry_point');
  if (!['node', 'python', 'binary', 'uv'].includes(m.server.type)) throw new McpbError(`server.type "${m.server.type}" is not supported`);
  const values: Record<string, string> = {};
  for (const [k, spec] of Object.entries(m.user_config ?? {})) {
    const v = userConfig[k] ?? spec.default;
    if ((v === undefined || v === '') && spec.required) throw new McpbError(`the bundle needs "${spec.title ?? k}" (user_config.${k})`);
    if (v !== undefined) values[k] = Array.isArray(v) ? v.join(path.delimiter) : String(v);
  }
  const dir = path.join(root, m.name);
  await fs.rm(dir, { recursive: true, force: true });
  for (const f of files) {
    const target = path.join(dir, ...f.name.split('/'));
    if (!target.startsWith(dir + path.sep)) throw new McpbError(`the archive holds a path outside its folder (${f.name})`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.data);
  }
  const mc = m.server.mcp_config ?? {};
  const entry = path.join(dir, ...m.server.entry_point.split('/'));
  const command = mc.command ? fill(mc.command, dir, values)
    : m.server.type === 'node' ? process.execPath
    : m.server.type === 'python' ? (process.platform === 'win32' ? 'python' : 'python3')
    : m.server.type === 'uv' ? 'uv' : entry;
  const args = mc.args ? mc.args.map((a) => fill(a, dir, values))
    : m.server.type === 'binary' ? [] : m.server.type === 'uv' ? ['run', entry] : [entry];
  const env = Object.fromEntries(Object.entries(mc.env ?? {}).map(([k, v]) => [k, fill(String(v), dir, values)]));
  return { name: m.name, version: m.version, description: m.description ?? m.display_name, dir, config: { command, args, env, cwd: dir } as McpServerConfig, installedAt: Date.now() };
}

/** The bundles installed under `root` (installed.json), to register at start. */
export async function installedMcpb(root: string): Promise<InstalledMcpb[]> {
  try { return JSON.parse(await fs.readFile(path.join(root, 'installed.json'), 'utf8')) as InstalledMcpb[]; } catch { return []; }
}

export async function saveInstalled(root: string, list: InstalledMcpb[]): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'installed.json'), JSON.stringify(list, null, 1), { mode: 0o600 });
}
