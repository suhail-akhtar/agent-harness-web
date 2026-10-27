# Changelog

## 0.2.0 — the platform release

The core is complete and everything else is a plugin built on it: the core never needs a solution, and
any mix of solutions runs on top of it. This is the base for new end-to-end plugins.

### Core and solutions
- The core: chat, projects, agents, dashboards, documents, research, quality gates, integrations and the
  desktop app; always there.
- **Solutions** are standalone plugins installed one by one, in any mix (Plugins > Catalogue > Solutions):
  **Studio** (games and 3D, with its Blender, Godot, Unity and Unreal engines), **Operations**,
  **Engineering** and **DevOps**. Installing one installs what it requires; removing one keeps its data.
  A setup in use before keeps every solution; a new one starts with the core (or `HARNESS_SOLUTIONS`).

### The plugin SDK
- `@harness/plugin-sdk` (types), `/runtime` (the harness's abilities: tools, paths, files, programs,
  browsers, libraries), `/testing` (the test kit: a real harness, tools, routes, scripted conversations)
  and `/ui` (pages built from the app's own kit).
- `npm run plugin -- new | test | check --deep | pack | sign | verify | index`; agents have the same
  through plugin-dev (`plugin_new`, `plugin_test`, `plugin_review`) and the build-a-plugin skill.
- Live reload, versioned plugin data with migrations (`api.store`), clear errors for every refused call.
- Portable plugins: other plugins' modules by name (`@harness/plugins/<name>/...`), never by relative
  path, so a packed plugin works on any server. Two tiers, official and custom, both with the whole API.
- The full guide: `docs/plugin-sdk` and the build-a-plugin skill's references; a complete example,
  `examples/plugins/customer-desk`.

### Plugins as bundles
- Each plugin carries a display name, icon, tags, category, publisher, author, licence, links and a
  changelog, shown on its card; its tests in its own `test/` folder.
- `engines.harness`: a plugin made for other harness versions is not loaded, and says what to do. Within
  a major version the SDK and runtime only grow, so an update of the harness keeps plugins working.
- Updates (the plugin's `updates.url`, then the catalogue), the version before kept, roll back to any of
  the last five; a version that fails to load leaves the one before running.
- Export a plugin as a `.tgz`; import it on another computer (reviewed, then *Open as app*) or server
  (signed with a trusted key).

### Trust and safety
- A plugin is reviewed before it loads in the desktop app (score, findings, what to do), and on demand.
- The review checks the manifest, tools, routes, pages, permissions against the code (network, secrets,
  the vault, sessions, routes, programs on the server), secrets in files, portability, the bundle and the
  plugin's own tests (quick ones; integration tests run with `plugin test`).
- Plugin code reviewed and tested without the server's credentials; `permissions.processes` declares
  programs started on the server, shown before a plugin is added.

### Desktop
- A plugin opens as its own app (a window focused on it, a desktop shortcut); plugins the person added sit
  under Custom; every tool parameter of the shipped plugins described for agents.

## 0.1.0

- The agent harness, its server and the desktop app.
