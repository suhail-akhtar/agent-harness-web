# Proof-carrying swarms: the position and the plan

Research: [research/REPORT.md](research/REPORT.md) ("Build the verifier before the swarm"), from seven research notes in
[research/](research/) (architectures, deep research agents, forecasting and BI, security, forensics / fact-checking /
OSINT, reliability and verification, frameworks and products), November 2026. It builds on the coordination research in
[../agents-mcp/research/](../agents-mcp/research/) and on acceptance as built ([../agents-mcp/COORDINATION.md](../agents-mcp/COORDINATION.md)).

## The position

The evidence says a bigger swarm does not buy accuracy: at equal compute, extra agents saturate after a handful, voting
among frontier models fails because their errors are correlated (two that both err pick the same wrong answer about
60% of the time), and debate costs 2-3x for equal or lower accuracy. What does buy accuracy is cheap and structural:
independent candidates **selected by a check that runs** (a test, an executed query, a crash, a fetched page that
contains the quote), a verifier from **another model family**, **visible budgets**, and **abstention** that never
counts as a pass. Where such a check exists, agent systems reach production precision (AIxCC: 54 of 63 planted bugs
found); where truth is judged, the best systems are co-pilots.

Frameworks have converged on a supervisor that calls agents as tools and still leave verification empty; products sell
provenance without publishing method. This harness already enforces the rare half: harness-run done criteria, held-out
checks, protected tests, a BLOCKED way out, a clean-context verifier whose "unknown" is never a pass, a source store
with a citation check, a semantic data layer, sandboxes behind an egress allowlist, and an eval runner. Calibrated
live: three verifier models (DeepSeek Flash, Claude Haiku 5.5, Claude Sonnet 5.5) passed none of 8 planted cheats and
failed none of 4 good changes ([EVAL-ACCEPTANCE.md](../agents-mcp/EVAL-ACCEPTANCE.md)).

So the harness's swarm is a **proof-carrying run**: alongside its deliverable it returns the evidence for each claim,
the verdicts of independent checkers, a budget account and a recording; the harness, under the person's **stakes**,
decides to accept, abstain or escalate, never a model's report on its own work. Agent count is the cost dial; checks,
verifiers and the claim ledger are the accuracy dial.

## What we do not build (on the evidence)

Free chat between agents and debate panels; majority votes among frontier models; 100-agent fan-outs sold as accuracy;
gates on a model's stated confidence; silently re-routing a task a provider refused (security) to a less-guarded one.

## Phases

Each phase ships only when a measured pilot shows it beats a single agent on the same model at the same budget, on
cost per correct answer (the rule of COORDINATION.md), on a gold set of the person's own kind of material with
abstention scored; anything that does not pay is removed. Spend in stages with written stop rules: a 5-task smoke
test, a paired pilot (30-50 tasks x 3 runs x 2 configurations), then confirmation on frontier models only for what won.

### Phase 1: the proof-carrying run (core)

1. **Oracle-grade checks.** A `run` check can require an exit code (`exit: 0 | n | "nonzero"`) and output that must
   not appear (`expect_not`): "the proof of vulnerability fires before the patch and not after" becomes a check.
2. **Stakes** on a delegation (`stakes: "normal" | "high" | "critical"`), one setting that drives the rest:
   - *high*: verification is required, by a verifier on **another provider** than the worker (from the models the
     person allows; a preference order the operator can change); a delegation with neither checks nor verification is
     verified anyway.
   - *critical*: as high, plus **replicas**: two independent workers on two providers (each in its own worktree in a
     git folder), each accepted on its own; then a **comparator** with a clean context reads both results against the
     brief. Agreement and both accepted: the stronger is returned, with the other as corroboration. Disagreement, or
     only one accepted: the report says UNKNOWN (with both), never a silent pick; for code, the one whose checks and
     verifier passed is offered, marked as uncorroborated.
3. **Visible budgets.** Every sub-agent sees its remaining steps and spend each turn (BATS: a budget tracker at 10
   calls matched 100 unbudgeted calls); a child's budget never exceeds its parent's remainder.
4. **Per-requirement verdicts.** The verifier lists each requirement of the brief as met, unmet or unverifiable; the
   report and the transcript card show them.
5. Tests: deterministic scenarios for every rule (replicas that agree, disagree, one failing; a verifier on the same
   provider refused at high stakes; a budget shown; exit checks). Live: a paired pilot, single agent vs stakes
   high/critical at equal budget, on a gold set with planted traps.

### Phase 2: answers over the person's own data

The data-answer swarm, the best ratio of measured gain to effort (a written semantics file added 17-23 points on every
frontier model tested; the checks run as code). A building block, then a workflow:
- `semantics.md` drafted when an MCP server is built from a database, approved by the person before agents use it.
- A clarifier (lists interpretations; asks or states its assumption), an SQL author that cites the definitions it
  used, deterministic checks after every query (join fan-out, grain uniqueness, parts sum to the total, date coverage),
  a recomputation on another provider that never sees the first query, and a provenance rule: every number in the
  narrative traces to a stored query cell, or the answer is rejected.
- Gold set: 40 questions over two of the person's databases, a quarter ambiguous or unanswerable.

### Phase 3: claim-checked research and fact-checking

The claim ledger: every claim in a deliverable carries typed evidence (a source id with quote and hash, a query cell, a
tool output hash, an oracle run) and a status (supported, partial, unsupported, contradicted, unverifiable); an
entailment check per claim by a verifier from another family that sees only the sentence and the cited passage; two
independent origins (after de-duplication) for key claims at high stakes; a counter-evidence searcher for contested
claims; a contradiction register the report must resolve; "not enough evidence" and "conflicting" as rewarded outcomes.
Readers of untrusted pages get only read tools and return structured evidence; actors never see raw page text.

### Phase 4: oracle-gated security review of the person's own code

Variant analysis (each security-fix commit's unfixed relatives) and SAST triage first; then shard-and-confirm (files
ranked, one agent each, "nothing found" or a finding with a reproducer, in sanitizer-built containers with no network,
de-duplicated, a final verifier); patch acceptance as checks (the reproducer no longer fires, others' reproducers as
held-out checks, a short fuzz run, tests protected, then the verifier). No oracle: "unknown", to a person. A mandate
(targets, authorization, window) enforced at the proxy and the tools; a person approves every outbound report.

### Phase 5: a forecasting ledger

Question framer, outside view first, researchers on different search tools, 5-8 forecasters across providers, a
deterministic aggregator in code (trimmed mean in log-odds, sqrt(3) extremizing, caps), a market comparison, and a
scorer that refits calibration from resolved questions. Live questions only; never a claim of beating humans without
live evidence.

### Phase 6: investigations as co-pilot work

Forensics, OSINT and threat triage once the ledger, the run recorder (content-hashed inputs and outputs, a hash-chained
log, replay distinct from re-run, an export bundle) and the mandate exist: discovery, ranked queues and coverage
checklists; people make every identification, attribution and remediation decision. EU AI Act: evaluating evidence in
criminal investigations is high-risk (Annex III 6(c)); untargeted scraping for face recognition is prohibited (Art. 5).

## Status

- Research: done (2026-11-02).
- Phase 1: built (2026-11-02): stakes (high: a verifier of another provider; critical: replicas on two providers in
  worktrees and a comparator), exit / expect_not checks, per-requirement verdicts, visible budgets; 51 deterministic
  scenarios in test/acceptance.test.ts; live: EVAL-ACCEPTANCE.md, P1-P3 and the calibration.
