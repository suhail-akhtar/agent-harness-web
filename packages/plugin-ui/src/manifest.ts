/**
 * The UI half of a harness plugin: the `ui` section of `harness-plugin.json`.
 *
 * Shared by the server (which validates it when it loads a plugin and serves the plugin's UI files)
 * and the desktop (which turns contributions into sidebar entries, pages, panels, commands, settings
 * sections, renderers and so on). Plain JSON on purpose: a person, or a model, can write and read it.
 *
 * Everything the shell shows comes from here - the built-in features are plugins with the same
 * contribution points, they just bring native components (trust "native", signed).
 */

export const UI_API_VERSION = 1;

/** Icons a manifest may name; the desktop maps each to its icon set. */
export const ICON_NAMES = [
  'chat', 'search', 'library', 'clock', 'plug', 'folder', 'folder-open', 'globe', 'git', 'git-branch', 'git-pr',
  'terminal', 'code', 'file', 'files', 'apps', 'activity', 'settings', 'star', 'bolt', 'book', 'chart', 'table',
  'grid', 'bell', 'inbox', 'user', 'users', 'image', 'sparkles', 'wrench', 'shield', 'lock', 'key', 'database',
  'cloud', 'server', 'cpu', 'bug', 'flask', 'rocket', 'palette', 'layers', 'list', 'check', 'map', 'calendar',
  'mail', 'history', 'stack', 'eye', 'zap', 'play', 'pause', 'stop', 'heart', 'bookmark', 'compass', 'box',
  'puzzle', 'brain', 'calculator', 'atom', 'function', 'workflow', 'robot', 'memory', 'vault', 'dollar', 'home',
  'pin', 'archive', 'trash', 'download', 'upload', 'link', 'external', 'info', 'warning', 'help', 'command',
  // Added for the desktop shell's own commands (compatible: only new names).
  'edit', 'keyboard', 'monitor', 'sun', 'moon', 'folder-plus', 'arrow-left', 'arrow-right', 'arrow-up', 'arrow-down',
  'sidebar', 'panel-right', 'refresh', 'plus', 'x', 'copy', 'file-text', 'alert', 'bot', 'paperclip', 'tag', 'filter', 'share', 'save',
] as const;
export type IconName = typeof ICON_NAMES[number];

/** How much a plugin's UI is trusted to run. */
export type UiTrust = 'declarative' | 'frame' | 'native';

/** What a frame may ask the host for, beyond the calls every frame gets. See capabilities.ts. */
export type Capability =
  | 'sessions.read' | 'sessions.start' | 'events.subscribe' | 'approvals.respond' | 'routes.call'
  | 'files.read' | 'workflows.start' | 'settings.read' | 'settings.write'
  | 'clipboard.write' | 'browser.open' | 'external.open';

export const CAPABILITIES: readonly Capability[] = [
  'sessions.read', 'sessions.start', 'events.subscribe', 'approvals.respond', 'routes.call',
  'files.read', 'workflows.start', 'settings.read', 'settings.write',
  'clipboard.write', 'browser.open', 'external.open',
];

// ---------------- actions ----------------

/** What a command, slash command, prompt chip or status item does. */
export type UiAction =
  /** Put this text in the composer (a new chat when `newChat`). Never sent without the person. */
  | { type: 'prompt'; prompt: string; newChat?: boolean }
  | { type: 'open-view'; view: string; params?: Record<string, string> }
  | { type: 'open-panel'; panel: string }
  | { type: 'open-url'; url: string }
  /** The built-in browser, when one is enabled; else the system browser. */
  | { type: 'browse'; url: string }
  /** Run in the terminal panel: always shown to the person before it runs. */
  | { type: 'terminal'; command: string; cwd?: string }
  /** Open the workflow start dialog with these inputs (the person confirms). */
  | { type: 'workflow'; workflow: string; input?: Record<string, string> }
  /** Run another command by id (`<plugin>:<id>` or a built-in's). */
  | { type: 'command'; command: string; args?: unknown }
  | { type: 'theme'; theme: string }
  /** Call this plugin's own server route and show the result as a toast. */
  | { type: 'route'; path: string; method?: 'GET' | 'POST'; body?: unknown };

export const ACTION_TYPES = ['prompt', 'open-view', 'open-panel', 'open-url', 'browse', 'terminal', 'workflow', 'command', 'theme', 'route'] as const;

// ---------------- contribution points ----------------

