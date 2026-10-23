---
name: core.settings-guide
description: Settings of this computer, the person's account (permissions, vault, schedules) and every plugin's sections.
---

# Settings (core.settings)

## What it is for

Where the person changes how the app and their agents behave. Three scopes: **this computer**
(appearance, general, application and the harness home, shortcuts, servers), **the person's
account** on the server (permissions and limits, instructions, memory, vault, schedules, and the
account sections of plugins), and **the operator's policy** (models and providers, MCP bundles;
editable by administrators only).

Use this guide when the person asks to change a setting, add a provider key, change permissions,
set up a schedule or a secret, or find where something is configured. You open the right section;
the person makes the change (keys and secrets are never typed by you).

## How to act

- Open a section: `desktop_command {"command":"core.settings:open","args":{"section":"core.settings:models"}}`
  (a short id such as `"models"` works when it names one section). Every plugin's sections are
  listed by `desktop_describe` (`settings`) and in each plugin's guide.
- Switch the theme: `desktop_command {"command":"core.shell:set-theme","args":{"theme":"dark"}}`.
- Resize the window's panes (sidebar, side-panel, split, dashboards.inspector, dashboards.datasets,
  diagram.details): `desktop_command {"command":"core.shell:layout","args":{"action":"list"}}` gives each
  one's size, bounds and default; `{"action":"set","pane":"side-panel","size":640}` (clamped to its
  bounds), `{"action":"reset","pane":"sidebar"}` (no pane: all), `{"action":"collapse","pane":"sidebar"}`
  and `"expand"`. The sizes are the person's and are kept across restarts; change them only when asked.
- Secrets: the person stores them in Vault; you only ever name a vault entry (e.g. a data source's
  `secret`). Never ask for a key in the chat.
- Delegation (which other models agents may hand work to, a cost cap) is under Models & providers.

## Worked examples

**"Add my Anthropic key"**: open `core.settings:models` and tell the person where to paste it.

**"Stop asking me before every file edit in this project"**: open `core.settings:permissions`;
explain the allow rule they could add (e.g. `edit(src/**)`), they decide.

**"Run this every morning at 8"**: open `core.settings:schedules`, or use the `schedule` tool when
the session has it.

**"Make the font bigger"**: open `core.settings:appearance`.
<!-- generated -->
