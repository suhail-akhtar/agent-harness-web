// Documents, as any server loads it: its agents, workflows and skills, every skill with its instructions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('documents: its agents, workflows and skills load; each skill says what it is for', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.agents.sort(), ['deck-designer', 'document-author', 'outline-writer', 'visual-reviewer']);
    assert.deepEqual(kit.adds.workflows.sort(), ['make-deck', 'write-document']);
    assert.deepEqual(kit.adds.skills.sort(), ['document-design', 'docx-recipes', 'pptxgenjs-recipes', 'slide-design']);
    for (const s of kit.adds.skills) {
      const md = await fs.readFile(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8');
      assert.match(md, /^---[\s\S]*?\bdescription:\s*\S[\s\S]*?---/, `${s} has a description`);
      assert.ok(md.length > 500, `${s} has instructions`);
    }
  } finally { await kit.close(); }
});
