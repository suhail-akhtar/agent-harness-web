# How production multi-agent systems coordinate agents (November 2026)

Research note for the harness's orchestrator, teams, background agents and linked sessions. It records the
coordination **mechanisms** each system documents: how work is split and assigned, how agents share state, whether
agents talk to each other or only through a lead, how conflicting edits are prevented, how progress is tracked and
stuck or looping agents caught, how results are verified and merged, and how cost is bounded. Gathered 2026-11-02.
Measured results and failure studies are in the sibling note [coordination-evidence.md](coordination-evidence.md).

How to read it:
- Dates: engineering posts and papers carry their publication date. Docs pages carry none, so they are cited as
  "docs, read 2026-11-02" and describe the product as of that day. **[older]** marks sources from before 2026.
- **(secondary)** means the detail was seen only in third-party coverage, not in a primary source.
- Section 10 is the cross-system table; section 11 lists the mechanisms that recur and look most proven.

Contents: 1 Anthropic (research system, Claude Code subagents, agent teams, dynamic workflows, cross-session
messaging, Agent SDK, Managed Agents, field reports) · 2 OpenAI (Agents SDK, Codex) · 3 Google ADK and A2A ·
4 Microsoft (Magentic-One, AutoGen, Agent Framework) · 5 LangChain / LangGraph · 6 CrewAI · 7 MetaGPT ·
8 Coding agents (Cursor, Devin, GitHub Copilot) · 9 Added: AWS Strands swarm, two failure/scaling studies ·
10 Cross-system table · 11 Recurring, most-proven mechanisms.

---

## 1. Anthropic

### 1.1 Multi-agent research system [older] (engineering post, 2025-06-13)

- **Split and assign.** Orchestrator-worker. A lead agent (Claude Opus 4) analyses the query, writes a strategy and
  spawns subagents (Claude Sonnet 4) for separate aspects. Every brief must give an **objective, an output format,
  guidance on tools and sources, and clear task boundaries**; vague briefs ("research the semiconductor shortage")
  made subagents duplicate each other's work.
- **Effort scaling written into the lead's prompt.** Simple fact-finding: 1 agent, 3-10 tool calls. Direct
  comparison: 2-4 subagents, 10-15 calls each. Complex research: more than 10 subagents with divided
  responsibilities. Added after early versions spawned 50 subagents for simple queries.
- **Parallelism.** The lead starts 3-5 subagents at once and each subagent runs 3+ tools in parallel; together this
  cut research time by up to 90% on complex queries.
- **Shared state.** The lead saves its plan to external memory (context past 200k tokens is truncated). Agents
  summarise finished phases to external storage; a fresh subagent can take over a full context with a handoff.
  Subagents write large outputs (reports, code) to a filesystem and return **lightweight references**, avoiding a
  "game of telephone" through the lead.
- **Communication.** Workers return condensed findings to the lead only. Observed failure: subagents "distracting
  each other with excessive updates".
- **Verification and merge.** The lead synthesises and decides whether more research is needed. A separate
  **CitationAgent** then maps each claim to a source. Evaluation: one LLM-as-judge call scoring 0.0-1.0 plus
  pass/fail on factual accuracy, citation accuracy, completeness, source quality and tool efficiency; started with
  about 20 real queries; human testers caught agents preferring SEO content farms.
- **Robustness.** Resume from the point of failure (checkpoints, retries) instead of restarting; the agent is told
  when a tool fails; rainbow deployments so running agents survive an update.
- **Cost.** Agents use about 4x the tokens of chat, multi-agent systems about 15x. On BrowseComp, token usage alone
  explained 80% of performance variance (95% with tool-call count and model choice). Multi-agent beat single-agent
  Opus 4 by 90.2% on the internal research eval. Stated poor fit: work needing shared context or many dependencies
  between agents, "such as most coding tasks".
- **Known limit.** Synchronous: the lead waits for each batch, cannot steer subagents mid-run, subagents cannot
  coordinate, and one slow subagent blocks the rest.

Source: https://www.anthropic.com/engineering/multi-agent-research-system

### 1.2 Claude Code subagents (docs, read 2026-11-02; Claude Code v2.1.2xx-2.1.3xx)

- **Split and assign.** The model delegates by matching each agent's `description`; a person can name one (prose,
  `@`-mention, `--agent`). Several Agent tool calls in one turn run concurrently.
- **Context.** A subagent starts fresh: its own system prompt, the brief written by the caller, CLAUDE.md, a git
  status snapshot, preloaded skills, and (if it has `SendMessage`) a roster of the other named agents. It does not
  see the parent's history. Exception: a **fork** (`subagent_type: "fork"`, `/subtask`) inherits the conversation.
- **Background by default.** "With nothing configured, a subagent that Claude spawns from your main conversation
  starts in the background." The Agent tool returns `status: "async_launched"`; the report arrives as a completion
  notification in a later turn. Claude waits (`status: "completed"`) when its next action needs the report.
- **Continue a subagent.** `SendMessage` to the agent's ID or name resumes it with its full history (tool calls,
  results, reasoning). Built-in Explore and Plan are one-shot. A name taken by a newer agent makes `SendMessage`
  refuse and say which agent the name now reaches. A subagent that resumes another receives that agent's report,
  not the main conversation.
