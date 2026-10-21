# Harness Web

An agent harness that is also a framework. You give it requirements and it works in a workspace until the job is done: it plans, edits, runs, tests, fixes what fails and reports. It remembers what matters across sessions, researches the web with citations it checks, builds long projects feature by feature, and can publish its work as a pull request. You extend what it can do with **plugins**: tools, models, providers, sub-agents, skills, MCP services, quality gates, workflows, search backends and hooks. All of it goes through the same registry the built-ins use.

It is tuned and tested on three cost-efficient models: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** (`deepseek-flash`) and **GPT-6 Luna**. Plugins can add more.

**Picking the project up?** Read [docs/HANDOFF.md](docs/HANDOFF.md): its purpose, what is built, the results, how to run it on your own machine, and the next steps.

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
npm run sandbox:image:3d      # optional: the same plus Blender 4.2 LTS and Godot 4.7 (games3d)
npm run sandbox:image:3d-export   # optional: the 3D image plus Godot's export templates (Linux, Web)
npm run sandbox:image:desktop # optional: the sandbox plus a desktop (Xvfb, Firefox) for computer use
export DEEPSEEK_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=...   # or GW_ANTHROPIC_API_KEY
npm start                     # http://127.0.0.1:4310, prints an access token
```

Node 22.18+ is required; it runs the TypeScript directly. Docker is optional: without it, work on your own computer through the companion, or in a server folder.

**The 3D sandbox image** (`docker/Dockerfile.sandbox-3d`, `harness-sandbox-3d:latest`, about 3.3 GB) is the sandbox plus the official Blender 4.2 LTS and Godot 4.7 builds (pinned, checked against the vendors' checksums), Xvfb and Mesa's CPU renderer, so the `blender` and `godot` tools work in a sandbox and Godot can draw frames for screenshots. Build `harness-sandbox:latest` first. Sessions use it when the operator allows it and the session picks it:

```bash
export HARNESS_SANDBOX_IMAGES=harness-sandbox-3d:latest   # images a session may choose, besides the default
npm start                                                  # "Sandbox image" appears in the new-session form
npm run cli -- --runtime docker --image harness-sandbox-3d:latest "Make a stool in Blender and export it"
```

Or make it every session's image with `HARNESS_SANDBOX_IMAGE=harness-sandbox-3d:latest`. A session can only name an image on that list; the browser and the agent cannot pick any other.

**Godot exports** need Godot's export templates, which the 3D image leaves out. `npm run sandbox:image:3d-export` builds `harness-sandbox-3d:export` from the same Dockerfile with `--build-arg GODOT_EXPORT_TEMPLATES=1`: it downloads the official `Godot_v4.7.2-stable_export_templates.tpz` (1.3 GB, checked against Godot's SHA512-SUMS.txt) and keeps only the Linux x86_64 and Web templates and the ICU data (185 MB; the image is 3.8 GB). For every platform (Windows, macOS, Android, iOS) add `--build-arg GODOT_TEMPLATES=all`, or name the files to keep from the .tpz's `templates/` folder, e.g. `--build-arg "GODOT_TEMPLATES=windows_release_x86_64.exe windows_debug_x86_64.exe"`. Allow it like the 3D image: `HARNESS_SANDBOX_IMAGES=harness-sandbox-3d:latest,harness-sandbox-3d:export`.
**The desktop sandbox image** (`docker/Dockerfile.sandbox-desktop`, `harness-sandbox-desktop:latest`, about 1.9 GB) is the sandbox plus Xvfb, the fluxbox window manager, xdotool, ImageMagick, Firefox ESR, xterm and Mousepad, for the `computer` tool (see Computer use). It is allowed and chosen the same way: `HARNESS_SANDBOX_IMAGES=harness-sandbox-desktop:latest`.

**On Windows, natively.** The npm scripts are plain `node` launchers (`scripts/run.mjs`, `scripts/test.mjs`), so they work in PowerShell and cmd as they do in bash. What to install:

- [Git for Windows](https://git-scm.com/download/win). The harness runs the model's commands in its **Git Bash**. It never uses `C:\Windows\System32\bash.exe`, which is WSL and sees the workspace at a different path. Without Git Bash, commands run in PowerShell; the model is told so, background commands are refused, and the quality gates fail with a message saying they need bash. Set `HARNESS_SHELL` to the path of a `bash.exe` to pick another one.
- For `render` of Office files (`.pptx`, `.docx`, `.xlsx`): `winget install TheDocumentFoundation.LibreOffice`. PDF, HTML, SVG and Markdown need only Chromium: pages are drawn by pdf.js and Markdown is converted by `marked`, both installed by `npm ci`. poppler and pandoc are used only if those are missing. LibreOffice is found in its install folder even when it is not on the PATH; a missing one is reported with the command that installs it, and `HARNESS_SOFFICE` points at it directly. Linux's no-network namespace for LibreOffice (`unshare`) does not exist on Windows, so there it runs with the machine's network.
- For `browser`: `npx playwright install chromium`, or set `HARNESS_CHROMIUM`.
- For `blender` and `godot` in a server folder or the companion: Blender (`winget install BlenderFoundation.Blender.LTS.4.2`) is found in `C:\Program Files\Blender Foundation\Blender *`; Godot (`winget install GodotEngine.GodotEngine`, or the downloaded `Godot_v4.x-stable_win64.exe` in a folder on the PATH, `%LOCALAPPDATA%\Godot` or `Program Files\Godot`). `HARNESS_BLENDER` and `HARNESS_GODOT` point at them directly.

These choices are covered by tests with simulated Windows paths (`test/windows.test.ts`), and the whole suite passes on native Windows 11 (first run 2026-10-21).

**Or run it in Docker** (`docker/Dockerfile.harness`: Node 22, bash, LibreOffice, poppler, pandoc and Chromium, so every visual tool works with nothing installed on the machine):

```bash
docker compose build
docker compose run --rm dev npm ci          # once; node_modules lives in a Linux volume
docker compose run --rm dev npm run build
docker compose run --rm dev npm test
docker compose up harness                   # http://127.0.0.1:4310; keys pass through from your shell
```

Sessions in the container use the server-folder runtime on `/work` (`HARNESS_WORK` on the host, default `./.work`); the container is the isolation. The server mounts the source and `node_modules` read-only, so an agent's shell cannot change the harness's own code; `dev` is the read-write service for installing, building and testing. Docker's default seccomp profile blocks `unshare`, so the document converters run without their extra no-network namespace there.

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
| **Compaction** | Thresholds are set per model for cost. Haiku 5.5 compacts before 100K tokens, where its price rises five times. Claude compacts **on the server** (`compact_20260112`): the summary is made inside the request, with no blocking extra call, and the history stays append-only, which Claude 5.5's preserved-thinking check requires. DeepSeek and GPT-6 Luna use the harness's own compaction: one summary request that reuses the cached context, then nothing older is replayed (the shape Anthropic recommends; OpenAI's server compaction was tried and did not shrink what the next request is billed for). Checked against the current API on 2026-10-21: `compact_20260112` and `clear_tool_uses_20250919` are current; the newer on-demand and keep-tail compaction (`compact-2026-09-04`) exists for harnesses that must edit history and still keep thinking blocks valid, which this one never does on Claude (frozen prefix, appended reminders, no client-side clearing; its own compaction restarts from a summary, which the check allows). |
| **Code mode** | `run_script`: the model writes a short JavaScript program that calls tools and keeps only what it needs; intermediate results never enter the context. On a 40-file aggregation task it gave the same correct answer at about **half the cost** on all three models. |
| **Small outputs** | `edit` sends only the changed text and echoes the changed lines (no re-read needed). Command output is trimmed to its head and tail. `read` pages large files. |
| **Effort** | Per session, per model. Explore sub-agents run at low effort. |
| **Images leave with their results** | A tool's images ride on its tool result: Claude gets them inside the `tool_result` (server-side clearing removes them with it), OpenAI and DeepSeek get them as following content and harness clearing drops them. A render-review loop no longer carries every old page (~1,200 tokens each). Long pages come back as A4-sized pages, never one giant image. |
| **Workflow steps start fresh** | Each step of a workflow is a new agent with a short brief and the files on disk, not the whole history. Steps of the same kind share a cache prefix. |

## Memory across sessions

The agent keeps Markdown notes with the `memory` tool (the same commands as Claude's own memory tool: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`), for every provider. Two scopes:

