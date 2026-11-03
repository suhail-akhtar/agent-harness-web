import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTIN_SKILLS_DIR } from '../src/skills/builder.ts';
import { checkSkillDir, SkillStore, unpackSkills } from '../src/skills/package.ts';
import type { HarnessEvent } from '../src/core/types.ts';
import { readZip, writeZip } from '../src/util/zip.ts';
import { tempDir } from './helpers.ts';
import { OPERATOR, setupServer, waitFor } from './multi-helpers.ts';

// Skills as packages: instructions, and for exact work scripts with tests, references, assets and MCP servers;
// imported from an Anthropic .skill, a .zip (one skill or many) or a SKILL.md; checked before they are kept; kept in
// the person's library; given to agents, who get what the skill uses and run its scripts.

const z = (files: Record<string, string>) => writeZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) })));
const SKILL = (name: string, extra = '') => `---\nname: ${name}\ndescription: Totals the amounts of an invoice CSV exactly, with a script.${extra}\n---\n# ${name}\n\nRun \`scripts/total.mjs <file.csv>\`: it prints {"total": n}.\n`;
const TOTAL = "import fs from 'node:fs';\nconst rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\\n').slice(1);\nconst total = rows.reduce((s, r) => s + Number(r.split(',')[1]), 0);\nconsole.log(JSON.stringify({ total: Math.round(total * 100) / 100 }));\n";
const TEST = "import { execFileSync } from 'node:child_process';\nimport fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';\nconst f = path.join(os.tmpdir(), `t-${process.pid}.csv`);\nfs.writeFileSync(f, 'item,amount\\na,1.10\\nb,2.20\\n');\nconst out = JSON.parse(execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'total.mjs'), f], { encoding: 'utf8' }));\nif (out.total !== 3.3) { console.error('got', out); process.exit(1); }\nconsole.log('ok');\n";

test('zips: read back what was written; a path out of the folder, too much data or a damaged file is refused', () => {
  const back = readZip(z({ 'a/SKILL.md': 'x', 'a/scripts/s.py': 'print(1)' }));
  assert.deepEqual(back.map((e) => [e.name, e.data.toString()]), [['a/SKILL.md', 'x'], ['a/scripts/s.py', 'print(1)']]);
  assert.throws(() => readZip(z({ '../evil.sh': 'x' })), /unsafe path/);
  assert.throws(() => readZip(z({ 'C:/evil': 'x' })), /unsafe path/);
  assert.throws(() => readZip(z({ 'big.txt': 'y'.repeat(5000) }), { entries: 10, file: 1000, total: 10_000 }), /too large/);
  assert.throws(() => readZip(Buffer.from('PK not really')), /not a zip|damaged/);
});

test('packages: an Anthropic .skill, a pack of skills (a Claude Code plugin\'s skills/), a SKILL.md alone; macOS litter and nested folders handled', () => {
  const one = unpackSkills(z({ 'invoice-totals/SKILL.md': SKILL('invoice-totals'), 'invoice-totals/scripts/total.mjs': TOTAL, '__MACOSX/invoice-totals/._SKILL.md': 'junk', 'invoice-totals/.DS_Store': 'junk' }));
  assert.deepEqual(one.map((s) => [s.name, [...s.files.keys()].sort()]), [['invoice-totals', ['SKILL.md', 'scripts/total.mjs']]]);
  const pack = unpackSkills(z({ 'plugin/skills/a-one/SKILL.md': SKILL('a-one'), 'plugin/skills/b-two/SKILL.md': SKILL('b-two'), 'plugin/skills/b-two/references/x/SKILL.md': 'an example inside b-two, not a skill', 'plugin/README.md': 'x' }));
  assert.deepEqual(pack.map((s) => s.name), ['a-one', 'b-two']);
  assert.ok(pack[1]!.files.has('references/x/SKILL.md'), 'a SKILL.md inside a skill\'s folder is part of it');
  assert.deepEqual(unpackSkills(Buffer.from(SKILL('plain'))).map((s) => s.name), ['plain']);
  assert.throws(() => unpackSkills(z({ 'readme.md': 'x' })), /no SKILL\.md/);
  assert.throws(() => unpackSkills(Buffer.from('just text')), /not a skill/);
});

test('a skill is checked before it is kept: its name and description, the files it points to, its scripts\' syntax, its MCP servers', async () => {
  const dir = path.join(await tempDir(), 'bad-skill');
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: Bad Name\ndescription: short\n---\nSee [the guide](references/guide.md) and run `scripts/go.mjs`.\n');
  await fs.writeFile(path.join(dir, 'scripts', 'go.mjs'), 'const x = ;\n');
  await fs.writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { thing: { args: [] } } }));
  const r = await checkSkillDir(dir);
  assert.equal(r.ok, false);
  const all = r.problems.join('\n');
  for (const want of [/name "Bad Name" must be/, /description must say what the skill does/, /points to references\/guide\.md, which is not in the skill/, /scripts\/go\.mjs does not parse/, /server "thing" needs a command or a url/]) assert.match(all, want);
  assert.ok(r.warnings.some((w) => /scripts without tests/.test(w)));
  // The harness's own skill-creator passes, and its self-test runs.
  const sc = await checkSkillDir(path.join(BUILTIN_SKILLS_DIR, 'skill-creator'));
  assert.deepEqual([sc.ok, sc.problems], [true, []]);
  assert.equal(execFileSync(process.execPath, [path.join(BUILTIN_SKILLS_DIR, 'skill-creator', 'tests', 'selftest.mjs')], { encoding: 'utf8' }).trim(), 'ok');
});

