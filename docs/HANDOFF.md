# Harness Web - handoff guide

Where the project stands on 2026-10-21, how to pick it up on your own machine, and what to do next.
The README is the reference for every feature; this page is the map.

## 1. Purpose

Harness Web is a **browser-based agent harness that is also a framework**, in the spirit of Claude Code:

- You give it requirements; an agent works in a workspace until the job is done - plans, edits, runs, tests, fixes, reports.
- It is **cache-first and token-efficient**: a frozen system prompt and sorted tool list so every request reuses the provider's cache, append-only history, clearing of old tool output, compaction (server-side on Claude), deferred MCP tools, and "code mode" (`run_script`) that keeps intermediate results out of the context.
- It is **pluggable**: tools, models, providers, sub-agents, skills, MCP servers, quality gates, workflows, search backends and hooks all register through one registry, the same way the built-ins do.
- It is tuned and tested on three cost-efficient models: **Claude Haiku 5.5**, **DeepSeek V4.1 Flash** and **GPT-6 Luna**. The bet is that a good harness lets cheap models do work that usually needs expensive ones, and the evals check that with hidden tests the agent never sees.

## 2. What is built (phase by phase)

| Phase | What it added | Where |
|---|---|---|
| 0 | Agent loop, three cache-aware providers, tools, permissions and hooks, Docker / server-folder / companion runtimes, sessions, HTTP+SSE server, browser UI | `src/core`, `src/providers`, `src/tools`, `src/runtime`, `src/server`, `ui/` |
| 1 | Registry and plugins, skills, named sub-agents, MCP (stdio + HTTP, deferred tool search), images, checkpoints, recovery after restart, trace | `src/kernel`, `src/plugins`, `src/skills`, `src/agents`, `src/mcp` |
| 2 | Durable workflow graphs (agent, gate, approval, parallel, branch, shell, code, end); `quality-gates` (13 gates); `sdlc` pack and `build-feature` | `src/graph`, `plugins/quality-gates`, `plugins/sdlc` |
| 3 | `visual` (render, headless browser, add_library, render/console/playtest gates); `documents` (decks, documents); `games3d` (games, 3D models) | `plugins/visual`, `plugins/documents`, `plugins/games3d` |
| 4 | `npm run eval` with hidden checks; Ed25519 plugin signing and catalogue; OpenTelemetry; Docker for Windows/macOS; native Windows | `src/eval`, `evals/`, `src/plugins/signing*`, `docker/` |
| 5 | Memory across sessions; research (web_search with 7 backends, readable web_fetch, source store, citation checker, deep-research workflow); accounts, ownership, rate limits, spend limits; plugin permissions (secrets, network); per-host network allowlist for the sandbox (egress proxy); `publish_branch` (push + pull request); Claude server-side compaction; code mode; `long-task` workflow; Chromium-only rendering for PDF/HTML/Markdown; remote plugin catalogue; render/browser on companion sessions | `src/memory`, `src/research`, `plugins/research`, `src/server/users.ts`, `src/runtime/egress-proxy.mjs`, `src/git/publish.ts`, `src/tools/code*.{ts,mjs}`, `plugins/sdlc/workflows/long-task.json` |
| 5b | Blender and Godot in `games3d`: `blender` and `godot` tools (headless bpy scripts; Godot check / run / screenshot / export), `blender-file` and `godot-project` gates, `blender-scripting` and `godot-essentials` skills; the 3D sandbox image (`npm run sandbox:image:3d`: Blender 4.2.23 LTS, Godot 4.7.2, Xvfb, Mesa) and a per-session sandbox image chosen from the operator's `HARNESS_SANDBOX_IMAGES` | `plugins/games3d/lib-engines.mjs`, `plugins/visual/lib/binaries.mjs`, `docker/Dockerfile.sandbox-3d`, `src/runtime/docker.ts` |
| 5c | Blender and Godot, closed gaps: Godot export templates in an image variant (`npm run sandbox:image:3d-export`, `harness-sandbox-3d:export`: Linux and Web templates, checksum-verified) and `export` with presets written only on request (`createPreset`); `godot screenshot` on companion sessions (Godot runs on the user's computer, the frame comes back as one file); an `engine` input for `model-3d` (`blender`: bpy script, `model-preview` gate on the renders) and `build-game` (`godot`: a Godot 4 project, `godot-selftest` gate on its scripted self-test) | `plugins/games3d/index.mjs`, `plugins/games3d/lib-engines.mjs`, `plugins/games3d/lib-png.mjs`, `plugins/games3d/workflows/*.json`, `docker/Dockerfile.sandbox-3d`, `docker/godot-templates.sh` |
| 6 | Single sign-on with OpenID Connect: code flow with PKCE, id_token checks against the JWKS (key rotation), allowlists and admin mapping, accounts made on first sign-in, server-side browser sessions that survive restarts, CSRF checks, `HARNESS_OIDC_ONLY`; Sign in / Sign out in the UI | `src/server/oidc.ts`, `src/server/app.ts`, `ui/src/auth.ts`, `test/oidc.test.ts` |
| 7 | Computer use: the `computer` tool (screenshot, clicks, drag, type, key, scroll, wait, cursor position, zoom, launch; screenshots returned as images, untrusted while a browser is open) and the `computer-use` skill; the desktop sandbox image (`npm run sandbox:image:desktop`: Xvfb, fluxbox, xdotool, ImageMagick, Firefox ESR, xterm, Mousepad); an end-to-end test that types a command into xterm in the real image | `plugins/computer`, `docker/Dockerfile.sandbox-desktop`, `test/computer.test.ts` |

Every finding from the code reviews of this branch was fixed with a regression test that fails without the fix: one review fixed in cc4d106, f87eecb and 2a51f4d (security, correctness, robustness), then a last round of 11 findings in commit 3c8ed77, which closed: the publish token going to any git host, a `run_script` sandbox escape, Windows path traversal in the companion mirror, a symlinked `.git` in publishing, project memory shared between accounts, gaps in untrusted-content tracking, mirror results over the request limit, gates that copied whole folders, quadratic HTML parsing, the compaction threshold, and a plugin named "config" getting the operator's reach.

## 3. Results

Full numbers are in the README ("Measured") and `evals/results/`. In short:

- **Phases 1-4, every pack on every model:** 12/12 runs, 39/39 hidden checks, $2.56 in total, ~93% of input read from cache. These ran on the code before phase 5; the regression run on the phase 5 code was stopped early (4 runs: fire-hydrant and board-deck on Haiku and Luna, all passing; nothing on DeepSeek, arcade or url-shortener).
- **Phase 5** (`evals/results/2026-10-20-p5.md`): research 3/3 with every report approved by the fact-checker; code mode the same answer at about half the cost on all three models; memory carried across sessions on all three; Claude server-side compaction ran three times in one task and stayed correct; the long-task workflow built a whole CLI feature by feature on GPT-6 Luna (11/11 features, every hidden check) and DeepSeek (15/18 features when stopped; the hidden checks pass on what was built). On Haiku it stopped at 10/26 features with the hidden test failing, which exposed a workflow deadlock; the fix (001e88b) is **not yet verified by a re-run**.
- **Single sign-on** (`test/oidc.test.ts`, 10 tests): a fake OpenID provider in the test (discovery, JWKS, authorize, a token endpoint that checks PKCE) drives full sign-ins through the server; it covers account creation and reuse, admin mapping, the allowlist, every id_token check (signature, kid rotation, issuer, audience/azp, expiry, nonce, verified e-mail), replayed state, PKCE mismatch, disabled accounts, CSRF, logout, `HARNESS_OIDC_ONLY` and sessions surviving a restart. Not yet tried against a real provider.
- **Tests:** `npm test` - 240 tests; typecheck clean. Some skip unless their tools are installed: Chromium, LibreOffice, Docker with the sandbox image, Blender, Docker with the 3D image (3), Docker with the export image (1), bubblewrap on Linux (2). The 5c run (2026-10-21, Windows 11, Docker Desktop, every image built): 237 pass, 2 skip (bubblewrap), 1 fails only because it ran in a worktree with no node_modules of its own (the bubblewrap-in-a-container test mounts the checkout and cannot find `undici`). All pass on native Windows 11 since 2026-10-21 (see below); there, with Docker Desktop and both images built, only the Chromium and LibreOffice ones skip. On Linux they passed before; a run on 2026-10-21 inside `harness-web:dev` as root had 4 failures (companion mirror, three workflow tests) that fail the same way on the commit before the Blender/Godot work - to look into (root in the container is the first suspect).
- **Tests:** `npm test` - 172 tests; typecheck clean. 12 skip unless their tools are installed: Chromium (7), LibreOffice (1), Docker with the sandbox image (1), Blender (1), Docker with the 3D image (2), Docker with the desktop image (1, the computer-use test). All pass on native Windows 11 since 2026-10-21 (see below); there, with Docker Desktop and both images built, only the Chromium and LibreOffice ones skip. On Linux they passed before; a run on 2026-10-21 inside `harness-web:dev` as root had 4 failures (companion mirror, three workflow tests) that fail the same way on the commit before the Blender/Godot work - to look into (root in the container is the first suspect).
- **First run on a real Windows machine (2026-10-21):** 9 tests failed and were fixed, each with a test: publishing broke because Git for Windows rejects `os.devNull` as a config path (now `NUL`); Git Bash cut off `-c` commands near 8K characters (long commands now run from a script file); the memory store's `mkdir` followed a planted link before the link check (a check on every OS, now done first); trace spans were written without waiting, so `readTrace` (and the eval's model-call counts) could miss the last ones (writes are now queued); plus two tests that assumed Linux.

