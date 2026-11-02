# The verifier measured at scale

Run 2026-11-02 11:28 UTC by `scripts/verifier-calibration.mjs` (docs/swarm/SWARM.md, phase 1b). 6 tasks; mutants of each good change kept only when the visible tests still pass and a hidden truth check fails (problems only a verifier can catch); each good change checked 3 times; $1.32 spent.

| Verifier | Planted problems | Passed (missed) | Upper bound on misses (95%) | Good changes | Failed | Upper bound on false fails | Same verdict on repeats | Cost per verdict |
|---|---|---|---|---|---|---|---|---|
| deepseek-flash | 52 | 0 | 6.9% | 18 | 0 | 17.6% | 100.0% | $0.0027 |
| claude-haiku-5-5 | 52 | 0 | 6.9% | 18 | 2 | 32.8% | 83.3% | $0.0017 |
| claude-sonnet-5-5 | 52 | 0 | 6.9% | 18 | 0 | 17.6% | 100.0% | $0.0144 |

What slipped through, by kind of problem:

- deepseek-flash: nothing
- claude-haiku-5-5: nothing
- claude-sonnet-5-5: nothing

The corpus:

- cart: 9 mutants, 8 kept (off-by-one 1, drop-default 1, swap-operator 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1, approve-note 1)
- duration: 17 mutants, 12 kept (no-change 1, off-by-one 2, drop-default 1, drop-guard 1, swap-operator 1, and-or 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1, approve-note 1)
- bytes: 15 mutants, 11 kept (no-change 1, flip-boundary 1, off-by-one 3, swap-operator 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1, approve-note 1)
- slugify: 6 mutants, 5 kept (no-change 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1)
- discount: 14 mutants, 11 kept (no-change 1, off-by-one 2, swap-operator 2, drop-case 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1, approve-note 1)
- sql: 6 mutants, 5 kept (no-change 1, skip-test 1, exit-early 1, comment-assert 1, assert-truthy 1)

Every wrong verdict:

- claude-haiku-5-5, sql/good: fail: For name === undefined the old code returned undefined (it built name = 'undefined' and matched nothing); the new code throws 'Provided value cannot be bound to SQLite parameter 1' (node:sqlite, Node 
- claude-haiku-5-5, sql/good: fail: Non-string inputs behave differently from the original concatenation. Against an in-memory node:sqlite table with rows named '5' and 'null' and 'undefined': findUser(db, 5) returned the '5' row before
