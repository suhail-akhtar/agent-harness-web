// npm run plugin -- keygen <name> [--out dir]      writes <name>.key.pem (keep secret) and <name>.pub.pem
//                   sign <plugin-dir> --key <name>.key.pem
//                   verify <plugin-dir> --keys <pub.pem or folder>
//                   pack <plugin-dir> [--out file.tgz]   an archive for a remote catalogue (sign first)
//                   index <folder of .tgz> [--base url]   writes index.json for those archives
//                   check <plugin-dir> [--deep] [--json]  loads it as the server would and lists what it adds (exit 1 on a problem);
//                                                         --deep reviews it all (src/plugins/review.ts): tools called, routes served, pages, permissions, its tests
//                   new <name> [--dir <folder>] [--js]    writes a complete plugin to change into yours (src/plugins/scaffold.ts)
//                   test <plugin-dir> [-- node --test args]  runs the plugin's tests (test/**/*.test.*) with @harness/plugin-sdk importable
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pack, unpack } from './archive.ts';
import { readManifest } from './loader.ts';
import { createHarness } from '../kernel/harness.ts';
import { validateWorkflow } from '../graph/validate.ts';
import { skillsIn } from '../skills/skills.ts';
import { generateKeyPair, loadTrustedKeys, signPlugin, verifyPlugin } from './signing.ts';
import { runPluginTests } from './run-tests.ts';
import { fileURLToPath } from 'node:url';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [cmd, target] = process.argv.slice(2);