## 4. Picking it up on your own machine

```bash
git clone https://github.com/suhail-akhtar/agent-harness-web
cd agent-harness-web
npm ci                              # Node 22.18+; runs the TypeScript directly
npx playwright install chromium     # render/browser tools; without it 7 tests skip
npm run build                       # browser UI + companion script
npm run typecheck && npm test       # expect 240 tests, 0 failing (some skip without Chromium, LibreOffice, Blender or the Docker images)
export DEEPSEEK_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=...   # only the ones you use
npm start                           # http://127.0.0.1:4310, prints an access token
```

In PowerShell, set the keys with `$env:DEEPSEEK_API_KEY = "..."` (one per line); every npm command is the same.

- Docker is optional. With it, `npm run sandbox:image` once, and sessions get a sandbox with the allowlist network. Without it, use a server folder or the companion (your own computer).
- For Blender and Godot in the sandbox: `npm run sandbox:image:3d` after the sandbox image (`harness-sandbox-3d:latest`, 3.3 GB: Blender 4.2.23 LTS, Godot 4.7.2, Xvfb, Mesa), then `HARNESS_SANDBOX_IMAGES=harness-sandbox-3d:latest` so a new session can pick it (or `HARNESS_SANDBOX_IMAGE` to make it the default). For Godot exports, `npm run sandbox:image:3d-export` builds `harness-sandbox-3d:export` (the same plus the Linux and Web export templates; `--build-arg GODOT_TEMPLATES=all` for every platform); add it to `HARNESS_SANDBOX_IMAGES`. Without Docker, install Blender / Godot on the machine; `HARNESS_BLENDER` / `HARNESS_GODOT` point at them. On a companion they need `--allow-hooks`.
- For Blender and Godot in the sandbox: `npm run sandbox:image:3d` after the sandbox image (`harness-sandbox-3d:latest`, 3.3 GB: Blender 4.2.23 LTS, Godot 4.7.2, Xvfb, Mesa), then `HARNESS_SANDBOX_IMAGES=harness-sandbox-3d:latest` so a new session can pick it (or `HARNESS_SANDBOX_IMAGE` to make it the default). Without Docker, install Blender / Godot on the machine; `HARNESS_BLENDER` / `HARNESS_GODOT` point at them.
- For computer use: `npm run sandbox:image:desktop` after the sandbox image (`harness-sandbox-desktop:latest`, 1.9 GB), then `HARNESS_SANDBOX_IMAGES=harness-sandbox-desktop:latest` so a new session can pick it; `HARNESS_DESKTOP_SIZE` sets the display (1280x800).
- Windows: install Git for Windows (Git Bash runs the commands); LibreOffice only for Office files. See the README's Quick start.
- Accounts for a shared server: `npm run users -- add <name> [--admin]`, or single sign-on with your identity provider (`HARNESS_OIDC_*`, see the README).
- Optional: `HARNESS_SEARCH` + a search key (Brave, Tavily, Exa, SearXNG) or the DeepSeek / Claude / OpenAI search; `HARNESS_GITHUB_TOKEN` for `publish_branch`.
- Evals cost real money. Run one case on one model first:
  `npm run eval -- --packs sdlc --cases expense-cli --models gpt-6-luna`.

