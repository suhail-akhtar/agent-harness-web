# Harness Web - handoff guide

Where the project stands on 2026-10-20, how to pick it up on your own machine, and what to do next.
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

Every code review of this branch (three rounds) was fixed with a regression test that fails without the fix. The last round (11 findings, commit 3c8ed77) closed: the publish token going to any git host, a `run_script` sandbox escape, Windows path traversal in the companion mirror, a symlinked `.git` in publishing, project memory shared between accounts, gaps in untrusted-content tracking, mirror results over the request limit, gates that copied whole folders, quadratic HTML parsing, the compaction threshold, and a plugin named "config" getting the operator's reach.

## 3. Results

Full numbers are in the README ("Measured") and `evals/results/`. In short:

- **Phases 1-4, every pack on every model:** 12/12 runs, 39/39 hidden checks, $2.56 in total, ~93% of input read from cache.
- **Phase 5** (`evals/results/2026-10-20-p5.md`): research 3/3 with every report approved by the fact-checker; code mode the same answer at about half the cost on all three models; memory carried across sessions on all three; Claude server-side compaction ran three times in one task and stayed correct; the long-task workflow built a whole CLI feature by feature on GPT-6 Luna (11/11 features, every hidden check) and DeepSeek (15/18 features when stopped, every hidden check), and exposed a workflow deadlock on Haiku that is now fixed.
- **Tests:** `npm test` - 155 tests, all passing on Linux; typecheck clean.

## 4. Picking it up on your own machine

```bash
git clone https://github.com/suhail-akhtar/agent-harness-web
cd agent-harness-web
npm ci                         # Node 22.18+; runs the TypeScript directly
npm run build                  # browser UI + companion script
npm run typecheck && npm test  # expect 155/155
export DEEPSEEK_API_KEY=... OPENAI_API_KEY=... ANTHROPIC_API_KEY=...   # only the ones you use
npm start                      # http://127.0.0.1:4310, prints an access token
```

- Docker is optional. With it, `npm run sandbox:image` once, and sessions get a sandbox with the allowlist network. Without it, use a server folder or the companion (your own computer).
- Windows: install Git for Windows (Git Bash runs the commands); LibreOffice only for Office files. See the README's Quick start.
- Accounts for a shared server: `npm run users -- add <name> [--admin]`.
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
2. **A fresh code review of the round-5 fixes** (run_script bootstrap, mirror chunking, taint persistence, the linear HTML scanner).
3. **Test on a real Windows machine and on Docker Desktop.** Both are covered only by simulated tests; the allowlist network needs Linux Docker networking.
4. **Pin the checked address in `web_fetch` and `api.fetch`** (an HTTP client with a custom DNS lookup, e.g. the `undici` package's `Agent({ connect: { lookup } })`), to close DNS rebinding between the check and the connection.
5. **Credential injection at the egress proxy**, so sandboxed commands can call an API without the key entering the sandbox.
6. **Companion sessions:** checkpoints and project MCP servers.
7. **Single sign-on** (OIDC) for shared servers; accounts are tokens today.
8. **Build the full sandbox image** on a network that reaches Debian's package mirrors (this environment could not).
9. **Blender / Godot** integration for the 3D pack (3D is Three.js in the headless browser today).
10. Watch the providers: Claude's newer compaction beta (keep-tail compaction that keeps preserved thinking valid) and OpenAI's server compaction, which did not lower the billed input when probed.

## 6. Repository status

- `main` holds everything (the `feature/phases-1-4` branch was merged; PR #1).
- Three earlier commits (cc4d106, f87eecb, 2a51f4d) carry the author's own e-mail and show as unverified on GitHub; they were left as they are on purpose.
- Evaluation workspaces are not in the repository; results are summarised in `evals/results/`.
