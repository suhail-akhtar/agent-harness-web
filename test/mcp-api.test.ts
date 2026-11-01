import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startModernHttp } from './mcp-fixtures.ts';
import { OPERATOR, setupServer } from './multi-helpers.ts';

// /api/me/mcp: a person's own MCP servers over HTTP, the browser's return from a sign-in, imports, and who may do what.

test('the API: add, test, sign in through the browser, approve, policies, import, remove; each person their own; a member\'s limits', async () => {
  const t = await setupServer();
  const srv = await startModernHttp({ MCP_OAUTH: '1' });
  try {
    const al = await t.member('al');
    const bo = await t.member('bo');
    const c = (tok: string, m: string, p: string, b?: unknown) => t.call(tok, m, p, b);

    // A member: no commands, https only, a private address never connects.
    assert.equal((await c(al.token, 'GET', '/api/me/mcp')).body.admin, false);
    assert.equal((await c(al.token, 'POST', '/api/me/mcp', { name: 'cmd', type: 'stdio', command: 'node' })).status, 403);
    assert.equal((await c(al.token, 'POST', '/api/me/mcp', { name: 'plain', type: 'http', url: srv.url })).status, 400);
    assert.equal((await c(al.token, 'POST', '/api/me/mcp', { name: 'inside', type: 'http', url: 'https://127.0.0.1:1/mcp' })).status, 201);
    const inside = (await c(al.token, 'POST', '/api/me/mcp/inside/test')).body;
    assert.equal(inside.ok, false);
    assert.match(inside.error, /private/);
    // A secret written into a header is refused.
    const secret = await c(al.token, 'POST', '/api/me/mcp', { name: 'leaky', type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer sk-1234567890abcdefghij' } });
    assert.equal(secret.status, 400);
    assert.match(secret.body.error, /vault/);
    // Bo sees none of al's.
    assert.deepEqual((await c(bo.token, 'GET', '/api/me/mcp')).body.servers, []);
    assert.equal((await c(bo.token, 'GET', '/api/me/mcp/inside')).status, 404);
    assert.equal((await c(bo.token, 'DELETE', '/api/me/mcp/inside')).status, 404);

    // An administrator's server that needs sign-in.
    const made = await c(OPERATOR, 'POST', '/api/me/mcp', { name: 'notes', type: 'http', url: srv.url, description: 'My notes' });
    assert.equal(made.status, 201, made.text);
    const before = (await c(OPERATOR, 'POST', '/api/me/mcp/notes/test')).body;
    assert.equal(before.needsSignIn, true);
    const start = (await c(OPERATOR, 'POST', '/api/me/mcp/notes/signin')).body;
    assert.ok(start.authorizeUrl, JSON.stringify(start));
    // The browser: the service approves and sends it back to the harness's callback (no harness sign-in there).
    const back = await fetch(start.authorizeUrl, { redirect: 'manual' });
    const callback = back.headers.get('location')!;
    assert.equal(new URL(callback).pathname, '/api/mcp/oauth/callback');
    const page = await fetch(callback);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in to notes/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    // The same return again: refused.
    const again = await fetch(callback);
    assert.equal(again.status, 400);
    assert.match(await again.text(), /expired or was already used/);
    // An error from the service, shown escaped.
    const err = await fetch(new URL('/api/mcp/oauth/callback?error=access_denied&error_description=%3Cscript%3E', callback));
    assert.ok(!(await err.text()).includes('<script>'));

    const ok = (await c(OPERATOR, 'POST', '/api/me/mcp/notes/test')).body;
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.protocol, '2026-07-28');
    assert.ok(ok.tools.every((x: { state: string }) => x.state === 'approved'));
    const listed = (await c(OPERATOR, 'GET', '/api/me/mcp')).body;
    assert.equal(listed.admin, true);
    assert.equal(listed.servers[0].signedIn, true);
    assert.equal(listed.servers[0].status.ok, true);

    // Policies and approval.
    assert.equal((await c(OPERATOR, 'PUT', '/api/me/mcp/notes/tools', { policies: { add: 'never' } })).status, 400);
    assert.deepEqual((await c(OPERATOR, 'PUT', '/api/me/mcp/notes/tools', { policies: { add: 'allow', slow: 'block' } })).body.policies, { add: 'allow', slow: 'block' });
    const ap = (await c(OPERATOR, 'POST', '/api/me/mcp/notes/approve', {})).body;
    assert.equal(ap.ok, true);
    // A stale save; turning it off.
    const v = (await c(OPERATOR, 'GET', '/api/me/mcp/notes')).body.version;
    assert.equal((await c(OPERATOR, 'PUT', '/api/me/mcp/notes', { description: 'x', expectVersion: v - 1 })).status, 409);
    assert.equal((await c(OPERATOR, 'PUT', '/api/me/mcp/notes', { enabled: false, expectVersion: v })).body.enabled, false);
    // An agent can be given it.
    assert.ok((await c(OPERATOR, 'GET', '/api/agents/options')).body.mcpServers.includes('notes') === false, 'turned off: not offered');
    await c(OPERATOR, 'PUT', '/api/me/mcp/notes', { enabled: true });
    assert.ok((await c(OPERATOR, 'GET', '/api/agents/options')).body.mcpServers.includes('notes'));
    // Sign out.
    await c(OPERATOR, 'POST', '/api/me/mcp/notes/signout');
    assert.equal((await c(OPERATOR, 'GET', '/api/me/mcp/notes')).body.signedIn, false);

    // Import: preview, then add the chosen ones.
    const cfg = JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_KEY}' } }, gh: { command: 'npx', args: ['-y', 'server-github'] } } });
    const preview = (await c(al.token, 'POST', '/api/me/mcp/import', { text: cfg })).body;
    assert.deepEqual(preview.servers.map((s: { config: { name: string } }) => s.config.name), ['linear', 'gh']);
    assert.deepEqual(preview.vault, ['LINEAR_KEY']);
    const applied = (await c(al.token, 'POST', '/api/me/mcp/import', { text: cfg, apply: true })).body;
    assert.deepEqual(applied.added, ['linear']);
    assert.match(applied.errors.join(), /gh: .*administrators/);
    assert.deepEqual((await c(al.token, 'GET', '/api/me/mcp')).body.servers.map((s: { name: string }) => s.name), ['inside', 'linear']);
    assert.equal((await c(al.token, 'POST', '/api/me/mcp/import', { text: 'not json' })).status, 400);

    assert.equal((await c(OPERATOR, 'DELETE', '/api/me/mcp/notes')).status, 200);
    assert.equal((await c(OPERATOR, 'GET', '/api/me/mcp/notes')).status, 404);
  } finally { srv.stop(); await t.close(); }
});