- `/memories/user`: about the person, for every project (per account on a shared server);
- `/memories/project`: about the project, keyed by its git remote, so every clone of a repository shares it (or by the folder, for a server folder without a remote).

A new session starts with the list of memory files and each scope's `MEMORY.md` index, fenced as *notes, not instructions*, so no round trip is spent looking. Memory is a channel into every future session, so it is guarded:
- paths are confined, links are refused, sizes are capped, and text that looks like a credential is refused;
- every change is logged with the session that made it;
- **once the agent has read untrusted content** (a web page, an MCP result, a sub-agent that did), saving to memory asks the user first, so a page cannot plant instructions for later sessions;
- sub-agents read memory but never change it.

The UI's **Memory** panel shows, edits and deletes what is remembered. `HARNESS_MEMORY=read` loads memory without letting agents change it; `off` turns it off.

## Research

- **`web_search`** works for every model. It uses Brave, Tavily, Exa or a SearXNG instance when configured, else DeepSeek's search endpoint ($0.75 per 1,000 searches), else the web search built into the Claude or OpenAI API, run by a small model. Its cost is added to the session. Plugins add backends with `api.registerSearchBackend`.
- **`web_fetch`** returns the readable part of a page (no menus or footers) and PDF text, and records every page it reads as a **session source**. The harness keeps the sources outside the workspace, so an agent cannot fabricate one.
- **The citation check** compares a report with those sources: every cited page must have been read, every quotation must appear word for word, and every figure in a cited sentence must appear in a source it cites. A computed figure goes in its own sentence marked "(derived: ...)".
- **The research pack** (`plugins/research`) contains:
  - agents: `research-lead`, `researcher`, `research-writer` and `fact-checker`;
  - skills: `research-method` and `cite-sources`;
  - tools: `check_citations` and `sources`, plus a `citations` gate;
  - the **`deep-research`** workflow. It plans sub-questions, sends three researchers in parallel, writes a report with numbered citations, passes it through the citation check and an independent fact-check, and revises up to three times. A revision must narrow or cut any claim it cannot support.

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

**Signed plugins and the catalogue.** A plugin's code runs in the server, so an operator can require signatures.
- `npm run plugin -- keygen acme` makes a key pair.
- `npm run plugin -- sign <dir> --key acme.key.pem` writes `harness-plugin.sig`: Ed25519 over the SHA-256 of every file, `node_modules` included.
- `verify` checks one.

With `HARNESS_PLUGIN_KEYS` set (a public key or a folder of them), every plugin not shipped with the harness must be signed by a trusted key. A changed, added or removed file, an unknown key or a symbolic link means it is refused.

`HARNESS_PLUGIN_CATALOGUE` is where signed plugins are offered for installation, and only administrators install them:
- **a folder**: plugins are listed with whether they verified;
- **an https URL of an `index.json`**: made with `npm run plugin -- pack <dir>` (a reproducible `.tgz`) and `npm run plugin -- index <folder> --base <url>`.

An install from a URL:
1. downloads the archive and checks its sha256;
2. unpacks it strictly (plain files and folders only, nothing outside the folder, size limits);
3. verifies the signature against the trust list;
4. loads it for new sessions.

The UI's **Plugins** dialog lists what is loaded, how each plugin was admitted, and what it declared it needs.

**Declared permissions are enforced on the channels the harness hands out.** A plugin's `permissions.secrets` are the only secrets `api.secret(name)` returns, and the only `${VAR}`s its MCP servers' configuration expands; an undeclared secret expands to nothing. `api.fetch` reaches only the hosts in `permissions.network`, with redirects re-checked; a private address needs an exact entry. MCP servers never inherit the server's environment. Before this, they received every provider key on the machine. Plugin code still runs in the server process, so code that ignores these channels is not contained: that is what signing and review are for.

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
| `shell` | Runs a command. A workspace workflow with a shell node loads only where project commands are trusted. | `ok`, `fail`, or `exit-N` for exit code N when `next` names it |
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

**`long-task`**: a goal too big for one context, built feature by feature. It follows Anthropic's pattern for long-running agents.
1. An `initializer` writes:
   - `.harness/long-task/features.json`, a prioritised list of small features, each with end-to-end steps and `"passes": false`;
   - an `init.sh` that sets up and smoke-tests;
   - a progress log, and a first commit.
2. A fresh agent runs per feature. It reads the log and the git history, builds the first feature that does not pass yet, and verifies it by following its steps as a user would. Only then does it mark the feature as passing, commit, and log what it did. The quality gates run after every feature.
3. After the last feature, a final review.

Safeguards:
- A check refuses a feature list changed beyond its `passes` fields.
- Three sessions in a row without progress stop and ask a person, instead of spending until the run cap.
- Every step is saved, so a run of hours resumes where it stopped.

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

The agent looks at what it made, the way a person will. The renderers run on the server, on the session's workspace folder. For a companion session (the folder is on your computer) they work on a server-side copy that is refreshed with the files that changed (node_modules, .git and build output are skipped), and what they write (an exported PDF, saved renders, a browser export) is written back through the companion.

Rendering needs only Chromium for PDF, HTML, SVG and Markdown: pdf.js reads each page's facts (count, size, every word with its font size) and draws the pages in headless Chromium, and `marked` converts Markdown. Checked against poppler on real decks: the same counts and identical images. Only Office files need LibreOffice. poppler and pandoc are fallbacks (`HARNESS_RENDER_PDF=poppler`).

| Tool / gate | What it does |
|---|---|
| `render {path, pages?, width?, export?}` | Office files (via LibreOffice), PDF, Markdown, HTML and SVG to page images. Also checks that need no eyes: page count, words per page, **slide text that does not fit** (LibreOffice drops what falls off a slide, so fewer words on the page than in the slide means it was cut) and **text too small to read** (autofit shrink passes the fit check but not this one). `export: "pdf"` saves a PDF beside the file. |
| `browser {path, actions?, eval?, save?}` | Opens a workspace page in headless Chromium (WebGL via SwiftShader), served from 127.0.0.1 and confined to the workspace; every other request is blocked and reported. Actions: keys (held for a time), clicks, drags, scroll, `eval`, `waitFor`, screenshots (flagged when blank). `save` writes what a page expression returns (a GLB from GLTFExporter, a canvas PNG) into the workspace. |
| `add_library {name}` | `three`, `pptxgenjs`, `docx`, `jszip` copied from the server's install at pinned versions (a sandbox has no network). |
| gates | `documents-render` (every document opens; no cut-off or tiny slide text), `web-console` (the page opens offline with no errors, missing files or network needs, and draws something), `playtest` (`playtest.json` scenarios: scripted input, then `==`, `>`, `increased`, … on `window` state). |

