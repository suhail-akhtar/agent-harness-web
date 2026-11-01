import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auth, type FetchLike, type OAuthClientMetadata, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens, UnauthorizedError } from '@modelcontextprotocol/client';
import { nodeEnv, scrubbedEnv } from '../runtime/host.ts';
import { assertPublicUrl, publicFetch } from '../tools/web.ts';
import { readJson, withFileLock, writeFileAtomic } from '../util/shared-file.ts';
import { seal, serverKey, unseal } from '../util/sealed.ts';
import { HttpTransport, McpClient, type McpCallResult, type McpTool, StdioTransport } from './client.ts';
import { spawnPlan, type McpStatus } from './manager.ts';
import { type McpEntry, qualifiedName } from './tools.ts';

// A person's own MCP servers: services they connect in the app (Settings > MCP servers), by URL or, for an
// administrator, a command on the server's computer; imported from Claude Desktop, Claude Code, Cursor or VS Code
// configs. They reach that person's conversations and agents only.
//
//   Secrets       ${vault:name} in a URL, header, argument or environment value: the value stays in the vault
//                 and is read when the server connects. OAuth (sign-in in the browser, PKCE, dynamic or
//                 metadata-document client registration, refresh) through the SDK; tokens sealed on disk.
//   Pinning       each tool's definition (description, schemas, annotations) is hashed when the person first
//                 sees it. A tool that later changes, or a new one, stays out of conversations until approved:
//                 a server cannot change what a tool says it does after the person said yes (a "rug pull").
//                 A change noticed mid-conversation (list_changed, a reconnect) blocks calls to it at once.
//   Policy        per tool: auto (the server's read-only hint decides whether it asks), allow, ask, block.
//   Reach         a member's servers are public https addresses only, every connection's address checked;
//                 commands run on the server's computer, so only administrators may add them.

export type ToolPolicy = 'auto' | 'allow' | 'ask' | 'block';
export const TOOL_POLICIES: readonly ToolPolicy[] = ['auto', 'allow', 'ask', 'block'];

export interface UserServerConfig {
  name: string;
  description?: string;
  type: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  /** An OAuth client registered in advance (most servers register one themselves). The secret is a ${vault:} reference. */
  oauth?: { clientId?: string; clientSecret?: string; scope?: string };
}

export interface UserServer extends UserServerConfig {
  enabled: boolean;
  /** Each tool's policy (absent: auto). */
  policies: Record<string, ToolPolicy>;
  /** The approved definition of each tool, by its hash. */
  pinned: Record<string, string>;
  /** When the tools were first seen and pinned (absent: never connected). */
  pinnedAt?: number;
  source?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

const changedText = (server: string, tool: string) => `The server "${server}" changed the tool "${tool}" after it was approved, so it is not run. The person can review and approve the change in Settings > MCP servers.`;

/** The server answered 401: the person signs in (or their sign-in ended and could not be renewed). */
export class NeedsSignIn extends Error {}
const needsSignIn = (e: unknown) => e instanceof NeedsSignIn || e instanceof UnauthorizedError;

export class McpServerError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_SERVERS = Number(process.env.HARNESS_MAX_USER_MCP ?? 50);
const VAULT_REF = /\$\{vault:([A-Za-z0-9_.@-]{1,128})\}/g;
const HAS_VAULT_REF = /\$\{vault:[A-Za-z0-9_.@-]{1,128}\}/;
const CONNECT_WAIT_MS = Number(process.env.HARNESS_USER_MCP_WAIT_MS ?? 8000);
/**
 * How old a server's tool listing may be before a call lists them again. A server reached over the stateless
 * 2026 protocol cannot tell us its tools changed in the middle of a conversation; each new conversation, and
 * each check from the app, lists them again whatever their age.
 */
const RELIST_MS = Number(process.env.HARNESS_MCP_RELIST_MS ?? 60_000);

/** A tool's definition as a hash: what the person approved. */
export function toolHash(t: McpTool): string {
  const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v);
  const a = t.annotations ?? {};
  const def = { name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {}, outputSchema: t.outputSchema ?? null, hints: { readOnly: a.readOnlyHint ?? null, destructive: a.destructiveHint ?? null, openWorld: a.openWorldHint ?? null, idempotent: a.idempotentHint ?? null } };
  return crypto.createHash('sha256').update(JSON.stringify(stable(def))).digest('hex').slice(0, 32);
}

/** The vault names a config refers to. */
export function vaultRefs(c: UserServerConfig): string[] {
  const out = new Set<string>();
  const scan = (s: string | undefined) => { for (const m of (s ?? '').matchAll(VAULT_REF)) out.add(m[1]!); };
  scan(c.url); scan(c.command); scan(c.cwd); scan(c.oauth?.clientSecret);
  for (const v of Object.values(c.headers ?? {})) scan(v);
  for (const v of Object.values(c.env ?? {})) scan(v);
  for (const v of c.args ?? []) scan(v);
  return [...out];
}

const strMap = (x: unknown, what: string): Record<string, string> | undefined => {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'object' || Array.isArray(x)) throw new McpServerError(`${what} is an object of names to text`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(k)) throw new McpServerError(`${what}: "${k}" is not a valid name`);
    if (typeof v !== 'string' || v.length > 8000) throw new McpServerError(`${what}.${k} is text (at most 8000 characters)`);
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
};

