import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { composeGuide, GENERATED_HOME_VIEW, GENERATED_MARKER, generateGuideSections, guideIndexLine, ManifestError, parseGuideMarkdown, validateUiManifest, type UiManifest } from '../packages/plugin-ui/src/index.ts';
import { buildRegistry, menuOf, type PluginEntry, type Registry } from '../apps/desktop/renderer/src/registry/registry.ts';
import { crumbsFor, pageTitle } from '../apps/desktop/renderer/src/registry/crumbs.ts';
import { describeForAgent, describePlugin, resolveOpen } from '../apps/desktop/renderer/src/registry/agent-surface.ts';
import { guideFor, guideIndex, homeModel, paletteTitle } from '../apps/desktop/renderer/src/registry/modules.ts';
import { reconcile } from '../apps/desktop/renderer/src/registry/reconcile.ts';
import { DEFAULT_PREFS, mergePrefs } from '../apps/desktop/shared/prefs.ts';
import * as agentsM from '../apps/desktop/renderer/src/builtins/core.agents/manifest.ts';
import * as artifactsM from '../apps/desktop/renderer/src/builtins/core.artifacts/manifest.ts';
import * as chatM from '../apps/desktop/renderer/src/builtins/core.chat/manifest.ts';
import * as dashboardsM from '../apps/desktop/renderer/src/builtins/dashboards/manifest.ts';
import * as diagramsM from '../apps/desktop/renderer/src/builtins/diagrams/manifest.ts';
import * as settingsM from '../apps/desktop/renderer/src/builtins/core.settings/manifest.ts';
import { Registry as ServerRegistry } from '../src/kernel/registry.ts';
import { loadPlugin } from '../src/plugins/loader.ts';
import { readPluginGuide, serverGuide } from '../src/plugins/guides.ts';

// Plugins as first-class modules of the desktop (docs/desktop/DESIGN.md, "Plugins as modules"):
// the menu contract, the registry's groups and homes, the generated home page, breadcrumbs and the
// palette, guides (authored + generated, never stale), desktop_describe per plugin.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtinsDir = path.join(root, 'apps', 'desktop', 'renderer', 'src', 'builtins');

