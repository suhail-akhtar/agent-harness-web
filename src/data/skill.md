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
Types: file (csv, tsv, json, ndjson, xml, parquet, xlsx, geojson, log), sqlite, postgres, mysql (and MariaDB),
mssql (SQL Server), mongodb (from = a table, one SELECT, or a collection), http (JSON, CSV, XML or log text;
its own host only), static (columns + rows), plugin. **Credentials are never in a source**: the person
stores them in the key vault; you name the entry in `secret`. Adding a source asks the person.
`test_source` lists tables, sheets and named ranges (or a log's detected format and columns). Paths are relative to your workspace.
- Text files: `encoding` and `delimiter` are detected (UTF-8, UTF-16, Windows-1252; `, ; tab |`); name them to override.
- JSON, NDJSON, XML, MongoDB: nested objects become columns (`customer.address.city` -> `customer_address_city`);
  `unnest:"items"` turns that array into one row per item (`items_sku`, ...); `flatten:false` keeps them whole.
  XML: `from` names the record element ("Order" or "Orders/Order"). MongoDB: `filter` (a query) and `projection`.
- Excel: `from` is a sheet, a named range, or `Sheet1!B3:F40`; the header row is found under a title.
- Logs: `log:{format}` with format `auto common combined syslog jsonl logfmt cef leef w3c cloudtrail alb elb docker cri
  winevent-xml winevent-csv regex grok`; typed columns such as `time level host status bytes latency_ms path method
  user_agent message` (and each format's own). `regex`/`grok` take `pattern` with named groups (`(?<status>\d{3})`,
  `%{IP:client} %{INT:status:int}`). Binary .evtx: export the events as XML or CSV first.
- http: `paginate:{kind: page|offset|cursor|link, param?, size?, sizeParam?, cursorPath?, maxPages?}` reads every page.

Query-editor steps (`add_step {dataset, step, at?}`; `preview {dataset, step}` shows the rows after a step;
`profile` gives nulls, distinct, min/max, top values):
`filter {where}` · `keep {columns}` · `remove {columns}` · `rename {columns:{old:new}}` · `type {column, to: integer|double|decimal|text|date|timestamp|boolean, format?}` ·
`split {column, by, into:[a,b]}` · `filldown {columns}` · `replace {column, find, with}` · `group {by:[..], aggs:[{column, fn, as}]}` (fn: sum avg min max count count_distinct median stddev first last) ·
`pivot {on, values, fn}` · `unpivot {columns, name, value}` · `merge {with: dataset, on:[["left","right"]], how: left|inner|right|full|anti|semi, columns?}` ·
`append {with:[datasets]}` · `dedupe {columns?}` · `add {name, expr}` · `conditional {name, cases:[{when, then}], else}` · `dateparts {column, parts:[year,quarter,month,monthname,week,day,weekday,dayname]}` · `sort {by:[{column, desc}]}` · `limit {n}`.
Cleansing: `trim {columns}` · `case {columns, to: upper|lower|title}` · `nulls {columns, action: drop|fill, value}` ·
`parse_date {column, formats:["%d/%m/%Y",...], to: date|timestamp}` · `outliers {column, method: iqr|zscore, k, as}` (a flag column; filter after).
`set_incremental {dataset, incremental:{column, window, unit}}` re-reads only recent rows. `certify {dataset, certified:true}`.
`set_storage {dataset, storage: import|live, ttl}`: import keeps an extract (refreshed on its schedule); live reads the
source when queried (at most every ttl seconds), so one model can mix live and imported tables. Datasets from different
sources relate in one model like any others (an Excel sheet, a database table and an API joined by relationships).
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
- Hierarchies have two to five levels, top first (Year > Quarter > Month > Week > Day; Region > Country > State > City > Store).
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

## Drill and linked dashboards

A visual with `options.hierarchy` drills (`drillMode:true`: a click drills down instead of selecting).
`drill {doc, visual, action: down|up|next|expand|to|reset, value?, level?, state?}` returns the new drill state, the
breadcrumb and the numbers (pass the returned `state` back as `state.drill[visual]` to go on): `down` a value,
`up`, `next` (the next level for every parent), `expand` (the next level within its parents: several levels at once),
`to` a breadcrumb level. Each level is aggregated in SQL; filters, measures and time intelligence apply at every level.
`drillthrough {doc, visual, point:{field: value}, state?, to:{page} | to:{doc, page?} | link}` goes to a drill-through
page or another dashboard with the filters in force, the drilled path and the point, and returns the target's numbers.
`add_link {doc, visual, link:{label, doc, page?, fields?}}`: the visual's points open that dashboard with their context
(`fields` limits what travels). Buttons: `button:{label, action:"doc", target: docId, page?}`.
`sync_slicer {doc, visual, group}`: slicers of one group share their selection across pages and dashboards.
Published pages keep links (a linked dashboard is read through the published page's own link).

## Layouts and templates

A page has a layout (`set_layout {doc, page, layout:{type, ...}}`; switching keeps every widget, re-flowed; undo restores):
`grid` (12 columns: `compact: up|left`, `responsive:false` + `width` for fixed; wide, `breakpoint:"medium"` and phone arrangements) ·
`canvas` (pixels: `move_widget {x,y}`, `resize_widget {w,h}`, `arrange {z: front|back, lock, group}`, `align {visuals, edge: left|right|top|bottom|hcenter|vcenter|size|distribute}`) ·
`sections` / `tabs` (`add_section {page, section:{title}}`, `update_section {section, patch:{title, collapsed, to}}`, `move_widget {visual, section}`) ·
`sidebar` (`sidebar:{side, width}`; `move_widget {visual, section:"sidebar"}`) · `masonry` (`cardWidth`) · `story` (one column) ·
`tv` (`aspect: 16:9|21:9`, `rotate` seconds per page, `scale`; no chrome) · `print` (`paper: A4|Letter`, `orientation`, `margins` mm; the document's `header`/`footer` with {title} {date} {page} {pages}).
`pack {page, direction}` closes gaps. "Make this a TV wall" -> `set_layout {type:"tv"}`; "a printable monthly report" -> `set_layout {type:"print"}` on each page (and `set_doc {header, footer}`).

Templates (`list_templates`; `apply_template {template, model, doc?}`: a new document, or a page added to `doc`; placeholders filled from the
model's measures, date and fields; a widget with nothing to fill is left out and named): `executive`, `noc` (TV), `sales`, `funnel`, `product`,
`delivery` (sections), `sre` (sidebar), `lab` (science visuals), `quality` (masonry, completeness per field), and `blank-<layout type>`.
After applying one, `describe` and adjust titles and fields to the person's words; then `verify`.
