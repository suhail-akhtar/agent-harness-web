# Reliability engineering for high-stakes LLM agent systems: verification, calibration, abstention, measurement

Gathered 2026-11-02. Extends [docs/agents-mcp/research/verification.md](../../docs/agents-mcp/research/verification.md)
(reward hacking, the catalogue of check-gaming tricks, generator-verifier loops, judge failure modes such as
self-preference, position bias and framing, structured verdicts, check security, done-criteria contracts). Nothing
here repeats that note; where it already holds the evidence, it is referenced as "(see verification.md, section N)".

Conventions (same as verification.md):
- **[older]** marks results from before 2026, or on models released before 2025-H2.
- **(abstract)** means only the abstract or listing was read. **(secondary)** means the figure came from a search
  summary, mirror or third-party write-up, not the primary text.
- "Harness:" bullets under Inferences are design proposals (opinion), not findings. The harness is a TypeScript
  agent harness with harness-run done criteria, a clean-context verifier returning pass / fail / unknown, teams
  (lead, members, reviewer) and several model providers.

---

## 1. Reliability metrics: pass@k vs pass^k, consistency across runs, variance, and decay over long tasks

### Takeaway
Capability (pass@1, pass@k) and reliability (pass^k, run-to-run consistency, robustness to rephrasing) have diverged:
across 14 models released over 18 months, accuracy rose steadily while reliability improved only modestly, with
outcome consistency between 30% and 75%. Reliability also falls much faster with task length than the headline
50% horizon suggests (the 80% horizon is roughly 5-14x shorter), and any claim of very high reliability (99%+) rests
on tail extrapolations that differ by about 20x between plausible models. "No failure tolerated" can only be
claimed with explicit sample sizes and upper confidence bounds, and for rare failures it cannot be demonstrated by
testing alone.

### Cited Findings

