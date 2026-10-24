import type { Message } from '../core/types.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { Tool } from './types.ts';
import { str } from './types.ts';

// Plugin tools offered on demand. Every tool schema is in every request (cached, but a cache
// read is still paid on every step, a write on every miss, and in full by every sub-agent), and
// a coding turn calls none of the games, documents or operations tools the bundled plugins add.
// So a plugin's tools are a group: until something loads it, the request carries one line for
// it in load_tools' description (its name, purpose and tool names) instead of the schemas.
//
// Loading is sticky and derived from the history: a group is loaded once any call loaded it
// (load_tools naming it, a call to one of its tools by name, or its plugin's guide skill), so
// every request of the session renders the same list from the same history, and the prefix
// changes only when a group is first loaded: one cache miss per group per session.
// The tools themselves stay in the agent's toolbox (only their schemas are left out), so a
// model that calls one by its own name is served, and the plugin-off rule is unchanged.

export interface ToolGroup {
  /** The plugin's name. */
  id: string;
  /** One line: what the plugin is for. */
  summary: string;
  tools: string[];
  /** The plugin's skills: loading one loads its tools too (a skill is the procedure for them). */
  skills?: string[];
}

export const LOAD_TOOLS = 'load_tools';

/** A plugin's description as one short line for the load_tools list. */
export function groupSummary(text: string | undefined, id: string): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim();
  // The first sentence; a long one up to its first colon or semicolon (what the plugin is, before the details).
  let s = /^(.{12,}?\.)\s/.exec(`${one} `)?.[1] ?? one;
  for (const stop of [/;(\s|$)/, /:(\s|$)/]) {
    if (s.length <= 140) break;
    const cut = s.search(stop);
    if (cut >= 12) s = s.slice(0, cut);
  }
  // A cut inside parentheses drops the open part.
  const open = s.lastIndexOf('(');
  if (open > s.lastIndexOf(')')) s = s.slice(0, open).trim();
  if (s.length > 140) s = `${s.slice(0, 137).replace(/\s+\S*$/, '')}...`;
  s = s.replace(/[\s,;:]+$/, '');
  return s ? (/[.!?]$/.test(s) ? s : `${s}.`) : id;
}

/**
 * The groups of a toolbox: one per plugin that contributed tools. Core tools stay inline; a
 * tool marked `defer: false` stays inline whoever made it, and one marked `defer: true` is
 * deferred even when it is core (in a group of its own name's prefix: "core").
 */
export function pluginGroups(tools: Tool[], ownerOf: (t: Tool) => string | undefined, describe: (plugin: string) => string | undefined, minTokens = GROUP_MIN_TOKENS): ToolGroup[] {
  const groups = new Map<string, ToolGroup & { size: number }>();
  for (const t of tools) {
    if (t.defer === false) continue;
    const owner = ownerOf(t) ?? (t.defer ? 'core' : undefined);
    if (!owner) continue;
    let g = groups.get(owner);
    if (!g) groups.set(owner, g = { id: owner, summary: groupSummary(describe(owner), owner), tools: [], size: 0 });
    g.tools.push(t.spec.name);
    g.size += JSON.stringify(t.spec).length / 4;
  }
  // A group whose schemas cost less than its load would (a step, and a cache miss) stays inline.
  return [...groups.values()].filter((g) => g.size >= minTokens).map(({ size: _size, ...g }) => ({ ...g, tools: g.tools.sort() })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Smallest group worth deferring, in schema tokens: below it the line in load_tools and a load cost about as much. */
export const GROUP_MIN_TOKENS = 400;

/** The guide skill of a plugin (packages/plugin-ui's naming): loading it loads the plugin's tools. */
const guideOf = (skill: string) => (skill.endsWith('-guide') ? skill.slice(0, -'-guide'.length) : undefined);

/** Groups one call loads. Pure; the caller accumulates. */
export function groupsLoadedBy(name: string, input: Record<string, unknown> | undefined, groups: readonly ToolGroup[]): string[] {
  if (name === LOAD_TOOLS) {
    const raw = input?.groups;
    const names = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
    return names.filter((g) => groups.some((x) => x.id === g));
  }
  if (name === 'skill') {
    const skill = str(input?.name);
    const p = guideOf(skill);
    return groups.filter((g) => g.id === p || g.skills?.includes(skill)).map((g) => g.id);
  }
  const own = groups.find((g) => g.tools.includes(name));
  return own ? [own.id] : [];
}

/**
 * Every group a context has loaded, read from its messages. A load_tools call that failed
 * (an unknown or switched-off group) loads nothing.
 */
export function loadedGroups(messages: readonly Message[], groups: readonly ToolGroup[], into = new Set<string>()): Set<string> {
  if (!groups.length) return into;
  const failed = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_result' && b.is_error) failed.add(b.tool_use_id);
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      if ((b.name === LOAD_TOOLS || b.name === 'skill') && failed.has(b.id)) continue;
      for (const g of groupsLoadedBy(b.name, b.input, groups)) into.add(g);
    }
  }
  return into;
}

