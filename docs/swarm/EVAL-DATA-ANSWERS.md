# Answers over the person's own data, live (phase 2)

`scripts/live-data-answers.mjs`, 2026-11-02. Raw results of the final run:
[EVAL-DATA-ANSWERS.json](EVAL-DATA-ANSWERS.json).

## Setup

Two SQLite databases, each with approved definitions beside it, carry the traps that make data answers wrong:

- **A shop** (420 orders). An order has several item rows, so counting across the join counts it more than once.
  Refunded orders and test customers are excluded by the definitions. The data ends on 30 March.
- **HR** (180 employees). It has a relative period ("last year") and a question it cannot answer (satisfaction).

Ten questions are asked as a person would ask them. Each runs the `data-answer` workflow in a fresh conversation,
the first five on Claude Haiku 5.5 and the other five on Claude Sonnet 5.5, recomputed on Grok 4.7. Every answer is
graded from its figures against the truth computed by the script's own SQL.

## Final run: 10 of 10 right, 33 of 33 checks, $0.51

| # | Question | Model | Truth | Answer's figure | Recomputation (Grok 4.7) |
|---|---|---|---|---|---|
| 1 | Revenue in February 2026? | Haiku | 24,543.10 | 24,543.10 | agreed |
| 2 | Orders in Q1 2026? (the join fan-out trap) | Haiku | 397 | 397 | agreed |
| 3 | Region with the most revenue in March, and how much? | Haiku | north, 9,328.90 | north, 9,328.90 | agreed |
| 4 | Average order value? (fan-out again) | Haiku | 248.98 | 248.98 | agreed |
| 5 | Revenue in the first half of 2026? (data ends in March) | Haiku | 91,874.75 for January to March | 91,874.75, as January to March | agreed |
| 6 | Refund rate in Q1 2026? | Sonnet | 0.0705 | 0.0705 | agreed |
| 7 | Headcount at the end of March 2026? | Sonnet | 123 | 123 | agreed |
| 8 | Average salary in Engineering now? | Sonnet | 81,466.63 | 81,466.625 | agreed |
| 9 | How many people left last year? (relative period) | Sonnet | 15 in 2025 | 15, read as 2025 | agreed |
| 10 | Employee satisfaction in 2025? (no such data) | Sonnet | unanswerable | unanswerable | - |

Every number in every answer was traced to a query cell (the provenance gate). The rule kept them from typing
numbers of their own.

## What the first run found (5 of 10, 28 of 33): the harness's own coverage check misled the agents

- **Q7, Q6 and Q5 were refused by agents that trusted a CHECKS line written too strongly.** Q7 (headcount on a date)
  was declared unanswerable because the newest hire predates the date. Q6 (a quarter) was refused because the last
  day of the quarter had no orders. Q5 (a half year with data only to March) was refused instead of answered for the
  part covered.

  The check now fires only for a window with both a start and an end on the same date column, and only for a real
  gap: more than a week and more than a tenth of the window. It says to give the figure for the part covered and
  name it. The analyst's instructions say the same.
- **Q3 and Q4 were graded wrong by the grader**: the answers were right, but put their figures line in a code fence.
  The grader now reads the figures as the harness does.
