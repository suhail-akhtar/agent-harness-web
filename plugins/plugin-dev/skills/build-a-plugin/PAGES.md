# Pages

A page (a `frame` view, panel, renderer or home card) is the plugin's own HTML, run in a sandboxed frame
of the desktop app: an opaque origin, **no network**, nothing but its own files and the SDK. It reaches
the app through the SDK, and only for the capabilities its manifest declares (the person is asked once).
Its data comes from the plugin's own routes.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="harness://app/sdk/plugin-ui.css">   <!-- the UI kit's styles -->
<script src="harness://app/sdk/plugin-ui.js"></script>           <!-- the SDK: window.HarnessPluginUI -->
<title>Tickets</title>
</head>
<body class="hx">
<div id="root"></div>
<script src="app.js"></script>                                     <!-- its own scripts, from its folder -->
</body>
</html>
```

Allowed: its own files (scripts, styles, images, fonts under the plugin folder), inline scripts and
styles, `data:`/`blob:` images, images from `https:`. Not allowed: scripts or styles from the web
(copy a library into the folder), `fetch`/`XMLHttpRequest`/`WebSocket` (no network: use routes),
forms that post, nested frames.

## The SDK

```js
HarnessPluginUI.connect().then(async (harness) => {
  harness.plugin; harness.contribution; harness.params; harness.capabilities; harness.context;
  const data = await harness.routes.call('items');                       // GET /api/plugins/<plugin>/items
  await harness.routes.call('items', { method: 'POST', body: { title } });
  await harness.events.subscribe('plugins', (e) => { if (e?.type === 'signal' && e.plugin === harness.plugin && e.name === 'items') reload(); });
}).catch((e) => { document.body.textContent = 'This page runs inside the Harness app: ' + e.message; });
```

`connect()` resolves once the app answers; it applies the theme's CSS variables to the page and keeps
them current. A call the page was not granted fails with the reason; check `harness.capabilities`.

| Call | Capability | |
|---|---|---|
| `routes.call(path, { method?, body?, query? })` | `routes.call` | the plugin's own routes, as the signed-in person; `query` (`{ q: 'login' }`) becomes `req.query`; resolves with the parsed body, throws with the route's `error` |
| `events.subscribe(topic, fn, filter?)` → unsubscribe | `events.subscribe` | live events: `sessions`, `session`, `approvals`, `schedules`, `plugins` (`{ type: 'signal' \| 'changed', plugin \| name, ... }`), `notices` |
| `sessions.list({ query?, limit? })`, `.get(id)`, `.history(id, { after?, limit? })` | `sessions.read` | the person's conversations |
| `sessions.start({ title, prompt?, model? })` → `{ id }`, `sessions.send(id, text)` | `sessions.start` | a new conversation with every tool, skill and plugin (the person confirms each); the app opens it |
| `workflows.list()`, `workflows.start(name, input)` | `workflows.start` | the start dialog (the person confirms) |
| `approvals.list()`, `approvals.respond(sessionId, requestId, decision, feedback?)` | `approvals.respond` | only right after the person clicks in the page |
| `files.list({ session?, path? })`, `files.read({ session?, path })` | `files.read` | a conversation's workspace (default: the open one) |
| `settings.get(key?)`, `settings.set(key, value)` | `settings.read`, `settings.write` | its own settings (the keys its `settings` contribution declares: `app` scope on this computer, `account` scope on the server) |
| `clipboard.write(text)` | `clipboard.write` | after a click |
| `browser.open(url)` | `browser.open` | the built-in browser (or the system's) |
| `external.open(url)` | `external.open` | the system browser, after a click |
| `view.open(view, params?)`, `panel.open(panel)` | none | navigates the app (`<id>` of its own, or `<plugin>:<id>`) |
| `notify.toast(text, { kind? })` | none | `info`, `success`, `warning`, `error` |
| `composer.prefill(text, { newChat? })` | none | puts text in the composer for the person to send: the simplest way to hand work to the agent |
| `badge.set(name, value)` | none | a count on its nav item (`<plugin>.<name>`): number, short text or `null` |
| `storage.get(key)`, `storage.set(key, value)` | none | small values on this computer (200 keys, 256 KB each) |
| `frame.resize(height?)` | none | a frame that is not full-page sizes itself to its content |
| `registry.has({ plugin \| view \| panel \| renderer \| command })`, `registry.list(kind)` | none | what else is installed and on |
| `render.show({ fence, source, rect })`, `render.hide()` | none | draws a block with the app's renderer (e.g. `diagram`, `chart`) over part of the page |
| `theme.vars`, `theme.onChange(fn)` | none | the theme's variables |

Declare every capability a page calls, and none it does not: the review checks both.

`harness.params` are the view's route params (`view.open('ticket', { id: '42' })` → `{ id: '42' }`);
`harness.context` is what the host passes (for a panel next to a conversation, which one).

## The UI kit

`plugin-ui.css` gives the app's look as classes on the theme's variables (light, dark and the person's
accent follow with no work). `HarnessPluginUI.ui` builds the same markup from code, setting text as
text (never HTML), so a page needs no framework.

```js
const { ui } = HarnessPluginUI;
const view = ui.view(document.getElementById('root'), { tab: 'open', rows: null }, (s, set) =>
  ui.page({ title: 'Tickets', subtitle: 'Open and waiting tickets', actions: [ui.button('New ticket', { kind: 'primary', onClick: create })] },
    ui.grid({ min: 160 }, ui.stat({ label: 'Open', value: 12 }), ui.stat({ label: 'Due today', value: 3, tone: 'warning' })),
    ui.section('Queue',
      ui.tabs([{ id: 'open', label: 'Open', count: 12 }, { id: 'done', label: 'Done' }], s.tab, (tab) => set({ tab })),
      s.rows ? ui.table({ columns, rows: s.rows, onRowClick: (r) => harness.view.open('ticket', { id: r.id }) }) : ui.loading())));
