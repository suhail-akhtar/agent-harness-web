# Custom agents and MCP servers: plan and status

The goal: a person creates, from the desktop app or by asking an agent, **custom agents** (a role,
instructions, a model, tools, MCP servers, skills, autonomy and limits) and **custom MCP servers** (for any
API, database, command or service) that are standard, so any MCP client can use them (Claude Desktop,
Claude Code, Cursor, VS Code, OpenAI). The harness's own agents and orchestrator use both, in parallel
where it helps.

## What the research found (November 2026)

- **MCP today.** The current spec is **2026-07-28**, which is stateless: no `initialize`, `server/discover`, `_meta`
  on every request, multi round-trip input (instead of server-to-client requests), `subscriptions/listen`, and
  tasks as an extension. Most deployed servers are still 2025-era, so a client must speak both. The official
  TypeScript SDK v2 (`@modelcontextprotocol/server` and `/client` 2.4.0) does, and serves 2025 clients too.
  Authorization is OAuth 2.1 with PKCE, protected-resource metadata, resource indicators, Client ID Metadata
  Documents (dynamic registration deprecated), and no token passthrough. Distribution is `.mcpb` (manifest 0.3)
  and the MCP Registry's `server.json`. The conformance suite (`@modelcontextprotocol/conformance`) checks servers.
  Anthropic's guidance on tools for agents: a few workflow tools rather than one per endpoint, namespaced names,
  concise results with pagination, errors that say how to fix the input. Risks to guard against: tool poisoning,
  rug pulls (definitions that change after approval), injection through results, over-broad scopes.
- **Agents today.** Claude Code's `.claude/agents/*.md` (frontmatter `name`, `description`, `tools`,
  `disallowedTools`, `model`, `effort`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `isolation`,
  `background`, `color`, `memory`) is the format Cursor, VS Code and Copilot also read. Agent Skills (`SKILL.md`)
  is an open standard. A2A Agent Cards describe agents to other systems. Code and file definitions lasted
  (OpenAI is retiring its visual Agent Builder on 2026-11-30); generators that rewrite instructions silently, write
  vague descriptions or grant every tool fail.
- **Orchestration.** Parallel sub-agents pay off for independent work (Anthropic: +90% on research, about 15x the
  tokens); split by context, not by role; every brief needs an objective, an output format, tools and boundaries;
  keep writes single-threaded or isolated (worktrees); cap depth, concurrency, turns and spend.
- **Our harness.** It uses MCP servers (stdio, HTTP; tools only, 2025-06-18) and runs named agents from files and
  plugins (prompt, tools, model, effort). Missing: creating MCP servers, per-person servers, OAuth, resources and
  prompts, `list_changed`, a UI to add or test servers, a UI or API to create agents, per-agent MCP servers,
  skills, permissions and budgets, and the harness as an MCP server. A gap found on the way: an agent definition's
  own model skipped the person's allowed-models check.

## Phases

