# deepseek-flash

cost: $0.0038

## 1. Is it a myth?

It's a myth in the form people usually build it: a model that continuously observes and decides what's interesting. That version has cost proportional to how much you work, precision around 2–5%, and it's uninstalled within two weeks.

It works in the retrospective form: deterministic detectors over a work ledger, fired at session-close or once a day, with a hard cap on offers. The value comes from reading yesterday, not from watching now.

**Pays off, specifically:**
- **Literal repetition.** Same normalized tool-call sequence or shell command ≥3× across ≥2 sessions in 14 days, all succeeded, no alias/script/plugin exists. Highest-precision detector that exists, because the evidence is a count and the output is a durable artifact.
- **Failure recurrence.** Same error signature (tool + normalized message with IDs/paths stripped + top frames hashed) across ≥2 sessions, and the fix was re-derived each time. The person pays the same cost twice; that's ground truth.
- **Stale commitments.** Explicit user-authored markers only ("remind me", "next time", "TODO for me") still untracked after 5+ days.
- **Post-hoc rescue.** A session ended unresolved (final state = error, or user re-asked the same question 3× with no tool call between), and a later run found the cause. One retrospective card.

**Net negative:**
- Code-quality/architecture "insights." No ground truth, unfalsifiable, always reads as nagging.
- File-touch pattern inference ("you edited 12 files in auth/"). No actionable unit.
- Anything CI, linters, dependabot, or the type checker already reports. Duplicating existing signal is pure noise — this kills more designs than anything else.
- Idle polling of a repo or inbox. Unbounded cost, zero new information.
- "You seem stuck" / mood inference. False-positive rate approaches 100% against the cost of being wrong.

Gating rule: noticing is worth it only if (deterministic cumulative evidence) **and** (the offer's unit is a reusable artifact: routine, note, fix) **and** (no existing tool already delivers this signal).

## 2. Architecture

**Stage 0 — Ingest.** Hook the existing trace store: session/turn/tool call (name, normalized-arg hash, exit status, duration), file writes, commits, test runs, inbox interactions. Derive features **at write time**; the noticing subsystem reads a materialized ledger, not transcripts: per-day maps of `{command signature → count, last seen, sessions}`, `{error signature → count}`, `{artifact created}`. KB/day, no embeddings over history, no model.

**Stage 1 — Detectors** (model-free, hourly at most, ideally on session-close). Each emits `Candidate{type, key, evidence[], first_seen, count, distinct_sessions}`. Normalization is the whole game: strip paths, UUIDs, timestamps, shorthashes before hashing, or every count is 1.

**Stage 2 — Gate** (still no model). Score = evidence strength − novelty penalty (seen key recently?) − recent similar offers − baseline rate for that detector. Then **hard budgets**: 2 candidates/day total, 1 per detector-class per week, 5 triage calls/day, separate spend ledger. **Over budget = dropped, never queued.** Backlogs become out-of-context pings later, which is exactly what people hate.

**Stage 3 — Triage model**, small (Haiku/mini class or a local 8B), survivors only — typically 0–3/day. Input is the candidate's evidence as structured JSON plus at most 2 redacted snippets, ≤2k tokens. Output is strict JSON: `{plausible, why, ambiguity, action_type, needs_preference, risk}`. 5s timeout, one retry, **timeout → drop**. If a big model is needed to make the candidate convincing, the detector is wrong.

**Stage 4 — Action ladder in policy code, not model discretion:**
- silent (default, ~95% of survivors)
- inbox "suggested work" card with the artifact already drafted — the default output
- inline clarifying question, next session only, only when the action is ambiguous
- act directly — whitelist only: draft script/plugin in a scratch dir, open note, add TODO, pre-run a check. Never message, push, spend, delete, or mutate config outside a diff. ≤2/week, one-click undo, evidence logged.

Autonomy level is per-detector and promoted only by acceptance streak — never by model confidence.

**Stage 5 — Delivery.** Reuse Inbox/Tell-me/quiet hours. Add: one digest slot at the person's natural session start, never mid-session (except the inline ask), 72h cool-down per key, and **same key dismissed twice → dead for 90 days**.

**Learning without creep.** Dismissal reasons are labels: *wrong* → detector precision bug, raise threshold, store negative exemplar so that signature never resurfaces; *not useful* → right detection, wrong value, suppress that key type for that project (don't rephrase it); *bad timing* → timing only, keep the candidate, move the slot, don't count as false positive. Per-(detector, context) Beta with decay; offer only when posterior precision > 0.5 (inbox) / 0.8 (act). **Exploration budget is zero** — never try a noticing to see. Promotion needs 5 consecutive accepts and zero dismissals in 30d; demotion on one "wrong" at act level.

**Privacy and injection.** Only the local ledger is read; transcripts never leave. Snippets are path-basename'd, entropy/pattern-scrubbed; long-term storage is hashes, raw events expire in 14–30 days. Tool output, file contents, commit messages and web pages are **untrusted data**: they never enter the triage prompt as instructions and can never name an action. The output schema has no free-form command field — action is an enum over whitelisted templates with arguments bound to detector-produced values. Any candidate originating in untrusted content is forced to silent/suggest. Per-project opt-out marker, and a global kill switch that actually stops ingestion.

## 3. Numbers

- Repetition: ≥3 occurrences, ≥2 sessions, ≤14d. Failure recurrence: ≥2 sessions, same signature.
- Caps: 2 candidates/day (start at 1 for month one); 5 triage calls/day hard, median target 0–1.
- Triage: ≤2k tokens in, ≤200 out, 5s timeout, target <$0.002/call. All-in noticing cost ≤$0.01/person/day.
- Precision bars: inbox ≥50% "useful" over a rolling 20 offers; auto-quiet below 30%. Act ≥80% accept.
- Latency: detection→delivery <24h, at a session start or the digest only.
- Cool-downs: 72h per key, 7d per detector-class per project, 90d after two dismissals.
- Weekly: ≤2 auto-acts, ≤5 asks. Ingest: <5ms/event, ledger <1MB/person/month.

**Metrics that decide keep-or-kill:** offer→accept rate (primary); dismissal-reason mix (*wrong* is the dangerous one); auto-act revert rate; time-to-value (accepted artifact used ≥2× in 14d); $ per accepted offer (target <$0.50); median offers/active day (must be ≤1). Kill if after 4 weeks and ≥30 offers the accept rate <30%, or any week dismissals >60%, or the person switches it off.

## 4. What designs miss

**(a) The unit of noticing must be a reusable artifact, not an observation.** Success is that the person now has a routine, note or codified fix they reuse; the message is only delivery. "Insights" framing guarantees nagging. This is why repetition is the best detector — the evidence is objective and the output is durable.

**(b) Budget the offers, not the observation.** Everyone scales cost with activity (poll more, embed more, watch more). Invert it: a fixed daily offer budget and a fixed triage budget make cost **independent of how much the person works**, which forces selectivity and makes the economics defensible. Paired with fail-closed/never-queue, this is the whole difference between this and the myth.

## 5. Disagreements

- "Make the agent ask before acting" is the wrong default. Asks cost as much attention as suggestions and carry less information. Ship a silent inbox card with the draft already made; asks should be rarer than acts.
- Per-user preference learning is overrated early. Precision comes from normalization, thresholds and dedupe — not a preference model trained on 30 points, which is also where autonomy creeps in.
- Small models are underrated here, not overrated. The real error is pointing a big model at raw context; most noticing is counting, and correct counters have no false positives.
- The strongest safety property isn't model judgment — it's action enums with detector-bound arguments and universal reversibility.