- **Isolation.** `isolation: worktree` runs the subagent in a temporary git worktree branched from the default
  branch (not the parent's HEAD), removed automatically if it made no changes.
- **Hard limits.** Nesting depth 3 layers below the main conversation (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; at the
  limit the Agent tool is withheld). Concurrency 20 running subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`;
  beyond it the spawn fails with `Concurrent subagent limit reached`). `maxTurns`: at the limit the output is
  returned **marked partial** and the agent can be resumed.
- **What comes back.** Only the final message. Since v2.1.210 it is scanned before the parent reads it: imitated
  harness tags (e.g. `<system-reminder>`) are neutralised, `Human:`/`Assistant:` turn markers escaped, a
  `[harness: ...]` marker line prepended; nothing is removed. An API error that ends a subagent is never delivered as
  its result.
- **Permissions.** A background subagent's permission prompt surfaces in the main session naming the subagent;
  "no message from any agent counts as your approval".
- **Hooks.** `SubagentStart` / `SubagentStop`, matched on the agent's name.
- **Model and cost.** Per-call `model`, then the definition's `model`, then `CLAUDE_CODE_SUBAGENT_MODEL`, then the
  session's model; the org's `availableModels` allowlist substitutes a blocked choice. Opus 5 "delegates to
  subagents more readily", so with the `claude_code` preset on Opus 5 Claude Code adds a system-prompt line not to
  call the Agent tool unless asked; the docs say to set the hard limits as well.
- **`/batch`.** A bundled skill that splits one large change into 5 to 30 worktree-isolated subagents.

Sources: https://code.claude.com/docs/en/sub-agents · https://code.claude.com/docs/en/agents ·
https://code.claude.com/docs/en/agent-sdk/subagents

### 1.3 Claude Code agent teams (docs, read 2026-11-02; experimental, off by default)

- **Parts.** A lead session, teammates (separate Claude Code instances, each its own context), a **shared task
  list**, and a **mailbox** per agent. Enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- **Task list.** States pending, in progress, completed. Tasks can depend on others and show as blocked until those
  finish; completing a task unblocks its dependants automatically. The lead assigns, or a teammate **self-claims**
  the next unassigned, unblocked task after finishing one. "Task claiming uses file locking to prevent race
  conditions." Stored in `~/.claude/tasks/{team}/` (kept after the session).
- **Mailbox and messaging.** One JSON inbox file per agent (`~/.claude/teams/{team}/inboxes/{agent}.json`),
  validated on read; a message counts as sent only when the write succeeds. Delivery is automatic (no polling).
  Any teammate can message any other **by name**; there is no broadcast (one message per recipient). Team config
  lists members so teammates can discover each other. Structured protocol messages: plan approval, shutdown request.
- **Idle and failure notices.** A teammate that finishes notifies the lead with its final answer; one whose turn ends
  on an API error notifies the lead with the error.
- **Plan gate.** A teammate spawned while the lead is in plan mode works read-only until it sends a plan approval
  request to the lead.
- **Quality gates as hooks.** `TeammateIdle` (exit 2 = feedback, keep working), `TaskCreated` (exit 2 = block
  creation), `TaskCompleted` (exit 2 = refuse completion).
- **Trust.** A message from another agent is marked as coming from another Claude session, cannot approve a
  permission prompt or relay a denied action; in auto mode a classifier reviews each inter-agent message before
  delivery.
- **Conflict prevention.** None built in: teammates are **not** isolated in worktrees. Guidance: "Two teammates
  editing the same file leads to overwrites. Break the work so each teammate owns a different set of files."
- **Sizing and cost.** Start with 3-5 teammates; 5-6 tasks per teammate lets the lead reassign work when someone is
  stuck. Tokens scale linearly with teammates; the costs page puts teams at "approximately 7x more tokens than
  standard sessions when teammates run in plan mode". Advice: Sonnet for teammates, small teams, focused spawn
  prompts, shut teammates down when done.
- **Documented failure modes.** Task status lags (a teammate fails to mark completion, blocking dependants); the
  lead declares the team finished early or starts implementing instead of waiting; teammates stop after errors.
  One team per session, no nested teams, fixed lead, in-process teammates not restored on resume.

Sources: https://code.claude.com/docs/en/agent-teams · https://code.claude.com/docs/en/costs

### 1.4 Claude Code dynamic workflows (docs, read 2026-11-02)

- **Plan in code.** Claude writes a JavaScript script that a runtime executes in the background: `agent()` spawns one
  subagent, `parallel()` runs several and waits for all, `pipeline()` runs one per list item, `phase()` groups
  agents for the progress view, `args` carries input. Intermediate results live in **script variables**, not in
  Claude's context; Claude gets only the final answer. Docs' comparison: subagents and teams are steered "turn by
  turn" by Claude; in a workflow "the script" decides what runs next.
- **Typed hand-offs.** `agent(prompt, { schema })` returns JSON matching the schema; a self-contradictory schema fails
  before the agent starts; output failing validation is retried up to 5 times (`MAX_STRUCTURED_OUTPUT_RETRIES`).
- **Verification patterns** shipped and documented: adversarial review of each finding before it is reported;
  `/deep-research` fans out searches, cross-checks sources, **votes on each claim**, drops claims that fail, and
  lists claims verifiers could not check as unverified rather than refuted. Documented stop rules: "until the type
  check passes or two rounds in a row make no progress"; "stop once two rounds in a row find nothing new".
- **Conflict prevention.** Writers run "each file in its own isolated copy" (worktrees).
- **Stall detection.** An agent whose output stops for the stall window restarts from the same prompt with a fresh
  transcript (files it changed stay changed), at most 5 restarts; then the call fails (`agent stalled on all 6
  attempts`), and inside `parallel()`/`pipeline()` its slot becomes `null` while the run continues.
- **Resume.** The runtime records each agent's result; a relaunch replays saved results until the first agent whose
  prompt differs, then re-runs from there. `Date.now()` and `Math.random()` throw so replays are deterministic.
  Runs pause at a usage limit and continue after reset (at most twice).
- **Limits and cost.** 16 concurrent agents by default (1-256), 4,096 items per `parallel()`/`pipeline()`, 1,000
  agents per run. A `Large workflow` warning appears past 25 agents or 1.5M projected tokens (advisory). A size
  guideline is sent as advice: small < 5, medium < 10 (default), large < 50 agents. Sibling agents with the same
  model, tools and prompt prefix are held up to 5 s so they read the first agent's prompt cache.
- **Approval.** The planned phases are shown for approval before the run (per permission mode); the script can be
  saved and rerun as a command.

Source: https://code.claude.com/docs/en/workflows

### 1.5 Claude Code cross-session messaging (docs, read 2026-11-02; v2.1.224+)

- Separate sessions (local, other machines via Remote Control, cloud) find each other with `ListAgents` and send
  plain text with `SendMessage`; never history or files. Delivered between tool calls during a turn, or as a new
  turn when the receiver is idle.
- `notify_when_idle`: one notice when another local session next goes idle or exits; dropped after 12 hours.
- Incoming messages are marked as not from the person: they cannot approve prompts, change configuration or run
  commands. Receiver policy `crossSessionInbound`: accept, hold (for approval), refuse.
- **Loop control**: per-sender rate limit, identical repeats in a short window dropped, at most 50 queued, so "a
  message loop between two sessions therefore stops on its own"; about 1M characters per message.

Source: https://code.claude.com/docs/en/cross-session-messaging

### 1.6 Claude Agent SDK (docs, read 2026-11-02)

- `agents` option takes `AgentDefinition`s: `description`, `prompt`, `tools`, `disallowedTools` (incl. `mcp__server__*`
  globs), `model`, `skills`, `mcpServers`, `maxTurns`, `background`, `effort`, `permissionMode`, `omitClaudeMd`,
  `autoCompactWindow`. The only parent-to-child content is the Agent tool's prompt string.
- Tracing: messages from inside a subagent carry `parent_tool_use_id` and (TS) `agent_id`, stable across resumes.
- Resume: capture `session_id` and the `agentId` in the Agent tool result, then `resume: sessionId`.
- **Caps enforced by the runtime**: depth, concurrency (env vars above) and `maxBudgetUsd`. At the spend cap the SDK
  refuses new spawns (`Budget limit reached`), **stops background subagents still running**, and ends the query with
  `error_max_budget_usd`. Subagent spend counts toward `total_cost_usd`.
- `Workflow` tool (TS SDK v0.3.149+) for runs of dozens to hundreds of agents.

Source: https://code.claude.com/docs/en/agent-sdk/subagents

### 1.7 Claude Managed Agents multiagent (docs, read 2026-11-02; beta header `managed-agents-2026-04-01`)

- Three hand-off modes on one agent (`multiagent_20261001`): **subagents** (delegated and read back by the agent),
  **dynamic workflows** (a program the server runs as a background "workflow run"), and an **advisor** model the
  primary thread consults mid-turn for planning or a final review.
- All agents in a session **share one sandbox, filesystem and vault credentials**; each runs in its own **session
  thread** with its own history and event stream. Subagent threads persist, so the agent can send follow-ups
  (`send_to_agent`, `list_agents`); workflow-run threads cannot be messaged and are archived at the end of the run.
- Limits: delegation one level deep; at most 25 child threads at a time (idle ones included; advisor and run threads
  excluded); up to 20 predefined agents per list; predefined agents pinned to a version; inline agents can be
  disabled so only listed agents run.
- Cost: a **session budget** caps spend including runs; runs pause at the budget and resume when it is raised.

Source: https://platform.claude.com/docs/en/managed-agents/multi-agent

### 1.8 Anthropic field reports on coordination

- **Building effective agents [older] (2024-12-19).** The pattern vocabulary most systems reuse: prompt chaining,
  routing, parallelisation (sectioning, voting), orchestrator-workers, evaluator-optimizer.
  https://www.anthropic.com/engineering/building-effective-agents
- **Effective harnesses for long-running agents [older] (2025-11-26).** Coordination across sessions through files:
  an initializer session writes a feature list in JSON (all `passes: false`; later sessions may change only that
  field), an `init.sh`, and `claude-progress.txt`; each coding session reads progress, git log and the feature list,
  runs a basic end-to-end test, works on **one feature**, commits with a descriptive message (git as checkpoint),
  and marks a feature done only after browser-driven end-to-end testing. Addressed failures: one-shotting, declaring
  the project done early, marking features done untested.
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- **Building a C compiler with parallel Claudes (2026-02-05).** 16 Opus 4.6 agents, each in its own Docker container
  with a clone of a bare upstream git repo. **No orchestrator** and no other inter-agent channel. An agent claims a
  task by writing `current_tasks/<task>.txt`; if two claim the same task, git synchronisation forces the second to
  pick another; finished work is pulled, merged (conflicts frequent, resolved by the agent), pushed, lock removed.
  Agents pick the "next most obvious" problem and keep running notes of failed approaches. When one monolithic task
  (compiling the Linux kernel) made every agent hit the same bug and overwrite each other's fixes, GCC was used as
  an oracle so each agent got a different random subset of files. Specialised agents: dedupe code, performance,
  generated-code quality, Rust-style critique, docs. CI blocked commits that broke existing tests; test output kept
  to a few lines with details in log files; a `--fast` mode ran a deterministic per-agent 1%/10% sample. About 2,000
  sessions, 2B input and 140M output tokens, just under $20,000.
  https://www.anthropic.com/engineering/building-c-compiler
- **Building multi-agent systems: when and how (2026-01-23).** Multi-agent uses 3-10x the tokens of a single agent.
  Split **by context boundary** (independent research paths, components with clean interfaces, black-box
  verification), not **by role** (planner, implementer, tester, reviewer), which degraded at each handoff and in one
  experiment spent more tokens coordinating than working. Verification subagent: checks output against explicit
  criteria with little build context; sample loop retries up to 3 times with failure feedback. Failure mode "early
  victory" (verifier runs one or two tests and declares success). Consider splitting at about 15-20+ tools, after
  trying tool search. https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them

---

## 2. OpenAI

### 2.1 OpenAI Agents SDK (docs, read 2026-11-02)

- **Two LLM-driven patterns.** **Handoffs**: each handoff is a tool (`transfer_to_<agent>`); the target "becomes the
  active agent for the rest of the turn" and by default sees the entire prior history. `input_filter` rewrites what
  it sees (e.g. `remove_all_tools`); `nest_handoff_history` (beta, off) collapses prior turns into a summary block;
  `on_handoff` callback, `input_type` (validated arguments), `is_enabled`. **Agents as tools**: `Agent.as_tool()`; the
  manager "keeps control of the conversation", the nested run does not inherit the parent's conversation, and the
  tool returns the nested agent's final output (`custom_output_extractor` to post-process). `as_tool` takes
  `max_turns`, `needs_approval`, structured `parameters`, `on_stream`. The two compose.
- **Code-driven orchestration** (documented as more predictable in speed, cost and performance): structured-output
  routing, chaining, an **evaluator loop** (`while` until the evaluator says the output passes), parallel runs via
  `asyncio.gather`.
- **Loop and progress control.** `max_turns` raises `MaxTurnsExceeded` (or a `"max_turns"` error handler returns a
  controlled final output). Input guardrails run on the first agent, output guardrails on the agent producing the
  final output. Built-in tracing (`trace_id`, `group_id` links traces across runs). Pause and resume via `RunState`;
  durable-execution integrations: Temporal, Dapr, Restate, DBOS.
- **State.** Client-managed history, a `session`, or server-side `conversation_id` / `previous_response_id` (one
  strategy per conversation); app state in the run context, not in the LLM input.
- *(secondary)* April 2026 update added native sandbox execution and a model-native harness (filesystem, shell,
  apply-patch, AGENTS.md); no new multi-agent coordination mechanism was reported.

Sources: https://openai.github.io/openai-agents-python/multi_agent/ ·
https://openai.github.io/openai-agents-python/handoffs/ · https://openai.github.io/openai-agents-python/tools/ ·
https://openai.github.io/openai-agents-python/running_agents/

**A practical guide to building agents [older] (April 2025)** names the same two shapes: a **manager pattern** (a
central agent calls specialists as tools) and a **decentralized pattern** (peers hand off to one another), and advises
splitting into several agents only for complex conditional logic or tool overload (overlapping tools rather than
a raw count). https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf

### 2.2 Codex (cloud tasks, best-of-N, app, subagents)

- **Cloud tasks [older] (launch 2025-05-16).** Each task runs in its own isolated cloud environment preloaded with the
  repository; many tasks run in parallel; the agent cites terminal logs and test output as evidence; repository
  guidance in `AGENTS.md`; results come back as a diff the person turns into a PR. Current docs (read 2026-11-02):
  each task has its own workspace and keeps working with the person's computer asleep; environments are saved and
  reused; network access per environment (all, package managers only, or an allowlist).
  https://openai.com/index/introducing-codex/ · https://learn.chatgpt.com/docs/cloud
- **Best-of-N [older] (June 2025, secondary).** Codex generates several responses to one task at once for the person
  to compare and pick; third-party CLI guides describe `--attempts 1-4`, each attempt in its own container.
  https://bleepingcomputer.com/news/artificial-intelligence/chatgpts-ai-coder-codex-now-lets-you-choose-the-best-solution
- **Codex app (2026-02-02).** A command centre for several agents in parallel, with built-in worktrees so agents work
  on the same repo without conflicts; merging back is done by the person. https://openai.com/index/introducing-the-codex-app/
- **Subagents (docs, read 2026-11-02).** Spawned only on an explicit request or when `AGENTS.md`/skill instructions ask
  for delegation (the top tier in ChatGPT Work may delegate proactively). Custom agents are TOML files
  (`name`, `description`, `developer_instructions`, optional model, reasoning effort, feature switches to remove shell,
  apps, plugins, memories); sandbox and approval policy are inherited and cannot be overridden per agent.
  `agents.max_concurrent_threads_per_session` caps open threads. The main thread "waits until all requested results
  are available, then returns a consolidated response". No subagent-to-subagent messaging is documented. Guidance:
  parallelise read-heavy work (exploration, tests, triage, summarisation); parallel writes "can create conflicts and
  increase coordination overhead"; subagent runs "consume more tokens than comparable single-agent runs".
  https://learn.chatgpt.com/docs/agent-configuration/subagents

---

## 3. Google: Agent Development Kit and Agent2Agent

### 3.1 Agent Development Kit (docs, read 2026-11-02; ADK 2.0 in Python, Go and TypeScript)

- **Hierarchy.** A parent agent with `sub_agents`. **Workflow agents** run sub-agents deterministically:
  `SequentialAgent`, `ParallelAgent`, `LoopAgent`. ADK 2.0 adds graph workflows (agents mixed with deterministic
  nodes), dynamic (code-driven) workflows, collaborative workflows (one coordinator agent) and experimental agent
  routing (router functions for fallback, A/B, auto-routing).
- **Delegation.** LLM-driven: the coordinator calls `transfer_to_agent` (one delegation tool per sub-agent is
  generated), which needs clear sub-agent `description`s. Explicit: wrap a specialist as `AgentTool`. ADK 2.0
  sub-agent **modes**: `chat` (talks with the person, returns only by explicit transfer), `task` (may ask clarifying
  questions, returns via `finish_task`; must be a leaf), `single_turn` (no person, returns automatically; several
  run in parallel).
- **Shared state.** Session state is the blackboard: an agent writes its result under its `output_key`, later agents
  read it through `{key}` placeholders.
- **Parallel branches.** Each `ParallelAgent` child runs in its own branch and does not see siblings' history while
  running; each writes a **distinct** `output_key`, and a following agent (usually inside a `SequentialAgent`) merges
  them. Result order is not deterministic. Sharing a mutable context across branches needs locks.
- **Loops and termination.** `LoopAgent` does not decide to stop by itself: it stops at `max_iterations` or when a
  sub-agent sets `escalate = True` (e.g. a critic replies "No major issues found." and a refiner calls `exit_loop`).
  Documented patterns: coordinator/dispatcher, sequential pipeline, parallel fan-out/gather, hierarchical
  decomposition, generator-critic, iterative refinement, human-in-the-loop (no built-in human agent).

Sources: https://adk.dev/workflows/ · https://adk.dev/workflows/collaboration/ · https://adk.dev/workflows/patterns/ ·
https://adk.dev/agents/workflow-agents/parallel-agents/ · https://adk.dev/agents/workflow-agents/loop-agents/

### 3.2 Agent2Agent protocol (spec 1.0.0; status 2026)

**What it standardises** (spec, read 2026-11-02):
- **Discovery and identity.** An **Agent Card** (identity, skills, endpoints and supported interfaces, auth schemes)
  at `https://{server_domain}/.well-known/agent-card.json`; optionally signed with JWS (RFC 7515) over JCS-canonical
  JSON (RFC 8785); an authenticated extended card via `GetExtendedAgentCard`.
- **Unit of work.** A **Task** with server-generated ID and lifecycle states: submitted, working, input-required,
  auth-required, completed, failed, canceled, rejected. `contextId` groups related tasks and messages; a follow-up
  message carries the `taskId` (multi-turn via input-required).
- **Content.** Messages (turns with a role) versus **Artifacts** (outputs; "Messages SHOULD NOT be used to deliver task
  outputs"), both made of Parts (text, file, structured JSON).
- **Operations.** SendMessage, SendStreamingMessage (SSE), GetTask (with `historyLength`), ListTasks, CancelTask,
  SubscribeToTask, push-notification config CRUD (server POSTs to a client webhook with credentials). Bindings:
  JSON-RPC, gRPC, HTTP+JSON/REST. Version negotiated with the `A2A-Version` header (major.minor).
- **Opacity.** Agents collaborate on declared capabilities and exchanged messages, without sharing internal memory,
  state or tool implementations.
- **What it leaves to each agent:** task decomposition, planning, conflict prevention, verification and budgets. It
  is the wire contract between opaque agents, not a coordination policy.

**Status and adoption.** Launched by Google April 2025; donated to the Linux Foundation June 2025; IBM's Agent
Communication Protocol merged in August 2025; v1.0 (first stable spec: multi-protocol bindings, version negotiation,
multi-tenancy, signed cards) March 2026. At its one-year mark (2026-04-09): more than 150 supporting organisations,
22,000+ GitHub stars, SDKs in Python, JavaScript, Java, Go and .NET; integrated in Azure AI Foundry and Copilot Studio
and Amazon Bedrock AgentCore Runtime. On 2026-08-17 it became a hosted project of the Agentic AI Foundation, beside
MCP (MCP for agent-to-tool, A2A for agent-to-agent). Named production uses: Huawei HarmonyOS assistant to in-app
agents, Tencent WeChat with Android OEM assistants; Google Cloud runs A2A agents through ADK, Agent Engine, Cloud Run
and GKE.

Sources: https://a2a-protocol.org/latest/specification/ ·
https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year ·
https://aaif.io/blog/a2a-joins-aaif

---

## 4. Microsoft

### 4.1 Magentic-One [older] (paper, arXiv 2411.04468, 2024-11-07)

- **Orchestrator with two ledgers.** Outer loop: a **task ledger** of given or verified facts, facts to look up, facts
  to derive, educated guesses, and a step-by-step plan assigning steps to agents (a hint, not a script). Inner loop:
  each step the orchestrator fills a **progress ledger** answering five questions: is the request fully satisfied;
  is the team looping or repeating itself; is forward progress being made; which agent speaks next; what
  instruction to give it.
- **Stall detection and replanning.** A stall counter increments on a loop or no progress; past a threshold (2 in the
  experiments) the orchestrator leaves the inner loop, reflects, updates the task ledger, revises the plan, and all
  agents **reset their contexts**. Ends on completion or limits (attempts, time; e.g. a 25-minute budget), reporting
  an answer or best guess.
- **Workers.** WebSurfer, FileSurfer, Coder (LLM agents) and ComputerTerminal (deterministic executor); only the
  orchestrator addresses them.
- **Evidence.** Removing the ledgers cut GAIA validation performance by 31%. Top failure codes in logs:
  persistent-inefficient-actions, insufficient-verification-steps, inefficient-navigation-attempts.

Source: https://arxiv.org/html/2411.04468v1

### 4.2 AutoGen AgentChat [older] (docs; maintenance mode since about October 2025, secondary)

- Teams: `RoundRobinGroupChat`, `SelectorGroupChat` (an LLM picks the next speaker from names and descriptions; each
  reply is broadcast to all participants; the same speaker is not picked twice in a row by default; `selector_func`
  overrides, `candidate_func` narrows), `Swarm` (handoff messages), `MagenticOneGroupChat`.
- **Termination conditions** composable with `|` and `&`: MaxMessage, TextMention, **TokenUsage**, **Timeout**,
  Handoff, SourceMatch, **External** (a stop button), StopMessage, TextMessage, FunctionCall, Functional.

Sources: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html ·
https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html

### 4.3 Microsoft Agent Framework (1.0 GA early April 2026, secondary; successor to AutoGen and Semantic Kernel; docs updated Oct 2026)

- Built-in orchestrations: Sequential, Concurrent, Handoff (agents transfer control), Group Chat, Magentic; human
  approval through approval-required tools; checkpointing.
- **Group chat.** Star topology with an orchestrator in the middle choosing the next speaker (round robin, a
  selection function, an orchestrator agent, or custom). Agents do not share one session object: before each turn
  the orchestrator **synchronises each agent's session** with the conversation and broadcasts every response; in
  Python, tool calls and results are filtered out before broadcast. Stops on `termination_condition` /
  `MaximumIterationCount`.
- **Magentic.** Magentic-One's manager (ledger prompts from the paper) over your own agents, with
  `max_round_count`, `max_stall_count` (consecutive non-progressing rounds before reset and replan) and
  `max_reset_count`; optional human **plan review** (approve or revise; also offered on stall-triggered replans);
  events for plan created, replanned and progress ledger updated each round. The docs warn: "it is untested how well
  the Magentic orchestration will perform outside of the original Magentic-One design."

Sources: https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/ ·
https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat ·
https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic

---

## 5. LangChain and LangGraph

- **Supervisor (`langgraph-supervisor`; repository archived 2026-09-20).** A supervisor routes with handoff tools
  (`create_handoff_tool`, returning `Command(goto=..., graph=Command.PARENT)`), `output_mode` `full_history` or
  `last_message` for what a worker adds to shared state, supervisors of supervisors, and a `forward_message` tool so a
  worker's answer reaches the output without the supervisor paraphrasing it. Its README now recommends "the
  supervisor pattern directly via tools rather than this library", for more control over context.
  https://github.com/langchain-ai/langgraph-supervisor-py
- **Swarm (`langgraph-swarm`).** Agents hand off directly to each other with handoff tools; an `active_agent` key
  records who is active and the next turn resumes with that agent; all agents share one `messages` list by default;
  needs a checkpointer. https://github.com/langchain-ai/langgraph-swarm-py
- **LangChain multi-agent patterns (docs, read 2026-11-02).** Subagents (all routing through the main agent; subagents
  stateless), handoffs (a state variable switches the active agent; sequential), skills (one agent loads prompts on
  demand), router (classify, fan out, synthesise; parallel), custom LangGraph workflow. Their measured comparison on
  one scenario: subagents 4 model calls one-shot, about 9K tokens multi-domain; handoffs 7+ calls, 14K+ tokens;
  stateful patterns save 40-50% of calls on repeat requests. https://docs.langchain.com/oss/python/langchain/multi-agent
- **Deep Agents (docs).** A `task` tool to named subagents (a general-purpose one by default); isolated mode passes
  only the task description and returns only the final result (optionally as structured output); `fork` mode (beta)
  inherits the parent history and cannot delegate further; several `task` calls in one turn run in parallel; async
  subagents for long-running or steerable work. https://docs.langchain.com/oss/python/deepagents/subagents

---

## 6. CrewAI (docs, read 2026-11-02)

- **Processes.** `Process.sequential` (default) or `Process.hierarchical`, where a manager (`manager_llm` or a custom
  `manager_agent`) assigns tasks by each agent's role, capabilities and tools and evaluates outcomes; `planning=True`
  adds a planning step.
- **Delegation tools.** `allow_delegation` (default False) gives an agent two tools: "Delegate work to
  coworker(task, context, coworker)" and "Ask question to coworker(question, context, coworker)". No numeric cap on
  delegation rounds; loops are prevented structurally (specialists keep `allow_delegation=False`).
- **Shared state.** A task's `context=[other tasks]` feeds their outputs in and makes it wait for them;
  `async_execution`; `memory=True`.
- **Verification.** Per-task `guardrail(s)` (a function returning (bool, value), or a string that becomes an LLM
  check), failures fed back to the agent up to `guardrail_max_retries` (default 3); `output_pydantic`/`output_json`;
  `human_input` review of the final answer.
- **Limits.** Agent `max_iter` (default 20), `max_retry_limit` (default 2), `max_rpm`, `max_execution_time`,
  `respect_context_window` (summarises when near the limit).

Sources: https://docs.crewai.com/en/learn/hierarchical-process · https://docs.crewai.com/en/concepts/collaboration ·
https://docs.crewai.com/en/concepts/agents · https://docs.crewai.com/en/concepts/tasks

---

## 7. MetaGPT [older] (paper, arXiv 2308.00352, v1 2023-08-01, v7 2024-11-01; ICLR 2024)

- **Standard operating procedures as a fixed pipeline of roles**, each producing a defined document: Product Manager
  (PRD with user stories, requirement pool), Architect (system design: file list, data structures, interfaces,
  sequence diagram), Project Manager (task list, one task per code file), Engineer (code), QA Engineer (tests).
- **Structured communication.** Agents exchange documents and diagrams, not dialogue, to avoid "telephone game"
  distortion.
- **Shared message pool with publish-subscribe.** Agents publish structured messages to one pool and **subscribe by
  role profile**, because "sharing all information with every agent can lead to information overload"; an agent acts
  only once all its prerequisite inputs have arrived.
- **Executable feedback.** The Engineer writes and runs unit tests and debugs "until the test is passed or a maximum
  of 3 retries is reached"; removing it raised human revisions from 0.83 to 2.25 per project.

Source: https://arxiv.org/html/2308.00352v7

---

## 8. Coding agents

### 8.1 Cursor

- **Parallel agents [older] (2.0, 2025-10-29).** "Run up to eight agents in parallel on a single prompt", each in its own
  git worktree or remote machine "to prevent file conflicts". https://cursor.com/changelog/2-0
- **Worktrees and best-of-N (docs, read 2026-11-02; Cursor 3.x).** `/worktree` runs a task in a separate checkout;
  `/best-of-n sonnet,gpt,composer` runs the same task on several models, each in its own worktree; the person picks a
  winner and brings it back with `/apply-worktree` (or commits/PRs from the worktree). Setup per worktree via
  `.cursor/worktrees.json`; at most 25 worktrees per machine (older ones cleaned up).
  https://cursor.com/docs/configuration/worktrees
- **Subagents (docs, read 2026-11-02).** Several Task tool calls in one message run simultaneously; clean context;
  only a final message returns; failures return an error status the parent can retry or resume; resume by agent ID;
  `readonly` blocks edits and state-changing shell commands; background subagents write state to
  `~/.cursor/subagents/` for the parent to read; since 2.5 one extra level of nesting. Isolation: by default subagents
  **share the parent's checkout**; with isolation each gets its own worktree or cloud VM and branch, and "changes stay
  on that branch until the parent merges them". https://cursor.com/docs/subagents
- **Scaling long-running autonomous coding (blog, 2026-01-14).** Hundreds of concurrent agents for weeks on one
  project. (1) Shared file with locks to claim tasks: locks held too long or never released; "twenty agents would slow
  down to the effective throughput of two or three". (2) Optimistic concurrency (writes fail if state changed):
  simpler, but without hierarchy agents became risk-averse and churned on small safe changes. (3) What worked:
  **planners** (and sub-planners) explore and create tasks; **workers** take one task, do not coordinate with other
  workers, and push; a **judge** decides at the end of each cycle whether to continue; each cycle starts fresh to fight
  drift and tunnel vision. A separate integrator role was removed as a bottleneck; workers resolved conflicts
  themselves. Model per role (one model planned better, another stopped early and took shortcuts).
  https://cursor.com/blog/scaling-agents

### 8.2 Devin (Cognition)

- **"Don't build multi-agents" [older] (2025-06-12).** Two principles: share full agent traces, not just messages;
  "actions carry implicit decisions, and conflicting decisions carry bad results" (two subagents building parts of a
  Flappy Bird clone chose incompatible styles). Recommended a single-threaded agent plus history compression.
  https://cognition.com/blog/dont-build-multi-agents
- **Managed Devins (2026-03-19).** A coordinator session "scopes the work, assigns each piece to a managed Devin,
  monitors progress, resolves any conflicts" and compiles results (e.g. into a set of PRs). Each child is a full Devin
  in its **own VM** with a clean context and its own session link. The coordinator can message any child mid-task,
  track each child's compute use, put children to sleep or stop them, schedule check-ins to itself, and read child
  trajectories to improve later breakdowns. Docs: children get their own prompt, playbook, tags and compute (ACU)
  limit; for batch work Devin proposes the sessions for approval first; the same controls are exposed through the
  Devin MCP server. Example concurrency cap: 10 sessions. https://cognition.com/blog/devin-can-now-manage-devins ·
  https://docs.devin.ai/work-with-devin/advanced-capabilities
- **"Multi-agents: what's actually working" (2026-04-22).** Works in production: **one writer with read-only helpers**
  (search, codebase Q&A); a **review agent with a clean context** (Devin Review: on average 2 bugs caught per PR, about
  58% severe; better without the coder's context); a "smart friend" (a cheaper primary model consults a stronger one,
  sharing a fork of the full context); manager/child Devins coordinated through an internal MCP ("map-reduce-and-manage").
  Still not working: parallel writers (conflicting implicit decisions), children assuming shared state, sub-agents not
  reliably reporting discoveries back. https://cognition.com/blog/multi-agents-working

### 8.3 GitHub Copilot

- **Coding agent (docs, read 2026-11-02).** Runs in a GitHub Actions environment or a cloud sandbox; "can only work on
  one branch at a time and can open one pull request per task"; 59-minute maximum per Actions session; rulesets and
  branch protection apply; Agent Merge works on failing workflows and merge conflicts; humans review the PR.
  https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
- **Agent HQ / mission control [older] (announced 2025-10-28; Claude and Codex in public preview 2026-02, secondary).**
  One place to assign, steer and track agents from several vendors; the same task can go to several agents in
  parallel for comparison. https://www.i-programmer.info/news/105-artificial-intelligence/18651-github-adds-claude-and-codex-to-agent-hq.html
- **Copilot CLI `/fleet` (blog 2026-04-01).** An orchestrator splits the objective into work items with
  dependencies, starts independent items as background subagents, polls for completion and starts the next wave,
  then verifies and combines outputs. Subagents cannot message each other and do not see the orchestrator's history.
  Shared filesystem with **no locking**: "If two agents write to the same file, the last one to finish wins—silently."
  Mitigations given: distinct files per agent, temporary paths merged by the orchestrator, an explicit order for
  shared files. Custom agents in `.github/agents/`. https://github.blog/2026/04/01/run-multiple-agents-at-once-with-fleet-in-copilot-cli/ ·
  https://docs.github.com/en/copilot/concepts/agents/copilot-cli/fleet

---

## 9. Added: one more framework and two studies

- **AWS Strands Agents swarm (docs, read 2026-11-02).** Peers hand off with an injected `handoff_to_agent(agent_name,
  message, context)` tool; Python shares a key-value `SharedContext` (original task, who worked on it, contributed
  knowledge, collaborators). Runtime safety limits: `max_handoffs` 20, `max_iterations` 20, `execution_timeout` 900 s,
  `node_timeout` 300 s, and **repetitive-handoff detection** (`repetitive_handoff_detection_window` with
  `repetitive_handoff_min_unique_agents`; off by default): if too few distinct agents appear in the recent window the
  swarm stops with FAILED. Results include node history and accumulated usage.
  https://strandsagents.com/latest/documentation/docs/user-guide/concepts/multi-agent/swarm/
- **Towards a science of scaling agent systems (Google Research; arXiv 2512.08296, Dec 2025; blog 2026-01-28).** 180
  configurations, five architectures (single, independent, centralised, decentralised, hybrid), four benchmarks,
  three model families. Centralised coordination +80.9% on a parallelisable finance task; multi-agent variants -39%
  to -70% on a sequential planning task; independent agents amplified errors 17.2x versus 4.4x with an orchestrator
  acting as a "validation bottleneck"; coordination overhead grows with tool count.
  https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
- **Why do multi-agent LLM systems fail? (MAST; arXiv 2503.13657, 2025-03, revised 2025-10) [older].** 14 failure modes
  in three groups (system design issues, inter-agent misalignment, task verification) from 1,600+ traces across 7
  frameworks; gains over single agents on popular benchmarks "often minimal". https://arxiv.org/abs/2503.13657

---

## 10. Cross-system table of mechanisms

Abbreviations: CC = Claude Code; MAF = Microsoft Agent Framework; ctx = context window; WT = git worktree.

**Platforms and SDKs**

| Mechanism | Anthropic research system | CC subagents (+ Agent SDK) | CC agent teams | CC dynamic workflows / Managed Agents runs | OpenAI Agents SDK | Codex | Google ADK | A2A |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Work split | Lead plans, writes briefs (objective, format, tools, boundaries); effort rules by query type | Model picks agent by `description`, writes a brief; parallel calls in one turn | Lead creates tasks with dependencies; lead assigns or teammates self-claim | A script (written by Claude) fans out with `parallel`/`pipeline`, in phases | Handoff (specialist takes over) or agent-as-tool (manager keeps control); or code routing/chaining | Cloud: one task per request, best-of-N; subagents only on explicit request | Coordinator `transfer_to_agent` by descriptions, `AgentTool`, or Sequential/Parallel/Loop agents | Not defined (client sends a Task to a remote agent chosen from its Agent Card) |
| Shared state | Plan in external memory; outputs in files, references returned | Brief string only; final report back; worktree files | Shared task list (files); per-agent JSON mailbox; team config roster | Script variables; typed JSON results; Managed: shared sandbox and filesystem | Full history on handoff (filterable/nested); session or server conversation; run context | Per-task workspace; AGENTS.md; main thread collects results | Session state keys via `output_key`; isolated branches for parallel children | None shared; messages, artifacts, `contextId` |
| Agent-to-agent | Via lead only | Via parent; named agents can `SendMessage`; resume by ID | Direct by name (no broadcast); idle notices to lead | None inside a run; script passes results | Via handoff transfer or tool result | Via main thread only | Via transfer, tool result or state | Remote agent opaque; message/task API, SSE, webhooks |
| Conflict prevention | Read-only research | `isolation: worktree` per writer | None built in; partition files by owner | Each writer in an isolated copy (WT) | Not addressed (single active agent at a time for handoffs) | Container per cloud task; app worktrees; caution on parallel writes | Distinct `output_key` per branch; locks if sharing ctx | Out of scope |
| Progress / stuck detection | Lead decides when to stop; checkpoints, resume | `maxTurns` returns partial; completion notices; depth/concurrency caps | Task states, blocked deps; `TeammateIdle` hook; known status lag | Per-agent stall restart (5x), "no progress in two rounds" stop rules; resumable replay | `max_turns` / `MaxTurnsExceeded`; tracing | Waits for all; per-session thread cap | `LoopAgent` `max_iterations`, `escalate` | Task states incl. input-required, failed, canceled |
| Verification / merge | Lead synthesis; CitationAgent; LLM judge in evals | Parent reads report (scanned for injected tags) | `TaskCompleted`/`TaskCreated` hooks; plan approval | Adversarial verify, claim voting, typed schemas with retries | Guardrails; evaluator loop in code | Test/log evidence; person reviews diff, opens PR | Generator-critic, merger agent reads keys | Artifacts returned; verification is the client's |
| Cost control | Effort-scaling rules; Sonnet workers | Depth 3, 20 concurrent, `maxBudgetUsd` (refuses spawns, stops background agents) | Small teams, Sonnet teammates, shutdown | 16 concurrent, 1,000 agents/run, size guideline, large-run warning; Managed: session budget | `max_turns`; code-driven flows | Explicit-request spawning; thread cap; cheaper model for light subagents | `max_iterations`; deterministic workflow agents | Out of scope |

**Frameworks and coding products**

| Mechanism | Magentic-One / MAF Magentic | AutoGen / MAF group chat | LangGraph supervisor / swarm | CrewAI hierarchical | MetaGPT | Cursor | Devin (managed) | Copilot (/fleet, coding agent) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Work split | Orchestrator's task ledger plan; picks next agent each step | Manager selects next speaker (round robin, LLM, function) | Supervisor handoff tools; swarm peers hand off | Manager assigns by role/tools; delegate/ask tools | Fixed SOP pipeline of roles and documents | Parent subagents; planner/worker/judge at scale; best-of-n | Coordinator scopes and assigns child sessions | Orchestrator work items with dependencies, in waves; one PR per coding-agent task |
| Shared state | Ledgers held by orchestrator | Full shared conversation, synced and broadcast | Shared `messages`; `active_agent`; checkpointer | Task `context` outputs; memory | Message pool, publish-subscribe by role | Final messages; background state files; branches | Child VMs; coordinator reads trajectories | Shared filesystem; brief only |
| Agent-to-agent | Only via orchestrator | Broadcast to all participants | Supervisor: via supervisor; swarm: direct handoff | Via delegation tools | Via pool subscriptions | Workers don't coordinate | Coordinator messages children mid-task | Not allowed between subagents |
| Conflict prevention | Single speaker at a time | Single speaker at a time | Single active agent | Sequential tasks | Pipeline order; one code file per task | Worktree / VM per agent; merge by parent | VM per child; coordinator resolves conflicts | None (last write wins); assign distinct files; PR branch per task |
| Progress / stuck detection | Progress ledger (satisfied? looping? progressing?), stall counter, replan, reset limits | Termination conditions incl. token, timeout, external stop | Graph state; checkpointer | `max_iter` 20, `max_execution_time` | Acts when prerequisites arrive | Judge per cycle; fresh start each cycle | Scheduled check-ins; sleep/stop children | Orchestrator polls; `/tasks`; 59-min session cap |
| Verification / merge | Orchestrator checks completion; final synthesis; human plan review | Reviewer agent + termination on approval | `forward_message` passes worker answer unparaphrased | Guardrails, 3 retries; human input | Executable tests, 3 debug retries | Person picks best-of-n winner, applies worktree | Clean-context review agent; results compiled into PRs | Orchestrator verifies and combines; human PR review; Agent Merge for CI and conflicts |
| Cost control | `max_round_count`, `max_stall_count`, `max_reset_count` | `TokenUsageTermination`, max messages | Graph `recursion_limit` | `max_rpm`, `max_iter` | Fixed role count | Up to 8 parallel; 25 worktrees/machine; model per role | Per-child compute (ACU) limits; concurrency cap | Model per custom agent; each subagent spends credits; parallelise only independent items |

---

## 11. Mechanisms that recur and look most proven

1. **A lead that briefs workers and receives only their final reports.** Anthropic's research system, Claude Code,
   Codex, Cursor, Copilot `/fleet`, Devin, OpenAI agents-as-tools, ADK `AgentTool`, LangChain subagents. Evidence:
   +90.2% on Anthropic's research eval; independent agents amplified errors 17.2x versus 4.4x with an orchestrator
   (Google). A brief carries objective, output format, tools/sources and boundaries; effort rules sit in the lead's
   prompt.
2. **Parallel fan-out for independent, mostly read-heavy work; writes single-threaded or isolated.** Stated by
   Anthropic ("poor fit for most coding"), Codex docs, Cognition (2025 and 2026), and measured by Google (-39% to -70%
   on sequential tasks). Split by context boundary, not by role (Anthropic 2026-01).
3. **One isolated workspace per parallel writer, merged through git.** Worktree, container or VM per agent with a
   branch, diff or PR: Codex cloud and app, Cursor, Claude Code `isolation: worktree` and workflows, Copilot coding
   agent, Devin, the C compiler run. Where it is missing (agent teams, `/fleet`) the docs fall back to file ownership
   and warn of silent overwrites.
4. **Hard limits enforced by the runtime, not the prompt.** Turns, depth, concurrency, agents per run, wall time and a
   spend budget that refuses new spawns and stops background agents (Claude Agent SDK, workflows, Managed Agents,
   OpenAI `max_turns`, AutoGen token/time terminations, MAF round/stall/reset counts, CrewAI `max_iter`, Strands
   timeouts and handoff caps). A partial result marked as partial and resumable (Claude Code `maxTurns`).
5. **Explicit progress checks with a stall counter that triggers replan, restart or stop.** Magentic-One's progress
   ledger (ablation: -31% without ledgers), MAF `max_stall_count`/`max_reset_count`, workflow stall restarts and
   "no progress for two rounds" rules, Strands repetitive-handoff detection, message-loop throttling between sessions.
6. **A separate verifier with a clean context and explicit, executable criteria.** Devin Review, Anthropic's
   verification subagent and CitationAgent, MetaGPT's test-and-debug loop (3 retries), workflow adversarial checks
   and claim voting, ADK generator-critic, CrewAI guardrails (3 retries), CI blocking regressions, completion hooks
   that can refuse "done". Known failure: verifiers declaring victory after one or two tests.
7. **Structured hand-offs and durable state outside any one context.** Schemas for results (workflows, CrewAI,
   OpenAI routing), documents instead of chat (MetaGPT), artifacts versus messages (A2A), large outputs written to files
   with references passed (Anthropic), plans, progress files, feature lists and git commits as checkpoints for
   resumption (Anthropic research system and long-running harness, workflow replay).
8. **Task claiming needs an atomic arbiter and stays small.** Claim locks plus dependency unblocking work for a few
   agents (Claude Code teams' file lock, the C compiler's lock file settled by git push), but Cursor found shared
   locks collapsed 20 agents to the throughput of 2-3 and moved to planners and workers; Claude Code documents task
   status lag blocking dependants.
9. **Messages from other agents are data, not authority.** Claude Code marks inter-agent and cross-session messages
   as not from the person (no approvals, no config changes, commands not run), screens subagent reports, and A2A keeps
   agents opaque with signed identity cards.
10. **Best-of-N with a human or judge choosing.** Codex, Cursor `/best-of-n`, Agent HQ; reliable in products but costs
    N times the tokens and needs a selection step.
