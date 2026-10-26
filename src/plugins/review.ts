import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALLS } from '../../packages/plugin-ui/src/rpc.ts';
import { CAPABILITIES, ICON_NAMES as ICONS, validateUiManifest } from '../../packages/plugin-ui/src/manifest.ts';
import { validateWorkflow } from '../graph/validate.ts';
import { readManifest } from './loader.ts';
import { loadPlugin } from './testkit.ts';
import { pluginTestFiles, runPluginTests } from './run-tests.ts';

// A deep review of a plugin folder, before it is trusted with a person's data: `npm run plugin --
// check <dir> --deep`, the desktop app when a plugin is added, and agents (the plugin_review tool).
// It loads the plugin into a throwaway harness (the test kit) and goes through every part:
//  - the manifest (fields, typos, paths that exist, permissions it declares and uses);
//  - each tool: its name, description and parameter schema as an agent sees them, and the read tools
//    without required input called once (an exception, not an error result, is a bug);
//  - each route: served, answering signed-in callers without a server error, refusing anonymous ones
//    (auth "user"), and a POST with an empty body answered with a 4xx, not a crash;
//  - its pages: entries that exist, the SDK loaded, every SDK call covered by a declared capability
//    (and no capability declared but unused), routes.call paths that exist, nothing that needs the
//    network a page does not have, the theme followed;
//  - its code and files: what reaches past the api it is handed (child processes, eval, the
//    environment, the home folder), secrets written in files, size;
//  - skills, agents and workflows; and its own tests, run.
// Each finding says what is wrong and what to do; an error means it should not be used as it is.

export type Level = 'error' | 'warning' | 'info';
export interface Finding { level: Level; area: string; message: string; fix?: string }
export interface Review {
  ok: boolean;
  /** 100, less 20 per error and 4 per warning (never below 0). */
  score: number;
  plugin: string;
  version: string;
  dir: string;
  adds: { tools: string[]; skills: string[]; agents: string[]; workflows: string[]; gates: string[]; routes: string[]; pages: number };
  findings: Finding[];
  tests?: { files: number; passed: boolean; output: string };
  durationMs: number;
}

const KNOWN_KEYS = new Set(['name', 'version', 'description', 'main', 'skills', 'agents', 'outputStyles', 'mcpServers', 'hooks', 'workflows', 'permissions', 'ui', 'author', 'license', 'homepage', 'repository', 'keywords', 'solution', 'requires', '$schema']);
const KNOWN_PERMISSIONS = new Set(['network', 'secrets', 'vault', 'sessions', 'routes']);
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'a private key'],
  [/\bsk-(ant-|proj-)?[A-Za-z0-9_-]{24,}/, 'an API key (sk-...)'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bghp_[A-Za-z0-9]{30,}\b/, 'a GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{20,}/, 'a Slack token'],
];

