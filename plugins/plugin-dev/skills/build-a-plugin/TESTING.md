# Testing a plugin

The test kit (`@harness/plugin-sdk/testing`) loads the plugin folder into a real harness, the way a
server does, with a throwaway data folder and workspace, and calls what it adds for real. Tests are
`node:test` files named `*.test.ts` (or `.mjs`, `.js`) anywhere in the plugin (usually `test/`).

```bash
npm run plugin -- test <plugin folder>        # from the harness checkout; agents: plugin_test
```

`@harness/plugin-sdk` is importable from any folder there (nothing to install). Keep the tests in the
plugin's own `test/` folder: they travel with it (Export, `pack`) and run wherever it is installed. A test
that needs the harness itself (a whole server, its helpers) imports it by name, `@harness/core/src/...`
(the harness's own files, wherever it is installed), and another plugin's module as
`@harness/plugins/<name>/...`; the plugin's own files by relative path (`../lib/x.mjs`). The shipped
solutions do the same: `plugins/aiops/test`, `plugins/games3d/test`, and the harness's suite runs them too.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = new URL('..', import.meta.url);

test('tickets: create, find, close', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);                          // it loaded
    const made = await kit.tool('desk_ticket_create', { title: 'Login fails', body: 'Since this morning' });
    assert.equal(made.isError, false);
    assert.match((await kit.tool('desk_ticket_search', { query: 'login' })).content, /Login fails/);
    assert.equal((await kit.tool('desk_ticket_create', {})).isError, true);   // schema-checked like the agent's calls
  } finally { await kit.close(); }
});
```

## The kit

| | |
|---|---|
| `loadPlugin(dir, { env?, workspaceFiles? })` | loads it; `env` sets environment variables for the test (secrets), `workspaceFiles` seeds the workspace (`{ 'data/a.csv': '...' }`) |
| `kit.error` | why it did not load (then nothing else works), or `undefined` |
| `kit.adds` | `{ tools, skills, agents, workflows, gates, routes }`: names of what it added (`routes`: `"GET items"`) |
| `kit.tool(name, input?)` → `{ content, isError }` | calls a tool on the test workspace with a real tool context; input is checked against the schema first; `ctx.callTool` reaches the harness's other tools |
| `kit.route(method, path, { body?, query?, headers?, as?: 'operator' \| 'anonymous', token? })` → `{ status, body, text, headers }` | calls a route over HTTP through the server's own checks; signed in by default; `as: 'anonymous'` to check refusals; `token` for `auth: 'token'` routes |
| `kit.routeToken(path)` | a token for an `auth: 'token'` route (what an administrator would read), to pass as `token` |
| `kit.chat(prompt, { script?, model?, mode?, timeoutMs? })` → `{ text, calls, cost, history }` | a whole conversation with the plugin loaded (below) |
| `kit.idle(sessionId)` → history | waits for a conversation the plugin started (`api.sessions.start`) to finish its turn; no real model is called (they answer "done") unless `loadPlugin(dir, { realModels: true })` |
| `kit.signals`, `kit.logs` | its `api.signal` names and `api.log` lines so far |
| `kit.dataDir`, `kit.workspace` | its data folder (`api.dataDir`) and the test workspace |
| `kit.harness` | the harness itself, for anything else |
| `kit.close()` | always, in `finally` |

## Conversations

Scripted: no model, no cost. Each turn says what the "model" does; the harness runs the tools for real
(permissions, hooks, the plugin's code) and the results are returned. It proves the wiring: the
agent can call the tools in this order and gets these results.

```ts
const r = await kit.chat('add a ticket about the login bug', {
  script: [
    { calls: [{ name: 'desk_ticket_create', input: { title: 'Login bug' } }] },
    { calls: [{ name: 'desk_ticket_search', input: { query: 'login' } }] },
    { text: 'Done: ticket created.' },
  ],
});
assert.deepEqual(r.calls.map((c) => [c.name, c.isError]), [['desk_ticket_create', false], ['desk_ticket_search', false]]);
assert.match(r.calls[1]!.result, /Login bug/);
```

With a real model (`{ model: 'deepseek-flash' }`, keys from the environment): it proves the
descriptions and the skill lead a model to the right tools. Slow and paid: keep these few, and skip
them when the key is missing (`test('...', { skip: !process.env.DEEPSEEK_API_KEY }, ...)`).

## Data migrations

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

test('version 1 data is brought forward', async () => {
  const kit = await loadPlugin(dir);
  try {
    // Old data, as version 1 wrote it, then the code reads it.
    await fs.mkdir(kit.dataDir, { recursive: true });
    await fs.writeFile(path.join(kit.dataDir, 'desk.json'), JSON.stringify({ version: 1, data: { tickets: [{ id: 't1', title: 'Old' }] } }));
    assert.match((await kit.tool('desk_ticket_search', { query: 'old' })).content, /Old/);
    assert.equal(JSON.parse(await fs.readFile(path.join(kit.dataDir, 'desk.json'), 'utf8')).version, 2);
  } finally { await kit.close(); }
});
```

## What to cover

- It loads, and adds what it should (`kit.adds`).
- Each tool: the normal case, each error case (the message says what to do), output size.
- Each route: as the page calls it; bad input answers 4xx; `as: 'anonymous'` is refused for `user` routes.
- A scripted conversation through the main flow.
- Every migration step, from each older version.
- Webhooks: a valid signature is accepted, an invalid one refused.

Then `npm run plugin -- check <dir> --deep` (agents: `plugin_review`) runs the tests as part of the review.