/** The built-ins with a guide: their manifest module and their folder. */
const GUIDED = [
  { m: chatM, dir: 'core.chat' }, { m: agentsM, dir: 'core.agents' }, { m: artifactsM, dir: 'core.artifacts' },
  { m: diagramsM, dir: 'diagrams' }, { m: dashboardsM, dir: 'dashboards' }, { m: settingsM, dir: 'core.settings' },
];
const builtin = (x: (typeof GUIDED)[number]): PluginEntry => ({
  ...x.m.meta, source: 'builtin', enabled: true, ui: validateUiManifest(x.m.ui, { trustCeiling: 'native' }),
  guide: fs.readFileSync(path.join(builtinsDir, x.dir, 'GUIDE.md'), 'utf8'),
});
const native = (name: string, contributes: Record<string, unknown>, extra: Record<string, unknown> = {}): PluginEntry => ({
  name, source: 'builtin', enabled: true, ui: validateUiManifest({ apiVersion: 1, trust: 'native', capabilities: [], contributes, ...extra }, { trustCeiling: 'native' }),
});
const shell = native('core.shell', { views: [{ id: 'plugin-home', title: 'Home', kind: 'native', component: 'PluginHome' }], commands: [{ id: 'palette', title: 'Palette', handler: 'p' }] });
const SERVER_UI = ['sdlc', 'aiops', 'research', 'quality-gates'];
const manifestOf = (p: string) => JSON.parse(fs.readFileSync(path.join(root, 'plugins', p, 'harness-plugin.json'), 'utf8')) as { name: string; description: string; ui?: unknown; skills?: string };
const server = (p: string, extra: Partial<PluginEntry> = {}): PluginEntry => {
  const m = manifestOf(p);
  const ui = m.ui ? validateUiManifest(m.ui, { trustCeiling: 'frame' }) : undefined;
  // What GET /api/plugins says of its guide: the purpose from its frontmatter.
  const purpose = ui?.guide ? parseGuideMarkdown(fs.readFileSync(path.join(root, 'plugins', p, ui.guide), 'utf8')).purpose : undefined;
  return { name: m.name, description: m.description, source: 'bundled', enabled: true, ...(ui ? { ui } : {}), ...(purpose ? { guideInfo: { purpose } } : {}), uiHash: 'h', ...extra };
};
const third = (name: string, ui: Record<string, unknown>): PluginEntry => ({ name, source: 'installed', enabled: true, ui: validateUiManifest(ui), uiHash: 'h' });
const inbox = native('core.inbox', { navItems: [{ id: 'inbox', title: 'Inbox', view: 'inbox', order: 10 }], views: [{ id: 'inbox', title: 'Waiting for you', kind: 'native', component: 'I' }] });
const notes = third('acme-notes', {
  displayName: 'Acme Notes', trust: 'frame', capabilities: ['routes.call'],
  contributes: {
    navItems: [{ id: 'board', title: 'Board', view: 'board' }, { id: 'list', title: 'All notes', view: 'list', badge: 'acme-notes.open' }, { id: 'tags', title: 'Tags', view: 'tags', placement: 'more' }],
    views: [{ id: 'board', title: 'Board', kind: 'frame', entry: 'ui/b.html', description: 'Notes on a board' }, { id: 'list', title: 'Notes', kind: 'frame', entry: 'ui/l.html' }, { id: 'tags', title: 'Tags', kind: 'frame', entry: 'ui/t.html' }, { id: 'archive', title: 'Archive', kind: 'markdown', markdown: '# old' }],
    commands: [{ id: 'new', title: 'New note', action: { type: 'prompt', prompt: 'A note: ' }, agent: { description: 'Type a new note for the person', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } }, { id: 'open-board', title: 'Open the board', action: { type: 'open-view', view: 'board' } }],
    slashCommands: [{ name: 'note', description: 'Write a note', action: { type: 'prompt', prompt: 'A note: {args}' } }],
    settings: [{ id: 'notes', title: 'Notes', scope: 'app', schema: { type: 'object', properties: { color: { type: 'string', enum: ['yellow', 'blue'] } } } }],
    statusItems: [{ id: 'open', text: '{acme-notes.open} open notes', command: 'open-board' }],
    homeCards: [{ id: 'today', title: 'Today', kind: 'markdown', markdown: 'Nothing today.' }],
  },
});
const single = third('quick-links', { trust: 'declarative', contributes: { navItems: [{ id: 'links', title: 'Links', view: 'links' }], views: [{ id: 'links', title: 'Links', kind: 'links', links: [{ title: 'Docs', url: 'https://example.com' }] }] } });

function fullRegistry(o: { off?: string[]; menuOrder?: string[] } = {}): Registry {
  const entries = [shell, inbox, ...GUIDED.map(builtin), ...SERVER_UI.map((p) => server(p)), server('devops', { guideInfo: { purpose: 'DevOps: plan, apply, roll out.' }, contributes: ['tool:iac', 'tool:k8s', 'workflow:ship-change'] }), notes, single];
  for (const e of entries) if (o.off?.includes(e.name)) e.enabled = false;
  return buildRegistry(entries, { navOrder: ['core.chat:new', 'core.chat:search', 'core.inbox:inbox'], menuOrder: o.menuOrder });
}

// ---------------- the contract ----------------

