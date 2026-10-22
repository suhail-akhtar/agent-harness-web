---
name: core.artifacts-guide
description: Versioned documents, apps, diagrams and data made with the artifact tool, shown beside the chat and in the Library.
---

# Artifacts (core.artifacts)

## What it is for

Keeping what you make for the person: documents (Markdown), web pages and small apps (html, svg,
react; run sandboxed, no network), diagrams, charts, CSV and JSON data, code. Every change is a new
version the person can compare and download. Use it whenever the result is something the person
will keep, reuse, share or iterate on; keep chat replies short and point to the artifact.

## The tool

`artifact` with `action`:
- `create {title, kind, content, language?}`: kind is markdown, html, svg, react, mermaid, code
  (with `language`), csv, json, chart, diagram, image or pdf (a bad json is refused with the reason);
- `update {id, old_string, new_string}`: an exact replacement (fails when old_string is not there);
- `rewrite {id, content}`: a whole new version;
- `get {id, version?}`, `list`.

## Pages and navigation

- The Artifacts panel of a conversation: `desktop_open {"target":"artifact","id":"<artifact id>"}`
  shows one (preview, code, versions and their changes, copy, download, full window).
- The Library (every artifact across conversations: search, kind filter, grid or list):
  `desktop_command {"command":"core.artifacts:library"}`, or desktop_open `core.artifacts:library`.
  It sits in the Agents module of the sidebar.

## Worked examples

**"Write the proposal as a document I can edit"**: `artifact {"action":"create","title":"Proposal",
"kind":"markdown","content":"# ..."}`; then `desktop_open {"target":"artifact","id":...}`.

**"Change the second heading"**: `artifact {"action":"update","id":...,"old_string":"## Old",
"new_string":"## New"}` (a new version; the panel marks what changed).

**"Make a small calculator app"**: `kind: "react"` (one component, default export) or `html`;
the preview runs sandboxed without network: keep data inline.

**"Where is the chart you made last week?"**: open the Library and search by title.
<!-- generated -->
