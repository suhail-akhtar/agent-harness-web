# Agents and MCP: live evaluation

Run 2026-11-02 08:53 UTC by `scripts/live-agents-eval.mjs`. Orchestrator: claude-sonnet-5-5. Prompts are written as a person would write them; every check is against the end state (tests run by the script, numbers from the database, files, the git log). 43 of 44 checks passed; $0.27 spent.

## E1: A provider added in the app; a custom agent on its model; the orchestrator calls it when needed

- PASS: Kimi is not available before its key is added
- PASS: the Moonshot key is added over the API (as Settings > Models & providers does): 200
- PASS: Kimi K3.1 Pro is available after
- PASS: the orchestrator handed it to the changelog-writer agent by itself (agents used: changelog-writer)
- PASS: the agent ran on its own model, Kimi K3.1 Pro ({"claude-sonnet-5-5":{"cost":0.0244991,"requests":2},"kimi-k3.1-pro":{"cost":0.0242844,"requests":7}})
- PASS: CHANGELOG.md was written
- PASS: it covers the real history (cart, user lookup, discounts): 3 of 3
- PASS: it does not invent changes that are not in the history

Notes:
- git history: Plan three utilities | Add discount codes (fixed amounts only) | Test that the total counts quantities | Add the user lookup | Add the cart total

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| the request | 51s | $0.0488 | claude-sonnet-5-5 $0.0245 (2)<br>kimi-k3.1-pro $0.0243 (7) | changelog-writer 45.652s | 1 |

<details><summary>the request: the answer</summary>

> I added `CHANGELOG.md` at the workspace root, written from the git history on `main`. I haven't opened the file or checked it against the history myself, so what follows is the agent's report.
> 
> - **Format:** Keep a Changelog style. There are no release tags, so everything sits under one **Unreleased** heading.
> - **Added:**
>   - Cart total calculation from item prices.
>   - Database user lookup by name.
>   - The fixed-value `SAVE5` discount code, including its zero minimum.
> - **Other files:** none were changed.

</details>

## E2: Several specialists on different models; one mixed request; the orchestrator routes each part

- PASS: the tests fail before
- PASS: the failing tests went to test-fixer (agents used: test-fixer, security-reviewer)
- PASS: the security question went to security-reviewer
- PASS: the two independent parts ran at the same time (at most 2 at once)
- PASS: each ran on its own model: claude-sonnet-5-5, claude-haiku-5-5, deepseek-flash
- PASS: the test suite passes after (run by this script)
- PASS: the tests were not weakened (the expected 11 is still there)
- PASS: the review found the SQL injection in src/db.js
- PASS: the person is told about the injection

Notes:
- diff:  1 file changed, 1 insertion(+), 1 deletion(-)

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| the request | 33s | $0.0408 | claude-sonnet-5-5 $0.0357 (3)<br>claude-haiku-5-5 $0.0006 (2)<br>deepseek-flash $0.0046 (11) | test-fixer (bg) 0.004s<br>security-reviewer 5.904s | 2 |

<details><summary>the request: the answer</summary>

