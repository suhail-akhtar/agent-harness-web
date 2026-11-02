# Multi-agent "swarm" architectures for high-accuracy work: what is measured (gathered 2026-11-02)

Scope note. This extends `docs/agents-mcp/research/` (coordination-evidence.md, coordination-systems.md, verification.md)
and does not repeat it. Already covered there and only referenced here: Google/DeepMind "Towards a Science of Scaling
Agent Systems" (arXiv 2512.08296: the ~45% single-agent threshold, error amplification 4.4x-17.2x, overhead +58% to
+515%), BenchAgent (2606.05670), Tran and Kiela equal-budget study (2604.02460), CAID (2603.21489), DeLM (2606.10662),
the Anthropic advisor pattern, Kimi K2.5 swarm, MAST (2503.13657) frequencies, "Debate or Vote" (2508.17536), "Stop
Overvaluing MAD" (2502.08788), Self-MoA (2502.00674), "Talk Isn't Always Cheap" (2509.05396), the blackboard paper
(2510.01285), self-preference of judges (2410.21819, 2404.13076), token multiples (~15x Anthropic research, 3-10x).
Labels: **[older]** = published before 2025 (still cited where nothing newer supersedes it); **[vendor]** = claim by
the system's maker; **[snippet]** = number seen only in a search-result summary, not in the primary text;
**[abstract]** = only the abstract was read. "Harness:" lines say what a finding implies for the TypeScript harness
(orchestrator, sub-agents with harness-run done criteria and a clean-context verifier, teams with lead + reviewer,
workflows/graphs, providers Anthropic / OpenAI / Moonshot / Z.ai / DeepSeek).

## 1. Architectures compared with numbers: which gains survive equal-compute baselines?

### Takeaway
At equal compute, the gains that survive are (a) **selection among independent candidates by a strong verifier**
(tests, executable checks, a trained or well-prompted verifier), (b) **decomposition that keeps each call's context
small** when the input or tool space exceeds what one context uses well (recursive / map-reduce over corpora), and
(c) **budget-aware single agents** that plan and verify against a visible budget. Gains that mostly do not survive:
unguided debate, homogeneous voting past a handful of samples, and hub-and-spoke chat with strong models. The largest
remaining loss in almost every architecture is the **selection gap**: the right answer was generated but the
aggregator threw it away.

### Cited Findings

