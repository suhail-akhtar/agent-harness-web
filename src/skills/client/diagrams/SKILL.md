---
name: diagrams
description: Draw architecture, deployment (hosts, zones, subnets), data (ER), code-dependency and flow diagrams the desktop app shows as live, interactive canvases with animated flows. Load before writing a diagram artifact or a ```diagram block.
---

# Diagrams for the desktop app

The app draws one JSON spec as an interactive canvas: cards with an icon per kind, status badges,
nested zone boxes, labelled orthogonal edges, flows played step by step. The person can drag boxes,
open details and ask you for changes from the canvas.

Where to put it:
- **An artifact** (`artifact` tool, `kind: "diagram"`, content = the JSON): the default. It is
  versioned; the canvas updates in place when you change it and marks what changed.
- A ```diagram fenced block: only for a quick, throwaway picture in a reply.

The JSON is checked when you save it; an error names the exact problem. Fix it and save again.

## The spec

```
{ "view": "context|container|component|deployment|data|code|flow", "title": "...", "description": "...",
  "groups": [{ "id", "kind", "label", "subtitle"?, "tone"?, "parent"? }],
  "nodes":  [{ "id", "kind", "title", "tech"?, "description"?, "status"?, "integrated"?, "group"?,
               "size"?, "address"?, "fields"?, "links"?, "findings"?, "tags"? }],
  "edges":  [{ "id"?, "from", "to", "label"?, "async"?, "count"?, "kind"?, "cardinality"?, "description"? }],
  "flows":  [{ "id", "title", "steps": [{ "edge": "<edge id>" | "from" + "to", "label" }] }],
  "layout": { "direction"?: "right|down|left|up", "spacing"?: "compact|normal|wide" } }
```

- **ids**: short, stable, unique (`web`, `db`, `dmz`). Node and group ids must differ. Keep ids when
  you edit, so boxes stay where the person put them.
- **node kinds** (each has its icon and caption): person, web-app, mobile-app, desktop-app, api,
  service, function, worker, batch-job, relational-db, document-db, key-value, cache, queue, stream,
  storage, search, reverse-proxy, load-balancer, gateway, cdn, dns, secrets, identity, monitoring,
  external-system, internet, browser, device, folder, file, table, container, custom.
- **title** is the name ("CRM database"); **tech** the technology line ("PostgreSQL 16").
- **status**: done, in-progress, failing, planned (badges). Omit when unknown.
- **integrated: true** for bought, SaaS or third-party systems (drawn dashed).
- **group**: the id of the box it sits in. Groups nest with `parent`. Group kinds: host, network,
  zone, subnet, cluster, region, boundary. Tones: blue, green, amber, red, purple, teal, gray, pink,
  indigo, orange. A `subtitle` carries the subnet or the machine ("subnet dmz 10.42.10.0/24").
- Deployment nodes: **address** ("10.42.10.2:443") and **size** ("2 vCPU · 4 GB") lines.
- **edges** point from the caller to the called (from depends on to). `label` is short (protocol or
  verb: "https", "sql 5432", "publishes"). `async: true` for queues, events and jobs (dashed).
  `count` bundles many (imports between folders).
- **links**: `{label?, url}` (http/https) or `{label?, file, line?}` (a workspace path).
- **findings**: `{severity: info|low|medium|high|critical, title, detail?}` (risks, issues).
- **data** view: nodes of kind `table` with `fields: [{name, type, pk?, fk?: "table.column", uk?, pii?}]`;
  edges from the table holding the foreign key to the table it references, `cardinality: "n:1"`
  (or 1:1, 1:n, n:m), `label` = the column.
- **flows**: ordered steps over edges. A step names an edge (`edge`) or `from`/`to` nodes; a reply
  goes backwards over the same edge (from the callee to the caller). Labels say what happens:
  "connect 10.42.20.5 -> 10.42.29.3:5432 as crm_app".
- Do not write `layout.positions`: the app writes them when the person drags boxes. When you edit a
  diagram that has them, leave them as they are (a new node is placed next to its neighbours).
- At most 600 nodes, 2000 edges; fold detail into groups rather than drawing everything.

## Editing an artifact

`artifact get` it first (the person may have moved boxes), then `update` with an exact
find/replace for a small change (add a node object, change an edge) or `rewrite` for a large one.
Keep the ids of what stays. Say in one line what you changed.

## Examples

