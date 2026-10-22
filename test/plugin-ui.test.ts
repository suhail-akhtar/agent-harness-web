import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALLS, CAPABILITIES, ManifestError, PROTOCOL, isPluginFile, needsConfirm, needsGesture, qualify, refuseCall, uiEntries, validateUiManifest } from '../packages/plugin-ui/src/index.ts';
import { connect } from '../packages/plugin-ui/src/sdk.ts';

const full = {
  displayName: 'Notes', icon: 'book', category: 'Productivity', trust: 'frame',
  capabilities: ['sessions.read', 'routes.call'],
  contributes: {
    navItems: [{ id: 'notes', title: 'Notes', icon: 'book', view: 'notes', order: 30, badge: 'notes.unread' }],
    views: [
      { id: 'notes', title: 'Notes', kind: 'frame', entry: 'ui/notes.html' },
      { id: 'about', title: 'About', kind: 'markdown', markdown: '# Notes' },
      { id: 'links', title: 'Links', kind: 'links', links: [{ title: 'Docs', url: 'https://example.com' }] },
      { id: 'ideas', title: 'Ideas', kind: 'prompt-board', prompts: [{ title: 'Plan', prompt: 'Plan my day' }] },
      { id: 'new', title: 'New note', kind: 'form', schema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } } }, submit: { action: { type: 'route', path: 'notes', method: 'POST' } } },
    ],
    panels: [{ id: 'outline', title: 'Outline', kind: 'frame', entry: 'ui/outline.html', where: 'session' }],
    commands: [{ id: 'open', title: 'Open notes', keybinding: 'Ctrl+Alt+N', action: { type: 'open-view', view: 'notes' } }],
    slashCommands: [{ name: 'summarise', description: 'Summarise into a note', action: { type: 'prompt', prompt: 'Summarise {args}' } }],
    composerChips: [{ id: 'book', title: 'Notebook', kind: 'select', setting: 'notes.notebook', options: ['work', 'home'] }],
    settings: [{ id: 'notes', title: 'Notes', scope: 'account', schema: { type: 'object', properties: { folder: { type: 'string', format: 'path' } } } }],
    renderers: [{ id: 'card', for: { tool: 'note_save' }, kind: 'frame', entry: 'ui/card.html' }, { id: 'fence', for: { fence: 'note' }, kind: 'frame', entry: 'ui/card.html' }],
    homeCards: [{ id: 'today', title: 'Today', kind: 'frame', entry: 'ui/today.html' }],
    statusItems: [{ id: 'unread', text: '{notes.unread} unread', command: 'open' }],
    themes: [{ id: 'paper', label: 'Paper', mode: 'light', background: '#fbf8f1', foreground: '#2b2722', accent: '#b4532a' }],
    prompts: [{ id: 'daily', title: 'Daily summary', prompt: 'Write it', home: true }],
    onboarding: [{ id: 'first', title: 'Create a notebook', view: 'new' }],
  },
};

test('plugin-ui manifest: every contribution point validates and is normalised; entries listed for serving', () => {
  const ui = validateUiManifest(full);
  assert.equal(ui.apiVersion, 1);
  assert.equal(ui.trust, 'frame');
  assert.deepEqual(ui.capabilities, ['sessions.read', 'routes.call']);
  assert.equal(ui.contributes.views.length, 5);
  assert.deepEqual(uiEntries(ui).sort(), ['ui/card.html', 'ui/notes.html', 'ui/outline.html', 'ui/today.html']);
  assert.equal(qualify('acme-notes', 'notes'), 'acme-notes:notes');
  assert.equal(qualify('acme-notes', 'core.chat:home'), 'core.chat:home');
  // Declarative-only needs no trust and gets "declarative".
  const dec = validateUiManifest({ contributes: { views: [{ id: 'a', title: 'A', kind: 'markdown', markdown: 'x' }], commands: [{ id: 'c', title: 'C', action: { type: 'open-view', view: 'a' } }] } });
  assert.equal(dec.trust, 'declarative');
  assert.deepEqual(dec.contributes.panels, []);
});