export interface NavItemContribution {
  id: string;
  title: string;
  icon?: IconName;
  /** A view id: `<id>` of this plugin's views, or `<plugin>:<id>`. */
  view: string;
  params?: Record<string, string>;
  /** `primary` in the sidebar list; `more` under More; `footer` near the profile row. Default primary. */
  placement?: 'primary' | 'more' | 'footer';
  order?: number;
  /** A live value (from a frame's `badge.set` or a built-in's store) shown as a count. */
  badge?: string;
}

interface ViewBase { id: string; title: string; icon?: IconName; description?: string }

/** A page. Declarative kinds need no code; `frame` runs the plugin's HTML sandboxed; `native` is a signed first-party component. */
export type ViewContribution =
  | ViewBase & { kind: 'markdown'; markdown: string }
  | ViewBase & { kind: 'links'; links: Array<{ title: string; url: string; description?: string }> }
  | ViewBase & { kind: 'prompt-board'; prompts: Array<{ title: string; prompt: string; icon?: IconName }> }
  /** A form from a JSON Schema; submitting runs `action` with the values as `args`/`input`. */
  | ViewBase & { kind: 'form'; schema: JsonSchema; submit: { label?: string; action: UiAction } }
  | ViewBase & { kind: 'frame'; entry: string }
  | ViewBase & { kind: 'native'; component: string };

export interface PanelContribution {
  id: string;
  title: string;
  icon?: IconName;
  kind: 'frame' | 'native';
  entry?: string;
  component?: string;
  /** Where it can open: next to a session, next to any page, or both. */
  where?: 'session' | 'page' | 'any';
}

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  icon?: IconName;
  /** e.g. "Ctrl+Alt+G" ("Mod" is Ctrl, or Cmd on macOS). */
  keybinding?: string;
  action?: UiAction;
  /** Native plugins run code instead: the id of a handler their module registers. */
  handler?: string;
  /**
   * Marks the command agent-callable: an agent may run it with desktop_command (asked like an
   * action on another system unless a rule allows it). Unmarked commands are the person's only.
   */
  agent?: AgentCommand;
}

/** What an agent sees of an agent-callable command, and the shape of the args it must pass. */
export interface AgentCommand { description: string; inputSchema?: JsonSchema }

export interface SlashCommandContribution {
  /** Typed as `/name`; lower-case letters, digits and dashes. */
  name: string;
  description: string;
  /** `{args}` in a prompt action is replaced by what follows the command. */
  action: UiAction;
}

export interface ComposerChipContribution {
  id: string;
  title: string;
  icon?: IconName;
  kind: 'toggle' | 'select';
  /** The setting it reads and writes (`<plugin>.<key>`), sent with each message as session context. */
  setting: string;
  options?: string[];
}

export interface SettingsContribution {
  id: string;
  title: string;
  icon?: IconName;
  group?: 'app' | 'agent' | 'integrations' | 'plugins' | 'admin';
  order?: number;
  /** `app`: this machine; `account`: the person's server settings; `operator`: policy, editable by administrators only. */
  scope: 'app' | 'account' | 'operator';
  schema?: JsonSchema;
  /** Native first-party sections bring their own component instead of a schema. */
  component?: string;
}

export interface RendererContribution {
  id: string;
  /** What it draws: a tool's results, an event kind, a Markdown code-fence language, or an artifact kind (html, svg, react, diagram ...). */
  for: { tool: string } | { event: string } | { fence: string } | { artifact: string };
  kind: 'frame' | 'native';
  entry?: string;
  component?: string;
  /** Initial height of a frame in pixels; the frame can resize itself. */
  height?: number;
}

export interface HomeCardContribution {
  id: string;
  title: string;
  kind: 'frame' | 'native' | 'markdown';
  entry?: string;
  component?: string;
  markdown?: string;
  order?: number;
}

export interface StatusItemContribution {
  id: string;
  /** May name live values in braces: "{badge-name} open". */
  text: string;
  tooltip?: string;
  command?: string;
  align?: 'left' | 'right';
  order?: number;
}

export interface ThemeContribution {
  id: string;
  label: string;
  mode: 'light' | 'dark';
  background: string;
  foreground: string;
  accent: string;
}

export interface PromptContribution {
  id: string;
  title: string;
  prompt: string;
  icon?: IconName;
  home?: boolean;
}

export interface OnboardingContribution {
  id: string;
  title: string;
  description?: string;
  /** The view that completes the step. */
  view: string;
  order?: number;
}

