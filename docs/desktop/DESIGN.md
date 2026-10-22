# Harness Desktop - design

Status: the contract for the desktop work. Codename "Harness Desktop"; every name, icon and colour a
person sees comes from a product profile (section 8), so the same core ships under any brand.

## 1. Purpose

One **core desktop shell** on top of the harness, where **everything is a plugin**: the chat, projects,
settings sections, the inbox and the code view are plugins built on the same API a third party gets. A
specialised product - an operations console, a coding studio, a security workbench, an enterprise suite
of all of them - is this core plus a set of plugins plus a product profile. Anyone can build an
AI-driven or agent-driven application on it without changing the core.

**Scope: the core only.** This repository builds the generic shell and its built-in plugins - nothing
specific to one domain. Domain products (operations, coding, security, anything) are derived later by
adding plugins and a product profile, or by forking the core; the core must make that possible without
changes to it.

Principles:

1. **The shell names no feature.** Sidebar entries, pages, panels, composer chips, slash commands,
   settings sections, status items, home cards and renderers all come from plugins. Turning a plugin off
   removes all of its contributions at once.
2. **The built-ins use the public API.** If a built-in needs something a plugin cannot do, the API is
   missing a contribution point; we add it rather than special-case the built-in.
3. **One plugin package, two halves.** The server half (tools, agents, workflows, gates, routes, event
   handlers - already in the harness) and the UI half (this document) live in one `harness-plugin.json`.
   A plugin brings its tools *and* the pages that use them.
4. **Same engine, local or remote.** The desktop is a client of the harness HTTP API. Locally it starts
   the engine itself; for a team or an enterprise it connects to a server (single sign-on), or to
   several.
5. **Safe by construction.** The renderer never holds the engine token; plugin UI code runs isolated and
   gets only the capabilities its manifest declares and a person (or the operator) granted; every
   change the agent makes still goes through the harness's permissions and approvals.
6. **Nothing interrupts work.** Updates wait for idle, notifications only when the window is in the
   background, approvals queue in one inbox.

## 2. Architecture

```
 ┌──────────────────────────── Electron app ─────────────────────────────┐
 │ main process                                                          │
 │   engine host ── utilityProcess: the harness server (local mode)      │
 │   harness://app  ── serves the UI, proxies /api/* (adds the token),   │
 │                     serves plugin UI files under a sandbox CSP        │
 │   services: windows, tray, notifications, updater, files, terminal,   │
 │             git, keychain, deep links, plugin trust                   │
 │   preload ── invoke/on over an allowlist of channel prefixes          │
 │                                                                       │
 │ renderer (React)                                                      │
 │   shell: sidebar, top bar, status bar, command palette, settings      │
 │          modal, router, toasts, popovers, theme                       │
 │   registry: every contribution from every enabled plugin              │
 │   built-in plugins (React, first-party)                               │
 │   plugin frames (sandboxed iframes, @harness/plugin-ui SDK over       │
 │                  postMessage, capability-checked by the host)         │
 └───────────────────────────────────────────────────────────────────────┘
            │ harness://app/api/*  (local)      or      https://server/api/* (remote)
            ▼
     harness server: sessions, agents, workflows, plugins (server halves), vault, ...
```

Process model and security (taken from AICO, which got this right):

- The engine runs in an Electron `utilityProcess` started with a random token and a loopback port. It is
  restarted with backoff; its last log lines are kept so the "engine gate" screen shows real errors and
  a Restart button instead of a spinner.
- The renderer is served from the privileged scheme `harness://app/`. Requests to
  `harness://app/api/...` are proxied by main to the engine with the token attached; the renderer never
  sees the token. For a remote server the same proxy attaches that server's session (from the OS
  keychain), so renderer code is identical in both modes.
- `contextIsolation`, `sandbox: true`, no `nodeIntegration`; the preload exposes only `invoke` and `on`
  over channel prefixes main registered; every IPC handler refuses anything but the top frame of
  `harness://app`.
- Plugin UI files are served from `harness://app/plugins/<id>/` with a strict CSP; frames are
  `sandbox="allow-scripts allow-forms"` without `allow-same-origin`, so they have an opaque origin, no
  cookies, no access to the shell's DOM and no IPC.

## 3. Repository layout

npm workspaces in this repository:

