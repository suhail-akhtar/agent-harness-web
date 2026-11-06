# Overview

This guide is for someone deciding whether to use this project. It says what the project is, what you get, what it does not do, and how you would build on it.

## What it is

This is a framework for building systems around AI agents, written in TypeScript. An agent is a language model working in a loop: it reads a task, calls tools (read a file, run a command, search the web), looks at the results, and repeats until the task is done.

The framework gives you that loop and what has to surround it to use it for real work: permissions, sandboxes, memory, multi-step workflows, a server with an HTTP API, an Electron desktop app, and a plugin system. Plugins use the same registry as the built-in features. The project also has an SDK for plugins, core plugins, solutions (complete products built on the core), and a kit, which is a signed local package of the engine that you build yourself.

It is for:

- developers who want agents inside their own product, and do not want to write the surrounding system;
- teams who want to run agents on their own machines, with their own model keys;
- operators who need control over what agents may do, what they may spend and who may use them;
- anyone who wants a desktop agent app that they can extend.

### What people can build on it

| A system | What it does | Parts it would use |
|---|---|---|
| A customer support desk | Pages for tickets, a webhook that starts a triage conversation, a sub-agent that drafts replies, a person who approves them | A plugin with tools, pages, a route and a workflow with an approval step. `examples/plugins/customer-desk` is a working version. |
| A delivery assistant for a software team | Takes a written request to tested code and a draft pull request | The Engineering solution (`build-feature`), quality gates, the Docker sandbox, `publish_branch`, a watch on new commits |
| An incident responder | Takes an alert, gathers evidence, proposes a fix, waits for a person, runs it, writes the postmortem | The Operations solution, alert webhooks, runbooks, the Key Vault, the Integrations plugin for approvals in chat |
| A monthly board pack | Reads a database, builds a dashboard, writes a deck, and leaves it in an inbox | Dashboards, the `data-answer` and `make-deck` workflows, a schedule, the Inbox |
| A research desk | Answers questions with reports whose citations are checked, and keeps score of forecasts | The `deep-research` workflow, the claim ledger, the forecasting plugin, artifacts |
| An agent inside your own product | Your front end, your tools, your accounts | `createHarness` and `defineTool` from the kit, or the server with `@harness/client`, single sign-on and daily spend caps |

## What you get out of the box