| Phase | What | Status |
|---|---|---|
| 1 | **Custom agents.** Per-person agents (versioned): role, description, instructions, model and effort, tools (allow and deny, with globs), MCP servers, skills, autonomy (permission mode), turn and spend limits, worktree isolation, whether the person or the orchestrator may use it. Claude Code's file format in and out (also `.github/agents`, `.cursor/agents`). Enforced where an agent runs; its model checked against the allowed models (the gap). A whole conversation can run as an agent. `GET /api/agents`, `/api/me/agents` (create, edit, versions, delete, import, export), generate from a description, a test run. The desktop's Agents page: Your agents, a builder with Generate, Test and versions. | Done |
| 2 | **MCP connections.** Per-person MCP servers (HTTP with headers or OAuth sign-in, secrets from the key vault; stdio where it may run), status and a Test, each tool's definition pinned (a change asks again) and set to allow, ask or block; the client on the official SDK (both spec eras, `list_changed`, resources and prompts as tools, OAuth). Settings' MCP servers: add by URL, command, pasted JSON (Claude Desktop, Claude Code, Cursor, VS Code formats) or a `.mcpb`. | Done (a `.mcpb` stays an operator's install, MCP bundles) |
| 3 | **The MCP server builder.** "Make me an MCP server for …": from a description, an OpenAPI document, a command or a database. A builder agent and skill write a TypeScript server on the official SDK (stdio and HTTP), curated workflow tools with annotations, tests; the harness checks it with its own client (every tool called) and a conformance check, packs a `.mcpb` and a `server.json`, writes the config for Claude Desktop, Claude Code, Cursor and VS Code, and adds it to the person's servers. A wizard in the desktop app. | Done |
| 4 | **The harness as an MCP server.** A streamable HTTP endpoint (`/mcp`, the person's token) that offers their agents as tools (and a stdio bridge for apps that start a command), so Claude Desktop, Claude Code or Cursor can hand work to them. | Done |
| 5 | **Orchestration.** Teams: an agent that fans work out to named agents in parallel (isolated writers, a reviewer), with the brief template and effort scaling in its instructions, a spend limit for the whole team, and the Agents panel showing it live. | Done |

Each phase is tested on its own (engine, API, the desktop app end to end) and live on a real model before the next.

### Phase 2 as built

- **Client** (`src/mcp/client.ts`) on `@modelcontextprotocol/client` 2.4: the 2026-07-28 revision (`server/discover`)
  first, the 2025 `initialize` handshake when a server only has that; tools with titles, output schemas and
  annotations, resources, prompts, progress (a slow tool's progress keeps its call alive), cancellation, change
  notices (taken at once, not debounced), OAuth on streamable HTTP. A nearly-right server still works (a missing
  version, a tool without an input schema).
- **A person's servers** (`src/mcp/servers.ts`, `<data>/mcp/<owner>.json`): by URL (a member's: public `https://`
  only, every connection's address checked; an administrator's: any) or a command (administrators only: it runs
  with the server's rights). Secrets are `${vault:name}` references, read from the person's vault when the server
  connects; a secret written into a header is refused. Versioned (a stale save is refused), on and off.
- **Sign-in**: OAuth 2.1 with PKCE, dynamic client registration (or a client registered in advance, its secret in the
  vault), the resource indicator, refresh, and the authorization server bound between the start and the return. The
  browser comes back to `/api/mcp/oauth/callback` with a single-use state (10 minutes). Tokens are sealed on disk
  with the server key. A background connection never registers a client or opens a browser: it says "needs sign-in",
  known from the server's own 401.
- **Pinning against a changed tool ("rug pull")**: each tool's definition (description, schemas, hints) is hashed
  when first seen. A tool that changes, or a new one, stays out of conversations until the person approves it. The
  tools are listed again for every conversation, every check from the app, after a call that may change things (a
  tool not marked read-only), when the server says they changed, after a reconnect, and when the listing is older
  than a minute (`HARNESS_MCP_RELIST_MS`): a changed tool is refused before anyone is asked to allow the call.
- **Policy** per tool: auto (the server's read-only hint decides whether it asks), allow, ask, block. After untrusted
  content, a call that sends data out is still confirmed, whatever the policy.
- **Resources and prompts** reach the agent as two read-only tools per server (`mcp__<server>__resources`,
  `mcp__<server>__prompts`).
- **In conversations and agents**: the person's servers join the operator's and the project's (a name already used
  keeps theirs); a server that does not answer within 8 seconds is left out of that conversation. An agent's
  `mcpServers` can name them; the agent builder offers them.
- **Import**: Claude Desktop, Claude Code, Cursor (`mcpServers`) and VS Code (`servers`, `inputs`) configs, with
  comments and trailing commas; `${VAR}`, `${env:VAR}` and `${input:id}` become vault references, and so does a key
  written into the file. The old SSE transport is tried as streamable HTTP, and said.
- **API**: `GET/POST /api/me/mcp`, `GET/PUT/DELETE /api/me/mcp/:name`, `POST .../test`, `.../approve`,
  `PUT .../tools`, `POST .../signin`, `.../signout`, `POST /api/me/mcp/import`; an `mcp` event topic.
- **Desktop**: Settings > MCP servers (the kit's blocks): the list with status, a switch and what waits for review;
  add (by address, or a command for an administrator); a server's page with its tools (approve, a policy each),
  documents and prompts, sign-in in the browser (the page follows when it is done); import from a pasted config.
- **Tested**: the client against a server on the official SDK over stdio and HTTP, both eras
  (`test/mcp-modern.test.ts`); the store, pinning, reconnects, policies, the vault, OAuth with a fake authorization
  server, imports and conversations (`test/mcp-user.test.ts`); the API (`test/mcp-api.test.ts`); the desktop app
  end to end (`test/desktop-e2e-mcp.test.ts`); live (`scripts/live-mcp.mjs`): 10 of 10 checks on Claude Sonnet 5.5
  ($0.018) and DeepSeek V4.1 Flash ($0.001).

### Phase 3 as built

- **A server is a spec and one runtime.** `src/mcp/build/template/server.ts` is a server on the official SDK
  (`@modelcontextprotocol/server` 2.4: `serveStdio` for both eras on stdio, `createMcpHandler` for streamable HTTP,
  JSON Schema through `fromJsonSchema`) that runs whatever its `spec.json` says. Each tool is an HTTP call (`{arg}` in
  the path, query and JSON body arguments, headers from settings), a command (no shell), SQL against SQLite
  (`node:sqlite`) or DuckDB, or a code body (`ctx.env`, `ctx.fetch`, `ctx.query`). Settings come from the environment
  (`${NAME}`), never the spec; a header that carries a key must read one. A model writes data the harness checks
  (`checkBuildSpec`), never free-form files; one tested runtime runs them all.
- **Drafts** (`src/mcp/build/spec.ts`, `generate.ts`): from an OpenAPI 3 document (an operation each, `$ref`s
  resolved, path, query and JSON body arguments, its API key or bearer token as a secret setting, hints from the
  method, what cannot be a tool said); from a database (its tables, a find tool each with its columns as filters,
  read-only SQL, an execute tool only when asked, opened read-only otherwise); from a command (its `--help` read, a
  model drafts tools of kind "command"); from a description (a model drafts a few workflow tools with hints and
  examples, real endpoints, keys as settings).
- **Built and checked** (`builder.ts`): written to `<data>/mcp-builds/<owner>/<name>/` with `package.json`, a README,
  an MCPB 0.3 `manifest.json` (secrets as sensitive user config), a registry `server.json`, and the configs for
  Claude Desktop, Claude Code, Cursor and VS Code (secrets as `${input:}` there). The harness's own client checks it:
  the 2026-07-28 protocol, the 2025 handshake, stdio and streamable HTTP, every tool listed as specified with a
  description, an object schema and a read-only hint, each read-only tool called with its example, a call without
  its required arguments answered as an error, an unknown tool refused. It runs from its folder without
  `npm install` (`sdk-loader.mjs` resolves the SDK from the harness).
- **Packed** as a `.mcpb` (esbuild bundles the server and the SDK into one file) that Claude Desktop installs, and
  that the harness's own MCPB install runs. **Registered** to the person's servers (a command server: its settings as
  given at build time, secrets only as `${vault:}` references).
- Building runs code on the server's computer: administrators only (the desktop app's person is one).
- **API**: `POST /api/me/mcp-builds/draft`, `POST /api/me/mcp-builds` (build and check), `GET .../:name`,
  `POST .../pack`, `GET .../bundle`, `GET .../file?path=`, `POST .../register`, `DELETE .../:name`.
- **Desktop**: Settings > MCP servers > Build a server: from a description, an OpenAPI document, a database or a
  command; the draft's tools to keep and its settings; the check, each line; add it, download the `.mcpb`, copy the
  config for another app. The servers built are listed there.
- **Tested**: specs, OpenAPI and database drafts, an OpenAPI server checked against a real REST API with a key, a
  SQLite server registered and used, a code server with a vault secret packed as a `.mcpb` that installs
  (`test/mcp-build.test.ts`); the API (`test/mcp-api.test.ts`); the desktop app end to end
  (`test/desktop-e2e-mcp.test.ts`); live (`scripts/live-mcp-build.mjs`): Claude Sonnet 5.5 drafted a weather server
  from a plain description of the Open-Meteo APIs; the harness built it and its check called the real API (11 of 11
  checks); a conversation then answered with its tools; 9 of 9 checks, $0.053. Found by the first live run: the
  model made a public API's address a setting with no value, so a setting can now have a default (never a secret).

### Phase 4 as built

- **`POST /mcp`** (`src/mcp/expose.ts`): streamable HTTP on the official SDK, both protocol eras, made per request.
  A bearer token only (an account's, the operator's, or the desktop app's MCP token): no cookie or browser session
  reaches it, so no web page can drive it. The tools: `agent_<name>` for each agent the person may start (built-in,
  plugins', their own that are on; never an orchestrator-only one), `run_agent` (by name, optionally another
  model), `list_agents`, `get_result`.
- **A run** is a conversation that runs as the agent (the same rules as `POST /api/sessions`: an administrator's on
  the server, in a folder of theirs or a workspace of its own; a member's in a sandbox; a folder is for
  administrators). It never waits for a person: dontAsk by default (what would need approval is refused), or plan,
  acceptEdits, auto. Each tool call it makes is a progress notification. Past the wait (`waitSeconds`, default
  600), the call returns the conversation's id and the run goes on; `get_result` fetches the answer. A call the
  client cancels while waiting stops the run.
- **The stdio bridge** (`src/mcp/bridge.ts`): for apps that start a command. It presents the same tools on stdio and
  hands each call to `/mcp`; the token from the environment, never the command line.
- **The desktop app** (Settings > Use your agents elsewhere, off until turned on): a token of its own for `/mcp`
  (kept encrypted with the OS keychain; renewable), the engine's current address in a file the bridge reads (the
  address changes with each start), the bridge run on the app's own runtime (no Node.js install), and the configs to
  copy for Claude Desktop, Claude Code, Cursor and VS Code.
- **Tested**: `test/mcp-expose.test.ts` (tokens and cookies, the tools, a run and its answer, a long run fetched
  later, each person's own, the bridge) and the desktop app end to end (turned on, the Claude Code config copied,
  the bridge started as that app would start it, an agent run through it, turned off).

### Phase 5 as built

- **A team is an agent with members** (`team: { members, reviewer? }` on an agent definition; `team:` and
  `reviewer:` in its file). It leads them: its agent tool offers only its members (wherever it runs: a
  conversation as the team, a delegated run, a run from another app over `/mcp`), and its instructions get the
  lead's procedure (`teamBrief`): size the effort to the task, split it into independent parts, a complete brief
  for each member, independent parts started in one turn so they run in parallel, writers never on the same files
  (each in its own worktree where the folder is a repository), gaps sent back to the member who did the part, the
  reviewer's check before the report.
- **One spend limit for the team**: a conversation that runs as an agent stops at its `maxCostUsd`, and what its
  members spend counts.
- **Desktop**: the agent builder's Team part (members, a reviewer); the Agents panel and the transcript show each
  member's run as it works.
- **Tested**: `test/agents-team.test.ts` (definitions, a team whose two members are shown to run at the same time,
  the reviewer, a non-member refused, the team-wide spend limit); the desktop app end to end (a team made in the
  builder and run); live (`scripts/live-team.mjs`, through `/mcp`): 6 of 6 checks on Claude Sonnet 5.5 ($0.029) and
  DeepSeek V4.1 Flash ($0.004); the two summarisers started in one turn, the checker after their work. Found by the
  first live run: members ran in the background (the default for agents), so the lead briefed its reviewer before
  the work had come back; a lead's members now run in the foreground unless it asks otherwise.

### The live evaluation (2026-11-02)

`scripts/live-agents-eval.mjs` runs seven scenarios on real models with prompts written as a person would write them,
and checks the end state against the truth; the report is `EVAL.md`. The fixes it led to are in the CHANGELOG
(your own agents used for their work, a report from an agent that ran out of steps, team sizing, a team lead's
default agent). Coordination research and a design: `COORDINATION.md`.

### Gaps closed after the five phases

- **A delegated team leads.** Sub-agents may not start sub-agents by default (`maxSubagentDepth` 1), so a team the
  orchestrator handed work to had no agent tool. A team lead now hands work to its members wherever it runs (at
  most three levels down). Tested: an orchestrator delegates to a team whose two members run at once.
- **Generate drafts teams**: from the agents listed (built-in, plugins', the person's own); invented members are
  dropped and said; one member is no team.
- **DuckDB and command servers** are built and checked in tests (a command's arguments reach it without a shell).
- **A `.mcpb` as the person's own server** (administrators: it runs a program): its settings shown first, a secret only
  as a `${vault:}` reference; Import > Install a .mcpb bundle in the app.
- **Approval from another app**: `/mcp` runs take mode `ask`: what needs approval waits for the person in the app
  (their approvals), and the run goes on when they allow it.
- **A member's run from another app** goes to a Docker sandbox, as in the app, and makes no container until it runs
  a command (tested: none made or left).
- **The installed app builds and packs servers**: esbuild is a runtime dependency (packed into the app with its
  platform binary); a server was built, checked (9 of 9) and packed by the installed `Harness.exe` as Node, and its
  bridge started from the installed engine.
- **Real servers** (`scripts/live-mcp-real.mjs`): DeepWiki connected for a member on MCP 2025-11-25 and answered; a
  public name that resolves to this computer was refused; Linear's server said it needs sign-in and its OAuth
  metadata (PKCE S256, dynamic registration) is what the harness's sign-in uses.
- **Left to the person**: signing in to a real service (their own account, in their browser), and publishing a built
  server to the MCP registry (their npm and GitHub accounts; each build has its `server.json` and README).
