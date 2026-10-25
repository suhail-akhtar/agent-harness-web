# Build your first plugin

A plugin adds things to the harness: tools the agent can call, skills (procedures it follows),
sub-agents, workflows, quality gates, HTTP routes, and pages in the desktop app. Everything the
built-in features do goes through the same calls, so a plugin can do as much as they do.

This guide builds one plugin end to end, **`reading-list`**: a tool that saves links with notes, a
tool that lists them, a skill that tells the agent when to use them, and a page in the desktop app
that shows the list. Each step says how to check it before going on.

The full reference is in the [README's Plugins section](../README.md#plugins) and, for pages,
[docs/desktop/DESIGN.md](desktop/DESIGN.md) section 4. Working examples: `examples/plugins/acme`
(tool, gate, hook, agent, skill) and `examples/plugins/hello-frame` (route and pages).

## 1. The folder and the manifest

A plugin is a folder with a `harness-plugin.json`. The name is lowercase letters, digits and dashes.

```
reading-list/
  harness-plugin.json
  index.mjs
  skills/reading-list/SKILL.md
  ui/index.html
```

```json
{
  "name": "reading-list",
  "version": "0.1.0",
  "description": "Saves links with a note and lists them; a page in the desktop app shows the list.",
  "main": "index.mjs",
  "skills": "skills",
  "permissions": { "routes": true }
}
```

- `main` is the code that runs in the server. Leave it out for a plugin that is only skills, agents,
  workflows or pages.
- `permissions` declares what the code may reach: `network` (hosts for `api.fetch`), `secrets`
  (environment variables for `api.secret`), `routes` (HTTP endpoints), `sessions` (start and drive
  conversations), `vault` (key vault entries). Anything not declared is refused.

## 2. A tool

`index.mjs` exports the plugin. It imports nothing from the harness: the `api` object passed to
`setup` has everything, so the plugin works wherever it is installed.

```js
import fs from 'node:fs/promises';
import path from 'node:path';

export default {
  name: 'reading-list',
  setup(api) {
    // The plugin's own folder on the server, outside every workspace: no agent can edit it.
    const file = path.join(api.dataDir, 'links.json');
    const load = async () => JSON.parse(await fs.readFile(file, 'utf8').catch(() => '[]'));
    const save = async (links) => { await fs.mkdir(api.dataDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(links, null, 2)); };

    api.registerTool({
      name: 'reading_list_add',
      description: 'Save a link to the reading list with a short note on why it is worth reading. Use it when the person asks to keep, save or bookmark a link.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'An http or https URL' },
          note: { type: 'string', description: 'One line: why it is worth reading' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['url'],
      },
      // 'edit': it changes something, so it is asked about in "Ask first" mode. 'read' runs freely.
      kind: 'edit',
      sendsOut: false,
      summarize: (i) => `save ${i.url}`,
      async run({ url, note = '', tags = [] }) {
        if (!/^https?:\/\/\S+$/.test(String(url))) return { content: `Not an http(s) URL: ${url}`, is_error: true };
        const links = await load();
        if (links.some((l) => l.url === url)) return `Already saved: ${url}`;
        links.unshift({ url, note, tags, savedAt: new Date().toISOString() });
        await save(links);
        api.signal('links'); // tells open pages to refresh (step 5)
        return `Saved ${url} (${links.length} on the list).`;
      },
    });

    api.registerTool({
      name: 'reading_list_list',
      description: 'The saved links, newest first, optionally only those with a tag.',
      parameters: { type: 'object', properties: { tag: { type: 'string' } } },
      kind: 'read',
      parallelSafe: true,
      sendsOut: false,
      async run({ tag }) {
        const links = (await load()).filter((l) => !tag || l.tags.includes(tag));
        return links.length ? links.map((l) => `- ${l.url}${l.note ? ` - ${l.note}` : ''}`).join('\n') : 'The reading list is empty.';
      },
    });
  },
};
```

What matters in a tool:

- **The description is the agent's only manual.** Say what it does and *when to use it*. Name the
  parameters plainly and describe each one.
- **`kind`** decides permissions: `read` runs freely; `edit`, `exec`, `network` and `external` are
  asked about depending on the person's mode.
- **`sendsOut: false`** for a tool that keeps everything local. A plugin that declares network hosts
  is otherwise treated as able to send data out, and its tools are confirmed after the agent has
  read untrusted content.
- **Errors**: return `{ content, is_error: true }` with what went wrong and what to do instead. The
  agent reads it and tries again; a thrown exception becomes an error result too.
- Return a string, or `{ content, is_error?, images? }`. Keep it short: long output costs tokens on
  every later step.
- `run(input, ctx)` also gets `ctx.host` (where the session's commands run: `ctx.host.exec`,
  files), and `api.workspacePath(ctx.host, p)` resolves a path safely inside the workspace.

**Check it:**

```bash
npm run plugin -- check path/to/reading-list
```

It loads the plugin the way the server does and lists what it adds, or the problem (a manifest
error, code that throws, a broken workflow, a bad `ui` section). Exit code 1 on a problem.

## 3. A skill

A skill is a Markdown file the agent loads when its description matches the task. Use one for a
procedure: steps, rules, the order to use your tools in.

`skills/reading-list/SKILL.md`:

```markdown
---
name: reading-list
description: Keep and recall the person's reading list. Use when they share a link to read later, ask what they saved, or want reading suggestions from it.
---
# Reading list

1. A link to keep: save it with reading_list_add and a one-line note in your own words (what it is, why it matters to them). Add tags only when they are obvious (a language, a topic).
2. "What did I save about X": reading_list_list with the tag if there is one, else list all and pick the matching ones.
3. Never invent links. If the list is empty, say so.
```

## 4. Try it in a conversation

**On the desktop app:** copy the folder into `~/.harness/plugins/` (Windows:
`%USERPROFILE%\.harness\plugins\reading-list`), then restart the engine (Settings > Application > Engine >
Restart). The plugin appears under **Plugins**. Ask in a new chat: "save
https://example.com/article, it explains caching well".

**On a server or from the command line:** point `HARNESS_PLUGINS` at the folder (several:
separated by `;` on Windows, `:` elsewhere):

```bash
HARNESS_PLUGINS=path/to/reading-list npm run cli -- --model deepseek-flash --runtime local --dir ./scratch "save https://example.com/a and tell me what is on my list"
```

The output shows each tool call and its result. If the agent does not use your tool, its
description does not say clearly enough when to.

## 5. A page in the desktop app

Pages run in a sandboxed frame. They have no network and reach the app only through its SDK, and
only for the capabilities the manifest declares (the person is asked once). A page gets its data
from the plugin's own route.

Add a route in `setup` (needs `"permissions": { "routes": true }`):

```js
    api.registerRoute({
      method: 'GET', path: 'links', auth: 'user',
      async handler() { return { status: 200, body: { links: await load() } }; },
    });
```

`auth: 'user'` means only someone signed in to this server can call it (the app's own pages are).
Use `'token'` for other systems calling in and `'none'` only when you check the caller yourself.

Add the `ui` section to `harness-plugin.json`:

```json
  "ui": {
    "apiVersion": 1,
    "displayName": "Reading list",
    "icon": "bookmark",
    "capabilities": ["routes.call"],
    "contributes": {
      "navItems": [{ "id": "reading-list", "title": "Reading list", "icon": "bookmark", "view": "list" }],
      "views": [{ "id": "list", "title": "Reading list", "icon": "bookmark", "kind": "frame", "entry": "ui/index.html" }]
    }
  }
```

`ui/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="harness://app/sdk/plugin-ui.js"></script>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; background: var(--hx-bg); color: var(--hx-text-primary); }
  a { color: var(--hx-accent-text); } .muted { color: var(--hx-text-muted); }
  li { margin: 6px 0; }
</style>
</head>
<body>
<h1>Reading list</h1>
<ul id="list"><li class="muted">Loading…</li></ul>
<script>
HarnessPluginUI.connect().then(async (harness) => {
  const list = document.getElementById('list');
  const show = async () => {
    const { links } = await harness.routes.call('links');
    list.replaceChildren(...(links.length ? links : [null]).map((l) => {
      const li = document.createElement('li');
      if (!l) { li.className = 'muted'; li.textContent = 'Nothing saved yet. Ask the agent to save a link.'; return li; }
      const a = Object.assign(document.createElement('a'), { href: '#', textContent: l.url });
      a.onclick = (e) => { e.preventDefault(); harness.browser.open(l.url); };
      li.append(a, l.note ? ` - ${l.note}` : '');
      return li;
    }));
  };
  await show();
  // api.signal('links') on the server: refresh without polling.
  await harness.events.subscribe('plugins', (e) => { if (e && e.type === 'signal' && e.name === 'links') show(); });
}).catch((e) => { document.body.textContent = 'This page runs inside the app: ' + e.message; });
</script>
</body>
</html>
```

- Icons (`icon` on the plugin, nav items, views, commands) are names from the app's set: `activity`, `alert`, `apps`, `archive`, `arrow-down`, `arrow-left`, `arrow-right`, `arrow-up`, `atom`, `bell`, `bolt`, `book`, `bookmark`, `bot`, `box`, `brain`, `bug`, `calculator`, `calendar`, `chart`, `chat`, `check`, `clock`, `cloud`, `code`, `command`, `compass`, `copy`, `cpu`, `database`, `dollar`, `download`, `edit`, `external`, `eye`, `file`, `file-text`, `files`, `filter`, `flask`, `folder`, `folder-open`, `folder-plus`, `function`, `git`, `git-branch`, `git-pr`, `globe`, `grid`, `heart`, `help`, `history`, `home`, `image`, `inbox`, `info`, `key`, `keyboard`, `layers`, `library`, `link`, `list`, `lock`, `mail`, `map`, `memory`, `monitor`, `moon`, `palette`, `panel-right`, `paperclip`, `pause`, `pin`, `play`, `plug`, `plus`, `puzzle`, `refresh`, `robot`, `rocket`, `save`, `search`, `server`, `settings`, `share`, `shield`, `sidebar`, `sparkles`, `stack`, `star`, `stop`, `sun`, `table`, `tag`, `terminal`, `trash`, `upload`, `user`, `users`, `vault`, `warning`, `workflow`, `wrench`, `x`, `zap`. An unknown name is shown as `puzzle`, and `npm run plugin -- check` warns with the nearest names.
- The theme's colours are CSS variables (`--hx-bg`, `--hx-text-primary`, `--hx-text-muted`,
  `--hx-accent`, `--hx-border`, ...): use them and the page follows light and dark.
- `harness.browser.open` needs the `browser.open` capability, `events.subscribe` needs
  `events.subscribe`: add each one you call to `capabilities`.
- What the SDK offers: `routes.call`, `sessions.list/get/start/send`, `events.subscribe`,
  `approvals.list/respond`, `files.list/read`, `workflows.list/start`, `settings.get/set`,
  `view.open`, `notify.toast`, `badge.set`, `composer.prefill`, `frame.resize`, `storage.get/set`,
  `clipboard.write`, `browser.open`, `external.open`. A call the page was not granted fails with
  the reason.
- Other things a `ui` section can add: session panels, slash commands, commands for the palette,
  settings sections from a JSON Schema, renderers for a code-fence language, home cards, status
  items, themes and prompts. See DESIGN.md section 4.

While you work on the page, **Plugins > Load a plugin folder…** in the desktop app loads only its
UI half from your folder and reloads it as you edit. The server half (tools, routes) still comes
from `~/.harness/plugins` or `HARNESS_PLUGINS`.

## 6. More you can add

| To add | How |
|---|---|
| A sub-agent | `agents/<name>.md` with frontmatter `name`, `description`, `tools`, optional `model`, `effort`; the prompt as the body. Manifest: `"agents": "agents"`. |
| A workflow | `workflows/<name>.json` (manifest `"workflows": "workflows"`) or `api.registerWorkflow(def)`: a graph of agent, gate, approval, branch, map, shell and end nodes. See the README's Workflows section. `npm run plugin -- check` validates each graph. |
| A quality gate | `api.registerGate({ name, description, applies?, run })` returning `{ pass, summary, details? }`. Workflows run gates to prove work is right. |
| A hook | `api.on('PreToolUse', handler, 'bash')`: return `{ block: true, feedback }` to stop a call. |
| An MCP server | `"mcpServers"` in the manifest, Claude Code's format. |
| A guide for agents | `ui.guide: "GUIDE.md"`: desktop sessions list the plugin and load its guide when needed. |

## 7. Before you share it

- `npm run plugin -- check <dir>` says OK.
- Every tool's description says when to use it; every parameter is described.
- Errors tell the agent what to do next.
- The plugin declares only the permissions it uses.
- A page uses the theme variables and works in light and dark.
- To distribute it signed: `npm run plugin -- keygen <name>`, then `sign <dir> --key <name>.key.pem`
  and `pack <dir>` for a catalogue (README, "Signed plugins and the catalogue").
