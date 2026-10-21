import fs from 'node:fs';

// Credentials for commands in the sandbox, kept outside it. The egress proxy
// (the sandbox's only way out on an allowlist network) adds the real header to
// requests sent to http://egress:3128/__cred/<name>/...; the sandbox gets base
// URLs pointing there and a placeholder key, never the key itself.
//
// HARNESS_SANDBOX_CREDENTIALS lists what sandboxes get: preset names
// (openai, anthropic, deepseek, github) and/or the path of a JSON file of
//   [{ "name": "billing", "upstream": "https://api.billing.example",
//      "headers": { "authorization": "Bearer ${BILLING_TOKEN}" },
//      "env": { "BILLING_URL": "{base}" } }]
// "${VAR}" in a header is read from the server's environment; "{base}" in env is
// the gateway URL for that credential.

export interface SandboxCredential {
  name: string;
  /** Where requests go, e.g. https://api.openai.com. */
  upstream: string;
  /** Added by the proxy; resolved values. */
  headers: Record<string, string>;
  /** Set in the sandbox, with {base} resolved. */
  env: Record<string, string>;
}

export const GATEWAY = 'http://egress:3128/__cred';
export const PLACEHOLDER = 'harness-placeholder-key-the-proxy-adds-the-real-one';

interface Template { name: string; upstream: string; headers: Record<string, string>; env: Record<string, string> }

const PRESETS: Record<string, Template> = {
  openai: { name: 'openai', upstream: 'https://api.openai.com', headers: { authorization: 'Bearer ${OPENAI_API_KEY}' }, env: { OPENAI_BASE_URL: '{base}/v1', OPENAI_API_KEY: PLACEHOLDER } },
  anthropic: { name: 'anthropic', upstream: 'https://api.anthropic.com', headers: { 'x-api-key': '${ANTHROPIC_API_KEY|GW_ANTHROPIC_API_KEY}' }, env: { ANTHROPIC_BASE_URL: '{base}', ANTHROPIC_API_KEY: PLACEHOLDER } },
  deepseek: { name: 'deepseek', upstream: 'https://api.deepseek.com', headers: { authorization: 'Bearer ${DEEPSEEK_API_KEY}' }, env: { DEEPSEEK_BASE_URL: '{base}', DEEPSEEK_API_KEY: PLACEHOLDER } },
  github: { name: 'github', upstream: 'https://api.github.com', headers: { authorization: 'Bearer ${HARNESS_SANDBOX_GITHUB_TOKEN}' }, env: { GITHUB_API_URL: '{base}', GH_TOKEN: PLACEHOLDER } },
};

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

function resolve(t: Template, env: NodeJS.ProcessEnv): SandboxCredential | string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) return `credential name "${t.name}" must be letters, digits, - and _`;
  let up: URL;
  try { up = new URL(t.upstream); } catch { return `${t.name}: upstream is not a URL`; }
  if (up.protocol !== 'https:' && up.protocol !== 'http:') return `${t.name}: upstream must be http(s)`;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    const filled = fill(String(v), env);
    if (filled === undefined) return `${t.name}: ${String(v).match(/\$\{([^}]+)\}/)?.[1]} is not set on the server`;
    headers[k.toLowerCase()] = filled;
  }
  const base = `${GATEWAY}/${t.name}`;
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.env ?? {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) e[k] = String(v).replace(/\{base\}/g, base);
  return { name: t.name, upstream: up.origin + up.pathname.replace(/\/+$/, ''), headers, env: e };
}

/** The operator's sandbox credentials, and why any were skipped (a missing variable, a bad entry). */
export function sandboxCredentials(env: NodeJS.ProcessEnv = process.env): { credentials: SandboxCredential[]; problems: string[] } {
  const spec = env.HARNESS_SANDBOX_CREDENTIALS?.trim();
  const credentials: SandboxCredential[] = [];
  const problems: string[] = [];
  if (!spec) return { credentials, problems };
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    let templates: Template[];
    if (PRESETS[item]) templates = [PRESETS[item]!];
    else {
      try { templates = JSON.parse(fs.readFileSync(item, 'utf8')) as Template[]; } catch (e) { problems.push(`${item}: not a preset (${Object.keys(PRESETS).join(', ')}) or a readable JSON file (${(e as Error).message})`); continue; }
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

/** What the proxy reads: name -> upstream and headers. */
export function proxyCredentialFile(creds: SandboxCredential[]): string {
  return JSON.stringify(Object.fromEntries(creds.map((c) => [c.name, { upstream: c.upstream, headers: c.headers }])));
}
