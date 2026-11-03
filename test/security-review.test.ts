import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONTROL_PLANE_DENY } from '../src/agents/agents.ts';
import { runGates } from '../src/gates/gates.ts';
import { validateWorkflow } from '../src/graph/validate.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { LocalHost } from '../src/runtime/host.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir } from './helpers.ts';

// Security review of the person's own code, gated by an oracle (docs/swarm/SWARM.md, phase 4): a finding counts only
// when its reproducer, run by the harness, fires; a fix only when it no longer does and the tests pass; the report is
// held to the harness's ledger; nothing runs outside the person's mandate.

const here = path.dirname(fileURLToPath(import.meta.url));
const today = new Date().toISOString().slice(0, 10);

/** A small file server with a path traversal (read any file under the folder's parent), and a safe twin. */
async function app(dir: string) {
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.mkdir(path.join(dir, 'public'), { recursive: true });
  await fs.writeFile(path.join(dir, 'public', 'hello.txt'), 'hello\n');
  await fs.writeFile(path.join(dir, 'secret.env'), 'API_KEY=sk-live-7f3a9\n');
  await fs.writeFile(path.join(dir, 'src', 'files.mjs'), "import fs from 'node:fs';\nimport path from 'node:path';\nexport function serve(root, name) { return fs.readFileSync(path.join(root, 'public', name), 'utf8'); }\n");
  await fs.writeFile(path.join(dir, 'src', 'safe.mjs'), "import fs from 'node:fs';\nimport path from 'node:path';\nexport function serve(root, name) { const p = path.resolve(root, 'public', name); if (!p.startsWith(path.resolve(root, 'public') + path.sep)) throw new Error('no'); return fs.readFileSync(p, 'utf8'); }\n");
  await fs.writeFile(path.join(dir, 'test.mjs'), "import { serve } from './src/files.mjs';\nif (serve('.', 'hello.txt') !== 'hello\\n') process.exit(1);\nconsole.log('ok');\n");
  await fs.mkdir(path.join(dir, 'security', 'repro'), { recursive: true });
  await fs.writeFile(path.join(dir, 'security', 'repro', 'f1.mjs'), "import { serve } from '../../src/files.mjs';\ntry { console.log(serve('.', '../secret.env')); } catch (e) { console.log('blocked', e.message); }\n");
  await fs.writeFile(path.join(dir, 'security', 'repro', 'f2.mjs'), "import { serve } from '../../src/safe.mjs';\ntry { console.log(serve('.', '../secret.env')); } catch (e) { console.log('blocked'); }\n");
}

async function setup() {
  const h = await createHarness({ dataDir: await tempDir(), plugins: [path.join(here, '..', 'plugins', 'security-review')], search: null, memory: 'off' });
  const dir = await tempDir('hw-sec-');
  await app(dir);
  const host = new LocalHost(dir);
  const ctx = { host, signal: new AbortController().signal, services: {} } as unknown as ToolContext;
  const tool = (name: string, input: Record<string, unknown>) => h.registry.tools.get(name)!.run(input, ctx);
  // Reproducers run plainly here (fast), unless a test asks for isolation.
  const mandate = (m: Record<string, unknown>) => fs.mkdir(path.join(dir, '.harness'), { recursive: true }).then(() => fs.writeFile(path.join(dir, '.harness', 'security-mandate.json'), JSON.stringify({ isolate: 'off', ...m })));
  return { h, dir, host, tool, mandate };
}

test('nothing runs outside the person\'s mandate: none, its dates, its scope; and agents of a swarm cannot write it', async () => {
  const t = await setup();
  try {
    const f1 = { id: 'F1', title: 'path traversal in serve', file: 'src/files.mjs', kind: 'CWE-22', reproducer: 'node security/repro/f1.mjs', marker: 'sk-live-7f3a9' };
    assert.match((await t.tool('confirm_finding', f1)).content, /^Not run: no mandate: the person writes \.harness\/security-mandate\.json/);
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: '2020-01-01', until: '2020-12-31' });
    assert.match((await t.tool('confirm_finding', f1)).content, /^Not run: the mandate holds from 2020-01-01 until 2020-12-31/);
    await t.mandate({ scope: ['lib/**'], authorizedBy: 'Sam', from: today, until: today });
    assert.match((await t.tool('confirm_finding', f1)).content, /^Not run: src\/files\.mjs is outside the mandate's scope \(lib\/\*\*\)/);
    assert.ok(CONTROL_PLANE_DENY.includes('write(.harness/security-mandate.json)') && CONTROL_PLANE_DENY.includes('edit(.harness/security-mandate.json)'));
  } finally { await t.h.close(); }
});

