# Harness Web

An agent harness that is also a framework. You give it requirements and it works in a workspace until the job is done: it plans, edits, runs, tests, fixes what fails and reports. You extend what it can do with **plugins**: tools, models, providers, sub-agents, skills, MCP services, quality gates, workflows and hooks. All of it goes through the same registry the built-ins use.

It is tuned and tested on three cost-efficient models: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** (`deepseek-flash`) and **GPT-6 Luna**. Plugins can add more.

```
              ┌──────────────── browser UI / CLI / your code (createHarness) ───────────────┐
              │                                                                               │
 Registry ◀── built-ins + plugins (tools · models · providers · agents · skills · MCP · gates · hooks)
              │                                                                               │
 Session ──▶ Agent loop ──▶ Provider (Claude / OpenAI / DeepSeek, cache-first)                │
              │   └─▶ tools ──▶ Host: Docker sandbox · server folder · your computer (companion)
              └── history (append-only) · checkpoints · trace · recovery after restart        │
```

## Quick start

```bash
cd harness-web
npm install
npm run build                 # browser UI + companion script
npm run sandbox:image         # the Docker sandbox image (once)
export DEEPSEEK_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=...   # or GW_ANTHROPIC_API_KEY
npm start                     # http://127.0.0.1:4310, prints an access token
```

Node 22.18+ is required; it runs the TypeScript directly. Docker is optional: without it, work on your own computer through the companion, or in a server folder.

Headless, for scripts and CI:

```bash
npm run cli -- --model deepseek-flash --runtime local --dir ./project "Add input validation to the API and tests for it"
```

As a library:

```ts
import { createHarness } from './harness-web/src/index.ts';
const h = await createHarness({ dataDir: './data', plugins: ['./my-plugins'] });
const s = await h.sessions.create({ model: 'claude-haiku-5-5', runtime: { kind: 'local', network: 'none', path: '.' } });
s.subscribe(0, ({ event }) => { if (event.kind === 'text_delta') process.stdout.write(event.text); });
await s.send('Fix the failing tests');
```

## The loop

`src/core/agent.ts` runs one loop that the model drives: call the model, run the tools it asked for, append the results, and repeat until it answers without a tool call.

- **Tool scheduling.** Read-only calls in one turn run in parallel; everything else runs in order.
- **Limits.** The loop stops at a step limit, a session spend limit, a refusal, or when the user presses Stop.
- **Errors come back as repair instructions, not crashes.** The research found that how failures are returned is a main reason harnesses differ:
  - An invalid JSON argument returns the parse error and the expected schema.
  - An unknown tool returns the list of real tools.
  - A missing parameter is named.
  - An edit whose text was not found points to the line that nearly matched.
  - A call cut off at the output limit is refused rather than run.
  - An identical call repeated three times gets a "try something else" note.
  - A deferred MCP tool called by its own name is routed automatically.
- **Writing file contents from the shell is refused.** That covers `cat > f`, heredocs, `sed -i`, `tee`, and `echo > file.js`. In testing, Claude Haiku wrote every file this way. That bypassed checkpoints, diffs, the stale-file check and edit approval, and it cost more output tokens than small edits. The `bash` tool's description says so up front, so models switch to `write`/`edit` without a wasted call.

## Token economy: minimum input, maximum output

