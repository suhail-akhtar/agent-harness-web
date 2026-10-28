import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTheme, contrast, DEFAULT_DARK, DEFAULT_LIGHT, modeOf, resolveTheme, TOKEN_NAMES, BUILTIN_THEMES, parseHex } from '../packages/ui/src/theme.ts';
import { coerce, fieldsOf, getPath, labelOf, schemaText, setPath, validate, widgetFor, withDefaults } from '../packages/ui/src/schema.ts';
import { decide, grantRecord } from '../apps/desktop/shared/grants.ts';
import { DEFAULT_PREFS, mergePrefs, projectName } from '../apps/desktop/shared/prefs.ts';
import { matches as productMatches, normaliseProduct, solutionProduct } from '../apps/desktop/shared/product.ts';
import type { JsonSchema } from '../packages/plugin-ui/src/index.ts';

test('theme builder: three colours make every token, and text always reads', () => {
  for (const colors of [DEFAULT_LIGHT, DEFAULT_DARK, { background: '#fbf8f1', foreground: '#2b2722', accent: '#b4532a' }, { background: '#0f1420', foreground: '#dfe6f3', accent: '#6c9cff' }]) {
    const t = buildTheme(colors);
    for (const k of TOKEN_NAMES) assert.ok(t[k], `${k} is set`);
    assert.ok(contrast(t['--hx-text-primary']!, t['--hx-bg']!) >= 4.5, 'primary text reads');
    assert.ok(contrast(t['--hx-text-secondary']!, t['--hx-bg']!) >= 4.5, 'secondary text reads');
    assert.ok(contrast(t['--hx-text-muted']!, t['--hx-bg']!) >= 3, 'muted text still reads');
    assert.ok(contrast(t['--hx-accent-text']!, t['--hx-bg']!) >= 4.5, 'accent used as text reads');
    assert.ok(contrast(t['--hx-on-accent']!, t['--hx-accent']!) >= 2.5, 'text on the accent reads');
  }
  // A plugin theme that asks for unreadable text gets readable text anyway.
  const bad = buildTheme({ background: '#ffffff', foreground: '#f4f4f4', accent: '#ffff00' });
  assert.ok(contrast(bad['--hx-text-primary']!, '#ffffff') >= 4.5);
  assert.ok(contrast(bad['--hx-accent-text']!, '#ffffff') >= 4.5);
  assert.equal(bad['--hx-on-accent'], '#0c0c0c', 'dark text on a yellow accent');
  const strong = buildTheme(DEFAULT_LIGHT, { contrast: 'strong' });
  assert.ok(contrast(strong['--hx-text-primary']!, strong['--hx-bg']!) >= 7);
  assert.equal(modeOf(DEFAULT_DARK), 'dark');
  assert.equal(modeOf(DEFAULT_LIGHT), 'light');
  assert.deepEqual(parseHex('#abc'), [170, 187, 204]);
  assert.deepEqual(parseHex('nonsense'), [128, 128, 128]);
});

test('theme resolution: system follows the OS, plugin themes by id, accent overrides only the built-ins', () => {
  const paper = { id: 'core.shell:paper', label: 'Paper', mode: 'light' as const, colors: { background: '#f7f3ea', foreground: '#2b2722', accent: '#b4532a' } };
  const all = [...BUILTIN_THEMES, paper];
  assert.equal(resolveTheme({ theme: 'system' }, true, all).id, 'dark');
  assert.equal(resolveTheme({ theme: 'system' }, false, all).id, 'light');
  assert.equal(resolveTheme({ theme: 'core.shell:paper' }, true, all).id, 'core.shell:paper');
  assert.equal(resolveTheme({ theme: 'gone:theme' }, false, all).id, 'light', 'a theme whose plugin is gone falls back');
  assert.equal(resolveTheme({ theme: 'dark', accent: '#00ff00' }, false, all).colors.accent, '#00ff00');
  assert.equal(resolveTheme({ theme: 'core.shell:paper', accent: '#00ff00' }, false, all).colors.accent, '#b4532a');
});

