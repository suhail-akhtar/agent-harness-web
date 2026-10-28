# Harness Desktop

The agent harness as a desktop app (Electron). It is a generic shell: the shell names no feature,
and everything a person sees comes from plugins through one registry. The built-ins (chat,
projects, inbox, activity, artifacts, agents, diagrams, dashboards, plugins, settings) are plugins too, with trust `native`; third-party
plugins use the same seventeen contribution points from the `ui` section of `harness-plugin.json`.
The design is in [docs/desktop/DESIGN.md](../../docs/desktop/DESIGN.md).

## Run it

```sh
npm install                 # once, at the repository root (npm workspaces)
npm run desktop:dev         # build, start Electron, rebuild on change (the window reloads)
npm run desktop:build       # package: release/win-unpacked (and the NSIS installer on Windows)
npm run desktop:test        # the end-to-end test in Electron, against a scripted engine
```

`desktop:build` takes `--dir-only` (`npm run build:app -w @harness/desktop -- --dir-only`) to skip
the installer. The output is in `apps/desktop/release/`.

## How it fits together

| Part | Where | What it does |
|---|---|---|
| Main process | `electron/` | Starts the **engine** (the harness server, `src/server/main.ts`, run from source in an Electron utility process) on `127.0.0.1` with a random port and token; its data is in the **harness home** (`~/.harness/data`, shared with the server and the CLI) and `HARNESS_LOCAL_ROOTS` adds the projects the person opened elsewhere. It restarts the engine with backoff and keeps a log tail (also in `<home>/logs/engine.log`). |
| `harness://app/` | `electron/protocol.ts` | Serves the interface, and proxies `harness://app/api/*` to the engine with the token added (the renderer never sees it). The same proxy serves a **remote server** (its URL, and a token kept with `safeStorage`). Plugin frames load from `harness://app/plugins/<name>/` under a sandbox CSP. |
| `harness://preview/` | `electron/preview.ts` | An origin of its own for artifact previews (HTML, React, 3D molecules): no network, framed only by the app, never same-origin. |
| Preload | `electron/preload.ts` | An allowlist of IPC channels, answered only for the top frame. |
| Renderer | `renderer/src/` | The shell (sidebar, top and status bars, router, command palette, keybindings, toasts, themes, the engine gate, onboarding) and the built-in plugins, drawn from the registry (`registry/`). |
| Shared packages | `packages/client`, `packages/ui`, `packages/plugin-ui` | The typed client, event reader and timeline; the design system and the rich renderers; the plugin UI contract and SDK. |
| Product profile | `products/harness.json` | Name, app id, icon, accent, bundled and required plugins, sidebar order, home cards. `HARNESS_PRODUCT=path` picks another. |

### The harness home

Everything the agent works with lives under `~/.harness` (or `HARNESS_HOME`): `data/`, `workspaces/`
(`default/`, and a folder per project made with Projects > New project), `tmp/` (each Scratch
conversation gets a folder there; folders not changed for 7 days are removed on start and daily),
`exports/`, `plugins/`, `logs/` and `settings.json`. Opening an existing folder keeps working in
place. An older install's engine data (`<user data>/engine`) is moved in once at start (copied,
checked, the old folder kept as `engine.backup-<date>`, a line in the log); if that fails the app keeps
using the old folder. Settings > Application > Location shows the home and its folders with their sizes,
opens them, sets the clean-up age, and moves the home (copied, checked, sessions' folders and projects
follow, the engine restarts there; the old copy stays until you remove it there). The app's own files
(window, prefs, grants) stay in Electron's user data.

Also: one window (single instance), window bounds remembered, a tray (Open, New chat, Quit),
notifications only when the window is not focused, `harness://open?session=...` deep links (stub),
frame grants tied to each plugin's `uiHash` (a changed UI asks again).

## Plugins

A plugin contributes nav items, views, side panels, commands (with keybindings), slash commands,
composer chips, settings sections (JSON schema forms), renderers (for a tool's results, an event
kind, a code-fence language or an artifact kind), home cards, status items, themes, prompts and
onboarding steps. Frame contributions run in sandboxed iframes and talk to the app through the
SDK (`@harness/plugin-ui`, `connect()`); every call is checked against the capabilities the person
granted.

Switching a plugin on or off takes effect at once: its page closes to home with a note, its panels
close, its keybindings, renderers, badges and status items go, its theme falls back to the
default. Its grants and settings are kept, so switching it back on restores them. On a clash (a
keybinding or slash command), the core or the first-loaded plugin wins, and the Plugins page shows
the clash. A `ui` section that does not validate contributes nothing and shows its error there.

