# Proactive work: plan and status

Why and what: [RESEARCH.md](RESEARCH.md) (the evidence, products, design patterns and an inventory of
the harness; the notes behind it are in [research/](research)). In short: proactivity the person
authors (schedules, triggers, watches) with every run written down and a queue the person owns,
not an assistant that interrupts on its own judgement.

| Phase | What | Status |
|---|---|---|
| 0 | The desktop's schedule form makes schedules (it sent no target); unattended runs respect the daily spend limit; `notify_user` reaches the person (toast and system notification); the tray note | Done |
| 1 | A record of every run (status, times, cost, summary, tool calls and actions, told the person, nothing to report, its conversation); the Scheduled page, run history, Activity's recent runs; edit; time zones (daylight saving handled); missed runs run once or are skipped; at most one run every 5 minutes; a spend limit per run; runs cut off by a shutdown are interrupted | Done |
| 2 | The agent inbox: results, messages and suggestions in one queue (read, snooze, dismiss with a reason; every response logged); unattended runs park what needs approval in the Inbox instead of refusing it (digests come with phase 4) | Done |
| 2b | Easy setup: the schedule dialog (templates, plain timing with a preview of the next runs, a prompt or a workflow, where, approvals), the Scheduled page in plain words, agents setting routines up (schedule tool: new_conversation, asks, time_zone, workflow, run_now) or proposing them (core.scheduled:new); schedules that run workflows | Done |
| 3 | A core watch primitive (a check without a model, the model only on change), a durable event log with dedup, debounce and batching, file, git and CI sources, declarative automations; untrusted input never reaches a run that holds both sensitive tools and a way out | |
| 4 | An initiative policy per automation and action class (silent, notify, question, review, act), an interruption budget, quiet hours and digests; acceptance rates from the person's responses; "act" only on the person's say-so | |
| 5 | Optional: suggestions inside a conversation, only if the data from phase 4 supports them | |

## Conventions

- A scheduled run's prompt says nobody is watching; an agent that finds nothing ends its reply with
  `[nothing to report]` (the run is marked so and stays quiet).
- Run records: `<data>/schedule-runs.jsonl` (one line per change of a run, newest kept), API
  `GET /api/schedules/:id/runs`, `GET /api/schedule-runs`; events on the `schedules` topic (`fired`
  when a run starts, `ended` with its record).
- Tests: `test/schedule-delivery.test.ts`, `test/schedule-runs.test.ts` (engine and API) and
  `test/desktop-e2e-proactive.test.ts` (the real desktop app on a scripted engine).
