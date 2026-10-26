# The plugin SDK

Everything to build a plugin for the harness and its desktop app, from one tool to a complete app.
A plugin uses the same API as the built-in features (Studio, Dashboards and Operations are plugins),
and an AI agent can build one end to end with it: the `plugin-dev` plugin gives agents the template,
the tests and the review as tools, and the `build-a-plugin` skill as their guide.

## Start

```bash
npm run plugin -- new my-plugin --dir ../my-plugin     # a complete working plugin (TypeScript; --js for JavaScript)
npm run plugin -- test ../my-plugin                    # its tests
npm run plugin -- check ../my-plugin --deep            # the deep review: OK / NOT READY, a score, each finding with what to do
```

Then in the desktop app: **Plugins > Developer > Load a plugin folder…**. The folder is reviewed first,
then loaded whole (pages, tools, routes, skills) and shown under **Custom** in the sidebar. While it
is loaded, saving a file reloads it: a page edit reloads its pages, a code edit reloads the plugin in
the engine, with no restart. **Open as app** opens it in a window of its own; **Desktop shortcut**
starts the app that way.

Or ask an agent in the desktop app: "Build a plugin that ..." (it uses `plugin_new`, the
`build-a-plugin` skill, `plugin_test` and `plugin_review`).

## What a plugin is

```
my-plugin/
  harness-plugin.json     the manifest: what it adds, what it may reach, its pages and menu
  index.ts                its server code: tools, routes, data, hooks (setup(api))
  lib/                    more code (imported with relative paths)
  skills/<name>/SKILL.md  when and how the agent uses its tools
  agents/<name>.md        sub-agents
  workflows/<name>.json   workflow graphs
  GUIDE.md                what agents read about it in desktop sessions
  ui/                     its pages (HTML on the UI kit)
  test/*.test.ts          tests on the test kit
```

## Core and solutions

The core (chat, projects, agents, dashboards, documents, research, quality gates, integrations, the
desktop app) is always there. On top of it, **solutions** are complete standalone plugins shipped with
the harness: **Studio** (games and 3D, with its Blender, Godot, Unity and Unreal engines), **Operations**,
**Engineering** and **DevOps**. A server installs the ones it needs, in any mix (DevOps + Operations,
Studio only, Operations only...), from **Plugins > Catalogue > Solutions**; removing one keeps its data.

- A new server or desktop starts with the core only, or with `HARNESS_SOLUTIONS=aiops,devops` (or `all`,
  `none`) on its first start; a product edition sets the same with `"server": { "solutions": [...] }`.
- A setup that was in use before keeps every solution: nothing changes for it.
- `HARNESS_SOLUTIONS_MODE=all` loads every shipped plugin as before; a folder named in `HARNESS_PLUGINS`
  always loads.
- A solution needing another says so (`"requires": ["games3d"]`): installing it installs that one, and
  that one cannot be removed while it is needed.
- Your own plugin is built the same way: it uses the core's API (and other plugins' tools) and adds
  what the core does not have.

