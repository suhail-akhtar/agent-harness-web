---
name: ci-debugging
description: Debugging failing GitHub Actions runs - finding the failing step and its error with the ci tool, telling code failures from environment and flaky ones, reproducing the job's steps locally (ci run-local), fixing the cause, linting workflows with actionlint, and watching the re-run. Use when a CI run fails or a workflow is being written.
---
# CI debugging (GitHub Actions)

## Find the failure
1. `ci {"action": "runs", "branch": "main", "status": "failure"}` - the newest failing runs.
2. `ci {"action": "logs", "runId": N}` - the jobs, the step that failed, and its log trimmed to the error (from the step's start to the first `##[error]`). Read the first error, not the last: later errors are usually consequences.
3. Classify before fixing:
   - **Code**: a test assertion, a type or lint error, a build error with a file and line. Fix the code (or the test, only if the test is wrong - say so).
   - **Workflow**: a YAML or expression error, an unknown action input, a wrong `runs-on`, a missing `permissions:`, a step that assumes a tool the runner lacks. `ci {"action": "lint"}` (actionlint) catches most of these; fix the workflow.
   - **Environment**: a dependency or registry outage, rate limits, a runner image change (tool version moved), a secret missing in a fork's run. Pin versions (`node-version: 22.x`, action SHAs), add caching, or report it - do not "fix" code for it.
   - **Flaky**: passes on re-run without a change (timing, ordering, network in tests). `rerun-failed` once to confirm, then fix the flakiness (deterministic waits, isolated test data) rather than re-running until green.
4. Look at what changed: the run's commit vs the last green run (git log between the SHAs).

## Reproduce locally before pushing
- `ci {"action": "run-local", "workflow": "ci.yml", "job": "test"}` runs the job's `run:` steps here, in order, with the workflow/job/step env and the first matrix entry, stopping at the first failure - the same commands CI runs. `uses:` steps are skipped (the sandbox's toolchain stands in for setup-node and friends), and so are steps that need secrets.
- Iterate until run-local passes, then `ci lint` and the quality gates.

## Push and watch
- Push with `publish_branch` (a branch and pull request; never to the default branch directly).
- `ci {"action": "watch", "branch": "<branch>", "sha": "<commit>"}` waits for the run and shows the failing logs if it fails again.

## Writing workflows well
```yaml
name: ci
on: { push: { branches: [main] }, pull_request: {} }
permissions: { contents: read }            # least privilege; widen per job only
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<full sha>   # pin third-party actions to a commit SHA
      - uses: actions/setup-node@<full sha>
        with: { node-version: 22.x, cache: npm }
      - run: npm ci
      - run: npm test
```
- Every expression must reference something that exists: `${{ matrix.node }}` needs a `strategy.matrix.node`; actionlint reports undefined properties.
- Secrets only where needed, never echoed; `pull_request_target` never checks out and runs the PR's code with secrets.
- Shell in `run:` is checked by shellcheck through actionlint: quote variables.
