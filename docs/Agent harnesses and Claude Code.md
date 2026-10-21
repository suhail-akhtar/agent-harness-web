# How harnesses turn models into agents

An agent harness is **everything around a language model that is not the model**: the loop that calls it, the tools it can use and the code that runs them, the management of what goes into its context window, memory files, sub-agents, permission rules, sandboxes and lifecycle hooks. LangChain sums this up as "Agent = Model + Harness" ([LangChain](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)). Anthropic's Claude Code docs use the term "agentic harness" for the layer that provides tools and manages context around the loop ([Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works)).

As of October 2026 the leading designs have converged. The core is **a single loop in which the model decides the next step**. Around it sit deterministic controls (permission rules, hooks, OS sandboxes) and a set of mechanisms for keeping the context window small (compaction, sub-agents with their own contexts, deferred tool loading).

The evidence that the harness matters is strong but uneven. A controlled October 2026 study found that the **same two models swap places by up to about 38 points depending on the harness** ([arXiv 2610.00917](https://arxiv.org/abs/2610.00917)). Many of the headline numbers, however, are reported by vendors about their own products.

Web and cloud harnesses run that same loop inside a disposable, vendor-hosted VM. They differ from local harnesses mainly in **where tools execute and who holds the credentials**, not in how the agent thinks.

Node-graph frameworks (LangGraph, Microsoft Agent Framework, Google ADK 2.0) are a different layer, not a rival to the loop. They provide durable, checkpointed orchestration, and increasingly they **embed agent loops as nodes**.

Claude Code is closed-source but documented in unusual detail. Its CLI, Agent SDK, Desktop Code tab and web sessions run one engine, and Anthropic says "the underlying agentic loop is identical" on every surface. Several things are not public: the system prompt text, the cloud hypervisor, how the Desktop app embeds the engine, and any server-side scheduler. Claims drawn from the March 2026 source-map leak remain unofficial.

*How to read the evidence in this report.* "Documented" means a primary vendor page or paper that is cited. "Vendor-reported" means a figure a company publishes about its own product. "Secondary" means press or blogs. "Unofficial" means leaks, reverse engineering or informal comments. "Inference" means my own reading of the sources. The underlying research could not fetch openai.com pages (HTTP 403), so every OpenAI launch-post detail here comes from summaries. No benchmark leaderboard row was checked directly.

## "Everything that is not the model": the anatomy of a 2026 harness

### Three vocabularies for one idea

The term has no standard definition, but three generations of vocabulary describe the same thing.

**2024: "scaffolds" and the agent-computer interface (ACI).** SWE-agent called language-model agents "a new category of end users" that need "specially-built interfaces" ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793)). Anthropic told builders to "carefully craft your agent-computer interface" ([Anthropic, Dec 2024](https://www.anthropic.com/engineering/building-effective-agents)).

**2025: "harness".** Anthropic began calling the Claude Agent SDK "a powerful, general-purpose agent harness" ([Anthropic, Nov 2025](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).

**2026: "harness engineering" as a discipline.** OpenAI's February 2026 post described engineers shifting from writing code to "designing environments, specifying intent, and providing structured feedback" ([InfoQ](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex); [OpenAI](https://openai.com/index/harness-engineering/), summary only). LangChain's definition is the broadest in use: "A harness is every piece of code, configuration, and execution logic that isn't the model itself." It lists the components as system prompts; tools, skills and MCP servers; a filesystem, sandbox and browser; orchestration such as sub-agent spawning and model routing; and hooks or middleware for deterministic steps such as compaction and lint checks ([LangChain, Mar 2026](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)). Secondary explainers note that "harness", "framework" and "scaffold" are still used interchangeably ([Arize](https://arize.com/blog/what-is-an-agent-harness/)). I found no canonical lab definition of "agent runtime".

### Each component answers a known failure

**The loop.** In Anthropic's documented loop, the model receives the system prompt, tool definitions and history. It replies with text and/or tool calls, the harness executes those calls and returns the results, and this repeats until a reply contains no tool calls ([Agent loop docs](https://code.claude.com/docs/en/agent-sdk/agent-loop)).

**Tools.** Tools are treated as an interface to design. On SWE-bench, Anthropic "spent more time optimizing our tools than the overall prompt", for example by requiring absolute file paths after the model kept making relative-path errors ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

**Context engineering.** Anthropic defines this as "curating and maintaining the optimal set of tokens", and treats the context window as an attention budget that degrades as it fills ("context rot"). The remedies it lists are compaction, clearing old tool results, structured note-taking, sub-agents, and just-in-time retrieval through file paths and queries. A sub-agent can spend "tens of thousands of tokens" exploring but returns a summary of "often 1,000–2,000 tokens" ([Anthropic, Sep 2025](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).

**Cost and the cache.** Manus calls the KV-cache hit rate "the single most important metric for a production-stage AI agent." Its input-to-output token ratio is about 100:1, and cached input on Claude Sonnet costs $0.30 per million tokens against $3 uncached ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)). Several of its practices follow from that. It keeps a stable prompt prefix and an append-only history. It masks unavailable tools rather than removing them, because removing them breaks the cache. It keeps a `todo.md` that the agent rewrites to hold its attention on the goal. It leaves failed actions in the context, because "erasing failure removes evidence."

Secondary summaries of OpenAI's Codex loop post report two related choices. Codex resends the full conversation each turn to stay stateless (which supports Zero Data Retention). It also orders the prompt so that caching turns the cost of a long session from quadratic in the number of turns into linear ([InfoQ](https://www.infoq.com/news/2026/02/codex-agent-loop); [ZenML](https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design)).

**Long-running work.** Anthropic's harness for long tasks pairs an **initializer agent** with a **coding agent**. The initializer writes an `init.sh` script, a progress log, a first git commit and a JSON list of more than 200 features, all marked failing. The coding agent then works on one feature per session and may change only each feature's `passes` field. JSON was chosen because the model is less likely to rewrite it improperly than Markdown ([Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). The design targets four named failures: declaring the task done too early, leaving progress undocumented, marking features done without checking them, and wasting time working out how to run the app.

**Verification.** LangChain found that agents often re-read their own code, judged it fine, and stopped. It added middleware that intercepts the agent before it exits and forces a verification pass ([LangChain](https://blog.langchain.com/improving-deep-agents-with-harness-engineering); vendor's own account).

*Inference.* These patterns serve three goals: keeping the context small and relevant, keeping it cheap through cache-stable prefixes, and keeping long work honest through external state, verification and git checkpoints. None of the primary sources gives quantitative detail on prompt-injection defences inside the loop. I also found no primary data on runaway-loop guards such as iteration caps.

## Same model, different harness: swings of five to thirty-plus points

### The controlled studies

The best controlled evidence is recent. Li et al. (October 2026) ran **66 model-by-harness configurations** across 5 models. The harnesses included OpenHands, PI, openJiuwen, DeepSeek Harness, and the native Codex–GPT and Claude Code–Claude pairings ([arXiv 2610.00917](https://arxiv.org/abs/2610.00917)). The headline results:

- **Claude led GPT by 7.94 points in OpenHands but trailed it by 30.16 points in PI.** The ranking reverses depending on the harness.
- For 4 of the 5 models, the best harness changed from one benchmark to another.
- The vendor's own harness was not reliably the best.
- GPT scored higher under PI than under DeepSeek Harness, at under a quarter of the cost per task.
- openJiuwen gave Kimi, a model prone to malformed tool calls, its best score on all three benchmarks, by 5.61–11.11 points.

The authors' explanation is that models do almost all of their own error repair, so results depend on whether the harness returns failures in a form the model can use. A search summary adds that Claude Code was Claude's best harness on two of the three benchmarks but trailed OpenHands on the terminal benchmark ([arXiv HTML](https://arxiv.org/html/2610.00917v1)). The abstract names that benchmark "Terminal-Bench 4"; I did not verify the label.

A May 2026 position paper goes further. It argues that among models of comparable frontier capability on long tasks, "harness-induced variance can substantially exceed model-induced variance." It calls for papers to disclose their harness and to decompose variance between model and harness ([arXiv 2605.23950](https://arxiv.org/abs/2605.23950)). Its abstract gives no figures.

### The vendor and blog numbers

The most-cited single data point is vendor-reported. LangChain raised its deepagents-cli from **52.8% to 66.5% on Terminal-Bench 2.0 (+13.7 points)** with the model held fixed (gpt-5.2-codex), by changing only the prompt, tools and middleware ([LangChain](https://blog.langchain.com/improving-deep-agents-with-harness-engineering)). LangChain also claims, without figures, that Opus 4.6 scores "well below" its potential in Claude Code ([LangChain](https://www.langchain.com/blog/the-anatomy-of-an-agent-harness)).

A blog citing the Terminal-Bench 2.1 leaderboard reports two native-versus-reference gaps:

| Model | Native harness | Terminus 2 | Gap |
|---|---|---|---|
| GPT-5.5 | 83.1% in Codex | 78.0% | 5.1 points |
| Opus 4.7 | 68.9% in Claude Code | 66.1% | 2.8 points |

Source: [D. Vaughan](https://codex.danielvaughan.com/2026/06/11/terminal-bench-2-1-june-2026-benchmark-landscape-codex-cli-harness-engineering-model-scores/). I did not verify these figures against tbench.ai.

### The counterweight: minimal harnesses

Evidence that minimal harnesses can compete comes from the SWE-agent team itself. **mini-swe-agent's agent class is about 100 lines of Python.** It uses bash only, does not use tool-calling, and runs each action as an independent subprocess. Its maintainers report over 74% on SWE-bench Verified ([GitHub](https://github.com/SWE-agent/mini-swe-agent)). In 2024 the original SWE-agent reached 12.5%, and at the time the elaborate interface was the point ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793)).

*Inference.* Both findings hold at once. As models improve, elaborate tooling adds little on short, well-scoped tasks. The harness still dominates on long, messy terminal work, where error feedback, self-verification and context management decide the outcome. Leaderboards that pair each vendor's model with its own harness cannot separate the two effects. Only same-model comparisons can, and the strongest of those (LangChain's) is self-reported.

## Cloud harnesses run the same loop inside a disposable VM

### The convergent shape

Every major cloud coding agent follows the same design. A vendor-hosted loop drives tools inside a **short-lived VM or container for each task**. The repository is cloned in, a setup script installs dependencies while the network is open, and the agent then works under a tighter network policy. The work comes out as **a branch or pull request for a human to review**. Durable state lives in git, not in the box.

| Product | Where tools run | Environment and persistence | Network and limits | Documented status |
|---|---|---|---|---|
| OpenAI Codex cloud | Isolated sandbox per task | Codex sets up the environment itself, then the user "publishes" it; network and proxy secrets | Legacy: no internet in the agent phase by default; optional allowlist and GET/HEAD/OPTIONS-only mode ([docs](https://learn.chatgpt.com/docs/cloud/internet-access)) | Isolation technology not published; "microVM" is a third-party description |
| GitHub Copilot cloud agent | GitHub Actions ([firewall docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall)) | `copilot-setup-steps.yml` | Firewall covers only the Bash tool's processes; **hard 59-minute session cap** ([about](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)) | Documented |
| Cursor Cloud Agents | "Isolated VMs", or the customer's own machines ([docs](https://cursor.com/docs/cloud-agent)) | Snapshot or Dockerfile; secrets injected at start | Outbound domains can be restricted; Tailscale for private networks | Cloud provider and isolation technology not stated |
| Google Jules | "Short-lived" Ubuntu VM ([docs](https://jules.google/docs/environment/)) | "Run and Snapshot" | 15 / 100 / 300 tasks per day by plan ([limits](https://jules.google/docs/usage-limits/)) | Network policy during the agent phase not found |
| Devin | Fresh copy of the organisation's snapshot each session ([docs](https://docs.devin.ai/onboard-devin/environment/blueprints)) | Snapshot rebuilt about every 24 hours | — | macOS guests on bare-metal EC2 Mac hosts ([blog](https://devin.ai/blog/devin-gets-a-mac)) |
| Claude Code on the web | Fresh Ubuntu 24.04 VM, about 4 vCPU / 16 GB / 30 GB ([docs](https://code.claude.com/docs/en/cloud-environments)) | Setup script snapshot-cached | Network level None, Trusted, Full or Custom; proxies hold credentials | Hypervisor not documented |
| Manus | E2B Firecracker microVM ([E2B](https://www.e2b.dev/blog/how-manus-uses-e2b-to-provide-agents-with-virtual-computers)) | Sessions can last hours | — | Documented by the sandbox vendor |

### Who runs the compute

*Inference.* Three compute models emerge. Most vendors host their own VMs (Codex, Cursor, Jules, Devin, Claude Code). Copilot runs on the customer's CI substrate, GitHub Actions, and so inherits Actions billing and workflow approval. A growing set offers self-hosted executors: Cursor's Self-Hosted Machines, Anthropic's self-hosted environments for Team and Enterprise ([cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)), a "self-hosted sandboxes" heading in the Codex docs (heading only), and Factory's OpenCompute (secondary). Several vendors adding self-hosting suggests that is where enterprise demand is heading; no vendor says so.

Underneath, sandbox-as-a-service providers fall into tiers. E2B and Vercel Sandbox use **Firecracker microVMs**, each with its own kernel ([Vercel](https://vercel.com/docs/vercel-sandbox/concepts)). Modal uses gVisor. Daytona uses containers with optional VM classes. Cloudflare binds containers to Durable Objects for a persistent identity ([Cloudflare](https://developers.cloudflare.com/sandbox/concepts/architecture/)). Secondary comparisons put E2B and Daytona near **$0.05 per vCPU-hour** and say idle time drives the bill more than the rate does ([beri.net](https://www.beri.net/article/e2b-vs-modal-vs-daytona-agent-sandbox-pricing-isolation-2026)). Their cold-start figures conflict badly and are not reliable.

### Security: credentials outside the box

The security model has converged on four controls:

1. An allowlist or default-deny egress firewall while the agent works.
2. Secrets injected at start and kept out of snapshots, increasingly bound to specific hosts.
3. Least-privilege git credentials.
4. Filtering hidden text out of untrusted input.

GitHub's version is the most explicit. Copilot can push only to its own branch. It opens draft PRs that it cannot approve or merge. CI does not run on its code until a human clicks "Approve and run workflows". Hidden characters and HTML comments are stripped from issues ([GitHub](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)).

Every vendor states that these controls reduce risk rather than remove it. GitHub says its firewall "should not be considered a comprehensive security solution", and it excludes MCP servers and setup steps. OpenAI's own documentation gives an example in which a GitHub issue's hidden instruction makes the agent POST the last commit to an outside site ([OpenAI docs](https://learn.chatgpt.com/docs/cloud/internet-access)). Simon Willison's "lethal trifecta" names the structural problem: private data, untrusted content and a channel to the outside, all held by one agent. His example was the May 2025 GitHub MCP exploit, in which an issue in a public repo led an agent to leak data from a private one ([Willison](https://simonwillison.net/2025/May/26/github-mcp-exploited/)).

*Inference.* Setup scripts are the soft spot, because they run with the network open and, on Copilot, outside the firewall.

### Browser and computer-use harnesses

Browser agents split the same way. A **remote browser** (OpenAI's agent, hosted browser services) keeps the user's credentials away from the agent. An **in-browser extension** (Claude in Chrome, Perplexity Comet) acts inside the user's logged-in sessions. Brave showed that hidden page text could make Comet steal credentials and one-time passwords ([The Register](https://www.theregister.com/2025/08/20/perplexity_comet_browser_prompt_injection/)).

### Local versus cloud

| | Cloud harness | Local harness |
|---|---|---|
| Strengths | Parallelism (Jules allows 3 to 60 concurrent tasks by plan); runs while the laptop sleeps ([Codex](https://learn.chatgpt.com/docs/cloud)); mobile and Slack triggers; a smaller blast radius | Direct access to local files, devices, VPN-only services and the user's own sessions |
| Costs and gaps | Setup friction; no direct reach into private resources; time caps; metered cost; vendor custody of code and git tokens | A bad command runs with the developer's own privileges |

Some configuration also does not travel: user-level Cursor hooks do not run in its cloud VMs ([Cursor](https://cursor.com/docs/cloud-agent)).

*Inference.* The local/cloud line is blurring. The deciding questions are now where tools execute and which credentials they can reach, not which UI starts the session. No vendor publishes like-for-like success or latency comparisons between the local and cloud modes of the same product.

## Graph frameworks wrap agent loops rather than replace them

### How the graph runtimes work

Graph frameworks model a workflow as nodes that read and update a shared, typed state, joined by fixed or conditional edges.

In **LangGraph**, a compiled `StateGraph` runs in Pregel-style **super-steps**. Nodes that run in parallel share a super-step. Per-key reducers merge their updates, for example by appending messages. `Send` fans out a variable number of branches, and `Command` combines a state update with routing. A recursion limit (default 1,000 super-steps) stops runaway graphs ([LangGraph docs](https://docs.langchain.com/oss/python/langgraph/graph-api)).

The checkpointer saves state **only at super-step boundaries**, keyed by thread. When a run resumes after `interrupt()`, "the node restarts from the beginning", so side effects before the interrupt "should (ideally) be idempotent" ([interrupts docs](https://docs.langchain.com/oss/python/langgraph/interrupts)). LangGraph 1.0 shipped in October 2025, and LangChain's `create_agent` now runs on it ([LangChain](https://www.langchain.com/blog/langgraph-v1)).

Microsoft's **Agent Framework** succeeds both AutoGen and Semantic Kernel. Its workflows are typed executors connected by edges, with fan-out and fan-in and checkpoints "at superstep boundaries", plus an experimental functional `@workflow` API in plain Python ([MS Learn](https://learn.microsoft.com/en-us/agent-framework/concepts/workflows/)). The framework also ships a separate **"Harness Agent"** with planning, compaction, file access, memory and tool approval built in ([MS Learn](https://learn.microsoft.com/en-us/agent-framework/overview/agent-framework-overview)).

Google's **ADK 2.0** replaced its fixed Sequential, Parallel and Loop agents with graph-based and dynamic workflows. In the Go release, "agents, tools, and functions run as individual nodes" ([Google](https://developers.googleblog.com/why-we-built-adk-20/); [adk-go release](https://newreleases.io/project/github/google/adk-go/release/v2.0.0); some release dates are third-party).

### Graph versus code: a spectrum

The other frameworks vary along one axis: how much of the control flow is declared as a graph and how much is ordinary code.

- **CrewAI Flows** are event-driven (`@start`, `@listen`, `@router`) and orchestrate autonomous "Crews" ([CrewAI](https://docs.crewai.com/en/concepts/flows)).
- **LlamaIndex Workflows** infer edges from type annotations. They rejected explicit DAGs because encoding loops and branches as edges "did not feel natural to developers" ([LlamaIndex](https://developers.llamaindex.ai/python/llamaagents/workflows/)).
- **Pydantic AI's** graph docs warn, "Don't use a nail gun unless you need a nail gun" ([Pydantic](https://pydantic.dev/docs/ai/graph/graph/)).
- **ComfyUI**, a node-graph executor for media pipelines, needed runtime node expansion and tail recursion before it could express loops at all ([ComfyUI](https://docs.comfy.org/development/comfyui-server/execution_model_inversion_guide)).
- **Temporal** takes a different route to durability. It records every LLM call and tool result as it happens, and an OpenAI Agents SDK integration has been available since July 2025 ([Temporal](https://temporal.io/blog/announcing-openai-agents-sdk-integration)).

Two designs show how loop and graph now relate. **OpenAI's Agents SDK does not use graph edges for multi-agent work.** Handoffs "are represented as tools to the LLM", so the model chooses where control goes, inside one run loop ([OpenAI Agents SDK](https://openai.github.io/openai-agents-python/handoffs/)). And **n8n embeds a model-driven loop inside a single "AI Agent" node** of an otherwise deterministic automation graph ([n8n](https://docs.n8n.io/advanced-ai/examples/understand-agents/)).

### The workflows-versus-agents debate

Anthropic's December 2024 vocabulary still frames the debate. Workflows follow "predefined code paths", while agents "dynamically direct their own processes and tool usage". The advice is to find "the simplest solution possible, and only [increase] complexity when needed" ([Anthropic](https://www.anthropic.com/engineering/building-effective-agents)).

The 2025 argument over multi-agent systems sharpened this:

- **Cognition** argued for one thread with continuous context, because "actions carry implicit decisions". In its example, sub-agents building a Flappy Bird clone produced mismatched parts. It also observed that Claude Code's sub-agents rarely run in parallel ([Cognition](https://cognition.com/blog/dont-build-multi-agents)).
- **Anthropic's** orchestrator-worker research system "outperformed single-agent Claude Opus 4 by 90.2%" on an internal evaluation. It used **about 15 times the tokens of a chat**, against about 4 times for a single agent ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). That figure is vendor-reported and internal-only.

*Inference.* The two positions mostly agree. Cognition objects to splitting **write-heavy, tightly coupled** work, such as code whose parts must fit together. Anthropic's gains come from **read-heavy, breadth-first** research. Both recommend model-driven loops for the core reasoning, and neither recommends a fixed node graph.

### When a graph beats a loop

*Inference.* A graph wins when:

- the steps are known in advance;
- a human approval must sit at a fixed point;
- the work fans out into independent pieces;
- runs must survive restarts;
- auditors need an inspectable path.

A loop wins when the path depends on what the agent discovers, as in debugging, coding and exploratory research. It also absorbs model improvements without the graph being redrawn, and its append-only transcript suits prompt caching. That last point is my inference from how caching works; I found no measurement of it. **No independent head-to-head benchmark of graph versus loop exists in the sources.** The industry has settled on a hybrid: a deterministic outer graph whose nodes are agent loops.

**Claude Code and Codex are documented as single loops.** Claude Code's docs describe Claude "chaining dozens of actions together", with each step informed by the last ([Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works)). Codex's loop is described the same way in OpenAI's January 2026 post (known from summaries only). Their graph-like features are all triggered inside the loop: sub-agent spawning by the model, hooks by lifecycle events, plan mode by the user or model. None is a declared graph. Whether any server-side scheduler behind Claude Code on the web or Codex cloud uses a workflow engine is **not public**.

## Claude Code: one closed engine wrapped in deterministic controls

### The documented core

Anthropic's documentation (code.claude.com, versions around v2.1.2xx in October 2026) describes a tool loop. Each cycle is "one turn". Read-only tools such as `Read`, `Glob` and `Grep` can run in parallel, while `Edit`, `Write` and `Bash` run one at a time. Runs can be capped by `maxTurns` and `maxBudgetUsd`, and a run ends with one of a fixed set of result types (`success`, `error_max_turns`, `error_max_budget_usd`, and others) ([Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)).

Anthropic's stated philosophy is "give your agents a computer". The work cycle is gather context, act, verify, repeat. Anthropic prefers agentic search with grep over embeddings, which it calls "less accurate, harder to maintain, and less transparent" ([Claude blog, Sep 2025](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)).

The built-in tool set now reaches well past coding. It includes `Agent`, `Skill`, `ToolSearch`, the `Task*` tools, `Cron*`, `Monitor`, `PushNotification`, `SendMessage` and a `Workflow` tool that "orchestrates many subagents in the background" ([Tools reference](https://code.claude.com/docs/en/tools-reference)).

### The controls around the loop

**Permissions.** There are six permission modes: Manual (default), `acceptEdits`, `plan`, `auto`, `dontAsk` and `bypassPermissions`. In `auto`, "a background classifier checks that they align with your request." Rules are evaluated "deny, then ask, then allow", and specificity does not change that order. The docs are explicit about who enforces them: "Permission rules are enforced by Claude Code, not by the model" ([Permissions](https://code.claude.com/docs/en/permissions)).

**Sandbox.** The OS-level Bash sandbox uses Seatbelt on macOS and bubblewrap plus socat on Linux and WSL2. **It is off by default, and native Windows is unsandboxed.** By default it allows reads of most of the machine, including `~/.ssh`. Network traffic goes through a proxy whose allowlist starts empty. File tools, MCP servers and hooks run outside the sandbox ([Sandboxing](https://code.claude.com/docs/en/sandboxing)). Anthropic reports that sandboxing **cut permission prompts by 84%** in internal use ([Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing)). The runtime is open source ([sandbox-runtime](https://github.com/anthropics/sandbox-runtime)).

**Hooks.** There are about 33 hook events, from `SessionStart` through `PreToolUse`, `PreCompact` and `Stop`. Handlers come in five types: command, http, mcp_tool, prompt and agent. A hook that exits with code 2 blocks the action ([Hooks](https://code.claude.com/docs/en/hooks)).

**Sub-agents.** Sub-agents, launched through the `Agent` tool (renamed from `Task` in v2.1.63), start with a fresh context and return only a summary. By default they can nest 3 levels deep, with up to 20 running at once ([Subagents](https://code.claude.com/docs/en/sub-agents)).

**Skills.** Skills load progressively: only their descriptions sit in context until one is invoked. Custom slash commands have been merged into skills ([Skills](https://code.claude.com/docs/en/skills)).

**MCP.** MCP tool schemas are deferred by default and loaded on demand through `ToolSearch` ([Agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)).

**Memory.** CLAUDE.md files load from managed, user, project and local levels. AGENTS.md is read from v2.1.277, but only when no CLAUDE.md exists. "Auto memory" caps its index at 200 lines or 25 KB per session ([Memory](https://code.claude.com/docs/en/memory)).

**Settings.** Settings resolve in the order managed, then CLI flags, then local project, then shared project, then user ([Settings](https://code.claude.com/docs/en/settings)).

### The Agent SDK

The Agent SDK is not a reimplementation. It is "a library that runs the Claude Code binary", which both the Python and TypeScript SDKs bundle. It was renamed from the Claude Code SDK in September 2025 because the harness "now powers many non-coding agents" ([SDK overview](https://code.claude.com/docs/en/agent-sdk/overview); [Claude blog](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)).

### What the design shows

*Inference.* The architecture deliberately separates **guarantees from steering**. Rules, hooks, the sandbox and managed settings are enforced by code. CLAUDE.md, skills and output styles are context, and the memory docs say Claude "treats them as context, not enforced configuration." Context economy shows up in almost every feature: deferred schemas, progressive skills, isolated sub-agents, memory caps, and budgets for re-attaching recently used skills after compaction. That suggests context-window management is the main design constraint.

### Compared with Codex CLI and Gemini CLI

Against its peers, Claude Code is the least open and the most configurable. Codex CLI separates `sandbox_mode` from `approval_policy` and offers an `auto_review` reviewer agent, which is the same idea as Claude Code's classifier ([Codex docs](https://learn.chatgpt.com/docs/sandboxing)). Gemini CLI is Apache-2.0 licensed and has the widest range of sandbox backends. Google replaced it with Antigravity CLI for unpaid users in June 2026 ([gemini-cli](https://github.com/google-gemini/gemini-cli)).

### Desktop, web and Cowork move the loop and the boundary

Anthropic states that "the underlying agentic loop is identical" across surfaces ([Claude Code docs](https://code.claude.com/docs/en/how-claude-code-works)). What changes from one surface to the next is where tools run and what contains them.

| Surface | Where the model runs | Where tools run | Containment (documented) |
|---|---|---|---|
| Claude Code CLI / Agent SDK | Anthropic cloud | User's machine | Optional Seatbelt/bubblewrap sandbox plus permission rules |
| Desktop app, Code tab | Anthropic cloud | Local, SSH host, WSL, or a cloud VM | Same settings files and modes as the CLI ([Desktop](https://code.claude.com/docs/en/desktop)) |
| Claude Code on the web / `--cloud` | Anthropic cloud | Anthropic-managed Ubuntu VM | VM plus security proxy, GitHub proxy and agent proxy ([cloud environments](https://code.claude.com/docs/en/cloud-environments)) |
| claude.ai code execution | Anthropic cloud | Anthropic server sandbox | gVisor ([via Willison](https://simonwillison.net/2026/May/30/how-we-contain-claude/)) |
| Cowork (Desktop) | Anthropic cloud | Local Linux VM | Apple Virtualization framework / Windows HCS (same source) |
| Remote Control | Anthropic cloud | User's machine | Outbound-only HTTPS, short-lived scoped credentials ([Remote Control](https://code.claude.com/docs/en/remote-control)) |

**The Desktop app.** It has three tabs: Chat, Cowork and Code. It installs local MCP servers as one-click **Desktop Extensions**, ZIP files with a `manifest.json` (renamed from `.dxt` to `.mcpb` in September 2025). The app ships its own Node.js and stores sensitive settings in the OS keychain ([Anthropic](https://www.anthropic.com/engineering/desktop-extensions)). Remote "connectors", by contrast, are called **from Anthropic's cloud, not the user's device, on every client**, so they cannot reach VPN-only servers ([support](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp); search summary).

**The Code tab.** It "reads the same settings files as the CLI". It can isolate parallel sessions in git worktrees. On SSH hosts it "installs a helper program and Claude Code under `~/.claude/remote/`" ([Desktop](https://code.claude.com/docs/en/desktop)).

**Cloud sessions.** Each one gets a fresh VM with toolchains preinstalled. A setup script runs as root, and if it finishes within about 5 minutes the resulting filesystem is snapshotted and reused for up to about 7 days. Idle VMs pause, and a paused VM can be reclaimed. The credential design is the notable part. The git credential inside the VM is a scoped stand-in that the GitHub proxy swaps for the real token. "Network secrets" are added by an agent proxy "after each request leaves the session's VM". The GitHub proxy rejects GraphQL and tag pushes. The docs also concede that even at network level None, the VM can still reach the Anthropic API, "which may allow data to exit the VM" ([cloud environments](https://code.claude.com/docs/en/cloud-environments); [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web)). Teleport pulls a cloud session down into a local terminal.

**Cowork.** Cowork "uses the same agentic architecture that powers Claude Code" for non-coding work ([Cowork docs](https://claude.com/docs/cowork/overview)). Anthropic's product page now says "Claude Cowork is now just Claude".

**Computer use, Dispatch and Chrome.** Computer use and Dispatch arrived in March 2026 ([Claude blog](https://claude.com/blog/dispatch-and-computer-use)). Claude in Chrome reached general availability in August 2026. Its autonomous mode uses "the same mechanism as auto mode in Claude Code", together with probes that scan web content in tool results. Anthropic reports **3.8% attack success for Opus 5 without safeguards**, and none for several current models once the probes and classifier are added ([Claude blog](https://claude.com/blog/claude-in-chrome-generally-available)). Its 2025 pilot figure was 11.2% with mitigations, which Simon Willison called "a catastrophic failure rate" ([Willison](https://simonwillison.net/2025/Aug/26/piloting-claude-for-chrome/)).

*Inference.* Containment strengthens as the user becomes less technical and the agent more autonomous: a process sandbox for developers, a full VM for Cowork. Computer use and Chrome act on the user's real desktop and browser, so they sit outside every sandbox. Their defences are policy and classifiers, not isolation.

## What Anthropic has not published, and what the leak does not prove

### Not documented by Anthropic

Several parts of these harnesses are not documented anywhere I could find:

- **The full system prompt.** The docs describe only its parts: a "full" and a "shorter" prompt, and a coding-instructions section ([Output styles](https://code.claude.com/docs/en/output-styles)).
- **How the Desktop app embeds the engine.** The Desktop docs do not say whether the app bundles the CLI or uses the Agent SDK.
- **The Desktop framework.** That the app is built on **Electron** is widely assumed but unconfirmed.
- **The cloud-session VM technology.** Firecracker, gVisor or something else is not documented; the docs say only "isolated VM".
- **The proxy implementation**, the Cowork VM image, any server-side scheduler or orchestration for cloud sessions, and model routing between surfaces.

### Outside sources and their limits

Outside sources fill some of these gaps only partly. An Anthropic engineer said on Hacker News that Cowork runs the Claude Code harness inside a Linux VM ([HN mirror](https://hn.svelte.dev/item/47218288)). That is an unofficial attribution, although Anthropic's own containment article confirms the full-VM design. A secondhand report says Cowork's VM is Ubuntu 22.04 with bubblewrap inside. I could not trace it to its original source.

The documentation also contradicts itself in places. Anthropic's 2025 sandboxing post said the GitHub proxy ensures "pushes only go to the configured branch". The current docs say the proxy "doesn't limit which branches a push can update". Support pages still call Claude in Chrome "beta" after the general-availability post.

### The March 2026 source-map leak

The leak is documented only as an incident. On 31 March 2026, `@anthropic-ai/claude-code` v2.1.88 shipped to npm with a **59.8 MB source map that exposed more than 512,000 lines of TypeScript**. Anthropic called it "a release packaging issue caused by human error, not a security breach" ([The Hacker News](https://thehackernews.com/2026/04/claude-code-tleaked-via-npm-packaging.html)).

The architecture claims drawn from it are **unofficial**. They include a "query engine", "swarm" orchestration, a "self-healing memory architecture", an unreleased persistent background agent called "KAIROS", "Undercover Mode" and anti-distillation decoy tools. They come from community readings of code, and code in a repository is not the same as a shipped feature. Some documented 2026 features (`PushNotification`, `ScheduleWakeup`, `Monitor`) resemble the KAIROS descriptions, but no source connects them. The incident also produced malware: fake "leaked Claude Code" repositories carried malicious code (same source).

The public GitHub repository holds plugins, examples and a changelog under "All rights reserved", not the engine ([LICENSE](https://raw.githubusercontent.com/anthropics/claude-code/main/LICENSE.md)).

### Limits of this report

This report has its own blind spots:

- OpenAI's primary posts returned errors, so every OpenAI launch-post detail comes from summaries.
- No leaderboard figure was checked directly at the source.
- Several harnesses were not researched: Aider, Goose, Cline, opencode, Gemini CLI's approval modes, Codex CLI's licence and hook names, and ChatGPT agent's architecture.
- No independent audit was found of any vendor's sandbox or its prompt-injection statistics.

## Conclusion

The harness has become the main place where agent behaviour is engineered. The way these products evolved points to a two-part rule. Anything that must hold for certain belongs in deterministic harness code: permission rules, proxies that keep credentials outside the box, hooks, checkpoints. Anything adaptive belongs in the model's loop, fed by a context window that is kept small and cache-stable. Claude Code's docs make this split explicit. Cloud harnesses, graph frameworks and the Chrome agent each rediscovered it in their own setting. That shared rediscovery is the strongest reason to treat it as the state of the art and not as one vendor's taste.

Two practical consequences follow. First, a benchmark score describes a model *and* a harness together. The October 2026 ranking reversals mean that "which model is best" has no answer without saying which harness and which task, and anyone comparing agents should insist on harness disclosure. Second, the open questions are no longer about loop design. They are about custody and orchestration: how credentials, egress and untrusted content are separated when agents run unattended in the cloud, and whether many coordinated sub-agents (Claude Code's `Workflow` tool, agent teams, graph runtimes with loops as nodes) can match a single thread with continuous context on coupled work. On the first question vendors publish their own figures and no independent ones exist. On the second, no controlled evidence exists yet.
