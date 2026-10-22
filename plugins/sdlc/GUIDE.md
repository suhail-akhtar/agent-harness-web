---
name: sdlc-guide
description: Engineering: features from request to reviewed delivery (build-feature workflow, role agents), a Delivery board, gates.
---

# Engineering (sdlc)

## What it is for

Building software the way a team would: requirements, an architecture decision record, a plan,
test-first implementation, the quality gates, code and security reviews, docs and a delivery
report. Use it when the person asks to build a feature or a change of some size, to review changes
against requirements, to run the quality gates, or to see how a feature is going. For a one-line
fix, just do it; for a feature, use the workflow.

## How work runs

- **build-feature** (workflow): requirements (analyst) -> design and ADR (architect) -> optional
  design approval -> plan (planner) -> test-first build (engineer) -> quality gates (fix loop) ->
  code and security reviews -> docs (tech writer) -> delivery report. `long-task` is the variant for
  work that spans many sessions.
- **Role agents** (`agent` tool): analyst, architect, planner, engineer, code-reviewer,
  security-reviewer, tech-writer, initializer.
- **Quality gates** (`quality_gates` tool, from the quality-gates plugin): tests, type checks, lint,
  builds, secrets, conflict markers; each PASS, FAIL or WARN with its numbers.
- **Skills**: requirements-spec, architecture-decision-records, test-driven-development,
  code-review-checklist, delivery-report (load the one the step needs).
- The person's defaults (Settings > Engineering): design approval, stack, review strictness, the
  roles' models (a model other than the conversation's is a delegation).

## Pages and navigation

- Home: `desktop_open {"target":"view","id":"sdlc"}`: features in flight, failing gates, recent
  deliveries, quick actions.
- Delivery board: `sdlc:delivery` (features by stage: requirement, design, plan, build, gates,
  review, delivered); one feature: params `{"id": "<delivery id>"}`.
- Start a feature: `sdlc:start-feature` (a form; params `{"request": "..."}` fills it in).
- Gates: `sdlc:quality` (every feature's gates, failing first).
- Quality gates panel next to a conversation: `desktop_open {"target":"panel","id":"sdlc:gates"}`.

## Commands you may run

- `desktop_command {"command":"sdlc:start-feature","args":{"request":"..."}}` opens the form with
  the request filled in; the person reviews and starts it (you never start a delivery unasked).
- `desktop_command {"command":"sdlc:run-gates"}` opens the Quality gates panel next to this
  conversation (run the gates themselves with `quality_gates`).
- `desktop_command {"command":"sdlc:open-delivery","args":{"id":"..."}}` shows the board, or one
  feature.

## Worked examples

**"Build a slugify function with tests"**: if the person wants the full process, open the form with
`sdlc:start-feature` and their request; or, asked to just do it here, follow
test-driven-development, then `quality_gates`, and report each gate.

**"How is the login feature going?"**: open `sdlc:delivery` with its id (or the board) and summarise
the stage, the gates (pass/fail counts and the failing names) and the cost.

**"Review my changes"**: the person can type `/review`; or do it: read the diff, run the tests, list
findings as BLOCKING, MAJOR or MINOR with file:line, then APPROVE or REQUEST_CHANGES.
<!-- generated -->
