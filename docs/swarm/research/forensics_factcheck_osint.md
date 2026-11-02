# AI agents for digital forensics, incident investigation, fact-checking and OSINT: performance, trustworthiness, and what a defensible "investigation swarm" needs

Scope note: current as of 2 November 2026. Items marked [OLDER] predate 2025 and are included as foundations. Many 2026 sources are arXiv preprints whose peer-review status was not verified; numbers from secondary summaries are flagged. "Harness mapping" bullets translate each practice into the TypeScript harness described in the brief (orchestrator, sub-agents with harness-run checks, a clean-context verifier, sandboxes, MCP tools, several model providers). Defensive, lawful, authorized investigation only.

## Q1. Digital forensics and incident response (DFIR) with LLMs: studies, benchmarks, measured accuracy, hallucination risks, and forensic standards

### Takeaway
By late 2026, agents are measurably useful at *finding* intrusion evidence. The best model on SecRespond detected 79% of checkpoints. But no model fully detected and fixed any single compromised host. Models struggle with persistence, lateral movement, joining scattered evidence into a timeline, and remediation. Non-determinism and unlogged intermediate outputs have already drawn a procedural challenge in court. Forensic standards (hash, work on copies, read-only acquisition, document every step, validated tools) are not met by LLM output itself. The harness has to supply them around the model.

### Cited Findings