view.set({ rows });   // draws again
```

| Component | Returns |
|---|---|
| `ui.h(tag, props?, ...children)` | any element; props: `class`, `style` (string or object), `dataset`, `on<Event>` handlers, attributes |
| `ui.mount(root, ...nodes)` | replaces what `root` shows |
| `ui.view(root, state, render)` → `{ state, set(patch), refresh() }` | a part that draws itself again on `set` |
| `ui.page({ title, subtitle?, actions?, wide? }, ...children)` | the page frame with its header |
| `ui.section(title \| null, ...children)`, `ui.card({ title?, onClick? } \| null, ...)`, `ui.grid({ min? }, ...)`, `ui.row(...)` | layout |
| `ui.stat({ label, value, delta?, tone? })` | a number with its label |
| `ui.table({ columns: [{ key, label, num?, sort?, width?, render? }], rows, onRowClick?, empty?, sortBy? })` | a table, sortable by columns with `sort` |
| `ui.list(items, { title, detail?, right?, onClick?, empty? })` | rows with a title and detail |
| `ui.tabs(items, active, onChange)` | tabs |
| `ui.form({ fields: [{ name, label, type?, options?, required?, help?, placeholder?, value?, validate? }], submitLabel?, onSubmit, onCancel? })` | a form; values typed (numbers, booleans); required and `validate` checked first |
| `ui.dialog({ title, body, actions? })` → `{ close }`, `ui.confirm({ title, text?, confirm?, danger? })` → `Promise<boolean>` | dialogs |
| `ui.button(label, { kind?: primary \| ghost \| danger, size?: 'sm', onClick?, disabled?, title? })` | a button |
| `ui.badge(text, tone?)`, `ui.callout(text, tone?)`, `ui.progress(0..1)` | status |
| `ui.empty({ title, detail?, action? })`, `ui.loading(text?)`, `ui.error(e, retry?)` | the states every page needs |
| `ui.relTime(date)`, `ui.fmtNumber(n, opts?)` | "3 min ago", "1,234.5" |

Tones: `success`, `warning`, `danger`, `info`, `accent`, `neutral`. Field types: `text`, `number`,
`textarea`, `select`, `checkbox`, `date`, `email`, `url`, `password`.

Classes for hand-written markup: `hx-page`, `hx-header`, `hx-h1`/`hx-h2`/`hx-h3`, `hx-muted`, `hx-small`,
`hx-mono`, `hx-code`, `hx-pre`, `hx-row`, `hx-col`, `hx-grid`, `hx-section`, `hx-card` (`hx-interactive`),
`hx-stat`, `hx-list`, `hx-btn` (`hx-primary`, `hx-ghost`, `hx-danger`, `hx-sm`), `hx-input`, `hx-select`,
`hx-textarea`, `hx-field`, `hx-check`, `hx-tabs`/`hx-tab`, `hx-badge`, `hx-callout`, `hx-empty`,
`hx-loading`/`hx-spinner`, `hx-progress`, `hx-table-wrap`/`hx-table`, `hx-dialog-scrim`/`hx-dialog`.
Theme variables for your own styles: `--hx-bg`, `--hx-surface`, `--hx-elevated`, `--hx-text-primary`,
`--hx-text-secondary`, `--hx-text-muted`, `--hx-border`, `--hx-border-subtle`, `--hx-accent`,
`--hx-accent-hover`, `--hx-accent-soft`, `--hx-accent-text`, `--hx-on-accent`, `--hx-hover`, `--hx-active`,
`--hx-focus`, `--hx-success`, `--hx-warning`, `--hx-danger`, `--hx-info`, `--hx-code-bg`, `--hx-font`,
`--hx-font-mono`.

## Patterns

- **Every state**: loading (`ui.loading()`), empty (`ui.empty` with what to do), error (`ui.error(e, retry)`).
- **Refresh without polling**: the server calls `api.signal('items')` after a change; the page
  subscribes to `plugins` and reloads on that signal.
- **Hand work to the agent**: `harness.composer.prefill('Draft replies to the open tickets', { newChat: true })`
  (no capability, the person sends it), or `sessions.start` (asked each time) for a ready conversation.
- **Several pages**: one HTML file per view, sharing scripts (`<script src="common.js">`); `view.open`
  between them with params.
- **Big data**: page it in the route (`?offset=&limit=`), not in the page.
- **A library**: copy it into the folder (`ui/vendor/chart.min.js`) and load it with `<script src>`.
