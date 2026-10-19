# Harness Web

A browser-based agent harness: you give it requirements, and it works in a workspace until the job is done. It reads code, plans, edits files, runs commands and tests, fixes what fails, and reports back. Its design follows the published architecture of Claude Code and Codex. It runs on three models, each tuned for cost: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** (`deepseek-flash`) and **GPT-6 Luna**.

```
browser ──HTTPS/SSE──> server (holds the API keys) ──> model provider
                          │
                          ├─ tools run in a per-session Docker sandbox, or
                          ├─ in a folder on the server (opt-in), or
                          └─ on your own computer through the companion (outbound-only)
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

Requires Node 22.18+, which runs the TypeScript directly. Docker is optional: without it, use the companion or a server folder.

Headless, for scripts and CI:

```bash
npm run cli -- --model deepseek-flash --runtime local --dir ./project "Add input validation to the API and tests for it"
```

## How it works

**One loop that the model drives** (`src/core/agent.ts`). Each step calls the model, runs the tools it asked for, appends the results, and repeats until the model answers without calling a tool. Read-only calls in the same turn run in parallel; everything else runs in order. The loop stops at a step limit, at a session spend limit, when the user presses Stop, or on a refusal.

**Errors go back to the model as repair instructions, not crashes:**

- an invalid JSON argument returns the parse error and the expected schema;
- an unknown tool returns the list of real tools;
- a missing parameter is named;
- an edit whose text was not found points to the line that nearly matched;
- a call that was cut off at the output limit is refused rather than run;
- a call repeated three times with the same arguments gets a "try something else" reminder.

The research showed that how errors come back is the single biggest reason one harness gets more out of a model than another.

**Cache first** (`src/providers/*`):

- The system prompt (about 450 tokens) is identical for every session. Everything that varies (date, workspace, AGENTS.md / CLAUDE.md) goes in the first user message.
- The tool list is fixed for the whole session and sorted by name.
- The history only ever grows. Reminders are appended, never inserted earlier.
- Each provider gets its own caching setup:
  - **Claude** gets one explicit cache breakpoint on the system prompt, which also covers the tools, plus automatic caching of the conversation tail. Old tool results are cleared on the server (context editing), so the transcript we send never changes and thinking signatures stay valid.
  - **OpenAI** uses the Responses API with `prompt_cache_key` per conversation and `store: false`. Its encrypted reasoning items are replayed exactly as received.
  - **DeepSeek** caches automatically by prefix, so the job is to keep that prefix byte-identical. `reasoning_content` is replayed, as its API requires.
- Cache hit rate and cost are measured on every request and shown live.

**Context management.** Compaction triggers per model, at a level chosen for cost as well as fit. Haiku 5.5 compacts before 100K tokens, because longer prompts bill at five times the rate. The summary request is the current context plus one appended instruction, so it reads the cache the loop has built. The new context is that summary, the task list, and your latest message. Every provider accepts this shape.

Sub-agents (`agent` tool) explore or work in their own context and return only a report. Several run in parallel.

**Tools:**

| Tool | Purpose |
|------|---------|
| `read` / `write` / `edit` | Exact-string edits. Refuses to change a file it hasn't read, or one changed since it was read. |
| `glob` / `grep` | ripgrep when available. |
| `bash` | Timeout, head-and-tail output, and `run_in_background` for servers. |
| `todo_write` | The agent's task list. |
| `web_fetch` | SSRF-guarded. |
| `agent` | Starts a sub-agent. |
| `ask_user` | Asks you a question. |
| `exit_plan_mode` | Presents a plan for your approval. |

**Permissions** (`src/core/permissions.ts`) are enforced in code on every call. Order: deny rules, then ask rules, then allow rules, then the mode's default.

- **Ask before edits** (default): sandboxed commands run freely; edits and commands on a real machine ask first.
- **Auto-accept edits**
- **Plan mode**: read-only until you approve a plan.
- **Bypass**

"Always allow" in the approval prompt adds a rule for the rest of the session. A prefix rule like `bash(npm test:*)` never covers a compound command (`npm test; rm -rf ~`).

**Hooks** (`.harness/settings.json`), shell commands with the event as JSON on stdin; exit code 2 blocks:

- `PreToolUse` / `PostToolUse`: block a call, or attach feedback to its result.
- `Stop`: send the agent back to work, e.g. "the tests still fail".
- `UserPromptSubmit`, `SessionStart`

Project hooks and allow-rules come from the repository, so they are trusted only in the sandbox.

```json
{
  "permissions": { "deny": ["read(**/.env*)"], "ask": ["bash(git push:*)"] },
  "hooks": {
    "PostToolUse": [{ "matcher": "edit|write", "command": "npx prettier --write . >/dev/null 2>&1; true" }],
    "Stop": [{ "command": "npm test >/dev/null 2>&1 || { echo 'Tests fail. Fix them before finishing.' >&2; exit 2; }" }]
  }
}
```

## Where the agent works

- **Sandbox** (Docker; the default)
  - One container per session.
  - No capabilities, `no-new-privileges`, and limits on memory, CPU and processes.
  - No network unless you enable it for the session.
  - Your files sit in a host folder mounted at `/workspace`. The file tools check real paths, so a symlink planted from inside the container cannot reach the host.
- **Your computer** (companion)
  - Open "Your computers", then run the two lines it shows in the folder you want to work on.
  - `harness-companion.mjs` needs Node 18+ and nothing else.
  - It connects out to the server (long-poll over HTTPS: no open ports, works behind NAT) and runs tool calls in that folder only.
  - Hooks run there only with `--allow-hooks`.
- **Server folder**: opt-in with `HARNESS_LOCAL_ROOTS`.
  - Commands are not sandboxed.
  - Their environment is stripped of anything that looks like a credential, so the agent cannot read the server's API keys.
  - They can still reach services on the server's network, the harness itself included. In testing, an agent probed port 4310 and got a 401, so the access token is what protects the API. Keep this mode for trusted, single-user machines.

## Configuration

| Variable | Default | |
|---|---|---|
| `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` (or `GW_ANTHROPIC_API_KEY`) | | Models without a key are greyed out. |
| `HARNESS_HOST` / `HARNESS_PORT` | `127.0.0.1` / `4310` | |
| `HARNESS_TOKEN` | random, printed | Browser access token. Put the server behind HTTPS before exposing it. |
| `HARNESS_DATA` | `./.harness-data` | Sessions (append-only JSONL), workspaces, companions. |
| `HARNESS_MAX_STEPS` | 150 | Model calls per user turn. |
| `HARNESS_MAX_COST_USD` | 5 | Spend cap per session. |
| `HARNESS_COMPACT_AT` | per model | Override the compaction threshold, in prompt tokens. |
| `HARNESS_SUBAGENT_MODEL` | session model | E.g. run sub-agents on `deepseek-flash`. |
| `HARNESS_SANDBOX_IMAGE`, `_MEMORY`, `_CPUS`, `_IDLE_MS` | `harness-sandbox:latest`, `4g`, `2`, 30 min | |
| `HARNESS_PRICING_JSON` | | Override prices: `{"gpt-6-luna":{"input":0.1,"cacheRead":0.01,"cacheWrite":0,"output":0.5}}`. |

## Honest limits

- **This is not Claude Code's code.** Claude Code is closed source. This harness follows its *published* design and open-source harnesses (Codex CLI, mini-swe-agent). Unpublished tuning, such as the exact prompts, is not reproduced.
- **The harness lifts every model, but cannot make them equal.** Published studies show harness changes are worth 5–30 points on agent benchmarks, and the model is still most of the result. Run `npm run bench` to measure the models on your own tasks.
- **Not tested here:**
  - The Claude path is written to Anthropic's current API docs but was not exercised live in development, because no Anthropic key was available.
  - Prices come from the providers' pages on 2026-10-19 and can change.
  - GPT-6 Luna's rate card covers prompts up to 272K tokens, so its context is kept below that.
- **Not built yet:**
  - background compaction;
  - per-host network allowlists in the sandbox (it is all or nothing);
  - checkpoints / rewind;
  - MCP servers;
  - image input;
  - multi-user accounts (one access token).
