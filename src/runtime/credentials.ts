import fs from 'node:fs';

// Credentials for commands in the sandbox, kept outside it. The egress proxy
// (the sandbox's only way out on an allowlist network) adds the real header to
// requests sent to http://egress:3128/__cred/<name>/...; the sandbox gets base
// URLs pointing there and a placeholder key, never the key itself.
//
// HARNESS_SANDBOX_CREDENTIALS lists what sandboxes get: preset names
// (openai, anthropic, deepseek, github; "github:write" lets it write) and/or the
// path of a JSON file of
//   [{ "name": "billing", "upstream": "https://api.billing.example",
//      "headers": { "authorization": "Bearer ${BILLING_TOKEN}" },
//      "env": { "BILLING_URL": "{base}" },
//      "allow": [{ "methods": ["GET"], "paths": ["/v2/invoices/**"] }] }]
// "${VAR}" in a header is read from the server's environment; "{base}" in env is
// the gateway URL for that credential. "allow" (optional) limits the methods and
// paths the gateway forwards: the gateway terminates each request, so it sees
// both, which an HTTPS tunnel would hide.
//
// The presets are least privilege: the model APIs reach only their inference
// endpoints (and the model list); GitHub is read-only (GET, HEAD - a GraphQL
// POST counts as a write) unless the operator lists "github:write".

/** Requests the gateway forwards: a method in `methods` (absent: any) and a path matching one of `paths` (absent: any). */
export interface CredentialRule { methods?: string[]; paths?: string[] }

export interface SandboxCredential {
  name: string;
  /** Where requests go, e.g. https://api.openai.com. */
  upstream: string;
  /** Added by the proxy; resolved values. */
  headers: Record<string, string>;
  /** Set in the sandbox, with {base} resolved. */
  env: Record<string, string>;
  /** What the gateway forwards (absent: everything). Paths are relative to the upstream's path. */
  allow?: CredentialRule[];
  /**
   * Whether a command can change something others may read through it (a push, a
   * comment, a gist): a way data leaves the session, which the taint guard counts.
   * A read-only API, or a model's inference endpoint, is not.
   */
  writes: boolean;
  /** Said with a refusal (how the operator widens it). */
  hint?: string;
}

export const GATEWAY = 'http://egress:3128/__cred';
export const PLACEHOLDER = 'harness-placeholder-key-the-proxy-adds-the-real-one';

interface Template { name: string; upstream: string; headers: Record<string, string>; env: Record<string, string>; allow?: CredentialRule[]; writes?: boolean; hint?: string }

const READ = ['GET', 'HEAD'];
const PRESETS: Record<string, Template> = {
  openai: {
    name: 'openai', upstream: 'https://api.openai.com', headers: { authorization: 'Bearer ${OPENAI_API_KEY}' }, env: { OPENAI_BASE_URL: '{base}/v1', OPENAI_API_KEY: PLACEHOLDER },
    allow: [{ methods: ['POST'], paths: ['/v1/chat/completions', '/v1/responses'] }, { methods: READ, paths: ['/v1/models', '/v1/models/*'] }], writes: false,
    hint: 'Only inference (chat completions, responses) and the model list go through this gateway.',
  },
  anthropic: {
    name: 'anthropic', upstream: 'https://api.anthropic.com', headers: { 'x-api-key': '${ANTHROPIC_API_KEY|GW_ANTHROPIC_API_KEY}' }, env: { ANTHROPIC_BASE_URL: '{base}', ANTHROPIC_API_KEY: PLACEHOLDER },
    allow: [{ methods: ['POST'], paths: ['/v1/messages', '/v1/messages/count_tokens'] }, { methods: READ, paths: ['/v1/models', '/v1/models/*'] }], writes: false,
    hint: 'Only inference (messages) and the model list go through this gateway.',
  },
  deepseek: {
    name: 'deepseek', upstream: 'https://api.deepseek.com', headers: { authorization: 'Bearer ${DEEPSEEK_API_KEY}' }, env: { DEEPSEEK_BASE_URL: '{base}', DEEPSEEK_API_KEY: PLACEHOLDER },
    allow: [{ methods: ['POST'], paths: ['/chat/completions', '/v1/chat/completions'] }, { methods: READ, paths: ['/models', '/v1/models'] }], writes: false,
    hint: 'Only inference (chat completions) and the model list go through this gateway.',
  },
  github: {
    name: 'github', upstream: 'https://api.github.com', headers: { authorization: 'Bearer ${HARNESS_SANDBOX_GITHUB_TOKEN}' }, env: { GITHUB_API_URL: '{base}', GH_TOKEN: PLACEHOLDER },
    allow: [{ methods: READ }], writes: false,
    hint: 'It is read-only (GET and HEAD; a GraphQL POST counts as a write); the operator allows writes with "github:write" in HARNESS_SANDBOX_CREDENTIALS.',
  },
};

/** A preset with writes allowed ("github:write"): every method and path. */
function writable(t: Template): Template {
  const { allow: _a, hint: _h, ...rest } = t;
  return { ...rest, writes: true };
}