> The suite is green, and the review of `src/db.js` found one serious problem. I haven't changed `src/db.js`. I didn't re-run the tests myself; the pass is the test-fixer's own result (2 of 2 passing under `npm test`).
> 
> **Tests:** The failure was in `src/cart.js:2`. `total()` added up prices but ignored `qty`, so the test got 7 where it expected 11. It now computes `item.price * (item.qty ?? 1)`. An item with no `qty` counts as one unit. No test files were touched.
> 
> **Security in `src/db.js`:**
> - **SQL injection (critical, line 3):** `findUser` builds the query by concatenating `name` into the SQL string. An input like `x' OR '1'='1` would return an arbitrary row. The fix is a bound parameter:
>   ```js
>   return db.prepare("SELECT * FROM users WHERE name = ?").get(name);
>   ```
>   I'd also check that `name` is a string before running the query.
> - **Over-broad `SELECT *` (lower severity):** it returns every column, including any password hashes or tokens. List only the columns callers need, for example `id, name`.
> - **Not checked:** the reviewer only read `src/db.js`. It didn't look at callers, so I can't say how easily user input reaches `findUser`.
> 
> Do you want me to apply the `src/db.j

</details>

## E3: A bigger task: one agent alone, then a team in parallel (same model), against hidden tests

- PASS: one agent alone: correct (hidden tests 3/3) and its suite passes
- PASS: the team: correct (hidden tests 3/3) and its suite passes
- FAIL: the team ran members at the same time (at most 1 at once)
- PASS: the reviewer checked the work

Notes:
- alone: 34s, $0.0074, hidden tests 3/3, its own suite passes
- team:  192s, $0.0463, hidden tests 3/3, its own suite passes, 5 agent runs, at most 1 at once
- team against one agent: 5.7x the time, 6.2x the cost

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| one agent alone | 34s | $0.0074 | deepseek-flash $0.0074 (11) | - | 0 |
| a team in parallel | 192s | $0.0463 | deepseek-flash $0.0463 (51) | util-dev 42.691s<br>util-dev 10.843s<br>code-reviewer 52.844s<br>util-dev 15.997s<br>util-dev 15.904s | 1 |

<details><summary>one agent alone: the answer</summary>

> Done. `npm test` passes with 18/18 tests.
> 
> **What changed**
> - `src/slugify.js` — NFD-normalizes and strips combining marks, lowercases, collapses every run of non-`[a-z0-9]` into one `-`, trims leading/trailing dashes. `"Héllo, World!"` → `"hello-world"`.
> - `src/duration.js` — strict `^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$` parse, parts must appear in h→m→s order and at least one must be present; returns seconds (`"1h30m"` → `5400`), throws `Error` on anything else (including non-strings, empty, decimals, wrong order). No range limits on minutes/seconds, since the spec only constrains order and optionality.
> - `src/bytes.js` — 1024-based B/KB/MB/GB/TB, one decimal max via `toFixed(1)` then numeric coercion to drop `.0` (`1536` → `"1.5 KB"`, `0` → `"0 B"`, `1048576` → `"1 MB"`), capped at TB. Throws `TypeError` for non-finite input.
> - Tests: `test/slugify.test.js`, `test/duration.test.js`, `test/bytes.test.js` (node:test, matching the existing style).
> - `src/cart.js:2` — **pre-existing failure fixed**: the baseline suite was already red (`total` summed `price` and ignored `qty`, giving 7 instead of 11). It now multiplies by `qty`. Flagging it because it's outside the three utilities but

</details>

<details><summary>a team in parallel: the answer</summary>

> `npm test`: **17 tests, 17 pass, 0 fail**.
> 
> ## What was built
> | File | Contents | By |
> |---|---|---|
> | `src/slugify.js` | `slugify`: lowercase → NFD → strip combining marks → runs of non `[a-z0-9]` → `-` → trim dashes. `"Héllo, World!"` → `"hello-world"`, `""` → `""` | util-dev |
> | `src/duration.js` | `parseDuration`: anchored `^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$` with at-least-one-component check; `"1h30m"` → 5400, `"45s"` → 45, `"2h"` → 7200; everything else (including `"90"`, `"30m1h"`, `"1h 30m"`, `"1h30"`, non-strings) throws `Error` | util-dev |
> | `src/bytes.js` | `formatBytes`: 1024-based B→TB, one decimal max, `.0` stripped, rounding overflow promoted (`1048575` → `"1 MB"`), TB cap, negative sign | util-dev |
> | `test/{slugify,duration,bytes}.test.js` | 14 tests covering the spec examples, the throw cases and the edges | util-dev |
> 
> Each module exports exactly its one function (`['slugify']`, `['parseDuration']`, `['formatBytes']`).
> 
> ## Pre-existing failure fixed
> `src/cart.js:2` ignored `qty`, so `test/cart.test.js` "the total counts quantities" failed (7 instead of 11) and `npm test` could never pass. Fixed to `item.price * (item.qty ?? 1)` — one expression, no test edits t

</details>

## E4: A custom MCP server built from a database; a data agent answers business questions

- PASS: a server drafted from the database: list_tables, query, find_customers, find_orders
- PASS: built and checked by the harness (12/12)
- PASS: added to the person's MCP servers
- PASS: the orchestrator asked the data-analyst (agents used: data-analyst)
- PASS: the analyst used the shop server's tools: mcp__shop__list_tables, mcp__shop__query
- PASS: the analyst ran on Claude Haiku 5.5
- PASS: the right customer: Chloe Martin
- PASS: the right amount: 495.4
- PASS: the right number of orders: 3
- PASS: the right number of cities: 4

Notes:
- truth: Chloe Martin, 495.4, 3 orders; 4 cities

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| the question | 20s | $0.0320 | claude-sonnet-5-5 $0.0298 (2)<br>claude-haiku-5-5 $0.0022 (4) | data-analyst 13.381s | 1 |

<details><summary>the question: the answer</summary>

> In October 2026, **Chloe Martin** (Lyon) spent the most. She spent **495.40** across **3 orders**. The next highest was Dev Patel at 330, so there's no tie.
> 
> October's orders came from **4 different cities**: Lyon, Pune, Lahore and Madrid.
> 
> There were 7 orders from 4 customers in October. I took these figures from the data-analyst agent's query results and didn't re-run the queries myself.

</details>

## E5: Hard cases: a member that runs out of steps; an MCP server that crashes in the middle of a run

- PASS: the member hit its step limit
- PASS: it still reported what it did and what is left (## src/cart.js - src/cart.js:1–2 — `total()` calls `.reduce` on whatever it is given; no guard for a missing cart Trigger: `total(null)` or `total(undefined)` (e.g. cart not yet loaded / DB lookup ret)
- PASS: the lead's report says the audit was not complete
- PASS: a notes MCP server is added
- PASS: the call after the crash worked (the server was restarted): 5 / 30
- PASS: both sums reached the person (5 and 30)

Notes:
- the server's status after: {"ok":true,"tools":7,"pending":0,"protocol":"2026-07-28","checkedAt":1793609632887}

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| a member out of steps | 58s | $0.0126 | deepseek-flash $0.0126 (10) | hasty-auditor 24.33s | 1 |
| a server crash | 7s | $0.0023 | deepseek-flash $0.0023 (5) | - | 0 |

<details><summary>a member out of steps: the answer</summary>

> Verification note: my session has only `read` and `agent` (no shell, no grep/glob), so I verified by re-reading every file in full — root, `src/`, `test/` — rather than by running anything. The tree is complete as listed: `src/cart.js` (3 lines), `src/db.js` (4), `src/discount.js` (4), `test/cart.test.js`, `package.json`, `README.md`, `TODO.md`. Nothing outside `src/` is source. I re-checked each claim below against the code; findings confirmed, with two corrections noted.
> 
> ## Audit result — missing error handling
> 
> **src/cart.js:2** — no input validation on `items` or on each `item.price`
> - Trigger: `total(null)` → `TypeError: Cannot read properties of null (reading 'reduce')` from inside `reduce`, naming neither the function nor the cart.
> - Trigger: `total([{ price: "2" }, { price: "5" }])` → `0 + "2"` = `"02"`, then `+ "5"` = **returns the string `"025"`** as a total. `total([{ qty: 2 }])` (no price) → returns `NaN`.
> - Missing: guard `items` before use, and check `typeof price === "number" && Number.isFinite(price)` per item. The silent-`"025"`/`NaN` path is the serious one: it is returned as a valid total rather than thrown. Nothing in the file validates anything (`cart.js:1-3`)

</details>

<details><summary>a server crash: the answer</summary>

> Both sums came back:
> 
> - **2 + 3 = 5**
> - **10 + 20 = 30**
> 
> Order of calls: `add(2,3)` → 5, then `crash` → "stopping", then `add(10,20)` → 30.
> 
> Worth flagging: despite the crash tool reporting "stopping", the service kept answering — the follow-up `add` returned 30 and an `echo` call afterward also succeeded. So either it restarted automatically or the crash didn't actually take effect; no error was returned at any point.

</details>

## E6: Agents in the background for different jobs; their reports reach the person

- PASS: two agents ran in the background ((no type) (background), (no type) (background))
- PASS: the person got the structure without waiting for the background work
- PASS: the dependency check reached the person (left-pad)
- PASS: the TODO list reached the person (the discount TODO)

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| two background jobs | 15s | $0.0682 | claude-sonnet-5-5 $0.0682 (10) | (no type) (bg) 0.017s<br>(no type) (bg) 0.017s | 2 |

<details><summary>two background jobs: the answer</summary>

> Both checks are done.
> 
> **Dependencies (explore-1)**
> - **`left-pad` 1.3.0 is deprecated.** It's the project's only dependency. It has no known CVEs. Replace it with the built-in `str.padStart(n, ch)` and remove it. The project would then have no dependencies.
> - **No lockfile.** Run `npm install` to create `package-lock.json`, commit it, and use `npm ci` in CI.
> - **No `engines` field.** `node --test` needs Node 18 or later, so add `"engines": {"node": ">=18"}`.
> - **Pinning is fine.** `1.3.0` is an exact version.
> - **Caveat:** the agent didn't query the npm registry. The deprecation status comes from its own knowledge.
> 
> **TODOs (explore-2)**
> - There is one marker in the code, at `src/discount.js:1`: `// TODO: support percentage codes as well as fixed ones`.
> - It found no FIXME, HACK or XXX markers.
> - It only searched source code, so `TODO.md` wasn't checked.
> 
> I haven't changed anything. I can make the `left-pad`, lockfile and `engines` changes if you want them. I can also read `TODO.md` to see what it adds.

