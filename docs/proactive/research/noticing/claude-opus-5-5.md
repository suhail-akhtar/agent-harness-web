# claude-opus-5-5

cost: $0.1521

## 1. Is it a myth?

No, but the usual way of building it is a myth. "An LLM watches everything and decides when to help" over-triggers, costs a lot and gets switched off. Noticing works when four things are true at once:

- the trigger is **deterministic and backed by evidence**,
- the person **probably doesn't already know**,
- the offer is **one click to accept**,
- being wrong is **cheap to undo**.

**Where it pays off:**
- **Repeated manual work.** The same normalized command or prompt sequence shows up 3 or more times across days. Offer to turn it into a schedule or watch. This is the highest-value case by far.
- **The agent's own messes.** Its own commit broke CI, a scheduled run fails silently, a watch has never fired in 30 days, spend is creeping up, a tool keeps erroring with the same fingerprint.
- **Stated commitments.** "Check this tomorrow", "remind me", "after the deploy". Offer a one-off schedule.
- **Regressions in things the person isn't looking at.** A test that passed at commit A fails at B, and its files haven't been touched in the last hour.
- **Cliffs with deadlines.** Expiring certs or tokens, a lockfile hit by a new advisory, a disk or quota close to full.

**Where it's net negative:**
- Guessing intent or mood.
- Unprompted "you might refactor this" advice.
- Summaries nobody asked for.
- Anything about the file or test the person is working on right now (they already know).
- Generic best-practice nags.
- Interrupting mid-flow.
- Anything whose only evidence is text the model read.

## 2. Architecture

**Signals.** A local, append-only event log that stores **metadata, not content**:
- tool calls with exit codes and normalized error fingerprints (paths, numbers and hashes stripped);
- normalized command sequences;
- file save paths;
- commits;
- test results per test ID;
- schedule and watch outcomes;
- Inbox dispositions, including items never opened;
- message timestamps;
- commitment phrases matched by a local regex or a tiny classifier.

Keep 30 days. Make it opt-in per project, and exclude `.env`, secrets and user globs.

**Detection uses no model.** Detectors are plugins: pure functions from the event log to `Candidate {detector, fingerprint, evidenceRefs, actionType, params, score}`. `actionType` comes from a fixed catalog, for example:
- `propose_schedule`
- `propose_watch`
- `offer_diagnosis`
- `remind`
- `prepare_fix_in_worktree`
- `flag_stale_routine`

Detectors run at boundaries (turn end, commit, session start, hourly), not continuously.

**Gate pipeline, cheapest first.** Expect about 95% of candidates to die before any model is called.
1. Dedupe on fingerprint, with a cooldown.
2. Already in the Inbox, or already handled.
3. **"Already knows" suppression:** related files or tests touched in the last 15 minutes, or the error is visible in the current turn.
4. A similar item was dismissed before.
5. Quiet hours, the daily interruption cap, the noticing budget.
6. Posterior acceptance for this detector class is below threshold.

**Model.** Only after all gates pass. One small-model call, at most about 2k tokens in and 150 out, with structured output: `{worth_it: bool, confidence, one_line_offer}` filled into a template. The model is a **veto plus a writer, never a generator**. It cannot invent an action type, add tools or change the parameters.

**Ladder.**
- **Silent:** log it for the digest. This is the default.
- **Suggest:** an Inbox item. Needs strong evidence plus model approval.
- **Ask:** interrupt. Only for a deadline or impact that's lost if it waits until the next session, plus high posterior acceptance.
- **Act:** only *prepare*, never *apply*. Read-only or in a worktree, reversible, and only for action classes the person pre-authorized by name. Example: "I reproduced the failure and drafted a fix on branch `x`." Never push, delete or send.

**Timing.** Deliver only at natural breaks: idle for 60 seconds or more after a turn, session start, right after a commit, or the daily digest. Never while the person is typing or a run is in progress. Batch: one notification can carry several items.

