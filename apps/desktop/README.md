# Harness Desktop

The agent harness as a desktop app (Electron). It is a generic shell: the shell names no feature,
and everything a person sees comes from plugins through one registry. The built-ins (chat,
projects, inbox, activity, plugins, settings) are plugins too, with trust `native`; third-party
plugins use the same thirteen contribution points from the `ui` section of `harness-plugin.json`.
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
| Main process | `electron/` | Starts the **engine** (the harness server, `src/server/main.ts`, run from source in an Electron utility process) on `127.0.0.1` with a random port and token; `HARNESS_DATA` lives in the app's user data and `HARNESS_LOCAL_ROOTS` holds the projects the person opened. It restarts the engine with backoff and keeps a log tail. |
| `harness://app/` | `electron/protocol.ts` | Serves the interface, and proxies `harness://app/api/*` to the engine with the token added (the renderer never sees it). The same proxy serves a **remote server** (its URL, and a token kept with `safeStorage`). Plugin frames load from `harness://app/plugins/<name>/` under a sandbox CSP. |
| `harness://preview/` | `electron/preview.ts` | An origin of its own for artifact previews (HTML, React, 3D molecules): no network, framed only by the app, never same-origin. |
| Preload | `electron/preload.ts` | An allowlist of IPC channels, answered only for the top frame. |
| Renderer | `renderer/src/` | The shell (sidebar, top and status bars, router, command palette, keybindings, toasts, themes, the engine gate, onboarding) and the built-in plugins, drawn from the registry (`registry/`). |
| Shared packages | `packages/client`, `packages/ui`, `packages/plugin-ui` | The typed client, event reader and timeline; the design system and the rich renderers; the plugin UI contract and SDK. |
| Product profile | `products/harness.json` | Name, app id, icon, accent, bundled and required plugins, sidebar order, home cards. `HARNESS_PRODUCT=path` picks another. |

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

Examples: `examples/plugins/hello-frame` and `notes-frame` (frames with the SDK), `quick-links`
(declarative only). Two real ones: `plugins/sdlc` ("Engineering": a Delivery board, a Start a feature form, a
Quality gates panel) and `plugins/aiops` ("Operations": incidents, alerts, services, topology,
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
- Settings sections with `scope: "app"` are the ones a frame reads (`settings.read`).
- `workflows.start(name, input)` opens the workflow dialog after the person says yes; opened from a page,
  the dialog runs it in a new conversation in the folder they pick.
- Home cards and renderers size themselves (`frame.resize` with the body's height); live values such as a
  nav badge or a status item count come from `badge.set` in a frame that is open (the home card is a good place). To work on a plugin without installing it: `HARNESS_DESKTOP_DEV_PLUGINS=<dir>`
or Settings > Plugins > Add a folder.

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
declares those fences. `diagram` is reserved
for the interactive diagrams of a later `core.diagrams` plugin; until then it reads as JSON.
A plugin renderer for a fence language or an artifact kind replaces the default.

## Environment

| Variable | |
|---|---|
| `HARNESS_DESKTOP_DATA` | The app's data folder (default: Electron's user data). |
| `HARNESS_DESKTOP_ENGINE` | Another engine entry (the tests use a scripted one). |
| `HARNESS_DESKTOP_DEV_PLUGINS` | Folders of plugins under development (path-delimited). |
| `HARNESS_DESKTOP_NO_TRAY`, `HARNESS_DESKTOP_HIDDEN` | No tray icon; start without showing the window (tests). |
| `HARNESS_PRODUCT` | Another product profile. |
| `HARNESS_DESKTOP_SCREENSHOTS=1` | The e2e test writes its screenshots to `docs/screenshots/desktop/`. |

## Tests

- Unit (in `npm test`): `test/desktop-registry.test.ts` (registry, keybindings, reconcile),
  `desktop-ui-core` (theme contrast, schema forms, grants, prefs, products), `desktop-client`
  (client and event reader), `desktop-security` (frame host refusals, scheme policies),
  `desktop-render`, `desktop-science` and `desktop-biology` (every renderer, hostile input included).
- End to end: `test/desktop-e2e.test.ts` drives the app with playwright-core against a scripted
  engine (no paid calls); it skips itself when Electron cannot start. `test/desktop-plugins-e2e.test.ts`
  is the plugins journey: Engineering and Operations switched on and off live and used in between
  (`test/fixtures/desktop/plugins-engine.ts`: the real server and plugins, fixture monitoring, a scripted
  model); screenshots in `docs/screenshots/desktop/plugins-journey/` with `HARNESS_DESKTOP_SCREENSHOTS=1`.
- Live smoke (costs money, not in `npm test`):
  `node --env-file=<path to .env> apps/desktop/scripts/live-smoke.mjs` runs deepseek-flash and
  claude-sonnet-5-5 at effort medium under a $0.50 cap; it never prints key values.
  `apps/desktop/scripts/live-bio.mjs` (same invocation) asks both models for a sequence, a plasmid
  map, a tree and a volcano plot and checks each drew, under a $0.60 cap.
  `node --env-file=<path to .env> test/fixtures/desktop/plugins-live.ts` runs the plugins journey on real
  models (a feature with claude-sonnet-5-5, an incident with deepseek-flash, a check each on kimi-k2.6 and
  glm-5.3-flash) under a $3.00 cap.