/**
 * A data source type for dashboards (core.dashboards): this plugin's own server route returns the
 * rows (JSON: a list of objects, [header, ...rows] or {columns, rows}); `params` (a JSON Schema) are
 * asked when a person adds one and passed to the route as query parameters.
 */
export interface DataSourceContribution { id: string; title: string; icon?: IconName; description?: string; route: string; params?: JsonSchema }
/** A dashboard visual drawn by a fence renderer (this plugin's or the app's), given {columns, rows, options} as its source. */
export interface WidgetContribution { id: string; title: string; icon?: IconName; description?: string; fence: string }
/** An action on a rendered block in a transcript (a chart, a table ...): runs `command` with {lang, source} as its args. */
export interface BlockActionContribution { id: string; title: string; icon?: IconName; kinds: string[]; command: string }

export interface UiContributes {
  navItems?: NavItemContribution[];
  views?: ViewContribution[];
  panels?: PanelContribution[];
  commands?: CommandContribution[];
  slashCommands?: SlashCommandContribution[];
  composerChips?: ComposerChipContribution[];
  settings?: SettingsContribution[];
  renderers?: RendererContribution[];
  homeCards?: HomeCardContribution[];
  statusItems?: StatusItemContribution[];
  themes?: ThemeContribution[];
  prompts?: PromptContribution[];
  onboarding?: OnboardingContribution[];
  dataSources?: DataSourceContribution[];
  dashboardWidgets?: WidgetContribution[];
  blockActions?: BlockActionContribution[];
}

export const CONTRIBUTION_POINTS = ['navItems', 'views', 'panels', 'commands', 'slashCommands', 'composerChips', 'settings', 'renderers', 'homeCards', 'statusItems', 'themes', 'prompts', 'onboarding', 'dataSources', 'dashboardWidgets', 'blockActions'] as const;

export interface UiManifest {
  apiVersion: number;
  displayName?: string;
  icon?: IconName;
  category?: string;
  trust: UiTrust;
  capabilities: Capability[];
  /** Shipped on and cannot be switched off (set by a product profile for the core plugins). */
  required?: boolean;
  contributes: Required<UiContributes>;
}

/** The subset of JSON Schema the settings and form renderer understands. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: Array<string | number>;
  enumLabels?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'secret' | 'url' | 'email' | 'path' | 'multiline' | 'color';
  items?: JsonSchema;
  order?: number;
}

// ---------------- validation ----------------

export class ManifestError extends Error {}

const ID = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const SLASH = /^[a-z][a-z0-9-]{0,31}$/;
const FENCE = /^[a-z][a-z0-9-]{1,40}$/;
const HEX = /^#[0-9a-f]{3,8}$/i;
const SETTING = /^[a-z0-9][a-z0-9._-]{0,63}\.[a-zA-Z0-9_.-]{1,64}$/;
const COMPONENT = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const KEYBINDING = /^((Mod|Ctrl|Cmd|Alt|Shift|Meta)\+){0,3}([A-Z0-9]|F[1-9]|F1[0-2]|[,./;'\[\]\\`=-]|Enter|Escape|Space|Tab|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown)$/;

/** A file inside the plugin folder: relative, no `..`, no scheme, no absolute path. */
export function isPluginFile(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 200) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\')) return false;
  return p.split(/[\\/]/).every((seg) => seg !== '..' && seg !== '' && seg !== '.');
}

function isObj(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }

function checkAction(where: string, a: unknown): UiAction {
  if (!isObj(a) || typeof a.type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(a.type)) throw new ManifestError(`${where}: "action" needs a "type" (${ACTION_TYPES.join(', ')}).`);
  const need = (k: string) => { if (typeof a[k] !== 'string' || !(a[k] as string).trim()) throw new ManifestError(`${where}: a "${a.type}" action needs "${k}".`); };
  switch (a.type) {
    case 'prompt': need('prompt'); break;
    case 'open-view': need('view'); break;
    case 'open-panel': need('panel'); break;
    case 'open-url': case 'browse':
      need('url');
      if (!/^https?:\/\//i.test(String(a.url))) throw new ManifestError(`${where}: "url" must be http(s).`);
      break;
    case 'terminal': need('command'); break;
    case 'workflow': need('workflow'); break;
    case 'command': need('command'); break;
    case 'theme': need('theme'); break;
    case 'route':
      need('path');
      if (!/^[a-z0-9][a-z0-9/_.-]{0,127}$/i.test(String(a.path)) || String(a.path).includes('..')) throw new ManifestError(`${where}: "path" must be one of this plugin's route paths.`);
      if (a.method !== undefined && a.method !== 'GET' && a.method !== 'POST') throw new ManifestError(`${where}: "method" is GET or POST.`);
      break;
  }
  return a as unknown as UiAction;
}

function checkSchema(where: string, s: unknown, depth = 0): JsonSchema {
  if (!isObj(s)) throw new ManifestError(`${where}: "schema" must be a JSON Schema object.`);
  if (depth > 6) throw new ManifestError(`${where}: the schema nests too deeply.`);
  if (s.type !== undefined && !['object', 'string', 'number', 'integer', 'boolean', 'array'].includes(String(s.type))) throw new ManifestError(`${where}: unsupported type "${String(s.type)}".`);
  if (s.properties !== undefined) {
    if (!isObj(s.properties)) throw new ManifestError(`${where}: "properties" must be an object.`);
    for (const [k, v] of Object.entries(s.properties)) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(k)) throw new ManifestError(`${where}: property name "${k}" is not allowed.`);
      checkSchema(`${where}.${k}`, v, depth + 1);
    }
  }
  if (s.items !== undefined) checkSchema(`${where}[]`, s.items, depth + 1);
  if (s.pattern !== undefined) { try { new RegExp(String(s.pattern)); } catch { throw new ManifestError(`${where}: "pattern" is not a valid regular expression.`); } }
  return s as JsonSchema;
}

function checkAgentCommand(where: string, a: unknown): AgentCommand {
  if (!isObj(a) || typeof a.description !== 'string' || !a.description.trim() || a.description.length > 500) throw new ManifestError(`${where}: "agent" needs a "description" (at most 500 characters) saying what the command does for an agent.`);
  if (a.inputSchema !== undefined) checkSchema(`${where} agent.inputSchema`, a.inputSchema);
  return { description: a.description.trim(), ...(a.inputSchema !== undefined ? { inputSchema: a.inputSchema as JsonSchema } : {}) };
}

/**
 * A form an agent asks the person to fill in (ask_user's `form`): the same JSON Schema subset as
 * settings, an object at the top, at most 40 fields and 20,000 characters. Throws ManifestError.
 */
export function validateFormSchema(s: unknown): JsonSchema {
  const schema = checkSchema('form', s);
  if (schema.type !== 'object' || !isObj(schema.properties) || !Object.keys(schema.properties).length) throw new ManifestError('form: the schema must be {"type": "object", "properties": {...}}.');
  if (Object.keys(schema.properties).length > 40) throw new ManifestError('form: at most 40 fields.');
  if (JSON.stringify(schema).length > 20_000) throw new ManifestError('form: the schema is larger than 20,000 characters.');
  for (const r of schema.required ?? []) if (!Object.hasOwn(schema.properties, r)) throw new ManifestError(`form: "required" names "${r}", which is not a property.`);
  return schema;
}

/**
 * Checks a value against the schema subset: types, required, enum, minimum/maximum,
 * minLength/maxLength, pattern, items. Returns every problem found (empty: valid).
 * Properties the schema does not name are refused, so a form answer carries only its fields.
 */
export function validateValue(schema: JsonSchema, value: unknown, where = 'answer'): string[] {
  const out: string[] = [];
  const t = schema.type;
  if (value === undefined || value === null) return t ? [`${where}: a ${t} is required`] : [];
  const kind = Array.isArray(value) ? 'array' : typeof value;
  if (t === 'object') {
    if (kind !== 'object') return [`${where}: must be an object`];
    const v = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) if (v[r] === undefined || v[r] === null || v[r] === '') out.push(`${where}.${r}: is required`);
    for (const [k, x] of Object.entries(v)) {
      if (!Object.hasOwn(props, k)) { out.push(`${where}.${k}: is not a field of this form`); continue; }
      if (x !== undefined && x !== null) out.push(...validateValue(props[k]!, x, `${where}.${k}`));
    }
    return out;
  }
  if (t === 'array') {
    if (kind !== 'array') return [`${where}: must be a list`];
    (value as unknown[]).slice(0, 1000).forEach((x, i) => { if (schema.items) out.push(...validateValue(schema.items, x, `${where}[${i}]`)); });
    if ((value as unknown[]).length > 1000) out.push(`${where}: at most 1000 items`);
    return out;
  }
  if (t === 'string' && kind !== 'string') return [`${where}: must be text`];
  if ((t === 'number' || t === 'integer') && (kind !== 'number' || !Number.isFinite(value as number))) return [`${where}: must be a number`];
  if (t === 'integer' && !Number.isInteger(value)) return [`${where}: must be a whole number`];
  if (t === 'boolean' && kind !== 'boolean') return [`${where}: must be true or false`];
  if (schema.enum && !schema.enum.includes(value as string | number)) out.push(`${where}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: at most ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: at least ${schema.minLength} characters`);
    if (value.length > (schema.maxLength ?? 100_000)) out.push(`${where}: at most ${schema.maxLength ?? 100_000} characters`);
    if (schema.pattern !== undefined) { let re: RegExp | undefined; try { re = new RegExp(schema.pattern); } catch { /* checked with the schema */ } if (re && !re.test(value.slice(0, 10_000))) out.push(`${where}: does not match the expected format`); }
  }
  return out;
}

