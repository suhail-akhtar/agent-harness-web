# Dashboards, reports and data (core.dashboards)

Every number on a dashboard, in a report or in your answer comes from the engine (DuckDB) running a
query over a dataset. **Never type a number yourself.** Four tools, one op layer (the app's buttons
apply the same ops): `datasource`, `dataset`, `model`, `dashboard`. Each takes `{op, ...args}`, or
`{ops: [{op, ...}, ...]}` to apply several at once (atomic: all or none; reads run after the writes).
A result lists what changed (`+`, `~`, `-`); every change is versioned and `undo` takes it back.

## Procedure (required)

1. **Look first.** `dashboard {op:"describe", doc}` (pages, visual ids, fields, measures) or
   `model {op:"describe_model", model}` before editing; edit by id, never by guess.
2. **Ambiguous request?** Ask with `ask_user` (a form with the choices) instead of guessing.
3. **Build** with ops (batch them). Fields are `table.column`; dates take a grain: `sales.day:month`.
4. **Verify**: `dashboard {op:"verify", doc}` runs every visual and reconciles totals. Fix any ERROR,
   EMPTY, WARNING or STATIC line before saying you are done.
5. **Numbers in prose** come only from executed results (`model_query`, `query`, `verify`) and, in a
   narrative visual, as placeholders `{{Revenue}}` or `{{Revenue[regions.region=EU]}}`; `set_narrative`
   refuses any number no computed result backs.
6. **Report** what changed (the diff lines) in one short paragraph; the person can undo.

## Data

```json
{"op":"add_source","source":{"name":"Sales workbook","type":"file","path":"data/sales.xlsx"}}
{"op":"add_source","source":{"name":"Orders DB","type":"postgres","host":"db","database":"shop","user":"bi","secret":"shop-db-password"}}
{"op":"add_source","source":{"name":"FX rates","type":"http","url":"https://api.example.com/rates","rowsPath":"data.items","secret":"fx-token","auth":"bearer"}}
{"op":"define","dataset":{"name":"sales","source":"src-1a2b3c4d","from":"Sheet1"}}
{"op":"define","dataset":{"name":"big_orders","sql":"SELECT * FROM sales WHERE amount > $min","params":[{"name":"min","type":"number","default":1000}]}}
```
Types: file (csv, tsv, json, parquet, xlsx, geojson), sqlite, postgres, mysql (from = a table or one
SELECT), http (JSON or CSV; its own host only), static (columns + rows), plugin. **Credentials are never
in a source**: the person stores them in the key vault; you name the entry in `secret`. Adding a source
asks the person. `test_source` lists tables/sheets. Paths are relative to your workspace.

Query-editor steps (`add_step {dataset, step, at?}`; `preview {dataset, step}` shows the rows after a step;
`profile` gives nulls, distinct, min/max, top values):
`filter {where}` · `keep {columns}` · `remove {columns}` · `rename {columns:{old:new}}` · `type {column, to: integer|double|decimal|text|date|timestamp|boolean, format?}` ·
`split {column, by, into:[a,b]}` · `filldown {columns}` · `replace {column, find, with}` · `group {by:[..], aggs:[{column, fn, as}]}` (fn: sum avg min max count count_distinct median stddev first last) ·
`pivot {on, values, fn}` · `unpivot {columns, name, value}` · `merge {with: dataset, on:[["left","right"]], how: left|inner|right|full|anti|semi, columns?}` ·
`append {with:[datasets]}` · `dedupe {columns?}` · `add {name, expr}` · `conditional {name, cases:[{when, then}], else}` · `dateparts {column, parts:[year,quarter,month,monthname,week,day,weekday,dayname]}` · `sort {by:[{column, desc}]}` · `limit {n}`.
`set_incremental {dataset, incremental:{column, window, unit}}` re-reads only recent rows. `certify {dataset, certified:true}`.
`query {sql}` (one read-only SELECT over datasets by name) returns a capped summary.

## Semantic model

```json
{"ops":[
 {"op":"add_model","model":{"id":"sales-model","name":"Sales"}},
 {"op":"set_table","model":"sales-model","table":{"name":"sales","dataset":"sales"}},
 {"op":"set_table","model":"sales-model","table":{"name":"regions","dataset":"regions"}},
 {"op":"set_relationship","model":"sales-model","relationship":{"from":"sales.region_id","to":"regions.id"}},
 {"op":"set_model","model":"sales-model","patch":{"date":"sales.order_date"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Revenue","expr":"sum(sales.amount)","format":"currency:USD:0"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Orders","expr":"count(*)","table":"sales","format":"integer"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Avg order","expr":"[Revenue] / [Orders]","format":"currency:USD"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"EU revenue","expr":"sum(sales.amount)","filter":"regions.region = 'EU'"}},
 {"op":"set_measure","model":"sales-model","measure":{"name":"Revenue YoY %","base":"Revenue","calc":"yoy_pct"}},
 {"op":"set_hierarchy","model":"sales-model","hierarchy":{"name":"Calendar","levels":["sales.order_date:year","sales.order_date:quarter","sales.order_date:month"]}}
]}
```
- Relationships go many -> one (`from` the fact's key, `to` the lookup's unique key; the engine refuses a
  non-unique one side). `crossFilter:"both"` lets a filter on the many side reach the other way.