/** A config from the API or an import, checked. Plain secrets in headers are refused: they belong in the vault. */
export function checkServerConfig(x: unknown): UserServerConfig {
  if (!x || typeof x !== 'object') throw new McpServerError('a server is an object');
  const o = x as Record<string, unknown>;
  const name = String(o.name ?? '').trim().toLowerCase();
  if (!SERVER_NAME.test(name)) throw new McpServerError('name: lowercase letters, digits, - and _ (at most 40), starting with a letter or digit');
  const type = o.type === 'stdio' || (o.type === undefined && typeof o.command === 'string') ? 'stdio' : o.type === 'http' || o.type === undefined ? 'http' : undefined;
  if (!type) throw new McpServerError('type is "http" (a URL) or "stdio" (a command)');
  const description = typeof o.description === 'string' ? o.description.trim().slice(0, 500) || undefined : undefined;
  const timeoutMs = o.timeoutMs === undefined ? undefined : Number(o.timeoutMs);
  if (timeoutMs !== undefined && !(timeoutMs >= 1000 && timeoutMs <= 3_600_000)) throw new McpServerError('timeoutMs is between 1000 and 3600000');
  let oauth: UserServerConfig['oauth'];
  if (o.oauth !== undefined && o.oauth !== null) {
    const a = o.oauth as Record<string, unknown>;
    oauth = {
      ...(typeof a.clientId === 'string' && a.clientId ? { clientId: a.clientId.slice(0, 500) } : {}),
      ...(typeof a.clientSecret === 'string' && a.clientSecret ? { clientSecret: a.clientSecret } : {}),
      ...(typeof a.scope === 'string' && a.scope ? { scope: a.scope.slice(0, 1000) } : {}),
    };
    if (oauth.clientSecret && !/^\$\{vault:[^}]+\}$/.test(oauth.clientSecret)) throw new McpServerError('oauth.clientSecret is a ${vault:name} reference: keep the secret in the vault');
    if (!Object.keys(oauth).length) oauth = undefined;
  }
  const base = { name, ...(description ? { description } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(oauth ? { oauth } : {}) };
  if (type === 'http') {
    const url = String(o.url ?? '').trim();
    try { const u = new URL(url.replace(VAULT_REF, 'x')); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(); } catch { throw new McpServerError('url is an http(s) address'); }
    const headers = strMap(o.headers, 'headers');
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (/^(authorization|cookie|.*(token|key|secret|password).*)$/i.test(k) && !HAS_VAULT_REF.test(v) && v.length > 12) throw new McpServerError(`headers.${k} looks like a secret: put it in the vault and write \${vault:name} here`);
    }
    return { ...base, type, url, ...(headers ? { headers } : {}) };
  }
  const command = String(o.command ?? '').trim();
  if (!command || command.length > 1000) throw new McpServerError('command is the program to run');
  if (o.args !== undefined && (!Array.isArray(o.args) || o.args.some((a) => typeof a !== 'string') || o.args.length > 200)) throw new McpServerError('args is a list of text');
  const env = strMap(o.env, 'env');
  const cwd = typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined;
  return { ...base, type, command, ...(o.args && (o.args as string[]).length ? { args: o.args as string[] } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
}

const configOf = (s: UserServer): UserServerConfig => {
  const { enabled: _e, policies: _p, pinned: _pi, pinnedAt: _pa, source: _s, version: _v, createdAt: _c, updatedAt: _u, ...c } = s;
  return c;
};
/** Whether a change of config means a new connection (and new tool definitions to look at). */
const sameConnection = (a: UserServerConfig, b: UserServerConfig) => JSON.stringify({ ...a, description: undefined }) === JSON.stringify({ ...b, description: undefined });

// ---- OAuth -------------------------------------------------------------------------------------------------

interface AuthRecord { tokens?: StoredOAuthTokens; client?: StoredOAuthClientInformation; verifier?: string; redirectUrl?: string; at?: number; /** Which authorization server a sign-in started with: the return must come from the same one. */ discovery?: OAuthDiscoveryState }

/** A pending sign-in: the state the browser brings back, once. */
interface PendingSignIn { owner: string | undefined; server: string; expires: number; provider: StoredAuth; serverUrl: string; fetch?: FetchLike }

class StoredAuth implements OAuthClientProvider {
  authorizeUrl?: URL;
  private stateValue?: string;
  private store: UserMcp;
  private owner: string | undefined;
  private server: string;
  private redirect: string | undefined;
  private cfg: UserServerConfig;
  private onState?: (state: string) => void;
  constructor(store: UserMcp, owner: string | undefined, server: string, redirect: string | undefined, cfg: UserServerConfig, onState?: (state: string) => void) {
    this.store = store; this.owner = owner; this.server = server; this.redirect = redirect; this.cfg = cfg; this.onState = onState;
  }
  get redirectUrl(): string | undefined { return this.redirect; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Agent Harness',
      redirect_uris: this.redirect ? [this.redirect] : [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.cfg.oauth?.clientSecret ? 'client_secret_post' : 'none',
      ...(this.cfg.oauth?.scope ? { scope: this.cfg.oauth.scope } : {}),
    } as OAuthClientMetadata;
  }
  state(): string {
    this.stateValue = crypto.randomBytes(24).toString('base64url');
    this.onState?.(this.stateValue);
    return this.stateValue;
  }
  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    if (this.cfg.oauth?.clientId) {
      const secret = this.cfg.oauth.clientSecret ? await this.store.expand(this.owner, this.cfg.oauth.clientSecret, this.server) : undefined;
      return { client_id: this.cfg.oauth.clientId, ...(secret ? { client_secret: secret } : {}) } as StoredOAuthClientInformation;
    }
    return (await this.store.readAuth(this.owner, this.server)).client;
  }
  async saveClientInformation(c: StoredOAuthClientInformation): Promise<void> {
    // Only a sign-in registers a client (a background connection has no address for the browser to come back to).
    if (!this.redirect) return;
    await this.store.writeAuth(this.owner, this.server, (r) => { r.client = c; });
  }
  async tokens(): Promise<StoredOAuthTokens | undefined> { return (await this.store.readAuth(this.owner, this.server)).tokens; }
  async saveTokens(t: StoredOAuthTokens): Promise<void> { await this.store.writeAuth(this.owner, this.server, (r) => { r.tokens = t; r.at = Date.now(); }); }
  redirectToAuthorization(url: URL): void { this.authorizeUrl = url; }
  async saveDiscoveryState(d: OAuthDiscoveryState): Promise<void> { await this.store.writeAuth(this.owner, this.server, (r) => { r.discovery = d; }); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await this.store.readAuth(this.owner, this.server)).discovery; }
  async saveCodeVerifier(v: string): Promise<void> { await this.store.writeAuth(this.owner, this.server, (r) => { r.verifier = v; if (this.redirect) r.redirectUrl = this.redirect; }); }
  async codeVerifier(): Promise<string> {
    const v = (await this.store.readAuth(this.owner, this.server)).verifier;
    if (!v) throw new Error('no sign-in is in progress for this server');
    return v;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.store.writeAuth(this.owner, this.server, (r) => {
      if (scope === 'all' || scope === 'tokens') delete r.tokens;
      if (scope === 'all' || scope === 'client') delete r.client;
      if (scope === 'all' || scope === 'verifier') delete r.verifier;
      if (scope === 'all' || scope === 'discovery') delete r.discovery;
    });
  }
}

