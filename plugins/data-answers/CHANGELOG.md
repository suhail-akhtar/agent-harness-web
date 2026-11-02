# Changelog

## 1.0.0

- Answers over the person's own SQLite databases (docs/swarm/SWARM.md, phase 2):
  - **`data_schema`**: the database's tables, columns and row counts.
  - **`sql_query`**: read-only. Each result is kept as a query cell the agent cannot edit. After every query the
    database itself is checked for join fan-out, repeated groups, and periods the data does not cover.
  - **`draft_semantics`**: a definitions file, which the person approves before agents query.
  - **`check_answer` and the `provenance` gate**: every number comes from a cell, or is marked derived.
  - **`recompute_answer` and the `recompute` gate**: an agent of another family, which never sees the first queries,
    recomputes the figures, and they are compared in code.
  - **The `data-answer` workflow.**
