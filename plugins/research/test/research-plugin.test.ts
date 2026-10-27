// Research, as any server loads it: its tools, agents, workflow, skills and citations gate; check_citations
// on a report whose sources were never read, and sources without a source store, answer clearly.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { loadPlugin } from '@harness/plugin-sdk/testing';

const dir = new URL('..', import.meta.url);

test('research: loads whole; check_citations and sources answer clearly', async () => {
  const kit = await loadPlugin(dir);
  try {
    assert.equal(kit.error, undefined);
    assert.deepEqual(kit.adds.tools.sort(), ['check_citations', 'sources']);
    assert.deepEqual(kit.adds.agents.sort(), ['fact-checker', 'research-lead', 'research-writer', 'researcher']);
    assert.deepEqual(kit.adds.workflows, ['deep-research']);
    assert.deepEqual(kit.adds.gates, ['citations']);
    await fs.mkdir(path.join(kit.workspace, 'research'), { recursive: true });
    await fs.writeFile(path.join(kit.workspace, 'research', 'report.md'), '# Report\n\nA claim [1].\n\n## References\n\n1. https://example.org/never-read\n');
    const c = await kit.tool('check_citations', { path: 'research/report.md' });
    assert.ok(c.content.length > 0);
    assert.equal((await kit.tool('check_citations', {})).isError, true, 'a path is needed');
    const s = await kit.tool('sources', { command: 'list' });
    assert.ok(s.content.length > 0);
  } finally { await kit.close(); }
});
