---
name: requirements-spec
description: Format and rules for docs/requirements.md - numbered, testable requirements with acceptance criteria. Use when writing or updating requirements.
---
# docs/requirements.md

```
# <Product or feature name> - Requirements

## Goal
One paragraph: who it is for and what problem it solves.

## Functional requirements
- **REQ-1** <one capability, stated as observable behaviour>
  - AC-1.1 Given <context>, when <action>, then <observable result>.
  - AC-1.2 ...
- **REQ-2** ...

## Non-functional requirements
- **NFR-1** <performance / security / reliability / usability, with a measurable threshold>

## Interfaces
Inputs, outputs, endpoints or commands the user sees (names only; the architect designs the details).

## Assumptions
- <every gap you filled, so it can be challenged>

## Out of scope
- <related things deliberately not built>
```

Rules
- One behaviour per requirement; IDs never reused or renumbered.
- Every acceptance criterion must be checkable by an automated test. Avoid "fast", "easy", "user-friendly" without a number or an observable check.
- Cover error cases: invalid input, missing records, limits.
- Security basics are requirements, not afterthoughts: input validation, limits, no secrets in code.
