// The desktop app is built from @harness/ui's standard components: pages use Page (not their own
// scroll column and title row), form controls are the library's (not the browser's raw ones), and
// nothing pops up a browser dialog. A real exception is listed here with its reason, so a new one is
// a decision, not drift. The components and their states: Command palette > Open the component gallery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC = path.resolve('apps/desktop/renderer/src');
const files = (fs.readdirSync(SRC, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx')).map((f) => f.split(path.sep).join('/'));
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

/** Where a page title is not Page's, and why. */
const OWN_TITLE: Record<string, string> = {
  'builtins/core.chat/Views.tsx': 'the home greeting, centred over the composer',
  'shell/Overlays.tsx': 'the engine gate, shown before any page can be',
  'builtins/dashboards/Doc.tsx': "a document's editable title in its editor toolbar",
  'builtins/dashboards/Data.tsx': 'a full-height tool page: title and tabs in a toolbar over split panes',
  'builtins/plugin-home.tsx': "ModuleHeader: the one header of every plugin's home (icon, purpose, Ask the agent)",
};
/** Where a raw form control stays, and why. */
const RAW_CONTROL: Record<string, string> = {
  'builtins/core.chat/Composer.tsx': "the composer's growing text box and its inline chip choices",
};

test('ui standards: pages use Page, not a hand-made scroll column with its own title row', () => {
  const shell = /hx-scroll h-full overflow-(?:y-)?auto"[^>]*>\s*<div className="mx-auto max-w-/;
  const hand = files.filter((f) => shell.test(read(f)));
  assert.deepEqual(hand, [], `use <Page> from @harness/ui in: ${hand.join(', ')}`);
  const titled = files.filter((f) => /<h1[\s>]/.test(read(f)) && !OWN_TITLE[f]);
  assert.deepEqual(titled, [], `a page title belongs to <Page title=...> (or add the file to OWN_TITLE with a reason): ${titled.join(', ')}`);
  for (const f of Object.keys(OWN_TITLE)) assert.ok(files.includes(f) && /<h1[\s>]/.test(read(f)), `${f} is listed in OWN_TITLE but has no title of its own any more: take it off the list`);
});

test('ui standards: the library\'s form controls and dialogs, never the browser\'s raw ones', () => {
  const raw = /<select[\s>]|<textarea[\s>]|type="checkbox"|type="radio"/;
  const found = files.filter((f) => raw.test(read(f)) && !RAW_CONTROL[f]);
  assert.deepEqual(found, [], `use Select, Textarea, Checkbox or Switch from @harness/ui in: ${found.join(', ')}`);
  const dialogs = files.filter((f) => /\bwindow\.(alert|confirm|prompt)\(|(^|[^.\w])(alert|confirm|prompt)\(['"`]/m.test(read(f)));
  assert.deepEqual(dialogs, [], `use ConfirmDialog, useApp().ask or toast instead of a browser dialog in: ${dialogs.join(', ')}`);
});

test('ui standards: the gallery shows every layout component', () => {
  const gallery = read('builtins/gallery.tsx');
  const layout = fs.readFileSync(path.resolve('packages/ui/src/components/layout.tsx'), 'utf8');
  const exported = [...layout.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!);
  assert.ok(exported.length >= 4);
  for (const name of exported) assert.match(gallery, new RegExp(`<${name}[\\s>]`), `the gallery shows ${name}`);
});