### Switching a plugin off

- **Kept:** its settings, grants and data, and what it made: old conversations and artifacts open as before.
- **Drawn plainly:** a tool card or event its renderer drew shows the default view with a note
  ("Made with <plugin>, which is off. Switch it on to view it fully") and a button to the Plugins
  page; an artifact of a kind only it renders opens in a basic view (the JSON spec, or the page) with
  the same note. Switched back on, the full view returns at once. Renderers sit inside error
  boundaries, so a missing one never takes the transcript down.
- **On the server** (a server plugin): open conversations keep its tools listed but a call answers
  that it is off; its workflow runs wait at the step that needs it and carry on when it is switched
  on; its schedules are skipped, its routes answer 503 (see the main README).
- **Uninstall** (catalogue plugins) asks what becomes of its data folder: kept by default, deleted
  only when "Also delete its data folder" is ticked.

Examples: `examples/plugins/hello-frame` and `notes-frame` (frames with the SDK), `quick-links`
(declarative only). Two real ones: `solutions/engineering/plugins/sdlc` ("Engineering": a Delivery board, a Start a feature form, a
Quality gates panel) and `solutions/operations/plugins/aiops` ("Operations": incidents, alerts, services, topology,
changes, an On call card). Both are bundled, and still frames: the path any third party takes.

### Writing a frame plugin

- A frame loads the SDK as a classic script, `<script src="harness://app/sdk/plugin-ui.js">`, then
  `HarnessPluginUI.connect()`; its own files (a shared `kit.js`, `kit.css`) load from its `ui/` folder.
  It has no network: everything goes through the host, checked against the capabilities the person granted.
- Look native with the theme variables the host sends (`--hx-bg`, `--hx-elevated`, `--hx-text-primary`,
  `--hx-accent`, `--hx-success`/`--hx-warning`/`--hx-danger`, `--hx-font`...); a theme change arrives as an event.
- Read your server half's data with `routes.call(path, {method: 'POST', body})` (a path takes no query:
  pass arguments in the body) on routes registered with `auth: 'user'`: signed in like the rest of the API,
  the handler gets `req.user` to answer each person with their own data.
- One HTML file can serve several views: `init.contribution` says which; a view opened again with other
  params (`view.open('incidents', {id})`) starts again with them.
- A frame reads and writes its own settings with `settings.get/set`: keys of a `scope: "app"` section live on
  this computer, keys of a `scope: "account"` section with the person's account on the server (checked
  against the schema, here and by the server, which keeps only a plugin's account keys); `operator` keys are
  read-only. Engineering keeps the person's choices (approval, stack, review strictness, the roles' models)
  with the account and the panel's display on this computer; Operations the investigation models.
- `registry.has({ renderer | view | panel | command | plugin })` and `registry.list(kind)` say what else is
  installed (ids and yes/no only, no capability needed). `render.show({ fence, source, rect })` draws a block
  with one of the host's renderers over a rectangle of the frame (Operations' Topology hands a `diagram` spec
  to core.diagrams that way when it is there, and draws its own SVG otherwise).
- Badges and status items while none of the plugin's pages is open: `ui.badges` in the manifest,
  `[{ "name": "open", "route": "console/badges", "every": 30, "signal": true }]`: the app reads the plugin's
  own signed-in route as the person every `every` seconds (15 at least; paused while the window is hidden)
  and at once when the server half calls `api.signal(name)`. The route answers the value, or an object with
  a value per badge name. Operations' open-incident badge and its status items work that way.
- Commands marked `agent` (with an `inputSchema`) are agent-callable through `desktop_command`: Engineering's
  start feature and quality gates panel, Operations' open incident and ops check. The server checks the args,
  asks the person (default mode), and the app runs the command and answers what it did (a route's answer, the
  page it opened).
- `workflows.start(name, input)` opens the workflow dialog after the person says yes; opened from a page,
  the dialog runs it in a new conversation in the folder they pick.
