# Multi-agent coordination: what the evidence says (November 2026)

Research note for the harness's orchestrator, teams (lead, members, reviewer), background agents and per-agent
models. It covers measured results, failure studies, practitioner reports, peer messaging versus a lead, and
evaluation. Gathered 2026-11-02.

How to read it:
- **[older]** marks results from before 2026 or on models from before 2025-H2. They still matter, but stronger models
  have shifted several of them (see "capability saturation").
- **Who ran it** is given for each source. Vendor and practitioner reports are mostly n=1 projects or internal evals
  whose size is not disclosed. Treat them as existence proofs, not effect sizes.
- **(secondary)** means the figure was seen only in a third-party summary, not in the primary text.

---

## 1. Measured benefits and costs

### 1.1 Head-to-head results

| Study (who, date) | Setup | Result | Caveats |
|---|---|---|---|
| Anthropic Research system ([Anthropic, 2025-06-13](https://www.anthropic.com/engineering/multi-agent-research-system)) **[older]** | Opus 4 lead + Sonnet 4 subagents vs single Opus 4, internal research eval | **+90.2%** over single agent. On BrowseComp, **token usage alone explains 80%** of performance variance; tokens, number of tool calls and model choice together explain **95%**. Upgrading Sonnet 3.7 to Sonnet 4 beat doubling the 3.7 token budget. Parallelism cut research time **up to 90%** on complex queries. Agents use **~4x** chat tokens, multi-agent **~15x**. | Internal eval, size not given; the gain is largely "more tokens spent in parallel". Built for breadth-first research. Anthropic itself says most coding is a poor fit. |
| Opus 4.6 BrowseComp ([Anthropic, 2026-03-06](https://www.anthropic.com/engineering/eval-awareness-browsecomp); system card) | Multi-agent vs single-agent harness, same model | Multi-agent **86.57%** vs single **83.73%** (revised figures; single-agent figure from the system card, seen via secondary). About **+3 points** (~3% relative) for the same frontier model: far below the 2025 internal-eval gain, though the evals differ. | Vendor; multi-agent runs also had **3.7x** more unintended solutions (0.87% vs 0.24%), see §4. |
| "Towards a Science of Scaling Agent Systems" ([Google Research, DeepMind, MIT; arXiv 2512.08296, 2025-12](https://arxiv.org/abs/2512.08296)) | 180 configurations: single agent vs Independent, Centralized, Decentralized, Hybrid; GPT-5 family, Gemini 2.x, Claude 3.7 to 4.5; **token budgets matched** (~4,800 reasoning tokens per trial) | Finance-Agent: Centralized **+80.8%**, Decentralized +74.5%. BrowseComp-Plus: Decentralized **+9.2%**, Centralized +0.2%, Independent about **-35%**. Workbench: Decentralized +5.7%, others about -1.2%. PlanCraft (sequential): **every** MAS lost, **-39% to -70%**. Coordination gains vanish or turn negative once the single agent scores above **~45%** (beta = -0.404, p<0.001); tool-heavy tasks suffer more from overhead (beta = -0.267). A predictive model picks the best architecture for **87%** of held-out configurations (cross-validated R^2 0.52). Sub-agent capability mattered more than orchestrator capability. | Largest controlled study found. Small per-trial budgets; four benchmarks; relative (%) changes on low baselines look large. |
| BenchAgent "Do More Agents Help?" ([Westlake U. et al.; arXiv 2606.05670 v2, 2026-10](https://arxiv.org/abs/2606.05670)) | 6 published MAS workflows vs one single-agent reference, 10 benchmarks, GPT-4.1, 3 runs; GAIA (165 tasks, 1 run) | Only EvoAgent beat the single agent on the pooled score (79.70% vs 76.65%, **+3.05 points at 1.27x tokens**). The other five trailed by **1.7 to 8.8 points**; ChatEval used **4.34x** tokens and still trailed. Local wins exist (debate +9.7 on HumanEval; ChatEval +22 on IFEval but 4.4% on AIME). On GAIA one workflow (Jarvis) beat single (46.7% vs 37.6%) with fewer tokens. With Qwen3-32B, **no** MAS beat single. | Frameworks are 2023-2024 designs; GPT-4.1 backbone. Authors flag "answer preservation" (a correct intermediate answer lost before the final one). |
| Tran and Kiela ([arXiv 2604.02460, 2026-04](https://arxiv.org/abs/2604.02460)) | Single vs several MAS on multi-hop reasoning, Qwen3, R1-distill, Gemini 2.5, **equal thinking-token budgets** | Single agent **matches or beats** every MAS at equal budget and lower cost. Argument from the data processing inequality: passing summaries between agents can only lose information. MAS helps when a single agent's effective context use is degraded, or when more compute is spent. | Also finds budget-control artifacts in APIs (notably Gemini 2.5) that inflate apparent MAS gains. |
| CAID ([CMU, Geng and Neubig; arXiv 2603.21489, 2026-03](https://arxiv.org/abs/2603.21489)) | Manager + 2-4 engineers in **separate git worktrees**, test-gated merges, vs one OpenHands agent (100 iterations); Sonnet 4.5, MiniMax 2.5, GLM 4.7 | PaperBench: Sonnet 4.5 57.2 to **63.3**; MiniMax 10.4 to 36.7; GLM 38.0 to 45.4. Commit0-Lite: Sonnet 53.1 to **59.1**; MiniMax 42.3 to 57.0; GLM 42.8 to 46.5. Doubling the single agent's iterations (100 to 200) gave little or negative gain. **Cost was 1.7x to 4.3x higher and wall-clock time was longer in all six pairs** (e.g. Commit0, Sonnet: 693 s to 1,583 s). Shared workspace with "stay out of each other's files" instructions (**soft isolation**) scored **below** the single agent on PaperBench (55.5 vs 57.2). 8 engineers did worse than 4. One run where the manager never assigned a critical dependency scored 8.7% vs 34.3% in another run (single: 17.4%). Manager review per round beat engineer self-verification (60.2% vs 55.1% pass rate) at higher runtime. | Writes in parallel can pay on accuracy, but only with real isolation and tests; it did **not** save time. |
| DeLM ([Stanford, Mao and Mirhoseini; arXiv 2606.10662, 2026-06](https://arxiv.org/abs/2606.10662)) | No orchestrator: agents claim subtasks from a shared queue and write verified compact "gists" to a shared context; vs mini-SWE-agent (single) and AOrchestra (lead spawns subagents) | SWE-bench Verified, Gemini 3 Flash: single 54.7%, orchestrator 55.2-56.4%, DeLM **65.7%** at **$0.12 vs $0.26** per task. With Opus 4.6: single **76.9%**, orchestrator 74.7-75.2% (**below single**), DeLM 78.0% at $0.63 vs $0.61. LongBench-v2 multi-doc QA (125 samples, 4 models): +3.6 to +6.5 points over a single call. | Authors' own method. Gains shrink sharply with the stronger model; the hub-and-spoke baseline lost to the single agent with Opus 4.6. No wall-clock numbers. |
| Advisor strategy ([Anthropic, 2026-04-09](https://claude.com/blog/the-advisor-strategy)) | Cheap executor runs the task; calls a stronger model for advice (400-700 tokens of guidance, no tools) | SWE-bench Multilingual (300 problems, 5 trials): Sonnet + Opus advisor **+2.7 points** and **-11.9%** cost per task vs Sonnet alone. BrowseComp (1,266 problems): Haiku 19.7% alone, **41.2%** with an Opus advisor, still 29% below Sonnet solo, at 85% less cost than Sonnet. | Vendor; thinking settings differed between compared runs. |
| LangChain tau-bench ([LangChain, 2025-06-10](https://www.langchain.com/blog/benchmarking-multi-agent-architectures)) **[older]** | Retail tau-bench (100 tasks) + up to 6 irrelevant "distractor" domains (19 tools each); gpt-4o; single, swarm, supervisor | Single agent drops sharply with **2+ distractor domains**; swarm and supervisor stay flat. With one domain the single agent is slightly best. Swarm slightly beats supervisor (supervisor paraphrases sub-agent answers). Fixing the supervisor's hand-off gave **~50%** improvement. | Shows the "tool overload / context protection" case for splitting. |
| Single agent with skills ([UBC, arXiv 2601.04748, 2026-01](https://arxiv.org/abs/2601.04748)) | MAS "compiled" into one agent choosing among skills; GSM8K, HumanEval, HotpotQA | Similar accuracy with **~54% fewer tokens and ~50% lower latency**. Skill selection accuracy falls non-linearly as the library grows (confusable skills); hierarchical routing helps. | Small, older benchmarks. |
| "Single-agent or multi-agent? Why not both" ([UIUC, arXiv 2505.18286, 2025-05](https://arxiv.org/abs/2505.18286)) **[older]** | MAS vs single across agentic apps; Gemini 2.0, GPT-4o, Llama 4 | MAS advantage **diminishes as models improve** at long-context reasoning. Routing each request to single or multi by complexity: +1.1% to +12% accuracy, up to 20% lower cost. Failure points: one critical agent caps the whole system; downstream agents "overthink" redundant input. | |
| Kimi K2.5 Agent Swarm ([Moonshot, 2026-01](https://www.kimi.com/blogs/kimi-k2-5.html)) | RL-trained orchestrator, up to 100 sub-agents, up to 1,500 steps | Up to **4.5x** less execution time (measured in "critical steps": orchestrator steps + slowest sub-agent per stage); 80% less end-to-end runtime internally. BrowseComp with swarm 78.4% vs 60.6% or 74.9% without (secondary; the two summaries disagree). | Vendor. Training needed explicit penalties for "serial collapse" and "spurious parallelism". Users report sub-agents drifting into inconsistent definitions. |

Debate, voting and model mixing (reasoning tasks):
- "Debate or Vote" ([UW-Madison, arXiv 2508.17536, NeurIPS 2025](https://arxiv.org/abs/2508.17536)) **[older]**: across 7 benchmarks,
  **majority voting alone accounts for most of the gain** credited to multi-agent debate; debate itself is a martingale
  (does not raise expected correctness).
- "Stop Overvaluing Multi-Agent Debate" ([arXiv 2502.08788, 2025-02](https://arxiv.org/abs/2502.08788)) **[older]**: debate often fails to beat
  chain-of-thought or self-consistency at the same or lower compute; mixing different models helps debate.
- "Rethinking the Bounds of LLM Reasoning" ([ACL 2024](https://arxiv.org/abs/2402.18272)) **[older]**: one agent with a strong prompt
  (with demonstrations) matches the best discussion method; discussion wins only without demonstrations.
- Self-MoA ([Princeton, arXiv 2502.00674, TMLR 2026](https://arxiv.org/abs/2502.00674)): sampling the **single best model** several times and
  aggregating beats mixing different models (+6.6% AlpacaEval 2.0, +3.8% average on MMLU, CRUX, MATH); weaker models
  in the mix pull quality down. Mixing won only on a constructed task with complementary skills (+0.17 to +0.35%).
- "Talk Isn't Always Cheap" ([arXiv 2509.05396, 2025-09](https://arxiv.org/abs/2509.05396)): debate can make answers **worse** than a
  single agent, especially with a weaker agent in the group; agents flip correct answers to incorrect ones to agree;
  longer debates can degrade further.

### 1.2 Parallel speedups (wall-clock)

| Source | Reported speedup | Conditions |
|---|---|---|
| Anthropic Research (2025) **[older]** | Up to **90%** less research time | 3-5 subagents spawned at once, each making 3+ tool calls in parallel; breadth-first web research. |
| Kimi K2.5 (2026-01, vendor) | Up to **4.5x** fewer critical-path steps; 80% runtime cut | Wide search; RL-trained decomposition. |
| Algorithm discovery harness ([arXiv 2605.15221, 2026-05](https://arxiv.org/abs/2605.15221)) | **3.2x-3.9x** with 4 agents (69.7 h to 20.0 h) | Independent candidate programs, one git worktree each (embarrassingly parallel). |
| CAID (2026-03) | **Slower** than single agent in all 6 runs | Dependent coding subtasks; manager planning and merges add serial time. |
| Cursor (2026-01) | Lock-based flat team: **20 agents ran at the throughput of 2-3** | Agents held locks too long, forgot to release them. |
| Anthropic multi-agent guide (2026-01) | "The primary benefit is thoroughness, not speed" | Guidance, not a measurement. |
| Anthropic harness (2026-03) | Full 3-agent harness took **6 h / $200** vs solo **20 min / $9** (over 20x cost) for clearly better output | Quality, not speed, was the gain. |

### 1.3 Cost multiples

| Source | Multiple |
|---|---|
| Anthropic Research (2025) | ~15x chat tokens (single agent ~4x) |
| Anthropic "Building multi-agent systems" ([2026-01-23](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them)) | 3-10x a single agent for equivalent tasks |
| Claude Code docs ([costs](https://code.claude.com/docs/en/costs), current) | Agent teams ~7x a standard session when teammates run in plan mode; tokens scale roughly linearly with team size |
| Google scaling study (2025-12) | Coordination overhead +58% (independent), +263% (decentralized), +285% (centralized), +515% (hybrid) |
| CAID (2026-03) | 1.7x-4.3x dollars |
| BenchAgent (2026-10) | 0.7x-4.3x tokens; most expensive workflow was not the most accurate |
| Anthropic C compiler ([2026-02-05](https://www.anthropic.com/engineering/building-c-compiler)) | 16 agents, ~2,000 sessions, 2B input + 140M output tokens, just under $20,000 |
| Counter-examples | DeLM (compact shared state) and the advisor pattern were **cheaper** than the single agent; AgentPrune ([ICLR 2025](https://arxiv.org/abs/2410.02506)) cut tokens 28-73% by pruning redundant inter-agent messages at equal accuracy |

### 1.4 Where splitting helps and where it hurts (synthesis of 1.1-1.3)

Helps:
- **Breadth-first, read-heavy work** with independent branches (research, search, wide lookup, review from several
  angles, competing hypotheses). Gains come mostly from spending more tokens in parallel in separate contexts.
- **Context protection**: subtasks producing large, mostly irrelevant intermediate output (Anthropic: over ~1,000
  tokens), and tool overload (Anthropic: 20+ tools; LangChain: 2+ unrelated domains). Underlying cause: all 18 models
  Chroma tested lose reliability as input grows, even on simple tasks, and distractors make it worse
  ([Chroma "Context Rot", 2025-07-14](https://www.trychroma.com/research/context-rot)) **[older]**.
- **A separate verifier or reviewer** with a clean context (Anthropic harness, Cognition, CAID round review, MAST +15.6%).
- **Weaker or cheaper models**: the gap closes when a cheap executor can consult a strong model (advisor), or when
  agents split a long task the weaker model cannot hold (DeLM's Gemini 3 Flash gain, CAID's MiniMax gain).
- **Parallel writes only with hard isolation and tests** (CAID worktrees + test-gated merge; Carlini's per-test tasks).

Hurts or wastes:
- **Sequential, tightly coupled work** (PlanCraft -39% to -70%; Carlini's Linux kernel phase, where all 16 agents hit
  the same bug and overwrote each other).
- **Strong single-agent baselines** (above ~45% success, Google); frontier models narrow or erase the gain (Opus 4.6:
  +3 points on BrowseComp; DeLM with Opus: +1.1; hub-and-spoke below single).
- **Tool-heavy tasks** where every agent must load many tools (Google beta = -0.267).
- **Equal-budget reasoning tasks**: debate and discussion add little beyond voting or a better prompt.
- **Wall-clock time on dependent coding tasks** (CAID slower in every case).
- **Shared workspaces without isolation** ("soft isolation" fell below the single agent).

---

## 2. Failure modes and how often they occur

### 2.1 MAST: "Why Do Multi-Agent LLM Systems Fail?"

[Cemri, Pan, Yang et al., UC Berkeley; arXiv 2503.13657](https://arxiv.org/abs/2503.13657): v1 2025-03, v3 2025-10. **[older]**: 7 frameworks
(MetaGPT, ChatDev, HyperAgent, AppWorld, AG2/MathChat, Magentic-One, OpenManus), mostly GPT-4o/GPT-4 era, plus Claude 3.7
Sonnet and Qwen2.5-Coder. Taxonomy from 150 traces with 6 expert annotators (kappa 0.88); frequencies from **1,642
annotated traces** (MAST-Data) labelled by an LLM annotator (o1, 94% accuracy, kappa 0.77 vs experts). Share of
observed failures (v3; a trace can have several):

| Category | Failure mode | Share |
|---|---|---|
| **System design / specification, 44.2%** | Disobey task specification | 11.8% |
| | Disobey role specification | 1.5% |
| | Step repetition (loops, redone work) | **15.7%** |
| | Loss of conversation history | 2.8% |
| | Unaware of termination conditions | **12.4%** |
| **Inter-agent misalignment, 32.4%** | Conversation reset | 2.2% |
| | Fail to ask for clarification | 6.8% |
| | Task derailment | 7.4% |
| | Information withholding | 0.85% |
| | Ignored other agent's input | 1.9% |
| | Reasoning-action mismatch | **13.2%** |
| **Task verification, 23.5%** | Premature termination | 6.2% |
| | No or incomplete verification | 8.2% |
| | Incorrect verification | 9.1% |

Interventions (ChatDev, GPT-4o): clearer role specification **+9.4%** task success; adding a high-level objective
verification step **+15.6%** (ProgramDev). The authors conclude prompt fixes help but are "insufficient"; most failures
come from system design (who verifies, when to stop, what each agent knows), not model weakness alone. Earlier v2
numbers (200 traces) differ, e.g. step repetition 17.1%; use v3.

### 2.2 Other measured failure data

- **Error amplification** (Google, 2025-12): relative to a single agent, errors propagate **17.2x** with independent
  agents (no communication, results merged), **7.8x** decentralized, **5.1x** hybrid, **4.4x** centralized. A lead that
  checks members' work contains errors best.
- **Collaboration gap** ([Microsoft Research, arXiv 2511.02687, COLM 2026](https://arxiv.org/abs/2511.02687)): 32 models solving mazes alone and in
  pairs; many models that do well alone lose much of it when they must collaborate, distilled models most. "Relay"
  (stronger agent does the first steps, then hands off) closes much of the gap.
- **Debate pathologies** (2025): correct-to-incorrect flips to agree with peers; a weaker member drags down a stronger
  one; correctness incentives in the prompt did not stop it ("Talk Isn't Always Cheap"). Judge mistakes and
  wrong-answer propagation ("Rethinking the Bounds", 2024).
- **Answer preservation** (BenchAgent, 2026-10): correct intermediate answers lost before the final output.
- **Node and edge bottlenecks** (UIUC, 2025-05): the agent with the hardest subtask caps the system; redundant
  information makes downstream agents overthink.
- **Delegation misses** (CAID, 2026-03): a manager that never assigns a critical dependency sinks the run (8.7% vs
  34.3% on the same repo).
- **Security**: "Prompt Infection" ([arXiv 2410.07283, 2024-10](https://arxiv.org/abs/2410.07283)) **[older]**: an injected prompt
  self-replicates across agents through their messages, reaching agents that never saw external input; tagging plus
  existing defenses reduces it, neither alone suffices.
- **Evaluation integrity** (Anthropic, 2026-03): multi-agent BrowseComp runs found leaked answers or decrypted the
  benchmark **3.7x** as often as single-agent runs (0.87% vs 0.24% of problems): more parallel searchers, more chances
  to hit a leak. Agents also leave traces on the web that later agents read.

### 2.3 Practitioner-reported failures (unquantified unless stated)

| Failure | Reported by |
|---|---|
| Spawning **50 subagents** for a simple query; endless searching for sources that do not exist; excessive status updates between agents; duplicated searches from vague briefs; preferring SEO content farms | Anthropic Research (2025) |
| Subagents spending **more tokens on coordination than on the work**; role pipelines (planner, implementer, tester, reviewer) losing fidelity at each hand-off ("telephone game"); teams later found a better single-agent prompt matched the pipeline | Anthropic guide (2026-01) |
| Verifier "early victory": runs a few checks and declares success | Anthropic guide (2026-01) |
| Self-evaluation "reliably skews positive"; a separate evaluator found real issues then talked itself into approving | Anthropic harness (2026-03) |
| Conflicting implicit decisions between parallel writers (Flappy Bird split into a Mario-style background and a mismatched bird) | Cognition ([2025-06-12](https://cognition.com/blog/dont-build-multi-agents)) **[older]** |
| Overly prescriptive managers; children wrongly assuming shared state; children not reporting back unless told; unstructured agent swarms "mostly a distraction" | Cognition ([2026-04-22](https://cognition.com/blog/multi-agents-working)) |
| Locks held too long or never released; agents crashing while holding locks; flat teams become **risk-averse**, take small safe tasks, churn; an integrator role became a bottleneck and was removed; drift and tunnel vision on long runs (periodic fresh starts needed); Opus 4.5 "stopped early and took shortcuts" on very long autonomous runs vs GPT-5.2 | Cursor ([2026-01-14](https://cursor.com/blog/scaling-agents)) |
| All agents hitting the same bug and overwriting each other on a monolithic task; frequent merge conflicts; new work breaking old features until CI was enforced; "tests pass, so done" false conclusions; agents cannot sense time and burn hours on test runs | Anthropic C compiler (2026-02) |
| Task status lagging (teammates not marking tasks done, blocking dependents); the lead stopping before tasks are done; the lead doing the work itself instead of waiting; teammates stopping after errors; same-file edits overwriting | Claude Code agent teams docs ([current](https://code.claude.com/docs/en/agent-teams)) |

### 2.4 Diagnosing failures is itself unreliable

- Who&When ([Penn State, Duke et al.; ICML 2025](https://arxiv.org/abs/2505.00212)) **[older]**: the best method found the responsible agent in
  **53.5%** of failures and the decisive step in **14.2%**; o1 and R1 were not practically usable.
- Who&When Pro ([arXiv 2607.09996, 2026-07](https://arxiv.org/abs/2607.09996)): 12,326 failed trajectories, 15 frameworks, 18 error modes. Agent-level
  attribution **48-58%**, step-level 64-74%, error-mode macro-F1 **11-22%**, all three correct 16-25%. Step accuracy
  falls from ~94% on traces under 3K tokens to ~50% above 12K. Models label errors by the visible symptom (usually
  "reasoning") and mislabel coordination, planning and verification errors.

---

## 3. Practices that work

### 3.1 Decide whether to split at all

- **Start single; add agents on evidence.** Anthropic (2024, 2026-01), OpenAI's
  [agent guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) (2025; split on tool overload or
  unmaintainable branching, seen via secondary), Cognition (2025),
  [LangChain](https://blog.langchain.com/how-and-when-to-build-multi-agent-systems) (2025) and the Claude Code docs all say this. The Claude Code docs: "for sequential tasks,
  same-file edits, or work with many dependencies, a single session or subagents are more effective."
- **Split by context, not by role** (Anthropic, 2026-01). Good split points: independent research paths, components
  with clean interfaces, black-box verification. Bad: sequential phases of the same work, tightly coupled components,
  shared state. The agent that builds a feature should also write its tests.
- **Read-heavy parallel, write single-threaded** (Cognition 2025 and 2026; LangChain 2025; Claude Code docs: "start with
  research and review"). Cognition 2026: multi-agent works "when writes stay single-threaded and the additional
  agents contribute intelligence rather than actions".
- **Rules of thumb with numbers**: delegate when the subtask would put more than ~1,000 mostly irrelevant tokens in the
  main context, or the agent needs 20+ tools (Anthropic 2026-01); coordinate only when the single agent's success is
  below ~45% and the task decomposes (Google 2025-12).

### 3.2 Effort scaling and limits

- Anthropic Research (2025) put scaling rules in the lead's prompt: **simple fact-finding, 1 agent, 3-10 tool calls**;
  **comparisons, 2-4 subagents, 10-15 calls each**; complex research, 10+ subagents with divided responsibilities;
  spawn **3-5 at once**. Without them the lead over-spawned.
- Team size: Claude Code docs say start with **3-5 teammates**, **5-6 tasks per teammate**; "three focused teammates
  often outperform five scattered ones". CAID: 2-4 engineers best, 8 worse. Kimi needed explicit training penalties
  against both "serial collapse" and "spurious parallelism".
- Task size: too small and coordination costs more than the work; too large and agents run too long without
  check-ins (Claude Code docs).

### 3.3 Briefs and hand-offs

- Every brief: **objective, output format, tools and sources to use, task boundaries** (Anthropic 2025). Vague briefs
  produced duplicated work. Members do not inherit the lead's history; put the task's specifics in the spawn prompt
  (Claude Code docs).
- Return **compact results and references**, not transcripts: subagents store work in external systems (files) and pass
  "lightweight references" back, which "prevents information loss" and saves tokens (Anthropic 2025). A lookup subagent
  should return 50-100 tokens, not 2,000+ of raw data (Anthropic 2026-01).
- Avoid paraphrase layers: LangChain's supervisor gained ~50% from removing hand-off clutter and letting the supervisor
  forward a member's answer verbatim (`forward_message`).
- Write down "done" before work starts: the harness's **sprint contract** (generator proposes what done means and how
  to verify it; evaluator agrees before coding) (Anthropic 2026-03).
- Delegation quality is the bottleneck: assign the critical dependency explicitly (CAID); managers that over-specify
  hurt (Cognition 2026).
- Good tool descriptions pay off across agents: an agent rewriting failing tool descriptions cut later task time 40%
  (Anthropic 2025).

### 3.4 Verification and judges

- A **separate, skeptical evaluator** is more tractable than making the generator self-critical; tune it against logs
  of human judgments; give it hard thresholds and a running app to test (Playwright) (Anthropic 2026-03).
- A verifier needs **explicit criteria, negative tests and an instruction to run the full suite** (Anthropic 2026-01).
- A reviewer works best with a **clean context that sees only the diff**; filter its findings against the user's
  instructions to avoid loops and scope creep (Cognition 2026: Devin Review finds ~2 bugs per PR, ~58% severe).
- Tests are the real coordinator for parallel writers: "the verifier must be nearly perfect" or agents solve the wrong
  problem (Carlini 2026); test-gated merges (CAID); a known-good oracle (GCC) to split a monolithic task into
  independent failures (Carlini).
- Stronger orchestrators can increasingly check member work themselves; separate verifiers matter most with weaker
  leads, special tooling or required checkpoints (Anthropic 2026-01).
- Hook-style gates on task completion (Claude Code `TaskCompleted`, `TeammateIdle`) enforce checks mechanically.

### 3.5 Isolation and concurrency control

- **Worktree per writer** (CAID; algorithm discovery; Claude Code's `isolation`); soft isolation by instruction failed.
- **File or area ownership** per member (Claude Code docs).
- For shared task lists: atomic claiming (file lock or optimistic concurrency), dependency blocking. Cursor found locks
  brittle and slow; optimistic concurrency was simpler but did not fix the lack of hierarchy.
- Hierarchy beat a flat peer team at scale: planners (recursive sub-planners) create tasks, workers do them without
  talking to each other, a judge decides whether to continue each cycle (Cursor 2026).

### 3.6 Models per role

- Give the hardest subtask the strongest model; sub-agent capability mattered more than orchestrator capability
  (Google 2025-12). Anthropic Research used an Opus lead with Sonnet workers.
- A cheap executor with an on-demand strong advisor is cost-effective (Anthropic advisor 2026-04; Cognition's "Smart
  Friend", which needs a fork of the primary's full context and works across frontier models but not with a much
  weaker primary).
- Do not add weaker models to votes or debates (Self-MoA; "Talk Isn't Always Cheap"); heterogeneity helps debate only
  among comparably strong models ("Stop Overvaluing MAD").
- Pick models per role by behavior on long runs: Cursor found GPT-5.2 a better planner than a coding-tuned model and
  steadier than Opus 4.5 on week-long autonomy; Anthropic dropped context resets once Opus 4.5 stopped showing
  "context anxiety".

### 3.7 Long runs and background agents

- Synchronous fan-out (the lead waits for each batch) is a bottleneck and prevents steering; asynchronous execution is
  the next gain but adds coordination and error-propagation problems (Anthropic 2025).
- The lead should **wait for members**; leads that start doing the work themselves or stop early are a documented
  failure (Claude Code docs). Monitor and steer; unattended teams waste effort.
- Checkpoint and resume rather than restart after errors (Anthropic 2025); periodic fresh starts with a structured
  hand-off counter drift (Cursor; Anthropic harness); persist the plan to memory before the context fills.
- Keep logs terse and greppable; print progress sparingly; offer sampled fast test runs (Carlini).

### 3.8 Re-test the scaffolding with each model

"Every component encodes an assumption about what the model can't do on its own" (Anthropic 2026-03). Sprints and
context resets were removed as models improved; the evaluator moved to a single end check. The Google saturation
effect and the shrinking frontier gains (BrowseComp +3 points, DeLM +1.1 on Opus) point the same way.

---

## 4. Peer messaging versus hub-and-spoke

| Evidence | Finding |
|---|---|
| Google scaling (2025-12) | Centralized (hub) contained errors best (4.4x amplification vs 7.8x decentralized peers, 17.2x independent) and won the decomposable finance task (+80.8%). Decentralized peer exchange won on dynamic web navigation (BrowseComp-Plus +9.2% vs +0.2%) and tool-use Workbench (+5.7%). Independent agents with no communication were worst. Overhead: decentralized +263%, centralized +285%. |
| LangChain (2025-06) **[older]** | Swarm (agents hand off directly and answer the user) slightly beat a supervisor that relays answers, and used fewer tokens; the gap was the supervisor's paraphrasing, and a verbatim-forward tool closed much of it. |
| Cursor (2026-01) | A flat team of equal peers coordinating through a shared file with locks failed (throughput, risk aversion, churn). Planner/worker hierarchy with no worker-to-worker talk scaled to hundreds of agents. |
| Anthropic C compiler (2026-02) | No orchestrator and no messaging: 16 agents claimed tasks via lock files in git. Worked while there were many independent failing tests; collapsed on one monolithic task until an oracle re-split it. |
| Cognition (2026-04) | Unstructured negotiating swarms "mostly a distraction"; open problem is how a child surfaces discoveries that affect siblings. |
| Claude Code agent teams (2026, experimental) | Lead + teammates with direct messaging, a shared task list (pending, in progress, completed; dependencies; file-locked claiming) and a mailbox. Recommended for research, review, competing-hypothesis debugging (teammates try to disprove each other to counter anchoring) and cross-layer work with separate file ownership; not for sequential or same-file work. Messages from other agents are marked as not from the user and cannot carry approvals. |
| Blackboard ([Google, arXiv 2510.01285, 2025-09](https://arxiv.org/abs/2510.01285)) | A central agent posts requests to a shared board and data-owning agents volunteer answers: **+13% to +57%** relative end-to-end success over baselines including a master-slave design, +9% data-discovery F1 (KramaBench, modified DSBench and DA-Code). Advantage: the coordinator need not know each agent's expertise. |
| DeLM (2026-06) | Shared verified context (task queue + compact checked gists), no central controller, beat a lead-spawns-subagents baseline on SWE-bench Verified (65.7% vs 55-56% with Gemini 3 Flash, at half the cost). Evidence that a well-curated shared state can replace message passing. |
| MultiAgentBench ([arXiv 2503.01935, 2025-03](https://arxiv.org/abs/2503.01935)) **[older]** | Of star, chain, tree and graph topologies, graph (peers talk along defined edges) did best in the research scenario; cognitive planning +3% milestone achievement. |
| AgentPrune (ICLR 2025) **[older]** | Much peer traffic is redundant: one-shot pruning of the message graph kept accuracy while cutting tokens 28-73% and improved robustness to malicious agents. |
| Debate studies (2024-2025) | Peer exchange of answers mostly reduces to voting and can push agents toward agreement on wrong answers. |
| Smart-manufacturing control ([arXiv 2610.01364, 2026-10](https://arxiv.org/abs/2610.01364)) (secondary) | Peer-to-peer used the fewest tokens and handled isolated faults, but lacked global replanning for cross-module faults. |
| Prompt Infection (2024) **[older]** | Peer channels spread injected instructions between agents. |

Reading: a **lead (hub) is the safer default** for task assignment, error containment and synthesis. Direct peer
messages earn their cost in two places: adversarial review or hypothesis testing among readers, and passing a
discovery that changes a sibling's work. A **shared board** (task list with claiming and dependencies, or a
blackboard of verified findings) beats free-form chat for both, provided entries are compact and checked before
others rely on them. Flat peer teams with locks did not scale for writers.

---

## 5. Evaluation methods and metrics

How teams evaluate:
- **End-state checks**: grade the final state (tests pass, files right, environment state), with checkpoints for long
  workflows, not the exact path (Anthropic 2025; Anthropic evals [2026-01-09](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)). Transcript checks are
  still useful for tool use, turn counts and code quality.
- **Start small, from real failures**: ~20 queries were enough early because effects were large (30% to 80% success)
  (Anthropic 2025); 20-50 tasks from real failures (Anthropic 2026-01). A task at 0% over many trials is usually broken.
- **LLM judge with a rubric**: one call scoring 0.0-1.0 plus pass/fail on factual accuracy, citation accuracy,
  completeness, source quality, tool efficiency worked best (Anthropic 2025). Later guidance: one isolated judge per
  rubric dimension, an "Unknown" escape option, calibration against human graders (Anthropic 2026-01). Self-preference
  bias is real: models rate their own outputs higher ([Panickssery et al., NeurIPS 2024](https://arxiv.org/abs/2404.13076)) **[older]**,
  so the judge should not be the generator.
- **Agent-as-a-judge**: a judge that can inspect the workspace agreed with human consensus ~**90%** vs ~**70%** for a
  plain LLM judge, at ~2-3% of the human cost and time (55 DevAI tasks, 3 human experts; [Zhuge et al., arXiv 2410.10934, 2024-10](https://arxiv.org/abs/2410.10934)) **[older]**.
  Human pairs disagreed 10-30% of the time.
- **Humans still catch what automation misses** (Anthropic 2025: edge cases, source quality).
- **Log analysis for shortcuts and leaks**: HAL found agents searching for benchmark answers; Anthropic found
  multi-agent runs leak more (§2.2). Parallel, long, compute-heavy setups need more scrutiny.
- **Milestone KPIs** for collaboration quality (MultiAgentBench) and **failure taxonomies** (MAST; an LLM annotator
  reached kappa 0.77 with experts) to see where a team fails; automated attribution is only ~50% accurate at the agent
  level (Who&When, Who&When Pro).

Metrics that matter:
- **Success rate at matched budget** against a single-agent baseline. Several MAS gains disappear when tokens are
  matched (Tran and Kiela 2026; Google 2025; BenchAgent 2026). Report tokens and dollars with every score.
- **Cost per solved task** and the cost-accuracy Pareto frontier. HAL ([Princeton et al., ICLR 2026](https://arxiv.org/abs/2510.11977): 21,730
  rollouts, 9 models, 9 benchmarks, ~$40,000) found the most expensive setups rarely on the frontier and higher
  reasoning effort lowering accuracy in 21 of 36 runs; "AI Agents That Matter" ([arXiv 2407.01502, 2024](https://arxiv.org/abs/2407.01502))
  **[older]** showed simple baselines matching complex agents at a fraction of the cost.
- **Reliability (pass^k)**: the chance all k trials succeed; 75% per trial gives ~42% pass^3 (Anthropic 2026-01;
  tau-bench, [arXiv 2406.12045](https://arxiv.org/abs/2406.12045) **[older]**). pass@k is for "one success is enough".
- **Time to solution** as wall-clock or critical path (Kimi's "critical steps": orchestrator steps plus the slowest
  member per stage), alongside tokens; token counts alone mislead about difficulty and duration
  ([AssetOpsBench retrospective, arXiv 2605.08518](https://arxiv.org/abs/2605.08518), secondary).
- **Coordination diagnostics**: overhead (extra tokens vs single), error amplification (failure rate relative to
  single), redundancy (duplicated work), message volume (Google 2025).

---

## 6. Conclusions for the harness design

1. **Default to one agent.** The orchestrator should delegate only for (a) independent, read-heavy branches,
   (b) work that would put large irrelevant output or many extra tools into its context, or (c) a fresh-context
   check. Put an effort-scaling rule in its instructions (none for simple asks; 2-4 for comparisons; more only for
   broad research) and keep hard caps on concurrency (3-5), depth, turns and spend. At equal budget a single agent
   often matches a team; each split must buy something specific.
2. **Writers stay single-threaded or truly isolated.** Parallel writing needs a worktree per writer, disjoint file
   ownership and test-gated merges; instruction-only separation in a shared tree did worse than one agent. Do not
   expect parallel coding to be faster; expect it to be more thorough at 2-4x the cost.
3. **Enforce the brief.** Objective, output format, tools and sources, boundaries and a written definition of done
   (sprint-contract style). Members do not share the lead's history, so the brief must carry it. Members return
   compact results plus references to files, and the lead can forward a member's result verbatim instead of
   paraphrasing it.
4. **The reviewer is a separate, skeptical agent with a clean context.** It sees the spec, the diff or artifact and
   explicit pass criteria, runs the full checks (including negative tests), and cannot be the generator. Calibrate it
   against human verdicts; watch for "early victory" and for talking itself into approval. Verification gaps are
   ~24% of MAS failures; a verification step gave +15.6%.
5. **Hub-and-spoke by default; peers by exception.** A lead that assigns, checks and synthesizes contains errors best
   (4.4x vs 17.2x amplification). Allow member-to-member messages for adversarial review or competing hypotheses and
   for a discovery that changes a sibling's work; prefer a shared task board (atomic claiming, dependencies) over chat.
   Treat every inter-agent message as data from another agent, never as the person's approval (prompt infection).
6. **Make termination explicit.** Unclear stopping conditions (12.4%), loops (15.7%) and premature termination (6.2%)
   are among the largest failure shares. The lead must wait for members (the harness's foreground default for team
   members matches the evidence); give each member done criteria and a turn limit; detect a lead that stops or starts
   doing members' work.
7. **Assign models by role and difficulty.** The strongest model goes where the hardest subtask is (members matter
   more than the lead in Google's study); a cheap executor with a strong advisor on demand is a good default for cost;
   never mix markedly weaker models into votes, debates or review panels.
8. **Budget for 3-15x tokens and show it.** Keep the team-wide spend limit; report tokens, dollars and wall-clock per
   run; stop runaway spawning (the "50 subagents for a simple query" failure). Use cached, compact shared context to
   cut repeated reading.
9. **Background agents need checkpoints and steering.** Persist plans and progress to files, resume from checkpoints,
   give the person a way to look in and redirect, and start long runs afresh with a structured hand-off when they drift.
10. **Evaluate every coordination change against a single-agent baseline at matched budget**, with end-state checks,
    a rubric judge (one isolated judge per dimension, an "Unknown" option) and human spot checks; track cost per solved
    task, pass^k and time to solution; scan logs for leaks and shortcuts. Do not trust automated blame for team
    failures (about 50% right on which agent).
11. **Re-test with each model upgrade.** Gains shrink as single-agent baselines rise (above ~45% success, coordination
    stops paying). Treat each team feature (reviewer, sprint, reset, parallel members) as removable and keep only what
    still beats one agent.
