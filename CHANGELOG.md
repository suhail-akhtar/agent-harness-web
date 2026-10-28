# Changelog

## Unreleased

- **Your messages**: copy, edit and send again, send again from here, branch a new conversation from here (under
  each message, and on a right-click). Editing goes back to that message: what came after it is removed from
  the conversation (files the agent changed stay as they are); a conversation that changed since it was shown
  is not cut (POST /api/sessions/:id/cut).
- **Export a conversation**: as Markdown or text (a save dialog), or copy it as Markdown, from the
  conversation's header and its row in the sidebar.
- **Workflow cards** fold once the run is done (Show graph opens them again), and sit where the run started in
  the conversation, not after everything, when it is opened again.
- **The context meter** measures against the compaction point, not the model's whole window.
- **Studio: playing a web game**: studio_template play and Builds > Play in the browser serve the build on this
  computer (a module game does not run from file://); a game opened from its file says how to play it.

## 0.2.4

- **Install from a file** (Plugins page): a plugin's file, or a whole solution's in one file (Studio: its five
  plugins, signed each, installed in order, all or none; again: nothing changes; a newer one updates), into
  the app as it was, after showing what is in it and who signed it. `npm run plugin -- solution <dir>`; the
  desktop build writes `<solution>-<version>.tgz` beside the plugins' files.
- **Any solution as an app of its own, the harness desktop app as its base**: `npm run desktop:build --
  --solution studio` builds Harness Studio (solutions/studio/package.json "harness.app": its name, app id,
  tagline, the plugin it opens on), with every feature of the harness, Studio inside and installed, the window
  focused on Studio, and its own home folder (~/.harness-studio) so both apps run side by side.
  `npm run desktop:dev -- --solution studio` runs it from the checkout. The core's installer ships the core.
- An official plugin installed from a file has its own group in the sidebar, as when it ships (others: Custom).

## 0.2.3

- **Solutions apart from the core**: a complete product on the core lives in `solutions/<name>` with its own
  version, plugins, tests, evals, docs and changelog. Studio is the first (`solutions/studio`, Studio 1.1.0:
  games3d and the Blender, Godot, Unity and Unreal engines); its changes are in solutions/studio/CHANGELOG.md.
  The core finds every solution's plugins in the checkout; `npm test -- --core` or `--solution=studio` runs
  one part's tests.
- **The plugin test kit** covers what a plugin's or solution's tests need (`@harness/plugin-sdk/testing`:
  createHarness, pluginDir, hosts, gates, skills, workflows, evals, fixtures; `/testing/desktop`: how the
  desktop app shows a plugin), so they never import the harness's own files; the core's suite checks that no
  solution does. `@harness/plugin-sdk/runtime` has HARNESS_VERSION and version ranges (`satisfies`).
- **Official and verified**: plugins signed with an official publisher's key (the desktop product's
  `trustedKeys`: Suhail Akhtar's) are Official and Verified on the Plugins page; a signed plugin changed
  afterwards says its signature does not match; a person's own plugins load as before. The desktop build
  signs every bundle with the publisher's key when there is one (HARNESS_PUBLISHER_KEY).

## 0.2.2

- **Questions from the agent**: suggested answers with what each does and the recommended one marked; a form's
  choices as tick boxes, suggestions as chips; a note with the answer, a reply in your own words, a review of
  what is sent, Skip (the agent decides and says what it assumed). Send works in the conversation as in the
  Inbox; a form question can be skipped or answered in words.
- **Run a workflow**: what a workflow is, workflows searched and grouped by plugin, how the chosen one runs
  (steps, who does each, where it waits for you, what repeats), what it needs, what happens when you start it.
- **Right-click menus** everywhere: what is under the pointer (a conversation, a project, a plugin, a reply),
  spelling, copy and quote, links and images, code blocks, and the editing commands in text fields.
- **Working animation**: the jump-to-latest button shows it while the agent works (the arrow on hover); six
  styles in Settings > Appearance.
- **Administrator commands**: bash with elevated: true, asked every time, then by the operating system (UAC,
  sudo or the system's password dialog); never with a password the app sees; only on this computer.
- **Plugins as separate installables**: npm run plugins:bundles, and the desktop build writes every plugin's
  bundle and an index beside the installer.
- A page that cannot be shown says why (its plugin switched off, with Switch it on), never blank.
- **Too large for the provider (413)**: a request carries the newest images up to a budget (older ones become a note);
  a 413 is sent again without images, then after compacting; past that it says what to do. Long screenshot-heavy
  conversations go on instead of stopping.

## 0.2.1

- Published by Suhail Akhtar under the MIT licence (LICENSE): every shipped plugin says so on its card, and the packages declare it.
- The installed desktop app's engine carries its dependencies (the installer is made from the unpacked app after they are copied in).

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
