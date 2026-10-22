/**
 * A plugin's guide for agents: what the plugin is for and how to drive it, as one Markdown skill
 * (`<plugin>-guide`) a model loads when a task touches that plugin.
 *
 * Two halves, merged: the text its author wrote (`ui.guide`, or a `<plugin>-guide` skill in its
 * `skills` folder: purpose, when to use it, worked examples), and sections generated here from what
 * the plugin really has - its pages and menu (desktop_open targets), panels, agent-callable commands
 * with their argument schemas, the person's commands and slash commands, settings, renderers, the
 * tools, workflows and agents of its server half. The generated half is made from the manifest each
 * time, so it never goes stale; the authored half says what a manifest cannot.
 *
 * Pure: shared by the server (its plugins) and the desktop (its built-ins); unit-tested in
 * test/desktop-modules.test.ts.
 */

import { qualify, type JsonSchema, type MenuItemRef, type UiAction, type UiManifest } from './manifest.ts';

export interface GuideTool { name: string; description?: string; input_schema?: unknown }
export interface GuideNamed { name: string; description?: string }

export interface GuideSource {
  name: string;
  /** The display name (ui.displayName). */
  title?: string;
  /** The plugin's description (harness-plugin.json). */
  description?: string;
  ui?: UiManifest;
  /** Tools of its server half (with their specs where the caller has them). */
  tools?: GuideTool[];
  workflows?: GuideNamed[];
  agents?: GuideNamed[];
  skills?: GuideNamed[];
  /** Quality gates it registers (run with the quality_gates tool). */
  gates?: GuideNamed[];
  /** The authored guide: Markdown, with or without its frontmatter. */
  authored?: string;
}

/** The skill a plugin's guide is loaded as. */
export const guideSkillName = (plugin: string): string => `${plugin}-guide`;

/** The line a model always sees for an enabled plugin (in the client block of the system prompt). */
export const guideIndexLine = (plugin: string, purpose: string): string => `${plugin}: ${oneLine(purpose)}; guide: load skill ${guideSkillName(plugin)}`;

/** The view that draws a plugin's home when it declares none. */
export const GENERATED_HOME_VIEW = 'core.shell:plugin-home';

/** Where to put the generated sections in authored text: this marker, else the end. */
export const GENERATED_MARKER = '<!-- generated -->';

export const PURPOSE_MAX = 200;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Splits a guide file into its frontmatter `description` (the plugin's one-sentence purpose) and the body. */
export function parseGuideMarkdown(md: string): { purpose?: string; name?: string; body: string } {
  const text = md.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { body: text.trim() };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
  }
  return { ...(fm.description ? { purpose: oneLine(fm.description).slice(0, PURPOSE_MAX) } : {}), ...(fm.name ? { name: fm.name } : {}), body: text.slice(m[0].length).trim() };
}

/** The plugin's one-sentence purpose: its guide's frontmatter, else the first sentence of its description. */
export function purposeOf(src: Pick<GuideSource, 'authored' | 'description' | 'title' | 'name'>): string {
  const p = src.authored ? parseGuideMarkdown(src.authored).purpose : undefined;
  if (p) return p;
  const d = oneLine(src.description ?? '');
  const first = /^(.{12,}?[.!?])(\s|$)/.exec(d)?.[1] ?? d;
  return (first || `the ${src.title ?? src.name} plugin`).slice(0, PURPOSE_MAX);
}

// ---------------- rendering ----------------

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const json = (v: unknown) => JSON.stringify(v);

/** A JSON Schema's fields as Markdown lines: `name` (type, required, one of ...): description. */
export function schemaLines(schema: unknown, indent = ''): string[] {
  const s = schema as JsonSchema | undefined;
  if (!s || typeof s !== 'object') return [];
  const props = s.properties ?? {};
  const keys = Object.keys(props);
  if (!keys.length) return [`${indent}- (no arguments)`];
  const req = new Set(s.required ?? []);
  return keys.map((k) => {
    const p = props[k]!;
    const bits = [p.type === 'array' ? `array of ${p.items?.type ?? 'values'}` : p.type ?? 'any', req.has(k) ? 'required' : 'optional'];
    if (p.enum) bits.push(`one of ${p.enum.map((e) => json(e)).join(', ')}`);
    if (p.items?.enum) bits.push(`items: ${p.items.enum.map((e) => json(e)).join(', ')}`);
    if (p.maxLength !== undefined) bits.push(`at most ${p.maxLength} characters`);
    if (p.minimum !== undefined || p.maximum !== undefined) bits.push(`${p.minimum ?? '...'} to ${p.maximum ?? '...'}`);
    if (p.default !== undefined && p.default !== '' && !(Array.isArray(p.default) && !p.default.length)) bits.push(`default ${json(p.default)}`);
    const what = oneLine([p.title, p.description].filter(Boolean).join(': '));
    return `${indent}- ${code(k)} (${bits.join(', ')})${what ? `: ${what}` : ''}`;
  });
}

