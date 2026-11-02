# AI agents and agent teams for defensive security: vulnerability research, code auditing, threat intelligence, red-teaming one's own systems

Notes current to 2026-11-02. Material older than 2025 is marked **[older: 2024]**. Vendor claims are marked **(vendor claim)**. Low-authority sources (aggregators, unrefereed blogs) are marked **(low-authority)**. This is a summary of architectures, results and safeguards for defensive use. It holds no exploit code and no attack procedures.

Harness vocabulary used in the "maps onto the harness" notes: an orchestrator (lead); sub-agents with **harness-run checks** (`done_when`: `run`/`expect`, `file`/`contains`, `unchanged`, `absent`, `protect: 'tests'`, `hidden` checks the worker never sees; see `src/agents/acceptance.ts`); a **clean-context verifier** returning `pass` / `fail` / `unknown` (`unknown` never counts as a pass); Docker sandboxes; MCP tools (definitions pinned when first seen); several model providers; `scrubbedEnv` for commands.

---

## 1. Systems and results: what agent systems achieve in real security work, and how the best are built

### Takeaway
By late 2026, agent systems find real, previously unknown vulnerabilities at scale. AIxCC finalists found 54 of 63 planted bugs and 18 real zero-days. Claude Opus 4.6 found more than 500 validated high-severity bugs, Claude Mythos Preview more than 1,000, Big Sleep 20 in one batch, and CodeMender had 72 fixes upstreamed. Every credible system pairs the LLM with a **deterministic oracle**: a sanitizer crash, a proof-of-vulnerability (PoV) run, a headless browser, or tests plus fuzzing. Each also has a **final filter**, either an agent or a person, before anything is reported. In AIxCC, reliable engineering and accuracy-gated submission decided the ranking more than how agentic a system was.

### Cited Findings

