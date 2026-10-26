# harness-plugin.json

```json
{
  "name": "customer-desk",
  "version": "1.2.0",
  "description": "A support desk: tickets and contacts the agent and the team work together, with triage and reply drafts.",
  "main": "index.ts",
  "skills": "skills",
  "agents": "agents",
  "workflows": "workflows",
  "outputStyles": "styles",
  "mcpServers": { "crm": { "command": "node", "args": ["mcp/crm.mjs"], "env": { "CRM_KEY": "${CRM_KEY}" } } },
  "hooks": { "PostToolUse": [{ "type": "command", "matcher": "desk_ticket_update", "command": "node hooks/audit.mjs" }] },
  "permissions": { "routes": true, "sessions": true, "network": ["api.crm.example.com"], "secrets": ["CRM_KEY"], "vault": ["desk-*"] },
  "ui": { "apiVersion": 1, "...": "see below" }
}
```

| Field | |
|---|---|
| `name` | lowercase letters, digits, `.` `_` `-`; unique on the server |
| `version` | semantic version (`1.2.0`): `api.store` versions are separate |
| `description` | one or two sentences: shown before it is added, read by agents |
| `main` | the server code (`.ts`, `.mjs`, `.js`): default-exports `{ name, setup(api), close? }` |
| `skills` | a folder of skills: `<skill>/SKILL.md` with `name` and `description` frontmatter, plus any files it names (loaded with `skill` and `file`) |
| `agents` | a folder of sub-agent definitions (`<name>.md`: frontmatter `name`, `description`, `tools`, `model`, `effort`; the body is its prompt) |
| `workflows` | a folder of workflow graphs (`<name>.json`) |
| `outputStyles` | a folder of output styles (`<name>.md`: how to reply) |
| `mcpServers` | MCP servers, Claude Code's format (`command`/`args`/`env`, or `{ "type": "http", "url", "headers" }`) |
| `hooks` | per event, a list of `{ type: command \| http \| prompt, matcher?, command?, url?, headers?, prompt? }` (an HTTP hook only to declared hosts, `${VAR}` in headers only for declared secrets) |
| `permissions` | what its code may reach (below) |
| `ui` | its desktop UI (below) |

## permissions

