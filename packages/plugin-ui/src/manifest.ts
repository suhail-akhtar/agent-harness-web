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

/** Where validateUiManifest collects what it put right (an unknown icon); set only while it runs. */
let fixes: string[] | undefined;
/** The icon names nearest to one the set lacks (by edit distance), for the warning. */
function nearestIcons(name: string): string[] {
  const d = (a: string, b: string) => { const row = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { let prev = row[0]!; row[0] = i; for (let j = 1; j <= b.length; j++) { const t = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } } return row[b.length]!; };
  return [...ICON_NAMES].sort((a, b) => d(name, a) - d(name, b)).slice(0, 4);
}
/**
 * An icon from the set, or "puzzle" with a warning for one it lacks: a wrong icon name is not worth
 * losing a plugin's whole UI over (the warning says which names come closest).
 */
function iconOf(raw: unknown, where: string): IconName | undefined {
  if (raw === undefined) return undefined;
  if ((ICON_NAMES as readonly string[]).includes(String(raw))) return raw as IconName;
  fixes?.push(`${where}: unknown icon "${String(raw)}", shown as "puzzle" (nearest: ${nearestIcons(String(raw)).join(', ')}).`);
  return 'puzzle';
}

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
  /** A live value shown as a count: `<plugin>.<name>`, set by a frame's `badge.set`, a built-in's store, or a badge source (`ui.badges`). */
  badge?: string;
}

/**
 * Where a badge's value comes from while no page of the plugin is open (`ui.badges`): the host reads
 * the plugin's own signed-in route (auth "user") as the person, every `every` seconds (at least 15;
 * paused while the window is hidden), and at once when the plugin's server half signals (`signal`).
 * The route answers the value (a number, short text or null), or an object holding it by `name`
 * (one route can feed several badges: it is read once for all of them).
 */
export interface BadgeSource {
  /** The badge it sets: `<plugin>.<name>` (what navItems[].badge and statusItems' `{...}` name). */
  name: string;
  /** One of this plugin's route paths (GET unless `method`). */
  route: string;
  method?: 'GET' | 'POST';
  /** Seconds between reads (15 to 86400; default 60). */
  every?: number;
  /** Read again at once when the plugin's server half calls api.signal() (a `plugins` event). */
  signal?: boolean;
}

export const BADGE_MIN_SECONDS = 15;

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
/** A dashboard template: pages with a layout and placeholder widgets ($m1, $date:month, $cat1, $entity), filled from a model. */
export interface DashboardTemplateContribution { id: string; title: string; purpose?: string; description?: string; icon?: IconName; pages: Array<{ name: string; layout?: { type: string; [k: string]: unknown }; visuals: Array<Record<string, unknown>> }> }
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
  dashboardTemplates?: DashboardTemplateContribution[];
}

export const CONTRIBUTION_POINTS = ['navItems', 'views', 'panels', 'commands', 'slashCommands', 'composerChips', 'settings', 'renderers', 'homeCards', 'statusItems', 'themes', 'prompts', 'onboarding', 'dataSources', 'dashboardWidgets', 'blockActions', 'dashboardTemplates'] as const;

/**
 * An item of a plugin's own menu (`ui.menu.items`): a nav item by id (this plugin's, or another's as
 * "<plugin>:<id>": core.agents lists the Library of core.artifacts), or an item of its own.
 */
export type MenuItemRef = string | MenuItemInline;
/** A menu item the menu itself defines: like a nav item, with sub-items (one level deep). */
export interface MenuItemInline {
  id: string;
  title: string;
  icon?: IconName;
  /** A view id: `<id>` of this plugin's views, or `<plugin>:<id>`. */
  view: string;
  params?: Record<string, string>;
  /** A live value shown as a count (see NavItemContribution.badge). */
  badge?: string;
  /** Sub-items: refs or inline items without children of their own. */
  children?: Array<string | Omit<MenuItemInline, 'children'>>;
}
/**
 * The plugin as a module of the app: one group in the sidebar (a header with its icon and title that
 * opens the plugin's home, its items under it), "Plugin > Item" in the palette and the breadcrumbs.
 */
export interface MenuContribution {
  /** The group's title (default: displayName). */
  title?: string;
  icon?: IconName;
  /** Where the group sits among the others until the person reorders them (default 100). */
  order?: number;
  /** Starts folded (the person's choice is remembered either way). */
  collapsed?: boolean;
  items: MenuItemRef[];
}

