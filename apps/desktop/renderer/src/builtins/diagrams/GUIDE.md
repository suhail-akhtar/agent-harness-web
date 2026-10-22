---
name: core.diagrams-guide
description: Interactive architecture, deployment, ER, code and flow diagrams from one JSON spec, explored and edited on a canvas.
---

# Diagrams (core.diagrams)

## What it is for

Pictures of systems the person will look at and change: architecture (context, container,
component), deployment (hosts, zones, subnets), data (ER tables with keys), code dependencies, and
flows played step by step. Use it when the person asks for an architecture, a deployment picture,
an ER diagram, a request flow, or "show me how this codebase is organised".

## How to make one

1. Load the `diagrams` skill for the exact spec (views, node kinds, groups, edges, flows, layout).
2. Prefer an **artifact**: `artifact {"action":"create","title":"...","kind":"diagram","content":"<the JSON>"}`.
   It is versioned: an update draws in place and marks what changed; positions the person dragged
   are kept between versions. A ```diagram block is for a quick throwaway picture only.
3. The spec is checked when saved; an error names the exact problem: fix it and save again.
4. Show it: `desktop_open {"target":"artifact","id":"<artifact id>"}`; "Open interactive" in the
   panel opens the canvas page (`core.diagrams:diagram` with params `{"session":..., "artifact":...}`).

## The canvas

Pan, zoom, fit, minimap, Overview and Neighbourhood, search, collapsible groups, details in the
side panel (`core.diagrams:details`), flows played step by step, export to SVG and PNG. The person
can drag boxes (saved as a new version) and ask you for a change from the canvas: the request
arrives in this conversation with the artifact's id and version; update that artifact.

## The code map

`desktop_command {"command":"core.diagrams:code-map"}` (or `/codemap` typed by the person) draws
the workspace of the conversation on screen by folder, from its TS/JS/Python imports (read-only).

## Worked examples

**"Draw our deployment: web and API in a DMZ, Postgres in a private subnet"**: load `diagrams`,
write a `view: "deployment"` spec with zone groups and nodes, `artifact create kind diagram`,
open it with desktop_open.

**"Add a Redis cache between the API and the database"** (from the canvas): `artifact update` the
same id (add the node and two edges); the canvas shows the new version with the changes marked.
<!-- generated -->
