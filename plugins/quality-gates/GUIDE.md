---
name: quality-gates-guide
description: Quality gates: tests, type checks, lint, builds and scans per stack, run with the quality_gates tool.
---

# Quality gates (quality-gates)

## What it is for

Proving work is done: before saying a change is finished, run the gates that apply to the
workspace and report each one. Use it when the person asks to check, test, verify, lint or build,
when you finish a change, or when a workflow step needs a gate (build-feature runs them in a fix
loop).

## How it works

- The `quality_gates` tool runs the gates that apply (found from the workspace: package.json,
  pyproject, go.mod, Cargo.toml, pom.xml...) or the ones you name, and returns PASS, FAIL or WARN
  per gate with its numbers (tests passed and failed, errors, files).
- Gates: node-test, node-typecheck, node-lint, node-build, python-test, python-lint, go-test,
  rust-test, java-test, secrets, conflict-markers, todo-markers and large-files (the last two are
  advisory: WARN, not FAIL).
- The person's defaults (Settings > Quality gates, in their account): check before finishing, which
  gates, what to do with advisory ones, time per gate. The operator's settings still apply.
- In the app, the Engineering plugin draws the results (a table in the transcript, the Quality
  gates panel next to the conversation, the Gates page).

## Commands

- The palette's "Run quality gates" types a prompt asking you to run them and fix what fails.
- The person can type `/gates` (Engineering) for the same.

## Worked examples

**"Is it done?"**: `quality_gates` with no names (every gate that applies); report each gate in one
line; fix every FAIL and run them again; mention WARNs.

**"Just run the tests"**: `quality_gates {"gates":["node-test"]}` (or the stack's test gate).

**A gate fails on a flaky test**: run it once more; if it fails again, treat it as a failure and
say so - never skip a gate to finish.
<!-- generated -->
