import crypto from 'node:crypto';
import { seal, unseal } from '../util/sealed.ts';
import { type AwsCredentials, signV4 } from './sigv4.ts';

// Where a vault entry's value lives. The entry's metadata (name, kind, scope,
// owner, versions) is always the harness's own; the value is in one backend:
//   local      sealed with the server key (AES-256-GCM, a random IV per value), in
//              the entry file itself;
//   hashicorp  HashiCorp Vault's KV v2 engine (token or AppRole login);
//   azure      Azure Key Vault (client-credentials OAuth);
//   aws        AWS Secrets Manager (SigV4-signed JSON requests).
// A write returns a handle the harness keeps per version: the sealed text for
// local, the backend's own version id elsewhere, so an older version reads back
// for a rollback. Backend credentials come from the server's environment and are
// never shown to a session.

export interface Backend {
  readonly name: string;
  readonly type: 'local' | 'hashicorp' | 'azure' | 'aws';
  /** Stores a new version under `ref`; returns the handle that reads it back. */
  write(ref: string, value: string): Promise<string>;
  read(ref: string, handle: string): Promise<string>;
  /** Removes every version (external backends; local values go with the entry). */
  remove(ref: string): Promise<void>;
  /** The backend's name for an entry, when it was not given one. */
  refFor(key: { scope: string; owner: string; name: string }): string;
}

export class BackendError extends Error {}

export class LocalBackend implements Backend {
  readonly name = 'local';
  readonly type = 'local' as const;
  private key: () => Promise<Buffer>;
  constructor(key: () => Promise<Buffer>) { this.key = key; }
  async write(_ref: string, value: string): Promise<string> { return seal(await this.key(), value); }
  async read(_ref: string, handle: string): Promise<string> { return unseal(await this.key(), handle); }
  async remove(): Promise<void> {}
  refFor(k: { scope: string; owner: string; name: string }): string { return `${k.scope}/${k.owner}/${k.name}`; }
}

/** "${VAR}" in a backend's configuration, from the server's environment. */
const fill = (v: unknown, env: NodeJS.ProcessEnv): string | undefined => (typeof v === 'string' ? v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, n: string) => env[n] ?? '') || undefined : undefined);

async function call(what: string, url: string, init: RequestInit, timeoutMs = 20_000): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }); } catch (e) { throw new BackendError(`${what}: ${(e as Error).message}`); }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

// ---------- HashiCorp Vault (KV v2) ----------

export interface HashiCorpConfig { type: 'hashicorp'; address?: string; mount?: string; prefix?: string; namespace?: string; token?: string; roleId?: string; secretId?: string; approlePath?: string }

export class HashiCorpBackend implements Backend {
  readonly type = 'hashicorp' as const;
  private token?: { value: string; until: number };
  private address: string;
  private mount: string;
  private prefix: string;
  readonly name: string;
  private cfg: HashiCorpConfig;
  private env: NodeJS.ProcessEnv;
  constructor(name: string, cfg: HashiCorpConfig, env: NodeJS.ProcessEnv = process.env) {
    this.name = name; this.cfg = cfg; this.env = env;
    this.address = (fill(cfg.address, env) ?? env.VAULT_ADDR ?? 'http://127.0.0.1:8200').replace(/\/+$/, '');
    this.mount = (cfg.mount ?? 'secret').replace(/^\/+|\/+$/g, '');
    this.prefix = (cfg.prefix ?? 'harness').replace(/^\/+|\/+$/g, '');
  }
  refFor(k: { scope: string; owner: string; name: string }): string { return [this.prefix, k.scope, k.owner, k.name].filter(Boolean).join('/'); }