if (cmd === 'keygen' && target) {
  const out = path.resolve(arg('out') ?? '.');
  const k = generateKeyPair();
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, `${target}.key.pem`), k.privatePem, { mode: 0o600 });
  await fs.writeFile(path.join(out, `${target}.pub.pem`), k.publicPem);
  console.log(`key ${k.keyId}: ${path.join(out, `${target}.key.pem`)} (secret) and ${path.join(out, `${target}.pub.pem`)} (give this to operators)`);
} else if (cmd === 'sign' && target && arg('key')) {
  const s = await signPlugin(path.resolve(target), await fs.readFile(arg('key')!, 'utf8'));
  console.log(`signed ${Object.keys(s.files).length} files with key ${s.keyId}`);
} else if (cmd === 'verify' && target && arg('keys')) {
  const v = await verifyPlugin(path.resolve(target), await loadTrustedKeys(path.resolve(arg('keys')!)));
  console.log(v.ok ? `OK: ${v.files} files, signed by ${v.keyName} (${v.keyId})` : `REFUSED: ${v.reason}`);
  process.exit(v.ok ? 0 : 1);
} else if (cmd === 'pack' && target) {
  const dir = path.resolve(target);
  const m = await readManifest(dir);
  if (!m) { console.error(`no harness-plugin.json in ${dir}`); process.exit(1); }
  const out = path.resolve(arg('out') ?? `${m.name}-${m.version ?? '0.0.0'}.tgz`);
  const data = await pack(dir);
  await fs.writeFile(out, data);
  console.log(`${out}\nsha256 ${crypto.createHash('sha256').update(data).digest('hex')}`);
} else if (cmd === 'index' && target) {
  const dir = path.resolve(target);
  const plugins = [];
  for (const f of (await fs.readdir(dir)).filter((x) => x.endsWith('.tgz')).sort()) {
    const data = await fs.readFile(path.join(dir, f));
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-index-'));
    try {
      await unpack(data, path.join(tmp, 'p'));
      const m = await readManifest(path.join(tmp, 'p'));
      if (!m) { console.error(`skipped ${f}: no harness-plugin.json`); continue; }
      plugins.push({ name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '', url: arg('base') ? new URL(f, arg('base')!.replace(/\/?$/, '/')).toString() : f, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  }
  await fs.writeFile(path.join(dir, 'index.json'), JSON.stringify({ plugins }, null, 2));
  console.log(`index.json: ${plugins.length} plugin(s)`);
} else if (cmd === 'check' && target && process.argv.includes('--deep')) {
  const { reviewPlugin, formatReview } = await import('./review.ts');
  const r = await reviewPlugin(path.resolve(target), { runTests: !process.argv.includes('--no-tests') });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReview(r));
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'check' && target) {
  process.exit(await check(path.resolve(target)));
} else if (cmd === 'new' && target) {
  const { scaffold } = await import('./scaffold.ts');
  const dir = path.resolve(arg('dir') ?? target);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = await scaffold(dir, target, { js: process.argv.includes('--js'), repoRoot });
  console.log([`${target}: ${files.length} files in ${dir}`, ...files.map((f) => `  ${f}`), '', 'Next:', `  npm run plugin -- test ${dir}`, `  npm run plugin -- check ${dir} --deep`, `  Desktop app: Plugins > Developer > Load a plugin folder... (${dir})`].join('\n'));
} else if (cmd === 'test' && target) {
  // --keys: the environment's API keys reach the tests (for tests on real models); without it they are removed.
  process.exit(await runPluginTests(path.resolve(target), process.argv.slice(process.argv.indexOf(target) + 1).filter((a) => a !== '--' && a !== '--keys'), { keys: process.argv.includes('--keys') }) as number);
} else {
  console.error('usage: npm run plugin -- new <name> [--dir d] [--js] | check <dir> [--deep] [--json] | test <dir> | keygen <name> [--out dir] | sign <dir> --key <x.key.pem> | verify <dir> --keys <pub.pem|dir> | pack <dir> [--out f.tgz] | index <dir> [--base url]');
  process.exit(2);
}

/**
 * Loads a plugin folder the way the server does (in a throwaway data folder) and says what it adds:
 * its tools, skills, agents, workflows (each checked), gates, routes and UI. A problem (no manifest,
 * code that throws, a bad ui section, a broken workflow, a name taken) is printed and exits 1.
 */
async function check(dir: string): Promise<number> {
  const m = await readManifest(dir).catch((e: Error) => { console.error(`harness-plugin.json: ${e.message}`); return null; });
  if (!m) { console.error(`no valid harness-plugin.json in ${dir}`); return 1; }
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'hw-check-'));
  const logs: string[] = [];
  const problems: string[] = [];
  const h = await createHarness({ dataDir: data, plugins: [dir], backgroundWork: false, scheduler: false, search: null, log: (x) => logs.push(x) });
  try {
    const e = h.plugins.list().find((x) => x.name === m.name);
    if (!e) problems.push(`it did not load: ${logs.filter((l) => l.includes(m.name) || /plugin/i.test(l)).join(' | ') || 'no reason given'}`);
    if (e?.error) problems.push(`it did not load: ${e.error}`);
    if (e?.uiError) problems.push(`its ui section is not used: ${e.uiError}`);
    const reg = h.registry;
    const mine = <T>(map: Map<string, T>) => [...map.entries()].filter(([, v]) => reg.ownerOf(v) === m.name).map(([k]) => k);
    const tools = mine(reg.tools);
    const agents = mine(reg.agents);
    const workflows = mine(reg.workflows);
    const gates = [...reg.gates.values()].filter((g) => g.plugin === m.name).map((g) => g.name);
    const routes = reg.routes.filter((r) => r.plugin === m.name).map((r) => `${r.method} /api/plugins/${m.name}/${r.path} (auth ${r.auth})`);
    const skills = (await Promise.all(reg.skillDirs.filter((d) => d.dir.startsWith(dir)).map((d) => skillsIn(d.dir, d.source)))).flat().map((x) => x.name);
    for (const w of workflows) for (const err of validateWorkflow(reg.workflows.get(w)!)) problems.push(`workflow ${w}: ${err}`);
    const list = (label: string, xs: string[]) => console.log(`${label.padEnd(10)} ${xs.length ? xs.join(', ') : '-'}`);
    console.log(`${m.name} ${m.version ?? '0.0.0'}${e?.signature ? ` (${e.signature})` : ''}`);
    list('tools', tools); list('skills', skills); list('agents', agents); list('workflows', workflows); list('gates', gates); list('routes', routes);
    const ui = e?.ui as { contributes?: Record<string, unknown[]> } | undefined;
    list('ui', ui?.contributes ? Object.entries(ui.contributes).filter(([, v]) => Array.isArray(v) && v.length).map(([k, v]) => `${v.length} ${k}`) : []);
    if (e && !tools.length && !skills.length && !agents.length && !workflows.length && !gates.length && !routes.length && !ui?.contributes) problems.push('it adds nothing (no tools, skills, agents, workflows, gates, routes or ui)');
    for (const w of e?.uiWarnings ?? []) console.error(`WARNING: ${w}`);
    for (const x of problems) console.error(`PROBLEM: ${x}`);
    console.log(problems.length ? `${problems.length} problem(s)` : 'OK');
    return problems.length ? 1 : 0;
  } finally { await h.close(); await fs.rm(data, { recursive: true, force: true }); }
}