function actionText(a: UiAction | undefined, plugin: string): string {
  if (!a) return 'runs code of the app';
  switch (a.type) {
    case 'prompt': return `types a prompt for the person${a.newChat ? ' in a new chat' : ''}`;
    case 'open-view': return `opens the page ${code(qualify(plugin, a.view))}`;
    case 'open-panel': return `opens the panel ${code(qualify(plugin, a.panel))}`;
    case 'open-url': case 'browse': return `opens ${a.url}`;
    case 'terminal': return `suggests the command ${code(a.command)}`;
    case 'workflow': return `opens the ${code(a.workflow)} workflow dialog`;
    case 'command': return `runs ${code(qualify(plugin, a.command))}`;
    case 'theme': return `switches to the theme ${code(a.theme)}`;
    case 'route': return `calls the plugin's route ${code(a.path)}`;
  }
}

/** The menu as nested lines: title, the view it opens (a desktop_open id). */
function menuLines(plugin: string, ui: UiManifest): string[] {
  const nav = new Map(ui.contributes.navItems.map((n) => [n.id, n]));
  const line = (it: MenuItemRef, indent: string): string[] => {
    if (typeof it === 'string') {
      const n = it.includes(':') ? undefined : nav.get(it);
      return n ? [`${indent}- ${n.title}: ${code(qualify(plugin, n.view))}${n.params ? ` with params ${json(n.params)}` : ''}`] : [`${indent}- ${code(it)} (another plugin's page, when it is on)`];
    }
    return [`${indent}- ${it.title}: ${code(qualify(plugin, it.view))}${it.params ? ` with params ${json(it.params)}` : ''}`, ...(it.children ?? []).flatMap((c) => line(c, `${indent}  `))];
  };
  return ui.menu ? ui.menu.items.flatMap((it) => line(it, '')) : ui.contributes.navItems.map((n) => `- ${n.title}: ${code(qualify(plugin, n.view))}`);
}