/** "${A|B}" -> the first of A, B that is set; undefined when none is (the credential is skipped). */
function fill(v: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const out = v.replace(/\$\{([A-Za-z0-9_|]+)\}/g, (_m, names: string) => {
    const hit = names.split('|').map((n) => env[n]?.trim()).find(Boolean);
    if (!hit) missing = true;
    return hit ?? '';
  });
  return missing ? undefined : out;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function checkRules(name: string, allow: unknown): CredentialRule[] | string | undefined {
  if (allow === undefined) return undefined;
  if (!Array.isArray(allow)) return `${name}: "allow" must be a list of { methods, paths }`;
  const out: CredentialRule[] = [];
  for (const r of allow as CredentialRule[]) {
    if (!r || typeof r !== 'object') return `${name}: each "allow" rule is an object`;
    if (r.methods !== undefined && (!Array.isArray(r.methods) || !r.methods.every((m) => typeof m === 'string' && /^[A-Za-z]+$/.test(m)))) return `${name}: "methods" must be a list of HTTP methods`;
    if (r.paths !== undefined && (!Array.isArray(r.paths) || !r.paths.every((p) => typeof p === 'string' && p.startsWith('/')))) return `${name}: "paths" must be a list of paths starting with /`;
    out.push({ ...(r.methods ? { methods: r.methods.map((m) => m.toUpperCase()) } : {}), ...(r.paths ? { paths: [...r.paths] } : {}) });
  }
  return out;
}

function resolve(t: Template, env: NodeJS.ProcessEnv): SandboxCredential | string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) return `credential name "${t.name}" must be letters, digits, - and _`;
  let up: URL;
  try { up = new URL(t.upstream); } catch { return `${t.name}: upstream is not a URL`; }
  if (up.protocol !== 'https:' && up.protocol !== 'http:') return `${t.name}: upstream must be http(s)`;
  const allow = checkRules(t.name, t.allow);
  if (typeof allow === 'string') return allow;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    const filled = fill(String(v), env);
    if (filled === undefined) return `${t.name}: ${String(v).match(/\$\{([^}]+)\}/)?.[1]} is not set on the server`;
    headers[k.toLowerCase()] = filled;
  }
  const base = `${GATEWAY}/${t.name}`;
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.env ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) e[k] = String(v).replace(/\{base\}/g, base);
  // Unless it says, a credential writes when any of its rules lets a method other than a read through.
  const writes = typeof t.writes === 'boolean' ? t.writes : !allow || allow.some((r) => !r.methods || r.methods.some((m) => !SAFE_METHODS.has(m)));
  return { name: t.name, upstream: up.origin + up.pathname.replace(/\/+$/, ''), headers, env: e, ...(allow ? { allow } : {}), writes, ...(t.hint ? { hint: t.hint } : {}) };
}

/** The operator's sandbox credentials, and why any were skipped (a missing variable, a bad entry). */
export function sandboxCredentials(env: NodeJS.ProcessEnv = process.env): { credentials: SandboxCredential[]; problems: string[] } {
  const spec = env.HARNESS_SANDBOX_CREDENTIALS?.trim();
  const credentials: SandboxCredential[] = [];
  const problems: string[] = [];
  if (!spec) return { credentials, problems };
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    let templates: Template[];
    // "github:write": a preset with writes allowed. (A Windows path has a colon too: only preset names count.)
    const pm = /^([a-z]+):(write|read)$/.exec(item);
    if (pm && PRESETS[pm[1]!]) templates = [pm[2] === 'write' ? writable(PRESETS[pm[1]!]!) : PRESETS[pm[1]!]!];
    else if (PRESETS[item]) templates = [PRESETS[item]!];
    else {
      try { templates = JSON.parse(fs.readFileSync(item, 'utf8')) as Template[]; } catch (e) { problems.push(`${item}: not a preset (${Object.keys(PRESETS).join(', ')}, or github:write) or a readable JSON file (${(e as Error).message})`); continue; }
      if (!Array.isArray(templates)) { problems.push(`${item}: must hold a JSON array`); continue; }
    }
    for (const t of templates) {
      const r = resolve(t, env);
      if (typeof r === 'string') problems.push(r);
      else if (credentials.some((c) => c.name === r.name)) problems.push(`${r.name}: listed twice`);
      else credentials.push(r);
    }
  }
  return { credentials, problems };
}

/** What the proxy reads: name -> upstream, headers and rules. */
export function proxyCredentialFile(creds: SandboxCredential[]): string {
  return JSON.stringify(Object.fromEntries(creds.map((c) => [c.name, { upstream: c.upstream, headers: c.headers, ...(c.allow ? { allow: c.allow } : {}), ...(c.hint ? { hint: c.hint } : {}) }])));
}

/** A credential's sandbox variables with the gateway at another origin (an OS sandbox's local proxy). */
export function gatewayEnv(c: SandboxCredential, origin: string): Record<string, string> {
  const from = GATEWAY.replace(/\/__cred$/, '');
  return Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, v.split(from).join(origin)]));
}

/** What the agent is told about a session's credentials (and the taint guard reads `writes`). */
export function credentialSummary(creds: SandboxCredential[]): { name: string; vars: string[]; writes: boolean }[] {
  return creds.map((c) => ({ name: c.name, vars: Object.keys(c.env), writes: c.writes }));
}