**Benchmarks and measured performance**
- **SecRespond** (arXiv, 29 Jul 2026)
  - Setup: agents get a forensic disk snapshot of a compromised cloud host, plus alerts, vulnerability scans and baseline checks. They must write forensic reports and a remediation plan. There are 10 cyber ranges, 4 entry-point types, 21 ATT&CK techniques, 5 operating systems and 280 checkpoints. Only 30–40% of attack actions trigger alerts, so agents must inspect files, logs and configs themselves. 23 frontier LLMs ran on the OpenCode agent harness. — [SecRespond, alphaXiv 2607.26791](https://www.alphaxiv.org/abs/2607.26791)
  - Results: the top model (Claude Opus 4.7) scored 79.0% on detection and 65.7% on planning. Detection exceeded planning for every model. No model achieved complete detection and remediation on any single range. Agents were best on malicious entities and worst on persistence and response quality. Performance dropped on broad-surface attacks such as NPM worms and lateral movement. — [SecRespond](https://www.alphaxiv.org/abs/2607.26791)
  - Failure modes:
    - missed silent persistence (hidden scripts, crontab entries) unless explicitly prompted;
    - plans that omit post-cleanup health checks and credential rotation;
    - difficulty linking scattered evidence into a coherent timeline;
    - a "skill boundary" effect: agents given procedural skills stopped investigating once the routine finished.
    - — [SecRespond](https://www.alphaxiv.org/abs/2607.26791)
  - Judging: three LLM judges from different vendors scored against rubrics (detection on discovery, evidence and attribution; planning on correctness and completeness). Inter-judge agreement was 72–75%. Correlation with human experts was ρ = 0.86–0.87. The authors conclude that agents beat traditional agentless scanners at finding intrusions but are "not ready to operate autonomously in high-stakes incident response". — [SecRespond](https://www.alphaxiv.org/abs/2607.26791)
- **SIR-Bench** (arXiv 2604.12040, Apr 2026)
  - Setup: 794 test cases derived from 129 anonymized incident patterns, replayed in cloud environments. Three metrics: triage accuracy, novel-finding discovery (to separate real investigation from "alert parroting"), and appropriate tool use. Uses an adversarial LLM-as-judge that requires concrete forensic evidence before crediting a finding.
  - Results: the authors' own agent reached 97.1% true-positive detection, 73.4% false-positive rejection and 5.67 novel key findings per case.
  - Caveats: the abstract reports no judge validation against humans and no comparison with other agents.
  - — [SIR-Bench, arXiv 2604.12040](https://arxiv.org/abs/2604.12040)
- **AuditBench** (Univ. of Chicago, UC Berkeley, Google; arXiv 2606.10281 v2, Sep 2026)
  - Setup: 51 scenarios (25 lab Linux/Windows scenarios plus 26 from DARPA OpTC, 10 of them benign). Tasks: alert classification, persistence, lateral movement and exfiltration over raw auditd/ProcMon logs or a provenance-graph ("edge") format. Single prompt per chunk at temperature 0, no agentic tool use.
  - Results: no model dominated. Exfiltration and persistence were easiest and lateral movement hardest (best OpTC lateral-movement F1 was about 0.25). Lab classification ranged from GPT-5 mini at F1 0.57 (TPR 40%, no false-positive chunks) to the Gemini 2.5 models at 100% TPR but 85.7% FPR.
  - Main failure mode: over-flagging benign activity, driven by unusual file names and high event volume. Few false positives were shared across models, so ensembles might reduce them.
  - The authors release data, prompts and model I/O.
  - — [AuditBench, arXiv 2606.10281](https://arxiv.org/html/2606.10281)
- **DFIR-Metric** (arXiv 2505.19973, May 2025; Springer chapter)
  - Setup: three modules. 700 expert-reviewed multiple-choice questions from certifications and official documentation; multi-step forensic challenges; and string-search tasks based on NIST's Computer Forensics Tool Testing (CFTT) programme. 14 LLMs tested. Introduces a Task Understanding Score (TUS) that gives partial credit when accuracy is near zero. Even the best models struggle with sustained deductive reasoning, and accuracy and consistency vary across trials. — [DFIR-Metric, arXiv](https://arxiv.org/abs/2505.19973); [Springer](https://link.springer.com/chapter/10.1007/978-981-95-4367-0_2)
  - Secondary summaries: GPT-4.1 had the highest TUS@4 (38.52%) yet "only completed 1 task fully correct out of 500", and GPT-4o led mean MCQ accuracy (93.03%). — [Liner review](https://liner.com/review/dfirmetric-benchmark-dataset-for-evaluating-large-language-models-in-digital); [Moonlight review](https://www.themoonlight.io/review/dfir-metric-a-benchmark-dataset-for-evaluating-large-language-models-in-digital-forensics-and-incident-response)
  - Conflict: the two secondary summaries disagree on GPT-4.1's Confidence Index (89.34% vs 28%). Verify against the paper before use.
- **CFA-Bench** (IEEE): tests LLM agents on forensic tasks (incident response, threat attribution) in a testbed that generates packet captures and logs. Agents are scored at checkpoints that end with identifying a CVE. The authors call their results preliminary. — [CFA-Bench, IEEE Xplore](https://ieeexplore.ieee.org/document/11129512/)
- **First-hour law-enforcement survey** (arXiv 2609.12681, Sep 2026)
  - Reviews four approaches for frontline police in the first hour of a cyber incident: playbooks, LLMs, RAG and agentic AI.
  - Finds RAG "a relatively viable intermediate solution".
  - Names prompt sensitivity and "confident hallucinations in legal contexts" as major risks, and loss of volatile evidence through first-hour procedural errors.
  - Judges existing cyber benchmarks insufficient for law-enforcement safety and legal needs, and calls for a benchmark on naive-query robustness and evidence preservation.
  - — [arXiv 2609.12681](https://arxiv.org/abs/2609.12681)

**Hallucination, reproducibility and admissibility risks**
- A 2025 review (Yin et al., arXiv 2504.02963) describes two unnamed, uncited incidents:
  - a European law-enforcement case in which an LLM summary of phone contents "inadvertently" violated chain-of-custody procedure because intermediate outputs were not systematically logged; the findings were then challenged on procedural grounds;
  - a university-led evaluation in which an LLM rebuilding activity timelines from logs gave different event sequences on different runs.
  - The review calls for human verification before LLM output enters forensic reports, prompt version control, and standard protocols or certification. It reports no accuracy numbers.
  - — [Digital Forensics in the Age of LLMs, arXiv 2504.02963](https://arxiv.org/html/2504.02963)
  - Caveat: both incidents are anecdotal and unsourced in the paper.
- Memory-forensics work with LLMs names hallucinated threats and incorrect indicators of compromise (IOCs) as a concern, raised further in criminal cases because of chain of custody. — [ACM, Leveraging LLMs for Memory Forensics](https://dl.acm.org/doi/pdf/10.1145/3748263)
- [OLDER] The DFRWS 2023 ChatGPT study found that hallucinations make it hard to tell when an answer is correct. — [ChatGPT for digital forensic investigation, ScienceDirect](https://www.sciencedirect.com/science/article/pii/S266628172300121X)
- A 2026 paper on forensic artifacts of local LLM runtimes points to the US Daubert reliability standard and stresses reproducibility for admissibility. — [arXiv 2603.23996](https://arxiv.org/html/2603.23996v1)
- A proposed admissibility model (HERAM) combines hallucination-probability scoring, metadata integrity checks, explainability and blockchain-based custody logging. It is listed on ResearchGate; peer review was not verified. — [HERAM, ResearchGate](https://www.researchgate.net/publication/404703330_AI_Hallucination_Forensics_and_Legal_Admissibility_Framework_for_Generative_AI_Evidence_Proposing_the_Hallucination_Evidence_Reliability_Assessment_Model_HERAM)
- A paper proposes a standard way to quantify LLM performance on forensic timeline tasks such as event summarization. Only its introduction was seen, so its results are unverified. — [LLM-based Digital Forensic Timeline Analysis](https://forensicsandsecurity.com/publications/LLM-based-Digital-Forensic-Timeline-Analysis.pdf)

**Forensic standards the work must meet** (secondary sources; the primary standards were not fetched)
- [OLDER] Two core standards:
  - NIST SP 800-86 (2006), "Guide to Integrating Forensic Techniques into Incident Response", the broader NIST guide;
  - ISO/IEC 27037 (2012), the international framework for identifying, collecting, acquiring and preserving digital evidence.
  - — [Elcomsoft blog, Aug 2026](https://blog.elcomsoft.com/2026/08/write-blockers-in-forensics-what-controls-how-you-use-them/)
- Write blocking:
  - SWGDE 18-F-001 says evidence should be protected with a software or hardware write blocker, with analysis done on a copy.
  - Tools validated through NIST CFTT are how labs typically show they meet NIST, SWGDE and ISO expectations. ISO/IEC 17025 is the relevant lab-competence standard.
  - Write blocking is professional consensus rather than law in most countries, and ISO 27037 does not name write blockers explicitly.
  - — [Elcomsoft blog](https://blog.elcomsoft.com/2026/08/write-blockers-in-forensics-what-controls-how-you-use-them/)
- Hashing and documentation:
  - A forensic image's hash guards against bit rot, transmission corruption, copy errors and incidental change during analysis. It does not by itself guard against deliberate tampering.
  - Recommended records: hashes of both source and image, device make, model and serial number, firmware, date and time, and operator.
  - — [Elcomsoft blog](https://blog.elcomsoft.com/2026/08/write-blockers-in-forensics-what-controls-how-you-use-them/)

### Inferences
- Agents are good at *discovery* and weak at *completeness* and *synthesis* (persistence, lateral movement, timelines, remediation). A harness should therefore not equate "the agent stopped" with "the investigation is complete". The SecRespond "skill boundary" effect means procedural skills can make coverage *worse* if they are treated as exhaustive.
- Over-flagging (AuditBench) and confident hallucination (survey, DFRWS 2023) push in opposite directions. A defensible system needs both a false-positive filter and a coverage check, not one "accuracy" score.
- Judge reliability is itself a measured quantity. SecRespond's 72–75% inter-judge agreement means a single LLM judge is not a ground truth. Benchmarks that do not validate their judge (SIR-Bench abstract) should be treated cautiously.
- Harness mapping:
  - **Write-blocking analog.** Evidence is mounted read-only into the sandbox, and analysis runs on a working copy. The harness (not the model) computes SHA-256 at intake and re-verifies before each tool session and at report time.
  - **Custody log.** Every MCP tool call is recorded in an append-only, hash-chained log: inputs, output hash, timestamp, model id and version, prompt version, temperature and tool version. This directly answers the "intermediate outputs not logged" failure.
  - **Deterministic extraction.** Parsing, carving and timeline generation use validated deterministic tools (MCP-wrapped forensic utilities). The LLM interprets their outputs. Each finding must cite a tool-output record by hash so a person can re-run that step.
  - **Coverage checklist as a harness-run check.** Required categories (persistence locations, accounts and credentials, lateral movement, exfiltration, timeline gaps) must each be marked "examined, with evidence" or "not examinable, with reason" before the orchestrator may close.
  - **Remediation and any action on a live system** stay behind human approval; the sandbox has no write path to production.
  - **Cross-provider ensemble or verifier** for triage verdicts, since false positives are rarely shared across models (AuditBench).

### Gaps
- No primary text of NIST SP 800-86 or ISO/IEC 27037 was fetched; the standards are described here through secondary blogs. A revision of SP 800-86 since 2006 was not checked.
- No published study found that tests LLM forensic output against a court's admissibility test. The European court-challenge anecdote is uncited.
- SecRespond's page did not report hallucinated findings or destructive actions. AuditBench did not test agentic tool use or classify hallucinated IOCs.
- No benchmark found for LLM memory or disk artifact triage with published accuracy beyond the above. The memory-forensics ACM paper's numbers were not retrieved.

## Q2. Fact-checking and claim verification: pipelines, benchmarks, accuracy vs professionals, multi-agent debate, abstention

### Takeaway
On a fixed evidence base, automated fact-checking reaches about 70–77% label accuracy on AVeriTeC. It drops sharply on the open web and on "conflicting evidence" or "not enough evidence" claims. Curated, high-quality context matters far more than reasoning or web search. Professional workflow knowledge encoded as skills adds about 2–5 points.

Compared with professionals, LLM fact-checks can approach inter-professional agreement in some settings but fall below it in deployed bots. Experts judge them accurate but less useful. Multi-agent debate gives small gains and tends toward neutral or "inconclusive" verdicts. Abstention is safer but costs benchmark accuracy.

### Cited Findings

**Pipelines and benchmarks**
- [OLDER] **AVeriTeC 2024 shared task** (FEVER workshop): 21 submissions, 18 beat the baseline. The winner, TUDA_MAI, scored 63% (AVeriTeC score). GPT-4o was the most common backbone, though small models such as Llama-3-8B did well at question generation and retrieval. Top systems scored much higher on supported and refuted claims than on conflicting-evidence and not-enough-evidence claims. — [AVeriTeC shared task overview, arXiv 2410.23850](https://arxiv.org/pdf/2410.23850); [ACL Anthology](https://aclanthology.org/2024.fever-1.1/)
- [OLDER] HerO placed second (0.57) using only open LLMs. — [HerO, arXiv 2410.12377](https://arxiv.org/pdf/2410.12377)
- [OLDER] Team Papelo found that multi-hop evidence pursuit, fewer classes, and metadata with multi-sentence context from one document helped. — [Papelo, arXiv 2411.05762](https://arxiv.org/pdf/2411.05762)
- **AVeriTeC 2025** ("Open-weights, Reproducible and Efficient Systems"):
  - Constraints: open-weights models only, on a single GPU with 23 GB of RAM, and a verdict in one minute or less. The test set has 1,000 claims that postdate the earlier data.
  - Results: 7 submissions, 6 beat the baseline. The winner, CTU AIC, scored 33.17%.
  - Scoring: moved from METEOR question matching to Ev2R recall, an LLM-based evidence evaluation that, per its authors, compared favourably with human ratings and adversarial tests.
  - — [AVeriTeC 2025 overview, ACL Anthology 2025.fever-1.15](https://aclanthology.org/2025.fever-1.15); [HerO 2, arXiv 2507.11004](https://arxiv.org/pdf/2507.11004)
- **ClaimCheck** (post-task) reports 76.4% accuracy on AVeriTeC with the small Qwen3-4B under strict temporal cutoffs. This is not a leaderboard result and is not directly comparable. — [ClaimCheck, arXiv 2510.01226](https://arxiv.org/pdf/2510.01226)
- **SkillCheck** (HKBU, arXiv 2610.25777, Oct 2026)
  - Method: distils AFP Fact Check's public stylebook and "How We Work" into a "Professional Fact-Checking Skill" with ten reference files: claim decomposition, query strategy, a 4-tier source reliability hierarchy, cross-verification across independent sources, evidence sufficiency and when to stop, context (out-of-context use, cherry-picking), numerical verification, quote attribution, confirmation-bias countermeasures, and verdict logic. — [SkillCheck, arXiv 2610.25777](https://arxiv.org/html/2610.25777v1)
  - AVeriTeC dev (491 claims), accuracy / macro-F1 compared with the skill-free DEFAME baseline:
    - GPT-4o: 70.8/43.9 → 74.8/50.2
    - GPT-4o-mini: 69.4/41.7 → 74.2/47.3
    - DeepSeek-V4-Flash: 73.9/46.2 → 76.9/47.7
    - Zero-shot GPT-4o: 62.1
    - Gold-evidence LLM results: above 81.6
  - Open web (ClaimReview2024+, 199 claims): GPT-4o 54.5 → 60.1.
  - Ablation: raw guidelines added only 0.4–1.2 points, while the distilled skill added 3.6 more. Guidance during *retrieval* produced 55–75% of the gain.
  - Costs: input tokens rise from about 3K to about 26K per claim, and stricter verification can over-abstain (NEI on a claim the baseline got right).
  - Architecture: a ReAct loop with no separate verifier role, and no comparison with human experts.
  - — [SkillCheck](https://arxiv.org/html/2610.25777v1)
- **Long-form factuality metrics** [OLDER]
  - SAFE (2024) splits a response into atomic facts and checks each with Google Search. It agreed with 72% of crowdsourced human labels from Min et al. 2023 (FActScore data), won 76% of a 100-case disagreement sample, and is more than 20× cheaper than crowd annotators. — [Long-form factuality in LLMs, arXiv 2403.18802](https://arxiv.org/abs/2403.18802v2)
  - VeriScore (2024): human annotators preferred its claim extraction over SAFE's 93% of the time, with verification agreement of Fleiss κ = 0.73. Annotators labelled 42.2% of claims *inconclusive*, a sign of how often open-domain evidence is insufficient. — [VeriScore summary, alphaXiv 2406.19276](https://alphaxiv.org/overview/2406.19276v1) (secondary summary)

**LLM fact-checkers compared with professionals**
- An analysis of over a million fact-check requests to the Grok and Perplexity bots on X benchmarked 19 frontier LLMs against professional fact-checkers' ratings of headlines. LLM fact-checks can technically match or exceed agreement *among* professionals. Designers and users, more than capability, are now the binding constraints. — [PsyArXiv preprint, Dec 2025](https://osf.io/preprints/psyarxiv/85quw_v1)
- On a 100-post sample from the same work, 54.5% of Grok and 57.7% of Perplexity bot ratings agreed with human fact-checkers, versus 64.0% agreement between human fact-checkers. — [Pitt talk abstract](https://calendar.pitt.edu/event/doctoral-guild-talk-grok-is-this-true-llm-powered-fact-checking-on-social-media)
- DeVerna, Yang, Yan and Menczer (Nov 2025) tested 15 LLMs on more than 6,000 PolitiFact claims. Standard models perform poorly. Web search gives only moderate gains and reasoning minimal benefit. A curated RAG over PolitiFact summaries improved macro-F1 by 233% on average. — [arXiv 2511.18749](https://arxiv.org/abs/2511.18749)
- Professionals rated LLM-written fact-check reports as accurate as human-written ones but significantly less useful. — [Beyond Accuracy, ACM CHI 2026](https://dl.acm.org/doi/10.1145/3772318.3791625)
- A 2026 Scientific Reports study of multilingual fact-checking found a Dunning-Kruger-like pattern: capability inversely correlates with confidence. It advises complementing professional fact-checkers rather than replacing them. — [Scientific Reports 2026](https://www.nature.com/articles/s41598-026-39046-w)
- A 2025 Reuters Institute study of UK journalists found 12% using AI for "fact-checking/verification/source assessment". — [UK journalists AI adoption (LMU repository)](https://epub.ub.uni-muenchen.de/131859/1/AI_Adoption_by_UK_Journalists_0.pdf)
- In the Reuters Institute's 2026 public report, weekly chatbot use reached 51% across six tracked countries, and use for getting information rose to 38%. — [Resultsense write-up of RISJ 2026 report](https://www.resultsense.com/news/2026-10-30-reuters-institute-generative-ai-news-report-2026/)

**Multi-agent debate and abstention**
- **DebateCV** (WWW '26): two debaters argue opposite stances and a moderator decides. Zero-shot moderators are biased toward neutral verdicts, which the authors address with Debate-SFT. — [DebateCV, arXiv 2507.19090](https://arxiv.org/pdf/2507.19090)
- Zero-shot DebateCV scored 65.4% on AVeriTeC dev, against 62.1% for zero-shot GPT-4o. The trained DebateCV scored 72.8%. — [SkillCheck baselines](https://arxiv.org/html/2610.25777v1)
- **PROClaim** uses a courtroom-style debate with progressive RAG and role-switching. If the refuting side cannot persuade the panel, the verdict defaults to "Inconclusive". It reports a 3.3-point gain over single-judge panels. — [PROClaim, arXiv 2603.28488](https://arxiv.org/html/2603.28488v1)
- **Tool-MAD**: debaters use different tools, and the judge outputs SUPPORTS, REFUTES or NOT ENOUGH, weighing a stability score when the debaters do not converge. — [Tool-MAD, arXiv 2601.04742](https://arxiv.org/pdf/2601.04742)
- **TRUST Agents** allows abstention by design, because forcing a binary verdict on weak evidence misleads. Supervised encoder baselines remained substantially stronger in raw accuracy and macro-F1. Retrieval quality and uncertainty calibration are the central bottlenecks. — [TRUST Agents, arXiv 2604.12184](https://arxiv.org/html/2604.12184)

### Inferences
- The decisive variables are **evidence quality and retrieval**, not reasoning effort or the number of agents. Curated context gave +233% macro-F1, and retrieval-stage guidance produced most of SkillCheck's gain. The swarm's budget should go to retrieval, source tiering and archiving before debate rounds.
- Benchmark scores are not comparable across editions. AVeriTeC 2024's 63% and 2025's 33% differ in metric (METEOR vs Ev2R), constraints (open weights, one GPU, one minute) and data.
- The verdict scale must include NEI and "conflicting/cherry-picked". These are exactly where systems fail, and where VeriScore's annotators said "inconclusive" for 42% of claims. Abstention should be a first-class, rewarded outcome in the harness's own evals.
- Self-reported confidence is not a safe gate (the Dunning-Kruger-like finding). Gates should rest on harness-checkable evidence properties: number of independent sources, source tier, verbatim quote match and recency.
- Harness mapping:
  - **Claim decomposer** sub-agent: atomic claims, as in SAFE and VeriScore, each with a check-worthiness flag.
  - **Retriever** sub-agents with the professional skill loaded, using MCP search, fetch and archive tools.
  - **Harness-run checks** (deterministic code): every cited quote appears verbatim in the archived copy; at least two *independent* sources (different owners or domains, not syndicated copies) for a "supported" or "refuted" verdict; each source's publish date precedes the claim's cutoff where relevant (temporal-leakage check, as ClaimCheck does).
  - **Clean-context verifier** on a *different provider*: sees only the claim, the evidence bundle and the archived snapshots, never the retriever's reasoning; must re-derive the verdict or return NEI.
  - **Debate** only for contested claims, with the moderator's neutral bias treated as a known calibration issue. Do not rely on debate for accuracy gains larger than about 3 points.
  - **Output** is a fact-check record that keeps the evidence trail, because experts value usefulness (context, sourcing) and not only the label.

### Gaps
- The full AVeriTeC 2025 leaderboard with per-team Ev2R scores was not retrieved, nor per-class (NEI and conflicting) breakdowns for 2025.
- FEVER (2018) and FActScore (2023) were not separately reviewed beyond their role as antecedents. A "FactCheckBench"-named dataset was not found.
- No 2026 survey of professional fact-checking organisations' (IFCN, Duke Reporters' Lab) use of LLM agents was found. Tow Center work was not retrieved.
- No head-to-head study of a multi-agent fact-checking swarm against professional fact-checkers on the same claims with a full evidence trail was found.

## Q3. OSINT investigations: professional methods translated to agents, tools and reliability, risks, agent systems and evaluations

### Takeaway
Bellingcat's October 2026 tests show large gains for agentic geolocation. Its custom skills on Claude Opus 5.5 (satellite tiles plus OpenStreetMap search) beat every off-the-shelf model on GeoGuessr score, and only it and one other tool found an exact camera position in a hard case. Even so, answers are "rarely an exact match", and the best models "can confidently claim a wrong position".

The OSINT literature has a "hallucination-validation gap": only one OSINT system measured hallucination end to end. Verification, reporting and decision support are the least studied stages, and a human-AI co-pilot model is the defensible near-term design.

### Cited Findings
- **Bellingcat geolocation test (22 Oct 2026)**
  - Setup: 52 unpublished photos (metadata removed, no landmarks, some snowy, foggy or night-time). One coordinate answer required. Tools allowed: built-in search, code execution and page fetch. Limits: 64K output tokens and 15 minutes per photo. Two metrics: GeoGuessr score, and a 0–100 mean log score that rewards narrowing the last few kilometres. — [Bellingcat, Oct 2026](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
  - Results:
    - Gemini 4 Argon had the highest mean log score; Claude Opus and "Fable" were at the top on both metrics.
    - Several models put at least 10 of 52 photos within 1 km, and the top models put over 50% within 25 km.
    - GeoClip beat only Claude Haiku. Grok was the most expensive and in the bottom half.
    - Several tools refused or timed out (e.g. GeoSeer Agent refused 8 photos).
    - — [Bellingcat](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
  - Agentic setup: Bellingcat's skills let the agent download ESRI satellite tiles and query Bellingcat's OpenStreetMap search tool to match features. These runs had no timeout, so the comparison is not direct. Only Gemini Argon beat Bellingcat's agent on mean log score. In the Venice example, 11 of 17 models were within 5 km, but only Bellingcat's agent and GeoSleuth found the exact camera position. — [Bellingcat](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
  - Conclusions: verify independently (match features and perspective, cross-reference sources); treat AI as an assistant for narrowing areas, not a tool to delegate geolocation to; strong human skills remain essential. The article cites the high stakes of military use (a strike on a school in Minab, Iran, which Bellingcat geolocated). It offers no privacy guidance. — [Bellingcat](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
  - Critique of vendor claims: Anthropic's "superhuman" geolocation claim (unreleased Mythos model; median error 37.0 km and 47.2 km on 6,000 photos, about 23–24% within 1 km) used online photos possibly in training data. GeoGuessr imagery is Street View, which is biased to daytime roads in covered countries and has shortcuts. An outside academic called median error "a strong simplification". — [Bellingcat](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
- [OLDER-ish] Earlier Bellingcat rounds:
  - June 2025: 500 tests of 20 models on 25 unpublished photos with Google Lens as baseline. Gemini did worse than Lens, and "all the models, at some point, returned answers that were entirely wrong". — [Bellingcat, Jun 2025](https://www.bellingcat.com/resources/how-tos/2025/06/06/have-llms-finally-mastered-geolocation/); [quote via X post](https://x.com/heinenbros/status/1931147579540246830)
  - An updated test of 24 LLMs reported Google AI Mode the most capable tool overall. — [GIJN](https://gijn.org/stories/updated-test-24-llms-ai-geolocation/)
  - The GIJN result was seen only via a search summary; details are unverified.
- **OSINT survey** (Palmieri et al., arXiv 2607.03233, Jul 2026)
  - Coverage: 74 studies in an 11-category taxonomy.
  - Hallucination: over 20 studies flag it, but only one OSINT-specific RAG system measured end-to-end hallucination, under non-reproducible conditions. The authors call this "the hallucination-validation gap".
  - Lifecycle: collection and analysis are well covered; verification, reporting, dissemination and decision support are not.
  - Recommended design: a human-AI co-pilot in which "analysts retain responsibility for verification and decision-making".
  - Evaluation of OSINT collection is mostly English-language and surface-web.
  - — [arXiv 2607.03233](https://arxiv.org/abs/2607.03233)
- **Tooling**
  - A third-party project packages 320+ tools from Bellingcat's toolkit as AI agent skills across 12 categories, including geolocation, image and video forensics, social media, people search and transport tracking. It is not an official Bellingcat release. — [CasualSecurityInc/Bellingcat-OSINT-Toolkit](https://github.com/CasualSecurityInc/Bellingcat-OSINT-Toolkit)
  - Bellingcat's Auto Archiver (public since 2022) has preserved over 150,000 web pages and posts. It combines yt-dlp with platform-specific archivers, stores to local disk, Google Drive or S3 (cloud storage recommended), and now has an API and web UI. — [Bellingcat, Aug 2025](https://www.bellingcat.com/resources/2025/08/13/the-open-source-tool-that-has-preserved-150000-pieces-of-online-evidence/); [Auto Archiver docs](https://bellingcat.gitbook.io/toolkit/more/all-tools/auto-archiver)
- **Berkeley Protocol** (OHCHR and UC Berkeley Human Rights Center, launched Dec 2020) [OLDER]: the reference standard for professional, legal and ethical digital open-source investigation. Its workflow has separate phases for identification, collection, preservation, verification and analysis, with Preservation (section D) following Collection (section C). — [Berkeley HRC](https://humanrights.berkeley.edu/programs/investigations/berkeley-protocol); [OHCHR PDF](https://unipd-centrodirittiumani.it/public/docs/OHCHR_BerkeleyProtocol.pdf)
- Secondary sources describe sound practice under the Protocol: cryptographic hashing so later alteration is detectable; web-archive formats that capture a page's full state; and preservation paired with verification, proportionality and privacy. — [Privacy Insight Solutions](https://privacyinsightsolutions.com/blog/osint-evidence-standards); [Andrea Fortuna](https://andreafortuna.org/2025/11/05/setting-standards-for-digital-investigations-in-the-age-of-open-source-intelligence/)

### Inferences
- Bellingcat's method translates cleanly into agent roles: hypothesis generation (where could this be), tool-grounded checking (satellite tiles, OSM feature queries, perspective and feature matching), and independent human or second-agent confirmation. The gain came from **tools that ground claims in external data**, not from the model alone. This mirrors the fact-checking finding that evidence access dominates.
- Narrowing to an area is now cheap; *exact* identification is the hard, high-consequence step. The harness should label outputs by precision tier ("region", "within about 5 km", "exact camera position with matched features"), and should require explicit feature-match evidence (overlay or feature list with coordinates) for the top tier.
- Contamination matters for any internal eval. Use unpublished or held-out material, as Bellingcat did, or scores will be inflated.
- Harness mapping:
  - **Collector** sub-agents capture each item through an MCP archive tool at first access: WARC/WACZ or media file plus screenshot, SHA-256 hash, UTC retrieval time and original URL, stored in an immutable evidence store.
  - **Analyst** sub-agents propose hypotheses with explicit precision tiers.
  - **Verifier** (clean context, different provider) gets the archived item and the claimed location or identity plus the feature-match evidence, and must independently confirm or reject.
  - **Human gate**: required before any output names or locates a person, or feeds a decision with physical-world consequences.
  - **People-search and facial-search categories** in the toolkit-as-skills approach should be off by default and policy-gated (see Q5).

### Gaps
- No peer-reviewed agentic OSINT evaluation beyond geolocation was found: none for source triangulation, social-media account attribution or chronolocation.
- Whether Auto Archiver produces WACZ by default today is unverified. The only WACZ evidence is a 2022 prototype description (a WACZ manifest allows tamper and completeness checks). — [inkdroid 2022](https://inkdroid.org/2022/09/26/auto-archiver/)
- The Berkeley Protocol's exact preservation and hashing wording was not retrieved; only its structure and secondary descriptions were.
- No data was found on misidentification rates of AI OSINT agents identifying *people*.

## Q4. Truth and provenance infrastructure: C2PA, web archiving, source reliability, exact quotes, contradiction detection

### Takeaway
C2PA Content Credentials give a signed provenance record when present, but platforms routinely strip them. Absence proves nothing, and presence certifies provenance, not truth. Microsoft Research also warns of "reversal attacks" that make authentic media look synthetic and the reverse. For an investigation swarm, the robust provenance layer is the one the harness controls: archiving at access time, hashing, signed custody logs, verbatim-quote checks, and explicit handling of conflicting evidence.

### Cited Findings
- **C2PA metadata**: cryptographically signed but easily removed before posting. Several platforms recompress uploads and strip credentials, reportedly including Instagram, X, LinkedIn, TikTok, WhatsApp and iMessage. — [arXiv review via search, 2608.07337](https://arxiv.org/pdf/2608.07337); [Swiss Trust Layer (vendor)](https://www.swisstrustlayer.com/blog/c2pa-content-credentials-limitations-2026); [TextSight (vendor)](https://www.textsight.ai/blog/c2pa-content-credentials-guide/)
- C2PA provides a tamper-evident record tied to a signing key; it "does not and was not designed to certify authenticity". — [TrueScreen (vendor)](https://truescreen.io/articles/c2pa-standard-history-limitations/)
- Most online media carries no credential, either because no tool in its chain added one or because a later step stripped it. Missing credentials are therefore not evidence of manipulation. — [TextSight (vendor)](https://www.textsight.ai/blog/c2pa-content-credentials-guide/)
- Adoption is partial: Google uses C2PA data in image-context features, and YouTube added a "Captured with a camera" label. — [Content Credentials, Wikipedia](https://en.wikipedia.org/wiki/Content_Credentials)
  - Conflict: a garbled table snippet claimed Leica, Nikon and Canon do not participate as of mid-2026. This is unverified and conflicts with general knowledge that several camera makers ship credential-capable cameras; treat as unreliable.
- **Microsoft Research technical report** (Jan 2026, arXiv Feb 2026): evaluates cryptographic provenance, imperceptible watermarking and soft-hash fingerprinting across modalities and threat models. Warns of "sociotechnical reversal attacks that can invert integrity signals". Points to secure enclaves on capture devices for high-confidence provenance. — [Media Integrity and Authentication, arXiv 2602.18681](https://arxiv.org/abs/2602.18681)
- Watermarks and fingerprints that survive metadata stripping remain active research rather than a deployed solution. Hybrid metadata-plus-in-content signals are proposed, and robust watermarks fail under diffusion-based editing. — [arXiv 2608.07337](https://arxiv.org/pdf/2608.07337); [Editing Away the Evidence, arXiv 2603.12949](https://arxiv.org/pdf/2603.12949)
- **Web archiving**: Auto Archiver (above) is the main open-source evidence-capture tool, at more than 150,000 items. — [Bellingcat](https://www.bellingcat.com/resources/2025/08/13/the-open-source-tool-that-has-preserved-150000-pieces-of-online-evidence/)
- **Source reliability, quotes and contradictions** in agent workflows: AFP-derived skills encode a 4-tier source reliability hierarchy, cross-verification across *independent* sources, quote-attribution verification, and detection of out-of-context use and cherry-picking. — [SkillCheck](https://arxiv.org/html/2610.25777v1)
- Conflicting-evidence and cherry-picking claims are where AVeriTeC systems perform worst. — [AVeriTeC 2024 overview](https://arxiv.org/pdf/2410.23850)

### Inferences
- Treat C2PA as a *positive signal when present and valid*, record it in the evidence record (signer, assertions, validation result), and never treat its absence as a negative signal. The verifier's prompt and the harness's scoring must encode this asymmetry, or agents will over-read missing metadata.
- Reversal attacks mean a "synthetic or authentic" classifier verdict should never be a sole basis for a conclusion. It is one weighted signal next to provenance, independent corroboration and contextual checks.
- The harness's own provenance is more defensible than any external signal:
  - **Archive-on-access**: every URL the swarm relies on is captured (WARC or WACZ plus screenshot plus hash) when first fetched. Citations point to the archived copy *and* the live URL with retrieval time.
  - **Verbatim-quote check**: a deterministic harness check that each quoted span exists byte-for-byte (after normalisation) in the archived source. Any paraphrase is labelled as such.
  - **Source tiering**: a stored, versioned reliability rating per source (primary document, official record, established outlet, other), so the verifier and humans see why a source was trusted.
  - **Contradiction register**: when sources disagree, the orchestrator records both, and the verdict must be "conflicting" or explain why one source outranks the other. Silently picking one fails the check.
  - **Signed custody**: hash-chain the custody log and sign the final report bundle (evidence hashes, tool-call log and claim-evidence map). This makes the harness's output itself carry C2PA-like provenance, which also addresses the fact that a plain hash guards against accidents, not deliberate tampering.

### Gaps
- No primary C2PA specification or C2PA-organisation adoption data was fetched; most C2PA limitation sources are vendor blogs.
- No independent evaluation of source-reliability rating services (e.g. NewsGuard, MBFC) for agent use was retrieved.
- No study was found that measures LLM accuracy at reproducing *exact* quotes from cited sources in investigative settings. It is reasonable to assume it fails often enough to require a deterministic check, but that is unmeasured here.
- No primary Bellingcat or Auto Archiver documentation on hashing or timestamping of archives was retrieved.

## Q5. Ethics and legal limits for agent investigations (privacy, targeting individuals, data protection)

### Takeaway
The legal perimeter is concrete in the EU. AI that evaluates the reliability of evidence in criminal investigations, or that profiles people during them, is *high-risk* under the AI Act (Annex III 6(c) and 6(e)). Building facial-recognition databases by untargeted scraping is *prohibited* (Art. 5(1)(e)), and remote biometric identification is a high-risk category. GDPR applies to automated processing regardless of human oversight. Professional OSINT standards (Berkeley Protocol) require legality, proportionality and privacy. Agents that aggregate sources raise re-identification and misidentification risk.

### Cited Findings
- **EU AI Act Annex III**, point 6 (law enforcement) high-risk uses include:
  - 6(c), AI used "to evaluate the reliability of evidence in the course of the investigation or prosecution of criminal offences";
  - 6(e), AI "for the profiling" of natural persons in detection, investigation or prosecution of crimes.
  - Point 1(a) covers remote biometric identification ("establishing the identity of a natural person"), excluding one-to-one verification.
  - — [AI Act Annex III](https://artificialintelligenceact.eu/annex/3/)
- **EU AI Act Article 5(1)(e)** prohibits AI systems that "create or expand facial recognition databases" through "untargeted scraping of facial images from the internet or CCTV footage". — [AI Act Art. 5](https://artificialintelligenceact.eu/article/5/)
- The EU AI Act sets strict limits on AI in law enforcement because evidence reliability matters. — [ACM memory forensics paper](https://dl.acm.org/doi/pdf/10.1145/3748263)
- **GDPR and agents** (secondary compliance guides):
  - GDPR applies to any automated processing of personal data whether or not a human monitors each step.
  - Article 22 concerns automated decisions with legal or similarly significant effects.
  - The lawful basis should be documented before an agent is activated.
  - Erasure duties reach agent memory.
  - Agents pulling from several sources at once increase re-identification risk.
  - — [MTM blog](https://www.mtm.video/blog/ai-agents-data-privacy-gdpr-ai-act-compliance-guide-2026/); [Atlan](https://atlan.com/know/data-privacy-for-ai-agents/); [Technova](https://technovapartners.com/en/insights/security-gdpr-enterprise-ai-agents)
- An academic treatment of AI agents under EU law exists (arXiv 2604.04604), but its content was not retrieved. — [AI Agents Under EU Law](https://arxiv.org/pdf/2604.04604)
- **OSINT legality** (secondary): collecting publicly available data is legal in most jurisdictions. Bypassing access controls or breaching platform terms of service is questionable and could create US Computer Fraud and Abuse Act exposure. — [Recosint guide](https://recosint.com/osint-investigations-2026/)
- The **Berkeley Protocol** frames digital open-source investigation as professional, legal and ethical, with preservation paired with proportionality and privacy. — [Berkeley HRC](https://humanrights.berkeley.edu/programs/investigations/berkeley-protocol); [Privacy Insight Solutions](https://privacyinsightsolutions.com/blog/osint-evidence-standards)
- Bellingcat stresses that inaccurate geolocation in military contexts can be life or death. Its October 2026 article gives no guidance on privacy risks of automated location inference. — [Bellingcat Oct 2026](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
- The first-hour survey flags "confident hallucinations in legal contexts" as a major challenge for law-enforcement use. — [arXiv 2609.12681](https://arxiv.org/abs/2609.12681)

### Inferences
- If the harness is used to judge evidence reliability for criminal matters in the EU, it falls in a high-risk category. Logging, human oversight, accuracy documentation and risk management become legal obligations, not good practice. This is an inference from Annex III 6(c); confirm with counsel.
- Harness mapping for limits:
  - **Authorization record**: every investigation starts with a scoped mandate (who authorised it, purpose, lawful basis, subjects in and out of scope, retention period), stored with the case. The orchestrator refuses tasks outside scope.
  - **Policy-gated tools**: people-search, face search and account de-anonymisation tools are off by default, require named human approval per use, and are logged. No tool that builds face databases by untargeted scraping.
  - **Data minimisation**: collectors drop personal data not needed for the mandate. Agent memory and caches follow the case retention and erasure policy.
  - **No ToS-breaking automation**: MCP fetch tools respect access controls and do not bypass logins or rate limits.
  - **Identification threshold**: any output that identifies a private individual requires the verifier's independent confirmation *and* human sign-off, and is labelled with its evidence and confidence tier. Misidentification is the highest-harm error.
  - **Defensive scope only**: DFIR on systems the client owns or is authorised to examine; fact-checking of public claims; OSINT on public information within the mandate.

### Gaps
- No primary EDPB guidance or regulator decision on AI-driven OSINT, or on the GDPR accuracy principle (Art. 5(1)(d)) applied to agent outputs, was retrieved.
- No case law was found on admissibility of LLM-agent-derived evidence (beyond the uncited European anecdote in Q1). No US or UK guidance was retrieved.
- The "Gartner predicts over 2,000 AI legal claims" figure surfaced only via a secondary blog and is not included as a finding.

## Q6. What an "investigation swarm" must have to be defensible (synthesis across Q1–Q5)

### Takeaway
The evidence says swarms are useful for discovery, retrieval and hypothesis narrowing. They are not reliable on completeness, exact identification, conflicting evidence or remediation. Their self-reported confidence is not trustworthy, and LLM judges agree only about 72–75% of the time. Defensibility therefore has to come from harness-enforced properties, not model quality:
- immutable hashed evidence;
- a complete, replayable custody log;
- deterministic checks on citations and coverage;
- an independent clean-context verifier on a different provider;
- first-class abstention;
- human gates on high-consequence conclusions;
- a mandate that bounds privacy and legality.

### Cited Findings
- No model fully detected and fixed any single host. Persistence, timeline linking and remediation were weakest, and procedural skills caused early stopping. — [SecRespond](https://www.alphaxiv.org/abs/2607.26791)
- LLM judges agree 72–75% with each other and ρ ≈ 0.86 with human experts. — [SecRespond](https://www.alphaxiv.org/abs/2607.26791)
- False positives are rarely shared across models, which suggests ensembles. — [AuditBench](https://arxiv.org/html/2606.10281)
- Unlogged intermediate outputs led to a procedural challenge, and timeline reconstruction is non-deterministic across runs (anecdotal). — [arXiv 2504.02963](https://arxiv.org/html/2504.02963)
- Curated evidence beats reasoning or web search. — [DeVerna et al.](https://arxiv.org/abs/2511.18749)
- Retrieval-stage professional guidance gives most of the skill gain. — [SkillCheck](https://arxiv.org/html/2610.25777v1)
- Systems fail most on conflicting and NEI claims. — [AVeriTeC 2024](https://arxiv.org/pdf/2410.23850)
- Debate gives small gains, moderators drift to neutral, and abstention trades accuracy for safety. — [DebateCV](https://arxiv.org/pdf/2507.19090); [PROClaim](https://arxiv.org/html/2603.28488v1); [TRUST Agents](https://arxiv.org/html/2604.12184)
- Model confidence can be inversely related to capability. — [Scientific Reports 2026](https://www.nature.com/articles/s41598-026-39046-w)
- Tool-grounded agents beat bare models, but humans remain key; contamination-free test sets are needed. — [Bellingcat Oct 2026](https://www.bellingcat.com/resources/2026/10/22/can-llms-supercharge-geolocations-our-tests-show-big-improvements-but-humans-remain-key/)
- The near-term defensible design is a human-AI co-pilot in which analysts own verification and decisions. — [OSINT survey](https://arxiv.org/abs/2607.03233)

### Inferences
Requirements checklist, mapped to the harness:

1. **Mandate and scope object** (orchestrator input): authoriser, purpose, lawful basis, in-scope systems or subjects, prohibited tools, retention. The orchestrator and every sub-agent run against it, and an out-of-scope tool call is refused by the harness.
2. **Evidence intake** (harness-owned):
   - SHA-256 on ingest;
   - immutable store;
   - sandboxes mount evidence read-only and work on copies (the write-blocker analog);
   - web evidence archived at first access (WARC/WACZ, screenshot, hash, UTC time);
   - hashes re-verified when the report is sealed.
3. **Custody and replay log** (harness-owned, append-only, hash-chained): every model call (provider, model id and version, prompt or skill version, temperature or seed) and every MCP tool call (tool name and version, arguments, output hash). The report bundle is signed. A person can replay any finding's derivation.
4. **Deterministic-first analysis**: validated forensic or OSINT tools do extraction (parsers, timeline builders, map queries) behind MCP. LLMs interpret, hypothesise and write. Each finding references tool-output records by hash.
5. **Claim–evidence ledger**: findings decomposed into atomic claims, each with evidence pointers (hash and offset, or archive id and verbatim quote), source tier, independence group and precision tier. Harness checks enforce the following, and failures block the report:
   - verbatim-quote match;
   - at least two independent sources for strong verdicts;
   - temporal validity;
   - no claim without evidence.
6. **Coverage checks**: domain checklists (DFIR: persistence, credentials, lateral movement, exfiltration, timeline gaps; fact-check: each sub-claim; OSINT: each identity or location claim). Each item must be marked examined-with-evidence or not-examinable-with-reason. This counters early stopping and the skill-boundary effect.
7. **Clean-context verifier on a different provider**: receives only the claims, the evidence bundle and the archived artifacts, never the investigators' reasoning. It must independently re-derive each claim and may answer "unsupported", "conflicting" or "not enough evidence". Disagreement is escalated, not averaged away. Optionally add a second-provider ensemble for triage verdicts, since false positives are rarely shared.
8. **Calibrated verdict scale with abstention**: supported, refuted, conflicting, NEI and inconclusive are first-class outputs. The harness's own evals reward correct abstention and penalise unsupported certainty. Self-reported confidence is never a gate.
9. **Human gates**: required before (a) identifying or locating a private individual, (b) attributing an attack to an actor, (c) any remediation or containment action on live systems, (d) publishing a verdict. Sign-off is recorded in the custody log.
10. **Contradiction register**: conflicting sources are recorded together, and the report must state how each was resolved.
11. **Provenance signals treated asymmetrically**: a valid C2PA credential is a positive signal and is recorded; absence is neutral; synthetic-media classifier output is one weighted signal and never sole proof (because of reversal attacks).
12. **Privacy and legal controls**: tools for people-search and face search off by default, with per-use approval; no untargeted face scraping; data minimisation; retention and erasure that cover agent memory; no ToS or access-control bypass. EU criminal-evidence use treated as AI Act high-risk.
13. **Evaluation discipline**:
    - held-out, unpublished test material to avoid contamination;
    - LLM judges validated against human labels before use, with judge agreement reported;
    - separate metrics for discovery, false positives, completeness and abstention quality, rather than one accuracy number.

### Gaps
- No published system was found that implements this whole chain (custody log, clean-context verifier and human gates) and reports court or editorial acceptance. The checklist is synthesised from component evidence.
- No study was found that directly measures whether a clean-context verifier on a different provider reduces investigative error compared with a same-context or same-provider verifier in DFIR, fact-checking or OSINT. This is supported only indirectly (AuditBench non-shared false positives, SecRespond judge disagreement).
- No benchmark was found that measures the *reproducibility* of agent investigations across reruns (same evidence, same verdict). This is a key admissibility property that remains unquantified.
