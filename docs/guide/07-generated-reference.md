# Reference generated from the code

This file is written by `npm run docs`. Do not edit it by hand: `test/docs.test.ts` fails when it differs from the code.

Version 0.2.7. Node >=22.18. Electron 44.10.2.

## Models

Prices are USD per million tokens. A model needs its provider's key to be available.

| Model | Provider | Context | Max output | Input | Cached input | Output |
|---|---|---|---|---|---|---|
| `claude-fable-5-1` | anthropic | 1000000 | 128000 | $10 | $0.25 | $50 |
| `claude-haiku-5-5` | anthropic | 1000000 | 128000 | $0.1 | $0.01 | $0.5 |
| `claude-opus-5-5` | anthropic | 1000000 | 128000 | $4 | $0.2 | $20 |
| `claude-sonnet-5-5` | anthropic | 1000000 | 128000 | $2 | $0.2 | $10 |
| `deepseek-flash` | deepseek | 1048576 | 256000 | $0.15 | $0.003 | $0.6 |
| `deepseek-v4-pro` | deepseek | 1048576 | 256000 | $0.66 | $0.022 | $1.98 |
| `glm-5.3` | zai | 1000000 | 131072 | $1.4 | $0.26 | $4.4 |
| `glm-5.3-flash` | zai | 1000000 | 131072 | $0.15 | $0.03 | $0.5 |
| `glm-5.3-flashx` | zai | 1000000 | 131072 | $0.37 | $0.075 | $1.25 |
| `gpt-6-luna` | openai | 272000 | 128000 | $0.1 | $0.01 | $0.5 |
| `grok-4.3` | xai | 1000000 | 128000 | $1.25 | $0.2 | $2.5 |
| `grok-4.7` | xai | 500000 | 128000 | $2 | $0.5 | $6 |
| `grok-build-0.1` | xai | 256000 | 128000 | $1 | $0.2 | $2 |
| `kimi-k2.6` | moonshot | 262144 | 64000 | $0.95 | $0.16 | $4 |
| `kimi-k2.7-code` | moonshot | 262144 | 64000 | $0.95 | $0.19 | $4 |
| `kimi-k3` | moonshot | 1048576 | 131072 | $3 | $0.3 | $15 |
| `kimi-k3.1-pro` | moonshot | 1048576 | 131072 | $2 | $0.2 | $10 |
| `kimi-k3.1-pro-highspeed` | moonshot | 1048576 | 131072 | $4 | $0.2 | $20 |

## Built-in tools

`kind` is what the permission system judges a call by.

