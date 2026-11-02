# Security review of the person's own code, live (phase 4)

`scripts/live-security.mjs`, 2026-11-02. Raw results, the findings and the report:
[EVAL-SECURITY.json](EVAL-SECURITY.json).

## Setup

A small Node app with three real flaws and two decoys that look like them but are safe:

- **The flaws**: a path traversal in `src/files.mjs`, a SQL injection in `src/search.mjs`, and a command injection
  in `src/ping.mjs`.
- **The decoys**: a guarded file server in `src/assets.mjs`, and a parameterized query in `src/lookup.mjs`.
- **The mandate**: the person's covers `src/**` for today.
- **Models**: the review runs the `security-review` workflow on Claude Haiku 5.5. The fixes run in a second
  conversation on Claude Sonnet 5.5.
- **Grading**: from the harness's own ledger of reproducer runs, the code, and probes of our own, never from what
  the agents said.

## Final run: 12 of 12, $0.12

**Review (Haiku, 1 minute, $0.009)**:

- **Four findings confirmed by reproducers the harness ran.** The three planted flaws, plus a hard-coded admin token
  in `src/db.mjs`: the seed data really is in the source, a legitimate finding we had not planted as one.
- **No decoy confirmed.**
- **The report held to the ledger**, including the plan's coverage, and the workflow succeeded.
- **The code under review was untouched.**

**Fixes (Sonnet, 0.6 minutes, $0.12)**:

- **All four fixed.** Each reproducer no longer fires, and the tests pass.
- **The decoys were left as they were.**
- **Our own probes**, not the agents', confirm the three flaws are closed: the traversal no longer reads the secrets
  file, the injection no longer reaches the admin token, and the command injection no longer runs a command.

## What the runs before it found (and what was fixed)

- **Re-confirming after a fix erased a finding.** After patching the SQL injection, the fixing agent ran
  `confirm_finding` on it again. The reproducer no longer fired, and that overwrote "confirmed", so the finding
  vanished from the ledger. A finding confirmed once now stays confirmed: confirming it again points to `check_fix`.
- **A review that looked at nothing succeeded.** A workflow's agents work at depth 1, where by default they cannot
  start agents, so the lead could not send hunters. It reviewed nothing and the report said "none". Two fixes:
  - the lead now reviews the files itself, fanning out only where it can start agents;
  - the gate requires a plan listing every file in scope, and every file of the plan in the report.
- **The first run's review skipped the workflow**: asked for "a security review", Haiku did the review with the
  tools directly. The eval now asks for the workflow by name, as the other evals do.