test('ui.menu: nav item refs (own or "<plugin>:<id>"), inline items with sub-items one level deep, checked; ui.home, ui.guide and ui.tools too; a manifest without them is unchanged', () => {
  const base = { trust: 'frame', contributes: { navItems: [{ id: 'a', title: 'A', view: 'va' }, { id: 'b', title: 'B', view: 'vb' }], views: [{ id: 'va', title: 'A', kind: 'frame', entry: 'ui/a.html' }, { id: 'vb', title: 'B', kind: 'frame', entry: 'ui/b.html' }] } };
  const ok = validateUiManifest({ ...base, menu: { title: 'Acme', icon: 'rocket', order: 5, collapsed: true, items: ['a', 'core.artifacts:library', { id: 'more', title: 'More', view: 'vb', params: { tab: 'x' }, badge: 'acme.n', children: ['b', { id: 'deep', title: 'Deep', view: 'va' }] }] }, home: 'va', guide: 'GUIDE.md', tools: ['acme_tool', 'acme_tool'] });
  assert.deepEqual(ok.menu, { items: ['a', 'core.artifacts:library', { id: 'more', title: 'More', view: 'vb', params: { tab: 'x' }, badge: 'acme.n', children: ['b', { id: 'deep', title: 'Deep', view: 'va' }] }], title: 'Acme', icon: 'rocket', order: 5, collapsed: true });
  assert.equal(ok.home, 'va');
  assert.equal(ok.guide, 'GUIDE.md');
  assert.deepEqual(ok.tools, ['acme_tool'], 'tools once each');
  const plain = validateUiManifest(base);
  assert.ok(!('menu' in plain) && !('home' in plain) && !('guide' in plain) && !('tools' in plain), 'compatible: nothing added to a manifest that has none');
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => validateUiManifest({ ...base, ...patch }), (e: Error) => e instanceof ManifestError && re.test(e.message), JSON.stringify(patch));
  bad({ menu: { items: ['nope'] } }, /"nope" is not one of this plugin's nav items/);
  bad({ menu: { items: ['a', 'a'] } }, /in the menu twice/);
  bad({ menu: { items: [] } }, /1 to 40 items/);
  bad({ menu: { items: Array.from({ length: 41 }, () => 'a') } }, /1 to 40 items/);
  bad({ menu: { items: [{ id: 'x', title: 'X', view: 'va', children: [{ id: 'y', title: 'Y', view: 'va', children: [] }] }] } }, /one level deep/);
  bad({ menu: { items: [{ id: 'a', title: 'X', view: 'va' }] } }, /the id "a" is taken/);
  bad({ menu: { items: [{ id: 'x', title: 'X', view: 'elsewhere' }] } }, /not one of this plugin's views/);
  bad({ menu: { items: [{ id: 'x', view: 'va' }] } }, /needs a "title"/);
  { const w: string[] = []; const ok = validateUiManifest({ ...base, menu: { items: ['a'], icon: 'not-an-icon' } }, { warnings: w }); assert.equal(ok.menu?.icon, 'puzzle', 'an unknown icon is shown as puzzle, not a lost menu'); assert.match(w[0]!, /unknown icon "not-an-icon"/); }
  bad({ menu: { items: ['a'], title: 'x'.repeat(41) } }, /at most 40 characters/);
  bad({ menu: 'a' }, /is an object/);
  bad({ home: 'missing' }, /not one of this plugin's views/);
  bad({ home: '../x' }, /is a view id/);
  bad({ guide: '../GUIDE.md' }, /Markdown file inside the plugin folder/);
  bad({ guide: 'guide.txt' }, /Markdown file/);
  bad({ tools: ['ok', 'not ok'] }, /at most 40 tool names/);
  // Every real manifest validates: the built-ins and the bundled frame plugins.
  for (const g of GUIDED) assert.ok(validateUiManifest(g.m.ui, { trustCeiling: 'native' }), g.dir);
  for (const p of SERVER_UI) assert.ok(validateUiManifest(manifestOf(p).ui, { trustCeiling: 'frame' }), p);
});

// ---------------- groups ----------------

test('registry: a plugin with a menu is a group (its items, another plugin\'s by name, sub-items), a third party\'s several nav items too; plain plugins and the core stay at the top; order: the person\'s, then the menu\'s', () => {
  const r = fullRegistry();
  assert.deepEqual(r.groups.map((g) => g.plugin), ['core.agents', 'core.dashboards', 'sdlc', 'aiops', 'custom'], 'by the menus\' order, then title; the plugins the person added under Custom, last');
  const top = r.navItems.filter((n) => !n.group).map((n) => n.qid);
  assert.deepEqual(top.slice(0, 3), ['core.chat:new', 'core.chat:search', 'core.inbox:inbox'], 'the core\'s items stay at the top level');
  assert.ok(top.includes('research:research'), 'a shipped plugin with one nav item stays a single item');
  assert.deepEqual(r.groups.find((g) => g.plugin === 'custom')!.items.map((e) => e.qid), ['acme-notes:menu', 'quick-links:links'], 'added plugins: one with several pages as an entry with them under it, one page as an entry');
  const agents = r.groups.find((g) => g.plugin === 'core.agents')!;
  assert.deepEqual(agents.items.map((e) => e.qid), ['core.agents:agents', 'core.artifacts:library'], 'the Library of core.artifacts sits in the Agents module');
  assert.equal(r.navItems.find((n) => n.qid === 'core.artifacts:library')!.group, 'core.agents');
  assert.deepEqual(agents.home, { view: 'core.agents:home' });
  const ops = r.groups.find((g) => g.plugin === 'aiops')!;
  assert.equal(ops.title, 'Operations');
  assert.deepEqual(ops.items.map((e) => e.title), ['Incidents', 'Alerts', 'Services', 'Topology', 'Changes']);
  assert.equal(ops.items[0]!.badge, 'aiops.open', 'badges kept');
  assert.equal(ops.items[1]!.badge, 'aiops.firing');
  assert.ok(r.navItems.some((n) => n.qid === 'aiops:alerts' && n.group === 'aiops' && n.view === 'aiops:alerts'), 'inline items are nav items too (palette, desktop_open)');
  assert.deepEqual(r.groups.find((g) => g.plugin === 'sdlc')!.items.map((e) => e.view), ['sdlc:delivery', 'sdlc:start-feature', 'sdlc:quality']);
  assert.deepEqual(r.groups.find((g) => g.plugin === 'core.dashboards')!.items.map((e) => e.qid), ['core.dashboards:dashboards', 'core.dashboards:reports', 'core.dashboards:data']);
  const acme = menuOf(r, 'acme-notes')!;
  assert.equal(acme.title, 'Acme Notes');
  assert.deepEqual(acme.items.map((e) => e.qid), ['acme-notes:list', 'acme-notes:board', 'acme-notes:tags'], 'a third party\'s nav items become its group, in their sidebar order');
  assert.deepEqual(acme.home, { view: GENERATED_HOME_VIEW, params: { plugin: 'acme-notes' } }, 'no home declared: the shell draws one');
  assert.equal(acme.homeDeclared, false);
  assert.deepEqual(r.homes.get('quick-links'), { view: GENERATED_HOME_VIEW, params: { plugin: 'quick-links' } }, 'every plugin has a home');
  // The person's order first.
  assert.deepEqual(fullRegistry({ menuOrder: ['aiops', 'custom'] }).groups.map((g) => g.plugin), ['aiops', 'custom', 'core.agents', 'core.dashboards', 'sdlc']);
  // Sub-items, one level deep.
  const sub = buildRegistry([shell, { ...third('deep', { trust: 'frame', menu: { items: [{ id: 'p', title: 'Parent', view: 'a', children: ['n', { id: 'c', title: 'Child', view: 'a', params: { k: 'v' } }] }] }, contributes: { navItems: [{ id: 'n', title: 'Nav child', view: 'a' }], views: [{ id: 'a', title: 'A', kind: 'frame', entry: 'ui/a.html' }] } }), source: 'bundled' }]);
  const g = sub.groups[0]!;
  assert.deepEqual(g.items.map((e) => [e.qid, e.children.map((c) => c.qid)]), [['deep:p', ['deep:n', 'deep:c']]]);
  assert.deepEqual(sub.navItems.filter((n) => n.parent === 'deep:p').map((n) => n.qid).sort(), ['deep:c', 'deep:n']);
  // Switched off: the group goes; an item another plugin lent goes with its owner.
  const off = fullRegistry({ off: ['aiops', 'core.artifacts'] });
  assert.ok(!off.groups.some((x) => x.plugin === 'aiops'));
  assert.deepEqual(off.groups.find((x) => x.plugin === 'core.agents')!.items.map((e) => e.qid), ['core.agents:agents']);
  assert.ok(!off.homes.has('aiops'));
  // Reconciled live: a page of a group switched off goes home.
  assert.equal(reconcile(r, off, { route: { view: 'aiops:alerts' }, panel: null, settingsSection: null, badges: { 'aiops.open': 2 } }).leaveView?.label, 'Operations');
});

test('the home a plugin without one gets: what it is, its pages as cards, its commands and slash commands, settings, status items, home cards, "Ask the agent"', () => {
  const r = fullRegistry();
  const m = homeModel(r, 'acme-notes')!;
  assert.equal(m.title, 'Acme Notes');
  assert.deepEqual(m.pages.map((p) => [p.title, p.route.view]), [['All notes', 'acme-notes:list'], ['Board', 'acme-notes:board'], ['Tags', 'acme-notes:tags'], ['Archive', 'acme-notes:archive']], 'its menu, then pages nothing else reaches');
  assert.equal(m.pages[1]!.description, 'Notes on a board');
  assert.equal(m.pages[0]!.badge, 'acme-notes.open');
  assert.deepEqual(m.actions.map((a) => [a.kind, a.run]), [['command', 'acme-notes:new'], ['slash', '/note ']], 'a command that only opens a page shown as a card is not repeated');
  assert.equal(m.actions[0]!.agent, true);
  assert.deepEqual(m.settings, [{ id: 'acme-notes:notes', title: 'Notes' }]);
  assert.deepEqual(m.statusItems, [{ id: 'acme-notes:open', text: '{acme-notes.open} open notes', command: 'acme-notes:open-board' }]);
  assert.deepEqual(m.homeCards, ['acme-notes:today']);
  assert.match(m.ask, /Acme Notes plugin/);
  assert.match(m.ask, /acme-notes-guide/);
  assert.equal(homeModel(r, 'not-there'), undefined);
  // A built-in with a declared home still has the model (its header uses it).
  const d = homeModel(r, 'core.dashboards')!;
  assert.match(d.purpose, /Data, dashboards and reports/);
  assert.ok(d.pages.some((p) => p.route.view === 'core.dashboards:data'));
});

test('breadcrumbs read Plugin > Page (the plugin links to its home); the palette names items "Plugin › Item"', () => {
  const r = fullRegistry();
  assert.deepEqual(crumbsFor(r, { view: 'aiops:alerts' }, null), { parent: { label: 'Operations', route: { view: 'aiops:home' } }, title: 'Alerts' });
  assert.deepEqual(crumbsFor(r, { view: 'aiops:home' }, null), { title: 'Operations' }, 'the home is the plugin');
  assert.deepEqual(crumbsFor(r, { view: 'core.artifacts:library' }, null), { parent: { label: 'Agents', route: { view: 'core.agents:home' } }, title: 'Library' });
  assert.deepEqual(crumbsFor(r, { view: 'core.agents:agents' }, null), { parent: { label: 'Agents', route: { view: 'core.agents:home' } }, title: 'Working now' }, 'the item\'s own title');
  assert.deepEqual(crumbsFor(r, { view: 'core.dashboards:doc', params: { id: 'd1' } }, null), { parent: { label: 'Dashboards', route: { view: 'core.dashboards:home' } }, title: 'Dashboard' }, 'a page of the plugin no item opens');
  assert.deepEqual(crumbsFor(r, { view: GENERATED_HOME_VIEW, params: { plugin: 'acme-notes' } }, null), { title: 'Acme Notes' });
  assert.deepEqual(crumbsFor(r, { view: 'acme-notes:board' }, null), { parent: { label: 'Acme Notes', route: { view: GENERATED_HOME_VIEW, params: { plugin: 'acme-notes' } } }, title: 'Board' });
  assert.deepEqual(crumbsFor(r, { view: 'core.dashboards:doc' }, { view: 'core.dashboards:doc', title: 'Sales', parent: { label: 'Dashboards', route: { view: 'core.dashboards:dashboards' } } }), { parent: { label: 'Dashboards', route: { view: 'core.dashboards:dashboards' } }, title: 'Sales' }, 'what a page says about itself wins');
  assert.equal(pageTitle(r, { view: 'aiops:alerts' }, null), 'Alerts');
  const nav = (qid: string) => r.navItems.find((n) => n.qid === qid)!;
  assert.equal(paletteTitle(r, nav('aiops:alerts')), 'Operations › Alerts');
  assert.equal(paletteTitle(r, nav('core.artifacts:library')), 'Agents › Library');
  assert.equal(paletteTitle(r, nav('core.chat:new')), 'New chat', 'top-level items as they are');
  const sub = buildRegistry([{ ...third('deep', { trust: 'frame', menu: { items: [{ id: 'p', title: 'Parent', view: 'a', children: [{ id: 'c', title: 'Child', view: 'a' }] }] }, contributes: { views: [{ id: 'a', title: 'A', kind: 'frame', entry: 'ui/a.html' }] } }), source: 'bundled' }]);
  assert.equal(paletteTitle(sub, sub.navItems.find((n) => n.qid === 'deep:c')!), 'deep › Parent › Child');
  // Under Custom: "Plugin › Page", never "Custom › ...".
  assert.equal(paletteTitle(r, nav('acme-notes:board')), 'Acme Notes › Board');
  assert.equal(paletteTitle(r, nav('quick-links:links')), 'quick-links › Links');
});

test('prefs: the groups\' order and folded state are remembered, cleaned', () => {
  const p = mergePrefs(DEFAULT_PREFS, { menus: { order: ['aiops', 'aiops', 'core.agents', 7, '../x'], collapsed: { aiops: true, sdlc: 'yes', 'core.dashboards': false } } });
  assert.deepEqual(p.menus, { order: ['aiops', 'core.agents'], collapsed: { aiops: true, 'core.dashboards': false } });
  assert.deepEqual(mergePrefs(DEFAULT_PREFS, {}).menus, { order: [], collapsed: {} });
  assert.deepEqual(mergePrefs(DEFAULT_PREFS, { menus: 'x' }).menus, { order: [], collapsed: {} });
});

// ---------------- guides ----------------

/** Every plugin that must have a guide, with its authored text. */
function authoredGuides(): Array<{ name: string; text: string; ui: UiManifest | undefined; description: string }> {
  const out: Array<{ name: string; text: string; ui: UiManifest | undefined; description: string }> = GUIDED.map((g) => ({ name: g.m.meta.name, text: fs.readFileSync(path.join(builtinsDir, g.dir, 'GUIDE.md'), 'utf8'), ui: validateUiManifest(g.m.ui, { trustCeiling: 'native' }), description: g.m.meta.description }));
  for (const p of ['sdlc', 'aiops', 'research', 'quality-gates', 'devops', 'integrations']) {
    const m = manifestOf(p);
    const ui = m.ui ? validateUiManifest(m.ui, { trustCeiling: 'frame' }) : undefined;
    const file = ui?.guide ? path.join(root, 'plugins', p, ui.guide) : path.join(root, 'plugins', p, m.skills ?? 'skills', `${p}-guide`, 'SKILL.md');
    out.push({ name: p, text: fs.readFileSync(file, 'utf8'), ui, description: m.description });
  }
  return out;
}

test('guides: every full plugin has one (a one-sentence purpose, what it is for, worked examples); the generated half lists every command and view of its manifest, so it never goes stale', () => {
  const all = authoredGuides();
  assert.equal(all.length, 12);
  for (const g of all) {
    const parsed = parseGuideMarkdown(g.text);
    assert.ok(parsed.purpose && parsed.purpose.length <= 200 && parsed.purpose.length > 30, `${g.name}: a one-sentence purpose (${parsed.purpose})`);
    assert.match(parsed.body, /## What it is for/, `${g.name}: what it is for`);
    assert.match(parsed.body, /## Worked examples/, `${g.name}: worked examples`);
    assert.ok(parsed.body.includes(GENERATED_MARKER), `${g.name}: says where the generated reference goes`);
    assert.ok(!/\r/.test(g.text), `${g.name}: LF only`);
    const full = composeGuide({ name: g.name, title: g.ui?.displayName, description: g.description, ui: g.ui, authored: g.text });
    assert.ok(!full.includes(GENERATED_MARKER), 'the marker is replaced');
    assert.ok(!full.startsWith('---'), 'no frontmatter in the loaded guide');
    assert.match(full, /## Reference: /);
    // The staleness check: every command and view (and panel, setting, slash command) of the manifest is in its guide.
    const c = g.ui?.contributes;
    for (const cmd of c?.commands ?? []) assert.ok(full.includes(`\`${g.name}:${cmd.id}\``), `${g.name}: the command ${cmd.id} is in its guide`);
    for (const v of c?.views ?? []) assert.ok(full.includes(`\`${g.name}:${v.id}\``), `${g.name}: the view ${v.id} is in its guide`);
    for (const p of c?.panels ?? []) assert.ok(full.includes(`\`${g.name}:${p.id}\``), `${g.name}: the panel ${p.id}`);
    for (const s of c?.settings ?? []) assert.ok(full.includes(`\`${g.name}:${s.id}\``), `${g.name}: the settings section ${s.id}`);
    for (const s of c?.slashCommands ?? []) assert.ok(full.includes(`\`/${s.name}\``), `${g.name}: /${s.name}`);
    for (const cmd of (c?.commands ?? []).filter((x) => x.agent?.inputSchema?.properties)) for (const k of Object.keys(cmd.agent!.inputSchema!.properties!)) assert.ok(full.includes(`\`${k}\``), `${g.name}: ${cmd.id}'s argument ${k}`);
    for (const t of g.ui?.tools ?? []) assert.ok(full.includes(`\`${t}\``), `${g.name}: the tool ${t}`);
  }
  // A command added to a manifest shows in the generated half without anyone touching the guide.
  const ui = validateUiManifest({ trust: 'frame', contributes: { views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'ui/v.html' }], commands: [{ id: 'fresh', title: 'Fresh', action: { type: 'open-view', view: 'v' }, agent: { description: 'Brand new', inputSchema: { type: 'object', properties: { when: { type: 'string', enum: ['now', 'later'] } }, required: ['when'] } } }] } });
  const gen = generateGuideSections({ name: 'acme', ui });
  assert.match(gen, /`acme:fresh`: Brand new/);
  assert.match(gen, /`when` \(string, required, one of "now", "later"\)/);
  assert.match(gen, /desktop_open \{"target":"view","id":"acme"\}/, 'how to open its home');
  assert.equal(guideIndexLine('aiops', 'On call.\n Incidents.'), 'aiops: On call. Incidents.; guide: load skill aiops-guide');
});

test('guides on the server: the plugin\'s authored text plus its tools, workflows, agents, gates and skills as loaded; the purpose from its frontmatter', async () => {
  const reg = new ServerRegistry();
  for (const p of ['sdlc', 'research', 'quality-gates', 'devops']) await loadPlugin(reg, path.join(root, 'plugins', p));
  const entry = async (p: string, contributes: string[]) => {
    const m = manifestOf(p);
    const ui = m.ui ? validateUiManifest(m.ui, { trustCeiling: 'frame' }) : undefined;
    return { name: p, description: m.description, dir: path.join(root, 'plugins', p), enabled: true, ui, ...(await readPluginGuide(path.join(root, 'plugins', p), m, ui)), loaded: { contributes } };
  };
  const sdlc = await entry('sdlc', []);
  assert.match(sdlc.guide!.purpose, /^Engineering: features from request/);
  const text = await serverGuide(sdlc, reg);
  assert.match(text, /## What it is for/);
  assert.match(text, /### Workflows[\s\S]*`build-feature`/);
  assert.match(text, /### Agents \(agent tool\)[\s\S]*`engineer`/);
  assert.match(text, /### Skills \(skill tool\)[\s\S]*`test-driven-development`/);
  assert.match(text, /`sdlc:start-feature`: Opens the Start a feature form[\s\S]*`request` \(string, required\)/);
  const research = await entry('research', ['tool:check_citations', 'tool:sources']);
  const rt = await serverGuide(research, reg);
  assert.match(rt, /### Tools[\s\S]*`check_citations`: Check a report's citations/);
  assert.match(rt, /### Quality gates \(quality_gates tool\)\n- `citations`/);
  const devops = await entry('devops', ['tool:iac']);
  assert.match(devops.guide!.purpose, /^DevOps: Terraform/, 'a guide kept as the plugin\'s <name>-guide skill');
  assert.match(await serverGuide(devops, reg), /`iac`: Terraform/);
  assert.deepEqual(await readPluginGuide(path.join(root, 'plugins', 'visual'), manifestOf('visual')), {}, 'no guide, no line');
});

// ---------------- desktop_describe ----------------

test('desktop_describe: each plugin with its purpose, home, menu, agent-callable commands and tools; {plugin} in depth, with its guide; a plugin\'s name opens its home', () => {
  const r = fullRegistry();
  const d = describeForAgent(r, { view: 'core.chat:home' });
  const ops = d.plugins.find((p) => p.name === 'aiops')!;
  assert.equal(ops.title, 'Operations');
  assert.match(ops.purpose!, /^Operations: alerts, incidents/);
  assert.equal(ops.guide, 'aiops-guide');
  assert.equal(ops.home, 'aiops:home');
  assert.deepEqual(ops.menu, ['Incidents=aiops:incidents', 'Alerts=aiops:alerts', 'Services=aiops:services', 'Topology=aiops:topology', 'Changes=aiops:changes']);
  assert.deepEqual(ops.commands, ['aiops:open-incident', 'aiops:run-ops-check']);
  const dash = d.plugins.find((p) => p.name === 'core.dashboards')!;
  assert.deepEqual(dash.tools, ['datasource', 'dataset', 'model', 'dashboard']);
  assert.equal(d.plugins.find((p) => p.name === 'acme-notes')!.home, 'generated');
  assert.ok(!('guide' in d.plugins.find((p) => p.name === 'quick-links')!), 'a plain plugin has no guide line');
  assert.deepEqual(d.serverPlugins, [{ name: 'devops', purpose: 'DevOps: plan, apply, roll out.', guide: 'devops-guide' }], 'the server\'s guided plugins without pages');
  assert.ok(!d.off.includes('devops'));
  assert.ok(!d.views.some((v) => v.startsWith(GENERATED_HOME_VIEW)));
  assert.ok(JSON.stringify(d).length < 16_000, `compact (${JSON.stringify(d).length} characters for ${d.plugins.length} plugins)`);
  // One plugin in depth.
  const one = describePlugin(r, 'aiops') as ReturnType<typeof describePlugin> & { views: Array<{ id: string }>; commands: Array<{ id: string; agent?: string; args?: unknown }>; menu: unknown[] };
  assert.deepEqual(one.home, { view: 'aiops:home' });
  assert.ok(one.views.some((v) => v.id === 'aiops:topology'));
  assert.ok(one.commands.find((c) => c.id === 'aiops:open-incident')!.args, 'with the schema of its args');
  assert.ok(!('guideText' in one));
  const byTitle = describePlugin(r, 'Operations') as { name: string };
  assert.equal(byTitle.name, 'aiops', 'by its display name too');
  const withGuide = describePlugin(r, 'core.dashboards', { guide: true }) as { guideText: string };
  assert.match(withGuide.guideText, /# Dashboards \(core\.dashboards\)/);
  assert.match(withGuide.guideText, /`core\.dashboards:open-doc`/);
  assert.equal(guideFor(r, 'core.dashboards'), withGuide.guideText, 'the guide the skill loads is the one the app shows');
  assert.throws(() => describePlugin(r, 'nope'), /No plugin "nope"/);
  // desktop_open: a plugin's name (or display name) is its home.
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'aiops' }), { target: 'view', view: 'aiops:home' });
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'Operations' }), { target: 'view', view: 'aiops:home' });
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'acme-notes' }), { target: 'view', view: GENERATED_HOME_VIEW, params: { plugin: 'acme-notes' } });
  assert.deepEqual(resolveOpen(r, { target: 'view', id: 'aiops:incidents', params: { id: 'alr-1' } }), { target: 'view', view: 'aiops:incidents', params: { id: 'alr-1' } }, 'views as before');
});

test('the guide index the app declares: one entry per enabled plugin with a guide, sorted, the app\'s and the server\'s; it follows plugins on and off', () => {
  const r = fullRegistry();
  const idx = guideIndex(r);
  assert.deepEqual(idx.map((g) => g.name), ['aiops', 'core.agents', 'core.artifacts', 'core.chat', 'core.dashboards', 'core.diagrams', 'core.settings', 'devops', 'quality-gates', 'research', 'sdlc']);
  assert.deepEqual(idx.find((g) => g.name === 'core.dashboards'), { name: 'core.dashboards', title: 'Dashboards', purpose: parseGuideMarkdown(fs.readFileSync(path.join(builtinsDir, 'dashboards', 'GUIDE.md'), 'utf8')).purpose, from: 'app', tools: ['datasource', 'dataset', 'model', 'dashboard'] });
  assert.equal(idx.find((g) => g.name === 'aiops')!.from, 'server');
  assert.ok(!idx.some((g) => g.name === 'acme-notes'), 'a third party\'s app plugin without a guide of its own: no line (desktop_describe still lists it)');
  const off = guideIndex(fullRegistry({ off: ['aiops', 'core.dashboards'] })).map((g) => g.name);
  assert.ok(!off.includes('aiops') && !off.includes('core.dashboards'));
  assert.equal(off.length, idx.length - 2);
});
