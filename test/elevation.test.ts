// Administrator commands (bash with elevated: true): asked of the person every time, whatever the mode, the
// rules, the hooks or auto mode say; never "always allowed"; refused where nobody can be asked, in a sandbox or
// on another machine, and on a server whose operator did not turn them on. (Nothing here really elevates:
// that would show the operating system's prompt.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide } from '../src/core/permissions.ts';
import { bashTool } from '../src/tools/exec.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { FakeProvider, tempDir } from './helpers.ts';
import { record, waitFor } from './multi-helpers.ts';

const rules = (allow: string[] = []) => ({ allow, deny: [], ask: [] });

test('elevated: asked in every mode, over allow rules; refused where nobody can be asked; an ordinary command is unchanged', () => {
  const up = { command: 'Get-Service', elevated: true };
  for (const mode of ['default', 'acceptEdits', 'bypass', 'auto'] as const) {
    const d = decide(bashTool, up, { mode, rules: rules(['bash', 'bash(*)', 'bash(Get-Service:*)']), sandboxed: false });
    assert.deepEqual([d.action, d.always], ['ask', true], mode);
    assert.match(d.reason, /administrator rights/);
  }
  assert.equal(decide(bashTool, up, { mode: 'dontAsk', rules: rules(['bash']), sandboxed: false }).action, 'deny');
  assert.equal(decide(bashTool, { ...up, elevated: false }, { mode: 'bypass', rules: rules(), sandboxed: false }).action, 'allow');
  assert.equal(decide(bashTool, up, { mode: 'bypass', rules: { allow: [], deny: ['bash'], ask: [] }, sandboxed: false }).action, 'deny', 'a deny rule still wins');
  assert.match(bashTool.summarize(up), /^\[as administrator\] Get-Service/);
});

test('elevated: refused on a server that did not turn it on, in a sandbox, on another machine, in the background, with secrets', async () => {
  const ctx = (host: Partial<ToolContext['host']>) => ({ host: { kind: 'local', sandboxed: false, root: process.cwd(), shell: 'bash', ...host }, signal: new AbortController().signal } as unknown as ToolContext);
  const prev = { d: process.env.HARNESS_DESKTOP, e: process.env.HARNESS_ELEVATION };
  try {
    delete process.env.HARNESS_DESKTOP; delete process.env.HARNESS_ELEVATION;
    assert.match((await bashTool.run({ command: 'id', elevated: true }, ctx({}))).content, /turned off on this server.*HARNESS_ELEVATION=on/);
    process.env.HARNESS_DESKTOP = '1';
    process.env.HARNESS_ELEVATION = 'off';
    assert.match((await bashTool.run({ command: 'id', elevated: true }, ctx({}))).content, /turned off/);
    delete process.env.HARNESS_ELEVATION;
    assert.match((await bashTool.run({ command: 'id', elevated: true }, ctx({ kind: 'docker', sandboxed: true }))).content, /in a sandbox/);
    assert.match((await bashTool.run({ command: 'id', elevated: true }, ctx({ sandboxed: true }))).content, /in a sandbox/);
    assert.match((await bashTool.run({ command: 'id', elevated: true }, ctx({ kind: 'companion' }))).content, /on another machine/);
    assert.match((await bashTool.run({ command: 'id', elevated: true, run_in_background: true }, ctx({}))).content, /cannot run in the background/);
    assert.match((await bashTool.run({ command: 'id', elevated: true, secrets: { X: 'db' } }, ctx({}))).content, /secrets are not given/);
  } finally {
    if (prev.d === undefined) delete process.env.HARNESS_DESKTOP; else process.env.HARNESS_DESKTOP = prev.d;
    if (prev.e === undefined) delete process.env.HARNESS_ELEVATION; else process.env.HARNESS_ELEVATION = prev.e;
  }
});

test('Windows: the wrapper an elevated command runs in brings back its output, errors and exit code (run here without elevation)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { writeWindowsScripts, readOut } = await import('../src/runtime/elevate.ts');
  const cwd = await tempDir();
  await fs.writeFile(path.join(cwd, 'marker.txt'), 'here');
  const go = async (command: string) => {
    const dir = await tempDir();
    const s = await writeWindowsScripts(command, cwd, dir);
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', s.wrap], { windowsHide: true });
    return { out: (await readOut(s.out)).trim(), err: (await readOut(s.err)).trim(), code: Number((await fs.readFile(s.exit, 'utf8')).trim()) };
  };
  const a = await go("Get-Content marker.txt; Write-Output 'naïve ünïcode'");
  assert.deepEqual([a.out.replace(/\r/g, ''), a.code], ['here\nnaïve ünïcode', 0], 'in the session folder, its output in UTF-8');
  const b = await go("Write-Error 'it broke'; exit 3");
  assert.equal(b.code, 3);
  assert.match(b.err, /it broke/);
  const c = await go("cmd /c 'exit 5'");
  assert.equal(c.code, 5, "a program's exit code");
  const d = await go("throw 'boom'");
  assert.equal(d.code, 1);
  assert.match(d.err, /boom/);
});

test('elevated in a session in bypass mode: the person is asked (no "always allow" offered, one sent anyway is once)', async () => {
  const data = await tempDir();
  const h = await createHarness({ dataDir: data, plugins: [], backgroundWork: false, scheduler: false, search: null });
  try {
    const fake = new FakeProvider([{ calls: [{ name: 'bash', input: { command: 'net stop spooler', elevated: true, description: 'stop the print spooler' } }] }, { text: 'ok' }]);
    for (const id of h.registry.providers.keys()) h.registry.setProviderInstance(id, fake);
    const s = await h.sessions.create({ model: 'deepseek-flash', runtime: { kind: 'local', network: 'none', path: await tempDir() }, mode: 'bypass' });
    const ev = record(s);
    await s.send('stop the spooler');
    await waitFor(() => ev.some((e) => e.kind === 'permission_request'), 'the question');
    const q = ev.find((e) => e.kind === 'permission_request') as Extract<HarnessEvent, { kind: 'permission_request' }>;
    assert.equal(q.tool, 'bash');
    assert.equal(q.suggestion, '', 'no "always allow"');
    assert.match(q.summary, /\[as administrator\] net stop spooler \(it runs with administrator rights\)/);
    // "Always allow" sent anyway is once, and adds no rule.
    s.respond(q.requestId, { decision: 'allow_always' });
    await waitFor(() => ev.some((e) => e.kind === 'tool_result'), 'the result');
    const r = ev.find((e) => e.kind === 'tool_result') as Extract<HarnessEvent, { kind: 'tool_result' }>;
    // Allowed once, then the server's own policy (a plain server, not the desktop app's engine) refuses it.
    assert.match(r.content, /turned off on this server/);
    assert.deepEqual(s.meta.sessionRules, []);
  } finally { await h.close(); }
});
