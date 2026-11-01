# kimi-k3.1-pro

cost: $0.0399

## 1. Not a myth; continuous LLM “awareness” is the mistake

Self-initiated noticing pays when there is **fresh, structured evidence of a concrete problem or repeated cost**, and the intervention is cheaper than the problem:

- The same normalized tool error recurs despite retries or edits.
- A previously green test fails immediately after a specific edit.
- The agent is repeating a failing command without changing its inputs.
- A manually repeated sequence is frequent enough to justify a watch or schedule.
- Work is complete but a narrowly scoped, previously authorized follow-up remains undone.
- A scheduled/watch-based automation would prevent an observed recurring failure.

It is net negative when based on vague relevance: “you mentioned X,” “this file might need refactoring,” “tests have not run recently,” generic commit reminders, or attempts to infer goals from conversation. Also avoid noticing during exploration, speculative branches, deliberate failing tests, and active debugging unless repetition is clear. The right default is not “helpful”; it is **silence**.

## 2. Architecture: deterministic exception detection, not an agent watching everything

**Event layer.** Reuse harness telemetry rather than rescanning the workspace:

- Tool name, exit status, duration, normalized error fingerprint, retry count.
- Command/workflow fingerprints with secrets and arguments redacted.
- Edit → test-run ordering, test fingerprints, prior green state, commit/file metadata.
- Session linkage, workspace, active/idle state, existing schedules and watches.
- Conversation only as structured metadata by default; no continuous raw-text model review.

Keep a short-lived local event buffer. Candidate state belongs in a durable **candidate ledger**: fingerprint, evidence, first/last occurrence, disposition, cooldown, model calls, and outcome.

**Candidate detectors.** Pure functions produce candidates only for explicit patterns:

- Identical failure ≥N times without a meaningful input/change-set difference.
- Green → edit → repeated red with the same failure signature.
- Repeated command/workflow across separate sessions.
- Repeated task matching an existing routine capability, with no routine installed.
- Agent-owned runaway behavior, such as futile retries.

No model polling, embeddings over everything, or background file-content ingestion.

**Model gate.** Most candidates need no model: deterministic templates can say, “This command failed identically three times. Stop retrying?” Use one small, tool-less model only when evidence passes thresholds but usefulness or wording is ambiguous. Give it a compact redacted evidence packet and require strict JSON: `show/suppress`, category, rationale, suggested response. It may **veto or rank**, never invent evidence, create an action grant, or elevate autonomy. Cache its decision by evidence fingerprint.

**Decision ladder.**

- **Silent:** retain ledger evidence; no Inbox item.
- **Suggest:** noninterrupting Inbox card with evidence and one concrete action.
- **Ask:** interrupt only for imminent repeated cost or an action requiring a decision.
- **Act:** initially only on the agent’s own work—stop futile retries, preserve a checkpoint. External changes require an existing, explicit standing grant specifying scope, spend, expiry, reversibility, and verification. A dismissal never creates such a grant.

Every offer should contain: observed facts, why now, one-click action, and “turn this into a watch/schedule.” The best noticing often **converts itself into person-authored deterministic automation and disappears**.

**Timing.** Deliver at response completion, command completion, or a natural session boundary; never while typing, tests are running, or a presentation/full-screen app is active. Otherwise wait for idle or digest. Merge candidates by root fingerprint. No “still broken?” reminders without new evidence.

**Learning.** Feedback applies to narrow detector/topic/workspace scopes:

- Snooze: temporary cooldown.
- Bad timing: adjust timing only.
- Not useful: suppress that detector/topic combination.
- Wrong: suppress the exact fingerprint and require stronger evidence.
- Repeated dismissals: disable the detector and offer a global off switch.

Feedback can only **reduce frequency or autonomy**. Promotion, broader scopes, new sensors, and action grants require explicit consent.

**Privacy and injection safety.** Observation is local, workspace-scoped, retention-limited, and inspectable. Cross-session and linked-session signals are opt-in. Tool output, files, commits, and web content remain untrusted data: detectors extract facts but never execute instructions found there. Models receive no secrets or arbitrary instruction-bearing content where metadata suffices. Suggested commands require the normal authorization path.

## 3. Starting numbers and keep/kill metrics

Start with **two weeks of shadow mode**: record candidates and hypothetical delivery, show nothing, and review samples.

Initial defaults:

- Retry-loop candidate: **3 identical failures in 10 minutes**.
- Routine candidate: **3 repetitions in 7 days across ≥2 sessions**; require an estimated manual cost of at least **2 minutes per occurrence**.
- Regression candidate: prior green, relevant edit, then **2 identical failing runs**.
- Model: at most **1 call per candidate, 4 per day**, ≤2,000 input tokens and 150 output tokens each; zero calls for deterministic cases.
- Delivery: **1 interrupt/day, 3/week**, **3 Inbox suggestions/day**, with existing caps and quiet hours taking precedence.
- Cooldowns: **24 hours** after snooze, **7 days** after ordinary dismissal, **30 days** after “not useful”; permanent detector disable after three such dismissals.
- Event retention: **7 days** locally unless attached to an Inbox item.

Measure verified usefulness, not engagement:

- Offer accepted and action completed successfully, or routine installed and still used after 14 days.
- “Wrong,” “not useful,” and “bad timing” rates separately.
- Interrupts per verified useful outcome; repeats demonstrably avoided.
- Proactive tokens as a share of total tokens; time spent reviewing offers.
- Detector-level precision and opt-out/disable rate.

After four weeks and at least 30 visible offers: keep interrupts only if **≥60% are verified useful**, wrong/not-useful is **<15%**, and proactive cost is **<1% of total token spend**. Inbox-only suggestions can survive at **≥35% useful**. Below that, revert weak detectors to shadow or silence. Any unauthorized action is a launch-blocking defect, not a metric to average away.

## 4. What most designs miss

1. **The output should be a durable control, not a conversation.** Repeatedly noticing the same thing is failure. Install an explicit watch, cap, or workflow—or stop noticing it.
2. **A shadow ledger and counterfactual rehearsal matter more than model quality.** Replay historical events, inspect what would have interrupted, and price false alarms before enabling delivery. Without this, teams tune against anecdotes.

## 5. Where I disagree with the common view

The skeptics are right about the usual implementation: an LLM continuously reading context will produce expensive, plausible irrelevance. But that does not make noticing mythical; it makes **model-first noticing** bad engineering. High-value proactivity is rare, episodic, and mostly deterministic.

Conversely, optimists overvalue bigger models, broader surveillance, and acceptance rates. Users accept offers merely to clear them. The healthier system is one that calls almost no model, acts almost never without a grant, and can go weeks in silence without considering itself broken.
