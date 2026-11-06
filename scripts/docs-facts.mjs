// npm run docs: writes docs/guide/07-generated-reference.md from the code, so the facts that go stale are never typed
// by hand. npm run docs -- --check says whether the file is current (test/docs.test.ts runs it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'guide', '07-generated-reference.md');
const check = process.argv.includes('--check');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
// What this machine has set must not change the file.
for (const k of Object.keys(process.env)) if (/^HARNESS_|_API_KEY$/.test(k)) delete process.env[k];
process.env.HARNESS_PLUGIN_LOOPS = 'off';

const { createHarness } = await imp('src/kernel/harness.ts');
const { shippedPluginDirs } = await imp('src/plugins/shipped.ts');
const { BUILTIN_TOOLS } = await imp('src/tools/index.ts');
const { HOOK_EVENTS } = await imp('src/core/settings.ts');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-facts-'));
const h = await createHarness({ dataDir: data, memory: 'off', search: null, plugins: [path.join(root, 'plugins')], shippedPlugins: shippedPluginDirs(root), scheduler: false, backgroundWork: false, log: () => {} });
const r = h.registry;

const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const first = (s) => { const t = cell(s); const m = /^.{20,220}?[.:;](?=\s|$)/.exec(t); return m ? m[0].replace(/[:;]$/, '.') : t.slice(0, 220); };
const by = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((x) => `| ${x.join(' | ')} |`)].join('\n');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const price = (n) => (typeof n === 'number' ? `$${n}` : '');
// A fixed moment: a provider's price can depend on the hour, and this file must not.
const STANDARD_HOURS = new Date(Date.UTC(2026, 0, 3, 12));

const models = r.listModels().map((m) => ({ ...m })).sort(by('id'));
const tools = BUILTIN_TOOLS.map((t) => ({ name: t.spec.name, kind: t.kind, about: first(t.spec.description) })).sort(by('name'));
const pluginDirs = fs.readdirSync(path.join(root, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(root, 'plugins', e.name, 'harness-plugin.json'))).map((e) => e.name).sort();
const manifests = pluginDirs.map((n) => json(`plugins/${n}/harness-plugin.json`));
const solutions = fs.readdirSync(path.join(root, 'solutions'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const agents = [...r.agents.values()].map((a) => ({ name: a.name, about: first(a.description) })).sort(by('name'));
const workflows = [...r.workflows.values()].map((w) => ({ name: w.name, about: first(w.description) })).sort(by('name'));
const gates = [...r.gates.values()].map((g) => ({ name: g.name, about: first(g.description) })).sort(by('name'));
const api = [...read('src/plugins/api.ts').slice(read('src/plugins/api.ts').indexOf('export interface PluginAPI')).matchAll(/^ {2}(?:readonly )?([a-zA-Z]+)[(?:]/gm)].map((m) => m[1]);

// Every HARNESS_ setting the code reads, and the line the README gives it, if any.
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) { if (!['node_modules', 'dist', 'test', 'release'].includes(e.name)) walk(p); } else if (/\.(ts|tsx|mjs)$/.test(e.name)) files.push(p); } };
for (const d of ['src', 'plugins', 'apps/desktop/electron']) walk(d);
const names = new Set();
for (const f of files) for (const m of read(f).matchAll(/\b(HARNESS_[A-Z0-9_]+)\b/g)) names.add(m[1]);
const readme = read('README.md');
const documented = (n) => { const m = new RegExp(`^\\| \`${n}\`[^|]*\\|([^|]*)\\|(.*)\\|\\s*$`, 'm').exec(readme); return m ? { dflt: cell(m[1]), about: first(m[2]) } : undefined; };
const settings = [...names].sort().map((n) => ({ n, d: documented(n), mentioned: readme.includes(n) }));

const rootPkg = json('package.json');
const desktopPkg = json('apps/desktop/package.json');
const body = `# Reference generated from the code

This file is written by \`npm run docs\`. Do not edit it by hand: \`test/docs.test.ts\` fails when it differs from the code.

Version ${rootPkg.version}. Node ${cell(rootPkg.engines?.node)}. Electron ${desktopPkg.devDependencies?.electron ?? desktopPkg.dependencies?.electron}.

## Models

Prices are USD per million tokens. A model needs its provider's key to be available.

${table(['Model', 'Provider', 'Context', 'Max output', 'Input', 'Cached input', 'Output'], models.map((m) => { const p = m.rate?.(1000, STANDARD_HOURS); return [`\`${m.id}\``, m.provider, m.contextWindow ?? '', m.maxOutput ?? '', price(p?.input), price(p?.cacheRead), price(p?.output)]; }))}

## Built-in tools

\`kind\` is what the permission system judges a call by.

${table(['Tool', 'Kind', 'What it does'], tools.map((t) => [`\`${t.name}\``, t.kind, t.about]))}

## Plugins that ship with the core

${table(['Plugin', 'Version', 'What it adds'], manifests.map((m) => [`\`${m.name}\``, m.version, first(m.description)]))}

Solutions, each with its own version and installed separately: ${solutions.map((s) => `\`${s}\``).join(', ')}.

## Agent types

${table(['Agent', 'What it is for'], agents.map((a) => [`\`${a.name}\``, a.about]))}

## Workflows

${table(['Workflow', 'What it does'], workflows.map((w) => [`\`${w.name}\``, w.about]))}

## Quality gates

${table(['Gate', 'What it checks'], gates.map((g) => [`\`${g.name}\``, g.about]))}

## Hook events

${HOOK_EVENTS.map((e) => `\`${e}\``).join(', ')}

## The plugin API

What a plugin's \`setup(api)\` is given. Types: \`@harness/plugin-sdk\`.

${[...new Set(api)].map((a) => `\`${a}\``).join(', ')}

## Settings

Every \`HARNESS_\` environment variable the code reads. The description comes from the README's table; "see README" means the README mentions it elsewhere.

${table(['Variable', 'Default', 'What it does'], settings.map((s) => [`\`${s.n}\``, s.d?.dflt ?? '', s.d?.about ?? (s.mentioned ? 'see README' : 'internal, or not documented yet')]))}
`;

await h.close?.();
fs.rmSync(data, { recursive: true, force: true });
if (check) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now !== body) { console.error('docs/guide/07-generated-reference.md is out of date: run npm run docs'); process.exit(1); }
  console.log('generated reference is current');
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  console.log(`${path.relative(root, out)}: ${models.length} models, ${tools.length} tools, ${manifests.length} plugins, ${agents.length} agents, ${workflows.length} workflows, ${gates.length} gates, ${settings.length} settings (${settings.filter((s) => !s.mentioned).length} not in the README)`);
}
process.exit(0);
