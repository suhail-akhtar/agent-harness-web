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
| 3 | **The MCP server builder.** "Make me an MCP server for …": from a description, an OpenAPI document, a command or a database. A builder agent and skill write a TypeScript server on the official SDK (stdio and HTTP), curated workflow tools with annotations, tests; the harness checks it with its own client (every tool called) and a conformance check, packs a `.mcpb` and a `server.json`, writes the config for Claude Desktop, Claude Code, Cursor and VS Code, and adds it to the person's servers. A wizard in the desktop app. | |
| 4 | **The harness as an MCP server.** A streamable HTTP endpoint (`/mcp`, the person's token) that offers their agents as tools (and a stdio bridge for apps that start a command), so Claude Desktop, Claude Code or Cursor can hand work to them. | |
| 5 | **Orchestration.** Teams: an agent that fans work out to named agents in parallel (isolated writers, a reviewer), with the brief template and effort scaling in its instructions, a spend limit for the whole team, and the Agents panel showing it live. | |

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
