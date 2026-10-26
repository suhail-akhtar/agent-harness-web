import fs from 'node:fs/promises';
import path from 'node:path';
import { HARNESS_VERSION } from './bundle.ts';

// `npm run plugin -- new <name>`: a complete plugin that works as written, to change into the real one.
// It shows every part a full plugin has: tools the agent calls, versioned data (api.store), routes its
// page reads and writes (signed-in, per person), a skill, a guide for agents, a page built from the UI
// kit that follows the theme and refreshes on api.signal, an "ask the agent" handoff, and tests on the
// test kit (tools, routes, a scripted conversation). TypeScript by default (Node runs it as written:
// erasable syntax only); --js writes the same in JavaScript with JSDoc types.

export interface ScaffoldOptions {
  /** Plain JavaScript (index.mjs, JSDoc types) instead of TypeScript. */
  js?: boolean;
  /** The harness checkout (for tsconfig paths to the SDK and its types). */
  repoRoot: string;
  /** The page's title (default: from the name). */
  title?: string;
}

const titleOf = (name: string) => name.split(/[-_.]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');

export function scaffoldFiles(name: string, o: ScaffoldOptions): Record<string, string> {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error(`"${name}" is not a plugin name: lowercase letters, digits and dashes, starting with a letter`);
  const title = o.title ?? titleOf(name);
  const p = name.replace(/-/g, '_');
  const ext = o.js ? 'mjs' : 'ts';
  const sdk = path.join(o.repoRoot, 'packages', 'plugin-sdk', 'src').split(path.sep).join('/');
  const files: Record<string, string> = {};

  files['harness-plugin.json'] = `${JSON.stringify({
    name, version: '0.1.0',
    description: `${title}: a list of items the agent and you keep together. Tools to add, list and finish items; a page in the desktop app.`,
    displayName: title, icon: 'icon.svg', category: 'Productivity', tags: ['lists', 'tasks'],
    publisher: { name: 'Your name or company', url: 'https://example.com' },
    license: 'MIT',
    links: { homepage: 'https://example.com', support: 'mailto:support@example.com' },
    changelog: 'CHANGELOG.md',
    engines: { harness: `>=${HARNESS_VERSION}` },
    main: `index.${ext}`,
    skills: 'skills',
    permissions: { routes: true },
    ui: {
      apiVersion: 1, displayName: title, icon: 'list', guide: 'GUIDE.md',
      capabilities: ['routes.call', 'events.subscribe'],
      contributes: {
        navItems: [{ id: name, title, icon: 'list', view: 'home' }],
        views: [{ id: 'home', title, icon: 'list', kind: 'frame', entry: 'ui/index.html', description: `The ${title.toLowerCase()} items, open and done` }],
        commands: [{ id: 'open', title: `Open ${title}`, icon: 'list', action: { type: 'open-view', view: 'home' } }],
      },
    },
  }, null, 2)}\n`;

  const typesTs = `export interface Item {
  id: string;
  title: string;
  notes: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
}
export interface Data { items: Item[] }
`;
  const body = (ts: boolean) => {
    const t = (s: string) => (ts ? s : '');
    return `${ts ? `import type { PluginAPI, PluginDefinition, PluginRouteRequest } from '@harness/plugin-sdk';
import type { Data, Item } from './types.ts';
` : `/** @typedef {import('./types.mjs').Item} Item */
/** @typedef {import('./types.mjs').Data} Data */
`}
// ${title}: the server half. Everything it needs comes through \`api\` (no other imports from the
// harness), so it runs wherever it is installed. docs/plugin-sdk/README.md has the whole API.

const plugin = {
  name: '${name}',
  ${ts ? 'setup(api: PluginAPI)' : '/** @param {import(\'@harness/plugin-sdk\').PluginAPI} api */\n  setup(api)'} {
    // The plugin's data: one JSON document, versioned. When its shape changes, raise \`version\` and add
    // a step to \`migrations\` (migrations[2] turns version 1 into 2); old data is upgraded on first read.
    const db = api.store${t('<Data>')}('items', { version: 1, initial: () => ({ items: [] }) });
    const newId = () => Math.random().toString(36).slice(2, 10);
    const line = (i${t(': Item')}) => \`\${i.done ? '[x]' : '[ ]'} \${i.id} \${i.title}\${i.notes ? \` - \${i.notes}\` : ''}\`;
    const changed = () => api.signal('items'); // open pages refresh at once (they subscribe to it)

    api.registerTool({
      name: '${p}_add',
      description: 'Add an item to the ${title.toLowerCase()} list. Use when the person asks to note, track or remember something to do. Returns the new item with its id.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short title, a few words' },
          notes: { type: 'string', description: 'Optional detail: why, links, context' },
        },
        required: ['title'],
      },
      kind: 'edit', // it changes something: asked about in "Ask first" mode
      sendsOut: false,
      summarize: (i) => \`add "\${i.title}"\`,
      async run(input) {
        const title = String(input.title ?? '').trim();
        if (!title) return { content: 'The title is empty: give the item a short title.', is_error: true };
        const item${t(': Item')} = { id: newId(), title, notes: String(input.notes ?? '').trim(), done: false, createdAt: new Date().toISOString() };
        await db.update((d) => { d.items.unshift(item); });
        changed();
        return \`Added \${line(item)}\`;
      },
    });

    api.registerTool({
      name: '${p}_list',
      description: 'The ${title.toLowerCase()} items, open ones first. Use before answering what is on the list, or to find an item\\'s id.',
      parameters: { type: 'object', properties: { include_done: { type: 'boolean', description: 'Also the finished items (default false)' } } },
      kind: 'read',
      parallelSafe: true,
      sendsOut: false,
      async run(input) {
        const { items } = await db.read();
        const shown = items.filter((i) => input.include_done === true || !i.done);
        return shown.length ? shown.map(line).join('\\n') : (items.length ? 'Nothing open: every item is done.' : 'The list is empty.');
      },
    });

    api.registerTool({
      name: '${p}_done',
      description: 'Mark an item finished, by its id (from ${p}_list). Use when the person says it is done.',
      parameters: { type: 'object', properties: { id: { type: 'string', description: 'The item\\'s id' } }, required: ['id'] },
      kind: 'edit',
      sendsOut: false,
      async run(input) {
        let found${t(': Item | undefined')};
        await db.update((d) => { found = d.items.find((i) => i.id === input.id); if (found) { found.done = true; found.doneAt = new Date().toISOString(); } });
        if (!found) return { content: \`No item with id \${input.id}. Call ${p}_list to see the ids.\`, is_error: true };
        changed();
        return \`Done: \${line(found)}\`;
      },
    });

    // The page's routes: auth 'user' (signed in, as the app's own pages are). GET reads, POST changes.
    const json = (status${t(': number')}, body${t(': unknown')}) => ({ status, body: body${t(' as object')} });
    const parse = (req${t(': PluginRouteRequest')}) => { try { return JSON.parse(req.body.toString('utf8') || '{}'); } catch { return {}; } };

    api.registerRoute({
      method: 'GET', path: 'items', auth: 'user',
      async handler() {
        const { items } = await db.read();
        return json(200, { items, open: items.filter((i) => !i.done).length, done: items.filter((i) => i.done).length });
      },
    });
    api.registerRoute({
      method: 'POST', path: 'items', auth: 'user',
      async handler(req) {
        const b = parse(req);
        const title = typeof b.title === 'string' ? b.title.trim() : '';
        if (!title) return json(400, { error: 'A title is required.' });
        const item${t(': Item')} = { id: newId(), title, notes: typeof b.notes === 'string' ? b.notes.trim() : '', done: false, createdAt: new Date().toISOString() };
        await db.update((d) => { d.items.unshift(item); });
        changed();
        return json(201, { item });
      },
    });
    api.registerRoute({
      method: 'POST', path: 'items/toggle', auth: 'user',
      async handler(req) {
        const { id } = parse(req);
        let item${t(': Item | undefined')};
        await db.update((d) => { item = d.items.find((i) => i.id === id); if (item) { item.done = !item.done; item.doneAt = item.done ? new Date().toISOString() : undefined; } });
        if (!item) return json(404, { error: \`No item \${id}.\` });
        changed();
        return json(200, { item });
      },
    });
    api.registerRoute({
      method: 'POST', path: 'items/delete', auth: 'user',
      async handler(req) {
        const { id } = parse(req);
        let gone = false;
        await db.update((d) => { const n = d.items.length; d.items = d.items.filter((i) => i.id !== id); gone = d.items.length < n; });
        if (!gone) return json(404, { error: \`No item \${id}.\` });
        changed();
        return json(200, { ok: true });
      },
    });
  },
}${ts ? ' satisfies PluginDefinition' : ''};

export default plugin;
`;
  };
  files[`index.${ext}`] = body(!o.js);
  if (o.js) files['types.mjs'] = `// The data's shape, for JSDoc types in index.mjs (the file exports nothing at run time).\n/**\n * @typedef {{ id: string, title: string, notes: string, done: boolean, createdAt: string, doneAt?: string }} Item\n * @typedef {{ items: Item[] }} Data\n */\nexport {};\n`;
  else files['types.ts'] = typesTs;

  files[`skills/${name}/SKILL.md`] = `---
name: ${name}
description: Keep the person's ${title.toLowerCase()} list. Use when they ask to note, track or remember something to do, ask what is on the list, or say something is done.
---
# ${title}

1. Something to do: ${p}_add with a short title (a few words, in their words) and notes only when they gave detail.
2. "What is on my list": ${p}_list, then answer from it. Never invent items.
3. "X is done": ${p}_list to find its id, then ${p}_done with it. Several match: ask which.
4. The list is also a page in the app (${title} in the sidebar): mention it when they want to see it all.
`;

  files['GUIDE.md'] = `# ${title}

What it does: a list of items the agent and the person keep together, shown on the ${title} page.

- Tools: \`${p}_add\` (title, notes), \`${p}_list\` (include_done), \`${p}_done\` (id).
- Data: kept on this computer by the plugin (api.store "items", version 1).
- The page: sidebar > Custom > ${title}; it refreshes as items change.
- Use the ${name} skill for the steps.
`;

  files['ui/index.html'] = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="harness://app/sdk/plugin-ui.css">
<script src="harness://app/sdk/plugin-ui.js"></script>
<title>${title}</title>
</head>
<body class="hx">
<div id="root"></div>
<script src="app.js"></script>
</body>
</html>
`;

  files['ui/app.js'] = `// ${title}'s page: built from the UI kit (HarnessPluginUI.ui), so it looks like the app and follows its
// theme. It reads and changes the items through the plugin's own routes and refreshes when the server
// signals a change. docs/plugin-sdk/UI.md lists every component and call.
const { ui } = HarnessPluginUI;
const root = document.getElementById('root');

HarnessPluginUI.connect().then(async (harness) => {
  const view = ui.view(root, { tab: 'open', data: null, error: null }, (s, set) => {
    if (s.error) return ui.page({ title: '${title}' }, ui.error(s.error, load));
    if (!s.data) return ui.page({ title: '${title}' }, ui.loading());
    const { items, open, done } = s.data;
    const shown = items.filter((i) => (s.tab === 'open' ? !i.done : s.tab === 'done' ? i.done : true));
    return ui.page({
      title: '${title}',
      subtitle: 'Items you and the agent keep. Ask the agent to add or finish one, or add one here.',
      actions: [
        ui.button('Ask the agent', { onClick: () => harness.composer.prefill('Look at my ${title.toLowerCase()} list and suggest what to do first.', { newChat: true }) }),
        ui.button('Add item', { kind: 'primary', onClick: add }),
      ],
    },
      ui.grid({ min: 160 }, ui.stat({ label: 'Open', value: open }), ui.stat({ label: 'Done', value: done, tone: 'success' }), ui.stat({ label: 'All', value: items.length })),
      ui.section(null,
        ui.tabs([{ id: 'open', label: 'Open', count: open }, { id: 'done', label: 'Done', count: done }, { id: 'all', label: 'All', count: items.length }], s.tab, (tab) => set({ tab })),
        shown.length ? ui.table({
          columns: [
            { key: 'title', label: 'Item', sort: true, render: (r) => ui.h('div', null, ui.h('div', { style: r.done ? 'text-decoration:line-through;opacity:.6' : '' }, r.title), r.notes ? ui.h('div', { class: 'hx-muted hx-small' }, r.notes) : null) },
            { key: 'createdAt', label: 'Added', sort: true, width: '140px', render: (r) => ui.h('span', { class: 'hx-muted', title: r.createdAt }, ui.relTime(r.createdAt)) },
            { key: 'done', label: '', width: '170px', render: (r) => ui.row(
              ui.button(r.done ? 'Reopen' : 'Done', { size: 'sm', onClick: (e) => { e.stopPropagation(); void act('items/toggle', { id: r.id }); } }),
              ui.button('Delete', { size: 'sm', kind: 'ghost', onClick: async (e) => { e.stopPropagation(); if (await ui.confirm({ title: 'Delete this item?', text: r.title, confirm: 'Delete', danger: true })) void act('items/delete', { id: r.id }); } }),
            ) },
          ],
          rows: shown,
          sortBy: { key: 'createdAt', dir: 'desc' },
        }) : ui.empty({ title: s.tab === 'done' ? 'Nothing finished yet' : 'Nothing here yet', detail: 'Ask the agent to add something, or add it here.', action: ui.button('Add item', { kind: 'primary', onClick: add }) }),
      ),
    );
  });

  async function load() {
    try { view.set({ data: await harness.routes.call('items'), error: null }); }
    catch (e) { view.set({ error: e }); }
  }
  async function act(path, body) {
    try { await harness.routes.call(path, { method: 'POST', body }); await load(); }
    catch (e) { void harness.notify.toast(e.message, { kind: 'error' }); }
  }
  function add() {
    const d = ui.dialog({
      title: 'Add an item',
      body: ui.form({
        fields: [{ name: 'title', label: 'Title', required: true, placeholder: 'What to do' }, { name: 'notes', label: 'Notes', type: 'textarea' }],
        submitLabel: 'Add',
        onCancel: () => d.close(),
        onSubmit: async (v) => { await act('items', v); d.close(); void harness.notify.toast('Added', { kind: 'success' }); },
      }),
    });
  }

  await load();
  // The server's api.signal('items'): refresh without polling.
  await harness.events.subscribe('plugins', (e) => { if (e && e.type === 'signal' && e.plugin === '${name}' && e.name === 'items') void load(); });
}).catch((e) => { root.textContent = 'This page runs inside the Harness app: ' + e.message; });
`;

  files[`test/plugin.test.${ext}`] = `// ${title}'s tests, on the plugin test kit: the plugin loads into a real harness (a throwaway data
// folder and workspace); its tools, its routes (over HTTP, as the server serves them) and a whole
// conversation are called for real. Run them: npm run plugin -- test <this folder>
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = new URL('..', import.meta.url);

test('it loads and adds its tools, routes and skill', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.tools.sort(), ['${p}_add', '${p}_done', '${p}_list']);
    assert.deepEqual(kit.adds.routes.sort(), ['GET items', 'POST items', 'POST items/delete', 'POST items/toggle']);
    assert.deepEqual(kit.adds.skills, ['${name}']);
  } finally { await kit.close(); }
});

