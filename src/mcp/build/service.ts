import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelSpec } from '../../core/models.ts';
import type { Provider } from '../../providers/types.ts';
import { readJson, writeFileAtomic } from '../../util/shared-file.ts';
import { type UserMcp } from '../servers.ts';
import { type CheckReport, checkServer, localCommand, packServer, serverFiles, writeServer } from './builder.ts';
import { generateServerSpec } from './generate.ts';
import { type BuildSpec, BuildSpecError, checkBuildSpec, type DbTable, fromDatabase, fromOpenApi, type OpenApiOperation } from './spec.ts';

// The MCP server builder for a person (docs/agents-mcp/PLAN.md, phase 3): a draft spec from an OpenAPI document, a
// database, a command or a description; the server built from it in <data>/mcp-builds/<owner>/<name>/, checked,
// packed as a .mcpb, and added to the person's own servers. Building runs code on the server's computer, so only
// an administrator builds (the desktop app's person is one).

export interface BuildRecord { name: string; spec: BuildSpec; source: string; report?: CheckReport; builtAt: number; bundle?: { bytes: number; at: number }; registered?: boolean }

export type DraftSource =
  | { source: 'openapi'; text?: string; url?: string; only?: string[]; name?: string }
  | { source: 'database'; kind: 'sqlite' | 'duckdb'; path: string; tables?: string[]; write?: boolean; name?: string }
  | { source: 'description'; description: string }
  | { source: 'command'; command: string; description?: string };

export interface Draft { spec: BuildSpec; operations?: OpenApiOperation[]; skipped?: string[]; tables?: DbTable[]; costUsd?: number }

export class BuildError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const SECRET_VALUE = /^\$\{vault:[A-Za-z0-9_.@-]{1,128}\}$/;

export class McpBuilder {
  readonly root: string;
  private um: UserMcp;
  constructor(dataDir: string, um: UserMcp) { this.root = path.join(dataDir, 'mcp-builds'); this.um = um; }

  private ownerDir(owner: string | undefined): string { return path.join(this.root, (owner ?? '_local').replace(/[^\w.-]/g, '_').slice(0, 80) || '_local'); }
  dir(owner: string | undefined, name: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new BuildError('not a server name', 404);
    return path.join(this.ownerDir(owner), name);
  }
  private mayBuild(owner: string | undefined): void {
    if (!this.um.isAdmin(owner)) throw new BuildError('Building a server runs its code on this server\'s computer: only administrators can. Ask one, or build it in the desktop app on your computer.', 403);
  }