/** The generated half of a guide: everything the plugin has, from its manifest and its server half. */
export function generateGuideSections(src: GuideSource): string {
  const out: string[] = [];
  const p = src.name;
  const ui = src.ui;
  const c = ui?.contributes;
  const title = src.title ?? ui?.displayName ?? p;
  out.push(`## Reference: ${title} (${code(p)}), generated from its manifest`);
  if (c) {
    const home = ui!.home ? qualify(p, ui!.home) : null;
    out.push(`Home page: \`desktop_open {"target":"view","id":"${p}"}\`${home ? ` (the view ${code(home)})` : ' (a page the app draws from this manifest)'}.`);
    if (c.navItems.length || ui!.menu) out.push('', '### Menu', ...menuLines(p, ui!));
    if (c.views.length) {
      out.push('', '### Pages (desktop_open {"target":"view","id":...})');
      for (const v of c.views) {
        const kind = v.kind === 'frame' ? 'page' : v.kind === 'native' ? 'page' : v.kind;
        out.push(`- ${code(`${p}:${v.id}`)}: ${v.title}${v.description ? `. ${oneLine(v.description)}` : ''}${kind !== 'page' ? ` (${kind})` : ''}`);
      }
    }
    if (c.panels.length) {
      out.push('', '### Side panels (desktop_open {"target":"panel","id":...})');
      for (const x of c.panels) out.push(`- ${code(`${p}:${x.id}`)}: ${x.title}${x.where === 'session' ? ', next to a conversation (opens on yours)' : x.where === 'page' ? ', next to a page' : ''}`);
    }
    const agentCmds = c.commands.filter((x) => x.agent);
    if (agentCmds.length) {
      out.push('', '### Commands you may run (desktop_command {"command":..., "args":{...}}; the person is asked first)');
      for (const x of agentCmds) {
        out.push(`- ${code(`${p}:${x.id}`)}: ${oneLine(x.agent!.description)}`);
        out.push(...(x.agent!.inputSchema ? schemaLines(x.agent!.inputSchema, '  ') : ['  - (no arguments)']));
      }
    }
    const personCmds = c.commands.filter((x) => !x.agent);
    if (personCmds.length) {
      out.push('', '### Commands for the person (command palette; not agent-callable: suggest them)');
      for (const x of personCmds) out.push(`- ${code(`${p}:${x.id}`)}: ${x.category ? `${x.category}: ` : ''}${x.title}${x.keybinding ? ` (${x.keybinding})` : ''}, ${actionText(x.action, p)}`);
    }
    if (c.slashCommands.length) {
      out.push('', '### Slash commands (the person types them in the composer)');
      for (const s of c.slashCommands) out.push(`- ${code(`/${s.name}`)}: ${oneLine(s.description)}; ${actionText(s.action, p)}`);
    }
    if (c.settings.length) {
      out.push('', '### Settings (core.settings:open with {"section": id})');
      for (const s of c.settings) {
        out.push(`- ${code(`${p}:${s.id}`)}: ${s.title} (${s.scope === 'app' ? 'this computer' : s.scope === 'account' ? 'the person\'s account' : 'the operator\'s policy'})`);
        if (s.schema) out.push(...schemaLines(s.schema, '  '));
      }
    }
    if (c.renderers.length) {
      out.push('', '### What it draws in a conversation');
      for (const r of c.renderers) {
        const f = r.for as { tool?: string; event?: string; fence?: string; artifact?: string };
        out.push(`- ${f.tool ? `results of the ${code(f.tool)} tool` : f.event ? `${code(f.event)} events` : f.fence ? `\`\`\`${f.fence} blocks` : `artifacts of kind ${code(f.artifact!)}`}`);
      }
    }
    if (c.homeCards.length || c.statusItems.length) {
      out.push('', '### On the home page and the status bar');
      for (const h of c.homeCards) out.push(`- Home card ${code(`${p}:${h.id}`)}: ${h.title}`);
      for (const s of c.statusItems) out.push(`- Status item ${code(`${p}:${s.id}`)}: "${s.text}"${s.command ? `, runs ${code(qualify(p, s.command))}` : ''}`);
    }
    if (c.composerChips.length) {
      out.push('', '### Composer chips (sent with each message as session context)');
      for (const ch of c.composerChips) out.push(`- ${ch.title}: ${code(ch.setting)}${ch.options ? ` (${ch.options.join(', ')})` : ''}`);
    }
    if (c.dataSources.length || c.dashboardWidgets.length || c.dashboardTemplates.length || c.blockActions.length) {
      out.push('', '### Dashboards contributions');
      for (const d of c.dataSources) out.push(`- Data source type ${code(`${p}:${d.id}`)}: ${d.title}${d.description ? `. ${oneLine(d.description)}` : ''}`);
      for (const w of c.dashboardWidgets) out.push(`- Widget ${code(`${p}:${w.id}`)}: ${w.title} (drawn by \`\`\`${w.fence})`);
      for (const t of c.dashboardTemplates) out.push(`- Template ${code(`${p}:${t.id}`)}: ${t.title}${t.purpose ? ` (${t.purpose})` : ''}`);
      for (const b of c.blockActions) out.push(`- On drawn ${b.kinds.join('/')} blocks: "${b.title}" runs ${code(qualify(p, b.command))}`);
    }
  }
  const tools = [...(src.tools ?? [])];
  for (const n of ui?.tools ?? []) if (!tools.some((t) => t.name === n)) tools.push({ name: n });
  if (tools.length) {
    out.push('', '### Tools');
    for (const t of tools) {
      out.push(`- ${code(t.name)}${t.description ? `: ${oneLine(t.description).slice(0, 400)}` : ' (when this session has it)'}`);
      const s = t.input_schema as JsonSchema | undefined;
      if (s?.properties && Object.keys(s.properties).length) out.push(...schemaLines(s, '  ').slice(0, 25));
    }
  }
  if (src.workflows?.length) { out.push('', '### Workflows (workflow tool, or the workflow dialog)'); for (const w of src.workflows) out.push(`- ${code(w.name)}${w.description ? `: ${oneLine(w.description)}` : ''}`); }
  if (src.agents?.length) { out.push('', '### Agents (agent tool)'); for (const a of src.agents) out.push(`- ${code(a.name)}${a.description ? `: ${oneLine(a.description).slice(0, 300)}` : ''}`); }
  if (src.gates?.length) { out.push('', '### Quality gates (quality_gates tool)'); out.push(`- ${src.gates.map((g) => code(g.name)).join(', ')}`); }
  if (src.skills?.length) { out.push('', '### Skills (skill tool)'); for (const s of src.skills) out.push(`- ${code(s.name)}${s.description ? `: ${oneLine(s.description).slice(0, 300)}` : ''}`); }
  return out.join('\n');
}

/** The whole guide: the authored text (without its frontmatter) with the generated sections at its marker, or after it. */
export function composeGuide(src: GuideSource): string {
  const title = src.title ?? src.ui?.displayName ?? src.name;
  const parsed = src.authored ? parseGuideMarkdown(src.authored) : { body: '' };
  const generated = generateGuideSections(src);
  const head = parsed.body || `# ${title}\n\n${purposeOf(src)}`;
  if (head.includes(GENERATED_MARKER)) return head.replace(GENERATED_MARKER, generated);
  return `${head}\n\n${generated}`;
}