test('a finding counts only when its reproducer fires here; a fix only when it no longer does and the tests pass; kept outside the workspace', async () => {
  const t = await setup();
  try {
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: today, until: today });
    const real = await t.tool('confirm_finding', { id: 'F1', title: 'path traversal in serve', file: 'src/files.mjs', kind: 'CWE-22', reproducer: 'node security/repro/f1.mjs', marker: 'sk-live-7f3a9' });
    assert.equal(real.is_error, false);
    assert.match(real.content, /^F1 CONFIRMED: the reproducer fired[\s\S]*API_KEY=sk-live-7f3a9/);
    // The safe twin: the same attack is blocked, so the "finding" is not confirmed, whatever anyone says.
    const decoy = await t.tool('confirm_finding', { id: 'F2', title: 'path traversal in safe serve', file: 'src/safe.mjs', reproducer: 'node security/repro/f2.mjs', marker: 'sk-live-7f3a9' });
    assert.deepEqual([decoy.is_error, /^F2 UNCONFIRMED: the reproducer did not fire \(exit 0, no marker in its output\)/.test(decoy.content)], [true, true]);
    // A marker the output always has is no proof: it must be what only the flaw would print.
    assert.match((await t.tool('confirm_finding', { id: 'F3', title: 'x', file: 'src/files.mjs', reproducer: 'node -e "1"', marker: 'ok' })).content, /at least 3 characters/);
    assert.match((await t.tool('findings', {})).content, /F1 \[CONFIRMED\] path traversal in serve[\s\S]*F2 \[UNCONFIRMED\]/);
    assert.equal((await fs.readdir(t.dir, { recursive: true })).some((f) => /findings-/.test(String(f))), false, 'the ledger is not in the workspace');

    // A fix that breaks the tests is no fix; one that keeps them and stops the reproducer is.
    await fs.writeFile(path.join(t.dir, 'src', 'files.mjs'), "export function serve() { throw new Error('off'); }\n");
    assert.match((await t.tool('check_fix', { id: 'F1', tests: 'node test.mjs' })).content, /^F1 NOT FIXED: the reproducer no longer fires; the tests fail/);
    await fs.copyFile(path.join(t.dir, 'src', 'safe.mjs'), path.join(t.dir, 'src', 'files.mjs'));
    const fixed = await t.tool('check_fix', { id: 'F1', tests: 'node test.mjs' });
    assert.deepEqual([fixed.is_error, fixed.content], [false, 'F1 FIXED: the reproducer no longer fires; the tests pass.']);
    // Confirming it again after the fix does not erase it (seen live): it says to check the fix instead.
    assert.match((await t.tool('confirm_finding', { id: 'F1', title: 'path traversal in serve', file: 'src/files.mjs', reproducer: 'node security/repro/f1.mjs', marker: 'sk-live-7f3a9' })).content, /^F1 was confirmed already[\s\S]*check_fix/);
    assert.match((await t.tool('findings', {})).content, /F1 \[FIXED\]/);
    assert.match((await t.tool('check_fix', { id: 'F2', tests: 'node test.mjs' })).content, /F2 is not a confirmed finding/);
  } finally { await t.h.close(); }
});

test('the report holds to the ledger: an unconfirmed finding called confirmed, a fix never checked, or a confirmed one left out fails it', async () => {
  const t = await setup();
  try {
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: today, until: today });
    await t.tool('confirm_finding', { id: 'F1', title: 'path traversal', file: 'src/files.mjs', reproducer: 'node security/repro/f1.mjs', marker: 'sk-live-7f3a9' });
    await t.tool('confirm_finding', { id: 'F2', title: 'traversal in safe', file: 'src/safe.mjs', reproducer: 'node security/repro/f2.mjs', marker: 'sk-live-7f3a9' });
    const signal = new AbortController().signal;
    const gate = async (report: string) => { await fs.writeFile(path.join(t.dir, 'security', 'findings.md'), report); return (await runGates(t.h.registry, t.host, ['findings-confirmed'], signal))[0]!; };
    // A review that covered nothing is not a clean bill (seen live: no plan, nothing reviewed, "none", and success).
    assert.match((await gate('## Confirmed\nNone.\n')).details!, /security\/plan\.md lists no files/);
    await fs.writeFile(path.join(t.dir, 'security', 'plan.md'), '- src/files.mjs: builds a path from the request\n- src/safe.mjs: the same, guarded\n- src/other.mjs: no input\n');
    assert.match((await gate('## Confirmed\n### F1 CONFIRMED: path traversal (src/files.mjs)\n## Unconfirmed\n- F2 UNCONFIRMED (src/safe.mjs)\n')).details!, /src\/other\.mjs is on the plan but not in the report/);
    await fs.writeFile(path.join(t.dir, 'security', 'plan.md'), '- src/files.mjs: builds a path from the request\n- src/safe.mjs: the same, guarded\n');
    const bad = await gate('## Confirmed\n### F2 CONFIRMED: traversal in safe\n### F1 FIXED: path traversal\n');
    assert.equal(bad.pass, false);
    assert.match(bad.details!, /F2 is called CONFIRMED, but its reproducer did not fire[\s\S]*F1 is called FIXED, but check_fix was never run|F1 is called FIXED, but check_fix did not pass/);
    assert.match((await gate('## Confirmed\nnone\n## Unconfirmed (for a person to judge)\n- F2 UNCONFIRMED: traversal in safe\n')).details!, /F1 \(path traversal\) was confirmed but is not in the report/);
    const good = await gate('## Confirmed\n### F1 CONFIRMED: path traversal\nFile: src/files.mjs\n\n## Unconfirmed (for a person to judge)\n- F2 UNCONFIRMED: traversal in safe (src/safe.mjs)\n');
    assert.deepEqual([good.pass, good.summary], [true, 'security/findings.md: 1 confirmed finding(s), each with a reproducer that fired']);
    assert.deepEqual(validateWorkflow(t.h.registry.workflows.get('security-review')!), []);
    for (const a of ['security-lead', 'security-hunter', 'security-reporter']) assert.ok(t.h.registry.agents.has(a), a);
  } finally { await t.h.close(); }
});