  async list(owner: string | undefined): Promise<BuildRecord[]> {
    let names: string[] = [];
    try { names = (await fs.readdir(this.ownerDir(owner), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    const out: BuildRecord[] = [];
    for (const n of names.sort()) { const r = await this.get(owner, n).catch(() => undefined); if (r) out.push(r); }
    return out;
  }
  async get(owner: string | undefined, name: string): Promise<BuildRecord | undefined> {
    return readJson<BuildRecord | undefined>(path.join(this.dir(owner, name), 'build.json'), undefined);
  }
  private async save(owner: string | undefined, r: BuildRecord): Promise<void> {
    await fs.mkdir(this.dir(owner, r.name), { recursive: true });
    await writeFileAtomic(path.join(this.dir(owner, r.name), 'build.json'), JSON.stringify(r, null, 1));
  }

  /** A spec to review, from where the person points (nothing is written). */
  async draft(owner: string | undefined, d: DraftSource, ai?: { model: ModelSpec; provider: Provider }): Promise<Draft> {
    this.mayBuild(owner);
    const taken = [...(await this.list(owner)).map((b) => b.name), ...(await this.um.list(owner)).map((s) => s.name)];
    try {
      if (d.source === 'openapi') {
        let text = d.text;
        if (!text && d.url) {
          const res = await fetch(d.url, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new BuildError(`the document's address answered ${res.status}`);
          text = (await res.text()).slice(0, 10_000_000);
        }
        if (!text) throw new BuildError('give the OpenAPI document (its text or its address)');
        const r = fromOpenApi(text, { ...(d.only ? { only: d.only } : {}), ...(d.name ? { name: d.name } : {}) });
        return { spec: r.spec, operations: r.operations, skipped: r.skipped };
      }
      if (d.source === 'database') {
        const tables = await introspect(d.kind, d.path);
        const chosen = d.tables ? tables.filter((t) => d.tables!.includes(t.name)) : tables.slice(0, 20);
        const spec = fromDatabase({ name: d.name ?? (path.basename(d.path).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'database'), kind: d.kind, tables: chosen, write: !!d.write });
        return { spec, tables };
      }
      if (!ai) throw new BuildError('no model is available to draft the server');
      if (d.source === 'command') {
        // What the program says about itself (no shell; ten seconds).
        const help = await new Promise<string>((resolve) => execFile(d.command, ['--help'], { timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true }, (_e, out, err) => resolve(`${out}\n${err}`.trim().slice(0, 12_000))));
        if (!help) throw new BuildError(`"${d.command} --help" said nothing: is it installed here?`);
        const r = await generateServerSpec({ ...ai, taken, description: `A server whose tools run the command-line program "${d.command}" (tools of kind "command", command "${d.command}"). ${d.description ?? 'Offer its most useful operations.'}\n\nIts --help output:\n${help}` });
        return { spec: r.spec, costUsd: r.costUsd };
      }
      const r = await generateServerSpec({ ...ai, taken, description: d.description });
      return { spec: r.spec, costUsd: r.costUsd };
    } catch (e) { if (e instanceof BuildSpecError) throw new BuildError(e.message, 422); throw e; }
  }

  /** The values a server's settings get for a check or a registration: secrets only as ${vault:} references. */
  private checkSettings(spec: BuildSpec, settings: Record<string, string>): void {
    for (const e of spec.env) {
      const v = settings[e.name];
      if (v === undefined || v === '') { if (e.required) continue; else continue; }
      if (e.secret && !SECRET_VALUE.test(v)) throw new BuildError(`${e.name} is a secret: put it in the Vault and give \${vault:name} here`);
    }
    for (const k of Object.keys(settings)) if (!spec.env.some((e) => e.name === k)) throw new BuildError(`${k} is not a setting of this server`);
  }

  /** Writes and checks the server (a new one, or a new version of one of the same name). */
  async build(owner: string | undefined, rawSpec: unknown, settings: Record<string, string> = {}, source = 'spec'): Promise<BuildRecord> {
    this.mayBuild(owner);
    let spec: BuildSpec;
    try { spec = checkBuildSpec(rawSpec); } catch (e) { throw new BuildError((e as Error).message, 422); }
    this.checkSettings(spec, settings);
    const dir = this.dir(owner, spec.name);
    const had = await this.get(owner, spec.name);
    await writeServer(dir, spec);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (v) env[k] = await this.um.expand(owner, v, spec.name);
    const report = await checkServer(dir, spec, env);
    // The settings the check used (vault references, never values) go with the build, for registering it.
    await writeFileAtomic(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 1));
    const rec: BuildRecord = { name: spec.name, spec, source, report, builtAt: Date.now(), ...(had?.registered ? { registered: true } : {}) };
    await this.save(owner, rec);
    return rec;
  }

  async pack(owner: string | undefined, name: string): Promise<BuildRecord> {
    this.mayBuild(owner);
    const rec = await this.get(owner, name);
    if (!rec) throw new BuildError(`no server "${name}" was built`, 404);
    const r = await packServer(this.dir(owner, name), rec.spec);
    if ('error' in r) throw new BuildError(r.error, 501);
    rec.bundle = { bytes: r.bytes, at: Date.now() };
    await this.save(owner, rec);
    return rec;
  }
  async bundle(owner: string | undefined, name: string): Promise<Buffer> {
    try { return await fs.readFile(path.join(this.dir(owner, name), `${name}.mcpb`)); } catch { throw new BuildError('pack it first', 404); }
  }
  /** One of its files (the configs, the README, the spec) to read or copy. */
  async file(owner: string | undefined, name: string, rel: string): Promise<string> {
    const files = await serverFiles((await this.get(owner, name))?.spec ?? (() => { throw new BuildError(`no server "${name}" was built`, 404); })());
    if (!(rel in files)) throw new BuildError(`no file ${rel}: ${Object.keys(files).join(', ')}`, 404);
    return fs.readFile(path.join(this.dir(owner, name), ...rel.split('/')), 'utf8');
  }

  /** Adds the built server to the person's own servers (or updates the entry), its settings as given at build time. */
  async register(owner: string | undefined, name: string): Promise<{ created: boolean }> {
    this.mayBuild(owner);
    const rec = await this.get(owner, name);
    if (!rec) throw new BuildError(`no server "${name}" was built`, 404);
    if (rec.report && !rec.report.ok) throw new BuildError('its check did not pass: fix it and build it again first', 409);
    const settings = await readJson<Record<string, string>>(path.join(this.dir(owner, name), 'settings.json'), {});
    const cmd = localCommand(this.dir(owner, name));
    const cfg = { name, type: 'stdio', command: cmd.command, args: cmd.args, cwd: this.dir(owner, name), description: rec.spec.description.slice(0, 500), ...(Object.keys(settings).length ? { env: settings } : {}) };
    const existing = await this.um.get(owner, name);
    if (existing) await this.um.update(owner, name, cfg); else await this.um.create(owner, cfg, { source: 'builder' });
    rec.registered = true;
    await this.save(owner, rec);
    return { created: !existing };
  }

  async remove(owner: string | undefined, name: string): Promise<void> {
    this.mayBuild(owner);
    const dir = this.dir(owner, name);
    // Only a real folder of ours (never a link that leads elsewhere).
    const st = await fs.lstat(dir).catch(() => undefined);
    if (!st) throw new BuildError(`no server "${name}" was built`, 404);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new BuildError('not a build folder', 409);
    // Its process (when it is one of the person's servers) holds the folder open: stopped first.
    await this.um.forget(owner, name);
    try { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {
      throw new BuildError(`its folder could not be removed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): is it running somewhere else?`, 409);
    }
  }
}

/** The tables of a database file, and their columns. */
export async function introspect(kind: 'sqlite' | 'duckdb', file: string): Promise<DbTable[]> {
  try { await fs.access(file); } catch { throw new BuildError(`no database file at ${file}`); }
  if (kind === 'sqlite') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
      return names.map((n) => ({ name: n.name, columns: (db.prepare(`PRAGMA table_info("${n.name.replace(/"/g, '""')}")`).all() as Array<{ name: string; type: string }>).map((c) => ({ name: c.name, type: c.type || 'TEXT' })) }));
    } finally { db.close(); }
  }
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const conn = await (await DuckDBInstance.create(file, { access_mode: 'READ_ONLY' })).connect();
  const rows = (await conn.runAndReadAll("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('information_schema','pg_catalog') ORDER BY table_name, ordinal_position")).getRowObjectsJson() as Array<{ table_name: string; column_name: string; data_type: string }>;
  const by = new Map<string, DbTable>();
  for (const r of rows) { const t = by.get(r.table_name) ?? { name: r.table_name, columns: [] }; t.columns.push({ name: r.column_name, type: r.data_type }); by.set(r.table_name, t); }
  return [...by.values()];
}