  /** A token: the configured one (or VAULT_TOKEN), else an AppRole login, renewed before its lease ends. */
  private async auth(): Promise<string> {
    const fixed = fill(this.cfg.token, this.env) ?? (this.cfg.roleId ? undefined : this.env.VAULT_TOKEN);
    if (fixed) return fixed;
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const roleId = fill(this.cfg.roleId, this.env) ?? this.env.VAULT_ROLE_ID;
    const secretId = fill(this.cfg.secretId, this.env) ?? this.env.VAULT_SECRET_ID;
    if (!roleId || !secretId) throw new BackendError(`vault backend ${this.name}: no token (VAULT_TOKEN) and no AppRole (roleId, secretId)`);
    const r = await call(`vault backend ${this.name} login`, `${this.address}/v1/auth/${this.cfg.approlePath ?? 'approle'}/login`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ role_id: roleId, secret_id: secretId }) });
    const a = r.json.auth as { client_token?: string; lease_duration?: number } | undefined;
    if (r.status !== 200 || !a?.client_token) throw new BackendError(`vault backend ${this.name}: AppRole login failed (HTTP ${r.status})`);
    this.token = { value: a.client_token, until: Date.now() + Math.max(30, (a.lease_duration ?? 3600) - 30) * 1000 };
    return a.client_token;
  }
  private headers(token?: string): Record<string, string> {
    return { 'content-type': 'application/json', ...(token ? { 'x-vault-token': token } : {}), ...(this.cfg.namespace ? { 'x-vault-namespace': this.cfg.namespace } : {}) };
  }
  private path(kind: 'data' | 'metadata', ref: string) { return `${this.address}/v1/${this.mount}/${kind}/${ref.split('/').map(encodeURIComponent).join('/')}`; }

  async write(ref: string, value: string): Promise<string> {
    const r = await call(`vault backend ${this.name}`, this.path('data', ref), { method: 'POST', headers: this.headers(await this.auth()), body: JSON.stringify({ data: { value } }) });
    const v = (r.json.data as { version?: number } | undefined)?.version;
    if (r.status !== 200 || v === undefined) throw new BackendError(`vault backend ${this.name}: write failed (HTTP ${r.status}${errorsOf(r.json)})`);
    return String(v);
  }
  async read(ref: string, handle: string): Promise<string> {
    const r = await call(`vault backend ${this.name}`, `${this.path('data', ref)}?version=${encodeURIComponent(handle)}`, { headers: this.headers(await this.auth()) });
    const value = ((r.json.data as { data?: { value?: unknown } } | undefined)?.data)?.value;
    if (r.status !== 200 || typeof value !== 'string') throw new BackendError(`vault backend ${this.name}: read failed (HTTP ${r.status}${errorsOf(r.json)})`);
    return value;
  }
  async remove(ref: string): Promise<void> {
    const r = await call(`vault backend ${this.name}`, this.path('metadata', ref), { method: 'DELETE', headers: this.headers(await this.auth()) });
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new BackendError(`vault backend ${this.name}: delete failed (HTTP ${r.status})`);
  }
}

const errorsOf = (j: Record<string, unknown>) => (Array.isArray(j.errors) && j.errors.length ? `: ${j.errors.join('; ').slice(0, 200)}` : '');

// ---------- Azure Key Vault ----------

export interface AzureConfig { type: 'azure'; vaultUrl: string; tenantId?: string; clientId?: string; clientSecret?: string; authorityHost?: string; prefix?: string; apiVersion?: string }