test('tools: add, list, done; mistakes answer with what to do', async () => {
  const kit = await loadPlugin(dir);
  try {
    const added = await kit.tool('${p}_add', { title: 'Write the report', notes: 'for Friday' });
    assert.equal(added.isError, false);
    const id = /\\] (\\w+) /.exec(added.content)${ts(o)}[1];
    assert.match((await kit.tool('${p}_list')).content, /Write the report - for Friday/);
    assert.match((await kit.tool('${p}_done', { id })).content, /^Done: \\[x\\]/);
    assert.equal((await kit.tool('${p}_list')).content, 'Nothing open: every item is done.');
    const wrong = await kit.tool('${p}_done', { id: 'nope' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.content, /Call ${p}_list/);
    assert.equal((await kit.tool('${p}_add', { title: '  ' })).isError, true);
    assert.ok(kit.signals.includes('items'), 'open pages are told to refresh');
  } finally { await kit.close(); }
});

test('routes: the page reads and changes items, signed in only', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal((await kit.route('POST', 'items', { body: { title: 'From the page' } })).status, 201);
    const got = await kit.route('GET', 'items');
    assert.deepEqual([got.status, got.body.open, got.body.items[0].title], [200, 1, 'From the page']);
    const id = got.body.items[0].id;
    assert.equal((await kit.route('POST', 'items/toggle', { body: { id } })).body.item.done, true);
    assert.equal((await kit.route('POST', 'items', { body: {} })).status, 400);
    assert.equal((await kit.route('GET', 'items', { as: 'anonymous' })).status, 401, 'not signed in: refused');
    assert.equal((await kit.route('POST', 'items/delete', { body: { id } })).status, 200);
  } finally { await kit.close(); }
});

