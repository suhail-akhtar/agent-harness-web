import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zip } from '../../data/xlsx.ts';
import { nodeEnv, scrubbedEnv } from '../../runtime/host.ts';
import { HttpTransport, McpClient, MCP_PROTOCOL_VERSION, StdioTransport } from '../client.ts';
import type { BuildSpec } from './spec.ts';

// A server from its spec: written to a folder (the runtime, spec.json, package.json, a README, an MCPB manifest, a
// registry server.json and the configs for Claude Desktop, Claude Code, Cursor and VS Code), checked by the
// harness's own client (both protocol eras, stdio and HTTP, every tool listed as specified, the safe ones called, a
// bad call answered as an error), and packed as a .mcpb for Claude Desktop.

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, 'template', 'server.ts');
/** `node --import` this to run a built server from its folder with the harness's SDK (no npm install). */
export const SDK_LOADER = pathToFileURL(path.join(here, 'sdk-loader.mjs')).href;
const SDK_VERSION = '2.4.0';

/** How the harness starts a server it built (and what a person's server entry says). */
export function localCommand(dir: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['--import', SDK_LOADER, '--no-warnings=ExperimentalWarning', path.join(dir, 'server.ts')] };
}

/** The settings a client config sets: those without a default (the rest work as they are). */
const envBlock = (spec: BuildSpec, value: (n: string) => string) => Object.fromEntries(spec.env.filter((e) => !e.default).map((e) => [e.name, value(e.name)]));

/** Every file of the server, by its path in the folder. */
export async function serverFiles(spec: BuildSpec): Promise<Record<string, string>> {
  const runtime = await fs.readFile(TEMPLATE, 'utf8');
  const usesDuck = spec.database?.kind === 'duckdb';
  const pkg = {
    name: spec.name, version: spec.version, description: spec.description, type: 'module', private: true,
    bin: { [spec.name]: 'dist/server.mjs' },
    scripts: { start: 'node server.ts', http: 'node server.ts --http 3000', bundle: 'esbuild server.ts --bundle --platform=node --format=esm --target=node22 --outfile=dist/server.mjs --external:@duckdb/node-api && node -e "require(\'fs\').copyFileSync(\'spec.json\',\'dist/spec.json\')"' },
    engines: { node: '>=22.18' },
    dependencies: { '@modelcontextprotocol/server': SDK_VERSION, ...(usesDuck ? { '@duckdb/node-api': '1.4.1-r.4' } : {}) },
    devDependencies: { esbuild: '^0.25.0' },
  };
  const settings = spec.env.map((e) => `- \`${e.name}\`${e.required ? ' (required)' : ''}${e.secret ? ' (secret)' : ''}: ${e.description}${e.default ? ` (default: ${e.default})` : ''}`).join('\n') || '- none';
  const tools = spec.tools.map((t) => `- **${t.name}**${t.annotations.readOnlyHint ? ' (read-only)' : t.annotations.destructiveHint ? ' (changes data, cannot be undone)' : ''}: ${t.description.split('\n')[0]}`).join('\n');
  const placeholder = (n: string) => `<${n}>`;
  const stdioCfg = { command: 'node', args: [`/path/to/${spec.name}/dist/server.mjs`], env: envBlock(spec, placeholder) };
  const readme = [
    `# ${spec.title ?? spec.name}`, '', spec.description, '',
    'An MCP server (Model Context Protocol) on the official TypeScript SDK, made with Agent Harness. It speaks the',
    '2026-07-28 protocol and the 2025 handshake, over stdio or streamable HTTP. What it offers is in `spec.json`;',
    '`server.ts` runs it.', '',
    '## Tools', '', tools, '',
    '## Settings (environment variables)', '', settings, '',
    '## Run it', '', '```bash', 'npm install', 'npm run bundle      # dist/server.mjs, one file', 'node dist/server.mjs                # stdio', 'node dist/server.mjs --http 3000    # http://127.0.0.1:3000/mcp (MCP_HTTP_TOKEN to require a token)', '```', '',
    '## Use it', '',
    '- **Claude Desktop**: open `' + spec.name + '.mcpb` (a bundle), or add `configs/claude_desktop_config.json` to yours.',
    '- **Claude Code**: `configs/mcp.json` as `.mcp.json` in a project, or `claude mcp add ' + spec.name + ' -- node /path/to/dist/server.mjs`.',
    '- **Cursor**: `configs/cursor-mcp.json` as `.cursor/mcp.json`.',
    '- **VS Code**: `configs/vscode-mcp.json` as `.vscode/mcp.json` (it asks for secrets).',
    '- **The MCP registry**: `server.json` describes it (publish the package first).', '',
  ].join('\n');
  // MCPB 0.3 (Claude Desktop extensions): the bundled server, its settings as user_config (secrets marked sensitive).
  const manifest = {
    manifest_version: '0.3', name: spec.name, display_name: spec.title ?? spec.name, version: spec.version, description: spec.description.slice(0, 300),
    author: { name: 'Agent Harness user' },
    server: { type: 'node', entry_point: 'server/server.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server/server.mjs'], env: envBlock(spec, (n) => `\${user_config.${n.toLowerCase()}}`) } },
    tools: spec.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 300) })),
    user_config: Object.fromEntries(spec.env.filter((e) => !e.default).map((e) => [e.name.toLowerCase(), { type: 'string', title: e.name, description: e.description, ...(e.required ? { required: true } : {}), ...(e.secret ? { sensitive: true } : {}) }])),
    compatibility: { runtimes: { node: '>=22.0.0' } },
  };
  // The registry's server.json (published as an npm package named like the server).
  const serverJson = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: `io.github.your-name/${spec.name}`, description: spec.description.slice(0, 100), version: spec.version,
    packages: [{ registryType: 'npm', identifier: spec.name, version: spec.version, transport: { type: 'stdio' }, environmentVariables: spec.env.map((e) => ({ name: e.name, description: e.description, isRequired: !!e.required, isSecret: !!e.secret })) }],
  };
  const vscode = { inputs: spec.env.filter((e) => e.secret).map((e) => ({ type: 'promptString', id: e.name.toLowerCase(), description: e.description, password: true })), servers: { [spec.name]: { type: 'stdio', command: 'node', args: stdioCfg.args, env: envBlock(spec, (n) => (spec.env.find((e) => e.name === n)?.secret ? `\${input:${n.toLowerCase()}}` : placeholder(n))) } } };
  const j = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    'server.ts': runtime,
    'spec.json': j(spec),
    'package.json': j(pkg),
    'README.md': readme,
    'manifest.json': j(manifest),
    'server.json': j(serverJson),
    'configs/claude_desktop_config.json': j({ mcpServers: { [spec.name]: stdioCfg } }),
    'configs/mcp.json': j({ mcpServers: { [spec.name]: { type: 'stdio', ...stdioCfg } } }),
    'configs/cursor-mcp.json': j({ mcpServers: { [spec.name]: stdioCfg } }),
    'configs/vscode-mcp.json': j(vscode),
    '.gitignore': 'node_modules/\ndist/\n*.mcpb\n',
  };
}