LibreOffice runs without network (`unshare -rn`) where the kernel allows, so a document cannot make the server fetch a URL; pdf.js pages load nothing but the PDF itself.

### Documents (`plugins/documents`)

`make-deck` and `write-document`: storyline and outline (with the sources checked against each other), optional approval, build with a script (PptxGenJS / docx), render-and-fix, an independent `visual-reviewer` that renders every page and checks provenance (every number and label must come from the sources), up to two revision rounds, PDF export and a delivery note. Skills carry design rules and recipes that were run and rendered before they shipped (number formats on chart labels, sizing text boxes, real heading styles, page numbers).

### Games and 3D (`plugins/games3d`)

`build-game`: design document and `playtest.json`, build (Canvas 2D or Three.js), `web-console` + `playtest` gates with a fix loop, an independent `playtester` that plays with real input and screenshots, a polish round with a scenario for every bug fixed, and a how-to-play README. `model-3d`: plan with real dimensions, the model as code (`model.js`) with a viewer that shows fixed views, look-and-fix, export `model.glb`, the `gltf-valid` gate and `model_info` (container checks, triangles per placed instance, size from composed node transforms), an independent `art-director`, revisions. The skills hold a complete template game and a Three.js viewer that were run in the headless browser before they shipped.

Both workflows take an `engine` input; the browser path stays the default:

- `model-3d` with `engine=blender`: the `3d-artist` builds the model with a bpy script (`tools/model.py`, exporting `model.glb` and `model.blend`) and renders previews into `previews/` with Blender; the gates are `gltf-valid`, `model-preview` and `blender-file`; the `art-director` reviews the renders and `model_info`.
- `build-game` with `engine=godot`: the designer writes a "Self-test" section instead of `playtest.json`; the `game-engineer` builds a Godot 4 project in `game/` with a `--selftest` mode; the gates are `godot-project` and `godot-selftest`; the `playtester` runs the self-test, takes screenshots with the `godot` tool and reads the scripts; then a polish round and a README.

```bash
npm run cli -- --runtime docker --image harness-sandbox-3d:latest --workflow build-game \
  --input "idea=Dodge the falling rocks" --input engine=godot --input approval=auto
```

Blender and Godot run where the session's commands run: in the 3D sandbox image (above), or on the machine of a server folder or companion. They are looked for there - inside the container through the session's own shell, on the server with the same finder as LibreOffice (the PATH, `godot4` and `Godot_v4.x` download names, the usual Windows, macOS and Linux install folders, `HARNESS_BLENDER` / `HARNESS_GODOT`) - and a missing one is reported with how to get it. On a companion they run on the user's computer, which the companion allows only when started with `--allow-hooks` (as for the quality gates); files they write (frames, renders) come back one at a time, not through the mirror.

| Tool / gate | What it does |
|---|---|
| `blender {script \| code, file?, args?, show?}` | `blender -b [file.blend] --factory-startup --python script -- args`, headless, paths inside the workspace only. A Python error fails the call (`--python-exit-code`). `show` returns images the script wrote, e.g. a Cycles-on-CPU or Workbench preview (Eevee needs a GPU). For procedural models exported to .glb, and for opening a .blend and exporting glb/fbx/obj. |
| `godot {action, project?, scene?, frames?, args?, out?, preset?, output?, createPreset?}` | `check`: import, then load every script and scene (parse errors, missing resources). `run`: N frames headless at a fixed 60 per second, every script error and `push_error` reported with its `res://` line; `args` reach the game (`--selftest`). `screenshot`: frames drawn with OpenGL (on Xvfb and llvmpipe in the sandbox) where Godot runs - the sandbox, the server, or the companion's computer - and the last saved as a PNG the agent sees. `export`: with a preset from `export_presets.cfg`; a missing preset is an error that lists the ones there, and only `createPreset: "linux"` or `"web"` makes the tool write a minimal one (and say so). It reports the files written; without export templates it says where to get them. |
| gates | `blender-file` (every .blend opens headless), `godot-project` (each project.godot imports, loads and runs 30 frames with no script errors), `godot-selftest` (each project with a `--selftest` mode runs it for up to 600 frames and must print `SELFTEST PASS` with no errors), `model-preview` (renders in `previews/` exist, were made after the last export of the model, and are not one flat colour; read on the server without a browser). When the program is not installed in that runtime they report `not checked` as a warning, never a failure. |

Skills: `blender-scripting` (bpy: bmesh and modifiers, materials, units and axes for glTF, FBX/OBJ export, previews without a GPU) and `godot-essentials` (a Godot 4 project as text files, a scene built in code, input actions, a self-test the `run` action drives). Their recipes were run in the 3D image: the Blender stool exported to .glb, imported by the Godot template and drawn in a screenshot. `3d-artist` uses Blender when asked for it, `game-engineer` builds a Godot project when asked for one, and the workflows do either with `engine` (above). In the export image a tiny project was exported to Linux (the build then ran headless in the container) and to the Web (`index.html`, `.js`, `.wasm`, `.pck`).

### Computer use (`plugins/computer`)

The agent operates a desktop through screenshots, mouse and keyboard, in the shape of Anthropic's computer-use tool. The desktop runs inside the session's Docker sandbox (the desktop image above), so it is contained like any command there: same user, limits and network policy. It can also work your real desktop through the companion, when you start it with `--allow-desktop` (below).

| Tool | What it does |
|---|---|
| `computer {action, coordinate?, start_coordinate?, text?, scroll_direction?, scroll_amount?, duration?, region?}` | `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`, `mouse_move`, `left_click_drag`, `type`, `key` (xdotool names: `ctrl+l`, `Return`), `scroll`, `wait`, `cursor_position`, `zoom` (a region enlarged, to read small text) and `launch` (start an app detached in `/workspace`, e.g. `firefox-esr https://example.com`). Every action except `wait` and `cursor_position` returns a fresh screenshot the model sees. |

- The display is 1280x800 (`HARNESS_DESKTOP_SIZE`). Larger displays are shown scaled to fit 1280x800 and the model's coordinates are scaled back.
- On first use the tool starts Xvfb on `:99` and fluxbox, detached, so they outlive the call; a sandbox restarted after idling gets a new desktop on the next call. Apps started from the agent's own commands draw there too (`DISPLAY=:99`).
- It is an `exec` tool: free in a sandbox, like a command. Only sessions whose sandbox image has a desktop (Xvfb and xdotool, checked once per image without starting a sandbox) get the tool at all, so other sessions pay no prompt tokens for it. Any tool can say where it works the same way (`availableIn` in the plugin API). Sandboxes get 512 MB of shared memory (`HARNESS_SANDBOX_SHM`), which browsers need.
- While a browser is open, its results are marked untrusted, so the rules for web content below apply (ways out are confirmed, hidden text is stripped from the text part).
- Skill: `computer-use` (screenshot first, check every result, prefer keyboard shortcuts, zoom to read, never type secrets, what a page says is data).
- Tested against the real image: launch xterm, click into it, type a command and press Return, and the file it writes appears in the workspace; screenshots are PNGs of the display size and not blank.