- Home cards and renderers size themselves (`frame.resize` with the body's height); live values such as a
  nav badge or a status item count come from `badge.set` in a frame that is open (the home card is a good place). To work on a plugin without installing it: `HARNESS_DESKTOP_DEV_PLUGINS=<dir>`
or Settings > Plugins > Add a folder.

### Plugins as modules (DESIGN.md section 23)

- `ui.menu` makes a plugin a group in the sidebar (header with icon and title, its items and
  sub-items, badges; fold and reorder, remembered); `ui.home` is the page its header opens (else the
  app draws one from the manifest); `ui.guide` (Markdown, frontmatter `description` = its purpose) is
  what agents load as the skill `<plugin>-guide`, merged with sections generated from the manifest.
- A desktop session's system prompt lists one line per enabled plugin with a guide; switching a
  plugin on or off changes that line (and its skill) from the next message, nothing else.
- Built-in modules: Agents (Working now, Library), Dashboards (Dashboards, Reports, Data),
  Engineering (Delivery, Start a feature, Gates), Operations (Incidents, Alerts, Services, Topology,
  Changes). Live check: `node --env-file=<.env> apps/desktop/scripts/live-modules.mjs` (on 2026-10-23
  both passed for $0.13: Sonnet loaded aiops-guide and opened Incidents, $0.119; DeepSeek loaded
  core.dashboards-guide and built a dashboard from an inline CSV through the data tools, $0.010).

## Agents in the app (DESIGN.md sections 11 to 13)

- **Artifacts** (`core.artifacts`): the documents, apps, diagrams and data an agent makes with its
  `artifact` tool. A card in the transcript opens the conversation's Artifacts panel: preview
  (html/svg/react in the sandboxed preview frame, Markdown, Mermaid, charts, CSV, JSON, code, images),
  code, a version picker and the changes between two versions, copy, download, open in full window.
  The **Library** page lists every artifact across conversations (search, kind filter, grid or list).
- **Agents** (`core.agents`): the Agents panel is a live tree of a conversation - its sub-agents
  (type, model, status, cost, duration, worktree branch: from the events, the history and the trace),
  background tasks, linked sessions (status, end reason, cost; open here or beside) and open
  proposals, with its todo list and cost per model. The transcript draws proposal cards (Start /
  Dismiss), cards for linked sessions started, reporting or sending a message, and chapters
  (`mark_chapter`) with a floating table of contents. **Split view** opens a conversation beside the
  current one (resizable, closeable, "open here"). The **Agents** page shows everything working
  across conversations, linked sessions under the one that started them, proposals waiting, Stop.
- **Workflow runs** are drawn as a graph (layered, each node's status, outcome, agent and model;
  click a node for its output), or as the list of steps.
- **Desktop tools, answered by the window**: `desktop_describe` (the live registry, compact: plugins,
  views, panels, agent-callable commands with their argument schemas, settings, renderers, themes,
  what is on screen), `desktop_open` (a view, a panel, a workspace file, an artifact, or an http(s) URL
  in the system browser), `desktop_notify` (a toast and a system notification), `desktop_command`
  (only commands a manifest marks `agent`, arguments checked against their schema; the server asks
  the person first). Every call is answered within 20 s with a result or a clear error. A session made
  by the app declares the four tools and its own plugins' agent-callable commands. Built-in commands
  agents may call: `core.shell:set-theme`, `core.shell:open-view`, `core.chat:new` (a prompt typed in,
  never sent), `core.settings:open`, `core.artifacts:library`, `core.agents:page`.
- **`ask_user` forms**: a question with a JSON-Schema form is a native form in the attention bar;
  the answer goes back as the filled-in object.
- **Delegation**: Settings > Models & providers > Delegation edits your `delegation` setting (which
  other models agents may hand work to, ask before the first hand-off to a provider, a cost cap).
  The session's cost button shows the cost per model; so does the Agents panel.

Also: breadcrumbs say page > subpage, the window's title follows the page, Help > About (versions)
and Help > Keyboard shortcuts (`Ctrl+/`), a page or panel that fails shows an error card with
Disable (never a blank window), first-run setup recommends Claude Sonnet 5.5 when an Anthropic key
is there (else DeepSeek Flash), the product icon in the sidebar and About.

## What the transcript draws

GFM, highlighted code (label, copy, wrap, fold), KaTeX (with mhchem `\ce`/`\pu` and physics
macros), Mermaid, Vega-Lite and ECharts, HTML/SVG/React artifacts in sandboxed frames (Preview /
Code, side panel, download), images with a lightbox, CSV/TSV/JSON tables and trees (filter, sort,
stats, pivot, CSV export), diffs (unified and split), citations, "Thought for", steps folded under
"Worked for", file cards, workflows. Science and BI blocks load on first use: `smiles` (2D
structures), `pdb`/`sdf`/`mol`/`xyz` (3D, 3Dmol.js in a sandboxed frame), `plot` (function plots,
zoom and pan), `dot` (Graphviz, wasm), `dashboard` (KPIs and panels, the spec in
`@harness/plugin-ui`), `ipynb` (notebooks), `geojson` (maps without tiles). Biology blocks load
the same way (one chunk, `packages/ui/src/render/biology`, no new libraries): `fasta`/`sequence`
(colours, ruler, selection, features, GC, weight, reverse complement, 3-frame translation),
`msa`/`clustal` (conservation, consensus), `newick`/`phyloxml` (rectangular or circular,
collapsible), `plasmid` (circular and linear maps, sites), `gff`/`gtf`/`bed`/`tracks` (genes with
exons and CDS, signal tracks, zoom and pan), `pdb`/`cif` (cartoon by secondary structure, chains,
ligands, residue picker), `uniprot` (feature tracks), `pathway` (SBGN-like glyphs, Graphviz layout),
`volcano`, `ma`, `kaplan-meier` (log-rank p), `manhattan` (Vega-Lite) and `heatmap` (clustered, with
dendrograms). Their formats are in the core `rich-output` skill, offered to sessions whose client
declares those fences. `diagram` is drawn by `core.diagrams` (below).
A plugin renderer for a fence language or an artifact kind replaces the default.

## Diagrams (`core.diagrams`)

Architecture, deployment, data (ER), code and flow diagrams from one JSON spec
(`packages/plugin-ui/src/diagram.ts`: `validateDiagram`, the version diff, flows), drawn by
`packages/ui/src/render/diagram/`: cards with an icon per kind, status badges, dashed integrated
systems, nested zones, ER tables with key marks, orthogonal edges laid out by ELK (elkjs, in a
worker; AICO's layered layout as the fallback). A ```diagram block or an artifact of kind `diagram`
shows a static picture in the transcript; "Open interactive" opens the canvas: pan, zoom, fit,
minimap, Overview and Neighbourhood, search, collapsible groups, details in the side panel, flows
played step by step, export to SVG and PNG, arrow keys and Enter. Dragging a box saves the positions
as a new artifact version (`PUT /api/sessions/:id/artifacts/:aid`, refused when stale); the ask box
sends a request to the conversation and the new version arrives in place with its changes marked.
Layouts stay put between versions: boxes keep their places, new ones go next to their neighbours.
"Show code map" (`/codemap`) draws the session's workspace by folder from
`GET /api/sessions/:id/files/imports` (TS/JS/Python imports, read-only). Models learn the spec from
the `diagrams` skill, listed only for an app that declares the `diagram` renderer.

## Dashboards (`core.dashboards`)

Dashboards, Reports and Data in the sidebar: sources (secrets as key vault names), datasets with
the query editor (steps, previews, profiling, SQL), the semantic model (relationships, measures,
hierarchies, roles), dashboards and reports edited in place (drag, resize, the inspector, nine
layout types, templates) with Undo, Ask (an agent applying the same ops beside the dashboard),
publishing as a live page, exports. Every chart, figure and table in a transcript has "Add to
dashboard". A visual with a hierarchy has a drill bar (up, drill mode, next level, expand all, a
breadcrumb); a point's menu opens linked dashboards with its context; slicers sync across
dashboards; the model view shows where each table comes from (and which are live). See the README's "Data, dashboards and reports". `node apps/desktop/scripts/build-viewer.mjs`
builds the published-page viewer (`dist/bi-viewer`); the e2e builds it when it is out of date.

## Environment

| Variable | |
|---|---|
| `HARNESS_DESKTOP_DATA` | The app's data folder (default: Electron's user data). Set without `HARNESS_HOME`, the harness home is `<it>/home` (tests and side-by-side editions never touch `~/.harness`). |
| `HARNESS_HOME` | The harness home (default `~/.harness`, or where a move put it: `~/.harness-location`). |
| `HARNESS_DESKTOP_TEST=1` | Set by the end-to-end tests and the live scripts: the window is never shown, focused or flashed, no tray, no system notifications, no taskbar entry; playwright still drives it and takes its screenshots (each checked not to be blank). |
| `HARNESS_E2E_SHOW=1` | With the tests or live scripts: show the window, to watch them run. |
| `HARNESS_DESKTOP_ENGINE` | Another engine entry (the tests use a scripted one). |
| `HARNESS_DESKTOP_DEV_PLUGINS` | Folders of plugins under development (path-delimited). |
| `HARNESS_DESKTOP_NO_TRAY`, `HARNESS_DESKTOP_HIDDEN` | No tray icon; start without showing the window (tests). |
| `HARNESS_PRODUCT` | Another product profile. |
| `HARNESS_DESKTOP_SCREENSHOTS=1` | The e2e test writes its screenshots to `docs/screenshots/desktop/`. |