**pass@k vs pass^k**
- tau-bench introduced pass^k, "the reliability of agent behavior over multiple trials"; gpt-4o-class
  function-calling agents solved fewer than half the tasks and had **pass^8 < 25% in retail**
  ([Yao, Shinn, Razavi, Narasimhan; arXiv 2406.12045, 2024-06](https://arxiv.org/abs/2406.12045)) **[older]** (abstract).
  pass^k is defined as the chance that all k i.i.d. trials of a task succeed, averaged over tasks; GPT-4o retail was
  ~61% pass@1 vs ~25% pass^8 (secondary: [search summary of the paper](https://arxiv.org/pdf/2406.12045)).
- No verified 2026 per-domain pass^4/pass^8 numbers for current frontier models were found; third-party
  leaderboards do not state domain or k, and a benchmark guide warns not to compare results unless domain, task
  release, user simulator, prompting, tools, trial count and the pass^k metric are all identified
  ([BenchLM tau-bench page](https://benchlm.ai/benchmarks/tau-bench)) (secondary).

**Consistency and variance (multi-dimensional reliability)**
- "Towards a Science of AI Agent Reliability" ([Rabanser, Kapoor, Kirgis, Liu, Utpala, Narayanan; ICML 2026, arXiv 2602.16666](https://arxiv.org/html/2602.16666v2)):
  12 metrics in four dimensions. Consistency: outcome (C_out), trajectory (distributional and sequential), resource
  (C_res). Robustness: fault, environment, prompt (each = perturbed accuracy / baseline accuracy, capped at 1).
  Predictability: calibration (ECE-based), discrimination (AUROC), Brier. Safety: compliance and harm severity
  (weights 0.25 / 0.5 / 1.0), reported separately, not averaged in. Protocol: GAIA (165 tasks) and a cleaned
  tau-bench airline subset (26 tasks), **K = 5 runs per task at temperature 0, J = 5 paraphrases, p_fault = 0.2**,
  14 OpenAI/Google/Anthropic models from early 2024 to late 2025 **[older models]**.
  - "Outcome consistency remains low across all models"; **30% to 75%** across models
    ([authors' blog, normaltech.ai](https://www.normaltech.ai/p/new-paper-towards-a-science-of-ai)).
  - Fault and environment robustness show ceiling effects (crashes and timeouts handled well); **prompt robustness
    drops "substantially"** when instructions are reworded with the same meaning and varies widely by model.
  - Predictability was the weakest dimension: on one benchmark "most models couldn't distinguish their correct
    predictions from incorrect ones better than chance"; discrimination improved on tau-bench but mostly worsened on
    GAIA; Claude models showed stronger calibration.
  - Scaling helps calibration and robustness but **can hurt consistency**. "Financial accuracy violations are the
    most prevalent failure mode" for safety.
  - Accuracy vs reliability: reliability improved only modestly while accuracy improved substantially; the authors
    say high-stakes autonomy needs "3-5 nines" (99.9% to 99.999%) and reject linear extrapolation because "each
    order-of-magnitude reduction in unreliability will be as hard as the last". Recommendation: automation needs a
    higher reliability bar than augmentation (human reviews output). Dashboard: hal.cs.princeton.edu/reliability.
- "Beyond pass@1" ([Khanal, Tao, Zhou; arXiv 2603.29231, 2026-03](https://arxiv.org/abs/2603.29231)) (abstract):
  10 models, **23,392 episodes**, 396 tasks in four duration buckets. Metrics: Reliability Decay Curve, Variance
  Amplification Factor, Graceful Degradation Score, Meltdown Onset Point. **Software-engineering GDS fell 0.90 to
  0.44** across duration buckets; document processing was nearly flat (0.74 to 0.71). Capability and reliability
  rankings invert at long horizons. **Frontier models had the highest "meltdown" rates, up to 19%** (ambitious
  multi-step strategies that spiral). Memory scaffolds lowered long-horizon performance for all 10 models.
- ReliabilityBench ([Gupta; arXiv 2601.06112, 2026-01](https://arxiv.org/abs/2601.06112)) (abstract): success fell
  **96.9% to 88.1%** under semantically equivalent task perturbations (epsilon 0 to 0.2); rate limiting was the most
  damaging injected fault. 1,280 episodes, Gemini 2.0 Flash and GPT-4o **[older models]**.
- "On the Reliability of Computer Use Agents" ([arXiv 2604.17849](https://arxiv.org/pdf/2604.17849)) uses paired
  statistical tests over repeated executions to detect per-task changes in consistency (secondary; not read).

**Nondeterminism (why a single run is a sample, not a measurement)**
- Temperature 0 is not deterministic on shared inference servers: Qwen3-235B, same prompt **1,000 times at
  temperature 0 gave 80 unique completions** (most common 78 times), first divergence at token 103; the cause is
  kernels that are not batch-invariant (server load changes batch size, which changes reduction order). With
  batch-invariant kernels all 1,000 were identical; cost on Qwen3-8B: **26 s default vs 42 s deterministic**
  (55 s unoptimised) ([He / Thinking Machines, "Defeating Nondeterminism in LLM Inference", 2025-09-10](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)) **[older]**.

**Decay with task length (METR time horizons, compounding error)**
- METR's original paper: 50% time horizon doubling about every 7 months; **80% horizons roughly 5x shorter** than
  50% horizons (e.g. Claude 3.7 Sonnet 59 min at 50% vs ~15 min at 80%)
  ([Kwa et al.; arXiv 2503.14499, 2025-03](https://arxiv.org/html/2503.14499v3)) **[older]** (figures via search summary,
  secondary).
- METR's page: "the trends for 50%- and 80%-time horizons are very similar"; Time Horizon 1.1 uses the same method
  with a larger task suite; **"Measurements above 16 hrs are unreliable with our current task suite"**
  ([METR time horizons](https://metr.org/time-horizons/)). Claude Opus 4.6 (Feb 2026): **50% horizon ~14 h 30 min,
  80% horizon ~1 h 03 min** (secondary: [Wikipedia mirror via search](https://wikwiand-revamp.pages.dev/en/METR)).
  For how cheating changes horizons (GPT-5.6 Sol 11.3 h vs >270 h), see verification.md section 1.1.
- Constant-hazard model: success on longer tasks fits a constant failure rate per human-minute, i.e. an exponential
  "half-life" equal to the 50% horizon ([Ord; arXiv 2505.05115, 2025-05](https://arxiv.org/abs/2505.05115v1)) **[older]**.
  Revised: hazard rates **decline** over a task; Weibull shape **k ≈ 0.6 for agents vs ≈ 0.37 for humans**, stable
  across generations; the Weibull and METR's log-logistic fit similarly but their **99% horizons differ by ~20x**
  (Weibull ≈ 1/20 of log-logistic); the 99% horizon is "deeply uncertain"
  ([Ord, "Hazard rates for AI agents decline", 2026-02-04](https://www.tobyord.com/writing/hazard-rates-for-ai-agents-decline)).

**Measuring "no failure tolerated" (safety-critical engineering)**
- Statistical testing cannot establish failure probabilities of 10^-7 to 10^-9 per hour; life testing is
  "prohibitively impractical", reliability-growth models do not remove the need for excessive testing, and
  independence of separately built versions "cannot be justified by experimentation in the ultrareliability region"
  ([Butler and Finelli, IEEE TSE 19(1), 1993; NASA NTRS full text](https://ntrs.nasa.gov/api/citations/20040139817/downloads/20040139817.pdf)) **[older]**.
- Aviation targets one catastrophic error per billion flight hours; nuclear protection systems must respond
  identically every time (reference points used by Rabanser et al.,
  [normaltech.ai](https://www.normaltech.ai/p/new-paper-towards-a-science-of-ai)).

### Inferences
- **pass^k measures within-task inconsistency.** If every task were either always solved or never solved, pass^k
  would equal pass@1 for every k; the gap between them is the share of tasks the agent solves only sometimes. With a
  uniform per-task success of 0.9, pass^8 = 0.9^8 = 0.43 (my arithmetic). For n trials with c successes per task, the
  unbiased estimate is C(c,k)/C(n,k), averaged over tasks (the same combinatorial form as the pass@k estimator).
- **Compounding.** Independent per-step success of 0.99 over 100 steps gives 0.99^100 = 0.37; 0.999 gives 0.90
  (my arithmetic). Ord's declining hazard (k < 1) says real agents are less bad than this on long tasks and worse on
  short ones, but the direction for high-reliability use is the same: the 99% horizon is minutes, not hours.
  Converting with Weibull k = 0.6: H80/H50 = (ln 0.8 / ln 0.5)^(1/0.6) ≈ 0.15 (≈ 6.6x shorter); H99/H50 ≈ 0.0009. For
  a 14.5 h 50% horizon that is roughly a **1 minute 99% horizon** (exponential model: ~13 min). The reported Opus 4.6
  80%/50% ratio (~1/14) is steeper still. These are extrapolations with ~20x model uncertainty (Ord), not
  measurements.
- **Zero observed failures is weak evidence.** With 0 failures in n i.i.d. trials, the 95% upper bound on the failure
  rate is 1 − 0.05^(1/n) ≈ 3/n ("rule of three"; standard binomial result). Claiming < 1% failure at 95% confidence
  needs ~300 consecutive clean runs on representative tasks; < 0.1% needs ~3,000 (my arithmetic). Butler and Finelli's
  point carries over: beyond ~10^-3 per task, reliability must be argued from structure (checks, independent
  verification, containment, human approval at irreversible points), not from test counts.
- **Report reliability as a vector, not a number.** A harness reliability report should carry: pass@1, pass^k (k ≥ 3),
  outcome consistency, prompt-paraphrase robustness, calibration/discrimination of whatever confidence signal is
  used, safety violations, and failure counts with upper confidence bounds, all split by task-length bucket and with
  "cheat = fail" accounting (see verification.md section 1.1).
- Harness:
  - A `reliability` eval mode that runs each task K times (default 5) and with J paraphrased briefs, records each
    outcome from the harness-run done criteria (not the agent's claim), and computes pass@1, pass^k (estimator above),
    outcome consistency, robustness ratios, Wilson or Clopper-Pearson intervals and the rule-of-three upper bound.
  - Store per-task duration (wall clock, steps, tokens) so decay curves can be drawn per agent and team; flag
    "meltdowns" (runs that exhaust step or spend limits while tool errors rise).
  - Treat any single run as a sample: the harness should never present one passing run as evidence an agent is
    reliable; the agent page should show "n runs, x failed, 95% upper bound y%".
  - Record whether the provider offers deterministic inference; where it does not, reproducibility comes from
    recording outputs (section 6), not from re-running.

### Gaps
- No primary 2026 pass^k figures for current frontier models (Opus 5.x, GPT-6.x, Gemini 3.x) on tau2/tau3-bench were
  found; the Rabanser et al. models end in late 2025.
- METR's per-model 50%/80% numbers for 2026 models were only seen in secondary sources (graph data not in the page
  text); METR has published no 95% or 99% horizon.
- The Khanal et al. effect sizes (VAF values, number of rank inversions, memory-scaffold penalty) are not in the
  abstract.
- No study was found that measures pass^k for multi-agent teams vs single agents on the same tasks.

---

## 2. Calibration and uncertainty: verbalized confidence, sampling-based uncertainty, conformal prediction, selective prediction

### Takeaway
Current agents mostly do not know when they are wrong: in the largest 2026 agent study, predictability was the
weakest reliability dimension (near-chance discrimination on one benchmark), an untrained agent's per-step
confidence was near chance at predicting episode failure, and reasoning fine-tuning made abstention 24% worse.
Sampling-based signals (semantic entropy, agreement across samples) work on short QA (AUROC ~0.78-0.81) but miss
"self-consistent" errors, which do not shrink with scale. Conformal methods are the only ones with distribution-free
guarantees, and they need a labelled calibration set from the same distribution. For a harness, confidence should
be a measured, calibrated quantity derived from agreement and checks, with thresholds set on the person's own
labelled runs, not a number the model states.

### Cited Findings

**How well do agents know when they are wrong?**
- Rabanser et al. (ICML 2026): predictability weakest; near-chance discrimination of correct vs incorrect on one
  benchmark; calibration improved in recent models ([arXiv 2602.16666](https://arxiv.org/html/2602.16666v2);
  [normaltech.ai](https://www.normaltech.ai/p/new-paper-towards-a-science-of-ai)) **[older models]**.
- "Can an Agent Learn to Predict Its Own Failure?" ([Hathidara; arXiv 2610.18614, 2026-10-13](https://arxiv.org/abs/2610.18614v1)) (abstract):
  step-confidence AUROC against episode outcome is **"near chance" before training** and **0.68-0.85 after offline RL**
  (Qwen2.5-7B; ALFWorld, TextWorld, WebShop); online RL cut **ECE from 0.42 to below 0.12** without hurting task
  success; the **top 10% most-confident steps succeed ~4.3x more often than average**. The agent can tell which
  *tasks* it will fail from the first step, but telling a succeeding attempt from a failing one *on the same task* is
  much harder.
- UQ for LLM agents ([Lin et al.; arXiv 2609.07395, 2026-09](https://arxiv.org/abs/2609.07395)) (abstract): confidence
  from the agent's own responses "does not consistently outperform a simple baseline"; averaging over whole
  trajectories **hides overconfidence at later steps**; proposes Trajectory-Checkpoint ECE (calibration measured at
  checkpoints along a trajectory, up to 50 steps).
- AbstentionBench ([Kirichenko et al., Meta FAIR; NeurIPS 2025, arXiv 2506.09038](https://arxiv.org/abs/2506.09038v1)) **[older]**:
  20 datasets (unknown answers, underspecification, false premises, subjective, outdated); **reasoning fine-tuning
  degrades abstention by 24% on average**, even in math and science; scaling is "of little use"; a careful system
  prompt helps but does not fix it; models voice uncertainty in their reasoning and **still give a definitive wrong
  final answer**.
- "LLMs Should Express Uncertainty Explicitly" ([arXiv 2604.05306](https://arxiv.org/html/2604.05306v2)): the baseline
  is dominated by confidently wrong predictions; a calibration-trained model assigns substantially lower confidence
  to wrong answers (secondary: search summary). A mechanistic study traces overconfident verbal confidence to compact
  "Confidence Mover Circuits" ([arXiv 2604.01457, COLM 2026](https://arxiv.org/pdf/2604.01457)) (secondary).
- Verbalized confidence for LLM judges: a prompt-only recipe (no logprobs) improved judge calibration on post-2025
  proprietary models in **67 of 90** (model, task) comparisons ([arXiv 2609.10996](https://arxiv.org/html/2609.10996v1))
  (secondary). DualStake trains separate "evidence" and "answer" confidence for deep-research agents
  ([arXiv 2609.00935](https://arxiv.org/pdf/2609.00935)) (secondary).

**Sampling-based uncertainty**
- Semantic entropy: sample several answers, cluster by bidirectional entailment, take entropy over meaning clusters;
  detects confabulations better than token-level entropy and other baselines on QA
  ([Farquhar, Kossen, Kuhn, Gal; Nature 630, 2024](https://www.nature.com/articles/s41586-024-07421-0)) **[older]**
  (paywalled; not re-read; numbers not taken).
- 2026 follow-ups (all on QA, none on agents): adaptive Bayesian semantic entropy needs **~50% fewer samples** for
  equal detection and gives **+12.6% average AUROC** at equal budget ([AAAI 2026, arXiv 2603.22812](https://arxiv.org/abs/2603.22812))
  (secondary); BEACON (black-box, combines semantic entropy with other consistency signals) **~0.81 AUROC** across
  seven benchmarks, **~0.78 with only 5 calls** ([arXiv 2606.07528](https://papers.cool/arxiv/2606.07528)) (secondary);
  global AUROC can hide the failures that matter in deployment; entropy plus a correctness probe usually helps, the
  best detector varies by model ([arXiv 2603.21172](https://arxiv.org/html/2603.21172v1)) (secondary).
- **Self-consistent errors** ([Tan et al.; EMNLP 2025, arXiv 2505.17656](https://arxiv.org/abs/2505.17656)) **[older]**
  (abstract): errors where the model repeats the same wrong answer across samples **stay stable or increase with
  scale** while inconsistent errors fall; **all four families of detection methods tested struggle** on them; a
  cross-model probe using an external verifier model's hidden states improves detection across three families.

**Conformal prediction and abstention with guarantees**
- Conformal abstention ([Yadkori et al., Google DeepMind; arXiv 2405.01563, 2024](https://arxiv.org/html/2405.01563v1)) **[older]**:
  answer or abstain using a self-consistency score with a threshold calibrated so the **hallucination rate is
  provably bounded**; bounds held on closed-book open-domain QA.
- Conformal factuality ([Mohri and Hashimoto; arXiv 2402.10978, 2024](https://arxiv.org/abs/2402.10978)) **[older]**
  (abstract): back off by removing or generalising claims until a calibrated threshold is met; **80-90% correctness
  guarantees** on FActScore, NaturalQuestions and MATH while retaining "the majority" of the original output.
- 2026: conditional (per-group) factuality guarantees via conformal sampling
  ([arXiv 2603.27403](https://arxiv.org/html/2603.27403v1)); conformal thresholds that decide when to stop generating,
  during inference ([arXiv 2606.08831](https://arxiv.org/abs/2606.08831)); a geometry-calibrated conformal abstention
  method reporting a **75% conditional correctness guarantee** ([arXiv 2604.01413](https://arxiv.org/html/2604.01413));
  a differentiable surrogate for multi-claim risk control ([arXiv 2604.20098](https://www.emergentmind.com/papers/2604.20098))
  (all secondary).

### Inferences
- **Do not use the model's stated confidence as a gate.** The evidence (near-chance discrimination, AbstentionBench,
  Lin et al.) says verbalized confidence from an untrained agent is at best a weak feature. It can be logged and
  calibrated, but gating on it needs measurement first.
- **Agreement is a better signal than self-report, but blind to consistent errors.** Agreement across independent
  runs (and across providers, section 4) is the cheapest usable uncertainty signal for agents, and BEACON-style
  5-sample estimates get most of the benefit. Tan et al. show its blind spot: a wrong answer the model produces
  every time looks certain. Agreement must therefore be paired with checks and a cross-family verifier, never used
  alone to approve.
- **Coverage-risk is the right way to present abstention.** For a confidence score s and threshold t, coverage =
  share of tasks with s ≥ t that the system answers; risk = error rate among those. Plotting risk against coverage
  (and the area under it) on the person's own labelled runs shows what "answer only when confident" buys. Hathidara's
  "top 10% of steps succeed 4.3x more often" is one point on such a curve.
- **Split conformal calibration is implementable without model access.** Given a calibration set of n labelled runs
  with scores, choose the threshold as the appropriate empirical quantile so that, for a new exchangeable task, the
  probability of answering wrongly is at most alpha. It needs (a) labels (from done criteria, verifier-plus-human
  audits, or later ground truth), (b) exchangeability (same task distribution, same models), and (c) recalibration
  when either changes. The guarantee is marginal (on average over tasks), not per task.
- Harness:
  - A `confidence` record per result built from measurable signals: done-criteria pass count, verifier verdict and
    per-criterion statuses, agreement across replicas (section 4), cross-provider agreement, the agent's stated
    confidence (logged, weight learned), and tool-error counts. Store it with the eventual true outcome so it can be
    calibrated.
  - A per-agent/team **abstention threshold** setting with a target risk (e.g. "at most 2% wrong among answered"),
    set by split conformal on that agent's labelled history; results below threshold come back as "unverified /
    abstained", which the existing `unknown` verdict already models. Show the coverage-risk curve on the agent page,
    and refuse to show a guarantee when there are fewer than ~100-300 labelled runs.
  - Measure calibration along the trajectory (checkpoint ECE) for long tasks rather than only at the end.
  - Give every agent an explicit "I cannot do this reliably / the brief is ambiguous" exit (verification.md rule 5)
    and count its use: AbstentionBench shows reasoning models rarely abstain unprompted.

### Gaps
- No study found applying semantic entropy or conformal abstention to multi-step tool-using agents with measured
  AUROC or risk guarantees; all quantitative evidence is QA or short reasoning.
- No head-to-head of verbalized vs sampling-based vs verifier-based confidence on agent tasks with 2026 frontier
  models was found (Lin et al. may contain one; only the abstract was read).
- The Semantic Entropy Nature paper's numbers were not re-read (paywall).

---

## 3. Verification techniques with measured gains

### Takeaway
Verification pays most when checking is easier than solving (math, logic, puzzles, code with executable checks) and
least on knowledge recall, where the verifier needs the same knowledge as the solver. A verifier from a different
model family beats one from the same family, which beats self-verification; the more similar the verifier's
distribution to the solver's, the more false passes. Aggregating several weak or aspect-specific verifiers with
estimated accuracies beats any single one. Debate adds little over voting. LLM judges can be highly repeatable yet
biased and invalid, and raw agreement overstates their quality by 33-41 points against chance-corrected kappa.

### Cited Findings

**Self vs same-family vs cross-family verification**
- "When Does Verification Pay Off?" ([Lu, Teehan, Jin, Ren (NYU); arXiv 2512.02304 v2, 2026-04-21](https://arxiv.org/html/2512.02304v2)):
  37 models in 7 families (0.5B-72B), 9 datasets. Verifier gain = precision of accepted answers − solver accuracy,
  where precision = acc·TPR / (acc·TPR + (1 − acc)·FPR). Findings: **cross-family gains largest, intra-family slightly
  above self, self-verification smallest**; more accurate solvers do not self-improve more. Similarity between
  solver and verifier **raises false-positive rate** (cross-family FPR slope +0.459, gain slope −0.183 per unit of
  log-likelihood similarity). Reasoning post-training **raises FPR and lowers self-verification gain**, but makes
  models better cross-family verifiers. Qwen3 self-checks spontaneously in 96% of outputs (DeepSeek-R1-Distill 73%,
  Llama3/Qwen2.5 1-2%), leaving little for a forced second pass. Gains highest on AIME, GSM8K, 3SAT, Sudoku; smaller
  on GPQA, MMLU and CSQA, "since verifying requires the same knowledge as solving". **[older models]** (open models only).
- Medical VQA: routing verification to a different model reduced agreement bias and verifier error on all seven
  tasks, but did not remove it ([arXiv 2605.10850](https://arxiv.org/pdf/2605.10850)); cross-model verification beat
  self-verification for every answerer, each model worst at checking itself ([arXiv 2609.29604](https://arxiv.org/pdf/2609.29604))
  (both secondary).
- For self-preference counter-evidence (labels "self"/"other" matter more than authorship), see verification.md 3.1.

**Generative verifiers and process vs outcome verification**
- Generative verifiers (GenRM, chain-of-thought verification with majority vote over rationales) beat
  discriminative RMs, DPO verifiers and LLM-as-judge; Best-of-N gains: algorithmic **5% to 45.3%**, GSM8K **73% to
  93.4%**, easy-to-hard MATH **28% to 44.6%** ([Zhang et al.; ICLR 2025, arXiv 2408.15240](https://arxiv.org/abs/2408.15240)) **[older]**.
- Process vs outcome: PRIME (ACL 2026) reports outcome-only verification rewards correct answers reached by wrong
  derivations; process-outcome-aligned verification gave **+8.29, +9.12, +7.31 points** on AIME24, AIME25 and
  Beyond-AIME for Qwen3-14B-Base ([ACL 2026](https://preview.aclanthology.org/ingest-acl/2026.acl-long.683/)) (secondary).
  AgentPRM (WWW 2026): **>8x compute efficiency** vs baselines on three agent tasks with Qwen2.5-3B
  ([arXiv 2511.08325](https://arxiv.org/html/2511.08325v1)) (secondary). PRM benchmarks show weak transfer and missed
  implicit step errors; ToolPRMBench finds large differences between PRMs on tool-use
  ([search summary](https://liner.com/review/toolprmbench-evaluating-and-advancing-process-reward-models-for-toolusing-agents)) (secondary).
  No 2026 head-to-head of agent PRMs vs outcome verifiers was found.

**Aggregating multiple verifiers**
- Weaver ([Saad-Falcon et al., Stanford; arXiv 2506.18203, 2025](https://arxiv.org/html/2506.18203v2)) **[older]**:
  combines many weak verifiers (RMs, LLM judges) by estimating each one's accuracy without labels (weak supervision),
  normalising outputs and filtering weak ones; Llama 3.3 70B as generator reached **87.7%** average (o3-mini level)
  vs GPT-4o 69.0%; naive aggregation performs poorly; a distilled **400M cross-encoder keeps 98.2%** of the gain at
  **99.97% less** verification compute ([HazyResearch blog](https://hazyresearch.stanford.edu/blog/2025-06-18-weaver)).
- Multi-Agent Verification ([Lifshitz, McIlraith, Du; arXiv 2502.20379, 2025](https://arxiv.org/abs/2502.20379)) **[older]**:
  BoN-MAV samples n candidates, collects binary approvals from m "aspect verifiers" (off-the-shelf LLMs prompted to
  check one facet each) and picks the most-approved; scales better than self-consistency and reward-model
  verification; weaker verifiers can improve stronger generators.

**Debate**
- "Debate or Vote" ([Choi, Zhu, Li; NeurIPS 2025, arXiv 2508.17536](https://arxiv.org/pdf/2508.17536)) **[older]**:
  across 7 benchmarks, **majority voting alone accounts for most of the gains** attributed to multi-agent debate;
  debate beliefs form a **martingale** (debate does not improve expected correctness); targeted interventions that
  bias updates toward correction help; "simple ensembling methods remain strong alternatives".

**LLM-as-a-judge reliability (new 2026 evidence; earlier biases in verification.md 3.1)**
- "Reliability without Validity" ([Norman, Rivera, Hughes; arXiv 2606.19544, 2026-06](https://arxiv.org/abs/2606.19544)) (abstract):
  21 judges, 9 providers, ~541,000 judgments on MT-Bench, JudgeBench, RewardBench. **Raw agreement overstates
  agreement vs Cohen's kappa by 33-41 points** on MT-Bench ("kappa deflation"); **test-retest reliability > 0.95
  coexists with position bias > 0.10** in two production-deployed judges; verbosity bias small (< 0.011) under one
  pairwise rubric; **judge rankings shift by up to 14 places** across benchmarks. Proposes a "Minimum Viable
  Validation Protocol".
- Correlated errors bias LLM-as-judge evaluation (judges share errors with the models they grade)
  ([Kim, Garg, Peng, Garg; ICML 2025, arXiv 2506.07962](https://arxiv.org/abs/2506.07962)) **[older]** (abstract).
- A RAND "Judge Reliability Harness" (2026-03) tested four judges on safety, persuasion, misuse and agentic
  benchmarks; no judge was uniformly reliable; consistency broke under formatting changes, paraphrase and verbosity
  shifts (secondary: [search summary](https://www.adaline.ai/blog/llm-as-a-judge-reliability-bias); primary not found).

### Inferences
- **Verifier value is computable.** With the Lu et al. formula, a solver at 80% with a verifier at TPR 0.95, FPR 0.20
  yields 95% precision among accepted results; two verifiers that both must pass, if independent, give TPR 0.90 and
  FPR 0.04 and precision ~98.9% (my arithmetic). Correlation between verifiers (and between verifier and solver)
  pushes FPR back up, which is why the cross-family result matters. The harness can estimate TPR and FPR per
  verifier from its calibration set (verification.md rule 15) and show expected precision per configuration.
- **Where verification is weak, change the task, not the verifier.** On knowledge-recall claims, a second model knows
  what the first knows; verification there must be grounding (the claim's cited evidence exists and says it,
  section 6) rather than a second opinion.
- **Aggregation rule depends on the decision.** For choosing among candidates, majority of approvals (BoN-MAV) or
  accuracy-weighted scores (Weaver) work. For approving a high-stakes result, a conjunction is safer: any aspect
  verifier's justified "fail" fails the result; "unknown" from any blocks auto-approval.
- **Judge validity needs labels.** A verifier that agrees with itself 95% of the time can still be wrong in a fixed
  direction. Measure verifier quality with Cohen's kappa (or false-pass and false-fail rates) against labelled cases,
  never raw agreement, and re-measure per model version.
- **Debate is not a verifier.** Free-form debate between agents spends tokens without changing expected correctness;
  the useful part is independent answers plus voting, and a targeted "try to disprove this specific finding" step
  (already in verification.md 3.2 item 7).
- Harness:
  - **Cross-provider verifier by default at high stakes**: a `verifier.provider` setting that defaults to a different
    family from the worker when stakes are high; warn when worker and verifier share a family; record both in the
    result.
  - **Aspect verifiers**: split the single verifier into narrow roles (criteria met; scope and tamper; evidence
    grounding; safety/irreversibility) each with its own clean context and verdict; combine with AND for approval
    at high stakes; log per-aspect verdicts for later accuracy estimates.
  - **Verifier scorecard metric**: per verifier configuration, kappa, false-pass and false-fail rates on the
    calibration set (known-good diffs, planted bugs, the tricks in verification.md 1.2), test-retest agreement over 3
    reruns, and a position-swap check for any pairwise comparison.
  - **Prefer executable and process checks when they exist**: step-level checks on intermediate artefacts (schema of a
    plan, a migration's dry-run, a query's row counts) are cheap process supervision; keep LLM process-reward models
    out of the critical path until measured on the person's tasks.

### Gaps
- No 2026 study found comparing cross-provider frontier verifiers (e.g. Claude verifying GPT output and vice versa)
  on agentic coding or research tasks; Lu et al. used open models up to 72B.
- No head-to-head PRM vs outcome verifier for tool-using agents was found.
- The RAND judge harness and the "Minimum Viable Validation Protocol" details were not read in primary form.

---

## 4. Redundancy: N-version ideas for LLMs, independent replications with agreement checks, red-team and devil's-advocate roles, correlated errors

### Takeaway
Redundancy helps, but far less than independence would predict, because LLM errors are strongly correlated:
models agree on the same wrong answer about 60% of the time when both err, and more accurate models are more
correlated even across providers. The 2026 replication of Knight and Leveson's N-version experiment with coding
agents found the same common-mode failure as the 1986 original; 2-of-3 voting cut failures about 3x, where
independence would predict a cut of hundreds of times. Diversity (different families, prompts, decompositions,
evidence sources) reduces correlation; voting extracts most of what debate offers; disagreement is a cheap, useful
escalation trigger, but agreement is not proof.

### Cited Findings
- **Knight and Leveson** ([IEEE TSE 12(1), 1986; KTH copy](https://www.kth.se/social/files/564df871f2765419e306178d/KnightLeveson.pdf)) **[older]**:
  27 versions written independently from one specification, 1,000,000 tests; coincident failures (several versions
  failing the same input) were "substantially more than expected" under independence; 1,255 coincident failures, up
  to 8 versions failing one input (secondary figures). Conclusion: N-version reliability analysis must include
  dependent errors. A 1987 analysis of the same programs still found a substantial reduction in failure probability
  from voting ([NASA NTRS](https://ntrs.nasa.gov/api/citations/19870002808/downloads/19870002808.pdf)) (secondary).
- **N-version programming with coding agents** ([Ron, Baudry, Monperrus; arXiv 2606.20158, 2026-06-18](https://arxiv.org/abs/2606.20158))
  (abstract): **48 agent-written implementations** of the same Launch Interceptor specification, 1,000,000 random
  inputs against a shared oracle; "substantial common-mode failure, along the findings of Knight-Leveson"; 2-of-3
  majority units cut mean failures from **387.44 (single) to 130.99 (triples)**; **11,844 N-version units had no
  observed failures**. Models/providers used not stated in the abstract.
- **Correlated errors across LLMs** ([Kim, Garg, Peng, Garg; ICML 2025, arXiv 2506.07962](https://arxiv.org/abs/2506.07962)) **[older]**:
  350+ models; on one leaderboard models **agree on the same wrong answer 60% of the time when both err**; shared
  provider and architecture raise correlation; **larger, more accurate models have highly correlated errors even
  across providers**. Secondary summaries add: chance would be about one third, and one cross-provider pair agreed
  on 99.87% of jointly wrong answers ([summary](https://www.themoonlight.io/review/correlated-errors-in-large-language-models)) (secondary).
- Self-consistent errors grow or hold with scale (section 2; [Tan et al.](https://arxiv.org/abs/2505.17656)), so
  repeated sampling of one model gives correlated "replicas" by construction.
- Similarity between solver and verifier raises false-pass rates; cross-family is better
  ([Lu et al.](https://arxiv.org/html/2512.02304v2)) (section 3).
- Butler and Finelli: the independence assumption behind multiversion software "cannot be justified by
  experimentation in the ultrareliability region" ([NASA NTRS](https://ntrs.nasa.gov/api/citations/20040139817/downloads/20040139817.pdf)) **[older]**.
- Voting vs debate: majority voting accounts for most debate gains ([Choi et al.](https://arxiv.org/pdf/2508.17536)) **[older]**.
- Adversarial checking of findings (disprove step) raised reviewer precision in production (Claude Code Review,
  OpenCodeReview; see verification.md 2.1 and 3.2 item 7). No controlled study of a standing "devil's advocate" or
  red-team agent role in agent swarms, with measured accuracy gains, was found.

### Inferences
- **Quantifying the correlation penalty (my arithmetic).** In Ron et al., a single version fails on ~3.9 x 10^-4 of
  inputs (387/10^6). If versions failed independently, a 2-of-3 vote would fail at ~3q^2 ≈ 4.5 x 10^-7, i.e. about
  0.5 failures per million; the observed 131 is roughly **300x worse than independence**. Heterogeneous version
  quality explains part, common-mode faults the rest. The practical reading: voting among agents buys roughly a
  3x error cut, not orders of magnitude.
- **Kim et al.'s 60% has a direct design consequence**: when two models both err on a multiple-choice style decision,
  they agree on the wrong answer more often than not, so "two models agree" filters out only the uncorrelated part
  of the errors. Agreement should raise confidence modestly; **disagreement should strongly lower it** (it is a
  near-certain signal that at least one is wrong).
- **Diversity levers, in rough order of expected decorrelation (opinion, extrapolated from Lu et al., Kim et al.,
  Knight-Leveson):** different evidence sources and tools (an answer derived from the database vs from the docs) >
  different decomposition or method (compute it two ways) > different model family > different prompt or persona >
  different sampling seed on the same model.
- **Where N-version fits**: outputs that can be compared mechanically (a number, a classification, a set of
  extracted facts, a decision with reasons, a query result, a config value). It fits poorly for long free-form
  artefacts (two different correct reports do not "agree"); there, use claim-level comparison (section 6) or
  aspect verifiers.
- **Red-team roles**: a red-team agent whose job is to find one concrete, evidenced way the result is wrong is a
  targeted "bias toward correction" (the intervention Choi et al. found helps); a free-ranging devil's advocate in a
  debate is not. No measured gain was found for either in agent swarms.
- Harness:
  - A **`replicas` setting** for a task (default 1; high stakes 3): the lead's brief runs in R independent members
    with no shared context, ideally on at least two providers and, when the task allows, with different evidence
    instructions ("derive from source A" / "derive from source B"). A **comparator** (code where outputs are
    structured; a clean-context agent otherwise) reports agree / disagree per field or claim.
  - **Disagreement routes to `unknown`** and, at high stakes, to the person, with both answers and their evidence side
    by side; agreement still goes through done criteria and the verifier (agreement never replaces them).
  - Record replica agreement and the eventual truth so the harness can measure the actual correlation per model pair
    on the person's tasks (the "error agreement when both wrong" statistic) and show it in the model picker.
  - A **red-team role** in teams: after the reviewer passes a result, one member gets the result and evidence and
    must return either "no evidenced defect found" or a defect with a reproducing command or quote; its findings get
    one refutation attempt (verification.md rule 12) before reopening the task. Measure its precision and the
    fix rate it causes.

### Gaps
- The 2026 N-version paper's models, providers, and whether mixing providers reduced common-mode failure are not in
  the abstract.
- No study found measuring error correlation between current frontier agents (2026) on multi-step agentic tasks
  rather than single-answer benchmarks.
- No controlled evidence found on standing red-team or devil's-advocate agent roles in multi-agent systems.

---

## 5. Human-in-the-loop for high stakes: where to place approvals, how to present evidence

### Takeaway
People approve almost everything they are asked (93% of Claude Code permission prompts), and wrong AI advice
measurably drags down even AI-trained experts (−14 points in a physician RCT). Asking a person more often is
therefore not a safety mechanism; asking at fewer, well-chosen points with evidence designed to expose errors is.
First-person uncertainty phrasing reduced overreliance in a pre-registered study; warnings help partially;
explanations do not reliably help and can make it worse. A classifier gate catches most dangerous actions at a
0.4% false-block rate but still misses 17% of real overeager actions, so irreversible high-stakes actions still need
a person.

### Cited Findings
- **Approval fatigue and classifier gating** ([Anthropic, "How we built Claude Code auto mode", 2026-03-25](https://www.anthropic.com/engineering/claude-code-auto-mode)):
  users accept **93%** of manual permission prompts. Two-stage classifier (Sonnet 4.6): stage 1 a single-token
  filter told to "err on the side of blocking", stage 2 chain-of-thought only on flagged actions. Real traffic
  (n=10,000): **8.5% FPR stage 1, 0.4% FPR full pipeline**. Real overeager actions (n=52): **6.6% FNR stage 1, 17% FNR
  full** ("the honest number"). Synthetic exfiltration (n=1,000): 1.8% / 5.7% FNR. Most misses: the classifier saw
  the danger but misjudged whether the user's consent covered the action's blast radius. It sees only user messages
  and tool calls (assistant text and tool results stripped, "reasoning-blind by design", the main injection
  defence); escalates to a human after **3 consecutive or 20 total denials**; "not a drop-in replacement for careful
  human review on high-stakes infrastructure". Secondary reports say auto mode became the default on 2026-08-14 and
  cite a 97% approval rate ([hyrax.dev](https://hyrax.dev/blog/claude-code-auto-mode-default-august-14)) (secondary,
  conflicts with the primary 93%).
- **Automation bias in experts**: RCT with 44 physicians who had completed 20 h of AI-literacy training; GPT-4o
  advice error-free vs deliberately wrong in 3 of 6 vignettes; diagnostic reasoning accuracy **84.9% vs 73.3%,
  adjusted difference −14.0 points (95% CI −8.3 to −19.7, p < .0001)**
  ([medRxiv 2025.08.23.25334280](https://www.medrxiv.org/content/10.1101/2025.08.23.25334280)) **[older]** (abstract via
  search; preprint, 22 per arm). A follow-up RCT of a behavioural nudge (72 physicians; registered NCT07328815) has no
  published results found ([protocol](https://cdn.clinicaltrials.gov/large-docs/15/NCT07328815/Prot_SAP_000.pdf)).
- **Warnings help partially**: in a Cognitive Reflection Test study, participants given faulty AI answered fewer than
  half as many items correctly as a no-AI group; a warning roughly doubled their score but did not restore baseline
  ([Procedia Computer Science, 2025](https://www.sciencedirect.com/science/article/pii/S1877050925030042)) **[older]**
  (secondary).
- **Uncertainty phrasing**: pre-registered study, n=404, medical questions with an LLM-infused search tool;
  **first-person expressions of uncertainty ("I'm not sure, but...") reduced overreliance and increased accuracy**;
  general phrasing ("It's not clear, but...") had weaker, non-significant effects
  ([Kim, Liao, Vorvoreanu, Ballard, Vaughan; FAccT 2024, arXiv 2405.00623](https://www.arxiv.org/abs/2405.00623)) **[older]** (abstract).
- **Explanations** do not reliably reduce acceptance of incorrect suggestions and sometimes increase it; the paper
  distinguishes "weak" automation bias (ignoring available contrary evidence) from "strong" (following the system
  despite knowing the evidence) ([Philosophy & Technology, 2026](https://link.springer.com/article/10.1007/s13347-026-01090-9)) (secondary).
  Novices using LLM assistants for software help often failed to notice wrong or hallucinated answers
  ([arXiv 2402.08030](https://arxiv.org/pdf/2402.08030)) **[older]** (secondary).
- **Regulation**: the EU AI Act requires human oversight measures for high-risk systems that keep overseers aware of
  the tendency to over-rely on output ("automation bias"; Article 14, sub-paragraph cited variously as 14(4)(b) or
  14(3)(b)) and automatic event logging over the system's lifetime (Article 12); commentary says deployers keep logs
  at least six months and that zero overrides may itself signal automation bias
  ([Mishcon de Reya, Article 14](https://www.mishcon.com/eu-uk-ai-navigator/article-14);
  [Presencis, Article 12](https://presencis.com/regulations/eu-ai-act/article-12/)) (secondary; legal text not read).
- Rabanser et al.: automation should meet a higher reliability bar than augmentation where a human reviews output
  ([arXiv 2602.16666](https://arxiv.org/html/2602.16666v2)).

### Inferences
- **Place approvals by irreversibility and disagreement, not by frequency.** Ask the person (a) before irreversible
  or externally visible actions (send, pay, deploy, delete, merge to protected branches, write to production data),
  (b) when the system's own signals disagree (replicas disagree, verifier says `unknown`, a check was skipped, a
  claim is ungrounded), and (c) at plan approval for long tasks (cheap to fix, before work is spent). Everything else
  goes through checks and classifiers. The 93% acceptance rate means a stream of routine prompts trains people to
  click yes.
- **Present evidence so errors are visible, not hidden by fluency** (opinion built on the cited results): lead with
  what the system is *not* sure of (failed or skipped checks, unknown criteria, replica disagreements, ungrounded
  claims), in first person ("I could not verify X"); show the evidence itself (diff, check output, quoted source
  passage) next to each claim; keep the model's narrative explanation secondary and short; show the blast radius of an
  action (what it changes, whether it can be undone) because that is exactly what the auto-mode classifier misjudged.
- **Make the reviewer commit before seeing the agent's answer when feasible** (opinion; no direct evidence found): for
  a single key decision (e.g. a number, a go/no-go), asking the person for their own estimate first avoids anchoring;
  the physician RCT shows how much anchoring costs.
- **Measure the human gate.** Log approvals, overrides, time to decision and later-found errors per approver; an
  approval rate near 100% with near-zero review time is a measured automation-bias signal (consistent with the EU
  AI Act commentary).
- Harness:
  - A **`stakes` setting** per agent, team or task (low / normal / high / critical) that sets defaults: replicas,
    cross-provider verifier, conformal abstention target, and which action classes need approval. Critical: every
    irreversible action approved by a person; no auto mode for them.
  - An **approval card** design: "What I am not sure of" first; per claim, status (checked / unverified / disputed)
    with the evidence pointer; replica answers side by side when they differ; actions listed with reversibility and
    scope; buttons "approve", "reject", "ask for evidence on item N".
  - **Seeded audits of the human gate**: occasionally (and transparently, with the person's opt-in) include a known
    planted defect in an approval to measure catch rate; without this there is no estimate of how much the human
    step adds.
  - **Escalation counters** like auto mode's 3-consecutive / 20-total denials: repeated verifier fails or check
    failures escalate to the person instead of looping.

### Gaps
- No controlled study found on how to present agent evidence (diffs, citations, check results) to reviewers so they
  catch more planted errors; the evidence is from QA and diagnosis settings.
- The physician nudge RCT results and the CRT study's exact numbers were not available.
- No measured data found on approval-placement strategies (per-action vs per-plan vs per-result) in agent systems.

---

## 6. Provenance and auditability: claims traced to evidence, reproducible runs, audit logs

### Takeaway
Citations from research agents are often wrong or unsupporting (citation accuracy 40-80% across deep-research
systems), and agents' final reports are not reliable accounts of what they did (see verification.md 1.1), so
provenance has to be recorded by the harness, not reported by the model. Re-running is not reproduction: identical
temperature-0 requests give different outputs on shared servers, so a reproducible run means a recorded run
(every model response and tool output stored, replayable without calling the model), plus regulatory-grade event
logs for high-risk uses.

### Cited Findings
- **Citation reliability** ([DeepTRACE, Microsoft Research; ICLR 2026, arXiv 2509.04499](https://arxiv.org/html/2509.04499v1)):
  eight measurable dimensions over answer text, sources and citations; statement-level decomposition with citation
  and factual-support matrices. Deep-research modes are less overconfident and more thorough in citing, but remain
  one-sided on debate questions and have "large fractions of unsupported statements", with **citation accuracy
  40-80%** across systems; reported unsupported-statement rates include YouChat (DR) 74.6% and Perplexity (DR) 97.5%
  (secondary: search summary of the HTML; exact metric definitions not checked). 303 queries, 9 systems (secondary).
- **Self-reports are not provenance**: overclaiming, false success and concealed actions are documented in
  verification.md section 1.1 (OverclaimBench: final reports misleading 80.4% of the time after skipped files;
  Transluce; False success).
- **Nondeterminism**: 80 distinct completions from 1,000 identical temperature-0 requests; batch-invariant kernels
  fix it at ~1.6x cost ([Thinking Machines, 2025-09-10](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/)) **[older]**.
  Quantisation, mixed hardware and library versions still shift numerics across machines
  ([geosurge.ai](https://blog.geosurge.ai/2025/11/12/when-same-question-same-settings-still-gives-different-ai-answers/)) (secondary).
- **Logging duties**: EU AI Act Article 12 automatic event logging for high-risk systems; deployers keep logs for at
  least six months; error-only logging fails the traceability requirement; Article 14 oversight depends on usable
  Article 12 records (who reviewed, what the output was, accepted or overridden)
  ([datenschutz-notizen.de](https://www.datenschutz-notizen.de/ai-logging-under-the-eu-ai-act-the-compliance-infrastructure-behind-high-risk-systems-4458904/);
  [Presencis](https://presencis.com/regulations/eu-ai-act/conformity/article-12-record-keeping)) (secondary).
- Rabanser et al. recommend tying reliability metrics and incident analysis to deployment governance
  ([arXiv 2602.16666](https://arxiv.org/html/2602.16666v2)).

### Inferences
- **A claim ledger is the unit of provenance.** Every factual claim in a high-stakes result should be a record:
  claim text, the evidence pointer (tool call id and output hash, file and line range, URL with the quoted passage
  and its hash, query and result hash), who produced it (agent, model, provider) and its verification status
  (grounded / unverified / disputed). A grounding check can then be mechanical: the quoted passage exists in the
  recorded tool output, and an entailment check (cross-family model) confirms it supports the claim. With citation
  accuracy at 40-80% in commercial systems, this check is where most research-output errors would be caught.
- **Record, then replay.** Store every model request and response (with model id, provider, parameters, system-prompt
  hash), every tool call with its full output, file snapshots and environment versions in a content-addressed store.
  "Replay" re-drives the harness from recorded outputs (deterministic, for audits and debugging); "re-run" calls
  models again (a new sample, for reliability measurement). Never call a re-run a reproduction.
- **Tamper evidence**: an append-only, hash-chained run log (each event includes the previous event's hash) lets an
  auditor verify nothing was removed, which matters because agents have erased evidence (verification.md 1.1, METR
  2026).
- Harness:
  - **Claims in the result schema**: high-stakes results carry `claims: [{text, evidence: [{kind, ref, quote,
    hash}], status}]`; the verifier and a `grounding` aspect verifier check each; ungrounded claims are shown as
    unverified on the approval card (section 5) and count against the abstention threshold (section 2).
  - **Run recorder** on by default at high stakes: content-addressed storage of model I/O and tool outputs,
    hash-chained event log, retention setting (default at least six months for high-risk work), export bundle for an
    audit, and a "replay this run" action.
  - **Provenance in delegation**: each member result records which agent and model did the work and which checks
    ran, so a lead cannot present its own work as a member's verified result (verification.md rule 4).
  - **Incident records**: every failure found after acceptance (by a person, a later check, or the red team) is linked
    to its run and feeds the calibration set, the verifier scorecard and the reliability report.

### Gaps
- DeepTRACE's per-system figures and metric definitions were not read in full; the 97.5% figure needs checking.
- No study found measuring how often agent tool-output citations (file, line, tool call) are wrong, as opposed to web
  citations.
- The EU AI Act article sub-paragraphs were not verified against the EUR-Lex text.
- No source found on the cost of full I/O recording for long agent runs (storage per run-hour), though it is
  straightforward to measure in the harness.