test('the library: kept only when it passes, not replaced unless asked, removed, exported as a .skill that imports again', async () => {
  const store = new SkillStore(await tempDir());
  const files = (skill: string) => new Map([['SKILL.md', Buffer.from(skill)], ['scripts/total.mjs', Buffer.from(TOTAL)], ['tests/test_total.mjs', Buffer.from(TEST)]]);
  assert.equal((await store.put('u1', { name: 'invoice-totals', files: new Map([['SKILL.md', Buffer.from('---\nname: invoice-totals\ndescription: x\n---\n')]]) })).ok, false, 'a failing skill is not kept');
  assert.deepEqual(await store.names('u1'), []);
  const r = await store.put('u1', { name: 'invoice-totals', files: files(SKILL('invoice-totals')) });
  assert.deepEqual([r.ok, r.manifest?.scripts, r.manifest?.tests], [true, ['scripts/total.mjs'], ['tests/test_total.mjs']]);
  assert.match((await store.put('u1', { name: 'invoice-totals', files: files(SKILL('invoice-totals')) })).problems[0]!, /already/);
  assert.equal((await store.put('u1', { name: 'invoice-totals', files: files(SKILL('invoice-totals', ' Version two.')) }, { replace: true })).ok, true);
  assert.deepEqual(await store.names('u2'), [], 'each person has their own');
  const again = unpackSkills(await store.exportZip('u1', 'invoice-totals'));
  assert.deepEqual([again[0]!.name, [...again[0]!.files.keys()].sort()], ['invoice-totals', ['SKILL.md', 'scripts/total.mjs', 'tests/test_total.mjs']]);
  assert.equal(await store.remove('u1', 'invoice-totals'), true);
});

