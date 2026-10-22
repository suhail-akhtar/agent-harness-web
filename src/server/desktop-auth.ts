import crypto from 'node:crypto';

// Sign-in for native apps (the desktop) on a single sign-on server, as RFC 8252 says:
// the app opens the system browser at /auth/desktop/start with a loopback redirect URI
// and a PKCE challenge of its own; the person signs in at the identity provider through
// the server's usual OpenID Connect flow; the server then sends the browser to the app's
// loopback address with a one-time code (60 seconds, single use, bound to the challenge),
// and the app trades the code and its verifier at POST /auth/desktop/token for a bearer
// session (kept hashed on the server like a browser session, revoked by POST /auth/logout).

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const same = (a: string, b: string) => crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

export const DESKTOP_TOKEN_PREFIX = 'hwd_';
const START_MS = 10 * 60_000;
const CODE_MS = 60_000;
const MAX = 5000;

export class DesktopAuthError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** The app's loopback redirect: http, 127.0.0.1 / localhost / [::1], an explicit port, no credentials or fragment. */
export function loopbackRedirect(raw: string | null): URL {
  let u: URL;
  try { u = new URL(String(raw ?? '')); } catch { throw new DesktopAuthError(400, 'redirect_uri must be a loopback URL such as http://127.0.0.1:53123/callback'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !u.port || u.username || u.password || u.hash) {
    throw new DesktopAuthError(400, 'redirect_uri must be http://127.0.0.1:<port>/..., http://localhost:<port>/... or http://[::1]:<port>/... (RFC 8252 loopback, with an explicit port)');
  }
  return u;
}

interface Start { redirect: string; state: string; challenge: string; at: number }
interface Code { user: string; challenge: string; redirect: string; at: number }

export class DesktopSignIn {
  /** Sign-ins started by an app, by the hash of the browser's binding cookie. */
  private starts = new Map<string, Start>();
  /** One-time codes, by their hash. */
  private codes = new Map<string, Code>();
  private now: () => number;
  constructor(opts: { now?: () => number } = {}) { this.now = opts.now ?? Date.now; }

  private prune(m: Map<string, { at: number }>, ttl: number): void {
    const t = this.now();
    for (const [k, v] of m) if (t - v.at > ttl) m.delete(k); else break;
    while (m.size >= MAX) m.delete(m.keys().next().value!);
  }

  /** Checks the app's request (redirect, state, challenge) before any provider is involved. */
  check(q: URLSearchParams): Omit<Start, 'at'> {
    const redirect = loopbackRedirect(q.get('redirect_uri')).toString();
    const state = q.get('state') ?? '';
    if (!/^[A-Za-z0-9._~-]{8,512}$/.test(state)) throw new DesktopAuthError(400, 'state is required (8-512 unreserved characters)');
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256') throw new DesktopAuthError(400, 'code_challenge_method must be S256');
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new DesktopAuthError(400, 'code_challenge must be the base64url SHA-256 of the verifier (43 characters)');
    return { redirect, state, challenge };
  }

  /** Remembers an app's sign-in under the browser binding the server's OIDC flow set. */
  begin(binding: string, s: Omit<Start, 'at'>): void {
    this.prune(this.starts, START_MS);
    this.starts.set(sha(binding), { ...s, at: this.now() });
  }

  /** The app's sign-in this browser started (taken: one callback each), if any. */
  take(binding: string | undefined): Start | undefined {
    if (!binding) return undefined;
    const k = sha(binding);
    const s = this.starts.get(k);
    this.starts.delete(k);
    return s && this.now() - s.at <= START_MS ? s : undefined;
  }

  /** A one-time code for the signed-in account, and where the browser goes with it. */
  issue(start: Start, user: string): string {
    this.prune(this.codes, CODE_MS);
    const code = crypto.randomBytes(32).toString('base64url');
    this.codes.set(sha(code), { user, challenge: start.challenge, redirect: start.redirect, at: this.now() });
    return withParams(start.redirect, { code, state: start.state });
  }

  /** Trades a code and its verifier for the account; the code is gone after the first try, right or wrong. */
  redeem(code: unknown, verifier: unknown, redirect?: unknown): string {
    if (typeof code !== 'string' || !code || typeof verifier !== 'string') throw new DesktopAuthError(400, 'code and code_verifier are required');
    const k = sha(code);
    const c = this.codes.get(k);
    this.codes.delete(k);
    if (!c || this.now() - c.at > CODE_MS) throw new DesktopAuthError(400, 'invalid_grant: the code is unknown, used or expired (60 seconds)');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !same(sha(verifier), c.challenge)) throw new DesktopAuthError(400, 'invalid_grant: the code_verifier does not match the challenge');
    if (redirect !== undefined && redirect !== c.redirect) throw new DesktopAuthError(400, 'invalid_grant: redirect_uri does not match the sign-in');
    return c.user;
  }
}

/** The redirect URI with these query parameters added (its own kept). */
export function withParams(uri: string, params: Record<string, string>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
