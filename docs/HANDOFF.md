# Harness Web - handoff guide

Where the framework stands on 2026-10-21, how to pick it up on your own machine, and what comes next.
The README is the reference for every feature; this page is the map. The browser UI in `ui/` is a working console over the API; the focus is the framework.

## 1. Purpose

Harness Web is a **browser-based agent harness that is also a framework**, in the spirit of Claude Code:

- You give it requirements; an agent works in a workspace until the job is done - plans, edits, runs, tests, fixes, reports.
- It is **cache-first and token-efficient**: a frozen system prompt and sorted tool list so every request reuses the provider's cache, append-only history, clearing of old tool output, compaction (server-side on Claude), deferred MCP tools, and "code mode" (`run_script`) that keeps intermediate results out of the context.
- It is **pluggable**: tools, models, providers, sub-agents, skills, MCP servers and bundles, quality gates, workflows, search backends, output styles and hooks all register through one registry, the same way the built-ins do.
- It is tuned and tested on three cost-efficient models: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** and **GPT-6 Luna**. The bet is that a good harness lets cheap models do work that usually needs expensive ones, and the evals check that with hidden tests the agent never sees.

The framework is complete against the research in `docs/Agent harnesses and Claude Code.md`: every mechanism it describes was audited against the code on 2026-10-21 and the missing ones were built (phases 8-12 below). What a harness cannot do by design is listed under "Honest limits" in the README.

## 2. What is built (phase by phase)

| Phase | What it added | Where |
|---|---|---|
| 0 | Agent loop, three cache-aware providers, tools, permissions and hooks, Docker / server-folder / companion runtimes, sessions, HTTP+SSE server, browser UI | `src/core`, `src/providers`, `src/tools`, `src/runtime`, `src/server`, `ui/` |
| 1 | Registry and plugins, skills, named sub-agents, MCP (stdio + HTTP, deferred tool search), images, checkpoints, recovery after restart, trace | `src/kernel`, `src/plugins`, `src/skills`, `src/agents`, `src/mcp` |
| 2 | Durable workflow graphs (agent, gate, approval, parallel, branch, shell, code, end); `quality-gates` (13 gates); `sdlc` pack and `build-feature` | `src/graph`, `plugins/quality-gates`, `plugins/sdlc` |
| 3 | `visual` (render, headless browser, add_library, render/console/playtest gates); `documents` (decks, documents); `games3d` (games, 3D models) | `plugins/visual`, `plugins/documents`, `plugins/games3d` |
| 4 | `npm run eval` with hidden checks; Ed25519 plugin signing and catalogue; OpenTelemetry; Docker for Windows/macOS; native Windows | `src/eval`, `evals/`, `src/plugins/signing*`, `docker/` |
| 5 | Memory across sessions; research (web_search with 7 backends, readable web_fetch, source store, citation checker, deep-research workflow); accounts, ownership, rate and spend limits; plugin permissions; per-host network allowlist (egress proxy); `publish_branch`; Claude server-side compaction; code mode; `long-task` workflow; Chromium-only rendering; remote plugin catalogue | `src/memory`, `src/research`, `plugins/research`, `src/server/users.ts`, `src/runtime/egress-proxy.mjs`, `src/git/publish.ts`, `src/tools/code*` |
| 5b/5c | Blender and Godot in `games3d`: `blender` and `godot` tools, `blender-file`, `godot-project`, `godot-selftest`, `model-preview` gates, skills; the 3D image and its export variant with Godot's templates (`npm run sandbox:image:3d`, `:3d-export`); Godot screenshots on companions; `engine=blender` / `engine=godot` branches of `model-3d` and `build-game` | `plugins/games3d`, `docker/Dockerfile.sandbox-3d`, `docker/godot-templates.sh` |
| 6 | Single sign-on (OpenID Connect, PKCE, JWKS rotation, allowlists, admin mapping, verified e-mail required, provider sign-out) | `src/server/oidc.ts`, `ui/src/auth.ts` |
| 7 | Security and sandboxes: the untrusted-content ("lethal trifecta") guard across sub-agents, workflows, allow rules and auto mode; hidden-text stripping (invisible Unicode, hidden HTML, HTML comments); DNS pinning; the credential gateway at the egress proxy (keys never enter the sandbox; per-credential method and path rules, `github` read-only unless `github:write`); OS sandboxes (bubblewrap, Seatbelt) with daemon sockets hidden, `.git` hooks/config read-only and an allowlist through a local proxy; `HARNESS_SANDBOX_RUNTIME` (gVisor, Kata); setup scripts with per-account snapshots; git worktrees; least-privilege publishing (`agent/` branches, drafts, private clones with a header token) | `src/core/permissions.ts`, `src/core/untrusted.ts`, `src/runtime/*`, `src/git/*` |
| 8 | Hooks of five kinds (command, http, prompt, mcp_tool, agent) on 21 events; permission modes default / acceptEdits / auto (a checking model) / dontAsk / plan (the agent can enter it) / bypass; settings tiers (operator, per account, project, local) and instruction tiers (managed, user, project with `@imports`, local, nested per folder); output styles; a turn time limit | `src/core/hooks.ts`, `src/core/settings.ts`, `src/core/instructions.ts`, `src/core/prompt.ts` |
| 9 | Background work: background sub-agents and workflows, `send_message` to continue a sub-agent, `task_list` / `task_output` / `task_stop`, `monitor`; nested sub-agents up to 3 levels with a parallel limit; scheduled prompts (cron, once) and triggers (secret URLs for Slack, webhooks, phones); per-account concurrency caps | `src/core/session.ts`, `src/tools/tasks.ts`, `src/core/scheduler.ts` |
| 10 | Workflows: typed state with reducers, conditions, a `map` node over a list (concurrency, resume of unfinished items), quoted shell values; the `workflow` tool and slash commands | `src/graph/state.ts`, `src/graph/runner.ts` |
| 11 | Computer use: the `computer` tool in the desktop sandbox image (Xvfb, Firefox, xterm) and, opt-in, on the user's real desktop through the companion (`--allow-desktop`; Windows, macOS, Linux X11), asked about on a real desktop and always untrusted there | `plugins/computer`, `src/companion/desktop.ts`, `docker/Dockerfile.sandbox-desktop` |
| 12 | Portable sessions (export/import between servers and the desktop app), MCP bundles (`.mcpb`, secrets encrypted at rest), companion tokens that expire and rotate, headless CLI with JSON output and exit codes, eval ablations (`--configs`) with confidence intervals and re-judging (`--rejudge`) | `src/core/portable.ts`, `src/mcp/mcpb.ts`, `src/runtime/companion.ts`, `src/cli.ts`, `src/eval/*` |