export class AzureBackend implements Backend {
  readonly type = 'azure' as const;
  private token?: { value: string; until: number };
  private vaultUrl: string;
  readonly name: string;
  private cfg: AzureConfig;
  private env: NodeJS.ProcessEnv;
  constructor(name: string, cfg: AzureConfig, env: NodeJS.ProcessEnv = process.env) {
    this.name = name; this.cfg = cfg; this.env = env;
    const u = fill(cfg.vaultUrl, env);
    if (!u) throw new BackendError(`vault backend ${name}: vaultUrl is required`);
    this.vaultUrl = u.replace(/\/+$/, '');
  }
  /** Key Vault names allow letters, digits and dashes (at most 127): the rest becomes a dash, with a hash so two names never meet. */
  refFor(k: { scope: string; owner: string; name: string }): string {
    const full = [this.cfg.prefix ?? 'harness', k.scope, k.owner, k.name].join('-');
    const h = crypto.createHash('sha256').update(full).digest('hex').slice(0, 8);
    return `${full.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 110)}-${h}`;
  }
  private get api() { return this.cfg.apiVersion ?? '7.4'; }
  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const tenant = fill(this.cfg.tenantId, this.env) ?? this.env.AZURE_TENANT_ID;
    const clientId = fill(this.cfg.clientId, this.env) ?? this.env.AZURE_CLIENT_ID;
    const secret = fill(this.cfg.clientSecret, this.env) ?? this.env.AZURE_CLIENT_SECRET;
    if (!tenant || !clientId || !secret) throw new BackendError(`vault backend ${this.name}: tenantId, clientId and clientSecret are required (or AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)`);
    const host = (fill(this.cfg.authorityHost, this.env) ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'https://vault.azure.net/.default' });
    const r = await call(`vault backend ${this.name} sign-in`, `${host}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    const t = r.json.access_token;
    if (r.status !== 200 || typeof t !== 'string') throw new BackendError(`vault backend ${this.name}: sign-in failed (HTTP ${r.status}: ${String((r.json as { error?: unknown }).error ?? '').slice(0, 100)})`);
    this.token = { value: t, until: Date.now() + Math.max(60, Number(r.json.expires_in ?? 3600) - 60) * 1000 };
    return t;
  }
  private url(ref: string, version = '') { return `${this.vaultUrl}/secrets/${encodeURIComponent(ref)}${version ? `/${encodeURIComponent(version)}` : ''}?api-version=${this.api}`; }
  async write(ref: string, value: string): Promise<string> {
    const r = await call(`vault backend ${this.name}`, this.url(ref), { method: 'PUT', headers: { authorization: `Bearer ${await this.auth()}`, 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
    const id = typeof r.json.id === 'string' ? r.json.id : '';
    if (r.status !== 200 || !id) throw new BackendError(`vault backend ${this.name}: write failed (HTTP ${r.status})`);
    return id.split('/').pop()!;
  }
  async read(ref: string, handle: string): Promise<string> {
    const r = await call(`vault backend ${this.name}`, this.url(ref, handle), { headers: { authorization: `Bearer ${await this.auth()}` } });
    if (r.status !== 200 || typeof r.json.value !== 'string') throw new BackendError(`vault backend ${this.name}: read failed (HTTP ${r.status})`);
    return r.json.value;
  }
  async remove(ref: string): Promise<void> {
    const r = await call(`vault backend ${this.name}`, this.url(ref), { method: 'DELETE', headers: { authorization: `Bearer ${await this.auth()}` } });
    if (r.status !== 200 && r.status !== 404) throw new BackendError(`vault backend ${this.name}: delete failed (HTTP ${r.status})`);
  }
}

// ---------- AWS Secrets Manager ----------

export interface AwsConfig { type: 'aws'; region?: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; endpoint?: string; prefix?: string; recoveryDays?: number }

export class AwsBackend implements Backend {
  readonly type = 'aws' as const;
  private region: string;
  private endpoint: string;
  readonly name: string;
  private cfg: AwsConfig;
  private env: NodeJS.ProcessEnv;
  constructor(name: string, cfg: AwsConfig, env: NodeJS.ProcessEnv = process.env) {
    this.name = name; this.cfg = cfg; this.env = env;
    this.region = fill(cfg.region, env) ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'us-east-1';
    this.endpoint = (fill(cfg.endpoint, env) ?? `https://secretsmanager.${this.region}.amazonaws.com`).replace(/\/+$/, '');
  }
  refFor(k: { scope: string; owner: string; name: string }): string {
    return [this.cfg.prefix ?? 'harness', k.scope, k.owner, k.name].join('/').replace(/[^A-Za-z0-9/_+=.@-]/g, '-').slice(0, 512);
  }
  private creds(): AwsCredentials {
    const accessKeyId = fill(this.cfg.accessKeyId, this.env) ?? this.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = fill(this.cfg.secretAccessKey, this.env) ?? this.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = fill(this.cfg.sessionToken, this.env) ?? this.env.AWS_SESSION_TOKEN;
    if (!accessKeyId || !secretAccessKey) throw new BackendError(`vault backend ${this.name}: accessKeyId and secretAccessKey are required (or AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)`);
    return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }
  private async op(target: string, payload: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
    const body = JSON.stringify(payload);
    const url = `${this.endpoint}/`;
    const headers = signV4({ method: 'POST', url, body, region: this.region, service: 'secretsmanager', credentials: this.creds(), headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `secretsmanager.${target}` } });
    // fetch sets Host itself (the same value that was signed).
    const { host: _host, ...send } = headers;
    return call(`vault backend ${this.name}`, url, { method: 'POST', headers: send, body });
  }
  async write(ref: string, value: string): Promise<string> {
    const token = crypto.randomUUID();
    let r = await this.op('PutSecretValue', { SecretId: ref, SecretString: value, ClientRequestToken: token });
    if (r.status === 400 && /ResourceNotFound/.test(String(r.json.__type ?? ''))) r = await this.op('CreateSecret', { Name: ref, SecretString: value, ClientRequestToken: token });
    const v = r.json.VersionId;
    if (r.status !== 200 || typeof v !== 'string') throw new BackendError(`vault backend ${this.name}: write failed (HTTP ${r.status} ${String(r.json.__type ?? '')})`);
    return v;
  }
  async read(ref: string, handle: string): Promise<string> {
    const r = await this.op('GetSecretValue', { SecretId: ref, ...(handle ? { VersionId: handle } : {}) });
    if (r.status !== 200 || typeof r.json.SecretString !== 'string') throw new BackendError(`vault backend ${this.name}: read failed (HTTP ${r.status} ${String(r.json.__type ?? '')})`);
    return r.json.SecretString;
  }
  async remove(ref: string): Promise<void> {
    const r = await this.op('DeleteSecret', { SecretId: ref, RecoveryWindowInDays: this.cfg.recoveryDays ?? 7 });
    if (r.status !== 200 && !(r.status === 400 && /ResourceNotFound/.test(String(r.json.__type ?? '')))) throw new BackendError(`vault backend ${this.name}: delete failed (HTTP ${r.status})`);
  }
}

