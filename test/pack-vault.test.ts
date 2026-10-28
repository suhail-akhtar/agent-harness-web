import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../src/kernel/harness.ts';
import { FakeProvider, results, tempDir } from './helpers.ts';
import { pluginDir } from '../src/plugins/test-fixtures.ts';

// The AIOps pack against the real Key Vault (the plugins' own tests use a stand-in):
// an operator stores a token, an agent's tool call uses it, and it never reaches the model.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('devops ci with the real vault: the operator\'s token reaches GitHub, never the model; the use is audited for the plugin', async () => {
  const seen: { url: string; auth?: string }[] = [];
  const gh = http.createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ workflow_runs: [{ id: 42, name: 'ci', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'failure', head_sha: 'abc1234def', html_url: 'https://github.com/acme/shop/actions/runs/42', created_at: '2026-10-21T10:00:00Z', updated_at: '2026-10-21T10:05:00Z', run_attempt: 1, display_title: 'fix sum' }] }));
  });
  await new Promise<void>((r) => gh.listen(0, '127.0.0.1', r));
  const before = process.env.HARNESS_GITHUB_API;
  process.env.HARNESS_GITHUB_API = `http://127.0.0.1:${(gh.address() as { port: number }).port}`;
  // A GitHub Enterprise-style address: the operator grants the plugin that host.
  const grantBefore = process.env.HARNESS_PLUGIN_NETWORK;
  process.env.HARNESS_PLUGIN_NETWORK = JSON.stringify({ devops: ['127.0.0.1'] });
  const token = `ghp_${'Q'.repeat(36)}`;
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, search: null, memory: 'off', scheduler: false, plugins: [pluginDir('devops')] });
  const fake = new FakeProvider([{ calls: [{ name: 'ci', input: { action: 'runs', repo: 'acme/shop' } }] }, { text: 'Run 42 failed.' }]);
  h.registry.setProviderInstance('deepseek', fake);
  try {
    assert.ok(h.vault, 'the vault is on by default');
    await h.vault!.put({ admin: true, label: 'test operator' }, { name: 'github-token', scope: 'operator', kind: 'token', value: token });
    const s = await h.sessions.create({ model: 'deepseek-flash', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: await tempDir() } });
    const ended = new Promise<void>((r) => s.subscribe(0, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
    await s.send('what is failing in CI?');
    await ended;
    const out = results(s.history[2])[0]!.content;
    assert.match(out, /#42/, out);
    assert.equal(seen[0]?.auth, `Bearer ${token}`, 'GitHub got the token from the vault');
    for (const req of fake.requests) assert.ok(!JSON.stringify(req).includes(token), 'no request to the model holds the token');
    assert.ok(!JSON.stringify(s.history).includes(token));
    const audit = await h.vault!.audit();
    assert.ok(audit.some((a) => a.action === 'reveal' && a.name === 'github-token' && a.plugin === 'devops' && a.result === 'ok'), JSON.stringify(audit.slice(-3)));
  } finally {
    if (before === undefined) delete process.env.HARNESS_GITHUB_API; else process.env.HARNESS_GITHUB_API = before;
    if (grantBefore === undefined) delete process.env.HARNESS_PLUGIN_NETWORK; else process.env.HARNESS_PLUGIN_NETWORK = grantBefore;
    gh.close();
    await h.close();
  }
});
