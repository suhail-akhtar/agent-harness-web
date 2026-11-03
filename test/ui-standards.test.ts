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
};
/** Where a raw form control stays, and why. */
const RAW_CONTROL: Record<string, string> = {
  'builtins/core.chat/Composer.tsx': "the composer's growing text box and its inline chip choices",
  'builtins/core.settings/server-sections.tsx': "the delegation models' toggle chips (a visually hidden checkbox in each chip's label)",
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

// The design system (docs/desktop/DESIGN-SYSTEM.md): type roles, status tints and the shared blocks, never a
// page's own copy. The kit (packages/ui) defines them; the app and the kit's renderers use them.
const KIT = path.resolve('packages/ui/src');
const kitFiles = (fs.readdirSync(KIT, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts')).map((f) => f.split(path.sep).join('/'));
const both = [...files.map((f) => ({ f, text: read(f) })), ...kitFiles.map((f) => ({ f: `ui/${f}`, text: fs.readFileSync(path.join(KIT, f), 'utf8') }))];
/** Where a tone colour with an opacity stays, and why (a meter's fill, not a tint). */
const TINT_OK: Record<string, string> = {
  'builtins/dashboards/Data.tsx': "a quality meter's empty track",
  'ui/render/dashboard/Visual.tsx': "a table cell's data bar",
  'ui/render/dashboard/Layouts.tsx': "the sidebar resize handle's hover",
};

test('design system: text sizes are the type roles (text-caption, text-body, ...), never a pixel size', () => {
  const px = both.filter(({ text }) => /\btext-\[\d+(?:\.\d+)?px\]/.test(text)).map(({ f }) => f);
  assert.deepEqual(px, [], `use a type role (micro, tiny, caption, small, body, body-lg, title, heading, display) in: ${px.join(', ')}`);
});

test('design system: status tints are tokens (bg-hx-danger-soft, border-hx-warning-border), never an opacity on a tone', () => {
  const tint = /\b(?:bg|border|ring)-hx-(?:danger|warning|success|info|accent|accent-soft)\/\d+\b/;
  const found = both.filter(({ f, text }) => tint.test(text) && !TINT_OK[f]).map(({ f }) => f);
  assert.deepEqual(found, [], `use the -soft and -border tokens (or Callout, Badge, Card tone) in: ${found.join(', ')}`);
});

test('design system: pages use the kit\'s blocks, not their own copies of a section, a stat tile or a choice row', () => {
  const own = files.filter((f) => /^(?:export )?function (?:Section|Kpi|StatCard|Choice|Callout|EmptyBox)\b/m.test(read(f))).map((f) => f);
  assert.deepEqual(own, [], `use Section, StatCard, ChoiceGroup or Callout from @harness/ui in: ${own.join(', ')}`);
  const hand = files.filter((f) => /<p role="alert" className="[^"]*bg-hx-danger/.test(read(f)));
  assert.deepEqual(hand, [], `an error note is a <Callout tone="danger"> in: ${hand.join(', ')}`);
});
