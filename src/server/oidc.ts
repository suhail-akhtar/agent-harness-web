import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Single sign-on with OpenID Connect: the authorization code flow with PKCE
// (S256), state and nonce; id_tokens verified against the provider's JWKS;
// browser sessions kept on the server (only an opaque id goes in the cookie).
// No dependency: Node's crypto verifies the signatures.

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  /** Where people reach the server, without a trailing slash; the redirect URI hangs off it. */
  publicUrl: string;
  scopes: string;
  allowedDomains: string[];
  allowedEmails: string[];
  admins: string[];
  /** People sign in only through the provider; personal tokens stop working. */
  only: boolean;
  /**
   * Accept an e-mail without email_verified=true (HARNESS_OIDC_TRUST_EMAIL=1), for a
   * provider that never sends the claim and never lets people set an address it has
   * not verified. Otherwise a missing claim is refused: the address decides the
   * allowlist and who is an administrator.
   */
  trustEmail?: boolean;
}

export interface Identity { iss: string; sub: string; email: string; name?: string; /** The raw id_token, kept as the id_token_hint for signing out at the provider. */ idToken?: string }

/** A refusal with the HTTP status to answer it with. */
export class OidcError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 10_000;
const CACHE_MS = 60 * 60_000;
const SKEW_SEC = 60;

const lower = (v: string | undefined) => (v ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const sameText = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

/** Reads the HARNESS_OIDC_* settings; undefined when single sign-on is not configured. Throws on a half-done configuration. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
  const issuer = env.HARNESS_OIDC_ISSUER?.trim();
  if (!issuer) {
    if (env.HARNESS_OIDC_ONLY === '1') throw new Error('HARNESS_OIDC_ONLY=1 needs single sign-on: set HARNESS_OIDC_ISSUER, HARNESS_OIDC_CLIENT_ID and HARNESS_PUBLIC_URL');
    return undefined;
  }
  const missing = ['HARNESS_OIDC_CLIENT_ID', 'HARNESS_PUBLIC_URL'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`single sign-on needs ${missing.join(' and ')} (HARNESS_OIDC_ISSUER is set)`);
  let iss: URL, pub: URL;
  try { iss = new URL(issuer); } catch { throw new Error(`HARNESS_OIDC_ISSUER is not a URL: ${issuer}`); }
  // The issuer's documents decide who gets in: never fetch them in clear text across a network.
  if (iss.protocol !== 'https:' && !(iss.protocol === 'http:' && isLoopback(iss.hostname))) throw new Error('HARNESS_OIDC_ISSUER must be an https URL');
  try { pub = new URL(env.HARNESS_PUBLIC_URL!.trim()); } catch { throw new Error(`HARNESS_PUBLIC_URL is not a URL: ${env.HARNESS_PUBLIC_URL}`); }
  if (pub.protocol !== 'https:' && pub.protocol !== 'http:') throw new Error('HARNESS_PUBLIC_URL must be an http(s) URL');
  return {
    // The issuer is compared exactly (a trailing slash matters), so it is kept as given.
    issuer,
    clientId: env.HARNESS_OIDC_CLIENT_ID!.trim(),
    clientSecret: env.HARNESS_OIDC_CLIENT_SECRET?.trim() || undefined,
    publicUrl: `${pub.origin}${pub.pathname.replace(/\/+$/, '')}`,
    scopes: env.HARNESS_OIDC_SCOPES?.trim() || 'openid email profile',
    allowedDomains: lower(env.HARNESS_OIDC_ALLOWED_DOMAINS),
    allowedEmails: lower(env.HARNESS_OIDC_ALLOWED_EMAILS),
    admins: lower(env.HARNESS_OIDC_ADMINS),
    only: env.HARNESS_OIDC_ONLY === '1',
    trustEmail: env.HARNESS_OIDC_TRUST_EMAIL === '1',
  };
}

export const NOBODY_ALLOWED = 'Single sign-on is not open to anyone yet: the operator must set HARNESS_OIDC_ALLOWED_DOMAINS or HARNESS_OIDC_ALLOWED_EMAILS.';

/** Why this e-mail address may not sign in, or undefined when it may. */
export function refusal(cfg: OidcConfig, email: string | undefined): string | undefined {
  if (!cfg.allowedDomains.length && !cfg.allowedEmails.length) return NOBODY_ALLOWED;
  const e = (email ?? '').toLowerCase();
  const at = e.lastIndexOf('@');
  if (at > 0 && (cfg.allowedEmails.includes(e) || cfg.allowedDomains.includes(e.slice(at + 1)))) return undefined;
  return `${email || 'This account'} may not sign in to this server.`;
}

export const isSsoAdmin = (cfg: OidcConfig, email: string | undefined) => !!email && cfg.admins.includes(email.toLowerCase());

// ---- id_token verification ----

type Jwk = crypto.webcrypto.JsonWebKey & { kid?: string; use?: string; alg?: string };
const ALGS: Record<string, { kty: string; hash: string | null; crv?: string; pss?: boolean; ec?: boolean }> = {
  RS256: { kty: 'RSA', hash: 'sha256' }, RS384: { kty: 'RSA', hash: 'sha384' }, RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true }, PS384: { kty: 'RSA', hash: 'sha384', pss: true }, PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256', ec: true }, ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384', ec: true }, ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521', ec: true },
  EdDSA: { kty: 'OKP', hash: null },
};