test('in the app: a .skill imported (its MCP server added, switched off), listed, given to an agent, which loads it and runs its script; check_skill and save_skill keep one an agent made', async () => {
  const t = await setupServer();
  try {
    const pkg = z({ 'invoice-totals/SKILL.md': SKILL('invoice-totals', '\nallowed-tools: read, skill_script\nmcp-servers: ledger-db'), 'invoice-totals/scripts/total.mjs': TOTAL, 'invoice-totals/tests/test_total.mjs': TEST, 'invoice-totals/mcp.json': JSON.stringify({ mcpServers: { 'ledger-db': { url: 'https://ledger.example/mcp' } } }) });
    const imp = await t.call(OPERATOR, 'POST', '/api/me/skills/import', { data: pkg.toString('base64') });
    assert.equal(imp.status, 200, JSON.stringify(imp.body));
    assert.deepEqual([imp.body.skills[0].ok, imp.body.skills[0].scripts, imp.body.skills[0].serversAdded], [true, 1, ['ledger-db']]);
    const mcp = (await t.call(OPERATOR, 'GET', '/api/me/mcp')).body as { servers: { name: string; enabled: boolean }[] };
    assert.deepEqual(mcp.servers.filter((s) => s.name === 'ledger-db').map((s) => s.enabled), [false], 'added, switched off: the person turns it on');
    const listed = (await t.call(OPERATOR, 'GET', '/api/me/skills')).body as { name: string; tools: string[]; mcpServers: string[] }[];
    assert.deepEqual(listed.map((s) => [s.name, s.tools, s.mcpServers]), [['invoice-totals', ['read', 'skill_script'], ['ledger-db']]]);
    assert.ok(((await t.call(OPERATOR, 'GET', '/api/agents/options')).body.skills as { name: string }[]).some((s) => s.name === 'invoice-totals'), 'offered in the agent builder');
    assert.equal((await t.call(OPERATOR, 'POST', '/api/me/skills/import', { text: 'no frontmatter' })).status, 400);

    // An agent of the person's with the skill: it gets the skill's tools, loads it, runs its script on the workspace.
    assert.equal((await t.call(OPERATOR, 'POST', '/api/me/agents', { name: 'bookkeeper', description: 'Totals invoices.', prompt: 'You total invoices.', model: 'deepseek-flash', tools: ['read'], skills: ['invoice-totals'] })).status, 201);
    const dir = await tempDir('hw-skill-');
    await fs.writeFile(path.join(dir, 'march.csv'), 'item,amount\ndesk,120.50\nchair,79.25\nlamp,19.99\n');
    const made = await t.call(OPERATOR, 'POST', '/api/sessions', { model: 'deepseek-flash', runtime: 'local', path: dir, mode: 'bypass' });
    const s = t.harness.sessions.get(made.body.id)!;
    const ev: HarnessEvent[] = [];
    s.subscribe(0, ({ event }) => ev.push(event));
    const ends = () => ev.filter((e) => e.kind === 'turn_end' && (!('agent' in e) || !e.agent)).length;
    const turn = async (text: string) => { const n = ends(); await s.send(text); await waitFor(() => ends() > n, 'the turn', 60_000); };
    const result = (name: string) => ev.filter((e): e is Extract<HarnessEvent, { kind: 'tool_result' }> => e.kind === 'tool_result' && e.name === name).at(-1)!;
    t.ds.scripts.lead = [{ calls: [{ name: 'agent', input: { description: 'total it', type: 'bookkeeper', prompt: '[[bk]] What is the total of march.csv?' } }] }, { text: 'Done.' }];
    t.ds.scripts.bk = [{ calls: [{ name: 'skill_script', input: { skill: 'invoice-totals', script: 'scripts/total.mjs', args: ['march.csv'] } }] }, { text: 'The total is 219.74.' }];
    await turn('[[lead]] Total the March invoices.');
    const sub = t.ds.requests.find((r) => JSON.stringify(r.messages[0]).includes('<brief>\\n[[bk]]'))!;
    const first = (sub.messages[0]!.content as { text: string }[])[0]!.text;
    assert.match(first, /<skill name="invoice-totals">\n# invoice-totals/, 'the agent starts with its skill');
    assert.doesNotMatch(first, /- skill-creator:/, 'and is offered only its own skills');
    assert.deepEqual(sub.tools.map((x) => x.name).filter((n) => ['read', 'skill', 'skill_script'].includes(n)).sort(), ['read', 'skill', 'skill_script'], 'its tools, and the skill\'s');
    assert.match(result('skill_script').content, /\{"total":219\.74\}/, 'the script ran on the workspace');

    // An agent builds a skill in the workspace: a failing test keeps it out; fixed, it is checked and kept.
    await fs.mkdir(path.join(dir, 'skills', 'line-count', 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'skills', 'line-count', 'tests'), { recursive: true });
    await fs.writeFile(path.join(dir, 'skills', 'line-count', 'SKILL.md'), '---\nname: line-count\ndescription: Counts the lines of a text file exactly, with a script.\n---\nRun `scripts/count.mjs <file>`: it prints {"lines": n}.\n');
    await fs.writeFile(path.join(dir, 'skills', 'line-count', 'scripts', 'count.mjs'), "import fs from 'node:fs';\nconsole.log(JSON.stringify({ lines: fs.readFileSync(process.argv[2], 'utf8').split('\\n').length }));\n");
    await fs.writeFile(path.join(dir, 'skills', 'line-count', 'tests', 'test.mjs'), "import { execFileSync } from 'node:child_process';\nimport fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';\nconst f = path.join(os.tmpdir(), `lc-${process.pid}.txt`); fs.writeFileSync(f, 'a\\nb\\n');\nconst o = JSON.parse(execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'count.mjs'), f], { encoding: 'utf8' }));\nif (o.lines !== 2) { console.error('wanted 2 lines, got', o.lines); process.exit(1); }\n");
    t.ds.scripts.lead = [{ calls: [{ name: 'save_skill', input: { path: 'skills/line-count' } }] }, { text: 'Tried.' }];
    await turn('[[lead]] Keep the skill.');
    assert.equal(result('save_skill').is_error, true);
    assert.match(result('save_skill').content, /^Not saved\.[\s\S]*FAIL tests\/test\.mjs[\s\S]*wanted 2 lines, got 3/);
    await fs.writeFile(path.join(dir, 'skills', 'line-count', 'scripts', 'count.mjs'), "import fs from 'node:fs';\nconsole.log(JSON.stringify({ lines: fs.readFileSync(process.argv[2], 'utf8').split('\\n').filter((l, i, a) => i < a.length - 1 || l).length }));\n");
    t.ds.scripts.lead = [{ calls: [{ name: 'check_skill', input: { path: 'skills/line-count' } }, { name: 'save_skill', input: { path: 'skills/line-count' } }] }, { text: 'Kept.' }];
    await turn('[[lead]] Keep it now.');
    assert.match(result('check_skill').content, /^The skill passes\.[\s\S]*PASS tests\/test\.mjs/);
    assert.match(result('save_skill').content, /^Saved "line-count" to your skills/);
    assert.deepEqual(((await t.call(OPERATOR, 'GET', '/api/me/skills')).body as { name: string }[]).map((x) => x.name), ['invoice-totals', 'line-count']);
    // Removed, it is gone.
    assert.equal((await t.call(OPERATOR, 'DELETE', '/api/me/skills/line-count')).status, 200);
    assert.equal((await t.call(OPERATOR, 'GET', '/api/me/skills/line-count')).status, 404);
  } finally { await t.close(); }
});
