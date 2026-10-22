import fs from 'node:fs/promises';
import path from 'node:path';
import { composeGuide, guideSkillName, parseGuideMarkdown, purposeOf } from '../../packages/plugin-ui/src/guide.ts';
import type { UiManifest } from '../../packages/plugin-ui/src/manifest.ts';
import { within } from '../tools/paths.ts';
import type { Registry } from '../kernel/registry.ts';
import type { ClientDecl } from '../core/client.ts';
import type { Skill } from '../skills/skills.ts';
import { skillsIn } from '../skills/skills.ts';
import { readManifest } from './loader.ts';

// Plugin guides on the server (packages/plugin-ui/src/guide.ts): what a plugin is for and how to
// drive it, as the skill `<plugin>-guide` a desktop session loads when a task touches the plugin.
//
// The authored half is the plugin's own Markdown: `ui.guide` (a file in its folder), or a
// `<plugin>-guide` skill in its `skills` folder. The generated half is made each time it is loaded
// from what the plugin has now: its manifest's pages, menu, commands, settings, and the tools,
// workflows and agents its server half registered. The app's own plugins (core.*) have their guides
// in the app: their skill asks it (desktop_describe {plugin, guide}).

export interface PluginGuideInfo { purpose: string; file: string }
const MAX_GUIDE = 100_000;

/** Where a plugin's authored guide is, and its one-sentence purpose (its frontmatter, else its description). */
export async function readPluginGuide(dir: string, m: { name: string; description?: string; skills?: string; ui?: unknown }, ui?: UiManifest): Promise<{ guide?: PluginGuideInfo }> {
  const candidates: string[] = [];
  const declared = ui?.guide ?? (m.ui && typeof m.ui === 'object' && typeof (m.ui as { guide?: unknown }).guide === 'string' ? (m.ui as { guide: string }).guide : undefined);
  if (declared) candidates.push(declared);
  if (typeof m.skills === 'string') candidates.push(path.join(m.skills, guideSkillName(m.name), 'SKILL.md'));
  for (const rel of candidates) {
    const file = path.resolve(dir, rel);
    if (!within(path.resolve(dir), file)) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined) continue;
    return { guide: { file, purpose: purposeOf({ authored: text, description: m.description, name: m.name, title: ui?.displayName }) } };
  }
  return {};
}

/** A server plugin as a session sees it (the harness's plugin list). */
export interface GuidePlugin {
  name: string; description?: string; dir?: string; enabled: boolean; ui?: UiManifest;
  guide?: PluginGuideInfo; loaded?: { contributes: string[] };
}

/** The whole guide of a server plugin: its authored text and what it has now. */
export async function serverGuide(p: GuidePlugin, reg: Registry): Promise<string> {
  const authored = p.guide ? await fs.readFile(p.guide.file, 'utf8').then((t) => t.slice(0, MAX_GUIDE)).catch(() => undefined) : undefined;
  const contributes = p.loaded?.contributes ?? [];
  const tools = contributes.filter((c) => c.startsWith('tool:')).map((c) => reg.tools.get(c.slice(5))).filter((t) => !!t).map((t) => ({ name: t!.spec.name, description: t!.spec.description, input_schema: t!.spec.input_schema }));
  const workflows = [...reg.workflows.values()].filter((w) => w.source === p.name).map((w) => ({ name: w.name, description: (w as { description?: string }).description }));
  const agents = [...reg.agents.values()].filter((a) => a.source === p.name).map((a) => ({ name: a.name, description: a.description }));
  const gates = [...reg.gates.values()].filter((g) => (g as { plugin?: string }).plugin === p.name).map((g) => ({ name: g.name }));
  let skills: Array<{ name: string; description: string }> = [];
  if (p.dir) {
    const m = await readManifest(p.dir).catch(() => undefined);
    if (m?.skills) skills = (await skillsIn(path.resolve(p.dir, m.skills), p.name)).filter((s) => s.name !== guideSkillName(p.name)).map((s) => ({ name: s.name, description: s.description }));
  }
  return composeGuide({ name: p.name, title: p.ui?.displayName, description: p.description, ui: p.ui, authored, tools, workflows, agents, skills, gates });
}

export interface GuideSkillDeps {
  client: ClientDecl;
  plugins: () => GuidePlugin[];
  registry: Registry;
  /** Asks the attached app for one of its plugins' guides (desktop_describe {plugin, guide: true}). */
  askApp: (plugin: string, signal: AbortSignal) => Promise<string>;
  /** The session's tools now (an app plugin's guide gets the details of the tools it names). */
  tools?: () => Array<{ spec: { name: string; description: string; input_schema: unknown } }>;
}

/**
 * The guide skills of a desktop session: one per plugin of its index the server can serve - its own
 * plugins that are on and have a guide, and the app's built-ins (core.*, through desktop_describe).
 * A skill marks the plugin it guides (`guide`), so the session's <skills> listing leaves it out (the
 * client block lists it already).
 */
export function guideSkills(d: GuideSkillDeps): Skill[] {
  const out: Skill[] = [];
  for (const p of d.client.plugins ?? []) {
    const server = d.plugins().find((x) => x.name === p.name && x.enabled && x.guide);
    if (server) {
      out.push({ name: guideSkillName(p.name), description: server.guide!.purpose, source: p.name, guide: p.name, files: async () => [], load: async (file) => {
        if (file && file !== 'SKILL.md') throw new Error(`${guideSkillName(p.name)} has no other files`);
        const now = d.plugins().find((x) => x.name === p.name && x.enabled);
        if (!now) throw new Error(`${p.name} is switched off on the server now.`);
        return serverGuide(now, d.registry);
      } });
      continue;
    }
    if (p.from !== 'app' || !p.name.startsWith('core.') || !d.client.tools.includes('desktop_describe')) continue;
    out.push({ name: guideSkillName(p.name), description: p.purpose, source: p.name, guide: p.name, files: async () => [], load: async (file) => {
      if (file && file !== 'SKILL.md') throw new Error(`${guideSkillName(p.name)} has no other files`);
      const text = await d.askApp(p.name, AbortSignal.timeout(30_000));
      // The tools of the engine it drives, as this server has them.
      const have = d.tools?.() ?? [...d.registry.tools.values()];
      const details = (p.tools ?? []).map((n) => have.find((t) => t.spec.name === n)).filter((t) => !!t).map((t) => {
        const props = (t!.spec.input_schema as { properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>; required?: string[] }).properties ?? {};
        const req = new Set((t!.spec.input_schema as { required?: string[] }).required ?? []);
        return [`- \`${t!.spec.name}\`: ${t!.spec.description.replace(/\s+/g, ' ').slice(0, 600)}`, ...Object.entries(props).slice(0, 20).map(([k, v]) => `  - \`${k}\` (${v.type ?? 'any'}${req.has(k) ? ', required' : ''}${v.enum ? `, one of ${v.enum.map((e) => JSON.stringify(e)).join(', ')}` : ''})${v.description ? `: ${v.description.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)].join('\n');
      });
      return details.length ? `${text}\n\n### Tool details (as this server has them)\n${details.join('\n')}` : text;
    } });
  }
  return out;
}

/** Guide text a plugin's author wrote, without its frontmatter (tests and the docs). */
export function authoredBody(md: string): string { return parseGuideMarkdown(md).body; }