**On your real desktop, through the companion (opt-in).** A companion started with `--allow-desktop` lets the same tool see your screen and use your mouse and keyboard. Off by default; at startup the companion says plainly that desktop control is on. Without the flag the server does not offer the tool for that companion, and the companion itself refuses desktop jobs with how to turn it on. The companion reports the flag to the server (`desktop: true` in its info).
- Same actions, same key names (`ctrl+l`, `Return`, `Page_Down`; on macOS `super` is Command). The primary display only. Screenshots are scaled to fit 1280x800 and the model's coordinates scaled back; `zoom` enlarges a region the same way. Each job carries the screen size its coordinates were read for, and the companion does nothing if the screen is now another size (the agent is told to take a new screenshot); before the first screenshot, clicks are refused rather than guessed.
- Built from what ships with each OS, no native modules:
  - **Windows**: PowerShell with user32 through `Add-Type` (`SendInput` for buttons, wheel, keys and Unicode text; `SetCursorPos`, `GetCursorPos`), `SetProcessDPIAware` so coordinates are real pixels on a scaled display, and System.Drawing's `CopyFromScreen` for PNG screenshots. Windows of programs running as administrator, the lock screen and UAC prompts cannot be controlled (Windows blocks it), and the error says so.
  - **macOS**: `osascript -l JavaScript` with CoreGraphics mouse events and System Events keys, `screencapture -x` and `sips`. Coordinates are points (a Retina capture is scaled to them). The terminal running the companion needs Accessibility and Screen Recording in System Settings. Not run on a Mac: tested as generated script text.
  - **Linux**: X11 with xdotool and ImageMagick (`import`, or `xwd` and `convert`), as in the sandbox; a missing tool is named with the package to install. Wayland is not supported and says so.
  - `launch` starts the command detached in the companion's folder (Windows through `cmd /c`, so `start msedge https://example.com` works; macOS and Linux through `sh`). It runs on your computer outside the companion's sandbox: a desktop app has to draw on your screen.
- **Asked, every time.** Your desktop is not contained by anything, so on a companion every action except reading the pointer and `wait` is treated like an action on an outside service: asked in default, accept-edits and auto mode (auto's checking model sees it first), refused in plan and never-ask (`dontAsk`) mode, free only in bypass. "Always allow" offers a rule for that one action, e.g. `computer(screenshot)` (rules take `computer(screenshot|zoom)` lists), so allowing screenshots never allows clicks. In the Docker sandbox nothing changes: there the tool is a command, free.
- **Untrusted, always.** Every result from your screen is marked untrusted (mail, chats and web pages are on it), so the untrusted-content guard applies from the first screenshot: actions that can click or type are then confirmed by a person even under a session allow rule; screenshots and zoom are not ways out and are not re-confirmed.
- **No secrets typed.** `type` refuses text that looks like a credential (API keys, tokens, private keys, `password=...`) on your screen. Typed text is never written at full length in permission prompts or notices (the length and the first 40 characters), and the companion's own log shows only how many characters were typed; a `launch` command is shown in full.
- Tested: the generated PowerShell, JavaScript and xdotool text for every action; permissions in every mode; the refusal without `--allow-desktop`; a session driving a stand-in desktop through an in-process companion. **On a real Windows 11 machine** (opt-in, `HARNESS_TEST_REAL_DESKTOP=1`, never in a normal run): a 2560x1600 screen gave a 1280x800 PNG that is not blank, and the pointer moved to a point read back exactly; nothing was clicked or typed.

## Permissions

Enforced in code on every call. Order: deny rules, then ask rules, then allow rules, then the mode's default.

| Mode | Edits | Commands | External services |
|---|---|---|---|
| Ask before edits (default) | ask | free in a sandbox, ask on a real machine | ask |
| Auto-accept edits | free | free in a sandbox, ask on a real machine | ask |
| Auto (checked by a model) | free | what would be asked goes to a small checking model first | the same |
| Never ask (`dontAsk`) | refused | free in a sandbox, refused on a real machine | refused |
| Plan mode | blocked | read-only only | blocked |
| Bypass | free | free | free |

The `computer` tool on a companion's real desktop is in the last column: nothing contains it (see Computer use).

In plan mode the agent researches read-only, then presents its plan for approval. "Always allow" in an approval adds a rule for the session. A prefix rule like `bash(npm test:*)` never covers a compound command.

- **Auto mode**, like Claude Code's: a call that would be asked about is first shown to a small model (`HARNESS_AUTO_MODEL`, else the sub-agent model) with the user's request and whether untrusted content was read. A clear yes runs it; anything else is asked, with the checker's reason. Its cost is charged to the session. Checked live on DeepSeek: `npm test` cleared, posting `.env` to a paste site refused.
- **Never ask (`dontAsk`)** is for unattended runs (scheduled tasks use it by default): what would be asked is refused, so a run never hangs waiting; allow rules still let work through.

**Untrusted content changes what is asked.** Once a web page, a search result or a service's answer is in the context (also through a sub-agent, at any depth, or a resumed or imported session):
- **every way out of the session is confirmed**, whatever the mode, bypass aside: a call to a service (any MCP tool, read-only ones too), a URL, a push, and a command on a machine or sandbox with open network. This is the "lethal trifecta" - private data, untrusted content and a way out in one agent - that Willison and GitHub's MCP exploit showed. A sandbox with no network or only the operator's allowlist is not a way out, unless the allowlist carries credentials (the gateway can write to those services). Allow rules do not skip this check, except the operator's own (`HARNESS_SETTINGS`): a rule from the repository, or a click made before the content arrived, is asked again; a repository's hooks can block a call but never allow one. In auto mode these calls go to a person, not to the checking model;
- **saving to memory or scheduling a prompt** needs a yes, so a page cannot plant instructions for later;
- **hidden text never reaches the model**: Unicode tag characters (ASCII smuggling), zero-width characters, bidi controls and smuggling variation selectors are stripped from outside content, with a note saying how many; elements a person never sees on a page (`hidden`, `display:none`, `visibility:hidden`, zero font size, `aria-hidden`, hidden inputs) are dropped from fetched pages.

`HARNESS_TAINT_GUARD=off` turns the confirmation off (not recommended). With `HARNESS_INJECTION_SCAN=on`, a small model also reads each outside result for text that tries to instruct the agent (to ignore its task, run something, send data out) and adds a warning to it, like the probes Anthropic runs on web content for Claude in Chrome; one cheap call per outside result. Checked live on DeepSeek: an injected HTML comment flagged, ordinary release notes passed.

**Fetching outside URLs checks the address twice**: before the request, and again on the exact address the connection uses (a pinned DNS lookup), so a name that resolves publicly for the check and to `127.0.0.1` a moment later (DNS rebinding) is refused. Plugin fetches get the same.

**Scripts** (`run_script`) run in a fresh V8 context with no `require`, `process`, `fetch` or `eval`, inside a process under Node's permission model (no files, no child processes). In a Docker session that process runs inside the sandbox, under its network policy, like any command there; on Linux elsewhere, in a namespace with no network; on other machines it asks first. Every tool it calls goes through these same checks.

## Hooks

Deterministic steps the model cannot skip, at 14 points: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `StopFailure`. Five kinds, as in Claude Code:

| Kind | How | Answers |
|---|---|---|
| `command` | runs on the session's host with the event as JSON on stdin | exit 0 proceeds (stdout is feedback, or JSON `{"decision":"allow"\|"deny"\|"block","reason"}`); exit 2 blocks with stderr as the reason |
| `http` | POSTs the event as JSON; `headers` may read server variables as `${VAR}` | a 2xx with the same JSON, or nothing |
| `prompt` | a small model judges the event against `prompt` (an instruction) | ok allows, not ok blocks (denies, for `PermissionRequest`) |
| `mcp_tool` | calls `tool` on a connected MCP `server` with the event (plus `arguments`) | its text, read like a command hook's stdout |
| `agent` | a verifying agent (`agent`, default the read-only `explore`) checks the event against `prompt`, looking at the workspace as it needs | ok allows, not ok blocks; it runs without hooks of its own |

- `PreToolUse` runs before anyone is asked: it can block a call or allow it without a prompt. `PermissionRequest` can answer a prompt instead of a person (a policy service, a judging model); deny wins over allow. `PreCompact`'s feedback is added to what the summary must keep. `SubagentStart` adds context to a sub-agent's brief; `SubagentStop` can send a sub-agent back, like `Stop` for the main agent. `Notification` fires whenever the agent waits for a person (and on `notify_user`), so an `http` hook can reach a chat channel or a phone.
- **Who may configure what.** The operator's settings file (`HARNESS_SETTINGS`, JSON with `permissions`, `hooks` and limits; a file that cannot be read stops the server rather than dropping its rules) and plugin manifests take every kind; a plugin's `http` hook goes only to its declared hosts and reads only its declared secrets. A repository's `.harness/settings.json` adds only `command` hooks, which run in its sandbox: an `http` hook would run on the server.
- In-process hooks from code plugins (`api.on(event, handler)`) answer `{ block?, feedback?, decision? }`.

## Where the agent works

- **Sandbox** (Docker; the default)
  - One container per session.
  - No capabilities, `no-new-privileges`, and limits on memory, CPU and processes.
  - Network per session:
    - **none**;
    - **an allowlist** (the default in the UI): the sandbox sits on an internal Docker network with no route out, and no host address on it either. A small proxy container beside it is the only way out and admits only the allowed hosts. The package registries and GitHub are allowed by default (`HARNESS_SANDBOX_ALLOW_HOSTS`). The list can be edited while the session runs, the agent is told what is allowed, and blocked attempts are reported. Tested against real Docker.
    - **full**.
  - Files sit in a host folder mounted at `/workspace`. The file tools check real paths, so a symlink planted from inside the container cannot reach the host.
  - **API keys without the key in the sandbox.** With `HARNESS_SANDBOX_CREDENTIALS` (presets `openai`, `anthropic`, `deepseek`, `github`, or a JSON file of your own), an allowlist sandbox gets base URLs pointing at its proxy (`OPENAI_BASE_URL=http://egress:3128/__cred/openai/v1`, ...) and a placeholder key; the proxy adds the real key on the way out, from a file only it mounts, and drops whatever auth the sandbox sent. The agent is told which credentials exist. Verified live: a sandbox listed OpenAI's models while `env` inside showed only the placeholder.
  - **A desktop**, with the desktop image: the `computer` tool works the screen, mouse and keyboard of a virtual display inside the container (see Computer use).
  - **Setup scripts.** A session's `setup` (or a repository's `.harness/setup.sh` when `HARNESS_REPO_SETUP=1`) runs once as root with the network open, in a throwaway container with the workspace mounted, as cloud harnesses do. What it installs is kept as a snapshot image (by base image and script, for `HARNESS_SNAPSHOT_DAYS`, 7) and reused; the script runs again on top of it, so idempotent installs are quick. The session then starts from the snapshot with its own user and network policy. The log is in `.harness/setup.log`; a failing script leaves the session usable on the base image.