Context (people, the system, what it uses):
```json
{"view":"context","title":"CRM - context","nodes":[
 {"id":"rep","kind":"person","title":"Sales rep"},
 {"id":"crm","kind":"web-app","title":"CRM","tech":"Next.js · Postgres","status":"done"},
 {"id":"idp","kind":"identity","title":"Identity provider","tech":"Entra ID","integrated":true},
 {"id":"mail","kind":"external-system","title":"Email","tech":"SendGrid","integrated":true}],
"edges":[{"from":"rep","to":"crm","label":"manages deals"},{"from":"crm","to":"idp","label":"OIDC"},
 {"from":"crm","to":"mail","label":"sends mail","async":true}]}
```

Deployment with a host, zones and a login flow:
```json
{"view":"deployment","title":"CRM - production",
"groups":[{"id":"host","kind":"host","label":"vm-prod-01","subtitle":"Ubuntu 24.04 · 8 vCPU"},
 {"id":"dmz","kind":"zone","label":"DMZ zone","subtitle":"subnet dmz 10.42.10.0/24","tone":"amber","parent":"host"},
 {"id":"app","kind":"zone","label":"App zone","subtitle":"subnet app 10.42.20.0/24","tone":"blue","parent":"host"},
 {"id":"data","kind":"zone","label":"Data zone","subtitle":"subnet data 10.42.29.0/24","tone":"purple","parent":"host"}],
"nodes":[{"id":"user","kind":"person","title":"Sales rep"},
 {"id":"proxy","kind":"reverse-proxy","title":"Reverse proxy","tech":"nginx 1.27","group":"dmz","address":"10.42.10.2:443","status":"done"},
 {"id":"web","kind":"web-app","title":"CRM web app","tech":"Node 22","group":"app","address":"10.42.20.5:3000","size":"2 vCPU · 2 GB"},
 {"id":"backup","kind":"batch-job","title":"Backup job","tech":"pg_dump nightly","group":"app","status":"in-progress"},
 {"id":"db","kind":"relational-db","title":"CRM database","tech":"PostgreSQL 16","group":"data","address":"10.42.29.3:5432"},
 {"id":"secrets","kind":"secrets","title":"Secrets","tech":"Vault","group":"data","integrated":true}],
"edges":[{"id":"e1","from":"user","to":"proxy","label":"https 443"},{"id":"e2","from":"proxy","to":"web","label":"http 3000"},
 {"id":"e3","from":"web","to":"db","label":"sql 5432"},{"id":"e4","from":"web","to":"secrets","label":"token"},
 {"id":"e5","from":"backup","to":"db","label":"pg_dump"}],
"flows":[{"id":"login","title":"Login","steps":[{"edge":"e1","label":"POST /login over TLS"},
 {"edge":"e2","label":"forward to 10.42.20.5:3000"},{"edge":"e4","label":"read the signing key"},
 {"edge":"e3","label":"connect 10.42.20.5 -> 10.42.29.3:5432"},{"from":"db","to":"web","label":"the user row"},
 {"from":"proxy","to":"user","label":"Set-Cookie: session"}]}]}
```

Data model (ER):
```json
{"view":"data","title":"CRM - data","nodes":[
 {"id":"accounts","kind":"table","title":"accounts","fields":[{"name":"id","type":"uuid","pk":true},{"name":"domain","type":"text","uk":true}]},
 {"id":"contacts","kind":"table","title":"contacts","fields":[{"name":"id","type":"uuid","pk":true},
  {"name":"account_id","type":"uuid","fk":"accounts.id"},{"name":"email","type":"citext","uk":true,"pii":true}]}],
"edges":[{"from":"contacts","to":"accounts","cardinality":"n:1","label":"account_id"}]}
```

Flow (a process over services, two paths):
```json
{"view":"flow","title":"Checkout","nodes":[{"id":"shop","kind":"web-app","title":"Shop"},
 {"id":"orders","kind":"service","title":"Orders"},{"id":"pay","kind":"external-system","title":"Payments","integrated":true}],
"edges":[{"id":"a","from":"shop","to":"orders","label":"place order"},{"id":"b","from":"orders","to":"pay","label":"authorise"}],
"flows":[{"id":"ok","title":"Paid","steps":[{"edge":"a","label":"POST /orders"},{"edge":"b","label":"authorise 49.90 EUR"},
 {"from":"pay","to":"orders","label":"authorised"}]}]}
```