test('plugin-ui manifest: mistakes are refused with a message a person can act on', () => {
  const bad = (contributes: unknown, extra: Record<string, unknown> = {}) => () => validateUiManifest({ contributes, ...extra });
  assert.throws(bad({ widgets: [] }), /"ui.contributes.widgets" is not a contribution point/);
  assert.throws(bad({ views: [{ id: 'v', title: 'V', kind: 'frame', entry: '../../etc/passwd' }] }), /needs an "entry" file inside the plugin folder/);
  assert.throws(bad({ views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'https://evil.example/x.html' }] }), /inside the plugin folder/);
  assert.throws(bad({ views: [{ id: 'v', title: 'V', kind: 'frame', entry: '/abs.html' }] }), /inside the plugin folder/);
  assert.throws(bad({ views: [{ id: 'v', title: 'V', kind: 'html', entry: 'a.html' }] }), /kind "html"/);
  assert.throws(bad({ views: [{ id: 'v', title: 'V', kind: 'markdown', markdown: 'x' }, { id: 'v', title: 'W', kind: 'markdown', markdown: 'y' }] }), /Duplicate view id "v"/);
  assert.throws(bad({ commands: [{ id: 'c', title: 'C', action: { type: 'shell', command: 'rm' } }] }), /needs a "type"/);
  assert.throws(bad({ commands: [{ id: 'c', title: 'C', keybinding: 'Hyper+Q', action: { type: 'theme', theme: 't' } }] }), /is not a keybinding/);
  assert.throws(bad({ commands: [{ id: 'c', title: 'C', action: { type: 'open-url', url: 'javascript:alert(1)' } }] }), /must be http\(s\)/);
  assert.throws(bad({ commands: [{ id: 'c', title: 'C', action: { type: 'route', path: '../admin' } }] }), /route paths/);
  assert.throws(bad({ slashCommands: [{ name: 'Bad Name', description: 'x', action: { type: 'prompt', prompt: 'x' } }] }), /needs a "name"/);
  assert.throws(bad({ themes: [{ id: 't', label: 'T', mode: 'dark', background: 'red', foreground: '#fff', accent: '#000' }] }), /"background" as a #hex colour/);
  assert.throws(bad({ settings: [{ id: 's', title: 'S', scope: 'global', schema: {} }] }), /scope is app, account or operator/);
  assert.throws(bad({ settings: [{ id: 's', title: 'S', scope: 'app', schema: { type: 'object', properties: { x: { type: 'string', pattern: '(' } } } }] }), /not a valid regular expression/);
  assert.throws(bad({ renderers: [{ id: 'r', for: { tool: 'a', fence: 'b' }, kind: 'frame', entry: 'r.html' }] }), /needs "for"/);
  assert.throws(bad({ composerChips: [{ id: 'k', title: 'K', kind: 'select', setting: 'nodot' }] }), /"setting" like/);
  assert.throws(bad({ navItems: [{ id: 'n', title: 'N', view: 'v', icon: 'not-an-icon' }] }), /unknown icon/);
  assert.throws(() => validateUiManifest({ apiVersion: 99 }), /newer than this host supports/);
  assert.throws(() => validateUiManifest({ capabilities: ['root'] }), /"ui.capabilities" lists capabilities from/);
  assert.throws(() => validateUiManifest({ trust: 'declarative', capabilities: ['sessions.read'], contributes: {} }), /declarative UI runs no code/);
  assert.ok(new ManifestError('x') instanceof Error);
});

test('plugin-ui trust: what the contributions need, at most what was declared, and native only under a host that trusts the signer', () => {
  const frame = { contributes: { views: [{ id: 'v', title: 'V', kind: 'frame', entry: 'v.html' }] } };
  assert.equal(validateUiManifest(frame).trust, 'frame');
  assert.throws(() => validateUiManifest({ ...frame, trust: 'declarative' }), /need "frame"/);
  const native = { contributes: { views: [{ id: 'v', title: 'V', kind: 'native', component: 'NotesPage' }] } };
  assert.throws(() => validateUiManifest(native), /Native UI is only for plugins signed by a key this app trusts/);
  assert.equal(validateUiManifest(native, { trustCeiling: 'native' }).trust, 'native');
  assert.throws(() => validateUiManifest({ contributes: { settings: [{ id: 's', title: 'S', scope: 'app', component: 'Panel' }] } }), /Native UI/);
  assert.throws(() => validateUiManifest({ trust: 'frame', contributes: {} }, { trustCeiling: 'declarative' }), /more than this host allows/);
});

test('plugin-ui files: only relative paths inside the plugin', () => {
  for (const ok of ['a.html', 'ui/a.html', 'ui/deep/b.js']) assert.ok(isPluginFile(ok), ok);
  for (const no of ['', '../a', 'ui/../../a', '/a', '\\a', 'C:/a', 'file:///a', 'ui//a', './a', 'a/./b', 'x'.repeat(201)]) assert.ok(!isPluginFile(no), no);
});

