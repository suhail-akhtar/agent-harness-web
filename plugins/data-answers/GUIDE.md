# Data answers (data-answers)

## What it is for

Questions about the person's own data in a SQLite database in the folder: totals, trends, counts, comparisons. Use it
when the answer is a number the person will act on, and they need to know where it came from.

## How work runs

- **data-answer** (workflow): the data-analyst reads the definitions (`<db>.semantics.md`), clarifies the question,
  queries read-only, and writes `data/answer.md` with every number citing its query cell; the `provenance` gate checks
  every number comes from a cell; the `recompute` gate has an agent of another model family answer the same question
  from the definitions alone, and compares the figures in code.
- **Tools**: `data_schema`, `sql_query` (each result a cell [qN], with CHECKS for join fan-out, repeated groups and
  missing periods), `draft_semantics` (a draft the person approves before agents query), `check_answer`,
  `recompute_answer`.
- **Agents**: data-analyst, data-checker. **Gates**: `provenance`, `recompute` (only where a workflow names it).
