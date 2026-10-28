---
name: architecture-decision-records
description: How to record architecture decisions as ADRs in docs/adr/. Use when choosing a stack, a storage model, an API style or any decision that is costly to reverse.
---
# ADRs

One file per decision: `docs/adr/NNNN-short-title.md` (0001, 0002, ...).

```
# NNNN. <Decision title>

Status: Accepted
Date: <YYYY-MM-DD>

## Context
The forces at play: requirements (cite REQ/NFR IDs), constraints, what exists already.

## Decision
What we will do, in one or two sentences, then the specifics.

## Alternatives considered
- <option>: why not.

## Consequences
What becomes easier, what becomes harder, risks and how they are mitigated.
```

Write an ADR for: language/runtime and framework, persistence, API style and error format, and anything a reviewer would ask "why?" about. Keep each under a page.