test('plugin-ui protocol: the host refuses unknown methods and calls a frame was not granted; gestures and confirmations by method', () => {
  const call = (method: string, extra: Record<string, unknown> = {}) => ({ protocol: PROTOCOL, kind: 'call', id: 1, method, ...extra });
  assert.equal(refuseCall(call('theme.get'), []), undefined, 'every frame may read the theme');
  assert.match(refuseCall(call('sessions.list'), [])!, /needs the "sessions.read" capability/);
  assert.equal(refuseCall(call('sessions.list'), ['sessions.read']), undefined);
  assert.match(refuseCall(call('eval'), CAPABILITIES)!, /unknown method/);
  assert.match(refuseCall(call('__proto__'), CAPABILITIES)!, /unknown method/);
  assert.match(refuseCall(call('constructor'), CAPABILITIES)!, /unknown method/);
  assert.match(refuseCall({ ...call('theme.get'), protocol: 'other' }, [])!, /not a harness-ui call/);
  assert.match(refuseCall({ ...call('theme.get'), id: 'x' }, [])!, /numeric id/);
  assert.match(refuseCall(null, [])!, /not a message/);
  assert.ok(needsGesture('approvals.respond') && needsGesture('external.open') && needsGesture('clipboard.write'));
  assert.ok(!needsGesture('sessions.list'));
  assert.ok(needsConfirm('sessions.start') && needsConfirm('workflows.start') && !needsConfirm('routes.call'));
  for (const [m, spec] of Object.entries(CALLS)) assert.ok(spec.capability === null || CAPABILITIES.includes(spec.capability), m);
});

test('plugin-ui SDK: connects on init, round-trips calls, applies the theme, delivers events only from the parent', async () => {
  const sent: any[] = [];
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const style = new Map<string, string>();
  const parent = { postMessage: (m: unknown) => sent.push(m) };
  const win = {
    parent,
    addEventListener: (type: string, fn: (e: any) => void) => { (listeners[type] ??= []).push(fn); },
    document: { documentElement: { style: { setProperty: (k: string, v: string) => style.set(k, v) } }, body: { scrollHeight: 321 } },
  };
  const deliver = (data: unknown, source: unknown = parent) => { for (const f of listeners.message ?? []) f({ data, source }); };
  const p = connect(win as never, { timeoutMs: 1000 });
  deliver({ protocol: PROTOCOL, kind: 'init', plugin: 'evil', contribution: 'x', params: {}, theme: {}, apiVersion: 1, capabilities: [] }, { not: 'parent' });
  deliver({ protocol: PROTOCOL, kind: 'init', plugin: 'acme-notes', contribution: 'notes', params: { a: '1' }, theme: { accent: '#b4532a' }, apiVersion: 1, capabilities: ['sessions.read'] });
  const h = await p;
  assert.equal(h.plugin, 'acme-notes', 'a message from anyone but the parent is ignored');
  assert.equal(style.get('--accent'), '#b4532a');
  const listed = h.sessions.list({ limit: 5 });
  const c = sent.at(-1);
  assert.deepEqual({ protocol: c.protocol, kind: c.kind, method: c.method, params: c.params, gesture: c.gesture }, { protocol: PROTOCOL, kind: 'call', method: 'sessions.list', params: { limit: 5 }, gesture: false });
  deliver({ protocol: PROTOCOL, kind: 'result', id: c.id, ok: true, value: [{ id: 's1' }] });
  assert.deepEqual(await listed, [{ id: 's1' }]);
  const refused = h.approvals.respond('s1', 'r1', 'approve');
  deliver({ protocol: PROTOCOL, kind: 'result', id: sent.at(-1).id, ok: false, error: 'approvals.respond needs the "approvals.respond" capability' });
  await assert.rejects(refused, /needs the "approvals.respond" capability/);
  // A click in the frame marks the next call as a gesture.
  for (const f of listeners.pointerdown ?? []) f({});
  void h.external.open('https://example.com');
  assert.equal(sent.at(-1).gesture, true);
  // Events: subscribe, deliver, theme changes.
  const got: unknown[] = [];
  const sub = h.events.subscribe('approvals', (e) => got.push(e));
  deliver({ protocol: PROTOCOL, kind: 'result', id: sent.at(-1).id, ok: true });
  const off = await sub;
  deliver({ protocol: PROTOCOL, kind: 'event', topic: 'approvals', payload: { n: 1 } });
  deliver({ protocol: PROTOCOL, kind: 'event', topic: 'approvals', payload: { n: 2 } }, { someone: 'else' });
  deliver({ protocol: PROTOCOL, kind: 'event', topic: 'theme', payload: { accent: '#000000' } });
  assert.deepEqual(got, [{ n: 1 }]);
  assert.equal(style.get('--accent'), '#000000');
  off();
  assert.equal(sent.at(-1).method, 'events.unsubscribe');
  void h.frame.resize();
  assert.deepEqual(sent.at(-1).params, { height: 321 });
});

test('plugin-ui SDK: outside the app (no host) it says so instead of hanging', async () => {
  const win = { parent: { postMessage() {} }, addEventListener() {} };
  await assert.rejects(connect(win as never, { timeoutMs: 50 }), /no host answered/);
});
