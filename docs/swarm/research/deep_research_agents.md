# Deep-research agents: how they are built, how accurate they are, and what makes their citations trustworthy

Notes compiled 2026-11-02. Labels used throughout: **[vendor]** = number reported by the company that built the system; **[aggregator]** = third-party leaderboard site of unknown rigour; **[older]** = material from before 2026; **[unverified]** = seen only in a search snippet or secondary summary, not in the primary source. "Harness note" lines in each Inferences section say how a technique could be built into the TypeScript harness (orchestrator, sub-agents with harness-run checks, a clean-context verifier, MCP tools, several model providers).

---

## 1. How the leading systems are built (architecture, search/crawl tools, planning, iteration, synthesis, citation step)

### Takeaway
Almost every serious system uses the same skeleton: plan, then fan out searches in parallel sub-agents that each have their own context, compress what they found, synthesise centrally, then attribute citations in a separate step. The differences are in (a) whether the search behaviour is trained end to end with RL (OpenAI, Kimi, Tongyi) or prompted (Anthropic, open_deep_research, STORM), (b) how evidence is reduced before synthesis (PaperQA2's rerank-and-summarise step is the best-documented), and (c) whether there is a dedicated attribution/verification pass at the end.

### Cited Findings

**Anthropic multi-agent Research (engineering post, June 2025) [older]**
- Orchestrator-worker: a lead agent (Claude Opus 4) plans and spawns Sonnet 4 sub-agents that search in parallel, each with its own context window, using interleaved thinking to judge tool results — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- The lead saves its plan to memory because context beyond 200,000 tokens is truncated; near context limits, agents summarise completed phases, store them externally and spawn fresh sub-agents that reload the plan — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- A separate **CitationAgent** runs after synthesis, processing the documents and the report to place each citation — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Sub-agents can write outputs to external storage and pass lightweight references back to the coordinator, reducing information loss and token overhead — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Effort-scaling rules embedded in the prompt: simple fact-finding = 1 agent, 3–10 tool calls; direct comparisons = 2–4 sub-agents, 10–15 calls each; complex research = more than 10 sub-agents. The lead spawns 3–5 sub-agents in parallel and each uses 3+ tools in parallel; parallelism cut research time "up to 90%" on complex queries — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- [vendor] Multi-agent system beat single-agent Opus 4 by 90.2% on Anthropic's internal research eval. On BrowseComp, token usage alone explained 80% of performance variance; tokens, number of tool calls and model choice together explained 95% — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Cost: agents use ~4x the tokens of chat; multi-agent systems ~15x — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Failure modes seen early: 50 sub-agents spawned for simple queries, endless searches for nonexistent sources, sub-agents duplicating each other because delegation was vague, over-long specific queries (fixed by "start broad then narrow"). A tool-testing agent that rewrote flawed tool descriptions cut task completion time by 40% — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Production: durable execution with checkpoints and resume-from-error, full tracing, "rainbow deployments" (old and new versions run side by side while traffic shifts) so updates don't break agents mid-run; the lead waiting synchronously on each sub-agent batch is named as a bottleneck — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)

