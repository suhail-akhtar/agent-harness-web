import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SealError, seal, serverKey, unseal } from '../util/sealed.ts';
import { FileWatch, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { type Backend, backendsFrom } from './backends.ts';
import { MIN_SECRET_LENGTH } from './redact.ts';

// The key vault: named secrets that sessions use without the model ever seeing
// them. Metadata is in clear in <data>/vault/entries.json (name, kind, scope,
// owner, versions); each value is in a backend (sealed with the server key by
// default, see backends.ts), the current one and up to five before it, so a bad
// rotation can be rolled back. Who may do what:
//   operator scope  written by administrators (the operator token or an admin
//                   account) through the API; used by administrators' sessions,
//                   and by the members or accounts its `allow` list names (new
//                   entries: administrators only). Whoever can use a secret in a
//                   command can in effect read it (`echo $X | rev` is not
//                   redacted), so `allow` is the real boundary, not redaction;
//   user scope      one account's own (its sessions and the person); nobody else
//                   sees the names, administrators included;
//   session scope   one session's (and the account that owns it).
// Every use and change is appended to <data>/vault/audit.jsonl: who, which
// session and plugin, what, which entry, why - never a value.

export const VAULT_KINDS = ['secret', 'password', 'token', 'ssh-key', 'certificate', 'connection-string'] as const;
export type VaultKind = typeof VAULT_KINDS[number];
export type VaultScope = 'operator' | 'user' | 'session';
const SCOPES: VaultScope[] = ['operator', 'user', 'session'];
/** Earlier versions kept per entry. */
export const KEEP_VERSIONS = 5;
const MAX_VALUE = 64 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** What anyone but the backend sees of an entry: never the value. */
export interface VaultEntryInfo {
  name: string;
  description?: string;
  kind: VaultKind;
  scope: VaultScope;
  createdAt: number;
  updatedAt: number;
  /** When it should be rotated by (ms since the epoch). */
  rotateBy?: number;
  rotateEveryDays?: number;
  backend: string;
  version: number;
  /** rotateBy has passed. */
  overdue?: boolean;
  /** Operator scope, shown to administrators: who besides administrators may use it ("members", account ids). */
  allow?: string[];
}

interface VersionRecord { version: number; handle: string; createdAt: number; by: string }

interface StoredEntry {
  name: string;
  scope: VaultScope;
  /** '' (operator scope), the account (user scope) or the session id (session scope). */
  owner: string;
  /** The account the entry belongs to ('' for operator scope). */
  account: string;
  kind: VaultKind;
  description?: string;
  backend: string;
  ref: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  rotateBy?: number;
  rotateEveryDays?: number;
  current: VersionRecord;
  history: VersionRecord[];
  /**
   * Operator scope: who may use it besides administrators - "members" (every account)
   * or account ids. Absent (an entry from before the list existed) or ["admins"]:
   * administrators only.
   */
  allow?: string[];
}

/** Who acts. `session`: a session's agent or plugin code; absent: a person through the API. */
export interface VaultActor {
  /** The account (undefined: the single-user server, or the operator token). */
  account?: string;
  /** An administrator (the operator token or an admin account) acting through the API. */
  admin?: boolean;
  session?: string;
  plugin?: string;
  tool?: string;
  /** For the audit log. */
  label?: string;
}

/** Which code asks, inside a session: a plugin is limited to the names its manifest declared. */
export interface VaultCaller { plugin?: string; tool?: string; grants?: string[] }

export interface PutSpec { name: string; value: string; kind?: VaultKind; description?: string; scope?: VaultScope; rotateBy?: number; rotateEveryDays?: number; backend?: string; ref?: string; /** Refuse when it exists (POST); otherwise a new version. */ create?: boolean; /** Operator scope: who may use it besides administrators (see StoredEntry.allow); default administrators only. */ allow?: string[] }
export type GenerateSpec = Omit<PutSpec, 'value'> & { length?: number };

/** The vault as a session's tools see it (ToolServices.vault). */
export interface VaultService {
  /** Names and metadata only - never values. */
  list(): Promise<VaultEntryInfo[]>;
  /** The value, for server-side code only; audited with `purpose`. Never put it in a tool result. */
  reveal(name: string, purpose: string, by?: VaultCaller): Promise<string>;
  /** Environment for one command: { VAR: 'vault-name' } -> values, for host.exec's env only. */
  envFor(map: Record<string, string>, purpose: string, by?: VaultCaller): Promise<Record<string, string>>;
  /** The vault tool's own operations (the main agent only). */
  manage?: {
    put(spec: PutSpec): Promise<VaultEntryInfo>;
    generate(spec: GenerateSpec): Promise<{ info: VaultEntryInfo; publicKey?: string }>;
    rotate(name: string): Promise<VaultEntryInfo>;
    remove(name: string): Promise<boolean>;
    history(name: string): Promise<{ version: number; createdAt: number; by: string; current: boolean }[]>;
  };
}

/** A plugin's way to rotate some entries for real (change the database password, then store it). */
export interface RotationHandler {
  plugin: string;
  kind?: VaultKind;
  /** Entry names it handles (a prefix, e.g. "prod-db-"). */
  prefix?: string;
  /** Returns the new value (or nothing: `generated` is stored). `current()` works for names the plugin declared. */
  rotate(ctx: { name: string; kind: VaultKind; scope: VaultScope; generated: string; current(): Promise<string> }): Promise<string | void>;
}

export interface AuditRecord { at: number; actor: string; account?: string; session?: string; plugin?: string; tool?: string; action: string; name: string; scope?: VaultScope; purpose?: string; result: 'ok' | 'denied' | 'error'; reason?: string }

export class VaultError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** "prod-*" style patterns (a plugin's manifest, permission rules). */
export function vaultGlob(pattern: string): (name: string) => boolean {
  const re = new RegExp(`^${pattern.trim().split('*').map((p) => p.split('?').map((x) => x.replace(/[.+^${}()|[\]\\/]/g, '\\$&')).join('.')).join('.*')}$`);
  return (n) => re.test(n);
}

const acct = (a?: string) => a || '_local';

/** Who an operator-scope entry is for: "admins", "members" ("*" is the same) or account ids. */
export function normalizeAllow(list: unknown): string[] {
  if (!Array.isArray(list)) throw new VaultError('allow is a list: "admins", "members" (every account) or account ids');
  const out = new Set<string>(['admins']);
  for (const x of list) {
    const v = String(x ?? '').trim();
    if (!v) continue;
    if (v === '*' || v === 'members' || v === 'everyone') out.add('members');
    else if (v === 'admins' || v === 'admin') out.add('admins');
    else if (/^[A-Za-z0-9_.@-]{1,128}$/.test(v)) out.add(v);
    else throw new VaultError(`"${v}" is not "admins", "members" or an account id`);
  }
  return [...out];
}

/**
 * Environment names a vault secret may not take: they change how the command, the
 * shell, a language runtime or the Docker CLI behave (where it connects, what it
 * loads), whatever host the command runs on.
 */
export const BLOCKED_ENV = /^(PATH|PATHEXT|HOME|USERPROFILE|SHELL|IFS|ENV|BASH_ENV|BASH_FUNC_\w+|PROMPT_COMMAND|PS4|CDPATH|GLOBIGNORE|SHELLOPTS|BASHOPTS|TMPDIR|TEMP|TMP|SYSTEMROOT|WINDIR|COMSPEC|LD_\w+|DYLD_\w+|NODE_(OPTIONS|PATH|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED|REPL_EXTERNAL_MODULE|V8_COVERAGE|PRESERVE_SYMLINKS\w*|ICU_DATA|DEBUG\w*|REDIRECT_WARNINGS|COMPILE_CACHE)|NPM_CONFIG_\w+|PYTHON[A-Z]+|PERL5\w*|PERLLIB|RUBYOPT|RUBYLIB|GEM_(HOME|PATH)|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|GO(DEBUG|FLAGS|PATH|ROOT|PROXY|ENV|TOOLCHAIN|INSECURE|NOPROXY|NOSUMDB|PRIVATE|SUMDB|MAXPROCS|GC|TRACEBACK|EXPERIMENT)|DOCKER_\w+|\w*_PROXY|SSL_CERT_\w+|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|GIT_(ASKPASS|SSH|SSH_COMMAND|EXEC_PATH|CONFIG\w*|DIR|WORK_TREE|PROXY_COMMAND|TEMPLATE_DIR)|SSH_ASKPASS\w*|SSH_AUTH_SOCK|XDG_\w+|CONTAINER_HOST|CONTAINERS_\w+)$/i;

const GEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.+';

/** A strong random value for a kind (and, for an SSH key, its public half). */
export function generateValue(kind: VaultKind, length?: number): { value: string; publicKey?: string } {
  if (kind === 'password') {
    const n = Math.min(128, Math.max(16, length ?? 28));
    return { value: Array.from({ length: n }, () => GEN_ALPHABET[crypto.randomInt(GEN_ALPHABET.length)]).join('') };
  }
  if (kind === 'secret' || kind === 'token') return { value: crypto.randomBytes(Math.min(128, Math.max(16, length ?? 32))).toString('base64url') };
  if (kind === 'ssh-key') {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const str = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
    const blob = Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]);
    return { value: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: `ssh-ed25519 ${blob.toString('base64')} harness-vault` };
  }
  throw new VaultError(`a ${kind} cannot be generated here: set its value, or rotate it with a plugin's rotation handler`);
}