Code reviews: every finding from every review was fixed with a regression test that fails without the fix. On 2026-10-21 alone, two full reviews (15 and 13 findings: taint gaps through sub-agents, allow rules and auto mode; local escape channels from the OS sandboxes; a setup-log link the server followed; shared snapshots; export through swapped links; unverified SSO e-mail; background logs and output styles read through links; background results not fenced as data; repository rules covering real-desktop actions; imports reaching secrets; unquoted workflow shell values; a monitor regex that could stall the server; a sub-agent slot deadlock; and more) - see the commit messages of 20aa7bd and ac1656b.

## 3. Results

- **Evals, 2026-10-21, native Windows** (`evals/results/2026-10-21.md`): every pack on every model - **17/17 runs, 58/58 hidden checks, $4.52**, 74-98% of input read from cache. The long-task workflow on Claude Haiku 5.5 now builds the whole CLI and passes every hidden check (the 2026-10-20 deadlock fix is verified).
- **Earlier evals** (`evals/results/2026-10-20*.md`): 12/12 runs, 39/39 checks; research 3/3; code mode about half the cost; memory across sessions; server-side compaction.
- **Live checks today, for cents:** computer use in the desktop sandbox on Haiku ($0.002) and Luna ($0.0004); the credential gateway against OpenAI's API; DeepSeek as the auto-mode checker and the injection scanner; the real desktop through a companion on Windows (screenshot and pointer).
- **Tests:** `npm test` - 345 tests, 0 failing on native Windows 11 with Docker Desktop and every image built (5 skip: bubblewrap natively, and the opt-in real-desktop test, which never moves the mouse unless `HARNESS_TEST_REAL_DESKTOP=1`). The same suite in a Linux container as a normal user: 0 failing (Docker-in-Docker and live-key tests skip there; bubblewrap runs for real inside a container from the Windows run). Typecheck clean.
- **Screenshots** of the running app, made by `node scripts/screenshots.mjs` against real sessions: `docs/screenshots/` (home, new session, an approval in the sandbox, a sandbox task with tests and gates, an approval and its result on a server folder, computer use, workflows, background tasks with monitor and task_stop).

## 4. Picking it up on your own machine