| Key | Grants | Without it |
|---|---|---|
| `routes: true` | `api.registerRoute` | registering a route throws |
| `sessions: true` | `api.sessions`, `api.events` (start, drive and answer conversations; every session's events) | those calls throw |
| `network: ["host", "*.domain"]` | `api.fetch` and HTTP hooks to those hosts | every `api.fetch` is refused |
| `secrets: ["NAME"]` | `api.secret(NAME)`, `${NAME}` in its MCP servers and hooks | `api.secret` throws, `${NAME}` is empty |
| `vault: ["glob-*"]` | key-vault entries its tools and `api.vault` may read (an administrator still grants each) | no vault access |

People see every permission before they add the plugin; the review flags declared ones that are not
used, and used ones that are not declared.

## ui

```json
"ui": {
  "apiVersion": 1,
  "displayName": "Customer desk",
  "icon": "inbox",
  "guide": "GUIDE.md",
  "capabilities": ["routes.call", "events.subscribe", "sessions.start", "settings.read", "settings.write"],
  "home": "overview",
  "menu": { "title": "Customer desk", "icon": "inbox", "items": ["overview", "tickets", { "id": "people", "title": "Contacts", "icon": "users", "view": "contacts" }] },
  "badges": [{ "name": "open", "route": "badge", "every": 120, "signal": true }],
  "tools": ["desk_ticket_create", "desk_ticket_search"],
  "contributes": { "navItems": [], "views": [], "...": "contribution points below" }
}
```

| Field | |
|---|---|
| `apiVersion` | `1` |
| `displayName`, `icon` | its name and icon in the app (icons: see below) |
| `guide` | a Markdown file for agents (what it does, its tools, where its data is): desktop sessions list the plugin and load it on demand |
| `capabilities` | what its pages may ask the app for (PAGES.md); the person is asked once, and again when the list grows |
| `home` | the view its menu header opens (default: a home drawn from the manifest: its pages, commands, settings) |
| `menu` | its own group of pages: `items` are nav item ids, other plugins' `"<plugin>:<id>"`, or inline `{ id, title, icon, view, params?, badge?, children? }` (one level of children). Added plugins with a menu show under **Custom** with their pages under them; opened as their own app, the menu is the window's first group |
| `badges` | live counts while no page is open: the host reads the route (auth `user`) every `every` seconds (15 minimum, default 60) and at once on `api.signal` when `signal`; the route answers a number, short text, `null`, or an object holding it under `name` |
| `tools` | its server tools its pages drive (named in its guide and to agents) |

## Contribution points (`ui.contributes`)

Ids are lowercase (`[a-z0-9._-]`); a view named in another field is `<id>` (its own) or `<plugin>:<id>`.

| Point | Shape | What it is |
|---|---|---|
| `navItems` | `{ id, title, icon?, view, params?, placement?: primary \| more \| footer, order?, badge? }` | an entry in the sidebar (under Custom for added plugins); `badge` is `<plugin>.<name>` |
| `views` | `{ id, title, icon?, description?, kind, ... }` | a page: `frame` (`entry`: its HTML), `markdown` (`markdown`), `links` (`links: [{title, url, description?}]`), `prompt-board` (`prompts: [{title, prompt, icon?}]`), `form` (`schema` + `submit: { label?, action }`) |
| `panels` | `{ id, title, icon?, kind: 'frame', entry, where?: session \| page \| any }` | a side panel next to a conversation or a page |
| `commands` | `{ id, title, category?, icon?, keybinding?, action, agent? }` | an entry in the command palette (Ctrl+K); `keybinding` like `"Mod+Alt+G"`; `agent: { description, inputSchema? }` lets agents run it (desktop_command) |
| `slashCommands` | `{ name, description, action }` | `/name` in the composer; `{args}` in a prompt action is what follows |
| `composerChips` | `{ id, title, icon?, kind: toggle \| select, setting, options? }` | a chip under the composer, sent with each message as context |
| `settings` | `{ id, title, icon?, group?, order?, scope: app \| account \| operator, schema }` | a settings section from a JSON Schema (`app`: this computer; `account`: the person's, on the server; `operator`: administrators) |
| `renderers` | `{ id, for: { tool } \| { event } \| { fence } \| { artifact }, kind: 'frame', entry, height? }` | draws a tool's results, an event, a code-fence language or an artifact kind in conversations |
| `homeCards` | `{ id, title, kind: frame \| markdown, entry?, markdown?, order? }` | a card on the app's home page |
| `statusItems` | `{ id, text, tooltip?, command?, align?, order? }` | text in the status bar; `{<plugin>.<badge>}` in `text` is a live value |
| `themes` | `{ id, label, mode, background, foreground, accent }` | a color theme |
| `prompts` | `{ id, title, prompt, icon?, home? }` | a ready prompt (on the home page with `home`) |
| `onboarding` | `{ id, title, description?, view, order? }` | a setup step |
| `dataSources` | `{ id, title, icon?, description?, route, params? }` | a data source for Dashboards: its route returns rows (`[{...}]`, `[header, ...rows]` or `{ columns, rows }`); `params` (a JSON Schema) become query parameters |
| `dashboardWidgets` | `{ id, title, icon?, description?, fence }` | a dashboard visual drawn by a fence renderer |
| `dashboardTemplates` | `{ id, title, purpose?, pages }` | a dashboard template |
| `blockActions` | `{ id, title, icon?, kinds, command }` | an action on rendered blocks in a transcript (a chart, a table) |

### Actions (`action` of commands, slash commands, forms, status items)

| `type` | Fields | Does |
|---|---|---|
| `prompt` | `prompt`, `newChat?` | puts text in the composer (never sent without the person) |
| `open-view` | `view`, `params?` | opens a page |
| `open-panel` | `panel` | opens a side panel |
| `route` | `path`, `method?`, `body?` | calls its own route; the result shows as a toast |
| `workflow` | `workflow`, `input?` | opens the workflow start dialog (the person confirms) |
| `command` | `command`, `args?` | runs another command |
| `open-url` / `browse` | `url` | the system browser / the built-in browser |
| `terminal` | `command`, `cwd?` | a command in the terminal panel, shown before it runs |
| `theme` | `theme` | switches the theme |

### Icons

activity, alert, apps, archive, arrow-down, arrow-left, arrow-right, arrow-up, atom, bell, bolt, book,
bookmark, bot, box, brain, bug, calculator, calendar, chart, chat, check, clock, cloud, code, command,
compass, copy, cpu, database, dollar, download, edit, external, eye, file, file-text, files, filter,
flask, folder, folder-open, folder-plus, function, git, git-branch, git-pr, globe, grid, heart, help,
history, home, image, inbox, info, key, keyboard, layers, library, link, list, lock, mail, map, memory,
monitor, moon, palette, panel-right, paperclip, pause, pin, play, plug, plus, puzzle, refresh, robot,
rocket, save, search, server, settings, share, shield, sidebar, sparkles, stack, star, stop, sun, table,
tag, terminal, trash, upload, user, users, vault, warning, workflow, wrench, x, zap. An unknown name
shows as `puzzle` (the check warns with the nearest names).

## Where a plugin shows in the app

- Added plugins (installed, loaded from a folder) sit under **Custom** in the sidebar: one page as an
  entry, a `menu` as an entry with its pages under it.
- **Open as app** (its card on the Plugins page, or its home) opens a window focused on it: its menu
  first, its home, its name; everything else is still there. **Desktop shortcut** makes a shortcut
  that starts the app that way (`--plugin=<name>`).
- The command palette lists its commands; its pages read "Plugin > Page" in the breadcrumbs.
