# LLM agents and agent ensembles for forecasting and for business intelligence / data analysis

Notes compiled 2026-11-02. The newest forecasting data found dates from late May to June 2026, and the newest text-to-SQL leaderboard readings from September to October 2026. Material from 2024 and early 2025 is marked **[older]**. Claims made by vendors or by the teams that built a system are marked **[vendor/self-reported]**.

---

## 1. How accurate are LLM forecasters, compared with superforecasters, pros, the public and markets?

### Takeaway
As of mid-2026, the best LLM systems are close to elite human forecasters but have not beaten them in live, forward-looking evaluation. On ForecastBench, superforecasters lead the best LLMs by about 2.7 points on FRI's Brier Index (Brier 0.086 vs roughly 0.10). In Metaculus's live bot tournaments, Pro forecasters have won every season. By Spring 2026 their margin was no longer statistically significant (1.25 head-to-head points per question). Claims of parity rest on backtests.

### Cited Findings
**ForecastBench (Forecasting Research Institute, FRI)**
- October 2025: superforecasters had a difficulty-adjusted Brier score of 0.081. The best LLM on the leaderboard scored 0.101 (GPT-4.5, released Feb 2025). GPT-4 (Mar 2023) scored 0.131. FRI's linear extrapolation then put LLM–superforecaster parity around November 2026. — [FRI on X, Oct 2025](https://x.com/Research_FRI/status/1975909516777537614?lang=en); [EA Forum synthesis](https://forum.effectivealtruism.org/posts/Spyz3wESZu2eeqhDj/ai-forecasting-in-2026-what-11-analyses-say)
- January 29, 2026: superforecasters were #1 and led the best LLMs by 0.017 Brier. Tied for #2 were xAI Grok 4.20 Preview (0.102, run Oct 2025) and Cassi's `ensemble_2_crowdadj`. FRI's own baseline runs of GPT-5, o3 and Claude Sonnet 4.5 ranked below these two external submissions. Claude 3.5 Sonnet (Oct 2024) scored 0.117, about 0.015 worse than Grok 4.20 a year later. Parity extrapolation: November 2026 (95% CI Jan 2026 – Nov 2027), with dataset questions expected around June 2026 and market questions around August 2026. — [FRI, "LLMs Are Closing the Gap on Human Superforecasters"](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human)
- Difficulty-adjusted Brier scores make question sets that do not overlap comparable. FRI notes that the initial superforecaster sample and the latest models had zero questions in common. Models appear on the leaderboard 50 days after their first forecast. — [FRI Jan 2026](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human)
- Around May 2026, after FRI moved to a "Brier Index" (higher is better): superforecasters had Brier 0.086 (Brier Index 70.6%). The best LLMs (Cassi `ensemble_2_crowdadj` and xAI Grok 4.20 Preview) had 67.9%, a gap of 2.7 percentage points. The updated parity estimate is May 2027 (95% CI Apr 2026 – May 2028). — [FRI via search summary](https://forecastingresearch.substack.com/p/introducing-the-brier-index); [EA Forum synthesis](https://forum.effectivealtruism.org/posts/Spyz3wESZu2eeqhDj/ai-forecasting-in-2026-what-11-analyses-say)
- An aggregator (Parallect, May 2026) says an LLM has matched superforecasters, citing a Google DeepMind submission at about 67.8–67.9. This contradicts FRI's own reporting that superforecasters still lead significantly, so treat the claim as unverified. — [Parallect](https://parallect.ai/reports/ai-superforecasters-forecastbench-may-2026-895525); contradicted by [FRI](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human)
- Good Judgment's critique: the superforecaster baseline on ForecastBench comes from a single engagement in 2024, and the questions resolved so far lean toward short-horizon, data-rich topics where AI has structural advantages. — [Good Judgment](https://goodjudgment.com/what-superforecasters-actually-said-about-forecastbench/)

**Metaculus AI Benchmark / FutureEval (live, forward-looking tournaments)**
- Bot team (top 10 bots) vs Pro team, head-to-head (negative means bots worse), with 95% CI: Q3 2024 −11.3 [−21.8, −0.7]; Q4 2024 −8.9 [−18.8, 1]; Q1 2025 −17.7 [−28.3, −7.0]; Q2 2025 −20.03 [−28.63, −11.41] (p = 0.00001). Metaculus found no clear trend across those quarters. **[older]** — [Metaculus Q2 2025 results, LessWrong](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- Q2 2025: 54 bot makers, 42 in-house Metaculus bots, 348 questions. On a combined leaderboard all 10 Pros took places 1–10 and the best bot (metac-o3) was 11th. o3 was the best model, significantly ahead of the next best. By question type the bots trailed most on multiple-choice (−32.9, 17 questions), then numeric (−23.2, 21 questions), then binary (−14.8, 55 questions). — [LessWrong Q2](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- Model age matters a lot. The in-house metac-gpt-4o bot fell from 4th of 55 (Q3 2024) to 82nd of 96 (Q2 2025) as newer models arrived. — [LessWrong Q2](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- Q3 2025: 55 bots, 255 weighted questions. Pros were significantly better than the top bots (p = 0.036, log scoring, weighted t-test). — [Metaculus Q3 notebook](https://www.metaculus.com/notebooks/28784/aibq3results/) (via search summary)
- Spring 2026 (events Jan–May 2026): 173 bots (111 not run by Metaculus) on 297 scored questions. The 10-person Pro team beat the top-10 bot team by an average of 1.25 head-to-head points per question, and the margin was **not statistically significant**. Nine of the 10 Pros beat every individual bot. The top bot was a GPT-5.1-high setup. A commentator questioned whether the narrower gap reflects better bots or a different question set. — [Metaculus on X, "Pro Forecasters Beat Bots, but the Gap is Nearly Gone"](https://x.com/metaculus/status/2095608079991894293) (via search summary)
- Metaculus (June 22, 2026): Pros have led bots "every season by a large margin" in spot peer scores. Claims that bots match top humans rest on backtesting and "have not been reproduced under live, forward-looking evaluation". — [Metaculus FutureEval post](https://metaculus.substack.com/p/metaculus-futureeval-ai-forecasting-benchmark); [FutureEval page](https://www.metaculus.com/futureeval/)

**Prophet Arena (live prediction-market questions; ICLR 2026)**
- More than 1,300 resolved events. GPT-5 (reasoning) had Brier 0.184 and ECE 0.042, against the market baseline's Brier 0.187 and ECE 0.069. Model Brier scores fall in a narrow band of 0.17–0.24 (random guessing is about 0.25), so calibration separates models more than accuracy does. Claude was reported as best on calibration and GPT-5 as best on Brier and return. — [Prophet Arena paper, arXiv 2510.17638](https://arxiv.org/pdf/2510.17638); [ICLR 2026](https://iclr.cc/virtual/2026/poster/10009102)
- Lightning Rod AI says its Foresight-32B reached Brier 0.199 against GPT-5's 0.207 on 251 live Polymarket questions, and that it is #1 on Prophet Arena. **[vendor/self-reported, unverified]** — [Lightning Rod](https://www.lightningrod.ai/solutions/prediction-markets)

**Halawi et al. 2024, "Approaching Human-Level Forecasting with Language Models" [older]**
- Test set of 914 binary questions opened after June 1, 2023. The retrieval-augmented system scored Brier 0.179 (accuracy 71.5%), against the human crowd's 0.149 (77.0%). A weighted combination of system and crowd (crowd weighted 4×) scored 0.146 (77.8%), better than either alone. GPT-4 zero-shot without retrieval scored about 0.206–0.208. — [arXiv 2402.18563 (HTML)](https://arxiv.org/html/2402.18563)
- Where the system beat the crowd: when the crowd was uncertain (crowd forecast between 0.3 and 0.7), the system scored 0.238 against the crowd's 0.240. With all three favourable conditions together (uncertain crowd, early retrieval date, at least 5 relevant articles), it scored 0.240 against 0.247, covering 22% of forecasts and 43% of questions. — [arXiv 2402.18563](https://arxiv.org/html/2402.18563)

**Schoenegger, Tuminauskaite, Park, Tetlock 2024, "Wisdom of the Silicon Crowd" [older]**
- An ensemble of 12 LLMs on 31 binary questions was not statistically different from a crowd of 925 human tournament forecasters, and was equivalent within medium-effect bounds. Individual models showed an *acquiescence bias*: mean predictions were above 50% although outcomes split roughly evenly. — [arXiv 2402.19379](https://arxiv.org/abs/2402.19379)

**AIA Forecaster (Bridgewater AIA Labs, Nov 2025)**
- Reports that it matches superforecasters on ForecastBench. A secondary source gives an FB-Market Brier of 0.0753 against 0.0740 for superforecasters, with a public median of 0.1035; these were not checked against the paper's tables. On a harder benchmark of liquid prediction markets it lags slightly behind market consensus, but an ensemble of the forecaster and the market beats the market alone. **[self-reported; backtest]** — [arXiv 2511.07678](https://arxiv.org/html/2511.07678v1); secondary numbers via [Emergent Mind](https://emergentmind.com/topics/forecastbench)
- Skeptics (an LW/EA synthesis of 11 analyses) say parity claims have not been tested rigorously enough to rule out leakage or noise, and that the Platt-scaling gain was not applied to the human crowd. They also call this report the best-done version of such claims. — [EA Forum](https://forum.effectivealtruism.org/posts/Spyz3wESZu2eeqhDj/ai-forecasting-in-2026-what-11-analyses-say)

### Inferences
- A realistic target for a harness forecasting swarm built on frontier models is "close to a strong human crowd, not better than superforecasters". Expect a Brier score roughly 0.01–0.02 worse than elite humans on mixed questions. Claims of being better than humans should not appear in UI copy or reports unless the harness has shown them on live questions.
- The most reliable win is **hybrid**: combining the system with a crowd or market. This held in Halawi (0.146 combined, better than either), in Cassi's crowd adjustment (about 0.01 Brier gained) and in AIA (forecaster plus market better than market). Where a market or crowd price exists, the harness should fetch it and treat it as an input or prior, not ignore it.
- Model choice dominates. A forecasting team should be easy to move to the newest frontier model, and should hold a per-model track record so that stale models can be dropped (metac-gpt-4o went from 4th to 82nd within a year).

### Gaps
- I found no results summary for the Metaculus Summer/Fall 2026 seasons and no ForecastBench leaderboard data after May 2026. Standings may have changed by November 2026.
- I did not obtain the exact Spring 2026 head-to-head confidence interval or the Q4 2025 / Fall 2025 numbers.
- The figure of 0.081 for superforecasters (Oct 2025) and 0.086 (May 2026) come from different scoring snapshots (difficulty-adjusted Brier vs the Brier Index era), so they are not directly comparable.

---

## 2. Which methods moved forecasting accuracy and calibration, and by how much? (aggregation, retrieval, calibration, superforecasting practices)

### Takeaway
Measured gains come from, roughly in order: (1) a better base model; (2) aggregating several independent forecasts (trimmed mean, median or mean); (3) agentic, multi-source retrieval; (4) anchoring to or blending with crowd and market prices; (5) post-hoc calibration that extremizes, because LLMs hedge toward 50% (Platt scaling, with caps on the extremes). Elaborate scaffolding gives a marginal gain on top of a frontier model; Metaculus estimates it is worth about 9 months of model progress. Self-consistency sampling alone did not help on Prophet Arena.

### Cited Findings
**Aggregation and ensembles**
- Halawi: the final forecast is the trimmed mean of 6 forecasts (3 from base GPT-4-1106, 3 from fine-tuned GPT-4-0613). The trimmed mean was best of the five ensembling methods tested. Fine-tuning on the model's own good reasoning improved Brier from 0.186 to 0.179. **[older]** — [arXiv 2402.18563](https://arxiv.org/html/2402.18563)
- Metaculus Q2 2025 survey of bot makers (19 responses), coverage-adjusted score differences: aggregating multiple forecasts (median or mean) +1,799 (95% CI +1,017 to +2,582); custom question creation and testing +2,216 (+912 to +3,519; the survey wording was ambiguous); manual review of bot outputs +1,041 (CI crosses 0); AskNews made no demonstrable difference. Correlation with score: LLM calls per question 0.40, development hours 0.20. — [LessWrong Q2](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- The Q2 2025 winner (Panshul42) used a 6–7 step agentic research process and five final predictions from Sonnet 3.7/4, o4-mini and o3. It beat metac-o3+asknews, but the confidence intervals overlapped. Metaculus concluded that model quality matters more than scaffolding. — [LessWrong Q2](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- xAI's ForecastBench entry: a minimal setup in which the model has X search, web search and a Python REPL, makes 8 forecasts, and the forecasts are averaged. — [FRI Jan 2026](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human)
- Cassi's entry: generate sub-questions and search queries, retrieve with Tavily, filter for relevance and recency, forecast with an ensemble of o3 and GPT-5, then have another LLM analyse the reasoning and set the final forecast. The crowd-adjusted variant compares the forecast with the market price and lets an LLM revise it when they disagree significantly, a gain of nearly 0.01 Brier. No post-hoc calibration. — [FRI Jan 2026](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human)
- Silicon crowd: a median ensemble of 12 diverse LLMs matched a crowd of 925 humans. In Study 2, showing GPT-4 and Claude 2 the human median improved their accuracy by 17–28%, but simply averaging the human and machine forecasts was more accurate still. **[older]** — [arXiv 2402.19379](https://arxiv.org/abs/2402.19379)
- AIA Forecaster recipe: agentic search, ensembles of independent runs, a **supervisor agent that reconciles disparate forecasts**, and statistical calibration. — [arXiv 2511.07678](https://arxiv.org/html/2511.07678v1)

**Calibration and extremizing**
- AIA links Platt scaling to extremizing and uses a fixed coefficient of √3 ≈ 1.73. It deliberately avoided 2.27, the value optimized on the benchmark, to limit overfitting. — [arXiv 2511.07678](https://arxiv.org/pdf/2511.07678); [search summary](https://emergentmind.com/topics/superforecasters)
- Metaculus (June 2026): most winning bots aggregate several forecasts, apply post-hoc calibration, and cap predictions at a minimum and maximum. Agentic, iterative search beats one-shot retrieval. Winners used about 1.7 distinct research sources against 1.00 for non-winners, and no search provider was consistently better. Good scaffolding is "worth about nine months of base model progress", but only on a frontier model. Simple one-shot bots on frontier models reached the top 5. — [Metaculus FutureEval](https://metaculus.substack.com/p/metaculus-futureeval-ai-forecasting-benchmark)
- Practical failure modes: LLMs forecast in steps of 5% or 10% even when asked for 1% precision. One bot maker saw about a 30% failure rate on numeric and multiple-choice runs, mostly formatting errors. Some makers capped predictions to limit losses from overconfidence. One bot maker found that median aggregation reduced precision. — [LessWrong Q2](https://www.lesswrong.com/posts/Surnjh8A4WjgtQTkZ/q2-ai-benchmark-results-pros-maintain-clear-lead)
- Prophet Arena: directly verbalized probabilities were stable across prompt rewrites. Self-consistency sampling (even with 10 rollouts) gave *significantly lower* accuracy and mixed calibration benefits. Remaining weaknesses: inaccurate recall of events, misreading of data sources, and slower aggregation of information than markets as resolution nears. — [Prophet Arena, arXiv 2510.17638](https://arxiv.org/pdf/2510.17638)
- With label noise η, clamping forecasts to [t*, 1−t*] with t* = 2η/(1+2η) improves the expected log score. This is a principled reason to cap extremes. — [Paleka et al., arXiv 2506.00723](https://arxiv.org/html/2506.00723v1)

**Retrieval**
- Halawi: retrieval moved GPT-4 from about 0.206 (no retrieval) to 0.179 with the full system. The system did better when at least 5 relevant articles were found and when retrieval dates were earlier, where the crowd also had less information. **[older]** — [arXiv 2402.18563](https://arxiv.org/html/2402.18563)
- Prophet Arena and Metaculus both point to the *breadth* of agentic research, not a particular provider, as what matters. — [Metaculus FutureEval](https://metaculus.substack.com/p/metaculus-futureeval-ai-forecasting-benchmark)

### Inferences
Translating these findings, and superforecasting practice, into a forecasting team in the harness:
- **Question framer / resolution checker** (one sub-agent): restates the question, the exact resolution criteria, the horizon and the resolution source. Harness check: the criteria are present and unambiguous, and the deadline is parsed.
- **Base-rate / reference-class agent**: produces an outside-view prior (a reference class, its frequency, and a citation for the class). A Fermi-decomposition agent breaks numeric questions into factors, each with a range. Harness check: the prior and its source are recorded before any inside-view research is shown, which keeps the outside view uncontaminated.
- **Researchers** (2–3, different search providers or MCP tools): agentic, iterative search with at least 2 distinct sources (winners used about 1.7 against 1.0). Each returns dated evidence with publish dates. Harness check: drop any document dated after the forecast date; record source URLs.
- **Independent forecasters** (5–8 runs spread over at least 2–3 providers and models): no shared drafts, each produces a verbalized probability plus a rationale. Diversity of models matters more than repeated samples from one model (self-consistency underperformed on Prophet Arena).
- **Aggregator (deterministic code, not an LLM)**: trimmed mean or median of the forecasters' probabilities, optionally in log-odds. Then **Platt/extremizing calibration** with a coefficient fitted on the harness's *own* resolved history; default about √3 per AIA, refit once there is enough data. Then **caps** (for example [0.02, 0.98]). This should be a tested function, not a prompt.
- **Supervisor / reconciler agent**: triggered when the spread across forecasters is large (for example an interquartile range above 0.2). It reads the disagreeing rationales and either asks for targeted research or sets a reconciled forecast (the AIA and Cassi pattern).
- **Crowd/market comparator**: fetches a Metaculus, Polymarket or Kalshi price if one exists. If the system differs from the market by more than a threshold, it must give an explicit reason or be pulled toward the market. The final answer is a weighted blend (Halawi's best weighted the crowd 4×). Log the raw and blended forecasts separately.
- **Format validator (a harness check)**: probabilities in [0, 1], numeric CDFs monotonic and inside bounds, multiple-choice options summing to 1. Retry on failure, since about 30% of numeric and multiple-choice runs failed on formatting in Q2 2025.
- **Updater / scheduler**: re-forecasts when news arrives or on a schedule (the superforecasting practice of frequent small updates), and stores a forecast history.
- **Scorer/ledger** (deterministic): when questions resolve, compute Brier, log score and calibration (reliability bins, ECE) per model, per agent configuration and per topic. Use these numbers to choose models and to refit calibration.

### Gaps
- I found no controlled study isolating the effect of explicit base-rate or Fermi prompting on LLM Brier scores in 2025–2026. The suggestion above is the human superforecasting practice carried across, not a measured LLM effect.
- The extremizing literature on human crowds (Baron et al. 2014; Satopää et al. 2014) and GJP's training and teaming effect sizes were not re-verified in this pass.
- I did not read the full AIA Forecaster report for the supervisor agent's design or ablation numbers.

---

## 3. Leakage and evaluation pitfalls: how to evaluate a forecasting agent honestly

### Takeaway
Backtests overstate LLM forecasting skill through several kinds of leakage. Logical leakage: questions picked with hindsight, or that resolved early. Retrieval leakage: date filters that let later content through, and retrievers trained on later data. Model leakage: knowledge past the stated cutoff. Gains are also often within statistical noise. The only fully honest test is live, forward-looking forecasting, scored on resolution with proper scoring rules and compared against a crowd or market.

### Cited Findings
- Paleka, Goel, Geiping, Tramèr, "Pitfalls in Evaluating Language Model Forecasters" (arXiv May 2025; ICLR 2026). — [arXiv 2506.00723](https://arxiv.org/html/2506.00723v1); [ICLR 2026](https://mlanthology.org/iclr/2026/paleka2026iclr-pitfalls/)
  - Questions that resolved before the forecasting window ended: at least 3.8% of Halawi et al.'s questions and at least 10% of Tao et al. (2025).
  - A news-generated multiple-choice benchmark (Dai et al.) could be solved at up to 80% by a DeBERTa classifier with **no retrieval** (chance is 25%). DeepSeek v3 reached 55%, the same as on real Metaculus questions (55%).
  - Survivorship bias: a question about a company's Q3 2025 revenue (correct answer $0) would not appear in datasets built from 2025 news.
  - Date-restricted search leaks: "wuhan" before December 2018 returns the Wuhan Institute of Virology; a Nihon Hidankyo search restricted to Jan–Sep 2024 returns a page "dated" January 2024 that discusses the October 2024 Nobel; "October 7" before 2022 is dominated by later conflict content. Restated financials (Enron) make the original numbers hard to retrieve.
  - Retrieval models trained on later data leak through what they rank highly. Suggested mitigation: TF-IDF or older embedding models.
  - Training cutoffs are unreliable. Treat the model's release date as the upper bound of its knowledge and add a buffer of a few months.
  - ForecastBench is skewed toward Security & Defense, and many non-market questions follow a few templates (ACLED counts).
  - Metrics: the average Brier score favours improving coin-flip questions over getting rare events right. Calibration alone can be gamed (always saying 1% for each of 100 papal candidates). Accuracy is not a proper scoring rule. Correlated questions mean a calibrated forecaster need not maximize the expected score.
  - Recommendations: only use questions whose every resolution can be verified at evaluation time; filter out questions that resolved early; test whether a shortcut classifier can solve the set; use versioned or reliably dated corpora; check whether crowd forecasts were available to the model and measure edge over the crowd; evaluate across several disjoint time periods and report risk-adjusted performance; report Brier, log score and calibration; make final claims through live testing broken down by topic and horizon.
- Metaculus: claims of bot–human parity come from backtests and have not reproduced in live evaluation. — [Metaculus FutureEval](https://metaculus.substack.com/p/metaculus-futureeval-ai-forecasting-benchmark)
- KramaBench (a data-analysis benchmark, but the same issue): OpenAI Deep Research scored about 52% on a pre-filtered subset, possibly because it fetched answers from the source publications. Wildfire tasks scored highest even with no input data, which suggests models had memorized recent events. — [KramaBench, arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)
- ForecastBench mitigates leakage by asking only about future events (questions resolve after the forecast) and uses difficulty adjustment to compare question sets that do not overlap. Good Judgment's caveat about the single 2024 superforecaster baseline still applies. — [FRI](https://forecastingresearch.substack.com/p/llms-are-closing-the-gap-on-human); [Good Judgment](https://goodjudgment.com/what-superforecasters-actually-said-about-forecastbench/)

### Inferences
- In the harness, **live evaluation is the default**. Every forecast is stored with a timestamp, the model and version, and the evidence it used, then scored automatically on resolution. Backtests are labelled "backtest (upper bound)" in the UI.
- For any backtest mode, the retrieval MCP tool must enforce a hard `as_of` date at the source (a versioned snapshot or a corpus with trusted dates). A **leakage auditor** sub-agent scans retrieved snippets for entities or events that postdate `as_of`. Question sets are filtered for resolutions that happened before the window closed.
- Use only models released before the backtest window opens (plus a buffer of a few months). A model released after the window has already seen the outcomes.
- Report Brier, log score, calibration curves and edge over the crowd or market, with confidence intervals, and break results down by horizon and topic. Do not claim an improvement without a significance test (the Metaculus head-to-head with t-tests is a model to copy).

### Gaps
- I did not find numbers for how much leakage inflates Brier scores on average across common backtests. The paper gives examples and shortcut-classifier results, not an overall inflation figure.

---

## 4. BI and data-analysis agents: benchmark accuracy of current best systems

### Takeaway
On academic text-to-SQL, top agents report 76% (Spider 2.0-Lite) to 97% (Spider 2.0-Snow) execution accuracy and about 83% on BIRD (humans about 93%). On realistic multi-step data work the numbers fall sharply: dbt projects about 66%, DABStep hard tasks about 15% at launch, KramaBench data-lake pipelines about 22% at launch, and BIRD-Interact with ambiguity 9–29%. Benchmark labels themselves are wrong 50–66% of the time on BIRD Mini-Dev and Spider 2.0-Snow, so leaderboard ranks are unreliable.

### Cited Findings
**Spider 2.0 (enterprise text-to-SQL; read from the official leaderboard Nov 2026, entry dates not shown)**
- Snow (547 tasks, Snowflake): #1 Genloop Sentinel Agent v2 Pro 96.70; #2 Native mini 96.53; #3 QUVI-3 (Gemini-3-pro-preview) 94.15; #4 Tencent TCDataAgent-SQL 93.97; #5 Paytm Prism Swarm (Claude Sonnet 4.5) 90.49. — [spider2-sql.github.io](https://spider2-sql.github.io/)
- Lite (547 tasks: 214 BigQuery, 198 Snowflake, 135 SQLite): #1 Tencent Tianqiong Data Agent (GLM 5.2) 76.23; DecisionX 74.95; Kaelio ktx 73.67; Snowflake AI Research × UCSD DivSkill-SQL 73.13; Oracle OCI SOMA-SQL 72.02. — [spider2-sql.github.io](https://spider2-sql.github.io/)
- DBT (68 tasks, DuckDB via dbt): #1 SignalPilot 65.6; JetBrains Databao 60.29; then a drop to 41.18 (Shadowfax, GPT-5) and 39.71 (GPT-5 / GPT-5.4 agents). — [spider2-sql.github.io](https://spider2-sql.github.io/)
- Baselines at launch (Nov 2024): o1-preview 17.1% and GPT-4o 10.1% on Spider 2.0, against GPT-4o's 86.6% on Spider 1.0. Spider-Agent + GPT-4o scored 12.98 (Snow), 13.16 (Lite), 7.35 (DBT). Gold SQL was released in Dec 2024 and ground-truth tables in Apr 2025, and the maintainers warn against training on them. **[older baseline]** — [spider2-sql.github.io](https://spider2-sql.github.io/)
- BIRD: top system GrainSQL at 82.95 execution accuracy (Sept 2026), human baseline 92.96. **[secondary source; a vendor page citing the leaderboard]** — [Count.co](https://count.co/ai/text-to-sql)

**Benchmark reliability**
- Jin et al. (CIDR/VLDB 2026): annotation errors in 52.8% of BIRD Mini-Dev and 62.8% (another version says 66.1%) of Spider 2.0-Snow items. Re-scoring 16 agents on a corrected BIRD subset changed performance by −7% to +31% and moved ranks by up to 9 places. Rank correlation fell from 0.85 to 0.32. — [arXiv 2601.08778](https://arxiv.org/html/2601.08778v3); [CIDR paper](https://www.vldb.org/cidrdb/papers/2026/p5-jin.pdf); [GitHub](https://github.com/uiuc-kang-lab/text_to_sql_benchmarks)
- Tension: Spider 2.0-Snow tops around 97% while this audit finds most Snow items mislabelled. Either the maintainers fixed labels after the audit, or top entries fit the published gold. I could not resolve which.

**Interactive and ambiguous queries**
- BIRD-Interact (ICLR 2026), 600 tasks: GPT-5 completes only 8.67% in c-Interact (conversational) and 17.00% in a-Interact (agentic). Other table versions give 14.50% and 29.17%, probably the priority sub-task metric. The bottleneck is communication (asking the right clarifying questions), not SQL: giving GPT-5 ambiguity-resolution histories from stronger models raised its score significantly. — [arXiv 2510.05318](https://arxiv.org/pdf/2510.05318); [ICLR poster](https://www.iclr.cc/virtual/2026/poster/10007486)

**Multi-step data analysis**
- DABStep (Adyen + Hugging Face, Jun 2025): 450 tasks from real payments analytics (72 Easy, 378 Hard) with a hidden test set. At launch o4-mini scored 76.39% on Easy and 14.55% on Hard; Claude 3.7 Sonnet and o3-mini were below 14% on Hard. **[older]** — [arXiv 2506.23719](https://arxiv.org/pdf/2506.23719)
- KramaBench (MIT, Jun 2025): 104 real pipelines over 1,700 files from 24 sources in 6 domains. Best: DS-Guru (self-correcting) with o3 at 22.08% overall (Astronomy 3.53%, Wildfire 50.73%). The same scaffold with Claude 3.5 scored 14.35% and with GPT-4o 8.28%. Planning lifted o3 from 9.64% (naive) to 20.80%. "No configuration had an overall score higher than 50%." **[older]** — [arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)
- DSBench (2024): the best agent solved 34.12% of data-analysis tasks. DA-Code (EMNLP 2024): the best LLM reached 30.5%. **[older; recalled from the paper abstracts, not re-fetched in this pass]** — [DSBench arXiv 2409.07703](https://arxiv.org/abs/2409.07703); [DA-Code arXiv 2410.07331](https://arxiv.org/abs/2410.07331)

### Inferences
- A BI swarm should be designed for the "realistic" numbers (roughly 15–65% unaided on multi-step work), not the Spider-Snow 97%. Verification and human-reviewed definitions are what make the difference.
- BIRD-Interact implies the harness needs an **ambiguity / clarification step** before any SQL is written: a sub-agent that lists the interpretations and either asks the person or picks one and states it.
- For the harness's DuckDB/SQLite MCP servers, the closest public analogues are Spider 2.0-DBT (DuckDB) and Spider 2.0-Lite's SQLite slice. Current best agents score 60–66% on dbt-style work.

### Gaps
- I found no current (2026) DABStep or KramaBench leaderboard standings. Only launch figures (mid-2025) were available.
- I could not verify the BIRD 82.95 figure against the official BIRD leaderboard (a different aggregator listed a Dev-set entry at 75.74%, probably a different track).
- I did not fetch InfiAgent-DABench numbers.

---

## 5. Typical BI-agent errors and verification techniques that work

### Takeaway
Most wrong answers are *silent*: the SQL runs and returns a plausible number. The common causes are join fan-out, missing business filters, date-column or timezone mistakes, wrong aggregation (COUNT vs COUNT DISTINCT, an average of ratios) and metric definitions that differ from the business's own. The best measured fix is giving the model explicit business semantics. A 4 KB hand-written semantic document added 17–23 accuracy points for every frontier model tested, and Snowflake reports about 2× accuracy with a semantic model. Other checks: compute the same figure by a second route, reconcile to trusted totals, and keep a benchmark set of questions with gold results for each data source.

### Cited Findings
- Rumiantsau & Fokeev (arXiv, Apr 28 2026): Claude Opus 4.7, Claude Sonnet 4.6 and GPT-5.4 on 100 questions over Contoso Retail in ClickHouse, single-shot and paired. Schema only: 45.5–50.5% accuracy. Schema plus a **4 KB markdown file of measures, conventions and disambiguation rules**: 67.7–68.7%, a gain of 17–23 points, all p < 0.01. The models did not differ from one another within either condition. The semantic document explained essentially all the significant variance; the choice of model did not. — [arXiv 2604.25149](https://arxiv.org/abs/2604.25149) (a benchmark repository is linked from the paper: [cubedevinc/semantic-layer-benchmark](https://github.com/cubedevinc/semantic-layer-benchmark); note that Cube sells a semantic layer)
- Snowflake Cortex Analyst: "over 90% SQL accuracy on real-world use cases" with a semantic model, "close to 2x more accurate than single-shot SQL generation" with GPT-4o. The figure comes from an internal set of about 150 questions and dates from 2024. **[vendor/self-reported, older]** — [Snowflake engineering blog](https://www.snowflake.com/en/blog/engineering/cortex-analyst-text-to-sql-accuracy-bi/); [Behind the scenes](https://www.snowflake.com/en/engineering-blog/snowflake-cortex-analyst-behind-the-scenes/)
- A third-party write-up of Snowflake's BIRD test reports that the same LLM went from 57% without a semantic model to 78% with Cortex Analyst. Another source reports 60–70% in practice on raw schemas without a semantic view (secondary, not a controlled study). — [Atlan](https://atlan.com/know/snowflake/cortex-analyst-vs-text-to-sql/); [AtScale](https://snowflake.atscale.com/blog/semantic-layer-cortex-analyst-accuracy/)
- Error taxonomy (vendor guide): join fan-out inflating counts and sums; wrong filters (test accounts, refunds, soft-deleted rows); date problems (which column, timezone, inclusive end date); COUNT(*) vs COUNT(DISTINCT); averaging ratios instead of dividing totals; metric definitions (logo vs revenue churn, rolling vs calendar MAU); ambiguous questions; wrong gold SQL. Recommended checks: governed metrics in a semantic layer; reading the FROM, JOIN, WHERE and aggregation clauses; **computing the figure by a second route and reconciling**; checking against a trusted total from finance or the source system; making the model state its definitions before writing SQL. **[vendor content]** — [Count.co](https://count.co/ai/text-to-sql)
- Databricks Genie "benchmarks": authors write test questions paired with gold SQL (up to 500 per space). A question counts as Correct when Genie's result set exactly matches the gold result, and otherwise as Needs Review. These are used to track accuracy as instructions change. A claimed 80% readiness threshold before user acceptance testing is unverified. **[vendor]** — [Databricks blog](https://www.databricks.com/blog/building-confidence-your-genie-space-benchmarks-and-ask-review); [Kanerika](https://kanerika.com/blogs/databricks-genie/)
- KramaBench failure modes: not finding all the relevant files (data discovery), misreading custom delimiters and transformation formulas, and print-debugging loops that drift the code away from the task over several iterations. Implementation scores were below design scores. — [arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)
- BIRD-Interact: failures come mainly from not resolving ambiguity, not from SQL syntax. — [arXiv 2510.05318](https://arxiv.org/pdf/2510.05318)

### Inferences
Roles and checks for a BI team in the harness, using MCP servers built from SQLite or DuckDB:
- **Semantic layer as a first-class, human-reviewed artifact.** When an MCP server is built from a database, also generate a draft `semantics.md` (measures, grain, join keys, standard filters, fiscal calendar, timezone, metric definitions). A person must approve it before agents use it. This is the single best-measured lever (+17–23 points). Edits are versioned, and each definition carries an owner.
- **Clarifier agent**: lists interpretations of the question (which date column, which churn definition) and asks or states its assumptions. Its output is shown in the answer.
- **SQL author agent**: writes SQL through the read-only SQL tool, citing the definitions from `semantics.md` it used.
- **Deterministic harness checks after each query** (code, not LLM):
  - the query executes and is read-only;
  - row counts before and after each join (**fan-out detector**: the joined count exceeds the base table's count at the stated grain);
  - a uniqueness check on the declared grain;
  - null and empty-result detection;
  - the date range in the result covers the asked period;
  - sums of parts equal the total;
  - units and currency match the semantics;
  - results are flagged when outside historical min/max.
- **Independent recomputation (verifier on a different provider or model)**: computes the headline number by a second route (different SQL, or pandas over an export) without seeing the first query. The harness compares the two within a tolerance. A mismatch triggers a reconciliation round or escalation to the person.
- **Trusted-total reconciliation**: where a control total exists (a finance figure, a dashboard number), the harness checks the answer against it.
- **Number provenance check**: every number in the final narrative must trace to a stored query result (query ID plus cell). The harness rejects reports with numbers it cannot trace. This targets "silent wrong numbers" and invented figures.
- **Per-source benchmark suite** (the Genie pattern): questions with gold SQL and results, re-run whenever `semantics.md`, the model or the prompts change. Report Correct / Needs Review rates. Gate release to others on a threshold the person sets.

### Gaps
- I found no published hallucination-rate numbers (separate from accuracy) for the Apr 2026 semantic-layer paper; only the abstract was read.
- I found no controlled measurements of how much cross-query consistency or second-route checks reduce error rates for LLM SQL agents. The recommendation rests on practice and vendor guidance.

---

## 6. Data mining at scale with agents: pattern discovery, anomaly detection, keeping numbers correct

### Takeaway
Measured evidence on autonomous data mining is thin and discouraging. End-to-end pipelines over data lakes score about 22% at best (KramaBench), and multi-step hard analytics about 15% (DABStep, mid-2025). Correctness comes from pushing every number through executed code or SQL with deterministic tools, keeping notebooks reproducible, and checking memorization and leakage, not from the model's own arithmetic or recall.

### Cited Findings
- On KramaBench, systems did adequately on well-specified code generation but struggled where extensive data processing and domain knowledge were needed. Data discovery across many files (astronomy) was a main failure. Self-correction through print debugging drifted from the task. — [arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)
- Wildfire tasks on KramaBench scored highest even *without input data*, so models may answer from memorized outcomes rather than from the data. — [arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)
- DABStep Hard (multi-step reasoning over payments data plus documentation) was about 15% for the best model at launch. — [arXiv 2506.23719](https://arxiv.org/pdf/2506.23719)
- Planning gave the biggest gain within KramaBench: DS-Guru o3 went from 9.64% naive to 20.80% with simple planning and 22.08% with self-correction. — [arXiv 2506.06541](https://arxiv.org/html/2506.06541v1)

### Inferences
- **Data steward / discovery agent**: inventories the tables and files available through MCP (schemas, row counts, date ranges, delimiters) before analysis begins. This addresses KramaBench's discovery failures.
- **Planner**: writes an explicit analysis plan (steps, the expected shape of each intermediate result) that the verifier later checks against. Planning was the largest measured lever on KramaBench.
- **Executor**: every computation runs in a sandboxed Python or DuckDB cell. The notebook (code, inputs with hashes, outputs) is saved so the harness can re-run it. A reproducibility check re-executes the notebook and diffs the outputs.
- **Anomaly and pattern detection through deterministic tools** (z-score or IQR, seasonal decomposition, isolation forest, change-point detection) exposed as MCP or harness tools. The LLM chooses the method and explains the findings but does not compute them. Each reported pattern gets a hold-out or second-period check and a multiple-comparisons note, to guard against data dredging.
- **Memorization guard**: for any claim that might come from training data rather than the dataset, ask the model to answer *without* the data (the KramaBench wildfire signal). If it answers equally well, flag the claim.
- **Debug-drift guard**: limit self-correction iterations and re-check the current code against the original plan after each fix.

### Gaps
- I found no 2025–2026 benchmark that specifically measures LLM-agent accuracy on anomaly detection or pattern discovery in business data. The roles above are inferred from the general data-agent benchmarks.

---

## 7. Products: claimed accuracy and how they ground numbers

### Takeaway
Only Snowflake publishes a headline accuracy figure: 90%+ on an internal set of about 150 questions with a semantic model, about 2× single-shot GPT-4o (2024). Databricks Genie gives customers a benchmark tool rather than a number. For Hex, Julius, ChatGPT data analysis, BigQuery's agents and Microsoft Fabric Copilot / data agents I found no published accuracy figures. The common grounding pattern is a semantic model plus executed SQL or code plus a customer-owned evaluation set.

### Cited Findings
- Snowflake Cortex Analyst: 90%+ with a semantic model and about 2× single-shot GPT-4o; internal set, not refreshed since. **[vendor, older]** — [Snowflake](https://www.snowflake.com/en/blog/engineering/cortex-analyst-text-to-sql-accuracy-bi/); [Atlan](https://atlan.com/know/snowflake/cortex-analyst-vs-text-to-sql/)
- Databricks Genie: benchmarks are pairs of question and gold SQL; a question is Correct when result sets match exactly, otherwise Needs Review. In agent mode, an LLM judge grades the narrative (third-party description). **[vendor + third party]** — [Databricks](https://www.databricks.com/blog/building-confidence-your-genie-space-benchmarks-and-ask-review); [codecentric](https://www.codecentric.de/en/knowledge-hub/blog/reliable-by-design-building-an-evaluation-harness-for-databricks-genie)
- Comparisons of Cortex Analyst and Genie say both reach high accuracy only with a well-curated semantic model, and that real accuracy must be measured on your own evaluation set. — [Valiotti](https://valiotti.com/snowflake-cortex-vs-databricks-genie-2026/)
- On Spider 2.0, vendors' agents (Snowflake × UCSD, Oracle OCI, Tencent Cloud, JetBrains) are on the leaderboards at 60–76% on Lite and dbt, which is a public, comparable proxy for their engines. — [spider2-sql.github.io](https://spider2-sql.github.io/)

### Inferences
- The harness should copy the product pattern that has evidence behind it: a semantic model, executed queries only, and a customer-owned gold set with result matching. It should never present a single vendor-style accuracy number. It should show the accuracy on *this* data source's benchmark suite, with its date and size.

### Gaps
- I found no accuracy claims or published evaluations for Hex Magic / Hex agents, Julius AI, ChatGPT data analysis, Google BigQuery data / conversational analytics agents, or Microsoft Fabric Copilot / Fabric data agents. A product-by-product search would be needed. Their grounding approach (executing Python or SQL) is known from product design, not from accuracy studies.
- The claimed 80% Genie readiness threshold could not be confirmed in Databricks' own documentation.