| Lever | How |
|---|---|
| **Prompt caching** | Built in from the start. The system prompt (~560 tokens) is identical for every session. Tools never change mid-session and are sorted by name. History only grows; reminders are appended. Claude gets one explicit breakpoint plus automatic tail caching. OpenAI gets `prompt_cache_key` and replayed encrypted reasoning. DeepSeek's prefix cache is kept byte-identical. Measured: **81–99% of input tokens read from cache** in every validation run. |
| **Deferred MCP schemas** | Past 10 MCP tools, the session declares only `tool_search` + `tool_call`. Schemas are fetched on demand and appended, so the cache keeps hitting. With 30 tools, the MCP part of the prompt went from ~1,240 to ~160 tokens; real servers' schemas are far larger. |
| **Skills** | One line per skill sits in context. The full instructions load only when the task needs them. |
| **Sub-agents** | Exploration and review run in their own context and return a report, not their transcript. They can run on another model (`HARNESS_SUBAGENT_MODEL`, or a `model:` in the agent definition). |
| **Context clearing** | Old tool results are cleared in large batches. Claude does it on the server (context editing, so the transcript stays append-only); OpenAI and DeepSeek do it in the harness, only past 60% of the compaction threshold and only if at least 12K tokens are freed. The stored history keeps everything. |
| **Compaction** | Thresholds are set per model for cost. Haiku 5.5 compacts before 100K tokens, where its price rises five times. The summary request reuses the cached context. |
| **Small outputs** | `edit` sends only the changed text and echoes the changed lines (no re-read needed). Command output is trimmed to its head and tail. `read` pages large files. |
| **Effort** | Per session, per model. Explore sub-agents run at low effort. |
| **Images leave with their results** | A tool's images ride on its tool result: Claude gets them inside the `tool_result` (server-side clearing removes them with it), OpenAI and DeepSeek get them as following content and harness clearing drops them. A render-review loop no longer carries every old page (~1,200 tokens each). Long pages come back as A4-sized pages, never one giant image. |
| **Workflow steps start fresh** | Each step of a workflow is a new agent with a short brief and the files on disk, not the whole history. Steps of the same kind share a cache prefix. |

## Plugins

A plugin is a folder with `harness-plugin.json`. See `examples/plugins/acme` for a working one that the test suite loads.

```json
{
  "name": "acme",
  "version": "1.0.0",
  "main": "index.mjs",
  "skills": "skills",
  "agents": "agents",
  "mcpServers": { "github": { "type": "http", "url": "https://api.example.com/mcp", "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" } } },
  "hooks": { "PostToolUse": [{ "matcher": "write|edit", "command": "npx prettier --write . >/dev/null 2>&1; true" }] },
  "permissions": { "network": ["api.example.com"], "secrets": ["GITHUB_TOKEN"] }
}
```

```js
// index.mjs — runs in the server (trusted plugins only). No imports from the harness:
// the plugin works wherever it is installed.
export default {
  name: 'acme',
  setup(api) {
    api.registerTool({ name: 'acme_status', description: '...', parameters: { type: 'object', properties: {} }, kind: 'read', run: async () => 'green' });
    api.registerGate({ name: 'acme-no-todo', description: '...', run: async ({ host }) => ({ pass: true, summary: 'ok' }) });
    api.on('PreToolUse', ({ input }) => /--force/.test(String(input?.command)) ? { block: true, feedback: 'no force-push' } : undefined, 'bash');
    // also: registerModel, registerProvider, registerAgent, registerSkills, registerMcpServer,
    // registerWorkflow, workspacePath(host, p), log; and close() on the plugin for teardown
  },
};
```

**Signed plugins and the catalogue.** A plugin's code runs in the server, so an operator can require signatures. `npm run plugin -- keygen acme` makes a key pair; `npm run plugin -- sign <dir> --key acme.key.pem` writes `harness-plugin.sig` (Ed25519 over the SHA-256 of every file); `verify` checks one. With `HARNESS_PLUGIN_KEYS` (a public key or a folder of them) set, every plugin not shipped with the harness must be signed by a trusted key: a changed, added or removed file, an unknown key or a symbolic link refuses it. `HARNESS_PLUGIN_CATALOGUE` points at a folder of signed plugins: `GET /api/plugins/catalogue` lists them with their verification, `POST /api/plugins/install {name}` verifies, copies into `<data>/plugins`, verifies again where it will run, and loads it for new sessions (installs need a trust list).