/** The key in a JWKS that may verify this alg (by kid, or the only candidate when there is no kid). */
export function pickKey(keys: Jwk[], kid: string | undefined, alg: string): Jwk | undefined {
  const a = ALGS[alg];
  if (!a) return undefined;
  const fits = keys.filter((k) => k.kty === a.kty && k.use !== 'enc' && (!k.alg || k.alg === alg) && (!a.crv || k.crv === a.crv) && (a.kty !== 'OKP' || k.crv === 'Ed25519' || k.crv === 'Ed448'));
  return kid !== undefined ? fits.find((k) => k.kid === kid) : fits.length === 1 ? fits[0] : undefined;
}

export interface VerifyOptions {
  /** The verification key for a header's kid and alg (throws OidcError when there is none). */
  keyFor: (kid: string | undefined, alg: string) => Promise<crypto.KeyObject>;
  issuer: string;
  clientId: string;
  nonce: string;
  nowSec?: number;
}

export type Claims = Record<string, unknown> & { iss: string; sub: string; aud: string | string[]; exp: number; iat: number; nonce?: string; email?: string; email_verified?: unknown; name?: string; azp?: string; nbf?: number };

const bad = (m: string) => new OidcError(401, `The sign-in was refused: ${m}.`);

/** Verifies an id_token's signature and claims; returns the claims. */
export async function verifyIdToken(jwt: string, o: VerifyOptions): Promise<Claims> {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw bad('the id_token is not a signed JWT');
  let header: { alg?: string; kid?: string }, c: Claims;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch { throw bad('the id_token cannot be read'); }
  const alg = String(header.alg);
  const a = ALGS[alg];
  // Never "none" or a shared-secret HMAC: only the provider's published keys count.
  if (!a) throw bad(`id_token algorithm ${alg} is not accepted`);
  const key = await o.keyFor(header.kid, alg);
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2]!, 'base64url');
  let ok = false;
  try {
    ok = a.pss ? crypto.verify(a.hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig)
      : a.ec ? crypto.verify(a.hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig)
      : crypto.verify(a.hash, data, key, sig);
  } catch { ok = false; }
  if (!ok) throw bad('the id_token signature does not verify');

  const now = o.nowSec ?? Math.floor(Date.now() / 1000);
  if (c.iss !== o.issuer) throw bad(`the id_token comes from ${String(c.iss)}, not ${o.issuer}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(o.clientId)) throw bad('the id_token is meant for another application (aud)');
  // With several audiences the token must say it was issued to us.
  if ((aud.length > 1 || c.azp !== undefined) && c.azp !== o.clientId) throw bad('the id_token was issued to another application (azp)');
  if (typeof c.exp !== 'number' || now >= c.exp + SKEW_SEC) throw bad('the id_token has expired');
  if (typeof c.iat !== 'number' || c.iat > now + SKEW_SEC) throw bad('the id_token was issued in the future');
  if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf > now + SKEW_SEC)) throw bad('the id_token is not valid yet');
  if (typeof c.nonce !== 'string' || !sameText(c.nonce, o.nonce)) throw bad('the id_token does not belong to this sign-in (nonce)');
  if (typeof c.sub !== 'string' || !c.sub) throw bad('the id_token names no subject');
  return c;
}

// ---- the relying party ----

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[]; end_session_endpoint?: string }
interface Pending { nonce: string; verifier: string; binding: string; at: number }

export class OidcClient {
  readonly cfg: OidcConfig;
  private fetchFn: typeof fetch;
  private disc?: { doc: Discovery; at: number };
  private jwks?: { keys: Jwk[]; at: number };
  private jwksLoading?: Promise<Jwk[]>;
  /** Sign-ins started and not finished, by state: in memory, short-lived, single use. */
  private pending = new Map<string, Pending>();

  constructor(cfg: OidcConfig, opts: { fetch?: typeof fetch } = {}) { this.cfg = cfg; this.fetchFn = opts.fetch ?? fetch; }

  get redirectUri(): string { return `${this.cfg.publicUrl}/auth/callback`; }
  get origin(): string { return new URL(this.cfg.publicUrl).origin; }
  get secure(): boolean { return this.cfg.publicUrl.startsWith('https:'); }

  private async json(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
    let r: Response;
    try { r = await this.fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }); } catch (e) { throw new OidcError(502, `The identity provider cannot be reached (${new URL(url).host}): ${(e as Error).message}`); }
    const text = await r.text();
    try { return { ok: r.ok, status: r.status, body: JSON.parse(text) }; } catch { throw new OidcError(502, `The identity provider answered ${url} with something other than JSON (HTTP ${r.status}).`); }
  }

  async discovery(): Promise<Discovery> {
    if (this.disc && Date.now() - this.disc.at < CACHE_MS) return this.disc.doc;
    const url = `${this.cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const r = await this.json(url);
    if (!r.ok) throw new OidcError(502, `OpenID discovery failed: HTTP ${r.status} from ${url}`);
    const d = r.body as unknown as Discovery;
    if (d.issuer !== this.cfg.issuer) throw new OidcError(502, `The discovery document names the issuer ${String(d.issuer)}, not ${this.cfg.issuer} (HARNESS_OIDC_ISSUER must match it exactly).`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof d[k] !== 'string') throw new OidcError(502, `The discovery document has no ${k}.`);
    this.disc = { doc: d, at: Date.now() };
    return d;
  }

  private loadKeys(): Promise<Jwk[]> {
    this.jwksLoading ??= (async () => {
      const r = await this.json((await this.discovery()).jwks_uri);
      if (!r.ok || !Array.isArray(r.body.keys)) throw new OidcError(502, `The provider's signing keys cannot be read (HTTP ${r.status}).`);
      this.jwks = { keys: r.body.keys as Jwk[], at: Date.now() };
      return this.jwks.keys;
    })().finally(() => { this.jwksLoading = undefined; });
    return this.jwksLoading;
  }

  /** The provider's key for a token; an unknown kid fetches the JWKS again (keys rotate). */
  async keyFor(kid: string | undefined, alg: string): Promise<crypto.KeyObject> {
    const fresh = !this.jwks || Date.now() - this.jwks.at >= CACHE_MS;
    let k = pickKey(fresh ? await this.loadKeys() : this.jwks!.keys, kid, alg);
    if (!k && !fresh) k = pickKey(await this.loadKeys(), kid, alg);
    if (!k) throw bad(`the id_token was signed with a key the provider does not publish${kid ? ` (kid ${kid})` : ''}`);
    try { return crypto.createPublicKey({ key: k, format: 'jwk' }); } catch { throw bad('the provider published a key that cannot be used'); }
  }

  private prune(now = Date.now()): void {
    for (const [s, p] of this.pending) if (now - p.at > PENDING_MS) this.pending.delete(s); else break;
    // Anyone can start a sign-in: keep the table bounded (oldest first, Maps keep insertion order).
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
  }

  /**
   * Starts a sign-in: the provider URL to send the browser to, and a binding
   * secret for a cookie, so the callback is accepted only in the browser that
   * started it (no one can sign someone else in to their own account).
   */
  async start(): Promise<{ url: string; binding: string }> {
    const d = await this.discovery();
    this.prune();
    const state = rand(), nonce = rand(), verifier = rand(48), binding = rand();
    this.pending.set(state, { nonce, verifier, binding: sha(binding), at: Date.now() });
    const u = new URL(d.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: this.cfg.clientId, redirect_uri: this.redirectUri, scope: this.cfg.scopes, state, nonce, code_challenge: sha(verifier), code_challenge_method: 'S256' })) u.searchParams.set(k, v);
    return { url: u.toString(), binding };
  }

  /**
   * Where to send the browser to sign out at the provider too (RP-initiated logout),
   * back to this server afterwards; undefined when the provider has no such endpoint
   * (Google) - then only the harness session ends.
   */
  async logoutUrl(idTokenHint?: string): Promise<string | undefined> {
    const end = (await this.discovery()).end_session_endpoint;
    if (typeof end !== 'string') return undefined;
    let u: URL;
    try { u = new URL(end); } catch { return undefined; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return undefined;
    u.searchParams.set('client_id', this.cfg.clientId);
    u.searchParams.set('post_logout_redirect_uri', `${this.cfg.publicUrl}/`);
    // With the hint the provider knows whose session to end and signs out without asking
    // (Keycloak shows a "Do you want to log out?" page without it).
    if (idTokenHint) u.searchParams.set('id_token_hint', idTokenHint);
    return u.toString();
  }

  /** Finishes a sign-in from the callback's query: exchanges the code and verifies the id_token. */
  async finish(q: URLSearchParams, binding: string | undefined): Promise<Identity> {
    const state = q.get('state') ?? '';
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > PENDING_MS) throw new OidcError(400, 'This sign-in has expired or was already used. Start again.');
    if (!binding || !sameText(sha(binding), p.binding)) throw new OidcError(400, 'This sign-in was started in another browser. Start again.');
    const err = q.get('error');
    if (err) throw new OidcError(403, `The identity provider refused the sign-in: ${err}${q.get('error_description') ? ` (${q.get('error_description')})` : ''}`);
    const code = q.get('code');
    if (!code) throw new OidcError(400, 'The identity provider sent no code.');
    const d = await this.discovery();
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: p.verifier, client_id: this.cfg.clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.cfg.clientSecret) {
      const methods = d.token_endpoint_auth_methods_supported;
      if (methods && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) form.set('client_secret', this.cfg.clientSecret);
      else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')}`;
    }
    const r = await this.json(d.token_endpoint, { method: 'POST', headers, body: form });
    if (!r.ok) throw new OidcError(401, `The identity provider did not accept the sign-in code: ${String(r.body.error ?? `HTTP ${r.status}`)}${r.body.error_description ? ` (${String(r.body.error_description)})` : ''}`);
    if (typeof r.body.id_token !== 'string') throw new OidcError(502, 'The identity provider returned no id_token (is "openid" in HARNESS_OIDC_SCOPES?).');
    const c = await verifyIdToken(r.body.id_token, { keyFor: (kid, alg) => this.keyFor(kid, alg), issuer: this.cfg.issuer, clientId: this.cfg.clientId, nonce: p.nonce });
    const verified = c.email_verified === true || c.email_verified === 'true';
    if (c.email_verified === false || c.email_verified === 'false' || (!verified && !this.cfg.trustEmail)) throw bad(c.email_verified === undefined ? 'the provider did not say this e-mail address is verified (set HARNESS_OIDC_TRUST_EMAIL=1 only if it never lets people use an address it has not verified)' : 'the provider has not verified this e-mail address');
    if (typeof c.email !== 'string' || !c.email.includes('@')) throw bad('the provider sent no e-mail address (is "email" in HARNESS_OIDC_SCOPES?)');
    return { iss: c.iss, sub: c.sub, email: c.email, name: typeof c.name === 'string' ? c.name : undefined, idToken: r.body.id_token };
  }
}