// ---- Live connections --------------------------------------------------------------------------------------

/** One server's connection for one person: its tools as last listed, and those that changed since they were approved. */
interface Live {
  client: McpClient;
  tools: McpTool[];
  /** When the tools were last listed. */
  listedAt: number;
  /** Approved tools whose definition changed while connected: refused until approved again. */
  changed: Set<string>;
  /** The re-check after the server said its tools changed, while it runs (a call waits for it). */
  checking?: Promise<void>;
  hasResources: boolean;
  hasPrompts: boolean;
  protocol?: string;
  serverInfo?: { name?: string; version?: string };
}

export interface ToolView { name: string; title?: string; description?: string; readOnly: boolean; policy: ToolPolicy; state: 'approved' | 'new' | 'changed' }

export interface ServerView {
  name: string; description?: string; type: 'http' | 'stdio'; url?: string; command?: string; args?: string[];
  headers?: Record<string, string>; env?: Record<string, string>; cwd?: string; timeoutMs?: number; oauth?: UserServerConfig['oauth'];
  enabled: boolean; version: number; updatedAt: number; source?: string;
  policies: Record<string, ToolPolicy>; vault: string[];
  signedIn: boolean;
  status?: { ok: boolean; error?: string; needsSignIn?: boolean; tools: number; pending: number; protocol?: string; server?: string; checkedAt: number };
}

export interface TestResult {
  ok: boolean; error?: string; needsSignIn?: boolean;
  protocol?: string; serverInfo?: { name?: string; version?: string }; instructions?: string;
  tools: ToolView[];
  resources: { uri: string; name?: string; description?: string }[];
  prompts: { name: string; description?: string }[];
}

interface OwnerFile { servers: Record<string, UserServer> }

export interface UserMcpOptions {
  dataDir: string;
  vault?: { reveal(a: { account?: string }, name: string, purpose: string): Promise<string> };
  /** Whether an account is an administrator (default: only the single-user server's, no account). */
  isAdmin?: (owner: string | undefined) => boolean;
  /** Told when a person's servers changed (an event for their windows). */
  onChange?: (owner: string | undefined) => void;
  /** Server names taken by the operator's own servers. */
  reserved?: () => Iterable<string>;
}

export class UserMcp {
  readonly dir: string;
  private live = new Map<string, Promise<Live>>();
  private status = new Map<string, NonNullable<ServerView['status']>>();
  private pending = new Map<string, PendingSignIn>();
  private key?: Promise<Buffer>;
  isAdmin: (owner: string | undefined) => boolean;

  private opts: UserMcpOptions;

  constructor(opts: UserMcpOptions) {
    this.opts = opts;
    this.dir = path.join(opts.dataDir, 'mcp');
    this.isAdmin = opts.isAdmin ?? ((o) => o === undefined);
  }

  // ---- files ----

