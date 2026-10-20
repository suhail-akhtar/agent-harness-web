import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAgentDir } from '../agents/agents.ts';
import type { Registry } from '../kernel/registry.ts';
import type { PluginAPI, PluginDefinition, PluginManifest } from './api.ts';

// Plugins are folders with a harness-plugin.json. The operator lists plugin
// directories (HARNESS_PLUGINS); those are TRUSTED: their code runs in the
// server. Code never loads from a workspace - a repository can only contribute
// declaratively, per session (see the session's project loading).

export const MANIFEST = 'harness-plugin.json';

export async function readManifest(dir: string): Promise<PluginManifest | undefined> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, MANIFEST), 'utf8')) as PluginManifest;
    if (!m || typeof m.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(m.name)) throw new Error('manifest needs a valid "name"');
    return m;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${path.join(dir, MANIFEST)}: ${(err as Error).message}`);
  }
}

/** A plugin dir, or a dir of plugin dirs. */
export async function findPluginDirs(root: string): Promise<string[]> {
  if (await readManifest(root).catch(() => undefined)) return [root];
  let names: string[];
  try { names = await fs.readdir(root); } catch { return []; }
  const out: string[] = [];
  for (const n of names.sort()) {
    const d = path.join(root, n);
    try { if ((await fs.stat(d)).isDirectory() && (await fs.stat(path.join(d, MANIFEST)).catch(() => null))) out.push(d); } catch { /* skip */ }
  }
  return out;
}

export async function loadPlugin(reg: Registry, dir: string, log: (m: string) => void = () => {}): Promise<void> {
  const m = await readManifest(dir);
  if (!m) throw new Error(`no ${MANIFEST} in ${dir}`);
  if (reg.plugins.some((p) => p.name === m.name)) throw new Error(`plugin ${m.name} is loaded twice`);
  const contributes: string[] = [];
  const within = (rel: string) => {
    const p = path.resolve(dir, rel);
    if (!p.startsWith(path.resolve(dir) + path.sep) && p !== path.resolve(dir)) throw new Error(`${m.name}: path ${rel} leaves the plugin folder`);
    return p;
  };

  if (m.skills) { reg.skillDirs.push({ dir: within(m.skills), source: m.name }); contributes.push('skills'); }
  if (m.agents) {
    for (const a of await loadAgentDir(within(m.agents), m.name)) {
      if (!reg.agents.has(a.name)) reg.agents.set(a.name, a);
    }
    contributes.push('agents');
  }
  for (const [name, cfg] of Object.entries(m.mcpServers ?? {})) {
    reg.mcpServers.set(name, { ...cfg, plugin: m.name } as never);
    contributes.push(`mcp:${name}`);
  }
  for (const [ev, specs] of Object.entries(m.hooks ?? {})) {
    (reg.shellHooks[ev as keyof typeof reg.shellHooks] ??= []).push(...(specs ?? []));
    contributes.push(`hooks:${ev}`);
  }

  if (m.main) {
    const mod = await import(pathToFileURL(within(m.main)).href) as { default?: PluginDefinition };
    const def = mod.default;
    if (!def || typeof def.setup !== 'function') throw new Error(`${m.name}: ${m.main} must default-export definePlugin({...})`);
    const api: PluginAPI = {
      pluginName: m.name,
      pluginDir: dir,
      registerTool: (t) => { reg.addTool(t, m.name); contributes.push(`tool:${t.spec.name}`); },
      registerModel: (spec) => { reg.models.set(spec.id, spec); contributes.push(`model:${spec.id}`); },
      registerProvider: (id, p) => { reg.providers.set(id, p); contributes.push(`provider:${id}`); },
      registerAgent: (a) => { reg.agents.set(a.name, { ...a, source: m.name }); contributes.push(`agent:${a.name}`); },
      registerSkills: (d) => { reg.skillDirs.push({ dir: path.resolve(dir, d), source: m.name }); contributes.push('skills'); },
      registerMcpServer: (name, cfg) => { reg.mcpServers.set(name, { ...cfg, plugin: m.name } as never); contributes.push(`mcp:${name}`); },
      registerGate: (g) => { reg.gates.set(g.name, { ...g, plugin: m.name }); contributes.push(`gate:${g.name}`); },
      on: (event, handler, matcher) => { reg.hooks.push({ event, handler, matcher, plugin: m.name }); contributes.push(`hook:${event}`); },
      log: (msg) => log(`[${m.name}] ${msg}`),
    };
    await def.setup(api);
  }
  reg.plugins.push({ name: m.name, version: m.version ?? '0.0.0', description: m.description ?? '', dir, trusted: true, contributes: [...new Set(contributes)] });
}