export interface VaultOptions {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  /** HARNESS_VAULT_BACKENDS (JSON), or the same as an object. */
  backends?: string | Record<string, unknown>;
  /** Rotation handlers plugins registered. */
  rotators?: () => RotationHandler[];
  /** Whether an account's sessions may use the vault (HARNESS_VAULT=admins). */
  mayUse?: (account: string | undefined) => boolean;
  /** Whether an account is an administrator (default: none is; no account, the single-user server's or the operator's, is). */
  isAdmin?: (account: string | undefined) => boolean;
}

export class VaultStore {
  private dir: string;
  private file: string;
  private auditFile: string;
  private entries: StoredEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private watch: FileWatch;
  private auditWrites: Promise<void> = Promise.resolve();
  private key?: Promise<Buffer>;
  readonly backends: Map<string, Backend>;
  readonly defaultBackend: string;
  private opts: VaultOptions;
  mayUse: (account: string | undefined) => boolean;
  /** Whether an account is an administrator: their sessions use every operator-scope entry (the server sets it from its accounts). */
  isAdmin: (account: string | undefined) => boolean;

  constructor(opts: VaultOptions) {
    this.opts = opts;
    this.dir = path.join(opts.dataDir, 'vault');
    this.file = path.join(this.dir, 'entries.json');
    this.auditFile = path.join(this.dir, 'audit.jsonl');
    this.watch = new FileWatch(this.file);
    const env = opts.env ?? process.env;
    const b = backendsFrom(opts.backends ?? env.HARNESS_VAULT_BACKENDS, env, () => this.serverKey());
    this.backends = b.backends;
    this.defaultBackend = b.defaultBackend;
    this.mayUse = opts.mayUse ?? (() => true);
    this.isAdmin = opts.isAdmin ?? ((account) => account === undefined);
  }