// ---- browser sessions ----

interface BrowserSession { user: string; created: number; seen: number; /** The provider's id_token, for id_token_hint at sign-out (it signs no one in here). */ idt?: string }

/**
 * Signed-in browsers: the cookie holds a random id, this store holds its hash
 * (a leaked file signs no one in), the account, and when it was last used.
 * Kept on disk so a restart keeps people signed in.
 */
export class BrowserSessions {
  private file: string;
  private recs = new Map<string, BrowserSession>();
  private writing: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  readonly idleMs: number;
  readonly maxMs: number;
  private now: () => number;

  constructor(dataDir: string, opts: { idleMs?: number; maxMs?: number; now?: () => number } = {}) {
    this.file = path.join(dataDir, 'browser-sessions.json');
    this.idleMs = opts.idleMs ?? 12 * 3_600_000;
    this.maxMs = opts.maxMs ?? 7 * 86_400_000;
    this.now = opts.now ?? Date.now;
  }

  async load(): Promise<this> {
    try { this.recs = new Map(Object.entries(JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, BrowserSession>)); } catch { /* none yet */ }
    for (const [k, r] of this.recs) if (this.expired(r)) this.recs.delete(k);
    return this;
  }

  private expired(r: BrowserSession): boolean { const t = this.now(); return t - r.seen > this.idleMs || t - r.created > this.maxMs; }

