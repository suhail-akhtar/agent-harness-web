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
| 3 | Watches: a check with no model (a command's output, files, commits, a web page or API) and a run only on a change, settled and batched, past an optional filter (a small model with no tools), what changed fenced as data in a conversation that counts as having read outside content; durable across restarts; Check now; for people and agents. (Not done: a general durable event log for plugins' events, MCP resource notifications) | Done |
| 4 | When updates may interrupt: a per-schedule "Tell me" (every time, only when it matters, digest, nothing), the person's quiet hours, daily most and digest time, one place that decides (src/core/initiative.ts) with the reason an update waited; usefulness per schedule from runs and responses (opened, dismissed and why, left unread, cost) and an offer to be quieter when mostly unwanted, never louder by itself | Done |
| 5 | Optional: suggestions inside a conversation, only if the data from phase 4 supports them (it now measures what that needs) | Not started (by design) |

## Conventions

- A scheduled run's prompt says nobody is watching; an agent that finds nothing ends its reply with
  `[nothing to report]` (the run is marked so and stays quiet).
- Run records: `<data>/schedule-runs.jsonl` (one line per change of a run, newest kept), API
  `GET /api/schedules/:id/runs`, `GET /api/schedule-runs`; events on the `schedules` topic (`fired`
  when a run starts, `ended` with its record).
- Tests: `test/schedule-delivery.test.ts`, `test/schedule-runs.test.ts` (engine and API) and
  `test/desktop-e2e-proactive.test.ts` (the real desktop app on a scripted engine).
