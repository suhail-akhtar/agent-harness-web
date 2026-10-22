import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateUiManifest } from '../packages/plugin-ui/src/index.ts';
import { buildRegistry, fuzzyScore, interpolate, normaliseChordText, rendererFor, type PluginEntry } from '../apps/desktop/renderer/src/registry/registry.ts';
import { allowedWhileTyping, chordFromEvent, conflicts, formatChord, matches, parseChord } from '../apps/desktop/renderer/src/registry/keybindings.ts';

const native = (name: string, contributes: Record<string, unknown>, extra: Partial<PluginEntry> = {}): PluginEntry => ({
  name, source: 'builtin', enabled: true, ui: validateUiManifest({ trust: 'native', contributes }, { trustCeiling: 'native' }), native: { components: {} }, ...extra,
});
const third = (name: string, ui: Record<string, unknown>, extra: Partial<PluginEntry> = {}): PluginEntry => ({ name, source: 'installed', enabled: true, ui: validateUiManifest(ui), uiHash: 'h1', ...extra });

test('registry: contributions are qualified, ordered by the product profile, and disabled plugins contribute nothing', () => {
  const chat = native('core.chat', {
    navItems: [{ id: 'new', title: 'New chat', view: 'home' }, { id: 'search', title: 'Search', view: 'search', order: 5 }],
    views: [{ id: 'home', title: 'Home', kind: 'native', component: 'Home' }, { id: 'search', title: 'Search', kind: 'native', component: 'Search' }],
    homeCards: [{ id: 'recent', title: 'Recent', kind: 'native', component: 'Recent', order: 20 }],
  });
  const inbox = native('core.inbox', { navItems: [{ id: 'inbox', title: 'Inbox', view: 'inbox', order: 1 }], views: [{ id: 'inbox', title: 'Inbox', kind: 'native', component: 'Inbox' }], homeCards: [{ id: 'attention', title: 'Waiting', kind: 'native', component: 'A', order: 99 }] });
  const notes = third('acme-notes', { contributes: { navItems: [{ id: 'notes', title: 'Notes', view: 'notes', order: 0 }], views: [{ id: 'notes', title: 'Notes', kind: 'markdown', markdown: '# n' }] } });
  const off = third('off-plugin', { contributes: { navItems: [{ id: 'x', title: 'X', view: 'x' }], views: [{ id: 'x', title: 'X', kind: 'markdown', markdown: 'x' }] } }, { enabled: false });
  const r = buildRegistry([notes, inbox, chat, off], { navOrder: ['core.chat:new', 'core.chat:search', 'core.inbox:inbox'], homeCards: ['core.inbox:attention', 'core.chat:recent'] });
  assert.deepEqual(r.navItems.map((n) => n.qid), ['core.chat:new', 'core.chat:search', 'core.inbox:inbox', 'acme-notes:notes'], 'profile order first, then each item\'s own order');
  assert.equal(r.navItems[0]!.view, 'core.chat:home', 'a view reference inside a plugin is qualified with the plugin');
  assert.ok(r.views.has('acme-notes:notes'));
  assert.ok(!r.views.has('off-plugin:x'), 'a switched-off plugin contributes nothing');
  assert.deepEqual(r.homeCards.map((h) => h.qid), ['core.inbox:attention', 'core.chat:recent'], 'home cards follow the profile');
  assert.deepEqual(r.active.map((p) => p.name).sort(), ['acme-notes', 'core.chat', 'core.inbox']);
});

test('registry: required plugins stay on; native UI from anything but a built-in is refused; manifest errors are kept', () => {
  const settings = native('core.settings', { settings: [{ id: 'a', title: 'Appearance', scope: 'app', component: 'A', group: 'app' }] }, { enabled: false });
  const forged: PluginEntry = { name: 'evil', source: 'installed', enabled: true, ui: validateUiManifest({ trust: 'native', contributes: { views: [{ id: 'v', title: 'V', kind: 'native', component: 'Steal' }] } }, { trustCeiling: 'native' }) };
  const broken: PluginEntry = { name: 'broken', source: 'installed', enabled: true, uiError: '"ui.contributes.widgets" is not a contribution point' };
  const r = buildRegistry([settings, forged, broken], { required: ['core.settings'] });
  assert.equal(r.settings.length, 1, 'a required plugin contributes even when switched off');
  assert.ok(!r.views.has('evil:v'), 'native components only from the app\'s own plugins');
  assert.ok(r.errors.some((e) => e.plugin === 'evil' && /Native UI/.test(e.error)));
  assert.ok(r.errors.some((e) => e.plugin === 'broken'));
});