/**
 * Validates and normalises the `ui` section. Throws a ManifestError a person (or model) can act on.
 * `trustCeiling` is the most the host allows this plugin (native only for signed first-party ones).
 */
export function validateUiManifest(input: unknown, opts: { trustCeiling?: UiTrust } = {}): UiManifest {
  if (!isObj(input)) throw new ManifestError('"ui" must be an object.');
  const m = input;
  const apiVersion = m.apiVersion === undefined ? UI_API_VERSION : Number(m.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new ManifestError('"ui.apiVersion" must be a whole number.');
  if (apiVersion > UI_API_VERSION) throw new ManifestError(`"ui.apiVersion" ${apiVersion} is newer than this host supports (${UI_API_VERSION}): update the app.`);
  const c = isObj(m.contributes) ? m.contributes : {};
  for (const k of Object.keys(c)) if (!(CONTRIBUTION_POINTS as readonly string[]).includes(k)) throw new ManifestError(`"ui.contributes.${k}" is not a contribution point (${CONTRIBUTION_POINTS.join(', ')}).`);
  const arr = <T>(key: string): T[] => {
    const v = c[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new ManifestError(`"ui.contributes.${key}" must be an array.`);
    if (v.length > 200) throw new ManifestError(`"ui.contributes.${key}" has more than 200 entries.`);
    if (!v.every(isObj)) throw new ManifestError(`Every entry of "ui.contributes.${key}" must be an object.`);
    return v as T[];
  };
  const ids = (kind: string, items: Array<Record<string, unknown>>, key = 'id', re = ID) => {
    const seen = new Set<string>();
    for (const it of items) {
      const id = it[key];
      if (typeof id !== 'string' || !re.test(id)) throw new ManifestError(`Every ${kind} needs a "${key}" (letters, digits, dot, dash; got ${JSON.stringify(id)}).`);
      if (seen.has(id)) throw new ManifestError(`Duplicate ${kind} ${key} "${id}".`);
      seen.add(id);
    }
  };
  const title = (kind: string, it: Record<string, unknown>) => { if (typeof it.title !== 'string' || !it.title.trim() || it.title.length > 80) throw new ManifestError(`${kind} "${String(it.id ?? it.name)}" needs a "title" (at most 80 characters).`); };
  const icon = (kind: string, it: Record<string, unknown>) => { if (it.icon !== undefined && !(ICON_NAMES as readonly string[]).includes(String(it.icon))) throw new ManifestError(`${kind} "${String(it.id)}": unknown icon "${String(it.icon)}".`); };
  let usesCode = false; let usesNative = false;
  const body = (kind: string, it: Record<string, unknown>, kinds: string[]) => {
    if (!kinds.includes(String(it.kind))) throw new ManifestError(`${kind} "${String(it.id)}" has kind "${String(it.kind)}"; use ${kinds.join(', ')}.`);
    if (it.kind === 'frame') { usesCode = true; if (!isPluginFile(it.entry)) throw new ManifestError(`${kind} "${String(it.id)}" needs an "entry" file inside the plugin folder.`); }
    if (it.kind === 'native') { usesNative = true; if (typeof it.component !== 'string' || !COMPONENT.test(it.component)) throw new ManifestError(`${kind} "${String(it.id)}" needs a "component" name.`); }
  };

  const navItems = arr<NavItemContribution & Record<string, unknown>>('navItems');
  ids('nav item', navItems);
  for (const n of navItems) {
    title('Nav item', n); icon('Nav item', n);
    if (typeof n.view !== 'string' || !n.view) throw new ManifestError(`Nav item "${n.id}" needs a "view".`);
    if (n.placement !== undefined && !['primary', 'more', 'footer'].includes(n.placement)) throw new ManifestError(`Nav item "${n.id}": placement is primary, more or footer.`);
  }
  const views = arr<Record<string, unknown>>('views');
  ids('view', views);
  for (const v of views) {
    title('View', v); icon('View', v);
    body('View', v, ['markdown', 'links', 'prompt-board', 'form', 'frame', 'native']);
    if (v.kind === 'markdown' && typeof v.markdown !== 'string') throw new ManifestError(`View "${String(v.id)}" needs "markdown".`);
    if (v.kind === 'links') {
      if (!Array.isArray(v.links)) throw new ManifestError(`View "${String(v.id)}" needs "links".`);
      for (const l of v.links as Array<Record<string, unknown>>) if (!isObj(l) || typeof l.title !== 'string' || !/^https?:\/\//i.test(String(l.url))) throw new ManifestError(`View "${String(v.id)}": every link needs a "title" and an http(s) "url".`);
    }
    if (v.kind === 'prompt-board') {
      if (!Array.isArray(v.prompts)) throw new ManifestError(`View "${String(v.id)}" needs "prompts".`);
      for (const p of v.prompts as Array<Record<string, unknown>>) if (!isObj(p) || typeof p.title !== 'string' || typeof p.prompt !== 'string') throw new ManifestError(`View "${String(v.id)}": every prompt needs "title" and "prompt".`);
    }
    if (v.kind === 'form') {
      checkSchema(`View "${String(v.id)}"`, v.schema);
      if (!isObj(v.submit)) throw new ManifestError(`View "${String(v.id)}" needs "submit": { action }.`);
      checkAction(`View "${String(v.id)}" submit`, v.submit.action);
    }
  }
  const panels = arr<Record<string, unknown>>('panels');
  ids('panel', panels);
  for (const p of panels) {
    title('Panel', p); icon('Panel', p); body('Panel', p, ['frame', 'native']);
    if (p.where !== undefined && !['session', 'page', 'any'].includes(String(p.where))) throw new ManifestError(`Panel "${String(p.id)}": where is session, page or any.`);
  }
  const commands = arr<Record<string, unknown>>('commands');
  ids('command', commands);
  for (const cmd of commands) {
    title('Command', cmd); icon('Command', cmd);
    if (cmd.keybinding !== undefined && (typeof cmd.keybinding !== 'string' || !KEYBINDING.test(cmd.keybinding))) throw new ManifestError(`Command "${String(cmd.id)}": "${String(cmd.keybinding)}" is not a keybinding (e.g. "Ctrl+Alt+G").`);
    if (cmd.action !== undefined) checkAction(`Command "${String(cmd.id)}"`, cmd.action);
    else if (typeof cmd.handler === 'string' && COMPONENT.test(cmd.handler)) usesNative = true;
    else throw new ManifestError(`Command "${String(cmd.id)}" needs an "action" (or, for native plugins, a "handler").`);
    if (cmd.agent !== undefined) cmd.agent = checkAgentCommand(`Command "${String(cmd.id)}"`, cmd.agent);
  }
  const slashCommands = arr<Record<string, unknown>>('slashCommands');
  ids('slash command', slashCommands, 'name', SLASH);
  for (const s of slashCommands) {
    if (typeof s.description !== 'string' || !s.description.trim()) throw new ManifestError(`Slash command "/${String(s.name)}" needs a "description".`);
    checkAction(`Slash command "/${String(s.name)}"`, s.action);
  }
  const composerChips = arr<Record<string, unknown>>('composerChips');
  ids('composer chip', composerChips);
  for (const ch of composerChips) {
    title('Composer chip', ch); icon('Composer chip', ch);
    if (ch.kind !== 'toggle' && ch.kind !== 'select') throw new ManifestError(`Composer chip "${String(ch.id)}": kind is toggle or select.`);
    if (typeof ch.setting !== 'string' || !SETTING.test(ch.setting)) throw new ManifestError(`Composer chip "${String(ch.id)}" needs a "setting" like "<plugin>.<key>".`);
    if (ch.kind === 'select' && (!Array.isArray(ch.options) || !ch.options.length || !ch.options.every((o) => typeof o === 'string'))) throw new ManifestError(`Composer chip "${String(ch.id)}" needs "options".`);
  }
  const settings = arr<Record<string, unknown>>('settings');
  ids('settings section', settings);
  for (const st of settings) {
    title('Settings section', st); icon('Settings section', st);
    if (!['app', 'account', 'operator'].includes(String(st.scope))) throw new ManifestError(`Settings section "${String(st.id)}": scope is app, account or operator.`);
    if (st.group !== undefined && !['app', 'agent', 'integrations', 'plugins', 'admin'].includes(String(st.group))) throw new ManifestError(`Settings section "${String(st.id)}": unknown group "${String(st.group)}".`);
    if (st.schema !== undefined) checkSchema(`Settings section "${String(st.id)}"`, st.schema);
    else if (typeof st.component === 'string' && COMPONENT.test(st.component)) usesNative = true;
    else throw new ManifestError(`Settings section "${String(st.id)}" needs a "schema" (or, for native plugins, a "component").`);
  }
  const renderers = arr<Record<string, unknown>>('renderers');
  ids('renderer', renderers);
  for (const r of renderers) {
    body('Renderer', r, ['frame', 'native']);
    const f = r.for;
    const ok = isObj(f) && Object.keys(f).length === 1 && ((typeof f.tool === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(f.tool)) || (typeof f.event === 'string' && /^[a-z_]{2,40}$/.test(f.event)) || (typeof f.fence === 'string' && FENCE.test(f.fence)) || (typeof f.artifact === 'string' && FENCE.test(f.artifact)));
    if (!ok) throw new ManifestError(`Renderer "${String(r.id)}" needs "for": {"tool": name} or {"event": kind} or {"fence": language} or {"artifact": kind}.`);
  }
  const homeCards = arr<Record<string, unknown>>('homeCards');
  ids('home card', homeCards);
  for (const h of homeCards) {
    title('Home card', h); body('Home card', h, ['frame', 'native', 'markdown']);
    if (h.kind === 'markdown' && typeof h.markdown !== 'string') throw new ManifestError(`Home card "${String(h.id)}" needs "markdown".`);
  }
  const statusItems = arr<Record<string, unknown>>('statusItems');
  ids('status item', statusItems);
  for (const s of statusItems) if (typeof s.text !== 'string' || !s.text.trim() || s.text.length > 60) throw new ManifestError(`Status item "${String(s.id)}" needs "text" (at most 60 characters).`);
  const themes = arr<Record<string, unknown>>('themes');
  ids('theme', themes);
  for (const t of themes) {
    if (typeof t.label !== 'string' || !t.label.trim()) throw new ManifestError(`Theme "${String(t.id)}" needs a "label".`);
    if (t.mode !== 'light' && t.mode !== 'dark') throw new ManifestError(`Theme "${String(t.id)}" needs "mode": "light" or "dark".`);
    for (const k of ['background', 'foreground', 'accent']) if (typeof t[k] !== 'string' || !HEX.test(t[k] as string)) throw new ManifestError(`Theme "${String(t.id)}" needs "${k}" as a #hex colour.`);
  }
  const prompts = arr<Record<string, unknown>>('prompts');
  ids('prompt', prompts);
  for (const p of prompts) { title('Prompt', p); icon('Prompt', p); if (typeof p.prompt !== 'string' || !p.prompt.trim()) throw new ManifestError(`Prompt "${String(p.id)}" needs "prompt".`); }
  const onboarding = arr<Record<string, unknown>>('onboarding');
  ids('onboarding step', onboarding);
  for (const o of onboarding) { title('Onboarding step', o); if (typeof o.view !== 'string' || !o.view) throw new ManifestError(`Onboarding step "${String(o.id)}" needs a "view".`); }
  const dataSources = arr<Record<string, unknown>>('dataSources');
  ids('data source', dataSources);
  for (const d of dataSources) {
    title('Data source', d); icon('Data source', d);
    if (typeof d.route !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/.test(d.route)) throw new ManifestError(`Data source "${String(d.id)}" needs a "route": a path of this plugin's own routes.`);
    if (d.params !== undefined) checkSchema(`Data source "${String(d.id)}"`, d.params);
  }
  const widgets = arr<Record<string, unknown>>('dashboardWidgets');
  ids('widget', widgets);
  for (const w of widgets) { title('Widget', w); icon('Widget', w); if (typeof w.fence !== 'string' || !FENCE.test(w.fence)) throw new ManifestError(`Widget "${String(w.id)}" needs a "fence" language whose renderer draws it.`); }
  const blockActions = arr<Record<string, unknown>>('blockActions');
  ids('block action', blockActions);
  for (const b of blockActions) {
    title('Block action', b); icon('Block action', b);
    if (!Array.isArray(b.kinds) || !b.kinds.length || !b.kinds.every((k) => typeof k === 'string' && FENCE.test(k))) throw new ManifestError(`Block action "${String(b.id)}" needs "kinds": the block kinds it applies to (chart, viz, table, csv ...).`);
    if (typeof b.command !== 'string' || !b.command) throw new ManifestError(`Block action "${String(b.id)}" needs a "command" to run.`);
  }

  // Trust: what the contributions need, at most what the manifest declares, at most the host's ceiling.
  const needed: UiTrust = usesNative ? 'native' : usesCode ? 'frame' : 'declarative';
  const declared = m.trust === undefined ? needed : String(m.trust);
  if (!['declarative', 'frame', 'native'].includes(declared)) throw new ManifestError('"ui.trust" is declarative, frame or native.');
  const rank = (t: string) => ['declarative', 'frame', 'native'].indexOf(t);
  if (rank(declared) < rank(needed)) throw new ManifestError(`"ui.trust" is "${declared}" but the contributions need "${needed}" (${needed === 'native' ? 'native components' : 'frame entries'}).`);
  const ceiling = opts.trustCeiling ?? 'frame';
  if (rank(declared) > rank(ceiling)) throw new ManifestError(declared === 'native' ? 'Native UI is only for plugins signed by a key this app trusts; use "frame" for your own UI.' : `"ui.trust" "${declared}" is more than this host allows (${ceiling}).`);

  const caps = m.capabilities === undefined ? [] : m.capabilities;
  if (!Array.isArray(caps) || !caps.every((x) => (CAPABILITIES as readonly string[]).includes(String(x)))) throw new ManifestError(`"ui.capabilities" lists capabilities from: ${CAPABILITIES.join(', ')}.`);
  if (caps.length && declared === 'declarative') throw new ManifestError('"ui.capabilities" are for frame or native UI; declarative UI runs no code.');

  return {
    apiVersion,
    displayName: typeof m.displayName === 'string' ? m.displayName.slice(0, 60) : undefined,
    icon: typeof m.icon === 'string' && (ICON_NAMES as readonly string[]).includes(m.icon) ? m.icon as IconName : undefined,
    category: typeof m.category === 'string' ? m.category.slice(0, 40) : undefined,
    trust: declared as UiTrust,
    capabilities: [...new Set(caps as Capability[])],
    ...(m.required === true ? { required: true } : {}),
    contributes: {
      navItems: navItems as NavItemContribution[], views: views as unknown as ViewContribution[], panels: panels as unknown as PanelContribution[],
      commands: commands as unknown as CommandContribution[], slashCommands: slashCommands as unknown as SlashCommandContribution[],
      composerChips: composerChips as unknown as ComposerChipContribution[], settings: settings as unknown as SettingsContribution[],
      renderers: renderers as unknown as RendererContribution[], homeCards: homeCards as unknown as HomeCardContribution[],
      statusItems: statusItems as unknown as StatusItemContribution[], themes: themes as unknown as ThemeContribution[],
      prompts: prompts as unknown as PromptContribution[], onboarding: onboarding as unknown as OnboardingContribution[],
      dataSources: dataSources as unknown as DataSourceContribution[], dashboardWidgets: widgets as unknown as WidgetContribution[], blockActions: blockActions as unknown as BlockActionContribution[],
    },
  };
}

/** Every file a manifest's frame contributions load (for serving and hashing). */
export function uiEntries(ui: UiManifest): string[] {
  const c = ui.contributes;
  return [...new Set([...c.views, ...c.panels, ...c.renderers, ...c.homeCards].flatMap((x) => ('kind' in x && x.kind === 'frame' && 'entry' in x && typeof x.entry === 'string' ? [x.entry] : [])))];
}

/** Resolves a view reference from a plugin: `<id>` means its own view, `<plugin>:<id>` another's. */
export function qualify(plugin: string, ref: string): string {
  return ref.includes(':') ? ref : `${plugin}:${ref}`;
}