Almost everything below needs a model to talk to. That means one provider key, or a local model server. Items that need nothing more say "Works at once". Others say what they need. Keys and settings are in [Operating](06-operating.md#keys-and-providers). The exact lists of models, tools, plugins, agents, workflows, gates and settings are generated from the code in [the reference](07-generated-reference.md).

Two terms used throughout: a **session** is one conversation with an agent, with its history and its working folder (the desktop app says "conversation"). The **operator** is whoever runs the server or the app.

### Agents and models

- **The agent loop.** One loop drives every agent: call the model, run the tools it asked for, add the results, repeat. Errors come back to the model as repair instructions, not crashes. Works at once. [The loop](../../README.md#the-loop).
- **Progress review.** When an agent reaches its step budget, the harness looks at what it did. An agent on track goes on; a stuck one stops with an account of what it did, or restarts from a written handoff. Works at once. [The loop](../../README.md#the-loop).
- **Built-in providers.** Anthropic, OpenAI, xAI, DeepSeek, Moonshot AI (Kimi) and Z.ai (GLM). Needs that provider's key. [Models and providers](../../README.md#models-and-providers); the current models and prices are in [the reference](07-generated-reference.md#models).
- **Any OpenAI-compatible server.** Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, Azure OpenAI and Gemini, among others, with no code. Needs an entry in `HARNESS_MODELS_JSON` or `HARNESS_MODELS_FILE`; a local server needs no key. [Models and providers](../../README.md#models-and-providers).
- **Lower token bills.** Prompts are built so that the provider's cache keeps hitting. Plugin tools load only when needed, long output is kept in a file, old results are cleared in batches, and `run_script` lets the model process results without reading them all. On by default. [Token economy](../../README.md#token-economy-minimum-input-maximum-output).
- **Your own agents.** Make an agent with its own instructions, model, tools, skills, autonomy and limits, or import an agent file from another tool. Each is versioned. Works at once, on the desktop page Agents > Your agents. [The plan](../agents-mcp/PLAN.md).
- **Places to work.** A session works in a Docker sandbox, in a folder on the server, or on your own computer through the companion (a small program that connects out to the server). The sandbox needs Docker and its image; the companion needs to be started on that computer. [Where the agent works](../../README.md#where-the-agent-works).
- **History you can go back through.** Sessions survive a restart. Files are saved before a tool first changes them, so a turn can be rewound. A session exports as one file and imports elsewhere. Works at once. [Durability, checkpoints, trace](../../README.md#durability-checkpoints-trace).

### Teams of agents

- **Sub-agents.** The main agent hands a part of the work to another agent, which works in its own context and returns a report. Several run in parallel. Works at once. [Scheduled work and sub-agents](../../README.md#scheduled-work-and-sub-agents).
- **Background work.** Agents, workflows and shell commands run in the background and report back, and a finished result wakes an idle session. Works at once. [Scheduled work and sub-agents](../../README.md#scheduled-work-and-sub-agents).
- **Linked sessions and proposals.** An agent starts separate full sessions that report to it, or offers one for you to start or dismiss. Works at once in the desktop and web clients. [Multi-agent](../../README.md#multi-agent).
- **Teams.** An agent can lead named members and a reviewer. It splits the work, keeps writers off each other's files, and has the reviewer check the result. Works at once. [The plan](../agents-mcp/PLAN.md).
- **Fan-outs under a charter.** One brief runs over a list of items, one agent each, and comes back as one table. A charter limits how many agents start, how fast, and what they spend; Stop all ends every agent of a run. Works at once. [Swarm design](../swarm/SWARM.md).
- **Work accepted by checks, not on the agent's word.** A delegation can carry checks that the harness runs itself, and a verifier with a clean context. At high stakes the verifier comes from another provider. High stakes need a second provider and your consent to use it. [Coordination](../agents-mcp/COORDINATION.md).
- **Other models, with consent.** Sub-agents and workflow steps can run on other models, but only those you allow, because what they see goes to that company. Needs that provider's key and a setting. [Multi-agent](../../README.md#multi-agent).
- **Work across your computers.** Agents can be placed on your own machines. Each machine's own policy file decides what they may do there. Needs a companion on each machine. [Swarm design](../swarm/SWARM.md).

### Workflows

- **Workflow graphs.** A workflow is a graph of steps that the harness drives, not the model: agents, quality gates, approvals, parallel branches, conditions, loops over a list, shell commands. Each step is saved, so a run survives a restart. Works at once. [Workflows](../../README.md#workflows-node-graphs).
- **Workflows that ship with the core.** Among them `deep-research`, `make-deck`, `write-document`, `data-answer`, `security-review` and `investigation`. Works at once, though some need more setup for what they produce (see the groups below). [The reference](07-generated-reference.md#workflows).
- **Your own workflows.** A JSON file in `.harness/workflows`, or one registered by a plugin. Run one from the desktop, the command line, a schedule, or code. Works at once. [Workflows](../../README.md#workflows-node-graphs).
- **Quality gates.** Checks that decide for themselves whether they apply: tests, type checks, lint and builds for several languages, and scans for secrets and merge-conflict markers. They run as workflow steps, as a tool, or before an agent may end its turn. They need the project's own toolchain, and bash on Windows. [Quality gates](../../README.md#quality-gates-pluginsquality-gates).

### Tools

- **Files and commands.** `read`, `write`, `edit`, `grep`, `glob` and `bash`, with checks: writing files from the shell is refused, and a file cannot be replaced without reading it first. Works at once. [The reference](07-generated-reference.md#built-in-tools).
- **Code mode.** `run_script` runs a short JavaScript program that calls tools and keeps only what it needs. Works at once. [Token economy](../../README.md#token-economy-minimum-input-maximum-output).
- **Looking at what was made.** `render` turns documents and pages into images and checks them; `browser` drives a page in headless Chromium. Needs Chromium, and LibreOffice for Office files. [Visual verification](../../README.md#visual-verification-pluginsvisual).
- **MCP services.** MCP (Model Context Protocol) is a standard way to offer tools to a model. Connect servers by address, sign in through the browser, and approve each tool. A changed tool stops working until you approve it again. Needs the service and its credentials. [Plugins](../../README.md#plugins), [the plan](../agents-mcp/PLAN.md).
- **Build an MCP server.** Settings > MCP servers > Build a server makes one from a description, an OpenAPI document, a database or a command. Administrators only, because building runs code on the server. [The plan](../agents-mcp/PLAN.md).
- **Pull requests.** `publish_branch` commits, pushes and opens a draft pull request. Needs `HARNESS_GITHUB_TOKEN`. [Publishing](../../README.md#publishing-branches-and-pull-requests).

### Research

- **Web search and reading.** `web_search` works for every model and `web_fetch` reads pages and PDFs. Every page read is recorded as a source, outside the workspace, so an agent cannot invent one. `web_fetch` works at once; search needs a backend ([which ones](06-operating.md#search-backends)). [Research](../../README.md#research).
- **Citation check.** A report's cited pages must have been read, its quotes must appear word for word, and its figures must appear in a cited source. Works at once. [Research](../../README.md#research).
- **The `deep-research` workflow.** Plans sub-questions, sends researchers in parallel, writes a report, checks it and revises it. Needs a search backend. [Research](../../README.md#research).
- **The claim ledger.** Each cited sentence is judged against its page by a model of another company. Needs a second provider's key. [Research](../../README.md#research).
- **Forecasting.** Live yes/no questions forecast by several models, combined in code, and scored once they resolve. Needs keys for the models used. [The reference](07-generated-reference.md#plugins-that-ship-with-the-core).
- **Investigations.** A coverage checklist and a ranked queue of leads with their evidence, inside a mandate you write. Every identification and decision stays with you. Works at once. [The reference](07-generated-reference.md#plugins-that-ship-with-the-core).

### Documents

- **Decks and documents.** `make-deck` and `write-document` go from a brief to a storyline, a build (`.pptx`, `.docx` with PDF), a look at every page, an independent review, and revisions. Needs Chromium, and LibreOffice for Office files. [Documents](../../README.md#documents-pluginsdocuments).
- **Artifacts.** Documents, apps, diagrams and data an agent makes appear in the app with versions, previews and a Library. Works at once in the desktop app. [HTTP API for desktop clients](../../README.md#http-api-for-desktop-clients).

### Data and dashboards

- **Sources and datasets.** Read files, logs, SQLite, Postgres, MySQL, SQL Server, MongoDB and HTTP APIs into named datasets, with a query editor and refreshes. Files work at once; a database needs its address, with its password in the Key Vault. [Data, dashboards and reports](../../README.md#data-dashboards-and-reports-coredashboards).
- **A semantic model.** Relationships, measures, time intelligence and row-level security, computed in SQL by DuckDB, so a model never types a number on a dashboard. Works at once. [Data, dashboards and reports](../../README.md#data-dashboards-and-reports-coredashboards).
- **Dashboards and reports.** Pages of visuals with cross-filtering, drill, layouts and templates; publishing at a link; exports. PDF and PNG exports need Chromium. [Data, dashboards and reports](../../README.md#data-dashboards-and-reports-coredashboards).
- **Answers from your own database.** The `data-answer` workflow answers with read-only SQL, traces every number to a query, and has an agent of another model family recompute the figures. Needs the database, and a second provider's key for the recomputation. [The reference](07-generated-reference.md#workflows).

### Memory and skills

- **Memory.** Agents keep Markdown notes about you and about the project across sessions. You can read, edit and delete them, and saving after untrusted content needs a yes. Works at once. [Memory across sessions](../../README.md#memory-across-sessions).
- **Instructions.** `AGENTS.md`, `CLAUDE.md` and `HARNESS.md` files, your own instructions, and the operator's. Works at once. [Instructions, settings and output styles](../../README.md#instructions-settings-and-output-styles).
- **Skills.** Know-how an agent loads only when the task needs it: instructions alone, or scripts with tests. Each person has a library; import a skill, or ask an agent to make one. Works at once. [Skills](../SKILLS.md).

### Proactive work

- **Schedules.** Run a prompt or a workflow once, or on a repeating time, in a new conversation or the same one. Works at once, but only while the server or app is running. [Operating](06-operating.md#unattended-work).
- **Triggers.** A secret URL that starts a prompt when something posts to it. Needs something that can reach the server. [Scheduled work and sub-agents](../../README.md#scheduled-work-and-sub-agents).
- **Watches.** A check with no model (a command, files, new commits, a web page) that starts a run only when something changed. Works at once. [Proactive plan](../proactive/PLAN.md).
- **The Inbox.** What waits for you in one place: approvals, questions, results of scheduled runs, what agents told you. You choose what may interrupt you. Works at once in the desktop app. [Proactive plan](../proactive/PLAN.md).
- **Noticing.** Fixed detectors notice things such as a schedule that keeps failing, with no model watching. It starts in a practice mode that shows nothing. Works at once. [Noticing](../proactive/NOTICING.md).

### Computer use

- **A desktop inside the sandbox.** The agent works a virtual screen through screenshots, mouse and keyboard, contained like any command there. Needs Docker and the desktop image (`npm run sandbox:image:desktop`). [Computer use](../../README.md#computer-use-pluginscomputer).
- **Your real desktop.** The same tool on your own screen, through a companion started with `--allow-desktop`. Off by default, and each action is asked about unless you are in bypass mode. [Computer use](../../README.md#computer-use-pluginscomputer).

### Integrations

- **Chat, paging and ticketing.** Slack, Microsoft Teams, PagerDuty, Opsgenie, Jira Cloud and ServiceNow. Incidents and approvals reach people in chat, and approvers answer from there. Needs an account with each service, credentials in the Key Vault, a configuration in `HARNESS_INTEGRATIONS`, and a public HTTPS address for two-way chat. It has been tested against stand-ins, not real accounts. [Integrations](../../README.md#integrations-pluginsintegrations).
- **Your agents in other apps.** The harness can be an MCP server, so your agents appear as tools in other programs. Off until you turn it on in Settings > Use your agents elsewhere. [The plan](../agents-mcp/PLAN.md).
- **Hooks.** Deterministic steps at fixed points in a session: a command, an HTTP call, a small model's judgement, an MCP tool or a verifying agent. Needs a settings file or a plugin. [Hooks](../../README.md#hooks).

### Safety

- **Permissions.** Every tool call is checked in code against rules and a mode, from "ask before edits" to "never ask". Works at once. [Permissions](../../README.md#permissions).
- **The untrusted-content guard.** Once a web page or service result is in the context, every way out of the session is confirmed, and hidden text is removed. On by default. [Permissions](../../README.md#permissions).
- **Sandboxes and network control.** One container per session, with no network, an allowlist or full network. Needs Docker. [Where the agent works](../../README.md#where-the-agent-works).
- **The Key Vault.** Named secrets that sessions use without the model seeing them, sealed at rest and audited. Works at once; external vaults need configuration. [Key Vault](../../README.md#key-vault).
- **Signed plugins.** An operator can require that plugin code is signed by a trusted key. Needs a trust list. [Plugins](../../README.md#plugins).
- **Security review of your own code.** A finding counts only when the harness ran its reproducer and it fired, inside a mandate you write. Works at once; isolated runs need a container. [The reference](07-generated-reference.md#workflows).

The whole picture is in [the security model](05-security-model.md).

### The desktop app, page by page

The app runs the same engine as the server, on your computer, and can connect to a remote server instead. A first run asks for a provider key and a default model. Its details are in [the desktop README](../../apps/desktop/README.md).

| Page | What it is for |
|---|---|
| New chat | The home page: the message box, starting prompts and cards such as what waits for you |
| Search | Finds past conversations |
| A conversation | The transcript, with workflow graphs, task lists, chapters and cards for each delegation. Side panels show Agents, Artifacts and the Run record. Two conversations can sit side by side. |
| Inbox | Approvals and questions waiting for you, updates from unattended work, and Noticing |
| Scheduled | Every schedule, watch and trigger, its next run, its last result and each run's record |
| Activity | What is running now and what ran lately |
| Projects | Your folders, each with its conversations |
| Agents | Working now (everything at work, with Stop all), Your agents, Your skills and the Library of artifacts |
| Dashboards | Dashboards, Reports, and Data (sources, datasets, the model, refresh history) |
| Plugins | Installed, Catalogue and Developer: install from a file, review, update, roll back, switch off |
| Settings | Appearance, General, Application, Shortcuts, Servers; Models & providers, Permissions & limits, Instructions, Memory; Vault, Schedules, MCP servers, MCP bundles, Use your agents elsewhere, Your computers; About |

Plugins add pages of their own: Research, Data answers, Forecasting, Investigations and Security review from the core, and for example Delivery from Engineering and the console from Operations. A command palette reaches every page and command. Agents in a desktop session know the app and can open pages and run the commands a plugin marks for them.

### The server and API

- **The server.** `npm start` from a checkout, or `harness start` from the kit, serves a browser interface and a JSON API on 127.0.0.1. It prints an access token. Works at once. [HTTP API](../../README.md#http-api).
- **Event streams.** Each session has a stream of server-sent events, and one global stream carries approvals, schedules, plugin changes and notices. Works at once. [HTTP API for desktop clients](../../README.md#http-api-for-desktop-clients).
- **Accounts and limits.** Members see only their own work. Requests, messages, running sessions and daily spend are limited per person. Needs accounts to be made. [Shared servers](../../README.md#shared-servers-accounts-and-limits).
- **Single sign-on.** OpenID Connect with Microsoft Entra ID, Google, Okta, Keycloak and others. Needs an application registered at the provider. [Single sign-on](../../README.md#single-sign-on).
- **Several servers.** Two or more can share one data folder behind a load balancer. Needs a shared folder and a shared secret. [Running several servers](../../README.md#running-several-servers).
- **Published dashboards.** A dashboard can be served read-only at `/p/<slug>`. Needs the viewer built once with `node apps/desktop/scripts/build-viewer.mjs`: `npm run build`, `npm run kit` and `npm run desktop:build` do not build it. [Data, dashboards and reports](../../README.md#data-dashboards-and-reports-coredashboards).

### The SDK and test kit

- **The plugin SDK.** `@harness/plugin-sdk` has the types, the runtime and the page kit. `npm run plugin -- new <name>` writes a working plugin. Works at once. [The plugin SDK](../plugin-sdk/README.md), [Build your first plugin](../BUILD-A-PLUGIN.md).
- **The test kit.** `@harness/plugin-sdk/testing` gives a real harness, tool calls, routes and scripted conversations, so tests spend no money. Works at once. [The plugin SDK](../plugin-sdk/README.md).
- **Plugin review.** `npm run plugin -- check <dir> --deep` loads a plugin into a throwaway harness and reviews its manifest, tools, routes, pages, permissions and code. Works at once. [The plugin SDK](../plugin-sdk/README.md).
- **Agents that build plugins.** The `plugin-dev` plugin gives an agent the template, the tests and the review as tools. Works at once. [The plugin SDK](../plugin-sdk/README.md).
- **The client.** `@harness/client` is a typed client for a front end of your own. Works at once. [The kit](../../kit/README.md).
- **The kit.** The engine, core plugins and SDK with their dependencies in one signed archive, to build on without this repository. You build it yourself with `npm run kit`. [The kit](../../kit/README.md).

### Evaluation and observability

- **The trace.** Every model call and tool call is recorded with its tokens, time and cost. Works at once. [Durability, checkpoints, trace](../../README.md#durability-checkpoints-trace).
- **Cache-miss attribution.** When the provider's cache misses, the trace names what changed. On by default. [Token economy](../../README.md#token-economy-minimum-input-maximum-output).
- **OpenTelemetry export.** Spans go to any OTLP/HTTP collector. Needs `HARNESS_OTEL_ENDPOINT`. [Observability](../../README.md#observability).
- **The run recorder.** A hash-chained log of a session's requests, calls and decisions, exported as a signed bundle that can be verified. Needs `"record": true` or `HARNESS_RECORD=on`. [Operating](06-operating.md#watching-it).
- **Evaluations.** `npm run eval` runs task packs on chosen models, in fresh workspaces, judged by hidden checks, and can compare harness configurations. Spends model money. [Evaluations](../../README.md#evaluations); past results are under [Measured](../../README.md#measured-2026-10-20-to-2026-10-24).

### Solutions

Solutions are complete products on the core, each with its own version, plugins, tests and docs. Each installs into the desktop app as one file, or builds into an app of its own.

- **[Engineering](../../solutions/engineering/README.md):** software delivery with role agents, gates and a delivery board.
- **[DevOps](../../solutions/devops/README.md):** Terraform or OpenTofu, Kubernetes, CI and compose deploys, with changes shipped only as approved.
- **[Operations](../../solutions/operations/README.md):** an inventory of hosts and services, monitoring, alerts, incidents and runbooks.
- **[Studio](../../solutions/studio/README.md):** browser games, 3D models, and Blender, Godot, Unity and Unreal Engine.

## What it does not do

From the README's [Honest limits](../../README.md#honest-limits), and the state of the project:

**It does not make models equal.** A harness changes what a model achieves, but the model is still most of the result.

**It does not contain plugin code.** Plugins run in the server process. Declared permissions hold on the channels the harness hands out, not on code that ignores them. Signing decides which code may run at all.

**It does not contain everything on every platform.**

- Windows has no operating-system sandbox for a command: use Docker there, or keep to trusted work.
- Outside Docker and Linux, `run_script` cannot be cut off from the network, so it asks first.
- The network proxy does not read inside HTTPS. For HTTPS it decides by host and port only.
- Behind an HTTP proxy, `web_fetch` can check an address only before the request.

**It does not fully protect secrets from whoever can use them.**

- Secrets at rest are protected against a copied data folder, not against the server's own account.
- Redaction catches the usual forms of a value. A command that holds a secret can still print it in some other form.

**Computer use has limits.** Planted instructions in the picture part of a screenshot cannot be removed the way hidden text can. On a real desktop the agent sees whatever is on the primary display when it takes a screenshot.

**Some parts have not been run for real.**

- Integrations are tested against stand-ins of each service, not real accounts.
- Sandboxing and desktop control were not run on a real Mac.
- The stronger container runtimes (gVisor, Kata) were not installed for testing.
- Azure Key Vault and AWS Secrets Manager were tested against local stand-ins.

**Studio has limits.** Godot's export image has only some templates, and the Godot self-test gate proves only what the game's own self-test checks.

**Several servers on one folder have limits.** A crashed server's sessions wait out a lease before another takes them. The shared disk must support atomic create and rename, and the servers' clocks must agree.

**It is not packaged for general release.**

- The kit is local. It is not on npm: you build it from this repository, or get the archive from someone who did.
- The desktop installer has no code-signing certificate, so an operating system may warn about it.
- Windows is the only platform a desktop installer has been built on.
- There is no CI in the repository. Tests run by hand.

## The four ways to build on it

The details and a worked example of each are in [Build your system](04-build-your-system.md).

**A plugin.** A folder with a `harness-plugin.json`. It adds tools, skills, agents, workflows, gates, routes and pages to a harness that already runs. Choose this when the server or desktop app already does most of what you need.

**A solution.** A complete product on the core, made of plugins, with its own version, tests and docs. It installs as one file, or builds into a desktop app with its own name and home folder. Choose this for a product you will ship to others.

**Your own program.** `harness new my-agent` makes a project linked to the kit, with `createHarness` and `defineTool` in your own code. Choose this when an agent is one part of a larger program.

**A server with your own front end.** Run `harness start` and write the interface yourself on the HTTP API or `@harness/client`. Choose this when you need accounts, limits and the API, but your own screens.

## How it compares in shape

A plain model API call gives you one request and one reply. A framework that only gives you a loop adds the repetition: call the model, run its tools, go on until it stops. Both leave the rest to you. This is what you would otherwise write yourself:

| What a working system needs | What you would write | Here |
|---|---|---|
| Staying up | Retries, dropped streams, resuming after a restart | History, checkpoints, resume |
| Knowing when to stop | Step and spend limits, a way to tell stuck from slow | Limits and the progress review |
| Cost control | Cache-friendly prompts, compaction, per-person caps | Built in, and measured in the trace |
| Control over actions | A permission system, a way to ask a person and wait | Modes, rules, approvals, the Inbox |
| Untrusted input | Tracking what the agent read and what may leave | The untrusted-content guard |
| Isolation | Containers, network policy, secrets kept from the model | The sandbox and the Key Vault |
| Fixed procedures | A step engine with state, approvals and resume | Workflows and quality gates |
| Delegation | Sub-agents, limits on them, checks on their work | Sub-agents, teams, charters, acceptance checks |
| Long memory | Notes across sessions, guarded against planted text | Memory, skills, instructions |
| Unattended work | A scheduler, wake-ups, what happens on a restart | Schedules, watches, the Inbox |
| Being used by others | An API, accounts, sign-on, a user interface | The server and the desktop app |
| Extension | A way for others to add tools and pages safely | Plugins, signing, the SDK |
| Knowing if it works | Tracing and a way to score runs | The trace, the run recorder, evaluations |

What you take on in return: a larger system to learn, Node as the runtime, and this project's choices about how sessions, permissions and plugins work. If one model call or a short loop meets your need, a plain API call is less to run.

## Where to go next

- [Architecture](02-architecture.md): how the parts fit together.
- [Getting started](03-getting-started.md): install it and run a first task.
- [Build your system](04-build-your-system.md): the four ways to build on it.
- [The security model](05-security-model.md): what is protected, how, and what is not.
- [Operating](06-operating.md): running it for yourself or others.
- [The reference](07-generated-reference.md): models, tools, plugins, settings and more, generated from the code.
- [The README](../../README.md): the full detail of every feature.