/** Writes the server to `dir` (its own files only; anything else there stays). */
export async function writeServer(dir: string, spec: BuildSpec): Promise<string[]> {
  const files = await serverFiles(spec);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  }
  return Object.keys(files);
}

export interface Check { name: string; ok: boolean; detail?: string }
export interface CheckReport { ok: boolean; checks: Check[]; protocol?: string; tools: number }

/**
 * Runs the server as a client would and checks it: the 2026 protocol and the 2025 handshake, stdio and HTTP, the
 * tools as the spec says (names, descriptions, schemas, hints), a call of each read-only tool with an example, a bad
 * call answered as an error. `env` gives the settings (a database file, a test key).
 */
export async function checkServer(dir: string, spec: BuildSpec, env: Record<string, string> = {}, o: { callWrites?: boolean } = {}): Promise<CheckReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, ...(detail ? { detail: detail.slice(0, 600) } : {}) }); };
  const cmd = localCommand(dir);
  // In the desktop app the harness's own program is Electron: it runs the server as Node.
  const childEnv = scrubbedEnv({ ...nodeEnv(), ...env });
  const start = () => spawn(cmd.command, cmd.args, { cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let protocol: string | undefined;
  const modern = new McpClient(new StdioTransport(start()), { callTimeoutMs: 60_000 });
  try {
    await modern.initialize();
    protocol = modern.protocol;
    add('starts and answers over stdio', true, `${modern.serverInfo?.name} ${modern.serverInfo?.version}`);
    add(`speaks MCP ${MCP_PROTOCOL_VERSION}`, modern.protocol === MCP_PROTOCOL_VERSION, `agreed ${modern.protocol}`);
    const tools = await modern.listTools();
    const want = spec.tools.map((t) => t.name).sort();
    const got = tools.map((t) => t.name).sort();
    add('lists every tool of the spec', JSON.stringify(want) === JSON.stringify(got), JSON.stringify(want) === JSON.stringify(got) ? `${got.length} tools` : `spec: ${want.join(', ')}; server: ${got.join(', ')}`);
    const badDefs = tools.filter((t) => !t.description || t.description.length < 10 || t.inputSchema?.type !== 'object' || !t.annotations || t.annotations.readOnlyHint === undefined);
    add('each tool has a description, an object schema and a read-only hint', !badDefs.length, badDefs.map((t) => t.name).join(', '));
    for (const t of spec.tools) {
      const run = t.example !== undefined && (t.annotations.readOnlyHint || o.callWrites);
      if (!run) continue;
      try {
        const r = await modern.callTool(t.name, t.example!);
        const out = (r.content ?? []).map((c) => c.text ?? '').join('\n');
        add(`${t.name} works (called with its example)`, !r.isError, out.slice(0, 300));
      } catch (e) { add(`${t.name} works (called with its example)`, false, (e as Error).message); }
    }
    // A tool with a required argument, called without it: an error result, not a crash.
    const strict = spec.tools.find((t) => Array.isArray(t.inputSchema.required) && (t.inputSchema.required as unknown[]).length);
    if (strict) {
      try { const r = await modern.callTool(strict.name, {}); add('a call without its required arguments is answered as an error', r.isError === true, (r.content?.[0]?.text ?? '').slice(0, 200)); } catch (e) { add('a call without its required arguments is answered as an error', /invalid|required|-32602/i.test((e as Error).message), (e as Error).message); }
    }
    try { await modern.callTool('no_such_tool_here', {}).then((r) => add('an unknown tool is refused', r.isError === true)); } catch { add('an unknown tool is refused', true); }
  } catch (e) {
    add('starts and answers over stdio', false, `${(e as Error).message}`);
  } finally { await modern.close(); }

  // The 2025 handshake (clients that do not know the 2026 protocol yet).
  const legacy = new McpClient(new StdioTransport(start()), { legacy: true, callTimeoutMs: 30_000 });
  try { await legacy.initialize(); add('answers the 2025 handshake too', /^2025-/.test(legacy.protocol ?? ''), legacy.protocol); } catch (e) { add('answers the 2025 handshake too', false, (e as Error).message); } finally { await legacy.close(); }

  // Streamable HTTP.
  const httpChild = spawn(cmd.command, [...cmd.args, '--http', '0'], { cwd: dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const t = setTimeout(() => reject(new Error('it did not start listening within 20s')), 20_000);
      httpChild.stdout.on('data', (d: Buffer) => { out += d.toString(); const m = /on (http:\/\/\S+\/mcp)/.exec(out); if (m) { clearTimeout(t); resolve(m[1]!); } });
      httpChild.on('exit', (c) => { clearTimeout(t); reject(new Error(`it exited (${c})`)); });
    });
    const c = new McpClient(new HttpTransport(url));
    try { await c.initialize(); const n = (await c.listTools()).length; add('serves streamable HTTP', n === spec.tools.length, `${n} tools at ${url}`); } finally { await c.close(); }
  } catch (e) { add('serves streamable HTTP', false, (e as Error).message); } finally { httpChild.kill(); }

  return { ok: checks.every((c) => c.ok), checks, ...(protocol ? { protocol } : {}), tools: spec.tools.length };
}

