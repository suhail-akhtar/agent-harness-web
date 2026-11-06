# Operating

This guide is for someone running the harness for themselves or for others. The operator is whoever runs the server or the app. Every setting named here is listed, with its default, in [the reference](07-generated-reference.md#settings).

## Ways to run it

### The desktop app

`npm run desktop:build` writes an installer to `apps/desktop/release/`, and `npm run desktop:dev` runs the app from a checkout. An installed app carries its own runtime, so it needs no Node on the machine.

The app starts its own server, called the engine, on 127.0.0.1 with a random port and token. Settings > Servers connects it to a remote server instead. A first run asks for a provider key and a default model.

### The server

From a checkout:

```bash
npm install
npm run build     # the browser interface and the companion script
npm start         # http://127.0.0.1:4310
```

From the kit (the signed archive, see [The kit](../../kit/README.md)):

```bash
node harness-kit-<version>/bin/harness.mjs start
```

At start the server prints its address, its home and data folders, an access token, the models with and without keys, the plugins, and the web search backend. The token is random at each start unless you set `HARNESS_TOKEN`.

The server also runs in Docker (`docker compose up harness`, see the [Quick start](../../README.md#quick-start)). There, sessions use a folder in the container, and the container is the isolation. `docker-compose.yml` passes through the Anthropic, DeepSeek and OpenAI keys; add any other key to its list.

### The command line

One job, then the process ends:

```bash
npm run cli -- --model <id> --runtime local --dir ./project "Fix the failing test"
npm run cli -- --output json --max-steps 60 --max-cost 0.50 --max-minutes 20 --dir ./project "Fix the failing test"
```

From the kit, the same is `harness run`. `--output json` prints one result object, and the exit code says how the run ended. Without `--dir`, a run works in a new folder under the home's `tmp/`. Plugins' background loops do not run here. The result fields and exit codes are in the [Quick start](../../README.md#quick-start).

### A library

`harness new my-agent` makes a project linked to the kit, with `createHarness` in your own code. [Build your system](04-build-your-system.md) has the details. A library calls `sessions.resumeInterrupted()` itself once it is ready, if it wants interrupted work to carry on.

### What each needs

| Requirement | What it is for | Without it |
|---|---|---|
| Node, at the version given at the top of [the reference](07-generated-reference.md) | The server, the command line, the library, the kit. It runs the TypeScript directly. | Only an installed desktop app works |
| Docker (optional) | Sandbox sessions, the computer-use desktop, the Docker-based test stacks | Work in a server folder or through the companion |
| Sandbox images | Built once with `npm run sandbox:image`; extra images for 3D, desktop and DevOps work (see the [Quick start](../../README.md#quick-start)) | Docker sessions cannot start |
| Git Bash, on Windows (from Git for Windows) | The shell for the model's commands, background commands and quality gates | Commands run in PowerShell, background commands are refused, and gates fail saying they need bash |
| Git | Worktrees, cloning repositories, `publish_branch` | Those are not available |
| Chromium (`npx playwright install chromium`, or `HARNESS_CHROMIUM`) | `render`, `browser`, the gates that open pages, PDF and PNG exports of dashboards | Those tools say how to install it |
| LibreOffice | Rendering `.pptx`, `.docx` and `.xlsx` files | A missing one is reported with how to install it |
| Blender, Godot | Studio's engine tools outside the 3D sandbox image | Gates report `not checked`, as a warning |

The Docker image of the server (`docker/Dockerfile.harness`) has Node, bash, LibreOffice, poppler, pandoc and Chromium.

## The harness home

The harness home is one folder shared by the server, the command line and the desktop app. It is `HARNESS_HOME` if that is set, else the folder a move left in `~/.harness-location`, else `~/.harness`. The server prints the home and data folders it uses at start.

| Folder or file | What it holds |
|---|---|
| `data/` | Everything the server keeps (below). `HARNESS_DATA` puts this folder elsewhere. |
| `workspaces/` | `default/`, and the projects the app creates |
| `tmp/` | Scratch conversations and command-line runs, a folder each. Entries not changed for some days are removed at start and daily. |
| `exports/` | Dashboards, reports and session exports |
| `plugins/` | Plugins installed from a catalogue |
| `logs/` | The desktop app's engine log |
| `settings.json` | Settings of this home: only the `tmp/` clean-up age (`tmpCleanupDays`) |

Inside `data/`:

| Path | What it holds |
|---|---|
| `sessions/<id>/` | One session: `meta.json`, `history.jsonl`, `trace.jsonl`, workflow runs |
| `workspaces/` | Workspaces that live in the data folder, such as a sandbox session's |
| `vault/` | Key Vault metadata, sealed values and `audit.jsonl` |
| `secret.key` | The key that seals secrets, unless `HARNESS_SECRET_KEY` is set |
| `record-signing-key.pem` | The private key that signs run records, made when first needed |
| `accounts/<owner>/` | Each person's settings and instructions |
| `memory/`, `skills/`, `agents/` | Memory notes, and people's skills and agents |
| `data/` | Dashboards' sources, datasets and extracts |
| `plugin-data/<name>/` | Each plugin's own data. This survives switching the plugin off. |
| `plugins-state.json`, `plugin-routes.json`, `plugin-actions.jsonl` | Which plugins are on, route tokens (hashed), and what plugins did in sessions |
| `users.json`, `spend.json`, `schedules.json`, `inbox.json` | Accounts, spend, schedules and the Inbox |
| `changes.jsonl`, `activity.jsonl` | The change journal, and the fingerprints Noticing counts |

The desktop app keeps its own files (window, preferences, plugin grants, the sign-ins of remote servers) in Electron's user data folder, which Settings > Application > Engine opens. An app built from a solution has a home of its own, such as `~/.harness-studio`.

### Backing up

1. Stop the server or quit the app, so that the copy is consistent.
2. Copy the home. `tmp/` can be left out. Add any folder outside the home that sessions work in, and the Docker `data` volume if you run the compose service.
3. Keep the sealing key apart from the backup. That is `HARNESS_SECRET_KEY`, or `data/secret.key`, which is inside the home, so take it out of the copy and store it elsewhere. Without it, sealed values cannot be read. With it, whoever holds the backup can read them.

External vault backends keep their values in that system, so back those up there.

### Moving it

In the desktop app, use Settings > Application > Location. It copies the home, verifies the copy, rewrites the paths stored in each session, and records the new place in `~/.harness-location`, which the server and the command line read too. The old copy stays until you remove it there.

There is no command for this on a server. Copying by hand and setting `HARNESS_HOME` works, but it does not rewrite the paths stored in each session's `meta.json`, so keep the path the same if you can. To move one conversation, export it and import it on the other side ([Durability, checkpoints, trace](../../README.md#durability-checkpoints-trace)).

## Keys and providers

### Adding a key

There are three ways, and a key in the environment wins over one stored through the app or API:

- **The environment**, set before the server starts.
- **A `.env` file** in the folder the server runs from. `npm start`, `npm run cli` and the kit's `harness` commands read it. A variable already set wins over the file.
- **Settings > Models & providers** in the desktop app, or `PUT /api/providers/:id` for an administrator. The key is stored as a Key Vault entry named `provider-<id>-key`, applies to the next request with no restart, and is never returned. The same page tests a key (`POST /api/providers/:id/test`).

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` or `GW_ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Moonshot AI (Kimi) | `MOONSHOT_API_KEY` |
| Z.ai (GLM) | `ZAI_API_KEY` |

A model whose provider has no key is greyed out. The current models are in [the reference](07-generated-reference.md#models). OpenAI-compatible servers are listed in `HARNESS_MODELS_JSON` or `HARNESS_MODELS_FILE`, and each entry names the variable that holds its key. A malformed entry stops the server at start. The fields are in [Models and providers](../../README.md#models-and-providers).

### What enables what

| You set | It enables |
|---|---|
| A provider's key | That provider's models |
| Keys of two providers | Checks that need a model of another company: the claim ledger, recomputed data answers, a verifier at high stakes |
| A search key or URL | `web_search` (below) |
| `HARNESS_GITHUB_TOKEN` | `publish_branch`, cloning private repositories, and DevOps CI calls when the vault has no `github-token` |
| `HARNESS_SANDBOX_CREDENTIALS` | API access from an allowlist sandbox, with the real key kept outside it |
| Key Vault entries named `int-*` | The Integrations plugin ([how to connect each service](../../README.md#how-to-connect-each-service)) |
| Key Vault entries named `ops-*` | Operations' hosts, monitoring and clusters |

### Search backends

`web_search` uses the first backend it finds, in this order: Brave (`BRAVE_API_KEY`), Tavily (`TAVILY_API_KEY`), Exa (`EXA_API_KEY`), SearXNG (`HARNESS_SEARXNG_URL`), DeepSeek's search, then the search built into the Anthropic or OpenAI API.

- **Only the environment counts for these.** A DeepSeek, Anthropic or OpenAI key stored through the app does not turn on their search.
- **Kimi's web tools** are a switch in the Moonshot provider's settings. While it is on, Kimi's search goes first.
- `HARNESS_SEARCH` names one backend, or `off`. A named backend with no key stops the server at start.
- Plugins can add backends.
- The server prints which one it uses. Each search's cost is added to the session.

### The Key Vault

The vault holds named secrets that sessions use without the model seeing them. An agent names an entry, and the server puts the value where it is needed. It has three scopes: operator, user and session. An operator entry reaches only administrators unless its `allow` list names members, accounts or a plugin. Every use, change and refusal goes to `<data>/vault/audit.jsonl`.

Values are sealed under `HARNESS_SECRET_KEY`, else a generated `<data>/secret.key`. `HARNESS_VAULT_BACKENDS` adds HashiCorp Vault, Azure Key Vault or AWS Secrets Manager. `HARNESS_VAULT` limits the vault to administrators, or turns it off. The rest is in [Key Vault](../../README.md#key-vault).

## Configuration

### Where settings come from

**The environment** sets the server's options. **The operator's settings file** (`HARNESS_SETTINGS`, JSON) holds permission rules, hooks of every kind, and limits. Its values override the same limits set in the environment, and the command line's flags. A file that is named but cannot be read stops the server, so it never runs without its deny rules.

Rules and limits then come in this order:

1. the operator's settings file and plugin manifests;
2. the person's own settings (`GET` and `PUT /api/me/settings`), which carry rules and limits, never hooks;
3. the project's `.harness/settings.json`, then the personal `.harness/settings.local.json`;
4. "always allow" clicks in a session.

Rules add up and are decided deny, then ask, then allow, so a deny at any level wins. Limits come from the operator, and a person can only lower them. A repository's allow rules and hooks count only where project content is trusted: in a sandbox, or with `HARNESS_TRUST_PROJECT=1`.

`GET /api/settings/effective` shows each setting in force and where it came from. [Permissions](../../README.md#permissions) has the detail. Instruction files come in tiers of their own ([Instructions, settings and output styles](../../README.md#instructions-settings-and-output-styles)).

### The most important settings

| Purpose | Settings |
|---|---|
| Where it listens | `HARNESS_HOST`, `HARNESS_PORT`, `HARNESS_TOKEN`, `HARNESS_PUBLIC_URL` |
| Where data lives | `HARNESS_HOME`, `HARNESS_DATA`, `HARNESS_LOCAL_ROOTS`, `HARNESS_SECRET_KEY` |
| Models | `HARNESS_MODELS_JSON`, `HARNESS_MODELS_FILE`, `HARNESS_SUBAGENT_MODEL`, `HARNESS_REVIEW_MODEL`, `HARNESS_AUTO_MODEL`, `HARNESS_DELEGATION_MODELS`, `HARNESS_PRICING_JSON` |
| Limits on an agent | `HARNESS_MAX_STEPS`, `HARNESS_MAX_COST_USD`, `HARNESS_MAX_TURN_MINUTES`, `HARNESS_SUBAGENT_DEPTH`, `HARNESS_SUBAGENTS_PARALLEL` |
| Limits on an account | `HARNESS_USER_DAILY_USD`, `HARNESS_USER_MAX_RUNNING`, `HARNESS_USER_MAX_SANDBOXES`, `HARNESS_RATE_LIMIT`, `HARNESS_MESSAGE_RATE_LIMIT` |
| Rules and instructions | `HARNESS_SETTINGS`, `HARNESS_INSTRUCTIONS`, `HARNESS_TRUST_PROJECT`, `HARNESS_GATES_ON_STOP` |
| Sandboxes | `HARNESS_SANDBOX_IMAGE`, `HARNESS_SANDBOX_IMAGES`, `HARNESS_SANDBOX_ALLOW_HOSTS`, `HARNESS_SANDBOX_RUNTIME`, `HARNESS_LOCAL_SANDBOX`, `HARNESS_SHELL` |
| Unattended work | `HARNESS_AUTO_RESUME`, `HARNESS_BACKGROUND_WAKE`, `HARNESS_BACKGROUND_MAX_WAKES`, `HARNESS_MAX_SCHEDULES` |
| Plugins | `HARNESS_PLUGINS`, `HARNESS_PLUGIN_KEYS`, `HARNESS_PLUGIN_CATALOGUE`, `HARNESS_PLUGIN_NETWORK`, `HARNESS_REQUIRED_PLUGINS`, `HARNESS_SOLUTIONS` |
| Publishing | `HARNESS_GITHUB_TOKEN`, `HARNESS_PUBLISH_REPOS`, `HARNESS_PUBLISH_PREFIX`, `HARNESS_PUBLISH_READY` |
| Safety switches | `HARNESS_TAINT_GUARD`, `HARNESS_INJECTION_SCAN`, `HARNESS_DESTINATION_FLOOR`, `HARNESS_SHELL_WRITE_GUARD` |
| Watching | `HARNESS_OTEL_ENDPOINT`, `HARNESS_OTEL_HEADERS`, `HARNESS_RECORD` |

Lists of folders, such as `HARNESS_PLUGINS` and `HARNESS_LOCAL_ROOTS`, use the operating system's path separator: `;` on Windows, `:` elsewhere.

The full list is in [the reference](07-generated-reference.md#settings), and the README's [Configuration](../../README.md#configuration) table says what each one does.

## Controlling cost

### Spend caps

| Cap | Where to set it | What it does |
|---|---|---|
| Per conversation | `HARNESS_MAX_COST_USD` or `maxCostUsd`; `--max-cost` on the command line; Settings > Application in the desktop app | On by default. `0` is no limit. The turn ends with the reason `budget`. |
| Per account, per day | `HARNESS_USER_DAILY_USD` | Refuses new messages and stops a running turn at its next step. Resets at midnight UTC. |
| Per scheduled run | `maxCostUsd` on the schedule | Stops that run |
| Per custom agent or team | The agent's spend limit | Stops that agent's run. For a team, it covers the whole team. |
| Work on other models | `delegation.maxCostUsd` in `/api/me/settings` | Counted apart from the session's own model |
| Per swarm run | `swarm.maxUsd`, or `HARNESS_SWARM_USD` | Stops the run's agents |
| Time | `HARNESS_MAX_TURN_MINUTES` or `--max-minutes` | The turn ends with the reason `time`. Off by default. |

A cap is checked between steps, so a run can pass it by the step in progress. A person can only lower the operator's limits. In the desktop app you are the operator, and a new limit applies after the engine restarts. After a cap stops a conversation, raise it and say "continue".

Prices come from [the reference](07-generated-reference.md#models), and `HARNESS_PRICING_JSON` overrides them. An OpenAI-compatible model's `prices` default to 0, so caps do not see its spend until you set them.

### What costs money

- Model calls: the main agent, sub-agents, workflow steps, compaction summaries.
- Web searches with a paid backend.
- `verify_claims` and other checks by a second model.
- Small helper calls, each charged to the session: auto mode's checker, `HARNESS_INJECTION_SCAN`, progress reviews, `prompt` hooks, and a watch's "only when" filter.
- Whatever your own tools and MCP services charge.

These make no model call: most quality gates, the check part of a watch, `monitor`, Noticing, and Operations' watch loop.

### How caching helps

Providers charge much less for input they have cached, and each step sends the whole context again. So the harness keeps the start of the prompt the same from step to step: a fixed system prompt, sorted tools, and a history that only grows. Reminders are added at the end. The [Token economy](../../README.md#token-economy-minimum-input-maximum-output) table has each lever.

What breaks a cache, and so costs more on the next request:

- a plugin's tools loading for the first time in a session;
- old results being cleared, or a compaction;
- a gap between requests longer than the cache lasts;
- changing the model.

Anthropic's prefix can be kept for an hour (`HARNESS_PREFIX_TTL`), and Kimi's too (`HARNESS_MOONSHOT_CACHE_TTL`). Writes cost more at that tier, so it pays when requests are far apart.

### What to read

- **The session's cost and tokens** are in the app, in `meta.json` (`cost`, `usage`, and `byModel` for each model), and in `--output json` (`cost`, `tokens`, `cacheHit`).
- **The trace** has one line per model call: uncached, cache-read, cache-write and output tokens, cost, stop reason and retries. Open it from the session in the browser interface, or at `GET /api/sessions/:id/trace`.
- **Cache misses** are named by cause in the trace (`type: "cache"`) and counted in the session's `cacheMisses`: `tools`, `system`, `model`, `mask`, `compaction`, `edit`, `ttl` or `provider`. A low `cacheHit` with many `tools` or `mask` misses is worth a look.
- **The Agents panel** shows the mix of models by cost for a run.
- **`GET /api/schedules/stats`** shows each schedule's runs, findings and cost over recent days.

### Budgets for unattended work

Nobody is watching, so set the limits first:

1. Give each schedule a `maxCostUsd`.
2. Set `HARNESS_USER_DAILY_USD`, so that a bad night has a ceiling. Scheduled, triggered and plugin-started runs respect it.
3. Keep `HARNESS_MAX_COST_USD` above 0.
4. Leave `HARNESS_BACKGROUND_MAX_WAKES` at a small number.
5. Put cheap work on a cheap model: `HARNESS_SUBAGENT_MODEL` and `HARNESS_REVIEW_MODEL`.
6. Prefer a watch to a schedule when work depends on a change. A quiet watch makes no model call.

## Unattended work

### What a run may do with nobody there

A session's permission mode decides what happens when a step would need a yes. [Permissions](../../README.md#permissions) has the full table.

| Schedule dialog | Mode | What happens |
|---|---|---|
| Never stop to ask | `dontAsk` | What would be asked is refused, so a run never hangs. Allow rules still let work through. |
| A checker decides | `auto` | A small model checks each call. What it does not clearly allow waits in the Inbox. |
| Edits are fine | `acceptEdits` | Edits run; the rest waits in the Inbox. |
| Ask me for everything | `default` | Everything that would be asked waits in the Inbox. |

A request that waits in the Inbox gets the safe answer (no) after a time you set (`askTimeoutMinutes`), and the run goes on. A schedule made through the API with a new session uses `dontAsk` unless it says otherwise. A workflow's approval steps wait in the Inbox too.

A run in `dontAsk` needs the operator's allow rules for what it must do. A refused step is recorded on the run, and the update is a warning, even if the agent reports nothing.

### Schedules and watches

Schedules run a prompt or a workflow on a time or a watch, in the same conversation or a new one each time. Every run goes through the same permissions and spend limits as a typed message. A busy session is skipped. Each run is recorded with how it ended, its cost and a line of what it said.

- **A missed run** runs once when the server comes back, or is skipped if the schedule says `misfire: skip`.
- **A watch** keeps what it saw across restarts, so a change made while the server was down runs at the next check.
- **In the desktop app**, schedules run only while the app is open. Closing the window quits it unless Settings > Application > Keep running in the tray is on. After the computer restarts they stop until the app opens again, unless Start at login is on.
- **On a server that has to be reliable**, use a machine that stays on.

### Restarts

If the server stops in the middle of a turn, each unfinished tool call gets a result saying so, and the session is idle after the restart.

By default it stays idle, and you send "continue", or press **Resume** on a workflow run.

With `HARNESS_AUTO_RESUME=1`, the server carries on with nobody there. An interrupted turn starts again, and an interrupted workflow run picks up at its step. If a session had several runs, one goes on and the others wait in its runs list. The desktop app's engine takes this variable from the app's own environment.

What the server keeps in memory is lost in a restart: the task list and kept sub-agents. Background shells keep running, and their logs stay in `.harness/bg/`.

### Outages

A model call retries by itself for about two minutes. Without `HARNESS_AUTO_RESUME=1`, a longer outage (no network, the provider down) ends the turn, and it stays ended.

With `HARNESS_AUTO_RESUME=1`, a turn or workflow run lost that way tries again: first after about a minute, then at longer gaps, and in the end every 30 minutes. This holds across a restart. The session shows when the next try is.

### What stops it going on for ever

Every automatic start counts as a wake: a background result, a resume, each outage retry. A session stops waking after `HARNESS_BACKGROUND_MAX_WAKES` wakes without a message from a person, or at the account's caps. A server in a crash loop therefore cannot spend without end. When it stops, it says why, and your next message carries on. `HARNESS_BACKGROUND_WAKE=0` turns off waking for background results.

### A laptop sleeping

A closed lid stops everything. While a machine sleeps there are no model calls, no schedules, no watches and no retries. Work that was in flight meets a dropped connection when the machine wakes, and is treated as an outage: it ends, or with `HARNESS_AUTO_RESUME=1` tries again. A schedule that came due during the sleep runs when the machine wakes, unless it says `misfire: skip`.

Settings > Application > Prevent sleep while working keeps the app from being suspended while an agent works. It does not change what your power settings do when the lid closes. For work that has to go on through the night, run a server on a machine that does not sleep.

## Sharing a server

### Accounts

Without accounts, the server is single-user: whoever holds `HARNESS_TOKEN`. To add accounts:

```bash
npm run users -- add alice            # a member; add --admin for an administrator
npm run users -- list
npm run users -- rotate <id>          # also: remove, disable, enable
```

Tokens are shown once and stored hashed. The kit's form is `harness users`.

- **Members** see only their own sessions, companions and memory. They cannot run commands on the server itself or install plugins.
- **Administrators** see everything and manage accounts.

### Single sign-on

With an OpenID Connect provider, people sign in with their work account. Set `HARNESS_PUBLIC_URL`, `HARNESS_OIDC_ISSUER`, `HARNESS_OIDC_CLIENT_ID`, `HARNESS_OIDC_CLIENT_SECRET` (a public client has none), and `HARNESS_OIDC_ALLOWED_DOMAINS` or `HARNESS_OIDC_ALLOWED_EMAILS`. With neither allow list set, nobody can sign in. `HARNESS_OIDC_ADMINS` names administrators. `HARNESS_OIDC_ONLY=1` turns off personal tokens; the operator token still works as the way in if the provider is down. The server prints the redirect URI to register. Each provider's steps are in [Single sign-on](../../README.md#single-sign-on).

### Limits

Every request and message is rate-limited per person (`HARNESS_RATE_LIMIT`, `HARNESS_MESSAGE_RATE_LIMIT`). `HARNESS_USER_DAILY_USD` caps daily spend. `HARNESS_USER_MAX_RUNNING` caps the sessions one account has working at once, and `HARNESS_USER_MAX_SANDBOXES` those with a container. Over the running limit, a request gets a 429 saying why. A scheduled run that would go over is skipped, and its last result says so. The operator's own token is not limited. See [Shared servers](../../README.md#shared-servers-accounts-and-limits).

### Several servers on one data folder

Two or more servers can share one data folder behind a load balancer. On each one, set `HARNESS_CLUSTER=1`, the same `HARNESS_DATA`, `HARNESS_CLUSTER_SECRET` and `HARNESS_PUBLIC_URL`, and its own `HARNESS_NODE_ID` and `HARNESS_NODE_URL`.

- One server drives a session at a time, through a lease file. A crashed server's sessions are taken over after the lease time.
- Other servers pass requests on to the holder.
- Use sticky sessions at the load balancer.
- Keep clocks in sync.
- The shared disk must support atomic create and rename.
- Each server needs the same configuration, keys, plugins and sandbox images.

See [Running several servers](../../README.md#running-several-servers).

### Exposing it

The server listens on 127.0.0.1 by default and serves plain HTTP. Before anyone reaches it from elsewhere:

1. Set `HARNESS_TOKEN`, and make accounts.
2. Put TLS in front of it, and set `HARNESS_PUBLIC_URL`.
3. Set `HARNESS_HOST` to the address to listen on.
4. Set the spend caps.
5. Require signed plugins with `HARNESS_PLUGIN_KEYS`.

Read [the security model](05-security-model.md) first.

## Plugins and solutions in operation

### Installing

Only administrators install plugins, because plugin code runs in the server.

| How | What it takes |
|---|---|
| Plugins > Install from a file, or `POST /api/plugins/import` | A plugin's `.tgz` or a whole solution's. Signed by a trusted key, or unsigned only where the server is the person's own computer and has no trust list. |
| Plugins > Catalogue, or `POST /api/plugins/install` | `HARNESS_PLUGIN_CATALOGUE` (a folder, or the https URL of an `index.json`) and a trust list |
| `HARNESS_PLUGINS` | Folders the operator names. These are trusted and always load. |
| Plugins > Developer > Load a plugin folder | For working on a plugin. It is reviewed first, and reloads on save. |

Solutions are offered under Plugins > Catalogue > Solutions when they ship with the server, and installed one by one; installing one installs what it requires. A new server starts with the core only, or with `HARNESS_SOLUTIONS` (`all`, `none` or names) on its first start. A server that was already in use keeps every solution.

### Updating and rolling back

**Check for updates** finds newer versions (`GET /api/plugins/updates`). **Update** installs one and keeps the version before. **Roll back** returns to a kept version (`POST /api/plugins/<name>/rollback`); the last few are kept. A plugin says which harness versions it runs on (`engines.harness`). On any other version it is not loaded, and the app says what to do.

### Switching off and removing

Switching a plugin off is safe at any time, with sessions and runs open. Its data, settings and schedules are kept. A workflow run that needs it waits at that step and carries on when it is switched back on. `HARNESS_REQUIRED_PLUGINS` names plugins that cannot be switched off. Removing a catalogue plugin keeps its data folder unless you ask otherwise. See [Plugins](../../README.md#plugins).

### Trust lists

| Setting | What it does |
|---|---|
| `HARNESS_PLUGIN_KEYS` | A public key, or a folder of them. Every plugin not shipped with the harness must be signed by one, or it is refused. |
| `HARNESS_PUBLISHER_KEYS`, and `trustedKeys` in a product profile | Official publishers. Their plugins show as Official and Verified. Nothing else is refused because of them. |
| `HARNESS_OFFICIAL_KEYS` | Key ids counted as official |

`npm run plugin -- keygen`, `sign` and `verify` make keys and signatures. With a trust list set, a changed, added or removed file, an unknown key or a symbolic link means the plugin is refused.

Declared permissions limit a plugin's network, secrets, vault entries, routes and sessions. `HARNESS_PLUGIN_NETWORK` and `HARNESS_PLUGIN_SESSION_OWNERS` widen them, and only the operator can do that. An administrator gets route tokens from `POST /api/plugin-routes`.

## Watching it

### Logs

The server writes to its own output. The desktop app keeps the engine's log in `<home>/logs/engine.log`, and shows it at Settings > Application > Engine > Show log.

Other records, kept outside every workspace:

- `<data>/vault/audit.jsonl`: every use of a secret.
- `<data>/plugin-actions.jsonl`: what plugins did in sessions.
- `<data>/plugin-data/aiops/audit.jsonl` and `<data>/plugin-data/integrations/audit.jsonl`: actions on systems, and chat decisions.

`GET /api/health` answers without signing in, for a load balancer or a monitor.

### The trace

Every model call and tool call is a line in the session's `trace.jsonl`, at `GET /api/sessions/:id/trace`. [Controlling cost](#what-to-read) says what to read in it.

### Run records

With `"record": true` in the settings, or `HARNESS_RECORD=on`, a session's requests, calls, results, answers and decisions are hashed into a chain. `GET /api/sessions/:id/record` exports a signed bundle, with `?view=verify` and `?view=replay` (the steps as they happened; nothing runs again). `GET /api/record-key` gives the public key. In the app, the Run record panel sits beside a conversation.

### OpenTelemetry

With `HARNESS_OTEL_ENDPOINT` (and `HARNESS_OTEL_HEADERS="k=v,k=v"`), spans also go out as OTLP/HTTP JSON, one trace per session. A failed export is logged and dropped. See [Observability](../../README.md#observability).

### Live events

`GET /api/events` is one stream of what you may see: sessions, approvals, schedules, plugins and notices. See [HTTP API for desktop clients](../../README.md#http-api-for-desktop-clients).

### Evaluations

`npm run eval` runs task packs on chosen models and judges them with hidden checks. It writes `report.md` and `results.json`, and each report names the harness that produced it. Run it after a change to models or settings. It spends model money. See [Evaluations](../../README.md#evaluations).

## Releasing your own build

### The order of work

1. Raise the version in `package.json`, `apps/desktop/package.json`, `packages/*/package.json` and `plugins/package.json`, and add a section to `CHANGELOG.md`.
2. Run `npm run docs`.
3. Commit. The kit builds only from a clean tree.
4. Tag it: `git tag -a v<version>`. A solution released on its own is tagged with its name, as in `studio-v<version>`.
5. Build and check as below.

### The kit

```bash
npm run kit
node scripts/check-kit.mjs release/kit/harness-kit-<version>.tgz
```

`npm run kit` writes to `release/kit`: the folder, its `.tgz` and the archive's signature. It stops rather than ship any of these:

- a dirty tree, untracked files included;
- no publisher key;
- a high or critical advisory in what ships, or `npm audit` giving no report;
- an environment file, a key file, a private key, or any value from the builder's `.env`;
- a symbolic link.

`--dirty`, `--unsigned` and `--no-audit` loosen these, and each one is recorded in the kit's `BUILD.json`.

`scripts/check-kit.mjs` meets the archive the way a stranger would. It unpacks it, tampers with it in each way, makes an app and a plugin, and starts the server. `--live <model>` also asks a real model, which spends money and needs a key (`node --env-file=.env scripts/check-kit.mjs ... --live <model>`). A kit is built for one platform, because DuckDB and esbuild include native binaries.

### The desktop app

```bash
npm run desktop:test                                # end to end, against a scripted engine
npm run desktop:build                               # apps/desktop/release
npm run desktop:build -- --solution studio          # a solution as its own app: apps/desktop/release-studio
```

`--dir-only` (through `npm run build:app -w @harness/desktop`) skips the installer. The build also writes every plugin as a bundle, with an index, in the release folder's `plugins/`. The product profile (`products/harness.json`, or `HARNESS_PRODUCT`) gives the name, app id, icon and trusted keys. The installer has no code-signing certificate. A solution's single file comes from `npm run bundle -w @harness/<solution>`.

Published dashboards need the viewer bundle, which is built apart from all of these: `node apps/desktop/scripts/build-viewer.mjs`.

### The publisher key

The kit and bundles are signed with an Ed25519 private key: `HARNESS_PUBLISHER_KEY` (a file), else the first `.pem` in `~/.harness-publisher`. Without one, the kit build stops, and the desktop build writes unsigned bundles. The key never goes in the repository. Only its public half does, under `products/keys`, and that is what the kit and apps ship.

To publish with a key of your own, make one with `npm run plugin -- keygen <name>` and put the public half in `products/keys`, because `harness verify` trusts the kit's `keys/` folder, which is copied from there. For the desktop app, also add it to `trustedKeys` in the product profile.

### Updating Electron and dependencies

1. Run `npm audit --omit=dev` to see the advisories in what ships.
2. Update what needs it. Do not use `npm audit fix --omit=dev`: it removes dev dependencies from `node_modules`.
3. Electron is pinned to an exact version in `apps/desktop/package.json`. Change it there, and run `npm install`.
4. Run `npm test`, `npm run desktop:test` and a desktop build.
5. Run `npm run docs`, because the reference names the Electron version.

The desktop build sets Electron's fuses in `apps/desktop/scripts/package.mjs`. `RunAsNode` stays on, because commands and `run_script` use the app's binary as their Node.

## Keeping these docs current

- `npm run docs` regenerates [the reference](07-generated-reference.md) from the code. Do not edit that file by hand.
- `npm run docs -- --check` says whether it is current.
- `test/docs.test.ts` fails on a stale reference or a broken link.
- Update a guide in the same change as the behaviour it describes.

## Troubleshooting

**1. A model is greyed out, or listed with "(no key)".** The server has no key for its provider. Add one ([Keys and providers](#keys-and-providers)), and test it in Settings > Models & providers. A key in the environment needs a restart; one set through the app does not.

**2. Commands run in PowerShell, or a gate says "the quality gates need bash".** Git Bash was not found on Windows. Install Git for Windows and restart the harness, or set `HARNESS_SHELL` to the path of a `bash.exe`. The harness never uses `C:\Windows\System32\bash.exe`.

**3. "Docker is not available", or Docker sessions do not start.** Docker is not running, or the sandbox image was never built. Start Docker and run `npm run sandbox:image`. Otherwise pick a server folder or a companion for that session.

**4. A conversation stopped with a message starting "Stopped:".** It reached a spend limit (end reason `budget`), or its account's daily limit. Raise the limit and say "continue". The daily limit resets at midnight UTC. A stop for `time` is `HARNESS_MAX_TURN_MINUTES`. A stop at the step budget comes with the progress review's reasons; read them before you go on.

**5. A schedule did not run.** The app was closed, the computer was asleep or off, the session was busy, or a limit skipped it. Open Scheduled and read the schedule's last result. In the desktop app, turn on Keep running in the tray and Start at login. For work that must run on time, use a server that stays on.

**6. A scheduled run was refused the steps it needed.** A `dontAsk` run refuses what it would otherwise ask. Give the schedule a checker or the Inbox, or add allow rules to `HARNESS_SETTINGS`. A key from the vault needs its own rule, such as `vault(name)`. After untrusted content, only the operator's rules count.

**7. Work did not carry on after a restart or an outage.** `HARNESS_AUTO_RESUME` is off, or the session reached `HARNESS_BACKGROUND_MAX_WAKES` or an account cap. With it on, the session says why, in a notice starting "Not carrying on". Send "continue", or resume the run from the runs list.

**8. The server stops at start.** The message names the cause. The usual ones are:

- `HARNESS_SETTINGS` names a file that cannot be read, or holds an unknown hook event;
- `HARNESS_MODELS_JSON` has a malformed entry;
- `HARNESS_SEARCH` names a backend with no key;
- `HARNESS_SANDBOX_RUNTIME` names a runtime that Docker does not have;
- `HARNESS_PORT` is already in use.

From the kit, `harness start` also refuses a kit that fails its signature check. The kit must also sit outside any `node_modules` folder.

**9. "cannot decrypt: the server key ... is not the one it was sealed with".** The vault or stored provider keys were sealed under another key. This follows a restore or a move without `secret.key`, or a changed `HARNESS_SECRET_KEY`. Put the original key back. Without it, set those values again.

**10. A plugin will not load or install.** Read its entry on the Plugins page. "is not for this harness" means its `engines.harness` range excludes this version: update it. "This server has no trust list" means the bundle must be signed by a key in `HARNESS_PLUGIN_KEYS`, or added on your own computer. A catalogue install always needs that list. With a trust list set, a changed file or an unknown key is refused.

For anything else, start with the server's output, or Settings > Application > Engine > Show log, then the session's trace.
