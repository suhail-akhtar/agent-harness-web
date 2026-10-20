---
name: test-driven-development
description: Test-first working method and test conventions. Use when implementing features or fixing bugs.
---
# Test-driven development

Loop for each task:
1. **Red** - write a test that states the next acceptance criterion; run it; watch it fail for the right reason.
2. **Green** - write the least code that passes; run the tests.
3. **Refactor** - clean up names and duplication with the tests green.

Conventions
- Name tests after behaviour: `rejects an empty title with 400`, not `test1`. Reference the AC: `AC-2.1 ...`.
- Test through public interfaces (HTTP endpoints, exported functions), not private internals.
- Each test sets up its own data; no order dependence; no network unless the test is about it; use an in-memory or temporary database.
- Cover: the happy path, each validation error, not-found, boundaries (empty, max length, zero, negative), and concurrency or idempotency where the requirement mentions it.
- A bug fix starts with a test that reproduces the bug.
- Never weaken or delete a test to make it pass; fix the code, or fix the test only if the test itself is wrong (say so).
- Keep the full suite fast (seconds): run it after every task.
