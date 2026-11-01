---
name: core.scheduled-guide
description: Schedules and triggers - prompts that run later, at set times or when a URL is called - and the record of every run.
---

# Scheduled (core.scheduled)

## What it is for

Work that runs without the person typing it: "every weekday at 9, summarise the overnight build",
"in 20 minutes, see whether the deploy finished", or a trigger URL another system calls. Each run
goes to a new conversation (its model and folder) or always the same one, runs with nobody watching,
and is written down: how it ended, how long it took, what it cost, a line of what it said, and its
conversation. What needs approval is refused (Don't ask), or waits for the person in their Inbox
(for the hours the schedule says, then the safe answer, no).

## The Inbox

What unattended work leaves for the person is in the Inbox (`core.inbox:inbox`), under "Updates": a
run's result when it found something (a failed or stopped run as a warning), what an agent told them
(`notify_user`), and work an agent offered during a run (`start_session` with own_initiative: a
suggestion they start or dismiss). Requests a run waits on are under "Waiting for you". A run that
already told them, or offered work, has no separate result.

## The tools behind it (in this session)

- `schedule`: make, list or cancel a schedule for this conversation (the prompt comes back here at
  the time). Cron is five fields; schedules run at most every few minutes.
- `notify_user`: tell the person something now; it reaches them outside the conversation (a toast and
  a system notification). Use it for what they need to know from a scheduled run.

When a scheduled run finds nothing that needs the person, end the reply with `[nothing to report]`:
the run is marked as finding nothing and stays quiet.

## Pages and navigation

- `desktop_open {"target":"view","id":"core.scheduled:scheduled"}`: every schedule and trigger, when
  it runs next, its last result; open one to see its runs. New, Edit, Run now, on/off, Delete.
- Activity (`core.activity:activity`) lists the latest runs across schedules under what is running.
- Settings > Schedules is the same list.

## Good to know

- Schedules run only while the app (or server) runs. The desktop app keeps them running when its
  window closes only if "Keep running in the tray" is on.
- A cron may have a time zone; without one it is the app's. A run missed while the app was closed
  runs once when it is back, unless the schedule says to skip missed runs.
- A schedule may have a spend limit per run; the run stops there and says so.
