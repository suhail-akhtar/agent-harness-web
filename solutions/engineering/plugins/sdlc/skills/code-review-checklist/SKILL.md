---
name: code-review-checklist
description: Checklist and severity scale for code reviews. Use when reviewing a change.
---
# Code review

Severity
- **BLOCKING** - wrong behaviour against a requirement, data loss, security hole, crash on valid input, tests that do not test what they claim.
- **MAJOR** - missing tests for a requirement or error case, unhandled error paths, likely bugs on edge cases, serious maintainability problems.
- **MINOR** - naming, style, small simplifications. Never request changes for MINOR only.

Check, in order
1. Every REQ and AC in docs/requirements.md is implemented and has a test that would fail without it.
2. Edge cases: empty/missing input, wrong types, boundaries, duplicates, not-found, concurrency.
3. Errors: correct status codes or exceptions, no internal details leaked, nothing swallowed silently.
4. Security: input validated at boundaries, size limits, no injection paths, no secrets.
5. Tests pass and are meaningful (run them).
6. Readability: clear names, no dead code, comments only where the why is not obvious.

Finding format: `- [SEVERITY] path:line - problem. Fix: ...`
