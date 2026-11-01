import { checkServerConfig, McpServerError, SERVER_NAME, type UserServerConfig } from './servers.ts';

// MCP server configs from other apps, as a person's own servers:
//   Claude Desktop, Claude Code (.mcp.json), Cursor, Windsurf  { "mcpServers": { name: { command, args, env } | { type?, url, headers } } }
//   VS Code (.vscode/mcp.json)                                 { "servers": { name: { type, command | url, ... } }, "inputs": [...] }
//   one server                                                 { "name"?, "command" | "url", ... }
// What they read from the environment or ask the person for (${VAR}, ${env:VAR}, ${input:id}) becomes a
// ${vault:name} reference: the value goes in the vault, never in the config.

export interface ImportedServer { config: UserServerConfig; warnings: string[] }
export interface ImportResult { format: string; servers: ImportedServer[]; /** Vault entries the servers need (to be set before they connect). */ vault: string[]; errors: string[] }

const vaultName = (s: string) => s.replace(/^env:/, '').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 128);

/** ${VAR}, ${env:VAR}, ${input:id} (and $VAR alone) as ${vault:...}; ${workspaceFolder} & co. are left to warn about. */
function toVault(v: string, needs: Set<string>, warn: (w: string) => void): string {
  return v.replace(/\$\{(input:|env:)?([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (m, kind: string | undefined, name: string) => {
    if (!kind && /^(workspaceFolder|workspaceRoot|userHome|cwd|pathSeparator|fileDirname)$/.test(name)) { warn(`${m} has no meaning here: replace it with a path`); return m; }
    if (m.startsWith('${vault:')) return m;
    const n = vaultName(name);
    needs.add(n);
    return `\${vault:${n}}`;
  });
}

function mapValues(o: unknown, needs: Set<string>, warn: (w: string) => void): Record<string, string> | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v !== 'string') { warn(`${k} is not text: left out`); continue; }
    // A literal secret in a pasted config: kept out of the config, asked for in the vault instead.
    if (/(token|key|secret|password|authorization)/i.test(k) && !/\$\{/.test(v) && v.length > 8) {
      const n = vaultName(k);
      needs.add(n);
      warn(`${k} had a secret written in the config: it is now \${vault:${n}}; put the value in the vault`);
      out[k] = /^authorization$/i.test(k) && /^Bearer\s/i.test(v) ? `Bearer \${vault:${n}}` : `\${vault:${n}}`;
      continue;
    }
    out[k] = toVault(v, needs, warn);
  }
  return Object.keys(out).length ? out : undefined;
}

function one(name: string, raw: Record<string, unknown>, needs: Set<string>): ImportedServer {
  const warnings: string[] = [];
  const warn = (w: string) => warnings.push(w);
  const type = String(raw.type ?? raw.transport ?? '').toLowerCase();
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.serverUrl === 'string' ? raw.serverUrl : typeof raw.httpUrl === 'string' ? raw.httpUrl : undefined;
  const clean = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
  if (clean !== name) warn(`named "${clean}" (was "${name}")`);
  if (raw.disabled === true) warn('it was turned off there: it is added turned off');
  let cfg: Record<string, unknown>;
  if (url && !raw.command) {
    if (type === 'sse') warn('it used the old SSE transport: connecting with streamable HTTP at the same address (most servers serve both; if not, use its /mcp address)');
    cfg = { name: clean, type: 'http', url: toVault(url, needs, warn), headers: mapValues(raw.headers, needs, warn) };
  } else if (typeof raw.command === 'string') {
    cfg = { name: clean, type: 'stdio', command: toVault(raw.command, needs, warn), args: Array.isArray(raw.args) ? raw.args.map((a) => toVault(String(a), needs, warn)) : undefined, env: mapValues(raw.env, needs, warn), ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}) };
    if (raw.envFile) warn('envFile is not read: put those values in env (as ${vault:...} for secrets)');
  } else throw new McpServerError(`"${name}" has neither a command nor a url`);
  if (typeof raw.timeout === 'number' && raw.timeout >= 1000) cfg.timeoutMs = raw.timeout;
  if (typeof raw.description === 'string') cfg.description = raw.description;
  return { config: checkServerConfig(cfg), warnings };
}

/** Reads a pasted or uploaded config. Nothing is saved here. */
export function parseMcpImport(text: string): ImportResult {
  let j: unknown;
  // JSON with comments and trailing commas (VS Code's and Cursor's files have them).
  const relaxed = text.replace(/^﻿/, '').replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
  try { j = JSON.parse(relaxed); } catch (e) { throw new McpServerError(`not JSON: ${(e as Error).message}`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new McpServerError('expected an object (a config with "mcpServers" or "servers", or one server)');
  const o = j as Record<string, unknown>;
  const needs = new Set<string>();
  const errors: string[] = [];
  const servers: ImportedServer[] = [];
  let map: Record<string, unknown> | undefined;
  let format: string;
  if (o.mcpServers && typeof o.mcpServers === 'object') { map = o.mcpServers as Record<string, unknown>; format = 'mcpServers (Claude Desktop, Claude Code, Cursor)'; }
  else if (o.servers && typeof o.servers === 'object' && !Array.isArray(o.servers)) { map = o.servers as Record<string, unknown>; format = 'servers (VS Code)'; }
  else if (o.mcp && typeof o.mcp === 'object' && (o.mcp as Record<string, unknown>).servers) { map = (o.mcp as Record<string, unknown>).servers as Record<string, unknown>; format = 'mcp.servers (VS Code settings)'; }
  else if (typeof o.command === 'string' || typeof o.url === 'string') { map = { [String(o.name ?? 'server')]: o }; format = 'one server'; }
  else throw new McpServerError('no servers found: expected "mcpServers", "servers", or a server with a command or url');
  for (const [name, raw] of Object.entries(map)) {
    if (!raw || typeof raw !== 'object') { errors.push(`${name}: not a server`); continue; }
    try {
      const s = one(name, raw as Record<string, unknown>, needs);
      if (!SERVER_NAME.test(s.config.name)) throw new McpServerError('not a usable name');
      if (servers.some((x) => x.config.name === s.config.name)) throw new McpServerError(`a second server named "${s.config.name}"`);
      if ((raw as Record<string, unknown>).disabled === true) (s as ImportedServer & { disabled?: boolean }).disabled = true;
      servers.push(s);
    } catch (e) { errors.push(`${name}: ${(e as Error).message}`); }
  }
  // VS Code's inputs: what each ${input:id} asks for, said in the warning.
  if (Array.isArray(o.inputs)) {
    for (const i of o.inputs as Array<Record<string, unknown>>) {
      const id = typeof i.id === 'string' ? vaultName(i.id) : undefined;
      if (id && needs.has(id)) for (const s of servers) if (JSON.stringify(s.config).includes(`\${vault:${id}}`)) s.warnings.push(`\${vault:${id}}: ${String(i.description ?? 'a value VS Code asked for')}`);
    }
  }
  return { format, servers, vault: [...needs].sort(), errors };
}
