import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { McpServerConfig } from '../plugins/api.ts';
import { seal, serverKey, unseal } from '../util/sealed.ts';

// MCP bundles (.mcpb, formerly .dxt): a zip with a manifest.json and the server's
// code, the format Claude Desktop installs as "Desktop Extensions" with one click.
// Installing one unpacks it into the data folder and registers its server as an
// operator MCP server; the person installing it fills in the values the bundle
// asks for (user_config) - an API key, a folder. Values the manifest marks
// "sensitive" are kept on disk only encrypted (AES-256-GCM under the server's key,
// see util/sealed.ts) and decrypted into memory when the server loads them.

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

export interface InstalledMcpb {
  name: string; version?: string; description?: string; dir: string;
  /** How to start the server, with every value filled in (in memory only when some are sensitive). */
  config: McpServerConfig;
  installedAt: number;
  /** The config with the sensitive values left as ${user_config.key}: what is written to disk. */
  template?: McpServerConfig;
  /** The sensitive values (user_config marked "sensitive"): on disk only encrypted. */
  secrets?: Record<string, string>;
  /** Why its secrets could not be decrypted (the server key changed); it starts without them. */
  problem?: string;
  /** Its sealed secrets as they were, kept when they could not be decrypted (a later save keeps them). */
  sealed?: string;
}

/** On disk: the template, and the secrets sealed with the server's key. */
type StoredMcpb = Omit<InstalledMcpb, 'secrets' | 'template' | 'problem'>;

/** ${__dirname} -> the install folder; ${user_config.key} -> the value given at install (a key not in `values` stays as it is). */
function fill(v: string, dir: string, values: Record<string, string>, keep: Set<string> = new Set()): string {
  return v.replace(/\$\{__dirname\}/g, dir).replace(/\$\{user_config\.([\w-]+)\}/g, (m, k: string) => (keep.has(k) ? m : values[k] ?? ''));
}