**DARPA AI Cyber Challenge (AIxCC) final, DEF CON 33, August 2025**
- Teams found 54 unique synthetic vulnerabilities across the final's 63 challenges and patched 43. That is 86% found, up from 37% at the semifinal, and 68% patched, up from 25%. Teams also found 18 real (non-synthetic) vulnerabilities, now in responsible disclosure, and provided 11 patches for them. Average cost was **$152 per competition task**, with remediation averaging 45 minutes. Placings: Team Atlanta first ($4M), Trail of Bits second ($3M), Theori third ($1.5M). All seven finalists agreed to open-source their systems. — [DARPA](https://www.darpa.mil/news/2025/aixcc-results)
- Counting conflict: Cybersecurity Dive reported 70 synthetic vulnerabilities (77% found, 61% patched). DARPA's editor's note corrects the figure to 63. Use the 63-based figures. — [Cybersecurity Dive](https://www.cybersecuritydive.com/news/darpa-ai-cyber-challenge-winners-def-con/757252/); [DARPA](https://www.darpa.mil/news/2025/aixcc-results)
- SoK paper (arXiv 2602.07666): about 143 hours of fully autonomous operation. Each team had $85K of Azure compute and $50K of LLM credits. Total team spend ranged from about $7.8K to $103.3K. Five of the seven teams used less than 25% of their LLM budget. — [SoK: DARPA's AIxCC](https://arxiv.org/html/2602.07666v2)
- Final scores (total / PoV / patch / SARIF / bundle / penalty):
  - Atlanta: 392.8 / 79.6 / 171.0 / 6.0 / 136.2 / −0.4
  - Trail of Bits: 219.4 / 52.4 / 100.9 / 1.0 / 65.1 / −0.6
  - Theori: 210.7 / 54.3 / 101.6 / 4.9 / 49.8 / −16.3
  - Fuzzing Brain: 153.7 / 52.3 / 68.8 / 6.2 / 26.4 / −13.5
  - Shellphish: 135.9 / 47.8 / 54.3 / 8.5 / 25.3 / −0.1
  - 42-b3yond-6ug: 105.0 / 70.1 / 14.2 / 9.7 / 11.0 / −0.3
  - Lacrosse: 9.6 total

  The paper notes that the components do not exactly add up to the totals. — [SoK](https://arxiv.org/html/2602.07666v2)
- Fuzzers alone solved 34 of the 63 vulnerabilities. The cyber reasoning systems (CRSs) found 22 PoVs that parallel fuzzing could not. All seven teams found at least one 0-day: 25 distinct vulnerabilities across 10 projects, of which 12 (48%) were patched. This is the SoK's own count and differs from DARPA's "18 real". — [SoK](https://arxiv.org/html/2602.07666v2)
- Architectures (all from the [SoK](https://arxiv.org/html/2602.07666v2)):
  - **Atlanta (Atlantis):** an ensemble. Independent bug-finding modules share seeds. **Eight patching agents** with different architectures, including off-the-shelf coding agents, compete, and the first valid patch wins. It was the only team to fine-tune LLMs for context retrieval. It used the most resources: 87% of its Azure budget and 59% of its LLM credits.
  - **Trail of Bits (Buttercup):** deterministic workflows break each task into steps. LLMs are used "only where conventional tools fall short", and mid-tier models are preferred over top reasoning models. Patching is multi-agent, with separate agents for root-cause analysis, patch writing, context retrieval and reflection.
  - **Theori (RoboDuck):** agentic-first, built around bug candidates. It uses logprob-based classification as an agent tool and two parallel diff-analysis agents. It submits patches without a PoV, delayed at least 45 minutes and gated on past PoV-patch success.
  - **Shellphish (Artiphishell):** 53 components. Non-LLM root-cause analysis with weighted voting, multi-source voting to rank bug candidates, 5 minutes of post-patch fuzzing, and an agentic patcher ensembled with a one-shot minimal patcher.
  - **42-b3yond-6ug:** traditional fuzzing and program analysis, with LLMs only in auxiliary roles such as seed generation. It tried 16 combinations of temperature and prompt context per patch. It had the second-highest PoV score (70.1), but a submission bug hurt its patch score.
  - **Fuzzing Brain:** 23 standalone strategy scripts, over 90% "vibe-coded". LLM-based PoV generation does most of the work. It uses an LLM as judge and post-patch fuzzing.
  - **Lacrosse:** DSPy escalates from cheaper to more expensive models. On one challenge it generated more than 1,200 PoVs for a single vulnerability, then crashed.
- Accuracy by team:
  - Patch accuracy: Atlanta 83.8%, Trail of Bits 79.2%, Shellphish 100% (strict filtering, and an easier mix of challenges), Theori 31.7%, Fuzzing Brain 23.3%.
  - Bundles (a PoV paired with its patch): 91 of 99 correct; 7 of the 8 wrong bundles failed because the patch was wrong.
  - Accuracy multiplier: AM = 1 − (1 − r)⁴, so 90% accuracy loses about nothing, 50% loses about 6%, and 40% about 13%.

  — [SoK](https://arxiv.org/html/2602.07666v2)
- SoK conclusions:
  - "The real bottleneck is not technique capability but robust integration into autonomous systems."
  - Atlanta won by stability, scoring in all seven phases while rivals went quiet after phases 3 or 4.
  - Shellphish's 53 components still missed bugs that basic techniques could handle.
  - Theori's very agentic design took the largest accuracy penalty.
  - Recommendations: telemetry (decision traces, environment snapshots), PoVs from other teams to validate patches, and semantic-correctness evaluation of patches.

  — [SoK](https://arxiv.org/html/2602.07666v2)
- Buttercup detail:
  - LLM-generated seed inputs feed standard OSS-Fuzz fuzzers (libFuzzer for C/C++, Jazzer for Java) through a shared corpus. — [Trail of Bits blog](https://blog.trailofbits.com/2024/08/09/trail-of-bits-buttercup-heads-to-darpas-aixcc/)
  - The seed generator and patcher call a program model built on CodeQuery and Tree-sitter through LangGraph tools. Patching uses software, security and quality-engineer agents with deterministic hand-offs. — [ToB DEF CON deck](https://www.trailofbits.com/documents/DEFCON_AIxCC_Stage_Talk.pdf)
  - "Seven AI agents" create and validate patches. — [Help Net Security](https://www.helpnetsecurity.com/2025/08/18/buttercup-ai-vulnerability-scanner-open-source/)
  - It runs on 8 cores and 16 GB of RAM, with a built-in LLM budget setting. — [GitHub trailofbits/buttercup](https://github.com/trailofbits/buttercup)

**Google Project Zero / DeepMind: Naptime, then Big Sleep**
- **[older: 2024]** Naptime (June 2024) set out five design principles:
  - space for reasoning
  - an interactive environment
  - specialised tools: a code browser, a Python sandbox, a debugger, and a reporter that signals success or gives up
  - **perfect verification**: the controller checks the success condition, usually an ASan or debugger-observed crash
  - sampling many independent trajectories

  On CyberSecEval 2 with GPT-4 Turbo, buffer overflow rose from 0.05 to **1.00** and advanced memory corruption from 0.16 to 0.76 (the text says 0.24; the post is inconsistent) at 20 trajectories. — [Project Zero: Naptime](https://projectzero.google/2024/06/project-naptime.html)
- **[older: 2024]** Big Sleep (November 2024) found an exploitable stack buffer underflow in SQLite. Its method was **variant analysis**: the agent was given recent commits and diffs and looked for unfixed relatives at HEAD. The bug was fixed the same day, before any release. AFL ran for 150 CPU-hours without finding it, and the OSS-Fuzz harness did not build the affected extension. Google's own caveat: "a target-specific fuzzer would be at least as effective", and the results were "highly experimental". — [Project Zero: From Naptime to Big Sleep](https://projectzero.google/2024/10/from-naptime-to-big-sleep.html)
- August 2025: Big Sleep reported 20 previously unknown flaws, mostly in open source (FFmpeg, ImageMagick). Each was found and reproduced by the agent, with a person reviewing before the report went out. — [Computing](https://www.computing.co.uk/news/2025/security/big-sleep-finds-20-flaws-in-open-source-software)
- CVE-2025-6965 (SQLite before 3.50.2) is credited to Big Sleep, after Google Threat Intelligence saw signs that an exploit was being staged (Google framing via press). — [TechRepublic](https://www.techrepublic.com/article/news-ai-beats-hackers-to-zero-day-exploits/)
- November 2025: five WebKit (Safari) flaws reported to Apple. — [Security Affairs](https://securityaffairs.com/184184/security/google-big-sleep-found-five-vulnerabilities-in-safari.html)
- Pushback: FFmpeg maintainers called the reports "CVE slop" (31 October 2025). One concerned a decoder used for the first frames of a 1995 game. The core complaint was reports arriving without fixes, written up by volunteers. At least some reports were real, for example CVE-2025-59733, fixed 22 August 2025. — [It's FOSS](https://itsfoss.com/news/ffmpeg-google-fiasco/); [TechSpot](https://www.techspot.com/news/110219-ffmpeg-volunteer-maintainers-struggling-keep-pace-ai-generated.html)

**Google DeepMind CodeMender (October 2025), a patching agent**
- Built on Gemini Deep Think. Its tools are a debugger, a source browser, static and dynamic analysis, **differential testing, fuzzing and SMT solvers**. Specialised sub-agents handle sub-problems. An LLM critique tool compares original and modified code to catch regressions, and the agent corrects itself.
- Patches surface only after automated checks that the patch fixes the root cause, is functionally correct, causes no regressions and follows the project's style.
- In six months it upstreamed **72 security fixes**, including in a project of up to 4.5M lines. "All patches ... are reviewed by human researchers before they're submitted upstream." The rollout is gradual, to take in maintainer feedback.
- It also adds proactive hardening, for example `-fbounds-safety` annotations in libwebp.

— [DeepMind blog](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)

**Anthropic**
- **Claude Opus 4.6 (published 5 February 2026):** found and validated more than **500 high-severity vulnerabilities** in open source.
  - Setup: a VM holding the latest project versions, standard utilities, and debuggers and fuzzers. "No special instructions, custom harness, task-specific tooling."
  - The search focused on memory corruption **because it is easier to validate** (crashes, address sanitizers).
  - Claude critiqued, de-duplicated and re-prioritised the crashes. At first, Anthropic's own researchers validated each finding and **wrote the patches by hand**; external researchers joined as volume grew.
  - The post argues that "industry-standard 90-day windows may not hold up" against bugs found this way.

  — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)
- **Claude Mythos Preview / Project Glasswing (April 2026)**, from [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview):
  - Scaffold: each run was a **container isolated from the internet**, with Claude Code and a short prompt. The agent formed a hypothesis, ran the project to confirm or reject it, and output either "no bug" or a report with a PoC and reproduction steps.
  - **Many agents ran in parallel, each assigned a different file**, to reduce duplicates. Files were ranked 1 to 5 for bug likelihood and processed best first. **A final agent re-checked each report** for being real and significant.
  - OSS-Fuzz benchmark (about 1,000 repos, about 7,000 entry points): Sonnet 4.6 and Opus 4.6 reached tier 1 in 150 to 175 cases. Mythos produced 595 crashes at tiers 1 and 2.
  - OpenBSD: about 1,000 runs for under $20,000; the run that found the most critical bug cost under $50. FFmpeg: several hundred runs for about $10,000.
  - More than 1,000 vulnerabilities found, with under 1% fully patched at the time of writing.
  - Validation: ASan-confirmed memory-safety bugs have shown "no false positives so far"; "logic bugs cannot be verified this cleanly". Every report is manually validated by contractors before it is sent.
  - Severity: in **198 manually reviewed reports, experts matched Claude's severity exactly 89% of the time and within one level 98%**.
- Glasswing access: Mythos is not generally available; access is limited to partners, numbered from 11 to about 50 depending on the source. — [The Hacker News](https://thehackernews.com/2026/04/anthropics-claude-mythos-finds.html); [VentureBeat](https://venturebeat.com/data/anthropic-says-its-most-powerful-ai-cyber-model-is-too-dangerous-to-release)
- A secondary claim of "10,000+ zero-days by 24 May 2026" is unverified. — [DEV Community (low-authority)](https://dev.to/akaranjkar08/anthropics-project-glasswing-claude-mythos-found-10000-critical-zero-days-in-30-days-4fni)

**OpenAI Aardvark, now Codex Security**
- Announced 30 October 2025. Its pipeline:
  1. Threat-model the whole repository.
  2. Scan each commit against that model, plus a historical scan when a repository is first connected.
  3. **Confirm exploitability in an isolated sandbox** to cut false positives.
  4. Draft a fix with Codex as a pull request, which a person approves.

  Results: 92% recall on internal "golden" repositories seeded with known and synthetic bugs **(vendor claim; benchmark not public)**, and 10 CVEs in open-source projects. Private beta on GitHub Cloud. — [VentureBeat](https://venturebeat.com/security/meet-aardvark-openais-in-house-security-agent-for-code-analysis-and-patching); [OpenAI](https://openai.com/index/introducing-aardvark)
- Renamed Codex Security; a research preview since 6 March 2026 (per OpenAI's page as summarised in search; the fetch was blocked). — [OpenAI](https://openai.com/index/introducing-aardvark)

**XBOW (autonomous web pentesting, HackerOne)**
- First non-human to top HackerOne's US leaderboard, June 2025. — [Dark Reading](https://www.darkreading.com/vulnerabilities-threats/ai-based-pen-tester-top-bug-hunter-hackerone)
- Report outcomes: about 1,060 submitted. 130 resolved, 303 triaged, **208 duplicates, 209 informative, 36 not applicable** (most closed by XBOW itself), 33 new and 125 pending. Severity over 90 days: 54 critical, 242 high, 524 medium, 65 low. — [XBOW blog](https://xbow.com/blog/top-1-how-xbow-did-it/)
- **Validators** confirm each finding before it is reported. Some use an LLM, others programmatic checks; for XSS, for example, a headless browser checks that the payload executes. Dedup uses SimHash on content plus image hashes of screenshots. Targets are scored on signals such as a WAF, status codes and login forms. **XBOW's security team reviewed every finding before submission**, as HackerOne's policy on automated tools requires. — [XBOW blog](https://xbow.com/blog/top-1-how-xbow-did-it/); [XBOW platform](https://xbow.com/platform)

**Other**
- TitanCA (April 2026): a four-stage pipeline (matching, filtering, inspection, adaptation) that found **118 CVEs plus 203 confirmed zero-days** in open source. Later stages cost more and do more of the false-positive filtering. — [arXiv 2604.17860](https://arxiv.org/abs/2604.17860); [AlphaXiv](https://www.alphaxiv.org/abs/2604.17860)

### Inferences
- **The dominant architecture is a pipeline:** context or threat model, then candidate generation (fuzzing, SAST, LLM hypotheses, variant analysis of recent commits), then oracle confirmation in a sandbox, then dedup, then severity, then patch, then patch validation, then a filter and a person. LLM agents live inside stages. Trail of Bits' "LLMs only where conventional tools fall short" placed second at a fraction of Atlanta's spend; Atlanta's ensemble won by redundancy and stability.
- **Maps onto the harness:**
  - The orchestrator runs this as a fixed workflow, not free-form delegation.
  - Each stage is a sub-agent whose `done_when` checks are the oracle. A finder must leave a reproducer that the harness runs in a Docker container built with sanitizers, with `run` plus `expect` matching a sanitizer signature.
  - A patcher's checks:
    - `protect: 'tests'`
    - the existing tests (`run`)
    - the reproducer no longer firing
    - `hidden` checks the patcher never sees: other agents' PoVs, as the SoK recommends, and a short post-patch fuzz run, as Shellphish did for 5 minutes
- **Ensemble where diversity pays:** finding and patching, as Atlanta did. Several model providers give natural decorrelation, for example N patchers on different providers with "first patch that passes all checks wins". Do not ensemble everything: Shellphish's 53 components did not beat Atlanta's simpler, more stable whole.
- **Per-file sharding, Mythos-style:** a ranking pass scores files 1 to 5, then parallel sub-agents each take one file and must output either "no bug" or a report with a reproducer. This fits orchestrator fan-out directly.
- **Cost anchors for budgeting:** about $152 per AIxCC task; about $20 per Mythos run (\$20K over 1,000 runs) with hits under \$50; most AIxCC teams spent under 25% of their LLM budget. Lacrosse's 1,200 PoVs for one bug argue for a **per-finding cap**, not just a per-run cap.
- **Variant analysis** (Big Sleep) is a cheap, high-yield mode for one's own code: feed each security-fix commit to an agent and ask for unfixed relatives elsewhere in the code.

### Gaps
- There is no public precision figure (reported findings that were real ÷ all reported) for Big Sleep, CodeMender, Aardvark or Mythos beyond the ASan "no false positives so far" statement and the 89% severity agreement.
- No CodeMender acceptance or rejection rate by maintainers was found, and no CodeMender figures after October 2025.
- XBOW's handling of business-logic false positives is mentioned in search summaries but not pinned to a primary source. The core agent design is not public.
- Microsoft Security Copilot's code-security agents and Snyk's AI triage were not covered by primary sources in this pass. Only the phishing triage RCT, in section 4, was found.
- Team Atlanta's own technical report was not read; the details above come from the SoK.

---

## 2. Benchmarks: best scores and what limits them

### Takeaway
On benchmarks where the vulnerability is described or located (patching, one-day exploitation, CTFs), agents now score well: patching 87–90% on BountyBench, 59% on NYU CTF. **Open-ended detection remains the weakest stage**: BountyBench Detect is 0–12.5%, CVE-Bench zero-day about 10–13%, and SEC-bench PoC generation 18%. Realistic, de-duplicated vulnerability classification (PrimeVul) collapses LLMs to near random. Headline 2026 CyberGym scores of 85–91% are self-reported and not comparable across sources.

### Cited Findings
- **CyberGym** (OSS-Fuzz-derived PoC reproduction; ICLR 2026): in the original paper the best agent (Claude Sonnet 4) reached **17.9%**, and all agents combined 18.4%. — [CyberGym arXiv 2506.02548](https://arxiv.org/pdf/2506.02548); [ICLR 2026 listing](https://mlanthology.org/iclr/2026/wang2026iclr-cybergym/)
- CyberGym in 2026, all self-reported or aggregator figures:
  - Sakana Fugu-Cyber: 86.9% (July 2026), not reproduced. — [AgentPedia (low-authority)](https://agentpedia.codes/blog/fugu-cyber-orchestration-security-benchmarks.md)
  - BenchLM tracker: GPT-5.6 Sol 84.5%, Gemini 3.5 Flash Cyber 83.2%; the metrics may be mixed. — [BenchLM (low-authority)](https://benchlm.ai/benchmarks/cybergym)
  - Feyospace-s1 (open-weight): 63.24% verified, 10th on the leaderboard as of 1 September 2026. — [AI Weekly (low-authority)](https://aiweekly.co/editors-blog/found-first-seven-person-team-s-cyber-agent-hits-63-24-on-cybergym-ranks-1st-at)
  - A 91.3% claim from a GCSA press release is unverified.
- **BountyBench** (Stanford, May 2025): 25 real systems with bug-bounty programs, 40 bounties worth $10 to $30,485, covering 9 of the OWASP Top 10. Success is checked by machine:
  - **Exploit:** a verifier passes on the current snapshot and fails on the patched one.
  - **Patch:** unit, integration and health tests still pass and the exploit verifier now fails.
  - **Detect:** runtime invariants fail, or an exploit works on the current snapshot but not on a patched one.

  Results (Detect / Exploit / Patch): Claude Code 5.0 / 57.5 / 87.5%; Codex CLI 5.0 / 32.5 / **90.0%**; custom agent with Claude 3.7 5.0 / **67.5** / 60.0%. Codex CLI refused 11.2% of tasks on safety grounds. — [Stanford CRFM](https://crfm.stanford.edu/2025/05/21/bountybench.html)
- A later BountyBench version lists Codex CLI with o3-high at 12.5% Detect, the best detect score. — [arXiv 2505.15216v3](https://arxiv.org/abs/2505.15216v3) (via search summary)
- **SEC-bench** (2025): state-of-the-art code agents reach **18.0% on PoC generation and 34.0% on patching**. The 81.7%, 39.4% and 69.2% figures are success rates of the benchmark's own builder, exploiter and fixer agents, which assemble and verify instances. php and upx were especially hard (4.2% and 12.0%). — [SEC-bench arXiv 2506.11791](https://arxiv.org/pdf/2506.11791); [AlphaXiv leaderboard](https://alphaxiv.org/benchmarks/university-of-illinois-at-urbana-champaign/sec-bench)
- **CVE-Bench** (40 critical web-app CVEs, eight target outcomes): v1 reported up to **13% zero-day and 25% one-day** (the one-day setting includes the CVE description). v4 reports 13% one-day success at 5 attempts for a hierarchical multi-agent team and 2.5% for a Cybench-style agent. The figures moved between versions. — [CVE-Bench v1](https://arxiv.org/html/2503.17332v1); [CVE-Bench v4](https://arxiv.org/html/2503.17332v4)
- **Cybench** **[older: 2024]** (40 professional CTF tasks): Claude 3.5 Sonnet was the first-run high at 17.5% unguided. — [Cybench paper](https://arxiv.org/pdf/2408.08926v3); [cybench.github.io](https://cybench.github.io)
- Cybench in 2026: open-weight models at pass@10 score 17.5% (Llama 4 Maverick) to 27.5% (gpt-oss-120b). — [CWM Preparedness Report arXiv 2605.00932](https://arxiv.org/pdf/2605.00932)
- **NYU CTF Bench** (200 challenges): an April 2026 study of 10 frontier models has **Claude 4.5 Opus at 59%** and Gemini 3 Pro at 52%. — [arXiv 2604.17159 via Emergent Mind](https://www.emergentmind.com/papers/2604.17159)
- **PrimeVul** **[older: 2024; ICSE 2025]**: 6,968 vulnerable and 228,800 benign functions, de-duplicated with a chronological split. A 7B model drops from **68.26% F1 on BigVul to 3.09% on PrimeVul**, and GPT-3.5 and GPT-4 are "akin to random guessing" in the strictest setting. The paper proposes the Vulnerability Detection Score: the false-negative rate at a fixed 0.5% false-positive rate. — [arXiv 2403.18624](https://arxiv.org/abs/2403.18624)
- **SecCodePLT** **[older: October 2024]**:
  - GPT-4o was the most secure code generator, at a 55% secure-coding rate; Cursor about 60%, failing entirely on some critical CWEs.
  - Security-policy reminders in the prompt raised secure coding by about 20%.
  - Claude refused more than 90% of sensitive attack steps.

  — [SecCodePLT project](https://seccodeplt.github.io); [arXiv 2410.11096](https://arxiv.org/html/2410.11096v1)
- **AutoPatchBench** (Meta, CyberSecEval 4, April 2025): 136 fuzzing-crash samples from ARVO (113 in the Lite set). A patch counts only if it removes the crash, passes **extended fuzzing with no new crashes**, and **matches the ground-truth fix's program state after the patched function returns** (differential testing). — [Meta Engineering](https://engineering.fb.com/2025/04/29/ai-research/autopatchbench-benchmark-ai-powered-security-fixes/)
- **CyberSOCEval** (Meta and CrowdStrike, September 2025), malware analysis and threat-intel reasoning: models scored 43–53% from report images and 5–10 points more from extracted text. **Reasoning models did not gain** their usual test-time-scaling boost; the authors read this as a sign of little security-analysis training. — [arXiv 2509.20166](https://arxiv.org/pdf/2509.20166)
- **ExCyTIn-Bench** (Microsoft; ICML 2026): threat investigation over a **read-only MySQL** database of Microsoft Sentinel logs. The first version has 8 simulated multi-step attacks, 57 tables and 589 questions; a later version has 7,542 questions. Scoring gives decayed partial credit because "binary scoring makes all agents look similar". — [arXiv 2507.14201](https://arxiv.org/abs/2507.14201); [PMLR v306](https://proceedings.mlr.press/v306/wu26bd.html)
- **CTIBench** **[older: NeurIPS 2024]**: GPT-4 scored 71% on CTI-MCQ, 72% on CTI-RCM (mapping to root-cause CWEs), and on threat-actor attribution 52% correct versus 86% "plausible". These numbers come from a third-party summary. — [NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5acd3c628aa1819fbf07c39ef73e7285-Abstract.html); [Liner summary (low-authority)](https://liner.com/review/ctibench-a-benchmark-for-evaluating-llms-in-cyber-threat-intelligence)

### Inferences
- **What limits scores:**
  1. **Search, not reasoning.** Given the location or description, agents patch and exploit well; finding where to look is the bottleneck (BountyBench Detect versus Patch, CVE-Bench zero-day versus one-day).
  2. **Contamination and leakage.** PrimeVul's collapse and "Sifting the Noise"'s post-cutoff set (section 3) show inflated scores on old public data.
  3. **pass@k and scaffold differences** make cross-paper numbers incomparable.
  4. **Weak oracles for logic, web and business-logic bugs**, compared with memory safety.
  5. **Refusals** (Codex CLI 11.2%) on legitimate defensive tasks.
- **Maps onto the harness:**
  - The verification definitions of BountyBench and AutoPatchBench are ready-made `done_when` templates. **Exploit:** the PoV fires on the vulnerable build and not on the patched one. **Patch:** tests pass, the PoV no longer fires, extended fuzzing finds no new crash, and optionally the program state matches a reference fix.
  - The harness needs a check that passes when a command *fails* or an output is *absent*. The existing `absent` check applies to files, so a negated `expect` or an exit-code check would be needed. This is an inference from the Check type; verify against the code.
  - For the harness's own evaluation of a security swarm, use **post-cutoff or private targets**, report detect separately from patch, and use a fixed-FPR metric (VD-Score style) rather than accuracy.

### Gaps
- No primary PentestGPT result was found in this pass. Its USENIX 2024 figures were not retrieved, so none is cited.
- AutoPatchBench per-model pass rates were not retrieved.
- ExCyTIn-Bench and CyberSOCEval per-model scores sit in figures that were not readable here.
- The 2026 CyberGym leaderboard numbers are self-reported or aggregator figures, with unclear metrics (difficulty level, pass@k); no independent replication was found.
- The CyberGym task count and its zero-day by-product counts were not verified in this pass.

---

## 3. Accuracy engineering: confirming findings before reporting, false-positive rates, patch validation

### Takeaway
Precision comes from **executable evidence plus an independent second look plus a person**, not from better prompting:
- For memory-safety bugs, a sanitizer-confirmed crash in a sandbox gives near-zero false positives (Mythos: "no false positives so far").
- For web bugs, programmatic validators (a headless browser) do the same job (XBOW).
- For SAST triage, tool-using agents on strong models remove 93–95% of false positives, but they can suppress real findings, and weak models are inconsistent.
- Patches that pass tests are often semantically wrong: 38–46% in the AIxCC SoK's baseline. Patch acceptance therefore needs PoV re-runs, post-patch fuzzing, differential checks and human review.

### Cited Findings

**Confirming a finding before reporting**
- Naptime's principle of "perfect verification": the result must be checkable automatically with certainty. The reporter tool triggers a controller check for an ASan or debugger-observed crash. — [Project Zero: Naptime](https://projectzero.google/2024/06/project-naptime.html) **[older: 2024]**
- Mythos: the agent must confirm by **running the project**; it outputs "no bug" or a report with a PoC and reproduction steps. A **final agent re-checks** each report. ASan-confirmed bugs have shown "no false positives so far", while logic bugs "cannot be verified this cleanly". Contractors validate every report manually before sending. — [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview)
- Opus 4.6: the targets (memory corruption) were chosen *because* they are easy to validate. Claude critiqued, de-duplicated and re-prioritised crashes ("not every crash is a high-severity vulnerability"), then people validated them. — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)
- XBOW validators: an LLM or programmatic peer reviewer per finding (a headless browser confirms XSS). Dedup by SimHash and screenshot hashing. The outcome mix still shows about 20% duplicates (208 of about 1,060) and about 20% informative (209). — [XBOW blog](https://xbow.com/blog/top-1-how-xbow-did-it/)
- Aardvark: a sandbox confirms exploitability before reporting. — [VentureBeat](https://venturebeat.com/security/meet-aardvark-openais-in-house-security-agent-for-code-analysis-and-patching)
- AIxCC scoring rewarded only machine-verified PoVs, and the accuracy multiplier punished wrong submissions. Atlanta falsely matched PoVs to two invalid SARIF reports. — [SoK](https://arxiv.org/html/2602.07666v2)

**Multiple agents and voting**
- Shellphish used multi-source weighted voting to rank bug candidates. Atlanta ran 8 diverse patchers, first valid patch wins. 42-b3yond-6ug swept 16 combinations of temperature and context. — [SoK](https://arxiv.org/html/2602.07666v2)
- Wagner et al. (June 2025) tested LLMs filtering SAST false positives across 5 SAST tools and 3 languages. The best single LLM removed **33.85% of false positives without losing any true positive**; combining several LLMs raised that to **38.46%**. — [arXiv 2506.16899](https://arxiv.org/abs/2506.16899v1)
- MultiVer (2026), a counterpoint: **union** voting across agents raises recall but gives 48.8% precision, against 63.9% for a fine-tuned baseline. — [arXiv 2602.17875](https://arxiv.org/html/2602.17875v1)
- VulAgent: a hypothesis-validation stage checks candidates against program context and defensive checks, cutting the false-positive rate by about 36% against LLM baselines. — [arXiv 2509.11523](https://arxiv.org/html/2509.11523v1)
- AEGIS: a verifier agent argues for and against exploitability, and an independent audit agent can veto. — [arXiv 2603.20637 via Emergent Mind](https://www.emergentmind.com/papers/2603.20637)
- FuzzingBrain V2: disabling its verifier caused "significant performance and scalability degradation due to unfiltered false positives". — [arXiv 2605.21779 via Emergent Mind](https://www.emergentmind.com/papers/2605.21779)

**False-positive rates of LLM triage of SAST alerts**
- "Sifting the Noise" (arXiv 2601.22952) compared Aider, OpenHands and SWE-agent:
  - **OWASP Benchmark:** a false-positive share above 92% fell to as low as **6.3%** in the best configuration.
  - **Real-world Java with CodeQL:** up to **93.3%** of false positives identified.
  - **Post-cutoff OSS-Fuzz C/C++:** SWE-agent with Claude Sonnet 4 identified **95.5% of false positives at 95.5% precision**, against 36.4% for vanilla prompting.
  - Gains were "limited or inconsistent" with weaker backbones and varied by CWE. Aggressive filtering can suppress real vulnerabilities, and costs differ widely between frameworks.

  — [arXiv 2601.22952](https://arxiv.org/abs/2601.22952)
- ZeroFalse gives the model **the SAST tool's exact dataflow path plus CWE-specific metadata**, not just the function. On the OWASP Benchmark the best F1 was 0.912 (grok-4) and 0.910 (gemini-2.5-pro); scale or a long context alone did not guarantee generalisation. — [arXiv 2510.02534](https://arxiv.org/html/2510.02534v1)
- SAST-Genius: Semgrep's 225 false positives fell to 20 **(self-reported)**. — [arXiv 2509.15433](https://arxiv.org/pdf/2509.15433)
- Semgrep Assistant, from more than 2,000 findings triaged by researchers:
  - Agreement with researchers is **96% on true positives but only 41% on false positives** (25% in its first version). It was deliberately conservative: "more likely to suggest a developer fix a FP than ignore a TP".
  - The biggest gain came from passing the **rule's confidence value**. Other context: rule metadata, earlier triage decisions, memories, and a few dozen lines around each dataflow step.
  - Developers start tuning a SAST tool out at about **10–30% noise**.

  — [Semgrep blog](https://semgrep.dev/blog/2025/building-an-appsec-ai-that-security-researchers-agree-with-96-of-the-time/) **(vendor claim)**
- Semgrep later reported that Assistant handles about 60% of new SAST triage for customers, with over 96% agreement when customers audit it. Its metrics documentation labels a "96%" figure differently, as false-positive confidence. — [Semgrep blog](https://semgrep.dev/blog/2025/semgrep-is-confidently-handling-60-of-all-triage-for-users-without-reducing-coverage); [Semgrep docs](https://cloudflare.semgrep.dev/docs/semgrep-assistant/metrics) **(vendor claim; internal inconsistency)**
- Severity calibration: across 198 reviewed Mythos reports, severity matched exactly 89% of the time and within one level 98%. — [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview)

**Patch validation**
- In the SoK baseline, **37.7% (Claude Code) and 45.6% (MultiRetrieval) of patches that passed automated tests were flagged as semantically wrong** in manual review. — [SoK](https://arxiv.org/html/2602.07666v2)
- Patch accuracy tracked how strictly patches were gated:
  - Atlanta 83.8%, Trail of Bits 79.2%, Shellphish 100%, the latter with strict filtering and 5 minutes of post-patch fuzzing.
  - Theori (31.7%) and Fuzzing Brain (23.3%) submitted patches without a PoV, delayed by at least 45 minutes or until half the time had passed.

  — [SoK](https://arxiv.org/html/2602.07666v2)
- CodeMender: differential testing, fuzzing, SMT, and an LLM critique comparing old and new code. A patch must fix the root cause, be functionally correct, cause no regression and follow the style; a person reviews it before upstream. — [DeepMind](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)
- AutoPatchBench: crash removed, plus extended fuzzing with no new crash, plus program state equal to the reference fix. — [Meta Engineering](https://engineering.fb.com/2025/04/29/ai-research/autopatchbench-benchmark-ai-powered-security-fixes/)
- Anthropic first **wrote patches by hand** and is "working to automate patch development". — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)

**What false positives cost**
- curl ended its HackerOne bounty on 31 January 2026, citing AI "slop". By mid-2025 about 20% of submissions were slop. The programme had confirmed 78–81 vulnerabilities over six years, for about $86–90K. — [The Register](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/); [BleepingComputer](https://bleepingcomputer.com/news/security/curl-ending-bug-bounty-program-after-flood-of-ai-slop-reports/)
- Even the attackers in GTG-1002 had to validate the model's output: it "claim[ed] to have obtained credentials that did not work" and presented public information as discoveries. — [The Hacker News](https://thehackernews.com/2025/11/chinese-hackers-use-anthropics-ai-to.html)

### Inferences
- **Precision ladder for a security swarm**, strongest first:
  1. An executable oracle: a sanitizer crash, an exploit-verifier pass/fail pair, or a headless-browser check.
  2. A clean-context verifier on a different provider that sees only the report, the reproducer and the code.
  3. Voting by intersection or veto, never union, when precision is the goal.
  4. A person for anything that reaches an outside party.
- **Maps onto the harness:**
  - **Finder `done_when`:** a `run` of the reproducer in a fresh sanitizer-built container, with `expect` matching a sanitizer or crash signature. A `hidden` re-run on a clean build stops the finder from passing by editing the target.
  - **Clean-context verifier:** the Mythos "final agent". It receives the report and reproducer but not the finder's chain of thought. It returns `pass` (real and significant), `fail` (not real or minor) or `unknown`. Logic, authorization and business-logic bugs with no oracle should default to `unknown`, which routes to a person and never counts as a pass. This matches Mythos ("logic bugs cannot be verified this cleanly").
  - **Severity agent:** a separate calibration step. The 89% exact agreement is a reasonable target to measure against a human-labelled sample.
  - **Dedup:** shard by file or function at fan-out, then hash or cluster findings (stack-trace hash for crashes; SimHash for web responses) before the verifier runs, to save verifier spend.
  - **SAST triage sub-agent:** give it the alert's exact dataflow path, the CWE metadata, the rule's confidence, and earlier triage decisions (ZeroFalse, Semgrep), plus code-navigation tools (agents beat one-shot prompts). Tune toward keeping true positives: "suppress" decisions go to a backlog, never deleted (the Semgrep pattern), and the 10–30% noise threshold can serve as a product target.
  - **Patch acceptance as harness checks:** `protect: 'tests'` and the existing tests pass; the original PoV no longer fires; `hidden` PoVs from other finders no longer fire; a short post-patch fuzz run (5 minutes as at Shellphish, longer for release) finds nothing new; optionally a differential check against a reference behaviour. Then the verifier reviews the diff for root-cause fit. No patch without a PoV until there is evidence it works.
  - **The harness's "Finding" signal** (added lines that can game a check: skipped tests, early exits) matters especially for security patches, because "delete the vulnerable feature" or "catch and ignore" patches pass crash checks.
- **Track accuracy as a first-class metric**, as AIxCC's multiplier did. Report precision at the verifier and at the person separately, so that drift in either shows.

### Gaps
- No independent, cross-vendor measurement of precision for agent-reported vulnerabilities in production (Aardvark's "low false positives" is unquantified).
- No published false-positive rate for XBOW validators by vulnerability class.
- The precision gain from a verifier on a different provider versus the same provider was not found in the literature; this is a design hypothesis to test.
- No ablation tables were read for AEGIS or VulAgent.

---

## 4. Threat intelligence and log/alert triage with agents: measured accuracy, hallucination, grounding

### Takeaway
Evidence for SOC and threat-intel agents is thinner and mostly vendor-authored. The best controlled result is Microsoft's 167-analyst randomized controlled trial (RCT) of its Phishing Triage Agent: up to **6.5× more true positives per analyst-minute** and **77% better verdict accuracy**. Independent benchmarks (CyberSOCEval at 43–53%; ExCyTIn-Bench, where multi-hop investigation "remains a real challenge") show that analysis over logs and reports is far from solved. Hallucinated evidence (claims of found credentials, of "sensitive" discoveries) is the documented failure mode. Grounding through read-only query tools over the actual data is the pattern the benchmarks use.

### Cited Findings
- **Microsoft Phishing Triage Agent RCT** (arXiv 2511.13860, November 2025; Microsoft-authored, not peer-reviewed):
  - 167 professional analysts triaged a privacy-vetted corpus of real user-submitted emails, with or without the agent.
  - The agent-assisted group had up to **6.5× the true positives per analyst-minute** and **77% better verdict accuracy**.
  - The agent had 100% precision and recall on this corpus, though the authors note it "will occasionally have" false negatives and false positives.
  - Analysts spent **53% more time on malicious emails** and **did not rubber-stamp** the agent's malicious verdicts.
  - Gains depend on agent accuracy and the base rate of malicious mail.

  — [arXiv 2511.13860](https://arxiv.org/html/2511.13860v1)
- Under an "accuracy counterfactual" (a higher malicious rate and lower agent accuracy), the F1 gain was 48%, against 77% on the corpus's ground truth; precision rose 106–134%. — [Moonlight summary (low-authority)](https://www.themoonlight.io/review/randomized-controlled-trials-for-phishing-triage-agent)
- **ExCyTIn-Bench:** agents investigate through **query actions against a read-only MySQL** database of Sentinel-style logs (57 tables). Multi-hop investigation rarely succeeds in one shot, so the benchmark uses decayed partial credit. — [arXiv 2507.14201](https://arxiv.org/abs/2507.14201)
- **CyberSOCEval:** malware detonation reports and threat-intel reports, as multiple choice. 43–53% from images, 5–10 points more from text. Test-time reasoning gave little lift. The malware part is Windows-centric, with few novel threats. — [arXiv 2509.20166](https://arxiv.org/pdf/2509.20166)
- **CTIBench:** motivated by "concerns about reliability, accuracy, and hallucinations" of LLMs in threat intelligence. Threat-actor attribution: about 52% correct against 86% "plausible", which shows a gap between plausible and correct. — [NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5acd3c628aa1819fbf07c39ef73e7285-Abstract.html); [Liner (low-authority)](https://liner.com/review/ctibench-a-benchmark-for-evaluating-llms-in-cyber-threat-intelligence) **[older: 2024]**
- **Hallucinated evidence in autonomous operations** (GTG-1002, November 2025): Claude claimed credentials that did not work and presented publicly available information as sensitive discoveries, so the human operators "had to carefully validate all results". — [The Hacker News](https://thehackernews.com/2025/11/chinese-hackers-use-anthropics-ai-to.html); [AI News](https://www.artificialintelligence-news.com/news/anthropic-details-cyber-espionage-campaign-orchestrated-by-ai/)
- Threat intelligence feeding vulnerability research: CVE-2025-6965 was found by Big Sleep after Google Threat Intelligence saw indicators of an exploit being staged (press framing). — [TechRepublic](https://www.techrepublic.com/article/news-ai-beats-hackers-to-zero-day-exploits/)

### Inferences
- **Hallucination risk in triage is asymmetric.** A fabricated indicator or a "plausible" attribution looks exactly like a real one. Every claim an agent makes in an alert verdict or a threat-intel summary should cite a **query result or a log row ID** that the harness can re-run. A claim that cannot be re-run is `unknown`, not `pass`.
- **Maps onto the harness:**
  - Expose security data as **read-only MCP tools**: a SIEM query, an EDR timeline, a threat-intel lookup, ExCyTIn-style read-only SQL. Each tool returns stable row or event IDs.
  - A triage sub-agent's `done_when` check could re-run the cited queries and confirm that each cited ID exists and supports the claim (a `run` check against a query CLI).
  - The clean-context verifier gets the verdict plus the cited evidence only, and checks entailment. It never sees the triager's reasoning.
  - For phishing and alert queues, the RCT shows that the value is in **routing analyst time** to likely-true positives. Design the output as a ranked queue with evidence, not an auto-close, unless measured precision on one's own data is very high. Auto-close needs a held-out human-labelled sample re-measured periodically, because base rates shift.
  - Use partial-credit, multi-hop evaluations (ExCyTIn-style) for internal testing of investigation agents; binary pass/fail hides progress.
- **Reasoning effort may not buy much** for SOC analysis (CyberSOCEval). Route triage to cheaper models and reserve expensive ones for the verifier or for the hard multi-hop cases, as Lacrosse escalated in AIxCC.

### Gaps
- No independent, field-measured precision or recall was found for Microsoft Security Copilot agents beyond the phishing RCT, nor for Google's or other vendors' SOC agents in this pass.
- No quantified hallucination rate (fabricated indicators per report) for threat-intel summarisation agents was found.
- Per-model ExCyTIn-Bench scores were not readable.

---

## 5. Safety and dual-use: sandboxing, egress, scope, audit, disclosure, provider policies

### Takeaway
The same capabilities serve attackers. In GTG-1002, Claude Code was manipulated into running 80–90% of a state actor's tactical work against about 30 targets. Frontier labs now gate their strongest cyber models: Mythos is limited to partners, and OpenAI's Trusted Access for Cyber requires identity verification. They also add activation-level misuse probes. For a defensive swarm, the baseline controls are:
- network-isolated containers by default, with a domain allowlist through a proxy outside the sandbox
- scope enforced at the tool layer, failing closed
- no secrets in the agent's environment, since prompt injection from the code under review is proven
- a per-tool-call audit trail
- human review before any outside disclosure, coordinated disclosure timelines, and enough care not to flood maintainers

### Cited Findings

**Sandboxing and egress**
- Mythos ran in a container "isolated from the internet and other systems". — [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview)
- Opus 4.6 ran in a VM. — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)
- Claude Code's sandbox:
  - Network traffic goes through a **proxy running outside the sandbox**, so only approved domains are reachable. The first request to a new domain asks for approval.
  - Filesystem limits are enforced by the OS: Seatbelt on macOS, bubblewrap on Linux.
  - Both permission modes enforce the same filesystem and network limits.

  — [Claude Code docs: sandboxing](https://code.claude.com/docs/en/sandboxing); [Anthropic article](https://claude.com/resources/articles/beyond-permission-prompts-making-claude-code-more-secure-and-autonomous)

**Prompt injection against security agents**
- "Comment and Control" (April 2026): Anthropic's Claude Code Security Review action, Google's Gemini CLI Action and GitHub's Copilot Agent were coerced into **leaking API keys and tokens** available to the Actions runner, through PR titles, issue bodies and comments. Anthropic reportedly said the action "is not designed to be hardened against prompt injection", then added a tool restriction and documentation. Bounties paid were $100 to $1,337. — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/)
- The CSA links the August 2025 Nx compromise to AI CLIs (Claude Code, Gemini CLI, Amazon Q) used as credential sources. — [CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-comment-control-github-prompt-injection-20/)

**Scope**
- XBOW was removed from a program that prohibited automated scanners. Its program scopes were parsed partly by an LLM and partly by hand, because scope is "not always machine-readable". Every finding was reviewed by people, as HackerOne's policy on automated tools requires. — [XBOW blog](https://xbow.com/blog/top-1-how-xbow-did-it/)
- Practitioner guidance (low-authority):
  - Enforce scope **at the tool layer, not the prompt**.
  - Bind the agent to approved targets, an environment and a time window; **fail closed** when scope data is missing; require re-approval for any scope change.
  - Log denials as well as successful calls.

  — [NHIMG FAQ (low-authority)](https://nhimg.org/faq/how-should-security-teams-implement-scope-enforcement-for-ai-pentesting-agents/)
- An example audit log: one JSONL record per tool call, with a timestamp, session ID, tool, sanitised arguments, a result summary and a trace ID. — [ProtoPen security model (low-authority)](https://protopen-marketing.pages.dev/docs/explanation/security-model)

**Disclosure and maintainer load**
- Mythos:
  - Coordinated disclosure no later than **90 + 45 days** after the report.
  - **SHA-3 hash commitments** of unpublished reports and exploits are published as timestamped proof, 15 hashes in the appendix.
  - People triage reports so as not to overwhelm maintainers.
  - Anthropic commits to announcing in advance any relaxation of human review.

  — [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview)
- Opus 4.6: human-validated reports and human-reviewed patches, because many projects lack security staff; 90-day windows "may not hold up". — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)
- CodeMender: every patch is reviewed by a person, and submissions ramp up gradually. — [DeepMind](https://deepmind.google/discover/blog/introducing-codemender-an-ai-agent-for-code-security/)
- Aardvark: findings disclosed under OpenAI's updated coordinated-disclosure policy; people approve patches. — [VentureBeat](https://venturebeat.com/security/meet-aardvark-openais-in-house-security-agent-for-code-analysis-and-patching)
- Maintainer backlash at volume: FFmpeg ("CVE slop", fund us or stop) and curl ending its bounty. — [It's FOSS](https://itsfoss.com/news/ffmpeg-google-fiasco/); [The Register](https://www.theregister.com/2026/01/21/curl_ends_bug_bounty/)

**Provider policies and safeguards**
- Anthropic:
  - **Cyber-specific probes on the model's internal activations** to detect misuse at scale, wired into enforcement pipelines.
  - Possible real-time blocking of traffic judged malicious, which Anthropic acknowledges may add friction for defenders.

  — [Anthropic: zero-days](https://www.anthropic.com/research/zero-days)
- Mythos is not generally available. New safeguards were planned for an upcoming Claude Opus model, and a **Cyber Verification Program** for legitimate professionals whose work is affected. — [Anthropic: Mythos Preview](https://www.anthropic.com/research/mythos-preview)
- OpenAI **Trusted Access for Cyber** (February 2026, launched with GPT-5.3-Codex, OpenAI's first model rated "High" for cyber under its Preparedness Framework):
  - Identity verification at chatgpt.com/cyber, with team access through OpenAI.
  - Expanded in April 2026 to thousands of verified individuals and hundreds of teams. The top tiers get **GPT-5.4-Cyber**, a more cyber-permissive variant.
  - OpenAI describes "defense-in-depth" rather than any single safeguard.

  — [OpenAI: Trusted Access for Cyber](https://openai.com/index/trusted-access-for-cyber/); [OpenAI: scaling trusted access](https://openai.com/index/scaling-trusted-access-for-cyber-defense/); [IT Brief](https://itbrief.com.au/story/openai-expands-cyber-access-for-verified-defenders)
- Refusals as friction: Codex CLI refused 11.2% of BountyBench tasks, and SecCodePLT found that Claude refuses more than 90% of sensitive attack steps. — [Stanford CRFM](https://crfm.stanford.edu/2025/05/21/bountybench.html); [SecCodePLT](https://seccodeplt.github.io)

**Misuse precedent**
- GTG-1002 (November 2025), attributed with high confidence to a Chinese state-sponsored actor: Claude Code was manipulated into attempting intrusions at about 30 organisations, with some successes. The AI executed **80–90% of the tactical work**. — [The Hacker News](https://thehackernews.com/2025/11/chinese-hackers-use-anthropics-ai-to.html)

### Inferences
- **Maps onto the harness:**
  - **Sandboxes.** Security sub-agents run only in Docker. The default is **no network** (`--network none`). Red-teaming one's own systems gets an egress proxy outside the container that allows only in-scope hosts and ports, follows the Claude Code pattern, and logs every denial. Build targets with sanitizers inside the container. Never mount host credentials, and use `scrubbedEnv` for every command.
  - **Scope as data, enforced by the harness.** Keep a signed scope document per engagement: targets, the owner's authorisation reference, a time window, allowed tool classes, and rate limits. Each MCP tool and the egress proxy check it before acting and fail closed. A scope change needs a person's approval in the app, never the agent's own request. The model is told the scope but is not trusted to keep to it.
  - **Prompt injection.** Code, issues, logs, web pages and threat-intel feeds under analysis are hostile input. The analysing agent holds no secrets and no write access to the repository or tracker. Its outputs (reports, patches) go through the verifier and a person before any side effect, such as opening a PR, filing an issue or emailing a maintainer. The harness's pinning of MCP tool definitions guards against tool-definition drift. Treat the content of tool results as data too.
  - **Audit.** Append-only JSONL per tool call: tool, arguments, target, scope decision, sandbox ID, timing, result hash. Add the run's model and provider and the verifier's verdict. Store reproducers and reports by hash; Mythos-style hash commitments are cheap and give a tamper-evident record.
  - **Disclosure.** For third-party code (dependencies), the swarm's output stops at a human-reviewed draft. Rate-limit outgoing reports per project. Attach a patch where possible, which answers the FFmpeg and curl complaint. Follow coordinated disclosure (90 + 45 days as in Mythos). Nothing leaves without a person's approval.
  - **Providers.** Expect refusals and friction on legitimate defensive tasks (11.2% refusals in BountyBench, Anthropic probes). The harness should surface a refusal as a distinct outcome (not a failure to retry on another provider without the person knowing), and record which provider tier, such as a verified cyber-access tier, an engagement used. Routing a refused task to a less-guarded provider without the person's knowledge would defeat provider safeguards and should not be automatic.
  - **Capability gating inside the product.** Keep exploit development (beyond a minimal crash or PoV that proves reachability) off by default for the swarm. Patch, harden, and confirm with the least proof that satisfies the oracle; Anthropic's and OpenAI's tiered access mirrors this.

### Gaps
- No primary, standards-body guidance specific to scope enforcement and egress control for autonomous pentest agents was found in this pass; the scope sources above are practitioner or vendor pages. OWASP's agentic-application guidance was not retrieved.
- HackerOne's exact policy text on automated tools was not retrieved; it is known only through XBOW's description.
- The current terms of Anthropic's Cyber Verification Program (planned in April 2026) and of Trusted Access tiers as of November 2026 were not confirmed.
- The details of the June 2026 Claude Code Action issue-injection report (RyotaK) were found only in a secondary source and are not cited.