export const MENU_MAX_ITEMS = 40;
export const MENU_MAX_CHILDREN = 20;
export const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

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
  /** Badge values the host keeps current while no page of the plugin is open (see BadgeSource). */
  badges?: BadgeSource[];
  /** The plugin's menu: it shows as a group in the sidebar (see MenuContribution). */
  menu?: MenuContribution;
  /** The plugin's landing page (a view id); without one the shell draws a home from the manifest. */
  home?: string;
  /** The plugin's guide for agents: a Markdown file in the plugin folder (frontmatter `description`: its one-sentence purpose). */
  guide?: string;
  /** Tools of the plugin's server half (or of the engine) its pages drive: named in its guide and in desktop_describe. */
  tools?: string[];
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
  /** Suggested values: shown as chips that fill the field in (a list adds them). */
  examples?: Array<string | number>;
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

const QREF = /^([a-z0-9][a-z0-9._-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,62}$/i;

/**
 * `ui.menu`: refs name this plugin's nav items (or "<plugin>:<id>" another's, resolved when the app
 * builds its registry); inline items are checked like nav items; sub-items one level deep; an id once.
 */
function checkMenu(raw: unknown, navItems: Array<Record<string, unknown>>, views: Array<Record<string, unknown>>): MenuContribution {
  if (!isObj(raw)) throw new ManifestError('"ui.menu" is an object: { "title"?, "icon"?, "order"?, "collapsed"?, "items": [...] }.');
  const m = raw;
  if (m.title !== undefined && (typeof m.title !== 'string' || !m.title.trim() || m.title.length > 40)) throw new ManifestError('"ui.menu.title" is at most 40 characters.');
  if (m.icon !== undefined) m.icon = iconOf(m.icon, '"ui.menu.icon"');
  if (m.order !== undefined && (typeof m.order !== 'number' || !Number.isFinite(m.order))) throw new ManifestError('"ui.menu.order" is a number.');
  if (m.collapsed !== undefined && typeof m.collapsed !== 'boolean') throw new ManifestError('"ui.menu.collapsed" is true or false.');
  if (!Array.isArray(m.items) || !m.items.length || m.items.length > MENU_MAX_ITEMS) throw new ManifestError(`"ui.menu.items" is a list of 1 to ${MENU_MAX_ITEMS} items: nav item ids, or { "id", "title", "view", "children"? }.`);
  const seen = new Set<string>();
  const navIds = new Set(navItems.map((n) => String(n.id)));
  const item = (it: unknown, where: string, depth: number): MenuItemRef => {
    if (typeof it === 'string') {
      if (!QREF.test(it)) throw new ManifestError(`${where}: "${it}" is not a nav item id ("<id>" or "<plugin>:<id>").`);
      if (!it.includes(':') && !navIds.has(it)) throw new ManifestError(`${where}: "${it}" is not one of this plugin's nav items (name another plugin's as "<plugin>:<id>").`);
      if (seen.has(it)) throw new ManifestError(`${where}: "${it}" is in the menu twice.`);
      seen.add(it);
      return it;
    }
    if (!isObj(it)) throw new ManifestError(`${where}: an item is a nav item id or an object.`);
    if (typeof it.id !== 'string' || !ID.test(it.id)) throw new ManifestError(`${where}: every inline item needs an "id" (letters, digits, dot, dash).`);
    if (seen.has(it.id) || navIds.has(it.id)) throw new ManifestError(`${where}: the id "${it.id}" is taken (by another item or a nav item).`);
    seen.add(it.id);
    if (typeof it.title !== 'string' || !it.title.trim() || it.title.length > 80) throw new ManifestError(`${where}: item "${it.id}" needs a "title" (at most 80 characters).`);
    if (it.icon !== undefined) it.icon = iconOf(it.icon, `${where}: item "${it.id}"`);
    if (typeof it.view !== 'string' || !QREF.test(it.view)) throw new ManifestError(`${where}: item "${it.id}" needs a "view".`);
    if (!it.view.includes(':') && !views.some((v) => v.id === it.view)) throw new ManifestError(`${where}: item "${it.id}" opens "${it.view}", which is not one of this plugin's views.`);
    if (it.params !== undefined && (!isObj(it.params) || !Object.values(it.params).every((v) => typeof v === 'string'))) throw new ManifestError(`${where}: item "${it.id}": "params" are text values.`);
    if (it.badge !== undefined && (typeof it.badge !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(it.badge))) throw new ManifestError(`${where}: item "${it.id}": "badge" is "<plugin>.<name>".`);
    const out: MenuItemInline = { id: it.id, title: it.title.trim(), view: it.view, ...(it.icon !== undefined ? { icon: it.icon as IconName } : {}), ...(it.params ? { params: it.params as Record<string, string> } : {}), ...(it.badge ? { badge: it.badge } : {}) };
    if (it.children !== undefined) {
      if (depth > 0) throw new ManifestError(`${where}: item "${it.id}": sub-items go one level deep.`);
      if (!Array.isArray(it.children) || it.children.length > MENU_MAX_CHILDREN) throw new ManifestError(`${where}: item "${it.id}": "children" is a list of at most ${MENU_MAX_CHILDREN} items.`);
      out.children = it.children.map((c, i) => item(c, `${where} > ${it.id}[${i}]`, depth + 1) as Omit<MenuItemInline, 'children'>);
    }
    return out;
  };
  const items = m.items.map((it, i) => item(it, `"ui.menu.items[${i}]"`, 0));
  return { items, ...(typeof m.title === 'string' ? { title: m.title.trim() } : {}), ...(m.icon !== undefined ? { icon: m.icon as IconName } : {}), ...(typeof m.order === 'number' ? { order: m.order } : {}), ...(typeof m.collapsed === 'boolean' ? { collapsed: m.collapsed } : {}) };
}

/**
 * Validates and normalises the `ui` section. Throws a ManifestError a person (or model) can act on.
 * `trustCeiling` is the most the host allows this plugin (native only for signed first-party ones).
 */
export function validateUiManifest(input: unknown, opts: { trustCeiling?: UiTrust; warnings?: string[] } = {}): UiManifest {
  const before = fixes;
  fixes = opts.warnings ?? [];
  try { return validateUi(input, opts); } finally { fixes = before; }
}

function validateUi(input: unknown, opts: { trustCeiling?: UiTrust }): UiManifest {
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
  const icon = (kind: string, it: Record<string, unknown>) => { if (it.icon !== undefined) it.icon = iconOf(it.icon, `${kind} "${String(it.id)}"`); };
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
  const dashboardTemplates = arr<Record<string, unknown>>('dashboardTemplates');
  ids('dashboard template', dashboardTemplates);
  for (const t of dashboardTemplates) {
    title('Dashboard template', t); icon('Dashboard template', t);
    if (!Array.isArray(t.pages) || !t.pages.length || t.pages.length > 20) throw new ManifestError(`Dashboard template "${String(t.id)}" needs "pages" (1 to 20).`);
    for (const p of t.pages as Array<Record<string, unknown>>) {
      if (!isObj(p) || typeof p.name !== 'string' || !Array.isArray(p.visuals) || p.visuals.length > 60 || !p.visuals.every(isObj)) throw new ManifestError(`Dashboard template "${String(t.id)}": every page is {name, layout?, visuals: [...]} (at most 60 widgets).`);
      const lt = (p.layout as { type?: unknown } | undefined)?.type;
      if (p.layout !== undefined && !['grid', 'canvas', 'sections', 'tabs', 'sidebar', 'masonry', 'story', 'tv', 'print'].includes(String(lt))) throw new ManifestError(`Dashboard template "${String(t.id)}": layout type "${String(lt)}" is not one of grid, canvas, sections, tabs, sidebar, masonry, story, tv, print.`);
    }
  }
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

  // Badge sources: the plugin's own routes, read by the host as the person (so the plugin must declare routes.call).
  let badges: BadgeSource[] | undefined;
  if (m.badges !== undefined) {
    if (!Array.isArray(m.badges) || m.badges.length > 20 || !m.badges.every(isObj)) throw new ManifestError('"ui.badges" is a list of at most 20 badge sources ({ "name", "route", "every" }).');
    if (!caps.includes('routes.call')) throw new ManifestError('"ui.badges" read the plugin\'s own routes: declare the "routes.call" capability.');
    const seen = new Set<string>();
    badges = (m.badges as Array<Record<string, unknown>>).map((b) => {
      if (typeof b.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,40}$/.test(b.name)) throw new ManifestError(`Badge source ${JSON.stringify(b.name)}: "name" is letters, digits, dot, dash and underscore (at most 40).`);
      if (seen.has(b.name)) throw new ManifestError(`Duplicate badge source "${b.name}".`);
      seen.add(b.name);
      if (typeof b.route !== 'string' || !/^[a-z0-9][a-z0-9/_.-]{0,127}$/i.test(b.route) || b.route.includes('..')) throw new ManifestError(`Badge source "${b.name}": "route" must be one of this plugin's route paths.`);
      if (b.method !== undefined && b.method !== 'GET' && b.method !== 'POST') throw new ManifestError(`Badge source "${b.name}": "method" is GET or POST.`);
      if (b.every !== undefined && (typeof b.every !== 'number' || !Number.isInteger(b.every) || b.every < BADGE_MIN_SECONDS || b.every > 86_400)) throw new ManifestError(`Badge source "${b.name}": "every" is whole seconds, ${BADGE_MIN_SECONDS} to 86400.`);
      if (b.signal !== undefined && typeof b.signal !== 'boolean') throw new ManifestError(`Badge source "${b.name}": "signal" is true or false.`);
      return { name: b.name, route: b.route, ...(b.method ? { method: b.method as 'GET' | 'POST' } : {}), ...(b.every !== undefined ? { every: b.every } : {}), ...(b.signal ? { signal: true } : {}) };
    });
  }

  const menu = m.menu === undefined ? undefined : checkMenu(m.menu, navItems, views);
  let home: string | undefined;
  if (m.home !== undefined) {
    if (typeof m.home !== 'string' || !/^([a-z0-9][a-z0-9._-]{0,62}:)?[a-z0-9][a-z0-9._-]{0,62}$/i.test(m.home)) throw new ManifestError('"ui.home" is a view id ("<id>" of this plugin\'s views, or "<plugin>:<id>").');
    if (!m.home.includes(':') && !views.some((v) => v.id === m.home)) throw new ManifestError(`"ui.home" names "${m.home}", which is not one of this plugin's views.`);
    home = m.home;
  }
  if (m.guide !== undefined && (!isPluginFile(m.guide) || !/\.md$/i.test(String(m.guide)))) throw new ManifestError('"ui.guide" is a Markdown file inside the plugin folder (e.g. "GUIDE.md").');
  let tools: string[] | undefined;
  if (m.tools !== undefined) {
    if (!Array.isArray(m.tools) || m.tools.length > 40 || !m.tools.every((t) => typeof t === 'string' && TOOL_NAME.test(t))) throw new ManifestError('"ui.tools" is a list of at most 40 tool names.');
    tools = [...new Set(m.tools as string[])];
  }

  return {
    apiVersion,
    ...(menu ? { menu } : {}), ...(home ? { home } : {}), ...(m.guide !== undefined ? { guide: String(m.guide) } : {}), ...(tools ? { tools } : {}),
    displayName: typeof m.displayName === 'string' ? m.displayName.slice(0, 60) : undefined,
    icon: iconOf(m.icon, '"ui.icon"'),
    category: typeof m.category === 'string' ? m.category.slice(0, 40) : undefined,
    trust: declared as UiTrust,
    capabilities: [...new Set(caps as Capability[])],
    ...(m.required === true ? { required: true } : {}),
    ...(badges ? { badges } : {}),
    contributes: {
      navItems: navItems as NavItemContribution[], views: views as unknown as ViewContribution[], panels: panels as unknown as PanelContribution[],
      commands: commands as unknown as CommandContribution[], slashCommands: slashCommands as unknown as SlashCommandContribution[],
      composerChips: composerChips as unknown as ComposerChipContribution[], settings: settings as unknown as SettingsContribution[],
      renderers: renderers as unknown as RendererContribution[], homeCards: homeCards as unknown as HomeCardContribution[],
      statusItems: statusItems as unknown as StatusItemContribution[], themes: themes as unknown as ThemeContribution[],
      prompts: prompts as unknown as PromptContribution[], onboarding: onboarding as unknown as OnboardingContribution[],
      dataSources: dataSources as unknown as DataSourceContribution[], dashboardWidgets: widgets as unknown as WidgetContribution[], blockActions: blockActions as unknown as BlockActionContribution[], dashboardTemplates: dashboardTemplates as unknown as DashboardTemplateContribution[],
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
