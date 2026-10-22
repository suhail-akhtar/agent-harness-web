---
name: core.chat-guide
description: Conversations in the app: the composer, the transcript and what it draws, the attention bar, search.
---

# Chat (core.chat)

## What it is for

The conversation the person is having with you, and the app around it: the home page with its
composer (a project folder or a scratch space to work in, model, effort, mode, composer chips),
the transcript (Markdown, code, math, charts, diagrams, tables, artifacts' cards, tool steps folded
under "Worked for"), the attention bar (permission requests, questions with forms, plans), search
across conversations. The core's other pages sit beside it in the sidebar: Inbox (everything
waiting for the person), Activity (what is running), Projects (folders), Plugins.

Use this guide when the person asks how to use the app itself: start a new chat, find an old
conversation, work in a folder, answer a request, what a drawn block is.

## How to act in the app

- A new chat with a prompt typed in (never sent for them):
  `desktop_command {"command":"core.chat:new","args":{"prompt":"..."}}`.
- Find a conversation: `desktop_open {"target":"view","id":"core.chat:search"}`; one conversation:
  `core.chat:session` with params `{"id": "<16 hex>"}`.
- Ask the person something with choices: the `ask_user` tool, with a JSON-Schema `form` for
  structured answers (it shows as a native form in the attention bar).
- Show a file of this conversation's workspace: `desktop_open {"target":"file","path":"src/a.ts"}`.
- A notification when long work ends: `desktop_notify {"title":"...","body":"..."}`.
- The Inbox (`core.inbox:inbox`), Activity (`core.activity:activity`), Projects
  (`core.projects:projects`) and Plugins (`core.plugins:plugins`) are pages to open with desktop_open.

## What the transcript draws (write these as fenced blocks)

`mermaid`, `chart` and `viz` (Vega-Lite or ECharts), `diagram` (see core.diagrams-guide), `csv`,
`json`, math with `$...$`, `smiles`, `pdb`, `plot`, `dot`, `dashboard`, `geojson`, and the biology
fences (load the rich-output skill for their formats). A drawn chart or table has "Add to
dashboard" (core.dashboards).

## Worked examples

**"Start a new chat about the release notes"**: `desktop_command {"command":"core.chat:new",
"args":{"prompt":"Draft the release notes for v2.3 from the merged PRs"}}`, then say it is typed in.

**"Where did we discuss the migration?"**: open search (`core.chat:search`) and tell the person to
type "migration"; you cannot read other conversations unless they are linked to this one.

**Slash commands the person can type**: `/new`, `/workflow`, `/plan <what>`, `/compact`, and
`/<skill>` for a skill; plugins add more (each plugin's guide lists its own).
<!-- generated -->