## Tests

- Unit (in `npm test`): `test/desktop-registry.test.ts` (registry, keybindings, reconcile),
  `desktop-ui-core` (theme contrast, schema forms, grants, prefs, products), `desktop-client`
  (client and event reader), `desktop-security` (frame host refusals, scheme policies),
  `desktop-render`, `desktop-science` and `desktop-biology` (every renderer, hostile input included),
  `desktop-agents-ui` (sub-agents, cost per model, the desktop tools' checks, workflow layout,
  breadcrumbs, the recommended model), `desktop-server-gaps` (workflows added mid-session, models
  while starting).
- `test/home.test.ts` (the harness home: resolution, first run, the tmp clean-up with links planted in it,
  migration, the move, the server's and the CLI's defaults) and `test/desktop-plugin-followups.test.ts`
  (registry.has/list, render.show's checks, badge sources and their polling, settings scopes in the app and on
  the server, the aiops inventory gates only in operations projects).
- The Electron files (`test/desktop-*e2e*.test.ts`) run after the rest of `npm test`, one at a time, with
  hidden windows (`HARNESS_E2E_SHOW=1` shows them).
- End to end: `test/desktop-e2e.test.ts` drives the app with playwright-core against a scripted
  engine (no paid calls); it skips itself when Electron cannot start. `test/desktop-e2e-agents.test.ts`
  does the same for the agent platform (artifacts, Library, sub-agents, linked sessions and
  proposals, split view, the desktop tools, forms, delegation, the workflow graph) against
  `test/fixtures/desktop/scripted-agents-engine.ts`. `test/desktop-plugins-e2e.test.ts` is the plugins journey:
  Engineering and Operations switched on and off live and used in between
  (`test/fixtures/desktop/plugins-engine.ts`: the real server and plugins, fixture monitoring, a scripted
  model); screenshots in `docs/screenshots/desktop/plugins-journey/` with `HARNESS_DESKTOP_SCREENSHOTS=1`.