test('registry: commands take the person\'s keybindings, conflicts are reported, slash names first come first served', () => {
  const a = native('core.shell', { commands: [{ id: 'palette', title: 'Palette', keybinding: 'Mod+K', handler: 'palette' }, { id: 'sidebar', title: 'Sidebar', keybinding: 'Mod+B', handler: 'sidebar' }], slashCommands: [{ name: 'plan', description: 'Plan', action: { type: 'prompt', prompt: 'p' } }] });
  const b = third('acme', { contributes: { commands: [{ id: 'go', title: 'Go', keybinding: 'Mod+K', action: { type: 'open-url', url: 'https://example.com' } }], slashCommands: [{ name: 'plan', description: 'Mine', action: { type: 'prompt', prompt: 'q' } }] } });
  const r = buildRegistry([a, b], { keybindings: { 'core.shell:sidebar': 'Ctrl+Alt+S' } });
  assert.equal(r.commands.find((c) => c.qid === 'core.shell:sidebar')!.keys, 'Ctrl+Alt+S');
  assert.equal(r.commands.find((c) => c.qid === 'core.shell:sidebar')!.defaultKeys, 'Mod+B');
  assert.deepEqual(r.conflicts.find((c) => c.kind === 'keybinding')?.ids, ['core.shell:palette', 'acme:go']);
  assert.equal(r.slashCommands.filter((s) => s.name === 'plan').length, 1);
  assert.equal(r.slashCommands[0]!.plugin, 'core.shell', 'the built-in keeps /plan');
  const unbound = buildRegistry([a], { keybindings: { 'core.shell:palette': '' } });
  assert.equal(unbound.commands.find((c) => c.qid === 'core.shell:palette')!.keys, undefined, '"" unbinds');
  assert.equal(normaliseChordText('shift+ctrl+p'), 'Ctrl+Shift+P');
});

test('registry: a third-party renderer replaces a built-in default; renderers by tool, event and fence', () => {
  const builtin = native('core.chat', { renderers: [{ id: 'mermaid', for: { fence: 'mermaid' }, kind: 'native', component: 'M' }] });
  const plugin = third('better-diagrams', { trust: 'frame', contributes: { renderers: [{ id: 'm', for: { fence: 'mermaid' }, kind: 'frame', entry: 'ui/m.html' }, { id: 't', for: { tool: 'note_save' }, kind: 'frame', entry: 'ui/t.html' }, { id: 'e', for: { event: 'notice' }, kind: 'frame', entry: 'ui/e.html' }] } });
  const r = buildRegistry([plugin, builtin]);
  assert.equal(rendererFor(r, 'fence', 'mermaid')!.plugin, 'better-diagrams');
  assert.equal(rendererFor(r, 'tool', 'note_save')!.qid, 'better-diagrams:t');
  assert.equal(rendererFor(r, 'event', 'notice')!.entry, 'ui/e.html');
  assert.equal(rendererFor(r, 'fence', 'python'), undefined);
});

