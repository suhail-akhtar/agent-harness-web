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
// index.mjs — runs in the server (trusted plugins only)
import { defineTool } from 'harness-web/src/plugins/api.ts';
export default {
  name: 'acme',
  setup(api) {
    api.registerTool(defineTool({ name: 'acme_status', description: '...', parameters: { type: 'object', properties: {} }, kind: 'read', run: async () => 'green' }));
    api.registerGate({ name: 'acme-no-todo', description: '...', run: async ({ host }) => ({ pass: true, summary: 'ok' }) });
    api.on('PreToolUse', ({ input }) => /--force/.test(String(input?.command)) ? { block: true, feedback: 'no force-push' } : undefined, 'bash');
    // also: registerModel, registerProvider, registerAgent, registerSkills, registerMcpServer, log
  },
};
```

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
- **Images.** `read` on a png/jpg/gif/webp shows the picture to the model, for checking screenshots, renders and charts. Each provider gets its own format.

## Measured (2026-10-20)

**Phase 1 validation** (`/tmp`-style scratch run, local workspace). One task needed all of these at once:

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
| `HARNESS_BUNDLED_PLUGINS` | on | `off` skips the bundled `plugins/` (quality gates, SDLC). |
| `HARNESS_SHELL_WRITE_GUARD` | on | `off` allows shell file writes. |
| `HARNESS_SANDBOX_IMAGE`, `_MEMORY`, `_CPUS`, `_IDLE_MS` | `harness-sandbox:latest`, `4g`, `2`, 30 min | |
| `HARNESS_PRICING_JSON` | | Override prices per model. |

## Honest limits

- **This is not Claude Code's code.** Claude Code is closed source. This harness follows its published design and open-source harnesses; unpublished tuning (the exact prompts) is not reproduced.
- **The harness lifts every model but cannot make them equal.** Studies put the harness's effect at 5–30 points on agent benchmarks; the model is still most of the result.
- **Not built yet:**
  - packs beyond software delivery: documents and presentations, 3D and games (Phase 3);
  - evaluation suites per pack (Phase 4);
  - background compaction;
  - per-host network allowlists in the sandbox (all or nothing);
  - checkpoints and project MCP servers on companion sessions;
  - OpenTelemetry export;
  - multi-user accounts (one access token);
  - plugin signing and a catalogue (Phase 4).
- **Not tested here:**
  - the full sandbox image (this environment's proxy blocks Debian packages, so tests used a plain Node image);
  - prices, which come from the providers' pages on 2026-10-19 and can change.