- **Your computer** (companion)
  - Open "Your computers", then run the two lines it shows.
  - It connects out over HTTPS (long-poll: no open ports, works behind NAT) and only touches the folder you start it in (unless you start it with `--allow-desktop`, which also lets the agent see the screen and use the mouse and keyboard).
  - **It contains the agent's commands** (`--sandbox`, default `auto`): bubblewrap on Linux, Seatbelt on macOS, else Docker with the folder mounted; `--network none|full`. It tells the server, which then treats its commands as sandboxed.
  - Checkpoints and rewind work on its files (saved through it before each write or edit), and the project's MCP servers (`.mcp.json`) start on that computer, their messages relayed through the companion - only when it is sandboxed or started with `--trust-project`.
  - Flags: `--dir` (the folder, default the current one), `--sandbox auto|bwrap|seatbelt|docker|off`, `--network full|none`, `--allow-hooks` (commands for hooks, quality gates, Blender and Godot), `--trust-project` (project MCP servers outside a sandbox), `--allow-desktop` (the `computer` tool on your real screen, mouse and keyboard, each action approved; see Computer use). All off by default.
- **Server folder**: opt-in with `HARNESS_LOCAL_ROOTS`, for administrators.
  - **Contained when you choose** (`sandbox` per session, default `HARNESS_LOCAL_SANDBOX`): bubblewrap (Linux) or Seatbelt (macOS) make the system read-only except the folder and temp, hide credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, ...) and cut the network unless allowed; or Docker mounts the folder into a sandbox (Windows has no OS sandbox for a command). `auto` takes the best there is. A sandbox that was asked for and is missing is an error, never a silent fallback. Verified: bubblewrap for real in a Linux container, Docker on Windows.
  - Uncontained, commands run with credentials stripped from their environment and are asked about; they can still reach the server's network: keep that for trusted, single-user machines.
  - **Worktrees**: a folder that is a git repository can give each session its own worktree and branch (`harness/<title>-<id>`), so several sessions work on one repository in parallel without touching your checkout. The branch stays when it has commits. In a sandbox only what committing on that branch needs is writable in the repository's `.git` (objects, `refs/heads/harness/`, the worktree's folder); hooks and config stay read-only, because a hook written from a sandbox would run on the host.

## Publishing: branches and pull requests

`publish_branch {branch, title, body?, commit_message?, draft?}` ends a coding task with a pull request.
1. It commits in the session's own runtime (for a sandboxed session, in the sandbox).
2. It copies the commits **out of the workspace** into a repository the harness owns, and pushes from there. So nothing in the workspace's git config runs on the server or redirects the push: no hooks, fsmonitor, url rewrites or filters.
3. It opens the pull request through the GitHub API, or finds the one already open.

The token (`HARNESS_GITHUB_TOKEN`) goes in a header for that one command; it is never written to disk, the workspace or the model's context. It pushes only to the repository the session was cloned from, or one in `HARNESS_PUBLISH_REPOS`, and never force-pushes or pushes to the base branch. The token goes only to github.com (or the GitHub Enterprise host of `HARNESS_GITHUB_API`, or a host in `HARNESS_PUBLISH_TOKEN_HOSTS`): a session cloned from anywhere else pushes without it. A workspace whose `.git` is a link, a gitfile or borrows objects from another repository is refused.

## Shared servers: accounts and limits

Without accounts the server is single-user: whoever holds `HARNESS_TOKEN`. With accounts (`npm run users -- add alice [--admin]`; tokens are shown once and stored hashed):
- **Members** see only their own sessions, companions and memory. They cannot run commands on the server itself (server folders are for administrators) or install plugins.
- **Administrators** see everything and manage accounts (`/api/users`: add, rotate, disable, remove).