**Trust.** Plugins from `HARNESS_PLUGINS` are the operator's and are trusted. Their code runs in the server, and `${VAR}` in their MCP configuration expands from the server's environment, so secrets never enter a repository or the model. A workspace can contribute only declaratively:

| Workspace file | What it adds |
|---|---|
| `.harness/skills/*/SKILL.md` (and `.claude/skills/*/SKILL.md`) | Skills |
| `.harness/agents/*.md` (and `.claude/agents/*.md`) | Sub-agents |
| `.harness/settings.json` | Permission rules and hooks |
| `.mcp.json` | MCP servers (Claude Code's format) |

Repository-defined commands (hooks, stdio MCP servers) run only in a sandboxed session, or with `HARNESS_TRUST_PROJECT=1`. Repository HTTP MCP servers must be public addresses.

**Sub-agents** are markdown files: frontmatter `name`, `description`, `tools`, `model`, `effort`, and the prompt as the body. Built-ins:

- `explore`: read-only, low effort;
- `general`.

**MCP** works over stdio and streamable HTTP (with sessions and SSE responses), with paged `tools/list` and `tools/call`. Tools marked `readOnlyHint` run freely. Every other MCP tool is classed as *external*: it asks for approval even in a sandbox, because the sandbox does not contain another service. Allow a whole server with a rule like `mcp__github__*`.

**Hooks** (shell or in-process): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Exit code 2 (or `{block: true}`) blocks. A `Stop` hook can send the agent back to work, for example "the tests still fail".

## Workflows (node graphs)

A workflow is a graph of steps that the harness drives, not the model. Each step is saved when it ends, so a run survives a restart and resumes at the step it was in (UI **Resume**, or `POST /api/sessions/:id/runs/:runId/resume`). Inside a step, an agent works with the normal loop and tools.

| Node | What it does | Outcomes it routes on |
|---|---|---|
| `agent` | Runs a sub-agent (`agent`, `prompt`, optional `model`, `effort`) in a fresh context. Its report is kept as `{{state.<node>}}`. | the first `decide` word found in the report, e.g. `APPROVE` / `REQUEST_CHANGES` |
| `gate` | Runs quality gates (`gates: "applicable"` or names). On failure the evidence becomes `{{feedback}}` for the next step. | `pass`, `fail`, `exhausted` (after `maxFailures`) |
| `approval` | Shows a person a message and files; they approve, or send it back with what to change. | `approve`, `reject` |
| `parallel` | Runs its `branches` at once. | the first negative branch outcome (`REQUEST_CHANGES`, `REJECT`, `FAIL`…), else `all` |
| `branch` | Routes on a rendered value, e.g. `{{input.approval}}`. | the value |
| `shell` | Runs a command. A workspace workflow with a shell node loads only where project commands are trusted. | `ok`, `fail` |
| `code` | Runs a function. Plugins only, never from a workspace. | what it returns |
| `end` | Finishes as `success` or `failed`. | |

`next` is a node id, or `{ "on": { "<outcome>": "<node>" }, "default": "<node>" }`. Templates: `{{input.x}}`, `{{state.<node>}}`, `{{feedback}}`. A graph is checked before it runs (missing nodes, unreachable nodes, branch rules). Loops are bounded by `maxAgentRuns` and 200 steps.

Workflows come from plugins (`registerWorkflow`, or a `workflows` folder in the manifest) or from the workspace (`.harness/workflows/*.json`). Run one from the UI (**Workflow…** beside Send), from the CLI, or from code:

```bash
npm run cli -- --model deepseek-flash --runtime local --dir ./work --workflow build-feature \
  --input "request=A URL shortener HTTP API with ..." --input approval=auto
```

### The SDLC pack (`plugins/sdlc`)

Seven agents (analyst, architect, planner, engineer, code-reviewer, security-reviewer, tech-writer) and five skills (requirements spec, ADRs, test-driven development, review checklist, delivery report). Its `build-feature` workflow:

```
requirements → architecture + ADRs → [approve design] → plan → implement (test-first)
  → quality gates ⇄ fix  → code review ∥ security review → [address findings → gates ⇄ fix]
  → docs → delivery report (requirement → code → test traceability)
```

With `approval=manual` (the default) a person approves the requirements and architecture before any code is written, and can send them back.

### Quality gates (`plugins/quality-gates`)

Each gate decides for itself whether it applies to the workspace:

- **Tests:** Node (`npm test`), Python (pytest, when there are test files), Go, Rust, Java (Maven or Gradle).
- **Checks:** Node typecheck, lint and build when the project defines them; ruff (blocking only if the project configures it).
- **Hygiene:** committed secrets (shown redacted), merge-conflict markers, TODO/FIXME markers (advisory), large files (advisory).

Gates run in three places:

1. as `gate` nodes in a workflow;
2. as the `quality_gates` tool, which agents call before they finish;
3. as a `Stop` check, with `HARNESS_GATES_ON_STOP=1` or `"gatesOnStop": true`: the agent cannot end its turn while a blocking gate fails.

Plugins add gates with `api.registerGate`.

### Visual verification (`plugins/visual`)

The agent looks at what it made, the way a person will. The renderers run on the server, on the session's workspace folder (sandbox and server-folder sessions).

| Tool / gate | What it does |
|---|---|
| `render {path, pages?, width?, export?}` | Office files (via LibreOffice), PDF, Markdown, HTML and SVG to page images. Also checks that need no eyes: page count, words per page, **slide text that does not fit** (LibreOffice drops what falls off a slide, so fewer words on the page than in the slide means it was cut) and **text too small to read** (autofit shrink passes the fit check but not this one). `export: "pdf"` saves a PDF beside the file. |
| `browser {path, actions?, eval?, save?}` | Opens a workspace page in headless Chromium (WebGL via SwiftShader), served from 127.0.0.1 and confined to the workspace; every other request is blocked and reported. Actions: keys (held for a time), clicks, drags, scroll, `eval`, `waitFor`, screenshots (flagged when blank). `save` writes what a page expression returns (a GLB from GLTFExporter, a canvas PNG) into the workspace. |
| `add_library {name}` | `three`, `pptxgenjs`, `docx`, `jszip` copied from the server's install at pinned versions (a sandbox has no network). |
| gates | `documents-render` (every document opens; no cut-off or tiny slide text), `web-console` (the page opens offline with no errors, missing files or network needs, and draws something), `playtest` (`playtest.json` scenarios: scripted input, then `==`, `>`, `increased`, … on `window` state). |

Converters run without network (`unshare -rn`) where the kernel allows, so a document cannot make the server fetch a URL.

### Documents (`plugins/documents`)

`make-deck` and `write-document`: storyline and outline (with the sources checked against each other), optional approval, build with a script (PptxGenJS / docx), render-and-fix, an independent `visual-reviewer` that renders every page and checks provenance (every number and label must come from the sources), up to two revision rounds, PDF export and a delivery note. Skills carry design rules and recipes that were run and rendered before they shipped (number formats on chart labels, sizing text boxes, real heading styles, page numbers).

### Games and 3D (`plugins/games3d`)

`build-game`: design document and `playtest.json`, build (Canvas 2D or Three.js), `web-console` + `playtest` gates with a fix loop, an independent `playtester` that plays with real input and screenshots, a polish round with a scenario for every bug fixed, and a how-to-play README. `model-3d`: plan with real dimensions, the model as code (`model.js`) with a viewer that shows fixed views, look-and-fix, export `model.glb`, the `gltf-valid` gate and `model_info` (container checks, triangles per placed instance, size from composed node transforms), an independent `art-director`, revisions. The skills hold a complete template game and a Three.js viewer that were run in the headless browser before they shipped.

## Permissions

Enforced in code on every call. Order: deny rules, then ask rules, then allow rules, then the mode's default.

| Mode | Edits | Commands | External services |
|---|---|---|---|
| Ask before edits (default) | ask | free in the sandbox, ask on a real machine | ask |
| Auto-accept edits | free | free in the sandbox, ask on a real machine | ask |
| Plan mode | blocked | read-only only | blocked |
| Bypass | free | free | free |

In plan mode the agent researches read-only, then presents its plan for approval. "Always allow" in an approval adds a rule for the session. A prefix rule like `bash(npm test:*)` never covers a compound command.

## Where the agent works

- **Sandbox** (Docker; the default)
  - One container per session.
  - No capabilities, `no-new-privileges`, and limits on memory, CPU and processes.
  - No network unless enabled for the session.
  - Files sit in a host folder mounted at `/workspace`. The file tools check real paths, so a symlink planted from inside the container cannot reach the host.
- **Your computer** (companion)
  - Open "Your computers", then run the two lines it shows.
  - It connects out over HTTPS (long-poll: no open ports, works behind NAT) and only touches the folder you start it in.
- **Server folder**: opt-in with `HARNESS_LOCAL_ROOTS`.
  - Commands are unsandboxed, with credentials stripped from their environment.
  - They can still reach services on the server's network: keep this mode for trusted, single-user machines.

## Durability, checkpoints, trace

- **History** is append-only JSONL. If the server stops mid-turn, every unfinished tool call gets a result saying so (the transcript stays valid). The session is idle again on restart, and with `HARNESS_AUTO_RESUME=1` it continues on its own.
- **Checkpoints.** Before a tool first changes a file in a turn, the file is saved. **Rewind** (UI, or `POST /api/sessions/:id/rewind {turn}`) puts every file touched since back as it was, and removes files created since. The agent is told which files changed. As in Claude Code, changes made by shell commands are not tracked, which is one reason shell file writes are refused.
- **Trace.** Every model call and tool call is recorded in `trace.jsonl`: model, time, uncached / cache read / cache write / output tokens, cost, stop reason, retries; tool, time, error. Shown in the UI under "Open trace", and as JSON at `GET /api/sessions/:id/trace`.
- **Images.** `read` (and `render`, `browser`) show pictures to the model, for checking screenshots, renders and charts. Each provider gets its own format. If a provider rejects an image, it is replaced by a note in the live context and the request goes on.
- **Networks fail.** A stream that drops mid-way is retried like a failed request, on every provider; a step that still fails is saved and resumes where it stopped (`--resume`, or **Resume** in the UI).

## Evaluations

`npm run eval -- [--packs sdlc,documents,games,3d] [--models a,b] [--repeat 2] [--concurrency 3]` runs each case in `evals/<pack>/<case>/eval.json` on every model and repeat, in fresh workspaces, and judges it with **hidden checks** the agent never sees: shell commands (the URL shortener's 25 HTTP acceptance checks), gates, required files, and hidden playtests in the headless browser. It writes `report.md` (pass rate, checks passed, median cost, time, cache hit, calls, every failed check) and `results.json`. The checks were calibrated against results verified by hand before they were trusted.

## Observability

Every model and tool call is a span in the session's `trace.jsonl` (UI: "Open trace"). With `HARNESS_OTEL_ENDPOINT` (and `HARNESS_OTEL_HEADERS="k=v,k=v"`) they are also exported as OTLP/HTTP JSON: one trace per session, `chat <model>` spans with `gen_ai.*` token attributes plus cache reads, cost and retries, and `execute_tool <name>` spans with errors. Batched off the request path; a failed export is logged and dropped.

## Measured (2026-10-20)

Every result below was checked independently, outside the agent's own claims: hidden HTTP acceptance checks, rendering and reading every slide, playing each game in the headless browser, viewing each model from four sides. One run per model per task, so these are observations, not benchmark statistics (`npm run eval -- --repeat N` gives those).

**Phase 2 - `build-feature`, a URL-shortener API from written requirements** (requirements, ADRs, plan, test-first build, gates, parallel code and security review, fixes, docs, delivery report):

| Model | Hidden acceptance (25) | Its own tests | Cost | Input tokens | Cache hit | Model calls |
|---|---|---|---|---|---|---|
| GPT-6 Luna | 25/25 | 43/43 | $0.10 | 6.4M | 94% | 219 |
| DeepSeek Flash | 25/25 | 216/216 | $0.46 | 29.6M | 97% | 508 |
| Claude Haiku 5.5 | 25/25 | 172/172 alone; 2 latency tests fail on a busy machine | $0.58 | 14.9M | 88% | 330 |

The code reviewer on the Luna run found a real header-injection bug (CR/LF in a stored URL reaching `Location`) by testing it live; the security reviewer had approved. Every test name cited in the delivery reports exists verbatim.

**Phase 3 - `make-deck`, a 9-11 slide board update from three data files:** all three decks rendered cleanly, carried every key number and passed the render gate. Luna ($0.024, approved first time) and Haiku ($0.13, one revision round) were correct but repeated a monthly-vs-quarterly burn conflict that was planted in the source notes; DeepSeek ($0.20, two rounds) caught that conflict with the arithmetic but added two claims the sources do not make (a region name and "included in the budget"). The reviewer now treats unsourced labels as blocking.

**Phase 3 - `build-game` (a gravity-flight delivery game) and `model-3d` (a cast-iron fire hydrant):**

| Model | Game: hidden playtests | Game cost | Hydrant (size, triangles, materials) | Model cost |
|---|---|---|---|---|
| GPT-6 Luna | 4/4 (+18 of its own) | $0.06 | 0.75 m, 15k tris, 6 materials | $0.03 |
| Claude Haiku 5.5 | 4/4 (+20 of its own) | $0.26 | 0.745 m, 12k tris, worn-paint texture | $0.08 |
| DeepSeek Flash | 4/4 (+20 of its own) | $0.64 | 0.75 m, 16k tris, 6 textures, pentagonal nuts | $0.25 |

The independent playtester found real bugs in DeepSeek's game over two rounds (restart dead on the pause screen, launch overriding the player's aim, the ship hidden under the HUD, off-screen arrows rotated 90 degrees); each fix came with a scenario that fails on the old build.

**What the live runs fixed in the harness:** parallel branches colliding on one save file; an agent step treating "out of steps" as failure; streams that drop mid-way ending a step; every old render staying in the context; one-image full-page renders that DeepSeek rejects; a rejected image ending a step; browser key presses that could fall between frames; plugins that broke when installed outside the repository; sub-agents wandering outside the workspace.


**Phase 1 validation** (local workspace). One task needed all of these at once:

- a project skill with a strict changelog format;
- a project-defined `reviewer` sub-agent;
- an MCP service with 30 tools (so deferred loading kicked in);
- code with tests.

| Model | Tests | Edge cases | Changelog format (from the skill) | Used skill | Used reviewer | Used tool_search → tool_call | Cost | Cache hit |
|---|---|---|---|---|---|---|---|---|
| Claude Haiku 5.5 | pass | pass | pass | yes | yes | yes | $0.0057 | 81% |
| DeepSeek Flash | pass | pass | pass | yes | yes | yes | $0.0120 | 90% |
| GPT-6 Luna | pass | pass | pass | yes | yes | yes | $0.0040 | 89% |

**Image check** (two-colour PNG, read through the loop): all three answered correctly, for $0.0002–$0.0014 each. GPT-6 Luna got an earlier direct test wrong, so its vision is marked as inconsistent.

**Earlier results:**

- **End to end from written requirements (TaskFlow).** A full-stack task tracker:
  - DeepSeek Flash built ~2,900 lines with 23/23 tests passing, for $0.036 at a 99% cache hit.
  - GPT-6 Luna built ~820 lines with 5/5 tests passing, for $0.013.
- **`npm run bench`.** Three tasks judged by hidden checks; all passed on DeepSeek and GPT-6 Luna. Two checks had to be corrected because they tested things the prompts never asked for, so treat it as a smoke test, not a leaderboard.

## Configuration

| Variable | Default | |
|---|---|---|
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` / `GW_ANTHROPIC_API_KEY` | | Models without a key are greyed out. |
| `HARNESS_PLUGINS` | | Plugin folders (`:`-separated). Trusted. |
| `HARNESS_MCP_CONFIG` | | Operator MCP servers, `.mcp.json` format. |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `4310` | |
| `HARNESS_TOKEN` | random, printed | Browser access token. Put the server behind HTTPS before exposing it. |
| `HARNESS_DATA` | `./.harness-data` | Sessions, workspaces, companions. |
| `HARNESS_MAX_STEPS` / `HARNESS_MAX_COST_USD` | 150 / 5 | Per turn / per session. |
| `HARNESS_COMPACT_AT` | per model | Prompt tokens before compaction. |
| `HARNESS_SUBAGENT_MODEL` | session model | E.g. run sub-agents on `deepseek-flash`. |
| `HARNESS_MCP_INLINE_MAX` | 10 | Above this many MCP tools, schemas load on demand. |
| `HARNESS_TRUST_PROJECT` | off | Let repository hooks and stdio MCP servers run outside the sandbox. |
| `HARNESS_AUTO_RESUME` | off | Continue interrupted sessions after a restart. |
| `HARNESS_GATES_ON_STOP` | off | Refuse to end a turn while a blocking quality gate fails. |
| `HARNESS_BUNDLED_PLUGINS` | on | `off` skips the bundled `plugins/` (quality gates, SDLC, visual, documents, games3d). |
| `HARNESS_PLUGIN_KEYS` | | Trusted public keys; when set, every non-bundled plugin must be signed. |
| `HARNESS_PLUGIN_CATALOGUE` | | A folder of signed plugins that can be installed from the UI/API. |
| `HARNESS_OTEL_ENDPOINT` / `HARNESS_OTEL_HEADERS` | | OTLP/HTTP trace export. |
| `HARNESS_RENDER_NETWORK` | off | `on` lets document converters reach the network (they run in an empty network namespace otherwise). |
| `HARNESS_CHROMIUM` | auto | Chromium for the render and browser tools. |
| `HARNESS_SHELL_WRITE_GUARD` | on | `off` allows shell file writes. |
| `HARNESS_SANDBOX_IMAGE`, `_MEMORY`, `_CPUS`, `_IDLE_MS` | `harness-sandbox:latest`, `4g`, `2`, 30 min | |
| `HARNESS_PRICING_JSON` | | Override prices per model. |

## Honest limits

- **This is not Claude Code's code.** Claude Code is closed source. This harness follows its published design and open-source harnesses; unpublished tuning (the exact prompts) is not reproduced.
- **The harness lifts every model but cannot make them equal.** Studies put the harness's effect at 5–30 points on agent benchmarks; the model is still most of the result.
- **Not built yet:**
  - the render and browser tools on companion sessions (they run on the server, on the workspace folder);
  - background compaction;
  - per-host network allowlists in the sandbox (all or nothing);
  - checkpoints and project MCP servers on companion sessions;
  - multi-user accounts (one access token);
  - a remote catalogue (the catalogue is a folder; a signed index served over HTTPS would be next);
  - Blender or Godot integration (3D is Three.js in the headless browser; neither binary was available to test).
- **Not tested here:**
  - the full sandbox image (this environment's proxy blocks Debian packages, so tests used a plain Node image);
  - prices, which come from the providers' pages on 2026-10-19 and can change.
