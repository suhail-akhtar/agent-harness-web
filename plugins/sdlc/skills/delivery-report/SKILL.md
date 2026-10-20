---
name: delivery-report
description: Format for docs/delivery-report.md - what was delivered, requirement-to-test traceability, quality gate results, reviews, and known limitations. Use at the end of a delivery.
---
# docs/delivery-report.md

```
# Delivery report - <name>

## Summary
Two or three sentences: what was built and its state.

## Traceability
| Requirement | Implemented in | Verified by |
|---|---|---|
| REQ-1 ... | path/file.ext | test name(s) in path/test.ext |

## Quality gates
The gate results (copy the PASS/FAIL lines).

## Reviews
Code review and security review verdicts, and how each BLOCKING/MAJOR finding was resolved.

## How to run
The exact commands (install, test, start) - each one confirmed to work.

## Known limitations and next steps
Honest list.
```

Every requirement ID from docs/requirements.md must have a row. If one is not verified by a test, say so in the row - never invent a test name.