const schema: JsonSchema = {
  type: 'object', required: ['name', 'url'],
  properties: {
    name: { type: 'string', title: 'Display name', minLength: 1, order: 2 },
    url: { type: 'string', format: 'url', order: 1 },
    count: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
    mode: { type: 'string', enum: ['a', 'b'], enumLabels: ['Alpha', 'Beta'] },
    level: { type: 'string', enum: ['x', 'y', 'z', 'w'] },
    on: { type: 'boolean', default: true },
    key: { type: 'string', format: 'secret' },
    color: { type: 'string', format: 'color' },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } },
    nested: { type: 'object', properties: { deep: { type: 'number', default: 1.5 } } },
    notes: { type: 'string', format: 'multiline', maxLength: 5 },
  },
};

test('settings schema form: widgets, order, defaults, labels', () => {
  assert.deepEqual(fieldsOf(schema).slice(0, 2).map(([k]) => k), ['url', 'name'], '`order` first');
  assert.equal(widgetFor(schema.properties!.on!), 'switch');
  assert.equal(widgetFor(schema.properties!.mode!), 'radio');
  assert.equal(widgetFor(schema.properties!.level!), 'select');
  assert.equal(widgetFor(schema.properties!.count!), 'number');
  assert.equal(widgetFor(schema.properties!.key!), 'secret');
  assert.equal(widgetFor(schema.properties!.color!), 'color');
  assert.equal(widgetFor(schema.properties!.tags!), 'list');
  assert.equal(widgetFor(schema.properties!.nested!), 'object');
  assert.equal(widgetFor(schema.properties!.notes!), 'textarea');
  assert.deepEqual(withDefaults(schema, { name: 'n' }), { name: 'n', count: 3, on: true, nested: { deep: 1.5 } });
  assert.equal(labelOf('maxCostUsd', {}), 'Max Cost Usd');
  assert.equal(labelOf('x', { title: 'Shown' }), 'Shown');
  assert.match(schemaText(schema), /Display name/);
  assert.match(schemaText(schema), /Beta/);
});

test('settings schema form: validation messages say what is wrong, by path', () => {
  const e = validate(schema, { name: '', count: 11, mode: 'c', color: 'red', tags: ['ok', 'NO'], nested: { deep: 'x' }, notes: 'too long', url: 'ftp://x' });
  assert.equal(e.name, 'Display name is required.');
  assert.equal(e.count, 'Must be at most 10.');
  assert.match(e.mode!, /Alpha, Beta/);
  assert.equal(e.color, 'Must be a #hex colour.');
  assert.equal(e['tags[1]'], 'Is not in the expected format.');
  assert.equal(e['nested.deep'], 'Must be a number.');
  assert.equal(e.notes, 'Must be at most 5 characters.');
  assert.equal(e.url, 'Must be an http(s) address.');
  assert.deepEqual(validate(schema, { name: 'n', url: 'https://x.example' }), {});
  assert.equal(validate({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 1.5 }).n, 'Must be a whole number.');
  assert.equal(coerce({ type: 'integer' }, '4'), 4);
  assert.equal(coerce({ type: 'number' }, ''), undefined);
  assert.equal(coerce({ type: 'string' }, '4'), '4');
  assert.deepEqual(setPath({ a: { b: 1 } }, 'a.c', 2), { a: { b: 1, c: 2 } });
  assert.deepEqual(setPath({ a: 1 }, 'a', undefined), {});
  assert.equal(getPath({ a: { b: 7 } }, 'a.b'), 7);
});

test('frame grants: tied to the uiHash and to what the manifest declares', () => {
  const declared = ['sessions.read', 'routes.call'] as const;
  assert.deepEqual(decide(undefined, 'h1', [...declared]), { state: 'ask', capabilities: [...declared], changed: false });
  const rec = grantRecord('h1', [...declared], ['sessions.read', 'routes.call', 'approvals.respond'], 5);
  assert.deepEqual(rec.capabilities, ['sessions.read', 'routes.call'], 'never more than declared');
  assert.deepEqual(decide(rec, 'h1', [...declared]), { state: 'granted', capabilities: [...declared] });
  assert.equal(decide(rec, 'h2', [...declared]).state, 'ask', 'changed files ask again');
  assert.equal((decide(rec, 'h2', [...declared]) as { changed: boolean }).changed, true);
  assert.equal(decide(rec, 'h1', [...declared, 'files.read']).state, 'ask', 'a new capability asks again');
  assert.equal(decide({ ...rec, denied: true }, 'h1', [...declared]).state, 'denied');
});