/**
 * The .mcpb bundle (Claude Desktop): the server bundled into one file with esbuild (the SDK inside), its spec, the
 * manifest. Without esbuild here, null and why.
 */
export async function packServer(dir: string, spec: BuildSpec): Promise<{ file: string; bytes: number } | { error: string }> {
  let esbuild: { build(o: Record<string, unknown>): Promise<unknown> };
  try { esbuild = await import('esbuild' as string) as typeof esbuild; } catch { return { error: 'esbuild is not installed with this harness: run "npm install && npm run bundle" in the server\'s folder, then pack it with "npx @anthropic-ai/mcpb pack"' }; }
  const out = path.join(dir, 'dist', 'server.mjs');
  // Resolved from the harness's own packages (the server's folder has none).
  await esbuild.build({
    entryPoints: [path.join(dir, 'server.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: out, logLevel: 'silent',
    external: ['@duckdb/node-api'], nodePaths: [path.resolve(here, '..', '..', '..', 'node_modules')],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  await fs.copyFile(path.join(dir, 'spec.json'), path.join(dir, 'dist', 'spec.json'));
  const files = [
    { name: 'manifest.json', data: await fs.readFile(path.join(dir, 'manifest.json')) },
    { name: 'server/server.mjs', data: await fs.readFile(out) },
    { name: 'server/spec.json', data: await fs.readFile(path.join(dir, 'spec.json')) },
    { name: 'README.md', data: await fs.readFile(path.join(dir, 'README.md')) },
  ];
  const file = path.join(dir, `${spec.name}.mcpb`);
  const buf = zip(files);
  await fs.writeFile(file, buf);
  return { file, bytes: buf.length };
}