**Best-of-N / repeated sampling with a verifier**
- Repeated sampling raises *coverage* (any sample correct) log-linearly over four orders of magnitude of samples; on
  SWE-bench Lite, DeepSeek-Coder-V2 went from **15.9% (1 sample) to 56% (250 samples)**, beating the then single-sample
  SOTA of 43%. But majority voting and reward models used to pick an answer **plateau beyond several hundred samples**;
  only automatic verifiers (unit tests, proof checkers) convert coverage into accuracy. **[older, 2024-07]** —
  [Brown et al., "Large Language Monkeys", arXiv 2407.21787](https://arxiv.org/abs/2407.21787). Not superseded; the
  2026 results below confirm the coverage-vs-selection gap. Harness: parallel candidates are worth it only where the
  harness can *run* a done criterion; without one, spend the budget on a better single run.
- Compute-optimal test-time allocation (choosing per prompt between sequential revision and parallel search with a
  verifier) is **>4x more compute-efficient than plain best-of-N**; FLOPs-matched, test-time compute let a small model
  beat a **14x larger** model on problems where the small model had non-trivial success. **[older, 2024-08]** —
  [Snell et al., arXiv 2408.03314](https://arxiv.org/abs/2408.03314). Harness: decide N per task from a difficulty
  estimate, not a fixed N.
- Best-of-3 on SWE-bench Verified with an LLM verifier: pass@1 **76.1%**, verifier-selected **78.2%**, oracle (any of
  3 correct) **84.4%** — the selector recovers only ~25% of the available gain. Pairwise round-robin tournaments cost
  O(N^2) judge calls; a Bradley-Terry pivot variant is cheaper. **[vendor/self-reported README]** —
  [LLM-as-a-Verifier repo](https://github.com/llm-as-a-verifier/llm-as-a-verifier).
- Anthropic reported Claude Opus 4 at 72.5% on SWE-bench Verified and **79.4% with parallel test-time compute**
  (multiple samples, an internal scoring model picks one); Sonnet 4 72.7% to 80.2%. **[vendor, 2025-05]** —
  [Anthropic, Claude 4 announcement](https://www.anthropic.com/news/claude-4). Note: a 2026 roundup says OpenAI stopped
  reporting SWE-bench Verified in Feb 2026 over contamination and flawed tests
  ([decodethefuture roundup](https://decodethefuture.org/en/ai-agent-benchmarks-2026/), secondary).
- **Action-level selective verification** instead of trajectory-level best-of-N: a 4B verifier (Qwen3.5-4B) scores
  each proposed agent action, samples alternatives only when the score is low, and ranks them before execution. It
  verified **<4% of steps**; SWE-bench Verified (mini-swe-agent, 500 tasks) MiniMax-M2.7 **75.47% to 77.20% at 1.09x
  cost**, DeepSeek-V4-Flash **72.60% to 74.27% at 1.13x** (the verifier never trained on DeepSeek's actions). Authors
  claim equal or better than trajectory-level and all-step baselines at lower cost (baseline numbers not in abstract).
  [abstract] — [Zou et al., SWE-Verifier, arXiv 2610.30284, 2026-10](https://arxiv.org/abs/2610.30284). Harness: a
  cheap per-step gate on risky actions (writes, deploys, deletes) is a far cheaper accuracy lever than N full
  trajectories; DeepSeek V4 Flash is one of the harness's providers and was tested here.

**Debate / discussion**
- "The Cost of Consensus" (2026-04, ACM CAIS): 10 agents, 3 rounds, homogeneous teams of Qwen2.5-7B, Llama-3.1-8B or
  Ministral-3-8B on GSM-Hard and MMLU-Hard. Debate used **2.1-3.4x the tokens of isolated self-correction (up to 28,631
  tokens per problem) for equal or lower accuracy**; agents adopted the majority answer at rates up to **85.5%**; peer
  rationales destabilised previously correct reasoning in up to **70.0%** of cases; plurality voting discarded correct
  answers already in the pool, an **oracle gap of up to 32.3 points**. [abstract] —
  [Bertalanič and Fortuna, arXiv 2605.00914](https://arxiv.org/abs/2605.00914). Small open models only; extends,
  does not overturn, "Debate or Vote" (already in coordination-evidence.md).

**Mixture-of-Agents (layered propose-aggregate)**
- Original MoA, open-source models only, layered proposers + aggregator: AlpacaEval 2.0 **65.1% vs 57.5% for GPT-4o**.
  Not compute-matched (many calls per answer); open-ended chat quality judged by GPT-4. **[older, 2024-06]** —
  [Wang et al., arXiv 2406.04692](https://arxiv.org/abs/2406.04692). Superseded in part by Self-MoA (2025, in
  coordination-evidence.md): sampling the single best model and aggregating beats mixing in weaker models.

**Hierarchical / recursive decomposition and map-reduce over large inputs**
- Recursive Language Models (RLM; MIT, v3 2026-05): the long input is a variable in a Python REPL; the model inspects,
  splits and recursively calls (sub-)models on pieces. GPT-5 root with GPT-5-mini sub-calls, score (mean cost/query):
  - BrowseComp-Plus (1K docs): base GPT-5 **0.0** (context overflow); CodeAct+BM25 51.0 ($0.71); compaction agent 70.5
    ($0.57); RLM depth 0 (REPL, no sub-calls) 88.0 ($0.44); **RLM depth 1 91.3 ($0.99)**; depth 2-3 92.0 ($0.51-0.55).
  - OOLONG (131K): base 44.0 ($0.14); compaction 46.0; RLM depth 1 56.0 ($0.43); depth 3 58.0.
  - OOLONG-Pairs (pairwise aggregation, F1): base **0.1**; compaction 0.1; CodeAct+sub-calls 28.4 ($1.11); RLM depth 1
    58.0 ($0.33); **depth 3 76.0 ($0.39)**.
  - CodeQA: base 24.0; RLM depth 2 66.0, but **depth 3 fell to 58.0** (deeper is not monotonically better).
  - Claude Code on Opus 4.1: OOLONG-Pairs 0.1 at **$6.75/query**; with context offloading 6.5 at $2.99; OOLONG 48.0
    with offloading.
  Abstract-level medians: +26% vs compaction, +130% vs CodeAct with sub-calls, +13% vs Claude Code, at "comparable"
  cost; RLM-Qwen3-8B +28.3% over base Qwen3-8B. — [Zhang, Kraska, Khattab, arXiv 2512.24601](https://arxiv.org/abs/2512.24601);
  tables from [HTML v3](https://arxiv.org/html/2512.24601v3). Harness: for "read a whole corpus / repo / data room"
  tasks, a context-as-variable sub-call pattern (depth 1-2) beats both one huge context and summarise-then-answer;
  the done criterion should check coverage of the corpus, not the prose.
- Chain-of-Agents (sequential workers each read a chunk and pass notes; a manager answers): up to **+10%** over RAG,
  full-context and multi-agent baselines on long-context QA, summarisation and code completion. **[older, 2024-06,
  NeurIPS 2024]** — [Zhang et al., arXiv 2406.02818](https://arxiv.org/abs/2406.02818). Largely superseded for strong
  models by RLM-style programmatic decomposition (RLM's compaction/summarise baselines lose badly on pairwise
  aggregation, above).
- As-needed decomposition (ADaPT: try the task; decompose only the part that fails, recursively): success **+28.3%
  ALFWorld, +27% WebShop, +33% TextCraft** over plan-first or execute-only baselines. **[older, 2023-11, NAACL 2024]**
  — [Prasad et al., arXiv 2311.05772](https://arxiv.org/abs/2311.05772). Harness: "attempt, then split on failure" is a
  cheap default for the orchestrator instead of up-front fan-out.

**Budget-aware single agent (the strongest equal-cost baseline to beat)**
- Google BATS (COLM 2026). With a 100-calls-per-tool budget, plain ReAct agents **do not use the budget**: Gemini 2.5
  Pro averaged **14.2 searches and 1.4 page visits** per BrowseComp question even when allowed 100, and accuracy only
  moved 10.3% -> 10.5% -> 12.6% for budgets 10 -> 30 -> 100. Adding a "Budget Tracker" (remaining budget shown each
  turn) at budget 10 **matched ReAct at budget 100 (12.8%) with 31.3% lower cost**. BATS (budget-aware planning
  checklist + SUCCESS/CONTINUE/PIVOT verification + new attempts with leftover budget + judge picks among verified
  answers): BrowseComp Gemini 2.5 Pro **12.6 -> 24.6**, BrowseComp-ZH 31.5 -> 46.0, HLE-Search 20.5 -> 27.0; Claude
  Sonnet 4 12.2 -> 19.1 / 29.1 -> 41.5 / 20.5 -> 29.0. Ablation (early-stop variant, Gemini 2.5 Pro BrowseComp): full
  18.7, without planning 17.0, without verification 15.4, without both 14.6. Training-free. —
  [Liu et al., arXiv 2511.17006 v2](https://arxiv.org/abs/2511.17006); numbers from
  [HTML v2](https://arxiv.org/html/2511.17006v2). Harness: before adding agents, show every agent its remaining
  budget and let it re-attempt with leftover budget after a verified answer; that alone roughly doubled accuracy here.

**Automated topology search**
- MaAS (agentic supernet that samples a query-specific multi-agent graph): beats handcrafted and automated MAS by
  **0.54-11.82%** while using **6-45%** of their inference cost (math, code, tool benchmarks). **[2025-02, ICML 2025]**
  — [Zhang et al., arXiv 2502.04180](https://arxiv.org/abs/2502.04180). Harness: per-query choice of "how many agents,
  which pattern" (including "none") is where cost savings come from; a fixed big graph for every request wastes money.

**Society of mind (large free-form groups)**
- "Natural-language societies of mind" ran groups of up to **129** model and tool members on VQA, image generation and
  other multimodal tasks, reported mostly qualitatively. **[older, 2023-05]** —
  [Zhuge et al., arXiv 2305.17066](https://arxiv.org/abs/2305.17066). No equal-compute evidence; superseded in practice
  by the scaling studies in section 2.

### Inferences
- Rank of evidence for accuracy-per-dollar, strongest first: verifier-gated selection with an executable check >
  budget-aware single agent with planning + verification > recursive decomposition for over-long inputs >
  heterogeneous candidates + selector > homogeneous voting > MoA-style aggregation > debate. Hub-and-spoke "swarm"
  chat without a verifier sits at or below a single agent with strong models (coordination-evidence.md).
- The recurring number to design around is the oracle-to-selected gap: 6.2 points (best-of-3 SWE-bench), up to 32.3
  points (plurality in debate), and in section 3 voting beats the best member in only ~10% of ensembles even though
  the oracle gain is positive in 100%. A swarm's accuracy ceiling is set by the selector, not the number of workers.
- Harness design consequence: a "swarm" mode should be *generate independently -> verify with a harness-run check ->
  select*, with the clean-context verifier as the selector, rather than agents talking to each other.
- Computed cost per correct answer from the RLM table (mean cost / accuracy): BrowseComp-Plus compaction $0.81, RLM
  depth 1 $1.08, CodeAct+BM25 $1.39; so the most accurate method was not the cheapest per correct answer, but it was
  cheaper than the weaker agentic baseline. From BATS Table 2: ReAct at budget 100 = 9.9c / 12.6% = ~79c per correct;
  Budget Tracker at budget 10 = 6.8c / 12.8% = ~53c (my arithmetic, not the authors').

### Gaps
- No 2026 paper found that compares, at matched dollars on the same agentic tasks, best-of-N + verifier vs
  orchestrator-worker vs debate vs MoA in one study; comparisons are stitched across papers with different models.
- MoA has no published 2026 equal-compute agentic evaluation that I found; its evidence is chat-quality benchmarks.
- SWE-Verifier's trajectory-level baseline numbers and ScaleMAS's numbers were not in the abstracts read.

## 2. Scaling: what happens as the number of agents grows (10, 100, 1000)?

### Takeaway
Homogeneous agents saturate early (often by 4-16) and frequently turn down (inverted U), because extra agents add
correlated samples plus coordination and reading overhead. Gains continue longer only when (a) agents are genuinely
diverse, (b) each agent's reads are bounded (search over a shared store, not broadcast chat), or (c) a verifier selects.
There is no measured evidence of accuracy gains on real high-stakes tasks at 1,000 agents; claims at 100-300 agents are
vendor results on wide search tasks where the gain is mainly wall-clock and breadth.

### Cited Findings
- "More Agents Is All You Need": plain sampling-and-voting accuracy rises with the number of agents, orthogonally to
  other prompting methods, and the gain grows with task difficulty. **[older, 2024-02, TMLR 2024]** —
  [Li et al., arXiv 2402.05120](https://arxiv.org/abs/2402.05120). Partly superseded: see the next three items.
- "Are More LLM Calls All You Need?": Vote and Filter-Vote accuracy can **first rise then fall** as the number of calls
  grows, because more calls help easy queries and hurt hard ones (where the wrong answer is the modal one); the optimal
  number of calls can be predicted from a small sample. **[older, 2024-03, NeurIPS 2024]** —
  [Chen et al., arXiv 2403.02419](https://arxiv.org/abs/2403.02419). Harness: on hard questions, voting more confirms
  the common mistake; difficulty should decide whether to vote at all.
- MacNet (agents arranged in DAGs) supported **>1,000 agents**; performance follows a **logistic** curve in agent count
  (rises, then flattens); irregular (small-world-like) topologies beat regular ones; "collaborative emergence" appears
  earlier than neural-scaling emergence. **[older, 2024-06, ICLR 2025]** —
  [Qian et al., arXiv 2406.07155](https://arxiv.org/abs/2406.07155). Saturation point and token cost not in abstract;
  tasks are older code/reasoning benchmarks.
- Diversity vs count (2026-02): Qwen-2.5-7B, Llama-3.1-8B, Mistral-7B on 7 QA/reasoning sets, agent counts 2-16,
  **compute matched by number of agent calls**. Homogeneous Vote at N=16: **65.34%** (peak 65.49%); homogeneous Debate
  N=16: 65.48%. Model + persona diversity reaches that level with **N=2 (67.71% Vote, 67.90% Debate)** and peaks at
  **76.86% (Vote) / 77.43% (Debate)**. Model-only diversity matches homogeneous-16 at N=4 (peak ~71.5%); persona-only
  diversity needs N=8-12 and peaks ~66%. Homogeneous scaling sometimes *declines* with N. —
  [Yang et al., arXiv 2602.03794](https://arxiv.org/abs/2602.03794); table from
  [HTML v1](https://arxiv.org/html/2602.03794v1). They propose K*, a label-free estimate of "effective channels".
  Caveat: small open models; see section 3 for the capability confound.
- Fudan "Scaling Behavior of Single LLM-Driven MAS" (2026-05): one shared model, sequential iterative communication;
  performance is **non-monotonic in agent count** (diminishing returns, then decline), driven by **coordination
  overhead rather than long-context failure**; a sufficiently capable base model is required; the optimal count depends
  strongly on task type; the trend generalises to debate topologies. [abstract] —
  [Li et al., arXiv 2606.00655](https://arxiv.org/abs/2606.00655). A search summary added that token cost grows
  roughly quadratically and that logical-reasoning tasks lost accuracy while fact retrieval fared better **[snippet,
  not verified in the abstract]**.
- ScaleMAS (Qi, Lakkaraju, Yih, Du et al., 2026-10; affiliations not on the abstract page): asynchronous agents publish to a shared datastore of linked
  messages and read only via bounded search (top-k by relevance and citation count) or by address; claims continued
  improvement **up to 128 agents**, better than agent-centric (orchestrator, peer messaging, fixed workflows) and
  blackboard baselines at lower inference compute, and tolerance of agents dropping out. Diagnoses three causes of
  diminishing returns in prior MAS: **reading burden that grows with group size, useful information diluted by
  shared work of unknown quality, fragility when agents fail**. [abstract, no numbers] —
  [Qi et al., arXiv 2610.16120](https://arxiv.org/abs/2610.16120). Harness: if the harness ever runs more than ~8
  concurrent workers, give them a bounded-read shared store (search with k cap, quality signal) rather than broadcast
  messages or a full blackboard dump into every context.
- Moonshot Kimi K2.6 Agent Swarm (open weights, 2026-04-20): up to **300 parallel sub-agents** and **4,000 coordinated
  steps** (K2.5: 100 and 1,500), trained with Parallel-Agent RL. Kimi's help page reports BrowseComp **15.9% single
  agent vs 33.3% swarm** and **3-4.5x fewer critical-path steps** in large-scale search. **[vendor; benchmark variant
  and settings not stated; secondary reports]** —
  [Kimi help: K2.6 Agent Swarm](https://www.kimi.com/it-it/help/agent/agent-swarm);
  [Verdent guide](https://www.verdent.ai/guides/what-is-kimi-k2-6) (secondary). The harness has Moonshot as a
  provider; a trained swarm is a model feature, not something the harness's orchestration reproduces.
- Correlated failures at scale: a 2026 preprint reports that reasoning models (o1, o3-mini, Claude 3.7 Sonnet Thinking,
  DeepSeek-R1) show **higher pairwise error correlation** than 2024 non-thinking models across 11,710 task instances,
  and that a **9-agent SWE-bench consensus raised failure from 59.4% to 67.4%**. **[snippet; Zenodo deposit, not peer
  reviewed]** — [Zenodo record 22310662](https://zenodo.org/records/22310662).
- Already in coordination-evidence.md (not repeated): Google's 180-configuration study (gains vanish above ~45%
  single-agent accuracy; error amplification by topology), CAID (8 engineers worse than 4), Cursor (20 agents at the
  throughput of 2-3).

### Inferences
- For the harness, the useful range for *accuracy* is small: 2-5 independent candidates (diverse where possible) plus a
  selector; 3-8 workers for breadth tasks. Past ~10 the evidence says returns are flat or negative unless reads are
  bounded and outputs are verified before others can read them.
- "100 agents" results (Kimi) are on wide search with a trained orchestrator, and report speed and breadth. They do not
  show accuracy gains for deep, dependent, high-stakes work; treat them as a latency feature.
- An explicit concurrency cap and an "effective diversity" check (do candidates actually differ?) should come before
  any feature that raises agent count.

### Gaps
- No controlled study found with real agentic tasks at 1,000 agents and matched budget; MacNet (2024) is the only
  >1,000-agent accuracy study and uses older tasks.
- Exact peak agent counts and cost curves in 2606.00655 and 2610.16120 were not available in the abstracts.

## 3. Heterogeneous model mixing across providers: does diversity beat one strong model?

### Takeaway
Mixing model families helps when the members are of **comparable strength** and their errors are **not** shared;
adding weaker models drags results down, and much of what looks like a "diversity" gain is a capability effect. Errors
of strong models from different providers are increasingly correlated, so cross-provider voting is not independent
evidence. Cross-family *verification* is worth doing because same-family judges inflate their own family by several
points, but it does not remove shared blind spots.

### Cited Findings
- Model diversity at matched calls (section 2): 2 diverse 7-8B models matched 16 homogeneous ones; model diversity
  contributed far more than persona diversity (peak ~71.5% vs ~66%; both combined ~77%). —
  [arXiv 2602.03794](https://arxiv.org/html/2602.03794v1).
- Capability-controlled audit (2026-07): 31,900 subsets of 30 LLMs on MMLU-Pro (+29 on TruthfulQA). The oracle (any
  member right) beat the best member in **100%** of subsets, but simple majority voting beat the strongest member in
  only **9.98%** of size-3 subsets (**18.71%** with held-out best-member selection; 1.27% pooled over sizes 2-4).
  Diversity metrics were nearly collinear with mean accuracy (Spearman rho +0.991) and mostly re-express capability;
  after capability controls only a weak signal remains (more shared errors -> lower gain). [abstract] —
  [Kim, arXiv 2607.20768](https://arxiv.org/abs/2607.20768). Harness: a cross-provider *vote* usually loses to just
  using the best member; the value of mixed providers is in candidates for a *selector*.
- Correlated errors (ICML 2025): across **350+ LLMs**, when two models both err they **agree on the same wrong answer
  ~60%** of the time on one leaderboard dataset; correlation is driven by shared architecture and provider, and
  **larger, more accurate models have highly correlated errors even across different architectures and providers**. —
  [Kim, Garg, Peng, Garg, arXiv 2506.07962](https://arxiv.org/abs/2506.07962).
- "Great Models Think Alike" (CAPA similarity metric): LLM judges favour models similar to themselves beyond what
  accuracy explains, and mistakes become **more similar as capability rises**, which undermines AI oversight by
  similar models. **[2025-02]** — [Goel et al., arXiv 2502.04313](https://arxiv.org/abs/2502.04313).
- Family-conditioned judge preference (2026-09): 4 open families (Llama 3.1, Qwen 2.5, Gemma 2, Yi 1.5), 9,312 fully
  crossed pairwise judgments: every family shows a **same-family lift of 3.4-8.4 points** (FPS 0.067, 95% CI
  0.053-0.084, p=0.0002) even when not judging its own outputs; adding judge-side likelihood cuts the coefficient
  **61%** (familiarity is much of it); **55.4%** of AB/BA pairs flip when order is swapped; panel composition alone
  changes **18.5%** of pairwise outcomes vs a family-balanced panel. [abstract] —
  [Awuni et al., arXiv 2609.17857](https://arxiv.org/abs/2609.17857). Harness: the clean-context verifier should be
  from a different family than the producer where a comparably strong one exists (e.g. Sonnet output checked by
  GLM/Kimi/GPT, or the reverse), and pairwise comparisons must be run in both orders.
- X-MAS-Bench (27 LLMs, 5 domains, 21 test sets, 1.7M evaluations): picking the best model per role/function instead
  of one model everywhere gave **up to +8.4% on MATH** (chatbot-only MAS) and **up to +47% on AIME** (mixing chatbots
  with reasoning models), without changing the MAS structure. **[2025-05]** —
  [Ye et al., arXiv 2505.16997](https://arxiv.org/abs/2505.16997). Harness: per-role model choice (planner, worker,
  verifier) is a cheaper diversity lever than more agents.
- ReConcile (round-table of ChatGPT, Bard, Claude 2 with confidence-weighted voting): **up to +11.4%** over single- and
  multi-agent baselines, beating GPT-4 on three datasets. **[older, 2023-09, ACL 2024]** —
  [Chen, Saha, Bansal, arXiv 2309.13007](https://arxiv.org/abs/2309.13007). Superseded for frontier models by Self-MoA
  (mixing helps only among comparable models).
- Adversarial / corrupted members: 5-agent heterogeneous ensemble with three corrupted 70B models and two clean 8B
  models: majority voting fell to **13.0%**; a token-level round-robin collaboration recovered **78.7%**; weak truthful
  agents could rescue strong corrupted ones but not the reverse. [snippet] —
  [The Consensus Trap, arXiv 2604.17139](https://arxiv.org/html/2604.17139v1). Harness: if any member can be
  prompt-injected (tool output, web pages), majority vote is a liability; the selector must weigh evidence.

### Inferences
- Cross-provider mixing in the harness should be used for (1) a verifier from another family, (2) a small set of
  diverse candidates for a selector on tasks with checkable outcomes, (3) per-role model choice. It should not be used
  for majority voting among frontier models, whose errors overlap.
- With the harness's providers, "comparably strong" pairs matter: mixing a frontier model with a much weaker flash
  model in a vote will lower accuracy (Self-MoA, already covered); a weak model is still useful as a cheap verifier or
  dissenter only if its role is to flag, not to outvote.
- Cost per correct answer for a mixed ensemble = sum of member costs / ensemble accuracy; given the audit's ~10% win
  rate for voting, most ensembles cost N times more per correct answer than the best single member.

### Gaps
- No 2026 study found that measures cross-provider ensembles of *current frontier agentic models* (Claude, GPT, Kimi,
  GLM, DeepSeek) on agentic tasks at matched dollars.
- No measurement found of family bias between the specific providers the harness uses (e.g. does GLM favour Kimi?).

## 4. Failure taxonomies beyond MAST: propagation, conformity, collusion, handoff loss, context pollution

### Takeaway
New 2026 work quantifies what MAST described: peers' answers induce conformity (up to 85.5% adoption) and destroy
correct reasoning (up to 70%); one injected error spreads to whole groups in a few rounds in mesh topologies; handoffs
lose the *constraints* attached to facts; recursive systems spread sub-call errors and can run away on cost. Reviewer or
QA agents inside the same message stream do not reliably stop cascades; provenance tracking and isolation do.

### Cited Findings
- Conformity in debate: majority adoption up to **85.5%**, correct reasoning destabilised in up to **70.0%** of cases,
  oracle gap up to **32.3 points**; conformity is high even with only 2 neighbours and grows with initial diversity.
  [abstract] — [arXiv 2605.00914](https://arxiv.org/abs/2605.00914).
- Measurement caveat: with GPT-4o, **37%** of agent-question pairs change answer even *without* peer information, so
  answer flips overstate conformity; the paper separates strict conformity from reasoned adoption. [snippet] —
  ["Not All Flips Are Conformity", arXiv 2606.00820](https://arxiv.org/html/2606.00820v2).
- Sycophancy propagation: unconstrained interaction amplifies sycophancy and agents converge on incorrect,
  user-aligned positions; telling agents their peers' sycophancy levels gave a **+10.5-point** absolute gain in one
  setting. [snippet] — ["Too Polite to Disagree", arXiv 2604.02668](https://arxiv.org/html/2604.02668v1).
- Biased consensus as a phase transition: a collective bias appears once conformity passes a critical threshold set by
  the models' initial bias and debate noise. [snippet] —
  ["Emergence of Biased Consensus", arXiv 2608.02827](https://arxiv.org/html/2608.02827).
- Error cascades ("From Spark to Fire", six MAS frameworks modelled as dependency graphs): three vulnerability classes,
  **cascade amplification, topological sensitivity, consensus inertia**; a single atomic error can solidify into
  system-wide false consensus; a genealogy-graph (provenance) governance layer at the message level **prevented final
  infection in >=89% of runs** without changing the architecture. [abstract] —
  [Xie et al., arXiv 2603.04474](https://arxiv.org/abs/2603.04474). A blog summary adds that in mesh topologies
  (AutoGen, Camel) one injected false claim reached **100% adoption by round 3** and that role-based checking (reviewer,
  QA agents) failed because those agents were infected too **[secondary blog]** —
  [danilchenko.dev summary](https://www.danilchenko.dev/posts/2026-04-01-error-cascades-multi-agent-llm-systems/).
  Harness: the reviewer must not read the members' conversation, only artifacts plus original sources (the existing
  clean-context verifier design is the right one); record which agent produced each claim.
- Factual decay in chains: claim-level accuracy drops a little per sequential hand-off and more over a 3-agent chain;
  suppressing errors aggressively can also lower factual accuracy. [snippet] —
  ["Hallucination Cascade", arXiv 2606.07937](https://arxiv.org/html/2606.07937v1).
- Handoff constraint loss ("boundary metadata collapse"): a downstream agent that receives a fact without its governing
  marker (e.g. confidential, do-not-use-for-X) cannot know a restriction applied; leaks rose from **2-3 of 48** tasks at
  5% label error to **11-15 of 48** at 30%, with task success >=0.979; direct full-marker access still leaked more than
  an operationalised handoff. [snippet] — ["Facts Without Rules", arXiv 2608.29028](https://arxiv.org/html/2608.29028v1).
  Harness: briefs and results should carry constraints as structured fields the harness enforces, not prose the lead
  may summarise away.
- Recursive-call failures (RLM): without a prompt warning, Qwen3-Coder issued **thousands of sub-calls** on basic tasks;
  syntax errors at higher depth propagated into sub-calls; the first decomposition strongly affected outcomes; mean cost
  exceeded median because of a long tail of runs that struggled (e.g. OOLONG depth 2: $1.10 +/- $3.25); final-answer
  tags were misused. — [arXiv 2512.24601 v3](https://arxiv.org/html/2512.24601v3). Harness: depth and sub-call caps,
  spend caps per subtree, and a structured final-answer channel rather than text tags.
- Context pollution: with the full input in context, base GPT-5 scored **0.0** on BrowseComp-Plus (1K docs) and **0.1
  F1** on OOLONG-Pairs; Claude Code (Opus 4.1) scored 0.1 on OOLONG-Pairs at $6.75/query; offloading context to files
  raised Claude Code to 62.0 on CodeQA and 84.0 on BrowseComp-Plus. — [arXiv 2512.24601 v3](https://arxiv.org/html/2512.24601v3).
- Collusion: models can hide information in innocuous-looking messages (steganographic collusion), and capability for
  it rises with model scale; paraphrasing and monitoring reduce but do not remove it. **[older, 2024-02, NeurIPS 2024]**
  — [Motwani et al., "Secret Collusion among AI Agents", arXiv 2402.07510](https://arxiv.org/abs/2402.07510). A broader
  taxonomy groups multi-agent risks into **miscoordination, conflict and collusion** with seven risk factors
  (information asymmetries, network effects, selection pressures, destabilising dynamics, commitment problems,
  emergent agency, multi-agent security). **[2025-02]** —
  [Hammond et al., Cooperative AI Foundation, arXiv 2502.14143](https://arxiv.org/abs/2502.14143). No measured
  collusion rates in production-style agent teams were found.
- Adversarial majority: see section 3 (majority voting 13.0% vs 78.7% with token-level collaboration).

### Inferences
- For high-stakes work, the defaults that follow are: independent generation before any exposure to peers' answers;
  the verifier sees artifacts and sources, never the debate; provenance on every claim; constraints carried as data;
  caps on depth, sub-call count and subtree spend.
- Debate-style "let the agents argue" features would import every failure listed here; the evidence favours
  isolation + verification over interaction for accuracy.

### Gaps
- Several 2026 papers were seen only as titles or snippets: "Most LLM Conformity Needs No Speaker" (arXiv 2607.05545),
  "Group Perspective Matters" (arXiv 2608.03648), "What Does Multi-Agent LLM Debate Actually Change?" (arXiv
  2609.08016), "Diversity Collapse in Multi-Agent LLM Systems" (arXiv 2604.18005); their numbers are not reported here.
- No 2026 update of MAST frequencies on current frontier models was found.

## 5. Planning and task decomposition for long, high-stakes tasks

### Takeaway
The measured wins come from making budgets visible and enforced (agents otherwise under-use or blow budgets), from
verifying intermediate answers and re-attempting with leftover budget, from decomposing only when an attempt fails, and
from stopping rules tied to agreement or verification. Planning quality is decided by the first decomposition and by
whether every dependency gets assigned; replanning should be triggered by verification outcomes, not on a timer.

### Cited Findings
- Budget awareness: agents with a 100-call budget used ~14 searches; a visible budget tracker at budget 10 matched
  budget 100 at 31.3% lower cost; BATS's plan + verify + pivot loop roughly doubled BrowseComp accuracy (12.6 -> 24.6,
  Gemini 2.5 Pro); removing planning cost 1.7 points and removing verification 3.3 points (early-stop variant).
  Context is compressed to a summary every 10 iterations; the loop ends when any tool budget is exhausted and a judge
  picks the best verified answer. — [arXiv 2511.17006 v2](https://arxiv.org/html/2511.17006v2).
- BAGEN (2026-05): proposes that agents predict upper/lower bounds on remaining cost at each planning step and alert
  when completion is unlikely; finds **stronger agents are not necessarily more budget-aware**. [abstract/snippet] —
  [arXiv 2606.00198](https://arxiv.org/abs/2606.00198). Harness: budget estimation cannot be left to the model's
  strength; the harness should meter and inject remaining budget.
- Agent Contracts (2026-01): a formal framework of resource-bounded agents in which **resources allocated to subtasks
  cannot exceed the parent's** (conservation across the delegation tree). [snippet] —
  [arXiv 2601.08815](https://arxiv.org/html/2601.08815v1). INTENT (2026-02) prunes any plan branch whose action cost
  exceeds the remaining budget. [snippet] — [arXiv 2602.11541](https://arxiv.org/html/2602.11541v1). A 2026 survey
  describes a shift to allocating tokens by task difficulty and subtask criticality. [snippet] —
  [Token Economics for LLM Agents, arXiv 2605.09104](https://arxiv.org/html/2605.09104v1).
- As-needed decomposition (ADaPT): +27 to +33 points over plan-first or execute-only on three interactive benchmarks.
  **[older]** — [arXiv 2311.05772](https://arxiv.org/abs/2311.05772).
- First-decomposition sensitivity: in RLM the first decomposition attempt strongly affected results (though runs often
  recovered); deeper recursion helped aggregation (OOLONG-Pairs 58.0 -> 76.0 from depth 1 to 3) but hurt CodeQA
  (66.0 -> 58.0 from depth 2 to 3). — [arXiv 2512.24601 v3](https://arxiv.org/html/2512.24601v3).
- Stopping rules for sampling: Adaptive-Consistency stops drawing samples once agreement is statistically settled,
  cutting the sample budget **up to 7.9x** with **<0.1%** average accuracy loss. **[older, 2023-05, EMNLP 2023]** —
  [Aggarwal et al., arXiv 2305.11860](https://arxiv.org/abs/2305.11860). Combined with the non-monotonic result in
  section 2 ([arXiv 2403.02419](https://arxiv.org/abs/2403.02419)), stopping should also trigger on detected hardness,
  where more votes entrench the modal error.
- Dependency coverage: a manager that never assigned a critical dependency scored 8.7% vs 34.3% on the same repo
  (CAID, already in coordination-evidence.md) — the planning failure that matters most in long tasks is an unassigned
  dependency, not a poorly worded subtask.
- Trained orchestrators: Kimi's swarm training needed penalties for "serial collapse" (orchestrator does everything
  itself) and "spurious parallelism" (already in coordination-evidence.md); K2.6 raises the limits to 300 sub-agents and
  4,000 steps **[vendor]** — [Kimi help page](https://www.kimi.com/it-it/help/agent/agent-swarm).

### Inferences
- For the harness: (1) meter tokens, tool calls and dollars per sub-agent and inject "remaining budget" into each
  turn; (2) enforce child budget <= parent's remaining budget at spawn; (3) let an agent that reaches a verified answer
  early either stop or spend leftover budget on an independent second attempt for the selector (BATS); (4) represent
  the plan as a dependency graph and have the harness check that every node is assigned and every leaf has a done
  criterion before execution; (5) re-plan on a failed done criterion (ADaPT-style), not on a schedule; (6) cap
  recursion depth at 2 by default with a per-subtree spend cap.
- Stopping rule for parallel candidates: stop when the verifier passes one candidate (executable criteria) or when k
  agreeing candidates are found on easy items; escalate to a stronger model rather than more samples when candidates
  disagree widely (a hardness signal).

### Gaps
- No controlled study found that measures plan quality itself (e.g. plan-graph completeness) against final accuracy on
  long, high-stakes tasks with current models.
- No published optimal rule for splitting a token budget across subtasks of unequal criticality; current work is
  frameworks and surveys, not measured allocation policies.

## 6. Cost/accuracy trade-offs: token multipliers, cost per solved task, cascades and routing

### Takeaway
Multi-agent accuracy gains usually cost 2-15x tokens (already documented), while the cheapest measured accuracy levers
are selective verification (~1.1x cost for ~+1.7 points), budget awareness (lower cost at equal accuracy), and
verifier-gated cascades from a cheap model to a strong one. Reporting cost per correct answer, with the mean and the
tail, changes which architecture wins.

### Cited Findings
- Debate vs isolated self-correction: 2.1-3.4x tokens (up to 28,631 per problem) for equal or lower accuracy. —
  [arXiv 2605.00914](https://arxiv.org/abs/2605.00914).
- Selective action verification: +1.7 points on SWE-bench Verified at **1.09-1.13x** cost, verifying <4% of steps. —
  [arXiv 2610.30284](https://arxiv.org/abs/2610.30284).
- Budget Tracker: equal accuracy at **31.3% lower cost** (budget 10 vs 100); BATS pushes the cost-accuracy Pareto
  frontier outward (curves only graphical). Tool calls priced at $0.001 each in their unified cost. —
  [arXiv 2511.17006 v2](https://arxiv.org/html/2511.17006v2).
- Recursive decomposition: median RLM run cheaper than the median base-model run, but mean higher because of outliers;
  per-query costs $0.11-$1.10 for GPT-5 RLM vs $2.03-$6.75 for Claude Code (Opus 4.1) on the same tasks. —
  [arXiv 2512.24601 v3](https://arxiv.org/html/2512.24601v3).
- Topology search: MaAS beat fixed MAS at **6-45%** of their inference cost. — [arXiv 2502.04180](https://arxiv.org/abs/2502.04180).
- Cascades: FrugalGPT (sequential cascade with a learned scorer that decides whether to accept an answer or escalate)
  matched GPT-4 with **up to 98% cost reduction**, or beat GPT-4 by 4% at equal cost. **[older, 2023-05]** —
  [Chen, Zaharia, Zou, arXiv 2305.05176](https://arxiv.org/abs/2305.05176). RouteLLM (router trained on preference
  data, decides before generation) cut cost **>2x** without quality loss on some benchmarks. **[older, 2024-06]** —
  [Ong et al., arXiv 2406.18665](https://arxiv.org/abs/2406.18665). Unified routing + cascading ("cascade routing")
  outperforms either alone. **[2024-10, ICML 2025]** — [Dekoninck et al., arXiv 2410.10347](https://arxiv.org/abs/2410.10347).
  CRE-Router (2026) argues routing (before generation) and escalation (after, catching errors routing cannot predict)
  are complementary. [snippet] — [arXiv 2606.27457](https://arxiv.org/pdf/2606.27457). A 2026 survey covers dynamic
  routing and cascading. — [arXiv 2603.04445](https://arxiv.org/pdf/2603.04445).
- Small model + search vs large model: Llemma-7B with tree search outperformed Llemma-34B on MATH across inference
  strategies; smaller models with stronger inference algorithms were Pareto-optimal for a fixed compute budget.
  **[older, 2024-08]** — [Wu et al., "Inference Scaling Laws", arXiv 2408.00724](https://arxiv.org/abs/2408.00724).
- Practitioner cascade demo: a calibrated verifier-gated cascade reached **88.0% accuracy at $0.000231/query vs 93.5%
  at $0.000351 for strong-only** (94% of the accuracy at 34% lower cost). **[self-run demo, illustrative]** —
  [cascade repo](https://github.com/darrshangovender/cascade).
- Vendor advisor pattern (cheap executor + strong advisor) and multi-agent token multiples (~15x, 3-10x, ~7x for
  Claude Code agent teams) are already in coordination-evidence.md.
- Parallel test-time compute on SWE-bench: +6.9 points for Opus 4 (72.5 -> 79.4) **[vendor, 2025-05]** —
  [Anthropic](https://www.anthropic.com/news/claude-4); cost multiple not disclosed.

### Inferences
- Cascade arithmetic (mine): blended cost = cheap cost + verifier cost + escalation rate x strong cost. With the strong
  model at 5x the cheap one and 30% escalation, cost is 1 + 0.3 x 5 = 2.5 units vs 5 (half), before verifier cost; if
  the verifier costs as much as a strong generation, the cascade loses. The escalation rate must be logged and alarmed,
  since a drifting verifier silently escalates everything.
- For the harness, the order of cost-effective accuracy levers is: (1) budget visibility and verified early stop;
  (2) selective verification of risky steps; (3) cheap-first cascade with a harness-run done criterion as the gate,
  escalating to a stronger provider on failure; (4) 2-3 diverse candidates + verifier selection for checkable,
  high-value tasks; (5) orchestrator-worker fan-out only for breadth tasks or over-long inputs.
- Report per run: tokens, dollars, wall-clock, accuracy, **cost per correct answer**, and p90/max cost (RLM shows
  mean >> median), against a single-agent baseline at the same budget.

### Gaps
- No controlled 2026 head-to-head of cost per correct answer across cascade designs on agentic (multi-step, tool-using)
  tasks was found; cascade evidence is mostly single-call QA and older.
- No published cost multiples for Kimi K2.6 swarm runs or for parallel test-time compute on current Claude models.
