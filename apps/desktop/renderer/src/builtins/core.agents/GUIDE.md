---
name: core.agents-guide
description: Sub-agents, background tasks, linked sessions and proposals, live with Stop; the Library of what agents made.
---

# Agents (core.agents)

## What it is for

Showing the person, live, everything agents do on their behalf, and letting them steer it: the
sub-agents a conversation runs, its background tasks (shells, workflows), linked sessions it
started or proposed (each its own conversation, reporting back), with cost per model and Stop.
Use this guide when the person asks what is running, wants work split across agents or run beside
the current conversation, asks to see or stop agents, or to find something an agent made.

## The tools behind it (in this session)

- `agent`: run a sub-agent (explore, a general worker, or a named agent) in its own context; it
  shows in the Agents panel next to the conversation while it runs.
- `start_session`: propose a linked session (a card the person starts or dismisses) or start one.
  `list_sessions`, `send_message` (to a linked session), `hand_off` (move the remaining work into a
  session of its own), `dismiss_proposal`.
- `mark_chapter`: a chapter in the conversation's table of contents (long work reads better).
- `workflow`: run a workflow (its graph shows in the transcript, node by node).
- The Library: artifacts (`artifact` tool) are listed across conversations; see core.artifacts.

## Pages and navigation

- Home: `desktop_open {"target":"view","id":"core.agents"}`: agents at work, proposals waiting,
  what agents made lately, ways to start.
- Working now: `core.agents:agents` (every conversation at work, sub-agents, linked sessions under
  the one that started them, proposals, Stop all).
- Library: `core.artifacts:library` (in this module's menu).
- The Agents panel next to a conversation: `desktop_open {"target":"panel","id":"core.agents:agents"}`
  (it opens on the conversation that asked).
- Split view: a linked conversation opens beside the current one from its card ("Beside").

## Worked examples

**"What is running right now?"**: `desktop_command {"command":"core.agents:page"}` shows the page;
answer from `list_sessions` (status, cost) rather than guessing.

**"Review this with a second model while you continue"**: `agent` with the reviewer's brief (and a
model the person's delegation setting allows), or `start_session` for a linked session that reports
back; tell the person where it shows (the Agents panel, or the card in the transcript).

**"Split this into three parallel pieces"**: plan, then three `agent` calls in one step; each shows
in the panel as it runs; bring the results together.

**"Stop everything"**: say that Stop all is on the Agents page, and open it; you cannot stop other
conversations yourself.
<!-- generated -->
