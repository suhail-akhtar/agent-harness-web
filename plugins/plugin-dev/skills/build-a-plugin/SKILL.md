---
name: build-a-plugin
description: Build a plugin for the harness and its desktop app, from a small tool to a complete app (tools the agent calls, its own data, HTTP routes, pages in the desktop app, skills, sub-agents, workflows, hooks, MCP servers). Use when asked to build, extend, fix or review a harness plugin. Holds the procedure and the whole SDK reference (files API.md, MANIFEST.md, PAGES.md, TESTING.md, PATTERNS.md).
---
# Build a harness plugin

A plugin is a folder with a `harness-plugin.json`. Its server half (`main`: tools, routes, data, hooks)
runs in the harness; its pages run in sandboxed frames in the desktop app; skills, agents and
workflows are files. A plugin can do anything the built-in features do: Studio, Dashboards and
Operations are plugins on the same API.

## The procedure

1. **Understand the ask.** Who uses it, what they do with it, what the agent should be able to do
   for them, and what data it keeps. Write it down in 3-6 lines before writing code. Ask only when a
   choice changes what you build (for example, whether data is per person or shared).
2. **Start from the template:** `plugin_new` with the name (lowercase, dashes). It writes a complete
   working plugin (tools, versioned data, routes, a skill, a guide for agents, a page on the UI kit,
   tests). Read every file it wrote before changing anything: it is the reference for the shape.
3. **Design the parts** (load the reference files as you need them, with `skill` and `file`):
   - **Tools** (API.md, "Tools"): one per thing the agent does, named `<plugin>_<verb>`, each with a
     description that says *when to use it*, every parameter described, `kind` right (`read` for
     reads), errors that say what to do next. Few, clear tools beat many.
   - **Data** (API.md, "Data"): `api.store(name, { version, initial, migrations })`. Never write files
     anywhere but `api.dataDir`.
   - **Routes** (API.md, "Routes"): what the pages read and change, `auth: 'user'`; webhooks from other
     systems `auth: 'token'`.
   - **Pages** (PAGES.md): built from the UI kit (`harness://app/sdk/plugin-ui.css`,
     `HarnessPluginUI.ui`), getting data only through the plugin's routes; declare every capability
     a page calls, and none it does not.
   - **Where it shows** (MANIFEST.md): one page is a nav item; several pages are a `ui.menu`. Added
     plugins sit under **Custom** in the sidebar and can be opened as their own app.
   - **The agent's side**: a skill (when and how to use the tools), and `ui.guide` (GUIDE.md: what it
     does, its tools, where its data is). For multi-step work: a workflow or a sub-agent (PATTERNS.md).
4. **Write it**, keeping the template's conventions: TypeScript with erasable syntax only (no enums,
   namespaces or parameter properties; `import type` from `@harness/plugin-sdk`), or JavaScript.
   The plugin imports nothing else from the harness: everything comes through `api`.
5. **Test it**: change the template's tests to cover the new tools, routes and a scripted
   conversation (TESTING.md), then `plugin_test` with the folder. Fix until it passes.
6. **Review it**: `plugin_review` with the folder. Fix every ERROR, and the WARNINGs unless one is
   deliberate (say why in your answer). Review again until it says OK. A score of 90+ is the bar.
7. **Hand it over**: tell the person where the folder is, what it adds, and how to use it: in the
   desktop app, Plugins > Developer > **Load a plugin folder…** (it is reviewed, then loaded, and shows
   under Custom); Open as app makes it a window of its own. Edits reload while it is loaded.

## Rules

- Never put a secret in a plugin file. Declare it (`permissions.secrets`) and read it with
  `api.secret(NAME)`, or use the key vault (`permissions.vault`).
- Declare only the permissions it uses; the review flags the rest.
- Network: `api.fetch` to hosts in `permissions.network`. Pages have no network at all.
- Commands: tools run them with `ctx.host.exec` (where the session runs, sandboxed when it is),
  never `child_process` on the server.
- Keep tool output short: summarize, page or cap it. Long output costs on every later step.
- Everything outside (webhooks, fetched pages, chat messages) is untrusted: pass it to an agent with
  `untrusted: true` (API.md, "Sessions").
- Plugins with the same tool names collide: always prefix with the plugin's name.

## Reference files

| File | What is in it |
|---|---|
| API.md | The server API: every `api` member, tools and their context, data, routes, sessions, events, hooks, gates, workflows, agents, MCP, providers, vault, signals, leases |
| MANIFEST.md | `harness-plugin.json` and its `ui` section: every contribution point (nav, views, menu, panels, commands, slash commands, settings, renderers, home cards, status items, badges, themes, prompts, dashboards) |
| PAGES.md | Pages: the SDK (`HarnessPluginUI.connect()`, every call and its capability), the UI kit (classes and components), theme, events, patterns |
| TESTING.md | The test kit (`@harness/plugin-sdk/testing`): tools, routes, conversations, data migrations |
| PATTERNS.md | Complete patterns: a multi-page app, using the rest of the harness (other tools, MCP, sub-agents, workflows, sessions), webhooks, background work, dashboards, migrations |