- Diagrams: `test/desktop-diagrams.test.ts` (spec, layouts, flows, diff, drawing, code map, speed),
  `desktop-diagrams-server.test.ts` (artifact kind, PUT, import scan, skill), and the Electron run
  `desktop-diagrams-e2e.test.ts`.
- Live smoke (costs money, not in `npm test`):
  `node --env-file=<path to .env> apps/desktop/scripts/live-smoke.mjs` runs deepseek-flash and
  claude-sonnet-5-5 at effort medium under a $0.50 cap; it never prints key values.
  `apps/desktop/scripts/live-diagrams.mjs` (same invocation) has claude-sonnet-5-5 draw a CRM
  deployment with zones and a login flow, asks for a cache from the canvas (the changes marked in
  place), then the same first request on deepseek-flash; $1.50 cap (a run costs about $0.15).
  `apps/desktop/scripts/live-bio.mjs` (same invocation) asks both models for a sequence, a plasmid
  map, a tree and a volcano plot and checks each drew, under a $0.60 cap.
  `node --env-file=<path to .env> test/fixtures/desktop/plugins-live.ts` runs the plugins journey on real
  models (a feature with claude-sonnet-5-5, an incident with deepseek-flash, a check each on kimi-k2.6 and
  glm-5.3-flash) under a $3.00 cap.
  `node --env-file=<path to .env> apps/desktop/scripts/live-agents.mjs` checks the agent platform in
  the real app (an artifact made and updated, two linked sessions reporting back with a proposal
  started from its card, a review delegated from DeepSeek to Claude, desktop_describe and
  desktop_open) on claude-sonnet-5-5 and deepseek-flash, plus a short session on kimi-k2.6 and
  glm-5.3-flash, under a $2.50 cap. On 2026-10-22 everything passed for $0.25 in all: Sonnet
  $0.076 (artifact), $0.096 (two linked sessions), $0.025 (desktop tools); DeepSeek $0.003, $0.003,
  $0.0004; the delegated review $0.017 (Claude $0.016 of it; it found the off-by-one in `last.js`);
  Kimi $0.018 (it called desktop_describe); GLM $0.002 (one call).
  `node --env-file=<path to .env> apps/desktop/scripts/live-home.mjs` checks the harness home and plugin
  commands on claude-sonnet-5-5 (effort medium): a file written in `<home>/workspaces/default` and read
  back, then an Operations incident (from an alert) opened in the app by the agent with `desktop_command`
  (asked first), under a $0.50 cap. On 2026-10-22 both passed for $0.039 ($0.022 and $0.017).