/** Fills only ${user_config.key} of the given values, everywhere in a config. */
function fillSecrets(c: McpServerConfig, secrets: Record<string, string>): McpServerConfig {
  const f = (v: string) => v.replace(/\$\{user_config\.([\w-]+)\}/g, (m, k: string) => secrets[k] ?? m);
  const x = c as McpServerConfig & { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string };
  return {
    ...x,
    ...(x.command !== undefined ? { command: f(x.command) } : {}),
    ...(x.args ? { args: x.args.map(f) } : {}),
    ...(x.env ? { env: Object.fromEntries(Object.entries(x.env).map(([k, v]) => [k, f(String(v))])) } : {}),
  } as McpServerConfig;
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
  const sensitive = new Set<string>();
  for (const [k, spec] of Object.entries(m.user_config ?? {})) {
    const v = userConfig[k] ?? spec.default;
    if ((v === undefined || v === '') && spec.required) throw new McpbError(`the bundle needs "${spec.title ?? k}" (user_config.${k})`);
    if (v !== undefined) values[k] = Array.isArray(v) ? v.join(path.delimiter) : String(v);
    if (spec.sensitive && values[k]) sensitive.add(k);
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
  // `keep`: the sensitive values stay placeholders (the template written to disk).
  const build = (keep: Set<string>): McpServerConfig => {
    const command = mc.command ? fill(mc.command, dir, values, keep)
      : m.server.type === 'node' ? process.execPath
      : m.server.type === 'python' ? (process.platform === 'win32' ? 'python' : 'python3')
      : m.server.type === 'uv' ? 'uv' : entry;
    const args = mc.args ? mc.args.map((a) => fill(a, dir, values, keep))
      : m.server.type === 'binary' ? [] : m.server.type === 'uv' ? ['run', entry] : [entry];
    const env = Object.fromEntries(Object.entries(mc.env ?? {}).map(([k, v]) => [k, fill(String(v), dir, values, keep)]));
    return { command, args, env, cwd: dir } as McpServerConfig;
  };
  const secrets = Object.fromEntries([...sensitive].map((k) => [k, values[k]!]));
  return {
    name: m.name, version: m.version, description: m.description ?? m.display_name, dir, config: build(new Set()), installedAt: Date.now(),
    ...(sensitive.size ? { template: build(sensitive), secrets } : {}),
  };
}

/**
 * The bundles installed under `root` (installed.json), to register at start. Their
 * sensitive values are decrypted here, into memory, with the server's key
 * (HARNESS_SECRET_KEY, else <data>/secret.key; `keyDir` is the data folder).
 */
export async function installedMcpb(root: string, o: { keyDir?: string; env?: NodeJS.ProcessEnv; log?: (m: string) => void } = {}): Promise<InstalledMcpb[]> {
  let stored: StoredMcpb[];
  try { stored = JSON.parse(await fs.readFile(path.join(root, 'installed.json'), 'utf8')) as StoredMcpb[]; } catch { return []; }
  let key: Buffer | undefined;
  const out: InstalledMcpb[] = [];
  let migrated = false;
  for (const { sealed, ...b } of stored) {
    if (!sealed) {
      // Installed before secrets were encrypted: their values sit in the config in plain
      // text. Recovered from the manifest's templates and saved encrypted from now on.
      const m = await unsealedSecrets(b).catch(() => undefined);
      if (m === null) o.log?.(`MCP bundle ${b.name}: its secrets are stored in plain text by an older version and could not be moved to encrypted storage; install it again`);
      if (m) { out.push({ ...b, template: m.template, secrets: m.secrets }); migrated = true; } else out.push(b);
      continue;
    }
    try {
      key ??= await serverKey(o.keyDir ?? path.dirname(root), o.env);
      const secrets = JSON.parse(unseal(key, sealed)) as Record<string, string>;
      out.push({ ...b, template: b.config, secrets, config: fillSecrets(b.config, secrets) });
    } catch (e) {
      out.push({ ...b, template: b.config, sealed, problem: `its secrets cannot be read: ${(e as Error).message}. Install it again.` });
      o.log?.(`MCP bundle ${b.name}: its secrets cannot be read (${(e as Error).message}); it starts without them. Install it again.`);
    }
  }
  if (migrated) {
    await saveInstalled(root, out, o);
    o.log?.('MCP bundles: secrets stored in plain text by an older version are now encrypted');
  }
  return out;
}

/**
 * For a bundle stored before encryption: its sensitive values, read back from the
 * plain config by matching it against the manifest's templates, and the config with
 * placeholders in their place. undefined: nothing sensitive; null: it could not be done.
 */
async function unsealedSecrets(b: Omit<InstalledMcpb, 'secrets' | 'template'>): Promise<{ template: McpServerConfig; secrets: Record<string, string> } | undefined | null> {
  const m = JSON.parse(await fs.readFile(path.join(b.dir, 'manifest.json'), 'utf8')) as McpbManifest;
  const sensitive = new Set(Object.entries(m.user_config ?? {}).filter(([, s]) => s.sensitive).map(([k]) => k));
  if (!sensitive.size) return undefined;
  const mc = m.server?.mcp_config ?? {};
  const secrets: Record<string, string> = {};
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // One stored string against its template: the template with ${__dirname} filled, the
  // non-sensitive values as they were stored, and the sensitive ones as placeholders.
  const unfill = (tpl: string | undefined, have: string | undefined): string | undefined | null => {
    if (tpl === undefined || have === undefined) return have;
    const keys: string[] = [];
    const parts = tpl.split(/(\$\{__dirname\}|\$\{user_config\.[\w-]+\})/);
    const re = new RegExp(`^${parts.map((p) => {
      if (p === '${__dirname}') return esc(b.dir);
      const k = /^\$\{user_config\.([\w-]+)\}$/.exec(p)?.[1];
      if (k) { keys.push(k); return '([\\s\\S]*?)'; }
      return esc(p);
    }).join('')}$`);
    const hit = re.exec(have);
    if (!hit) return null;
    let n = 0;
    return parts.map((p) => {
      if (p === '${__dirname}') return b.dir;
      const k = /^\$\{user_config\.([\w-]+)\}$/.exec(p)?.[1];
      if (!k) return p;
      const v = hit[++n]!;
      if (!sensitive.has(k)) return v;
      if (secrets[k] !== undefined && secrets[k] !== v) throw new Error('the same value differs');
      secrets[k] = v;
      return p;
    }).join('');
  };
  const c = b.config as McpServerConfig & { command?: string; args?: string[]; env?: Record<string, string> };
  const command = mc.command ? unfill(mc.command, c.command) : c.command;
  const args = mc.args && c.args ? (mc.args.length === c.args.length ? mc.args.map((t, i) => unfill(t, c.args![i])) : null) : c.args;
  const env = c.env ? Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, mc.env && k in mc.env ? unfill(String(mc.env[k]), String(v)) : v])) : undefined;
  if (command === null || args === null || (Array.isArray(args) && args.includes(null as never)) || (env && Object.values(env).includes(null as never))) return null;
  if (!Object.keys(secrets).length) return undefined;
  return { template: { ...c, ...(command !== undefined ? { command } : {}), ...(args ? { args: args as string[] } : {}), ...(env ? { env: env as Record<string, string> } : {}) } as McpServerConfig, secrets };
}

/** Writes the list: sensitive values encrypted (AES-256-GCM, the server's key), never in plain text. */
export async function saveInstalled(root: string, list: InstalledMcpb[], o: { keyDir?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  let key: Buffer | undefined;
  const stored: StoredMcpb[] = [];
  for (const { secrets, template, problem: _p, sealed, ...b } of list) {
    if (template && secrets && Object.keys(secrets).length) {
      key ??= await serverKey(o.keyDir ?? path.dirname(root), o.env);
      stored.push({ ...b, config: template, sealed: seal(key, JSON.stringify(secrets)) });
    } else stored.push({ ...b, ...(template ? { config: template } : {}), ...(sealed ? { sealed } : {}) });
  }
  const file = path.join(root, 'installed.json');
  const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(stored, null, 1), { mode: 0o600 });
  await fs.rename(tmp, file);
}