- Measures are SQL aggregates over model fields; `[Name]` combines measures (computed after grouping, so
  ratios are exact at every level); `filter` gives a measure its own filter context.
- `calc` on a base measure: `ytd qtd mtd prev_period prev_year yoy yoy_pct running_total moving_avg pct_of_total rank`
  (time calcs need a date dimension in the query; YTD and previous periods re-aggregate the fact rows exactly).
- Measures from different fact tables in one visual are grouped separately and joined on the dimensions.
- Formats: `currency:USD[:decimals]`, `percent[:d]`, `number[:d]`, `integer`, `compact`, `date[:grain]`.
- Row-level security: `set_role {model, role:{name, members:["usr_..","*"], filters:{regions:"region = 'EU'"}}}`
  (`{user}` is the viewer's account); enforced in SQL for the app ("view as") and published pages.
- `suggest {datasets}` profiles data and returns ops for relationships, measures and a calendar.
- `model_query {query:{model, dims, measures, filters, sort, limit}}` answers a question with its SQL.

## Dashboards and reports

```json
{"ops":[
 {"op":"create","doc":{"type":"dashboard","title":"Sales overview","model":"sales-model"}},
 {"op":"add_visual","doc":"$new","visual":{"type":"kpi","title":"Revenue","query":{"measures":["Revenue"]},"options":{"target":"Revenue PY","trend":"sales.order_date:month"}}},
 {"op":"add_visual","doc":"$new","visual":{"type":"slicer","title":"Region","options":{"slicer":{"field":"regions.region","style":"dropdown","multi":true}}}},
 {"op":"add_visual","doc":"$new","visual":{"type":"column","title":"Revenue by month","query":{"dims":["sales.order_date:month","regions.region"],"measures":["Revenue"]},"options":{"stack":"stacked","hierarchy":"Calendar"}}},
 {"op":"set_refresh","doc":"$new","refresh":{"mode":"interval","every":3600}}
]}
```
(`$new` is the document created earlier in the same batch.) Visual types: `card multicard kpi gauge bar column line area combo ribbon waterfall funnel pie donut treemap scatter table matrix map decomp drivers narrative slicer text image button fence`.
Query: `{dims, measures (names or {name, expr}), columns (detail rows), filters, sort:[{by, desc}], limit, totals}`.
Filters: `{field, op: in|not_in|eq|ne|gt|ge|lt|le|between|contains|starts|is_null|not_null|relative|top|bottom, values|value|to, n, unit, by}`;
on a measure name, `gt`/`lt` filter after aggregation; `top {field, n, by: measure}` keeps the top n values.
Options: `stack: clustered|stacked|percent`, `horizontal`, `labels`, `lines:[measures]` (combo), `target`, `trend`, `min`/`max` (gauge),
`size`, `play` (scatter play axis), `forecast:{periods}`, `anomalies:true`, `geo:{source, key | lat, lon}`, `rows` (matrix: how many dims are rows), `stepped`, `subtotals`,
`dims` (decomp splits / driver factors), `text` (narrative), `markdown` (text), `url` (image), `slicer:{field, style: list|dropdown|range|relative|buttons, multi}`,
`button:{label, action: bookmark|page|back|clear|url, target}`, `fence:{lang, source}`, `hierarchy`, `formats:{field: format}`,
`conditional:[{field, kind: scale|bars|icons|rules, colors, rules:[{op, value, color, icon}]}]`, `colors`, `detail:[fields]` (drill to rows).
Layout: 12 columns, rows of 40 px (`move_visual {visual, layout:{x,y,w,h}, mobile:{order,h,hidden}}`); omitted, a visual is placed below.
Interactions: a click filters the other visuals (bars and pies highlight); `set_interaction {from, to, mode: filter|highlight|none}`.
Pages: `add_page {page:{name, kind: drillthrough, drillFields:["regions.region"]}}` makes a drill-through target; `kind: tooltip` pages
show on hover of a visual whose `tooltip` names them. `add_bookmark {bookmark:{name, page, filters, hidden}}`; buttons apply bookmarks.
Also: `add_filter {scope: doc|page id|visual id, filter}`, `set_theme {theme}` (default ocean sunset mono contrast, or a palette),
`add_alert {alert:{name, measure, op, value, notify}}`, `add_subscription {subscription:{cron, format, deliver: save|notify}}`,
`pin {block:{lang, source}}` (a chart from a conversation: its numbers become a static, model-typed dataset; then `bind {visual, query}` to real data),
`publish {doc, access: token|signed-in, accounts?, role?}` (a live page at /p/<slug>; viewers get no SQL or credentials), `unpublish`,
`export {doc, format: xlsx|csv|html|pdf|png}`, `snapshot {doc}` (reports: refresh and freeze the numbers), `history`, `undo`, `redo`, `restore {version}`.
Reports are documents with `type:"report"`: visuals flow in order, `text` visuals carry the prose (markdown), header/footer repeat on each printed page.
