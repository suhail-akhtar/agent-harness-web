# Patterns

Each pattern is in a working plugin in the harness checkout: `examples/plugins/customer-desk` (a full
app: menu, five pages, a panel, six tools, a sub-agent, a workflow, versioned data, a webhook that puts
an agent to work, a badge, a dashboard source, tests: review score 100), and the template
`npm run plugin -- new` writes (`plugin_new`).

## A complete app

What a plugin needs to feel like part of the app rather than a page bolted on:

| Part | Where |
|---|---|
| A menu of pages, a home | `ui.menu.items`, `ui.home` (MANIFEST.md) |
| Its data | `api.store` with a version (API.md, "Data") |
| Pages on the UI kit, every state handled (loading, empty, error), live on `api.signal` | PAGES.md |
| A count in the sidebar | `ui.badges` + a `badge` route + `navItems[].badge` |
| A side panel next to conversations | `contributes.panels` with `where: "any"` |
| Palette commands, one agents may run | `contributes.commands` (`agent: { description }`) |
| A slash command | `contributes.slashCommands` (`/ticket {args}`) |
| Settings people set | `contributes.settings` (`scope: "account"`), read by pages with `settings.get` |
| Prompts on the home page | `contributes.prompts` |
| The agent's side: tools, a skill, a guide, a sub-agent, a workflow | API.md; `skills/`, `GUIDE.md`, `agents/`, `workflows/` |
| Tests | TESTING.md |

## Using the rest of the harness

A plugin does not have to do everything itself: every tool, MCP server, skill, sub-agent, workflow and
other plugin of the server is there to use.

**From a tool**, through its context (the agent's permissions apply):

```ts
async run(input, ctx) {
  // Another tool: built-in, another plugin's, an MCP server's (mcp__<server>__<tool>).
  if (ctx.toolNames?.().includes('web_search')) {
    const r = await ctx.callTool!('web_search', { query: `${input.product} known issues` });
    if (!r.is_error) notes.push(r.content.slice(0, 2000));
  }
  // A sub-agent with its own prompt and tools (one the plugin registered, or "general").
  const draft = await ctx.runSubagent!({ type: 'desk-writer', description: 'Draft a reply', prompt: `...` });
  // A workflow, waiting for it.
  const run = await ctx.services?.workflows?.run('desk-triage', { focus: 'urgent' }, ctx.signal);
  return draft;
}
```
Check that what you call is there (`ctx.toolNames()`, `ctx.runSubagent`, `ctx.services?.workflows`):
a session may not have it (a test's tool call has no sub-agents). Say what to do when it is missing.

**From server code** (a route, a webhook, a timer), by starting a conversation that has everything
(`permissions.sessions`):

```ts
await api.sessions.start({ title: 'Triage T-12', instructions: 'Triage it with the customer-desk skill.', prompt: ticketText, untrusted: true });
```

**From a page**: hand it to the person's agent: `harness.composer.prefill(text, { newChat: true })`
(they send it), or `harness.sessions.start({ title, prompt })` (they confirm), or a command with a
`prompt` action.

**Another plugin's pages or data**: `harness.registry.has({ plugin: 'aiops' })` before linking to it;
`harness.view.open('aiops:incidents')`; for its data, call its tools from yours (`ctx.callTool`).

## Webhooks from other systems

```ts
api.registerRoute({ method: 'POST', path: 'inbound', auth: 'token', async handler(req) {
  const b = JSON.parse(req.body.toString('utf8') || '{}');
  if (!b.subject) return { status: 400, body: { error: 'subject is required' } };
  // ... store it, then put an agent on it with the text fenced:
  await api.sessions.start({ title: `Triage: ${b.subject}`, instructions: '...', prompt: b.text, untrusted: true });
  return { status: 202, body: { ok: true } };
} });
```
`auth: 'token'`: the administrator gives the calling system the route's token
(`GET /api/plugin-routes`). A service that signs its requests (GitHub, Slack, Stripe): `auth: 'none'`
and check the signature over `req.body` with a secret from `api.secret` (constant-time compare).

## Background work

A timer that checks `api.lease(name)` before each run (one server of several does it), stopped in
`close()`. The desk closes tickets waiting a week; a monitor would poll an API with `api.fetch` and
`api.signal` its pages.

## Dashboards

`contributes.dataSources: [{ id, title, route }]`: the route returns `{ columns, rows }`; people add it
to a dashboard from Dashboards, and agents can build dashboards on it.

## Data that changes shape

Raise `version`, add `migrations[n]` (a pure function from the old document to the new), and test it
from each older version (TESTING.md). Keep the old fields' meaning; never reuse a field for something else.

## Tools agents use well

- Few tools, each a clear verb: `x_create`, `x_search`, `x_get`, `x_update` beats ten narrow ones.
- Search returns one line per item with its id; `get` returns the whole item; the agent chains them.
- Errors name the fix: "No ticket T-9. desk_ticket_search finds ids."
- Enums for closed choices (status, priority): the input check refuses anything else.
- A skill says the order: when to search first, when to ask the person, what never to do.

## Several pages

One HTML file per view, one shared script (`ui/common.js`: the connection, shared components),
`view.open('ticket', { id })` between them, `harness.params.id` on the other side.

## Opened as its own app

Nothing to do: any plugin with a page can be opened as its own window (Plugins > Open as app, or
a desktop shortcut). Give it a `ui.home` and a `ui.menu` so that window has a real start page and
navigation.