export type BackendConfig = HashiCorpConfig | AzureConfig | AwsConfig;

/**
 * HARNESS_VAULT_BACKENDS: {"<name>": {"type": "hashicorp" | "azure" | "aws", ...}, "default": "<name>"}.
 * String values may name server variables as ${VAR}. "local" is always there.
 */
export function backendsFrom(json: string | Record<string, unknown> | undefined, env: NodeJS.ProcessEnv, key: () => Promise<Buffer>): { backends: Map<string, Backend>; defaultBackend: string } {
  const backends = new Map<string, Backend>([['local', new LocalBackend(key)]]);
  let cfg: Record<string, unknown> = {};
  if (typeof json === 'string' && json.trim()) {
    try { cfg = JSON.parse(json) as Record<string, unknown>; } catch (e) { throw new BackendError(`HARNESS_VAULT_BACKENDS is not JSON: ${(e as Error).message}`); }
  } else if (json && typeof json === 'object') cfg = json;
  for (const [name, c] of Object.entries(cfg)) {
    if (name === 'default') continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name) || name === 'local') throw new BackendError(`vault backend name "${name}" is not allowed`);
    const b = c as BackendConfig;
    if (b?.type === 'hashicorp') backends.set(name, new HashiCorpBackend(name, b, env));
    else if (b?.type === 'azure') backends.set(name, new AzureBackend(name, b, env));
    else if (b?.type === 'aws') backends.set(name, new AwsBackend(name, b, env));
    else throw new BackendError(`vault backend ${name}: type must be hashicorp, azure or aws`);
  }
  const def = typeof cfg.default === 'string' ? cfg.default : 'local';
  if (!backends.has(def)) throw new BackendError(`HARNESS_VAULT_BACKENDS: the default backend "${def}" is not defined`);
  return { backends, defaultBackend: def };
}