  private id(owner: string | undefined): string { return (owner ?? '_local').replace(/[^\w.-]/g, '_').slice(0, 80) || '_local'; }
  private file(owner: string | undefined): string { return path.join(this.dir, `${this.id(owner)}.json`); }
  private authFile(owner: string | undefined): string { return path.join(this.dir, `${this.id(owner)}.auth.json`); }
  private async read(owner: string | undefined): Promise<OwnerFile> {
    const f = await readJson<OwnerFile>(this.file(owner), { servers: {} });
    return { servers: f.servers ?? {} };
  }
  private async change<T>(owner: string | undefined, fn: (f: OwnerFile) => T): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.file(owner);
    const r = await withFileLock(file, async () => {
      const f = await this.read(owner);
      const out = fn(f);
      await writeFileAtomic(file, JSON.stringify(f, null, 1), { mode: 0o600 });
      return out;
    });
    this.opts.onChange?.(owner);
    return r;
  }

  async readAuth(owner: string | undefined, server: string): Promise<AuthRecord> {
    const all = await readJson<Record<string, string>>(this.authFile(owner), {});
    const sealed = all[server];
    if (!sealed) return {};
    try { return JSON.parse(unseal(await this.sealKey(), sealed)) as AuthRecord; } catch { return {}; }
  }
  async writeAuth(owner: string | undefined, server: string, fn: (r: AuthRecord) => void): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.authFile(owner);
    const key = await this.sealKey();
    await withFileLock(file, async () => {
      const all = await readJson<Record<string, string>>(file, {});
      let r: AuthRecord = {};
      try { if (all[server]) r = JSON.parse(unseal(key, all[server]!)) as AuthRecord; } catch { /* unreadable: start again */ }
      fn(r);
      if (Object.keys(r).length) all[server] = seal(key, JSON.stringify(r)); else delete all[server];
      await writeFileAtomic(file, JSON.stringify(all, null, 1), { mode: 0o600 });
    });
  }
  private sealKey(): Promise<Buffer> { return (this.key ??= serverKey(this.opts.dataDir)); }

  // ---- the person's list ----

  async list(owner: string | undefined): Promise<ServerView[]> {
    const f = await this.read(owner);
    const out: ServerView[] = [];
    for (const s of Object.values(f.servers).sort((a, b) => a.name.localeCompare(b.name))) out.push(await this.view(owner, s));
    return out;
  }
  async get(owner: string | undefined, name: string): Promise<UserServer | undefined> { return (await this.read(owner)).servers[name]; }
  async viewOf(owner: string | undefined, name: string): Promise<ServerView> {
    const s = await this.get(owner, name);
    if (!s) throw new McpServerError(`no MCP server "${name}"`, 404);
    return this.view(owner, s);
  }
  private async view(owner: string | undefined, s: UserServer): Promise<ServerView> {
    const auth = s.type === 'http' ? await this.readAuth(owner, s.name) : {};
    const st = this.status.get(this.key2(owner, s.name));
    return {
      ...configOf(s), enabled: s.enabled, version: s.version, updatedAt: s.updatedAt, ...(s.source ? { source: s.source } : {}),
      policies: s.policies, vault: vaultRefs(s), signedIn: !!auth.tokens, ...(st ? { status: st } : {}),
    };
  }

  private mayHave(owner: string | undefined, c: UserServerConfig): void {
    if (c.type === 'stdio' && !this.isAdmin(owner)) throw new McpServerError('A command runs on the server\'s computer: only administrators can add one. Connect a server by its URL instead.', 403);
    if (c.type === 'http' && !this.isAdmin(owner) && !c.url!.startsWith('https://')) throw new McpServerError('A server\'s address is https:// (what it is sent, including your sign-in, must be encrypted).');
    for (const r of this.opts.reserved?.() ?? []) if (r.toLowerCase() === c.name) throw new McpServerError(`"${c.name}" is the name of a server this harness already has: choose another`, 409);
  }

  async create(owner: string | undefined, x: unknown, o: { source?: string; enabled?: boolean } = {}): Promise<ServerView> {
    const c = checkServerConfig(x);
    this.mayHave(owner, c);
    const now = Date.now();
    const s = await this.change(owner, (f) => {
      if (f.servers[c.name]) throw new McpServerError(`you already have a server named "${c.name}"`, 409);
      if (Object.keys(f.servers).length >= MAX_SERVERS) throw new McpServerError(`at most ${MAX_SERVERS} servers`);
      const s: UserServer = { ...c, enabled: o.enabled ?? true, policies: {}, pinned: {}, ...(o.source ? { source: o.source } : {}), version: 1, createdAt: now, updatedAt: now };
      f.servers[c.name] = s;
      return s;
    });
    return this.view(owner, s);
  }

  /** A new config (or only `enabled`); refused when it changed since `expectVersion`. A new address or command forgets the connection. */
  async update(owner: string | undefined, name: string, x: Record<string, unknown>, expectVersion?: number): Promise<ServerView> {
    let reconnect = false;
    const s = await this.change(owner, (f) => {
      const cur = f.servers[name];
      if (!cur) throw new McpServerError(`no MCP server "${name}"`, 404);
      if (expectVersion !== undefined && cur.version !== expectVersion) throw new McpServerError(`"${name}" changed since you opened it (version ${cur.version}, yours ${expectVersion}): reload it`, 409);
      const onlyToggle = Object.keys(x).every((k) => k === 'enabled' || k === 'expectVersion');
      let next: UserServer = { ...cur };
      if (!onlyToggle) {
        const c = checkServerConfig({ ...configOf(cur), ...x, name });
        this.mayHave(owner, c);
        reconnect = !sameConnection(configOf(cur), c);
        next = { ...c, enabled: cur.enabled, policies: cur.policies, pinned: cur.pinned, ...(cur.pinnedAt ? { pinnedAt: cur.pinnedAt } : {}), ...(cur.source ? { source: cur.source } : {}), version: cur.version, createdAt: cur.createdAt, updatedAt: cur.updatedAt };
      }
      if (typeof x.enabled === 'boolean') next.enabled = x.enabled;
      next.version = cur.version + 1;
      next.updatedAt = Date.now();
      f.servers[name] = next;
      return next;
    });
    if (reconnect || !s.enabled) await this.forget(owner, name);
    return this.view(owner, s);
  }

  async remove(owner: string | undefined, name: string): Promise<void> {
    await this.change(owner, (f) => {
      if (!f.servers[name]) throw new McpServerError(`no MCP server "${name}"`, 404);
      delete f.servers[name];
    });
    await this.forget(owner, name);
    await this.writeAuth(owner, name, (r) => { for (const k of Object.keys(r)) delete (r as Record<string, unknown>)[k]; });
  }

  async setPolicies(owner: string | undefined, name: string, policies: Record<string, unknown>): Promise<ServerView> {
    for (const [t, p] of Object.entries(policies)) if (!TOOL_POLICIES.includes(p as ToolPolicy)) throw new McpServerError(`${t}: a policy is auto, allow, ask or block`);
    const s = await this.change(owner, (f) => {
      const cur = f.servers[name];
      if (!cur) throw new McpServerError(`no MCP server "${name}"`, 404);
      const next = { ...cur.policies };
      for (const [t, p] of Object.entries(policies)) { if (p === 'auto') delete next[t]; else next[t] = p as ToolPolicy; }
      cur.policies = next;
      cur.version++;
      cur.updatedAt = Date.now();
      return cur;
    });
    return this.view(owner, s);
  }

  /** Approves the tools as the server describes them now (all that are new or changed, or the ones named). */
  async approve(owner: string | undefined, name: string, tools?: string[]): Promise<TestResult> {
    const s = await this.get(owner, name);
    if (!s) throw new McpServerError(`no MCP server "${name}"`, 404);
    const live = await this.connection(owner, s);
    // What the server says now, not what it said when the connection was made.
    live.tools = await live.client.listTools();
    const want = tools ? new Set(tools) : undefined;
    await this.change(owner, (f) => {
      const cur = f.servers[name];
      if (!cur) throw new McpServerError(`no MCP server "${name}"`, 404);
      for (const t of live.tools) if (!want || want.has(t.name)) { cur.pinned[t.name] = toolHash(t); live.changed.delete(t.name); }
      cur.pinnedAt ??= Date.now();
      cur.version++;
      cur.updatedAt = Date.now();
    });
    return this.test(owner, name);
  }

  // ---- connecting ----

  private key2(owner: string | undefined, name: string): string { return `${owner ?? ''}\u0000${name}`; }

  /** ${vault:name} replaced by the person's vault value (their own, or one shared with them). */
  async expand(owner: string | undefined, v: string, server: string): Promise<string> {
    const names = [...v.matchAll(VAULT_REF)].map((m) => m[1]!);
    if (!names.length) return v;
    if (!this.opts.vault) throw new McpServerError(`MCP server "${server}" uses \${vault:${names[0]}}, and this server has no vault`);
    let out = v;
    for (const n of new Set(names)) {
      let value: string;
      try { value = await this.opts.vault.reveal({ account: owner }, n, `connect MCP server "${server}"`); } catch (e) { throw new McpServerError(`MCP server "${server}" needs the vault entry "${n}": ${(e as Error).message}`); }
      out = out.split(`\${vault:${n}}`).join(value);
    }
    return out;
  }

  /** Every request to a member's server, and to the places its sign-in sends us, goes to a public address. */
  private fetchFor(owner: string | undefined): FetchLike | undefined {
    if (this.isAdmin(owner)) return undefined;
    return (async (url: string | URL, init?: RequestInit) => {
      await assertPublicUrl(String(url));
      return publicFetch(url, init);
    }) as FetchLike;
  }

  private async open(owner: string | undefined, s: UserServer, provider?: StoredAuth): Promise<McpClient> {
    const x = (v: string) => this.expand(owner, v, s.name);
    const opts = { callTimeoutMs: s.timeoutMs };
    if (s.type === 'http') {
      const url = await x(s.url!);
      if (!this.isAdmin(owner)) await assertPublicUrl(url);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers ?? {})) headers[k] = await x(v);
      // Whether the server itself turned us away (401), whatever the SDK's sign-in then tried.
      let refused = false;
      const endpoint = url.split('?')[0]!;
      const base = this.fetchFor(owner) ?? ((u: string | URL, i?: RequestInit) => fetch(u, i));
      const watched = (async (u: string | URL, i?: RequestInit) => { const r = await base(u, i); if (r.status === 401 && String(u).startsWith(endpoint)) refused = true; return r; }) as FetchLike;
      // Sign-in only where the person did not give their own authorization header.
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
      const auth = hasAuth ? undefined : provider ?? new StoredAuth(this, owner, s.name, (await this.readAuth(owner, s.name)).redirectUrl, s);
      const client = new McpClient(new HttpTransport(url, headers, { fetch: watched, ...(auth ? { authProvider: auth } : {}) }), opts);
      try { await client.initialize(); } catch (e) {
        await client.close().catch(() => {});
        if (refused && !hasAuth) throw new NeedsSignIn('This server needs you to sign in.');
        if (refused) throw new Error('The server refused the authorization header (HTTP 401): check the vault value it uses.');
        throw e;
      }
      return client;
    }
    if (!this.isAdmin(owner)) throw new McpServerError('only administrators can run a command server', 403);
    const args: string[] = [];
    for (const a of s.args ?? []) args.push(await x(a));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = await x(v);
    const command = await x(s.command!);
    const plan = spawnPlan(command, args);
    const child = spawn(plan.command, plan.args, { cwd: s.cwd ? await x(s.cwd) : undefined, env: scrubbedEnv(plan.command === process.execPath ? { ...nodeEnv(), ...env } : env), stdio: ['pipe', 'pipe', 'pipe'], shell: plan.shell });
    const client = new McpClient(new StdioTransport(child), opts);
    await client.initialize();
    return client;
  }

  /** The person's connection to a server (made once, shared by their conversations; made again when it ended). */
  private async connection(owner: string | undefined, s: UserServer): Promise<Live> {
    const k = this.key2(owner, s.name);
    const existing = this.live.get(k);
    if (existing) {
      const l = await existing.catch(() => undefined);
      if (l && !l.client.closed) return l;
      if (this.live.get(k) === existing) this.live.delete(k);
    }
    let p = this.live.get(k);
    if (!p) {
      p = this.connectLive(owner, s);
      this.live.set(k, p);
      p.catch(() => { if (this.live.get(k) === p) this.live.delete(k); });
    }
    return p;
  }

  private async connectLive(owner: string | undefined, s: UserServer): Promise<Live> {
    const client = await this.open(owner, s);
    try {
      const tools = await client.listTools();
      const live: Live = { client, tools, listedAt: Date.now(), changed: new Set(), hasResources: client.canListResources, hasPrompts: client.canListPrompts, protocol: client.protocol, serverInfo: client.serverInfo };
      // First connection: what the person sees now is what they approve (trust on first use).
      if (!s.pinnedAt) {
        await this.change(owner, (f) => {
          const cur = f.servers[s.name];
          if (!cur || cur.pinnedAt) return;
          for (const t of tools) cur.pinned[t.name] = toolHash(t);
          cur.pinnedAt = Date.now();
        });
      }
      // The server says its tools changed: what changed since it was approved is refused from now on.
      client.onToolsChanged(() => { void this.relist(owner, s.name, live, 0); });
      return live;
    } catch (e) { await client.close(); throw e; }
  }

  /** Lists the tools again when the listing is older than `maxAgeMs` (one listing at a time; a call waits for it). */
  private relist(owner: string | undefined, name: string, live: Live, maxAgeMs: number): Promise<void> {
    if (live.checking) return live.checking;
    if (Date.now() - live.listedAt < maxAgeMs || live.client.closed) return Promise.resolve();
    const p = this.recheck(owner, name, live).finally(() => { if (live.checking === p) live.checking = undefined; });
    live.checking = p;
    return p;
  }

  private async recheck(owner: string | undefined, name: string, live: Live): Promise<void> {
    try {
      const tools = await live.client.listTools();
      live.listedAt = Date.now();
      const s = await this.get(owner, name);
      if (!s) return;
      const sig = (ts: McpTool[]) => ts.map((t) => `${t.name}:${toolHash(t)}`).sort().join();
      const same = sig(tools) === sig(live.tools);
      for (const t of tools) if (s.pinned[t.name] && s.pinned[t.name] !== toolHash(t)) live.changed.add(t.name);
      live.tools = tools;
      if (same) return;
      // What the person's list says: how many wait for them now.
      const views = this.views(s, live);
      const st = this.status.get(this.key2(owner, name));
      if (st?.ok) { st.pending = views.filter((v) => v.state !== 'approved').length; st.tools = views.filter((v) => v.state === 'approved' && v.policy !== 'block').length; st.checkedAt = Date.now(); }
      this.opts.onChange?.(owner);
    } catch { /* the next call or conversation finds out */ }
  }

  /** Each tool as the person sees it: approved, new (not yet approved) or changed since it was. */
  private views(s: UserServer, live: Live): ToolView[] {
    return live.tools.map((t) => {
      const pinned = s.pinned[t.name];
      const state: ToolView['state'] = !pinned ? 'new' : pinned !== toolHash(t) || live.changed.has(t.name) ? 'changed' : 'approved';
      return { name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description.slice(0, 2000) } : {}), readOnly: t.annotations?.readOnlyHint === true, policy: s.policies[t.name] ?? 'auto', state };
    });
  }

  private record(owner: string | undefined, name: string, st: NonNullable<ServerView['status']>): void {
    this.status.set(this.key2(owner, name), st);
  }

  /** Connects now and says what the server offers (and which of its tools wait for approval). */
  async test(owner: string | undefined, name: string): Promise<TestResult> {
    const s = await this.get(owner, name);
    if (!s) throw new McpServerError(`no MCP server "${name}"`, 404);
    try {
      const live = await this.connection(owner, s);
      await this.relist(owner, name, live, 0);
      const fresh = (await this.get(owner, name)) ?? s;
      const tools = this.views(fresh, live);
      const [resources, prompts] = await Promise.all([
        live.hasResources ? live.client.listResources().catch(() => []) : [],
        live.hasPrompts ? live.client.listPrompts().catch(() => []) : [],
      ]);
      this.record(owner, name, { ok: true, tools: tools.filter((t) => t.state === 'approved' && t.policy !== 'block').length, pending: tools.filter((t) => t.state !== 'approved').length, ...(live.protocol ? { protocol: live.protocol } : {}), ...(live.serverInfo?.name ? { server: `${live.serverInfo.name}${live.serverInfo.version ? ` ${live.serverInfo.version}` : ''}` } : {}), checkedAt: Date.now() });
      return {
        ok: true, protocol: live.protocol, serverInfo: live.serverInfo, ...(live.client.instructions ? { instructions: live.client.instructions.slice(0, 4000) } : {}), tools,
        resources: resources.slice(0, 200).map((r) => ({ uri: r.uri, ...(r.name ? { name: r.name } : {}), ...(r.description ? { description: r.description.slice(0, 500) } : {}) })),
        prompts: prompts.slice(0, 200).map((p) => ({ name: p.name, ...(p.description ? { description: p.description.slice(0, 500) } : {}) })),
      };
    } catch (e) {
      const signIn = needsSignIn(e);
      const error = signIn ? 'This server needs you to sign in.' : (e as Error).message;
      this.record(owner, name, { ok: false, error, ...(signIn ? { needsSignIn: true } : {}), tools: 0, pending: 0, checkedAt: Date.now() });
      return { ok: false, error, ...(signIn ? { needsSignIn: true } : {}), tools: [], resources: [], prompts: [] };
    }
  }

  /** Drops a connection (its config changed, it was turned off or removed, the person signed in or out). */
  async forget(owner: string | undefined, name: string): Promise<void> {
    const k = this.key2(owner, name);
    const p = this.live.get(k);
    this.live.delete(k);
    this.status.delete(k);
    try { await (await p)?.client.close(); } catch { /* never connected */ }
  }

  async closeAll(): Promise<void> {
    const all = [...this.live.values()];
    this.live.clear();
    for (const p of all) { try { await (await p).client.close(); } catch { /* never connected */ } }
  }

  // ---- sign-in ----

  /** Starts signing in: the address to open in the browser, or nothing to do when the server already lets us in. */
  async signIn(owner: string | undefined, name: string, redirectUrl: string): Promise<{ authorizeUrl?: string; ok?: boolean }> {
    const s = await this.get(owner, name);
    if (!s) throw new McpServerError(`no MCP server "${name}"`, 404);
    if (s.type !== 'http') throw new McpServerError('only a server reached by URL signs in');
    for (const [st, p] of this.pending) if (p.expires < Date.now() || (p.owner === owner && p.server === name)) this.pending.delete(st);
    const url = await this.expand(owner, s.url!, name);
    const fetch = this.fetchFor(owner);
    let state: string | undefined;
    const provider = new StoredAuth(this, owner, name, redirectUrl, s, (v) => { state = v; });
    await this.forget(owner, name);
    // A fresh start; a client registered for another address of this harness registers again.
    await this.writeAuth(owner, name, (r) => {
      delete r.tokens; delete r.verifier;
      const uris = (r.client as { redirect_uris?: string[] } | undefined)?.redirect_uris;
      if (r.client && !uris?.includes(redirectUrl)) delete r.client;
    });
    let result: Awaited<ReturnType<typeof auth>>;
    try { result = await auth(provider, { serverUrl: url, ...(fetch ? { fetchFn: fetch } : {}) }); } catch (e) {
      throw new McpServerError(`Signing in to "${name}" did not start: ${(e as Error).message}. If the service gives you a key instead, put it in the Vault and add an Authorization header.`, 502);
    }
    if (result === 'AUTHORIZED') return { ok: true };
    if (!provider.authorizeUrl || !state) throw new McpServerError('the server\'s sign-in did not give an address to open');
    // At most a few hundred sign-ins wait at once (the oldest go first).
    while (this.pending.size >= 500) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(state, { owner, server: name, expires: Date.now() + 10 * 60_000, provider, serverUrl: url, ...(fetch ? { fetch } : {}) });
    return { authorizeUrl: provider.authorizeUrl.href };
  }

  /** The browser came back with a code: tokens for the server it was started for (a state is used once). */
  async finishSignIn(state: string, code: string, iss?: string): Promise<{ owner: string | undefined; server: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < Date.now()) throw new McpServerError('This sign-in has expired or was already used. Start it again from the app.', 400);
    await auth(p.provider, { serverUrl: p.serverUrl, authorizationCode: code, ...(iss ? { iss } : {}), ...(p.fetch ? { fetchFn: p.fetch } : {}) });
    await this.writeAuth(p.owner, p.server, (r) => { delete r.verifier; delete r.discovery; });
    await this.forget(p.owner, p.server);
    this.opts.onChange?.(p.owner);
    return { owner: p.owner, server: p.server };
  }

  async signOut(owner: string | undefined, name: string): Promise<void> {
    await this.writeAuth(owner, name, (r) => { delete r.tokens; delete r.verifier; });
    await this.forget(owner, name);
    this.opts.onChange?.(owner);
  }

  // ---- in conversations ----

  /**
   * The person's enabled servers' approved tools, for a conversation (and its agents). A server that does not
   * answer within a few seconds is left out of this conversation (it keeps connecting for the next one).
   */
  async entries(owner: string | undefined): Promise<{ entries: McpEntry[]; status: McpStatus[] }> {
    const f = await this.read(owner);
    const servers = Object.values(f.servers).filter((s) => s.enabled);
    const results = await Promise.all(servers.map(async (s) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const live = await Promise.race([
          this.connection(owner, s),
          new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new Error(`did not answer within ${CONNECT_WAIT_MS / 1000}s (still connecting: it will be in the next conversation)`)), CONNECT_WAIT_MS); }),
        ]);
        await this.relist(owner, s.name, live, 2000);
        const fresh = (await this.get(owner, s.name)) ?? s;
        const views = this.views(fresh, live);
        const entries = this.entriesFor(owner, fresh, live, views);
        const pending = views.filter((v) => v.state !== 'approved').length;
        this.record(owner, s.name, { ok: true, tools: entries.length, pending, ...(live.protocol ? { protocol: live.protocol } : {}), checkedAt: Date.now() });
        return { entries, status: { name: s.name, scope: 'user' as const, ok: true, tools: entries.length, ...(pending ? { pending } : {}) } };
      } catch (e) {
        const signIn = needsSignIn(e);
        const error = signIn ? 'needs you to sign in (Settings > MCP servers)' : (e as Error).message;
        this.record(owner, s.name, { ok: false, error, ...(signIn ? { needsSignIn: true } : {}), tools: 0, pending: 0, checkedAt: Date.now() });
        return { entries: [] as McpEntry[], status: { name: s.name, scope: 'user' as const, ok: false, tools: 0, error } };
      } finally { clearTimeout(timer); }
    }));
    return { entries: results.flatMap((r) => r.entries), status: results.map((r) => r.status) };
  }

  private entriesFor(owner: string | undefined, s: UserServer, live: Live, views: ToolView[]): McpEntry[] {
    const call = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> => {
      // Checked on every call: a definition can change while the conversation runs.
      await this.relist(owner, s.name, live, RELIST_MS);
      if (live.changed.has(tool)) return { isError: true, content: [{ type: 'text', text: changedText(s.name, tool) }] };
      let cur = live;
      if (live.client.closed) {
        // Reconnected: what the server says now must still be what was approved (as the person's file says now).
        const now = await this.get(owner, s.name);
        if (!now?.enabled) return { isError: true, content: [{ type: 'text', text: `The server "${s.name}" was turned off or removed.` }] };
        cur = await this.connection(owner, now);
        const t = cur.tools.find((x) => x.name === tool);
        if (!t || toolHash(t) !== now.pinned[tool] || now.policies[tool] === 'block') { live.changed.add(tool); return { isError: true, content: [{ type: 'text', text: `The server "${s.name}" reconnected and its tool "${tool}" is not the one approved: it is not run.` }] }; }
      }
      try { return await cur.client.callTool(tool, args, signal); } finally {
        // A call that may change things may change the server's tools too: the next call lists them first.
        if (cur.tools.find((x) => x.name === tool)?.annotations?.readOnlyHint !== true) cur.listedAt = 0;
      }
    };
    const out: McpEntry[] = [];
    const names = new Set(live.tools.map((t) => t.name));
    for (const v of views) {
      if (v.state !== 'approved' || v.policy === 'block') continue;
      const tool = live.tools.find((t) => t.name === v.name)!;
      out.push({
        server: s.name, tool, qualified: qualifiedName(s.name, tool.name), client: { callTool: (n, a, sig) => call(n, a, sig) },
        refused: async () => {
          // The person's choices as they are now (off, removed or blocked mid-conversation counts at once).
          const now = await this.get(owner, s.name);
          if (!now?.enabled) return `The person turned the server "${s.name}" off or removed it, so its tools are not run.`;
          if (now.policies[tool.name] === 'block') return `The person blocked the tool "${tool.name}" of "${s.name}".`;
          await this.relist(owner, s.name, live, RELIST_MS);
          return live.changed.has(tool.name) ? changedText(s.name, tool.name) : undefined;
        },
        ...(v.policy === 'allow' ? { kind: 'read' as const } : v.policy === 'ask' ? { kind: 'external' as const } : {}),
      });
    }
    // Resources and prompts, as one read-only tool each (they never change what the server does).
    if (live.hasResources && !names.has('resources')) {
      out.push({
        server: s.name, qualified: qualifiedName(s.name, 'resources'), kind: 'read',
        tool: { name: 'resources', description: `Read what the "${s.name}" server offers as resources (documents, records, files). Without a uri: the list. With a uri: that resource's content.`, inputSchema: { type: 'object', properties: { uri: { type: 'string', description: 'A resource\'s uri from the list.' } } }, annotations: { readOnlyHint: true } },
        client: { callTool: async (_n, a, signal) => {
          const c = live.client.closed ? (await this.connection(owner, s)).client : live.client;
          if (typeof a.uri !== 'string' || !a.uri) {
            const list = await c.listResources();
            return { content: [{ type: 'text', text: list.length ? list.slice(0, 200).map((r) => `${r.uri}${r.title ?? r.name ? ` - ${r.title ?? r.name}` : ''}${r.description ? `: ${r.description.slice(0, 200)}` : ''}`).join('\n') : '(no resources)' }] };
          }
          const r = await c.readResource(a.uri, signal);
          return { content: r.contents.map((x) => (x.text !== undefined ? { type: 'text', text: x.text } : { type: 'text', text: `[${x.mimeType ?? 'binary'} content, ${Math.round((x.blob?.length ?? 0) * 0.75)} bytes, at ${x.uri}]` })) };
        } },
      });
    }
    if (live.hasPrompts && !names.has('prompts')) {
      out.push({
        server: s.name, qualified: qualifiedName(s.name, 'prompts'), kind: 'read',
        tool: { name: 'prompts', description: `The "${s.name}" server's prompt templates (ready-made instructions for its tasks). Without a name: the list with their arguments. With a name and arguments: the filled-in prompt to follow.`, inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', description: 'Its arguments, as text values.' } } }, annotations: { readOnlyHint: true } },
        client: { callTool: async (_n, a, signal) => {
          const c = live.client.closed ? (await this.connection(owner, s)).client : live.client;
          if (typeof a.name !== 'string' || !a.name) {
            const list = await c.listPrompts();
            return { content: [{ type: 'text', text: list.length ? list.slice(0, 200).map((p) => `${p.name}${p.description ? `: ${p.description.slice(0, 200)}` : ''}${p.arguments?.length ? ` (arguments: ${p.arguments.map((x) => `${x.name}${x.required ? '' : '?'}`).join(', ')})` : ''}`).join('\n') : '(no prompts)' }] };
          }
          const args = Object.fromEntries(Object.entries((a.arguments ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
          const p = await c.getPrompt(a.name, args, signal);
          return { content: [{ type: 'text', text: p.messages.map((m) => `[${m.role}] ${m.content.text ?? (m.content.resource?.text ?? `(${m.content.type})`)}`).join('\n\n') }] };
        } },
      });
    }
    return out;
  }
}
