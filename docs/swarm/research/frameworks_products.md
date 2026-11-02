# Agent swarm frameworks and products: features to adopt and gaps nobody fills well (as of 2026-11-02)

Scope note: the sibling note `docs/agents-mcp/research/coordination-systems.md` already covers how each system coordinates
work: lead and worker briefs, task lists, mailboxes, worktrees, stall detection, A2A wire format, and Magentic-One ledgers. This
note does not repeat that detail. It adds adoption, durability, verification, cost, observability and product evidence, and ends
with a ranked feature list. Facts the older note documents are marked "(coord. note)" and keep their original URL.

Labels: **[primary]** official docs, repo or company post. **[secondary]** third-party coverage or aggregator.
**[vendor claim]** self-reported and not independently checked. **[analyst]** analyst forecast. **[older]** before 2026.
**[may be outdated]** fast-moving figure. GitHub star counts come only from secondary roundups, disagree with each other, and
were not checked against GitHub. Treat them as rough.

---

## 1. Frameworks: core abstractions, parallelism, state, verification, durability, observability, cost limits

### Takeaway
Frameworks have converged on two shapes: an LLM supervisor that calls agents as tools, and deterministic workflows or graphs
with checkpoints. LLM-routed "networks" and peer swarms are being deprecated or archived. None of them ships first-class
verification of results (claims, evidence, per-criterion grading). Durability is mostly handed to an outside engine
(Temporal, DBOS, Restate, Prefect), and cost limits are usually turn or iteration caps, not money. Anthropic's Managed Agents
"outcomes" (rubric plus a separate-context grader) is the only platform-level verification primitive found.

### Cited Findings