| Path | What |
|---|---|
| `packages/plugin-ui` | The UI contract: manifest types and validation, contribution points, the capability list, the frame RPC protocol, and the SDK plugin frames import (`@harness/plugin-ui/sdk`). No React. |
| `packages/client` | A typed client of the harness HTTP API and its event streams, shared by the desktop and the browser UI. |
| `packages/ui` | The design system: tokens, theme builder, components (Button, Popover, Modal, Menu, Tabs, Toast, Tooltip, Field, CodeBlock, Markdown, Diff, EmptyState...), icons by name. |
| `apps/desktop` | Electron main, preload, renderer shell and the built-in plugins (`apps/desktop/renderer/src/builtins/*`). |
| `products/*.json` | Product profiles (section 8). |

Stack: Electron 44, React 19, Vite 6, Tailwind 3 with CSS-variable tokens, zustand, esbuild for main and
preload; later Monaco, xterm with node-pty, electron-builder and electron-updater. The engine stays plain
TypeScript run by Node; the desktop bundles it.

## 4. The plugin UI contract (`ui` in `harness-plugin.json`)

```jsonc
{
  "name": "acme-notes", "version": "0.1.0",
  // ... the server half as today (main: tools, agents, workflows, routes; permissions) ...
  "ui": {
    "apiVersion": 1,
    "displayName": "Notes", "icon": "book", "category": "Productivity",
    "trust": "frame",                 // declarative | frame | native (native = signed first-party only)
    "capabilities": ["sessions.read", "sessions.start", "events.subscribe", "routes.call"],
    "contributes": {
      "navItems":   [{ "id": "notes", "title": "Notes", "icon": "book", "view": "notes", "placement": "primary", "order": 30, "badge": "notes.unread" }],
      "views":      [{ "id": "notes", "title": "Notes", "kind": "frame", "entry": "ui/notes.html" }],
      "panels":     [{ "id": "outline", "title": "Outline", "kind": "frame", "entry": "ui/outline.html", "where": "session" }],
      "commands":   [{ "id": "new-note", "title": "New note", "keybinding": "Ctrl+Alt+N", "action": { "type": "open-view", "view": "notes" } }],
      "slashCommands": [{ "name": "summarise", "description": "Summarise into a note", "action": { "type": "workflow", "workflow": "summarise-to-note" } }],
      "composerChips": [{ "id": "notebook", "title": "Notebook", "kind": "select", "setting": "notes.notebook", "options": ["work", "personal"] }],
      "settings":   [{ "id": "notes", "title": "Notes", "group": "plugins", "schema": { /* JSON Schema */ }, "scope": "account" }],
      "renderers":  [{ "id": "note-card", "for": { "tool": "note_save" }, "kind": "frame", "entry": "ui/note-card.html" }],
      "homeCards":  [{ "id": "today", "title": "Today's notes", "kind": "frame", "entry": "ui/today.html", "order": 10 }],
      "statusItems":[{ "id": "unread", "text": "{notes.unread} unread", "command": "new-note" }],
      "themes":     [{ "id": "paper", "label": "Paper", "mode": "light", "background": "#fbf8f1", "foreground": "#2b2722", "accent": "#b4532a" }],
      "prompts":    [{ "id": "daily", "title": "Write today's summary", "prompt": "...", "home": true }],
      "onboarding": [{ "id": "first-notebook", "title": "Create a notebook", "view": "notes" }]
    }
  }
}
```

Contribution points (each has an `id` unique in the plugin, referenced from elsewhere as `<plugin>:<id>`):

| Point | What it adds | Kinds |
|---|---|---|
| `navItems` | A sidebar destination (primary or under More), optional live badge | - |
| `views` | A page | `markdown`, `links`, `prompt-board`, `form` (JSON Schema), `frame`, `native` |
| `panels` | A side panel next to a session or a page | `frame`, `native` |
| `commands` | Command palette entries with optional keybinding | actions below |
| `slashCommands` | `/name` in the composer | actions below |
| `composerChips` | A chip under the composer (toggle, select, picker) bound to a setting or a session option | - |
| `settings` | A settings section; JSON Schema rendered natively (no code), scope `app` (this machine), `account` (server, per person) or `operator` (read-only unless admin) | `schema`, `native` |
| `renderers` | Custom rendering of a tool result, an event kind, or a Markdown code-fence language | `frame`, `native` |
| `homeCards` | A card on the home screen (like the morning brief) | `frame`, `native`, `markdown` |
| `statusItems` | Status bar text with live values and a command | - |
| `themes` | A theme from three colours (the theme builder derives the rest) | - |
| `prompts` | Quick prompts, optionally on the home screen | - |
| `onboarding` | Steps in the first-run wizard | - |