**OpenAI Deep Research**
- Launched 2025-02-03; produces cited reports after browsing 5–30 minutes; originally a specialised o3; lightweight version on o4-mini (April 2025); since February 2026 based on GPT-5.2, with the ability to restrict research to selected sites and connect data through MCP servers — [Wikipedia: ChatGPT Deep Research](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research)
- Built on an early o3 optimised for browsing, trained on new browsing datasets made for research use, plus reused o1 safety data; a separate o3-mini summarises chains of thought for display — [Deep research System Card, via secondary copy](https://scrapbox.io/nikkie-memos/Deep%20research%20System%20Card) [unverified against openai.com]
- OpenAI itself says it "occasionally makes factual hallucinations … or incorrect inferences" and may not convey uncertainty accurately — [Wikipedia: ChatGPT Deep Research](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research)

**Google Gemini Deep Research**
- December 2025 agent: Gemini 3 Pro as reasoning core, iteratively plans, formulates queries, reads results, identifies knowledge gaps and searches again; exposed to developers through the **Interactions API** — [The Decoder](https://the-decoder.com/google-opens-updated-deep-research-agent-to-developers-with-new-api/); [9to5Google](https://9to5google.com/2025/12/11/gemini-deep-research-agent/)
- Current docs list a newer model id `deep-research-preview-04-2026` and a second tier "Deep Research Max" aimed at maximum comprehensiveness — [Gemini API docs](https://ai.google.dev/gemini-api/docs/deep-research?hl=zh-cn) [unverified: seen via search summary]

**Open and RL-trained research agents**
- **Tongyi DeepResearch** (Alibaba, technical report Oct 2025): 30.5B-parameter MoE with 3.3B active, built on Qwen3-30B-A3B-Base, trained by "agentic mid-training" plus agentic post-training (WebSailor line) — [arXiv 2510.24701](https://arxiv.org/abs/2510.24701v2)
- **Kimi-Researcher** (Moonshot, June 2025): trained entirely by end-to-end agentic RL; its HLE score went from 8.6% to 26.9% through RL alone — [Moonshot Kimi-Researcher](https://moonshotai.github.io/Kimi-Researcher) [vendor, older]
- **LangChain open_deep_research**: LangGraph pipeline of clarification → research brief → supervisor that splits the brief and delegates to parallel researcher sub-graphs (each in an isolated context, ending with a compression step) → final report; models configured per role (research, compression, report); default 3 supervisor reflection rounds. The supervisor/researcher design has been moved to `legacy/multi_agent.py` and the current graph differs — [GitHub open_deep_research](https://github.com/langchain-ai/open_deep_research); [PyPI](https://pypi.org/project/open-deep-research/)

**Stanford STORM / Co-STORM [older, 2024]**
- STORM's pre-writing stage discovers perspectives by surveying existing articles on similar topics, then uses those perspectives to drive simulated question-asking to a "topic expert" grounded in web search, then builds an outline before writing; evaluated on FreshWiki (recent Wikipedia articles, to avoid training leakage); editors found it beat an outline-driven RAG baseline on breadth and organisation — [arXiv 2402.14207](https://arxiv.org/html/2402.14207v1); [GitHub stanford-oval/storm](https://github.com/stanford-oval/storm)
- Co-STORM (EMNLP 2024) adds a collaborative discourse protocol with a human in the loop and a dynamic mind map — [STORM/Co-STORM summary](https://bhanneke.github.io/RISE/projects/storm/)
- The project's own README says output is not publication-ready and often needs significant edits — [GitHub stanford-oval/storm](https://github.com/stanford-oval/storm)

**FutureHouse / Edison Scientific: PaperQA2, Robin, Kosmos**
- PaperQA2 (Sept 2024) [older]: a GPT-4-Turbo agent with four tools. *Paper Search* (keyword search, 12 candidate papers, parsed with PyMuPDF by default, Grobid for WikiCrow, chunked); *Gather Evidence* (dense top-k=30 retrieval, then **RCS = reranking and contextual summarisation**: each ~2,250-token chunk becomes a 200–400-token question-specific summary plus a relevance score); *Citation Traversal* (adds references and citing papers of high-scoring papers, 12-paper limit); *Generate Answer* (top summaries injected; default 15, but 5 gave the best accuracy). Averages 1.26 searches, 0.46 traversals and 14.5 papers per question — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)
- PaperQA2 ablations: removing the agent loop lowered accuracy (p=0.015); removing RCS significantly reduced retrieval accuracy (p<0.001); smaller models (GPT-3.5, Llama3-70B) in the RCS step lowered accuracy; Grobid vs PyMuPDF and chunk size made no significant difference — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)
- Robin's ablations: removing its PaperQA2-based agents (Crow/Falcon) "dramatically increases hallucinated citations" — [Scripps AI enablement review](https://scripps-ai-enablement.github.io/sci-ai-enabler/autonomous-science/systems/kosmos.html)
- Kosmos (Nov 2025, Edison Scientific spin-out): runs of up to 20 cycles; collaborators estimated one 20-cycle run equalled ~6 months of their own research time [vendor] — [Edison Scientific](https://edisonscientific.com/articles/announcing-kosmos); [arXiv 2511.02824](https://www.emergentmind.com/papers/2511.02824)

**Google AI co-scientist (Feb 2025 preprint; Nature 2026 per secondary sources)**
- Multi-agent system on Gemini 2.0: Generation, Reflection (acts as peer reviewer on correctness, novelty, rigour), Ranking (pairwise simulated debates scored as an **Elo tournament**), Proximity (similarity graph to cluster and de-duplicate ideas), Evolution (refines top-ranked hypotheses), Meta-review (final proposal); "generate, debate and evolve" — [arXiv 2502.18864](https://arxiv.org/pdf/2502.18864); [Scripps review](https://scripps-ai-enablement.github.io/sci-ai-enabler/autonomous-science/systems/co-scientist-google.html)
- Validation cases include liver-fibrosis epigenetic targets tested in human hepatic organoids — [Scripps review](https://scripps-ai-enablement.github.io/sci-ai-enabler/autonomous-science/systems/co-scientist-google.html) [secondary]

**Sakana AI Scientist and its critique [older, 2025]**
- Independent evaluation (Beel, Kan, Baumgart; SIGIR Forum 2025): 42% of attempted experiments failed (mostly coding errors); some manuscripts contained hallucinated numerical results; literature reviews were weak and established ideas (e.g. micro-batching for SGD) were labelled novel; few and outdated citations; needed substantial human guidance; cost ~$6–15 per paper — [arXiv 2502.14297](https://arxiv.org/abs/2502.14297); [Beel group summary](https://isg.beel.org/?p=10425)

**Elicit**
- [vendor] Screening "correctly screens in" 94% of papers vs published reviews; extraction 94–99% accuracy vs manual extraction; Elicit itself notes a 2025 Cochrane brief said there was no full independent report on its accuracy — [Elicit blog](https://elicit.com/blog/how-we-evaluated-elicit-systematic-review)

### Inferences
- The convergent design is: **plan → parallel isolated searchers → per-searcher compression → central synthesis → separate citation/attribution pass**. The harness already has an orchestrator that delegates to agents; the missing pieces for a research swarm are (1) an evidence store that sub-agents write to and pass references from (Anthropic's "artifact handoff"), (2) a compression contract for what a searcher returns, and (3) a dedicated attribution step that is not the writer.
- Harness note (effort scaling): put Anthropic-style budget rules into the lead's procedure (the harness already sizes effort for teams) and enforce them with harness limits on sub-agent count and tool calls per sub-agent, rather than trusting the prompt alone — the 50-sub-agent failure shows prompts drift.
- Harness note (RCS): PaperQA2's single most important component was turning raw chunks into short, question-specific summaries with a relevance score before the writer sees them. This maps onto a cheap-model "reader" sub-agent or an MCP tool (`gather_evidence(question, doc_ids) → [{doc_id, span, summary, score}]`), but the ablation says the RCS model must be strong; do not put the smallest provider on this step.
- Harness note (ideation tasks): the co-scientist tournament (pairwise LLM comparisons → Elo) is a cheap, model-agnostic way to rank many candidate hypotheses or report drafts; it fits as a harness-run loop over the multi-provider pool, using a different provider as judge than as generator.
- RL-trained agents (OpenAI, Kimi, Tongyi) learn search persistence that prompted agents must be told explicitly; for a harness that orchestrates third-party models, the practical analogue is a hard minimum-search policy plus a "what is still unknown" reflection step before stopping.

### Gaps
- No primary architecture details found this session for **Perplexity Deep Research**, **xAI Grok DeepSearch/DeeperSearch**, **GPT-Researcher**, **WebThinker** or **Search-R1** beyond a single benchmark number for Search-R1 (see section 2).
- The current (2026) Anthropic Research architecture and the GPT-5.2-based OpenAI Deep Research internals were not found; the Anthropic post is from June 2025.
- OpenAI's own system-card page could not be fetched (HTTP 403); training details above come from a secondary copy.

---

## 2. Measured accuracy on independent benchmarks

### Takeaway
BrowseComp (find-the-needle web browsing) went from ~50% in early 2025 to low-90s for frontier agents by October 2026 and is close to saturated; HLE with tools sits in the mid-40s; long-form report benchmarks (DeepResearch Bench, DRACO) show far lower and noisier numbers, and citation/factual-accuracy axes are consistently the weakest. On a fixed corpus (BrowseComp-Plus), the retriever matters as much as the model.

### Cited Findings

**BrowseComp (OpenAI, April 2025; 1,266 hard browsing questions with short verifiable answers)**
- Benchmark definition: 1,266 questions requiring persistent navigation for hard-to-find, entangled information; short answers easy to check; deliberately excludes long-form answers and ambiguous queries — [arXiv 2504.12516](https://arxiv.org/abs/2504.12516) [older]
- OpenAI Deep Research scored 51.5% at launch of the benchmark (GPT-4o with browsing ~1.9%) — [OpenAI BrowseComp](https://openai.com/index/browsecomp/) [older; page returned 403 to my fetch, figure from prior knowledge, verify before citing]
- [vendor] Gemini Deep Research (Dec 2025) 59.2% vs Gemini 3 Pro 49.4%; coverage says GPT-5 Pro was at 59.5% — [The Decoder](https://the-decoder.com/google-opens-updated-deep-research-agent-to-developers-with-new-api/)
- [vendor] Tongyi DeepResearch 43.4% (BrowseComp), 46.7% (BrowseComp-ZH) — [arXiv 2510.24701](https://arxiv.org/abs/2510.24701v2)
- [aggregator] October 2026 leaderboards disagree on the leader but cluster at 90–94%: BenchLM (2026-10-29) Atria Dawn Preview 92.5%, GPT-5.6 Sol 92.2%, Kimi K3.1 Pro 92.1% (top within 0.4 points, "nearing saturation"); TensorFeed (2026-10-19, vendor-reported) GPT-6 Astra 91.5%, Kimi K3 91.2%, Claude Opus 5 90.8%; Mercor APEX GPT-6 Astra 94.2% on a 130-question public subset; BenchLM lists Claude Opus 5 at 93.6% in a separate 10-agent configuration; GPT-5.5 Pro was 90.1% in May 2026 — [BenchLM](https://benchlm.ai/benchmarks/browsecomp); [TensorFeed](https://tensorfeed.ai/benchmarks/browsecomp); [Mercor APEX](https://www.mercor.com/apex/oss-benchmarks/oss-browsecomp-leaderboard/); [Steel leaderboard](https://leaderboard.steel.dev/leaderboards/browsecomp/); contradicted by [BenchLeader](https://www.benchleader.com/benchmarks/kaggle_browsecomp) (Gemini 3.1 Pro 31.2% as leader — likely a different setup or stale)

**BrowseComp-Plus (fixed corpus; ACL 2026)**
- Static, human-verified corpus of 100,195 documents; each query paired with verified supporting documents and mined hard negatives, so retrieval and reasoning can be separated — [arXiv 2508.06600](https://arxiv.org/html/2508.06600v1); [ACL 2026](https://aclanthology.org/2026.acl-long.1023.pdf)
- With BM25, open-source Search-R1 reaches 3.86% vs GPT-5 55.9%; GPT-5 with Qwen3-Embedding-8B retriever reaches 70.1% with fewer search calls; a better retriever can "in some cases" double agent accuracy on the same corpus — [ACL 2026](https://aclanthology.org/2026.acl-long.1023.pdf); [NeurIPS listing](https://neurips.cc/virtual/2025/130840)
- Open-source agents often issue too few search calls to use the evidence pool (Search-R1-32B ~1.78 calls) — [Emergent Mind summary](https://www.emergentmind.com/topics/browsecomp-plus-benchmark) [aggregator]

**Humanity's Last Exam (HLE)**
- OpenAI Deep Research 26.6% (Feb 2025) vs DeepSeek R1 9.4% and GPT-4o 3.3% — [Wikipedia: ChatGPT Deep Research](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research) [older]
- Kimi-Researcher 26.9% pass@1, 40.17% pass@4 [vendor, older] — [Moonshot](https://moonshotai.github.io/Kimi-Researcher)
- Perplexity Deep Research 21.1% (Feb 2025) [vendor, older] — [Perplexity blog](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) [from prior knowledge, not re-fetched]
- Tongyi DeepResearch 32.9% — [arXiv 2510.24701](https://arxiv.org/abs/2510.24701v2)
- [vendor] Gemini Deep Research 46.4% on full HLE vs Gemini 3 Pro 43.2% — [The Decoder](https://the-decoder.com/google-opens-updated-deep-research-agent-to-developers-with-new-api/)
- [aggregator] Community tool-augmented board: Gemini Deep Research 46.4 (2025-12-11), open model "Inkling" 46.0 (2026-07-15); Scale's no-tools board top was GPT-6 Astra 54.8% (Oct 2026) — [HLE agents-with-tools leaderboard](https://zoom-ai-hle-leaderboard.hf.space/); [BenchLM HLE with tools](https://benchlm.ai/benchmarks/hleWithTools)

**GAIA**
- OpenAI Deep Research ~67% (2025) — [secondary, via search summary](https://scrapbox.io/nikkie-memos/Deep%20research%20System%20Card) [unverified, older]

**DeepSearchQA (Google, Dec 2025)**
- 900 hand-crafted tasks in 17 fields testing multi-step research comprehensiveness; [vendor] Gemini Deep Research 66.1% vs Gemini 3 Pro 56.6% — [The Decoder](https://the-decoder.com/google-opens-updated-deep-research-agent-to-developers-with-new-api/); [36Kr](https://eu.36kr.com/en/p/3592003605528580)

**DeepResearch Bench (USTC; ICLR 2026)**
- 100 PhD-level research tasks across 22 fields; RACE scores report quality against reference reports (Gemini-2.5-Pro as judge), FACT measures citation accuracy (C.Acc) and effective citations (E.Cit) — [arXiv 2506.11763](https://arxiv.org/pdf/2506.11763)
- Claude-3.7-Sonnet with search: RACE 40.67, C.Acc 93.68%, E.Cit 32.48 — [arXiv 2506.11763](https://arxiv.org/pdf/2506.11763)
- LangChain open_deep_research (GPT-5): RACE 50.60, C.Acc 32.94, E.Cit 21.06 — [ICLR 2026 paper notes](https://en.papernotes.org/ICLR2026/llm_evaluation/deepresearch_bench_a_comprehensive_benchmark_for_deep_research_agents/)
- [vendor] Felo Research claims RACE 49.37, ahead of Gemini-2.5-Pro Deep Research at 48.92 — [Felo blog](https://felo.ai/ja/blog/deepresearch-bench/)
- Third-party listing: Claude Researcher ~45 overall, Nvidia AIQ 40.52, Perplexity Research 40.46 — [arXiv 2601.20843](https://arxiv.org/pdf/2601.20843)
- Caveat from the benchmark community: FACT depends on the scraper used (Jina vs vendors' internal fetchers), and some systems lack FACT scores due to UI/format issues; absolute RACE scores are clustered, so rankings matter more than gaps — [ICLR 2026 paper notes](https://en.papernotes.org/ICLR2026/llm_evaluation/deepresearch_bench_a_comprehensive_benchmark_for_deep_research_agents/)

**DRACO (Perplexity, Feb 2026)**
- 100 tasks in 10 domains sampled from de-identified Perplexity Deep Research requests; LLM-judge rubrics on accuracy, breadth/depth, presentation/objectivity and citation quality; compared OpenAI, Gemini, Claude Opus and Perplexity deep research; Perplexity's own system scored best (benchmark built by Perplexity) — [arXiv 2602.11685](https://arxiv.org/html/2602.11685v1)
- Reported by later papers: the best system reaches only 65% citation quality and 68% factual accuracy — [search summary attributing to DRACO via arXiv 2605.06635](https://arxiv.org/html/2605.06635v1) [unverified: my fetch of 2605.06635 did not find these numbers]

**Scientific-literature benchmarks**
- LitQA2 (248 questions): PaperQA2 precision 85.2% ± 1.1, accuracy 66.0% ± 1.2, "insufficient information" 21.9%; human experts (n=9, full internet, unlimited time) precision 73.8% ± 9.6, accuracy 67.7% ± 11.9. Precision is "superhuman" (p=0.0036); accuracy is not significantly different (p=0.66). Original PaperQA: 36.7% accuracy — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2) [older]
- SciArena (Yale/NYU/Ai2; NeurIPS 2025): human-researcher pairwise votes on literature-grounded answers, Elo leaderboard; July 2025: 23 models, 13,000+ votes, o3 first; later 47 models, 20,000+ votes, top o3, Claude 4.1 series, GPT-5. Best automated judge agreed with human preference only 65.1% of the time on SciArena-Eval — [arXiv 2507.01001](https://arxiv.org/pdf/2507.01001v2); [NeurIPS 2025](https://neurips.cc/virtual/2025/poster/121564)
- Kosmos: independent experts classified 102 statements from three reports; 79.4% supported — [arXiv 2511.02824](https://www.emergentmind.com/papers/2511.02824); a separate radiation-biology evaluation found useful hypotheses but "need for rigorous validation" — [arXiv 2511.13825](https://arxiv.deeppaper.ai/papers/2511.13825v1)
- Elicit, independent: a preprint across seven life/environmental-science reviews found high-accuracy mode value matches dropped to 77%, with 10% quote matches and 0% reasoning matches; concluded it complements but cannot replace human extractors — [EcoEvoRxiv](https://ecoevorxiv.org/repository/view/9909/); a medRxiv non-inferiority preprint found AI-assisted extraction non-inferior and cheaper — [medRxiv](https://www.medrxiv.org/content/10.64898/2026.02.25.26347053)

### Inferences
- Short-answer browsing benchmarks are now near ceiling for frontier models; they no longer discriminate between research systems and say nothing about long-form faithfulness. For a high-stakes research swarm, the meaningful numbers are long-form citation/factual-support rates (section 3), which sit around 50–80% even for the best systems.
- BrowseComp-Plus shows retrieval quality can double accuracy with the same model. Harness note: treat the search/rerank layer as a first-class, swappable MCP tool with its own eval (recall against a small gold set), not as a fixed built-in.
- PaperQA2's "superhuman" result is specifically higher **precision** (it abstains with "insufficient information" 21.9% of the time), not higher accuracy. Harness note: give sub-agents and the final writer an explicit "insufficient evidence" outcome and score it as better than a wrong answer.
- SciArena's 65% judge–human agreement means an LLM verifier on literature tasks needs calibration against human labels before it is trusted as a gate; the harness's acceptance checks should report judge agreement on a labelled set.

### Gaps
- No independent current (Nov 2026) numbers found for GAIA, DeepResearchGym, ResearchBench, or LitQA2 for systems other than PaperQA2.
- Most late-2026 BrowseComp/HLE numbers come from aggregator sites and vendor reports; no single audited leaderboard was found. Model names such as "GPT-6 Astra", "Atria Dawn Preview" and "Kimi K3.1 Pro" appear only on aggregators in this research.
- Perplexity Deep Research's and Grok's current benchmark scores were not found.

---

## 3. Citation and claim faithfulness (hallucinated/unsupported citations, claim-level verification, source reliability, contradictions, PaperQA2)

### Takeaway
Link validity is mostly solved (>94% live for frontier models), but **whether the cited page actually supports the sentence** is not: 2026 audits put claim-level support at roughly 24–77% depending on the model, deep-research modes hallucinate more URLs than plain search modes, more searching can lower support, and most final-report errors are introduced by the orchestrator/writer, not the searchers. Cheap harness-run checks (URL liveness, restricting citations to visited pages) nearly eliminate fake URLs; claim-support checking needs a per-sentence verifier against stored source text.

### Cited Findings

**Rates of hallucinated / non-resolving citations**
- Rao, Wong, Callison-Burch (UPenn, 2026-04-03): across DRBench and ExpertQA, 3–13% of cited URLs are hallucinated and 5–18% do not resolve. Deep-research agents: 10.7% hallucinated, 16.2% non-resolving; search-augmented models: 4.8% and 6.8%. Per system: gemini-2.5-pro-deepresearch 13.3% hallucinated / 18.5% non-resolving; openai-deepresearch 3.5% / 10.1% (about 65% of its dead links were stale rather than invented); claude-3-7-sonnet-with-search 3.2% / 8.5% — [arXiv 2604.03173](https://arxiv.org/html/2604.03173v1)
- Same paper, mitigation: open-source **urlhealth** classifies URLs as LIVE, DEAD (404 with a Wayback snapshot), LIKELY_HALLUCINATED (404 with no snapshot) or UNKNOWN. Letting agents self-correct with it on 435 ExpertQA questions cut non-resolving rates: GPT-5.1 16.0% → 0.6%, Gemini 2.5 Pro 6.1% → 0.1%, Claude Sonnet 4.5 4.9% → 0.8%; post-mitigation hallucination 0.4–1.8%. Weak tool users benefit less (gpt-5-nano 7.5% not-live vs 0.6% for GPT-5.1). Recommends restricting URL generation to pages actually visited — [arXiv 2604.03173](https://arxiv.org/html/2604.03173v1)
- Onweller et al. "Cited but Not Verified" (2026-05-07): Markdown AST parser extracts citation–claim pairs with no LLM; each URL fetched and scored on Link Works (binary), Relevant Content (LLM judge, source truncated to 5,000 chars) and Fact Check (LLM judge of support, calibrated on 50–100 manual reviews). Fact Check ranges from 24% (OSS-120B) to 77% (Claude Opus 4.5); e.g. GPT-5.2 58.8%, Claude Sonnet 4.6 58.7%, Gemini 3.1 Pro 48.5%, GPT-5.4 47.7%; link validity ≥94% for frontier models — [arXiv 2605.06635](https://arxiv.org/html/2605.06635v1)
- Same paper: as tool calls scale from 2 to 150, Fact Check falls ~42% on average — GPT-5.4 78.6% → 16.7%, Claude Opus 4.6 80.0% → 57.9%; "more retrieval does not produce more accurate citations." Cites an external range of 11–57% citation hallucination across deployed models (Yuan et al. 2026) — [arXiv 2605.06635](https://arxiv.org/html/2605.06635v1)
- DeepTRACE (Salesforce/Microsoft; ICLR 2026): decomposes answers into statements, scores confidence, builds citation and factual-support matrices across 8 dimensions; citation accuracy 40–80% across systems; listing more sources does not guarantee better grounding — [arXiv 2509.04499](https://arxiv.org/pdf/2509.04499); [Microsoft Research](https://microsoft.com/en-us/research/publication/deeptrace-auditing-deep-research-ai-systems-for-tracking-reliability-across-citations-and-evidence)
- Dermatology literature-review comparison (JMIR 2026): OpenAI Deep Research ~95% of citations identifiable, ~70% fully correct; Gemini 2.5 Pro Deep Research and Perplexity Deep Research had ~47–50% of references with fake authors or titles — [JMIR 2026;e88195](https://www.jmir.org/2026/1/e88195) [unverified: page body did not load; figures from search summary]

**Where errors are introduced**
- Hirsch, Wan, Wang, Stengel-Eskin, Bansal, Dagan (EMNLP 2026): test each agent call locally for faithfulness and verifiability against its own inputs; taxonomy = hallucination, uncited input reliance, uncited output, insufficient citations. Across three top open-source deep-research systems, almost every agent errs except single-document summarisers; in AI-Q, 84.7% of final-report errors originate at the orchestrator, ~31% of those are hallucinations and the rest citation mistakes; two simple interventions raised citation recall 5% without hurting quality — [arXiv 2608.24306](https://arxiv.org/abs/2608.24306)

**Claim-level verification methods**
- FActScore (2023) [older]: split long-form text into atomic facts and check each against a knowledge source; score = share supported — [arXiv 2305.14251](https://arxiv.org/abs/2305.14251) [from prior knowledge, not re-fetched]
- SAFE (Google DeepMind, 2024) [older]: an LLM splits a response into individual facts and checks each with multi-step Google Search; agreed with crowd annotators 72% of the time and was judged right in 76% of disagreements, at >20x lower cost — [arXiv 2403.18802](https://arxiv.org/abs/2403.18802) [from prior knowledge, not re-fetched]
- DRIFT / TELBench (June 2026): claim-centric auditing that tracks each claim through the agent's trajectory, checks support in trajectory evidence and flags spans where unsupported or conflicting claims affect the answer; built from 2,790 real trajectories; up to 30-point gains in error-span localisation — [arXiv 2606.02060](https://arxiv.org/abs/2606.02060)
- Anthropic's production eval: one LLM-judge call with a rubric (factual accuracy, citation accuracy, completeness, source quality, tool efficiency) giving a 0.0–1.0 score and pass/fail matched humans best; ~20 real queries were enough early on; human testers caught agents preferring SEO content farms over authoritative sources — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)

**How PaperQA2 reached "superhuman" literature QA (2024) [older]**
- Precision (not accuracy) beat experts: 85.2% vs 73.8% because the agent abstains when evidence is insufficient (21.9% of answers) — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)
- WikiCrow (PaperQA2 writing Wikipedia-style articles) vs Wikipedia on 375 expert-graded statements: cited-but-unsupported 13.5% vs 24.9%; uncited 3.5% vs 13.6%; precision 86.1% vs 71.2%; reasoning errors 12 vs 26 — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)
- Mechanism: full-text papers, RCS (question-specific summaries with relevance scores) before writing, citation traversal, and few (5) high-scoring summaries in the final prompt — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)

**Contradiction handling**
- ContraCrow (PaperQA2-based): AUC 0.842 on ContraDetect; at threshold 8, 73% accuracy, 88% precision, 7% false-positive rate; picked "lack of evidence" 98% of the time when no evidence existed; on 93 biology papers it flagged 6.85% of 3,180 claims, 2.34 ± 1.99 contradictions per paper, 70% validated by experts. Human–human agreement 75.5% vs human–ContraCrow 60.4% — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2)
- DeepTRACE found deep-research modes still gave one-sided answers to debate questions (GPT-5 DR 54.7%, YouChat DR 63.1%, Copilot DR 94.8%), and Perplexity's search mode stayed above 90% confidence even when one-sided — [arXiv 2509.04499](https://arxiv.org/pdf/2509.04499) [figures from search summary of the paper]

**Source reliability**
- Tow Center (CJR, March 2025) [older]: tools cited syndicated/copied versions instead of publishers' originals and fabricated links; licensing deals did not guarantee correct citation — [CJR Tow Center](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php)
- EBU/BBC (2025-10-22) [older]: 31% of assistant news answers had serious sourcing problems (missing, misleading or incorrect attribution); Gemini 72% — [EBU press release](https://www.ebu.ch/news/2025/10/ai-s-systemic-distortion-of-news-is-consistent-across-languages-and-territories-international-study-by-public-service-broadcaste)

### Inferences
- The two dominant failure classes need different defences. **Fake/dead links** are cheaply fixed by construction: the harness should only allow citations that reference an evidence-store id for a page the swarm actually fetched (Rao et al.'s recommendation), then run a urlhealth-style liveness check. **Unsupported claims** need a per-sentence check of the sentence against the stored text of its cited source.
- Harness note (citation by id): sub-agents' fetch tool writes `{id, url, canonical_url, fetched_at, content_hash, text, title, author, published_at}` to an evidence store; the writer cites `[E17]`, never a raw URL; a harness-run check rejects any citation id not in the store and any raw URL in the report. This turns URL hallucination from a model behaviour into a schema violation.
- Harness note (support check): reuse Onweller's cheap pipeline — parse the Markdown report into sentence–citation pairs deterministically, then send each pair (sentence + cited span, not the whole report) to a **clean-context verifier** on a different provider than the writer. Require a verbatim supporting quote from the source and check by string match that the quote exists in the stored text; only then ask the model whether the quote entails the sentence. Output per-claim SUPPORTED / PARTIAL / UNSUPPORTED / CONTRADICTED.
- Harness note (where to verify): Hirsch et al. show most final errors come from the orchestrator/writer. Verification must run on the final report against the evidence store, not only on sub-agent outputs; sub-agent outputs that summarise a single document are the most reliable layer and can be trusted more.
- Harness note (depth): because support falls as tool calls rise, cap tool calls per sub-agent and spend extra budget on reading and verifying fewer sources more deeply rather than on more searches.
- Harness note (contradictions and one-sidedness): add a dedicated "counter-evidence" sub-agent per contested claim, and a ContraCrow-style pass that compares extracted claims across sources and surfaces conflicts in the report instead of silently picking one; require the writer to state confidence and disagreement explicitly.
- Harness note (abstention): give the writer an "insufficient evidence" path per question and score it above an unsupported answer, mirroring PaperQA2's precision gain.

### Gaps
- No independent, cross-system study found that applies one claim-support method to the current (late 2026) commercial deep-research products together; the numbers above come from different methods and dates and are not directly comparable.
- The two specific interventions in Hirsch et al. that raised citation recall 5% were not in the abstract.
- No source found with measured performance of automated **source-reliability scoring** (domain reputation, primary-vs-secondary classification) inside deep-research agents.

---

## 4. Crawling and data mining at scale (tools, dedup, coverage, rate limits, legal/robots, cost per report)

### Takeaway
Search APIs for agents have converged on similar quality and price (~$5–8 per 1,000 queries), and independent rankings flip with the metric; the larger quality levers are the retriever/reranker and full-text parsing. Access is getting harder legally and technically (Cloudflare default-blocking AI crawlers since mid-2025, pay-per-crawl, disputes over stealth crawling). Cost per report ranges from ~$1–5 for focused literature QA to much more for wide multi-agent runs (~15x chat tokens).

### Cited Findings

**Search and retrieval tools**
- AIMultiple agentic benchmark (2026, 8 APIs): Brave 14.89, Firecrawl 14.58, Exa 14.39, Tavily 13.67, with overlapping confidence intervals (only Brave vs Tavily significant); latency Brave ~669 ms, Firecrawl ~1,335 ms — [AIMultiple](https://aimultiple.com/agentic-search) [aggregator]
- OpenBenchmarks (Sept 2026): single-query accuracy Exa fast 99.3% at $7/1k queries (~652 ms), Firecrawl ~95% at $5/1k, Brave ~93–94% at $5/1k, Tavily basic ~87.7% at $8/1k; on an agent-search F1 table Parallel basic led at 46.5% — [OpenBenchmarks](https://openbenchmarks.com/web-search/most-accurate-search-api) [aggregator]
- Artificial Analysis search index (Sept 2026): Perplexity 80, Parallel 75, Brave 75, Exa 74, Firecrawl 73 — [search summary citing Artificial Analysis](https://michaellivs.com/blog/web-search-for-agents-2026/) [unverified]
- OpenAI Deep Research (Feb 2026) can be restricted to selected sites and can pull data through MCP servers — [Wikipedia: ChatGPT Deep Research](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research)
- Retriever quality on a fixed corpus can double accuracy; GPT-5 rises from 55.9% (BM25) to 70.1% (Qwen3-Embedding-8B) with fewer searches — [ACL 2026 BrowseComp-Plus](https://aclanthology.org/2026.acl-long.1023.pdf)

**PDF/full-text extraction**
- PaperQA2 used PyMuPDF by default and Grobid for WikiCrow; switching parser or chunk size made no significant difference on LitQA2, while full-text retrieval plus RCS mattered — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2) [older]

**Deduplication and coverage**
- Tow Center: AI search cited syndicated and copied versions rather than publishers' originals, even for articles whose exact excerpt returned the original in Google's top three — [CJR Tow Center](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php) [older]
- Google co-scientist's Proximity agent clusters similar hypotheses with a similarity graph to avoid redundancy — [Scripps review](https://scripps-ai-enablement.github.io/sci-ai-enabler/autonomous-science/systems/co-scientist-google.html)
- BrowseComp-Plus measures coverage as recall against human-verified supporting documents; open-source agents make too few searches (~1.78) to exploit the pool — [Emergent Mind summary](https://www.emergentmind.com/topics/browsecomp-plus-benchmark) [aggregator]

**Legal / robots / access**
- Cloudflare (mid-2025): every new Cloudflare domain blocks known AI crawlers by default; "Pay Per Crawl" lets sites charge crawlers using HTTP 402; "AI Labyrinth" wastes resources of bots that ignore rules — [Search Engine World](https://www.searchengineworld.com/cloudflare-for-seo-a-deep-dive-into-bot-management-ai-crawler-control-and-pay-per-crawl); [llmrefs](https://llmrefs.com/blog/cloudflare-blocks-ai-crawlers)
- Cloudflare (Aug 2025) accused Perplexity of "stealth crawling": after its declared bot was blocked via robots.txt and WAF, an undeclared crawler with rotating IPs/ASNs and a Chrome-on-macOS user agent fetched test domains; Cloudflare delisted Perplexity as a verified bot; Perplexity denied it; Cloudflare said OpenAI respected robots.txt — [Decrypt](https://decrypt.co/333479/cloudflare-perplexity-ai-stealth-crawlers-website-blocks); [CyberScoop](https://cyberscoop.com/perplexity-blocks-on-crawlers-cloudflare/)
- Tow Center found several chatbots answered from publishers that had blocked their crawlers — [CJR Tow Center](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php) [older]

**Cost per report**
- PaperQA2 $1–3 per query; WikiCrow $4.48 ± $1.02 per article, ~491.5 s each — [arXiv 2409.13740 (HTML)](https://arxiv.org/html/2409.13740v2) [older]
- Sakana AI Scientist ~$6–15 per paper — [Beel group](https://isg.beel.org/?p=10425) [older]
- Multi-agent research uses ~15x chat tokens — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)
- Gemini Deep Research described as comparable to GPT-5 Pro on BrowseComp at an order of magnitude lower price — [The Decoder](https://the-decoder.com/google-opens-updated-deep-research-agent-to-developers-with-new-api/) [vendor framing]

### Inferences
- Harness note (tool layer): expose search, fetch, PDF-to-text and rerank as separate MCP tools behind one interface so providers can be swapped by config; the harness's existing MCP server builder (OpenAPI → tools) can wrap Brave/Exa/Tavily/Firecrawl APIs, with keys as vault secrets.
- Harness note (dedup/canonicalisation): on fetch, store canonical URL (rel=canonical, DOI), a content hash and a near-duplicate fingerprint (e.g. MinHash/SimHash over shingles); collapse syndicated copies to the original publisher and count "independent sources" per claim by distinct origin, not by URL.
- Harness note (coverage): maintain a per-question checklist of sub-questions/entities from the plan and report which have ≥1 supporting source; this is a cheap coverage measure that does not need a gold set. For eval, build a small BrowseComp-Plus-style gold set from the user's domain.
- Harness note (politeness/legal): the fetch tool should check robots.txt and identify itself with a declared user agent, honour HTTP 402/429 and Retry-After, rate-limit per host, and record the access decision in the evidence store; never fall back to a disguised browser after a block (the Perplexity dispute is the reputational risk).
- Harness note (cost): set a per-run token/USD budget at the orchestrator (the harness already has team spend limits) and size the swarm to the question (Anthropic's 1 / 2–4 / 10+ rule); a focused literature question should cost low single dollars.

### Gaps
- No primary, independent benchmark found comparing PDF/table extractors (Grobid, Docling, Marker, etc.) for research-agent use in 2026.
- No published per-report costs found for OpenAI, Gemini or Perplexity deep research in 2026 (only subscription quotas).
- No sources found on rate-limit behaviour of the major search APIs or on dataset-access tools (e.g. pulling tables from statistical agencies) within deep-research agents.
- Specific legal rulings on AI crawling in 2026 were not researched.

---

## 5. Prompt injection and data poisoning from crawled content

### Takeaway
Every browsing agent tested can be redirected by content on the pages it reads; measured success rates run from ~10–30% for hardened frontier agents on static attacks to >90% for adaptive attacks, and vendors say the problem will not be fully solved. A handful of planted documents can steer RAG answers ~90% of the time. The only defence with a strong guarantee is architectural (separating what reads untrusted text from what can act, with provenance tracking), at some cost in utility and tokens.

### Cited Findings
- TRAP (cloned websites, six frontier models): average attack success ~25%, from 13% (GPT-5) to 43% (DeepSeek-R1) — [arXiv 2512.23128](https://arxiv.org/pdf/2512.23128)
- WASP: agents are diverted in 17–86% of cases but complete the attacker's full goal in at most 16% — [cited in AgentDrift, arXiv 2609.06972](https://arxiv.org/pdf/2609.06972)
- BrowseSafe++ (Oct 2026): attacks that rarely succeed when replayed reach 95.41% once adapted using the browser agent's feedback — [arXiv 2610.17457](https://arxiv.org/abs/2610.17457v1)
- WAInjectBench benchmarks 12 injection detectors for web agents and notes prior attacks reaching ~70–100% in some settings — [arXiv 2510.01354](https://arxiv.org/pdf/2510.01354)
- [vendor] Anthropic Claude for Chrome pilot (Aug 2025): 23.6% attack success in autonomous mode without mitigations, 11.2% with them — [Anthropic](https://www.anthropic.com/news/claude-for-chrome) [figures seen via secondary summaries; page not fetched]
- [vendor] Per the Claude Opus 4.8 system card (2026-05-28) as reported by VentureBeat: 31.5% per-attempt hijack rate without safeguards, down from 50.7% for Sonnet 4.6 — [VentureBeat](https://venturebeat.com/security/anthropic-browser-agent-hijacked-31-percent-before-safeguards-engaged)
- OpenAI (2025-12-22) built an RL-trained automated attacker that uses the victim agent's full trace to refine injections, feeding adversarial training and safeguards for ChatGPT Atlas; it says prompt injection, like scams, is unlikely ever to be fully "solved" — [OpenAI](https://openai.com/index/hardening-atlas-against-prompt-injection); [eWeek](https://www.eweek.com/news/openai-chatgpt-atlas-security/)
- The UK NCSC has warned prompt injection may never be fully mitigated — [eWeek](https://www.eweek.com/news/openai-chatgpt-atlas-security/)
- CaMeL (Google DeepMind, 2025): extracts control and data flow from the trusted user query, runs it in a custom interpreter that tracks data provenance, and enforces capability policies on tool calls; on AgentDojo solves 77% of tasks with provable security vs 84% undefended (v1 reported 67%); reported ~2.8x input and ~2.7x output tokens — [arXiv 2503.18813](https://arxiv.org/abs/2503.18813); [summary](https://signals.aktagon.com/articles/2026/07/camel-defeating-prompt-injection-attacks-in-llm-agents-through-capability-based-security/)
- [unverified] NIST CAISI reportedly measured 81% success for novel attacks vs 11% for baseline attacks — [Genαi summary](https://genalphai.com/prompt-injection-in-2026-looks-nothing-like-2023-heres-proof/) (secondary only)
- PoisonedRAG (USENIX Security 2025) [older]: injecting 5 malicious texts per target question into a database of millions gives ~90% attack success (97% on NQ, black-box, 2.68M clean texts); paraphrasing and perplexity-based defences were insufficient — [arXiv 2402.07867](https://arxiv.org/pdf/2402.07867)
- Defences against poisoning (authors' own evaluations, non-adaptive attackers): RAGDefender reduced attack success on Gemini from 0.89 to as low as 0.02 — [arXiv 2511.01268](https://www.arxiv.org/pdf/2511.01268); TriShieldRAG from ~91% to ~13% — [alphaXiv 2607.23838](https://www.alphaxiv.org/abs/2607.23838)
- Anthropic's human testers found early research agents preferred SEO content farms over authoritative sources (a soft form of poisoning) — [Anthropic Engineering](https://www.anthropic.com/engineering/built-multi-agent-research-system)

### Inferences
- A research swarm is unusually exposed: it reads hundreds of attacker-reachable pages by design. The relevant threats are (a) **instruction injection** (page text that redirects the agent, exfiltrates data via URLs/tool calls, or tells it what to conclude) and (b) **content poisoning** (planted pages that are factually wrong but look authoritative).
- Harness note (separation, CaMeL / dual-LLM style): reader sub-agents that see raw web text get only read tools (search, fetch, store-evidence) — no write, send, shell or MCP tools with side effects, and no access to the person's private data. They return structured evidence (quotes + ids), not free instructions. The orchestrator never sees raw page text, only stored quotes marked as untrusted data. This is cheaper than full CaMeL and keeps most of its benefit for research tasks.
- Harness note (taint tracking): mark every evidence-store item as untrusted; the harness refuses any tool call whose arguments (e.g. a URL to fetch, an email address) were derived from untrusted content unless a policy allows it — e.g. fetching a URL that appeared in a page is allowed, posting data to it is not.
- Harness note (exfiltration): block fetches whose query strings contain data from the person's private context; log and surface any page text that addresses the agent ("ignore previous instructions", "AI assistant: …") as a finding rather than obeying it.
- Harness note (poisoning): require ≥2 independent origins (after dedup) for key claims, weight primary sources and known-reputable domains, flag single-source claims in the report, and have the clean-context verifier check for sources that contradict the majority.
- Because adaptive attacks reach >90%, a detector alone is not a defence; treat detection as telemetry and rely on capability restriction.

### Gaps
- No measured attack-success rates found specifically for **deep-research report agents** (as opposed to browser/action agents) — e.g. how often planted pages change a report's conclusion.
- StakeBench and the NIST CAISI figures were seen only on aggregator sites.
- No 2026 primary data found on SEO/"generative engine optimisation" manipulation rates of AI research tools.

---

## 6. Where deep research fails, according to independent evaluations

### Takeaway
Independent audits converge on the same weaknesses: sourcing/attribution errors are the most common serious problem, answers to contested questions are one-sided and over-confident, more searching does not mean better-grounded claims, early fabrications cascade, and errors concentrate in deciding/committing/aggregating rather than in retrieval. Numeric distortion and stale sources are recognised error classes but lack strong independent rate measurements.

### Cited Findings
- EBU/BBC (2025-10-22; 22 public broadcasters, 18 countries, 14 languages; free versions of ChatGPT, Copilot, Gemini, Perplexity): 45% of news answers had at least one significant issue, 81% some issue; 31% serious sourcing problems; ~20% accuracy problems including hallucinated details and outdated information; Gemini 76% significant issues (72% sourcing), Copilot 37%, ChatGPT 36%, Perplexity 30% — [EBU](https://www.ebu.ch/news/2025/10/ai-s-systemic-distortion-of-news-is-consistent-across-languages-and-territories-international-study-by-public-service-broadcaste); [VRT](https://communication.vrt.be/largest-study-of-its-kind-shows-ai-assistants-misrepresent-news-content-45-of-the-time-regardless-of-language-or-territory) [older]
- Tow Center (CJR, March 2025): 8 AI search tools, 1,600 queries; collectively wrong ~60% of the time; ChatGPT Search "completely correct" 28%, "completely incorrect" 57% (per secondary coverage); Perplexity noticeably better; fabricated links — [CJR](https://www.cjr.org/tow_center/we-compared-eight-ai-search-engines-theyre-all-bad-at-citing-news.php); [TechSpot](https://www.techspot.com/news/107101-new-study-finds-ai-search-tools-60-percent.html) [older; search tools rather than deep research]
- DeepTRACE: one-sided, highly confident answers on debate questions; deep-research modes reduced overconfidence somewhat but remained one-sided (GPT-5 DR 54.7%, Copilot DR 94.8%); citation accuracy 40–80% — [arXiv 2509.04499](https://arxiv.org/pdf/2509.04499)
- More search depth lowers claim support (GPT-5.4 78.6% → 16.7% from 2 to 150 tool calls) — [arXiv 2605.06635](https://arxiv.org/html/2605.06635v1)
- Span-level error localisation: retrieval steps rarely cause errors (2.9%) while decision (60.5%) and finalisation (51.8%) steps carry most risk — "the bottleneck … is not getting information, but how they commit to, verify, and aggregate" — [arXiv 2606.02060](https://arxiv.org/html/2606.02060v2) [unverified: numbers from a search summary, not in the abstract]
- Hallucination cascades: for proprietary agents more than 57% of source errors occur in the early stage of the trajectory — [arXiv 2601.22984](https://arxiv.org/html/2601.22984v1) [from search summary]
- A deep-research factuality taxonomy names numeric distortion (counts, percentages, confidence intervals), reliance on out-of-date or retracted sources without caveats, and recency extrapolation as distinct error classes — [DeepFact, arXiv 2603.05912](https://arxiv.org/pdf/2603.05912) [attribution from search summary; not fetched]
- Orchestrator/writer is the main source of final-report errors (84.7% in AI-Q) — [arXiv 2608.24306](https://arxiv.org/abs/2608.24306)
- Deep-research agents hallucinate URLs more than plain search-augmented models (10.7% vs 4.8%) — [arXiv 2604.03173](https://arxiv.org/html/2604.03173v1)
- AI-scientist systems: hallucinated numerical results and false novelty claims (Sakana) — [arXiv 2502.14297](https://arxiv.org/abs/2502.14297); Kosmos 79.4% of statements supported, so ~1 in 5 conclusions not supported — [Edison Scientific](https://edisonscientific.com/articles/announcing-kosmos)
- Human factors: users may adopt output without checking, and verifying it "can take many hours" (Andrew Rogoyski, University of Surrey, in The Guardian) — [Wikipedia: ChatGPT Deep Research](https://en.wikipedia.org/wiki/ChatGPT_Deep_Research)
- LLM judges are weak proxies on literature tasks (65.1% agreement with researcher preferences) — [SciArena, arXiv 2507.01001](https://arxiv.org/pdf/2507.01001v2)

### Inferences
- The failure profile argues for spending verification budget at the **commit points** (when a sub-agent decides an answer, and when the writer aggregates) rather than on more retrieval.
- Harness note (numeric check): a deterministic harness check that every number, date, percentage and unit in the final report appears in the cited evidence span (allowing formatting differences), and that derived numbers carry a shown calculation; flag mismatches to the verifier.
- Harness note (recency): store `published_at`/`fetched_at` per source; the verifier flags claims about "current" state that rely on sources older than a configurable window, and flags retracted papers (Retraction Watch/Crossref metadata via an MCP tool).
- Harness note (early-error cascades): verify sub-agent findings when they are returned (cheap, single-document-scale checks) so a fabricated early fact does not become the plan's premise; keep the plan's assumptions as explicit, checkable items.
- Harness note (calibration): require the writer to attach a confidence and an evidence count to each key claim, and to state when sources disagree; the verifier checks that high-confidence claims have ≥2 independent supporting origins.
- Harness note (evaluation of the swarm itself): start with ~20 real queries and an end-state rubric (as Anthropic did), but calibrate the judge against a human-labelled subset because judges agree with researchers only ~65% of the time on literature tasks; track per-claim support rate, URL validity, one-sidedness and abstention rate as separate metrics rather than one score.

### Gaps
- No independent, replicated measurement of **numeric error rates** in deep-research reports was found.
- No independent evaluation found that tests recency handling directly (e.g. questions whose answer changed after a cutoff) across current commercial deep-research products.
- The EBU/BBC and Tow Center studies tested consumer assistants/search, not dedicated deep-research modes; equivalent journalism-style audits of 2026 deep-research products were not found.