**OpenAI Agents SDK and Swarm**
- Swarm (2024, educational) is deprecated, and its README sends users to the Agents SDK for production. Existing Swarm code still runs. — [respan.ai](https://www.respan.ai/articles/is-openai-swarm-still-worth-using) [secondary]
- Agents SDK primitives: handoffs (`transfer_to_<agent>`, full history by default, `input_filter`), agents-as-tools (`Agent.as_tool()`, manager keeps control), input and output guardrails, `max_turns` / `MaxTurnsExceeded`, built-in tracing, sessions, pause and resume via `RunState`. Durable-execution integrations: Temporal, Dapr, Restate, DBOS. (coord. note) — [OpenAI Agents SDK docs](https://openai.github.io/openai-agents-python/running_agents/) [primary]
- The Temporal integration for the Agents SDK (Python) went from public preview (July 2025) to **general availability on 2026-03-23**. — [Temporal blog](https://temporal.io/blog/announcing-openai-agents-sdk-partnership) [primary, vendor]
- The April 2026 update reportedly added "sandbox agents" that run code and commands in isolated containers. One source cites 500 ms to 2 s of provisioning overhead. — [respan.ai / toolbrain](https://toolbrain-astro.pages.dev/blog/openai-swarm-to-agents-sdk-evolution-handoff-multi-agent/) [secondary]
- Stars: about 20.2k, 25.8k or 27k depending on the source; the Firecrawl roundup gives about 26.9k. — [Firecrawl](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks) [secondary, may be outdated]

**Microsoft Agent Framework (successor to AutoGen and Semantic Kernel)**
- **1.0 GA on 2026-04-03** in .NET and Python. It combines AutoGen's agent abstractions with Semantic Kernel's enterprise features (session state, type safety, middleware, telemetry). AutoGen and Semantic Kernel get only fixes and security patches, and Microsoft provides migration assistants. — [Microsoft Tech Community](https://techcommunity.microsoft.com/blog/azuredevcommunityblog/the-future-of-agentic-ai-inside-microsoft-agent-framework-1-0/4510698) [primary]; [Machine Herald](https://machineherald-io.pages.dev/article/2026-04/14-microsoft-ships-agent-framework-10-merging-semantic-kernel-and-autogen-into-a-single-production-ready-sdk) [secondary]
- Orchestrations: Sequential, Concurrent, Handoff, Group Chat and Magentic (with `max_round_count`, `max_stall_count`, `max_reset_count` and human plan review), plus checkpointing and approval-required tools. Microsoft's docs warn that Magentic is "untested" outside the original Magentic-One design. (coord. note) — [MS Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic) [primary]

**LangGraph and LangChain**
- LangGraph 1.0 shipped in October 2025 as "the first stable major release in the durable agent framework space": state persists automatically across server restarts and interruptions. Interrupts and resume need a checkpointer and a thread ID. — [LangChain changelog](https://changelog.langchain.com/announcements/ann_lxOZRCoFw2Qn9) [primary]; [Medium](https://medium.com/@romerorico.hugo/langgraph-1-0-released-no-breaking-changes-all-the-hard-won-lessons-8939d500ca7c) [secondary]
- Licensing: the library is MIT. The Agent Server that serves graphs over HTTP is under Elastic License 2.0, and self-hosting it in production needs a LangSmith license key. — [Geekflare](https://geekflare.com/open-source/langgraph/) [secondary]
- Temporal argues that "checkpoints are not durable execution": a LangGraph run lives in one process and dies with it. Temporal shipped a LangGraph plugin in July 2026. — [Temporal blog](https://temporal.io/blog/temporal-langgraph-plugin-durable-execution) [vendor pitch]
- `langgraph-supervisor` was archived on 2026-09-20. Its README now recommends the supervisor pattern "directly via tools". (coord. note) — [GitHub](https://github.com/langchain-ai/langgraph-supervisor-py) [primary]
- Named production users of LangChain and LangGraph (Uber, JPMorgan, BlackRock, Cisco, LinkedIn, Klarna) appear only on third-party sites. No LangChain-published 2026 customer list was found. — [respan.ai](https://www.respan.ai/market-map/langgraph) [secondary]

**CrewAI**
- About 52.4k stars (CrewAI 1.14.6), the most among multi-agent frameworks in these roundups. — [morphllm](https://www.morphllm.com/ai-agent-framework) [secondary, may be outdated]
- About 2 billion "agentic system executions" in the 12 months before January 2026 [vendor claim, via secondary]. The "450M runs/month" and "63% of Fortune 500" claims could not be traced to CrewAI. In October 2024 the open-source framework ran more than 10M agents a month. — [getpanto](https://www.getpanto.ai/blog/crewai-platform-statistics); [rywalker](https://rywalker.com/research/crewai) [secondary]
- Funding: $18M (inception round plus a Series A led by Insight Partners, October 2024). No later round was found. — [pulse2](https://pulse2.com/crewai-multi-agent-platform-raises-18-million-series-a) [secondary, older]
- Flows: event-driven workflows with typed state, start/listen/router steps, persistence and resumability. Pricing is now a free Basic tier and a custom Enterprise tier; the $25 Professional tier was removed in spring 2026. — [automationatlas](https://automationatlas.io/answers/crewai-pricing-explained-2026/) [secondary]
- Per-task guardrails (a function, or an LLM check) with `guardrail_max_retries` (default 3), `max_iter` 20, `max_execution_time`. (coord. note) — [CrewAI docs](https://docs.crewai.com/en/concepts/tasks) [primary]

**Google ADK and A2A**
- Workflow agents (Sequential, Parallel, Loop). ADK 2.0 adds graph workflows, dynamic workflows and sub-agent modes, in Python, Go and TypeScript. (coord. note) — [adk.dev](https://adk.dev/workflows/) [primary]
- Stars for adk-python: about 18.5k in one table, about 8.2k in another (the latter looks like an early snapshot). — [shiporskip](https://shiporskip.io/compare/google-adk-python-agent-development-kit-multi-agent-orchestration-2026-vs-openai-agents-python-lightweight-multiagent-framework-swarm-2026) [secondary, inconsistent]

**Anthropic: Claude Agent SDK and Managed Agents**
- Agent SDK subagents with runtime-enforced depth, concurrency and `maxBudgetUsd`. At the cap it refuses new spawns, stops background subagents and ends with `error_max_budget_usd`. (coord. note) — [Claude Code docs](https://code.claude.com/docs/en/agent-sdk/subagents) [primary]
- **Managed Agents "Outcomes"** (beta header `managed-agents-2026-04-01`, public beta since 2026-05-06):
  - **Definition.** One `user.define_outcome` event carries a `description`, a **required markdown rubric** (inline text or a Files API file) and `max_iterations` (default 3, maximum 20).
  - **Grader.** The harness provisions a **grader in a separate context window** "to avoid being influenced by the main agent's implementation choices". It scores each criterion independently and returns an explanation of which criteria passed or failed.
  - **Results.** `span.outcome_evaluation_end.result` is one of `satisfied`, `needs_revision`, `max_iterations_reached` (one final acknowledgement turn, no more evaluation), `failed` (the rubric does not apply to the deliverables, for example because it contradicts the description) or `interrupted`.
  - **Visibility and limits.** Each evaluation reports its own token `usage`. Grader reasoning is opaque (only heartbeats). One outcome runs at a time; outcomes can be chained.
  - **Docs advice.** Write gradeable criteria ("The CSV contains a price column with numeric values", not "the data looks good"), and bootstrap a rubric by asking Claude what makes a known-good example good.
  - **Data handling.** Managed Agents is **not eligible for zero data retention or HIPAA**.

  — [Claude docs: Define outcomes](https://platform.claude.com/docs/en/managed-agents/define-outcomes) [primary]
- Anthropic's headline claim is up to about 10 points of task-success improvement. One blog notes that part of the gain is attributed to "dreaming" (memory consolidation), not Outcomes. "Outcomes cost 1.5-3x base run cost" comes from a single third-party blog. — [findskill](https://findskill.ai/blog/claude-outcomes-rubric-grading/); [SD Times](https://sdtimes.com/ai/new-in-claude-managed-agents-dreaming-outcomes-and-multiagent-orchestration/) [secondary, vendor claim]
- Managed Agents multiagent: subagents, dynamic workflows and an advisor model; shared sandbox and filesystem; at most 25 child threads; a session budget that pauses runs. (coord. note) — [Claude docs](https://platform.claude.com/docs/en/managed-agents/multi-agent) [primary]

**Mastra (TypeScript; most relevant direct peer)**
- v1 released (beta late 2025, GA around January 2026). — [mastra.ai blog](https://mastra.ai/blog/page/2) [primary]
- Stars: about 21-25k (24.8k per Firecrawl). — [Firecrawl](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks) [secondary]
- Workflows: suspend at any step (human input, API callbacks, throttling costly operations), resume by step ID. **Snapshots are kept in the configured storage and survive deployments and restarts.** — [Mastra docs: suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume.md) [primary]
- **Agent networks (`.network()`, an LLM router over agents, workflows and tools) are deprecated** "and will be removed in a future major release". The docs point to **supervisor agents** with a migration guide. Networks needed memory to judge completion; approval and suspend arrive as stream chunks (`approveNetworkToolCall`, `resumeNetwork`, `autoResumeSuspendedTools`); output is validated with a Zod `structuredOutput`. — [Mastra docs: networks](https://mastra.ai/docs/agents/networks) [primary]

**Pydantic AI**
- Four documented durable-execution backends: **Temporal, DBOS and Prefect** ship with Pydantic AI as attachable capabilities, and **Restate** has its own SDK. All are co-maintained with the engine vendors and use only the public interface. A durable agent survives transient API failures, application errors and restarts, with streaming and MCP fully supported. Temporal has restrictions, for example on sub-agents that read agent folders at run start. — [Pydantic AI docs](https://pydantic.dev/docs/ai/integrations/durable_execution/overview/index.md) [primary]
- You must run or pay for the engine yourself (Temporal, or DBOS on SQLite/Postgres). — [rywalker](https://rywalker.com/research/pydantic-ai) [secondary]

**Letta (stateful memory)**
- **Sleep-time agents**: enabling them creates a primary agent (with `conversation_search` and `archival_memory_search`) and a background agent that rewrites the primary's memory blocks asynchronously. It runs every N steps (default 5). A memory block can be attached to several agents ("multi-agent shared memory"). — [Letta docs](https://docs.letta.com/guides/agents/architectures/sleeptime) [primary]

**Agno**
- AgentOS is the production runtime for agents, teams and workflows: a FastAPI app with session management, monitoring and an integrated control plane. Thoughtworks Radar lists it. About 42.9k stars. — [Agno docs](https://docs.agno.com/introduction) [primary]; [Thoughtworks Radar](https://www.thoughtworks.com/radar/languages-and-frameworks/agno) [secondary]; [openalternative](https://openalternative.co/compare/agentos/vs/agno) [secondary]

**CAMEL / OWL**
- OWL is built on CAMEL's "Workforce" (a planner plus workers). The README reports a **GAIA average of 69.09** (April 2025, the top open-source framework at the time; 58.18 in March 2025). The paper adds "Optimized Workforce Learning" (RL for the planner) and claims to beat OpenAI Deep Research on GAIA. Eigent is the commercial product built on CAMEL. — [GitHub camel-ai/owl](https://github.com/camel-ai/owl) [primary, older]; [arXiv 2505.23885](https://www.arxiv.org/pdf/2505.23885) [primary, older]

**Swarms (kyegomez)**
- No technical evaluation was found. The project's credibility is clouded by a Solana "SWARMS" token (up about 4,964% in two weeks around January 2025), code-copying allegations the developer has not addressed, and a rival founder publicly calling him a scammer. These are accusations, not verified findings. — [Cryptonews](https://cryptonews.com/exclusives/swarms-grows-by-5000-but-scam-concerns-persist-why/); [Gate](https://www.gate.com/news/detail/11486462) [secondary]

**MetaGPT**
- An SOP pipeline of roles exchanging documents, with test-and-debug loops of 3 retries. (coord. note) — [arXiv 2308.00352](https://arxiv.org/html/2308.00352v7) [primary, older]

**Positioning consensus across roundups**
- CrewAI for fast role-based prototypes, the OpenAI Agents SDK for lightweight handoffs, LangGraph for control over complex stateful branching, Mastra for TypeScript teams. — [Speakeasy](https://www.speakeasy.com/blog/ai-agent-framework-comparison); [LangChain](https://www.langchain.com/resources/ai-agent-frameworks); [encore.dev (TS, 2026-10-23)](https://encore.dev/articles/best-typescript-framework-for-building-ai-agents) [secondary]

**Compact comparison** (each cell from the sources above)

| Framework | Core multi-agent primitive | State / durability | Verification built in | Cost / limit controls | Status signal |
|---|---|---|---|---|---|
| OpenAI Agents SDK | handoffs; agents-as-tools | sessions; RunState; Temporal (GA 2026-03), Dapr, Restate, DBOS | guardrails (input/output) | `max_turns` | active; Swarm deprecated |
| MS Agent Framework | Sequential/Concurrent/Handoff/GroupChat/Magentic | checkpointing | approval tools; Magentic plan review | round/stall/reset counts | GA 2026-04-03; AutoGen/SK maintenance |
| LangGraph | graph; supervisor via tools; swarm lib | checkpointer + thread; Agent Server ELv2 | none beyond graph nodes | `recursion_limit` | 1.x; supervisor lib archived |
| CrewAI | crews (sequential/hierarchical), Flows | Flows persistence/resume | task guardrails, 3 retries | `max_iter`, `max_rpm`, time | most stars |
| Google ADK | Sequential/Parallel/Loop, AgentTool, graph (2.0) | session state (`output_key`) | generator-critic pattern only | `max_iterations` | 2.0 in Py/Go/TS |
| Claude Agent SDK / Managed Agents | subagents, workflows, advisor | sessions; shared sandbox; workflow replay | **Outcomes: rubric + separate grader** | `maxBudgetUsd`, session budget | Outcomes beta 2026-05 |
| Mastra (TS) | supervisor agents; workflows | snapshots in storage, suspend/resume | Zod structured output; scorers not confirmed | not documented on networks page | networks deprecated |
| Pydantic AI | agents + delegation | Temporal/DBOS/Prefect/Restate | typed outputs | engine-dependent | active |
| Letta | sleep-time agent groups | persistent memory blocks | none | none found | active |
| Agno | agents, teams, workflows | AgentOS runtime + control plane | none found | none found | ~43k stars |

### Inferences
- **Convergence on "supervisor calls agents as tools".** Mastra deprecated LLM-routed networks for supervisors,
  langgraph-supervisor was archived in favour of tool-based supervisors, OpenAI's agents-as-tools keeps control in a manager,
  and ADK has `AgentTool`. A harness that already has sub-agents and teams with leads is on the mainstream path. Peer-to-peer
  "swarm" handoffs look like a dead end for high-stakes work.
- **Durability is outsourced in Python and thin in TypeScript.** The Python frameworks bolt on Temporal, DBOS or Restate.
  Mastra persists workflow snapshots, but agent loops inside a step are not journaled per tool call in anything found here.
  A TypeScript harness with a built-in, per-call journal (replay finished model and tool calls, idempotency keys for side
  effects) would beat Mastra and avoid a Temporal dependency.
- **Verification is the empty space.** Frameworks offer guardrails (CrewAI), loops (ADK LoopAgent) and structured outputs.
  Only Anthropic's Outcomes makes "grade against a rubric in a clean context, iterate, report a typed result" a platform
  primitive. Even it does not separate unverifiable from failed per criterion or expose evidence. The harness's done criteria
  and clean-context verifier already sit in this space and can lead it.
- **Framework churn is itself a buyer pain.** Swarm deprecated, AutoGen and Semantic Kernel in maintenance, langgraph-supervisor
  archived, Mastra networks deprecated, all within about a year. Stable, versioned primitives are a selling point.

### Gaps
- **Not researched at all** (no sources gathered, so nothing is said about them): Ray-based agent systems (Anyscale, Ray Serve
  for agents), ChatDev, AgentVerse, MetaGPT's commercial MGX/Atoms, Inngest AgentKit (TypeScript networks), and the Vercel AI SDK.
- **No verified data:**
  - Mastra scorers/evals and execution caps.
  - Agno verification and cost features.
  - Exact current GitHub stars for LangGraph.
- **Claude Agent SDK adoption:** no independent adoption figures were found.

---

## 2. Products that run swarms for customers: claims on accuracy, grounding, pricing

### Takeaway
High-stakes products sell **grounding**: citations to the page and paragraph, permission-aware retrieval, rubric benchmarks.
They do not sell swarm mechanics, and almost none publish independent accuracy numbers. Pricing has moved to units of work:
compute units, tasks, actions, credits and resolutions. Accuracy claims (Harvey 99.7% citations, Hebbia 92% vs 68% RAG) are
self-reported and have no published method.

### Cited Findings

**Legal: Harvey**
- On 2026-05-05 Harvey put **500+ prebuilt practice-area agents** live, with Agent Builder in early access, and reported
  **25,000+ custom agents** built on its platform. — [Harvey blog](https://www.harvey.ai/blog/built-by-lawyers-tailored-by-you) [primary]
- On 2026-05-06 it launched the **Legal Agent Bench (LAB)**:
  - **Size.** 1,200+ long-horizon tasks across 24 practice areas, scored against **75,000+ expert-written rubric criteria**.
  - **Task contents.** Each task has instructions, working documents and rubrics.
  - **Model and licence.** Built on the SWE-bench and Terminal-Bench pattern; open source (MIT mirror).
  - **Plans.** A public leaderboard; outside groups are invited to audit the rubrics and improve the harness.

  — [Artificial Lawyer](https://www.artificiallawyer.com/2026/05/06/harvey-launches-legal-agent-bench/) [secondary, reporting a primary launch]
- Commentary notes Harvey promised, but had not yet published, accuracy metrics for its high-volume agent work. "99.7% verified
  citation accuracy" and "flags citations it can't verify" appear only in a blog. — [pulse.bot](https://www.pulse.bot/legaltech/news/harvey-deploys-500-legal-ai-agents-globally-and-opens-opensource-benchmark-2265f5f1-603e-4f5e-a49b-64eb6560b8db/) [secondary, vendor claim]
- A reviewer's rule of thumb: "aggressive associate at 70% accuracy", with every output needing partner review. This is editorial,
  not a measurement. — [aiagentrank](https://aiagentrank.io/blog/harvey-ai-review-2026) [secondary, opinion]

**Finance research: Hebbia, AlphaSense**
- **Hebbia Matrix** splits each question into agent steps, **runs them on each document, and fills each grid cell with a
  sourced, reasoned answer**. Secondary analysis calls this an "agent swarm" architecture. "Iterative Source Decomposition (ISD)"
  merges structured market data (FactSet partnership, September 2025) with documents. — [BusinessWire](https://www.businesswire.com/news/home/20250908104474/en) [primary, older]; [vantaige](https://vantaige.io/fr/ai-tool/hebbia) [secondary]
- "92% accuracy on financial document benchmarks vs 68% for standard RAG" is company-stated; no method was found. Finance
  users report Hebbia "cannot be treated as an absolute source of truth without manually checking the cited passages". — [SFV IC memo](https://sfv-ic-agent.vercel.app/memo/hebbia) [secondary, vendor claim]; [vantaige](https://vantaige.io/fr/ai-tool/hebbia) [secondary]
- **AlphaSense Deep Research** is its first autonomous research agent. It works over web and proprietary non-public content and
  gives clickable citations "enabling both verification and deeper follow-up". — [VentureBeat](https://venturebeat.com/ai/alphasense-launches-its-own-deep-research-for-the-web-and-your-enterprise-files-heres-why-it-matters) [secondary]

**Enterprise knowledge and operations: Glean, Palantir AIP**
- **Glean** agents include a deep research agent that gives "citation-backed research" over company and world knowledge, with
  permissions enforced, full referenceability and governance. Secondary coverage says outputs are checked against source
  documents with line-by-line citations. — [BusinessWire (Dec 2025)](https://www.businesswire.com/news/home/20251210210198/en) [primary]; [pulse.bot](https://www.pulse.bot/ai/news/gleans-ai-platform-leverages-enterprise-data-to-power-models-and-agents-946e65c2-e52f-4348-97f6-b7cd38ef7210/) [secondary]
- **Palantir AIP** agents read typed, permission-filtered ontology objects and act only through the same "action types" human
  operators use, so their changes are validated and logged the same way. Analysts frame AIP as governance, cost attribution and
  auditability, not a model wrapper. No Palantir primary doc was retrieved. — [Yahoo Finance](https://finance.yahoo.com/markets/stocks/articles/why-palantir-pltr-remains-standout-170653205.html) [secondary/analyst]

**Coding swarms: Devin, Factory**
- **Devin** bills in ACUs (agent compute units). Reported prices: about $2.25 per ACU pay-as-you-go from a $20 entry tier, or
  $2.00 per ACU in a $500/250-ACU Team plan. About 15 minutes of active work per ACU. Tier lists conflict across sources. —
  [usagebar](https://usagebar.com/blog/devin-pricing-and-rate-limits); [usecarly](https://www.usecarly.com/blog/devin-pricing) [secondary, conflicting, may be outdated]
- Devin's managed child sessions have per-child ACU limits; Devin Review catches about 2 bugs per PR. (coord. note) —
  [Cognition](https://cognition.com/blog/multi-agents-working) [primary]
- **Factory** (Droids) raised $200M at a $5B valuation (2026). Self-serve Pro $20, Max $200, with sales-quoted
  Business/Enterprise. "Teams" was renamed "Business" in July 2026, moving audit logging down a tier. — [techfundingnews](https://techfundingnews.com/factory-jumps-to-5b-in-5-months-with-200m-for-its-ai-droids/); [usagepricing](https://usagepricing.com/blueprint/activity/factory-2026-07-22-packaging) [secondary]

**General "super agents": Manus, Genspark**
- **Manus Wide Research** (July/August 2025) runs **up to 100 sub-agents in parallel, each a full Manus instance with its own
  VM**. Reviews say wide jobs "use many credits and break when domains block the bot". — [implicator.ai](https://www.implicator.ai/manus-unleashes-100-agent-swarms-challenging-openais-deep-learning-model/); [aitoolsradar](https://aitoolsradar.org/blog/reviews/manus-ai-review-2026/) [secondary]
- Meta announced the acquisition of Manus in December 2025 for more than $2B (per WSJ). **Its status is disputed**: one source
  says China blocked it in late April 2026, another says it closed early in 2026. A headline also claims a $450M run rate
  "amid Meta deal fallout". — [TechRadar](https://www.techradar.com/pro/meta-buys-manus-for-usd2-billion-to-power-high-stakes-ai-agent-race); [oracore](https://oracore.dev/en/news/manus-450m-run-rate-meta-deal-fallout-en) [secondary, conflicting]
- **Genspark** Super Agent: $10M ARR 9 days after launch and $36M by about 45 days (a Claude case study). The company reports
  about $250M ARR by June 2026. Valuation reports conflict ($1.6B or $2.6B). — [casestudies.com (Claude)](https://www.casestudies.com/company/claude/case-study/genspark-builds-the-future-of-ai-agents-with-claude); [BusinessWire](https://www.businesswire.com/news/home/20260617758937/en/) [vendor claim]

**Business agent builders: Lindy, Relevance AI**
- **Relevance AI** has split billing since September 2025: **Actions** (agent work) and **Vendor Credits** (model cost). Its
  public pricing page now shows only Enterprise. Its "workforce" model is narrow single-job agents handing off to each other. —
  [11x guide](https://www.11x.ai/guides/relevance-ai-pricing); [eesel](https://www.eesel.ai/blog/lindy-vs-relevance-ai) [secondary]
- **Lindy** uses credit billing. Plan prices conflict: $29.99 per user for 3,000 credits, $49.99 for 5,000, or $99.99 Pro. Some
  of these sources are competitor-authored. — [hackceleration](https://hackceleration.com/labs/lindy-pricing) [secondary, conflicting]

**Customer service: Sierra**
- Sierra raised $950M at about a $15.8B valuation in May 2026; ARR is reported as $150M or $200M. It uses **outcome-based
  pricing** with the per-resolution rate and the definition of "success" negotiated per contract. Third-party estimates run
  about $1-2.50 per resolution. What counts as a "resolution" is the main point of dispute. — [doolpa](https://doolpa.com/news/sierra-950m-series-e-15-8b-valuation-bret-taylor-may-4-2026); [featurebase](https://www.featurebase.app/blog/sierra-ai-pricing); [fin.ai (competitor)](https://fin.ai/learn/sierra-ai-pricing) [secondary]

### Inferences
- **What high-stakes buyers pay for is provenance plus permissions**, not parallelism:
  - Hebbia's question-by-document grid.
  - AlphaSense's and Glean's clickable or line-level citations.
  - Palantir's "agents act only through the human action types".
  - Harvey's rubric benchmark.

  A harness that makes evidence a typed object (claim, source span, verification status) carries the products' core value
  into a general tool.
- **The matrix pattern is the proven swarm shape for research.** The same agent runs over N items × M questions with per-cell
  provenance (Hebbia Matrix, Manus Wide Research, Parallel Task API batch enrichment). It is easy to verify cell by cell and
  easy to cost.
- **Rubric benchmarks are becoming the accuracy currency** (Harvey LAB, Anthropic Outcomes rubrics). Rubric-per-task is the
  same object the harness's done criteria already resembles.
- **Pricing per unit of work** (ACU, task, action, resolution) means buyers think in cost per deliverable. A harness should
  report cost that way.

### Gaps
- **No independent accuracy figures** were found for Harvey, Hebbia, AlphaSense, Glean or Palantir agents. LAB leaderboard
  results were not yet public in the sources found.
- **No primary pricing** was found for Harvey, Hebbia, AlphaSense, Glean or Palantir AIP, or any per-investigation or per-report
  price.
- **Unresolved:** Manus deal status. Devin, Factory, Lindy and Manus plan prices conflict across aggregators (check the
  vendors' pricing pages).
- **Not found:** Sierra's τ-bench (tau-bench) and agent benchmark data.

---

## 3. Interop and infrastructure: A2A, MCP, registries, durable execution, sandboxes, browsers, search, observability

### Takeaway
The supporting stack has matured and consolidated in 2026:
- **Durable execution:** Temporal is GA with the OpenAI SDK; Pydantic AI supports four engines.
- **Registries:** cloud registries (AWS and Google) are GA and validate MCP servers and A2A Agent Cards. The official MCP
  Registry is still described as a preview.
- **Observability and search:** Langfuse was bought by ClickHouse and Tavily by Nebius. OpenTelemetry GenAI agent spans are
  still in "Development" status.

### Cited Findings

**Interop: A2A, MCP, registries**
- **A2A**: v1.0 in March 2026 (signed Agent Cards, multi-protocol bindings, version negotiation). It joined the Agentic AI
  Foundation alongside MCP on 2026-08-17. 150+ organisations; integrated in Azure AI Foundry, Copilot Studio and Bedrock
  AgentCore. Task states include `input-required` and `auth-required`. Planning, verification and budgets are left to each
  agent. (coord. note) — [A2A spec](https://a2a-protocol.org/latest/specification/); [AAIF](https://aaif.io/blog/a2a-joins-aaif) [primary]
- **MCP Registry**: the official registry's preview launched on 2025-09-08, backed by Anthropic, GitHub, PulseMCP and Microsoft.
  No GA date was found; guides still warn of breaking changes and data resets. — [InfoQ](https://infoq.com/news/2025/09/introducing-mcp-registry) [secondary, older]
- **AWS Agent Registry** went from preview in April 2026 to **GA on 2026-08-31**. It governs MCP servers (validated against the
  MCP schema), agents (validated against the A2A AgentCard schema) and skills; the preview namespace ended 2026-10-30. **Google
  Cloud Agent Registry** went GA on 2026-06-18. **AGNTCY Agent Directory Service** (distributed, cryptographically verified
  discovery) has no GA status found. — [dev.to (AWS builders)](https://dev.to/aws-builders/aws-agent-registry-a-private-catalog-to-stop-agent-sprawl-c91) [secondary]; [Google Cloud release notes](https://docs.cloud.google.com/agent-registry/release-notes?hl=fr) [primary]; [emergentmind](https://www.emergentmind.com/topics/agntcy-agent-directory-service) [low confidence]

**Durable execution**
- **Temporal**: the OpenAI Agents SDK integration (Python) went GA on 2026-03-23. Temporal's docs have recipes for the OpenAI
  Agents SDK, Vercel AI SDK, Google ADK, Strands and MCP. A $300M Series D at $5B (February 2026, a16z lead) is reported. —
  [Temporal](https://temporal.io/blog/announcing-openai-agents-sdk-partnership) [primary]; [beri.net](https://www.beri.net/tools/temporal) [secondary]
- **Inngest** checkpoints each step and replays finished steps after a failure; it is event-first and JavaScript-friendly.
  **Restate** journals each `ctx.run()` before executing it, and serialises all handler calls on a "virtual object" by key (for
  example, a session ID). — [spheron](https://www.spheron.network/blog/ai-agent-workflow-orchestration-temporal-inngest-restate-gpu-cloud/); [noqta](https://www.noqta.tn/blog/durable-execution-ai-agents-inngest-trigger-temporal-2026) [secondary]
- **Pydantic AI** supports Temporal, DBOS, Prefect and Restate (section 1). — [Pydantic docs](https://pydantic.dev/docs/ai/integrations/durable_execution/overview/index.md) [primary]

**Sandboxes**
- **E2B**: $21M Series A (July 2025, Insight Partners), $35M total; the free Hobby tier gives 100 sandbox-hours a month.
  **Daytona**: $24M Series A (2026-02-05, FirstMark). **Modal**: about $693M disclosed, from a ranking site with no primary
  source. No published sandbox volumes for any vendor. A cost analysis argues idle time, not cold start, drives the bill. —
  [geo.sig.ai](https://geo.sig.ai/brands/e2b.md); [Seedtable](https://seedtable.com/companies/daytona/funding-rounds/series-a-2026-02); [startuphub](https://www.startuphub.ai/startup-categories/agent-sandboxing); [beri.net](https://www.beri.net/article/e2b-vs-modal-vs-daytona-agent-sandbox-pricing-isolation-2026) [secondary]

**Browser infrastructure**
- **Browserbase**: a $40M Series B at a $300M post-money valuation (June 2025; Notable Capital lead per most sources), with the
  Director no-code product. About 50M sessions in 2025 across 1,000+ customers. A Fetch API launched in Q1 2026 at $1/$4/$7 per
  1,000. No 2026 round was found. — [SiliconANGLE](https://siliconangle.com/2025/06/17/browserbase-reels-40m-browser-automation-tools/) [secondary, older]; [Sacra](https://sacra.com/c/browserbase) [secondary]

**Search, crawl and research APIs**
- **Parallel** Task API prices (USD per 1,000 successful runs; **failed runs are not billed**; billed per run, not per field):

  | Processor | lite | base | core | core2x | pro | ultra | ultra2x | ultra4x | ultra8x |
  |---|---|---|---|---|---|---|---|---|---|
  | Per 1,000 runs | $5 | $10 | $25 | $50 | $100 | $300 | $600 | $1,200 | $2,400 |

  Search API: $1 per 1,000 (turbo/fast) or $5 per 1,000 (basic/advanced), 10 results included.

  — [Parallel pricing](https://docs.parallel.ai/getting-started/pricing) [primary]
- Parallel processor latency, documented / observed p50 / p90. Parallel recommends its Responses API, not the Task API, when a
  caller is waiting. — [Parallel processors](https://docs.parallel.ai/task-api/guides/choose-a-processor) [primary]

  | Processor | Documented | p50 | p90 |
  |---|---|---|---|
  | `lite` | 10 s - 2 min | 45 s | 1.5 min |
  | `pro` | 2 - 10 min | 3.5 min | 7.5 min |
  | `ultra` | 3 - 25 min | 4 min | 10 min |
  | `ultra8x` | 5 min - 2 h | 6.5 min | 11 min |

- Funding and ownership:
  - Parallel: Series B in April 2026, about $230M total. — [keenable](https://select.keenable.ai/r/reported-funding-across-ai-search-providers/rkChwd6DnwZdTqMgkuSUaw) [aggregator]
  - Tavily: $25M earlier ($20M Series A from Insight and Alpha Wave). Parallel's own page says **Nebius completed the
    acquisition of Tavily** in 2026; one outlet gives $275M, unconfirmed. — [Newswire](https://www.newswire.com/news/tavily-raises-25-million-to-power-the-internet-of-agents-22618566) [primary, older]; [parallel.ai (competitor)](https://parallel.ai/articles/tavily-alternatives) [secondary]
  - Exa: about $250M disclosed (aggregator; may be one round, not a total). — [keenable](https://select.keenable.ai/r/reported-funding-across-ai-search-providers/rkChwd6DnwZdTqMgkuSUaw) [aggregator]
  - Firecrawl: no funding data found.
- Market split: search APIs (Brave, Exa, Tavily), scrape/crawl (Firecrawl, Crawl4AI) and deep-research APIs (Parallel,
  Perplexity Sonar). On the Artificial Analysis Search Index, Parallel advanced scores 75 and Exa auto 74 (Parallel-authored
  comparison). — [findskill](https://findskill.ai/blog/web-infrastructure-for-ai-agents-parallel-vs-exa-tavily-brave/); [parallel.ai](https://parallel.ai/articles/exa-alternatives) [secondary/vendor]

**Observability**
- **OpenTelemetry GenAI agent spans**:
  - **Shape.** The operation is `invoke_agent`; the span name is `invoke_agent {agent_name}`; the kind is CLIENT (INTERNAL in
    some cases). Child spans alternate `chat` and `execute_tool`. The tool duration metric carries the tool name and
    `error.type`.
  - **Status.** The GenAI and MCP conventions were still in **Development** status in May 2026. One source says they moved to a
    dedicated `semantic-conventions-genai` repository in June 2026 (v1.42.0).

  — [OpenTelemetry spec](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans) [primary]; [Greptime](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions); [dash0](https://www.dash0.com/knowledge/opentelemetry-genai-semantic-conventions-explained) [secondary]
- **Langfuse** was acquired by **ClickHouse** (2026-01-16), announced with ClickHouse's $400M Series D at a $15B valuation.
  There are no immediate product changes and the core stays MIT and self-hostable. — [Langfuse](https://langfuse.com/blog/joining-clickhouse) [primary]; [SiliconANGLE](https://siliconangle.com/2026/01/16/database-maker-clickhouse-raises-400m-acquires-ai-observability-startup-langfuse/) [secondary]
- **LangChain State of Agent Engineering** (1,300+ respondents, November-December 2025):
  - **Tracing:** 89% have some agent observability and 62% detailed step and tool tracing.
  - **Evaluations:** only **52.4% run offline evaluations and 37.3% online evaluations**.

  — [LangChain](https://langchain.com/state-of-agent-engineering) [primary survey]; [KDnuggets](https://www.kdnuggets.com/the-state-of-agent-engineering-report-overview) [secondary]

### Inferences
- **A2A is now the safe bet for "my team as a remote agent".** It is under AAIF beside MCP, and the AWS and Google registries
  validate Agent Cards. The harness already exposes agents over MCP (`/mcp`), so an A2A front door costs little: an Agent Card
  plus the task lifecycle mapped to harness runs (`input-required` mapped to an approval wait).
- **Tracing is solved; evaluation is the gap.** 89% trace but about half evaluate. OTel GenAI spans give a vendor-neutral export
  target. A harness that emits OTel `invoke_agent`/`execute_tool` spans and ties evaluation results to those traces avoids
  lock-in to LangSmith or Langfuse.
- **Search is a commodity with a price ladder.** Parallel's processor tiers make "research depth" a dial with a price
  ($0.005 to $2.40 per task). The harness can expose depth/effort as a budgeted parameter across search providers.
- **Durable execution is a standard expectation.** Temporal's "checkpoints are not durable execution" argument is vendor-biased
  but names a real distinction: per-call journaling and process independence versus graph-state snapshots.

### Gaps
- **Status unconfirmed:** the official MCP Registry's GA date and AGNTCY's production status.
- **Not found:** sandbox or browser usage volumes from primary sources; Firecrawl, Brave and Jina pricing and funding (not
  fetched); Inngest and Restate primary docs (only secondary comparisons were read).
- **Unchecked:** current LangSmith pricing per trace.

---

## 4. Pricing and cost evidence: what swarm runs cost in practice

### Takeaway
Hard numbers exist only for building blocks:
- **Tokens:** multi-agent runs use about 15x chat tokens (Anthropic); agent teams about 7x.
- **Research tasks:** $0.005 to $2.40 per Parallel task.
- **Deep research:** $10/$40 per million tokens for o3-deep-research.
- **Work units:** Devin ACUs at about $2-2.25 per roughly 15 minutes of work.
- **Long runs:** one documented long swarm, the Claude C compiler, cost just under $20,000.

No high-stakes vendor publishes a cost per investigation. Runaway-cost stories are common but mostly unverified.

### Cited Findings
- **Anthropic research system.** Agents use about 4x the tokens of chat and multi-agent systems about 15x. Token usage alone
  explained 80% of BrowseComp performance variance. (coord. note) — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) [primary, older]
- **Claude Code teams and workflows.** Agent teams use about 7x the tokens of a standard session (teammates in plan mode).
  Workflows warn past 25 agents or **1.5M projected tokens**. (coord. note) — [Claude Code costs](https://code.claude.com/docs/en/costs); [workflows](https://code.claude.com/docs/en/workflows) [primary]
- **C compiler swarm.** 16 parallel Opus 4.6 agents, about 2,000 sessions, 2B input and 140M output tokens, **just under
  $20,000**. (coord. note) — [Anthropic](https://www.anthropic.com/engineering/building-c-compiler) [primary]
- **Research API per task.** Parallel Task API from $0.005 (lite) to $2.40 (ultra8x); ultra is $0.30 per task; failed runs are
  free. — [Parallel pricing](https://docs.parallel.ai/getting-started/pricing) [primary]
- **OpenAI deep research.** `o3-deep-research` is $10 input / $40 output per million tokens ($2.50 cached input), and it always
  uses web search, billed on top. A third-party estimate puts a typical report at about $1.45 (about 50K input, 20K output, 15
  searches) or about $0.41 with `o4-mini-deep-research` ($2/$8). The estimate rests on assumptions. — [OpenAI model page](https://developers.openai.com/api/docs/models/o3-deep-research) [primary]; [tokencost](https://tokencost.app/blog/openai-deep-research-api-pricing) [secondary estimate]
- **Coding agent.** Devin is about $2.00-2.25 per ACU, about 15 minutes of active work each. — [usagebar](https://usagebar.com/blog/devin-pricing-and-rate-limits) [secondary, conflicting]
- **Customer-service outcomes.** Sierra is about $1-2.50 per resolution (estimates; contracts negotiated). — [featurebase](https://www.featurebase.app/blog/sierra-ai-pricing) [secondary]
- **Verification overhead.** Each Managed Agents outcome evaluation reports its own usage; the docs example is 2,400 input and
  350 output tokens per grading pass. "1.5-3x base run cost" for outcome-driven sessions is unverified. — [Claude docs](https://platform.claude.com/docs/en/managed-agents/define-outcomes) [primary]; [findskill](https://findskill.ai/blog/claude-outcomes-rubric-grading/) [secondary]
- **Runaway-cost anecdotes.** $48k of GPT-4o in 14 hours from one session; a "$47k token blowout" from a synchronisation bug;
  a code-review agent growing from 2K to 120K tokens; Reddit reports of 70-120x cost spikes; reliability from 80% to 99.9%
  "roughly triples spend". None was independently verified. Bounding trajectories reportedly cut cost by 28.6-44.1% (arXiv
  2509.23586, not read directly). — [getunblocked](https://getunblocked.com/blog/why-ai-agents-burn-tokens/); [thecodeforge](https://thecodeforge.io/ml-ai/multi-agent-systems-explained/); [getreadyforagents](https://www.getreadyforagents.com/blog/agent-cost-runaway-detection-token-enforcement-production/) [secondary, anecdotal]
- **Counter-evidence.** In the CODS 2025 AssetOpsBench challenge, single-agent runs used about 2x the tokens of multi-agent runs
  on average (because of the scenario mix), though multi-agent runs had higher wall-clock latency. — [arXiv 2605.08518](https://arxiv.org/pdf/2605.08518) [primary]
- **Manus credits.** Plan prices conflict (for example $39/3,900 credits, or $199/19,900 credits); wide jobs consume many
  credits. — [aitoolsradar](https://aitoolsradar.org/blog/reviews/manus-ai-review-2026/) [secondary, conflicting]

### Inferences
- **Token cost per job ranges from cents to tens of thousands of dollars:**
  - About $0.30-2.40 per deep task (API).
  - About $1-2 per deep-research report (estimated).
  - Tens of dollars for an hours-long coding agent (several ACUs).
  - About $20k for a weeks-long, 2,000-session swarm.

  High-stakes buyers need **pre-run estimates and caps in money**, not turns.
- **Verification has a measurable, modest cost.** A grading pass of a few thousand tokens is small next to the work it checks.
  The case for rubric grading on every deliverable is economic as well as about quality.
- **Cost evidence is mixed** (Anthropic 15x versus AssetOpsBench). The harness should measure cost per verified deliverable for
  single-agent and multi-agent configurations rather than assume either.

### Gaps
- **Not found:**
  - Any vendor-published cost per legal matter, diligence report or investigation (Harvey, Hebbia, AlphaSense, Palantir).
  - Primary pricing for Manus, Genspark or Lindy (the aggregators conflict).
  - Any independent measurement of what fraction of agent spend is wasted (loops, retries).

---

## 5. Gaps: what users complain about, and capabilities that would make a harness clearly better for high-stakes swarms

### Takeaway
The complaints are consistent:
- **Quality and reliability**, the top barrier at 32% (LangChain).
- **Cost escalation and unclear value** (Gartner: more than 40% of agentic projects cancelled by the end of 2027).
- **Opaque runs and no evaluation** (half of teams run none).
- **Unverifiable outputs** (users re-checking every Hebbia citation; Harvey outputs needing partner review).
- **Fragile multi-agent coordination**: errors amplified 17.2x with independent agents; parallel writers failing.

Nobody combines claim-level evidence, rubric verification, money budgets with forecasting, durable resume and steerable
runs in one open harness. That combination is the "extremely high value" position.

### Cited Findings
- **Gartner** [analyst, older, June 2025 forecast]: more than 40% of agentic AI projects will be cancelled by the end of 2027,
  due to "escalating costs, unclear business value or inadequate risk controls". "Agent washing" is widespread; only about 130
  of thousands of "agentic" vendors are real. — [Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-25-gartner-predicts-over-40-percent-of-agentic-ai-projects-will-be-canceled-by-end-of-2027)
- **LangChain survey** (1,300+ respondents, late 2025): 57% have agents in production. **Quality is the top barrier (32%)**,
  then latency (20%); cost is a falling concern. Observability 89%, offline evaluations 52.4%, online evaluations 37.3%. —
  [LangChain](https://langchain.com/state-of-agent-engineering); [nocode.tech](https://www.nocode.tech/article/langchain-report-quality-not-cost-killing-ai-agents) [primary survey / secondary]
- **MAST** (1,600+ traces, 7 frameworks): 14 failure modes in three groups, one of them **task verification**. Gains over single
  agents are "often minimal". (coord. note) — [arXiv 2503.13657](https://arxiv.org/abs/2503.13657) [primary, older]
- **Google scaling study**: independent agents amplified errors **17.2x** against 4.4x with an orchestrator acting as a
  validation bottleneck. Multi-agent setups lost 39-70% on sequential planning. (coord. note) — [Google Research](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/) [primary]
- **Cognition (2026-04)**: what still fails is parallel writers making conflicting implicit decisions, children assuming shared
  state, and sub-agents not reliably reporting discoveries back. What works is a clean-context review agent. (coord. note) —
  [Cognition](https://cognition.com/blog/multi-agents-working) [primary]
- **Magentic-One**: removing its ledgers cut GAIA performance by 31%. Top failure codes were persistent inefficient actions and
  **insufficient verification steps**. (coord. note) — [arXiv 2411.04468](https://arxiv.org/html/2411.04468v1) [primary, older]
- **Anthropic research system**: human testers found agents preferring SEO content farms over authoritative sources; a separate
  CitationAgent maps claims to sources. (coord. note) — [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) [primary, older]
- **Anthropic verification guidance**: verifiers declare "early victory" after one or two tests. (coord. note) — [Claude blog](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) [primary]
- **Grounding distrust in finance**: users say Hebbia "cannot be treated as an absolute source of truth without manually checking
  the cited passages". — [vantaige](https://vantaige.io/fr/ai-tool/hebbia) [secondary]
- **Managed Agents limits for regulated work**: not ZDR- or HIPAA-eligible, and transcripts persist until deleted. Grader
  reasoning is opaque (heartbeats only). — [Claude docs](https://platform.claude.com/docs/en/managed-agents/define-outcomes) [primary]
- **LangGraph licensing friction**: the self-hosted Agent Server is ELv2 and needs a LangSmith key. — [Geekflare](https://geekflare.com/open-source/langgraph/) [secondary]
- **Framework churn**: Swarm deprecated, AutoGen and Semantic Kernel in maintenance, langgraph-supervisor archived, Mastra
  networks deprecated. — [respan](https://www.respan.ai/articles/is-openai-swarm-still-worth-using); [Mastra](https://mastra.ai/docs/agents/networks); [GitHub](https://github.com/langchain-ai/langgraph-supervisor-py) [primary/secondary]
- **Practitioner cost mitigations**: per-agent and per-run token ceilings, rate-based circuit breakers (one caught a loop within
  60 s), bounded retries. — [getreadyforagents](https://www.getreadyforagents.com/blog/agent-cost-runaway-detection-token-enforcement-production/) [secondary]

### Inferences
**Gaps nobody fills well** (from the evidence across sections 1-4):
1. **Claim-level evidence as a runtime object.** Products show citations (Hebbia, AlphaSense, Glean, Harvey); frameworks have
   nothing typed for "claim → source span → verified, refuted or unverifiable". Anthropic's CitationAgent and Claude Code's
   claim voting are patterns, not a portable primitive.
2. **Verification with honest results.** Outcomes reports satisfied, needs revision or failed for the whole deliverable, but not
   per-claim "could not be verified". It does not calibrate graders against humans, and it is cloud-only and not ZDR.
3. **Budgets in money, before and during the run.** Most frameworks cap turns or iterations. Only the Claude Agent SDK and
   Managed Agents cap USD, and none found forecasts cost before launch beyond Claude workflows' advisory warning.
4. **Durable resume across crashes, provider outages and usage limits** without adopting Temporal. This is weakest in
   TypeScript.
5. **Steerable, inspectable long runs.** Synchronous leads cannot steer subagents mid-run (Anthropic). Grader reasoning is
   opaque. Half of teams cannot tell whether a run was good (no evaluations).
6. **Cross-model checking.** No framework uses disagreement between models from different providers as a verification signal,
   although multi-provider support is common.

### Gaps
- **Not found:**
  - A rigorous, independent user survey specifically about multi-agent or swarm complaints; the evidence here is general
    agent surveys plus anecdotes.
  - Any public data on how often high-stakes outputs (legal, finance) fail human review in production.

### Ranked features worth building into the harness (inference, ranked by value for high-stakes swarms)

The harness already has sessions, sub-agents with harness-run done criteria, a clean-context verifier, teams with reviewers,
MCP client and server, workflows and graphs, multiple providers and a desktop app. Ranked additions:

1. **Evidence ledger (claims → sources → verification state).**
   - **What.** A typed store per run. Each claim in a deliverable links to source spans: URL or document, page or paragraph,
     quote, content hash, fetch time and the agent that found it.
   - **Verification.** A citation verifier re-fetches each source and checks quote and entailment in a clean context, then marks
     the claim verified, refuted or unverifiable (unverifiable is not refuted).
   - **Surfaces.** The desktop shows claims inline with a click-through to the source; export carries the ledger.
   - **Why first.** This is what Harvey, Hebbia, AlphaSense and Glean sell, and no framework has it.
2. **Rubric outcomes with per-criterion results, multi-grader voting and calibration.**
   - **Base.** Extend done criteria into Outcomes-style rubrics: per-criterion pass, fail or unverifiable, `max_iterations`,
     typed terminal states including `failed` when the rubric does not fit. Graders run in a clean context.
   - **Beyond Outcomes.** N independent graders (optionally on different providers) with agreement shown. A rubric bootstrapped
     from a known-good example. Grader agreement tracked against the person's own accept/reject decisions.
   - **Why.** Directly attacks the top barrier (quality) and the "early victory" verifier failure.
3. **Money budgets with pre-run forecast and live circuit breakers.**
   - **Forecast.** An estimate (agents × expected tokens × model price, plus tool fees) shown with the plan for approval.
   - **Budgets.** Hierarchical: run, then team, then agent, then tool.
   - **Breakers.** A burn-rate breaker (loop or repeat detection) and pause-at-budget with resume (as Managed Agents does).
   - **Reporting.** Cost per verified deliverable.
   - **Why.** Answers Gartner's "escalating costs" and the runaway anecdotes.
4. **Matrix / wide fan-out primitive.**
   - **What.** The same agent or brief over N items × M questions, with a per-cell schema, per-cell provenance (#1), per-cell
     retry and stall restart, per-cell cost, and a grid view in the desktop with re-run of failed cells.
   - **Why.** The proven research-swarm shape (Hebbia Matrix, Manus Wide Research, Parallel batch tasks). It is easy to verify
     and to cost.
5. **Durable, journaled execution.** Journal every model and tool call. Resume after a crash, a provider outage or a usage limit
   by replaying finished calls (as Claude workflow replay does). Use idempotency keys for side-effecting tools. Make Temporal,
   Inngest or Restate an optional backend, not a requirement. This closes the TypeScript durability gap and makes hours-long
   swarms safe.
6. **Progress ledger and stall/loop detection as a runtime service.**
   - **Ledger.** A Magentic-One-style check each round: satisfied? looping? progressing?
   - **Detection.** A stall counter leading to replan or reset with a cap, plus repetitive-handoff detection.
   - **Visibility.** Surfaced as events and in the UI.
   - **Why.** The ledgers were worth 31% on GAIA, and stall detection catches cost loops early.
7. **Steering and approval for live runs.**
   - **Approval.** A plan-review gate (approve or revise) before fan-out, plus an approval queue that shows context, cost so far
     and evidence.
   - **Steering.** Message any running agent mid-task.
   - **Escalation.** Automatic escalation to a person on grader disagreement, low evidence coverage or budget thresholds. A2A
     `input-required` maps naturally onto it.
8. **Run explorer with OTel GenAI export and run diffing.**
   - **Explorer.** A trace tree (`invoke_agent` / `chat` / `execute_tool`) with tokens, cost and latency per node, exported as
     OTel GenAI spans (Langfuse, LangSmith or any collector).
   - **Debugging.** Diff two runs. Replay one node with a different model or prompt.
9. **Cross-provider disagreement checks.** Run critical sub-questions on two providers' models and treat disagreement as a
   trigger for deeper verification or human review. This turns the harness's multi-provider support into a reliability feature
   no single-vendor SDK can match.
10. **Evaluation suites built from past runs.**
    - **What.** Promote a run's task, rubric and accepted output into a regression set, then re-run it when a model, prompt or
      agent changes.
    - **Format.** LAB-style task, documents and rubric.
    - **Why.** Addresses the "89% trace, ~50% evaluate" gap.
11. **Source-quality policy for search and crawl.** One interface over providers (Parallel, Exa, Brave, Firecrawl, Tavily) with:
    - a depth/price dial (Parallel's tiers as a model);
    - domain allow and deny lists and authority scoring (Anthropic's SEO-farm finding);
    - caching and deduplication;
    - fetch timestamps fed into the evidence ledger.
12. **A2A front door and client.** Publish a team as an A2A agent (signed Agent Card; task lifecycle onto harness runs) and call
    remote A2A agents as team members. This makes harness teams listable in AWS and Google agent registries. Low cost given the
    existing `/mcp` server.
13. **Pluggable isolation per writer.** Worktree, container or remote sandbox (E2B, Daytona, Modal) per writer agent, merged by
    git or reviewer. This is the proven fix for parallel-writer conflicts. Ranked lower only because read-heavy research swarms
    need it less.
14. **Shared memory and consolidation.** Letta-style shared memory blocks and a background consolidation agent ("sleep-time" or
    "dreaming") for long-lived teams. Useful, but lower value for high-stakes correctness than items 1-10.