Every solution is **portable**: it imports the harness's abilities from `@harness/plugin-sdk/runtime` and
another plugin's modules by name (`@harness/plugins/games3d/...`), never by relative path, so it can be
packed (`npm run plugin -- pack`), signed and installed on any server. Plugins come in two tiers:
**official** (shipped with the harness, or signed with an official publisher's key: `HARNESS_OFFICIAL_KEYS`)
and **custom** (everything else). Both have the whole API and runtime.

## A plugin as a bundle

Each plugin carries what people need to find, trust and keep it: a display name, an icon image, tags, a
category, its publisher (the company behind it), author, licence, links (website, docs, support, privacy),
a changelog, and the harness versions it runs on (`engines.harness`). Its tests live in its own `test/`
folder, so they go wherever it goes.

- **Versions.** A server that is not in a plugin's `engines.harness` range does not load it, and the app
  shows why and what to do. Within a major version of the harness, the SDK and runtime only grow, so an
  update of the harness never breaks a plugin made for it; see *When the harness updates* in the
  [manifest reference](../../plugins/plugin-dev/skills/build-a-plugin/MANIFEST.md).
- **Updates and revisions.** *Check for updates* finds newer versions (the plugin's `updates.url`, the
  catalogue); *Update* installs one and keeps the version before; *Roll back* returns to it.
- **Moving.** *Export* saves a plugin as a `.tgz` bundle; *Import a plugin file* (desktop) or
  `POST /api/plugins/import` (a server) adds it elsewhere, reviewed and checked. On the desktop it can then
  open as its own app (*Open as app*, *Desktop shortcut*).

## The reference

The reference lives with the `build-a-plugin` skill, so agents and people read the same text:

| | |
|---|---|
| [The procedure](../../plugins/plugin-dev/skills/build-a-plugin/SKILL.md) | how to build one, step by step, and the rules |
| [API.md](../../plugins/plugin-dev/skills/build-a-plugin/API.md) | the server API: tools and their context (other tools, MCP, sub-agents, workflows), data (`api.store` with versions and migrations), routes, sessions, events, hooks, gates, MCP servers, providers, network, secrets, vault, background work, live reload |
| [MANIFEST.md](../../plugins/plugin-dev/skills/build-a-plugin/MANIFEST.md) | `harness-plugin.json`, permissions, the `ui` section and every contribution point (nav, views, menu, panels, commands, slash commands, settings, renderers, badges, data sources...), actions, icons, where it shows |
| [PAGES.md](../../plugins/plugin-dev/skills/build-a-plugin/PAGES.md) | pages: the SDK and its capabilities, the UI kit (components, classes, theme variables), patterns |
| [TESTING.md](../../plugins/plugin-dev/skills/build-a-plugin/TESTING.md) | the test kit: tools, routes over HTTP, scripted and real conversations, migrations |
| [PATTERNS.md](../../plugins/plugin-dev/skills/build-a-plugin/PATTERNS.md) | a complete app, using the rest of the harness, webhooks, background work, dashboards, data that changes shape |

## Examples

| | |
|---|---|
| [`examples/plugins/customer-desk`](../../examples/plugins/customer-desk) | a complete app: a menu of five pages and a panel, six tools (a sub-agent drafts replies), versioned data with a migration, a webhook that starts a triage conversation, a badge, a Dashboards source, a workflow with an approval, tests (review: 100) |
| `npm run plugin -- new` | the template: tools, data, routes, a skill, a guide, a page, tests |
| [`examples/plugins/acme`](../../examples/plugins/acme) | a tool, a gate, a hook, an agent, a skill |
| [`examples/plugins/hello-frame`](../../examples/plugins/hello-frame) | the page protocol by hand (no SDK) |
| `plugins/` | the shipped plugins (Operations, Studio, DevOps...) |

## Types

`@harness/plugin-sdk` has the types of everything (`import type { PluginAPI, PluginDefinition } from
'@harness/plugin-sdk'`); `@harness/plugin-sdk/testing` the test kit; `@harness/plugin-sdk/ui` the
page SDK and UI kit types. A plugin imports only types from it (nothing to bundle); the template's
`tsconfig.json` points at this checkout, so editors and `tsc` check plugin code, and the review runs
`tsc` when a plugin has one.

## The review

`npm run plugin -- check <dir> --deep` (the desktop app runs it when a folder is loaded, and on any
plugin's **Review** button; agents run `plugin_review`) loads the plugin into a throwaway harness and
checks: the manifest (fields, typos, paths), each tool (description, schema, a call of its read
tools), each route (served, no server errors on bad input, refusing callers it should), its pages
(the SDK loaded, every call covered by a declared capability and none declared unused, the routes
they call exist, no network, the theme followed), permissions declared against used, its code (child
processes, `eval`, the environment, plain `fetch`), secrets written in files, its skills, its types,
and its own tests. Errors mean it should not be used as it is; each finding says what to do.