Every request and every message is rate-limited per person (`HARNESS_RATE_LIMIT`, `HARNESS_MESSAGE_RATE_LIMIT`). An optional daily spend cap per account (`HARNESS_USER_DAILY_USD`) refuses new messages and stops a running turn at its next step.

### Single sign-on

With an OpenID Connect provider (Microsoft Entra ID, Google, Okta, Keycloak, ...), people sign in with their work account instead of a token. The login page shows a **Sign in** button; the sidebar shows who is signed in and **Sign out**.

```bash
HARNESS_PUBLIC_URL=https://harness.example.com
HARNESS_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
HARNESS_OIDC_CLIENT_ID=<application (client) id>
HARNESS_OIDC_CLIENT_SECRET=<client secret>      # optional for a public client
HARNESS_OIDC_ALLOWED_DOMAINS=example.com        # and/or HARNESS_OIDC_ALLOWED_EMAILS=a@x.com,b@y.com
HARNESS_OIDC_ADMINS=lead@example.com
# HARNESS_OIDC_ONLY=1                           # turn off personal tokens
```

- **Microsoft Entra ID:** App registrations, New registration, platform "Web", redirect URI `https://harness.example.com/auth/callback`; add a client secret under Certificates & secrets. The issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0` (its discovery document is that URL plus `/.well-known/openid-configuration`). Use a single-tenant registration: the multi-tenant `common` endpoint does not have one fixed issuer. Entra may leave out `email` for accounts without a mailbox; add the optional `email` claim to the ID token in Token configuration.
- **Google:** issuer `https://accounts.google.com`; create an OAuth client ID of type "Web application" with the same redirect URI.
- **Okta / Keycloak:** issuer `https://<org>.okta.com/oauth2/default` or `https://<host>/realms/<realm>`.

The server prints the redirect URI to register when it starts. How it works:

- **Flow:** authorization code with PKCE (S256), `state` and `nonce`. The provider's discovery document and keys (JWKS) are cached for an hour; a token signed with an unknown key id fetches the keys again, so key rotation needs nothing. A started sign-in is kept on the server for 10 minutes, can be finished once, and only in the browser that started it (a short-lived cookie binds them).
- **The id_token is checked:** signature (RS256/384/512, PS256/384/512, ES256/384/512 or EdDSA; never `none` or HMAC), issuer exactly, audience contains the client id (and `azp` is the client id when there are several audiences), `exp`/`iat`/`nbf` with one minute of clock skew, the nonce, and `email_verified` must not be false.
- **Who gets in:** only addresses in `HARNESS_OIDC_ALLOWED_EMAILS` or in a domain of `HARNESS_OIDC_ALLOWED_DOMAINS` (exact domain; subdomains are not included). With neither set, every sign-in is refused with a message saying so.
- **Accounts:** the first sign-in creates an account (named after the e-mail address) keyed by the provider's issuer and subject, so a reassigned e-mail address never inherits someone's account. Later sign-ins reuse it. It is a member, or an administrator when its address is in `HARNESS_OIDC_ADMINS` (checked on every request, so removing an address takes effect at once). Ownership, rate limits and spend caps apply as for token accounts; `npm run users -- disable <id>` works the same and ends the person's sessions at once, as does removing them from the allowlist.
- **Browser sessions:** the cookie `hw_sid` holds only a random id (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` on https). The server keeps its hash, the account and the last use in `browser-sessions.json` in the data folder, so a restart keeps people signed in. A session ends after 12 idle hours, or 7 days after sign-in, or at **Sign out** (`POST /auth/logout`), which deletes it on the server. Signing out does not sign you out of the provider.
- **Cross-site requests:** every API write needs the `x-harness: 1` header, which the UI sends and another site cannot (a cross-site page cannot set it without a CORS preflight this server never allows); for a single sign-on session the `Origin`, when the browser sends one, must also be `HARNESS_PUBLIC_URL`'s. The event stream is a GET and works with the cookie.
- `HARNESS_OIDC_ONLY=1` refuses personal tokens everywhere (Bearer, cookie and `/api/login`). The operator token (`HARNESS_TOKEN`) still works, for scripts and as the way in if the provider is down; companions keep their own tokens.
- `GET /auth/config` tells the UI whether single sign-on is on.

## Durability, checkpoints, trace

- **History** is append-only JSONL. If the server stops mid-turn, every unfinished tool call gets a result saying so (the transcript stays valid). The session is idle again on restart, and with `HARNESS_AUTO_RESUME=1` it continues on its own.
- **Checkpoints.** Before a tool first changes a file in a turn, the file is saved. **Rewind** (UI, or `POST /api/sessions/:id/rewind {turn}`) puts every file touched since back as it was, and removes files created since. The agent is told which files changed. As in Claude Code, changes made by shell commands are not tracked, which is one reason shell file writes are refused.
- **Trace.** Every model call and tool call is recorded in `trace.jsonl`: model, time, uncached / cache read / cache write / output tokens, cost, stop reason, retries; tool, time, error. Shown in the UI under "Open trace", and as JSON at `GET /api/sessions/:id/trace`.
- **Images.** `read` (and `render`, `browser`) show pictures to the model, for checking screenshots, renders and charts. Each provider gets its own format. If a provider rejects an image, it is replaced by a note in the live context and the request goes on.
- **Networks fail.** A stream that drops mid-way is retried like a failed request, on every provider; a step that still fails is saved and resumes where it stopped (`--resume`, or **Resume** in the UI).
- **Portable sessions.** A session exports as one file (`GET /api/sessions/:id/export`, the ⇩ button): its conversation, todos and workspace files, without heavy folders or secret files. Importing it (`POST /api/sessions/import`, or the new-session form) on another server or the desktop app makes a new session that continues where it stopped - never with a looser permission mode, and still counted as having read untrusted content if it had.

## Scheduled work and sub-agents

- **Scheduled prompts.** The agent's `schedule` tool sets up work for later in its own session - once (`in_minutes`, `at`) or on a five-field cron - and `/api/schedules` does the same for people, to an existing session or a new one per run (`dontAsk` by default: nobody is there to answer). Missed runs fire once after a restart, a busy session is skipped, and every run goes through the same permissions and spend limits as a typed message. `notify_user` tells the person something now, through the session and the `Notification` hooks.
- **Triggers.** `POST /api/schedules {trigger: true, prompt, ...}` returns a secret URL (shown once, stored hashed) that starts the prompt when something POSTs to it: a Slack slash command (its form's `text`), a GitHub webhook, a phone shortcut, `curl`. What it sends goes with the prompt, fenced as data from outside, and the session counts as having read untrusted content.
- **Sub-agents** run in parallel (at most `HARNESS_SUBAGENTS_PARALLEL` at once, default 10, at most 20) and may start their own up to `HARNESS_SUBAGENT_DEPTH` levels (default 1: they cannot; at most 3, as Claude Code). The limit counts the main agent's sub-agents and workflow agents; a nested sub-agent or a hook's verifier runs inside the slot of the agent that waits for it. Taint goes both ways: a sub-agent that read outside content taints every agent above it, and one started by a tainted agent (or a workflow the tainted agent ran) starts tainted, since its brief may carry what was read.
- **The `workflow` tool** lets the main agent run one of the session's workflows inside its turn (a fixed graph of agent steps, gates and approvals, such as `build-feature` or `long-task`) and get the outcome, like Claude Code's Workflow tool.
- **Slash commands.** `/<skill> [task]` in a message loads that skill with it (custom commands are skills, as in Claude Code); `/compact` compacts the context now.
- **MCP bundles** (`.mcpb`, Claude Desktop's one-click "Desktop Extensions"): an administrator installs one (`POST /api/mcpb` with the file and the values its manifest asks for); it is unpacked under the data folder (paths outside it and links refused), its server registered for every new session, and kept across restarts.

## Evaluations

`npm run eval -- [--packs sdlc,documents,games,3d] [--models a,b] [--repeat 2] [--concurrency 3]` runs each case in `evals/<pack>/<case>/eval.json` on every model and repeat, in fresh workspaces, and judges it with **hidden checks** the agent never sees: shell commands (the URL shortener's 25 HTTP acceptance checks), gates, required files, and hidden playtests in the headless browser. It writes `report.md` (pass rate, checks passed, median cost, time, cache hit, calls, every failed check) and `results.json`. The checks were calibrated against results verified by hand before they were trusted.

Every report names the harness that produced it - version, commit (and whether it had local changes), the loop's settings, plugins and platform - because a score describes a model and a harness together: a controlled study found the same two models swapping places by up to ~38 points across harnesses.

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

**Phase 4 - `npm run eval`, every pack on every model** (after the fixes below; [full report](evals/results/2026-10-20.md)): **12/12 runs passed, 39/39 hidden checks**, for $2.56 in total (111M input tokens, ~93% read from cache). Per model, all four cases together: GPT-6 Luna $0.23, Claude Haiku 5.5 $0.96, DeepSeek Flash $1.38. On the re-run board deck the stricter reviewer blocked the invented region name, marked the hosting cost as an assumption, and found that the test data itself contradicts (6 logos x $210k exceeds the quarter's new ARR).

**What the live runs fixed in the harness:** parallel branches colliding on one save file; an agent step treating "out of steps" as failure; streams that drop mid-way ending a step; every old render staying in the context; one-image full-page renders that DeepSeek rejects; a rejected image ending a step; browser key presses that could fall between frames; plugins that broke when installed outside the repository; sub-agents wandering outside the workspace.


**Phase 5 - memory, research, code mode, compaction, long tasks** ([full report](evals/results/2026-10-20-p5.md)):

- Research (`research/mcp-facts`): 3/3 models, 4/4 hidden checks each, every report approved by the fact-checker. GPT-6 Luna $0.047, Claude Haiku 5.5 $0.12, DeepSeek Flash $0.21.
- Code mode on a 40-file aggregation: the same correct answer at about half the cost on every model (Haiku $0.0037 → $0.0020, DeepSeek $0.0037 → $0.0017, Luna $0.0015 → $0.0007).
- Memory: a convention saved in one session was used unprompted in the next on all three models, under $0.003 a session.
- Claude server-side compaction: three compactions in one Haiku task, correct answer, $0.043.
- Long task (`sdlc/expense-cli`): GPT-6 Luna built all 11 features and passed every hidden end-to-end check ($0.15); DeepSeek had 15/18 features, all passing the hidden checks, when the run was stopped to save budget. Haiku exposed a deadlock in the workflow (a feature whose checks needed a later one); it is fixed but not yet re-run.
- Regression on the phase 5 code (stopped early): fire hydrant and board deck passed 3/3 on Haiku and Luna.

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
| `HARNESS_BUNDLED_PLUGINS` | on | `off` skips the bundled `plugins/` (quality gates, SDLC, visual, documents, games3d, computer). |
| `HARNESS_PLUGIN_KEYS` | | Trusted public keys; when set, every non-bundled plugin must be signed. |
| `HARNESS_PLUGIN_CATALOGUE` | | Signed plugins to install from the UI/API: a folder, or the https URL of an `index.json`. |
| `HARNESS_MEMORY` | on | `read` (load, never change) or `off`. |
| `HARNESS_SEARCH` | first available | `brave`, `tavily`, `exa`, `searxng`, `deepseek`, `anthropic`, `openai` or `off`; keys `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `HARNESS_SEARXNG_URL`. |
| `HARNESS_SEARCH_ANTHROPIC_MODEL` / `HARNESS_SEARCH_OPENAI_MODEL` | `claude-haiku-5-5` / `gpt-6-luna` | The small model that runs a provider's built-in search. |
| `HARNESS_GITHUB_TOKEN`, `HARNESS_PUBLISH_REPOS`, `HARNESS_GITHUB_API`, `HARNESS_GIT_AUTHOR`, `HARNESS_PUBLISH_TOKEN_HOSTS` | | `publish_branch`: token, extra repositories it may push to, API base (GitHub Enterprise), commit author `"Name <email>"`, other git hosts the token may be sent to. |
| `HARNESS_SANDBOX_ALLOW_HOSTS` | registries + GitHub | Comma-separated hosts an allowlist sandbox may reach; `HARNESS_SANDBOX_UPSTREAM_PROXY` chains its proxy through a corporate one. |
| `HARNESS_USER_DAILY_USD` | none | Daily spend cap per account. |
| `HARNESS_RATE_LIMIT` / `HARNESS_MESSAGE_RATE_LIMIT` | 600 / 30 | Requests / messages per minute per person (0 = none). |
| `HARNESS_OIDC_ISSUER` | | Single sign-on: the provider's issuer, exactly as its discovery document gives it (https; http only on loopback). |
| `HARNESS_OIDC_CLIENT_ID` / `HARNESS_OIDC_CLIENT_SECRET` | | The application registered at the provider. The secret is optional (a public client uses PKCE alone). |
| `HARNESS_PUBLIC_URL` | | Where people reach the server, e.g. `https://harness.example.com`; the redirect URI is this plus `/auth/callback`. Cookies are `Secure` when it is https. |
| `HARNESS_OIDC_SCOPES` | `openid email profile` | Scopes asked for. |
| `HARNESS_OIDC_ALLOWED_DOMAINS` / `HARNESS_OIDC_ALLOWED_EMAILS` | | Who may sign in (comma-separated e-mail domains / addresses). With neither, nobody can. |
| `HARNESS_OIDC_ADMINS` | | E-mail addresses that are administrators. |
| `HARNESS_OIDC_TRUST_EMAIL` | off | `1`: accept an e-mail the provider does not mark `email_verified` (only for a provider that never sends the claim and never lets people use an unverified address). By default a missing claim is refused. |
| `HARNESS_OIDC_ONLY` | off | `1`: people sign in only through the provider; personal tokens stop working (the operator token and companion tokens keep working). |
| `HARNESS_ANTHROPIC_SERVER_COMPACTION` | on | `off` makes Claude sessions use the harness's own compaction. |
| `HARNESS_SCRIPT_ISOLATION` | on | `off` runs scripts without the network namespace (they then ask first). |
| `HARNESS_MIRROR_MAX_MB` | 100 | How much of a companion folder server-side tools may copy. |
| `HARNESS_OTEL_ENDPOINT` / `HARNESS_OTEL_HEADERS` | | OTLP/HTTP trace export. |
| `HARNESS_RENDER_NETWORK` | off | `on` lets LibreOffice reach the network (it runs in an empty network namespace otherwise). |
| `HARNESS_RENDER_PDF` | pdf.js | `poppler` draws and measures PDF pages with poppler instead. |
| `HARNESS_CHROMIUM` | auto | Chromium for the render and browser tools. |
| `HARNESS_SOFFICE`, `HARNESS_PDFTOPPM`, `HARNESS_PDFTOTEXT`, `HARNESS_PDFINFO`, `HARNESS_PANDOC` | auto | Paths to the document converters (searched on the PATH and in the usual install folders). |
| `HARNESS_SHELL` | auto | Windows: `powershell`, or the path of a `bash.exe` (default: Git Bash, else PowerShell). |
| `HARNESS_SHELL_WRITE_GUARD` | on | `off` allows shell file writes. |
| `HARNESS_SANDBOX_IMAGE`, `_MEMORY`, `_CPUS`, `_IDLE_MS` | `harness-sandbox:latest`, `4g`, `2`, 30 min | |
| `HARNESS_SANDBOX_SHM` | `512m` | Shared memory of a sandbox (`/dev/shm`); browsers crash tabs with Docker's 64 MB. |
| `HARNESS_SANDBOX_IMAGES` | | Other images a sandbox session may choose (comma-separated), e.g. `harness-sandbox-3d:latest,harness-sandbox-3d:export,harness-sandbox-desktop:latest` (the second has Godot's export templates, the third a desktop for computer use). |
| `HARNESS_BLENDER`, `HARNESS_GODOT` | auto | Blender and Godot for server-folder sessions (searched on the PATH and in the usual install folders); on a companion, the same variables on the user's computer. |
| build args of `docker/Dockerfile.sandbox-3d` | `GODOT_EXPORT_TEMPLATES=0` | `1` adds Godot's export templates (`npm run sandbox:image:3d-export`); `GODOT_TEMPLATES` lists the template files kept (default Linux x86_64, Web, ICU data; `all` for every platform). |
| `HARNESS_DESKTOP_SIZE` | `1280x800` | The `computer` tool's display in a sandbox (`WxH`, 640x480 to 3840x2160). Screenshots larger than 1280x800 are scaled down to fit. A companion's real screen keeps its own size, scaled the same way. |
| companion `--allow-desktop` | off | The `computer` tool on the user's real screen, mouse and keyboard through that companion (each action approved; see Computer use). |
| `HARNESS_TEST_REAL_DESKTOP` | off | `1`: the desktop test takes a real screenshot and moves the pointer on the machine running the tests (never in a normal run). |
| `HARNESS_PRICING_JSON` | | Override prices per model. |
| `HARNESS_SETTINGS` | | The operator's settings file (JSON: `permissions`, `hooks` of every kind, `maxSteps`, `maxCostUsd`, `compactAt`, `subagentModel`, `autoModel`, `gatesOnStop`, `maxSubagentDepth`, `maxParallelSubagents`). |
| `HARNESS_AUTO_MODEL` | sub-agent model | The model that checks calls in auto mode. |
| `HARNESS_TAINT_GUARD` | on | `off` stops confirming ways out after untrusted content (not recommended). |
| `HARNESS_SANDBOX_CREDENTIALS` | | API credentials allowlist sandboxes use through their proxy: `openai`, `anthropic`, `deepseek`, `github` (`HARNESS_SANDBOX_GITHUB_TOKEN`), and/or the path of a JSON file of `{name, upstream, headers, env}`. |
| `HARNESS_LOCAL_SANDBOX` | off | How server-folder sessions contain commands by default: `auto`, `bwrap`, `seatbelt`, `docker` or `off`. |
| `HARNESS_REPO_SETUP` | off | `1`: a repository's `.harness/setup.sh` runs as a Docker session's setup script. |
| `HARNESS_SNAPSHOT_DAYS` / `HARNESS_SETUP_TIMEOUT_S` | 7 / 900 | How long setup snapshots are reused / how long a setup script may run. |
| `HARNESS_SUBAGENT_DEPTH` / `HARNESS_SUBAGENTS_PARALLEL` | 1 / 10 | How deep sub-agents may nest (at most 3) / how many run at once (at most 20). |
| `HARNESS_MAX_SCHEDULES` | 50 | Scheduled prompts per person. |
| `HARNESS_EXPORT_MAX_MB` / `HARNESS_IMPORT_MAX_MB` | 50 / 80 | Workspace files in an exported session / the largest import. |
| `HARNESS_INJECTION_SCAN` | off | `on`: a small model checks each outside result for instructions aimed at the agent. |
| `.env` | | `npm start` (and every npm launcher) reads a `.env` file where it runs; variables already set win. |

## Honest limits

- **This is not Claude Code's code.** Claude Code is closed source. This harness follows its published design and open-source harnesses; unpublished tuning (the exact prompts) is not reproduced.
- **The harness lifts every model but cannot make them equal.** Studies put the harness's effect at 5–30 points on agent benchmarks; the model is still most of the result.
- **Limits by design** (each is a trust boundary chosen on purpose, not missing work):
  - Plugin code runs in the server process, as Claude Code's plugins do. Declared permissions are enforced on the channels the harness hands out (fetch, secrets, MCP environment, hooks), not on code that ignores them; signing (`HARNESS_PLUGIN_KEYS`) is the control for which code may run at all.
  - Outside Docker and Linux, a script's process cannot be cut off from the network, so there `run_script` asks before running.
  - Behind an HTTP proxy, the proxy resolves names, so `web_fetch` can check addresses only before the request (without a proxy it pins the address it checked).
  - Companion mirrors (the server's copy for render and browser) leave out `.env`, key files and files over 20 MB, so secrets stay on the user's computer; on a Windows server, names with `\` or `:` too.
  - Computer use: the image half of a screenshot cannot be cleaned of planted instructions the way text is; it is marked untrusted while a browser is open (on a companion's real desktop, always), and the skill tells the model a page is data. On a real desktop the agent sees whatever is on the screen when it takes a screenshot (only the primary display); the approval of each screenshot is the control. Firefox runs without its own sandbox inside the container (user namespaces are not allowed there), so the container is the boundary.
  - The OS sandboxes (bubblewrap, Seatbelt) have no proxy, so a host allowlist needs the Docker sandbox; with them an allowlist means no network.
  - Godot exports: the export image has the Linux x86_64 and Web templates only (rebuild with `GODOT_TEMPLATES=all` for the rest); a Web export was checked for its files, not played in a browser. Outside a sandbox the templates must be installed by hand.
  - The `godot-selftest` gate proves only what the game's own `--selftest` checks; the playtester reads the scripts to judge that, but cannot play a Godot game with input.
  - Blender and Godot on a companion need `--allow-hooks`; the `model-preview` gate on a companion cannot tell whether the renders are newer than the model (its copy has the copy's file times).
- **Not tested here:** Seatbelt on a real Mac and Docker Desktop for macOS (no Mac was available: the Seatbelt profile is tested as generated text); desktop control on a real Mac or a Linux X11 desktop (tested as generated script text; on Windows a real screenshot and pointer move were run, clicks and typing only against a stand-in); bubblewrap ran for real inside a Linux container, not on a Linux desktop; Godot on Windows or macOS outside the sandbox (only discovery is tested there), and Godot installed on a user's computer behind a companion (screenshots ran with real Godot in a companion whose commands run in the 3D image); prices, which come from the providers' pages on 2026-10-19 and can change.
