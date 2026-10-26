# The server API

A plugin's `main` default-exports a definition; the harness calls `setup(api)` once when it loads the
plugin (and again on a live reload), and `close()` when it unloads it. Everything the plugin can do at
run time is on `api`: the plugin imports only types from `@harness/plugin-sdk`.

```ts
import type { PluginAPI, PluginDefinition } from '@harness/plugin-sdk';

export default {
  name: 'my-plugin',              // the manifest's name
  async setup(api: PluginAPI) { /* register everything here */ },
  async close() { /* stop timers, close connections */ },
} satisfies PluginDefinition;
```

JavaScript: the same object, typed with JSDoc (`/** @param {import('@harness/plugin-sdk').PluginAPI} api */`).
TypeScript runs as written (Node strips the types): erasable syntax only (no `enum`, `namespace`,
parameter properties), relative imports with their `.ts` extension, `import type` for types.

`setup` may be `async`. A setup that throws loads nothing of the plugin (all or nothing); on a live
reload the version before keeps running.

## Imports: the runtime and other plugins

A plugin imports nothing from the harness by relative path (it must run wherever it is installed). Two
names cover everything; the harness resolves them to where the code is:

```ts
// The harness's own abilities (the same for every plugin, official or custom):
import { defineTool, resolveIn, within, PathError, resolveHome, harnessPaths, readJson, writeFileAtomic, withFileLock,
  run, scrubbedEnv, findBinary, missingMessage, withBrowser, serveDir, runPage, chromiumPath, addLibrary,
  parseCron, CHANGE_KINDS, ChangeError } from '@harness/plugin-sdk/runtime';
// Another plugin's module, by its name (declare "requires": ["games3d"] when that plugin must be on):
import { runJob } from '@harness/plugins/games3d/sdk/jobs.mjs';
```

| From the runtime | What it is |
|---|---|
| `defineTool(def)` | a Tool object from a plain definition (to build tools ahead of `registerTool`) |
| `resolveIn(host, p)`, `within(root, p)`, `PathError` | a path inside a workspace, symlink-safe |
| `resolveHome()`, `harnessPaths()` | the harness home (`~/.harness`) and its folders |
| `readJson(file, fallback)`, `writeFileAtomic(file, data)`, `withFileLock(file, fn)` | files several servers can share safely |
| `run(cmd, args, { timeoutMs, cwd, env })`, `scrubbedEnv()` | a program on the server (prefer `ctx.host.exec` in tools: it runs where the session runs) |
| `findBinary(name)`, `missingMessage(name)`, `installPlaces`, `pathNames` | a program on this machine, and how to install it |
| `withBrowser(fn)`, `serveDir(dir)`, `runPage(o)`, `chromiumPath()`, `frameStats` | the headless browser |
| `addLibrary(dir, name)`, `LIBRARIES` | browser libraries the harness carries (three.js, ...) |
| `parseCron(expr)` | a cron expression as a predicate on dates |
| `CHANGE_KINDS`, `ChangeError` | the change journal's kinds (`api.changes`) |

`npm run plugin -- check --deep` flags any import that leaves the plugin's folder.

## Official and custom plugins

