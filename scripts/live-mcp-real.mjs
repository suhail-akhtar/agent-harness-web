// Live check against real, public MCP servers on the internet (no model, nothing spent; not part of npm test).
//   node scripts/live-mcp-real.mjs
//
// 1. DeepWiki (https://mcp.deepwiki.com/mcp, public, no sign-in), added by a MEMBER (not an administrator): the
//    public-address guard on a real host, the protocol a real server agrees, its tools pinned, a read-only call.
// 2. A real service that needs OAuth (Linear's MCP server): the harness sees it needs sign-in (from its 401), and
//    the server's protected-resource and authorization-server metadata are found (discovery only: no client is
//    registered and nothing is signed in; that needs the person's own account in the browser).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { UserMcp } = await imp('src/mcp/servers.ts');
const { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata } = await import('@modelcontextprotocol/client');

const checks = [];
const check = (ok, what) => { checks.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); };
const data = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'live-mcp-real-'));
const um = new UserMcp({ dataDir: data, isAdmin: (o) => o === undefined });
try {
  // 1. A public server, as a member.
  await um.create('member', { name: 'deepwiki', type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  const t = await um.test('member', 'deepwiki');
  check(t.ok, `DeepWiki connects for a member (public https, every connection's address checked)${t.ok ? `: MCP ${t.protocol}, ${t.serverInfo?.name ?? ''}` : `: ${t.error}`}`);
  if (t.ok) {
    check(t.tools.length > 0 && t.tools.every((x) => x.state === 'approved'), `its tools pinned as first seen: ${t.tools.map((x) => x.name).join(', ')}`);
    const { entries } = await um.entries('member');
    const structure = entries.find((e) => e.tool.name === 'read_wiki_structure');
    if (structure) {
      const r = await structure.client.callTool('read_wiki_structure', { repoName: 'modelcontextprotocol/typescript-sdk' });
      const text = (r.content ?? []).map((c) => c.text ?? '').join('');
      check(!r.isError && text.length > 50, `a real call answered (${text.replace(/\s+/g, ' ').slice(0, 120)}...)`);
    } else check(false, 'read_wiki_structure is offered');
  }
  // A member may not reach a private address, even one that looks public by name.
  await um.create('member', { name: 'sneaky', type: 'http', url: 'https://localhost.localtest.me/mcp' });
  const sneaky = await um.test('member', 'sneaky');
  check(!sneaky.ok && /private/.test(sneaky.error ?? ''), `a name that resolves to this computer is refused for a member (${sneaky.error})`);

  // 2. A real OAuth server: needs sign-in; discovery works (read-only).
  const linear = 'https://mcp.linear.app/mcp';
  await um.create('member', { name: 'linear', type: 'http', url: linear });
  const l = await um.test('member', 'linear');
  check(!l.ok && l.needsSignIn === true, `Linear says it needs sign-in (${l.error})`);
  const prm = await discoverOAuthProtectedResourceMetadata(linear).catch((e) => ({ error: e.message }));
  const asUrl = prm.authorization_servers?.[0];
  check(!!asUrl, `its protected-resource metadata names an authorization server (${asUrl ?? prm.error})`);
  if (asUrl) {
    const asm = await discoverAuthorizationServerMetadata(asUrl).catch((e) => ({ error: e.message }));
    check(!!asm?.authorization_endpoint && (asm.code_challenge_methods_supported ?? []).includes('S256'), `its authorization server supports PKCE S256 (${asm?.authorization_endpoint ?? asm?.error})`);
    check(!!asm?.registration_endpoint, `it offers dynamic client registration (${asm?.registration_endpoint ?? 'none: a client id is set in the server\'s settings instead'})`);
  }
} finally {
  await um.closeAll();
}
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