test('registry: all thirteen contribution points resolve from one manifest', () => {
  const p = third('everything', {
    trust: 'frame', capabilities: ['sessions.read'],
    contributes: {
      navItems: [{ id: 'n', title: 'N', view: 'v' }], views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'ui/v.html' }], panels: [{ id: 'p', title: 'P', kind: 'frame', entry: 'ui/p.html' }],
      commands: [{ id: 'c', title: 'C', action: { type: 'open-view', view: 'v' } }], slashCommands: [{ name: 's', description: 'S', action: { type: 'prompt', prompt: 'x {args}' } }],
      composerChips: [{ id: 'chip', title: 'Chip', kind: 'toggle', setting: 'everything.on' }], settings: [{ id: 'st', title: 'St', scope: 'account', schema: { type: 'object', properties: { a: { type: 'string' } } } }],
      renderers: [{ id: 'r', for: { fence: 'ev' }, kind: 'frame', entry: 'ui/r.html' }], homeCards: [{ id: 'h', title: 'H', kind: 'markdown', markdown: 'hi' }],
      statusItems: [{ id: 'si', text: '{everything.count} things' }], themes: [{ id: 't', label: 'T', mode: 'dark', background: '#000000', foreground: '#ffffff', accent: '#ff0000' }],
      prompts: [{ id: 'pr', title: 'Pr', prompt: 'do', home: true }], onboarding: [{ id: 'o', title: 'O', view: 'v' }],
    },
  });
  const r = buildRegistry([p]);
  assert.equal(r.navItems.length, 1); assert.equal(r.views.size, 1); assert.equal(r.panels.size, 1); assert.equal(r.commands.length, 1);
  assert.equal(r.slashCommands.length, 1); assert.equal(r.composerChips.length, 1); assert.equal(r.settings.length, 1); assert.equal(r.renderers.fence.size, 1);
  assert.equal(r.homeCards.length, 1); assert.equal(r.statusItems.length, 1); assert.equal(r.themes[0]!.qid, 'everything:t'); assert.equal(r.prompts.length, 1);
  assert.equal(r.onboarding[0]!.view, 'everything:v');
  assert.equal(interpolate(r.statusItems[0]!.text, { 'everything.count': 3 }), '3 things');
  assert.equal(interpolate('{missing} left', {}), '0 left');
});

test('palette fuzzy match: substrings first, then letters in order', () => {
  assert.ok(fuzzyScore('sett', 'Open settings') > fuzzyScore('sett', 'Search the text'));
  assert.ok(fuzzyScore('nc', 'New chat') > 0);
  assert.equal(fuzzyScore('zz', 'New chat'), -1);
  assert.equal(fuzzyScore('', 'anything'), 1);
});

test('keybindings: parse, match, record and show chords; Mod is Ctrl or Cmd', () => {
  const k = parseChord('Mod+K', 'win32')!;
  assert.deepEqual(k, { ctrl: true, alt: false, shift: false, meta: false, key: 'k' });
  assert.equal(parseChord('Mod+K', 'darwin')!.meta, true);
  assert.equal(parseChord('Hyper+K'), null);
  assert.equal(parseChord(''), null);
  assert.equal(parseChord('Alt+Left')!.key, 'ArrowLeft');
  assert.equal(parseChord('Ctrl++')!.key, '+');
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}, code?: string) => ({ key, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.ok(matches(k, ev('k', { ctrlKey: true }, 'KeyK')));
  assert.ok(matches(k, ev('K', { ctrlKey: true }, 'KeyK')), 'case does not matter');
  assert.ok(!matches(k, ev('k', { ctrlKey: true, shiftKey: true }, 'KeyK')), 'an extra Shift is another chord');
  assert.ok(matches(parseChord('Ctrl+Alt+N')!, ev('ñ', { ctrlKey: true, altKey: true }, 'KeyN')), 'the physical key when Alt changes the character');
  assert.ok(matches(parseChord('Mod+,')!, ev(',', { ctrlKey: true }, 'Comma')));
  assert.equal(chordFromEvent(ev('p', { ctrlKey: true, shiftKey: true }, 'KeyP')), 'Ctrl+Shift+P');
  assert.equal(chordFromEvent(ev('Shift', { shiftKey: true })), null, 'a lone modifier is not a chord');
  assert.equal(formatChord('Mod+Shift+P', 'win32'), 'Ctrl+Shift+P');
  assert.equal(formatChord('Mod+Shift+P', 'darwin'), '⇧⌘P');
  assert.equal(formatChord('Alt+Left', 'win32'), 'Alt+←');
  assert.ok(allowedWhileTyping(parseChord('Mod+K')!));
  assert.ok(!allowedWhileTyping(parseChord('Alt+Left')!), 'Alt+Left in a text box moves the caret, not back');
  assert.deepEqual(conflicts([{ id: 'a', keys: 'Ctrl+K' }, { id: 'b', keys: 'Mod+K' }, { id: 'c', keys: 'Ctrl+J' }], 'win32').map((c) => c.ids), [['a', 'b']]);
});