  /** Writes one at a time, each with the latest state, so an older snapshot never lands last. */
  private save(): Promise<void> {
    clearTimeout(this.timer);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.recs)), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    }).catch((e) => { console.error(`browser sessions not saved: ${(e as Error).message}`); });
    return this.writing;
  }

  async create(user: string, idToken?: string): Promise<string> {
    for (const [k, r] of this.recs) if (this.expired(r)) this.recs.delete(k);
    const id = rand(32);
    const t = this.now();
    // A very large token is not worth keeping (the hint is optional).
    this.recs.set(sha(id), { user, created: t, seen: t, ...(idToken && idToken.length <= 8192 ? { idt: idToken } : {}) });
    await this.save();
    return id;
  }

  /** The account a cookie's session belongs to; use slides its expiry. */
  get(id: string | undefined): string | undefined {
    if (!id) return undefined;
    const k = sha(id);
    const r = this.recs.get(k);
    if (!r) return undefined;
    if (this.expired(r)) { this.recs.delete(k); void this.save(); return undefined; }
    const t = this.now();
    if (t - r.seen > 60_000) {
      r.seen = t;
      // Sliding is saved lazily: a minute's precision is enough for a 12-hour window.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { void this.save(); }, 1000);
      this.timer.unref?.();
    }
    return r.user;
  }

  /** The id_token a browser session was signed in with (for the provider's sign-out). */
  idToken(id: string | undefined): string | undefined {
    return id ? this.recs.get(sha(id))?.idt : undefined;
  }

  async delete(id: string | undefined): Promise<void> {
    if (id && this.recs.delete(sha(id))) await this.save();
  }

  /** Waits for pending writes (for a clean shutdown). */
  async flush(): Promise<void> { if (this.timer) await this.save(); else await this.writing; }
}
