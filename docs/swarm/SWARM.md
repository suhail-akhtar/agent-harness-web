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

### Phase 1b: the verifier measured at scale

The calibration so far (no verifier passed any of 9 planted problems) is right but small: zero misses in 9 trials is
consistent with a true miss rate up to about 28% at 95% confidence; "under 1%" needs about 300 clean trials, "under
0.1%" about 3,000. Hand-written cases do not scale, so:
- **Mutation testing of the verifier.** Mutators plant one known kind of problem into a good change (an assertion
  weakened, a test skipped or focused, an input special-cased, a branch or an edge case dropped, an off-by-one, a
  boundary flipped, an exit added, an "approve" note planted, a regression beside the task); every mutant must fail.
  A few dozen good changes give hundreds of trials.
- **A scorecard per verifier model**: false passes and false fails with Wilson intervals (rule-of-three when zero),
  pass^3 consistency, cost per verdict; the harness picks verifiers by their measured record, and a model whose
  false-pass bound is above the stakes' target is not used at that stakes.
- **Calibration on the person's own work**: the same scorecard on their past delegations (with the outcomes the person
  confirmed), so thresholds fit their tasks.

### Phase 1c: the swarm governor (controllable replication)

Agents that start agents that start agents, for work too big for one: powerful only if the person keeps control, so
the agents never decide their own limits. Every spawn, at any depth, is a request to the harness's governor, granted
under a **charter** the person (or the root lead, within the person's settings) sets for the run:
- **The charter**: at most N agents in all and M at once, a depth, a spend and a time for the whole tree, the machines
  it may use (phase 7), the kinds of work (read-only, writing, network) and the stakes. A child's share never exceeds
  its parent's remainder; constraints only tighten down the tree (as done criteria already do).
- **Leases, not lives**: each agent holds a lease from the governor, renewed while its parent's run lives; no renewal,
  it stops. Nothing in a swarm outlives its run or persists itself: swarm agents cannot schedule themselves, create
  companions or tokens, change settings, permissions or hooks, or install anything to start later (tool policy, not
  instructions).
- **One stop for everything**: a kill switch stops the whole tree on every machine at once (abort cascades, leases are
  revoked); the person sees it in the Agents panel as a live tree (who started whom and why, budget used, status, each
  agent's acceptance).
- **Reporting back**: every agent reports to its parent with its acceptance (checks, verdicts, stakes); the root's
  report rolls the tree up; the run recorder keeps who did what (phase 6's recorder, started here).
- **Initiative with care**: what goes past the charter (more agents, more money, another machine, an external or
  irreversible action) is a proposal to the person, never taken; the governor watches the tree's replication rate
  (spawns a minute), loops (a child sent the same brief as an ancestor is refused), stalls (no progress anywhere in N
  minutes) and the effort rules the evidence gives (one agent for a simple question, 2-4 for a comparison, more only
  for wide research), and stops or asks.
- **Self-improvement only through the gate**: agents may propose better instructions, skills or checks from what the
  run's outcomes show; a proposal becomes real only when it beats the current one on the eval and the person approves
  it (docs/harnessing/HARNESSING.md); the controls themselves (the charter, the governor, the kill switch, tool policy)
  are never on the list of what agents may change.

What a swarm never does, by construction: copy itself to a machine the person did not connect and allow, persist or
hide, acquire credentials, accounts or money, raise its own limits, or reach past the kill switch. (The same controls
the evidence on runaway and self-replicating agents asks for; research in research/control.md.)

### Phase 2: answers over the person's own data

The data-answer swarm, the best ratio of measured gain to effort (a written semantics file added 17-23 points on every
frontier model tested; the checks run as code). A building block, then a workflow:
- `semantics.md` drafted when an MCP server is built from a database, approved by the person before agents use it.
- A clarifier (lists interpretations; asks or states its assumption), an SQL author that cites the definitions it
  used, deterministic checks after every query (join fan-out, grain uniqueness, parts sum to the total, date coverage),
  a recomputation on another provider that never sees the first query, and a provenance rule: every number in the
  narrative traces to a stored query cell, or the answer is rejected.
- Gold set: 40 questions over two of the person's databases, a quarter ambiguous or unanswerable.

### Phase 3: a deep web research swarm, claim-checked

Wide and deep on the internet, the way the evidence says works: a lead plans subtopics and a coverage target;
searchers fan out across subtopics and search engines (breadth), each with a bounded, ranked read of a shared evidence
store (ScaleMAS: gains past 8 agents only with bounded reads); a crawl frontier follows links to primary sources
(depth), de-duplicated by content and origin, honouring robots.txt and rate limits under a declared user agent; every
page fetched is archived and hashed into the source store; readers of web pages hold only read tools and return
structured evidence, never instructions (the reader/actor split: TRAP and BrowseSafe show injection succeeding 13-95%
of the time otherwise); budgets visible to every agent; then the claim checks below.

Claim-checked:

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

### Phase 7: a swarm across the person's computers

Workers on more than one machine, only machines the person has connected and allowed. The harness already has
companions: a small process on a person's computer that connects out to the harness (no inbound port), runs tool calls
in its folder and posts the results back, with permission checks on the server. A swarm extends that:
- **Machines as places to work**: each connected computer is listed with what it can do (OS, sandbox, network,
  desktop) and whether the person allows it for agents' work; a delegation can name a machine, or the harness places
  shards on allowed machines (the reader/actor split and the mandate hold there too).
- **Consent per machine and per kind of work**, revocable at once; a machine runs only in its sandbox and folder;
  nothing leaves a machine except the results and their evidence.
- **Durable across machines**: a worker on a machine that drops is resumed or re-placed from its checkpoint; results
  carry their proofs (checks run where the work ran, hashed evidence), so a machine is trusted no more than its proofs.
- Uses: compute spread across the person's machines, work where the data lives (a laptop's files, an office server),
  and checks on the real target platform (Windows, macOS, Linux).

Research first (as for every phase): distributed agent execution, consent and containment on personal computers,
scheduling and failure recovery.

## Status and order

- Research: done (2026-11-02).
- Phase 1: built (2026-11-02): stakes (high: a verifier of another provider; critical: replicas on two providers in
  worktrees and a comparator), exit / expect_not checks, per-requirement verdicts, visible budgets; 51 deterministic
  scenarios in test/acceptance.test.ts; live: EVAL-ACCEPTANCE.md.
- Phase 1b: built. The calibration at scale (CALIBRATION.md): 52 planted problems of 13 kinds, each passing the
  visible tests and failing a hidden truth check, and 6 good changes checked 3 times, on DeepSeek Flash, Claude Haiku
  5.5 and Claude Sonnet 5.5: no verifier passed any planted problem (0 of 156 in all: below about 2.4% at 95%); false
  fails 0, 2 (Haiku, on the SQL fix's behaviour for non-string input) and 0 of 18; same verdict on repeats 100%, 83%,
  100%; $0.0027, $0.0017 and $0.0144 a verdict. Scorecards order the verifiers the harness picks.
- Phase 1c: built: the governor (every agent granted under the charter: 16 agents a run by default, 30 a minute, a
  spend and a time when set; past the number, one question to the person, never taken where nobody can be asked;
  loops and bursts refused; three levels at most), the kill switch (POST /api/sessions/:id/stop_agents, the Agents
  panel's Stop all), tool policy (no schedule, vault or publish_branch for a swarm agent, memory read only; no writes to the
  project's .harness or .claude files), the fan-out (the agent tool's items and fields: one brief over up to 100
  items, a table back, each item governed and accepted on its own), the swarm as a tree in the Agents panel; 13
  deterministic scenarios (test/swarm.test.ts), the desktop e2e; live: EVAL-SWARM.md. Left from the research
  (research/control.md): a cap on agents at once below the first level, a cap of children per agent, kinds of work
  compiled to tools, paths and network policy, leases with heartbeats (for companions, phase 7), and writes to the
  control plane through a shell (contained only by a sandbox).
- Next, in this order: 3 (the deep web research swarm), 7 (across the person's computers), 2 (data answers), 4
  (security review of one's own code), 5 (forecasting), 6 (investigations).