</details>

## E7: Read-heavy work: one agent alone, then a team of explorers in parallel (same model), against the real code

- PASS: one agent alone: at least two real exports for every folder (3, 3, 3, 3, 3, 3, 4, 3)
- PASS: the team: at least two real exports for every folder (4, 3, 3, 3, 3, 4, 3, 4)
- PASS: the team's effort fit the work: the lead judged one pass enough and did not split, at 0.9x the cost

Notes:
- real exports named per folder (core, server, mcp, agents, vault, runtime, tools, plugins): alone 3, 3, 3, 3, 3, 3, 4, 3; team 4, 3, 3, 3, 3, 4, 3, 4
- alone: 22s, $0.0073; team: 19s, $0.0064, 0 explorers, at most 0 at once
- team against one agent: 0.9x the time, 0.9x the cost

| Conversation | Time | Cost | By model | Agents (seconds) | At once |
|---|---|---|---|---|---|
| one agent alone | 22s | $0.0073 | claude-haiku-5-5 $0.0073 (5) | - | 0 |
| a team of explorers | 19s | $0.0064 | claude-haiku-5-5 $0.0064 (5) | - | 0 |

<details><summary>one agent alone: the answer</summary>

> Each folder's purpose is drawn from its exports and the header comments I read (mainly `core/agent.ts`, `plugins/api.ts`). I did not read every file in full.
> 
> **core/**: The agent's engine. It holds the model-driven loop, sessions and their manager, scheduling, permissions, hooks, prompts, settings and cost tracking. Most other folders plug into it.
> - `Agent` (`core/agent.ts:160`): the call-model, run-tools, repeat loop, with permissions and hooks enforced on every call.
> - `Session` (`core/session.ts:395`): one persisted conversation, with its runtime, status and stored events.
> - `SessionManager` (`core/manager.ts:9`): creates, finds and owns the live sessions.
> 
> **server/**: The HTTP layer for the harness. It handles the API app, user accounts and roles, single sign-on, desktop sign-in, and workspace file operations.
> - `createApp` (`server/app.ts:226`): builds the `http.Server` and its request handler.
> - `UserStore` (`server/users.ts:20`): stores users, their token hashes and roles.
> - `OidcClient` (`server/oidc.ts:167`): runs the OpenID Connect sign-in flow.
> 
> **mcp/**: Model Context Protocol integration, in both directions. It connects to external MCP servers as a client and expose

</details>

<details><summary>a team of explorers: the answer</summary>

> I went through the exported names in each folder. The descriptions come from those exports and file names, not from reading each file in full.
> 
> **core/**: The agent engine and session layer: the `Agent` loop, the `Session` and `SessionManager` that hold conversations, and the policy, prompt, caching and scheduling logic around them.
> 1. `Agent` (core/agent.ts:160)
> 2. `Session` (core/session.ts:395)
> 3. `Scheduler` (core/scheduler.ts:275)
> 
> **server/**: The HTTP service that exposes sessions, workspaces and settings to clients, with user accounts, SSO and rate limits.
> 1. `createApp` (server/app.ts:226)
> 2. `UserStore` (server/users.ts:20)
> 3. `OidcClient` (server/oidc.ts:167)
> 
> **mcp/**: Model Context Protocol support, in both directions: it connects to external MCP servers as a client and exposes the harness's own agents as an MCP server.
> 1. `McpManager` (mcp/manager.ts:113)
> 2. `McpClient` (mcp/client.ts:134)
> 3. `UserMcp` (mcp/servers.ts:281)
> 
> **agents/**: Agent definitions: built-in agents, parsing and validating agent files from Markdown, a versioned store, and an AI generator for new agents.
> 1. `AgentStore` (agents/store.ts:40)
> 2. `parseAgentFile` (agents/agents.ts:93)
> 3. `makeAgentTo

</details>