test('a conversation: the agent adds an item and lists it (scripted, no model)', async () => {
  const kit = await loadPlugin(dir);
  try {
    const r = await kit.chat('remember to call the bank', {
      script: [
        { calls: [{ name: '${p}_add', input: { title: 'Call the bank' } }] },
        { calls: [{ name: '${p}_list' }] },
        { text: 'Added: call the bank.' },
      ],
    });
    assert.deepEqual(r.calls.map((c) => [c.name, c.isError]), [['${p}_add', false], ['${p}_list', false]]);
    assert.match(r.calls[1]${ts(o)}.result, /Call the bank/);
  } finally { await kit.close(); }
});
`;

  if (!o.js) {
    files['tsconfig.json'] = `${JSON.stringify({
      compilerOptions: {
        target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true, erasableSyntaxOnly: true,
        noEmit: true, strict: true, skipLibCheck: true, lib: ['es2023', 'dom'], types: ['node'],
        typeRoots: [`${o.repoRoot.split(path.sep).join('/')}/node_modules/@types`],
        paths: { '@harness/plugin-sdk': [`${sdk}/index.ts`], '@harness/plugin-sdk/*': [`${sdk}/*.ts`] },
      },
      include: ['*.ts', 'test/**/*.ts'],
    }, null, 2)}\n`;
  }

  files['README.md'] = `# ${title}