```bash
git clone https://github.com/suhail-akhtar/agent-harness-web
cd agent-harness-web
npm ci                              # Node 22.18+; runs the TypeScript directly
npx playwright install chromium     # render/browser tools
npm run build                       # browser UI + companion script (dist/companion.mjs)
npm run typecheck && npm test       # 0 failing; some tests skip without Chromium, LibreOffice, Blender or the Docker images
npm start                           # http://127.0.0.1:4310, prints an access token
```

Keys go in a `.env` file where you run it (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GW_ANTHROPIC_API_KEY`); every npm launcher reads it, and variables already set win. Never commit it (it is in `.gitignore`).

- Docker is optional. With it: `npm run sandbox:image` once (sandbox sessions with the allowlist network), and as wanted `sandbox:image:3d` (Blender, Godot), `sandbox:image:3d-export` (Godot export templates), `sandbox:image:desktop` (computer use); allow them with `HARNESS_SANDBOX_IMAGES`. Without Docker, use a server folder (contained by bubblewrap or Seatbelt where available) or the companion.
- The companion: "Your computers" in the UI shows the two lines to run on your machine (`node dist/companion.mjs --server ... --token ...`, plus `--sandbox`, `--allow-hooks`, `--allow-desktop` as wanted).
- Windows: Git for Windows (Git Bash runs the commands); LibreOffice only for Office files.
- Accounts: `npm run users -- add <name> [--admin]`, or single sign-on (`HARNESS_OIDC_*`).
- Evals cost real money: run one case on one model first (`npm run eval -- --cases expense-cli --models gpt-6-luna`); `--rejudge <dir>` re-runs only the checks.
- Screenshots: start the app with `HARNESS_AUTH=off` on loopback, then `node scripts/screenshots.mjs --url http://127.0.0.1:<port>`.

How to work on it:

- Every change gets a test in `test/` that fails without it; run `npm run typecheck` and `npm test` before committing. Tests never need real API keys (they use `FakeProvider`); the few live ones skip without a key.
- A new tool, model, gate, workflow or style belongs in a plugin unless it is core (`plugins/*`, `src/plugins/api.ts`); a tool that only works somewhere says so with `availableIn`.
- Anything that keeps data beyond a session sets `persists`; anything that returns outside content is `untrusted` or kind `network`/`external`; anything that can carry data out sets `sendsOut`. The untrusted-content guard relies on these.
- Keep the request prefix stable (system prompt, sorted tools, output style fixed at session start) - the cost numbers depend on the cache.

## 5. Next: the framework and the research

The framework is the product; the apps on top of it can wait. In order:

1. **Measure what the harness adds.** The eval runner can now separate harness from model: run the full set with repeats (`--repeat 3` or more) for confidence intervals, and with harness configurations (`--configs evals/ablations.json`: code mode on/off, compaction point, injection scan, memory, effort) so each mechanism's effect on pass rate and cost is a number, not a claim. Record each run in `evals/results/`. This is the research question the project was built to answer: how far a harness lifts cheap models.
2. **New domains as packs.** Any purpose beyond the bundled ones (sdlc, documents, games3d, research, visual, computer) is a plugin pack: tools, skills, sub-agents, a workflow, quality gates, and eval cases with hidden checks. Write the eval cases first; they decide whether the cheap models can be trusted there. `plugins/*` are the patterns; `src/plugins/api.ts` is the API.
3. **Run it where it has not run.** A real Mac (Seatbelt, its allowlist profile, desktop control through the companion), a Linux desktop (bubblewrap natively, X11 desktop control), gVisor or Kata as the sandbox runtime (`HARNESS_SANDBOX_RUNTIME`), and single sign-on against a real identity provider. Each is built and tested in simulation or a container; none has met the real thing.
4. **More models.** A provider is a plugin (`registerProvider`, `registerModel`): add one, run the eval set on it, compare.
5. **Keep up with the research.** Re-read `docs/Agent harnesses and Claude Code.md` against new Claude Code and agent-harness releases; each new mechanism gets the same treatment as today's audit - built, tested, and measured with the evals.
6. **Scale out when needed.** Sessions live on one server's disk; serving many people from several servers would need shared session storage and a queue in front of the sandboxes.

## 6. Repository status

- `main` holds everything; work happens on branches merged into it.
- Three early commits (cc4d106, f87eecb, 2a51f4d) carry the author's own e-mail and show as unverified on GitHub; left as they are on purpose.
- Evaluation workspaces are not in the repository; results are summarised in `evals/results/`.
