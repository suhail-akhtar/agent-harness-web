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
| 2 | **MCP connections.** Per-person MCP servers (HTTP with headers or OAuth sign-in, secrets from the key vault; stdio where it may run), status and a Test, each tool's definition pinned (a change asks again) and set to allow, ask or block; the client on the official SDK (both spec eras, `list_changed`, resources and prompts as tools, OAuth). Settings' MCP servers: add by URL, command, pasted JSON (Claude Desktop, Claude Code, Cursor, VS Code formats) or a `.mcpb`. | |
| 3 | **The MCP server builder.** "Make me an MCP server for …": from a description, an OpenAPI document, a command or a database. A builder agent and skill write a TypeScript server on the official SDK (stdio and HTTP), curated workflow tools with annotations, tests; the harness checks it with its own client (every tool called) and a conformance check, packs a `.mcpb` and a `server.json`, writes the config for Claude Desktop, Claude Code, Cursor and VS Code, and adds it to the person's servers. A wizard in the desktop app. | |
| 4 | **The harness as an MCP server.** A streamable HTTP endpoint (`/mcp`, the person's token) that offers their agents as tools (and a stdio bridge for apps that start a command), so Claude Desktop, Claude Code or Cursor can hand work to them. | |
| 5 | **Orchestration.** Teams: an agent that fans work out to named agents in parallel (isolated writers, a reviewer), with the brief template and effort scaling in its instructions, a spend limit for the whole team, and the Agents panel showing it live. | |

Each phase is tested on its own (engine, API, the desktop app end to end) and live on a real model before the next.
