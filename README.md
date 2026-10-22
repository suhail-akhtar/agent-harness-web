# Harness Web

An agent harness that is also a framework. You give it requirements and it works in a workspace until the job is done: it plans, edits, runs, tests, fixes what fails and reports. It remembers what matters across sessions, researches the web with citations it checks, builds long projects feature by feature, and can publish its work as a pull request. You extend what it can do with **plugins**: tools, models, providers, sub-agents, skills, MCP services, quality gates, workflows, search backends and hooks. All of it goes through the same registry the built-ins use.

It is tuned and tested on three cost-efficient models: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** (`deepseek-flash`) and **GPT-6 Luna**. The operator can add any model behind an OpenAI-compatible server (Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, Azure OpenAI, Gemini) without code (see [Models and providers](#models-and-providers)), and plugins can add more.

**Picking the project up?** Read [docs/HANDOFF.md](docs/HANDOFF.md): its purpose, what is built, the results, how to run it on your own machine, and the next steps.

```
              ┌──────────────── browser UI / CLI / your code (createHarness) ───────────────┐
              │                                                                               │
 Registry ◀── built-ins + plugins (tools · models · providers · agents · skills · MCP · gates · hooks)
              │                                                                               │
 Session ──▶ Agent loop ──▶ Provider (Claude / OpenAI / DeepSeek / OpenAI-compatible)         │
              │   └─▶ tools ──▶ Host: Docker sandbox · server folder · your computer (companion)
              └── history (append-only) · checkpoints · trace · recovery after restart        │
```

Screenshots of real sessions (a sandbox task with tests and gates, approvals, computer use, background work, workflows) are in [docs/screenshots](docs/screenshots); `node scripts/screenshots.mjs` makes them again against a running server.

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
npm run cli -- --output json --max-steps 60 --max-cost 0.50 --max-minutes 20 --dir ./project "Fix the failing test"
```

- `--output json` prints one JSON object on stdout when the run ends (progress goes to stderr): `reason` (`done`, `max_steps`, `budget`, `time`, `refusal`, `max_tokens`, `aborted`, `error`), `exitCode`, `text` (the agent's final reply), `sessionId`, `cost`, `tokens` (`input`, `uncached`, `cacheRead`, `cacheWrite`, `output`), `cacheHit` (0-1), `modelCalls`, `toolCalls`, and `error` when it failed.
- **Exit codes** say how the run ended, with or without `--output json`: 0 done, 1 error, 2 bad arguments, 3 step limit, 4 spend limit, 5 time limit, 6 the model refused, 7 cut off at the output limit, 130 interrupted.
- `--max-steps`, `--max-cost` (USD) and `--max-minutes` (per turn) set `HARNESS_MAX_STEPS`, `HARNESS_MAX_COST_USD` and `HARNESS_MAX_TURN_MINUTES` for the run; an operator settings file (`HARNESS_SETTINGS`) still wins.

As a library:

```ts
import { createHarness } from './harness-web/src/index.ts';
const h = await createHarness({ dataDir: './data', plugins: ['./my-plugins'] });
const s = await h.sessions.create({ model: 'claude-haiku-5-5', runtime: { kind: 'local', network: 'none', path: '.' } });
s.subscribe(0, ({ event }) => { if (event.kind === 'text_delta') process.stdout.write(event.text); });
await s.send('Fix the failing tests');
```

## Models and providers

Three providers are built in: Anthropic (Messages API, server-side compaction and context editing), OpenAI (Responses API) and DeepSeek (Chat Completions). A model whose provider has no key on the server is shown greyed out.

**Any OpenAI-compatible server, configured by the operator.** List the models in `HARNESS_MODELS_JSON` (a JSON array, or `{ "models": [...] }`) or in a file named by `HARNESS_MODELS_FILE`; each appears in the model picker and works with every tool, sub-agent and workflow. Keys stay in the server's environment: an entry names the variable that holds its key (`apiKeyEnv`), never the key. A malformed entry stops the server at start with what is wrong.

```json
{ "models": [
  { "id": "local-qwen", "label": "Qwen 2.5 7B (Ollama)", "preset": "ollama", "model": "qwen2.5:7b", "contextWindow": 32768, "maxOutput": 4096 },
  { "id": "vllm-llama", "preset": "vllm", "baseUrl": "http://gpu-box:8000/v1", "model": "meta-llama/Llama-3.3-70B-Instruct", "contextWindow": 131072 },
  { "id": "lmstudio", "preset": "lmstudio", "model": "qwen2.5-coder-14b-instruct" },
  { "id": "or-sonnet", "preset": "openrouter", "model": "anthropic/claude-sonnet-4.5", "images": true, "prices": { "input": 3, "output": 15, "cacheRead": 0.3 }, "headers": { "HTTP-Referer": "https://harness.example.com" } },
  { "id": "together-qwen", "preset": "together", "model": "Qwen/Qwen2.5-72B-Instruct-Turbo", "prices": { "input": 1.2, "output": 1.2 } },
  { "id": "groq-llama", "preset": "groq", "model": "llama-3.3-70b-versatile", "contextWindow": 131072, "prices": { "input": 0.59, "output": 0.79 } },
  { "id": "azure-gpt", "preset": "azure", "baseUrl": "https://my-resource.openai.azure.com", "azure": { "deployment": "gpt-4o-prod", "apiVersion": "2024-10-21" }, "images": true },
  { "id": "gemini-flash", "preset": "gemini", "model": "gemini-2.5-flash", "contextWindow": 1048576, "images": true, "prices": { "input": 0.3, "output": 2.5 } }
] }
```

| Field | Default | |
|---|---|---|
| `id` | (required) | The harness's id for the model (what sessions pick). |
| `model` | `id` | The name sent to the server (Azure: the deployment). |
| `label` | `id` | Shown in the picker. |
| `preset` | | `ollama`, `vllm`, `lmstudio`, `openrouter`, `together`, `groq`, `azure`, `gemini` or `openai`: fills in the base URL, key variable and the quirks below; every field can still be given. |
| `baseUrl` | from the preset | The API root before `/chat/completions` (`http://localhost:11434/v1`). Azure: the resource URL. |
| `apiKeyEnv` | from the preset | The environment variable with the key (`OPENROUTER_API_KEY`, `TOGETHER_API_KEY`, `GROQ_API_KEY`, `AZURE_OPENAI_API_KEY`, `GEMINI_API_KEY`). None: a local server that needs no key (the model is available without one). |
| `contextWindow` / `maxOutput` / `compactAt` | 32768 / 4096 / 60% of the window | Tokens. |
| `prices` | 0 | USD per million tokens: `input`, `output`, `cacheRead` and `cacheWrite` (both default to `input`). Spend caps and the cost shown use them. |
| `tools` | `true` | `false` for a model or server without function calling: it is sent no tools and answers without acting. |
| `images` | `false` | The model accepts images (screenshots, renders) as `image_url` parts. |
| `maxTokensField` | `max_tokens` | `max_completion_tokens` (OpenAI's newer models, Azure, Groq) or `none`. |
| `auth` | `bearer` | A header name instead, e.g. `api-key` (Azure). |
| `azure` | | `{ "deployment", "apiVersion" }`: Azure's deployment URL form `{baseUrl}/openai/deployments/{deployment}/chat/completions?api-version=...`. For Azure's v1 form use `baseUrl` `https://<resource>.openai.azure.com/openai/v1` with `query`. |
| `query` / `headers` / `body` | | Added to every request's URL / headers / JSON body (e.g. `temperature`, OpenRouter's `provider` routing). |
| `promptCacheKey` | off (on for `openai`, `azure`) | Send the session's `prompt_cache_key` (servers that route caches by key). Off by default: some servers reject fields they do not know. |
| `streamUsage` | `true` | Ask for token usage in the stream (`stream_options`); turn off for a server that refuses it. |
| `reasoningEffort` | off (on for `openai`, `gemini`) | Send the session's effort as `reasoning_effort`. |
| `replayReasoning` | off | Send a reply's reasoning back with its tool calls as `reasoning_content` (servers that require it). |
| `stream` | `true` | `false` reads one JSON answer instead of a stream. |
| `parallelToolCalls` | off | Send `parallel_tool_calls: true`. |

What the provider handles: streamed text and tool calls (arguments split across many chunks, calls without an `index`, every call numbered 0 with its own id, a `stop` finish that carries calls); reasoning in `reasoning_content`, in `reasoning` (OpenRouter, Ollama) or inline as `<think>...</think>` (shown as reasoning, kept out of the answer); usage with cached tokens (`prompt_tokens_details.cached_tokens`, DeepSeek-style `prompt_cache_hit_tokens`, cache writes where reported), and, when a server reports no usage, an estimate (about 4 characters a token) so compaction still happens in time. A server that refuses `tools` gets one clear error naming the model and the fix (`"tools": false`), not a retry loop; a refused key names the variable to check; a 404 names the URL and model; 429 and 5xx are retried like the built-in providers.

- **Ollama:** its default context is small; start it with `OLLAMA_CONTEXT_LENGTH` at least the `contextWindow` you configure (the harness's system prompt and tool schemas alone are several thousand tokens). Pick a model with tool support (`ollama show <model>` lists `tools` under capabilities).
- **Tested** against local stand-ins for each variation (Azure's URL and header, no usage, split tool-call deltas, a server that rejects tools, non-streaming, reasoning in all three forms) and **against a real Ollama** in Docker (`test/compat-ollama.test.ts`): a whole harness session on `qwen2.5:0.5b` (a 400 MB model, temperature 0) streamed a plain answer with real token counts, then called `read` on a file, the loop ran it, and the model answered with the code word from the file. The test runs when Docker has the `ollama/ollama` image (`HARNESS_TEST_OLLAMA=1` pulls it, several GB; `HARNESS_TEST_OLLAMA_URL` uses a running server; `HARNESS_TEST_OLLAMA_MODEL` picks another model) and removes its container and model volume afterwards.

## The loop

`src/core/agent.ts` runs one loop that the model drives: call the model, run the tools it asked for, append the results, and repeat until it answers without a tool call.

- **Tool scheduling.** Read-only calls in one turn run in parallel; everything else runs in order.
- **Limits.** The loop stops at a step limit, a session spend limit, a time limit per turn (`maxTurnMinutes`, `HARNESS_MAX_TURN_MINUTES`; off by default), a refusal, or when the user presses Stop. Each has its own end reason (`max_steps`, `budget`, `time`, `refusal`, `aborted`).
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
| **Prompt caching** | Built in from the start. The system prompt (~560 tokens) is identical for every session (an output style, chosen when a session is made, appends to it and stays fixed for that session). Tools never change mid-session and are sorted by name. History only grows; reminders are appended. Claude gets one explicit breakpoint plus automatic tail caching. OpenAI gets `prompt_cache_key` and replayed encrypted reasoning. DeepSeek's prefix cache is kept byte-identical. Measured: **81–99% of input tokens read from cache** in every validation run. |
| **Deferred MCP schemas** | Past 10 MCP tools, the session declares only `tool_search` + `tool_call`. Schemas are fetched on demand and appended, so the cache keeps hitting. With 30 tools, the MCP part of the prompt went from ~1,240 to ~160 tokens; real servers' schemas are far larger. |
| **Skills** | One line per skill sits in context. The full instructions load only when the task needs them. They are never cleared (by the harness or by Claude's server-side clearing), and after the harness's own compaction the three most recently loaded skills are re-attached (up to 4K tokens each, 8K in all), as Claude Code does. |
| **Sub-agents** | Exploration and review run in their own context and return a report, not their transcript. They can run on another model (`HARNESS_SUBAGENT_MODEL`, or a `model:` in the agent definition). |
| **Context clearing** | Old tool results are cleared in large batches (never the todo list, sub-agent reports or loaded skills). Claude does it on the server (context editing, so the transcript stays append-only); OpenAI and DeepSeek do it in the harness, only past 60% of the compaction threshold and only if at least 12K tokens are freed. The stored history keeps everything. |
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
  "permissions": { "network": ["api.example.com"], "secrets": ["GITHUB_TOKEN"], "vault": ["acme-*"] }
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
    // registerWorkflow, registerVaultRotation, workspacePath(host, p), dataDir (the plugin's own folder on the server,
    // outside every workspace), log; and close() on the plugin for teardown. A tool can name what
    // its permission rules match with ruleSubject(input), e.g. "<host> <command>" for ssh_exec.
  },
};
```

**Plugins that serve HTTP and drive sessions** (webhooks, chat integrations, alert ingestion). Declared in the manifest like network and secrets - `"permissions": { "routes": true, "sessions": true }` - and refused otherwise:

```ts
api.registerRoute({ method: 'GET' | 'POST', path, auth: 'token' | 'none', handler: (req: { method, path, query, headers, body: Buffer, ip }) => Promise<{ status, headers?, body?: string | Buffer | object }> })
api.events.subscribe((e: { sessionId, owner?, title, event: HarnessEvent }) => void): () => void   // needs "sessions"
api.sessions.start({ title, owner?, model?, mode?, runtime?, prompt?, instructions?, workflow?: { name, input }, untrusted? }): Promise<{ id }>
api.sessions.send(id, text, { untrusted? }): Promise<void>
api.sessions.respond(id, requestId, { decision: 'approve' | 'reject' | 'allow' | 'deny' | 'answer', feedback?, answer?, by }): Promise<boolean>
api.sessions.get(id): { id, title, owner?, status } | undefined
api.changes.record({ kind, target, service?, env?, summary, by, at?, ref?, source? }) / api.changes.query({ since, until?, service?, env?, target?, limit? })
api.lease(name): Promise<boolean>   // run a server-side loop only when true
api.vault?.list() / api.vault?.reveal(name, purpose)   // needs permissions.vault
```

- **Routes** are served at `/api/plugins/<plugin>/<path>`, before sign-in (callers are other systems), rate-limited per address like triggers (`HARNESS_ROUTE_RATE_LIMIT`, default 600 a minute), bodies up to 1 MB, the raw body handed over so signatures can be checked over it. `auth: 'token'`: the harness makes a random token per route path and keeps only its SHA-256 (`<data>/plugin-routes.json`); an administrator sees it **once** at `GET /api/plugin-routes` (with each route's URL; `HARNESS_PUBLIC_URL` sets the base), and gets a new one with `POST /api/plugin-routes/<plugin>/<path>/rotate` (the old one stops working). Callers send it as `?token=` or the `x-harness-route-token` header; it is compared in constant time and never passed to the handler. `auth: 'none'`: every request reaches the handler, and **the plugin must verify the caller itself** (Slack's signing secret, GitHub's `X-Hub-Signature-256`). A handler's error is logged and answered with a plain 500.
- **Events**: every session's events, harness-wide (requests, questions, notices, turn ends, workflow and task events; not the text deltas). A handler that throws or rejects is logged; the session never notices.
- **Sessions**: `start` makes a session owned by `owner` (default the operator's), unattended by default (`dontAsk`), in a server folder of its own unless `runtime` says otherwise, and counted against the owner's running-session limit; with `untrusted: true` the session counts as having read untrusted content (its workflow agents too), the `prompt` is fenced as outside data after the plugin's own `instructions`, and every `workflow.input` value is fenced: hidden characters removed, tags that could end the fence or pose as the harness's neutralised, inside `<outside_data source="the <plugin> plugin">`. `send` with `untrusted` fences the same way. **Anything a route passes on to an agent must go this way.** A plugin may send to and answer for the operator's sessions, sessions a plugin started, and those of the accounts the operator lists for it in `HARNESS_PLUGIN_SESSION_OWNERS` (`{"integrations": ["usr_...", "*"]}`). `respond` answers a pending request on someone's behalf: `by` (who answered, required) is written with the plugin, session, request, tool and decision to `<data>/plugin-actions.jsonl` (as are `start` and `send`), the session shows "Approved by ... through the X plugin", the decision must fit the request (`allow`/`deny` a permission request, `approve`/`reject` an approval or a plan, `answer` a question), and allowing a tool call a deny rule of the session covers is refused. It returns false when there is no such pending request.
- **Changes**: the framework's change journal (below).
- **Leases**: with several servers on one data folder, `lease(name)` is true only on the server holding the plugin's lease of that name (another takes over when it stops); on one server always true. It is false where background work is off - `HARNESS_PLUGIN_LOOPS=off`, `createHarness({ backgroundWork: false })`, which the eval runner and the CLI use (a run must not start investigations of its own), and the test runner's default.
- **The vault from server code** (a webhook's signing secret, a bot token; no session around): operator-scope entries only. `list()` gives the names and metadata of those the manifest's `permissions.vault` globs cover, each with whether it is granted; `reveal()` reads one only when an administrator also put `plugin:<name>` on the entry's allow list (`POST /api/vault/entries/<name>/allow {"allow": ["plugin:integrations"]}`) - refused by default, never a user- or session-scope entry, every read and refusal in the vault's audit log as `plugin:<name>` with the purpose. A value read this way is replaced by `[vault:<name>]` in whatever the plugin passes to `sessions.start`, `send` and `respond`.

**The change journal** (`src/ops/changes.ts`): one timeline of what changed on the systems the harness operates, at `<data>/changes.jsonl` (outside every workspace; appends under the file's lock, so servers sharing the data folder can all write it; trimmed to the newest half past `HARNESS_CHANGES_MAX_MB`, default 20). A change is `{kind: deploy | k8s-apply | rollout | rollback | iac-apply | ci-run | commit | config | restart | runbook | scale | other, target, service?, env?, summary, by, at?, ref?, source?}`. Tools record through `ctx.services.changes` (`by` and `source` default to the session's owner and the session); plugin server code through `api.changes`. The devops tools record every change they make, failed ones marked; aiops records `service_control` and runbook runs and accepts CI/CD webhooks (below).

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

**Declared permissions are enforced on the channels the harness hands out.** `permissions.routes` and `permissions.sessions` are the only way to `registerRoute`, `api.sessions` and `api.events`. A plugin's `permissions.secrets` are the only secrets `api.secret(name)` returns, and the only `${VAR}`s its MCP servers' configuration expands; an undeclared secret expands to nothing. `api.fetch` reaches only the hosts in `permissions.network`, with redirects re-checked; a private address needs an exact entry. Its tools' `ctx.services.vault` reveals only the key vault entries `permissions.vault` names (globs); any other is refused and audited (see [Key Vault](#key-vault)). MCP servers never inherit the server's environment. Before this, they received every provider key on the machine. Plugin code still runs in the server process, so code that ignores these channels is not contained: that is what signing and review are for.

**Trust.** Plugins from `HARNESS_PLUGINS` are the operator's and are trusted. Their code runs in the server, and `${VAR}` in their MCP configuration expands from the server's environment, so secrets never enter a repository or the model. A workspace can contribute only declaratively:

| Workspace file | What it adds |
|---|---|
| `.harness/skills/*/SKILL.md` (and `.claude/skills/*/SKILL.md`) | Skills |
| `.harness/agents/*.md` (and `.claude/agents/*.md`) | Sub-agents |
| `.harness/settings.json` | Permission rules and hooks |
| `.harness/settings.local.json` | The same, personal (gitignored); stacked after `settings.json`, trusted alike |
| `AGENTS.md` / `CLAUDE.md` / `HARNESS.md`, `*.local.md`, the same in subdirectories | Instructions (see [Instructions, settings and output styles](#instructions-settings-and-output-styles)) |
| `.harness/output-styles/*.md` (and `.claude/output-styles/*.md`) | Output styles a new session can name |
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
| `agent` | Runs a sub-agent (`agent`, `prompt`, optional `model`, `effort`) in a fresh context. Its report is kept as `{{state.<node>}}`; with `outputs`, it also reports declared state fields in a JSON block. | the first `decide` word found in the report, e.g. `APPROVE` / `REQUEST_CHANGES`; `invalid-output` when its JSON block is missing or mistyped and `next` names it |
| `gate` | Runs quality gates (`gates: "applicable"` or names). On failure the evidence becomes `{{feedback}}` for the next step. | `pass`, `fail`, `exhausted` (after `maxFailures`) |
| `approval` | Shows a person a message and files; they approve, or send it back with what to change. | `approve`, `reject` |
| `parallel` | Runs its `branches` at once. | the first negative branch outcome (`REQUEST_CHANGES`, `REJECT`, `FAIL`…), else `all` |
| `branch` | Routes on a rendered `value`, e.g. `{{input.approval}}`, or on a condition `when`, e.g. `state.failures > 2`. | the value; `true` / `false` for `when` |
| `map` | Runs its `node` (an agent, shell or code step) once per item of `over`, at most `concurrency` at once (default 4); `{{item}}`, `{{item.x}}` and `{{index}}` are filled in. Results go to the list field named by `collect`, in item order. | `all`, the first negative item outcome, or `fail` when an item failed and `next` names it (otherwise the run fails) |
| `shell` | Runs a command. Every `{{...}}` value in it goes in quoted as one argument (bash or PowerShell quoting), so an input, an agent's output or a map item cannot add commands. A workspace workflow with a shell node loads only where project commands are trusted. | `ok`, `fail`, or `exit-N` for exit code N when `next` names it |
| `code` | Runs a function. Plugins only, never from a workspace. | what it returns |
| `end` | Finishes as `success` or `failed`. | |

`next` is a node id, or `{ "on": { "<outcome>": "<node>" }, "default": "<node>" }`. Templates: `{{input.x}}`, `{{state.<node>}}`, `{{state.<field>}}` (dotted paths reach inside: `{{state.plan.title}}`; lists and objects render as JSON), `{{feedback}}`. A graph is checked before it runs (missing nodes, unreachable nodes, branch rules, state declarations, writes and conditions). Loops are bounded by `maxAgentRuns` and 200 steps; every map item counts as a step and every agent item as an agent run, and a map that would pass either cap fails before it starts anything.

**Typed state.** A workflow can declare fields under `state`, each with a `type` (`string`, `number`, `boolean`, `list`, `object`), an optional `initial` value and a `reducer` that says how a write combines with what is there: `replace` (the default), `append` (lists: a list adds its items, anything else is one item), `merge` (objects, shallow), `sum` (numbers). Reducers keep parallel branches and map items from overwriting each other. Nodes write with `writes: { "<field>": "<template>" }`, where `{{output}}` is the node's own output (an agent's report, a command's stdout, a map's result list); a write of the wrong type fails the node and changes nothing. An agent node with `outputs: ["<field>", ...]` is asked to end its report with a fenced `json` block holding those fields. The values are saved in the run record after every step (`values` in `runs/<id>.json`), so they survive a resume.

**Conditions** (`when`) are a small language, parsed and never evaluated as code: `state.x` / `input.x` / `item` / `index` references with dotted paths, numbers, quoted strings, `true` / `false` / `null`, `== != > >= < <=`, `&&` / `and`, `||` / `or`, `!` / `not`, parentheses, `len(x)` and `contains(list or text, value)`.

**Fan-out.** A `map` node saves each finished item's result as it goes; a stopped or failed run resumes with only the unfinished (or failed) items. Each item shows in the history as `<map>[<index>]`.

```json
{
  "name": "review-files", "description": "Review each changed file, then fix if there is much to fix", "start": "list",
  "state": {
    "files":    { "type": "list" },
    "findings": { "type": "number", "reducer": "sum" },
    "reviews":  { "type": "list" }
  },
  "nodes": {
    "list":   { "type": "agent", "prompt": "List the files changed on this branch.", "outputs": ["files"], "next": "review" },
    "review": { "type": "map", "over": "{{state.files}}", "concurrency": 3, "collect": "reviews",
                "node": { "type": "agent", "agent": "code-reviewer", "prompt": "Review {{item}} only.", "outputs": ["findings"] },
                "next": "triage" },
    "triage": { "type": "branch", "when": "state.findings > 2", "next": { "on": { "true": "fix", "false": "done" } } },
    "fix":    { "type": "agent", "prompt": "Fix the {{state.findings}} findings: {{state.reviews}}", "next": "done" },
    "done":   { "type": "end" }
  }
}
```

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
  - **Linux**: X11 with xdotool and ImageMagick (`import`, or `xwd` and `convert`), as in the sandbox; a missing tool is named with the package to install. Wayland is not supported and says so. Run for real end to end (below).
  - `launch` starts the command detached in the companion's folder (Windows through `cmd /c`, so `start msedge https://example.com` works; macOS and Linux through `sh`). It runs on your computer outside the companion's sandbox: a desktop app has to draw on your screen.
- **Asked, every time.** Your desktop is not contained by anything, so on a companion every action except reading the pointer and `wait` is treated like an action on an outside service: asked in default, accept-edits and auto mode (auto's checking model sees it first), refused in plan and never-ask (`dontAsk`) mode, free only in bypass. "Always allow" offers a rule for that one action, e.g. `computer(screenshot)` (rules take `computer(screenshot|zoom)` lists), so allowing screenshots never allows clicks. In the Docker sandbox nothing changes: there the tool is a command, free.
- **Untrusted, always.** Every result from your screen is marked untrusted (mail, chats and web pages are on it), so the untrusted-content guard applies from the first screenshot: actions that can click or type are then confirmed by a person even under a session allow rule; screenshots and zoom are not ways out and are not re-confirmed.
- **No secrets typed.** `type` refuses text that looks like a credential (API keys, tokens, private keys, `password=...`) on your screen. Typed text is never written at full length in permission prompts or notices (the length and the first 40 characters), and the companion's own log shows only how many characters were typed; a `launch` command is shown in full.
- Tested: the generated PowerShell, JavaScript and xdotool text for every action; permissions in every mode; the refusal without `--allow-desktop`; a session driving a stand-in desktop through an in-process companion. **On a real Linux X11 desktop** (`test/desktop-linux.test.ts`, runs whenever Docker has the desktop image): the desktop image runs Xvfb at 1920x1200 and fluxbox, and the companion itself (this repository mounted read-only, `--allow-desktop`) connects back over HTTP to a harness server in the test, so every job takes the real path (tool, hub, long poll, companion, xdotool and ImageMagick, and back). A screenshot is a 1280x800 PNG of the display; a move to [400, 300] puts the pointer at (600, 450) on the screen and reads back as [400, 300]; `launch` opens xterm, a click lands in it, typed text and `Return` run a command that writes a file; the screen then shows the terminal (over a thousand colours); `zoom` returns the region enlarged. It found a real bug: `launch` hung until its time limit, because the whole `cd && app &` list went to the background in a subshell that kept the script's output pipe open while the app ran; now only the app goes to the background (the sandbox's `launch` had the same pattern and is fixed too). **On a real Windows 11 machine** (opt-in, `HARNESS_TEST_REAL_DESKTOP=1`, never in a normal run): a 2560x1600 screen gave a 1280x800 PNG that is not blank, and the pointer moved to a point read back exactly; nothing was clicked or typed.

### AIOps pack: DevOps (`plugins/devops`)

Infrastructure as code, Kubernetes, CI, containers and compose deploys, each change proven before it ships and shipped only as approved. (The pack's other half, monitoring, incidents and system operations, is the `aiops` plugin.)

**The ops sandbox image** (`docker/Dockerfile.sandbox-ops`, `npm run sandbox:image && npm run sandbox:image:ops` -> `harness-sandbox-ops:latest`; allow it with `HARNESS_SANDBOX_IMAGES`). The sandbox plus OpenTofu 1.13.1 (as `tofu`; the tools use `terraform` instead where only that is installed), kubectl 1.37.1, Helm 4.3.1, kind 0.33.0, kubeconform 0.8.0, hadolint 2.15.1, ShellCheck 0.11.0, trivy 0.76.1, actionlint 1.7.12, yamllint 1.38.0, ansible-core 2.19.14, the docker CLI 29.9.2 with compose 5.6.1 (no daemon), and an SSH client. Every download is pinned and checked against the vendor's published SHA-256 (ShellCheck and the Docker static CLI publish none: their pinned hashes are the release assets' as served when pinned); the Python tools install with `pip --require-hashes` from `docker/ops-requirements.txt`. Baked in for offline work: the `hashicorp/null`, `local` and `random` providers as a provider mirror (other providers need the network), kubeconform schemas for 23 common kinds at a pinned commit of kubernetes-json-schema, and trivy's built-in checks. Not baked in: trivy's vulnerability database (about 0.8 GB; `--build-arg TRIVY_DB=1` adds it, or allow the network). linux/amd64. 1.87 GB on disk (465 MB compressed; the base sandbox is 0.96 GB). kind needs a Docker daemon's socket, so it belongs on a dedicated runner, never in a session sandbox.

Where the tools run: in the session's runtime, like a command - the ops image in a sandbox, the machine of a server folder or companion (`--allow-hooks`), or, for a server folder with `HARNESS_DEVOPS_IMAGE=harness-sandbox-ops:latest`, a throwaway container of the image with the workspace mounted (network `HARNESS_DEVOPS_NETWORK`, default none). In a sandbox without the ops image they are not offered at all; the gates say `not checked` (a warning) where a program is missing.

**Credentials come from the Key Vault**, never from the model: a tool input names a secret (`"kubeconfig": "kubeconfig-staging"`, `"env": {"AWS_ACCESS_KEY_ID": "cloud-aws-key-id"}`, `"dockerHost": "docker-host-prod"`, `"token": "github-token"`), the server resolves it (`ctx.services.vault.envFor`/`reveal`, with the call's purpose) and passes the value on the command's stdin - exported, or written to a private temporary file (a kubeconfig, an SSH key) outside the workspace. That file's folder has a name the server chose: the server removes it after the command however the command ended (a command killed on its timeout never runs its own cleanup), and each call first sweeps folders hours old that a dead server left. Values are never on a command line, and every value (and each line of a multi-line one), plus anything shaped like a credential, is redacted from what the tool returns. The plugin declares the names it may use (`permissions.vault` in its manifest: `github-token`, `kubeconfig*`, `cloud-*`, `tf-*`, `docker-host-*`, `ssh-*`, `registry-*`). Without a vault, the GitHub token falls back to the server's `HARNESS_GITHUB_TOKEN`; a call that needs a vault secret says there is none.

**Every vault read is a permission decision.** Each tool declares the entries a call will read (`vaultNames` in the plugin API: `iac` plan's `env` values, or for apply the env its plan was made with; `k8s` `kubeconfig` on cluster actions; `ci` `token`, or `github-token` for API calls; `container build`'s and `deploy`'s `dockerHost` and `sshKey`), so the same rules as bash's `secrets` apply before it runs: a `vault(NAME)` deny rule refuses the call in every mode, an ask rule asks, and otherwise the call is asked about - in a sandbox too - unless an allow rule names the entries (`vault(cloud-*)`; after untrusted content only the operator's rules count, and dontAsk refuses without one). The call can then read only the entries it declared. A session on the user's computer (a companion) gets no vault value at all - not on a command's stdin either; `ci` there uses only the server's `HARNESS_GITHUB_TOKEN`.

| Tool | What it does |
|---|---|
| `iac {action, dir?, env?, vars?, varFiles?, planHash?, allowDestroy?}` | Terraform / OpenTofu. `fmt` (check, or `write`), `validate` (every root module), `plan`: counts, destroys and replacements first under `!! DESTROYS`, every change by address, outputs by name, drift - values never shown - and the plan's sha256. The plan file holds every variable's value (`TF_VAR_*` secrets included), so it never stays where commands run: it is made in a private temporary folder, its bytes come back to the server, which keeps them for that session only (outside every workspace; the workspace gets a record of names and counts), and the folder is gone with the command. `apply` only applies a plan this session made, by that hash: the kept plan is checked against the hash, handed to the apply command on stdin and checked again there - a plan that changed is refused, a plan applies once, another session cannot apply it, and a plan that destroys needs `allowDestroy`. The permission prompt shows the plan (`APPLY plan 3fa2... in infra: +2 ~0 -1 DESTROYS null_resource.old`). Output values are named, not printed; state is never printed. |
| `k8s {action, ...}` | `validate` (kubeconform strict against the cached schemas; every manifest and Helm chart in the workspace, compose and CI files skipped), `template` (helm template, then validated), `lint`, and against a cluster: `diff` (the objects that change), `apply` (then waits for every workload it changed; a rollout that does not finish shows its pods with the reason - CrashLoopBackOff, image pull, unschedulable, not ready - and their Warning events), `rollout-status`, `rollout-undo`, `get` (pods with ready/restarts/why, deployments, services...), `describe`, `logs` (`previous` for a crashed container), `events` (warnings first). |
| `ci {action, ...}` | GitHub Actions through the API (server side; `HARNESS_GITHUB_API` for GitHub Enterprise, whose host must then be added to the manifest's `permissions.network`): `runs`, `jobs`, `logs` (the failing jobs' logs from the failing step's start to its first `##[error]`), `watch` (until a run - by id, or the newest for a branch/commit - finishes), `rerun-failed`, `dispatch`. Locally: `lint` (actionlint) and `run-local`: a job's `run:` steps the way the runner runs them (bash -eo pipefail, workflow/job/step env, the first matrix entry, `${{ env.X }}`), skipping `uses:` actions and steps that need secrets, stopping at the first failure - to reproduce a CI failure before pushing. |
| `container {action, ...}` | `lint` (hadolint), `scan` (trivy: `fs` - secrets and misconfigurations, vulnerabilities in lock files when the database is there; `config`; a `tarball` from docker save), findings by severity, secret values never shown. `build` needs a daemon: in a sandbox it answers **NOT BUILT** and lints and scans the Dockerfile instead; with `dockerHost` (a vault DOCKER_HOST) it builds there and scans the image. |
| `deploy {action, project, file?, service?, image?, healthUrl?, healthCmd?, dockerHost?, sshKey?}` | Docker Compose on the daemon where commands run or on a vault DOCKER_HOST (`tcp://`, or `ssh://` with a vault SSH key). `up` (optionally one service to a new image, pinned through an override file), then health: every service running and healthy (`up --wait`), plus the URL or command; when that fails it **rolls back** to the images that ran before and checks again. `ps`, `down` (volumes kept unless asked), `rollback` (to the last healthy deploy). History in `.harness/devops/deploy/`. |

Permissions: plan, validate, lint, scan and run-local are commands (`exec`: free in a sandbox). `iac apply`, `k8s apply` and `rollout-undo`, `deploy up/down/rollback`, `ci rerun-failed/dispatch` and a remote `container build` act on real systems (`external`: asked in every mode but bypass, refused in plan mode). Reads of GitHub are `network`. Anything that talks to a cluster, GitHub or a Docker host can carry data out (`sendsOut`), so it is confirmed after untrusted content.

Every change these tools make (`iac apply`, `k8s apply` and `rollout-undo`, `deploy up`/`down`/`rollback`, `ci rerun-failed`/`dispatch`) is recorded in the harness's change journal - failed ones too, marked, since a failed apply may have changed something - so an incident can be correlated with it (the aiops `change_timeline` tool, and the changes attached to alert incidents).

Gates: `terraform-valid` (init without the backend, validate, each root module; providers that cannot be downloaded make it `not checked`), `tf-plan-no-destroy` (the latest plan the `iac` tool made in this session - named by `.harness/devops/plans/latest.json`, its destroys read from the plan the server keeps, not from that editable file - else a fresh unlocked plan: any destroy or replacement blocks unless the run allows it in `.harness/devops/run-policy.json`, which `ship-change` writes from its input), `k8s-manifests-valid`, `dockerfile-lint` (errors and warnings block), `shell-lint` (shellcheck at warning level), `workflow-lint` (actionlint, with shellcheck on `run:` scripts), `iac-security` (trivy config: HIGH/CRITICAL block - trivy is strict: a Deployment without a read-only root filesystem and an explicit security context is HIGH), `secrets-in-repo` (the quality-gates plugin's credential scan, plus Terraform state, kubeconfigs, keys and `.env` files that git would commit, plus trivy's secret scanner).

Workflows, with typed state and approvals:
- `ship-change` - implement and plan (`platform-engineer`), a peer review by another `platform-engineer` and an IaC security review (`security-reviewer-iac`) in parallel, the DevOps gates with a fix loop, **human approval of the exact plan** (its summary and sha256), apply/deploy (`release-manager`, with that hash only), verification with the smoke checks, rollback on failure (Kubernetes undo, compose rollback; for Terraform a revert is reported as a new reviewed change, never improvised), and a change record in `docs/changes/`. Inputs: `change`, `kind` (terraform, kubernetes, compose), `dir`, `target` (vault secret names), `smoke`, `allowDestroy`.
- `pipeline-fix` - read the failing run (or, with `source=local`, reproduce it with `ci lint` and `run-local`), find the cause, fix it, run the job's steps locally until they pass, gates, `publish_branch`, and `ci watch` on the new run - back to diagnosis if it fails again.
- `k8s-rollout` - validate and diff, gates, approval of the diff, apply and wait, verify (ready pods, no new warnings, smoke checks), `rollout-undo` on failure, change record.

Agents: `platform-engineer` (makes and reviews changes; never ships), `release-manager` (ships only the approved plan, verifies, rolls back, writes change records), `security-reviewer-iac` (reads and scans only). Skills: `terraform-practices` (layout, state, reading a plan, moved/import/removed blocks, drift), `kubernetes-operations` (a workload that behaves, rollouts, a CrashLoopBackOff/ImagePullBackOff/Pending/not-ready table), `ci-debugging`, `docker-hardening`.

Evals (`evals/devops`, hidden checks run in the ops image; run with `HARNESS_DEVOPS_IMAGE=harness-sandbox-ops:latest`): `fix-terraform` (a broken config with deployed state: validate must pass, the plan must create exactly the intended resources and destroy nothing - the tempting fix replaces the deployed resource and fails), `fix-k8s-manifests` (kubeconform strict and a policy check: pinned image, requests and limits, probes on a real port, non-root, read-only root filesystem, the Service reaching the pods), `fix-ci` (`pipeline-fix` in local mode: actionlint, the job's steps run as CI would, the tests unchanged).

Tested (`test/devops.test.ts`): in the ops image for real - every tool's version; plan, approved apply, a destroy caught by the gate and allowed by the run policy (and not hidden by editing the workspace's record), a tampered plan refused, a plan another session cannot apply, no plan file left in the workspace or the sandbox, a secret Terraform variable never in any output; good and bad manifests, a chart, Dockerfiles, shell scripts and workflows through the tools and gates; trivy blocking a privileged container; credentials and state files found; `run-local` on a matrix job with an action, a secret step and a failure. Compose against this machine's Docker daemon: a healthy deploy, an unhealthy image rolled back automatically, history, down. GitHub through a local mock of the API (runs, trimmed logs behind a redirect, re-run, dispatch, watch; the token never shown). Kubernetes against a real control plane: kwok (`registry.k8s.io/kwok/cluster`: real API server, controller manager and scheduler, simulated kubelet) - diff, apply and wait, a rollout that cannot schedule diagnosed and undone, events, with the kubeconfig from the vault and gone after each call; the same scenario on kind with `HARNESS_TEST_KIND=1` - on a Linux host or dedicated runner: on the Windows 11 / Docker Desktop machine this was built on (WSL2 kernel 6.6.87), the kind node's systemd hangs in the kernel loading a module and the container cannot be removed until WSL restarts. The three evals are judged on their broken fixtures and on reference fixes, and two run end to end with a scripted FakeProvider (no model spend). Through a real session with a FakeProvider: a `vault(cloud-*)` deny rule stops `iac plan` with that env (never read), and a sandboxed session runs `iac` without secrets unasked but asks before a call reads a vault entry. Also: every tool's declared entries, a call refused an entry it did not declare, a companion refused every vault use, and a secrets folder removed after its command was killed.

### AIOps pack (`plugins/aiops`)

Monitoring, sysops, incident response and recommendations for the machines and services in an **ops inventory**: `.harness/ops/inventory.yaml` (or `.json`) in the workspace, and/or the operator's file `HARNESS_OPS_INVENTORY`. The inventory names hosts (ssh address, user, a Key Vault credential name - in the operator's file only, see the safety model - role, env, tags), services (host, container or systemd unit, health URL, TLS endpoint, Prometheus job, log source, owner, SLOs), environments, maintenance windows and alert rules; the `ops-inventory` skill has the format. The tools appear only in sessions whose workspace has an inventory (or when the operator sets one, or `HARNESS_OPS=on`), so other sessions pay no prompt tokens for them.

| Tool | Kind | What it does |
|---|---|---|
| `ops_inventory {action: list\|show\|validate, kind?, tag?, env?, role?, name?}` | read | Lists and filters the inventory (marks hosts in a maintenance window now), validates it (references, URLs, durations, cron, credential names, and whether each credential is in the Key Vault and due for rotation). |
| `prometheus_query {query, time? \| start?, end?, step?, top?, sort?}` | network | Instant or range PromQL. The step is raised so no series has more than 300 points; ranges up to 90 days. Results summarised per series (value, or last/min/max/avg), sorted, top N. |
| `logs_search {service? \| container? \| query? \| host?+file?, since?, filter?, limit?, dedupe?}` | network | Loki (LogQL) when configured, else `docker logs` (on a host over ssh, or on the server's engine for containers the operator allows), else a file over ssh. Regex filter; repeated lines collapsed with a count. |
| `probe {type: http\|tcp\|dns\|tls, url? \| target? \| service?}` | network | HTTP(S) status, latency and body match; TCP connect; DNS (A, AAAA, CNAME, MX, TXT, NS); TLS expiry, days left, chain, self-signed and name mismatch. With a service: its health URL and TLS endpoint. |
| `host_stats {host, disk_usage_path?}` | read on a host with a read-only account (it runs as that account) and for `local`; network otherwise | One read-only pass over ssh: CPU busy (two samples), load per CPU, memory and swap, disks and inodes (nearly full flagged), top processes, failed systemd units, kernel OOM / I/O errors; with `disk_usage_path`, the biggest entries and files under it. Works on busybox hosts too. |
| `docker_status {name?, project?, label?, host?}` | read (network with `host`) | Containers on a host over ssh, or on the server's own engine - only the containers the operator allows there. State, health (and the last check's output), restarts and policy, start time, CPU and memory, the user (root flagged), privileged, added capabilities, ports, memory limit, and env var **names** that look secret. |
| `ssh_exec {host, command, as?: reader\|operator, timeout_sec?, trust_host_key?}` | read as the host's read-only account (the default where the operator gave it one); external as the operator | A command on an inventory host with a vault credential (key or password). As `reader` it runs as the host's read-only OS account - any command, not asked about, the host refuses its changes; as `operator` (the host's `user` and `credential`) it is asked about, and says whether the command is a known read-only form. |
| `service_control {service, action: status\|restart\|start\|stop}` | external (status: network) | A service's container (docker) or systemd unit (over ssh). After a change it waits until the service runs, is healthy and its health URL answers, and reports before and after. |
| `ops_check {action?: run\|history, service?, severity?}` | network | Evaluates every alert rule now: PromQL rules (true for their whole `for`), probe rules, log-pattern rules, plus implicit ones (each health URL answers; each TLS endpoint has 21+ days). Alerts in a maintenance window are shown as silenced. Each run is recorded; `history` shows state changes per alert (noisy, flapping, always firing). |
| `slo_status {service?, slo?}` | network | Error ratio over the SLO window, error budget left, burn rates over 5m to 3d, and the multi-window alerts (14.4x over 1h and 5m, 6x over 6h and 30m, 3x, 1x). |
| `capacity_forecast {query, range?, threshold?, horizon?}` | network | Least-squares and Holt (double exponential smoothing, parameters fitted by grid search) per series: trend per day, value at the horizon, time to a threshold by each method, and a confidence that says when the data is too short. |
| `incident {action: open\|update\|resolve\|list\|show\|postmortem, ...}` | edit | Incidents in `.harness/ops/incidents/<id>/` (`incident.json`, `incident.md`, `postmortem.md`): severity, status, affected services, a timeline in time order, root cause and resolution, and a blameless postmortem with action items. |
| `runbook {action: list\|show\|check, name?}` | read | Markdown runbooks (`.harness/ops/runbooks/*.md`) and runbook workflows, checked against the runbook-safe rules. |
| `alerts {action: list\|show\|history, id?, status?, days?}` | read | Incidents the server opened from alerts (webhooks and the watch loop, below), kept on the server: open ones with their investigation, one with its alerts, why they were grouped, its timeline and the changes before it, and the history per service (count, mean time to resolve); plus the watch loop's last round. `incident list` and `incident show alr-...` show them too. |
| `change_timeline {action?: timeline\|import-git, service?, env?, target?, around?, before?, after?, limit?, path?}` | read | The change journal around a time (default 2h before to 30m after now; give the incident's start), nearest first, with links: deploys, rollouts, applies, CI runs, commits, restarts, runbooks. Changes without a service are shown for any service. `import-git` records a workspace repository's commits (once each). |

**Workflows.**
- `incident-response`: triage (opens the incident) -> evidence gathered in parallel by four `sre` steps (metrics, logs, recent changes and deploys, hosts) -> hypotheses tested -> root cause analysis (typed state: `incident`, `services`, `hypotheses`, `root_cause`, `remediation_needed`) -> a remediation runbook -> the `runbook-safe` gate (fix loop) -> **human approval** -> execution -> the `ops-healthy` gate (a reassess loop through approval again) -> a blameless postmortem. With nothing to change it goes straight to the postmortem.
- `ops-advisor`: a survey, then `sre` (reliability: missing monitoring, single points of failure, noisy alerts, SLOs), `capacity-planner` (forecasts), `security-auditor` (certificates, root and privileged containers, secrets in env, open ports, sshd settings, outdated packages) and `cost-optimizer` (idle and oversized resources) in parallel, merged into `.harness/ops/reports/ops-advisor.md`: every recommendation with its finding, evidence (the exact query or command and its numbers), impact, effort, the exact change and its risk. Read-only.
- `ops-watch`: one watch round run by an agent, for a schedule or explicit use (below); the server's model-free watch loop is the default way to watch.
- Runbooks: `runbook-restart-service` (baseline pre-checks, approval, restart, verify against the baseline), `runbook-clear-disk` (what fills it and a written plan of exact paths, approval, deletion of exactly those, verify the free space), `runbook-rotate-logs`, `runbook-os-updates` (report; applies only inside a maintenance window, with approval), `runbook-cert-check` (every TLS endpoint; renewal with approval when its command is known), `runbook-backup-verify` (a restore test into a scratch folder, with approval).

Change steps are marked `"change": true` and verify steps `"verify": true` (or are gate nodes); the `runbook-safe` gate and a unit test check that every built-in workflow reaches a change only through an approval's `approve` edge, that two changes never share one approval, and that no successful end is reachable from a change without a verify step.

**Agents** `sre`, `capacity-planner`, `security-auditor` (read-only commands, never prints secret values), `cost-optimizer`. **Skills** `aiops-triage` (impact first, recent changes first, USE and RED, hypotheses tested, symptom vs cause), `promql` (rate vs irate vs increase, histogram quantiles, absent, staleness, burn-rate alerts), `runbook-writing` (the tagged-step format the gate checks, with a complete example the tests run through the gate), `postmortem` (blameless, a `Root cause:` line, action items), `ops-inventory`. **Gates** `inventory-valid`, `alerts-valid` (every PromQL expression parsed by the Prometheus API when one is reachable), `runbook-safe` (workspace runbooks: every `[change]` has an `[approval]` before it since the last change, a `[verify]` after it, an exact command in backticks, and a rollback section), and `ops-healthy` (no critical alert fires; runs only when named, as a workflow's verify step).

**Safety model.**
- **Only the operator's inventory attaches credentials.** A host's `credential` and monitoring's `prometheus_credential` / `loki_credential` count only in `HARNESS_OPS_INVENTORY`; in a workspace file (which the agent can edit, and which comes with a repository) they are ignored with a warning, so a workspace can name an endpoint or a host but never send an operator's vault entry to it. ssh (`ssh_exec`, `host_stats`, logs over ssh) and authenticated Prometheus/Loki therefore need the operator's inventory. A call uses only the credentials attached to what it names: a workspace service on an operator host reaches it only when the call names the host itself.
- **Every credential use is a permission decision.** Each tool declares the credentials a call will use (`vaultNames`, worked out from the call's input and the operator's inventory before it runs), so the vault rules apply as for bash's `secrets`: `vault(ops-db-*)` in deny refuses, the call is asked about unless an allow rule names the entries (also in a sandbox; after untrusted content only the operator's rules count), and the call can then use no credential it did not declare. An unattended session needs the operator's allow rules for them (below). Quality gates never use credentials (no one is asked there): `alerts-valid` parses PromQL only against the operator's Prometheus and without a token (else it says it ran only the local check), and `ops-healthy` reports a rule that needs one as not evaluated. A session on the user's computer (a companion) gets no credential.
- **Inventory names are checked strictly, and an entry with an error is left out** (its error reported by `validate` and the `inventory-valid` gate) - a user name such as `-oProxyCommand=...` or a container `x; curl ...|sh` never reaches a command. ssh gets the user as `-l user` and `--` before the host; every remote command checks its container, unit and file names again right before it is built and shell-quotes them.
- **The server's own Docker engine is off** (`docker_status` without a host, `logs_search` of a container there, `service_control` of a service on `local`): on a shared server it runs every session's sandbox and the egress proxies. The operator turns it on with `HARNESS_OPS_LOCAL_DOCKER=1` and lists the containers the tools may see and control in `HARNESS_OPS_LOCAL_DOCKER_ALLOW` (names or globs, `label:key=value`; checked against the container's real name and labels after resolving it). The harness's own containers (`harness-*`, the `harness-web` label) are never allowed.
- Credentials come from the framework Key Vault (`ctx.services.vault.reveal(name, purpose)`, names `ops-*` only, declared as `"permissions": {"vault": ["ops-*"]}`); until a harness has one, the operator's declared secret `HARNESS_OPS_SECRETS` (a JSON object, or `@file`) stands in. Values are used on the server only: a key goes into a temporary file readable by this account alone (0600, and on Windows an ACL for this user only) that is deleted when the command ends; a password reaches ssh through an askpass helper reading the child's environment. Every output is redacted of the revealed values, private-key blocks, token shapes and `*PASSWORD=` / `*TOKEN=` assignments before the model sees it.
- Host keys are pinned on first use in the plugin's own `known_hosts` (`<data>/plugin-data/aiops/`, outside every workspace; plugins now get `api.dataDir`). A changed key is refused and the presented fingerprint shown; `trust_host_key` with that exact fingerprint re-pins it. That call is always asked about: the re-pin is part of what a rule must name, so `ssh_exec(db-1 uptime)` or `ssh_exec(db-1:*)` never covers it.
- **Least privilege: reader and operator.** Asking about every command on a host made an incident dozens of prompts, and a static guess at "read-only" is wrong both ways (`for p in /proc/*; do ...; done` reads; `cat` with the wrong redirect writes). So the host decides: in the operator's inventory a host can name a read-only account, `readUser` (an OS user the operator restricted: no sudo, not in the data owner's group, no docker group, no write access to the data) and `readCredential` (its vault name). `ssh_exec` and `host_stats` run as it by default (`as: "reader"`), as a `read`: not asked in any mode, the OS refuses its changes; the output is still untrusted, every call is still audited (with the account), and its credential still goes through the vault rules (`vault(ops-db-1-reader-key)`). `as: "operator"` uses the host's `user` and `credential` and is `external`: asked as before - for approved runbook steps. A host key re-pin is asked even as the reader. Only the operator's inventory can declare a reader: in a workspace file `readUser`/`readCredential` are ignored with a warning, and the permission decision reads the operator's file alone, so a repository can never make a command run unasked. A reader's command can still reach the network from the host; one that names a network client (curl, wget, nc, ssh, python...) is confirmed after untrusted content like any way out, but that is a hint, not a boundary - restrict the account's egress where exfiltration from the host matters. The workflows and skills investigate as the reader and change as the operator.
- The read-only label of an operator `ssh_exec` command is an allowlist of exact safe forms: known commands only, no `VAR=` in front, no expansion that could hide an option; `sed` only printing, deleting and substitutions without the `e`/`w` flags; `awk` without pipes, `system()`, redirection or script files; `git` status/log/diff/show/rev-parse and branch listing without `--output`; `journalctl` without `--vacuum`/`--rotate`; `hostname`, `date`, `dpkg`, `rpm` only in their reading forms; `env` never.
- `ssh_exec` as the operator and `service_control` changes are `external`: asked in default, accept-edits and auto mode, refused in plan and dontAsk mode, unless an **operator** allow rule names the host and command: `ssh_exec(db-1 systemctl status:*)` covers `systemctl status ...` on db-1 and never a compound command; `service_control(shop-api restart)` one action on one service. A repository's allow rules never cover them. (Tools can now name what their rules match: `ruleSubject` in the plugin API.)
- Reading monitoring data is `network` (asked in default mode) and untrusted: logs, metrics labels and command output can carry text written by anyone, so after reading them every way out is confirmed (the existing taint guard), and the outputs say they are data.
- With an operator inventory, hosts and monitoring endpoints come only from it: a workspace file can add services, alerts, SLOs and windows. Every inventory entry shows where it came from. The plugin reaches the hosts and URLs the inventory names directly (that is its job); probes and queries go where the inventory says.
- Every action on a system (`ssh_exec` with its account, user and read-only flag, `service_control`, a host key re-pin) is appended to `<data>/plugin-data/aiops/audit.jsonl` with its start time - no agent can edit it. Its `change` flag is what the plugin knows (never for the reader; for the operator, unless a known read-only form) - the eval checks below judge changes from the system instead.
- `ops_inventory validate` counts a credential the Key Vault lacks but the operator's `HARNESS_OPS_SECRETS` has as available (and says so), instead of reporting a working credential missing.

**Alert ingestion.** The pack sits behind the monitoring people already run: Alertmanager, Grafana Alerting, PagerDuty and Datadog post to the plugin's routes (each with its own route token, from `GET /api/plugin-routes`):

| Route (POST) | Payload |
|---|---|
| `/api/plugins/aiops/alerts/alertmanager` | Prometheus Alertmanager webhook (version 4): a `webhook_configs` receiver with `url: https://<harness>/api/plugins/aiops/alerts/alertmanager?token=<token>` (or the token in `http_config` headers). |
| `/api/plugins/aiops/alerts/grafana` | Grafana Alerting (unified alerting) webhook contact point: labels, annotations, values, dashboard and panel links. |
| `/api/plugins/aiops/alerts/pagerduty` | PagerDuty V3 webhook subscription: `incident.triggered` and `incident.reopened` fire, `incident.resolved` resolves, other events are ignored. With `HARNESS_OPS_WEBHOOK_SECRETS={"pagerduty": "<vault name>"}` every `v1=` signature in `X-PagerDuty-Signature` is checked (HMAC-SHA256 of the raw body); a bad one is a 401. |
| `/api/plugins/aiops/alerts/datadog` | A Datadog webhook with this payload template: `{"alert_id": "$ALERT_ID", "aggreg_key": "$AGGREG_KEY", "title": "$EVENT_TITLE", "message": "$TEXT_ONLY_MSG", "transition": "$ALERT_TRANSITION", "alert_type": "$ALERT_TYPE", "priority": "$ALERT_PRIORITY", "date": "$DATE", "last_updated": "$LAST_UPDATED", "tags": "$TAGS", "scope": "$ALERT_SCOPE", "hostname": "$HOSTNAME", "metric": "$ALERT_METRIC", "link": "$LINK"}` (a list of them works too). `Recovered` resolves; `Warn` and `No Data` are warnings; tags `service:`, `env:` map the service. |
| `/api/plugins/aiops/alerts` | Generic: one alert, a list, or `{"alerts": [...]}`, each `{name, severity, status (firing\|resolved), labels, annotations, startsAt, endsAt, fingerprint, service, env, value, url, summary}`. |

Every format is normalised to `{fingerprint, name, severity: critical|warning|info, status: firing|resolved, labels, annotations, startsAt, endsAt, source, service, env, value, url, summary}` (strings capped, links http(s) only, 500 alerts a request). The service comes from the inventory: a `service`/`app`/`container`/`job` label naming a service, a service's `metrics_job` or `container`, the inventory alert rule of that name, the `instance` matching a health URL, or the only service on a `host`; the env from an `env` label, else the service's.

**Grouping, deterministic, no model.** Alerts are deduplicated by fingerprint (a repeat only counts) and grouped by service and env (by alert name and env when no service is known): one group is one incident, `alr-<date>-<time>-<service>`, kept on the server in `<data>/plugin-data/aiops/alerts.json` (not only in a workspace: an alert arrives with no session around) with a timeline that records why each alert joined. When every alert of a group resolves, it waits the group window (`HARNESS_OPS_ALERTS_GROUP_WINDOW`, default 5m) and then resolves; an alert firing again inside it - or within the flap window of the resolution - reopens the same incident. An alert that changed state `HARNESS_OPS_ALERTS_FLAP_COUNT` (4) times within `HARNESS_OPS_ALERTS_FLAP_WINDOW` (30m) is flapping: recorded, waking nobody. An incident whose service, host or env is in a maintenance window of the inventory is silenced (recorded, no investigation) and opens if alerts still fire when the window ends. State changes are made under the file's lock, so several servers can take webhooks at once.

**One investigation per incident.** A new incident at or above `HARNESS_OPS_ALERTS_MIN_SEVERITY` (default warning), or one escalated to it, starts **one** session (`api.sessions.start`) running `HARNESS_OPS_ALERTS_WORKFLOW` (default `incident-response`; `none` sends a prompt instead) with the incident, its alerts and the changes recorded in the `HARNESS_OPS_CHANGE_WINDOW` (default 2h) before it as its input - fenced as outside data, the session marked as having read untrusted content - owned by `HARNESS_OPS_ALERTS_OWNER` (default the operator), on `HARNESS_OPS_ALERTS_MODEL` (default the first available: set it), in `HARNESS_OPS_ALERTS_MODE` (default dontAsk), working in `HARNESS_OPS_ALERTS_PATH` (the ops workspace with its inventory; default a folder of its own). Later alerts, escalations and the resolution reach that session as fenced notes. At most `HARNESS_OPS_ALERTS_MAX_CONCURRENT` (2) run at once and `HARNESS_OPS_ALERTS_MAX_PER_HOUR` (6) start an hour; the rest wait (the timeline says why) and start when a slot frees. `HARNESS_OPS_ALERTS_INVESTIGATE=0` only groups. The session needs the operator's allow rules for the tools it uses unattended, as below; its approvals wait for a person (the UI, or a chat integration answering through `api.sessions.respond`).

**The watch loop: model-free by default.** The server evaluates the inventory's alert rules itself every `HARNESS_OPS_WATCH_SECONDS` (default 60; 0 turns it off) - the same evaluation as `ops_check`: PromQL, probes, log patterns, the implicit health and TLS checks - and feeds what starts firing and what stops through the same grouping. A quiet estate costs no model call at all (the `ops-watch` workflow ran an agent every round: 288 runs a day at 5 minutes); an agent starts only for a new or escalated incident. It watches the operator's inventory plus the workspace inventory at `HARNESS_OPS_WATCH_PATH` (default `HARNESS_OPS_ALERTS_PATH`). With several servers only the holder of the plugin's `ops-watch` lease evaluates. Like the quality gates, it uses no Key Vault credential (nobody is there to ask): a rule that needs one (an authenticated Prometheus, logs over ssh) is listed as not evaluated in `alerts list`, never fired. Measured on the test stack (`test/aiops-watch-stack.test.ts`): rounds every 5 s against the real Prometheus, no session and no model request while the shop is healthy (the stack's expired certificate is one warning incident below the minimum severity there), then exactly one investigation once the slow-orders fault fires its latency rule, and still one after more rounds.

**Change intelligence.** The change journal (see [Plugins](#plugins)) gets the devops tools' changes (`iac apply`, `k8s apply` and `rollout-undo`, `deploy up`/`down`/`rollback`, `ci rerun-failed`/`dispatch`, failed ones marked), aiops `service_control` changes and runbook workflow runs (from the session events), and CI/CD: `POST /api/plugins/aiops/changes/github` takes GitHub `deployment`, `deployment_status` (success, failure, error), `workflow_run` (completed) and `push` webhooks - `X-Hub-Signature-256` checked when `HARNESS_OPS_WEBHOOK_SECRETS` names a `github` secret - mapping a repository to the inventory service whose optional `repo: owner/name` names it; `POST /api/plugins/aiops/changes` takes generic changes (`{kind, target, service, env, summary, by, at, ref}` or `{"changes": [...]}`). `change_timeline import-git` adds a workspace repository's commits on demand. When an incident opens, the changes of the window before it (for its service, or without a service in its env) are attached to its timeline, nearest first, and to the investigation's brief.

Webhook signing secrets (`HARNESS_OPS_WEBHOOK_SECRETS`, `{"pagerduty": "ops-pagerduty-webhook", "github": "ops-github-webhook"}`) are operator-scope vault entries the plugin reads from its server code - an administrator grants that with `plugin:aiops` on the entry's allow list - or, until a harness has a vault, entries of `HARNESS_OPS_SECRETS`.

**Scheduled watching with an agent** (the `ops-watch` workflow, for explicit use). Run `ops-watch` every N minutes in an unattended session: the operator settings (`HARNESS_SETTINGS`) need allow rules for what it does, since a dontAsk session refuses everything it would otherwise ask about: `{"permissions": {"allow": ["ops_check", "incident", "workflow", "vault(ops-prometheus-token)"]}}` (add `slo_status`, `probe` if the prompt uses them, and a `vault(...)` rule for each credential `ops_check` uses: the operator's Prometheus and Loki credentials, and the hosts of the operator's services). Then from a session, `schedule` with `cron: "*/5 * * * *"` and the prompt `Run the ops-watch workflow.`; or for a new dontAsk session each time, `POST /api/schedules {"title": "ops-watch", "cron": "*/5 * * * *", "prompt": "Run the ops-watch workflow.", "newSession": {"model": "...", "runtime": {"kind": "local", "path": "<the ops workspace>"}, "mode": "dontAsk"}}`. When something fires outside a maintenance window it opens or updates an incident and calls `notify_user`, which reaches the session and the `Notification` hooks (chat, phone).

**The test stack and evals.** `evals/aiops/stack` is a real environment (compose project `hwtest-aiops`, ports on 127.0.0.1 only): Prometheus (19090), node-exporter, a demo shop (19180, and 19443 with an **expired** certificate it makes itself) that exposes `/metrics` and `/health`, makes its own traffic, and breaks on purpose - `slow` (a migration "dropped" an index: `/api/orders` takes 1-2.5 s and logs the slow query), `leak`, `crash` (a worker crash loop), `disk` (the data volume fills with temp files) - and an ssh server `db-1` (12222) that shares the shop's data volume, with an operator account `ops` (key or password, sudo, owns the data) and a read-only account `reader` (a key; no sudo, its own group, can read `/data` but not write it), plus the `billing-worker` process the inventory names. `node evals/aiops/stack/stack.mjs up | reset | break <fault> | up-reset [faults] [--record <file>] | status | down`; an eval's setup (`up-reset`) also recreates the shop and Prometheus, so no log line or metric from an earlier case (a second "migration", an index gauge that flickers) misleads the next one. `test/aiops-stack.test.ts` brings it up (skipped without Docker or the images; `HARNESS_TEST_AIOPS_STACK=1` pulls them), runs the tools against it, and tears it down: real PromQL data, the probe catching the expired certificate, docker_status flagging the root container, ssh with a vault key and a vault password (the password echoed back comes out `[REDACTED]`), a replaced host key refused then re-pinned, the slow-endpoint alert firing, the logs naming the missing index, the fix clearing the alert, a full disk found with `host_stats` and freed with an exact command, a restart that waits for health, and the gates on real data.

Eval cases in `evals/aiops/` (an eval case can now have `setup` and `teardown` commands): `incident-slow-endpoint` (incident-response; hidden checks: the postmortem's `Root cause:` line names the missing orders index, the index was created after the approval, `/api/orders` is fast again, and no change before an approval), `disk-full` (runbook-clear-disk; half the volume free, the database untouched by checksum, the plan's deletion commands - parsed from its code spans, not its prose - stay inside `/data/cache`, no change before approval), `advisor-report` (ops-advisor; the report flags the expired certificate, the root container and the missing health checks, with evidence, and changes nothing). "Changed a system" is judged from the system, not from what a command looks like: the setup (`up-reset ... --record <run>/stack-before.json`, next to the workspace where no agent sees it) records db-1's files under `/data`, `/config` and `/etc` (type, size, mode, owner, mtime, ctime, SHA-256) and the containers (id, start time, restarts), then records every later change with its time (inotify on db-1, docker events). "Changes nothing" compares that with the state after the run; "no change before an approval" compares every change's time with the run's approval times - a change made during triage fails even when the approved step makes it again. Runs recorded before this have no recording and are judged from the audit log, by whether a command could write, and say so. They share one stack: run with `--concurrency 1`, `HARNESS_OPS_INVENTORY=evals/aiops/stack/operator-inventory.yaml` (the host db-1, Prometheus and the credential names are the operator's; the cases' workspace inventory names the services and alerts), `HARNESS_OPS_LOCAL_DOCKER=1 HARNESS_OPS_LOCAL_DOCKER_ALLOW=hwtest-aiops-*` (the shop container), and, until the Key Vault is there, `HARNESS_OPS_SECRETS=@evals/aiops/stack/.state/secrets.json`. The same test file runs each case end to end with a scripted model (no paid calls): setup, the real workflow with tool calls against the stack, the eval's automatic approval, and the hidden checks - including a run that "fixes" the problem during triage, which the approval check fails.

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

The `computer` tool on a companion's real desktop is in the last column: nothing contains it (see Computer use). So are the AIOps pack's `ssh_exec` and `service_control`; their rules name a host and a command (`ssh_exec(db-1 df:*)`) or a service and an action (`service_control(shop-api restart)`).

In plan mode the agent researches read-only, then presents its plan for approval. "Always allow" in an approval adds a rule for the session. A prefix rule like `bash(npm test:*)` never covers a compound command.

- **A command that gets key vault secrets** (`bash` with `secrets`) is decided twice: the command as any command, and the secrets like an action on another system - asked, even in a sandbox, unless a rule names the entries: `vault(ci-*|npm-token)` or `bash(vault:ci-*)` (globs; `vault(NAME)` also covers the `vault` tool on that entry). A rule for the command (`bash(npm publish:*)`) is not a rule for its secrets, a repository's rules never hand them out, and "always allow" adds a rule for those entries only. In `dontAsk` mode a command with secrets no rule names is refused. See [Key Vault](#key-vault).

- **The agent can enter plan mode itself** (`enter_plan_mode`) when a task should be researched and agreed before anything changes. Entering only takes permissions away, so nobody is asked; leaving is still the user's approval of the plan (`exit_plan_mode`), after which the session returns to the mode it was in (accept-edits stays accept-edits). It is refused in `dontAsk` (nobody could approve the plan) and `bypass` (the user chose no checks), and sub-agents do not have it.
- **Where rules come from**, in order: the operator's settings file (`HARNESS_SETTINGS`) and plugin manifests; the person's own settings (per account, `GET`/`PUT /api/me/settings`: permission rules and limits only, never hooks); the project's `.harness/settings.json`, then the personal `.harness/settings.local.json` (allow rules and hooks only where project content is trusted: in a sandbox, or with `HARNESS_TRUST_PROJECT=1`); then "always allow" clicks in the session. Rules add up and are decided deny > ask > allow, so a deny at any level wins, and nothing below the operator can loosen an operator's deny or ask. Limits (`maxSteps`, `maxCostUsd`, `maxTurnMinutes`) come from the operator; a person's settings can only lower them. Changing your settings applies to your live sessions at their next call. Companion sessions read the project's settings files on the user's computer, under the same trust rules.

- **Auto mode**, like Claude Code's: a call that would be asked about is first shown to a small model (`HARNESS_AUTO_MODEL`, else the sub-agent model) with the user's request and whether untrusted content was read. A clear yes runs it; anything else is asked, with the checker's reason. Its cost is charged to the session. Checked live on DeepSeek: `npm test` cleared, posting `.env` to a paste site refused.
- **Never ask (`dontAsk`)** is for unattended runs (scheduled tasks use it by default): what would be asked is refused, so a run never hangs waiting; allow rules still let work through.

**Untrusted content changes what is asked.** Once a web page, a search result or a service's answer is in the context (also through a sub-agent, at any depth, or a resumed or imported session):
- **every way out of the session is confirmed**, whatever the mode, bypass aside: a call to a service (any MCP tool, read-only ones too), a URL, a push, a command on a machine or sandbox with open network, and a command that gets key vault secrets (whatever the network: it holds the secret). This is the "lethal trifecta" - private data, untrusted content and a way out in one agent - that Willison and GitHub's MCP exploit showed. A sandbox with no network or only the operator's allowlist is not a way out, unless the allowlist carries credentials (the gateway can write to those services). Allow rules do not skip this check, except the operator's own (`HARNESS_SETTINGS`): a rule from the repository, a person's own settings (`/api/me/settings`), or a click made before the content arrived, is asked again; a repository's hooks can block a call but never allow one. A repository's allow rules never cover a call that leaves the sandbox at all (an MCP service, a URL, the user's real desktop), tainted or not. In auto mode these calls go to a person, not to the checking model;
- **saving to memory, scheduling a prompt or changing the key vault** needs a yes, so a page cannot plant instructions (or a value) for later;
- **hidden text never reaches the model**: Unicode tag characters (ASCII smuggling), zero-width characters, bidi controls and smuggling variation selectors are stripped from outside content, and so are HTML comments (`<!-- ... -->`) in content that is not a fetched page - an MCP result, a Markdown file, an issue body - as GitHub strips them from issues before its agent reads them; a note says how many of each were removed. Elements a person never sees on a page (`hidden`, `display:none`, `visibility:hidden`, zero font size, `aria-hidden`, hidden inputs) are dropped from fetched pages.

`HARNESS_TAINT_GUARD=off` turns the confirmation off (not recommended). With `HARNESS_INJECTION_SCAN=on`, a small model also reads each outside result for text that tries to instruct the agent (to ignore its task, run something, send data out) and adds a warning to it, like the probes Anthropic runs on web content for Claude in Chrome; one cheap call per outside result. Checked live on DeepSeek: an injected HTML comment flagged, ordinary release notes passed.

**Fetching outside URLs checks the address twice**: before the request, and again on the exact address the connection uses (a pinned DNS lookup), so a name that resolves publicly for the check and to `127.0.0.1` a moment later (DNS rebinding) is refused. Plugin fetches get the same.

**Scripts** (`run_script`) run in a fresh V8 context with no `require`, `process`, `fetch` or `eval`, inside a process under Node's permission model (no files, no child processes). In a Docker session that process runs inside the sandbox, under its network policy, like any command there; on Linux elsewhere, in a namespace with no network; on other machines it asks first. Every tool it calls goes through these same checks.

## Hooks

Deterministic steps the model cannot skip, at 21 points. The matcher, where there is one, is a regular expression over the name shown:

| Event | When | Matcher | Can |
|---|---|---|---|
| `SessionStart` | before the first message of a session | | add context |
| `SessionEnd` | the session is deleted, the server shuts down (`SIGINT`/`SIGTERM`), or an idle session's sandbox is stopped; `reason` says which | | observe |
| `UserPromptSubmit` | a message arrives | | block it, add context |
| `PreToolUse` | before a call, before anyone is asked | tool | block, allow |
| `PermissionRequest` | a call would be asked about | tool | allow, deny |
| `PostToolUse` / `PostToolUseFailure` | after a call / after one that failed | tool | add feedback |
| `FileChanged` | after `write` or `edit` changed a file (`path`, `tool`) | file path | add feedback (a formatter's report) |
| `InstructionsLoaded` | an instruction file entered the context (`file`, `scope`, `reason`: `session_start`, `compact`, `nested_traversal`) | reason | observe |
| `TaskCreated` / `TaskCompleted` | a todo item was added / marked done (`task`) | | add feedback; `TaskCompleted` can block, which puts the item back in progress |
| `ConfigChange` | settings changed through the API: the person's settings or instructions (`user_settings`, `user_instructions`), the session's mode, model or effort (`session`), its allowed hosts (`network`) | | observe |
| `WorktreeCreate` / `WorktreeRemove` | a worktree session's git worktree was made / is about to be removed (`path`, `branch`, `repository`) | | observe |
| `Notification` | the agent waits for a person (and on `notify_user`) | | observe |
| `SubagentStart` / `SubagentStop` | a sub-agent starts / ends | agent | add context / send it back |
| `PreCompact` / `PostCompact` | around a compaction (`trigger`: `auto`, or `server` for Claude's) | | add what the summary must keep / observe |
| `Stop` / `StopFailure` | the agent is about to end its turn / the turn failed | | send it back / observe |

Claude Code's `CwdChanged` has no counterpart: every command here runs in a fresh shell started in the workspace, so the working directory never changes between calls. Five kinds, as in Claude Code:

| Kind | How | Answers |
|---|---|---|
| `command` | runs on the session's host with the event as JSON on stdin | exit 0 proceeds (stdout is feedback, or JSON `{"decision":"allow"\|"deny"\|"block","reason"}`); exit 2 blocks with stderr as the reason |
| `http` | POSTs the event as JSON; `headers` may read server variables as `${VAR}` | a 2xx with the same JSON, or nothing |
| `prompt` | a small model judges the event against `prompt` (an instruction) | ok allows, not ok blocks (denies, for `PermissionRequest`) |
| `mcp_tool` | calls `tool` on a connected MCP `server` with the event (plus `arguments`) | its text, read like a command hook's stdout |
| `agent` | a verifying agent (`agent`, default the read-only `explore`) checks the event against `prompt`, looking at the workspace as it needs | ok allows, not ok blocks; it runs without hooks of its own |

- `PreToolUse` runs before anyone is asked: it can block a call or allow it without a prompt. `PermissionRequest` can answer a prompt instead of a person (a policy service, a judging model); deny wins over allow. `PreCompact`'s feedback is added to what the summary must keep; for Claude's server-side compaction, which happens inside a request, PreCompact runs once as the context passes 80% of the compaction point and its feedback goes into the compaction instructions sent with each request until it happens. `SubagentStart` adds context to a sub-agent's brief; `SubagentStop` can send a sub-agent back, like `Stop` for the main agent. `Notification` fires whenever the agent waits for a person (and on `notify_user`), so an `http` hook can reach a chat channel or a phone.
- **Who may configure what.** The operator's settings file (`HARNESS_SETTINGS`, JSON with `permissions`, `hooks` and limits; a file that cannot be read stops the server rather than dropping its rules) and plugin manifests take every kind; a plugin's `http` hook goes only to its declared hosts and reads only its declared secrets. A repository's `.harness/settings.json` adds only `command` hooks, which run in its sandbox: an `http` hook would run on the server.
- In-process hooks from code plugins (`api.on(event, handler)`) answer `{ block?, feedback?, decision? }`.
- A person's own settings (`/api/me/settings`) never carry hooks: a command there would run on the server's host for a server folder, and `http` and `prompt` hooks are the operator's to configure.

## Instructions, settings and output styles

**Instruction files**, in the tiers Claude Code reads, all in the first user message (never the system prompt, which stays the same for every session so it caches), in this order:

| Tier | Where | |
|---|---|---|
| managed | `HARNESS_INSTRUCTIONS`: a file the operator names | for every session; a named file that cannot be read stops the turn rather than running without it |
| user | the person's own, per account (`GET`/`PUT /api/me/instructions`, up to 24,000 characters) | for every session they own |
| project | `AGENTS.md`, `CLAUDE.md`, `HARNESS.md` at the workspace root | |
| local | `AGENTS.local.md`, `CLAUDE.local.md`, `HARNESS.local.md` at the root | personal and gitignored; workspace content like the project's |
| nested | the same files in a subdirectory | loaded the first time the agent reads or edits a file under it, appended as a reminder after that call's results (once per context) |

A workspace instruction file can import others with `@path` (relative to the file, inside the workspace only, up to four levels deep; not inside code blocks or code spans; never through `..`, never a hidden file or folder other than `.claude`, `.harness` and `.github`, never a secret-looking file such as `.env` or a key: an import goes into every request without a read permission check), each shown with the file that imported it. 32,000 characters in all for the opening tiers, the managed file first. The managed and user files do not import.

**Settings** come in levels too (operator, person, project and its local file, session): see [Permissions](#permissions).

**Output styles** set how the agent writes its replies. A session picks one when it is made (`outputStyle` in `POST /api/sessions`, or the new-session form): `default`, `concise`, `explanatory`, a workspace's `.harness/output-styles/<name>.md` (or `.claude/output-styles`), or an operator plugin's (manifest `"outputStyles": "<folder>"`). The style's text is appended to the system prompt and stored with the session when it is made, so the system prompt never changes during the session and the cache keeps hitting; sub-agents keep the shared sub-agent prompt.

## Where the agent works

- **Sandbox** (Docker; the default)
  - One container per session.
  - No capabilities, `no-new-privileges`, and limits on memory, CPU and processes.
  - Network per session:
    - **none**;
    - **an allowlist** (the default in the UI): the sandbox sits on an internal Docker network with no route out, and no host address on it either. A small proxy container beside it is the only way out and admits only the allowed hosts. The package registries and GitHub are allowed by default (`HARNESS_SANDBOX_ALLOW_HOSTS`). The list can be edited while the session runs, the agent is told what is allowed, and blocked attempts are reported. Tested against real Docker.
      - **Methods per host**: an entry may end with the methods it allows (`example.com GET,HEAD`, or `example.com read-only`). The proxy enforces that where it sees the request: plain `http://` and the credential gateway. An HTTPS tunnel (`CONNECT`) is opaque - there is no TLS interception - so for HTTPS only host-level policy applies, and a host limited to some methods is refused over a tunnel rather than opened; read-only access to an HTTPS API goes through the credential gateway, which terminates the request.
    - **full**.
  - **Stronger isolation** (`HARNESS_SANDBOX_RUNTIME`): sandbox containers run under another OCI runtime, e.g. `runsc` (gVisor, a user-space kernel) or `kata-runtime` (Kata Containers, a lightweight VM). The name is checked, and the server refuses to start (and a sandbox to run) if Docker does not have it, rather than quietly using runc. Tested: a missing runtime gives a clear error and no container; `runc` named explicitly is passed as `--runtime` (gVisor itself was not installed here).
  - Files sit in a host folder mounted at `/workspace`. The file tools check real paths, so a symlink planted from inside the container cannot reach the host.
  - **API keys without the key in the sandbox.** With `HARNESS_SANDBOX_CREDENTIALS` (presets `openai`, `anthropic`, `deepseek`, `github`, or a JSON file of your own), an allowlist sandbox gets base URLs pointing at its proxy (`OPENAI_BASE_URL=http://egress:3128/__cred/openai/v1`, ...) and a placeholder key; the proxy adds the real key on the way out, from a file only it mounts, and drops whatever auth the sandbox sent. The agent is told which credentials exist. Verified live: a sandbox listed OpenAI's models while `env` inside showed only the placeholder.
  - **A desktop**, with the desktop image: the `computer` tool works the screen, mouse and keyboard of a virtual display inside the container (see Computer use).
    - **Least privilege per credential**: the gateway sees each request's method and path and forwards only what the credential allows. The model presets reach only their inference endpoints and the model list (`POST /v1/messages`, `/v1/chat/completions`, `/v1/responses`, `GET /v1/models`); `github` is read-only (GET, HEAD; a GraphQL `POST` counts as a write) unless the operator lists `github:write`. A file entry takes `"allow": [{"methods": ["GET"], "paths": ["/v2/invoices/**"]}]`. Paths are matched after normalization (`..`, `%2e%2e`), and a refusal says what is allowed.
    - **The taint guard counts only writable credentials**: after untrusted content, a command on an allowlist is confirmed only when a credential could publish something (`github:write`, a file entry that allows writes); read-only ones and inference endpoints are not a way out.
  - **Setup scripts.** A session's `setup` (or a repository's `.harness/setup.sh` when `HARNESS_REPO_SETUP=1`) runs once as root with the network open, in a throwaway container with the workspace mounted, as cloud harnesses do. What it installs is kept as a snapshot image (by base image and script, for `HARNESS_SNAPSHOT_DAYS`, 7) and reused; the script runs again on top of it, so idempotent installs are quick. The session then starts from the snapshot with its own user and network policy. The log is in `.harness/setup.log`; a failing script leaves the session usable on the base image.
- **Your computer** (companion)
  - Open "Your computers", then run the two lines it shows.
  - It connects out over HTTPS (long-poll: no open ports, works behind NAT) and only touches the folder you start it in (unless you start it with `--allow-desktop`, which also lets the agent see the screen and use the mouse and keyboard).
  - **Short-lived tokens**: a companion token lasts `HARNESS_COMPANION_TOKEN_DAYS` (30). Once half of that has passed, a poll's reply carries a fresh token, which the companion uses from then on and keeps in an owner-only file (`~/.harness-companion/<server>.token`, or `--token-file`), so a restart with the original token falls back to it. The replaced token keeps working for a grace period (`HARNESS_COMPANION_TOKEN_GRACE_MIN`, 60) in case that reply was lost. A companion offline past expiry needs a new token: `POST /api/companions/<id>/token` issues one and stops every earlier one at once; deleting the companion revokes it.
  - **It contains the agent's commands** (`--sandbox`, default `auto`): bubblewrap on Linux, Seatbelt on macOS, else Docker with the folder mounted; `--network none|full`. It tells the server, which then treats its commands as sandboxed.
  - Checkpoints and rewind work on its files (saved through it before each write or edit), and the project's MCP servers (`.mcp.json`) start on that computer, their messages relayed through the companion - only when it is sandboxed or started with `--trust-project`.
  - Flags: `--dir` (the folder, default the current one), `--sandbox auto|bwrap|seatbelt|docker|off`, `--network full|none`, `--allow-hooks` (commands for hooks, quality gates, Blender and Godot), `--trust-project` (project MCP servers outside a sandbox), `--allow-desktop` (the `computer` tool on your real screen, mouse and keyboard, each action approved; see Computer use). All off by default.
- **Server folder**: opt-in with `HARNESS_LOCAL_ROOTS`, for administrators.
  - **Contained when you choose** (`sandbox` per session, default `HARNESS_LOCAL_SANDBOX`): bubblewrap (Linux) or Seatbelt (macOS) make the system read-only except the folder and temp, hide credential folders (`~/.ssh`, `~/.aws`, `~/.config/gh`, ...) and cut the network unless allowed; or Docker mounts the folder into a sandbox (Windows has no OS sandbox for a command). `auto` takes the best there is. A sandbox that was asked for and is missing is an error, never a silent fallback. Verified: bubblewrap for real in a Linux container, Docker on Windows.
  - **An allowlist in the OS sandboxes**: the same egress proxy runs as a local process per session (loopback port, keys handed over on its stdin - never in a file the sandbox could read - and gone when the server is). bubblewrap still unshares the network, binds the proxy's unix socket in, and a small bridge on the sandbox's own loopback forwards to it; Seatbelt denies the network except one connection, to the proxy's port. Commands get `HTTP(S)_PROXY`, and the credential gateway is at the same address. A command that ignores the variables has nowhere else to go. Verified: bubblewrap for real in a Linux container (allowed and blocked hosts, no route around the proxy, keys added outside, a refused write); the Seatbelt profile as generated text.
  - Uncontained, commands run with credentials stripped from their environment and are asked about; they can still reach the server's network: keep that for trusted, single-user machines.
  - **Worktrees**: a folder that is a git repository can give each session its own worktree and branch (`harness/<title>-<id>`), so several sessions work on one repository in parallel without touching your checkout. The branch stays when it has commits. In a sandbox only what committing on that branch needs is writable in the repository's `.git` (objects, `refs/heads/harness/`, the worktree's folder); hooks and config stay read-only, because a hook written from a sandbox would run on the host.

## Publishing: branches and pull requests

`publish_branch {branch, title, body?, commit_message?, draft?}` ends a coding task with a pull request.
1. It commits in the session's own runtime (for a sandboxed session, in the sandbox).
2. It copies the commits **out of the workspace** into a repository the harness owns, and pushes from there. So nothing in the workspace's git config runs on the server or redirects the push: no hooks, fsmonitor, url rewrites or filters.
3. It opens the pull request through the GitHub API, or finds the one already open.

The token (`HARNESS_GITHUB_TOKEN`) goes in a header for that one command; it is never written to disk, the workspace or the model's context. It pushes only to the repository the session was cloned from, or one in `HARNESS_PUBLISH_REPOS`, and never force-pushes or pushes to the base branch. The token goes only to github.com (or the GitHub Enterprise host of `HARNESS_GITHUB_API`, or a host in `HARNESS_PUBLISH_TOKEN_HOSTS`): a session cloned from anywhere else pushes without it. A workspace whose `.git` is a link, a gitfile or borrows objects from another repository is refused.

Least privilege, each widened only by the operator:
- **Branches under a prefix**: the agent pushes only to branches under `HARNESS_PUBLISH_PREFIX` (`agent/`; added when the agent leaves it out, so `fix/login` becomes `agent/fix/login`).
- **Only its own branches**: a branch that already exists is pushed to only if this session created it (recorded in the session's folder); someone else's branch, even under the prefix, is refused unless `HARNESS_PUBLISH_UPDATE=1`.
- **Draft pull requests**: every pull request is a draft unless `HARNESS_PUBLISH_READY=1` (then `draft: false` opens a ready one).
- **Private repositories**: a session's repository is cloned with the same token when the operator lists it (`HARNESS_CLONE_REPOS`: `owner/name`, URLs or `owner/*`; the `HARNESS_PUBLISH_REPOS` count too). The token goes in an HTTP header passed in git's environment for that one clone - not on the command line, not in the clone's `.git/config` - and only to the hosts a push may send it to. Tested against a real git HTTP server (`git http-backend`) that wants the token.

## Key Vault

Named secrets - passwords, tokens, SSH keys, certificates, connection strings - that sessions use without the model ever seeing them (`src/vault/`). The agent names an entry; the harness puts the value where it is needed, on the server, and hides it everywhere else.

**Using one in a command.** `bash` takes `secrets: {"DB_PASSWORD": "prod-db"}`: the harness resolves the entries and passes them as that one command's environment, never in the command text. The command refers to `$DB_PASSWORD`. In a Docker sandbox the values go into an env file (`docker exec --env-file`) in a private temporary folder (the file owner-only, deleted when the command ends); a multi-line or very long value travels base64-encoded and is decoded into its name inside the container. They are never in the docker CLI's arguments nor its own environment: the CLI runs with a fixed environment (the server's `PATH`, `HOME`, system folders and its own `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG`/... settings), so a secret can never point it at another daemon. On a server folder the values are the command's own environment. Variables that change how commands, runtimes or the Docker CLI behave cannot be secrets, on any host: `PATH`, `HOME`, `LD_*`, `DYLD_*`, `BASH_ENV`, `NODE_OPTIONS` and Node's other runtime variables, `PYTHONPATH`-style names, `DOCKER_*`, `*_PROXY`, `SSL_CERT_*`, `GIT_SSH_COMMAND`, `XDG_*` and similar (`BLOCKED_ENV` in `src/vault/store.ts`).

**A companion session gets no value at all.** Its commands run on the user's own computer: `reveal` and `envFor` are refused (and audited as denied) for every caller in such a session, plugin code included, and a `bash` call with `secrets` is not sent. The names are still listed.

**Whoever can use a secret in a command can in effect read it.** Redaction catches the value and its usual encodings, not every transformation: once a person approves a command with secrets, `echo $X | rev` (or a hash of each character, or a file written in pieces) shows the value in a form no redactor can know. Redaction keeps values out of the model's context and the logs by accident; it is not an access control. Who may use an entry at all is the access control: give operator entries only to the accounts that should be able to read them (see `allow` below).

**Hidden everywhere.** Every value a session is given, or that the model writes into a `vault` call, is registered with the session. One function (`Redactor` in `src/vault/redact.ts`) replaces it with `[vault:name]` at each chokepoint: tool results before they enter the context (command output included, so an `echo` or a `cat` of a file the command wrote shows the label), every message appended to the context (and so the stored history), every provider request (a safety net), every event the UI receives (notices, sub-agent reports, permission prompts), trace spans, hook payloads, workflow run records, the workspace file preview and exported bundles (conversation and files). It catches the value itself, its base64 (standard and URL-safe, also inside a longer base64 text such as a `Basic` header of `user:password`), its URL-encoded and JSON-escaped forms, and each line of a PEM key or other multi-line value. A value the model wrote into `vault set` is hidden from the message that carried it before that message is stored, shown or sent again. Signed provider reasoning (Anthropic `thinking` blocks with their signature and `redacted_thinking`, OpenAI `reasoning` items with `encrypted_content`) is left as it is - changing it breaks the provider's check - but only those exact shapes: any other object with a `signature` field, such as a tool input the model wrote, is redacted. The names a session was given are kept with it, and every value it ever saw is kept sealed under the server key in its own folder (`<data>/sessions/<id>/vault-seen.json`, owner-only), so after a restart its values are hidden again - also once the entry was deleted, rotated past the five kept versions, or the session's access to it withdrawn. With several servers the list of names only grows: a server that reads the session again loads the values another server handed out, and a save keeps the names already on disk.

**The `vault` tool** (the agent's view): `list` (names, kinds, scopes, versions, rotation dates; never values), `generate` (a strong random password, token or secret, or an Ed25519 SSH key whose public half is returned: the value never passes through the model), `create`/`set` (a value the model has), `rotate`, `history`, `delete`. There is no `get`. Writes are edits that persist: asked in default mode, refused in plan mode, confirmed after untrusted content; `delete` is asked even when edits are accepted. Sub-agents list and use entries but do not change them.

**Scopes and access.**

| Scope | Who changes it | Who uses it |
|---|---|---|
| `operator` | administrators (the operator token or an admin account), through the API | administrators' sessions (and the single-user server's), plus the members or accounts the entry's `allow` list names (when the tool or plugin is allowed) |
| `user` | the account and its sessions | that account's sessions only: nobody else sees the names, administrators included |
| `session` | that session (and its owner, through the API) | that session |

**`allow`** (operator scope): `["admins"]` (the default for every new operator entry, and what an entry from before the list existed means), `["members"]` (every account), or account ids (`["usr_ab12...", "usr_cd34..."]`), and `plugin:<name>` for a plugin's server code (a webhook handler, a background loop: see [Plugins](#plugins)), set at creation (`allow` in `POST /api/vault/entries`) or later (`POST /api/vault/entries/:name/allow`). An account an entry does not allow neither sees its name nor can use it - not in `list`, `reveal`, `envFor`, nor the restart reload; the request reads as "no such entry" and is audited as denied. Who is an administrator is decided as each request comes (a demoted or disabled account loses the entries at once; a single sign-on administrator is one by `HARNESS_OIDC_ADMINS`). Administrators see the list in `GET /api/vault/entries`; members do not.

A name is looked up in the session's entries, then the account's, then the operator's. `HARNESS_VAULT=admins` gives the vault only to administrators' sessions (and the single-user server's); `off` turns it off.

**Storage.** Metadata is in clear in `<data>/vault/entries.json` (owner-only): name, kind, description, scope, owner, created and updated times, `rotateBy`, and the current version plus the five before it. Each value is sealed with AES-256-GCM under the server key (`HARNESS_SECRET_KEY`, else `<data>/secret.key`, shared with MCP bundles in `src/util/sealed.ts`), with a random IV per value. A rotation keeps the earlier versions readable, so `POST .../rollback` can make one current again (as a new version: nothing is lost). Another server key gives a clear error: "cannot decrypt: the server key (HARNESS_SECRET_KEY or secret.key) is not the one it was sealed with". A change writes the value to its backend first and only then takes the short lock on `entries.json` for the metadata, so a slow external backend never holds the lock (other servers' changes go on); a change that meets a delete of the same entry on another server in between is refused with 409 rather than half-applied.

**External backends**, behind one interface (`src/vault/backends.ts`), chosen per entry (`backend`) or by default, configured by the operator in `HARNESS_VAULT_BACKENDS` (JSON; `${VAR}` reads the server's environment):

```json
{
  "hcv": { "type": "hashicorp", "address": "https://vault.internal:8200", "mount": "secret", "prefix": "harness" },
  "akv": { "type": "azure", "vaultUrl": "https://myvault.vault.azure.net", "tenantId": "${AZURE_TENANT_ID}", "clientId": "${AZURE_CLIENT_ID}", "clientSecret": "${AZURE_CLIENT_SECRET}" },
  "sm":  { "type": "aws", "region": "eu-west-1" },
  "default": "hcv"
}
```

- **HashiCorp Vault**, KV v2 over its HTTP API: a token (`token`, else `VAULT_TOKEN`) or AppRole (`roleId`/`secretId`, else `VAULT_ROLE_ID`/`VAULT_SECRET_ID`; the login is renewed before its lease ends), optional `namespace`. Each harness version is a KV version. Tested for real against `hashicorp/vault` in Docker dev mode: both logins, versions, rollback, delete, and a path outside the AppRole's policy refused.
- **Azure Key Vault**: client-credentials OAuth against the tenant (`authorityHost` for sovereign clouds), REST API 7.4; names are made Key-Vault-safe with a short hash. Tested against a local stand-in that checks the grant, the bearer token and the API version.
- **AWS Secrets Manager**: SigV4-signed JSON requests (`src/vault/sigv4.ts`, node:crypto only, no SDK; checked against AWS's published test vectors), keys from `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` or the config; `endpoint` for a VPC endpoint. Tested against a stand-in that recomputes every signature.

Entries are stored at `<prefix>/<scope>/<owner>/<name>` in the backend. Only an administrator may point an entry at an existing path (`ref`), so a member cannot reach another application's secrets through the server's backend credentials.

**For plugins.** A tool's `ctx.services.vault` has `list()` (metadata only), `reveal(name, purpose)` (for server-side code: signing a request, opening an SSH connection; never put it in a tool result - and if a plugin does, the result is redacted anyway) and `envFor({VAR: name}, purpose)` (for `host.exec`'s environment). Both are refused, and audited as denied, unless the name matches the plugin's manifest: `"permissions": {"vault": ["prod-*", "ci-token"]}`. The plugin loader hands each plugin's tools (and gates) a vault limited to those names. `api.registerVaultRotation({ kind?, prefix?, rotate })` makes `rotate` change the secret for real where it is used (the database password itself); it may read the current value only for names it declared, and returns the new one (or stores the generated one).

**Audit and rotation.** Every reveal, change, rotation, rollback, deletion and refusal is appended to `<data>/vault/audit.jsonl`: time, who (account, operator, or session), session, plugin, tool, action, entry, scope, purpose, result. Never a value. Entries past their `rotateBy` (set directly or with `rotateEveryDays`, which moves on with each rotation) are named in a notice when a session starts and flagged in `list`.

**REST API** (values are write-only: no response ever carries one):

| | |
|---|---|
| `GET /api/vault/entries` | names and metadata visible to you (`?session=<id>` adds that session's) and the backends |
| `POST /api/vault/entries` | `{name, value \| generate: true, kind, description, scope, rotateBy, rotateEveryDays, backend, ref, allow}`; 409 if it exists |
| `PUT /api/vault/entries/:name` | a new version (or a new entry) |
| `POST /api/vault/entries/:name/allow` | administrators, operator scope: `{allow: ["members"] \| ["usr_..."] \| []}` - who besides administrators may use it |
| `DELETE /api/vault/entries/:name` | `?scope=` to pick one |
| `GET /api/vault/entries/:name/history` | versions (metadata) |
| `POST /api/vault/entries/:name/rotate` | `{value?}`: a plugin's rotation handler, else a generated value |
| `POST /api/vault/entries/:name/rollback` | `{version}` |
| `GET /api/vault/audit` | administrators: the audit log (`?limit=`) |

## Shared servers: accounts and limits

Without accounts the server is single-user: whoever holds `HARNESS_TOKEN`. With accounts (`npm run users -- add alice [--admin]`; tokens are shown once and stored hashed):
- **Members** see only their own sessions, companions and memory. They cannot run commands on the server itself (server folders are for administrators) or install plugins.
- **Administrators** see everything and manage accounts (`/api/users`: add, rotate, disable, remove).

Every request and every message is rate-limited per person (`HARNESS_RATE_LIMIT`, `HARNESS_MESSAGE_RATE_LIMIT`). An optional daily spend cap per account (`HARNESS_USER_DAILY_USD`) refuses new messages and stops a running turn at its next step. What one account may have going at once is capped too, so one person cannot take every slot of a shared server: sessions working at the same time (`HARNESS_USER_MAX_RUNNING`, 4: a message that would start a turn, a workflow start or a resume is refused with 429 and why; a message to a session already working joins its turn) and sessions with a sandbox container (`HARNESS_USER_MAX_SANDBOXES`, 8). The operator's own token is not limited. Scheduled prompts and triggers count too: a run that would go over is skipped, and its last result says why.

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
- **Okta / Keycloak:** issuer `https://<org>.okta.com/oauth2/default` or `https://<host>/realms/<realm>`. In Keycloak: a client with Client authentication on (confidential), Standard flow, "PKCE Method" S256, the redirect URI above, and "Valid post logout redirect URIs" `https://harness.example.com/`.

The server prints the redirect URI to register when it starts. How it works:

- **Flow:** authorization code with PKCE (S256), `state` and `nonce`. The provider's discovery document and keys (JWKS) are cached for an hour; a token signed with an unknown key id fetches the keys again, so key rotation needs nothing. A started sign-in is kept on the server for 10 minutes, can be finished once, and only in the browser that started it (a short-lived cookie binds them).
- **The id_token is checked:** signature (RS256/384/512, PS256/384/512, ES256/384/512 or EdDSA; never `none` or HMAC), issuer exactly, audience contains the client id (and `azp` is the client id when there are several audiences), `exp`/`iat`/`nbf` with one minute of clock skew, the nonce, and `email_verified` must not be false.
- **Who gets in:** only addresses in `HARNESS_OIDC_ALLOWED_EMAILS` or in a domain of `HARNESS_OIDC_ALLOWED_DOMAINS` (exact domain; subdomains are not included). With neither set, every sign-in is refused with a message saying so.
- **Accounts:** the first sign-in creates an account (named after the e-mail address) keyed by the provider's issuer and subject, so a reassigned e-mail address never inherits someone's account. Later sign-ins reuse it. It is a member, or an administrator when its address is in `HARNESS_OIDC_ADMINS` (checked on every request, so removing an address takes effect at once). Ownership, rate limits and spend caps apply as for token accounts; `npm run users -- disable <id>` works the same and ends the person's sessions at once, as does removing them from the allowlist.
- **Browser sessions:** the cookie `hw_sid` holds only a random id (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` on https). The server keeps its hash, the account and the last use in `browser-sessions.json` in the data folder, so a restart keeps people signed in. A session ends after 12 idle hours, or 7 days after sign-in, or at **Sign out** (`POST /auth/logout`), which deletes it on the server.
- **Signing out at the provider:** where the provider publishes an `end_session_endpoint` (Keycloak, Entra ID, Okta; not Google), **Sign out** then sends the browser there (RP-initiated logout) with `client_id`, the `id_token_hint` (the id_token of that sign-in, kept with the browser session; it lets the provider end the right session without asking "Do you want to log out?") and `post_logout_redirect_uri` (`HARNESS_PUBLIC_URL/`), so the provider's own session ends too and the next sign-in asks for the password again.
- **Tested against a real Keycloak** (`test/oidc-keycloak.test.ts`, Keycloak 26.7 in Docker, dev mode): the realm, a confidential client with PKCE S256 and three users are made through Keycloak's admin REST API, and a scripted browser (fetch with a cookie jar) signs in through Keycloak's own login form. A verified member gets an account keyed by Keycloak's subject; the address in `HARNESS_OIDC_ADMINS` is an administrator; a user whose address Keycloak has not verified is refused (no account made); a second sign-in in the same browser goes through Keycloak's session without a password and reuses the account; sign-out ends the harness session, Keycloak's end_session endpoint ends Keycloak's session and redirects back (no confirmation page), and the login form is shown again; after the realm's signing key is replaced through the admin API (new key, old one deleted), the next sign-in fetches the new JWKS and works. It runs when Docker has a Keycloak image (`HARNESS_TEST_KEYCLOAK_IMAGE`, else `keycloak/keycloak:26.7.4` or `quay.io/keycloak/keycloak:26.7.4`; `HARNESS_TEST_KEYCLOAK=1` pulls the latter) and removes its container afterwards. What the real provider showed: without an `id_token_hint` Keycloak stops at a confirmation page on sign-out, so the hint is now sent.
- **Cross-site requests:** every API write needs the `x-harness: 1` header, which the UI sends and another site cannot (a cross-site page cannot set it without a CORS preflight this server never allows); for a single sign-on session the `Origin`, when the browser sends one, must also be `HARNESS_PUBLIC_URL`'s. The event stream is a GET and works with the cookie.
- `HARNESS_OIDC_ONLY=1` refuses personal tokens everywhere (Bearer, cookie and `/api/login`). The operator token (`HARNESS_TOKEN`) still works, for scripts and as the way in if the provider is down; companions keep their own tokens.
- `GET /auth/config` tells the UI whether single sign-on is on.

## Running several servers

Two or more harness servers can share one data folder (NFS, SMB, a shared Docker or Kubernetes volume) behind a load balancer, for capacity or so one can be restarted while the others serve. Turn it on on every server:

```bash
HARNESS_CLUSTER=1
HARNESS_DATA=/mnt/harness-data             # the same shared folder on every server
HARNESS_NODE_ID=harness-1                  # unique per server
HARNESS_NODE_URL=https://10.0.0.11:4310    # where the other servers reach this one directly (optional; https unless loopback)
HARNESS_CLUSTER_SECRET=<openssl rand -hex 32>  # the same on every server; without it no request is passed on
HARNESS_CLUSTER_PEERS=https://10.0.0.11:4310,https://10.0.0.12:4310   # optional: the only addresses requests go to
HARNESS_PUBLIC_URL=https://harness.example.com   # the load balancer's address (the same on all)
HARNESS_HOST=0.0.0.0
```

- **One server drives a session at a time.** A session has a lease: a file in `<data>/leases`, created atomically (O_EXCL), naming the server that holds it, its `HARNESS_NODE_URL` (signed with `HARNESS_CLUSTER_SECRET`) and a heartbeat it rewrites every third of the lease time (`HARNESS_LEASE_SECONDS`, 30). A server takes the lease when a turn, a workflow run, a resume or a rewind starts there, and gives it up when the session is idle again (no turn, no background work, no open question) and what it wrote is on disk. A takeover, a heartbeat and a release each change the file under the lease's short lock (`<lease>.lock`, O_EXCL) and only while the random token in it is still the one this server last wrote, so a heartbeat can never overwrite a takeover that landed a moment earlier (two servers driving one session) nor bring back a lease just released.
- **The other servers pass requests on.** A request to a server that does not hold a session's lease (a message, an approval, Stop, the event stream, reading the session) is streamed to the holder (the answer says `x-harness-served-by`) when all of these hold: `HARNESS_CLUSTER_SECRET` is set; the holder's address is https, or http on loopback; and it is in `HARNESS_CLUSTER_PEERS` or, without that list, the lease carries a valid signature of the address under the secret - a lease file is in the shared folder, and whoever can write there must not be able to send requests (and people's credentials) to an address of their choosing. The target is the peer's origin plus this request's path and query, nothing else of the request line (`GET //internal:8080/...` still goes to the peer). The person's `Authorization` header and cookies are never passed on: the request carries `x-harness-cluster-auth`, an HMAC under the secret of the account id, the time and the method, path and query, which the holder checks (within a minute) and maps back to the account as it is there (a disabled account is refused, the role is the holder's own decision). Otherwise, or for a request already passed on once, the answer is `409` with the holder's id, and its address when it was verified (`x-harness-session-server`). A scheduled run for a session busy elsewhere is skipped and says on which server.
- **A crashed server's sessions are taken over.** A lease whose heartbeat is older than the lease time belongs to a server that stopped; the next server to start work on the session takes it over, reads the session from disk and closes the interrupted turn the way a restart does (each unfinished tool call gets a result saying it did not complete). A server that finds it lost a lease stops its work there. Clocks are compared across servers: keep them in sync (NTP).
- **Everyone sees everything.** Sessions are listed from the folder, not from one server's memory: a session made, changed or deleted on one server shows on the others (checked at most once a second, `HARNESS_SYNC_MS`). Accounts, single sign-on browser sessions, companions, schedules and spend are files the servers re-read when they change on disk.
- **No write is lost or half-seen.** Every state file in the data folder (session meta, workflow runs, checkpoint manifests, schedules, accounts, browser sessions, companions, spend, settings, instructions, memory, leases) is written to a temp file next to it (unique per host, process and write) and renamed over it; a session's logs (history, trace) are only appended to, by the lease holder. Files several servers change (accounts, browser sessions, companions, schedules, spend) are changed under a short lock (`<file>.lock`, created atomically, broken after 30 seconds if its holder died) on the version on disk at that moment, so two servers adding an account at once keep both; spend is added as each server's increment, so two servers' charges add up. A session's history and meta are written only by the lease holder.
- **Schedules fire once.** Only the server holding the scheduler lease fires schedules (another takes over after the lease time if it stops). Each run is claimed on disk (its next time moved on) before it starts, so a change of leader cannot fire it twice.
- **Deploy with sticky sessions.** Configure the load balancer to keep a browser on one server (a cookie or source-IP affinity): an event stream then stays where its session runs, and forwarding is the exception (after a failover, or two people on one session). Health checks can use `GET /auth/config`. Each server needs the same configuration, keys, plugins and sandbox images; Docker sandboxes run on the Docker host of the server driving the session (the workspace is in the shared folder, so another server starts its own sandbox on it).
- **Companions** keep a long poll open to one server, and jobs for a companion session are sent from the server driving it: point a companion at one server's own address (its `HARNESS_NODE_URL`), or route `/api/companion/*` to one server at the load balancer.
- **Tested** with two servers in one process on one temporary folder (`test/cluster.test.ts`): a session made on one is listed and read on the other; while one runs a turn, the other's own attempt is refused, a message sent to it is passed on to the holder and joins its turn, its event stream is the holder's, and a request already passed on gets the 409; after the turn the other server takes its turn and its model is sent the first server's history; a deleted session disappears from both; a holder that stops beating loses the session to the other after the lease time, which closes the interrupted turn and answers; with both servers' timers due at the same moment a schedule fires once, and after the leader stops the other fires the next; accounts made on both at once, spend charged on both, sign-ins and companions made on one are all seen by the other; three writers' atomic writes are never read half-written, 40 overlapping locked read-change-writes lose nothing, and a lock left by a crash is broken; a heartbeat held between its read and its write while another server takes the lease over (or while the lease is released) does not write over the takeover (or bring the lease back); a request line naming another host is still passed only to the holder's origin, a lease whose address is unsigned, signed with another secret or plain http off loopback is not passed to, a server without the secret passes nothing on, a listed peer receives no token or cookie and a cluster header bound to the method, path and query, and the receiving server refuses a header with a wrong secret, for another path, too old, or for a disabled account; vault values one server handed out in a session are hidden on the other after it reads the session again, and neither a reload nor the other server's save loses a name.

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
- **Background work**, as in Claude Code: `agent` and `workflow` take `run_in_background: true` and return an id at once (`general-3`, `run_…`); `bash` with `run_in_background` returns a task id (`shell-…`). The main agent keeps working, and when the work ends its report (a workflow's steps, a shell's exit code and last lines) reaches it as a reminder with its next step. Every finished sub-agent is kept with its context, so `send_message` can continue it.

  | Tool | Permission | What it does |
  |---|---|---|
  | `agent` / `workflow` with `run_in_background` | meta | Start a sub-agent / a workflow run detached; the run is recorded and in the runs list like any other. |
  | `send_message` | meta (like `agent`) | Continue a sub-agent you started, with its context intact: a finished one runs again and returns its new report (later, with `run_in_background`); a background one still working sees the message at its next step. |
  | `task_list` | read | Background shells, sub-agents, workflow runs and monitors: id, kind, status, age, last line of output. |
  | `task_output` | read | A task's output (a shell's log, an agent's report or latest message, a run's steps), with `tail`, `offset` and a 30,000-character cap. |
  | `task_stop` | meta | Stop a task: a shell's whole process tree, an agent, a run, a monitor. Stopping what the agent itself started needs no approval. |
  | `monitor` | read | Wait without model calls until a shell's output has a line matching a regex (patterns that backtrack without end are refused, and each line is tested with a 50 ms limit, so no pattern can stall the server), or a task ends, or a timeout (60 s default, 10 min max); with `run_in_background` it fires as a reminder instead (up to an hour). |

  - **An idle session is not woken by default.** A result that arrives when no turn runs is queued for the agent, and the user gets a notice (and the `Notification` hooks fire): nothing is spent without them, and their next message carries it. `HARNESS_BACKGROUND_WAKE=1` starts a turn instead, as Claude Code does.
  - **Limits and stopping.** Background sub-agents take the same slots as foreground ones (`maxParallelSubagents`), are charged to the session, keep taint in both directions, and their permission prompts stay open after the turn that started them ends. The user's **Stop** stops the turn and every background agent, workflow and monitor (the UI shows "Stop background" while only those run); background shells keep running, since they are usually servers, until `task_stop` or the session is deleted.
  - **Only the main agent starts background work.** Sub-agents get `send_message` only where they may start their own (`HARNESS_SUBAGENT_DEPTH`), and a sub-agent's `run_in_background` runs in the foreground. They may read and watch tasks and stop their own.
  - **In memory.** The task list and the kept sub-agents (the last 20 finished, least recently used dropped first) live with the session in the server's memory; a restart forgets them (background shells keep running, and their logs stay in `.harness/bg/`). On a companion, `bash` runs on the user's computer, so its background shells are not in the task list.
- **Slash commands.** `/<skill> [task]` in a message loads that skill with it (custom commands are skills, as in Claude Code); `/compact` compacts the context now.
- **MCP bundles** (`.mcpb`, Claude Desktop's one-click "Desktop Extensions"): an administrator installs one (`POST /api/mcpb` with the file and the values its manifest asks for); it is unpacked under the data folder (paths outside it and links refused), its server registered for every new session, and kept across restarts. Values the manifest marks `sensitive` (API keys) are stored only encrypted (AES-256-GCM) under the server's key - `HARNESS_SECRET_KEY`, else a key generated into `<data>/secret.key` (owner-only) - and decrypted into memory when the server loads them; on disk the config holds `${user_config.key}` placeholders. Keep the key out of backups of the data folder. Bundles installed by an older version, with their values in plain text, are moved to encrypted storage when the server starts (from the manifest's templates; one that cannot be matched is named in the log, to install again).

## Evaluations

`npm run eval -- [--packs sdlc,documents,games,3d] [--models a,b] [--repeat 2] [--concurrency 3]` runs each case in `evals/<pack>/<case>/eval.json` on every model and repeat, in fresh workspaces, and judges it with **hidden checks** the agent never sees: shell commands (the URL shortener's 25 HTTP acceptance checks), gates, required files, and hidden playtests in the headless browser. It writes `report.md` (pass rate with its 95% Wilson confidence interval, checks passed, cost, time, cache hit and calls as "median (min-max)" over the repeats, every failed check) and `results.json`. The checks were calibrated against results verified by hand before they were trusted.

**Harness configurations (ablations).** `--configs <file>` (and/or `--config <name>` / `--config '<name>={...}'`, repeatable) runs every case and model under each named harness configuration, so the same model is measured under several harnesses and the harness's effect can be told apart from the model's. A configuration can change operator settings (`maxSteps`, `maxCostUsd`, `compactAt`, `subagentModel`, `autoModel`, `maxSubagentDepth`, `maxParallelSubagents`, `gatesOnStop`), turn code mode off (`"codeMode": false` removes `run_script`), load only some plugins (`"plugins": ["sdlc"]`), set the `effort`, the `injectionScan`, `memory` (`on`/`read`/`off`), take tools out (`disableTools`), or set other `HARNESS_*` variables (`env`). Each is applied the way an operator would (an operator settings file, the `HARNESS_*` switches), so configurations run one after another while each one's runs stay parallel. The first configuration is the baseline: the report gives each configuration its own row with `Δ pass` (percentage points) and `Δ cost` against the baseline on the same case and model, adds a per-model summary across all cases, and the disclosure block names every configuration. `evals/ablations.json` is an example:

```bash
npm run eval -- --packs sdlc --models deepseek-flash --repeat 3 --configs evals/ablations.json
npm run eval -- --cases url-shortener --repeat 5 --config baseline --config 'compact-early={"settings":{"compactAt":60000}}'
```

Every report names the harness that produced it - version, commit (and whether it had local changes), the loop's settings, plugins and platform - because a score describes a model and a harness together: a controlled study found the same two models swapping places by up to ~38 points across harnesses.

## Observability

Every model and tool call is a span in the session's `trace.jsonl` (UI: "Open trace"). With `HARNESS_OTEL_ENDPOINT` (and `HARNESS_OTEL_HEADERS="k=v,k=v"`) they are also exported as OTLP/HTTP JSON: one trace per session, `chat <model>` spans with `gen_ai.*` token attributes plus cache reads, cost and retries, and `execute_tool <name>` spans with errors. Batched off the request path; a failed export is logged and dropped.

## Measured (2026-10-20, 2026-10-21)

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

**2026-10-21 - every pack on every model again, on native Windows** ([full report](evals/results/2026-10-21.md)): **17/17 runs, 58/58 hidden checks, $4.52** (GPT-6 Luna $0.43 for six cases, Claude Haiku 5.5 $1.41 for six, DeepSeek Flash $2.68 for five), 74-98% of input read from cache. The long-task workflow on Haiku now builds the whole CLI and passes every hidden check (on 2026-10-20 it stopped at 10/26 features: a workflow deadlock, fixed and now verified). Computer use ran live on Haiku and Luna for under a cent each.

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
| `HARNESS_MODELS_JSON` / `HARNESS_MODELS_FILE` | | The operator's OpenAI-compatible models (Ollama, vLLM, LM Studio, OpenRouter, Together, Groq, Azure OpenAI, Gemini, ...): a JSON array or `{ "models": [...] }`, inline / in a file. See Models and providers. Their keys are in the variables the entries name (`apiKeyEnv`). |
| `HARNESS_CLUSTER` | off | `1`: this server shares its data folder with others (see Running several servers). |
| `HARNESS_NODE_ID` / `HARNESS_NODE_URL` | host name and port / none | This server's unique id among them / the address the others pass a session's requests to (https, or http on loopback; without it they answer 409). |
| `HARNESS_CLUSTER_SECRET` | none | At least 32 random characters, the same on every server: signs the addresses in leases and the `x-harness-cluster-auth` header that carries the person on a passed-on request. Without it no request is passed on (409). |
| `HARNESS_CLUSTER_PEERS` | none | Comma-separated server addresses: the only origins requests are passed to (else any address whose lease signature holds). |
| `HARNESS_LEASE_SECONDS` / `HARNESS_SYNC_MS` | 30 / 1000 | How long a stopped server keeps its sessions and the scheduler before another takes over / how often a server re-reads what the others changed. |
| `HARNESS_PLUGINS` | | Plugin folders (`:`-separated). Trusted. |
| `HARNESS_MCP_CONFIG` | | Operator MCP servers, `.mcp.json` format. |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `4310` | |
| `HARNESS_TOKEN` | random, printed | Browser access token. Put the server behind HTTPS before exposing it. |
| `HARNESS_DATA` | `./.harness-data` | Sessions, workspaces, companions. |
| `HARNESS_MAX_STEPS` / `HARNESS_MAX_COST_USD` | 150 / 5 | Per turn / per session. |
| `HARNESS_MAX_TURN_MINUTES` | 0 (off) | Wall-clock minutes a turn may run before it stops with the reason `time`. |
| `HARNESS_INSTRUCTIONS` | | The operator's instruction file for every session (the managed tier). |
| `HARNESS_COMPACT_AT` | per model | Prompt tokens before compaction. |
| `HARNESS_SUBAGENT_MODEL` | session model | E.g. run sub-agents on `deepseek-flash`. |
| `HARNESS_MCP_INLINE_MAX` | 10 | Above this many MCP tools, schemas load on demand. |
| `HARNESS_TRUST_PROJECT` | off | Let repository hooks and stdio MCP servers run outside the sandbox. |
| `HARNESS_AUTO_RESUME` | off | Continue interrupted sessions after a restart. |
| `HARNESS_GATES_ON_STOP` | off | Refuse to end a turn while a blocking quality gate fails. |
| `HARNESS_BUNDLED_PLUGINS` | on | `off` skips the bundled `plugins/` (quality gates, SDLC, visual, documents, games3d, computer, devops). |
| `HARNESS_PLUGIN_KEYS` | | Trusted public keys; when set, every non-bundled plugin must be signed. |
| `HARNESS_PLUGIN_NETWORK` | | Hosts the operator grants a plugin beyond its manifest's `permissions.network`, as JSON: `{"devops": ["github.acme.internal"], "aiops": ["prometheus.internal:9090"]}` (a GitHub Enterprise or internal monitoring address). Only the operator can widen a plugin's reach. |
| `HARNESS_PLUGIN_CATALOGUE` | | Signed plugins to install from the UI/API: a folder, or the https URL of an `index.json`. |
| `HARNESS_ROUTE_RATE_LIMIT` | 600 | Requests a minute per address to plugin routes (`/api/plugins/<plugin>/...`). |
| `HARNESS_PLUGIN_SESSION_OWNERS` | none | Accounts whose sessions a plugin may message and answer for besides the operator's and plugin-started ones, as JSON: `{"integrations": ["usr_...", "*"]}`. |
| `HARNESS_PLUGIN_LOOPS` | on | `off`: plugins' server-side loops do nothing here (`api.lease()` is false); the eval runner, the CLI and the test runner turn them off. |
| `HARNESS_CHANGES_MAX_MB` | 20 | The change journal (`<data>/changes.jsonl`) keeps its newest half past this size. |
| `HARNESS_OPS_WATCH_SECONDS` | 60 | The aiops model-free watch loop's interval (at least 5); 0 turns it off. |
| `HARNESS_OPS_WATCH_PATH` | `HARNESS_OPS_ALERTS_PATH` | A workspace whose inventory the watch loop and the alert routes read besides the operator's. |
| `HARNESS_OPS_ALERTS_PATH` | none | The server folder alert investigations work in (the ops workspace). |
| `HARNESS_OPS_ALERTS_MODEL` / `_OWNER` / `_MODE` / `_WORKFLOW` | first available / operator / dontAsk / incident-response | Alert investigations: the model (set it), the owning account, the permission mode, the workflow (`none`: a prompt). |
| `HARNESS_OPS_ALERTS_MIN_SEVERITY` | warning | The least severity of an incident that gets an investigation (critical, warning, info). |
| `HARNESS_OPS_ALERTS_MAX_CONCURRENT` / `_MAX_PER_HOUR` | 2 / 6 | Alert investigations running at once / started an hour (0: no limit). |
| `HARNESS_OPS_ALERTS_INVESTIGATE` | 1 | `0`: alerts are grouped into incidents, no session is started. |
| `HARNESS_OPS_ALERTS_GROUP_WINDOW` / `_FLAP_COUNT` / `_FLAP_WINDOW` | 5m / 4 / 30m | How long a group with every alert resolved waits before it resolves / state changes that make an alert flapping, within that window. |
| `HARNESS_OPS_CHANGE_WINDOW` | 2h | How far before an incident's start its changes are attached. |
| `HARNESS_OPS_WEBHOOK_SECRETS` | none | Vault names of webhook signing secrets, as JSON: `{"pagerduty": "ops-pagerduty-webhook", "github": "ops-github-webhook"}` (grant `plugin:aiops` on each entry's allow list). |
| `HARNESS_MEMORY` | on | `read` (load, never change) or `off`. |
| `HARNESS_SEARCH` | first available | `brave`, `tavily`, `exa`, `searxng`, `deepseek`, `anthropic`, `openai` or `off`; keys `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `HARNESS_SEARXNG_URL`. |
| `HARNESS_SEARCH_ANTHROPIC_MODEL` / `HARNESS_SEARCH_OPENAI_MODEL` | `claude-haiku-5-5` / `gpt-6-luna` | The small model that runs a provider's built-in search. |
| `HARNESS_GITHUB_TOKEN`, `HARNESS_PUBLISH_REPOS`, `HARNESS_GITHUB_API`, `HARNESS_GIT_AUTHOR`, `HARNESS_PUBLISH_TOKEN_HOSTS` | | `publish_branch`: token, extra repositories it may push to, API base (GitHub Enterprise), commit author `"Name <email>"`, other git hosts the token may be sent to. The devops `ci` tool uses the same token (when the Key Vault has no `github-token`) and API base. |
| `HARNESS_PUBLISH_PREFIX` | `agent/` | Branches the agent may push are under this prefix (`""`: any name). |
| `HARNESS_PUBLISH_UPDATE` / `HARNESS_PUBLISH_READY` | off / off | `1`: may push to a branch this session did not create / may open ready (non-draft) pull requests. |
| `HARNESS_CLONE_REPOS` | | Private repositories cloned with `HARNESS_GITHUB_TOKEN` at session creation (`owner/name`, URLs, `owner/*`; the publish repositories count too). |
| `HARNESS_SANDBOX_ALLOW_HOSTS` | registries + GitHub | Comma-separated hosts an allowlist sandbox may reach (an entry may add methods: `example.com GET,HEAD`); `HARNESS_SANDBOX_UPSTREAM_PROXY` chains its proxy through a corporate one. |
| `HARNESS_SANDBOX_RUNTIME` | Docker's (runc) | An OCI runtime for sandbox containers, e.g. `runsc` (gVisor) or `kata-runtime`; the server will not start if Docker lacks it. |
| `HARNESS_USER_DAILY_USD` | none | Daily spend cap per account. |
| `HARNESS_USER_MAX_RUNNING` / `HARNESS_USER_MAX_SANDBOXES` | 4 / 8 | Sessions working at once / sessions with a sandbox container, per account (0 = no limit); over it: 429. |
| `HARNESS_COMPANION_TOKEN_DAYS` / `HARNESS_COMPANION_TOKEN_GRACE_MIN` | 30 / 60 | How long a companion token lasts (replaced while the companion polls) / how long a replaced one still works. |
| `HARNESS_SECRET_KEY` | `<data>/secret.key` | The key that encrypts secrets at rest (key vault values, MCP bundles' sensitive values): at least 32 random characters, e.g. `openssl rand -hex 32`. Without it a key is generated into the data folder (owner-only). Back it up apart from the data folder: without it, sealed values cannot be read. |
| `HARNESS_VAULT` | on | The key vault: `admins` (only administrators' sessions get it) or `off`. Operator-scope entries are for administrators' sessions unless an entry's `allow` names members or accounts (see Key Vault). |
| `HARNESS_VAULT_BACKENDS` | local only | External backends as JSON: `{"<name>": {"type": "hashicorp" | "azure" | "aws", ...}, "default": "<name>"}` (see Key Vault); their credentials from `VAULT_TOKEN` / `VAULT_ROLE_ID` / `VAULT_SECRET_ID`, `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` / `AWS_REGION`, or `${VAR}` in the JSON. |
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
| `HARNESS_SANDBOX_IMAGES` | | Other images a sandbox session may choose (comma-separated), e.g. `harness-sandbox-3d:latest,harness-sandbox-3d:export,harness-sandbox-desktop:latest,harness-sandbox-ops:latest` (the second has Godot's export templates, the third a desktop for computer use, the fourth the DevOps toolchain). |
| `HARNESS_BLENDER`, `HARNESS_GODOT` | auto | Blender and Godot for server-folder sessions (searched on the PATH and in the usual install folders); on a companion, the same variables on the user's computer. |
| `HARNESS_DEVOPS_IMAGE` / `HARNESS_DEVOPS_NETWORK` | / `none` | Server-folder sessions: run the devops tools and gates in a throwaway container of this image (e.g. `harness-sandbox-ops:latest`) with the workspace mounted, on this Docker network. |
| build args of `docker/Dockerfile.sandbox-3d` | `GODOT_EXPORT_TEMPLATES=0` | `1` adds Godot's export templates (`npm run sandbox:image:3d-export`); `GODOT_TEMPLATES` lists the template files kept (default Linux x86_64, Web, ICU data; `all` for every platform). |
| build args of `docker/Dockerfile.sandbox-ops` | `TRIVY_DB=0` | `1` bakes trivy's vulnerability database into the ops image (about 0.8 GB) so vulnerability scans work offline; tool versions and checksums are `ARG`s at the top. |
| `HARNESS_DESKTOP_SIZE` | `1280x800` | The `computer` tool's display in a sandbox (`WxH`, 640x480 to 3840x2160). Screenshots larger than 1280x800 are scaled down to fit. A companion's real screen keeps its own size, scaled the same way. |
| companion `--allow-desktop` | off | The `computer` tool on the user's real screen, mouse and keyboard through that companion (each action approved; see Computer use). |
| `HARNESS_TEST_REAL_DESKTOP` | off | `1`: the desktop test takes a real screenshot and moves the pointer on the machine running the tests (never in a normal run). |
| `HARNESS_TEST_OLLAMA`, `_URL`, `_MODEL`, `_IMAGE` | runs if the image is present | The real Ollama test: `1` pulls `ollama/ollama` (several GB) / use a running server / the model (`qwen2.5:0.5b`) / the image. |
| `HARNESS_TEST_KEYCLOAK`, `_IMAGE`, `_URL`, `_ADMIN_PASSWORD` | runs if an image is present | The real Keycloak test: `1` pulls `quay.io/keycloak/keycloak:26.7.4` / another image / a running dev-mode Keycloak and its admin password. |
| `HARNESS_TEST_KIND` / `HARNESS_TEST_KWOK` | off / auto | `1`: the devops tests make a real kind cluster (minutes; pulls kindest/node) / pull the kwok image for the cluster test (it runs whenever the image is already there; `0` skips it). |
| `HARNESS_PRICING_JSON` | | Override prices per model. |
| `HARNESS_SETTINGS` | | The operator's settings file (JSON: `permissions`, `hooks` of every kind, `maxSteps`, `maxCostUsd`, `maxTurnMinutes`, `compactAt`, `subagentModel`, `autoModel`, `gatesOnStop`, `maxSubagentDepth`, `maxParallelSubagents`). |
| `HARNESS_AUTO_MODEL` | sub-agent model | The model that checks calls in auto mode. |
| `HARNESS_TAINT_GUARD` | on | `off` stops confirming ways out after untrusted content (not recommended). |
| `HARNESS_SANDBOX_CREDENTIALS` | | API credentials allowlist sandboxes use through their proxy: `openai`, `anthropic`, `deepseek` (inference endpoints only), `github` (`HARNESS_SANDBOX_GITHUB_TOKEN`; read-only, `github:write` for writes), and/or the path of a JSON file of `{name, upstream, headers, env, allow?}`. |
| `HARNESS_LOCAL_SANDBOX` | off | How server-folder sessions contain commands by default: `auto`, `bwrap`, `seatbelt`, `docker` or `off`. |
| `HARNESS_REPO_SETUP` | off | `1`: a repository's `.harness/setup.sh` runs as a Docker session's setup script. |
| `HARNESS_SNAPSHOT_DAYS` / `HARNESS_SETUP_TIMEOUT_S` | 7 / 900 | How long setup snapshots are reused / how long a setup script may run. |
| `HARNESS_SUBAGENT_DEPTH` / `HARNESS_SUBAGENTS_PARALLEL` | 1 / 10 | How deep sub-agents may nest (at most 3) / how many run at once (at most 20). |
| `HARNESS_MAX_SCHEDULES` | 50 | Scheduled prompts per person. |
| `HARNESS_BACKGROUND_WAKE` | off | `1`: a background agent, workflow, shell or monitor that finishes while the session is idle starts a turn with its result (default: the user is told, and the agent sees it with their next message). |
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
  - Godot exports: the export image has the Linux x86_64 and Web templates only (rebuild with `GODOT_TEMPLATES=all` for the rest); a Web export was checked for its files, not played in a browser. Outside a sandbox the templates must be installed by hand.
  - The `godot-selftest` gate proves only what the game's own `--selftest` checks; the playtester reads the scripts to judge that, but cannot play a Godot game with input.
  - Blender and Godot on a companion need `--allow-hooks`; the `model-preview` gate on a companion cannot tell whether the renders are newer than the model (its copy has the copy's file times).
  - The egress proxy does no TLS interception: over HTTPS it decides by host (and port) only. Method limits hold for plain `http://` and for the credential gateway; a host given a method list is refused over an HTTPS tunnel rather than opened unchecked.
  - Secrets at rest are encrypted with a key the server itself can read (`HARNESS_SECRET_KEY` or `<data>/secret.key`): that protects a copied data folder or a backup without the key, not the server's account. A headless server has no OS keychain to hold the key.
  - Key vault redaction replaces the forms a value is usually printed in (as is, base64, URL-encoded, JSON-escaped, PEM lines). A command that holds a secret can still transform it some other way (reversed, hex, split across lines, encrypted) and print that: the secret is the command's to use, which is why a command with secrets is asked about. Values shorter than 6 characters are refused (they cannot be told apart from ordinary text). Text the model streams is hidden per chunk, so a value split across two chunks can show in the live view until the message is complete (the stored message and the model's next request are hidden). A provider's signed or encrypted reasoning blocks (Claude's thinking signatures) are replayed unchanged, so a value the model wrote itself (`vault set`) can remain inside its own signed reasoning; `generate` avoids the model seeing a value at all.
  - Companion tokens are short-lived and replaced in the background, but a companion that stays offline past expiry needs a new token from the web app.
  - Several servers on one folder: a crashed server's sessions wait for the lease time (30 s) before another takes them over; an event stream a browser already had open on a server stays quiet when another server takes the session (a reload, or sticky sessions, fixes it); a companion serves the server it polls; the shared filesystem must support atomic exclusive create and rename (local disks, NFSv3+, SMB do) and the servers' clocks must agree to well within the lease time. On Windows a file read in a tight loop can hold off a rename over it for seconds (retried up to about ten).
- **Not tested here:** Seatbelt on a real Mac and Docker Desktop for macOS (no Mac was available: the Seatbelt profiles, including the allowlist one, are tested as generated text); desktop control on a real Mac (tested as generated script text; on Windows a real screenshot and pointer move were run, clicks and typing only against a stand-in; on Linux the whole set ran on a real X server in Docker, not on a physical Linux desktop with a desktop environment); bubblewrap (and its allowlist bridge) ran for real inside a Linux container, not on a Linux desktop; gVisor and Kata (not installed: the runtime option is tested with a missing runtime and with `runc` named explicitly); Godot on Windows or macOS outside the sandbox (only discovery is tested there), and Godot installed on a user's computer behind a companion (screenshots ran with real Godot in a companion whose commands run in the 3D image); Azure Key Vault and AWS Secrets Manager (the key vault backends were tested against local stand-ins that check the sign-in and the SigV4 signatures; HashiCorp Vault ran for real); prices, which come from the providers' pages on 2026-10-19 and can change.