How to work on it:

- Every change gets a test in `test/` that fails without it; run `npm run typecheck` and `npm test` before committing.
- A new tool, model, gate or workflow belongs in a plugin unless it is core (see `plugins/*` for the pattern and `src/plugins/api.ts` for the API).
- Anything that keeps data beyond a session must set `persists` (memory) and anything that returns outside content must be `untrusted` or kind `network`/`external` - that is what the "ask before saving after reading the web" rule relies on.
- Keep the request prefix stable (system prompt, sorted tools) - the cost numbers depend on the cache.

## 5. Next steps (in priority order)

1. **Re-run the evals on the final code.** The long-task eval was stopped to save budget: re-run Haiku (`--packs sdlc --cases expense-cli --models claude-haiku-5-5`) to confirm the deadlock fix, then the full set (`--cases url-shortener,board-deck,arcade,fire-hydrant,mcp-facts,expense-cli`). Record the numbers in `evals/results/` and the README.
2. **A fresh code review of the last round's fixes** (3c8ed77: run_script bootstrap, mirror chunking, taint persistence, the linear HTML scanner) and of the Windows fixes of 2026-10-21.
3. **The rest of Windows and Docker Desktop.** The suite passes on native Windows 11 with Docker Desktop: the sandbox image, the 3D image and the allowlist network (its test now uses `host.docker.internal` off Linux) all ran there on 2026-10-21. Still open: the LibreOffice test (skipped there), Docker Desktop for macOS, and any eval on Windows.
4. **Pin the checked address in `web_fetch` and `api.fetch`** (an HTTP client with a custom DNS lookup, e.g. the `undici` package's `Agent({ connect: { lookup } })`), to close DNS rebinding between the check and the connection.
5. **Credential injection at the egress proxy**, so sandboxed commands can call an API without the key entering the sandbox.
6. **Companion sessions:** checkpoints and project MCP servers.
8. **Blender / Godot, next:** an eval case per engine branch (`model-3d` with `engine=blender`, `build-game` with `engine=godot`) to see how the cheap models use them - the branches are tested only with scripted models (FakeProvider) and a stand-in Godot; play a Web export in the headless browser; Godot on a real user's computer through the companion.
9. Watch the providers: Claude's newer compaction beta (keep-tail compaction that keeps preserved thinking valid) and OpenAI's server compaction, which did not lower the billed input when probed.

## 6. Repository status

- `main` holds everything (the `feature/phases-1-4` branch was merged; PR #1).
- Three earlier commits (cc4d106, f87eecb, 2a51f4d) carry the author's own e-mail and show as unverified on GitHub; they were left as they are on purpose.
- Evaluation workspaces are not in the repository; results are summarised in `evals/results/`.