| Tool | Kind | What it does |
|---|---|---|
| `ask_user` | meta | Ask the user a decision only they can make. |
| `bash` | exec | Run a shell command in the workspace and return its exit code and output. |
| `edit` | edit | Replace an exact string in a file. |
| `enter_plan_mode` | meta | Switch to plan mode before a task that should be researched and agreed before anything changes (large, ambiguous or risky work). |
| `exit_plan_mode` | meta | In plan mode only: present your implementation plan (markdown) for the user to approve. |
| `glob` | read | Find files by glob pattern (e.g. |
| `grep` | read | Search file contents with a regular expression (ripgrep syntax). |
| `memory` | meta | Your memory across sessions. |
| `notify_user` | meta | Tell the user something now, even when they are not watching the session (it also reaches any notification channel the operator set up). |
| `publish_branch` | external | Publish the work as a git branch and open a pull request for it. |
| `read` | read | Read a text file. Returns numbered lines (` N\tline`). |
| `run_script` | read | Run a short JavaScript (async function body) that calls tools and returns only what you need, instead of making many tool calls whose full output fills the context. |
| `schedule` | external | Run a prompt or workflow later. |
| `todo_write` | meta | A task list the user sees in the chat. |
| `vault` | read | The key vault: named secrets (passwords, tokens, keys, connection strings) you use without seeing them. |
| `web_fetch` | network | Fetch a public web page or file over http(s) and return its readable text (HTML without menus and footers. |
| `web_search` | network | Search the web. Returns titles, URLs and short snippets. |
| `workflow` | meta | Run one of this session's workflows now - a fixed graph of agent steps, quality gates and approvals (e.g. |
| `write` | edit | Create a file or overwrite one completely. |

## Plugins that ship with the core

| Plugin | Version | What it adds |
|---|---|---|
| `computer` | 1.0.0 | Computer use: operate a desktop through screenshots, mouse and keyboard (the computer tool), for GUI apps and pages that need a real browser. |
| `data-answers` | 1.0.0 | Answers from your own database that you can trace. |
| `documents` | 1.0.0 | Decks and documents a professional would present. |
| `forecasting` | 1.0.0 | A forecasting ledger. |
| `integrations` | 1.0.0 | Two-way chat (Slack, Microsoft Teams), paging (PagerDuty, Opsgenie) and ticketing (Jira Cloud, ServiceNow). |
| `investigations` | 1.0.0 | Investigations as co-pilot work. |
| `plugin-dev` | 1.0.0 | Build plugins for the harness and its desktop app. |
| `quality-gates` | 1.0.0 | Stack-aware verifiers. |
| `research` | 1.2.0 | Research with sources you can check. |
| `security-review` | 1.0.0 | Security review of your own code where every finding is proven. |
| `visual` | 1.0.0 | Look at what was made. |

Solutions, each with its own version and installed separately: `devops`, `engineering`, `operations`, `studio`.

## Agent types

| Agent | What it is for |
|---|---|
| `counter-evidence` | Looks for evidence against a research report's main conclusions - other searches, other sources, newer data - and records what it finds, for the writer to address. |
| `data-analyst` | Answers a question from the person's own database with read-only SQL, every number traced to the query that produced it. |
| `data-checker` | Recomputes a data answer independently from the question and the definitions alone. |
| `deck-designer` | Builds a presentation (.pptx) from an outline with a build script, then renders every slide and fixes what it sees until each one is clean. |
| `document-author` | Writes a professional document (.docx with PDF, or Markdown) from an outline. |
| `fact-checker` | Independent check of a research report - every claim against the page it cites, and the answer against the question. |
| `forecaster` | Forecasts one yes/no question about the future - outside view first, then the latest evidence - and gives a probability. |
| `investigator` | Works an investigation inside the person's mandate - a coverage checklist, evidence read from the sources the mandate allows, leads ranked in the queue - and leaves every identification and decision to the person. |
| `outline-writer` | Turns a brief into a storyline and a page-by-page outline (decks) or a section outline (documents), with the key message and evidence for each part. |
| `research-lead` | Plans a research question - restates it, splits it into sub-questions with the evidence each needs and where to look. |
| `research-writer` | Writes a research report from evidence notes, with numbered citations that hold up to a word-for-word check. |
| `researcher` | Finds and reads sources for assigned research questions and writes evidence notes - claims with verbatim quotes, URLs and dates. |
| `security-hunter` | Reviews one file (or a small group) of the person's own code for a security flaw, and proves each one with a reproducer the harness runs. |
| `security-lead` | Runs a security review of the person's own code inside their mandate - ranks the files by risk, reviews them (or sends a hunter per file group where it can start agents), and proves each flaw with a reproducer the harnes |
| `security-reporter` | Writes the security review's report from the findings the harness confirmed. |
| `visual-reviewer` | Independent reviewer of a deck or document as the audience sees it - renders every page and judges message, design and correctness. |

## Workflows

| Workflow | What it does |
|---|---|
| `data-answer` | A question answered from the person's own database. |
| `deep-research` | From a question to a cited report. |
| `investigation` | An investigation inside the person's mandate. |
| `make-deck` | From a brief to a presentation-ready deck. |
| `security-review` | A security review of the person's own code inside their mandate. |
| `write-document` | From a brief to a finished document. |

## Quality gates

| Gate | What it checks |
|---|---|
| `citations` | A research report cites only pages that were read, and its quotes and figures match them |
| `claims` | Every cited sentence of research/report.md is supported by the passage it cites, as judged by a model of another family (the claim ledger) |
| `conflict-markers` | No unresolved merge-conflict markers |
| `coverage` | Every item of investigation/checklist.md is checked ([x]) or marked N/A with a reason |
| `documents-render` | Every document in the workspace (docx, pptx, xlsx, odt, odp, pdf) opens and renders, and no slide has text cut off at its edge. |
| `findings-confirmed` | security/findings.md calls a finding CONFIRMED (or FIXED) only when the harness ran its reproducer and it fired (or no longer fires) |
| `go-test` | go vet + go test |
| `java-test` | Maven or Gradle tests |
| `large-files` | No files over 5 MB outside build output (advisory) |
| `node-build` | npm run build |
| `node-lint` | npm run lint |
| `node-test` | npm test |
| `node-typecheck` | TypeScript type check |
| `playtest` | The scenarios in playtest.json pass. |
| `provenance` | Every number in data/answer.md comes from a query cell of this session (or is marked derived) |
| `python-lint` | ruff check |
| `python-test` | pytest (or unittest) |
| `recompute` | data/answer.md's figures agree with an independent recomputation on another model family |
| `rust-test` | cargo test |
| `secrets` | No private keys or credentials in source files |
| `todo-markers` | TODO/FIXME left in source (advisory) |
| `web-console` | The workspace page (index.html) opens offline with no uncaught errors, console errors or missing files, and draws something. |

## Hook events

`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`, `InstructionsLoaded`, `ConfigChange`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `TaskCreated`, `TaskCompleted`

## The plugin API

What a plugin's `setup(api)` is given. Types: `@harness/plugin-sdk`.

`pluginName`, `pluginDir`, `tier`, `harnessVersion`, `dataDir`, `registerTool`, `workspacePath`, `registerModel`, `registerProvider`, `registerAgent`, `registerSkills`, `registerMcpServer`, `registerGate`, `registerSearchBackend`, `registerWorkflow`, `on`, `log`, `signal`, `secret`, `fetch`, `registerVaultRotation`, `registerRoute`, `events`, `sessions`, `changes`, `lease`, `vault`, `method`, `user`, `path`, `auth`, `handler`, `title`, `owner`, `model`, `mode`, `runtime`, `prompt`, `instructions`, `workflow`, `untrusted`, `start`, `send`, `respond`, `get`, `name`, `version`, `setup`, `close`, `description`, `parameters`, `kind`, `kindsFor`, `parallelSafe`, `sendsOut`, `summarize`, `ruleSubject`, `availableIn`, `vaultNames`, `defer`, `run`, `main`, `skills`, `agents`, `outputStyles`, `mcpServers`, `hooks`, `workflows`, `permissions`, `ui`, `solution`, `requires`, `displayName`, `icon`, `tags`, `keywords`, `category`, `author`, `publisher`, `license`, `homepage`, `repository`, `links`, `changelog`, `engines`, `updates`

## Settings

Every `HARNESS_` environment variable the code reads. The description comes from the README's table; "see README" means the README mentions it elsewhere.

| Variable | Default | What it does |
|---|---|---|
| `HARNESS_ANTHROPIC_BASE_URL` |  | internal, or not documented yet |
| `HARNESS_ANTHROPIC_FALLBACK` |  | internal, or not documented yet |
| `HARNESS_ANTHROPIC_SERVER_COMPACTION` | on | `off` makes Claude sessions use the harness's own compaction. |
| `HARNESS_ARTIFACT_MAX_KB` |  | see README |
| `HARNESS_AUTH` |  | internal, or not documented yet |
| `HARNESS_AUTO_MODEL` | sub-agent model | The model that checks calls in auto mode. |
| `HARNESS_AUTO_RESUME` | off | After a restart, interrupted turns start again and interrupted workflow runs pick up at their step, with nobody there. |
| `HARNESS_BACKGROUND_MAX_WAKES` |  | see README |
| `HARNESS_BACKGROUND_WAKE` | on / 20 | A background agent, workflow, shell or monitor that finishes while the session is idle starts a turn with its result, up to this many turns without a message from the person. |
| `HARNESS_BLENDER` | auto | Blender and Godot for server-folder sessions (searched on the PATH and in the usual install folders). |
| `HARNESS_BUNDLED_PLUGINS` | on | `off` skips the plugins that ship with the core. |
| `HARNESS_CACHE_ATTRIBUTION` | on | Cache misses named by the prompt section that changed (trace, `cache_miss` events, session stats, eval results. |
| `HARNESS_CALL_MAX_MS` |  | internal, or not documented yet |
| `HARNESS_CHANGES_MAX_MB` | 20 | The change journal (`<data>/changes.jsonl`) keeps its newest half past this size. |
| `HARNESS_CHROMIUM` | auto | Chromium for the render and browser tools. |
| `HARNESS_CLIENT_CALL_MS` |  | see README |
| `HARNESS_CLONE_REPOS` |  | Private repositories cloned with `HARNESS_GITHUB_TOKEN` at session creation (`owner/name`, URLs, `owner/*`. |
| `HARNESS_CLUSTER` | off | `1`: this server shares its data folder with others (see Running several servers). |
| `HARNESS_CLUSTER_PEERS` | none | Comma-separated server addresses. |
| `HARNESS_CLUSTER_SECRET` | none | At least 32 random characters, the same on every server. |
| `HARNESS_COMPACT_AT` | per model | Prompt tokens before compaction. |
| `HARNESS_COMPANION_LEASE_S` |  | internal, or not documented yet |
| `HARNESS_COMPANION_SANDBOX` |  | internal, or not documented yet |
| `HARNESS_COMPANION_TOKEN` |  | see README |
| `HARNESS_COMPANION_TOKEN_DAYS` | 30 / 60 | How long a companion token lasts (replaced while the companion polls) / how long a replaced one still works. |
| `HARNESS_COMPANION_TOKEN_GRACE_MIN` |  | see README |
| `HARNESS_DATA` | `<home>/data` | Sessions, workspaces, companions. |
| `HARNESS_DATA_DIR` |  | see README |
| `HARNESS_DATA_MAX_ROWS` |  | see README |
| `HARNESS_DATA_MEMORY` |  | internal, or not documented yet |
| `HARNESS_DATA_PARALLEL` |  | internal, or not documented yet |
| `HARNESS_DATA_PRIVATE_HOSTS` |  | see README |
| `HARNESS_DATA_SCHEDULE` |  | internal, or not documented yet |
| `HARNESS_DATA_THREADS` |  | internal, or not documented yet |
| `HARNESS_DATA_TIMEOUT_MS` |  | see README |
| `HARNESS_DATA_TOOLS` |  | see README |
| `HARNESS_DEEPSEEK_BASE_URL` |  | internal, or not documented yet |
| `HARNESS_DEFER_PLUGIN_TOOLS` | on | Plugin tools' schemas wait behind `load_tools` (one line per plugin) until the session uses them (`efficiency.deferPluginTools`). |
| `HARNESS_DELEGATION_MODELS` |  | see README |
| `HARNESS_DESKTOP` |  | see README |
| `HARNESS_DESKTOP_DATA` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_DEV_PLUGINS` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_DEV_RELOAD` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_ENGINE` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_HIDDEN` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_NO_TRAY` |  | internal, or not documented yet |
| `HARNESS_DESKTOP_SESSION_DAYS` | 30 | How long a desktop sign-in's bearer session lasts at most (14 idle days end it sooner). |
| `HARNESS_DESKTOP_SIZE` | `1280x800` | The `computer` tool's display in a sandbox (`WxH`, 640x480 to 3840x2160). |
| `HARNESS_DESKTOP_TEST` |  | internal, or not documented yet |
| `HARNESS_DESTINATION_FLOOR` | on | `off`: in bypass mode, a message or payment to an address, account or number the person never named is no longer asked after untrusted content. |
| `HARNESS_DEVOPS_IMAGE` | / `none` | Server-folder sessions. |
| `HARNESS_E2E_SHOW` |  | internal, or not documented yet |
| `HARNESS_ELEVATION` |  | see README |
| `HARNESS_EVAL_DENY_HOSTS` | the repository's GitHub URLs | What an eval run's web tools refuse. |
| `HARNESS_EVAL_SANDBOX` | auto | How eval runs contain the agent's commands. |
| `HARNESS_EVENTS_RING` | 1000 | Events the global stream (`GET /api/events`) keeps for replay. |
| `HARNESS_EXPORT_MAX_MB` | 50 / 80 | Workspace files in an exported session / the largest import. |
| `HARNESS_FANOUT_MAX_MINUTES` |  | internal, or not documented yet |
| `HARNESS_FORK_COPY_MB` | 200 | A forked session's workspace is copied up to this size. |
| `HARNESS_GATES_ON_STOP` | off | Refuse to end a turn while a blocking quality gate fails. |
| `HARNESS_GITHUB_API` |  | see README |
| `HARNESS_GITHUB_TOKEN` |  | `publish_branch`: token, extra repositories it may push to, API base (GitHub Enterprise), commit author `"Name <email>"`, other git hosts the token may be sent to. |
| `HARNESS_GIT_AUTHOR` |  | see README |
| `HARNESS_GODOT` |  | see README |
| `HARNESS_HOME` | `~/.harness` (or where a move put it) | The harness home: data, workspaces, tmp, exports, plugins, logs, settings.json (see Where the agent works). |
| `HARNESS_HOME_ROOTS` | on | `off`: the home's folders are not allowed by default (only `HARNESS_LOCAL_ROOTS`). |
| `HARNESS_HOST` | `127.0.0.1` / `4310` |  |
| `HARNESS_IMPORT_MAX_MB` |  | see README |
| `HARNESS_INBOX_MAX` |  | internal, or not documented yet |
| `HARNESS_INJECTION_SCAN` | off | `on`: a small model checks each outside result for instructions aimed at the agent. |
| `HARNESS_INSTRUCTIONS` |  | The operator's instruction file for every session (the managed tier). |
| `HARNESS_INTEGRATIONS` |  | The integrations plugin's configuration. |
| `HARNESS_INTEGRATIONS_SECRETS` |  | An alternative to the Key Vault for the integrations plugin. |
| `HARNESS_LEASE_SECONDS` | 30 / 1000 | How long a stopped server keeps its sessions and the scheduler before another takes over / how often a server re-reads what the others changed. |
| `HARNESS_LINKED_MAX` |  | see README |
| `HARNESS_LINKED_MAX_AUTO` |  | internal, or not documented yet |
| `HARNESS_LINKED_SESSIONS` |  | see README |
| `HARNESS_LOCAL_ROOTS` |  | Folders server-folder sessions may use, besides the home's `workspaces/` and `tmp/`, separated by `:` (`;` on Windows). |
| `HARNESS_LOCAL_SANDBOX` | off | How server-folder sessions contain commands by default. |
| `HARNESS_MASK_BATCHED` | on | Non-Anthropic models. |
| `HARNESS_MAX_AGENTS` |  | internal, or not documented yet |
| `HARNESS_MAX_COST_USD` |  | see README |
| `HARNESS_MAX_SCHEDULES` | 50 | Scheduled prompts per person. |
| `HARNESS_MAX_STEPS` | 150 / 5 | Per turn / per session. |
| `HARNESS_MAX_TURN_MINUTES` | 0 (off) | Wall-clock minutes a turn may run before it stops with the reason `time`. |
| `HARNESS_MAX_USER_MCP` |  | internal, or not documented yet |
| `HARNESS_MCP_CONFIG` |  | Operator MCP servers, `.mcp.json` format. |
| `HARNESS_MCP_INLINE_MAX` | 10 | Above this many MCP tools, schemas load on demand. |
| `HARNESS_MCP_RELIST_MS` |  | internal, or not documented yet |
| `HARNESS_MCP_TOKEN` |  | internal, or not documented yet |
| `HARNESS_MCP_URL` |  | internal, or not documented yet |
| `HARNESS_MCP_WAIT_S` |  | internal, or not documented yet |
| `HARNESS_MEMORY` | on | `read` (load, never change) or `off`. |
| `HARNESS_MESSAGE_RATE_LIMIT` |  | see README |
| `HARNESS_MIRROR_MAX_MB` | 100 | How much of a companion folder server-side tools may copy. |
| `HARNESS_MODELS_FILE` |  | see README |
| `HARNESS_MODELS_JSON` |  | The operator's OpenAI-compatible models (Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, Azure OpenAI, Gemini, ...). |
| `HARNESS_MOONSHOT_CACHE_TTL` | `5m` | `1h`: Kimi K3 writes its prompt cache to the 1-hour tier (writes cost $6 instead of $3 per million tokens. |
| `HARNESS_NODE_ID` | host name and port / none | This server's unique id among them / the address the others pass a session's requests to (https, or http on loopback. |
| `HARNESS_NODE_URL` |  | see README |
| `HARNESS_NOTICE_AWAY_MINUTES` |  | internal, or not documented yet |
| `HARNESS_NOTICE_HOLDOUT` |  | internal, or not documented yet |
| `HARNESS_NOTICE_PRACTICE_DAYS` |  | internal, or not documented yet |
| `HARNESS_NOTICING` |  | internal, or not documented yet |
| `HARNESS_OFFICIAL_KEYS` |  | internal, or not documented yet |
| `HARNESS_OIDC_` |  | see README |
| `HARNESS_OIDC_ADMINS` |  | E-mail addresses that are administrators. |
| `HARNESS_OIDC_ALLOWED_DOMAINS` |  | Who may sign in (comma-separated e-mail domains / addresses). |
| `HARNESS_OIDC_ALLOWED_EMAILS` |  | see README |
| `HARNESS_OIDC_CLIENT_ID` |  | The application registered at the provider. |
| `HARNESS_OIDC_CLIENT_SECRET` |  | see README |
| `HARNESS_OIDC_ISSUER` |  | Single sign-on: the provider's issuer, exactly as its discovery document gives it (https. |
| `HARNESS_OIDC_ONLY` | off | `1`: people sign in only through the provider. |
| `HARNESS_OIDC_SCOPES` | `openid email profile` | Scopes asked for. |
| `HARNESS_OIDC_TRUST_EMAIL` | off | `1`: accept an e-mail the provider does not mark `email_verified` (only for a provider that never sends the claim and never lets people use an unverified address). |
| `HARNESS_OPENAI_BASE_URL` |  | internal, or not documented yet |
| `HARNESS_OTEL_ENDPOINT` |  | OTLP/HTTP trace export. |
| `HARNESS_OTEL_HEADERS` |  | see README |
| `HARNESS_OUTAGE_RETRY_MS` |  | internal, or not documented yet |
| `HARNESS_PLUGINS` |  | Plugin folders, separated by `:` (`;` on Windows). |
| `HARNESS_PLUGIN_CATALOGUE` |  | Signed plugins to install from the UI/API. |
| `HARNESS_PLUGIN_IGNORE_ENGINES` |  | internal, or not documented yet |
| `HARNESS_PLUGIN_KEYS` |  | Trusted public keys; when set, every non-bundled plugin must be signed. |
| `HARNESS_PLUGIN_LOOPS` | on | `off`: plugins' server-side loops do nothing here (`api.lease()` is false). |
| `HARNESS_PLUGIN_NETWORK` |  | Hosts the operator grants a plugin beyond its manifest's `permissions.network`, as JSON. |
| `HARNESS_PLUGIN_SESSION_OWNERS` | none | Accounts a plugin may act for, as JSON. |
| `HARNESS_PORT` |  | see README |
| `HARNESS_PREFIX_TTL` | auto | Claude's stable prefix (tools + system) cache TTL. |
| `HARNESS_PRICING_JSON` |  | Override prices per model. |
| `HARNESS_PRODUCT` |  | internal, or not documented yet |
| `HARNESS_PROGRESS_EXTEND` | 100 / 4 / 1 / 600 | The progress review's block, extensions and fresh starts per turn, and the absolute steps per turn. |
| `HARNESS_PROGRESS_EXTENSIONS` |  | see README |
| `HARNESS_PROGRESS_FALSE_DONE` |  | see README |
| `HARNESS_PROGRESS_REFRESHES` |  | see README |
| `HARNESS_PROGRESS_REVIEW` | on | `off`: the old hard stop at `maxSteps` (no checkpoint, extensions or reminders). |
| `HARNESS_PROGRESS_REVIEWER` | on / on | `off`: judge from the signals alone / do not check a final "done". |
| `HARNESS_PROGRESS_SOFT_EVERY` | 50 | Steps between early looks at the signals (0. |
| `HARNESS_PUBLIC_URL` |  | Where people reach the server, e.g. |
| `HARNESS_PUBLISHER_KEYS` |  | internal, or not documented yet |
| `HARNESS_PUBLISH_PREFIX` | `agent/` | Branches the agent may push are under this prefix (`""`. |
| `HARNESS_PUBLISH_READY` |  | see README |
| `HARNESS_PUBLISH_REPOS` |  | see README |
| `HARNESS_PUBLISH_TOKEN_HOSTS` |  | see README |
| `HARNESS_PUBLISH_UPDATE` | off / off | `1`: may push to a branch this session did not create / may open ready (non-draft) pull requests. |
| `HARNESS_RATE_LIMIT` | 600 / 30 | Requests / messages per minute per person (0 = none). |
| `HARNESS_RECORD` |  | internal, or not documented yet |
| `HARNESS_RENDER_NETWORK` | off | `on` lets LibreOffice reach the network (it runs in an empty network namespace otherwise). |
| `HARNESS_RENDER_PDF` | pdf.js | `poppler` draws and measures PDF pages with poppler instead. |
| `HARNESS_REPO_SETUP` | off | `1`: a repository's `.harness/setup.sh` runs as a Docker session's setup script. |
| `HARNESS_REQUEST_IMAGE_BYTES` |  | internal, or not documented yet |
| `HARNESS_REQUIRED_PLUGINS` |  | Comma-separated plugin names that cannot be switched off (`POST /api/plugins/:name/disable` answers 409). |
| `HARNESS_REVIEW_MODEL` | the agent's model | The model for progress reviews (a cheaper one is fine). |
| `HARNESS_ROOT` |  | internal, or not documented yet |
| `HARNESS_ROUTE_RATE_LIMIT` | 600 | Requests a minute per address to plugin routes (`/api/plugins/<plugin>/...`). |
| `HARNESS_RUN_TAG` |  | internal, or not documented yet |
| `HARNESS_SANDBOX_ALLOW_HOSTS` | registries + GitHub | Comma-separated hosts an allowlist sandbox may reach (an entry may add methods. |
| `HARNESS_SANDBOX_CPUS` |  | internal, or not documented yet |
| `HARNESS_SANDBOX_CREDENTIALS` |  | API credentials allowlist sandboxes use through their proxy. |
| `HARNESS_SANDBOX_GITHUB_TOKEN` |  | see README |
| `HARNESS_SANDBOX_IDLE_MS` |  | internal, or not documented yet |
| `HARNESS_SANDBOX_IMAGE` | `harness-sandbox:latest`, `4g`, `2`, 30 min |  |
| `HARNESS_SANDBOX_IMAGES` |  | Other images a sandbox session may choose (comma-separated), e.g. |
| `HARNESS_SANDBOX_MEMORY` |  | internal, or not documented yet |
| `HARNESS_SANDBOX_RUNTIME` | Docker's (runc) | An OCI runtime for sandbox containers, e.g. |
| `HARNESS_SANDBOX_SHM` | `512m` | Shared memory of a sandbox (`/dev/shm`). |
| `HARNESS_SANDBOX_UPSTREAM_PROXY` |  | see README |
| `HARNESS_SCHEDULE_ASK_MINUTES` |  | internal, or not documented yet |
| `HARNESS_SCHEDULE_MIN_MINUTES` |  | internal, or not documented yet |
| `HARNESS_SCHEDULE_RUNS_KEPT` |  | internal, or not documented yet |
| `HARNESS_SCRIPT_ISOLATION` | on | `off` runs scripts without the network namespace (they then ask first). |
| `HARNESS_SEARCH` | first available | `brave`, `tavily`, `exa`, `searxng`, `deepseek`, `kimi`, `anthropic`, `openai` or `off`. |
| `HARNESS_SEARCH_ANTHROPIC_MODEL` | `claude-haiku-5-5` / `gpt-6-luna` | The small model that runs a provider's built-in search. |
| `HARNESS_SEARCH_OPENAI_MODEL` |  | see README |
| `HARNESS_SEARXNG_URL` |  | see README |
| `HARNESS_SECRET_KEY` | `<data>/secret.key` | The key that encrypts secrets at rest (key vault values, MCP bundles' sensitive values). |
| `HARNESS_SERVER` |  | internal, or not documented yet |
| `HARNESS_SETTINGS` |  | The operator's settings file (JSON. |
| `HARNESS_SETUP_TIMEOUT_S` |  | see README |
| `HARNESS_SHELL` | auto | Windows: `powershell`, or the path of a `bash.exe` (default. |
| `HARNESS_SHELL_WRITE_GUARD` | on | `off` allows shell file writes. |
| `HARNESS_SNAPSHOT_DAYS` | 7 / 900 | How long setup snapshots are reused / how long a setup script may run. |
| `HARNESS_SOFFICE` | auto | Paths to the document converters (searched on the PATH and in the usual install folders). |
| `HARNESS_SOLUTION` |  | internal, or not documented yet |
| `HARNESS_SOLUTIONS` |  | internal, or not documented yet |
| `HARNESS_SOLUTIONS_MODE` |  | internal, or not documented yet |
| `HARNESS_SPILL` | on / 64 | Long tool output kept whole in `<workspace>/.harness/spill/<session>/` (head and tail shown) / the session's cap (`efficiency.spill`). |
| `HARNESS_SPILL_MAX_MB` |  | see README |
| `HARNESS_STALL_NOTE_S` |  | internal, or not documented yet |
| `HARNESS_STEP_CEILING` |  | see README |
| `HARNESS_STREAM_IDLE_MS` |  | internal, or not documented yet |
| `HARNESS_SUBAGENTS_PARALLEL` |  | see README |
| `HARNESS_SUBAGENT_DEPTH` | 1 / 10 | How deep sub-agents may nest (at most 3) / how many run at once (at most 20). |
| `HARNESS_SUBAGENT_MODEL` | session model | E.g. run sub-agents on `deepseek-flash`. |
| `HARNESS_SWARM_AGENTS` |  | internal, or not documented yet |
| `HARNESS_SWARM_CHILDREN` |  | internal, or not documented yet |
| `HARNESS_SWARM_MINUTES` |  | internal, or not documented yet |
| `HARNESS_SWARM_RATE` |  | internal, or not documented yet |
| `HARNESS_SWARM_USD` |  | internal, or not documented yet |
| `HARNESS_SYNC_MS` |  | see README |
| `HARNESS_TAINT_GUARD` | on | `off` stops confirming ways out after untrusted content (not recommended). |
| `HARNESS_TOKEN` | random, printed | Browser access token. |
| `HARNESS_TOOL_MAX_MINUTES` |  | internal, or not documented yet |
| `HARNESS_TRUST_PROJECT` | off | Let repository hooks and stdio MCP servers run outside the sandbox. |
| `HARNESS_USER_DAILY_USD` | none | Daily spend cap per account. |
| `HARNESS_USER_MAX_RUNNING` | 4 / 8 | Sessions working at once / sessions with a sandbox container, per account (0 = no limit). |
| `HARNESS_USER_MAX_SANDBOXES` |  | see README |
| `HARNESS_USER_MCP_WAIT_MS` |  | internal, or not documented yet |
| `HARNESS_VAULT` | on | The key vault: `admins` (only administrators' sessions get it) or `off`. |
| `HARNESS_VAULT_BACKENDS` | local only | External backends as JSON. |
| `HARNESS_VERIFY_TURNS` |  | internal, or not documented yet |
| `HARNESS_VERSION` |  | internal, or not documented yet |
| `HARNESS_WIN_JOBS` |  | internal, or not documented yet |