  private serverKey(): Promise<Buffer> {
    return (this.key ??= serverKey(this.opts.dataDir, this.opts.env ?? process.env).catch((e) => { this.key = undefined; throw e; }));
  }

  /** Seals text under the server key (a session's record of the values it saw). */
  async seal(text: string): Promise<string> { return seal(await this.serverKey(), text); }
  async unseal(sealed: string): Promise<string> { return unseal(await this.serverKey(), sealed); }

  async load(): Promise<this> {
    try {
      const j = JSON.parse(await fs.readFile(this.file, 'utf8')) as { entries?: StoredEntry[] };
      this.entries = Array.isArray(j.entries) ? j.entries : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new VaultError(`${this.file} cannot be read: ${(e as Error).message}`, 500);
    }
    await this.watch.mark();
    return this;
  }

  /** Another server on the same data folder may have changed the entries: read them again when the file changed. */
  async sync(): Promise<void> {
    // Every time (a stat): a secret changed on another server must not be read stale.
    if (await this.watch.changed(true)) await this.load();
  }

  /**
   * A change: under a lock on the file that every server on the data folder honours, the
   * entries are read again, `fn` changes them, and they are written back atomically - so
   * two servers changing the vault at once never lose one of the changes.
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => withFileLock(this.file, async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.load();
      const r = await fn();
      await writeFileAtomic(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 1), { mode: 0o600 });
      await this.watch.mark();
      return r;
    });
    const p = this.writes.catch(() => {}).then(run);
    this.writes = p.then(() => {}, () => {});
    return p;
  }

  private record(a: VaultActor, action: string, name: string, result: AuditRecord['result'], extra: { scope?: VaultScope; purpose?: string; reason?: string } = {}): void {
    const rec: AuditRecord = {
      at: Date.now(), actor: a.label ?? (a.session ? `session:${a.session}` : a.account ? `account:${a.account}` : 'operator'),
      ...(a.account ? { account: a.account } : {}), ...(a.session ? { session: a.session } : {}), ...(a.plugin ? { plugin: a.plugin } : {}), ...(a.tool ? { tool: a.tool } : {}),
      action, name, ...(extra.scope ? { scope: extra.scope } : {}), ...(extra.purpose ? { purpose: extra.purpose.slice(0, 300) } : {}), result, ...(extra.reason ? { reason: extra.reason.slice(0, 300) } : {}),
    };
    this.auditWrites = this.auditWrites.catch(() => {}).then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await fs.appendFile(this.auditFile, JSON.stringify(rec) + '\n', { mode: 0o600 });
    });
  }

  /** The audit log, newest last (at most `limit` records). */
  async audit(limit = 500): Promise<AuditRecord[]> {
    await this.auditWrites.catch(() => {});
    try {
      const lines = (await fs.readFile(this.auditFile, 'utf8')).split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(limit, 10_000))).map((l) => { try { return JSON.parse(l) as AuditRecord; } catch { return undefined; } }).filter((x): x is AuditRecord => !!x);
    } catch { return []; }
  }

  /** An administrator acting through the API, or a session (or person) of an administrator's account. */
  private adminActor(a: VaultActor): boolean {
    return (a.admin === true && !a.session) || this.isAdmin(a.account);
  }

  /** Operator scope: administrators, plus the members or accounts the entry's `allow` names. */
  private operatorAllows(e: StoredEntry, a: VaultActor): boolean {
    if (this.adminActor(a)) return true;
    const allow = e.allow ?? ['admins'];
    return allow.includes('members') || (!!a.account && allow.includes(a.account));
  }

  private visible(e: StoredEntry, a: VaultActor): boolean {
    if (e.scope === 'operator') return this.operatorAllows(e, a);
    if (e.scope === 'user') return e.owner === acct(a.account);
    return a.session ? e.owner === a.session : e.account === acct(a.account);
  }

  private info(e: StoredEntry, admin = false): VaultEntryInfo {
    return {
      name: e.name, ...(e.description ? { description: e.description } : {}), kind: e.kind, scope: e.scope, createdAt: e.createdAt, updatedAt: e.updatedAt,
      ...(e.rotateBy ? { rotateBy: e.rotateBy } : {}), ...(e.rotateEveryDays ? { rotateEveryDays: e.rotateEveryDays } : {}),
      backend: e.backend, version: e.current.version, ...(e.rotateBy && e.rotateBy < Date.now() ? { overdue: true } : {}),
      ...(admin && e.scope === 'operator' ? { allow: e.allow ?? ['admins'] } : {}),
    };
  }

  private allowed(a: VaultActor): void {
    if (!this.mayUse(a.account) && !a.admin) throw new VaultError('the key vault is not available to this account', 403);
  }

  /** The entry a name means to this actor: its session's, then its own, then the operator's. */
  private resolve(a: VaultActor, name: string, scope?: VaultScope): StoredEntry | undefined {
    const mine = this.entries.filter((e) => e.name === name && this.visible(e, a) && (!scope || e.scope === scope));
    return mine.find((e) => e.scope === 'session') ?? mine.find((e) => e.scope === 'user') ?? mine.find((e) => e.scope === 'operator');
  }

  /** `e`: an existing entry this actor can see (a person may change their own session's entries). */
  private mayWrite(a: VaultActor, scope: VaultScope, e?: StoredEntry): void {
    if (scope === 'operator' && (!a.admin || a.session)) throw new VaultError('only administrators change operator-scope entries (through the API)', 403);
    if (scope === 'session' && !a.session && !e) throw new VaultError('a session-scope entry needs its session', 400);
  }

  list(a: VaultActor): VaultEntryInfo[] {
    this.allowed(a);
    const order = { session: 0, user: 1, operator: 2 } as const;
    const admin = this.adminActor(a);
    return this.entries.filter((e) => this.visible(e, a)).sort((x, y) => order[x.scope] - order[y.scope] || (x.name < y.name ? -1 : 1)).map((e) => this.info(e, admin));
  }

  /** Entries past their rotation date. */
  overdue(a: VaultActor): VaultEntryInfo[] {
    try { return this.list(a).filter((e) => e.overdue); } catch { return []; }
  }

  private backend(name: string): Backend {
    const b = this.backends.get(name);
    if (!b) throw new VaultError(`no vault backend named "${name}" (configured: ${[...this.backends.keys()].join(', ')})`);
    return b;
  }

  private by(a: VaultActor): string { return a.label ?? (a.session ? `session:${a.session}` : a.account ? `account:${a.account}` : 'operator'); }

  async put(a: VaultActor, spec: PutSpec): Promise<VaultEntryInfo> {
    this.allowed(a);
    const scope = spec.scope ?? 'user';
    try {
      if (!NAME.test(spec.name ?? '') || spec.name.includes('..')) throw new VaultError('a vault name is 1-128 letters, digits, ".", "_", "-" or "/", starting with a letter or digit');
      if (!SCOPES.includes(scope)) throw new VaultError(`scope must be ${SCOPES.join(', ')}`);
      if (spec.kind && !VAULT_KINDS.includes(spec.kind)) throw new VaultError(`kind must be one of ${VAULT_KINDS.join(', ')}`);
      if (typeof spec.value !== 'string' || spec.value.length < MIN_SECRET_LENGTH) throw new VaultError(`a value must be at least ${MIN_SECRET_LENGTH} characters (shorter ones cannot be told apart from ordinary text to hide them)`);
      if (spec.value.length > MAX_VALUE) throw new VaultError('a value is at most 64 KB');
      if (spec.ref && (a.session || !a.admin)) throw new VaultError('only administrators point an entry at an existing backend path (ref)', 403);
      this.mayWrite(a, scope);
      if (spec.allow !== undefined && scope !== 'operator') throw new VaultError('allow is for operator-scope entries (user and session entries are their owner\'s alone)');
      const allow = spec.allow !== undefined ? normalizeAllow(spec.allow) : undefined;
      const owner = scope === 'operator' ? '' : scope === 'user' ? acct(a.account) : a.session!;
      const same = (e: StoredEntry) => e.name === spec.name && e.scope === scope && e.owner === owner;
      // The value goes to its backend first, outside the lock on entries.json: an external
      // backend is a network call that can take longer than the lock is honoured (30 s).
      // Only the metadata change below runs under the lock.
      await this.sync();
      const before = this.entries.find(same);
      if (before && spec.create) throw new VaultError(`a ${scope}-scope entry named "${spec.name}" already exists (set it to add a version)`, 409);
      if (before && spec.backend && spec.backend !== before.backend) throw new VaultError(`"${spec.name}" lives in the ${before.backend} backend; delete it to move it`);
      const backendName = before?.backend ?? spec.backend ?? this.defaultBackend;
      const b = this.backend(backendName);
      const ref = before?.ref ?? spec.ref ?? b.refFor({ scope, owner: owner || 'operator', name: spec.name });
      const handle = await b.write(ref, spec.value);
      return await this.locked(async () => {
      const existing = this.entries.find(same);
      if (existing && spec.create) throw new VaultError(`a ${scope}-scope entry named "${spec.name}" already exists (set it to add a version)`, 409);
      // Changed by another server while the value was being written: nothing is half-applied.
      if ((existing && (existing.backend !== backendName || existing.ref !== ref)) || (!existing && before)) throw new VaultError(`"${spec.name}" was changed or deleted at the same moment elsewhere; try again`, 409);
      const now = Date.now();
      const every = spec.rotateEveryDays !== undefined ? Math.max(0, Number(spec.rotateEveryDays) || 0) : existing?.rotateEveryDays;
      const rotateBy = spec.rotateBy ?? (every ? now + every * 86_400_000 : existing?.rotateBy);
      if (existing) {
        if (allow) existing.allow = allow;
        existing.history = [existing.current, ...existing.history].slice(0, KEEP_VERSIONS);
        existing.current = { version: existing.current.version + 1, handle, createdAt: now, by: this.by(a) };
        existing.updatedAt = now;
        if (spec.kind) existing.kind = spec.kind;
        if (spec.description !== undefined) existing.description = String(spec.description).slice(0, 500) || undefined;
        existing.rotateEveryDays = every || undefined;
        existing.rotateBy = rotateBy;
        this.record(a, 'set', spec.name, 'ok', { scope });
        return this.info(existing, this.adminActor(a));
      }
      const e: StoredEntry = {
        name: spec.name, scope, owner, account: scope === 'operator' ? '' : acct(a.account), kind: spec.kind ?? 'secret',
        ...(spec.description ? { description: String(spec.description).slice(0, 500) } : {}),
        backend: backendName, ref, createdAt: now, updatedAt: now, createdBy: this.by(a),
        ...(rotateBy ? { rotateBy } : {}), ...(every ? { rotateEveryDays: every } : {}),
        current: { version: 1, handle, createdAt: now, by: this.by(a) }, history: [],
        // A new operator-scope entry is for administrators only until the operator names others.
        ...(scope === 'operator' ? { allow: allow ?? ['admins'] } : {}),
      };
      this.entries.push(e);
      this.record(a, 'create', spec.name, 'ok', { scope });
      return this.info(e, this.adminActor(a));
      });
    } catch (err) {
      this.record(a, 'set', String(spec.name ?? ''), err instanceof VaultError && err.status === 403 ? 'denied' : 'error', { scope, reason: (err as Error).message });
      throw err;
    }
  }

  async generate(a: VaultActor, spec: GenerateSpec): Promise<{ info: VaultEntryInfo; publicKey?: string }> {
    const kind = spec.kind ?? 'password';
    const g = generateValue(kind, spec.length);
    const info = await this.put(a, { ...spec, kind, value: g.value });
    return { info, ...(g.publicKey ? { publicKey: g.publicKey } : {}) };
  }

  private found(a: VaultActor, action: string, name: string, scope?: VaultScope): StoredEntry {
    this.allowed(a);
    const e = this.resolve(a, name, scope);
    if (!e) {
      this.record(a, action, name, 'denied', { scope, reason: 'no such entry for this caller' });
      throw new VaultError(`no vault entry named "${name}"${scope ? ` in ${scope} scope` : ''} that this ${a.session ? 'session' : 'account'} can use`, 404);
    }
    return e;
  }

  private async readValue(e: StoredEntry, v: VersionRecord): Promise<string> {
    try { return await this.backend(e.backend).read(e.ref, v.handle); } catch (err) {
      if (err instanceof SealError) throw new VaultError(`vault entry "${e.name}": ${err.message}`, 500);
      throw err;
    }
  }

  /** The value (or an earlier version's), audited with why it is needed. */
  async reveal(a: VaultActor, name: string, purpose: string, o: { scope?: VaultScope; version?: number } = {}): Promise<string> {
    await this.sync();
    const e = this.found(a, 'reveal', name, o.scope);
    const v = o.version === undefined || o.version === e.current.version ? e.current : e.history.find((h) => h.version === o.version);
    if (!v) throw new VaultError(`"${name}" has no version ${o.version} (kept: ${[e.current, ...e.history].map((h) => h.version).join(', ')})`, 404);
    try {
      const value = await this.readValue(e, v);
      this.record(a, 'reveal', name, 'ok', { scope: e.scope, purpose: o.version ? `${purpose} (version ${o.version})` : purpose });
      return value;
    } catch (err) {
      this.record(a, 'reveal', name, 'error', { scope: e.scope, purpose, reason: (err as Error).message });
      throw err;
    }
  }

  /** Every kept version's value (current first): what a restarted session hides again. */
  async allValues(a: VaultActor, name: string): Promise<string[]> {
    await this.sync();
    const e = this.resolve(a, name);
    if (!e) return [];
    const out: string[] = [];
    for (const v of [e.current, ...e.history]) { try { out.push(await this.readValue(e, v)); } catch { /* unreadable: nothing to hide */ } }
    this.record(a, 'reload', name, 'ok', { scope: e.scope, purpose: 'hide its values again in a restarted session' });
    return out;
  }

  history(a: VaultActor, name: string, scope?: VaultScope): { version: number; createdAt: number; by: string; current: boolean }[] {
    const e = this.found(a, 'history', name, scope);
    return [{ ...e.current, current: true }, ...e.history.map((h) => ({ ...h, current: false }))].map(({ version, createdAt, by, current }) => ({ version, createdAt, by, current }));
  }

  /**
   * A new version: a plugin's rotation handler makes it (changing the password where
   * it is used), else a strong random value of the entry's kind. The old version
   * stays readable for a rollback.
   */
  async rotate(a: VaultActor, name: string, o: { scope?: VaultScope; value?: string; grantsFor?: (plugin: string) => string[] } = {}): Promise<VaultEntryInfo> {
    await this.sync();
    const e = this.found(a, 'rotate', name, o.scope);
    this.mayWrite(a, e.scope, e);
    let value = o.value;
    if (value === undefined) {
      const h = (this.opts.rotators?.() ?? []).find((r) => (!r.kind || r.kind === e.kind) && (!r.prefix || e.name.startsWith(r.prefix)));
      let generated = '';
      try { generated = generateValue(e.kind).value; } catch (err) { if (!h) throw err; }
      if (h) {
        const grants = o.grantsFor?.(h.plugin) ?? [];
        const got = await h.rotate({
          name: e.name, kind: e.kind, scope: e.scope, generated,
          current: async () => {
            if (!grants.some((g) => vaultGlob(g)(e.name))) throw new VaultError(`${h.plugin}: "${e.name}" is not in its manifest's permissions.vault`, 403);
            return this.reveal({ ...a, plugin: h.plugin }, e.name, 'rotation', { scope: e.scope });
          },
        }).catch((err: Error) => { this.record({ ...a, plugin: h.plugin }, 'rotate', name, 'error', { scope: e.scope, reason: err.message }); throw err; });
        value = typeof got === 'string' && got ? got : generated;
        if (!value) throw new VaultError(`${h.plugin}'s rotation handler gave no value for "${e.name}"`);
      } else value = generated;
    }
    await this.put({ ...a, ...(e.scope === 'session' ? { session: e.owner } : {}) }, { name: e.name, scope: e.scope, value });
    // A rotation with no schedule clears a reminder that was due (one with a schedule moved it on).
    // (by name: put read the entries again, so `e` may be an older copy)
    const now = await this.locked(async () => {
      const cur = this.entries.find((x) => x.name === e.name && x.scope === e.scope && x.owner === e.owner) ?? e;
      if (!cur.rotateEveryDays && cur.rotateBy && cur.rotateBy < Date.now()) delete cur.rotateBy;
      return cur;
    });
    this.record(a, 'rotate', name, 'ok', { scope: e.scope });
    return this.info(now, this.adminActor(a));
  }

  /** Makes an earlier version current again (as a new version: nothing is lost). */
  async rollback(a: VaultActor, name: string, version: number, scope?: VaultScope): Promise<VaultEntryInfo> {
    await this.sync();
    const e = this.found(a, 'rollback', name, scope);
    this.mayWrite(a, e.scope, e);
    const v = e.history.find((h) => h.version === version);
    if (!v) throw new VaultError(`"${name}" has no earlier version ${version}`, 404);
    const value = await this.readValue(e, v);
    const info = await this.put({ ...a, ...(e.scope === 'session' ? { session: e.owner } : {}) }, { name: e.name, scope: e.scope, value });
    this.record(a, 'rollback', name, 'ok', { scope: e.scope, purpose: `to version ${version}` });
    return info;
  }

  async remove(a: VaultActor, name: string, scope?: VaultScope): Promise<boolean> {
    await this.sync();
    const e = this.found(a, 'delete', name, scope);
    try { this.mayWrite(a, e.scope, e); } catch (err) { this.record(a, 'delete', name, 'denied', { scope: e.scope, reason: (err as Error).message }); throw err; }
    await this.backend(e.backend).remove(e.ref);
    await this.locked(async () => { this.entries = this.entries.filter((x) => !(x.name === e.name && x.scope === e.scope && x.owner === e.owner)); });
    this.record(a, 'delete', name, 'ok', { scope: e.scope });
    return true;
  }

  /**
   * Who may use an operator-scope entry besides administrators: "members" (every
   * account) or account ids; [] or ["admins"]: administrators only. Administrators,
   * through the API. Whoever may use it in a command can in effect read it.
   */
  async setAllow(a: VaultActor, name: string, allow: unknown): Promise<VaultEntryInfo> {
    this.allowed(a);
    try {
      this.mayWrite(a, 'operator');
      const list = normalizeAllow(allow);
      const info = await this.locked(async () => {
        const e = this.entries.find((x) => x.name === name && x.scope === 'operator');
        if (!e) throw new VaultError(`no operator-scope vault entry named "${name}"`, 404);
        e.allow = list;
        e.updatedAt = Date.now();
        return this.info(e, true);
      });
      this.record(a, 'allow', name, 'ok', { scope: 'operator', purpose: list.join(', ') });
      return info;
    } catch (err) {
      this.record(a, 'allow', name, err instanceof VaultError && err.status === 403 ? 'denied' : 'error', { scope: 'operator', reason: (err as Error).message });
      throw err;
    }
  }

  /** Whether a session's owner may use the vault at all. */
  enabledFor(account: string | undefined): boolean { return this.mayUse(account); }

  /**
   * The vault as one session's tools see it. `remember` is told every value handed
   * out, so the session hides it everywhere from then on. A caller with `grants` (a
   * plugin's tool, see the plugin loader) reaches only the names its manifest declared.
   * `host`: where the session's commands run; a companion (the user's own computer) gets
   * no value at all - reveal and envFor are refused, whoever asks.
   */
  service(o: { account?: string; session: string; main: boolean; remember(name: string, values: string[]): void; grantsFor?: (plugin: string) => string[]; host?: string }): VaultService {
    const base: VaultActor = { account: o.account, session: o.session };
    const actor = (by?: VaultCaller): VaultActor => ({ ...base, ...(by?.plugin ? { plugin: by.plugin } : {}), ...(by?.tool ? { tool: by.tool } : {}) });
    const check = (name: string, by?: VaultCaller) => {
      if (o.host === 'companion') {
        this.record(actor(by), 'reveal', name, 'denied', { reason: 'the session runs on a companion' });
        throw new VaultError(`key vault secrets are not used in a companion session (its commands run on the user's own computer): "${name}" was not revealed. Use a sandbox or server-folder session.`, 403);
      }
      if (by?.grants && !by.grants.some((g) => vaultGlob(g)(name))) {
        this.record(actor(by), 'reveal', name, 'denied', { reason: 'not in the plugin manifest permissions.vault' });
        throw new VaultError(`${by.plugin ?? 'this plugin'} may not use the vault entry "${name}": it is not in its harness-plugin.json permissions.vault`, 403);
      }
    };
    const reveal = async (name: string, purpose: string, by?: VaultCaller) => {
      check(name, by);
      const v = await this.reveal(actor(by), name, purpose || 'unspecified');
      o.remember(name, [v]);
      return v;
    };
    const svc: VaultService = {
      list: async () => { await this.sync(); return this.list(base); },
      reveal,
      envFor: async (map, purpose, by) => {
        const env: Record<string, string> = {};
        for (const [k, name] of Object.entries(map ?? {})) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new VaultError(`"${k}" is not a valid environment variable name`);
          if (BLOCKED_ENV.test(k)) throw new VaultError(`${k} changes how commands run (or where the Docker CLI connects); give the secret another variable name`);
          if (typeof name !== 'string' || !name) throw new VaultError(`${k}: name the vault entry it gets`);
          env[k] = await reveal(name, purpose, by);
        }
        return env;
      },
    };
    if (o.main) {
      svc.manage = {
        put: (spec) => this.put(base, spec),
        generate: (spec) => this.generate(base, spec),
        rotate: (name) => this.rotate(base, name, { grantsFor: o.grantsFor }),
        remove: (name) => this.remove(base, name),
        history: async (name) => this.history(base, name),
      };
    }
    return svc;
  }
}