/**
 * The tool list a request sends: every tool not in an unloaded group, plus load_tools while any
 * group is left to load. Sorted by name, so the same loaded set always renders the same bytes.
 */
export function sentSpecs(specs: readonly ToolSpec[], groups: readonly ToolGroup[], loaded: ReadonlySet<string>): ToolSpec[] {
  const have = new Set(specs.map((s) => s.name));
  const waiting = groups.filter((g) => !loaded.has(g.id)).map((g) => ({ ...g, tools: g.tools.filter((t) => have.has(t)) })).filter((g) => g.tools.length);
  const hidden = new Set(waiting.flatMap((g) => g.tools));
  const out = specs.filter((s) => !hidden.has(s.name));
  if (waiting.length) out.push(loadToolsSpec(waiting));
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** load_tools, listing the groups still to load: one line each. */
export function loadToolsSpec(waiting: readonly ToolGroup[]): ToolSpec {
  return {
    name: LOAD_TOOLS,
    description: [
      'Load the tools of a plugin that are not offered until needed. A loaded group stays loaded for the rest of the session; its tools are callable from your next step. Load only what the task needs.',
      ...waiting.map((g) => `- ${g.id}: ${g.summary} Tools: ${g.tools.join(', ')}`),
    ].join('\n'),
    input_schema: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string', enum: waiting.map((g) => g.id) } } }, required: ['groups'] },
  };
}

/** The load_tools tool; its answer names what was loaded (the loading itself is read from the call). */
export function makeLoadTools(groups: () => readonly ToolGroup[], offReason: (group: ToolGroup) => string | undefined): Tool {
  return {
    kind: 'meta', parallelSafe: true, remoteable: false,
    spec: loadToolsSpec(groups()),
    summarize: (i) => `load tools ${Array.isArray(i.groups) ? i.groups.join(', ') : str(i.groups)}`,
    async run(input) {
      const all = groups();
      const raw = Array.isArray(input.groups) ? input.groups.map(String) : typeof input.groups === 'string' ? input.groups.split(/[\s,]+/).filter(Boolean) : [];
      const known = raw.filter((g) => all.some((x) => x.id === g));
      const unknown = raw.filter((g) => !known.includes(g));
      if (!known.length) return { content: `No such group${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(none given)'}. Groups: ${all.map((g) => g.id).join(', ')}.`, is_error: true };
      const off = known.map((id) => offReason(all.find((g) => g.id === id)!)).filter(Boolean);
      if (off.length === known.length) return { content: off.join('\n'), is_error: true };
      const lines = known.map((id) => `${id}: ${all.find((g) => g.id === id)!.tools.join(', ')}`);
      return { content: `Loaded; callable from your next step:\n${lines.join('\n')}${off.length ? `\n${off.join('\n')}` : ''}${unknown.length ? `\nIgnored unknown: ${unknown.join(', ')}.` : ''}` };
    },
  };
}
