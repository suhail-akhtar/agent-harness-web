# Academic and Conceptual Foundations of Proactive AI Agents (to late 2026)

Research date: 2026-11-01. Sources are primary papers (arXiv abstract/HTML pages, author PDFs) unless noted. Numbers from arXiv abstract pages were checked against the full HTML where possible; where only the abstract was read, this is stated.

## Definitions: reactive vs proactive vs autonomous agents; mixed-initiative interaction; what "proactivity" means

### Takeaway
Across the literature, a **reactive** agent acts only on an explicit request. A **proactive** agent watches context (an event stream, the user's activity, the environment state), infers a latent need, and decides **whether, when and how** to offer or take action, including choosing to stay silent. **Mixed-initiative** (Horvitz 1999) is the older HCI framing: user and agent each take the lead at different times, and the agent's choice to act, ask, or do nothing is set by expected utility under uncertainty about the user's goal and attention. Recent work insists that **proactivity is not autonomy**. Autonomy is about how much an agent can do unattended. Proactivity is about initiative: deciding what matters and surfacing it unasked.

### Cited Findings
- Lu et al. define the proactive-agent task formally. Given user activities, environment events and environment state, the agent predicts a task P_t, or predicts nothing if no help is needed. The user accepts or rejects it, and the objective is to maximize acceptance. They contrast this with reactive agents that "wait for explicit instructions". — [Lu et al., arXiv 2410.12361 (Oct 2024, v3 Dec 2024)](https://arxiv.org/html/2410.12361v3)
- Horvitz describes mixed-initiative interfaces as those where "intelligent services and users may often collaborate efficiently to achieve the user's goals". He lists the key failures of agents: "poor guessing about the goals and needs of users, inadequate consideration of the costs and benefits of automated action, poor timing of action", and inadequate means for users to guide or refine results. — [Horvitz, "Principles of Mixed-Initiative User Interfaces", CHI 1999](https://erichorvitz.com/chi99horvitz.pdf)
- Bui and Evangelopoulos (position paper, May 2026) argue that "Agentic Coding Needs Proactivity, Not Just Autonomy":
  - They distinguish proactivity from autonomy and propose a three-level taxonomy: **Reactive → Scheduled → Situation Aware**.
  - They introduce an **insight policy**: what matters next, what evidence supports it, whether to surface it, and how to adapt after feedback.
  - They argue agents should be judged on the quality and improvement of that policy.
  - [arXiv 2605.06717](https://arxiv.org/abs/2605.06717)
- Deng, Lei, Lam and Chua wrote what they call the first survey of proactive dialogue systems (IJCAI 2023 Survey Track, pp. 6583–6591). It covers proactivity problems and designs across dialogue types, and the open challenges for real-world use. — [IJCAI 2023 proceedings](https://ijcai.org/proceedings/2023/738); [arXiv 2305.02750 (May 2023)](https://arxiv.org/abs/2305.02750)
- ProactBench (May 2026) defines "conversational proactivity" as noticing and acting on needs a user implies but does not state. It splits this into three types tied to the phase of the conversation:
  - **Emergent:** a need inferred from a single disclosed anchor.
  - **Critical:** a need synthesized across multiple anchors.
  - **Recovery:** grounded, forward-looking value offered after a task is complete.
  - [Harfi, Salimi, Shen, Smola, arXiv 2605.09228](https://arxiv.org/abs/2605.09228)
- ProactiveEval (Aug 2025) splits proactive dialogue into **target planning** and **dialogue guidance**. It evaluates 22 LLMs across 328 environments. — [Liu, Wan, Guo, Quan, arXiv 2508.20973](https://arxiv.org/abs/2508.20973) (the counts come from a search-result summary; the paper itself was not opened)
- The Always-On Agents survey (Jun 2026) argues that agents become "always-on" through **durable state that persists across sessions**, not through running continuously. It treats "proactivity calibration" (when to surface help versus stay silent) as named in the literature but not governed. — [arXiv 2606.30306](https://arxiv.org/html/2606.30306v1)
- A 2025 survey covers "overhearing" agents that listen in on human activity and offer suggestions, rooted in older ubiquitous-computing ideas of ambient assistance. — [Overhearing LLM Agents: A Survey, Taxonomy, and Roadmap, arXiv 2509.16325](https://arxiv.org/pdf/2509.16325) (only the search snippet was read)
- "Ask Now, Use Later" (EMNLP 2026) names a **proactivity gap** in long-lived agents. Agents keep preferences users volunteer but rarely ask for them unprompted. It isolates **Ask-to-Remember**: deciding whether to ask now for a reusable preference that the current task does not need but a future session will. — [Wu et al., arXiv 2605.28108](https://arxiv.org/abs/2605.28108)

### Inferences
- A useful working definition from these sources has five parts:
  1. Observe context continuously or on events.
  2. Infer a latent need or goal with calibrated uncertainty.
  3. Choose among **do nothing / ask (clarify or offer) / act**.
  4. Choose **timing** with the user's attention in mind.
  5. Learn from accept/reject feedback.
- Horvitz's 1999 framing already holds every part of this. The LLM-era contribution is mostly broader perception and generation, not a new decision theory.
- A taxonomy for a harness could combine Bui and Evangelopoulos's levels (Reactive / Scheduled / Situation-Aware) with Horvitz's three-way decision (none / dialog / action) at each trigger.

### Gaps
- James Allen's "Mixed-Initiative Interaction" (IEEE Intelligent Systems, 1999) is the standard dialogue-side definition (initiative shifting between participants). I did not retrieve or verify it this session.
- From prior knowledge, not verified this session: Deng et al.'s 2023 survey groups proactivity by dialogue type (open-domain target-guided dialogue, task-oriented non-collaborative dialogue, and information-seeking or clarification dialogue). A later SIGIR 2024 perspective paper ("Towards Human-centered Proactive Conversational Agents", Deng et al.) proposes intelligence / adaptivity / civility dimensions. The report writer should treat both as unconfirmed.
- No single agreed formal definition of "proactive agent" exists. Each benchmark sets its own.

## Horvitz: Principles of Mixed-Initiative UIs (CHI 1999), the expected-utility model, and attention-aware systems (LookOut, Notification Platform, BusyBody)

### Takeaway
Horvitz (CHI 1999) gives **12 critical factors** for mixed-initiative design and a decision-theoretic rule. The agent acts when p(G|E) exceeds a threshold p*, set by four outcome utilities. Adding a "dialog" option gives **two thresholds**: below p*¬A,D do nothing, between p*¬A,D and p*D,A ask, above p*D,A act. Context, especially the user's attention, shifts these thresholds. LookOut (the Outlook calendaring agent) put the rule into practice, along with learned timing and courteous time-outs. Later work (Notification Platform, BusyBody) generalized it to inferred **cost of interruption** compared with the value of information.

### Cited Findings
The 12 critical factors, as listed in Horvitz, CHI 1999 ([PDF](https://erichorvitz.com/chi99horvitz.pdf)):
1. Developing significant value-added automation: give real value beyond direct manipulation.
2. Considering uncertainty about a user's goals.
3. Considering the status of a user's attention in the timing of services: weigh the costs and benefits of deferring action until it is less distracting.
4. Inferring ideal action in light of costs, benefits and uncertainties: use expected value.
5. Employing dialog to resolve key uncertainties, considering "the costs of potentially bothering a user needlessly".
6. Allowing efficient direct invocation and termination.
7. Minimizing the cost of poor guesses about action and timing, including "appropriate timing out and natural gestures for rejecting attempts at service".
8. Scoping precision of service to match uncertainty: prefer "doing less" but doing it correctly.
9. Providing mechanisms for efficient agent–user collaboration to refine results.
10. Employing socially appropriate behaviors: "tasteful default behaviors and courtesies" of a benevolent assistant.
11. Maintaining working memory of recent interactions, so the user can refer to shared short-term context.
12. Continuing to learn by observing.

The expected-utility model (same source):
- There are four outcome utilities: u(A,G), u(A,¬G), u(¬A,G) and u(¬A,¬G).
  - eu(A|E) = p(G|E)·u(A,G) + [1−p(G|E)]·u(A,¬G)
  - eu(¬A|E) = p(G|E)·u(¬A,G) + [1−p(G|E)]·u(¬A,¬G)
  - The two lines cross at the threshold **p\***. Act when p(G|E) > p\*.
- Context moves p\*:
  - u(A,¬G) (acting when the user does not want it) "can diminish significantly with increases in the depth of a user's focus on another task". This raises the threshold.
  - More screen real estate lowers the cost of a needless action, which lowers the threshold.
  - u(¬A,G) falls "as a user becomes more rushed", which lowers the threshold.
- Dialog as a third option adds u(D,G) and u(D,¬G).
  - Asking when the goal is absent is usually better than acting when it is absent.
  - Asking when the goal is present is worse than just acting.
  - This gives two thresholds: **p\*¬A,D** (inaction→dialog) and **p\*D,A** (dialog→action).
- "Thresholds can be directly assessed by designers or users". LookOut lets users set the utilities, or the two thresholds directly.

LookOut details (same source):
- **Goal inference:** A linear SVM text classifier estimated the probability that a user wants to schedule from an email. It was trained initially on about 1,000 messages (500 relevant, 500 irrelevant).
- **Modes:** LookOut supports manual invocation, automated dialog, and fully automated action, plus a "social-agent" mode with speech.
- **Precision scoping:** When it cannot find a specific date, it scopes the calendar view to its best guess (for example a week) instead of making a poor specific guess.
- **Time-outs:**
  - The time-out before an offer "evaporates" is a function of the inferred probability that the user wants the service.
  - Dwell increases if the user shows signs of thinking ("hmmm…").
  - The design goal was "an intuitive, courteous butler".
- **Timing:**
  - Instrumented studies found a **nonlinear (sigmoid) relationship** between message length and how long users prefer to dwell before accepting automated scheduling.
  - The system can learn a per-user timing model, refit as a piecewise-linear regression.
- **Lifelong learning:** If the calendar is invoked within a set horizon after reading a message, that message is saved as a positive label. Users can set a retraining schedule.

Later attention-aware work:
- **Notification Platform:** an experimental system for "balancing the value of information awareness and cost of interruption".
  - It collected notifications from many sources and chose the best time to present them.
  - Early versions used hand-built dynamic Bayesian networks over sensed evidence to infer attentional state.
  - It computed both the actual and the expected cost of delayed presentation, and estimated message value with a trained classifier.
  - [Horvitz, Kadie, Paek, Hovel, "Models of Attention in Computing and Communication", CACM 2003](https://www.microsoft.com/en-us/research/publication/models-attention-computing-communication-principles-application/); [full PDF](https://interruptions.net/literature/Horvitz-CACM03-full.pdf); [Attention-Sensitive Alerting](https://www.microsoft.com/en-us/research/publication/attention-sensitive-alerting/) (summarized from search results)
- **BusyBody:** onboard supervised learning that produces **expected costs of interruption** and mediates incoming notifications.
  - It was trained through experience sampling: a pop-up "busy palette" announced by a chime.
  - [Horvitz, Koch, Apacible, "BusyBody: Creating and Fielding Personalized Models of the Cost of Interruption", CSCW 2004](https://erichorvitz.com/busybody_cscw.htm); [PDF](https://www.erichorvitz.com/busybody_cscw.pdf)

### Inferences
- For a harness, the Horvitz model translates directly:
  - A goal-probability estimator (an LLM or a small classifier).
  - A per-context utility table, or simply two user-tunable thresholds, mapped to **silent / ask-or-offer / act**.
  - An attention signal (typing, a running tool, focus) that raises the thresholds when the user is busy.
  - Courteous auto-dismiss offers whose time-out scales with confidence.
- Principle 8 ("do less but correctly") argues for scoped, previewable proposals rather than full autonomous changes when confidence is moderate.

### Gaps
- I did not open the full CACM 2003 PDF or the BusyBody PDF. Their quantitative results (for example BusyBody's classification accuracy) are not reported here.
- The "Priorities" system (Horvitz, Jacobs, Hovel, UAI 1999; email criticality ranking) appeared only as a name in search results. Its details are unverified.

## LLM-era proactive-agent research and benchmarks: methods, metrics, key numbers (2024–late 2026)

### Takeaway
Since late 2024, proactive-agent research has formed a benchmark family:
- **2024–25:** ProactiveBench, ProactiveEval, ContextAgentBench.
- **2026:** ProAgentBench, ProactBench, ProVoice-Bench, ATRBench, PM-Bench, UniClawBench, ProEvent.

The standard metrics are **precision/recall/F1 of proposed tasks** against human or simulated acceptance, and **false-alarm rate**. Headline results show **false-alarm rates of about 50% or more** even for the best models (ProactiveBench). Fine-tuning helps modestly. Real user studies (CHI 2025) find proactive help raises productivity by 12–18%, but **higher frequency sharply cuts preference** (90% → 47%). The newest work separates the **"when to act"** decision from content generation, and finds small dedicated models beat LLMs at the trigger decision.

### Cited Findings

**Proactive Agent / ProactiveBench (Lu et al., Tsinghua et al.; arXiv Oct 2024)** — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
- **Data collection:**
  - Real user activity (keyboard/mouse input, pages visited, dev tools) was collected and converted to text.
  - A GPT-4o-driven "Environment Gym" simulates scenarios and events, and keeps entity state.
  - The domains are coding, writing and daily life.
- **Benchmark size:** 6,790 training events and 233 test events.
- **Reward model:** LLaMA-3.1-8B fine-tuned on 1,760 human-annotated accept/reject labels (1,640 train, 120 test).
  - It reaches **91.80% F1 / 91.67% accuracy**, against human inter-annotator agreement of about 91.67%.
  - Prompted GPT-4o and LLaMA judges reach about 58–67% F1.
- **Metrics:** Recall, Precision, Accuracy, **False-Alarm** rate (unnecessary predictions) and F1.
- **Results on the test set (F1 / False-Alarm):**

  | Model | F1 | False-Alarm |
  |---|---|---|
  | Claude-3-Sonnet | 31.65% | 62.69% |
  | Claude-3.5-Sonnet | 62.00% | 54.63% |
  | GPT-4o-mini | 52.15% | 64.73% |
  | GPT-4o | 64.60% | 51.85% |
  | LLaMA-3.1-8B (base) | 55.06% | 61.84% |
  | LLaMA-3.1-8B-Proactive (fine-tuned) | 66.25% | 50.24% |
  | Qwen2-7B (base) | 60.74% | 56.00% |
  | Qwen2-7B-Proactive (fine-tuned) | **66.47%** | **50.22%** |

- **Further findings:**
  - Predicting 3 candidate tasks instead of 1 raises F1 for most models.
  - Reward-model feedback lowers false alarms but lowers recall.
- **Limitations the authors state:** few environment types, high false alarms, evaluation against a simulated user rather than real users, and privacy concerns from monitoring activity.
- **Inconsistencies in the source:** the paper's text contradicts its own table in places. Section 4.2 gives LLaMA F1 as 44.78→61.74, while Table 3 gives 55.06→66.25. The text gives the best Qwen F1 as 66.07, while the abstract and table give 66.47. Cite the table and abstract values.

**"Need Help? Designing Proactive AI Assistants for Programming" (Chen, Zhu, Zhao, Mozannar, Sontag, Talwalkar; CHI 2025, arXiv Oct 2024)** — [arXiv 2410.04596](https://arxiv.org/html/2410.04596v2); [MSR page](https://www.microsoft.com/en-us/research/publication/need-help-designing-proactive-ai-assistants-for-programming/)
- **Study design:** N=65 programmers. Each spent 20 minutes on a baseline chat assistant and 20 minutes on one proactive variant. All conditions used GPT-4o, on four Python tasks.
- **Conditions:**
  - *Suggest and Preview*
  - *Suggest*
  - *Persistent Suggest*: more frequent. It waits 5 s instead of 20 s, shows 5 suggestions instead of 3, and drops the guiding prompts.
- **Timing policy:**
  - Hold suggestions while the user is typing or chatting.
  - When the user is idle, show them after 5 s, at most once every 20 s.
  - Show them **immediately when code is run and errors**.
- **Design principles:**
  - Support efficient evaluation and use of suggestions.
  - Keep suggestions contextually relevant.
  - Incorporate accept/reject feedback.
  - Time suggestions based on context.
  - From the study: let users choose when proactive help is on, add context beyond code, and vary how much information is shown.
- **Productivity:** Test cases passed rose versus baseline by **+12.1% ±5.1%** (Suggest and Preview), **+18% ±5.8%** (Suggest) and **+11.6% ±5.0%** (Persistent Suggest).
- **Preference for proactive over baseline:** **90%** (Suggest), **80%** (Suggest and Preview) and **47%** (Persistent Suggest). Participants called the persistent variant "distracting and annoying".
- **Accepts and rejects:** 69 accepts and 6 rejects in total.
  - Brainstorming and latent-error debugging suggestions were accepted most.
  - Efficiency and modularity suggestions were rejected most.
  - Acceptance rates per condition were not reported.

**"Assistance or Disruption?" / Codellaborator (Pu et al.; CHI 2025, arXiv Feb 2025)** — [arXiv 2502.18658](https://arxiv.org/pdf/2502.18658)
- **Design:** a within-subjects study with N=18 comparing three conditions: prompt-only, a proactive agent, and a proactive agent with **presence indicators and interaction context**. The agent starts help based on editor activity and task context.
- **Findings:**
  - Proactive agents raise efficiency over prompt-only but cause workflow disruptions.
  - Presence and context cues reduced the disruption and improved awareness of what the AI was doing.
  - Costs remained for user control, ownership and code understanding.
  - (Summarized from the search abstract.)

**ContextAgent (Yang et al.; NeurIPS 2025, arXiv May 2025)** — [arXiv 2505.14668](https://arxiv.org/abs/2505.14668); [NeurIPS proceedings](https://proceedings.neurips.cc/paper_files/paper/2025/hash/f4e5cd2079f5a6cf5176818add841531-Abstract-Conference.html)
- **Design:** sensory context from wearables (video, audio) plus a historical persona → infer intent → decide whether to help → call tools.
- **Benchmark:** ContextAgentBench has **1,000 samples across 9 daily scenarios and 20 tools**.
- **Results:** up to **+8.5% proactive-prediction accuracy** and **+6.0% tool-call accuracy** over baselines (Proactive Agent, ICL, CoT and SFT). These are best-case "up to" figures.

**ProAgent (arXiv Dec 2025)** — [arXiv 2512.06721](https://arxiv.org/html/2512.06721)
- An end-to-end proactive agent that senses context on demand.
- It reports that baselines are often **over-proactive**, triggering when they detect relevant objects even when the user is not focused on them. (Only the search snippet was read.)

**ProAgentBench (Tang et al.; arXiv Feb 2026, cs.HC)** — [arXiv 2602.04482](https://arxiv.org/abs/2602.04482)
- **Design:** splits proactivity into **timing prediction** (when to intervene) and **assistance content generation**.
- **Data:** more than **28,000 events from more than 500 hours of real user sessions**, privacy-compliant. The data keeps bursty interaction patterns (burstiness B=0.787) that the authors argue synthetic data lacks.
- **Findings:**
  - Long-term memory and historical context significantly improve prediction.
  - Models trained on real data substantially beat models trained on synthetic data.
  - The abstract gives no numeric scores.

**"Do Proactive Agents Need an LLM to Decide When to Act?" (Liu, Zhang, Abdi, Galley et al.; arXiv May 2026, v2 Sep 2026)** — [arXiv 2605.30152](https://arxiv.org/abs/2605.30152)
- **Design:** a **temporal graph learning (TGL) controller** replaces the LLM as the trigger decider.
  - User activity is modeled as a graph of events linked by recurring entities.
  - Trigger decisions are made on event nodes and context selection on entity nodes, in one forward pass.
  - An LLM then writes the suggestion only for triggered events.
- **Speed and footprint:**
  - **11.13 ms/event** on a GPU, about **4–7× faster** than single-forward LLM triggers.
  - **13.99 ms on a consumer laptop** with about 220 MiB of memory.
- **Quality:**
  - Highest AUC of nine trigger architectures.
  - Improves downstream F1 for all **14 LLM backbones, by a mean of +16.7 points**.

**ProactBench (Harfi, Salimi, Shen, Smola; arXiv May 2026)** — [arXiv 2605.09228](https://arxiv.org/abs/2605.09228)
- **Design:** three agents (Planner, User Agent, Assistant) with information asymmetry, to avoid rubric leakage and "information dumps".
- **Corpus:** 198 dialogues with **624 trigger points across 24 communication styles**.
- **Findings:** across **16 models**, the *Recovery* type was hardest and only weakly predicted by six standard benchmarks. The abstract gives no per-model scores.

**ATRBench, "Ask Now, Use Later" (Wu et al.; EMNLP 2026, arXiv May 2026)** — [arXiv 2605.28108](https://arxiv.org/abs/2605.28108)
- **Design:** each user's preferences are hidden ground truth, so an agent can succeed only by asking for them.
- **Findings:**
  - Across **8 frontier agents**, default performance trails an oracle **by at least 62 points**.
  - Prompting closes little of the gap.
  - Acquiring the preference (getting the agent to ask) is the bottleneck.

**Other 2026 benchmarks (search-result summaries only; details unverified):**
- **ProVoice-Bench**, proactive voice agents, 1,182 samples. — [arXiv 2604.15037](https://arxiv.org/abs/2604.15037)
- **PM-Bench**, prospective memory: keeping intentions, running delayed tasks, monitoring changes. Cross-day and update-sensitive tasks are "largely unsolved". — [arXiv 2607.12385](https://arxiv.org/html/2607.12385v1)
- **UniClawBench**, 400 bilingual tasks, with a closed loop of executor, hidden supervisor and user simulator. — [arXiv 2607.08768](https://arxiv.org/pdf/2607.08768)
- **ProEvent**, event-centric tracking, precision and recall. — [arXiv 2607.17701](https://arxiv.org/pdf/2607.17701)
- **Long-term Task-oriented Agent**, proactive long-term intent maintenance in dynamic environments. — [arXiv 2601.09382](https://arxiv.org/pdf/2601.09382)

**Ask-before-acting and clarification:**
- **QuestBench** (Google DeepMind; NeurIPS 2025) tests whether a model can pick the one clarifying question needed to solve a problem.
  - Models do well on GSM-Q and GSME-Q but reach only **40–50% accuracy on Logic-Q and Planning-Q**.
  - On Planning-Q, LLMs rarely choose "not sure" even when it is offered.
  - [NeurIPS 2025 poster](https://neurips.cc/virtual/2025/poster/121518); [arXiv 2503.22674](https://arxiv.org/abs/2503.22674v1)
- **AskBench** (early 2026) turns QA into multi-turn tasks with clarification checkpoints. It trains "when and what to ask" with rubric-guided RLVR. — [arXiv 2602.11199](https://arxiv.org/pdf/2602.11199)
- A June 2026 paper adds clarification variants of WebShop and ALFWorld (half of the tasks deliberately underspecified). It separates action confidence from request uncertainty. — [Emergent Mind 2606.19559](https://www.emergentmind.com/papers/2606.19559) (secondary source; unverified)

### Inferences
- The consistent quantitative story:
  - Even strong LLMs **over-trigger**: false alarms of about 50% or more on ProactiveBench, and ProAgent's observation that baselines are over-proactive.
  - Benefits are real but fragile. Users react badly to frequency: CHI 2025 preference fell from 80–90% to 47% when suggestions became more frequent.
  - Precision and timing matter more than recall.
- A clear 2026 trend is **decoupling the "when" (trigger policy) from the "what" (content)**. ProAgentBench's hierarchy and the TGL controller both do this, and both support a cheap, always-running trigger model that gates an expensive LLM.
- Benchmarks are moving from single-shot task prediction (2024) to long-lived, memory-dependent proactivity (2026: ATRBench, PM-Bench, the Always-On survey).

### Gaps
- Most 2026 benchmark numbers come from abstracts only; per-model tables were not retrieved for ProactBench, ProAgentBench, PM-Bench, UniClawBench or ProEvent.
- ProactiveEval's detailed results were not retrieved.
- I found no published field deployment (in-the-wild, longitudinal) of an LLM proactive agent with acceptance and false-alarm rates for real users. Evidence is lab studies (N=18, N=65) or simulated users.
- Initiative in commercial background coding agents (for example scheduled or background agents in IDEs) is not covered by peer-reviewed metrics that I found, beyond the Bui and Evangelopoulos position paper.

## Components a proactive agent needs (according to the papers)

### Takeaway
The papers converge on a pipeline:
1. **Perception** of an environment or event stream (user activity, environment events and state, sensors).
2. A **user model / memory** (persona, preferences, history).
3. **Intention or need prediction** with uncertainty.
4. An **initiative and timing policy**: whether, when and how (silent / ask / offer / act), conditioned on attention and interruption cost.
5. **Generating and executing assistance** (often tool calls).
6. **Feedback learning** from accept/reject (reward models or online updates).
7. **Interaction affordances**: cheap invoke, dismiss and preview, and presence indicators.

### Cited Findings
- **Horvitz (1999):** goal inference p(G|E); an attention model for timing; utility-based choice among action, dialog and inaction; working memory of recent interactions; continual learning by observing; efficient invoke and terminate; graceful time-outs. — [CHI 1999 PDF](https://erichorvitz.com/chi99horvitz.pdf)
- **Lu et al. (2024):**
  - Inputs are user activities, environment events and environment state.
  - The output is a predicted task or "no task".
  - A **reward model** trained on human accept/reject labels serves as a simulated user and a training signal.
  - [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
- **Chen et al. (CHI 2025):** context from code, chat history and terminal output; **timing rules** (hold while typing, idle delay, show immediately on error); a mechanism for accept/reject feedback; preview to make suggestions cheap to evaluate. — [arXiv 2410.04596](https://arxiv.org/html/2410.04596v2)
- **Pu et al. (CHI 2025):** **presence indicators** and visible interaction context reduce the disruption of proactive actions. — [arXiv 2502.18658](https://arxiv.org/pdf/2502.18658)
- **ContextAgent (NeurIPS 2025):** multimodal sensory perception plus a **historical persona** → a proactive-need decision → tool calling. — [arXiv 2505.14668](https://arxiv.org/abs/2505.14668)
- **ProAgentBench (2026):** a separate **timing-prediction** stage plus **content generation**; long-term memory and historical context significantly improve prediction. — [arXiv 2602.04482](https://arxiv.org/abs/2602.04482)
- **TGL controller (2026):** a dedicated lightweight **trigger model** over an entity-linked event graph, plus **context selection** of relevant entities, then an LLM for content. — [arXiv 2605.30152](https://arxiv.org/abs/2605.30152)
- **Bui and Evangelopoulos (2026):**
  - An **insight policy** (what matters, the evidence, whether to surface it, adapting after feedback).
  - Proposed evaluation targets: **Insight Decision Quality, Context Grounding Score and Learning Lift**, measured through active user simulation.
  - [arXiv 2605.06717](https://arxiv.org/abs/2605.06717)
- **ATRBench / PM-Bench (2026):**
  - **Preference acquisition** (asking now for future use) is a missing component.
  - **Prospective memory** (keeping intentions, delayed execution, monitoring changes) is another.
  - [arXiv 2605.28108](https://arxiv.org/abs/2605.28108); [arXiv 2607.12385](https://arxiv.org/html/2607.12385v1)
- **Always-On survey (2026):** durable cross-session state and **governance** (scope and authority for proactive actions) as components. — [arXiv 2606.30306](https://arxiv.org/html/2606.30306v1)
- **BusyBody / Notification Platform:** a learned, personalized **cost-of-interruption** model that mediates notifications. — [BusyBody](https://erichorvitz.com/busybody_cscw.htm); [CACM 2003](https://www.microsoft.com/en-us/research/publication/models-attention-computing-communication-principles-application/)

### Inferences
- A minimal architecture for an agent harness:
  - An event bus (file, terminal, test and VCS events, plus user idle/typing state).
  - A cheap trigger and scoring stage that estimates p(need) and interruption cost.
  - Horvitz-style thresholds mapping to silent / offer-or-ask / act, with the act threshold also gated by permissions.
  - LLM content generation for triggered events.
  - A dismissible, previewable surface with a presence indicator.
  - Logging of accept, reject and ignore outcomes to recalibrate thresholds per user.

### Gaps
- No paper found gives an end-to-end reference architecture with ablations for every component together. Each paper ablates one or two.

## Open problems named in the literature

### Takeaway
The recurring open problems are:
- **Over-proactivity / false alarms**: high false-alarm rates, and baselines that trigger on mere relevance.
- **Annoyance and disruption**: frequency hurts preference; there are workflow costs to control, ownership and code understanding.
- **Privacy**: proactivity requires continuous observation.
- **Evaluation validity**: simulated users and reward models instead of real users; synthetic data that misses bursty real behavior; no benchmark that scores whether a proactive action was *licensed*.
- **Calibration and governance**: scope and authority of initiative.
- **Long-horizon memory**: asking for preferences, prospective intentions, cross-day tasks.
- **Cost and latency** of an always-on LLM trigger.

### Cited Findings
- **Over-proactivity:**
  - The best ProactiveBench models still show about **50% false alarms**, and the authors list high false alarms as a limitation. — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
  - Baselines "often exhibit over-proactive behavior", triggering on relevant objects when the user is not focused on them. — [ProAgent, arXiv 2512.06721](https://arxiv.org/html/2512.06721)
- **Annoyance and frequency:** the Persistent Suggest variant was described as distracting and annoying; preference fell to **47%** from 80–90%; participants raised over-reliance concerns. — [Chen et al., CHI 2025](https://arxiv.org/html/2410.04596v2)
- **Disruption and ownership:** proactive agents improve efficiency but cause workflow disruptions and costs to control, ownership and code understanding. — [Pu et al., CHI 2025](https://arxiv.org/pdf/2502.18658)
- **Privacy:** ProactiveBench flags privacy and ethical concerns from monitoring user activity. — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3). ProAgentBench stresses a "privacy-compliant" real-user dataset. — [arXiv 2602.04482](https://arxiv.org/abs/2602.04482)
- **Evaluation validity:**
  - Evaluation relies on a simulated user (a reward model). — [arXiv 2410.12361](https://arxiv.org/html/2410.12361v3)
  - Real-data models substantially beat synthetic-data models, and synthetic data misses burstiness. — [ProAgentBench](https://arxiv.org/abs/2602.04482)
  - ProactBench is designed against rubric leakage, style confounds and information dumps, and finds Recovery proactivity weakly predicted by standard benchmarks. — [arXiv 2605.09228](https://arxiv.org/abs/2605.09228)
- **Governance and calibration:** no ambient benchmark scores whether a proactive action was licensed; over-eager interruptions are scored as accuracy errors rather than scope or authority violations. — [Always-On Agents survey, arXiv 2606.30306](https://arxiv.org/html/2606.30306v1)
- **Long-horizon proactivity:**
  - There is a gap of at least 62 points to the oracle on Ask-to-Remember, and prompting barely helps. — [arXiv 2605.28108](https://arxiv.org/abs/2605.28108)
  - Cross-day and update-sensitive prospective-memory tasks remain "largely unsolved". — [PM-Bench, arXiv 2607.12385](https://arxiv.org/html/2607.12385v1)
- **Knowing when to ask:** LLMs reach only 40–50% on Logic-Q and Planning-Q clarification and rarely hedge with "not sure". — [QuestBench](https://neurips.cc/virtual/2025/poster/121518)
- **Cost and latency:** using an LLM as the per-event trigger is expensive; a graph model is 4–7× faster and runs on a laptop. — [arXiv 2605.30152](https://arxiv.org/abs/2605.30152)
- **Historical framing:** Horvitz already named poor goal-guessing, poor cost-benefit reasoning, poor timing and inadequate user control as the core failures of agents. — [CHI 1999](https://erichorvitz.com/chi99horvitz.pdf)

### Inferences
- The 1999 failure modes are almost exactly the 2026 open problems. LLMs improved goal inference and content but not calibration, timing or attention-awareness.
- For a harness, the safest default implied by the evidence is high thresholds for acting and moderate ones for offering. Add rate limits (Chen et al.'s 20-second floor), immediate triggers on clear failure signals (errors), visible presence, one-click dismiss, and per-user learning from rejections.

### Gaps
- I found no study quantifying long-term annoyance or habituation (for example acceptance decay over weeks) for LLM proactive agents.
- I found no standard metric for "cost of a false alarm" in LLM benchmarks. False-alarm rate is counted but not weighted by interruption cost, unlike Horvitz's utility framing.
- Security risks specific to proactivity (for example prompt injection arriving through observed event streams and triggering unrequested actions) were not covered by the sources retrieved here.