export async function reviewPlugin(dir: string, o: { runTests?: boolean; testTimeoutMs?: number } = {}): Promise<Review> {
  const started = Date.now();
  const findings: Finding[] = [];
  const add = (level: Level, area: string, message: string, fix?: string) => findings.push({ level, area, message, ...(fix ? { fix } : {}) });
  const adds: Review['adds'] = { tools: [], skills: [], agents: [], workflows: [], gates: [], routes: [], pages: 0 };
  const done = (name: string, version: string, tests?: Review['tests']): Review => {
    const errors = findings.filter((f) => f.level === 'error').length;
    const warnings = findings.filter((f) => f.level === 'warning').length;
    const order: Record<Level, number> = { error: 0, warning: 1, info: 2 };
    findings.sort((a, b) => order[a.level] - order[b.level]);
    return { ok: errors === 0, score: Math.max(0, 100 - errors * 20 - warnings * 4), plugin: name, version, dir, adds, findings, ...(tests ? { tests } : {}), durationMs: Date.now() - started };
  };

  // ---- the manifest ----
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(await fs.readFile(path.join(dir, 'harness-plugin.json'), 'utf8')) as Record<string, unknown>; } catch (e) {
    add('error', 'manifest', (e as NodeJS.ErrnoException).code === 'ENOENT' ? `No harness-plugin.json in ${dir}.` : `harness-plugin.json is not valid JSON: ${(e as Error).message}`, 'A plugin is a folder with a harness-plugin.json (npm run plugin -- new <name> writes one).');
    return done(path.basename(dir), '?');
  }
  const m = await readManifest(dir).catch((e: Error) => { add('error', 'manifest', e.message); return undefined; });
  if (!m) return done(String(raw.name ?? path.basename(dir)), String(raw.version ?? '?'));
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) add('warning', 'manifest', `Unknown field "${k}" (ignored).`, `Check the spelling; the fields are ${[...KNOWN_KEYS].filter((x) => x !== '$schema').join(', ')}.`);
  if (!m.version || !/^\d+\.\d+\.\d+([-+].+)?$/.test(m.version)) add('warning', 'manifest', `"version" ${m.version ? `"${m.version}" is not` : 'is missing; it should be'} a version like 1.0.0.`);
  if (!m.description || m.description.length < 20) add('warning', 'manifest', 'The description is missing or very short.', 'One or two sentences on what it does: people see it before they add it, and agents read it.');
  for (const [key, what] of [['main', 'file'], ['skills', 'folder'], ['agents', 'folder'], ['workflows', 'folder'], ['outputStyles', 'folder']] as const) {
    const rel = m[key as 'main'];
    if (typeof rel !== 'string') continue;
    const st = await fs.stat(path.resolve(dir, rel)).catch(() => null);
    if (!st || (what === 'file' ? !st.isFile() : !st.isDirectory())) add('error', 'manifest', `"${key}" names ${rel}, which is not a ${what} in the plugin.`);
  }
  const perms = (m.permissions ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(perms)) if (!KNOWN_PERMISSIONS.has(k)) add('warning', 'permissions', `Unknown permission "${k}" (ignored).`, `The permissions are ${[...KNOWN_PERMISSIONS].join(', ')}.`);

  // ---- its files: code it runs, secrets, size ----
  const files = await listFiles(dir);
  const size = (await Promise.all(files.map((f) => fs.stat(path.join(dir, f)).then((s) => s.size).catch(() => 0)))).reduce((a, b) => a + b, 0);
  if (size > 20 * 1024 * 1024) add('warning', 'files', `The folder is ${(size / 1024 / 1024).toFixed(0)} MB.`, 'Leave out build output, recordings and node_modules; large plugins are slow to install and review.');
  const codeFiles = files.filter((f) => /\.(m?js|cjs|ts|mts)$/.test(f) && !/(^|\/)(test|tests|ui)\//.test(f) && !f.endsWith('.d.ts'));
  const code = new Map<string, string>();
  for (const f of codeFiles) code.set(f, await fs.readFile(path.join(dir, f), 'utf8').catch(() => ''));
  const allCode = [...code.values()].join('\n');
  for (const f of files.filter((x) => /\.(m?js|cjs|ts|mts|json|md|html|css|txt|env|ya?ml|toml)$/i.test(x) || !x.includes('.'))) {
    const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) add('error', 'security', `${f} holds what looks like ${what}.`, 'Never ship a secret in a plugin: declare it in permissions.secrets and read it with api.secret(NAME), or use the key vault (permissions.vault).');
  }
  if (files.some((f) => f === '.env' || f.endsWith('/.env'))) add('error', 'security', 'The plugin ships a .env file.', 'Remove it: secrets come from the server (api.secret) or the key vault.');
  for (const [f, text] of code) {
    if (/\bfrom\s+['"](node:)?child_process['"]|require\(['"](node:)?child_process['"]\)/.test(text)) add('warning', 'security', `${f} starts processes on the server (child_process).`, 'Tools run commands where the session runs with ctx.host.exec (sandboxed when the session is); child_process runs them on the server itself, outside any sandbox.');
    if (/\beval\(|new Function\(/.test(text)) add('warning', 'security', `${f} runs code from strings (eval / new Function).`);
    if (/process\.env\b/.test(text)) add('warning', 'security', `${f} reads the server's environment directly (process.env).`, 'Declare what it needs in permissions.secrets and read it with api.secret(NAME): undeclared reads bypass what the operator approved.');
    if (/os\.homedir\(\)|process\.cwd\(\)/.test(text)) add('info', 'files', `${f} works with the home or current folder.`, 'Keep the plugin\'s own data in api.dataDir (or api.store); the current folder is the server\'s, not a session\'s.');
    if (/\bfetch\(/.test(text.replace(/api\.fetch\(/g, ''))) add('warning', 'permissions', `${f} calls fetch directly.`, 'Use api.fetch: it reaches only the hosts in permissions.network and refuses private addresses.');
  }
  const network = ((perms.network as unknown[]) ?? []).map(String);
  if (network.length && !/api\.fetch\(|registerMcpServer|mcpServers/.test(allCode + JSON.stringify(m.mcpServers ?? {}) + JSON.stringify(m.hooks ?? {}))) add('warning', 'permissions', `It declares network hosts (${network.join(', ')}) but its code never calls api.fetch.`, 'Declare only what it uses: people are shown every permission before they add it.');
  if (!network.length && /api\.fetch\(/.test(allCode)) add('error', 'permissions', 'Its code calls api.fetch but it declares no network hosts: every call will be refused.', 'List the hosts in permissions.network, e.g. ["api.example.com"].');
  const usedSecrets = [...allCode.matchAll(/api\.secret\(\s*['"]([A-Za-z0-9_]+)['"]/g)].map((x) => x[1]!);
  const declaredSecrets = ((perms.secrets as unknown[]) ?? []).map(String);
  for (const s of usedSecrets.filter((x) => !declaredSecrets.includes(x))) add('error', 'permissions', `Its code reads the secret ${s} but permissions.secrets does not declare it: api.secret will throw.`, `Add "${s}" to permissions.secrets.`);
  for (const s of declaredSecrets.filter((x) => !usedSecrets.includes(x) && !JSON.stringify(m.mcpServers ?? {}).includes(x) && !JSON.stringify(m.hooks ?? {}).includes(x))) add('warning', 'permissions', `It declares the secret ${s} but never reads it.`);
  if (perms.sessions === true && !/api\.(sessions|events)\b/.test(allCode)) add('warning', 'permissions', 'It declares "sessions" (start and drive conversations, see every session\'s events) but never uses api.sessions or api.events.', 'Remove it: it is one of the strongest permissions.');
  if (/api\.(sessions\.start|sessions\.send|events\.subscribe)/.test(allCode) && perms.sessions !== true) add('error', 'permissions', 'Its code uses api.sessions or api.events without "permissions": {"sessions": true}: those calls will throw.');

  // ---- load it, as a server does ----
  let kit: Awaited<ReturnType<typeof loadPlugin>> | undefined;
  try { kit = await loadPlugin(dir); } catch (e) { add('error', 'load', `It could not be loaded: ${(e as Error).message}`); }
  const tests = async (): Promise<Review['tests'] | undefined> => {
    if (o.runTests === false) return undefined;
    const n = (await pluginTestFiles(dir)).length;
    if (!n) { add('warning', 'tests', 'It has no tests.', 'Add test/*.test.ts on the test kit (@harness/plugin-sdk/testing): its tools, routes and a scripted conversation. npm run plugin -- new writes examples.'); return undefined; }
    const r = await runPluginTests(dir, [], { capture: true, timeoutMs: o.testTimeoutMs ?? 5 * 60_000 }) as { code: number; output: string };
    const tail = r.output.split('\n').filter((l) => !/^\s+at /.test(l)).slice(-40).join('\n');
    if (r.code !== 0) add('error', 'tests', `Its tests fail (${n} file${n === 1 ? '' : 's'}).`, 'Run npm run plugin -- test <dir> and fix what fails.');
    return { files: n, passed: r.code === 0, output: tail };
  };
  if (!kit) return done(m.name, m.version ?? '0.0.0', await tests());
  try {
    if (kit.error) add('error', 'load', `It did not load: ${kit.error}`);
    const entry = kit.harness.plugins.get(m.name);
    if (entry?.uiError) add('error', 'pages', `Its ui section is not used: ${entry.uiError}`);
    for (const w of entry?.uiWarnings ?? []) add('warning', 'pages', w);
    Object.assign(adds, kit.adds);
    const reg = kit.harness.registry;
    const nothing = !adds.tools.length && !adds.skills.length && !adds.agents.length && !adds.workflows.length && !adds.gates.length && !adds.routes.length && !m.ui && !m.mcpServers;
    if (nothing && !kit.error) add('error', 'load', 'It adds nothing: no tools, skills, agents, workflows, gates, routes, MCP servers or pages.');

    // ---- tools ----
    // Named after the plugin (its whole name, or a word of it: desk_ for customer-desk), so they do not clash with other plugins'.
    const prefixes = [m.name.replace(/[-.]/g, '_'), ...m.name.split(/[-_.]/).filter((w) => w.length > 2)].map((p) => `${p}_`);
    const unprefixed = adds.tools.filter((n) => !prefixes.some((p) => n.startsWith(p)));
    if (unprefixed.length) add('info', 'tools', `Tool name${unprefixed.length > 1 ? 's' : ''} not named after the plugin: ${unprefixed.join(', ')}.`, `Start them with ${prefixes[0]} (or a word of the name): it keeps them from clashing with other plugins' tools and tells the agent where they come from.`);
    for (const name of adds.tools) {
      const t = reg.tools.get(name)!;
      const where = `tool ${name}`;
      const d = t.spec.description ?? '';
      if (d.length < 40) add('warning', where, 'Its description is very short. The description is all an agent knows about the tool.', 'Say what it does and when to use it, in one or two sentences.');
      else if (!/\b(use|when|call|for)\b/i.test(d)) add('info', where, 'Its description does not say when to use it.', 'Add "Use when ..." so the agent picks it at the right moment.');
      const schema = t.spec.input_schema as { type?: string; properties?: Record<string, { description?: string; type?: unknown }>; required?: string[] };
      if (schema?.type !== 'object') add('error', where, 'Its parameters are not a JSON Schema object ({"type": "object", "properties": {...}}).');
      const props = schema?.properties ?? {};
      for (const r of schema?.required ?? []) if (!props[r]) add('error', where, `"${r}" is required but is not among its properties.`);
      const undescribed = Object.entries(props).filter(([, p]) => !p?.description).map(([k]) => k);
      if (undescribed.length) add('warning', where, `Parameter${undescribed.length > 1 ? 's' : ''} without a description: ${undescribed.join(', ')}.`, 'Describe each one: its meaning, format and an example value.');
      if (t.kind === 'exec' && !/\b(run|exec|command|shell)\b/i.test(d)) add('info', where, 'Its kind is "exec" (the default): it is asked about like a shell command.', 'Set kind: "read" for a tool that only reads, "edit" for one that changes the plugin\'s data.');
      // A read tool needing no input: called once. A thrown exception (not an error result) is a bug.
      if (t.kind === 'read' && !(schema?.required ?? []).length) {
        try {
          const r = await withTimeout(kit.tool(name, {}), 30_000);
          if (r.isError && /^(TypeError|ReferenceError|SyntaxError|Cannot read|.* is not a function|.* is not defined)/.test(r.content)) add('error', where, `Called with no input, it crashed: ${r.content.slice(0, 200)}`, 'Catch what can go wrong and return { content: "what happened and what to do", is_error: true }.');
          if (r.content.length > 20_000) add('warning', where, `Its output is long (${Math.round(r.content.length / 1000)}K characters) on an empty plugin.`, 'Long output is paid for on every later step: summarize, page or limit it.');
        } catch (e) { add('error', where, `Called with no input, it did not answer: ${(e as Error).message}`); }
      }
    }
    if ((reg.tools.size && adds.tools.length) && /sendsOut/.test(allCode) === false && network.length) add('info', 'tools', 'It declares network hosts, so its tools count as sending data out unless they say sendsOut: false.', 'Set sendsOut: false on tools that keep everything local: they are then not confirmed after the agent read untrusted content.');

    // ---- routes ----
    for (const r of reg.routes.filter((x) => x.plugin === m.name)) {
      const where = `route ${r.method} ${r.path}`;
      if (r.auth === 'none') add('info', where, 'auth "none": every request reaches it, signed in or not.', 'Check the caller in the handler (a webhook\'s signature), or use auth "user" (signed-in) or "token".');
      try {
        if (r.method === 'GET') {
          const res = await withTimeout(kit.route('GET', r.path, { as: r.auth === 'user' ? 'operator' : 'anonymous' }), 30_000);
          if (res.status >= 500) add('error', where, `It fails (${res.status}): ${String(res.body?.error ?? res.text).slice(0, 200)}`, 'A route answers every request: catch errors and return a 4xx with a message for bad input.');
        } else {
          const res = await withTimeout(kit.route('POST', r.path, { body: {}, as: r.auth === 'user' ? 'operator' : 'anonymous' }), 30_000);
          if (res.status >= 500) add('error', where, `An empty body makes it fail (${res.status}): ${String(res.body?.error ?? res.text).slice(0, 200)}`, 'Check the body and answer 400 with what is missing.');
        }
        if (r.auth === 'user') {
          const anon = await withTimeout(kit.route(r.method, r.path, { as: 'anonymous', ...(r.method === 'POST' ? { body: {} } : {}) }), 30_000);
          if (anon.status !== 401) add('error', where, `Not signed in, it answered ${anon.status} instead of 401.`);
        }
      } catch (e) { add('error', where, `It did not answer: ${(e as Error).message}`); }
    }
    if (perms.routes === true && !reg.routes.some((x) => x.plugin === m.name)) add('warning', 'permissions', 'It declares "routes" but registers none.');

    // ---- pages ----
    // Its pages are reviewed even when its code did not load (from the manifest, validated the same way).
    let manifestUi: unknown;
    if (!entry?.ui && m.ui !== undefined) { try { manifestUi = validateUiManifest(m.ui, { trustCeiling: 'frame' }); } catch (e) { add('error', 'pages', `Its ui section is not valid: ${(e as Error).message}`); } }
    const ui = (entry?.ui ?? manifestUi) as { capabilities?: string[]; contributes?: Record<string, Array<Record<string, unknown>>>; icon?: string } | undefined;
    if (ui) {
      const declared = new Set(ui.capabilities ?? []);
      const entries = Object.values(ui.contributes ?? {}).flatMap((xs) => (Array.isArray(xs) ? xs : [])).map((x) => x.entry).filter((e): e is string => typeof e === 'string');
      adds.pages = new Set(entries).size;
      const used = new Set<string>();
      const routePaths = new Set(reg.routes.filter((x) => x.plugin === m.name).map((x) => x.path));
      for (const e of new Set(entries)) {
        const file = path.resolve(dir, e);
        const html = await fs.readFile(file, 'utf8').catch(() => undefined);
        const where = `page ${e}`;
        if (html === undefined) { add('error', where, `${e} is not in the plugin folder.`); continue; }
        // The page and the scripts it loads from the plugin.
        const scripts = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map((x) => x[1]!);
        let text = html;
        for (const s of scripts) {
          if (/^https?:\/\//i.test(s)) add('error', where, `It loads a script from the web (${s}); pages may load only their own files and the SDK.`, 'Copy the library into the plugin folder and load it from there.');
          else if (!s.startsWith('harness://')) text += '\n' + await fs.readFile(path.resolve(path.dirname(file), s), 'utf8').catch(() => { add('error', where, `It loads ${s}, which is not in the plugin folder.`); return ''; });
        }
        // Its own stylesheets count for the theme.
        for (const x of html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/gi)) if (!/^(https?|harness):/i.test(x[1]!)) text += '\n' + await fs.readFile(path.resolve(path.dirname(file), x[1]!), 'utf8').catch(() => '');
        const usesSdk = /HarnessPluginUI/.test(text);
        if (usesSdk && !scripts.some((s) => s.includes('sdk/plugin-ui.js'))) add('error', where, 'It uses HarnessPluginUI but does not load the SDK.', 'Add <script src="harness://app/sdk/plugin-ui.js"></script> before your own scripts.');
        if (/\bfetch\(|XMLHttpRequest|new WebSocket|EventSource\(/.test(text)) add('error', where, 'It reaches the network (fetch / XMLHttpRequest / WebSocket): pages have none.', 'Get data through the plugin\'s own routes (harness.routes.call) and let the server half call out with api.fetch.');
        if (/<link[^>]+href=["']https?:/i.test(html)) add('error', where, 'It loads a stylesheet or font from the web; pages may load only their own files.');
        if (!/var\(--hx-|plugin-ui\.css|hx-page|class="hx|\.theme\b|theme\.(vars|onChange)/.test(text)) add('warning', where, 'It does not use the theme (the --hx-* variables or the UI kit): it will look out of place, and wrong in dark mode.', 'Load harness://app/sdk/plugin-ui.css and build with HarnessPluginUI.ui, or use var(--hx-bg), var(--hx-text-primary)...');
        for (const x of text.matchAll(/\.\s*(sessions|events|approvals|routes|files|workflows|settings|clipboard|browser|external)\s*\.\s*(\w+)\s*\(/g)) {
          const method = `${x[1]}.${x[2]}`;
          if (!Object.hasOwn(CALLS, method)) { if (x[1] !== 'settings' || !['get', 'set'].includes(x[2]!)) add('warning', where, `${method}() is not an SDK call.`); continue; }
          const cap = CALLS[method]!.capability;
          if (cap) { used.add(cap); if (!declared.has(cap)) add('error', where, `It calls ${method}, which needs the "${cap}" capability; the manifest does not declare it, so the call will fail.`, `Add "${cap}" to ui.capabilities.`); }
        }
        // The raw protocol too: call('routes.call', ...) or harness.call('sessions.list', ...).
        for (const x of text.matchAll(/\bcall\(\s*['"]([a-z]+\.[a-zA-Z]+)['"]/g)) {
          const spec = Object.hasOwn(CALLS, x[1]!) ? CALLS[x[1]!] : undefined;
          if (spec?.capability) { used.add(spec.capability); if (!declared.has(spec.capability)) add('error', where, `It calls ${x[1]}, which needs the "${spec.capability}" capability; the manifest does not declare it, so the call will fail.`, `Add "${spec.capability}" to ui.capabilities.`); }
        }
        for (const x of text.matchAll(/routes\.call\(\s*['"`]([^'"`$]+)['"`]|call\(\s*['"]routes\.call['"]\s*,\s*\{\s*path:\s*['"]([^'"]+)['"]/g)) {
          const rp = x[1] ?? x[2]!;
          if (!routePaths.has(rp.replace(/^\//, '').split('?')[0]!)) add('error', where, `It calls the route "${rp}", which the plugin does not register.`, `Registered: ${[...routePaths].join(', ') || 'none'}.`);
        }
      }
      for (const c of declared) {
        if (!(CAPABILITIES as readonly string[]).includes(c)) continue;
        if (!used.has(c)) add('warning', 'pages', `It declares the "${c}" capability but no page uses it.`, 'Declare only what its pages call: people are asked to allow each one.');
      }
    }

    // ---- skills, agents, workflows ----
    for (const s of adds.skills) {
      const sk = (await Promise.all(reg.skillDirs.filter((d) => d.source === m.name).map((d) => fs.readFile(path.join(d.dir, s, 'SKILL.md'), 'utf8').catch(() => '')))).find(Boolean) ?? '';
      const desc = /^description:\s*(.+)$/m.exec(sk)?.[1] ?? '';
      if (desc.length < 40) add('warning', `skill ${s}`, 'Its description is short: it is how the agent decides to load the skill.', 'Say what it covers and when to use it ("Use when ...").');
      for (const t of new Set([...sk.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+)\b/g)].map((x) => x[1]!))) {
        if (t.startsWith(m.name.replace(/-/g, '_')) && !reg.tools.has(t)) add('warning', `skill ${s}`, `It names the tool ${t}, which does not exist.`);
      }
    }
    if (m.skills && !adds.skills.length) add('warning', 'skills', `"skills" names ${m.skills}, but no skill was found there.`, 'Each skill is a folder with a SKILL.md that starts with name and description frontmatter.');
    for (const w of adds.workflows) for (const err of validateWorkflow(reg.workflows.get(w)!)) add('error', `workflow ${w}`, err);
    if (ui && !ui.icon) add('info', 'pages', 'It has no icon (ui.icon); it shows as a puzzle piece.', `Pick one of the app's icons: ${ICONS.slice(0, 12).join(', ')}, ...`);
    if (!(entry as { guide?: unknown } | undefined)?.guide && (adds.tools.length > 2 || adds.routes.length)) add('info', 'agents', 'It has no guide for agents (ui.guide).', 'A short GUIDE.md (what it does, its tools, where its data is) lets desktop sessions use it well; set "ui": {"guide": "GUIDE.md"}.');
  } finally { await kit.close(); }

  // ---- its types, when it has a tsconfig ----
  if (await fs.stat(path.join(dir, 'tsconfig.json')).catch(() => null)) {
    const tsc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'typescript', 'bin', 'tsc');
    if (await fs.stat(tsc).catch(() => null)) {
      const r = await runCapture(process.execPath, [tsc, '-p', dir, '--noEmit'], dir, 120_000);
      if (r.code !== 0) add('warning', 'types', `Its types do not check (${r.output.split('\n').filter((l) => /error TS/.test(l)).length} errors): ${r.output.split('\n').find((l) => /error TS/.test(l))?.trim() ?? r.output.slice(0, 200)}`, 'Run the TypeScript compiler on it (tsc -p <dir>) and fix them.');
    }
  }
  return done(m.name, m.version ?? '0.0.0', await tests());
}

/** The review as text: a verdict, then the findings by level. */
export function formatReview(r: Review): string {
  const mark: Record<Level, string> = { error: 'ERROR  ', warning: 'WARNING', info: 'INFO   ' };
  const adds = Object.entries(r.adds).filter(([, v]) => (Array.isArray(v) ? v.length : v)).map(([k, v]) => `${Array.isArray(v) ? v.length : v} ${k}`).join(', ');
  const lines = [
    `${r.plugin} ${r.version}: ${r.ok ? 'OK' : 'NOT READY'} (score ${r.score}/100, ${(r.durationMs / 1000).toFixed(1)} s)`,
    `adds: ${adds || 'nothing'}`,
    ...(r.tests ? [`tests: ${r.tests.files} file(s), ${r.tests.passed ? 'passing' : 'FAILING'}`] : []),
    '',
    ...r.findings.map((f) => `${mark[f.level]} [${f.area}] ${f.message}${f.fix ? `\n         -> ${f.fix}` : ''}`),
    ...(r.findings.length ? [] : ['No findings.']),
    ...(r.tests && !r.tests.passed ? ['', 'Test output (end):', r.tests.output] : []),
  ];
  return lines.join('\n');
}

/**
 * The review in a child process (the engine and the desktop app run it so): a plugin whose setup hangs
 * or crashes cannot take the caller with it, and its code is imported fresh every time.
 */
export async function reviewInChild(dir: string, o: { timeoutMs?: number; runTests?: boolean } = {}): Promise<Review> {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
  const r = await runCapture(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'check', dir, '--deep', '--json', ...(o.runTests === false ? ['--no-tests'] : [])], dir, o.timeoutMs ?? 8 * 60_000, { ELECTRON_RUN_AS_NODE: '1' });
  const start = r.stdout.indexOf('{');
  try { return JSON.parse(r.stdout.slice(start)) as Review; } catch {
    return { ok: false, score: 0, plugin: path.basename(dir), version: '?', dir, adds: { tools: [], skills: [], agents: [], workflows: [], gates: [], routes: [], pages: 0 }, findings: [{ level: 'error', area: 'review', message: `The review did not finish: ${(r.output || `exit ${r.code}`).split('\n').filter(Boolean).slice(-5).join(' | ').slice(0, 600)}` }], durationMs: 0 };
  }
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r); else if (e.isFile()) out.push(r);
      if (out.length > 5000) return;
    }
  };
  await walk(dir, '');
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer within ${ms / 1000} s`)), ms); })]).finally(() => clearTimeout(t));
}

function runCapture(cmd: string, args: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', output = '';
    child.stdout.on('data', (c) => { stdout += c; output += c; });
    child.stderr.on('data', (c) => { output += c; });
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on('exit', (code) => { clearTimeout(t); resolve({ code: code ?? 1, stdout, output }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 1, stdout, output: e.message }); });
  });
}
