---
name: core.dashboards-guide
description: Data, dashboards and reports on the engine: sources, datasets, a semantic model, visuals, live published pages.
---

# Dashboards (core.dashboards)

## What it is for

Turning data the person has (files, databases, APIs, logs) into dashboards and reports whose every
number is computed by the engine, never typed. Use it when the person asks for a dashboard, a KPI
page, a chart they will keep, a monthly report, a "number by month", or to connect a data source.
Do not use it for a one-off chart in a reply: a ```chart or ```viz block is enough for that (the
person can still pin it with "Add to dashboard").

## How it fits together

- **Sources** (`datasource` tool): where rows come from. Credentials are never in a source: the
  person stores them in the key vault and you name the entry (`secret`). Adding a source asks them.
- **Datasets** (`dataset` tool): named tables computed from a source with query-editor steps
  (filter, type, merge, group, cleansing...) or one read-only SELECT.
- **Model** (`model` tool): tables, relationships, measures (with time intelligence), hierarchies,
  formats and row-level roles. Visuals ask the model, so build it before the visuals.
- **Dashboards and reports** (`dashboard` tool): pages of visuals with filters, slicers, drill,
  links between dashboards, layouts (grid, canvas, sections, tabs, story, TV wall, print) and
  templates. `publish` makes a live page (it asks the person).

Every tool takes `{op, ...}` or `{ops: [...]}` (atomic). `dashboard {"op":"help"}` returns the full
op reference: read it before your first build in a session.

## Procedure

1. Look first: `dashboard {"op":"list_docs"}`, `datasource {"op":"list_sources"}`,
   `model {"op":"describe_model"}`; edit by id, never by guess.
2. Data: `add_source` (a workspace path for a file), `test_source`, `define` a dataset, `preview`.
3. Model: `add_model` with the dataset, then `set_measure` for each number the person cares about.
4. Build: `create` (or `apply_template`), then `add_visual` per chart; batch them in `ops`.
5. Verify: `dashboard {"op":"verify","doc":...}` and fix every ERROR, EMPTY or WARNING line.
6. Show it: `desktop_open {"target":"view","id":"core.dashboards:doc","params":{"id":"<doc id>"}}`
   (or `desktop_command {"command":"core.dashboards:open-doc","args":{"id":"<doc id>"}}`).
7. Report the diff lines in one short paragraph; every change is versioned and `undo` takes it back.

## Pages and navigation

- Home: `desktop_open {"target":"view","id":"core.dashboards"}`: recent dashboards and reports,
  datasets, sources, templates.
- Dashboards and Reports: the lists (`core.dashboards:dashboards`, `core.dashboards:reports`).
- One document: `core.dashboards:doc` with params `{"id": ..., "page"?: ..., "edit"?: "1"}`.
- Data: `core.dashboards:data` with params `{"tab": "sources" | "datasets" | "model" | "history",
  "dataset"?: id}`.
- Panels: `core.dashboards:ask` (ask beside a dashboard), `core.dashboards:pin` (add a drawn chart).

## Worked examples

**"Build me a dashboard from this CSV" (sales.csv in the workspace)**

```json
{"op":"add_source","source":{"name":"Sales CSV","type":"file","path":"sales.csv"}}
```
then `dataset {"op":"define","dataset":{"name":"sales","source":"<source id>"}}`,
`dataset {"op":"preview","dataset":"sales"}` (check the columns and types), then one batch:

```json
{"ops":[
 {"op":"add_model","model":{"id":"sales-model","name":"Sales"}},
 {"op":"set_table","model":"sales-model","table":{"name":"sales","dataset":"sales"}},
 {"op":"set_model","model":"sales-model","patch":{"date":"sales.order_date"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Revenue","expr":"sum(sales.amount)","format":"currency:USD:0"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Orders","expr":"count(*)","table":"sales","format":"integer"}}
]}
```
then `dashboard {"op":"apply_template","template":"executive","model":"sales-model"}` (or `create`
and `add_visual`), `verify`, and open it with desktop_open as above.

**"Add a year-over-year line to my sales dashboard"**: `dashboard {"op":"describe","doc":...}`,
`model {"op":"set_measure","model":"sales-model","measure":{"name":"Revenue YoY %","base":"Revenue","calc":"yoy_pct"}}`,
`add_visual` a line by `sales.order_date:month`, `verify`.

**"Make it refresh every morning and send it to the team"**: `set_refresh` on the datasets or the
document, then `publish` (asks the person) and share the link it returns.

## Things to remember

- Numbers in prose come from executed results (`model_query`, `query`, `verify`) only.
- Fields are `table.column`; dates take a grain: `sales.day:month`.
- The person may be editing the same dashboard: describe again before a second round of edits.
<!-- generated -->
