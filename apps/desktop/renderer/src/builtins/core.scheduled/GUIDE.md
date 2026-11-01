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

## Setting one up for the person

- When they ask for something regular ("every weekday at 9, summarise what changed here", "check the
  tests every hour and tell me when they fail"), set it up with the `schedule` tool:
  `{"action":"create","prompt":"<a complete instruction>","cron":"0 9 * * 1-5","new_conversation":true}`.
  `new_conversation` runs it each time in a new conversation like this one (this model and folder);
  without it the prompt comes back to this conversation. `time_zone` (IANA) if they name one;
  `asks: "inbox"` when it will need approval for commands (it waits in their Inbox, else it is refused);
  `workflow` and `input` to run a workflow instead of a prompt. Then `run_now` with its id to try it
  once, and tell them what it found and when it runs next.
- When they want something to happen when something changes ("tell me when the tests start failing",
  "review new commits", "watch the status page"), make a watch instead of a time: `"watch": {"kind":
  "command", "command": "npm test", "everyMinutes": 30, "onlyWhen": "a test fails"}` (kinds: `command`,
  `files` with `paths`, `git` with `branch`, `url` with `match`). It checks without a model and runs only
  when what it watches changes; `onlyWhen` lets a small model skip changes that do not matter.
- To let them check it before it exists, open the dialog filled in instead:
  `desktop_command {"command":"core.scheduled:new","args":{"title":"…","prompt":"…","cron":"0 9 * * 1-5","asks":"dontAsk"}}`.
- Write the prompt as a complete instruction for a run nobody watches: what to look at, what counts as
  worth telling them (with `notify_user`), and to end with `[nothing to report]` otherwise.
- `notify_user`: tell the person something now; it reaches them outside the conversation (a toast, a
  system notification, an Inbox update).

## Pages and navigation

- `desktop_open {"target":"view","id":"core.scheduled:scheduled"}`: every schedule and trigger, when
  it runs next, its last result; open one to see its runs. New, Edit, Run now, on/off, Delete.
- Activity (`core.activity:activity`) lists the latest runs across schedules under what is running.
- Settings > Schedules is the same list.

## When it interrupts the person

Every update lands in their Inbox. Whether it also interrupts them is theirs to set: each schedule's
"Tell me" (every time, only when it matters, in their daily digest, or not at all) and their quiet hours,
daily most and digest time (Inbox > Updates > Interruptions). Respect it: do not use `notify_user` to tell
them what a run found when it is routine; end with `[nothing to report]` when nothing needs them.

## Good to know

- Schedules run only while the app (or server) runs. The desktop app keeps them running when its
  window closes only if "Keep running in the tray" is on.
- A cron may have a time zone; without one it is the app's. A run missed while the app was closed
  runs once when it is back, unless the schedule says to skip missed runs.
- A schedule may have a spend limit per run; the run stops there and says so.

## Noticing (what the harness notices by itself)

Without anything set up, the harness notices a few things in the person's work and leaves them in the
Inbox as "Noticed" updates: a long conversation that stopped on an error or a limit while nobody had it
open, a schedule that keeps failing (or being skipped, or hitting its spend limit) or a watch that cannot
check, the same command failing the same way three times (a line by that conversation's message box), and
a task they asked for on three different days (it offers a schedule in their own words). No model watches:
it counts fingerprints, never the text. It starts in practice (written down, not shown) until the person
turns it on; they choose off, practice or on, and each detector, in the Noticing panel (the eye in Inbox >
Updates). If they ask why they saw something, or how to make it quieter, point them there: dismissing a
finding as "not useful" mutes that kind in that folder, "wrong" mutes that finding for good.
