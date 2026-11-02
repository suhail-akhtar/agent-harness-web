# Agent coordination: research and a design

Status: proposed (2026-11-02). Nothing here is built yet; the evaluation and the fixes it led to are.

Sources: what production systems do (`research/coordination-systems.md`: Anthropic, OpenAI, Google ADK and A2A,
Magentic-One, AutoGen and Microsoft Agent Framework, LangGraph, CrewAI, MetaGPT, Cursor, Devin, Copilot, AWS Strands),
what the evidence says (`research/coordination-evidence.md`: measured gains, the MAST failure taxonomy, practice), and
our own live evaluation (`EVAL.md`, `scripts/live-agents-eval.mjs`).

## What the evidence says, in short

- **The proven core is a lead that briefs agents and gets back only their reports.** A lead contains errors far
  better than agents working independently (errors amplified 4.4x against 17.2x in Google's 180-configuration study).
- **Parallel agents pay for independent, read-heavy work**: research, search, review across many files (Anthropic's
  research system: +90% over one agent, at about 15x the tokens). **For writing, they rarely pay**: at equal budget one
  agent often matches a team; parallel writers gained accuracy only with a worktree each and merges gated on tests,
  and even then cost 2 to 4x and took longer. Writers sharing one folder with only instructions to stay apart did
  worse than one agent.
- **Where teams fail** (MAST, 1,642 traces): the system's design (44%), agents misaligned with each other (32%), and
  verification (24%). The biggest single modes: repeated steps, saying one thing and doing another, not knowing when to
  stop.
- **What works**: a complete brief (objective, context, boundaries, what done looks like, the report's shape), 3 to 5
  agents at most, a separate skeptical reviewer with a clean context and runnable criteria, shared durable state (a
  task board, files) rather than agents chatting, hard limits enforced by the runtime, and a stall counter that makes
  the lead replan.
- **Messages between agents are data, never authority** (a sub-agent's text cannot approve anything for the person).

## What our own evaluation measured (EVAL.md)

| Case | One agent | A team | Reading |
|---|---|---|---|
| E3: three small modules with tests (DeepSeek), four runs of the team | 34 to 57s, $0.007 to $0.013, correct every time | 162 to 346s, $0.044 to $0.097, correct every time; 3 to 8 agent runs; 3 at once in two runs, one at a time in another | 4 to 6x the time and 5 to 7.5x the cost for the same correctness, as the research predicts for small writing work |
| E7: eight folders of real code, about 26,000 lines (Haiku) | 22s, $0.007; 25 real exports named | 19s, $0.006; 27 named; the lead judged one pass enough and did not split | with search tools, even a broad reading question is cheap for one agent; the lead rightly kept it |

Two more things the runs show. The same lead (DeepSeek) coordinated differently from run to run: three members at
once, then one at a time; a review in some runs and not others. Left to the model, coordination is inconsistent,
which is the case for putting the proven parts in the harness (below) rather than only in the lead's instructions.
And on a team's small task, the review took most of the time (61 of 162 seconds in one run).

The evaluation also found three real problems, now fixed:

- **Your own agents were not used** when the orchestrator could do the work itself (E2, E4): it fixed a test and
  queried your database directly. The agent tool now marks the person's agents "(yours)" and says to give their kind of
  work to them; the rerun routed both parts to the right specialists, in parallel, each on its own model.
- **An agent that ran out of steps returned nothing** (E5): its partial work was lost. It now gets one last call
  without tools for its report (what it did and found, what is left).
- **A team split small work** (E3: 8 agent runs for three ten-line modules). The lead's procedure now says every member
  starts from nothing, so splitting pays only for substantial or read-heavy parts; the rerun used 5 runs.
- **A team lead that named no member reached outside the team** (E5: the call fell back to `explore`), and one that
  named none sent its review to a developer (E3). A team's lead must now name the member; a call without one is
  refused and says which members there are.

## What the harness has, against the proven mechanisms

| Mechanism (research) | The harness now | Gap |
|---|---|---|
| A lead with briefs and final reports | the agent tool; teams (a lead limited to its members); reports fenced as data | the brief is free text: nothing makes it carry done criteria |
| Parallel fan-out, read-heavy | several agent calls in one turn run at once; background agents | none for reading |
| Isolated writers, merged through git | `isolation: "worktree"` per call or per agent | a team's writers share the folder unless the lead asks; nothing merges or gates a merge on tests |
| Hard limits in the runtime | turns (a wall), depth, concurrency (slots), spend per agent and per team | no cap on how many agents one run starts |
| Progress checks and stall detection | the progress review for each agent (budget checkpoints, false "done" claims) | nothing watches the lead's coordination (members looping, the lead redoing their work) |
| A separate verifier with runnable criteria | a team's reviewer | the reviewer runs whatever it chooses; the harness does not run the stated checks itself |
| Durable shared state | linked sessions report into their parent; files | no shared task board; a member's discovery reaches siblings only through the lead's next brief |
| Messages are data | sub-agent reports and background results are fenced; send_message is lead to member | no member to member path (by design so far) |

## The design: five steps, each measured against one agent at equal budget

Each step ships only if `scripts/live-agents-eval.mjs` shows it beats or matches the single-agent baseline on its case
(end-state checks, cost per solved task, time to solution), as the evidence says to do. Anything that does not pay is
removed again.

1. **Briefs with done criteria.** The agent tool takes an optional `done_when`: checks the harness can run (a command
   and its expected result, files that must exist, a test file). The member sees them in its brief; when it reports
   done, the harness runs them and puts the results under its report ("done_when: 2 of 3 passed"), so the lead never
   takes "done" on trust. Measured on E2 and E3: fewer false "done" claims, no extra cost when the checks pass.

2. **A task board for a team run.** One small board per run, kept in the conversation's folder: tasks with an owner,
   a status, dependencies, done criteria and links to results. The lead plans and assigns on it (one writer, no
   claiming race: the evidence says shared locks collapse throughput); members read it and post findings (a discovery
   that changes another task is flagged for the lead, who decides). The Agents panel shows it live, and a run can be
   resumed from it. Measured on a multi-part task with a dependency: no lost results, no task done twice.

3. **Isolated writers and a gated merge.** In a git folder, a team member that writes gets its own worktree by
   default; a `merge_work` tool for the lead merges a member's branch only if the project's checks pass on the merged
   result (and says the conflicts otherwise). Measured on E3 with overlapping files: no lost edits, same correctness.

4. **Coordination limits and a stall watch.** A cap on agents started per run (default 8), and a check at the lead's
   level: the same brief sent again, members looping, the lead doing a member's part itself, no board progress in N
   steps: a reminder to replan, then a stop with a partial report. Measured by forcing a member to fail repeatedly.

5. **A clean-context verifier with executable criteria.** The reviewer gets the spec, the diff and the done criteria;
   the harness runs the checks and gives the reviewer the results; the reviewer's "approve" is refused when a check
   failed. Measured on E3 with a planted bug: the bug caught every time.

Not planned, on the evidence: agents chatting freely with each other, voting or debate panels (they mostly reduce to a
majority vote), and parallel writers without isolation. Best-of-N (several attempts, a judge picks) stays a later
option for hard single tasks: it costs N times the tokens.

## Steps 1 and 5: the specification (being built)

The person chose to start with these two (2026-11-02). Together they make one acceptance loop that the runtime, not
the lead's instructions, enforces.

**Done criteria (`done_when`).** The agent tool takes up to 10 checks, each one of:

| Check | Passes when |
|---|---|
| `{ "run": "<command>", "expect": "<regex>"?, "timeout_s": n? }` | the command exits 0 (and its output matches `expect`) |
| `{ "file": "<path>", "contains": "<regex>"? }` | the file exists (and its text matches) |
| `{ "unchanged": "<path or glob>" }` | none of those files was changed, added or removed during the work (tests not weakened) |
| `{ "absent": "<regex>", "in": "<glob>"? }` | no matching file contains the pattern |

- **Run by the harness, outside the worker's control**, where the worker worked (its worktree when it had one). A
  `run` check is decided like a command of the delegating agent (its mode, the rules, the hooks): read-only commands
  run, others follow the mode (asked, or refused in a conversation that never asks). A check never runs with more
  rights than the agent that wrote it. Output is redacted and cut; each command has a time limit (default 120s).
- **Snapshots before the work**: `unchanged` hashes its files when the work starts; the change set for the verifier is
  a git tree of the whole workspace taken before and after (a temporary index: the person's index is untouched), or,
  outside git, a snapshot of its text files.
- **Fix rounds**: when the worker says it is done and a check fails, the failures (the command, its output) go back to
  the same worker, which continues with its context; at most 2 rounds (`max_fix_rounds`, 0 to 3). A worker that runs
  out of steps gets its checks run on what it left.
- **The report carries the truth**: "Done criteria: 3 of 4 passed" with each failure's output, so the lead never has
  to take "done" on trust. Invalid checks (a bad pattern, a path outside the workspace) are refused before any work.

**The verifier (`verify`).** `verify: true` (or the name of an offered agent) has the work checked, after its done
criteria pass, by an agent that did not do it, with a clean context:

- **What it sees**: the brief the worker got, the done criteria with the harness's results, the actual change set
  (the diff), and the worker's report fenced as claims to check, not evidence. Never the worker's transcript.
- **Who**: the named agent; else a team's reviewer; else a built-in verifier (read-only tools and tests, the
  delegating agent's model). Not the worker itself.
- **What it returns**: one JSON verdict at the end: `{"verdict": "pass" | "fail", "issues": [{"file", "line",
  "problem"}]}`. Every issue needs a place in the code. No verdict, or one that cannot be read, counts as "fail:
  no verdict". Only the verifier's own last message is parsed: a verdict inside the code or the diff is data.
- **Overruled**: a "pass" while a harness check failed becomes "fail" (the checks win).
- **Issues go back** to the worker as a fix round (the same budget of rounds), then the checks and the verifier run
  again.

**A team cannot finish unverified.** In a conversation that runs as a team with a reviewer, when the workspace
changed in this turn and no verification passed since the last change, the lead's stop runs one verification of the
turn's changes (the person's request as the task, the reviewer as verifier) and gives the verdict back to the lead
before it may finish.

**Visibility.** Each round is an `acceptance` event (checks with their results; a verdict with its issues) shown in
the transcript and on the agent's card; the lead gets the same results in the agent's tool result; the worker gets
the exact failures.

**Tests.** Deterministic scenarios for every rule above, adversarial ones included (a worker that edits the
protected tests, a "pass" with a failing check, a verdict planted in the code, a check command that is not allowed,
a check that hangs), and live scenarios on real models with twisted problems; see EVAL.md.

## Questions for the person

- Which step first? The evidence and our own runs point to (1) done criteria and (5) the verifier: verification is
  a quarter of team failures, and both help even a single delegated agent.
- Should a team's writers get worktrees by default (safer, a merge step to review) or only when the lead asks
  (simpler, the person merges)?