Besides `contributes`, `ui.badges` (`[{ "name", "route", "every", "signal" }]`) names badge sources: the host
reads the plugin's own signed-in route as the person every `every` seconds (at least 15, paused while the
window is hidden) and at once when its server half calls `api.signal(name)` (a `plugins` event with no data),
so a nav badge or a status item stays current while no page of the plugin is open. It needs `routes.call`.

Actions: `prompt` (prefill, never send without the person), `open-view`, `open-panel`, `open-url`,
`browse`, `terminal` (always shown before it runs), `workflow` (opens the start dialog with inputs),
`command`, `theme`, `route` (calls the plugin's own server route and shows the result).

Trust levels:

- **declarative** - JSON only (markdown, links, prompt boards, forms, settings schemas, commands, themes).
  No code runs; no trust prompt.
- **frame** - the plugin's HTML/JS in a sandboxed frame. The SDK calls the host over `postMessage`; the
  host checks each call against the manifest's `capabilities` *and* the grant. A person grants a frame
  plugin once; the grant is tied to a hash of the plugin's files, so any change asks again. The operator
  can pre-grant or forbid by policy.
- **native** - React modules loaded into the renderer. Only for plugins signed by a key the product
  profile trusts (the built-ins, and an enterprise's own). Unsigned native plugins are refused.

Capabilities a frame can declare (each a set of SDK calls):

| Capability | SDK calls |
|---|---|
| (always) | `theme.get`, `theme.onChange`, `view.open`, `notify.toast`, `storage.get/set` (namespaced), `composer.prefill`, `registry.has/list` (what else is installed: ids and yes/no only), `render.show/hide` (a block drawn by one of the host's fence renderers over a rectangle of the frame) |
| `sessions.read` | `sessions.list`, `sessions.get`, `sessions.history` |
| `sessions.start` | `sessions.start` (shown to the person when not from their click), `sessions.send` |
| `events.subscribe` | `events.subscribe(filter)` - the global stream, filtered |
| `approvals.respond` | `approvals.list`, `approvals.respond` (only with a user gesture in the frame) |
| `routes.call` | `routes.call(path, body)` - this plugin's own server routes only |
| `files.read` | `files.list/read` within the session's or project's workspace |
| `workflows.start` | `workflows.list`, `workflows.start` (opens the dialog; the person confirms) |
| `settings.read` / `settings.write` | this plugin's own settings: `app` keys on this machine, `account` keys with the person's account (checked against the schema; the server keeps only a plugin's account keys), `operator` keys read-only |
| `clipboard.write`, `browser.open`, `external.open` | as named |

## 5. Built-in plugins

All first-party, `native`, signed, on the same registry: `core.chat` (home, composer, transcript, attention
bar, approvals), `core.projects`, `core.library` (artifacts), `core.scheduled`, `core.inbox` ("Waiting for
you"), `core.activity` (background tasks and runs), `core.workflows`, `core.plugins` (manage, install,
trust, catalogue), `core.settings` (the sections below), `core.code` (file tree, editor, diffs),
`core.terminal`, `core.git`, `core.browser`, `core.memory`, `core.vault`, `core.usage`, `core.admin`
(accounts, policy - for administrators).

## 6. Settings

A modal with search and sections from plugins, grouped App / Agent / Integrations / Plugins / Admin:
Appearance (theme, contrast, density, fonts, transcript width, motion), General (send key, steps, notifications),
Application (start at login, tray, prevent sleep, updates, data folder, backup), Models & providers (keys
in the OS keychain or the vault, base URLs, test button, defaults per task), Permissions & modes, Limits &
spend, Memory & instructions, Projects & trusted folders, Skills, Agents, Workflows, Hooks, MCP servers,
Vault, Schedules, Shortcuts (rebindable, conflicts shown), Network & proxy, Servers & accounts (local,
remote, sign-in), Privacy & data, About. Values live in one of three scopes: this machine (prefs file in
the app's data folder), the account (the server's per-account settings), the operator (policy: shown
locked to members).

## 7. Server additions the desktop needs

- `GET /api/events` - one stream for everything the person may see: session list changes, status,
  pending requests across sessions, schedules firing, plugin events, notices. Replaces polling; drives
  the tray, badges and the inbox.
- `GET /api/health`, `GET /api/version`.
- Providers and models: list, set keys (stored in the vault, never returned), base URLs, test a key, add
  OpenAI-compatible models; per-account defaults.
- Plugins: list with UI manifests and grants, enable/disable per account or operator, uninstall, update
  from the catalogue, serve plugin UI files (`/api/plugins/<name>/ui/<file>`), hot reload.
- Files: tree (lazy), read, write, create, rename, delete, search (names and content), upload; git status,
  diff, log for a session's workspace.
- Sessions: search, archive, fork (from a turn), pagination of history, attachments (images, files) on
  messages, pin, rename, groups.
- Settings: read the effective settings with their source tier; write account settings; operator settings
  for administrators.
- Native sign-in: OIDC with PKCE through the system browser and a loopback or deep-link redirect,
  returning a bearer session the desktop keeps in the OS keychain.

## 8. Product profiles (editions)

```jsonc
// products/harness.json - the core
{
  "id": "harness", "name": "Harness", "appId": "dev.harness.desktop",
  "brand": { "icon": "assets/harness.png", "accent": "#d97757", "wordmark": "Harness" },
  "plugins": { "bundled": ["core.*"], "enabled": ["core.*"], "required": ["core.chat", "core.settings", "core.plugins"] },
  "nav": { "order": ["core.chat:new", "core.chat:search", "core.library:library", "core.scheduled:scheduled", "core.inbox:inbox", "core.plugins:plugins", "core.projects:projects"] },
  "home": { "cards": ["core.inbox:attention", "core.chat:recent"] },
  "trustedKeys": ["keys/harness.pub"],
  "policy": { "lock": {}, "defaults": {} },
  "server": { "mode": "local" }
}
```

A derived product lists its plugins, nav order, home cards, theme and locked policy;
`npm run desktop:build -- --product products/<id>.json` produces its installer with its own app id, name
and icon, so editions install side by side. An enterprise suite is a profile that bundles several.

## 9. Phases

1. **Foundation.** Workspaces; `packages/plugin-ui`, `packages/client`, `packages/ui`; the server additions
   that the core needs (events stream, health, providers and models, plugin UI serving and enable/disable,
   files and git, attachments, session search/archive/fork); `apps/desktop`: engine host, scheme and proxy,
   preload, window state, single instance, tray, engine gate; renderer shell (sidebar, top bar, status bar,
   router with history, command palette, toasts, popovers, settings modal, theme builder, keybindings);
   the registry with all contribution points; `core.chat`, `core.projects`, `core.settings`,
   `core.plugins`, `core.inbox`. Ends with a Windows installer that starts, runs a session with approvals,
   and loads a declarative and a frame plugin.
2. **Built-ins to AICO's level.** Library, Scheduled, Activity, Workflows, Code (Monaco, tree, diffs),
   Terminal, Git, Browser (lighter than AICO's), Memory, Vault, Usage, onboarding wizard, notifications,
   updater, backup.
3. **Platform.** SDK published with examples and templates; signing and the catalogue in the Plugins page;
   product profiles and per-edition builds; enterprise policy; remote servers and single sign-on; several
   servers at once.

Tests at every step: unit tests for the contract (manifest validation, capability checks, registry
resolution, theme builder); server tests for each new route; Playwright driving the Electron app for the
shell (start, engine gate, a session with an approval, a frame plugin calling allowed and refused SDK
calls, settings round trip); screenshots in `docs/screenshots/desktop/`.

## 10. From AICO

Taken (adapted to this API): engine host, the scheme and its proxy, preload and IPC frame checks, the
`register(ctx)` feature pattern, the theme builder, popover/tooltip/modal/toast, icons by name, the plugin
registry shape, composer behaviour (steer vs queue, chips, `@` and `/` menus, drafts), the attention bar,
the inbox, the engine gate, update policy, notification rules. Not taken: AICO's coupling to its web
client's store, its browser's size (ours starts small), unsigned builds.

## 11. Agents that know and drive the desktop

The model must know what this app can show and do, and use it - without a word of it in the core's code
being specific to one plugin.

- **The client declares itself.** A session created by the desktop carries
  `client: {kind: 'desktop', version, renderers, tools}`: the fence languages it renders (mermaid, math,
  chart specs, csv, json, html/svg/react artifacts, every plugin renderer) and the desktop tools it serves.
  The server puts that in the session's frozen system prompt (the cache prefix stays stable), so the model
  writes a Mermaid diagram or a chart spec knowing it will be drawn, and uses artifacts for documents and
  apps.
- **Artifacts are first-class.** Tool `artifact {action: create|update|rewrite|get|list, id?, title, kind:
  markdown|html|svg|react|mermaid|code|csv|json|chart|image|pdf, content, language?}`: versioned files under
  `.harness/artifacts/<id>/v<n>` with an `artifact` event. API: `GET /api/sessions/:id/artifacts`,
  `GET /api/sessions/:id/artifacts/:aid?version=`, and across sessions `GET /api/artifacts?query=` (the
  Library). The desktop shows them in an Artifacts panel (preview/code, versions, diff between versions,
  download, open full window); html/svg/react run in a sandboxed frame without same origin.
- **Desktop tools** (served only while a desktop is attached to the session; the server forwards each call
  to the client on the event stream as `client_call {callId, tool, input}` and the client answers
  `POST /api/sessions/:id/client-result {callId, result}`, with a timeout):
  `desktop_describe` (read: the live registry - plugins, views, panels, commands, settings sections,
  renderers, themes - so the agent learns what is available), `desktop_open {view|panel|file|artifact|url}`
  (read), `desktop_notify {title, body}` (read), `desktop_command {command, args}` (external: asked unless a
  rule allows it; only commands a manifest marks `agent: {description, inputSchema}`), and `ask_user` with a
  JSON-Schema form rendered as a native form.
- **Plugins extend what agents can do in the UI** by marking commands `agent`-callable and by contributing
  renderers; `desktop_describe` lists them, so a new plugin's features are usable by the agent the moment it
  is enabled, and gone when it is disabled.

## 12. A multi-agent platform

The same powers as Claude's desktop app, on the harness:

- **Sub-agents** (exists): named agents with their own tools and models, nested up to 3 levels, in the
  background with a notification when done, continued with `send_message`. Adds: `isolation: 'worktree'`
  (the sub-agent works in its own git worktree, removed when it changed nothing) and a catalogue of agent
  types the model can browse.
- **Sessions that start sessions.** Tool `start_session {title, prompt, context: fork|fresh, initiation:
  user_asked|offer|own_initiative, use_worktree, model?, effort?}`: a full, separate session linked to its
  parent (`meta.parent`). `offer` and `own_initiative` become a proposal card the person starts or dismisses
  (`session_proposal` event; nothing runs until they do); `user_asked` starts at once within the account's
  limits. When a linked session ends a turn, the parent gets a fenced `side-session` report (first 400
  characters of its latest summary) at its next step, and an idle parent can be continued automatically
  (setting). `list_sessions {linked}`, `send_message` to a session id (delivered as a fenced note from that
  session), `hand_off {title, remaining_plan}` (move the current task to a new session and answer the
  person here), `dismiss_proposal`.
- **Limits and safety:** linked sessions inherit the account's spend and concurrency caps, a depth limit,
  the parent's permission mode at most, and the untrusted-content guard (a report from a session that read
  outside content is fenced as outside content).
- **In the desktop:** an Agents panel (a live tree: session -> sub-agents -> background tasks -> linked
  sessions, with status, cost and a click-through to each transcript), proposal cards in the chat, report
  cards when a linked session finishes, split view (two sessions side by side), chapters (`mark_chapter`
  draws a table of contents), the todo list, and workflow runs drawn as a graph with each node's agent.

## 13. Agents on several providers, with consent

Agents can work on other providers' models when the person allows it (data goes to that provider's API):
`delegation: {allowedModels, maxCostUsd?, requireApproval?}` per account under an operator cap. `agent`,
`start_session` and workflow agent nodes take `model`/`effort`; a model outside the list is refused; the
first delegation to a new provider can be asked. The allowed models are listed one line each (provider,
cost tier, context, strengths) in those tools' descriptions, so the catalogue sits in the cached prefix.
One provider's reasoning is never replayed to another; reports cross providers fenced like any report;
cost is counted per model.

## 14. Rendering for science and business intelligence

Lazily loaded, sandboxed where they run code, with no network: KaTeX with environments and mhchem
(`\ce`, `\pu`); 2D chemical structures from SMILES, 3D molecules (mol/sdf/pdb); function plots; Graphviz;
Vega-Lite (and ECharts) for statistics (histograms, box/violin, regression, heatmaps, annotated series);
a `dashboard` spec (KPI cards, charts and tables in a grid; defined in packages/plugin-ui so plugins and
models share it); tables with sort, filter, column statistics and pivots; notebooks (ipynb); GeoJSON as SVG.
Biology the same way: sequences, alignments, phylogenetic trees, plasmid maps, genome tracks, protein
3D and feature tracks, pathways, volcano / MA / survival / Manhattan plots and clustered heatmaps;
their compact formats live in a core skill offered only to sessions whose client declares them.
The client's declaration of what it renders stays under 150 tokens: it is in every request's cached prefix.

## 15. Cost

Minimal input, maximum output: the base prefix (system prompt + tools) has a token budget checked by a
test; tools appear only where they can work (desktop tools only with a desktop attached); everything
added during a session is appended (reminders), never edited into earlier messages; fresh child sessions
start from a brief, not the parent's history; reports into a parent are capped and fenced; cheaper models
take delegated sub-tasks when the person allows it.

## 16. Interactive diagrams (`core.diagrams`)

A built-in plugin that renders one JSON spec (defined in `packages/plugin-ui`, shared by models and
plugins) as a live canvas, in the transcript (a `diagram` fence), as an artifact kind, and as a plugin
view. The model is told the spec exists through the client declaration; the full spec is a skill it loads
only when it draws one (no cost to sessions that never do).

- **Views:** context (people, the system, external systems), containers, components, deployment (nested
  groups: host / network / zone / subnet / cluster / region, with addresses and sizes), data (ER: tables
  with typed fields, PK / FK / UK / PII marks, `n:1` relations, "+ N more" folding), code dependencies
  (folders and files with import counts, like AICO's code graph) and free flow charts.
- **Nodes:** a kind with its icon and caption (person, web app, mobile app, API, service, function,
  relational database, document store, cache, queue / stream, storage, batch job, reverse proxy /
  ingress, load balancer, secrets / key vault, external system, internet, browser, device, ...), title,
  technology line, status badge (done, in progress, failing, planned, changed), "integrated / bought"
  drawn dashed, size and address lines for deployment.
- **Edges:** label (uses, https, sql, env, file, ...), synchronous solid or asynchronous dashed, counts
  on bundled edges, direction.
- **Flows:** ordered steps over edges ("3. connect 10.42.29.2 -> 10.42.29.3:5432 with ...") played as an
  animation: the path draws step by step with moving dashes, the rest dims, the step label rides the edge;
  play, pause, step, speed.
- **Interaction:** pan, zoom, fit, minimap; Overview and Neighbourhood (a node and its neighbours) modes;
  click a node for a Details panel (all fields, linked files, findings); search; collapse groups; drag
  with the position kept in the spec; legend and a summary line ("3 built · 4 integrated · 8 relations ·
  9 flows · 1 finding"); "not connected" list; export SVG / PNG; light and dark.
- **Ask the agent:** a box on the canvas ("add a cache in front of the catalogue") sends the request with
  the diagram's artifact id; the agent edits the spec through the `artifact` tool and the canvas updates
  in place, the changed nodes marked `changed`.
- **Layout:** automatic (ELK layered with orthogonal routing, in a worker; AICO's layered layout as the
  fallback), stable between edits so a small change does not move everything.
- **Built:** the spec in `packages/plugin-ui/src/diagram.ts`, the renderer in
  `packages/ui/src/render/diagram/`, the plugin in `apps/desktop/renderer/src/builtins/diagrams/`, the
  `diagram` artifact kind (validated on save), `PUT /api/sessions/:id/artifacts/:aid` (a person's
  version, with `baseVersion`), `GET /api/sessions/:id/files/imports` (the code map) and the
  `diagrams` skill (`src/skills/client/`). A code map's overview leaves out implied and single
  imports (a toggle shows them); Neighbourhood keeps only ring-to-ring edges, so a hub reads as a fan.

## 17. Server implementation notes (sections 11 to 13: where they differ from the above)

The server side of sections 11 and 12 is built (README "Multi-agent" and "HTTP API for desktop clients").
Where it differs from the text above, and why:

- **Tool lists stay fixed.** A session's tools never change mid-session (it would break the cache), so
  desktop tools are declared when the session's client declaration names them and answer "unavailable"
  while no app is attached, rather than appearing and disappearing. Artifacts, chapters, desktop tools and
  the linked-session tools are declared only for sessions with a client (linked sessions: desktop or web
  clients, or the person's `linkedSessions.enabled`), so other sessions' prompts do not grow.
- **The `artifact` event nests its fields** (`{kind: 'artifact', artifact: {id, title, kind, version,
  action}}`): `kind` is every event's discriminator.
- **Client calls also reach the global stream** (topic `client`, only to the owner's own streams), so an
  app attached through `/api/events?client=desktop` can answer them; attachment is the declaration plus a
  live stream opened with `?client=<kind>` by the session's owner.
- **The client declaration may list `commands`** (agent-callable commands of the app's own native plugins,
  whose manifests the server cannot read); a server plugin's commands are agent-callable only when its
  manifest marks them `agent`.
- **`start_session` has `share_workspace`**: a server folder that is not a git repository is shared only
  when the agent asks for it; otherwise the start is refused with what to do. A sandbox's workspace is
  copied.
- **Delegation to other models needs the person's consent** (`delegation` in their settings, within the
  operator's cap): sub-agents, linked sessions and workflow agent nodes with a `model`.

## 18. Data, dashboards and reports (`core.dashboards`)

One query engine under everything: DuckDB, over files (CSV, TSV, JSON, Parquet, Excel), SQLite, Postgres,
MySQL, HTTP APIs (fetched by the server, hosts declared, credentials from the vault) and datasets the research
tools produce. A dataset is a named, parameterised, read-only SQL query with cached results (time, rows,
hash). Accuracy by construction: every chart, KPI and table in a dashboard or report is bound to a dataset the
engine computed - models never type the numbers - and each visual shows its lineage (source, SQL,
parameters, refreshed at). Dashboards (versioned artifacts) have a grid, filters and parameters with
cross-filtering, drill-down, time ranges, refresh policies (manual, interval, cron, event), thresholds and
alerts, TV mode and exports. Reports embed live visuals and can be snapshotted and scheduled. Any visual in a
transcript can be pinned to a dashboard or report. Agents drive it with lean `datasource`, `dataset` and
`dashboard` tools and a skill loaded on demand. Publishing serves a dashboard at `/p/<slug>` with the same
renderers as a web bundle, refreshed by the server and pushed live; viewers never see credentials or SQL
unless allowed; unpublish revokes at once; a static export is available. Plugins can add data source types
and widgets.

Target: the full capability set of an enterprise BI platform, built on SQL. (A) A semantic model:
relationships with cross-filter direction, calculated columns, measures with filter context and time
intelligence (YTD, previous period, same period last year, running totals, % of total, rank), hierarchies
with drill. (B) Multi-page reports: slicers, cross-filter and cross-highlight per visual pair, drill-through
with context, tooltip pages, bookmarks and buttons, conditional formatting, themes, phone layouts. (C) Visuals:
cards, KPI and gauge, every bar/line/area/combo/ribbon/waterfall/funnel/pie/treemap/scatter with a play axis,
matrix with subtotals, maps from local GeoJSON, a decomposition tree, key-driver analysis, anomalies and
forecasts (statistical, computed by the engine, method shown), a narrative written only from computed
numbers. (D) A query editor: recorded steps compiled to SQL, previews and column profiling, parameters,
incremental refresh. (E) Operations: refresh history and failure alerts, data alerts, subscriptions,
row-level security enforced server-side (app and published pages), usage metrics, paginated print-ready
reports, Excel export, embed codes, versions with restore, certified datasets. (F) Natural-language
questions answered by queries on the semantic model, with the SQL shown.

Layouts, mixed per page or section: a responsive grid (drag, resize, auto-pack, its own arrangement per
breakpoint), a free-form canvas (layers, guides, groups, locks), stacked sections, tabs and pages, a filter
sidebar, masonry for KPI walls, a scrolling story, TV/kiosk (fixed aspect, large type, rotating pages) and
print (A4/Letter, headers, footers, page breaks). Templates for purposes - executive overview, operations
monitoring, sales and finance, marketing funnel, product analytics, delivery tracking, incidents and SLOs,
lab results, data quality, and a blank of each layout - are plain specs the agent fills from the data;
plugins can contribute more. Switching a layout keeps the widgets; the published page renders the same.

Driven by agents, every bit: every change a person can make in the UI is a typed, validated operation
(`add_visual`, `set_measure`, `add_step`, ...) that the UI and the agents' tools both call - no UI-only
paths. Operations are checked against the model, applied atomically, recorded in the version history (person
or agent, which session) and undoable. A `describe` operation gives the agent the current state by id; a
`verify` operation runs the affected queries and reconciles totals; narrative numbers must match a measure.
A change asked in words (the dashboard's Ask box, the chat, a comment on a visual) becomes operations, shown
as a diff with undo; an ambiguous one is asked back. This is the rule for every core plugin: what a person
can do, an agent can do through the same operations.

## 19. The harness home (`~/.harness`)

By default everything lives under one folder the person can find and move: `~/.harness/` (or
`HARNESS_HOME`, or Settings > Application > Location): `data/` (the server's sessions, vault, plugin
data), `workspaces/` (`default/` and one folder per project the harness creates), `tmp/` (scratch sessions,
cleaned on a schedule), `dashboards/` and `reports/` exports, `plugins/` (installed), `logs/`, and
`settings.json`. Opening an existing folder keeps working in place; "Scratch" uses `tmp/`. Moving the home
is a setting that migrates (or points at) the folder after confirmation.

Built: `src/util/home.ts` (the server, the CLI and the app share it). Where: `HARNESS_HOME`, else the place a move
recorded in `~/.harness-location`, else `~/.harness`; explicit variables still win for what they name
(`HARNESS_DATA`/`HARNESS_DATA_DIR`, and `HARNESS_LOCAL_ROOTS` adds folders). The home's `workspaces/` and `tmp/`
are always among the local runtime's allowed roots (`HARNESS_HOME_ROOTS=off` drops them); nothing outside the
allowed roots is reachable. `tmp/` is cleaned on start and daily of entries unchanged for `tmpCleanupDays`
(settings.json, 7): only inside it, links removed as links and never followed or walked. Exports go to
`exports/` (one folder for dashboards, reports and conversation exports). The server's old default
(`./.harness-data`) stays in use while it has data and the home has none; the desktop moves its old
user-data engine folder in once (copied, checked, the old one kept as a backup; on failure it keeps using it).
Moving the home copies and checks it, points the sessions' recorded folders and the app's projects at the new
place, writes the pointer and restarts the engine; the old copy stays until the person removes it. The CLI's
runs default to the home's data and a scratch folder each in `tmp/`.

## 20. Domain plugins as frames (sdlc, aiops)

The first two domain products are plugins, not core: `plugins/sdlc` ("Engineering") and
`plugins/aiops` ("Operations") bring their pages as **frames**, the path a third party takes; native
stays for the desktop's own built-ins. What the core gained so that a frame can do real work (each
small, each for any plugin):

- **Plugin routes with `auth: "user"`**: signed in like the rest of the API (a write needs the
  `x-harness` header), the handler gets `req.user` and never the caller's credentials. A frame's
  `routes.call` reads its server half's data per person; webhooks keep `token` and `none`.
- **A workflow agent node's `model` may name the run's input** (`{{input.reviewerModel}}`; empty: the
  session's model). A role's model chosen at start is a delegation, within the person's setting.
- **The workflow dialog without a conversation** (opened from a page by `workflows.start` or a form)
  runs the workflow in a new conversation, in the folder the person picks.
- **A frame view or panel opened again with other params starts again** with them (its init carries
  them): links between a plugin's pages (`view.open('incidents', {id})`) work, back and forward too.
- **`open-view` actions take an agent's plain arguments as params** ("open incident <id>").

Then (follow-ups, for any plugin):

- **What is installed**: `registry.has` / `registry.list` (ids, yes/no). The Operations topology asks for a
  `diagram` fence renderer and, when core.diagrams is there, hands it a deployment spec through `render.show`
  (the host draws it over a placeholder in the page); otherwise it draws its own SVG.
- **Account-scope settings for frames**: `settings.get/set` span the plugin's sections by scope (see section 4).
  Engineering's approval, stack, review strictness and role models, and Operations' investigation models,
  moved to account sections; display choices (gates shown, refresh, severity filter) stay on the machine.
- **Badges with no page open**: `ui.badges` and `api.signal` (section 4). Operations' open-incidents badge and
  its status items come from `console/badges`, read every 30 s and at once when an alert or incident changes.
- **The inventory gates only in operations projects**: `inventory-valid` and `alerts-valid` apply where the
  workspace has an inventory or a session used the aiops tools; the operator's inventory alone no longer makes a
  software project (a slugify repository) answer for it. Named explicitly, they always run.
- **Plugin commands through `desktop_command`**: a frame plugin's commands marked `agent` run in the app, args
  checked against `inputSchema` (by the server, then the app), asked in default mode; the answer says what
  happened (the page opened, a route's text). An e2e step has a scripted agent open an incident this way.

## 21. The desktop side of sections 11 to 13 (built)

- `core.artifacts` and `core.agents` are built-in plugins on the public contribution points: panels
  (`where: session`), views and nav items, and renderers for the item kinds the timeline adds
  (`artifact`, `proposal`, `link`, `chapter`); without them the transcript falls back to a line each.
- The timeline (`packages/client`) draws proposals, linked-session reports and chapters live and from
  stored history (the start_session / mark_chapter results and the report reminders), and a turn a
  report woke as a boundary; artifact cards come from the artifact tool's results.
- One live store per conversation (`core.chat/live.ts`): the transcript, both panels and a split view
  of the same conversation share one event stream.
- Desktop calls are answered by `state/client-calls.ts` (pure checks in `registry/agent-surface.ts`),
  once per call (the global and the session stream both bring it), within 20 s. `desktop_notify` shows a
  toast and a system notification even with the window in front: the agent asked for it.
- Split view is the shell's (`openSplit(route)`, any view), not the agents plugin's.
- A session's workflow list is read again when `.harness/workflows` changes (cached on the folder's
  listing); the catalogue is not in the prompt, so the cached prefix is untouched.
