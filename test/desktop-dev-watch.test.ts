// A plugin folder loaded in the desktop app, edited: which changes reload its server code in the engine
// (everything but its page folders and docs), and its page grant holding across the author's own edits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { isServerFile, pageDirsOf } from '../apps/desktop/electron/dev-watch.ts';
import { decide } from '../apps/desktop/shared/grants.ts';
import { tempDir } from './helpers.ts';

test('dev watch: page folders come from the ui entries; code, skills and the manifest are server files', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'harness-plugin.json'), JSON.stringify({ name: 'x', main: 'index.mjs', ui: { contributes: { views: [{ id: 'a', entry: 'web/pages/a.html' }], panels: [{ id: 'p', entry: 'web/side.html' }] } } }));
  const pages = pageDirsOf(dir);
  assert.deepEqual(pages.sort(), ['web', 'web/pages']);
  const server = (f: string) => isServerFile(f.split('/').join(path.sep), pages);
  assert.equal(server('index.mjs'), true);
  assert.equal(server('lib/store.mjs'), true);
  assert.equal(server('harness-plugin.json'), true);
  assert.equal(server('skills/x/SKILL.md'), true, 'a skill is read by the engine');
  assert.equal(server('web/pages/a.html'), false);
  assert.equal(server('web/app.js'), false);
  assert.equal(server('README.md'), false);
  assert.equal(server('node_modules/y/index.js'), false);
  assert.deepEqual(pageDirsOf(path.join(dir, 'missing')), ['ui']);
});

test('grants: a plugin folder the person loaded keeps its grant across their edits, unless it asks for more', () => {
  const record = { uiHash: 'h1', capabilities: ['routes.call'] as const, at: 1 };
  assert.equal(decide({ ...record, capabilities: [...record.capabilities] }, 'h2', ['routes.call']).state, 'ask', 'anything else: asked again after a change');
  assert.equal(decide({ ...record, capabilities: [...record.capabilities] }, 'h2', ['routes.call'], { acrossEdits: true }).state, 'granted');
  assert.equal(decide({ ...record, capabilities: [...record.capabilities] }, 'h2', ['routes.call', 'sessions.start'], { acrossEdits: true }).state, 'ask', 'a new capability is asked');
});