test('variant analysis: a flaw fixed once, still in another file under other names, is found from the fix\'s own commit', async () => {
  const t = await setup();
  try {
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: today, until: today });
    const { execFileSync } = await import('node:child_process');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@x', ...a], { cwd: t.dir, stdio: 'pipe' });
    await fs.writeFile(path.join(t.dir, 'src', 'download.mjs'), "import fs from 'node:fs';\nimport path from 'node:path';\nexport function download(base, file) {\n  return fs.readFileSync(path.join(base, 'static', file), 'utf8');\n}\n");
    git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'the app');
    // The person fixed the traversal in files.mjs (only there).
    await fs.copyFile(path.join(t.dir, 'src', 'safe.mjs'), path.join(t.dir, 'src', 'files.mjs'));
    git('commit', '-qam', 'Fix path traversal in serve');
    const r = await t.tool('fix_variants', {});
    assert.equal(r.is_error ?? false, false, r.content);
    assert.match(r.content, /src\/download\.mjs:4 \(the same shape\): return fs\.readFileSync\(path\.join\(base, 'static', file\), 'utf8'\);\n {2}like src\/files\.mjs before [0-9a-f]+ Fix path traversal in serve/);
    assert.doesNotMatch(r.content, /src\/files\.mjs:\d/, 'the fixed file itself is not a candidate');
  } finally { await t.h.close(); }
});

test('code scanning: the built-in rules flag the planted flaws as candidates (Semgrep where installed), only inside the mandate', async () => {
  const t = await setup();
  try {
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: today, until: today });
    await fs.writeFile(path.join(t.dir, 'src', 'ops.mjs'), "import { execSync } from 'node:child_process';\nexport const ping = (host) => execSync(`ping -c 1 ${host}`);\nexport const find = (db, name) => db.prepare(\"SELECT * FROM users WHERE name = '\" + name + \"'\").all();\nconst API_KEY = 'sk-live-abcdef123456';\n");
    await fs.writeFile(path.join(t.dir, 'lib-out-of-scope.mjs'), "eval(process.argv[2]);\n");
    const r = (await t.tool('scan_code', {})).content;
    assert.match(r, /by (built-in rules|Semgrep)/);
    if (/built-in rules/.test(r)) {
      assert.match(r, /\[high\] command-injection: src\/ops\.mjs:2/);
      assert.match(r, /\[high\] sql-injection: src\/ops\.mjs:3/);
      assert.match(r, /\[medium\] path-traversal: src\/files\.mjs:3/);
      assert.match(r, /\[medium\] hard-coded-secret: src\/ops\.mjs:4/);
    }
    assert.doesNotMatch(r, /lib-out-of-scope/, 'only the mandate\'s scope');
  } finally { await t.h.close(); }
});

test('isolated: with Docker, a reproducer runs in a fresh container with no network and only this folder (said in the result and the ledger)', { skip: !(await (async () => { try { const { execFileSync } = await import('node:child_process'); return /ok/.test(execFileSync('docker', ['image', 'inspect', 'harness-sandbox:latest', '--format', 'ok'], { encoding: 'utf8', stdio: 'pipe' })); } catch { return false; } })()) && 'no Docker or no harness-sandbox image' }, async () => {
  const t = await setup();
  try {
    await t.mandate({ scope: ['src/**'], authorizedBy: 'Sam', from: today, until: today, isolate: 'auto' });
    // The reproducer also tries the network: inside the container there is none.
    await fs.writeFile(path.join(t.dir, 'security', 'repro', 'net.mjs'), "import { serve } from '../../src/files.mjs';\nconsole.log(serve('.', '../secret.env'));\ntry { await fetch('https://example.com', { signal: AbortSignal.timeout(3000) }); console.log('NET-OPEN'); } catch { console.log('net-closed'); }\n");
    const r = await t.tool('confirm_finding', { id: 'F1', title: 'path traversal in serve', file: 'src/files.mjs', reproducer: 'node security/repro/net.mjs', marker: 'sk-live-7f3a9' });
    assert.match(r.content, /^F1 CONFIRMED: the reproducer fired \(run in a container with no network\)[\s\S]*net-closed/);
    assert.doesNotMatch(r.content, /NET-OPEN/);
  } finally { await t.h.close(); }
});
