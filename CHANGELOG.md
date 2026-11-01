# Changelog

## Unreleased

- **Scheduled work you can see** (proactive work, phases 0 and 1; plan in docs/proactive/PLAN.md):
  - The desktop's New schedule form made no schedule (it sent no target): it now says where each run happens,
    a new conversation each time (its model and folder) or the same one.
  - Scheduled, triggered and plugin-started runs respect the daily spend limit (they checked concurrency only).
  - `notify_user` reaches the person: a toast and a system notification with the conversation's title (it stayed
    inside its conversation).
  - Every run is written down: how it ended (completed, failed, stopped, skipped, interrupted), when, how long, its
    cost, a line of what it said, its tool calls and actions, whether it told the person, whether it found nothing
    (`[nothing to report]`), and its conversation. `GET /api/schedules/:id/runs`, `GET /api/schedule-runs`; the
    `schedules` events say when a run starts and ends.
  - A Scheduled page (every schedule and trigger, next run, last result, each run's record; New, Edit, Run now,
    on/off, Delete), the same list in Settings > Schedules, and the latest runs on Activity. A finished run says
    what it found in a toast; one that found nothing stays quiet.
  - Schedules: a time zone for the cron (daylight saving: a skipped time does not run, a repeated one runs once),
    a missed run runs once or is skipped (`misfire`), at most one run every 5 minutes
    (`HARNESS_SCHEDULE_MIN_MINUTES`), a spend limit per run (`maxCostUsd`), and `PATCH /api/schedules/:id`. A run
    cut off by a shutdown is interrupted, not "stopped by the person". A trigger's hash no longer leaves the server.
  - The app says schedules stop when the window closes (unless it keeps running in the tray) and when the computer
    restarts (unless it starts at login), with a button for each.
- **The agent inbox** (proactive work, phase 2): the Inbox has Updates under "Waiting for you": a scheduled run's
  result when it found something (failed or stopped ones as warnings), what an agent told the person (`notify_user`,
  from any conversation), and work an agent offered during a scheduled run (a suggestion: Start or Dismiss). Each is
  opened, marked read or unread, snoozed (an hour, until tomorrow) or dismissed with a reason (not useful, wrong, bad
  timing, other); every response goes to `inbox-feedback.jsonl`. `GET /api/inbox`, `POST /api/inbox/:id`,
  `POST /api/inbox/read-all`, an `inbox` event topic; the sidebar badge counts what waits and what is new. A run that
  already told the person or offered work has no second update.
- **Unattended runs wait instead of refusing**: a schedule can ask in the Inbox (edits allowed, or nothing allowed
  without asking); a request then waits there for the hours it says (`askTimeoutMinutes`, default 8 hours), then gets
  the safe answer (no) and the run goes on. Its record counts what it asked. A schedule's own conversations have
  linked sessions, so work an agent offers there reaches the Inbox.
- Settings and the Scheduled page say what the server refused inside the form, not in a toast that stays and covers
  other dialogs.
- **Setting proactive work up, made easy** (for the person, and by agents):
  - A new schedule dialog: start from a template (Morning briefing, Watch the tests, Weekly report, Check back later);
    say what it runs (a prompt, or a workflow with its inputs), when in plain choices (once, every few minutes, hourly,
    daily, weekdays, weekly on chosen days, monthly, or a cron), shown in words with its next three runs before it is
    made; where (a new conversation each time in a folder, or the same one); and what happens when it needs approval
    (never stop to ask, a checker decides, edits are fine, ask me for everything; how long to wait). Limits under
    More options; what is still needed is said next to the button, which is always in view.
  - The Scheduled page: each schedule in plain words ("Every weekday at 09:00 (Asia/Tokyo)"), when it runs next
    ("in 3 h"), what it runs and how it asks, its last result as an icon and a word (why a run failed or stopped
    under it), Run now, on/off, and a menu (Edit, Show its runs, Delete after a confirmation). An empty page offers
    the templates and "Ask an agent to set it up".
  - Agents set it up: the `schedule` tool makes a routine in a new conversation each time (`new_conversation`, like
    the agent's own conversation; `asks: inbox`), in a time zone, or one that runs a workflow, then tries it with
    `run_now`; the desktop's `core.scheduled:new` command opens the dialog filled in with what an agent proposes, for
    the person to confirm.
  - Schedules and triggers can run a workflow (`workflow: {name, input}`): its run is followed to its end, its approval
    steps wait in the Inbox. `GET /api/workflows?path=` lists the workflows a folder offers; `POST /api/schedules/preview`
    says what a timing means; schedules carry `when` (in words) and `upcoming` (their next runs).
- Toasts move to the top while a dialog is open, so they never cover its buttons.

- **run_script works in the desktop app**: it started its helper with the app's own executable, which opened a
  second app (refused by the single-instance lock, exit 0) instead of running Node, so every call failed with
  "the script process exited (0)". The same was true of plugin review's type check, .mcpb Node servers and the
  network-allowlist proxy. They now ask Electron for Node mode (`nodeEnv()`).
- **A task card and a live activity line in the conversation**: the agent's task list (todo_write) shows as a card
  under the transcript while the turn runs or while some of it is open, and the line under it says what is
  happening now ("Showing all result JSON files", "Waiting for shell-85yenz", "Thinking") and how long the turn has
  run, instead of a bare "Working...". todo_write takes an `activeForm` ("Running the tests") for the step in
  progress, and its description asks for a list on any task of three or more steps.
- **bash**: `cmd | tee run.log` keeps a log again; tee and echo/printf are refused only when they write source or
  documents (as `> run.log` was always allowed).
- **Export**: an exported or copied conversation has the person's words only, without the context the harness adds
  to the first message (environment, memory, skills) or reminders.

## 0.2.5

- **Every solution apart from the core**: Engineering (`solutions/engineering`: sdlc 1.2.0), DevOps
  (`solutions/devops`: devops 1.1.0) and Operations (`solutions/operations`: aiops 1.2.0) join Studio, each with its
  own version, tests (test kit only), eval pack, docs and changelog. Each installs into the harness app as one
  signed file (Plugins > Install from a file) or becomes an app of its own (`--solution engineering|devops|operations`).
  The core is the engine, the SDK, the desktop app and its built-in plugins (visual, documents, research,
  computer, integrations, quality-gates, plugin-dev); its installer ships just those.
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