A harness plugin, made with \`npm run plugin -- new ${name}\`. Change it into the plugin you want.

| | |
|---|---|
| \`harness-plugin.json\` | the manifest: what it adds, what it may reach, its page |
| \`index.${ext}\` | the server half: tools, routes, data (\`api.store\`) |
| \`skills/${name}/SKILL.md\` | when and how the agent uses the tools |
| \`GUIDE.md\` | what an agent reads about the plugin in a desktop session |
| \`ui/\` | the page (UI kit + SDK) |
| \`test/\` | tests on the test kit |

From the harness checkout:

\`\`\`bash
npm run plugin -- check <this folder>          # loads it as the server would; --deep also calls its tools and routes
npm run plugin -- test <this folder>           # runs test/
\`\`\`

In the desktop app: **Plugins > Developer > Load a plugin folder…**, then pick this folder. It shows
under **Custom** in the sidebar. Edits reload as you save: a page edit reloads the page, a code edit
reloads the plugin in the engine.

The full guide: docs/plugin-sdk/README.md in the harness checkout.
`;
  files['.gitignore'] = 'node_modules/\n';
  files['CHANGELOG.md'] = `# Changelog\n\n## 0.1.0\n\n- First version: add, list and finish items; a page in the desktop app.\n`;
  files['icon.svg'] = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M20 22h24M20 32h24M20 42h16" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>\n';
  // ES modules (import.meta, import/export) for Node and the type checker.
  files['package.json'] = `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', description: 'A harness plugin (see harness-plugin.json).' }, null, 2)}\n`;
  return files;
}

const ts = (o: ScaffoldOptions) => (o.js ? '' : '!');

/** Writes a new plugin folder; refuses a folder that has anything in it. */
export async function scaffold(dir: string, name: string, o: ScaffoldOptions): Promise<string[]> {
  const files = scaffoldFiles(name, o);
  const existing = await fs.readdir(dir).catch(() => [] as string[]);
  if (existing.length) throw new Error(`${dir} is not empty: pick a new folder`);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, text);
  }
  return Object.keys(files);
}