test('desktop prefs: a bad file or patch cannot break them', () => {
  const p = mergePrefs(DEFAULT_PREFS, { theme: 'dark', fontSize: 99, sidebar: { collapsed: true, bogus: 1 }, keybindings: { 'a:b': 'Ctrl+J' }, unknown: 1, notifications: 'yes' });
  assert.equal(p.theme, 'dark');
  assert.equal(p.fontSize, 20, 'clamped');
  assert.equal(p.sidebar.collapsed, true);
  assert.equal((p.sidebar as unknown as Record<string, unknown>).bogus, undefined, 'fixed shapes keep their keys');
  assert.equal(p.keybindings['a:b'], 'Ctrl+J', 'open maps take any key');
  assert.equal(p.notifications, true, 'wrong types are ignored');
  assert.equal((p as unknown as Record<string, unknown>).unknown, undefined);
  assert.deepEqual(mergePrefs(DEFAULT_PREFS, 'garbage'), DEFAULT_PREFS);
  // The spend limit for the app's own engine: null (its default), an amount, or 0 (no limit); nothing else.
  assert.equal(DEFAULT_PREFS.spendLimitUsd, null);
  // Commands on this computer unless the person chose the Docker sandbox.
  assert.equal(DEFAULT_PREFS.commandSandbox, 'off');
  assert.equal(mergePrefs(DEFAULT_PREFS, { commandSandbox: 'docker' }).commandSandbox, 'docker');
  assert.equal(mergePrefs(DEFAULT_PREFS, { spendLimitUsd: 50 }).spendLimitUsd, 50);
  assert.equal(mergePrefs(DEFAULT_PREFS, { spendLimitUsd: 0 }).spendLimitUsd, 0);
  assert.equal(mergePrefs({ ...DEFAULT_PREFS, spendLimitUsd: 50 }, { spendLimitUsd: null }).spendLimitUsd, null);
  for (const bad of [-1, '50', Infinity, 1e9]) assert.equal(mergePrefs(DEFAULT_PREFS, { spendLimitUsd: bad }).spendLimitUsd, null, `${bad} is refused`);
  assert.equal(mergePrefs(DEFAULT_PREFS, { window: { x: 10, y: 20, width: 900, height: 700, maximized: false } }).window.x, 10);
  assert.equal(projectName('C:\\work\\repo\\'), 'repo');
  assert.equal(projectName('/home/me/app'), 'app');
});

test('product profiles: defaults filled, plugin patterns', () => {
  const p = normaliseProduct({ id: 'ops', name: 'Ops Console', brand: { accent: '#123456' }, nav: { order: ['x:y'] } });
  assert.equal(p.name, 'Ops Console');
  assert.equal(p.brand.accent, '#123456');
  assert.deepEqual(p.plugins.required, ['core.chat', 'core.settings', 'core.plugins']);
  assert.equal(p.server.mode, 'local');
  assert.ok(productMatches('core.*', 'core.chat'));
  assert.ok(!productMatches('core.*', 'acme'));
  assert.ok(productMatches('acme', 'acme'));
});

test('a solution as an app of its own: the base profile with its harness.app; it ships the solution, installs its plugins, opens focused on it, in a home of its own', async () => {
  const fs = await import('node:fs');
  const base = JSON.parse(fs.readFileSync(new URL('../products/harness.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('../solutions/studio/package.json', import.meta.url), 'utf8'));
  const p = normaliseProduct(solutionProduct(base, 'studio', pkg));
  assert.deepEqual([p.id, p.name, p.appId, p.focus, p.homeFolder, p.brand.tagline], ['studio', 'Harness Studio', 'dev.harness.studio', 'games3d', '.harness-studio', 'What shall we make?']);
  assert.deepEqual(p.solutions, ['studio']);
  assert.deepEqual(p.server.solutions, pkg.harness.plugins);
  assert.deepEqual([p.trustedKeys, p.plugins.required], [base.trustedKeys, base.plugins.required], "the base app's keys and core plugins");
  // Without an app section: named after the base and the solution, focused on its first plugin.
  const q = normaliseProduct(solutionProduct(base, 'kit', { harness: { title: 'Kit', plugins: ['kit-core', 'kit-engine'] } }));
  assert.deepEqual([q.name, q.appId, q.focus, q.homeFolder], ['Harness Kit', 'dev.harness.desktop.kit', 'kit-core', '.harness-kit']);
});