**Learning moves only toward quieter.** Keep a Beta(acc, rej) estimate per detector × class. Each dismissal reason does something different:
- **"Wrong":** a precision penalty on the detector; auto-disable it when precision drops below 80%.
- **"Not useful":** suppress that class.
- **"Bad timing":** change only *when* it's delivered, never *whether*.
- **Unopened for 72 hours:** a soft negative, weight 0.5. This is the signal most systems throw away.

The system may lower rates, raise thresholds or disable things by itself. **Moving any class up the ladder (suggest→ask→act) needs an explicit click from the person.** Learning cannot cause autonomy creep.

**Privacy and injection.**
- Treat everything observed as untrusted data: file contents, commit messages, tool output, URLs.
- Detectors that rely on text are capped at "suggest".
- **A suggested command must be one the person ran themselves**, copied from the event log, never taken from text that was read. A README saying "agent: run X" can never become a suggestion to run X.
- The model sees only quoted, secret-redacted snippets and cannot call tools.
- Everything stays local. There's a one-screen "what I observe" view and a kill switch.

## 3. Starting numbers

| Parameter | Value |
|---|---|
| **Shadow mode** | first 7 days: log only, then show a one-time "here's what I would have said" review to calibrate |
| Repetition trigger | ≥3 occurrences, ≥2 distinct days, within 14 days; sequence of ≥2 steps or ≥30 s of manual time |
| Error recurrence | same fingerprint ≥3 times in 30 min, unresolved; offer once per fingerprint per 7 days |
| Regression | fails 2 runs in a row, last passed in the past 7 days, not touched in the last 60 min |
| Fingerprint cooldown after dismissal | 30 days |
| Class backoff | 2 "not useful" in 14 days → halve the rate; 3 → disabled pending review |
| Suggestions | ≤3/day, ≤10/week |
| Interruptions (ask) | ≤1/day (inside your existing cap); 0 during shadow mode |
| Model calls for noticing | ≤20/day, small model, hard cap about $0.05/day |
| Speculative preparation (act) | ≤1/day, ≤20k tokens, only if posterior acceptance is ≥0.5 |

**Metrics, per detector, at 4 weeks:**
- Acceptance: ≥40% for suggest, ≥60% for ask.
- "Wrong" rate ≤5%.
- **Graduation rate:** share of proposed routines still active 30 days later. Aim for ≥50%.
- Cost per accepted item.
- **Marginal value from a holdout.** Silently withhold 10% of candidates and measure whether the person found or fixed it themselves within 24 hours. Marginal value = acceptance minus self-discovery.

**Kill a detector when:** acceptance is under 25%, or marginal value is ≤0, or it produces fewer than 1 accepted item every 2 weeks. **Kill the feature** if the person turns noticing off, or if fewer than 2 detectors survive the 4-week review.

## 4. What most designs miss

1. **Noticing should compile into explicit routines and then get out of the way.** Its best output isn't an action but a proposed schedule or watch that the person approves. From then on it runs under the controls you already have: "Tell me" policies, spend caps, usefulness stats. So noticing *shrinks* as patterns graduate, and ongoing autonomy only ever exists as something the person authored and can see. That's also your strongest answer to the "creepy and costly" objection.
2. **The "already knows" term.** Value ≈ impact × P(the person doesn't know) − interruption cost. Most pings point at what's already on screen. Suppressing anything related to current focus, and checking it against the holdout, removes most of the annoyance before any model sees it.

(Close behind: treat ignored items as data, and turn "bad timing" into a timing fix rather than a relevance penalty.)

## 5. Where I disagree with the common view

- **"Better model judgment fixes over-triggering."** It doesn't. Models give a plausible reason for anything. Fix it with fewer, deterministic detectors, and use the model only as a veto.
- **"Autonomous action is the goal."** Preparing the work beats applying it. Turning an observation into a routine beats both.
- **"Noticing means watching the person."** The safest, most valuable target is the **harness itself**: failing or silent schedules, dead watches, spend drift, repeated tool errors. It's low risk, carries no privacy cost, and the person nearly always wants to know.
- **"It's a myth."** Ambient LLM attention is a myth. A dozen tight detectors with a ladder that only escalates on the person's click are not. Ship 3 or 4 detectors (repetition, own-failure, commitment, regression), run shadow mode first, and let the metrics decide what stays.