| Tier | What it is |
|---|---|
| official | shipped with the harness (Studio, Operations, Engineering, DevOps, the core's plugins), or signed with a key the operator lists as an official publisher (`HARNESS_OFFICIAL_KEYS`, key ids) |
| custom | everything else: your plugins, a partner's, a folder loaded in the desktop app |

Both have the whole API, the runtime and other plugins' modules; `api.tier` says which one a plugin is,
and the app shows it. A plugin signed by a trusted key (official or not) may draw native UI; others draw
in sandboxed frames.

## api at a glance

| Member | What it does | Needs |
|---|---|---|
| `pluginName`, `pluginDir`, `dataDir` | its name, its folder, its own data folder (outside every workspace) | |
| `tier` | `official` or `custom` | |
| `store(name, opts)` | a versioned JSON document in `dataDir` (see Data) | |
| `registerTool(def)` | a tool agents call | |
| `registerRoute(route)` | an HTTP endpoint `/api/plugins/<name>/<path>` | `permissions.routes` |
| `registerSkills(dir)` | a folder of skills (also the manifest's `"skills"`) | |
| `registerAgent(def)` | a sub-agent type (also the manifest's `"agents"` folder) | |
| `registerWorkflow(def)` | a workflow graph (TypeScript ones may hold code nodes) | |
| `registerGate(gate)` | a quality gate workflows and agents run | |
| `on(event, handler, matcher?)` | an in-process hook (PreToolUse, PostToolUse, ...) | |
| `registerMcpServer(name, cfg)` | an MCP server (also the manifest's `"mcpServers"`) | |
| `registerModel(spec)`, `registerProvider(id, def)` | a model, a model provider | |
| `registerSearchBackend(b)` | a backend for `web_search` | |
| `registerVaultRotation(h)` | rotates key-vault entries for real | |
| `sessions.start/send/respond/get` | start and drive conversations | `permissions.sessions` |
| `events.subscribe(fn)` | every session's events | `permissions.sessions` |
| `fetch(url, init)` | `fetch` to declared hosts only | `permissions.network` |
| `secret(NAME)` | a server environment variable | `permissions.secrets` |
| `vault.list/reveal` | key-vault entries an administrator granted it | `permissions.vault` |
| `signal(name)` | tells open pages (and badges) something changed | |
| `lease(name)` | true on the one server that should run a background loop | |
| `changes` | the harness's change journal | |
| `workspacePath(host, p)` | a path inside the session's workspace (symlink-safe) | |
| `log(msg)` | a line in the server log, prefixed with the plugin's name | |

## Tools

```ts
api.registerTool({
  name: 'notes_add',                         // <plugin>_<verb>: letters, digits, _ (unique across plugins)
  description: 'Save a note. Use when the person asks to remember or note something.',
  parameters: {                              // JSON Schema, type object
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The note, in the person\'s words' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
    },
    required: ['text'],
  },
  kind: 'edit',                              // read | edit | exec | network | external | meta
  sendsOut: false,                           // it keeps everything local
  parallelSafe: false,                       // true: may run beside other calls (reads)
  summarize: (i) => `note "${String(i.text).slice(0, 40)}"`,  // the one line people see
  async run(input, ctx) {
    // ...
    return 'Saved.';                         // or { content, is_error?, images?, display? }
  },
});
```

- **The description is the agent's only manual.** What it does, *when to use it*, what it returns.
- **Input** is checked against `parameters` before `run` (required fields, types, enums); `run`
  still checks meaning (an empty title, an id that does not exist).
- **`kind`** decides when the person is asked: `read` runs freely; `edit` (changes data), `exec`
  (runs commands), `network`/`external` (reaches other systems) follow the person's mode.
- **Errors**: return `{ content: 'what went wrong and what to do', is_error: true }`. A thrown
  exception becomes an error result too, but say what to do.
- **Output**: short. Over ~10K characters, summarize, page (`offset`/`limit` parameters) or cap.
- `defer: false` keeps its schema in every request even when the session loads plugin tools on
  demand (for a tool nearly every turn uses).
- `vaultNames: (input) => ['NAME']`: the vault entries a call reads, checked by the vault's rules.
- `availableIn: (host) => host.kind === 'docker'`: only offered where it can work.

### What `run(input, ctx)` gets

| `ctx.` | What it is |
|---|---|
| `host` | where the session's commands and files are: `host.kind` (`local`, `docker`, `companion`), `host.root` (the workspace folder), `host.exec(cmd, { timeoutMs, cwd?, env?, stdin?, signal? })` → `{ stdout, stderr, code, timedOut }` (sandboxed when the session is) |
| `signal` | aborted when the person stops the turn: pass it to `fetch` and `exec` |
| `callTool(name, input)` | runs any other tool the agent has, as the agent would (permissions, hooks): built-ins (`read`, `bash`, `web_fetch`, `web_search`...), other plugins' tools, MCP tools (`mcp__<server>__<tool>`) → `{ content, is_error? }` |
| `toolNames()` | the tools the agent has (to check before `callTool`) |
| `runSubagent({ description, prompt, type, model?, effort? })` | runs a sub-agent (a registered agent type, e.g. one the plugin registered) and returns its report |
| `askUser(question, options, form?)` | asks the person (a choice, or a form from a JSON Schema) and returns the answer |
| `services.workflows.run(name, input, signal)` / `.start(name, input)` | runs a workflow (waits) or starts one (its outcome reaches the agent later) |
| `services.search.search(query, { max }, signal)` | web search through the server's backend |
| `services.memory` | the session's memory store |
| `services.notify(message)` | tells the person now (a notification) |
| `services.schedules.create({ prompt, cron? \| inMinutes? \| at? })` | schedules a prompt in this session |
| `services.vault` | `reveal(name, purpose)`, `envFor(map, purpose)`, `list()`: only entries the plugin declared |
| `services.charge(what, usd)` | adds a cost the tool incurred to the session's spend |
| `emit(event)` | an event in the session's transcript (e.g. `{ kind: 'notice', level: 'info', text }`) |
| `todos`, `setTodos` | the session's todo list |

`await api.workspacePath(ctx.host, rel)` turns a workspace-relative path into a real one, refusing
paths that leave the workspace. For a session on another computer (`host.kind === 'companion'`),
files are not on the server: use `ctx.callTool('read', { path })` / `ctx.callTool('write', {...})`.

## Data

```ts
interface Doc { items: Item[]; settings: { currency: string } }
const db = api.store<Doc>('main', {
  version: 3,                                // the shape this code reads and writes
  initial: () => ({ items: [], settings: { currency: 'USD' } }),
  migrations: {                              // migrations[n] turns version n-1 into n
    2: (v1) => ({ ...v1, items: v1.items.map((i) => ({ ...i, archived: false })) }),
    3: (v2) => ({ ...v2, settings: { currency: 'USD' } }),
  },
});
const doc = await db.read();                 // upgraded on the first read of old data
await db.update((d) => { d.items.push(item); });   // read-change-write under a lock (edit in place or return a new doc)
await db.write(doc);                         // replace
```

- One JSON file per store in `api.dataDir` (`<name>.json`, `{ version, data }`), written atomically
  under a lock: several servers may share the folder, concurrent updates lose nothing.
- An upgrade keeps the old file beside it (`<name>.v<old>.json`). Data newer than the code, or a
  missing step, is refused and left untouched (the error says which).
- A file the plugin wrote before using `store` (a bare document) is read as version 1.
- Several stores for unrelated data (`'items'`, `'audit'`); keep each under a few MB. For large or
  queried data, use SQLite or files of your own in `api.dataDir`.
- `api.dataDir` is the plugin's alone, kept when the plugin is uninstalled unless the
  administrator deletes it.

## Routes

```ts
api.registerRoute({
  method: 'GET',                             // GET | POST
  path: 'items',                             // /api/plugins/<plugin>/items (letters, digits, . _ - /)
  auth: 'user',                              // user | token | none
  async handler(req) {
    // req: { method, path, query, headers, body: Buffer, ip, user? }
    return { status: 200, body: { items: [] } };   // body: object (JSON), string or Buffer; headers optional
  },
});
```

- `auth: 'user'`: signed in (the app's own pages, a person's token); `req.user` is `{ id?, name, role }`.
  Pages call these with `harness.routes.call(path, { method, body })`.
- `auth: 'token'`: for other systems (webhooks, scripts): the harness makes a secret per route;
  an administrator reads it once at `GET /api/plugin-routes`; callers send `?token=` or the
  `x-harness-route-token` header.
- `auth: 'none'`: every request reaches the handler: check the caller yourself (a webhook's
  signature over `req.body`, with a secret from `api.secret` or the vault).
- Answer every request: 400 with what is missing for bad input, 404 for an unknown id. A thrown
  error is a 500 (a signed-in caller sees its message).
- Bodies up to 1 MB; rate-limited per caller address. Parse JSON yourself: `JSON.parse(req.body.toString('utf8') || '{}')`.
- Reserved paths: `ui/...`, `enable`, `disable`, `reload`.

## Signals and badges

`api.signal('items')` sends a `plugins` event `{ type: 'signal', plugin, name }` to everyone signed in
(at most one per name a second, no data): pages subscribed to `plugins` refresh, and a badge source
with `"signal": true` re-reads its route at once.

## Sessions (start and drive conversations)

Needs `"permissions": { "sessions": true }`.

```ts
const { id } = await api.sessions.start({
  title: 'Triage: ticket 42',
  prompt: ticket.body,                       // from outside: fenced as untrusted data
  instructions: 'Classify this ticket and draft a reply with desk_reply_draft.',  // yours, before it
  untrusted: true,
  model: 'claude-sonnet-5-5',                // default: the server's
  mode: 'dontAsk',                           // default: nobody is watching
  // workflow: { name: 'desk-triage', input: { ticket: '42' } },   // or run a workflow instead
  // owner: accountId,                        // a person's account (default: the operator's)
});
await api.sessions.send(id, 'Also check the customer\'s last order.');
const s = api.sessions.get(id);              // { id, title, owner?, status }
await api.sessions.respond(id, requestId, { decision: 'approve', by: 'slack:U123' });   // answer a pending request
```

A session started this way has every tool, skill, MCP server and plugin the server has: this is how
a plugin's server code puts an agent to work. Anything from outside goes in with `untrusted: true`.

`api.events.subscribe(({ sessionId, owner, title, event }) => {...})` sees every session's events
(tool calls, messages, approvals, the end of a turn); it returns the unsubscribe.

## Sub-agents, workflows, gates

```ts
api.registerAgent({ name: 'desk-triager', description: 'Classifies tickets and drafts replies.',
  prompt: 'You triage support tickets...', tools: ['desk_ticket_get', 'desk_reply_draft', 'web_search'], effort: 'medium' });
```
Or markdown files in the manifest's `"agents"` folder: frontmatter `name`, `description`, `tools`
(comma list), `model`, `effort`; the body is the prompt.

Workflows: JSON files in the manifest's `"workflows"` folder, or `api.registerWorkflow(def)`:

```json
{
  "name": "desk-triage",
  "description": "Triage a ticket: classify, draft a reply, a person approves, then send.",
  "inputs": { "ticket": { "description": "The ticket id", "required": true } },
  "start": "triage",
  "nodes": {
    "triage": { "type": "agent", "agent": "desk-triager", "prompt": "Triage ticket {{input.ticket}}. {{feedback}}", "next": "approve" },
    "approve": { "type": "approval", "message": "Send this reply?\n\n{{state.triage}}", "next": { "on": { "approve": "send", "reject": "triage" } } },
    "send": { "type": "agent", "prompt": "Send the approved reply for {{input.ticket}} with desk_reply_send.", "next": "done" },
    "done": { "type": "end" }
  }
}
```
Node types: `agent`, `gate`, `approval`, `shell`, `branch` (`value` or `when`), `map` (fan out over a
list), `parallel`, `end`, and `code` (TypeScript workflows only). `npm run plugin -- check` validates them.

```ts
api.registerGate({ name: 'desk-schema', description: 'The desk data file is valid',
  async applies(host) { return true; },
  async run({ host, signal }) { const r = await host.exec('node check.mjs', { timeoutMs: 60_000, signal }); return { pass: r.code === 0, summary: r.code === 0 ? 'valid' : 'invalid', details: r.stdout }; } });
```

## Hooks

```ts
api.on('PreToolUse', async (payload, { host }) => {
  if (payload.tool === 'bash' && /rm -rf \//.test(String((payload.input as { command?: string })?.command))) return { block: true, feedback: 'Not that.' };
}, 'bash');      // matcher: a tool name or pattern
```
The payload is `{ event, ...details }` (PreToolUse/PostToolUse: `tool`, `input`). Answer `{ block: true,
feedback }` to stop it (the model sees the feedback), or for PermissionRequest `{ decision: 'allow' | 'deny' }`.
Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
PostToolUseFailure, Notification, SubagentStart, SubagentStop, PreCompact, PostCompact, Stop,
StopFailure, InstructionsLoaded, ConfigChange, FileChanged, WorktreeCreate, WorktreeRemove,
TaskCreated, TaskCompleted. Shell, HTTP and prompt hooks can also be declared in the manifest's
`"hooks"` (MANIFEST.md).

## MCP servers, models, providers, search

```json
"mcpServers": { "tickets": { "command": "node", "args": ["mcp/server.mjs"], "env": { "API_KEY": "${TICKETS_KEY}" } } }
```
`${VAR}` expands only for variables in `permissions.secrets`. Its tools reach agents as `mcp__tickets__<tool>`.
`api.registerProvider(id, { keyEnv, create(apiKey, { baseUrl }) => Provider, listModels? })` and
`api.registerModel(spec)` add model providers; `api.registerSearchBackend({ name, available, search })`
a web search backend.

## Network, secrets, vault

- `api.fetch(url, init)`: only to `permissions.network` hosts (`"api.example.com"`, `"*.example.com"`);
  redirects re-checked; private addresses only when declared exactly. Plain `fetch` bypasses this:
  the review flags it. Where the address is the operator's own (an internal service named in its
  configuration, not by the model), put `// harness-review: fetch-ok <why>` on the line above the
  call: the review shows it as a note with that reason instead of a warning.
- `api.secret('NAME')`: a server environment variable named in `permissions.secrets` (throws otherwise).
- `api.vault.reveal(name, purpose)`: an operator-scope vault entry an administrator granted
  `plugin:<name>`, matched by `permissions.vault` globs; audited; values are hidden in transcripts.

## Background work

```ts
let timer: NodeJS.Timeout | undefined;
export default { name: 'poller', setup(api) {
  timer = setInterval(async () => { if (!(await api.lease('poll'))) return; /* one server does it */ }, 60_000);
}, close() { clearInterval(timer); } };
```
`api.lease(name)` is true on one server of several sharing a data folder (and false where background
work is off: evals, the CLI). Always stop what you start in `close()`: a live reload calls it.

## Live reload

While a plugin folder is loaded in the desktop app, saving a file reloads it: a page edit reloads its
pages; a code edit reloads the plugin in the engine (`POST /api/plugins/<name>/reload`): the new
`setup` runs, the old version's `close` after it, and open conversations keep their tools (the new
code runs for them). A version that fails to load leaves the old one running and says why.
